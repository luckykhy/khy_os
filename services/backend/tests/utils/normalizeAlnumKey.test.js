'use strict';

const normalizeAlnumKey = require('../../src/utils/normalizeAlnumKey');

describe('normalizeAlnumKey', () => {
  test('converts to lowercase', () => {
    expect(normalizeAlnumKey('HELLO')).toBe('hello');
  });

  test('removes non-alphanumeric characters', () => {
    expect(normalizeAlnumKey('hello-world')).toBe('helloworld');
    expect(normalizeAlnumKey('test_123')).toBe('test123');
    expect(normalizeAlnumKey('a.b.c')).toBe('abc');
  });

  test('handles empty string', () => {
    expect(normalizeAlnumKey('')).toBe('');
  });

  test('handles null/undefined', () => {
    expect(normalizeAlnumKey(null)).toBe('');
    expect(normalizeAlnumKey(undefined)).toBe('');
  });

  test('preserves numbers', () => {
    expect(normalizeAlnumKey('test123')).toBe('test123');
  });
});
