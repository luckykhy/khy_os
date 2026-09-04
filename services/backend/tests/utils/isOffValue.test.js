'use strict';

const isOffValue = require('../../src/utils/isOffValue');

describe('isOffValue', () => {
  test('returns true for off values', () => {
    expect(isOffValue('')).toBe(true);
    expect(isOffValue('0')).toBe(true);
    expect(isOffValue('false')).toBe(true);
    expect(isOffValue('off')).toBe(true);
    expect(isOffValue('no')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(isOffValue('FALSE')).toBe(true);
    expect(isOffValue('OFF')).toBe(true);
    expect(isOffValue('NO')).toBe(true);
  });

  test('trims whitespace', () => {
    expect(isOffValue('  false  ')).toBe(true);
  });

  test('returns false for on values', () => {
    expect(isOffValue('1')).toBe(false);
    expect(isOffValue('true')).toBe(false);
    expect(isOffValue('on')).toBe(false);
    expect(isOffValue('yes')).toBe(false);
  });

  test('handles null/undefined', () => {
    expect(isOffValue(null)).toBe(true);
    expect(isOffValue(undefined)).toBe(true);
  });
});
