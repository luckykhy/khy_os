'use strict';

/**
 * parseJsonObjectMap.test.js — 锁 utils/parseJsonObjectMap 口径
 *   (收敛 apiAdapter.parseJsonMap·aiGateway._parseJsonMap 2 处相同 body)。
 */

const test = require('node:test');
const assert = require('node:assert');

const parseJsonObjectMap = require('../src/utils/parseJsonObjectMap');

test('合法 JSON 对象 → 原样返回', () => {
  assert.deepStrictEqual(parseJsonObjectMap('{"a":1,"b":"x"}'), { a: 1, b: 'x' });
});

test('空/空白 → {}', () => {
  assert.deepStrictEqual(parseJsonObjectMap(''), {});
  assert.deepStrictEqual(parseJsonObjectMap('   '), {});
  assert.deepStrictEqual(parseJsonObjectMap(null), {});
});

test('数组 → {}(仅接受普通对象)', () => {
  assert.deepStrictEqual(parseJsonObjectMap('[1,2,3]'), {});
});

test('null 字面量 / 非法 JSON → {}(绝不抛)', () => {
  assert.deepStrictEqual(parseJsonObjectMap('null'), {});
  assert.deepStrictEqual(parseJsonObjectMap('not json'), {});
  assert.doesNotThrow(() => parseJsonObjectMap('{broken'));
  assert.deepStrictEqual(parseJsonObjectMap('{broken'), {});
});
