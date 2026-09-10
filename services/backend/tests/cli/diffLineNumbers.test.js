'use strict';

const { diffLineNumbersEnabled, parseUnifiedHunkHeader } = require('../../src/cli/diffLineNumbers');

describe('diffLineNumbers', () => {
  describe('diffLineNumbersEnabled', () => {
    test('returns true by default', () => {
      expect(diffLineNumbersEnabled({})).toBe(true);
    });

    test('returns false for off values', () => {
      expect(diffLineNumbersEnabled({ KHY_DIFF_LINE_NUMBERS: '0' })).toBe(false);
    });
  });

  describe('parseUnifiedHunkHeader', () => {
    test('parses basic hunk header', () => {
      const result = parseUnifiedHunkHeader('@@ -1,5 +1,5 @@');
      expect(result).toEqual({ oldStart: 1, newStart: 1 });
    });

    test('parses header without line counts', () => {
      const result = parseUnifiedHunkHeader('@@ -10 +20 @@');
      expect(result).toEqual({ oldStart: 10, newStart: 20 });
    });

    test('returns null for non-hunk lines', () => {
      expect(parseUnifiedHunkHeader('not a hunk')).toBe();
      expect(parseUnifiedHunkHeader('')).toBe();
    });

    test('returns null for non-string input', () => {
      expect(parseUnifiedHunkHeader(null)).toBe();
      expect(parseUnifiedHunkHeader(123)).toBe();
    });
  });
});
