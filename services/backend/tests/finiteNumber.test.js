'use strict';

/**
 * finiteNumber.test.js — 锁 utils/finiteNumber 三变体的口径。
 *
 * 收敛 15 处私有 `_num(v)`(三簇:any / >0 / >=0)的单一真源护栏。
 * 关键区别只在负数:toFiniteOr0 保留负数;toPositiveOr0/toNonNegOr0 把负数归 0。
 */

const test = require('node:test');
const assert = require('node:assert');

const { toFiniteOr0, toPositiveOr0, toNonNegOr0 } = require('../src/utils/finiteNumber');

test('toFiniteOr0:有限数原样(含负数),非有限 → 0', () => {
  assert.strictEqual(toFiniteOr0(5), 5);
  assert.strictEqual(toFiniteOr0(-3), -3);
  assert.strictEqual(toFiniteOr0(0), 0);
  assert.strictEqual(toFiniteOr0('2.5'), 2.5);
  assert.strictEqual(toFiniteOr0(NaN), 0);
  assert.strictEqual(toFiniteOr0(Infinity), 0);
  assert.strictEqual(toFiniteOr0(undefined), 0);
  assert.strictEqual(toFiniteOr0('abc'), 0);
});

test('toPositiveOr0:仅 >0 保留,0/负数/非有限 → 0', () => {
  assert.strictEqual(toPositiveOr0(5), 5);
  assert.strictEqual(toPositiveOr0(0), 0);
  assert.strictEqual(toPositiveOr0(-3), 0);
  assert.strictEqual(toPositiveOr0(0.1), 0.1);
  assert.strictEqual(toPositiveOr0(NaN), 0);
  assert.strictEqual(toPositiveOr0(Infinity), 0);
});

test('toNonNegOr0:>=0 保留,负数/非有限 → 0', () => {
  assert.strictEqual(toNonNegOr0(5), 5);
  assert.strictEqual(toNonNegOr0(0), 0);
  assert.strictEqual(toNonNegOr0(-0.0001), 0);
  assert.strictEqual(toNonNegOr0(NaN), 0);
  assert.strictEqual(toNonNegOr0(Infinity), 0);
});

test('三变体对非负有限输入一致(都 === Number(v))', () => {
  for (const v of [0, 1, 42, 3.14, '7']) {
    const n = Number(v);
    assert.strictEqual(toFiniteOr0(v), n);
    assert.strictEqual(toPositiveOr0(v), n); // v>=0 时 >0 分支对 0 也返 0 = n
    assert.strictEqual(toNonNegOr0(v), n);
  }
});
