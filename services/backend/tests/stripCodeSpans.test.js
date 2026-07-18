'use strict';

/**
 * stripCodeSpans.test.js — 锁 utils/stripCodeSpans 的口径。
 *
 * 这是 6 处曾逐字节相同(仅注释不同)的私有 `_stripCode(text)` 收敛后的单一真源
 * (testWritingPolicy / deliverySummaryFormat / mathSolvePolicy / config 三 resolver)。
 * 此测同时是逐字节回退的护栏:若「代码块/行内 code → 空格」规则漂移,六个消费方的
 * 意图扫描会一起变(把示例里的关键词误判为指令),此测先红。
 */

const test = require('node:test');
const assert = require('node:assert');

const stripCodeSpans = require('../src/utils/stripCodeSpans');

test('fenced 代码块 → 单空格(非贪婪,跨行)', () => {
  assert.strictEqual(stripCodeSpans('a ```\nKHY_X=1\n``` b'), 'a   b');
  // 两个独立 fenced 块各自替换,不吞中间文本
  assert.strictEqual(stripCodeSpans('```x``` mid ```y```'), '  mid  ');
});

test('行内 code span → 单空格', () => {
  assert.strictEqual(stripCodeSpans('set `on` please'), 'set   please');
});

test('替换为空格(非空串)防相邻词粘连', () => {
  // `code` 两侧的词不因剥离而融成一个 token
  const out = stripCodeSpans('foo`x`bar');
  assert.strictEqual(out, 'foo bar');
});

test('无 code → 原样(nullish → 空串)', () => {
  assert.strictEqual(stripCodeSpans('plain text'), 'plain text');
  assert.strictEqual(stripCodeSpans(''), '');
  assert.strictEqual(stripCodeSpans(null), '');
  assert.strictEqual(stripCodeSpans(undefined), '');
});

test('非字符串被 String 强转', () => {
  assert.strictEqual(stripCodeSpans(123), '123');
});

test('/g 正则无 lastIndex 泄漏:重复调用稳定', () => {
  const s = '`a` `b` `c`';
  assert.strictEqual(stripCodeSpans(s), stripCodeSpans(s));
});
