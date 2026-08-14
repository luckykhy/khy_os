'use strict';

/**
 * ocrCoverageNotice.test.js — 纯叶子单测:锁定「OCR 兜底覆盖率」诚实告诫的判据与门控回退。
 *
 * 背景(/goal 2026-07-12,与 ocrConfidenceCaveat 的「准确性」诚实正交,本条管「完整性」):
 * gateway 三处 OCR 注入点都以 `extractImageOcrDetails(images,{maxImages:3,maxChars:1200})` 提取,
 * `images.slice(0,maxImages)` 会静默丢弃第 4 张起,部分图片也可能读不出文字 → 模型收到残缺 OCR
 * 文本却被告知「据此作答」,以为看到了全部。本叶在真有覆盖缺口时追加一句诚实告诫。
 *
 * 核心陷阱(诚实边界):干净的单图 / 全覆盖**绝不**误报;unreadable 只统计「已尝试但无文字」,
 * 不把超上限未尝试的图重复计入(那归 omitted);门关 → 逐字节回退 null;畸形输入绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/services/gateway/ocrCoverageNotice');
const { isEnabled, computeCoverage, buildCoverageNotice, FLAG } = leaf;

test('门 default-on:未设置 env → isEnabled true', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(FLAG, 'KHY_OCR_COVERAGE_NOTICE');
});

test('门可关:0/false/off/no → isEnabled false(逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(isEnabled({ [FLAG]: off }), false, `off-word ${off} 应关门`);
  }
});

test('computeCoverage:干净单图(1 张全提取)→ 无缺口', () => {
  const c = computeCoverage({ totalImages: 1, ocrTextCount: 1, maxImages: 3 });
  assert.deepEqual(c, { total: 1, cap: 3, attempted: 1, withText: 1, omitted: 0, unreadable: 0 });
});

test('computeCoverage:超上限(5 张只识别前 3)→ omitted=2,无 unreadable', () => {
  const c = computeCoverage({ totalImages: 5, ocrTextCount: 3, maxImages: 3 });
  assert.equal(c.attempted, 3);
  assert.equal(c.omitted, 2);
  assert.equal(c.unreadable, 0);
});

test('computeCoverage:部分读不出(3 张里 2 张有文字)→ unreadable=1,无 omitted', () => {
  const c = computeCoverage({ totalImages: 3, ocrTextCount: 2, maxImages: 3 });
  assert.equal(c.attempted, 3);
  assert.equal(c.omitted, 0);
  assert.equal(c.unreadable, 1);
});

test('computeCoverage:超上限 + 尝试中部分读不出(5 张,前3中2张有文字)→ omitted=2 且 unreadable=1', () => {
  const c = computeCoverage({ totalImages: 5, ocrTextCount: 2, maxImages: 3 });
  assert.equal(c.attempted, 3);
  assert.equal(c.omitted, 2);
  assert.equal(c.unreadable, 1);
});

test('computeCoverage:withText 被夹紧,绝不产生负数 unreadable', () => {
  const c = computeCoverage({ totalImages: 2, ocrTextCount: 99, maxImages: 3 });
  assert.equal(c.withText, 2); // 夹到 total
  assert.equal(c.unreadable, 0);
  assert.equal(c.omitted, 0);
});

test('computeCoverage:cap 未知(0/非法)→ 不推断 omitted', () => {
  const c = computeCoverage({ totalImages: 5, ocrTextCount: 5, maxImages: 0 });
  assert.equal(c.cap, 0);
  assert.equal(c.omitted, 0);
  assert.equal(c.attempted, 5);
});

test('computeCoverage:畸形输入(非数字/负数/缺失)→ 全 0,绝不抛', () => {
  assert.doesNotThrow(() => computeCoverage());
  const c = computeCoverage({ totalImages: 'x', ocrTextCount: -3, maxImages: NaN });
  assert.equal(c.total, 0);
  assert.equal(c.withText, 0);
  assert.equal(c.omitted, 0);
  assert.equal(c.unreadable, 0);
});

test('buildCoverageNotice:干净单图 → null(无缺口,逐字节回退,绝不误报)', () => {
  assert.equal(buildCoverageNotice({ totalImages: 1, ocrTextCount: 1, maxImages: 3, env: {} }), null);
});

test('buildCoverageNotice:超上限 → 含 omitted 措辞', () => {
  const s = buildCoverageNotice({ totalImages: 5, ocrTextCount: 3, maxImages: 3, env: {} });
  assert.ok(s, '应产出告诫');
  assert.match(s, /共 5 张/);
  assert.match(s, /仅识别了前 3 张/);
  assert.match(s, /另有 2 张未做识别/);
  assert.match(s, /并未覆盖全部图片/);
});

test('buildCoverageNotice:部分读不出 → 含 unreadable 措辞', () => {
  const s = buildCoverageNotice({ totalImages: 3, ocrTextCount: 2, maxImages: 3, env: {} });
  assert.ok(s);
  assert.match(s, /1 张图片未能提取到文字/);
  assert.doesNotMatch(s, /未做识别/); // 无 omitted 段
});

test('buildCoverageNotice:两种缺口都在 → 两段都出现', () => {
  const s = buildCoverageNotice({ totalImages: 5, ocrTextCount: 2, maxImages: 3, env: {} });
  assert.ok(s);
  assert.match(s, /另有 2 张未做识别/);
  assert.match(s, /1 张图片未能提取到文字/);
});

test('buildCoverageNotice:门关 → null(即便有缺口也逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(
      buildCoverageNotice({ totalImages: 5, ocrTextCount: 3, maxImages: 3, env: { [FLAG]: off } }),
      null,
      `门关(${off})应不告诫`
    );
  }
});

test('buildCoverageNotice:畸形输入绝不抛,返回 null', () => {
  assert.doesNotThrow(() => buildCoverageNotice());
  assert.equal(buildCoverageNotice({ totalImages: {}, ocrTextCount: [], maxImages: 'z', env: {} }), null);
});
