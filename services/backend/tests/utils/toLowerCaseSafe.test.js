'use strict';

const toLowerCaseSafe = require('../../src/utils/toLowerCaseSafe');

describe('toLowerCaseSafe', () => {
  test('converts to lowercase', () => {
    expect(toLowerCaseSafe('HELLO')).toBe('hello');
  });

  test('handles mixed case', () => {
    expect(toLowerCaseSafe('HeLLo WoRLd')).toBe('hello world');
  });

  test('handles null', () => {
    expect(toLowerCaseSafe(null)).toBe('');
  });

  test('handles undefined', () => {
    expect(toLowerCaseSafe(undefined)).toBe('');
  });

  test('handles empty string', () => {
    expect(toLowerCaseSafe('')).toBe('');
  });

  test('handles non-string', () => {
    expect(toLowerCaseSafe(123)).toBe('123');
  });
});
