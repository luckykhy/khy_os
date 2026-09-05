'use strict';

const {
  isEnabled,
  shouldContinue,
} = require('../../../src/services/backslashContinuation');

describe('backslashContinuation', () => {
  describe('isEnabled', () => {
    test('returns true by default', () => {
      expect(isEnabled({})).toBe(true);
    });

    test('returns false when disabled', () => {
      expect(isEnabled({ KHY_BACKSLASH_NEWLINE: '0' })).toBe(false);
      expect(isEnabled({ KHY_BACKSLASH_NEWLINE: 'false' })).toBe(false);
      expect(isEnabled({ KHY_BACKSLASH_NEWLINE: 'off' })).toBe(false);
      expect(isEnabled({ KHY_BACKSLASH_NEWLINE: 'no' })).toBe(false);
    });
  });

  describe('shouldContinue', () => {
    test('returns false when disabled', () => {
      expect(shouldContinue('text\\', 4, { KHY_BACKSLASH_NEWLINE: '0' })).toBe(false);
    });

    test('detects single trailing backslash', () => {
      expect(shouldContinue('text\\', 4, {})).toBe(true);
    });

    test('detects triple backslash (odd)', () => {
      expect(shouldContinue('text\\\\\\', 6, {})).toBe(true);
    });

    test('rejects double backslash (even)', () => {
      expect(shouldContinue('text\\\\', 5, {})).toBe(false);
    });

    test('returns false when cursor at start', () => {
      expect(shouldContinue('\\text', 0, {})).toBe(false);
    });

    test('returns false when char before cursor is not backslash', () => {
      expect(shouldContinue('text', 3, {})).toBe(false);
    });

    test('returns false for non-string input', () => {
      expect(shouldContinue(null, 0, {})).toBe(false);
    });

    test('handles offset beyond text length', () => {
      expect(shouldContinue('text\\', 100, {})).toBe(false);
    });
  });
});
