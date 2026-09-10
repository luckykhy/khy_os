'use strict';

const envIntNonNeg = require('../../src/utils/envIntNonNeg');

describe('envIntNonNeg', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns env value when valid non-negative integer', () => {
    process.env.TEST_INT = '42';
    expect(envIntNonNeg('TEST_INT', 10)).toBe(42);
  });

  test('returns default when env not set', () => {
    delete process.env.TEST_INT;
    expect(envIntNonNeg('TEST_INT', 10)).toBe(10);
  });

  test('returns default for negative value', () => {
    process.env.TEST_INT = '-5';
    expect(envIntNonNeg('TEST_INT', 10)).toBe(10);
  });

  test('returns default for NaN', () => {
    process.env.TEST_INT = 'abc';
    expect(envIntNonNeg('TEST_INT', 10)).toBe(10);
  });

  test('returns 0 when env is "0"', () => {
    process.env.TEST_INT = '0';
    expect(envIntNonNeg('TEST_INT', 10)).toBe(0);
  });

  test('returns default for empty string', () => {
    process.env.TEST_INT = '';
    expect(envIntNonNeg('TEST_INT', 10)).toBe(10);
  });

  test('returns default for whitespace', () => {
    process.env.TEST_INT = '   ';
    expect(envIntNonNeg('TEST_INT', 10)).toBe(10);
  });

  test('trims whitespace before parsing', () => {
    process.env.TEST_INT = '  42  ';
    expect(envIntNonNeg('TEST_INT', 10)).toBe(42);
  });

  test('handles float string by parsing integer part', () => {
    process.env.TEST_INT = '3.14';
    expect(envIntNonNeg('TEST_INT', 10)).toBe(3);
  });

  test('returns default for null env value', () => {
    process.env.TEST_INT = undefined;
    expect(envIntNonNeg('TEST_INT', 5)).toBe(5);
  });

  test('handles very large number', () => {
    process.env.TEST_INT = '999999';
    expect(envIntNonNeg('TEST_INT', 10)).toBe(999999);
  });
});
