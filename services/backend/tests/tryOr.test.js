'use strict';

/**
 * tryOr.test.js — 锁 utils/tryOr 的口径。
 *
 * 这是 8 处曾逐字节相同的私有 `_safe(fn, dflt)`(cli/handlers/*)收敛后的单一真源。
 * 此测同时是逐字节回退的护栏:若 try/catch combinator 语义漂移,八个 handler 的
 * fail-soft 分支会一起变,此测先红。
 */

const test = require('node:test');
const assert = require('node:assert');

const tryOr = require('../src/utils/tryOr');

test('fn 正常返回 → 透传其返回值', () => {
  assert.strictEqual(tryOr(() => 42, 'x'), 42);
  assert.strictEqual(tryOr(() => 'ok', 'x'), 'ok');
});

test('fn 抛异常 → 返回 dflt', () => {
  assert.strictEqual(tryOr(() => { throw new Error('boom'); }, 'fallback'), 'fallback');
});

test('dflt 可为任意类型(含 undefined/null/对象)', () => {
  assert.strictEqual(tryOr(() => { throw 0; }, undefined), undefined);
  assert.strictEqual(tryOr(() => { throw 0; }, null), null);
  const obj = { a: 1 };
  assert.strictEqual(tryOr(() => { throw 0; }, obj), obj);
});

test('fn 返回 falsy 值时不落 dflt(只有抛错才落)', () => {
  assert.strictEqual(tryOr(() => 0, 9), 0);
  assert.strictEqual(tryOr(() => '', 'x'), '');
  assert.strictEqual(tryOr(() => false, true), false);
  assert.strictEqual(tryOr(() => null, 'x'), null);
});

test('fn 只被调用一次(不重试)', () => {
  let calls = 0;
  tryOr(() => { calls += 1; return calls; }, -1);
  assert.strictEqual(calls, 1);
  calls = 0;
  tryOr(() => { calls += 1; throw new Error('x'); }, -1);
  assert.strictEqual(calls, 1);
});

test('非 Error 抛出物(字符串/数字)一样被兜住', () => {
  assert.strictEqual(tryOr(() => { throw 'str'; }, 'd'), 'd');
  assert.strictEqual(tryOr(() => { throw 123; }, 'd'), 'd');
});
