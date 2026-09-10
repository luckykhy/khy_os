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

  test('returns true when env var is not set (default ON)', () => {
    delete process.env.TEST_ON;
    expect(envOnByName({}, 'TEST_ON')).toBe(true);
  });

  test('returns true for undefined value', () => {
    expect(envOnByName({ TEST_ON: undefined }, 'TEST_ON')).toBe(true);
  });

  test('returns false for "0"', () => {
    expect(envOnByName({ TEST_ON: '0' }, 'TEST_ON')).toBe(false);
  });

  test('returns false for "false"', () => {
    expect(envOnByName({ TEST_ON: 'false' }, 'TEST_ON')).toBe(false);
  });

  test('returns false for "off"', () => {
    expect(envOnByName({ TEST_ON: 'off' }, 'TEST_ON')).toBe(false);
  });

  test('returns true for "OFF" (case-sensitive, no trim)', () => {
    expect(envOnByName({ TEST_ON: 'OFF' }, 'TEST_ON')).toBe(true);
  });

  test('returns true for " off " (case-sensitive, no trim)', () => {
    expect(envOnByName({ TEST_ON: ' off ' }, 'TEST_ON')).toBe(true);
  });

  test('returns true for "no" (not in off-set)', () => {
    expect(envOnByName({ TEST_ON: 'no' }, 'TEST_ON')).toBe(true);
  });

  test('returns true for "1"', () => {
    expect(envOnByName({ TEST_ON: '1' }, 'TEST_ON')).toBe(true);
  });

  test('returns true for "true"', () => {
    expect(envOnByName({ TEST_ON: 'true' }, 'TEST_ON')).toBe(true);
  });

  test('returns true for empty string', () => {
    expect(envOnByName({ TEST_ON: '' }, 'TEST_ON')).toBe(true);
  });

  test('returns true for unknown values', () => {
    expect(envOnByName({ TEST_ON: 'maybe' }, 'TEST_ON')).toBe(true);
  });

  test('falls back to process.env when env arg is null', () => {
    process.env.TEST_ON = '0';
    expect(envOnByName(null, 'TEST_ON')).toBe(false);
  });

  test('falls back to process.env when env arg is undefined', () => {
    process.env.TEST_ON = '0';
    expect(envOnByName(undefined, 'TEST_ON')).toBe(false);
  });

  test('returns true for missing key even with other keys present', () => {
    expect(envOnByName({ OTHER: '0' }, 'TEST_ON')).toBe(true);
  });
});
