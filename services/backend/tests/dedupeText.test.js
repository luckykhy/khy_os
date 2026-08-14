'use strict';

/**
 * dedupeText.test.js — 锁 utils/dedupeText 口径(收敛 2 处证据/理由清洗 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const dedupeText = require('../src/utils/dedupeText');

test('去重复+保序', () => {
  assert.deepStrictEqual(dedupeText(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
});

test('trim 后去重(空白视同)', () => {
  assert.deepStrictEqual(dedupeText([' a ', 'a', '  a']), ['a']);
});

test('丢弃空/falsy 项', () => {
  assert.deepStrictEqual(dedupeText(['', '  ', null, undefined, 'x', 0]), ['x']);
});

test('空/缺省入参 → 空数组', () => {
  assert.deepStrictEqual(dedupeText(), []);
  assert.deepStrictEqual(dedupeText([]), []);
});

test('不 mutate 入参 + 逐输入等价原体', () => {
  const ref = (items = []) => {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const normalized = String(item || '').trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  };
  const input = ['x', ' y ', 'x', '', 'z', 'y'];
  const snapshot = [...input];
  const got = dedupeText(input);
  assert.deepStrictEqual(input, snapshot);
  assert.deepStrictEqual(got, ref(['x', ' y ', 'x', '', 'z', 'y']));
});
