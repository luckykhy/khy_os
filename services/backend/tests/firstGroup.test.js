'use strict';

/**
 * firstGroup.test.js — 锁 utils/firstGroup 口径
 *   (收敛 nlExternalAppResolver·nlProviderResolver 2 处相同 body 的 _firstGroup)。
 */

const test = require('node:test');
const assert = require('node:assert');

const firstGroup = require('../src/utils/firstGroup');

test('取第 1 捕获组并 trim', () => {
  assert.strictEqual(firstGroup(/name:\s*(\S+)/, 'name:  alice'), 'alice');
  assert.strictEqual(firstGroup(/x=(\s*\w+\s*)/, 'x=  foo  '), 'foo');
});

test('无匹配 / 无捕获组 → 空串', () => {
  assert.strictEqual(firstGroup(/nope:(\w+)/, 'name: alice'), '');
  assert.strictEqual(firstGroup(/\bhttps?/, 'https://x'), ''); // 匹配但无 group 1
});

test('text 非字符串 → 空串(绝不抛)', () => {
  assert.strictEqual(firstGroup(/(\w+)/, null), '');
  assert.strictEqual(firstGroup(/(\w+)/, undefined), '');
  assert.strictEqual(firstGroup(/(\w+)/, 123), '');
});

test('空捕获组 → 空串', () => {
  assert.strictEqual(firstGroup(/a(b?)/, 'a'), ''); // group1 = '' → falsy → ''
});

test('不 mutate 入参(regex/text)', () => {
  const re = /(\w+)/;
  const before = re.lastIndex;
  firstGroup(re, 'hello');
  assert.strictEqual(re.lastIndex, before);
});
