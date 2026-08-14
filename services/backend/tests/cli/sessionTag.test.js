'use strict';

// 纯叶子 sessionTag 的单测:对齐 CC `/tag` 的后端逻辑——
// 切换(toggle)标签、规范化、去重保序、算出完整新数组。零 IO、确定性、fail-soft。
const test = require('node:test');
const assert = require('node:assert');
const {
  isEnabled,
  normalizeTag,
  parseTagArgs,
  applyTags,
} = require('../../src/cli/sessionTag');

test('isEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_TAG: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(isEnabled({ KHY_TAG: off }), false, `应关: ${off}`);
  }
});

test('normalizeTag:trim + 内部空白折叠;空 → null', () => {
  assert.strictEqual(normalizeTag('  foo  '), 'foo');
  assert.strictEqual(normalizeTag('a   b'), 'a b');
  assert.strictEqual(normalizeTag(''), null);
  assert.strictEqual(normalizeTag('   '), null);
  assert.strictEqual(normalizeTag(null), null);
  assert.strictEqual(normalizeTag(123), '123');
});

test('parseTagArgs:逗号/空格分隔,保序去重', () => {
  assert.deepStrictEqual(parseTagArgs(['a', 'b']), ['a', 'b']);
  assert.deepStrictEqual(parseTagArgs(['a,b,c']), ['a', 'b', 'c']);
  assert.deepStrictEqual(parseTagArgs(['a', 'a', 'b']), ['a', 'b']);   // 去重
  assert.deepStrictEqual(parseTagArgs(['  x , y ']), ['x', 'y']);       // trim
  assert.deepStrictEqual(parseTagArgs([]), []);
  assert.deepStrictEqual(parseTagArgs(null), []);
});

test('applyTags:新标签加入(保序)', () => {
  const r = applyTags(['a'], ['b', 'c']);
  assert.deepStrictEqual(r.tags, ['a', 'b', 'c']);
  assert.deepStrictEqual(r.added, ['b', 'c']);
  assert.deepStrictEqual(r.removed, []);
});

test('applyTags:同名再打 → 移除(toggle)', () => {
  const r = applyTags(['a', 'b', 'c'], ['b']);
  assert.deepStrictEqual(r.tags, ['a', 'c']);
  assert.deepStrictEqual(r.added, []);
  assert.deepStrictEqual(r.removed, ['b']);
});

test('applyTags:一次混合增删', () => {
  const r = applyTags(['keep', 'drop'], ['drop', 'new']);
  assert.deepStrictEqual(r.tags, ['keep', 'new']);
  assert.deepStrictEqual(r.added, ['new']);
  assert.deepStrictEqual(r.removed, ['drop']);
});

test('applyTags:现有标签先规范化去重(防呆脏数据)', () => {
  const r = applyTags(['  a  ', 'a', null, '', 'b'], ['c']);
  assert.deepStrictEqual(r.tags, ['a', 'b', 'c']);
});

test('applyTags:空请求 → 原样(规范化后)无增删', () => {
  const r = applyTags(['a', 'b'], []);
  assert.deepStrictEqual(r.tags, ['a', 'b']);
  assert.deepStrictEqual(r.added, []);
  assert.deepStrictEqual(r.removed, []);
});

test('applyTags:existing 非数组防呆 → 视为空', () => {
  const r = applyTags(null, ['x']);
  assert.deepStrictEqual(r.tags, ['x']);
  assert.deepStrictEqual(r.added, ['x']);
});
