'use strict';

/**
 * sessionPersistFast.test.js — 「会话持久化收尾提速」(gate KHY_SESSION_PERSIST_FAST) 的
 * 真·文件系统覆盖(node:test)。
 *
 * 根因:persistSession 每轮在渲染事件循环上做无界同步 IO——① 对整份(随会话增长)JSONL 跑
 * **两次** readFileSync(数行 + 取末条 uuid);② 整份 messages pretty re-stringify + 阻塞 fsync
 * 同步写快照。长会话每轮都为此卡一下,回车后得等它做完才能打字。
 *
 * 修:① per-file 计数/末 uuid 记忆免去每轮双读(persistSession 是 JSONL 唯一追加者,进程内
 * 计数恒等文件行数);② 对进程内已建立的会话(cache hit)把快照写挪到 setImmediate 出本轮 tick
 * (JSONL 已同步 fsync 是权威源;restoreSession 消息取自 JSONL、仅从快照补元数据;cache miss=
 * fork/新会话仍同步写)。门控关 → 逐字节回退今日「双读 + 同步快照」。
 *
 * 关键不变量:
 *  - fast on/off 追加到 JSONL 的消息链(uuid/parentUuid/role/content)完全一致。
 *  - 增量持久化只追加 delta,绝不重复;count 恒等文件行数。
 *  - messages 变短(压缩/orphan-pop)时两路径都不追加(JSONL append-only)。
 *  - cache hit 时快照**延迟**写(drain setImmediate 后才现);cache miss / 门控关时快照**同步**可读。
 *
 * 运行:node --test services/backend/tests/services/sessionPersistFast.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离:require 之前把 sessions 树钉到临时目录。
const TMP_HOME = path.join(os.tmpdir(), `khy-sess-fast-${process.pid}`);
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const sp = require('../../src/services/sessionPersistence');

test.after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const CWD = process.cwd();
const drain = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// 从 JSONL 解析核心链字段(忽略 timestamp/_khyTrace 等增量信封)。
function readChain(sessionId) {
  const file = sp.jsonlPathFor(sessionId);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((l) => {
    const e = JSON.parse(l);
    return { uuid: e.uuid, parentUuid: e.parentUuid, role: e.role, content: e.content };
  });
}

const withEnv = (key, val, fn) => {
  const saved = process.env[key];
  if (val === undefined) delete process.env[key]; else process.env[key] = val;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  }
};

// 显式 uuid/timestamp → 写出的行确定,可跨 fast on/off 直接比对链。
const M = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, uuid: `u${i}`, timestamp: 1000 + i });

test('fast on/off:增量追加到 JSONL 的消息链完全一致(仅影响读/计数,不影响写)', () => {
  const seqs = [[M(0)], [M(0), M(1)], [M(0), M(1), M(2)], [M(0), M(1), M(2), M(3)]];

  withEnv('KHY_SESSION_PERSIST_FAST', 'on', () => {
    for (const messages of seqs) sp.persistSession('eq-on', { title: 'T', model: 'm', messages, metadata: { cwd: CWD } });
  });
  withEnv('KHY_SESSION_PERSIST_FAST', 'off', () => {
    for (const messages of seqs) sp.persistSession('eq-off', { title: 'T', model: 'm', messages, metadata: { cwd: CWD } });
  });

  const on = readChain('eq-on');
  const off = readChain('eq-off');
  assert.equal(on.length, 4, 'fast on 应恰好 4 条(只追加 delta,无重复)');
  assert.equal(off.length, 4, 'fast off 应恰好 4 条');
  assert.deepEqual(on, off, 'fast on/off 的链(uuid/parentUuid/role/content)必须一致');
  // parent 链正确:每条指向前一条。
  assert.equal(on[0].parentUuid, null);
  assert.equal(on[1].parentUuid, 'u0');
  assert.equal(on[3].parentUuid, 'u2');
});

test('count-memo:多轮增量只追加 delta,绝不重复;restore 拿回全部消息', () => {
  withEnv('KHY_SESSION_PERSIST_FAST', 'on', () => {
    sp.persistSession('memo', { title: 'A', model: 'm', messages: [M(0)], metadata: { cwd: CWD } });
    sp.persistSession('memo', { title: 'A', model: 'm', messages: [M(0), M(1)], metadata: { cwd: CWD } });
    sp.persistSession('memo', { title: 'A', model: 'm', messages: [M(0), M(1), M(2)], metadata: { cwd: CWD } });
  });
  const chain = readChain('memo');
  assert.equal(chain.length, 3, 'JSONL 应恰好 3 行(每轮只追加新消息)');
  assert.deepEqual(chain.map((c) => c.content), ['m0', 'm1', 'm2']);
});

test('压缩/变短:messages.length ≤ 已有行数 → 不追加(JSONL append-only,fast 与 off 同)', () => {
  withEnv('KHY_SESSION_PERSIST_FAST', 'on', () => {
    sp.persistSession('shrink', { title: 'A', model: 'm', messages: [M(0), M(1), M(2), M(3)], metadata: { cwd: CWD } });
    // 模拟压缩:传入更短的数组。
    sp.persistSession('shrink', { title: 'A', model: 'm', messages: [M(0), M(1)], metadata: { cwd: CWD } });
  });
  assert.equal(readChain('shrink').length, 4, '变短不截断也不追加,JSONL 仍 4 行');
});

test('cache miss(首轮/新会话)快照同步可读;cache hit 快照延迟到 setImmediate 后才现', async () => {
  // 首轮 = cache miss → 快照同步写:紧随其后的 restore 应拿到 title(fork/resume 安全)。
  withEnv('KHY_SESSION_PERSIST_FAST', 'on', () => {
    sp.persistSession('defer', { title: 'A', model: 'm', messages: [M(0)], metadata: { cwd: CWD } });
  });
  const r1 = sp.restoreSession('defer');
  assert.equal(r1.title, 'A', 'cache miss 首轮:快照同步,title 立即可读');

  // 第二轮 = cache hit → 快照延迟:JSONL 立即含新消息,但快照 title 仍旧,直到 drain。
  withEnv('KHY_SESSION_PERSIST_FAST', 'on', () => {
    sp.persistSession('defer', { title: 'B', model: 'm', messages: [M(0), M(1)], metadata: { cwd: CWD } });
  });
  const r2 = sp.restoreSession('defer');
  assert.equal(r2.messages.length, 2, 'JSONL 同步:第二条消息立即可见');
  assert.equal(r2.title, 'A', 'cache hit:快照延迟,title 尚未更新(仍为旧值 A)');

  await drain();
  const r3 = sp.restoreSession('defer');
  assert.equal(r3.title, 'B', 'drain setImmediate 后:延迟快照落盘,title 更新为 B');
});

test('门控关:快照同步写(不延迟),title 立即可读', () => {
  withEnv('KHY_SESSION_PERSIST_FAST', 'off', () => {
    sp.persistSession('gateoff', { title: 'X', model: 'm', messages: [M(0)], metadata: { cwd: CWD } });
    sp.persistSession('gateoff', { title: 'Y', model: 'm', messages: [M(0), M(1)], metadata: { cwd: CWD } });
  });
  // 门控关 → 一律同步,第二轮 title 无需 drain 立即可读。
  const r = sp.restoreSession('gateoff');
  assert.equal(r.title, 'Y', '门控关:快照同步,title 立即为 Y');
  assert.equal(r.messages.length, 2);
});

test('坏输入 / 空会话:不抛,返回 sessionId', () => {
  withEnv('KHY_SESSION_PERSIST_FAST', 'on', () => {
    const id = sp.persistSession('empty', { messages: [], metadata: { cwd: CWD } });
    assert.equal(id, 'empty');
    // 自铸 id(sessionId 为空)。
    const gen = sp.persistSession('', { messages: [M(0)], metadata: { cwd: CWD } });
    assert.ok(gen && gen.startsWith('sess-'));
  });
});
