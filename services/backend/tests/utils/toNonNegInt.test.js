'use strict';

const toNonNegInt = require('../../src/utils/toNonNegInt');

describe('toNonNegInt', () => {
  test('returns positive integer', () => {
    expect(toNonNegInt(5)).toBe(5);
  });

  test('floors float down', () => {
    expect(toNonNegInt(5.9)).toBe(5);
  });

  test('returns 0 for zero', () => {
    expect(toNonNegInt(0)).toBe(0);
  });

  test('returns 0 for negative number', () => {
    expect(toNonNegInt(-5)).toBe(0);
  });

  test('returns 0 for NaN', () => {
    expect(toNonNegInt(NaN)).toBe(0);
  });

  test('returns 0 for Infinity', () => {
    expect(toNonNegInt(Infinity)).toBe(0);
  });

  test('returns 0 for negative Infinity', () => {
    expect(toNonNegInt(-Infinity)).toBe(0);
  });

  test('parses numeric string', () => {
    expect(toNonNegInt('42')).toBe(42);
  });

  test('returns 0 for non-numeric string', () => {
    expect(toNonNegInt('abc')).toBe(0);
  });

  test('returns 0 for empty string', () => {
    expect(toNonNegInt('')).toBe(0);
  });

  test('returns 0 for null', () => {
    expect(toNonNegInt(null)).toBe(0);
  });

  test('returns 0 for undefined', () => {
    expect(toNonNegInt(undefined)).toBe(0);
  });

  test('Number(true) is 1, so returns 1', () => {
    expect(toNonNegInt(true)).toBe(1);
  });

  test('Number(false) is 0, so returns 0', () => {
    expect(toNonNegInt(false)).toBe(0);
  });

  test('handles very large number', () => {
    expect(toNonNegInt(999999999)).toBe(999999999);
  });

  test('handles float string', () => {
    expect(toNonNegInt('3.14')).toBe(3);
  });
});
