'use strict';

const escapeRegExp = require('../../src/utils/escapeRegExp');

describe('escapeRegExp', () => {
  test('escapes special regex characters', () => {
    expect(escapeRegExp('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  });

  test('handles normal string', () => {
    expect(escapeRegExp('hello')).toBe('hello');
  });

  test('handles empty string', () => {
    expect(escapeRegExp('')).toBe('');
  });

  test('converts non-string to string', () => {
    expect(escapeRegExp(123)).toBe('123');
  });

  test('handles null', () => {
    expect(escapeRegExp(null)).toBe('null');
  });

  test('handles undefined', () => {
    expect(escapeRegExp(undefined)).toBe('undefined');
  });
});
