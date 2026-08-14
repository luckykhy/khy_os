'use strict';

/**
 * visionRateLimitOcrRescue.test.js — 回归「视觉通道限流(429/瞬态)终局退回本地 OCR」判定叶子。
 *
 * 覆盖:门控默认开/显式关、瞬态错误类型 + 握图为真、无图/非瞬态类型为假、
 * 与既有模型拒绝兜底(shouldOcrRescue)正交、note 文案/marker/门控、独立门控隔离。
 * 纯叶子零 IO,不触真实 OCR/网络。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const fb = require('../src/services/gateway/visionOcrFallback');

describe('visionOcrFallback — rate-limit OCR rescue', () => {
  test('gate defaults ON; explicit falsy turns it off', () => {
    assert.equal(fb.isRateLimitOcrEnabled({}), true);
    assert.equal(fb.isRateLimitOcrEnabled({ KHY_VISION_RATE_LIMIT_OCR: undefined }), true);
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(fb.isRateLimitOcrEnabled({ KHY_VISION_RATE_LIMIT_OCR: v }), false, `"${v}" should disable`);
    }
    // Non-falsy stays on.
    assert.equal(fb.isRateLimitOcrEnabled({ KHY_VISION_RATE_LIMIT_OCR: '1' }), true);
  });

  test('transient error types + hasImage → rescue true', () => {
    for (const errorType of ['rate_limit', 'overloaded', 'timeout', 'network', 'RATE_LIMIT']) {
      assert.equal(
        fb.shouldRateLimitOcrRescue({ errorType, hasImage: true, env: {} }),
        true,
        `${errorType} + image should rescue`
      );
    }
  });

  test('no image → never rescue, even on rate_limit', () => {
    assert.equal(fb.shouldRateLimitOcrRescue({ errorType: 'rate_limit', hasImage: false, env: {} }), false);
    assert.equal(fb.shouldRateLimitOcrRescue({ errorType: 'rate_limit', env: {} }), false);
  });

  test('non-transient error types → not this leaf’s job (orthogonal to shouldOcrRescue)', () => {
    for (const errorType of ['auth', 'permission', 'model_not_found', 'bad_request', 'unavailable', '404', 'unknown', '']) {
      assert.equal(
        fb.shouldRateLimitOcrRescue({ errorType, hasImage: true, env: {} }),
        false,
        `${errorType} must NOT trigger rate-limit rescue`
      );
    }
  });

  test('gate off → shouldRateLimitOcrRescue always false', () => {
    assert.equal(
      fb.shouldRateLimitOcrRescue({ errorType: 'rate_limit', hasImage: true, env: { KHY_VISION_RATE_LIMIT_OCR: '0' } }),
      false
    );
  });

  test('buildRateLimitOcrNote carries marker + honest wording + retry hint', () => {
    const note = fb.buildRateLimitOcrNote({ count: 2, env: {} });
    assert.ok(note, 'note should be produced when gate on');
    assert.ok(note.startsWith(fb.RATE_LIMIT_OCR_NOTE_MARKER), 'must start with marker for dedup');
    assert.match(note, /限流|429/);
    assert.match(note, /OCR/);
    assert.match(note, /稍后重试|视觉/);
    assert.match(note, /2 张图片/); // count wording
    assert.match(note, /绝不臆测|不要假装/); // no-hallucination red line
  });

  test('buildRateLimitOcrNote generalizes when count missing/zero', () => {
    const note = fb.buildRateLimitOcrNote({ env: {} });
    assert.ok(note);
    assert.match(note, /图片/);
    assert.doesNotMatch(note, /\d+ 张图片/);
  });

  test('buildRateLimitOcrNote → null when gate off (byte-revert)', () => {
    assert.equal(fb.buildRateLimitOcrNote({ count: 1, env: { KHY_VISION_RATE_LIMIT_OCR: 'off' } }), null);
  });

  test('rate-limit gate is INDEPENDENT of KHY_VISION_OCR_FALLBACK', () => {
    // Disabling the model-rejection fallback must NOT disable the rate-limit rescue.
    const env = { KHY_VISION_OCR_FALLBACK: '0' };
    assert.equal(fb.isRateLimitOcrEnabled(env), true);
    assert.equal(fb.shouldRateLimitOcrRescue({ errorType: 'rate_limit', hasImage: true, env }), true);
    // And vice-versa: disabling rate-limit rescue must not disable model-rejection fallback.
    assert.equal(fb.isEnabled({ KHY_VISION_RATE_LIMIT_OCR: '0' }), true);
  });
});
