'use strict';

/**
 * normalizeAlnumKey.test.js — 锁 utils/normalizeAlnumKey 口径
 *   (收敛 6 处「lowercase + 去全部非字母数字」工具名规范化 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const normalizeAlnumKey = require('../src/utils/normalizeAlnumKey');

test('小写 + 去除全部非字母数字(点/斜杠/空白/下划线/连字符/unicode)', () => {
  assert.strictEqual(normalizeAlnumKey('Read'), 'read');
  assert.strictEqual(normalizeAlnumKey('web_search'), 'websearch');
  assert.strictEqual(normalizeAlnumKey('a.b/c'), 'abc');
  assert.strictEqual(normalizeAlnumKey('Tool-Name!! 123'), 'toolname123');
  assert.strictEqual(normalizeAlnumKey('中文Read工具'), 'read');
});

test('falsy → 空串', () => {
  assert.strictEqual(normalizeAlnumKey(''), '');
  assert.strictEqual(normalizeAlnumKey(null), '');
  assert.strictEqual(normalizeAlnumKey(undefined), '');
  assert.strictEqual(normalizeAlnumKey(0), '');
  assert.strictEqual(normalizeAlnumKey(false), '');
  assert.strictEqual(normalizeAlnumKey(), '');
});

test('数字 String 强转后规整', () => {
  assert.strictEqual(normalizeAlnumKey(42), '42');
});

test('A(+)与 B(无+)正则变体输出等价——空替换令 + 无关', () => {
  const A = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const B = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const s of ['a  b__c', 'X-Y-Z', 'Tool @#$ 9', '', '  ', 'read']) {
    assert.strictEqual(normalizeAlnumKey(s), A(s));
    assert.strictEqual(normalizeAlnumKey(s), B(s));
  }
});
