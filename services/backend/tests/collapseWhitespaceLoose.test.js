'use strict';

/**
 * collapseWhitespaceLoose.test.js — 锁 utils/collapseWhitespaceLoose 口径(收敛 5 处 falsy 变体折叠 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const loose = require('../src/utils/collapseWhitespaceLoose');

test('连续空白折叠 + 去首尾', () => {
  assert.strictEqual(loose('  a   b\t\tc\n\nd  '), 'a b c d');
});

test('falsy → 空串(含 0/false,区别于 nullish 变体)', () => {
  assert.strictEqual(loose(null), '');
  assert.strictEqual(loose(undefined), '');
  assert.strictEqual(loose(0), '');
  assert.strictEqual(loose(false), '');
  assert.strictEqual(loose(''), '');
});

test('无参调用 → 空串(等价消费方 (x=\'\') 默认参)', () => {
  assert.strictEqual(loose(), '');
});

test('非空字符串原样规整', () => {
  assert.strictEqual(loose('hello'), 'hello');
  assert.strictEqual(loose(42), '42');
});
