'use strict';

const isPlainObject = require('../../src/utils/isPlainObject');

describe('isPlainObject', () => {
  test('returns true for plain object', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  test('returns false for null', () => {
    expect(isPlainObject(null)).toBe(false);
  });

  test('returns false for array', () => {
    expect(isPlainObject([1, 2, 3])).toBe(false);
  });

  test('returns false for primitive', () => {
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject('string')).toBe(false);
    expect(isPlainObject(true)).toBe(false);
  });

  test('returns true for Date/RegExp (non-array objects)', () => {
    expect(isPlainObject(new Date())).toBe(true);
    expect(isPlainObject(/test/)).toBe(true);
  });
});
