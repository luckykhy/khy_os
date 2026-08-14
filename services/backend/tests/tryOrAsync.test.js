'use strict';

/**
 * tryOrAsync.test.js — 锁 utils/tryOrAsync 的口径。
 *
 * 这是 5 处曾逐字节相同的私有 `_safeAsync(fn, dflt)`(cli/handlers/*)收敛后的单一真源。
 * 覆盖 sync 抛出 + rejected Promise 两条失败路径,是逐字节回退的护栏。
 */

const test = require('node:test');
const assert = require('node:assert');

const tryOrAsync = require('../src/utils/tryOrAsync');

test('fn resolve → 透传其值', async () => {
  assert.strictEqual(await tryOrAsync(async () => 42, 'x'), 42);
  assert.strictEqual(await tryOrAsync(() => 7, 'x'), 7); // 非 async fn 也可(await 非 thenable 直接得值)
});

test('fn 同步抛出 → 返回 dflt', async () => {
  assert.strictEqual(await tryOrAsync(() => { throw new Error('boom'); }, 'fb'), 'fb');
});

test('fn 返回 rejected Promise → 返回 dflt', async () => {
  assert.strictEqual(await tryOrAsync(async () => { throw new Error('async boom'); }, 'fb'), 'fb');
  assert.strictEqual(await tryOrAsync(() => Promise.reject(new Error('rej')), 'fb'), 'fb');
});

test('resolve 到 falsy 值时不落 dflt(只有异常才落)', async () => {
  assert.strictEqual(await tryOrAsync(async () => 0, 9), 0);
  assert.strictEqual(await tryOrAsync(async () => '', 'x'), '');
  assert.strictEqual(await tryOrAsync(async () => null, 'x'), null);
  assert.strictEqual(await tryOrAsync(async () => false, true), false);
});

test('dflt 可为任意类型', async () => {
  assert.strictEqual(await tryOrAsync(() => { throw 0; }, undefined), undefined);
  const obj = { a: 1 };
  assert.strictEqual(await tryOrAsync(() => Promise.reject(0), obj), obj);
});

test('fn 只被调用一次(不重试)', async () => {
  let calls = 0;
  await tryOrAsync(async () => { calls += 1; throw new Error('x'); }, -1);
  assert.strictEqual(calls, 1);
});
