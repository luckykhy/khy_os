'use strict';

const trimIfString = require('../../src/utils/trimIfString');

describe('trimIfString', () => {
  test('trims string', () => {
    expect(trimIfString('  hello  ')).toBe('hello');
  });

  test('returns empty string for number', () => {
    expect(trimIfString(42)).toBe('');
  });

  test('returns empty string for null', () => {
    expect(trimIfString(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(trimIfString(undefined)).toBe('');
  });

  test('returns empty string for object', () => {
    expect(trimIfString({})).toBe('');
  });

  test('returns empty string for array', () => {
    expect(trimIfString([])).toBe('');
  });

  test('returns empty string for boolean', () => {
    expect(trimIfString(true)).toBe('');
  });
});
