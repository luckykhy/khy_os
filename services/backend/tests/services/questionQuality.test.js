'use strict';

/**
 * questionQuality.test.js — 「推荐选项确定性前置」纯叶子单测(node:test)。
 *
 * 覆盖:门控解析、推荐标记识别(半/全角括号·中英)、稳定提升(首个标记项移到 index 0·
 * 其余保持原序·无标记逐字节等价)、normalizeQuestions 逐卡处理 + 门控关字节回退 + 绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  isRecommendedFirstEnabled,
  isRecommendedOption,
  promoteRecommendedFirst,
  normalizeQuestions,
} = require('../../src/services/questionQuality');

test('isRecommendedFirstEnabled: 默认开,仅显式 falsy 关', () => {
  assert.equal(isRecommendedFirstEnabled({}), true);
  assert.equal(isRecommendedFirstEnabled({ KHY_QUESTION_RECOMMENDED_FIRST: '1' }), true);
  assert.equal(isRecommendedFirstEnabled({ KHY_QUESTION_RECOMMENDED_FIRST: 'yes' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(isRecommendedFirstEnabled({ KHY_QUESTION_RECOMMENDED_FIRST: off }), false, off);
  }
});

test('isRecommendedOption: 认括号包裹的 recommended/推荐(半/全角·大小写)', () => {
  assert.equal(isRecommendedOption({ label: 'Use JWT (Recommended)' }), true);
  assert.equal(isRecommendedOption({ label: '用 JWT(推荐)' }), true);
  assert.equal(isRecommendedOption({ label: '用 JWT（推荐）' }), true);
  assert.equal(isRecommendedOption({ label: 'Cache (recommended)' }), true);
  assert.equal(isRecommendedOption('Session (RECOMMENDED)'), true);
  // 不误伤正文里恰好出现的普通词(无括号包裹)
  assert.equal(isRecommendedOption({ label: 'Recommended settings' }), false);
  assert.equal(isRecommendedOption({ label: '推荐做法' }), false);
  assert.equal(isRecommendedOption({ label: 'Plain option' }), false);
});

test('promoteRecommendedFirst: 把标记项移到队首,其余保持原相对序', () => {
  const opts = [
    { label: 'A' },
    { label: 'B (Recommended)' },
    { label: 'C' },
  ];
  const out = promoteRecommendedFirst(opts);
  assert.deepEqual(out.map(o => o.label), ['B (Recommended)', 'A', 'C']);
});

test('promoteRecommendedFirst: 已在首位 → 原引用(逐字节等价,零复制)', () => {
  const opts = [{ label: 'B (推荐)' }, { label: 'A' }, { label: 'C' }];
  const out = promoteRecommendedFirst(opts);
  assert.strictEqual(out, opts);
});

test('promoteRecommendedFirst: 无标记 → 原引用', () => {
  const opts = [{ label: 'A' }, { label: 'B' }];
  assert.strictEqual(promoteRecommendedFirst(opts), opts);
});

test('promoteRecommendedFirst: 多个标记只提升第一个', () => {
  const opts = [
    { label: 'A' },
    { label: 'B (Recommended)' },
    { label: 'C (推荐)' },
  ];
  const out = promoteRecommendedFirst(opts);
  assert.deepEqual(out.map(o => o.label), ['B (Recommended)', 'A', 'C (推荐)']);
});

test('promoteRecommendedFirst: 非数组/单元素 → 原样返回', () => {
  assert.strictEqual(promoteRecommendedFirst(null), null);
  const one = [{ label: 'A (Recommended)' }];
  assert.strictEqual(promoteRecommendedFirst(one), one);
});

test('normalizeQuestions: 逐卡提升推荐项;门控关 → 原引用字节回退', () => {
  const questions = [
    {
      question: 'Q1?',
      options: [{ label: 'A' }, { label: 'B (Recommended)' }],
    },
    {
      question: 'Q2?',
      options: [{ label: 'X (推荐)' }, { label: 'Y' }], // 已在首位
    },
  ];
  const on = normalizeQuestions(questions, { env: {} });
  assert.deepEqual(on[0].options.map(o => o.label), ['B (Recommended)', 'A']);
  assert.deepEqual(on[1].options.map(o => o.label), ['X (推荐)', 'Y']);

  // 门控关 → 完全原引用(不重排)
  const off = normalizeQuestions(questions, { env: { KHY_QUESTION_RECOMMENDED_FIRST: '0' } });
  assert.strictEqual(off, questions);
});

test('normalizeQuestions: 全卡无标记/已就位 → 原引用(逐字节等价)', () => {
  const questions = [
    { question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'R?', options: [{ label: 'C (推荐)' }, { label: 'D' }] },
  ];
  assert.strictEqual(normalizeQuestions(questions, { env: {} }), questions);
});

test('normalizeQuestions: 绝不抛(畸形输入 fail-soft)', () => {
  assert.doesNotThrow(() => normalizeQuestions(null, { env: {} }));
  assert.doesNotThrow(() => normalizeQuestions([{ options: 'nope' }], { env: {} }));
  assert.strictEqual(normalizeQuestions([], { env: {} }).length, 0);
});
