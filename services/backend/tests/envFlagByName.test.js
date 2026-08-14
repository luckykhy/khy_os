'use strict';

/**
 * envFlagByName.test.js — 锁 utils/envFlagByName 口径(收敛 4 处 remote/* `_envFlag` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const envFlagByName = require('../src/utils/envFlagByName');

const KEY = '__KHY_TEST_ENVFLAG__';
function withEnv(v, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
  const prev = process.env[KEY];
  if (v === undefined) delete process.env[KEY];
  else process.env[KEY] = v;
  try { return fn(); } finally {
    if (had) process.env[KEY] = prev; else delete process.env[KEY];
  }
}

test('未设 → fallback', () => {
  withEnv(undefined, () => {
    assert.strictEqual(envFlagByName(KEY), false);
    assert.strictEqual(envFlagByName(KEY, true), true);
  });
});

test('空串 → fallback', () => {
  withEnv('   ', () => {
    assert.strictEqual(envFlagByName(KEY, true), true);
    assert.strictEqual(envFlagByName(KEY, false), false);
  });
});

test('on-set {1,true,yes,on,enabled} → true(大小写/空白不敏感)', () => {
  for (const v of ['1', 'true', 'YES', ' on ', 'Enabled']) {
    withEnv(v, () => assert.strictEqual(envFlagByName(KEY), true, `for ${v}`));
  }
});

test('未知值 → false(非 fallback)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'maybe']) {
    withEnv(v, () => {
      assert.strictEqual(envFlagByName(KEY, true), false, `for ${v} — 未知值应 false 非 fallback`);
    });
  }
});
