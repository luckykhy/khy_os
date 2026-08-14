'use strict';

/**
 * P1 溯源标签基线测试（DESIGN-ARCH-047 PHASE 1）。
 *
 * 覆盖：
 *   - khyTrace schema/枚举/盖戳/fail-safe-to-ours/未知 producer 坍缩 relay
 *   - provenanceClassifier producer×trust 矩阵
 *   - traceProjection 内联标签 / 矛盾标签 / 回放行 / 链状态行 字形确定性
 *   - sessionPersistence.appendMessage 把 _khyTrace 写入 JSONL（显式 + 据 hint 派生 + 缺省）
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const khyTrace = require('../../../src/services/trajectoryProvenance/khyTrace');
const classifier = require('../../../src/services/trajectoryProvenance/provenanceClassifier');
const projection = require('../../../src/services/trajectoryProvenance/traceProjection');
const sessionPersistence = require('../../../src/services/sessionPersistence');

const { PRODUCER, TRUST, KIND } = khyTrace;

const TMP = path.join(os.tmpdir(), `khy-traj-p1-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('khyTrace schema & 防呆', () => {
  test('makeTrace 默认 fail-safe 到 khy-local/verified', () => {
    const t = khyTrace.makeTrace();
    assert.equal(t.producer, PRODUCER.KHY_LOCAL);
    assert.equal(t.trust, TRUST.VERIFIED);
    assert.equal(t.v, khyTrace.TRACE_VERSION);
    assert.deepEqual(t.contradictions, []);
    assert.equal(t.seal, null);
  });

  test('未知 producer 坍缩为 relay:<raw>，永不抛', () => {
    const { producer, producerId } = khyTrace.normalizeProducer('weird-agent', null);
    assert.equal(producer, PRODUCER.RELAY);
    assert.equal(producerId, 'weird-agent');
  });

  test('外部 producer 缺 trust → claimed（绝不默认给外部 verified）', () => {
    const t = khyTrace.makeTrace({ producer: PRODUCER.CODEX });
    assert.equal(t.trust, TRUST.CLAIMED);
  });

  test('stamp 返回浅拷贝且带合法 _khyTrace；isTrace/traceOf 一致', () => {
    const src = { role: 'assistant', content: 'hi' };
    const out = khyTrace.stamp(src, { producer: PRODUCER.CLAUDE_CODE, kind: KIND.TEXT });
    assert.equal(src._khyTrace, undefined, '原对象不被改写');
    assert.ok(khyTrace.isTrace(out));
    assert.equal(khyTrace.traceOf(out).producer, PRODUCER.CLAUDE_CODE);
  });

  test('traceOf 对无 trace 条目返回 fail-safe 信封而非 null', () => {
    const t = khyTrace.traceOf({ role: 'user' });
    assert.equal(t.producer, PRODUCER.KHY_LOCAL);
    assert.equal(t.trust, TRUST.VERIFIED);
  });

  test('isRelayed 判定', () => {
    assert.equal(khyTrace.isRelayed(PRODUCER.KHY_LOCAL), false);
    assert.equal(khyTrace.isRelayed(PRODUCER.CODEX), true);
    assert.equal(khyTrace.isRelayed('garbage'), false);
  });
});

describe('provenanceClassifier 矩阵', () => {
  const cases = [
    [{ adapter: 'codex' }, PRODUCER.CODEX, TRUST.CLAIMED],
    [{ adapter: 'codex-direct' }, PRODUCER.CODEX, TRUST.CLAIMED],
    [{ provider: 'claude-code' }, PRODUCER.CLAUDE_CODE, TRUST.CLAIMED],
    [{ adapter: 'relay_api', endpoint: 'https://x/v1' }, PRODUCER.RELAY, TRUST.CLAIMED],
    [{ serviceType: 'responses' }, PRODUCER.KHY_LOCAL, TRUST.VERIFIED],
    [{ adapter: 'anthropic' }, PRODUCER.KHY_LOCAL, TRUST.VERIFIED],
    [{}, PRODUCER.KHY_LOCAL, TRUST.VERIFIED],
  ];
  for (const [sig, prod, trust] of cases) {
    test(`${JSON.stringify(sig)} → ${prod}/${trust}`, () => {
      const r = classifier.classify(sig);
      assert.equal(r.producer, prod);
      assert.equal(r.trust, trust);
    });
  }

  test('relay 携带 producerId（endpoint 优先）', () => {
    const r = classifier.classify({ adapter: 'relay_api', endpoint: 'https://up/v1', model: 'm' });
    assert.equal(r.producer, PRODUCER.RELAY);
    assert.equal(r.producerId, 'https://up/v1');
  });
});

describe('traceProjection 字形确定性', () => {
  test('verified / claimed / quarantined 内联标签', () => {
    assert.equal(projection.inlineLabel(khyTrace.stamp({}, { producer: PRODUCER.KHY_LOCAL })), '✓ KHY executed');
    assert.equal(projection.inlineLabel(khyTrace.stamp({}, { producer: PRODUCER.CODEX, trust: TRUST.CLAIMED })), '⟳ codex claims');
    assert.equal(projection.inlineLabel(khyTrace.stamp({}, { producer: PRODUCER.CODEX, trust: TRUST.QUARANTINED })), '⚠ quarantined');
  });

  test('relay 带 producerId 显示 producer:id', () => {
    const e = khyTrace.stamp({}, { producer: PRODUCER.RELAY, producerId: 'up1', trust: TRUST.CLAIMED });
    assert.equal(projection.inlineLabel(e), '⟳ relay:up1 claims');
  });

  test('contradictionLabels 渲染矛盾', () => {
    const e = khyTrace.stamp({}, {
      producer: PRODUCER.CODEX, trust: TRUST.CLAIMED,
      contradictions: [{ claim: '已删除 db', expectedTool: 'Delete' }],
    });
    assert.deepEqual(projection.contradictionLabels(e), ['⚠ unverified claim: "已删除 db" (no Delete ran)']);
  });

  test('replayRow 结构', () => {
    const row = projection.replayRow(khyTrace.stamp({}, { producer: PRODUCER.CODEX, trust: TRUST.CLAIMED }), 3);
    assert.equal(row.index, 3);
    assert.equal(row.glyph, '⟳');
    assert.equal(row.producer, 'codex');
    assert.equal(row.label, '⟳ codex claims');
  });

  test('chainStatusLine 三态', () => {
    assert.equal(projection.chainStatusLine({ ok: true, length: 5 }), '✓ chain intact (5 entries)');
    assert.equal(projection.chainStatusLine({ ok: false, brokenAt: 2, reason: 'x' }), '⚠ chain broken @ #2 — x');
    assert.equal(projection.chainStatusLine({ available: false }), 'chain: unavailable');
    assert.equal(projection.chainStatusLine(null), 'chain: unavailable');
  });
});

describe('sessionPersistence.appendMessage 写入 _khyTrace', () => {
  function readEntries(sessionId) {
    const f = path.join(TMP, `${sessionId}.jsonl`);
    return fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  test('显式 _khyTrace 原样保留', () => {
    const sid = 'sess-explicit';
    const trace = khyTrace.makeTrace({ producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, kind: KIND.TEXT });
    sessionPersistence.appendMessage(sid, { role: 'assistant', content: 'x', _khyTrace: trace }, null, TMP);
    const [e] = readEntries(sid);
    assert.equal(e._khyTrace.producer, PRODUCER.CODEX);
    assert.equal(e._khyTrace.trust, TRUST.CLAIMED);
  });

  test('据 _khyProvenance hint 派生', () => {
    const sid = 'sess-hint';
    sessionPersistence.appendMessage(sid, {
      role: 'assistant', content: 'y',
      _khyProvenance: { producer: PRODUCER.RELAY, producerId: 'up', trust: TRUST.CLAIMED },
    }, null, TMP);
    const [e] = readEntries(sid);
    assert.equal(e._khyTrace.producer, PRODUCER.RELAY);
    assert.equal(e._khyTrace.producerId, 'up');
    assert.equal(e._khyTrace.trust, TRUST.CLAIMED);
  });

  test('缺省 fail-safe khy-local/verified', () => {
    const sid = 'sess-default';
    sessionPersistence.appendMessage(sid, { role: 'user', content: 'hello' }, null, TMP);
    const [e] = readEntries(sid);
    assert.equal(e._khyTrace.producer, PRODUCER.KHY_LOCAL);
    assert.equal(e._khyTrace.trust, TRUST.VERIFIED);
  });
});
