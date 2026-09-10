'use strict';

const { fenceLangCharsetEnabled, fenceOpenRegex, RE_WIDE, RE_LEGACY } = require('../../src/cli/fenceLangCharset');

describe('fenceLangCharset', () => {
  describe('fenceLangCharsetEnabled', () => {
    test('returns true by default', () => {
      expect(fenceLangCharsetEnabled({})).toBe(true);
    });

    test('returns false for off values', () => {
      expect(fenceLangCharsetEnabled({ KHY_FENCE_LANG_CHARSET: '0' })).toBe(false);
    });
  });

  describe('fenceOpenRegex', () => {
    test('returns RE_WIDE when enabled', () => {
      expect(fenceOpenRegex({})).toBe(RE_WIDE);
    });

    test('returns RE_LEGACY when disabled', () => {
      expect(fenceOpenRegex({ KHY_FENCE_LANG_CHARSET: '0' })).toBe(RE_LEGACY);
    });
  });

  describe('regex behavior', () => {
    test('RE_WIDE matches csharp fence', () => {
      expect(RE_WIDE.test('```c#')).toBe(true);
    });

    test('RE_WIDE matches dot net fence', () => {
      expect(RE_WIDE.test('```asp.net')).toBe(true);
    });

    test('RE_LEGACY does not match csharp', () => {
      expect(RE_LEGACY.test('```c#')).toBe(false);
    });
  });
});
