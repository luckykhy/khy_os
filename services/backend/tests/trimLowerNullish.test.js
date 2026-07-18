'use strict';

/**
 * trimLowerNullish.test.js — 锁 utils/trimLowerNullish 口径
 *   (收敛 5 处「nullish-coerce + trim + lowercase」规范化 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const norm = require('../src/utils/trimLowerNullish');

test('trim + lowercase·nullish 保留 0/false', () => {
  assert.strictEqual(norm('  GLM-4V  '), 'glm-4v');
  assert.strictEqual(norm('Tool_Name'), 'tool_name'); // 下划线保留(与 trimLowerStripUnderscores 区分)
  assert.strictEqual(norm(0), '0');                    // nullish 非 falsy
  assert.strictEqual(norm(false), 'false');
  assert.strictEqual(norm(42), '42');
});

test('null/undefined → 空串', () => {
  assert.strictEqual(norm(null), '');
  assert.strictEqual(norm(undefined), '');
  assert.strictEqual(norm(''), '');
  assert.strictEqual(norm('   '), '');
});

test('逐输入等价原体 String(s==null?\'\':s).trim().toLowerCase()', () => {
  const ref = (s) => String(s == null ? '' : s).trim().toLowerCase();
  for (const s of ['  A B ', 'MODEL', '', '  ', 0, false, 42, null, undefined]) {
    assert.strictEqual(norm(s), ref(s));
  }
});

test('与 trimLowerCase(falsy) 在 0/false 上刻意分叉', () => {
  const falsy = (v) => String(v || '').trim().toLowerCase();
  assert.notStrictEqual(norm(0), falsy(0));     // '0' vs ''
  assert.notStrictEqual(norm(false), falsy(false)); // 'false' vs ''
});
