'use strict';

/**
 * replyDedup.test.js — 「整段答案逐字重复两遍(A+A)」折叠纯叶子契约 SSoT(node:test)。
 *
 * 背景:弱模型(api:agnes:agnes-2.0-flash · v0.1.165)工具轮后在单次回复里把整段旅游答案生成两遍,
 * 渲染一次即屏幕出两遍。本叶子只做一件事:精确等半(A===B,中缝纯空白,每份实质字符达阈值)→ 折叠为 A。
 *
 * 锁死契约:
 *   - 精确 A+A(gap 0 / 纯空白 gap)且每份 ≥40 实质字符 → 返回 A;
 *   - 非精确等半 / A≠B / 短重复 / 合法散文 → 逐字节原样返回;
 *   - 门关(0/false/off/no)→ 逐字节回退(恒返原文);
 *   - 绝不抛(非字符串 / null / junk env)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  collapseDuplicatedReply,
  replyDedupEnabled,
  MIN_HALF_NONSPACE,
} = require('../../src/services/replyDedup');

// 一段 > 阈值的实质文本(去空白后远超 40 字),模拟真实答案。
const ANSWER =
  '曲靖周边好玩的地方不少:寥廓山公园适合登高望远,珠江源风景区是南盘江的发源地风景秀丽,' +
  '爨文化博物馆能了解本地历史,九龙瀑布群气势磅礴值得一去。需要我帮你规划具体的游玩路线吗?';

test('精确 A+A(gap=0)→ 折叠为单份 A', () => {
  const doubled = ANSWER + ANSWER;
  assert.strictEqual(collapseDuplicatedReply(doubled, {}), ANSWER);
});

test('A + 纯空白间隔 + A(换行/空格缝)→ 折叠为 A', () => {
  for (const gap of ['\n\n', ' ', '\n', '  \n ']) {
    assert.strictEqual(collapseDuplicatedReply(ANSWER + gap + ANSWER, {}), ANSWER, JSON.stringify(gap));
  }
});

test('首尾外围空白被 trim,内部 A+A 仍折叠为 A(返回 trim 后的 A)', () => {
  assert.strictEqual(collapseDuplicatedReply('  ' + ANSWER + ANSWER + '  ', {}), ANSWER);
});

test('非重复的合法散文 → 逐字节原样返回', () => {
  const prose = ANSWER + ' 另外还有麒麟公园和南城门值得一看,交通也方便。';
  assert.strictEqual(collapseDuplicatedReply(prose, {}), prose);
});

test('A + B(两半不同)→ 原样返回', () => {
  const a = ANSWER;
  const b = '这是完全不同的另一半内容,长度也刻意凑得和上半差不多以排除等半巧合逃逸情况发生啊啊啊啊。';
  assert.strictEqual(collapseDuplicatedReply(a + b, {}), a + b);
});

test('短重复(每份实质字符 < 阈值)→ 不折叠(挡短巧合)', () => {
  assert.strictEqual(collapseDuplicatedReply('好的好的', {}), '好的好的');
  assert.strictEqual(collapseDuplicatedReply('The answer is 42. The answer is 42. ', {}), 'The answer is 42. The answer is 42. ');
});

test('中缝为非空白字符(A + "x" + A)→ 不折叠', () => {
  // gap 位置若含非空白,等半切分会使 A≠B 或 mid 非空白 → 不匹配。
  const glued = ANSWER + '。' + ANSWER; // 中间多一个句号,破坏精确等半对称
  assert.strictEqual(collapseDuplicatedReply(glued, {}), glued);
});

test('三份重复(A+A+A)→ 不折叠(只治精确两遍这一报告形状)', () => {
  const triple = ANSWER + ANSWER + ANSWER;
  assert.strictEqual(collapseDuplicatedReply(triple, {}), triple);
});

test('门关(0/false/off/no,大小写/空格不敏感)→ 逐字节回退', () => {
  const doubled = ANSWER + ANSWER;
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.strictEqual(replyDedupEnabled({ KHY_REPLY_DEDUP: v }), false, v);
    assert.strictEqual(collapseDuplicatedReply(doubled, { KHY_REPLY_DEDUP: v }), doubled, v);
  }
});

test('门开(默认 / 1 / on)→ 折叠生效', () => {
  const doubled = ANSWER + ANSWER;
  assert.strictEqual(replyDedupEnabled({}), true);
  assert.strictEqual(replyDedupEnabled({ KHY_REPLY_DEDUP: '1' }), true);
  assert.strictEqual(collapseDuplicatedReply(doubled, { KHY_REPLY_DEDUP: '1' }), ANSWER);
  assert.strictEqual(collapseDuplicatedReply(doubled, { KHY_REPLY_DEDUP: 'on' }), ANSWER);
});

test('绝不抛:非字符串 / null / undefined / junk env → 原样返回该输入', () => {
  assert.doesNotThrow(() => collapseDuplicatedReply(null, {}));
  assert.strictEqual(collapseDuplicatedReply(null, {}), null);
  assert.strictEqual(collapseDuplicatedReply(undefined, {}), undefined);
  assert.strictEqual(collapseDuplicatedReply(12345, {}), 12345);
  assert.strictEqual(collapseDuplicatedReply('', {}), '');
  assert.doesNotThrow(() => collapseDuplicatedReply(ANSWER + ANSWER, { KHY_REPLY_DEDUP: {} }));
  assert.doesNotThrow(() => replyDedupEnabled(null));
});

test('阈值边界:每份恰达 MIN_HALF_NONSPACE → 折叠;差一字 → 不折叠', () => {
  const unit = 'a'.repeat(MIN_HALF_NONSPACE);
  assert.strictEqual(collapseDuplicatedReply(unit + unit, {}), unit);
  const shortUnit = 'b'.repeat(MIN_HALF_NONSPACE - 1);
  assert.strictEqual(collapseDuplicatedReply(shortUnit + shortUnit, {}), shortUnit + shortUnit);
});
