'use strict';

/**
 * ocrTruncationNotice.test.js — 纯叶子单测:锁定「OCR 兜底单图内文本完整性」诚实告诫的判据与门控回退。
 *
 * 背景(/goal 2026-07-12,与 ocrConfidenceCaveat「准确性」、ocrCoverageNotice「跨图完整性」两条
 * 正交,本条管「单图内文本完整性」):一张稠密图片的 OCR 全文超过 maxChars(默认 1200)被截断,
 * 只保留前一部分、尾部丢弃。此前「被截断」只在文本里留一个内嵌英文 `...[truncated]` 标记,从不作为
 * 结构化信号 truncated 离开 ocrSnippetService。本轮把 truncated 暴露到明细,本叶据此在真有截断时告诫。
 *
 * 诚实边界:未截断 / 门关 / count<1 / 畸形 → null,逐字节回退;绝不误报,绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/services/gateway/ocrTruncationNotice');
const { isEnabled, countTruncated, buildTruncationNotice, FLAG } = leaf;

test('门 default-on:未设置 env → isEnabled true', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(FLAG, 'KHY_OCR_TRUNCATION_NOTICE');
});

test('门可关:0/false/off/no → isEnabled false(逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(isEnabled({ [FLAG]: off }), false, `off-word ${off} 应关门`);
  }
});

test('countTruncated:只统计 truncated===true', () => {
  const details = [
    { text: 'a', truncated: true },
    { text: 'b', truncated: false },
    { text: 'c' },
    { text: 'd', truncated: true },
  ];
  assert.equal(countTruncated(details), 2);
});

test('countTruncated:无截断 → 0', () => {
  assert.equal(countTruncated([{ text: 'a' }, { text: 'b', truncated: false }]), 0);
});

test('countTruncated:畸形输入(非数组/含 null/含标量)→ 0,绝不抛', () => {
  assert.doesNotThrow(() => countTruncated());
  assert.equal(countTruncated(undefined), 0);
  assert.equal(countTruncated('x'), 0);
  assert.equal(countTruncated([null, 1, 'y', {}]), 0);
});

test('countTruncated:truthy 非 true 不算(严格布尔)', () => {
  assert.equal(countTruncated([{ truncated: 1 }, { truncated: 'yes' }]), 0);
});

test('buildTruncationNotice:有截断 → 含张数与总数措辞', () => {
  const s = buildTruncationNotice({ count: 2, total: 5, env: {} });
  assert.ok(s, '应产出告诫');
  assert.match(s, /其中 2\/5 张/);
  assert.match(s, /因长度上限被截断/);
  assert.match(s, /尾部内容未包含/);
});

test('buildTruncationNotice:total 未知(0/非法)→ 只报张数,不报分母', () => {
  const s = buildTruncationNotice({ count: 1, total: 0, env: {} });
  assert.ok(s);
  assert.match(s, /其中 1 张/);
  assert.doesNotMatch(s, /其中 \d+\/\d+ 张/);
});

test('buildTruncationNotice:count<1 → null(无截断,逐字节回退,绝不误报)', () => {
  assert.equal(buildTruncationNotice({ count: 0, total: 3, env: {} }), null);
});

test('buildTruncationNotice:count 非有限 → null', () => {
  assert.equal(buildTruncationNotice({ count: NaN, total: 3, env: {} }), null);
  assert.equal(buildTruncationNotice({ count: 'x', total: 3, env: {} }), null);
});

test('buildTruncationNotice:门关 → null(即便有截断也逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(
      buildTruncationNotice({ count: 2, total: 5, env: { [FLAG]: off } }),
      null,
      `门关(${off})应不告诫`
    );
  }
});

test('buildTruncationNotice:畸形输入绝不抛,返回 null', () => {
  assert.doesNotThrow(() => buildTruncationNotice());
  assert.equal(buildTruncationNotice(), null);
  assert.equal(buildTruncationNotice({ count: {}, total: [], env: {} }), null);
});
