'use strict';

const parseBoolean = require('../../src/utils/parseBoolean');

describe('parseBoolean', () => {
  test('returns true for truthy values', () => {
    expect(parseBoolean('1')).toBe(true);
    expect(parseBoolean('true')).toBe(true);
    expect(parseBoolean('yes')).toBe(true);
    expect(parseBoolean('on')).toBe(true);
    expect(parseBoolean('y')).toBe(true);
  });

  test('returns false for falsy values', () => {
    expect(parseBoolean('0')).toBe(false);
    expect(parseBoolean('false')).toBe(false);
    expect(parseBoolean('no')).toBe(false);
    expect(parseBoolean('off')).toBe(false);
    expect(parseBoolean('n')).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(parseBoolean('TRUE')).toBe(true);
    expect(parseBoolean('False')).toBe(false);
    expect(parseBoolean('YES')).toBe(true);
  });

  test('trims whitespace', () => {
    expect(parseBoolean('  true  ')).toBe(true);
  });

  test('returns fallback for unrecognized', () => {
    expect(parseBoolean('maybe', false)).toBe(false);
    expect(parseBoolean('maybe', true)).toBe(true);
  });

  test('returns fallback for null/undefined/empty', () => {
    expect(parseBoolean(null, true)).toBe(true);
    expect(parseBoolean(undefined, true)).toBe(true);
    expect(parseBoolean('', true)).toBe(true);
  });

  test('passes through boolean', () => {
    expect(parseBoolean(true)).toBe(true);
    expect(parseBoolean(false)).toBe(false);
  });

  test('extended=false rejects y/n', () => {
    expect(parseBoolean('y', false, { extended: false })).toBe(false);
    expect(parseBoolean('n', true, { extended: false })).toBe(true);
  });
});
