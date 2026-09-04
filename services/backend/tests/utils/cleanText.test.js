'use strict';

const cleanText = require('../../src/utils/cleanText');

describe('cleanText', () => {
  test('trims whitespace', () => {
    expect(cleanText('  hello  ')).toBe('hello');
  });

  test('converts non-string to string', () => {
    expect(cleanText(123)).toBe('123');
  });

  test('handles null', () => {
    expect(cleanText(null)).toBe('');
  });

  test('handles undefined', () => {
    expect(cleanText(undefined)).toBe('');
  });

  test('handles empty string', () => {
    expect(cleanText('')).toBe('');
  });

  test('handles string with only whitespace', () => {
    expect(cleanText('   ')).toBe('');
  });
});
