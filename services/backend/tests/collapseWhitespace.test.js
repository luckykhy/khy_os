'use strict';

/**
 * collapseWhitespace.test.js — 锁 utils/collapseWhitespace 口径(收敛 4 处折叠空白 helper 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const collapseWhitespace = require('../src/utils/collapseWhitespace');

test('连续空白(空格/制表/换行)折叠为单空格', () => {
  assert.strictEqual(collapseWhitespace('a   b\t\tc\n\nd'), 'a b c d');
});

test('去首尾空白', () => {
  assert.strictEqual(collapseWhitespace('  hello world  '), 'hello world');
});

test('null / undefined → 空串', () => {
  assert.strictEqual(collapseWhitespace(null), '');
  assert.strictEqual(collapseWhitespace(undefined), '');
});

test('非字符串强转(数字/对象)', () => {
  assert.strictEqual(collapseWhitespace(42), '42');
  assert.strictEqual(collapseWhitespace(0), '0');
});

test('确定性:同输入同输出、不 mutate', () => {
  const s = '  x  y  ';
  assert.strictEqual(collapseWhitespace(s), collapseWhitespace(s));
  assert.strictEqual(s, '  x  y  ');
});
