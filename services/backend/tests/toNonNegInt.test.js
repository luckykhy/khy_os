'use strict';

/**
 * toNonNegInt.test.js — 锁 utils/toNonNegInt 口径
 *   (收敛 3 处「Number→非负整数否则 0」计数归一化 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const toNonNegInt = require('../src/utils/toNonNegInt');

test('正数向下取整', () => {
  assert.strictEqual(toNonNegInt(3), 3);
  assert.strictEqual(toNonNegInt(3.9), 3);
  assert.strictEqual(toNonNegInt('7'), 7);
  assert.strictEqual(toNonNegInt('2.5'), 2);
});

test('0 / 负数 → 0', () => {
  assert.strictEqual(toNonNegInt(0), 0);
  assert.strictEqual(toNonNegInt(-1), 0);
  assert.strictEqual(toNonNegInt(-3.7), 0);
});

test('非有限 / 非数值 → 0', () => {
  assert.strictEqual(toNonNegInt(NaN), 0);
  assert.strictEqual(toNonNegInt(Infinity), 0);
  assert.strictEqual(toNonNegInt(-Infinity), 0);
  assert.strictEqual(toNonNegInt('abc'), 0);
  assert.strictEqual(toNonNegInt(null), 0);
  assert.strictEqual(toNonNegInt(undefined), 0);
});

test('逐输入等价原体', () => {
  const ref = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.floor(v);
  };
  for (const s of [0, 1, 3.9, -2, NaN, Infinity, '5', '2.7', 'x', null, undefined, 42, 1e9]) {
    assert.strictEqual(toNonNegInt(s), ref(s));
  }
});
