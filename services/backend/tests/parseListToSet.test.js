'use strict';

/**
 * parseListToSet.test.js — 锁 utils/parseListToSet 口径
 *   (收敛 3 处 gateway env 列表解析 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const parseListToSet = require('../src/utils/parseListToSet');

test('非字符串 / falsy → 空 Set', () => {
  assert.deepStrictEqual([...parseListToSet('')], []);
  assert.deepStrictEqual([...parseListToSet(null)], []);
  assert.deepStrictEqual([...parseListToSet(undefined)], []);
  assert.deepStrictEqual([...parseListToSet(42)], []);
  assert.deepStrictEqual([...parseListToSet({})], []);
});

test('逗号分隔 → 小写去重', () => {
  assert.deepStrictEqual([...parseListToSet('A,B,c')], ['a', 'b', 'c']);
  assert.deepStrictEqual([...parseListToSet('X,x,X')], ['x']);
});

test('空白 / 混合分隔', () => {
  assert.deepStrictEqual([...parseListToSet('a b\tc')], ['a', 'b', 'c']);
  assert.deepStrictEqual([...parseListToSet('a, b ,  c')], ['a', 'b', 'c']);
});

test('trim 空段被丢弃', () => {
  assert.deepStrictEqual([...parseListToSet(',,a,,')], ['a']);
  assert.deepStrictEqual([...parseListToSet('   ')], []);
});

test('每次返回新 Set(不共享)', () => {
  const a = parseListToSet('x');
  const b = parseListToSet('x');
  assert.notStrictEqual(a, b);
});

test('逐输入等价原体', () => {
  const ref = (raw) => {
    const out = new Set();
    if (!raw || typeof raw !== 'string') return out;
    for (const part of raw.split(/[,\s]+/)) {
      const v = part.trim().toLowerCase();
      if (v) out.add(v);
    }
    return out;
  };
  for (const s of ['', null, undefined, 42, 'A,B', 'x x x', ' ,gpt-4 , CLAUDE ,', '\ta\nb']) {
    assert.deepStrictEqual([...parseListToSet(s)], [...ref(s)]);
  }
});
