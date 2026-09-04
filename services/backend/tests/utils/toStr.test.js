'use strict';

const { toStr, toStrSafe } = require('../../src/utils/toStr');

describe('toStr', () => {
  test('returns empty string for null', () => {
    expect(toStr(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(toStr(undefined)).toBe('');
  });

  test('converts number to string', () => {
    expect(toStr(42)).toBe('42');
  });

  test('converts boolean to string', () => {
    expect(toStr(true)).toBe('true');
  });

  test('returns string as-is', () => {
    expect(toStr('hello')).toBe('hello');
  });
});

describe('toStrSafe', () => {
  test('returns empty string for null', () => {
    expect(toStrSafe(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(toStrSafe(undefined)).toBe('');
  });

  test('converts number to string', () => {
    expect(toStrSafe(42)).toBe('42');
  });

  test('handles object with throwing toString', () => {
    const obj = { toString() { throw new Error('fail'); } };
    expect(toStrSafe(obj)).toBe('');
  });
});
