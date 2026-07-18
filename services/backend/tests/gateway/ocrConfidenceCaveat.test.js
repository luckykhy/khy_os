'use strict';

/**
 * ocrConfidenceCaveat.test.js — 纯叶子单测:锁定「OCR 低置信告诫」的诚实判据与门控回退。
 *
 * 背景(/goal 2026-07-11):纯文本模型 + 图片 → 本地 OCR 兜底时,gateway 把 OCR 文本当
 * 「请据此作答」的权威依据注入。若 tesseract 自评置信度偏低,必须追加一句诚实告诫,别让
 * 文本模型把误识文字当铁定事实。核心陷阱:CLI 无 tsv 时 confidence 退化为 0(未知),
 * 「confidence < 60 → 告诫」的朴素判据会在**每一次干净的 CLI 提取**上误报。因此判据必须
 * 只在**正向低置信信号**(needsAiFallback===true 或 confidence∈(0,60))时才告诫。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/services/gateway/ocrConfidenceCaveat');
const {
  isEnabled,
  isLowConfidence,
  countLowConfidence,
  buildLowConfidenceCaveat,
  FLAG,
  LOW_CONFIDENCE_THRESHOLD,
} = leaf;

test('门 default-on:未设置 env → isEnabled true', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(FLAG, 'KHY_OCR_LOW_CONFIDENCE_CAVEAT');
});

test('门可关:0/false/off/no → isEnabled false(逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(isEnabled({ [FLAG]: off }), false, `off-word ${off} 应关门`);
  }
});

test('isLowConfidence:needsAiFallback===true → 低置信(引擎自评低,最强信号)', () => {
  assert.equal(isLowConfidence({ needsAiFallback: true }), true);
  assert.equal(isLowConfidence({ confidence: 96, needsAiFallback: true }), true,
    'needsAiFallback 优先于高分数');
});

test('isLowConfidence:有限 confidence ∈ (0,60) → 低置信', () => {
  assert.equal(isLowConfidence({ confidence: 41 }), true);
  assert.equal(isLowConfidence({ confidence: 59.9 }), true);
  assert.equal(isLowConfidence({ confidence: 1 }), true);
});

test('isLowConfidence:高分或阈值边界 → 非低置信', () => {
  assert.equal(isLowConfidence({ confidence: 60 }), false, '恰好 60 非低(< 严格小于)');
  assert.equal(isLowConfidence({ confidence: 96 }), false);
  assert.equal(LOW_CONFIDENCE_THRESHOLD, 60);
});

test('isLowConfidence:未知置信(0 / 非有限)且 needsAiFallback≠true → 非低置信(绝不把「没测量」谎报成「低」)', () => {
  assert.equal(isLowConfidence({ confidence: 0, needsAiFallback: false }), false,
    'CLI 无 tsv 退化 confidence=0 是未知,不是低');
  assert.equal(isLowConfidence({ confidence: 0 }), false);
  assert.equal(isLowConfidence({ confidence: NaN }), false);
  assert.equal(isLowConfidence({ confidence: -1 }), false, '负 conf(tesseract 布局行) 非低');
  assert.equal(isLowConfidence({}), false);
});

test('isLowConfidence:畸形输入绝不抛,一律 false', () => {
  assert.equal(isLowConfidence(null), false);
  assert.equal(isLowConfidence(undefined), false);
  assert.equal(isLowConfidence('nope'), false);
  assert.equal(isLowConfidence(42), false);
});

test('countLowConfidence:统计正向低置信张数;非数组 → 0', () => {
  const details = [
    { confidence: 96, needsAiFallback: false }, // 高
    { confidence: 41, needsAiFallback: false }, // 低(分数)
    { needsAiFallback: true }, // 低(自评)
    { confidence: 0, needsAiFallback: false }, // 未知,不计
  ];
  assert.equal(countLowConfidence(details), 2);
  assert.equal(countLowConfidence([]), 0);
  assert.equal(countLowConfidence(null), 0);
  assert.equal(countLowConfidence('x'), 0);
});

test('buildLowConfidenceCaveat:count≥1 且门开 → 渲染诚实告诫句(带 n/total)', () => {
  const s = buildLowConfidenceCaveat({ count: 1, total: 2, env: {} });
  assert.ok(s, '应返回非空');
  assert.match(s, /置信度较低/);
  assert.match(s, /其中 1\/2 张/);
  assert.match(s, /误识|漏识/);
});

test('buildLowConfidenceCaveat:无 total → 只报张数', () => {
  const s = buildLowConfidenceCaveat({ count: 3, env: {} });
  assert.match(s, /其中 3 张/);
  assert.doesNotMatch(s, /\//);
});

test('buildLowConfidenceCaveat:count<1 / 非有限 → null(不注入)', () => {
  assert.equal(buildLowConfidenceCaveat({ count: 0, env: {} }), null);
  assert.equal(buildLowConfidenceCaveat({ count: NaN, env: {} }), null);
  assert.equal(buildLowConfidenceCaveat({ env: {} }), null);
});

test('buildLowConfidenceCaveat:门关 → null(逐字节回退,即使有低置信)', () => {
  assert.equal(buildLowConfidenceCaveat({ count: 5, total: 5, env: { [FLAG]: 'off' } }), null);
});
