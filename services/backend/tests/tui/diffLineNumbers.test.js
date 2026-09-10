'use strict';
/**
 * diffLineNumbers — ±diff 行号化纯叶子单测。
 *
 * 验证:① 门控 KHY_DIFF_LINE_NUMBERS 字节回退口径;
 *      ② unified-diff hunk 头 `@@ -a,b +c,d @@` 解析(含无长度、带尾随上下文、非头、畸形)。
 */
const dl = require('../../src/cli/diffLineNumbers');
describe('diffLineNumbersEnabled — 门控 KHY_DIFF_LINE_NUMBERS', () => {
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
  }
});
describe('parseUnifiedHunkHeader — `@@ -a,b +c,d @@`', () => {

describe('Diff Line Numbers', () => {
  test('未设(默认)→ 开', () => {
        expect(dl.diffLineNumbersEnabled({})).toBe(true);
  });

  test('=${off} → 关', () => {
          expect(dl.diffLineNumbersEnabled({ KHY_DIFF_LINE_NUMBERS: off })).toBe(false);
  });

  test('=1 / 任意其他真值 → 开', () => {
        expect(dl.diffLineNumbersEnabled({ KHY_DIFF_LINE_NUMBERS: '1' })).toBe(true);
        expect(dl.diffLineNumbersEnabled({ KHY_DIFF_LINE_NUMBERS: 'yes' })).toBe(true);
  });

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

});
