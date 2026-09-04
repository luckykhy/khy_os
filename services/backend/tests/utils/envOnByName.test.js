'use strict';

const envOnByName = require('../../src/utils/envOnByName');

describe('envOnByName', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns true when env is undefined (default on)', () => {
    delete process.env.TEST_FLAG;
    expect(envOnByName(process.env, 'TEST_FLAG')).toBe(true);
  });

  test('returns false for off values', () => {
    process.env.TEST_FLAG = '0';
    expect(envOnByName(process.env, 'TEST_FLAG')).toBe(false);
    process.env.TEST_FLAG = 'false';
    expect(envOnByName(process.env, 'TEST_FLAG')).toBe(false);
    process.env.TEST_FLAG = 'off';
    expect(envOnByName(process.env, 'TEST_FLAG')).toBe(false);
  });

  test('returns true for other values', () => {
    process.env.TEST_FLAG = '1';
    expect(envOnByName(process.env, 'TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = 'true';
    expect(envOnByName(process.env, 'TEST_FLAG')).toBe(true);
  });

  test('is case-sensitive (OFF is not off)', () => {
    process.env.TEST_FLAG = 'OFF';
    expect(envOnByName(process.env, 'TEST_FLAG')).toBe(true);
  });

  test('does not trim', () => {
    process.env.TEST_FLAG = ' off ';
    expect(envOnByName(process.env, 'TEST_FLAG')).toBe(true);
  });
});
