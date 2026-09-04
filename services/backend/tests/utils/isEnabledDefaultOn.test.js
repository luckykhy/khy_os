'use strict';

const isEnabledDefaultOn = require('../../src/utils/isEnabledDefaultOn');

describe('isEnabledDefaultOn', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns true when env is not set (default on)', () => {
    delete process.env.TEST_FLAG;
    expect(isEnabledDefaultOn('TEST_FLAG')).toBe(true);
  });

  test('returns false for off values', () => {
    process.env.TEST_FLAG = '0';
    expect(isEnabledDefaultOn('TEST_FLAG')).toBe(false);
    process.env.TEST_FLAG = 'false';
    expect(isEnabledDefaultOn('TEST_FLAG')).toBe(false);
    process.env.TEST_FLAG = 'off';
    expect(isEnabledDefaultOn('TEST_FLAG')).toBe(false);
    process.env.TEST_FLAG = 'no';
    expect(isEnabledDefaultOn('TEST_FLAG')).toBe(false);
  });

  test('returns true for other values', () => {
    process.env.TEST_FLAG = '1';
    expect(isEnabledDefaultOn('TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = 'true';
    expect(isEnabledDefaultOn('TEST_FLAG')).toBe(true);
  });

  test('is case-insensitive', () => {
    process.env.TEST_FLAG = 'FALSE';
    expect(isEnabledDefaultOn('TEST_FLAG')).toBe(false);
  });
});
