'use strict';

/**
 * latestUserText — guard tests for making the three truth-footer intent gates
 * (modelIdentityTruth / cacheMetricsTruth / visionRoutingTruth) read only the user's
 * CURRENT turn, fixing「不要每次回答都跟着一大段」.
 *
 * Root cause (see leaf header): pickUserText got the whole flattened conversation as
 * `prompt` (system prompt + every turn). The system prompt embeds the three truth
 * directives whose text quotes the trigger questions, so each isXxxQuestion self-matched
 * every turn → all three footers appended after every reply, even off-topic.
 *
 * Invariants:
 *   ① gate KHY_TRUTH_FOOTER_LATEST_USER_TEXT default ON; 0/false/off/no → OFF
 *   ② fromMessages: last user msg (string / block-array); skips assistant; '' when none
 *   ③ pickUserText ON: prefers messages' last user over the flattened prompt blob
 *   ④ pickUserText ON: falls back to prompt when no messages
 *   ⑤ pickUserText OFF: byte-identical legacy (returns the whole prompt blob)
 *   ⑥ BUG-FIX integration: a flattened prompt embedding the directive text + a benign
 *      last user msg → isIdentityQuestion/isCacheMetricsQuestion/isVisionQuestion all
 *      FALSE (ON), but TRUE under legacy (OFF) — proving the every-turn firing is fixed
 *   ⑦ never throws on bad input
 *   ⑧ LIVE wiring: the three modules delegate to latestUserText; flag registered
 *
 * node:test (jest via rtk proxy unavailable — Exec format error).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const leaf = require('../../src/services/latestUserText');
const mit = require('../../src/services/modelIdentityTruth');
const cmt = require('../../src/services/cacheMetricsTruth');
const vrt = require('../../src/services/visionRoutingTruth');
const BACKEND_ROOT = path.resolve(__dirname, '../../');

// A flattened conversation blob like buildFlatConversation produces, with the system
// prompt embedding the three truth directives (which quote the trigger phrases), then a
// benign off-topic user turn. This is the exact shape that made every footer fire.
const DIRECTIVE_BLOB = [
  'SYSTEM: 你必须如实回答:被问「你是什么模型」时报真实渠道+模型;',
  '被问「缓存命中率」时据实给数字;被问「哪些模型支持图像识别」时列出真实视觉模型。',
  '',
  'USER: 有没有免费的图像识别模型',
  'ASSISTANT: 这是一个 Canvas 2D 自由绘制应用……',
  'USER: 帮我把这个画板加一个撤销按钮',
].join('\n');

// ── ① gate default ON; falsy → OFF ────────────────────────────────────────
test('KHY_TRUTH_FOOTER_LATEST_USER_TEXT defaults ON, reverts on falsy words', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled({ KHY_TRUTH_FOOTER_LATEST_USER_TEXT: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.isEnabled({ KHY_TRUTH_FOOTER_LATEST_USER_TEXT: off }), false, `'${off}'`);
  }
  assert.strictEqual(leaf.isEnabled({ KHY_TRUTH_FOOTER_LATEST_USER_TEXT: '1' }), true);
});

// ── ② fromMessages ────────────────────────────────────────────────────────
test('fromMessages takes the last user message, skips assistant, handles blocks', () => {
  assert.strictEqual(
    leaf.fromMessages({ messages: [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: '  最后一句  ' },
    ] }), '最后一句');
  // block-array content
  assert.strictEqual(
    leaf.fromMessages({ messages: [
      { role: 'user', content: [{ type: 'text', text: 'a' }, { text: 'b' }, 'c'] },
    ] }), 'a b c');
  // no user / empty / bad input → ''
  assert.strictEqual(leaf.fromMessages({ messages: [{ role: 'assistant', content: 'x' }] }), '');
  assert.strictEqual(leaf.fromMessages({ messages: [] }), '');
  assert.strictEqual(leaf.fromMessages({}), '');
  assert.strictEqual(leaf.fromMessages(null), '');
});

// ── ③ pickUserText ON prefers messages over the flattened blob ────────────
test('pickUserText (ON) prefers the last user message over the flattened prompt', () => {
  const out = leaf.pickUserText(DIRECTIVE_BLOB, {
    messages: [{ role: 'user', content: '帮我把这个画板加一个撤销按钮' }],
  }, {});
  assert.strictEqual(out, '帮我把这个画板加一个撤销按钮');
});

// ── ④ pickUserText ON falls back to prompt when no messages ───────────────
test('pickUserText (ON) falls back to the prompt when no structured messages', () => {
  assert.strictEqual(leaf.pickUserText('  只有 prompt  ', {}, {}), '只有 prompt');
  assert.strictEqual(leaf.pickUserText('x', { messages: [] }, {}), 'x');
});

// ── ⑤ pickUserText OFF is byte-identical legacy (returns the blob) ─────────
test('pickUserText (OFF) reverts to legacy prompt-first (returns whole blob)', () => {
  const env = { KHY_TRUTH_FOOTER_LATEST_USER_TEXT: '0' };
  const out = leaf.pickUserText(DIRECTIVE_BLOB, {
    messages: [{ role: 'user', content: '帮我把这个画板加一个撤销按钮' }],
  }, env);
  assert.strictEqual(out, DIRECTIVE_BLOB.trim());
  assert.strictEqual(leaf.pickUserText(DIRECTIVE_BLOB, {}, env), DIRECTIVE_BLOB.trim());
});

// ── ⑥ BUG-FIX: the flattened blob no longer makes the gates fire (ON) ─────
test('BUG-FIX: benign turn + directive-laden blob → all three gates FALSE (ON)', () => {
  const options = { messages: [{ role: 'user', content: '帮我把这个画板加一个撤销按钮' }] };
  const text = leaf.pickUserText(DIRECTIVE_BLOB, options, {});
  // The gates see only the benign current turn → none fires.
  assert.strictEqual(mit.isIdentityQuestion(text), false, 'identity gate must not fire');
  assert.strictEqual(cmt.isCacheMetricsQuestion(text), false, 'metrics gate must not fire');
  assert.strictEqual(vrt.isVisionQuestion(text), false, 'vision gate must not fire');
});

test('BUG (legacy OFF): the same blob DID make gates fire — regression captured', () => {
  const legacyText = leaf.pickUserText(DIRECTIVE_BLOB, {}, { KHY_TRUTH_FOOTER_LATEST_USER_TEXT: '0' });
  // Under the old behavior the directive text self-matches → this is what we fixed.
  const anyFired = mit.isIdentityQuestion(legacyText)
    || cmt.isCacheMetricsQuestion(legacyText)
    || vrt.isVisionQuestion(legacyText);
  assert.strictEqual(anyFired, true, 'legacy blob must self-match (documents the bug)');
});

test('a genuine vision question this turn STILL fires vision (no over-correction)', () => {
  const options = { messages: [{ role: 'user', content: '有没有免费的图像识别模型' }] };
  const text = leaf.pickUserText(DIRECTIVE_BLOB, options, {});
  assert.strictEqual(vrt.isVisionQuestion(text), true, 'real vision ask must still fire');
  // but a vision ask must NOT trip identity/metrics
  assert.strictEqual(mit.isIdentityQuestion(text), false);
  assert.strictEqual(cmt.isCacheMetricsQuestion(text), false);
});

// ── ⑦ never throws ────────────────────────────────────────────────────────
test('pickUserText never throws on bad input', () => {
  assert.strictEqual(leaf.pickUserText(undefined, undefined, {}), '');
  assert.strictEqual(leaf.pickUserText(null, null, {}), '');
  assert.strictEqual(leaf.pickUserText(123, { messages: 'nope' }, {}), '123');
});

// ── ⑧ LIVE wiring ─────────────────────────────────────────────────────────
test('the three truth modules delegate pickUserText to latestUserText', () => {
  for (const f of ['modelIdentityTruth.js', 'cacheMetricsTruth.js', 'visionRoutingTruth.js']) {
    const src = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services', f), 'utf8');
    assert.ok(/require\(['"]\.\/latestUserText['"]\)\.pickUserText\(prompt,\s*options,\s*process\.env\)/.test(src),
      `${f} must delegate pickUserText to latestUserText`);
  }
});

test('flagRegistry registers KHY_TRUTH_FOOTER_LATEST_USER_TEXT default ON', () => {
  const reg = require('../../src/services/flagRegistry');
  assert.strictEqual(reg.isFlagEnabled('KHY_TRUTH_FOOTER_LATEST_USER_TEXT', {}), true);
  assert.strictEqual(
    reg.isFlagEnabled('KHY_TRUTH_FOOTER_LATEST_USER_TEXT', { KHY_TRUTH_FOOTER_LATEST_USER_TEXT: 'off' }), false);
});
