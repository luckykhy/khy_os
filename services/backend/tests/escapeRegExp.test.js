'use strict';

/**
 * escapeRegExp.test.js — 锁 utils/escapeRegExp 口径(收敛 3 处 `_escapeRe` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const escapeRegExp = require('../src/utils/escapeRegExp');

test('转义全部正则元字符', () => {
  assert.strictEqual(escapeRegExp('.*+?^${}()|[]\\'), '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
});

test('普通字符不受影响', () => {
  assert.strictEqual(escapeRegExp('abc_123'), 'abc_123');
});

test('String 强转:非字符串/nullish 按 String(s)(与原体一致)', () => {
  assert.strictEqual(escapeRegExp(5), '5');
  assert.strictEqual(escapeRegExp(null), 'null');
  assert.strictEqual(escapeRegExp(undefined), 'undefined');
});

test('.map 风格多余参数被忽略(与原体一致)', () => {
  assert.strictEqual(['a.b', 'c*d'].map(escapeRegExp).join(','), 'a\\.b,c\\*d');
});

test('转义结果可安全用于 RegExp 精确匹配', () => {
  const raw = 'v1.2.3(beta)';
  const re = new RegExp(`^${escapeRegExp(raw)}$`);
  assert.ok(re.test(raw));
  assert.ok(!re.test('v1X2X3(beta)'));
});
