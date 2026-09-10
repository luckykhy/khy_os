'use strict';

const cleanText = require('../../src/utils/cleanText');

describe('cleanText', () => {
  test('trims whitespace', () => {
    expect(cleanText('  hello  ')).toBe('hello');
  });

  test('handles null (returns empty string)', () => {
    expect(cleanText(null)).toBe('');
  });

  test('handles undefined (returns empty string)', () => {
    expect(cleanText(undefined)).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(cleanText('')).toBe('');
  });

  test('preserves inner whitespace', () => {
    expect(cleanText('hello world')).toBe('hello world');
  });

  test('coerces numbers to string', () => {
    expect(cleanText(123)).toBe('123');
  });

  test('coerces booleans to string', () => {
    expect(cleanText(true)).toBe('true');
    expect(cleanText(false)).toBe('false');
  });

  test('trims leading whitespace', () => {
    expect(cleanText('   hello')).toBe('hello');
  });

  test('trims trailing whitespace', () => {
    expect(cleanText('hello   ')).toBe('hello');
  });

  test('handles newlines and tabs', () => {
    expect(cleanText('\n\thello\n\t')).toBe('hello');
  });

  test('preserves string with no whitespace', () => {
    expect(cleanText('hello')).toBe('hello');
  });

  test('returns empty string for whitespace-only input', () => {
    expect(cleanText('   ')).toBe('');
  });

  test('handles object with toString', () => {
    expect(cleanText({ toString: () => 'custom' })).toBe('custom');
  });

  test('never throws', () => {
    expect(() => cleanText(null)).not.toThrow();
    expect(() => cleanText(undefined)).not.toThrow();
    expect(() => cleanText({})).not.toThrow();
  });
});
