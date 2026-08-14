'use strict';

/**
 * envFlagEnabled.test.js — 锁 utils/envFlagEnabled 口径
 *   (收敛 3 处三态 env 开关 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const envFlagEnabled = require('../src/utils/envFlagEnabled');

test('空 / undefined / null → 默认值', () => {
  assert.strictEqual(envFlagEnabled(undefined), true);
  assert.strictEqual(envFlagEnabled(null), true);
  assert.strictEqual(envFlagEnabled(''), true);
  assert.strictEqual(envFlagEnabled('   '), true);
  assert.strictEqual(envFlagEnabled(undefined, false), false);
  assert.strictEqual(envFlagEnabled('', false), false);
});

test('显式真值 → true', () => {
  for (const v of ['1', 'true', 'ON', 'Yes', 'y', '  TRUE  ']) {
    assert.strictEqual(envFlagEnabled(v, false), true, v);
  }
});

test('显式假值 → false', () => {
  for (const v of ['0', 'false', 'OFF', 'No', 'n', '  0  ']) {
    assert.strictEqual(envFlagEnabled(v, true), false, v);
  }
});

test('无法识别 → 默认值', () => {
  assert.strictEqual(envFlagEnabled('maybe', true), true);
  assert.strictEqual(envFlagEnabled('maybe', false), false);
});

test('逐输入等价原体', () => {
  const ref = (rawValue, defaultValue = true) => {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return defaultValue;
    const normalized = String(rawValue).trim().toLowerCase();
    if (['1', 'true', 'on', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'off', 'no', 'n'].includes(normalized)) return false;
    return defaultValue;
  };
  const inputs = [undefined, null, '', '  ', '1', 'true', 'on', 'yes', 'y', '0', 'false', 'off', 'no', 'n', 'maybe', 'MAYBE', 42];
  for (const v of inputs) {
    assert.strictEqual(envFlagEnabled(v), ref(v), `${v} default`);
    assert.strictEqual(envFlagEnabled(v, false), ref(v, false), `${v} false`);
  }
});
