'use strict';

const {
  diffFullWidthEnabled,
  diffRowPadCount,
  diffRowPadSpaces,
} = require('../../src/cli/diffFullWidth');

describe('diffFullWidth', () => {
  describe('diffFullWidthEnabled', () => {
    test('returns true by default', () => {
      expect(diffFullWidthEnabled({})).toBe(true);
    });

    test('returns true when env var is not set', () => {
      expect(diffFullWidthEnabled({})).toBe(true);
    });

    test('returns true for empty string', () => {
      expect(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: '' })).toBe(true);
    });

    test('returns false for "0"', () => {
      expect(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: '0' })).toBe(false);
    });

    test('returns false for "false"', () => {
      expect(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: 'false' })).toBe(false);
    });

    test('returns false for "off"', () => {
      expect(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: 'off' })).toBe(false);
    });

    test('returns false for "no"', () => {
      expect(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: 'no' })).toBe(false);
    });

    test('returns true for "1"', () => {
      expect(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: '1' })).toBe(true);
    });

    test('returns true for "true"', () => {
      expect(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: 'true' })).toBe(true);
    });

    test('is case-insensitive', () => {
      expect(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: 'FALSE' })).toBe(false);
      expect(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: 'OFF' })).toBe(false);
    });

    test('trims whitespace', () => {
      expect(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: '  false  ' })).toBe(false);
    });
  });

  describe('diffRowPadCount', () => {
    test('returns positive difference', () => {
      expect(diffRowPadCount(10, 80)).toBe(70);
    });

    test('returns 0 when used equals total', () => {
      expect(diffRowPadCount(80, 80)).toBe(0);
    });

    test('returns 0 when used exceeds total', () => {
      expect(diffRowPadCount(90, 80)).toBe(0);
    });

    test('handles decimals by flooring', () => {
      expect(diffRowPadCount(10.5, 80.7)).toBe(70);
    });

    test('returns 0 for NaN inputs', () => {
      expect(diffRowPadCount(NaN, 80)).toBe(0);
      expect(diffRowPadCount(10, NaN)).toBe(0);
    });

    test('returns 0 for Infinity', () => {
      expect(diffRowPadCount(Infinity, 80)).toBe(0);
      expect(diffRowPadCount(10, Infinity)).toBe(10);
    });

    test('returns 0 for -Infinity', () => {
      expect(diffRowPadCount(-Infinity, 80)).toBe(0);
    });

    test('returns 0 when both are NaN', () => {
      expect(diffRowPadCount(NaN, NaN)).toBe(0);
    });

    test('coerces string numbers', () => {
      expect(diffRowPadCount('10', '80')).toBe(70);
    });

    test('returns 0 for non-numeric strings', () => {
      expect(diffRowPadCount('abc', 'def')).toBe(0);
    });
  });

  describe('diffRowPadSpaces', () => {
    test('returns spaces when enabled', () => {
      expect(diffRowPadSpaces(10, 15, {})).toBe('     ');
    });

    test('returns empty string when disabled', () => {
      expect(diffRowPadSpaces(10, 15, { KHY_DIFF_FULL_WIDTH: 'false' })).toBe('');
    });

    test('returns empty string when no padding needed', () => {
      expect(diffRowPadSpaces(80, 80, {})).toBe('');
    });

    test('returns empty string when used exceeds total', () => {
      expect(diffRowPadSpaces(90, 80, {})).toBe('');
    });

    test('returns correct number of spaces', () => {
      expect(diffRowPadSpaces(5, 10, {}).length).toBe(5);
    });

    test('handles zero used width', () => {
      expect(diffRowPadSpaces(0, 10, {}).length).toBe(10);
    });
  });
});
