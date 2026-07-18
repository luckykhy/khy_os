'use strict';

/**
 * ocrOrientationNotice.test.js — 纯叶单测:OCR 兜底「图片方向自动校正」诚实告诫(第五条正交轴,
 * 唯一「纠正型」)。只验证叶子三件事:isEnabled 门控、computeCorrectedOrientations 收集校正角度、
 * buildOrientationNotice 渲染/抑制。docHelper 侧的真复原由 ocrOrientationRecovery.test.js 用真图核验。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const {
  isEnabled,
  computeCorrectedOrientations,
  buildOrientationNotice,
  FLAG,
} = require(BE + '/src/services/gateway/ocrOrientationNotice');

describe('ocrOrientationNotice 纯叶', () => {
  test('FLAG 名固定为 KHY_OCR_AUTO_ORIENT', () => {
    assert.equal(FLAG, 'KHY_OCR_AUTO_ORIENT');
  });

  test('isEnabled:默认 on(env 未设 → true)', () => {
    assert.equal(isEnabled({}), true);
  });

  test('isEnabled:off-words 0/false/off/no → false(逐字节回退)', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      assert.equal(isEnabled({ KHY_OCR_AUTO_ORIENT: v }), false, `off-word ${v}`);
    }
  });

  test('computeCorrectedOrientations:单图 orientationCorrected=90 → [90]', () => {
    assert.deepEqual(computeCorrectedOrientations([{ orientationCorrected: 90 }]), [90]);
  });

  test('computeCorrectedOrientations:多图并集去重 + 升序 → [90,180]', () => {
    const details = [
      { orientationCorrected: 180 },
      { orientationCorrected: 90 },
      { orientationCorrected: 90 },
    ];
    assert.deepEqual(computeCorrectedOrientations(details), [90, 180]);
  });

  test('computeCorrectedOrientations:0 / 未校正不计入(只收正角度)', () => {
    const details = [
      { orientationCorrected: 0 },
      { orientationCorrected: 270 },
      {},
    ];
    assert.deepEqual(computeCorrectedOrientations(details), [270]);
  });

  test('computeCorrectedOrientations:缺字段(旧缓存明细)→ []', () => {
    assert.deepEqual(computeCorrectedOrientations([{ text: 'x', confidence: 90 }]), []);
  });

  test('computeCorrectedOrientations:畸形(非数组/含 null/标量)→ [],绝不抛', () => {
    assert.deepEqual(computeCorrectedOrientations(null), []);
    assert.deepEqual(computeCorrectedOrientations('nope'), []);
    assert.deepEqual(computeCorrectedOrientations([null, 3, { orientationCorrected: 'x' }]), []);
  });

  test('buildOrientationNotice:有校正 → 含角度与「自动」「旋转校正」', () => {
    const s = buildOrientationNotice({ corrected: [90], env: {} });
    assert.ok(s, '应返回非空告诫');
    assert.match(s, /90°/);
    assert.match(s, /自动/);
    assert.match(s, /旋转校正/);
  });

  test('buildOrientationNotice:无校正(空数组)→ null(无误报,逐字节回退)', () => {
    assert.equal(buildOrientationNotice({ corrected: [], env: {} }), null);
  });

  test('buildOrientationNotice:corrected 非数组 → null', () => {
    assert.equal(buildOrientationNotice({ corrected: 'x', env: {} }), null);
  });

  test('buildOrientationNotice:门关 → null(即便有校正也逐字节回退)', () => {
    assert.equal(buildOrientationNotice({ corrected: [90], env: { KHY_OCR_AUTO_ORIENT: 'off' } }), null);
  });

  test('buildOrientationNotice:无参绝不抛,返回 null', () => {
    assert.equal(buildOrientationNotice(), null);
  });
});
