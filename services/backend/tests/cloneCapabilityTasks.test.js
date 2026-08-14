'use strict';

/**
 * cloneCapabilityTasks.test.js — 锁 utils/cloneCapabilityTasks 口径
 *   (收敛 capabilityAssessment·toolUseLoopCore 2 处相同 body 的 _cloneCapabilityTasks)。
 */

const test = require('node:test');
const assert = require('node:assert');

const clone = require('../src/utils/cloneCapabilityTasks');

test('非数组 → []', () => {
  assert.deepStrictEqual(clone(null), []);
  assert.deepStrictEqual(clone(undefined), []);
  assert.deepStrictEqual(clone('x'), []);
  assert.deepStrictEqual(clone(), []);
});

test('剔除非对象 task', () => {
  assert.deepStrictEqual(clone([1, 'a', null, undefined, { id: 'k' }]), [
    { id: 'k', patterns: [], requiredTools: [] },
  ]);
});

test('浅克隆 + 数组字段复制(不共享引用)', () => {
  const src = [{ id: 'a', patterns: ['p1'], requiredTools: ['t1'], extra: 1 }];
  const out = clone(src);
  assert.deepStrictEqual(out, [{ id: 'a', patterns: ['p1'], requiredTools: ['t1'], extra: 1 }]);
  assert.notStrictEqual(out[0], src[0]);
  assert.notStrictEqual(out[0].patterns, src[0].patterns);
  assert.notStrictEqual(out[0].requiredTools, src[0].requiredTools);
  // mutate 输出不影响源
  out[0].patterns.push('p2');
  assert.deepStrictEqual(src[0].patterns, ['p1']);
});

test('非数组 patterns/requiredTools → []', () => {
  assert.deepStrictEqual(clone([{ id: 'a', patterns: 'nope', requiredTools: 5 }]), [
    { id: 'a', patterns: [], requiredTools: [] },
  ]);
});

test('不 mutate 入参数组', () => {
  const src = [{ id: 'a', patterns: ['p'] }];
  const before = JSON.stringify(src);
  clone(src);
  assert.strictEqual(JSON.stringify(src), before);
});
