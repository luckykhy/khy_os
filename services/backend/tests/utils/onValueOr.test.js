'use strict';

const onValueOr = require('../../src/utils/onValueOr');

describe('onValueOr', () => {
  test('returns default for null/undefined/empty', () => {
    expect(onValueOr(null)).toBe(true);
    expect(onValueOr(undefined)).toBe(true);
    expect(onValueOr('')).toBe(true);
    expect(onValueOr(null, false)).toBe(false);
  });

  test('returns false for off values', () => {
    expect(onValueOr('0')).toBe(false);
    expect(onValueOr('false')).toBe(false);
    expect(onValueOr('off')).toBe(false);
    expect(onValueOr('no')).toBe(false);
  });

  test('returns true for other values', () => {
    expect(onValueOr('1')).toBe(true);
    expect(onValueOr('true')).toBe(true);
    expect(onValueOr('on')).toBe(true);
    expect(onValueOr('yes')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(onValueOr('FALSE')).toBe(false);
    expect(onValueOr('OFF')).toBe(false);
  });

  test('trims whitespace', () => {
    expect(onValueOr('  false  ')).toBe(false);
  });
});
