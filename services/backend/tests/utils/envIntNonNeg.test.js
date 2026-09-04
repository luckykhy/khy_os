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

  test('returns parsed non-negative integer', () => {
    process.env.TEST_VAR = '42';
    expect(envIntNonNeg('TEST_VAR', 0)).toBe(42);
  });

  test('returns default for negative', () => {
    process.env.TEST_VAR = '-5';
    expect(envIntNonNeg('TEST_VAR', 10)).toBe(10);
  });

  test('returns default for NaN', () => {
    process.env.TEST_VAR = 'abc';
    expect(envIntNonNeg('TEST_VAR', 5)).toBe(5);
  });

  test('returns default for unset', () => {
    delete process.env.TEST_VAR;
    expect(envIntNonNeg('TEST_VAR', 10)).toBe(10);
  });

  test('handles zero', () => {
    process.env.TEST_VAR = '0';
    expect(envIntNonNeg('TEST_VAR', 10)).toBe(0);
  });
});
