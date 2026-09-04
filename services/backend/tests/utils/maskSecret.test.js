'use strict';

const maskSecret = require('../../src/utils/maskSecret');

describe('maskSecret', () => {
  test('returns empty string for empty input', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret(null)).toBe('');
    expect(maskSecret(undefined)).toBe('');
  });

  test('masks short secrets (<=8 chars)', () => {
    expect(maskSecret('12345678')).toBe('12****');
    expect(maskSecret('1234567')).toBe('12****');
    expect(maskSecret('12')).toBe('12****');
  });

  test('masks long secrets (>8 chars)', () => {
    expect(maskSecret('1234567890')).toBe('1234...90');
    expect(maskSecret('abcdefghijklmnop')).toBe('abcd...op');
  });

  test('trims whitespace', () => {
    expect(maskSecret('  1234567890  ')).toBe('1234...90');
  });
});
