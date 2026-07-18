'use strict';

/**
 * isOffValue.test.js — 锁 utils/isOffValue 口径(收敛 5 处 `_falsy` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const isOffValue = require('../src/utils/isOffValue');

test('off-set(含空串)→ true', () => {
  for (const v of ['', '0', 'false', 'off', 'no']) {
    assert.strictEqual(isOffValue(v), true, `expected off for ${JSON.stringify(v)}`);
  }
});

test('trim + 大小写不敏感', () => {
  assert.strictEqual(isOffValue('  OFF  '), true);
  assert.strictEqual(isOffValue('False'), true);
  assert.strictEqual(isOffValue('\tNO\n'), true);
});

test('on-set / 其他值 → false', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'enabled', 'anything']) {
    assert.strictEqual(isOffValue(v), false, `expected non-off for ${JSON.stringify(v)}`);
  }
});

test('nullish → true(空串语义)', () => {
  assert.strictEqual(isOffValue(null), true);
  assert.strictEqual(isOffValue(undefined), true);
});

test('数字强转:0 → off,1 → 非 off', () => {
  assert.strictEqual(isOffValue(0), true);
  assert.strictEqual(isOffValue(1), false);
});

test('default-ON 门控惯用法:未设 → 启用', () => {
  const env = {};
  // 复刻消费方 `!isOffValue(X===undefined?'true':X)`
  assert.strictEqual(!isOffValue(env.KHY_X === undefined ? 'true' : env.KHY_X), true);
  assert.strictEqual(!isOffValue('off'), false);
});
