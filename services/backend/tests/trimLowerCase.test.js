'use strict';

/**
 * trimLowerCase.test.js — 锁 utils/trimLowerCase 口径(收敛 6 处 `String(x||'').trim().toLowerCase()` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const trimLowerCase = require('../src/utils/trimLowerCase');

test('trim + lowercase', () => {
  assert.strictEqual(trimLowerCase('  Hello World  '), 'hello world');
  assert.strictEqual(trimLowerCase('ABC'), 'abc');
  assert.strictEqual(trimLowerCase('\t Cursor \n'), 'cursor');
});

test('falsy(|| \'\' 口径)→ ""', () => {
  for (const v of [null, undefined, '', 0, false, NaN]) {
    assert.strictEqual(trimLowerCase(v), '', `for ${String(v)}`);
  }
});

test('数字/对象经 String() 强转', () => {
  assert.strictEqual(trimLowerCase(42), '42');
  assert.strictEqual(trimLowerCase('  A_B  '), 'a_b');
});

test('与原 inline 形式逐输入等价', () => {
  const inline = (v) => String(v || '').trim().toLowerCase();
  for (const v of ['  Hi ', 'X', null, undefined, 0, 42, false, ' Mixed_Case ']) {
    assert.strictEqual(trimLowerCase(v), inline(v), `for ${String(v)}`);
  }
});
