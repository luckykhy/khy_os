'use strict';

/**
 * clampInt.test.js — 锁 utils/clampInt 的口径。
 *
 * 这是 selfRepairTransaction.js / memoryWriteSafety.js 两处曾逐字节相同的私有
 * `_clampInt(v, lo, hi, fallback)` 收敛后的单一真源;此测同时是逐字节回退的护栏:
 * 若取整/夹取/fallback 规则漂移,两个消费方的边界行为会一起变,此测先红。
 */

const test = require('node:test');
const assert = require('node:assert');

const clampInt = require('../src/utils/clampInt');

test('有限数在界内 → 取整原样', () => {
  assert.strictEqual(clampInt(5, 1, 10, 3), 5);
  assert.strictEqual(clampInt(5.4, 1, 10, 3), 5);
  assert.strictEqual(clampInt(5.6, 1, 10, 3), 6);
});

test('低于下界 → 夹到 lo', () => {
  assert.strictEqual(clampInt(-3, 1, 10, 3), 1);
  assert.strictEqual(clampInt(0, 1, 10, 3), 1);
});

test('高于上界 → 夹到 hi', () => {
  assert.strictEqual(clampInt(999, 1, 10, 3), 10);
});

test('非有限数(NaN/undefined/字符串/Infinity)→ fallback,再取整+夹取', () => {
  assert.strictEqual(clampInt(NaN, 1, 10, 3), 3);
  assert.strictEqual(clampInt(undefined, 1, 10, 3), 3);
  assert.strictEqual(clampInt('abc', 1, 10, 3), 3);
  assert.strictEqual(clampInt(Infinity, 1, 10, 3), 3);
});

test('Number(null)===0(有限)→ 走夹取而非 fallback', () => {
  assert.strictEqual(clampInt(null, 1, 10, 3), 1);   // 0 < lo → 夹到 1
  assert.strictEqual(clampInt(null, 0, 10, 3), 0);   // 0 在界内 → 原样
});

test('fallback 本身也过取整+夹取(越界 fallback 被拉回)', () => {
  assert.strictEqual(clampInt(NaN, 1, 10, 99), 10);
  assert.strictEqual(clampInt(NaN, 1, 10, -5), 1);
  assert.strictEqual(clampInt(NaN, 1, 10, 3.7), 4);
});

test('数字字符串被 Number 强转', () => {
  assert.strictEqual(clampInt('7', 1, 10, 3), 7);
  assert.strictEqual(clampInt('7.6', 1, 10, 3), 8);
});

test('纯函数:同输入同输出', () => {
  assert.strictEqual(clampInt(5, 1, 10, 3), clampInt(5, 1, 10, 3));
});
