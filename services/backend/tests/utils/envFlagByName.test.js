'use strict';

const envFlagByName = require('../../src/utils/envFlagByName');

describe('envFlagByName', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns true for truthy values', () => {
    process.env.TEST_FLAG = '1';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = 'true';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = 'yes';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = 'on';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = 'enabled';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
  });

  test('returns false for falsy values', () => {
    process.env.TEST_FLAG = '0';
    expect(envFlagByName('TEST_FLAG')).toBe(false);
    process.env.TEST_FLAG = 'false';
    expect(envFlagByName('TEST_FLAG')).toBe(false);
    process.env.TEST_FLAG = 'no';
    expect(envFlagByName('TEST_FLAG')).toBe(false);
    process.env.TEST_FLAG = 'off';
    expect(envFlagByName('TEST_FLAG')).toBe(false);
  });

  test('returns fallback for unset', () => {
    delete process.env.TEST_FLAG;
    expect(envFlagByName('TEST_FLAG')).toBe(false);
    expect(envFlagByName('TEST_FLAG', true)).toBe(true);
  });

  test('returns fallback for empty string', () => {
    process.env.TEST_FLAG = '';
    expect(envFlagByName('TEST_FLAG', true)).toBe(true);
  });

  test('returns false for unknown values', () => {
    process.env.TEST_FLAG = 'maybe';
    expect(envFlagByName('TEST_FLAG', true)).toBe(false);
  });
});
