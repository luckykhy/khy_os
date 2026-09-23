'use strict';
/**
 * diffLineNumbers — ±diff 行号化纯叶子单测。
 *
 * 验证:① 门控 KHY_DIFF_LINE_NUMBERS 字节回退口径;
 *      ② unified-diff hunk 头 `@@ -a,b +c,d @@` 解析(含无长度、带尾随上下文、非头、畸形)。
 *
 * 双运行器:jest 下 describe/test/expect/beforeEach 为原生全局;node --test 下
 * 由下方 shim 映射到 node:test。
 */
const dl = require('../../src/cli/diffLineNumbers');
const assert = require('node:assert');

if (typeof globalThis.describe !== 'function') {
  const _nt = require(['node', ':test'].join(''));
  const _a = require(['node', ':assert/strict'].join(''));
  globalThis.describe = function (name, fn) {
    return _nt.test(name, fn);
  };
  globalThis.test = _nt.test;
  globalThis.expect = (v) => ({
    toBe: (e, m) => _a.strictEqual(v, e, m),
    toContain: (e, m) => _a.ok(String(v).includes(e), m || 'toContain'),
    toBeTruthy: (m) => _a.ok(v, m),
  });
}

describe('diffLineNumbersEnabled — 门控 KHY_DIFF_LINE_NUMBERS', () => {
  test('未设(默认)→ 开', () => {
    expect(dl.diffLineNumbersEnabled({})).toBe(true);
  });

  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    test(`=${off} → 关`, () => {
      expect(dl.diffLineNumbersEnabled({ KHY_DIFF_LINE_NUMBERS: off })).toBe(false);
    });
  }

  test('=1 / 任意其他真值 → 开', () => {
    expect(dl.diffLineNumbersEnabled({ KHY_DIFF_LINE_NUMBERS: '1' })).toBe(true);
    expect(dl.diffLineNumbersEnabled({ KHY_DIFF_LINE_NUMBERS: 'yes' })).toBe(true);
  });
});

describe('parseUnifiedHunkHeader — `@@ -a,b +c,d @@`', () => {
  test('标准头取 old/new 起始行', () => {
    assert.deepEqual(dl.parseUnifiedHunkHeader('@@ -10,2 +14,6 @@'), { oldStart: 10, newStart: 14 });
  });

  test('无长度(单行)亦可', () => {
    assert.deepEqual(dl.parseUnifiedHunkHeader('@@ -50 +60 @@'), { oldStart: 50, newStart: 60 });
  });

  test('带尾随函数上下文', () => {
    assert.deepEqual(
      dl.parseUnifiedHunkHeader('@@ -1,3 +1,3 @@ function foo() {'),
      { oldStart: 1, newStart: 1 }
    );
  });

  test('非 hunk 头 → null', () => {
    expect(dl.parseUnifiedHunkHeader('+++ b/f.js')).toBe(null);
    expect(dl.parseUnifiedHunkHeader(' context')).toBe(null);
    expect(dl.parseUnifiedHunkHeader('@@ malformed')).toBe(null);
  });

  test('非字符串 / null 不抛 → null', () => {
    expect(dl.parseUnifiedHunkHeader(null)).toBe(null);
    expect(dl.parseUnifiedHunkHeader(42)).toBe(null);
    expect(dl.parseUnifiedHunkHeader(undefined)).toBe(null);
  });
});
