'use strict';

/**
 * withTimeout.test.js — 锁 utils/withTimeout 口径
 *   (收敛 contextScope·reconstructionPort 2 处相同 body 的 _withTimeout)。
 */

const test = require('node:test');
const assert = require('node:assert');

const withTimeout = require('../src/utils/withTimeout');

test('原 promise 先结算 → resolve 其值', async () => {
  const r = await withTimeout(Promise.resolve(42), 1000);
  assert.strictEqual(r, 42);
});

test('超时先到 → resolve { __timeout: true }', async () => {
  const slow = new Promise((res) => setTimeout(() => res('late'), 50));
  const r = await withTimeout(slow, 5);
  assert.deepStrictEqual(r, { __timeout: true });
});

test('原 promise reject → resolve { __error: true }(绝不 reject)', async () => {
  const r = await withTimeout(Promise.reject(new Error('boom')), 1000);
  assert.deepStrictEqual(r, { __error: true });
});

test('非 promise 值也被 resolve', async () => {
  const r = await withTimeout('plain', 1000);
  assert.strictEqual(r, 'plain');
});

test('只结算一次(超时后原 promise 再 fulfilled 不改结果)', async () => {
  const slow = new Promise((res) => setTimeout(() => res('X'), 30));
  const r = await withTimeout(slow, 5);
  assert.deepStrictEqual(r, { __timeout: true });
  await new Promise((res) => setTimeout(res, 40)); // 让 slow 结算
  assert.deepStrictEqual(r, { __timeout: true });
});
