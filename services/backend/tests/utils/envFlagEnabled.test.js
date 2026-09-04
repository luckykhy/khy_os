'use strict';

const envFlagEnabled = require('../../src/utils/envFlagEnabled');

describe('envFlagEnabled', () => {
  test('returns true for truthy values', () => {
    expect(envFlagEnabled('1')).toBe(true);
    expect(envFlagEnabled('true')).toBe(true);
    expect(envFlagEnabled('on')).toBe(true);
    expect(envFlagEnabled('yes')).toBe(true);
    expect(envFlagEnabled('y')).toBe(true);
  });

  test('returns false for falsy values', () => {
    expect(envFlagEnabled('0')).toBe(false);
    expect(envFlagEnabled('false')).toBe(false);
    expect(envFlagEnabled('off')).toBe(false);
    expect(envFlagEnabled('no')).toBe(false);
    expect(envFlagEnabled('n')).toBe(false);
  });

  test('returns default for empty/null/undefined', () => {
    expect(envFlagEnabled('', true)).toBe(true);
    expect(envFlagEnabled(null, true)).toBe(true);
    expect(envFlagEnabled(undefined, true)).toBe(true);
    expect(envFlagEnabled('', false)).toBe(false);
  });

  test('returns default for unknown values', () => {
    expect(envFlagEnabled('maybe', true)).toBe(true);
    expect(envFlagEnabled('maybe', false)).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(envFlagEnabled('TRUE')).toBe(true);
    expect(envFlagEnabled('FALSE')).toBe(false);
  });
});
