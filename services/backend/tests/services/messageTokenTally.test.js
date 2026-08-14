'use strict';

/**
 * messageTokenTally — guard tests for the per-message token-estimate memo that
 * kills toolUseLoop's per-iteration O(N²) full-history reduce (goal「任务体验卡顿,
 * 无法做真正的软件项目/交付」).
 *
 * Invariants:
 *   ① gate KHY_MSG_TOKEN_MEMO default ON; 0/false/off/no → OFF (byte-revert)
 *   ② byte-identical: sumMessageTokens === the original inline reduce, for
 *      string content, structured content, empty/missing content, mixed
 *   ③ memo HIT: a surviving message object is estimated exactly once across
 *      many calls (the whole point — frozen prefix not recomputed each iter)
 *   ④ only NEW messages compute: append-only growth → +1 estimate per appended
 *      message, not a full re-scan (O(N²)→O(N))
 *   ⑤ gate OFF → estimate every element every call (no memo), same sum
 *   ⑥ estimateFn identity is part of the memo (different fn → recompute)
 *   ⑦ null/primitive message preserves original observable behavior
 *      (null.content throws; primitive → JSON.stringify('') branch)
 *   ⑧ LIVE wiring: toolUseLoop routes all 3 reduce sites through
 *      sumMessageTokens; flagRegistry registers KHY_MSG_TOKEN_MEMO
 *
 * node:test (jest via rtk proxy is unavailable — Exec format error).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const tally = require('../../src/services/messageTokenTally');
const BACKEND_ROOT = path.resolve(__dirname, '../../');

// The exact per-element expression the original reduce used — ground truth.
function originalReduce(messages, estimateFn) {
  return messages.reduce(
    (sum, m) => sum + estimateFn(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')),
    0
  );
}

// A deterministic estimator that also counts how many times it ran (to prove hits).
function mkEstimator() {
  const fn = (text) => { fn.calls++; return Math.ceil((text || '').length / 4); };
  fn.calls = 0;
  return fn;
}

// ── ① gate default ON; falsy words → OFF ──────────────────────────────────
test('KHY_MSG_TOKEN_MEMO defaults ON, reverts on falsy words', () => {
  assert.strictEqual(tally.isMsgTokenMemoEnabled({}), true);
  assert.strictEqual(tally.isMsgTokenMemoEnabled({ KHY_MSG_TOKEN_MEMO: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(tally.isMsgTokenMemoEnabled({ KHY_MSG_TOKEN_MEMO: off }), false, `'${off}'`);
  }
  assert.strictEqual(tally.isMsgTokenMemoEnabled({ KHY_MSG_TOKEN_MEMO: '1' }), true);
});

// ── ② byte-identical to the original inline reduce ────────────────────────
test('sumMessageTokens equals original reduce across content shapes', () => {
  const est = (text) => Math.ceil((text || '').length / 4);
  const cases = [
    [{ role: 'user', content: 'hello world' }],
    [{ role: 'assistant', content: [{ type: 'text', text: 'a structured block with some length' }] }],
    [{ role: 'user', content: '' }],
    [{ role: 'user' }], // missing content → JSON.stringify('') branch
    [
      { role: 'user', content: 'plain string' },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { path: '/x' } }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'RESULT' }] },
    ],
  ];
  for (const msgs of cases) {
    assert.strictEqual(
      tally.sumMessageTokens(msgs, est, {}),
      originalReduce(msgs, est),
      JSON.stringify(msgs).slice(0, 40),
    );
  }
});

// ── ③ memo HIT: surviving message estimated exactly once ──────────────────
test('a surviving message object is estimated once across many calls', () => {
  const m = { role: 'user', content: 'frozen prefix message' };
  const est = mkEstimator();
  const s1 = tally.sumMessageTokens([m], est, {});
  const s2 = tally.sumMessageTokens([m], est, {});
  const s3 = tally.sumMessageTokens([m], est, {});
  assert.strictEqual(s1, s2);
  assert.strictEqual(s2, s3);
  assert.strictEqual(est.calls, 1, 'estimateFn must run once for a stable message object');
});

// ── ④ only NEW messages compute (append-only O(N)) ────────────────────────
test('append-only growth estimates each message exactly once total', () => {
  const est = mkEstimator();
  const msgs = [];
  let expectedSum = 0;
  for (let i = 0; i < 50; i++) {
    const m = { role: 'user', content: `message number ${i} with content` };
    msgs.push(m);
    expectedSum += Math.ceil(m.content.length / 4);
    // Simulate a capacity decision returning a NEW array reusing the same objects.
    const snapshot = msgs.slice();
    const sum = tally.sumMessageTokens(snapshot, est, {});
    assert.strictEqual(sum, expectedSum, `iter ${i}`);
  }
  // Naive would be 1+2+...+50 = 1275 estimateFn calls; memo does exactly 50.
  assert.strictEqual(est.calls, 50, 'each message estimated exactly once across all iterations');
});

// ── ⑤ gate OFF → estimate every element every call, same sum ──────────────
test('gate OFF → no memo, estimateFn runs every element every call', () => {
  const m = { role: 'user', content: 'no-memo path' };
  const est = mkEstimator();
  const env = { KHY_MSG_TOKEN_MEMO: 'off' };
  const s1 = tally.sumMessageTokens([m], est, env);
  const s2 = tally.sumMessageTokens([m], est, env);
  assert.strictEqual(s1, s2);
  assert.strictEqual(s1, originalReduce([m], (t) => Math.ceil((t || '').length / 4)));
  assert.strictEqual(est.calls, 2, 'gate off must recompute every call');
});

// ── ⑥ estimateFn identity is part of the memo (never returns a stale value) ─
test('changing estimateFn never returns a stale memoized value', () => {
  const m = { role: 'user', content: 'shared message' };
  const estA = (t) => (t || '').length;          // length
  const estB = (t) => Math.ceil((t || '').length / 4); // quartered
  const a1 = tally.sumMessageTokens([m], estA, {});
  const a2 = tally.sumMessageTokens([m], estA, {}); // same fn → hit, same value
  const b1 = tally.sumMessageTokens([m], estB, {}); // different fn → must NOT reuse A's value
  assert.strictEqual(a1, a2);
  assert.strictEqual(a1, originalReduce([m], estA));
  assert.strictEqual(b1, originalReduce([m], estB));
  assert.notStrictEqual(a1, b1, 'different estimators must yield different sums (no stale reuse)');
});

test('repeated same-fn calls hit the memo (estimateFn runs once)', () => {
  const m = { role: 'user', content: 'stable content for hit counting' };
  const est = mkEstimator();
  tally.sumMessageTokens([m], est, {});
  tally.sumMessageTokens([m], est, {});
  tally.sumMessageTokens([m], est, {});
  assert.strictEqual(est.calls, 1, 'same fn + same message → computed once');
});

// ── ⑦ null / primitive message preserves original observable behavior ─────
test('null message throws like the original reduce', () => {
  const est = (t) => (t || '').length;
  assert.throws(() => tally.sumMessageTokens([null], est, {}), TypeError);
  assert.throws(() => originalReduce([null], est), TypeError);
});

test('primitive message → JSON.stringify empty branch, byte-identical', () => {
  const est = (t) => (t || '').length;
  const msgs = ['some string that is not an object'];
  assert.strictEqual(tally.sumMessageTokens(msgs, est, {}), originalReduce(msgs, est));
});

// ── ⑧ LIVE wiring guards ──────────────────────────────────────────────────
test('toolUseLoop routes all 3 token-tally sites through sumMessageTokens', () => {
  const src = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/toolUseLoop.js'), 'utf8');
  const hits = src.match(/messageTokenTally['"]\)\.sumMessageTokens/g) || [];
  assert.ok(hits.length >= 3, `expected >=3 sumMessageTokens call sites, found ${hits.length}`);
  // and each keeps the original reduce as a fail-soft fallback (byte-revert on error)
  const fallbacks = src.match(/conversationMessages\.reduce\(/g) || [];
  assert.ok(fallbacks.length >= 3, `expected >=3 reduce fallbacks, found ${fallbacks.length}`);
});

test('flagRegistry registers KHY_MSG_TOKEN_MEMO default ON', () => {
  const reg = require('../../src/services/flagRegistry');
  assert.strictEqual(reg.isFlagEnabled('KHY_MSG_TOKEN_MEMO', {}), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_MSG_TOKEN_MEMO', { KHY_MSG_TOKEN_MEMO: 'off' }), false);
});

// ── E2E: real tokenUsageService.estimateTokens preserved through the memo ──
test('E2E: memo preserves real estimateTokens output', () => {
  let est;
  try { est = require('../../src/services/tokenUsageService').estimateTokens; }
  catch { est = null; }
  if (typeof est !== 'function') return; // env without the service → skip
  const msgs = [
    { role: 'user', content: '你好世界 mixed CJK and ascii content here' },
    { role: 'assistant', content: [{ type: 'text', text: 'another block 更多中文字符测试' }] },
  ];
  assert.strictEqual(tally.sumMessageTokens(msgs, est, {}), originalReduce(msgs, est));
  // second call (all hits) still equal
  assert.strictEqual(tally.sumMessageTokens(msgs, est, {}), originalReduce(msgs, est));
});
