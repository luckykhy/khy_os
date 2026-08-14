'use strict';

/**
 * ocrResolutionNotice.test.js — 纯叶单测:OCR 兜底「低分辨率图片自动放大」诚实告诫(第六条正交轴,
 * 第二条「纠正型」)。只验证叶子三件事:isEnabled 门控、computeUpscaledFactors 收集放大倍数、
 * buildResolutionNotice 渲染/抑制。docHelper 侧的真复原由 ocrResolutionRecovery.test.js 用真图核验。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const {
  isEnabled,
  computeUpscaledFactors,
  buildResolutionNotice,
  FLAG,
} = require(BE + '/src/services/gateway/ocrResolutionNotice');

describe('ocrResolutionNotice 纯叶', () => {
  test('FLAG 名固定为 KHY_OCR_UPSCALE', () => {
    assert.equal(FLAG, 'KHY_OCR_UPSCALE');
  });

  test('isEnabled:默认 on(env 未设 → true)', () => {
    assert.equal(isEnabled({}), true);
  });

  test('isEnabled:off-words 0/false/off/no → false(逐字节回退)', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      assert.equal(isEnabled({ KHY_OCR_UPSCALE: v }), false, `off-word ${v}`);
    }
  });

  test('computeUpscaledFactors:单图 upscaledFactor=2 → [2]', () => {
    assert.deepEqual(computeUpscaledFactors([{ upscaledFactor: 2 }]), [2]);
  });

  test('computeUpscaledFactors:多图并集去重 + 升序 → [2,4]', () => {
    const details = [
      { upscaledFactor: 4 },
      { upscaledFactor: 2 },
      { upscaledFactor: 2 },
    ];
    assert.deepEqual(computeUpscaledFactors(details), [2, 4]);
  });

  test('computeUpscaledFactors:0 / 1(未放大)不计入(只收 >1 的倍数)', () => {
    const details = [
      { upscaledFactor: 0 },
      { upscaledFactor: 1 },
      { upscaledFactor: 3 },
      {},
    ];
    assert.deepEqual(computeUpscaledFactors(details), [3]);
  });

  test('computeUpscaledFactors:缺字段(旧缓存明细)→ []', () => {
    assert.deepEqual(computeUpscaledFactors([{ text: 'x', confidence: 90 }]), []);
  });

  test('computeUpscaledFactors:畸形(非数组/含 null/标量)→ [],绝不抛', () => {
    assert.deepEqual(computeUpscaledFactors(null), []);
    assert.deepEqual(computeUpscaledFactors('nope'), []);
    assert.deepEqual(computeUpscaledFactors([null, 3, { upscaledFactor: 'x' }]), []);
  });

  test('buildResolutionNotice:有放大 → 含倍数与「自动放大」「分辨率」', () => {
    const s = buildResolutionNotice({ upscaled: [2], env: {} });
    assert.ok(s, '应返回非空告诫');
    assert.match(s, /2×/);
    assert.match(s, /自动放大/);
    assert.match(s, /分辨率/);
  });

  test('buildResolutionNotice:无放大(空数组)→ null(无误报,逐字节回退)', () => {
    assert.equal(buildResolutionNotice({ upscaled: [], env: {} }), null);
  });

  test('buildResolutionNotice:upscaled 非数组 → null', () => {
    assert.equal(buildResolutionNotice({ upscaled: 'x', env: {} }), null);
  });

  test('buildResolutionNotice:门关 → null(即便有放大也逐字节回退)', () => {
    assert.equal(buildResolutionNotice({ upscaled: [2], env: { KHY_OCR_UPSCALE: 'off' } }), null);
  });

  test('buildResolutionNotice:无参绝不抛,返回 null', () => {
    assert.equal(buildResolutionNotice(), null);
  });
});
