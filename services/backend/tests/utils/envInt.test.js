'use strict';

const envInt = require('../../src/utils/envInt');

describe('envInt', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns parsed integer', () => {
    process.env.TEST_VAR = '42';
    expect(envInt('TEST_VAR', 0)).toBe(42);
  });

  test('returns default when env not set', () => {
    delete process.env.TEST_VAR;
    expect(envInt('TEST_VAR', 10)).toBe(10);
  });

  test('returns default when env is not a number', () => {
    process.env.TEST_VAR = 'abc';
    expect(envInt('TEST_VAR', 5)).toBe(5);
  });

  test('applies min bound', () => {
    process.env.TEST_VAR = '3';
    expect(envInt('TEST_VAR', 0, { min: 5 })).toBe(5);
  });

  test('applies max bound', () => {
    process.env.TEST_VAR = '100';
    expect(envInt('TEST_VAR', 0, { max: 50 })).toBe(50);
  });

  test('applies both bounds', () => {
    process.env.TEST_VAR = '100';
    expect(envInt('TEST_VAR', 0, { min: 10, max: 50 })).toBe(50);
  });
});
