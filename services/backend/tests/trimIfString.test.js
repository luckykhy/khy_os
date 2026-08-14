'use strict';

/**
 * trimIfString.test.js — 锁 utils/trimIfString 口径(收敛 4 处 `_s(v)` 类型闸门的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const trimIfString = require('../src/utils/trimIfString');

test('字符串 → trim 后返回', () => {
  assert.strictEqual(trimIfString('  hi  '), 'hi');
  assert.strictEqual(trimIfString('x'), 'x');
  assert.strictEqual(trimIfString('   '), '');
  assert.strictEqual(trimIfString(''), '');
});

test('非字符串一律 → ""(不强转)', () => {
  for (const v of [0, 1, 123, true, false, null, undefined, {}, [], NaN, Symbol('s')]) {
    assert.strictEqual(trimIfString(v), '', `for ${String(v)}`);
  }
});

test('与 String() 强转刻意不同(数字 42 → "" 而非 "42")', () => {
  assert.strictEqual(trimIfString(42), '');
  assert.strictEqual(String(42), '42');
});

test('与原 inline 形式逐输入等价', () => {
  const inline = (v) => (typeof v === 'string' ? v.trim() : '');
  for (const v of ['  a ', '', '   ', 0, 42, true, null, undefined, {}, ['x']]) {
    assert.strictEqual(trimIfString(v), inline(v), `for ${String(v)}`);
  }
});
