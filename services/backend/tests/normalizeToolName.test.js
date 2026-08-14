'use strict';

/**
 * normalizeToolName.test.js — 锁 utils/normalizeToolName 口径(收敛 6 处 tool-name 归一器的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const normalizeToolName = require('../src/utils/normalizeToolName');

test('lowercase + 去空白/下划线/连字符', () => {
  assert.strictEqual(normalizeToolName('Read File'), 'readfile');
  assert.strictEqual(normalizeToolName('read_file'), 'readfile');
  assert.strictEqual(normalizeToolName('read-file'), 'readfile');
  assert.strictEqual(normalizeToolName('  Web\tSearch  '), 'websearch');
});

test('falsy(|| \'\' 口径)→ ""', () => {
  for (const v of [null, undefined, '', 0, false, NaN]) {
    assert.strictEqual(normalizeToolName(v), '', `for ${String(v)}`);
  }
});

test('数字/对象经 String() 强转后归一', () => {
  assert.strictEqual(normalizeToolName(42), '42');
  assert.strictEqual(normalizeToolName('A-B_C D'), 'abcd');
});

test('与原 inline 形式逐输入等价', () => {
  const inline = (name) => String(name || '').toLowerCase().replace(/[\s_-]/g, '');
  for (const v of ['Read File', 'read_file', '', null, undefined, 0, 42, 'X-Y', '  a b  ']) {
    assert.strictEqual(normalizeToolName(v), inline(v), `for ${String(v)}`);
  }
});
