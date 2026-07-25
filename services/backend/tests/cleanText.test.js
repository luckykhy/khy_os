'use strict';

/**
 * cleanText.test.js — 锁 utils/cleanText 的口径。
 *
 * 这是 4 处曾逐字节相同的私有 `_clean(text)`(config 四 nl resolver)收敛后的单一真源。
 * 关键不变量:null/undefined → 空串(不是 'null'/'undefined'),其余 String 强转后 trim。
 */

const test = require('node:test');
const assert = require('node:assert');

const cleanText = require('../src/utils/cleanText');

test('null / undefined → 空串(非字面量 "null"/"undefined")', () => {
  assert.strictEqual(cleanText(null), '');
  assert.strictEqual(cleanText(undefined), '');
});

test('去首尾空白', () => {
  assert.strictEqual(cleanText('  hi  '), 'hi');
  assert.strictEqual(cleanText('\t\nx\n '), 'x');
});

test('普通字符串原样(内部空白保留)', () => {
  assert.strictEqual(cleanText('a b'), 'a b');
  assert.strictEqual(cleanText(''), '');
});

test('非字符串被 String 强转后 trim', () => {
  assert.strictEqual(cleanText(123), '123');
  assert.strictEqual(cleanText(0), '0');
  assert.strictEqual(cleanText(false), 'false');
});

test('不 mutate、确定性重复稳定', () => {
  const s = '  z  ';
  assert.strictEqual(cleanText(s), cleanText(s));
  assert.strictEqual(s, '  z  ');
});
