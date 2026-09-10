'use strict';
/**
 * visionRateLimitOcrRescue.test.js — 回归「视觉通道限流(429/瞬态)终局退回本地 OCR」判定叶子。
 *
 * 覆盖:门控默认开/显式关、瞬态错误类型 + 握图为真、无图/非瞬态类型为假、
 * 与既有模型拒绝兜底(shouldOcrRescue)正交、note 文案/marker/门控、独立门控隔离。
 * 纯叶子零 IO,不触真实 OCR/网络。
 */
const fb = require('../src/services/gateway/visionOcrFallback');
describe('visionOcrFallback — rate-limit OCR rescue', () => {
});

describe('Vision Rate Limit Ocr Rescue', () => {
  test('gate defaults ON; explicit falsy turns it off', () => {
        expect(fb.isRateLimitOcrEnabled({})).toBe(true);
        expect(fb.isRateLimitOcrEnabled({ KHY_VISION_RATE_LIMIT_OCR: undefined })).toBe(true);
        for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
          expect(fb.isRateLimitOcrEnabled({ KHY_VISION_RATE_LIMIT_OCR: v })).toBe(false);
        }
        // Non-falsy stays on.
        expect(fb.isRateLimitOcrEnabled({ KHY_VISION_RATE_LIMIT_OCR: '1' })).toBe(true);
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
        expect(fb.shouldRateLimitOcrRescue({ errorType: 'rate_limit', hasImage: false, env: {} })).toBe(false);
        expect(fb.shouldRateLimitOcrRescue({ errorType: 'rate_limit', env: {} })).toBe(false);
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
        expect(note).toBeTruthy();
        expect(note.startsWith(fb.RATE_LIMIT_OCR_NOTE_MARKER)).toBeTruthy();
        expect(note).toMatch(/限流|429/);
        expect(note).toMatch(/OCR/);
        expect(note).toMatch(/稍后重试|视觉/);
        expect(note).toMatch(/2 张图片/); // count wording
        expect(note).toMatch(/绝不臆测|不要假装/); // no-hallucination red line
  });

  test('buildRateLimitOcrNote generalizes when count missing/zero', () => {
        const note = fb.buildRateLimitOcrNote({ env: {} });
        expect(note).toBeTruthy();
        expect(note).toMatch(/图片/);
        expect(note).not.toMatch(/\d+ 张图片/);
  });

  test('buildRateLimitOcrNote → null when gate off (byte-revert)', () => {
        expect(fb.buildRateLimitOcrNote({ count: 1, env: { KHY_VISION_RATE_LIMIT_OCR: 'off' } })).toBe(null);
  });

  test('rate-limit gate is INDEPENDENT of KHY_VISION_OCR_FALLBACK', () => {
        // Disabling the model-rejection fallback must NOT disable the rate-limit rescue.
        const env = { KHY_VISION_OCR_FALLBACK: '0' };
        expect(fb.isRateLimitOcrEnabled(env)).toBe(true);
        expect(fb.shouldRateLimitOcrRescue({ errorType: 'rate_limit', hasImage: true, env })).toBe(true);
        // And vice-versa: disabling rate-limit rescue must not disable model-rejection fallback.
        expect(fb.isEnabled({ KHY_VISION_RATE_LIMIT_OCR: '0' })).toBe(true);
  });

});
