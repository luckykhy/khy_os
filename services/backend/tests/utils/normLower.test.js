'use strict';

const normLower = require('../../src/utils/normLower');

describe('normLower', () => {
  test('converts to lowercase', () => {
    expect(normLower('HELLO')).toBe('hello');
  });

  test('trims whitespace', () => {
    expect(normLower('  hello  ')).toBe('hello');
  });

  test('handles null', () => {
    expect(normLower(null)).toBe('');
  });

  test('handles undefined', () => {
    expect(normLower(undefined)).toBe('');
  });

  test('handles empty string', () => {
    expect(normLower('')).toBe('');
  });

  test('handles non-string', () => {
    expect(normLower(123)).toBe('123');
  });

  test('handles object with throwing toString', () => {
    const obj = { toString() { throw new Error('fail'); } };
    expect(normLower(obj)).toBe('');
  });
});
