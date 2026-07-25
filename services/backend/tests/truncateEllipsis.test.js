'use strict';

/**
 * truncateEllipsis.test.js — 锁 utils/truncateEllipsis 口径(收敛 4 处 `_truncate` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const truncateEllipsis = require('../src/utils/truncateEllipsis');

test('长度 ≤ n 原样返回', () => {
  assert.strictEqual(truncateEllipsis('hi', 5), 'hi');
  assert.strictEqual(truncateEllipsis('abcde', 5), 'abcde');
});

test('超长:slice(0, max(0,n-1)) + 单字符省略号 …', () => {
  assert.strictEqual(truncateEllipsis('hello', 3), 'he…');
  assert.strictEqual(truncateEllipsis('abcdef', 4), 'abc…');
  // '…' 是单个 U+2026
  const out = truncateEllipsis('abcdef', 4);
  assert.strictEqual(out.length, 4);
  assert.strictEqual(out.charCodeAt(3), 0x2026);
});

test('n=0 边界:max(0,-1)=0 → 仅省略号', () => {
  assert.strictEqual(truncateEllipsis('abc', 0), '…');
});

test('nullish → 空串(长度 0 ≤ n)', () => {
  assert.strictEqual(truncateEllipsis(null, 5), '');
  assert.strictEqual(truncateEllipsis(undefined, 5), '');
});

test('非字符串经 toStr 强转,与内联 s==null?\"\":String(s) 语义等价', () => {
  const inline = (s, n) => {
    const str = s == null ? '' : String(s);
    if (str.length <= n) return str;
    return str.slice(0, Math.max(0, n - 1)) + '…';
  };
  for (const [s, n] of [[123456, 4], [{}, 3], [0, 2], ['', 5], [[1, 2, 3], 4]]) {
    assert.strictEqual(truncateEllipsis(s, n), inline(s, n), `mismatch for ${String(s)}/${n}`);
  }
});
