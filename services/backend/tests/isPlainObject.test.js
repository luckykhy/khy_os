'use strict';

/**
 * isPlainObject.test.js — 锁 utils/isPlainObject 口径(收敛 3 处 `_isPlainObject` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const isPlainObject = require('../src/utils/isPlainObject');

test('普通对象 → true', () => {
  assert.strictEqual(isPlainObject({}), true);
  assert.strictEqual(isPlainObject({ a: 1 }), true);
  assert.strictEqual(isPlainObject(Object.create(null)), true);
});

test('null / 数组 → false', () => {
  assert.strictEqual(isPlainObject(null), false);
  assert.strictEqual(isPlainObject([]), false);
  assert.strictEqual(isPlainObject([1, 2]), false);
});

test('原始类型 → false', () => {
  assert.strictEqual(isPlainObject(undefined), false);
  assert.strictEqual(isPlainObject(0), false);
  assert.strictEqual(isPlainObject('s'), false);
  assert.strictEqual(isPlainObject(true), false);
});

test('宽判定:类实例/Date 亦 true(与原体一致,非严格 plain)', () => {
  assert.strictEqual(isPlainObject(new Date()), true);
  class C {}
  assert.strictEqual(isPlainObject(new C()), true);
});

test('.every 回调风格多余参数被忽略', () => {
  assert.strictEqual([{}, { x: 1 }].every(isPlainObject), true);
  assert.strictEqual([{}, []].every(isPlainObject), false);
});
