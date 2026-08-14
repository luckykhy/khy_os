'use strict';

/**
 * ilinkDispatcher 的账号感知会话键与全局串行执行锁接线。
 *
 * 两条线:
 *   1. buildSessionKey —— 纯函数,按 dmScope 把 (scope, accountId, userId) 映射成会话键。
 *      非法 scope 回退到 per-account-channel-peer 形式,绝不抛。
 *   2. dispatcher 接线 —— 不同 accountId 落到不同会话键(spy ai.scopeSession 断言);
 *      多账号并发查询经 ilinkExecutionLock 严格串行,执行区间不重叠。
 *
 * 全部离线:注入假 chat / 假通道,关掉结构化工具循环,不触模型、不触网络。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilinkdisp-'));
// 关掉结构化工具循环:让注入的假 chat 直接被调,断言的是接线本身而非循环消化返回值。
process.env.KHY_ILINK_DISABLE_TOOL_LOOP = '1';
process.env.KHY_ILINK_TYPING_KEEPALIVE_MS = '5';
// 把墙钟上限放宽,避免并发用例的 30ms 查询被看门狗误砍。
process.env.KHY_ILINK_QUERY_TIMEOUT_MS = '5000';

const { IlinkDispatcher, buildSessionKey, normalizeReply } =
  require('../../../src/services/channels/ilinkDispatcher');

// ── buildSessionKey:纯函数,四种 scope + 非法回退 ────────────────────────────

test('buildSessionKey: main → 所有 peer 共享一条历史', () => {
  assert.strictEqual(buildSessionKey('main', 'acc1', 'u1'), 'ilink:shared');
  assert.strictEqual(buildSessionKey('main', 'accX', 'u9'), 'ilink:shared', 'main 不看 account/user');
});

test('buildSessionKey: per-peer 与 per-channel-peer 只按 userId 隔离', () => {
  assert.strictEqual(buildSessionKey('per-peer', 'acc1', 'u1'), 'ilink:u1');
  assert.strictEqual(buildSessionKey('per-channel-peer', 'acc2', 'u1'), 'ilink:u1', '这两种 scope 不带 account');
});

test('buildSessionKey: per-account-channel-peer 按 account+user 双维隔离(默认)', () => {
  assert.strictEqual(buildSessionKey('per-account-channel-peer', 'acc1', 'u1'), 'ilink:acc1:u1');
  assert.notStrictEqual(
    buildSessionKey('per-account-channel-peer', 'acc1', 'u1'),
    buildSessionKey('per-account-channel-peer', 'acc2', 'u1'),
    '不同账号必须落到不同会话键',
  );
});

test('buildSessionKey: 非法/未知 scope 回退到 per-account-channel-peer 形式(不抛)', () => {
  assert.strictEqual(buildSessionKey('nope', 'acc1', 'u1'), 'ilink:acc1:u1');
  assert.strictEqual(buildSessionKey(undefined, 'acc1', 'u1'), 'ilink:acc1:u1');
  assert.strictEqual(buildSessionKey('', 'acc1', 'u1'), 'ilink:acc1:u1');
  assert.strictEqual(buildSessionKey(null, 'acc1', 'u1'), 'ilink:acc1:u1');
});

test('buildSessionKey: userId 清洗与既有实现一致(trim)', () => {
  assert.strictEqual(buildSessionKey('per-peer', 'acc1', '  u1  '), 'ilink:u1');
  assert.strictEqual(buildSessionKey('per-account-channel-peer', 'acc1', '\tu1\n'), 'ilink:acc1:u1');
  assert.strictEqual(buildSessionKey('per-peer', 'acc1', null), 'ilink:', '空 userId 也不抛');
});

/// ── normalizeReply:tool 块降级清洗 ─────────────────────────────────────────────────
// 中断轮次残留的 tool 块会随 finalResponse 流到这里;透传就是微信用户看到原始 JSON。

test('normalizeReply: 结构化 content blocks 的 JSON 降级为纯文本', () => {
  const blocks = JSON.stringify([
    { type: 'text', text: '已读完文件。' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.js' } },
  ]);
  const r = normalizeReply({ finalResponse: blocks });
  assert.strictEqual(r, '已读完文件。');
  assert.ok(!r.includes('tool_use'), '不得透传 tool_use 标记');
});

test('normalizeReply: 文本中散落的 tool 块行被滤掉,正常文本保留', () => {
  const mixed = '结果如下:\n{"type":"tool_use","id":"t2","name":"Bash"}\n完成。';
  const r = normalizeReply({ finalResponse: mixed });
  assert.ok(!r.includes('"type":"tool_use"'), `清洗后不得含 tool_use JSON:${r}`);
  assert.ok(r.includes('结果如下:'), '正常文本不得被误删');
  assert.ok(r.includes('完成。'), '正常文本不得被误删');
});

test('normalizeReply: tool_result 块 JSON 也被降级(取其文本内容)', () => {
  const blocks = JSON.stringify([{ type: 'tool_result', tool_use_id: 't3', content: '命令输出' }]);
  const r = normalizeReply({ finalResponse: blocks });
  assert.strictEqual(r, '命令输出');
});

test('normalizeReply: 普通文本逐字节不变(零回归)', () => {
  assert.strictEqual(normalizeReply('你好，世界'), '你好，世界');
  assert.strictEqual(normalizeReply({ reply: '  ok  ' }), 'ok');
  assert.strictEqual(normalizeReply(null), null);
  assert.strictEqual(normalizeReply({ reply: '   ' }), null);
});

test('normalizeReply: single-object tool_use JSON never yields [object Object]', () => {
  const objPayload = '{"type":"tool_use","id":"t1","name":"Read"}';
  const r = normalizeReply({ finalResponse: objPayload });
  assert.notStrictEqual(r, '[object Object]');
  assert.ok(!String(r || '').includes('[object Object]'));
});

test('normalizeReply: multi-line object JSON falls back to line filter', () => {
  const multiline = ['{', '"note": "keep-me",', '"type": "tool_use"', '}'].join('\n');
  const r = normalizeReply({ finalResponse: multiline });
  assert.ok(!String(r || '').includes('[object Object]'));
  assert.ok(String(r).includes('keep-me'));
  assert.ok(!/"type"\s*:\s*"tool_use"/.test(String(r)));
});

test('normalizeReply: plain text without tool markers is untouched', () => {
  const plain = 'done: {a:1} saved';
  assert.strictEqual(normalizeReply({ finalResponse: plain }), plain);
});

// ── dispatcher 接线:accountId 感知的会话键 ───────────────────────────────────

/** 只收集出站文本的假通道。 */
function fakeChannel() {
  const out = [];
  return {
    out,
    async sendReply(_c, _t, x) { out.push(String(x)); return { ok: true, sent: 1 }; },
    async setTyping() { return true; },
  };
}

test('dispatcher: 不同 accountId 生成不同会话键(默认 per-account-channel-peer)', async () => {
  // scopeSession 是进程级单例操作;spy 它即可断言 dispatcher 传下去的会话键。
  const ai = require('../../../src/cli/ai');
  const original = ai.scopeSession;
  const keys = [];
  ai.scopeSession = (key) => { keys.push(key); };
  try {
    const dA = new IlinkDispatcher({ channel: fakeChannel(), accountId: 'botA', getChat: () => async () => 'ok' });
    const dB = new IlinkDispatcher({ channel: fakeChannel(), accountId: 'botB', getChat: () => async () => 'ok' });
    await dA.handle({ userId: 'u1', channelId: 'u1', text: '你好' });
    await dB.handle({ userId: 'u1', channelId: 'u1', text: '你好' });
    assert.deepStrictEqual(
      keys, ['ilink:botA:u1', 'ilink:botB:u1'],
      `同一 userId 在不同账号下应落到不同会话键:${keys.join('|')}`,
    );
  } finally {
    ai.scopeSession = original;
  }
});

test('dispatcher: 两个账号并发 handle,chat 执行区间不重叠(全局串行锁)', async () => {
  let active = 0;
  let maxActive = 0;
  const mkChat = () => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    // 让出事件循环:若锁失效,两个查询会在此交错,maxActive 会涨到 2。
    await new Promise((r) => setTimeout(r, 30));
    active -= 1;
    return 'ok';
  };
  const dA = new IlinkDispatcher({ channel: fakeChannel(), accountId: 'botA', getChat: () => mkChat() });
  const dB = new IlinkDispatcher({ channel: fakeChannel(), accountId: 'botB', getChat: () => mkChat() });

  await Promise.all([
    dA.handle({ userId: 'u1', channelId: 'u1', text: 'q1' }),
    dB.handle({ userId: 'u2', channelId: 'u2', text: 'q2' }),
  ]);

  assert.strictEqual(maxActive, 1, '全局锁必须保证任一时刻只有一个 agent 查询在跑');
});
