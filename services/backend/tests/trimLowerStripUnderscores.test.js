'use strict';

/**
 * trimLowerStripUnderscores.test.js — 锁 utils/trimLowerStripUnderscores 口径
 *   (收敛 2 处「trim+lowercase+仅去下划线」规范化 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const norm = require('../src/utils/trimLowerStripUnderscores');

test('trim + lowercase + 删除全部下划线,保留连字符/内部空白', () => {
  assert.strictEqual(norm('  Web_Search  '), 'websearch');
  assert.strictEqual(norm('a_b_c'), 'abc');
  assert.strictEqual(norm('Tool-Name'), 'tool-name'); // 连字符保留
  assert.strictEqual(norm('a b'), 'a b');              // 内部空白保留
});

test('falsy → 空串', () => {
  assert.strictEqual(norm(''), '');
  assert.strictEqual(norm(null), '');
  assert.strictEqual(norm(undefined), '');
  assert.strictEqual(norm(0), '');
  assert.strictEqual(norm(false), '');
});

test('数字 String 强转后规整', () => {
  assert.strictEqual(norm(42), '42');
});

test('逐输入等价原体 String(name||\'\').trim().toLowerCase().replace(/_/g,\'\')', () => {
  const ref = (name) => String(name || '').trim().toLowerCase().replace(/_/g, '');
  for (const s of ['  A_B ', 'x_y-z', 'READ_FILE', '', '  ', 42, null]) {
    assert.strictEqual(norm(s), ref(s));
  }
});
