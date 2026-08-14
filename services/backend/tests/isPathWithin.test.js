'use strict';

/**
 * isPathWithin.test.js — 锁 utils/isPathWithin 口径
 *   (收敛 3 处路径包含判定 helper 的护栏·含 fail-closed 安全断言)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const isPathWithin = require('../src/utils/isPathWithin');

test('target 在 parent 之内 → true', () => {
  assert.strictEqual(isPathWithin('/tmp', '/tmp/sub/x'), true);
});

test('parent 与 target 相等 → true', () => {
  assert.strictEqual(isPathWithin('/tmp/a', '/tmp/a'), true);
});

test('target 在 parent 之外 → false', () => {
  assert.strictEqual(isPathWithin('/tmp/a', '/tmp/b'), false);
  assert.strictEqual(isPathWithin('/home/u', '/tmp/x'), false);
});

test('任一空/falsy → false (安全: 无法判定即拒绝)', () => {
  assert.strictEqual(isPathWithin('', '/tmp/x'), false);
  assert.strictEqual(isPathWithin('/tmp', ''), false);
  assert.strictEqual(isPathWithin(null, null), false);
});

test('逐输入等价原体', () => {
  const ref = (parent = '', target = '') => {
    const base = String(parent || '').trim();
    const value = String(target || '').trim();
    if (!base || !value) return false;
    try {
      const rel = path.relative(path.resolve(base), path.resolve(value));
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    } catch {
      return false;
    }
  };
  const cases = [
    ['/tmp', '/tmp/x'],
    ['/tmp/a', '/tmp/a'],
    ['/tmp/a', '/tmp/b'],
    ['  /tmp  ', '  /tmp/y  '],
    ['', ''],
    [null, '/x'],
    ['/a/b/c', '/a'],
    ['relbase', 'relbase/child'],
  ];
  for (const [p, t] of cases) {
    assert.strictEqual(isPathWithin(p, t), ref(p, t));
  }
});
