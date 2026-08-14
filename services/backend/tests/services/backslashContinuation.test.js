'use strict';

/**
 * backslashContinuation.test.js — 反斜杠续行纯叶子门控与转义判定。
 *
 * 锁死:
 *   - 门开(default)→ 光标前是奇数个连续尾部反斜杠(最后一个未转义)→ shouldContinue true;
 *   - 偶数个反斜杠(\\)→ false(字面反斜杠,正常提交);
 *   - 门关(0/false/off/no)→ 恒 false(逐字节回退历史「直接提交」);
 *   - 绝不抛(非字符串 / null / 越界 offset)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { isEnabled, shouldContinue } = require('../../src/services/backslashContinuation');

test('gate default-on', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_BACKSLASH_NEWLINE: '1' }), true);
});

test('gate off (0/false/off/no, case/space-insensitive)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.strictEqual(isEnabled({ KHY_BACKSLASH_NEWLINE: v }), false, v);
  }
});

test('single trailing backslash at cursor → continues (gate on)', () => {
  assert.strictEqual(shouldContinue('foo\\', 4, {}), true);
  assert.strictEqual(shouldContinue('\\', 1, {}), true);
  // 光标在中间但前一字符是单反斜杠也算(CC 判定基于光标前字符)。
  assert.strictEqual(shouldContinue('a\\b', 2, {}), true);
});

test('even run of backslashes → literal, does not continue', () => {
  assert.strictEqual(shouldContinue('foo\\\\', 5, {}), false); // 两个反斜杠
  assert.strictEqual(shouldContinue('x\\\\\\\\', 5, {}), false); // 四个
});

test('odd run > 1 → continues (last one unescaped)', () => {
  assert.strictEqual(shouldContinue('foo\\\\\\', 6, {}), true); // 三个反斜杠
});

test('no trailing backslash → false', () => {
  assert.strictEqual(shouldContinue('foo', 3, {}), false);
  assert.strictEqual(shouldContinue('', 0, {}), false);
  assert.strictEqual(shouldContinue('a\\b', 3, {}), false); // 光标前是 b
});

test('gate-off byte-reverts (never continues even with trailing backslash)', () => {
  assert.strictEqual(shouldContinue('foo\\', 4, { KHY_BACKSLASH_NEWLINE: 'off' }), false);
  assert.strictEqual(shouldContinue('foo\\', 4, { KHY_BACKSLASH_NEWLINE: '0' }), false);
});

test('never throws on junk input', () => {
  assert.doesNotThrow(() => shouldContinue(null, 0, {}));
  assert.doesNotThrow(() => shouldContinue(undefined, undefined, {}));
  assert.doesNotThrow(() => shouldContinue('foo\\', 99, {})); // offset 越界
  assert.doesNotThrow(() => shouldContinue('foo\\', -1, {}));
  assert.strictEqual(shouldContinue(42, 1, {}), false);
});
