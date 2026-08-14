'use strict';

/**
 * resolveEnv.test.js — 锁 utils/resolveEnv 口径(收敛 3 处 `_env(env)` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const resolveEnv = require('../src/utils/resolveEnv');

test('真值 env 原样返回(同引用)', () => {
  const injected = { A: '1' };
  assert.strictEqual(resolveEnv(injected), injected);
});

test('空对象 {} 亦真值 → 原样返回(不回退 process.env)', () => {
  const empty = {};
  assert.strictEqual(resolveEnv(empty), empty);
});

test('nullish/假值 → 回退 process.env', () => {
  assert.strictEqual(resolveEnv(undefined), process.env);
  assert.strictEqual(resolveEnv(null), process.env);
  assert.strictEqual(resolveEnv(0), process.env);
  assert.strictEqual(resolveEnv(''), process.env);
});
