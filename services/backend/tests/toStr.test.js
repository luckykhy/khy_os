'use strict';

/**
 * toStr.test.js — 锁 utils/toStr 家族的口径(收敛 11 处私有 `_str(v)` 的单一真源护栏)。
 * 关键:toStr 与被收敛的 typeof-fast-path 簇对所有输入输出等价;toStr 不吞异常,toStrSafe 吞。
 */

const test = require('node:test');
const assert = require('node:assert');

const { toStr, toStrSafe } = require('../src/utils/toStr');

// 被收敛的 typeof fast-path 原体,用于逐输入等价核对
function _legacyTypeof(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

test('toStr:null/undefined → 空串,其余 String 强转', () => {
  assert.strictEqual(toStr(null), '');
  assert.strictEqual(toStr(undefined), '');
  assert.strictEqual(toStr('abc'), 'abc');
  assert.strictEqual(toStr(123), '123');
  assert.strictEqual(toStr(0), '0');
  assert.strictEqual(toStr(false), 'false');
  assert.strictEqual(toStr({}), '[object Object]');
  assert.strictEqual(toStr(new String('y')), 'y');
});

test('toStr 对所有输入类与 typeof-fast-path 原体等价', () => {
  const cases = [null, undefined, '', 'x', 0, 1, -2, true, false, {}, [1, 2], new String('z')];
  for (const v of cases) {
    assert.strictEqual(toStr(v), _legacyTypeof(v), `mismatch for ${String(v)}`);
  }
});

test('toStr 不吞异常(与原体一致):toString 抛错的对象 → 抛', () => {
  const bad = { toString() { throw new Error('boom'); } };
  assert.throws(() => toStr(bad));
});

test('toStrSafe:同 toStr,但 toString 抛错 → 空串', () => {
  assert.strictEqual(toStrSafe(null), '');
  assert.strictEqual(toStrSafe('abc'), 'abc');
  assert.strictEqual(toStrSafe(123), '123');
  const bad = { toString() { throw new Error('boom'); } };
  assert.strictEqual(toStrSafe(bad), '');
});
