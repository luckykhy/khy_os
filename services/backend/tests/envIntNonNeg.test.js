'use strict';

/**
 * envIntNonNeg.test.js — 锁 utils/envIntNonNeg 口径(收敛 3 处 `_envInt(name,def)` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const envIntNonNeg = require('../src/utils/envIntNonNeg');

const KEY = '__KHY_TEST_ENVINT__';
function withEnv(v, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
  const prev = process.env[KEY];
  if (v === undefined) delete process.env[KEY];
  else process.env[KEY] = v;
  try { return fn(); } finally {
    if (had) process.env[KEY] = prev; else delete process.env[KEY];
  }
}

test('未设 → def', () => {
  withEnv(undefined, () => assert.strictEqual(envIntNonNeg(KEY, 42), 42));
});

test('空串/纯空白 → def', () => {
  withEnv('   ', () => assert.strictEqual(envIntNonNeg(KEY, 7), 7));
});

test('合法非负整数 → 该值(含 0,含前后空白与尾随非数字)', () => {
  withEnv('0', () => assert.strictEqual(envIntNonNeg(KEY, 5), 0));
  withEnv(' 123 ', () => assert.strictEqual(envIntNonNeg(KEY, 5), 123));
  withEnv('80px', () => assert.strictEqual(envIntNonNeg(KEY, 5), 80));
});

test('负数 / 非数字 → def', () => {
  withEnv('-3', () => assert.strictEqual(envIntNonNeg(KEY, 9), 9));
  withEnv('abc', () => assert.strictEqual(envIntNonNeg(KEY, 9), 9));
});

test('与原 inline 形式逐输入等价', () => {
  const inline = (name, def) => {
    const n = Number.parseInt(String(process.env[name] || '').trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  for (const v of [undefined, '', '  ', '0', '5', ' 12 ', '-1', 'x', '99z']) {
    withEnv(v, () => assert.strictEqual(envIntNonNeg(KEY, 100), inline(KEY, 100), `for ${JSON.stringify(v)}`));
  }
});
