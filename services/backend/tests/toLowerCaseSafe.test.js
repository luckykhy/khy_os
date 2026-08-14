'use strict';

/**
 * toLowerCaseSafe.test.js — 锁 utils/toLowerCaseSafe 口径(收敛 3 处 `_norm(s)` lowercase-only 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const toLowerCaseSafe = require('../src/utils/toLowerCaseSafe');

test('字符串 → toLowerCase(不 trim/不去空白)', () => {
  assert.strictEqual(toLowerCaseSafe('ABC'), 'abc');
  assert.strictEqual(toLowerCaseSafe('  Mixed Case  '), '  mixed case  ');
  assert.strictEqual(toLowerCaseSafe('A_B-C'), 'a_b-c');
});

test('null/undefined → ""', () => {
  assert.strictEqual(toLowerCaseSafe(null), '');
  assert.strictEqual(toLowerCaseSafe(undefined), '');
});

test('非字符串经 String() 强转后 lowercase(区别于类型闸门)', () => {
  assert.strictEqual(toLowerCaseSafe(0), '0');
  assert.strictEqual(toLowerCaseSafe(42), '42');
  assert.strictEqual(toLowerCaseSafe(true), 'true');
});

test('与原 inline 形式逐输入等价', () => {
  const inline = (s) => String(s == null ? '' : s).toLowerCase();
  for (const v of ['ABC', '  X ', null, undefined, 0, 42, true, 'A_B-C', '']) {
    assert.strictEqual(toLowerCaseSafe(v), inline(v), `for ${String(v)}`);
  }
});
