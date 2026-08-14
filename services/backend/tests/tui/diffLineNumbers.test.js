'use strict';

/**
 * diffLineNumbers — ±diff 行号化纯叶子单测。
 *
 * 验证:① 门控 KHY_DIFF_LINE_NUMBERS 字节回退口径;
 *      ② unified-diff hunk 头 `@@ -a,b +c,d @@` 解析(含无长度、带尾随上下文、非头、畸形)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const dl = require('../../src/cli/diffLineNumbers');

describe('diffLineNumbersEnabled — 门控 KHY_DIFF_LINE_NUMBERS', () => {
  test('未设(默认)→ 开', () => {
    assert.equal(dl.diffLineNumbersEnabled({}), true);
  });
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    test(`=${off} → 关`, () => {
      assert.equal(dl.diffLineNumbersEnabled({ KHY_DIFF_LINE_NUMBERS: off }), false);
    });
  }
  test('=1 / 任意其他真值 → 开', () => {
    assert.equal(dl.diffLineNumbersEnabled({ KHY_DIFF_LINE_NUMBERS: '1' }), true);
    assert.equal(dl.diffLineNumbersEnabled({ KHY_DIFF_LINE_NUMBERS: 'yes' }), true);
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
    assert.equal(dl.parseUnifiedHunkHeader('+++ b/f.js'), null);
    assert.equal(dl.parseUnifiedHunkHeader(' context'), null);
    assert.equal(dl.parseUnifiedHunkHeader('@@ malformed'), null);
  });
  test('非字符串 / null 不抛 → null', () => {
    assert.equal(dl.parseUnifiedHunkHeader(null), null);
    assert.equal(dl.parseUnifiedHunkHeader(42), null);
    assert.equal(dl.parseUnifiedHunkHeader(undefined), null);
  });
});
