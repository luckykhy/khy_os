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

  test('returns true for "1"', () => {
    process.env.TEST_FLAG = '1';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
  });

  test('returns true for "true"', () => {
    process.env.TEST_FLAG = 'true';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
  });

  test('returns true for "yes"', () => {
    process.env.TEST_FLAG = 'yes';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
  });

  test('returns true for "on"', () => {
    process.env.TEST_FLAG = 'on';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
  });

  test('returns true for "enabled"', () => {
    process.env.TEST_FLAG = 'enabled';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
  });

  test('returns false for "0"', () => {
    process.env.TEST_FLAG = '0';
    expect(envFlagByName('TEST_FLAG')).toBe(false);
  });

  test('returns false for "false"', () => {
    process.env.TEST_FLAG = 'false';
    expect(envFlagByName('TEST_FLAG')).toBe(false);
  });

  test('returns false for "off"', () => {
    process.env.TEST_FLAG = 'off';
    expect(envFlagByName('TEST_FLAG')).toBe(false);
  });

  test('returns false for "no"', () => {
    process.env.TEST_FLAG = 'no';
    expect(envFlagByName('TEST_FLAG')).toBe(false);
  });

  test('returns false for unknown value', () => {
    process.env.TEST_FLAG = 'maybe';
    expect(envFlagByName('TEST_FLAG')).toBe(false);
  });

  test('returns fallback when env not set', () => {
    delete process.env.TEST_FLAG;
    expect(envFlagByName('TEST_FLAG')).toBe(false);
    expect(envFlagByName('TEST_FLAG', true)).toBe(true);
  });

  test('returns fallback when env is null', () => {
    process.env.TEST_FLAG = undefined;
    expect(envFlagByName('TEST_FLAG', true)).toBe(true);
  });

  test('returns fallback for empty string', () => {
    process.env.TEST_FLAG = '';
    expect(envFlagByName('TEST_FLAG', true)).toBe(true);
  });

  test('returns fallback for whitespace-only string', () => {
    process.env.TEST_FLAG = '   ';
    expect(envFlagByName('TEST_FLAG', true)).toBe(true);
  });

  test('case insensitive', () => {
    process.env.TEST_FLAG = 'TRUE';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = 'FALSE';
    expect(envFlagByName('TEST_FLAG')).toBe(false);
  });

  test('trims whitespace', () => {
    process.env.TEST_FLAG = '  true  ';
    expect(envFlagByName('TEST_FLAG')).toBe(true);
  });

  test('default fallback is false', () => {
    delete process.env.TEST_FLAG;
    expect(envFlagByName('TEST_FLAG')).toBe(false);
  });
});
