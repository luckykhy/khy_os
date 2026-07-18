'use strict';

/**
 * normLower.test.js — 锁 utils/normLower 的口径。
 * 收敛 5 处逐字节相同私有 `_norm(v)` 的单一真源护栏:nullish→'',trim+lowercase,fail-soft。
 */

const test = require('node:test');
const assert = require('node:assert');

const normLower = require('../src/utils/normLower');

test('null/undefined → 空串', () => {
  assert.strictEqual(normLower(null), '');
  assert.strictEqual(normLower(undefined), '');
});

test('trim + 小写', () => {
  assert.strictEqual(normLower('  ABC  '), 'abc');
  assert.strictEqual(normLower('MixedCase'), 'mixedcase');
  assert.strictEqual(normLower('\tFoo\n'), 'foo');
});

test('非字符串 String 强转后处理', () => {
  assert.strictEqual(normLower(123), '123');
  assert.strictEqual(normLower(true), 'true');
});

test('fail-soft:toString 抛错的对象 → 空串', () => {
  const bad = { toString() { throw new Error('boom'); } };
  assert.strictEqual(normLower(bad), '');
});

test('确定性重复稳定', () => {
  assert.strictEqual(normLower('  X '), normLower('  X '));
});
