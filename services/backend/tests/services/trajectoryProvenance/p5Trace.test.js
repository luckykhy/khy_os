'use strict';

/**
 * P5 人机双投影 + `khy trace` 命令测试（DESIGN-ARCH-047 PHASE 5）。
 *
 * 覆盖：
 *   - sessionPersistence.verifyTraceChain：完整链 / 篡改正文 / 缺链 三态
 *   - traceProjection.replayRow + chainStatusLine 确定性渲染
 *   - handlers/trace：list / show / verify 只读运行不抛，且不改盘上文件
 *   - 隔离条目（quarantined）回放只出标签、不回显原文（gatewayLogLease 可见性）
 *   - 未知 session 友好处理（不崩）
 *
 * 注意：在 require 任何持久化模块**之前**先钉 KHY_PROJECT_DATA_HOME 到临时目录，
 * 因 dataHome 首次解析即缓存。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `khy-traj-p5-${process.pid}`);
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const sessionPersistence = require('../../../src/services/sessionPersistence');
const projection = require('../../../src/services/trajectoryProvenance/traceProjection');
const khyTrace = require('../../../src/services/trajectoryProvenance/khyTrace');
const { handleTrace } = require('../../../src/cli/handlers/trace');

const { PRODUCER, TRUST } = khyTrace;

after(() => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ } });

// ── 准备一条带本地+中转+隔离三类条目的会话 ──
const SID_GOOD = 'p5-good';
const SID_TAMPER = 'p5-tamper';

before(() => {
  // 经 persistSession 落「快照 + JSONL + sidecar 链」三件，贴近真实路径。
  sessionPersistence.persistSession(SID_GOOD, {
    title: '删除旧表会话', model: 'codex',
    metadata: { cwd: TMP_HOME },
    messages: [
      // 本地 user → verified（缺省 fail-safe-to-ours）
      { role: 'user', content: '请删除旧表' },
      // 中转 assistant，正文夹带未发生的删除声称 → claimed + 矛盾
      {
        role: 'assistant', content: '我已经删除了旧表',
        _khyProvenance: {
          producer: PRODUCER.CODEX, trust: TRUST.CLAIMED,
          contradictions: [{ claim: '我已经删除了旧表', expectedTool: 'Delete', found: false }],
        },
      },
      // 被隔离的中转工具调用
      {
        role: 'tool', content: 'rm -rf /etc/secret',
        _khyTrace: { v: 1, producer: PRODUCER.CODEX, trust: TRUST.QUARANTINED, kind: khyTrace.KIND.TOOL_CALL },
      },
    ],
  });

  // 第二条会话用于篡改检测
  sessionPersistence.persistSession(SID_TAMPER, {
    title: 'tamper', model: 'codex',
    metadata: { cwd: TMP_HOME },
    messages: [
      { role: 'user', content: 'real question' },
      { role: 'assistant', content: 'real answer' },
    ],
  });
});

describe('verifyTraceChain 三态', () => {
  test('完整会话 → ok + available', () => {
    const v = sessionPersistence.verifyTraceChain(SID_GOOD);
    assert.equal(v.available, true);
    assert.equal(v.ok, true);
    assert.equal(v.length, 3);
  });

  test('改 JSONL 一行正文 → ok:false 定位首坏块', () => {
    // 找出该会话的 jsonl 文件并手改首行正文
    const root = path.join(TMP_HOME, 'sessions');
    let jf = null;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === `${SID_TAMPER}.jsonl`) jf = full;
      }
    })(root);
    assert.ok(jf, '应找到 tamper 会话 jsonl');
    const lines = fs.readFileSync(jf, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    lines[0].content = 'forged question';
    fs.writeFileSync(jf, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const v = sessionPersistence.verifyTraceChain(SID_TAMPER);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 0);
  });

  test('未知 session → available:false 不抛', () => {
    const v = sessionPersistence.verifyTraceChain('does-not-exist');
    assert.equal(v.available, false);
    assert.equal(v.ok, false);
  });
});

describe('traceProjection 回放投影确定性', () => {
  test('replayRow 字形 + 矛盾标签', () => {
    const chain = sessionPersistence.buildConversationChain(SID_GOOD);
    const rows = chain.map((e, i) => projection.replayRow(e, i));
    // user = verified
    assert.equal(rows[0].trust, TRUST.VERIFIED);
    assert.equal(rows[0].glyph, '✓');
    // assistant = claimed + 1 矛盾
    assert.equal(rows[1].trust, TRUST.CLAIMED);
    assert.equal(rows[1].glyph, '⟳');
    assert.match(rows[1].label, /codex claims/);
    assert.equal(rows[1].contradictions.length, 1);
    assert.match(rows[1].contradictions[0], /no Delete ran/);
    // tool = quarantined
    assert.equal(rows[2].trust, TRUST.QUARANTINED);
    assert.equal(rows[2].glyph, '⚠');
  });

  test('chainStatusLine 三态文本', () => {
    assert.match(projection.chainStatusLine({ available: true, ok: true, length: 3 }), /chain intact \(3 entries\)/);
    assert.match(projection.chainStatusLine({ available: true, ok: false, brokenAt: 2, reason: 'x' }), /chain broken @ #2/);
    assert.equal(projection.chainStatusLine({ available: false }), 'chain: unavailable');
  });
});

describe('handlers/trace 只读运行', () => {
  // 捕获 console.log，并断言不改盘
  let logs;
  let origLog;
  before(() => { origLog = console.log; });
  after(() => { console.log = origLog; });
  function capture() { logs = []; console.log = (...a) => logs.push(a.join(' ')); }
  function restore() { console.log = origLog; }

  function snapshotDir() {
    const root = path.join(TMP_HOME, 'sessions');
    const map = {};
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else map[full] = fs.statSync(full).mtimeMs + ':' + fs.statSync(full).size;
      }
    })(root);
    return map;
  }

  test('trace list 列出会话不抛', async () => {
    capture();
    await handleTrace('list', []);
    restore();
    assert.ok(logs.join('\n').includes(SID_GOOD));
  });

  test('trace show <good> 回放且隔离条目不回显原文', async () => {
    const before = snapshotDir();
    capture();
    await handleTrace('show', [SID_GOOD]);
    restore();
    const out = logs.join('\n');
    assert.match(out, /codex claims/);
    assert.match(out, /no Delete ran/);
    // 隔离原文「rm -rf /etc/secret」绝不出现
    assert.ok(!out.includes('rm -rf /etc/secret'), '隔离条目原文不得回显');
    assert.match(out, /内容已隔离/);
    // 只读：盘上文件无变化
    assert.deepEqual(snapshotDir(), before);
  });

  test('trace verify <tamper> 报断链', async () => {
    capture();
    await handleTrace('verify', [SID_TAMPER]);
    restore();
    assert.match(logs.join('\n'), /chain broken @ #0/);
  });

  test('trace show 未知 session 友好报错不抛', async () => {
    capture();
    await assert.doesNotReject(handleTrace('show', ['nope-nope']));
    restore();
  });
});
