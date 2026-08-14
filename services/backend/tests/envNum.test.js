'use strict';

/**
 * envNum.test.js — 锁 utils/envNum 的口径。
 *
 * 这是 selfRepairTransaction.js / memoryWriteSafety.js / browser/scrollPlan.js
 * 三处曾逐字节相同的私有 `_envNum(env, key)` 收敛后的单一真源;此测同时是逐字节
 * 回退的护栏:若「缺失/空白/非数 → undefined」规则漂移,三个消费方的默认值分支
 * 会一起变,此测先红。
 */

const test = require('node:test');
const assert = require('node:assert');

const envNum = require('../src/utils/envNum');

test('有效数字字符串 → Number', () => {
  assert.strictEqual(envNum({ K: '5' }, 'K'), 5);
  assert.strictEqual(envNum({ K: '5.5' }, 'K'), 5.5);
  assert.strictEqual(envNum({ K: '0' }, 'K'), 0);
  assert.strictEqual(envNum({ K: '-3' }, 'K'), -3);
});

test('缺失 key → undefined', () => {
  assert.strictEqual(envNum({}, 'K'), undefined);
  assert.strictEqual(envNum({ OTHER: '1' }, 'K'), undefined);
});

test('null/undefined 值 → undefined', () => {
  assert.strictEqual(envNum({ K: null }, 'K'), undefined);
  assert.strictEqual(envNum({ K: undefined }, 'K'), undefined);
});

test('空白(含仅空格)→ undefined', () => {
  assert.strictEqual(envNum({ K: '' }, 'K'), undefined);
  assert.strictEqual(envNum({ K: '   ' }, 'K'), undefined);
});

test('非数字字符串 → undefined', () => {
  assert.strictEqual(envNum({ K: 'abc' }, 'K'), undefined);
  assert.strictEqual(envNum({ K: 'Infinity' }, 'K'), undefined); // Number('Infinity') 非有限
  assert.strictEqual(envNum({ K: 'NaN' }, 'K'), undefined);
});

test('env 本身缺失/非对象 → undefined(不抛)', () => {
  assert.strictEqual(envNum(null, 'K'), undefined);
  assert.strictEqual(envNum(undefined, 'K'), undefined);
});

test('纯函数:同输入同输出', () => {
  const e = { K: '7' };
  assert.strictEqual(envNum(e, 'K'), envNum(e, 'K'));
});
