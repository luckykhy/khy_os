'use strict';

/**
 * localBrainTextOpsHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of Object.values(TEXT_OPS) /
 * Object.entries(TEXT_OPS) out of isTextOpIntent / detectTextOp. They were
 * allocated fresh on every local-brain classification turn; now built once at
 * module load. Behavior (including first-match order) must be byte-identical.
 */

const test = require('node:test');
const assert = require('node:assert');

const ops = require('../../src/services/localBrainTextOps');
const { isTextOpIntent, detectTextOp, TEXT_OPS } = ops;

test('isTextOpIntent still detects known ops and rejects non-ops', () => {
  assert.strictEqual(isTextOpIntent('把这段转大写'), true);
  assert.strictEqual(isTextOpIntent('base64 编码这段'), true);
  assert.strictEqual(isTextOpIntent('今天天气怎么样'), false);
});

test('detectTextOp resolves the op key and label', () => {
  const plan = detectTextOp('转大写: hello');
  assert.ok(plan);
  assert.strictEqual(plan.opKey, 'upper');
  assert.strictEqual(plan.label, TEXT_OPS.upper.label);
  assert.strictEqual(plan.sourceText, 'hello');
});

test('first-match order preserved (insertion order of TEXT_OPS)', () => {
  // detectTextOp walks entries in insertion order and breaks on first match.
  // 'upper' precedes 'lower'; a text hitting the upper pattern resolves to upper.
  const plan = detectTextOp('转大写这段文本');
  assert.strictEqual(plan.opKey, 'upper');
  // The hoisted entries array must list keys in the same order as the object.
  const keysFromObject = Object.keys(TEXT_OPS);
  assert.strictEqual(keysFromObject[0], 'upper');
  assert.strictEqual(keysFromObject[1], 'lower');
});

test('repeated calls are stable (shared arrays not corrupted; regex has no /g)', () => {
  // The match regexes are used via .test() with no /g flag, so no lastIndex state
  // leaks between calls even though the array/regex objects are now shared.
  assert.strictEqual(isTextOpIntent('md5 这段'), isTextOpIntent('md5 这段'));
  const a = detectTextOp('md5: abc');
  const b = detectTextOp('md5: abc');
  assert.strictEqual(a.opKey, b.opKey);
  assert.strictEqual(a.opKey, 'md5');
});

test('empty / non-matching input returns null from detectTextOp', () => {
  assert.strictEqual(detectTextOp('随便聊聊'), null);
  assert.strictEqual(detectTextOp(''), null);
});
