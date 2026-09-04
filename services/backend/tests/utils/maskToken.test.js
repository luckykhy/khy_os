'use strict';

const maskToken = require('../../src/utils/maskToken');

describe('maskToken', () => {
  test('returns (empty) for empty input', () => {
    expect(maskToken('')).toBe('(empty)');
    expect(maskToken(null)).toBe('(empty)');
    expect(maskToken(undefined)).toBe('(empty)');
  });

  test('masks short tokens (<=10 chars)', () => {
    expect(maskToken('1234567890')).toBe('123***');
    expect(maskToken('123456789')).toBe('123***');
    expect(maskToken('123')).toBe('123***');
  });

  test('masks long tokens (>10 chars)', () => {
    expect(maskToken('12345678901')).toBe('123456***01');
    expect(maskToken('abcdefghijklmnop')).toBe('abcdef***mnop');
  });

  test('trims whitespace', () => {
    expect(maskToken('  12345678901  ')).toBe('123456***01');
  });
});
