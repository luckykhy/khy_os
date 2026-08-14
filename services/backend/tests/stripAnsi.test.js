'use strict';

/**
 * stripAnsi.test.js — 锁 utils/stripAnsi 口径(收敛 5 处裸参 SGR-剥离 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const stripAnsi = require('../src/utils/stripAnsi');

test('剥离 SGR 颜色码,保留可见文本', () => {
  assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.strictEqual(stripAnsi('\x1b[1;32mbold green\x1b[0m tail'), 'bold green tail');
});

test('无 ANSI 原样返回', () => {
  assert.strictEqual(stripAnsi('plain text'), 'plain text');
  assert.strictEqual(stripAnsi(''), '');
});

test('仅剥 …m 形 SGR,不动其他控制序列(与原体一致)', () => {
  // 光标移动 ESC[2A 不以 m 结尾 → 不被此正则剥离
  assert.strictEqual(stripAnsi('\x1b[2Akeep'), '\x1b[2Akeep');
});

test('裸参:非字符串抛(与被收敛五簇假定字符串输入一致)', () => {
  assert.throws(() => stripAnsi(null));
  assert.throws(() => stripAnsi(42));
});
