'use strict';

/**
 * visionOcrSuccessClosure.test.js — describe-fail → OCR-成功用户可见闭合消息(纯叶子,OPS-MAN-144)。
 *
 * 锁死叶子契约:
 *   - 门 KHY_VISION_OCR_SUCCESS_CLOSURE default-on;仅显式 0/false/off/no 关(byte-revert→null);
 *   - buildOcrSuccessClosure:门开 + count>0 → 含 MARKER「视觉模型均不可用」+「本地 OCR 成功识别」
 *     +「正在据此作答」的闭合串;单/多张图名词正确;
 *   - 门关 / count<=0 / 畸形 → null;绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isVisionOcrSuccessClosureEnabled,
  buildOcrSuccessClosure,
  OCR_SUCCESS_CLOSURE_MARKER,
} = require('../../../src/services/gateway/visionOcrSuccessClosure');

test('gate default-on; off words close it (byte-revert)', () => {
  assert.strictEqual(isVisionOcrSuccessClosureEnabled({}), true);
  assert.strictEqual(isVisionOcrSuccessClosureEnabled(undefined), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(
      isVisionOcrSuccessClosureEnabled({ KHY_VISION_OCR_SUCCESS_CLOSURE: v }),
      false,
      `off word ${v}`,
    );
  }
  assert.strictEqual(isVisionOcrSuccessClosureEnabled({ KHY_VISION_OCR_SUCCESS_CLOSURE: 'yes' }), true);
});

test('buildOcrSuccessClosure: gate on + count>0 → closure with marker + OCR disclosure', () => {
  const s = buildOcrSuccessClosure({ count: 1, env: {} });
  assert.ok(s, 'should build');
  assert.match(s, new RegExp(OCR_SUCCESS_CLOSURE_MARKER), 'contains marker');
  assert.match(s, /本地 OCR 成功识别/, 'discloses OCR was used');
  assert.match(s, /正在据此作答/, 'resolves the 请稍候 promise');
  assert.match(s, /识别图片/, 'single image noun');
});

test('buildOcrSuccessClosure: multi-image count noun', () => {
  const s = buildOcrSuccessClosure({ count: 3, env: {} });
  assert.match(s, /3 张图片/, 'plural noun with count');
});

test('buildOcrSuccessClosure: gate OFF → null (byte-revert)', () => {
  assert.strictEqual(buildOcrSuccessClosure({ count: 2, env: { KHY_VISION_OCR_SUCCESS_CLOSURE: '0' } }), null);
});

test('buildOcrSuccessClosure: count<=0 / malformed → null', () => {
  assert.strictEqual(buildOcrSuccessClosure({ count: 0, env: {} }), null);
  assert.strictEqual(buildOcrSuccessClosure({ count: -1, env: {} }), null);
  assert.strictEqual(buildOcrSuccessClosure({ count: NaN, env: {} }), null);
  assert.strictEqual(buildOcrSuccessClosure({ env: {} }), null);
});

test('buildOcrSuccessClosure: never throws on junk', () => {
  assert.doesNotThrow(() => buildOcrSuccessClosure());
  assert.doesNotThrow(() => buildOcrSuccessClosure({ count: {}, env: null }));
  assert.doesNotThrow(() => isVisionOcrSuccessClosureEnabled(null));
});
