'use strict';

const parseRetryAfterCooldown = require('../../src/utils/parseRetryAfterCooldown');

describe('parseRetryAfterCooldown', () => {
  const BASE = 10000;
  const MAX = 600000;

  test('returns base for falsy value', () => {
    expect(parseRetryAfterCooldown(null, BASE, MAX)).toBe(BASE);
    expect(parseRetryAfterCooldown('', BASE, MAX)).toBe(BASE);
    expect(parseRetryAfterCooldown(undefined, BASE, MAX)).toBe(BASE);
  });

  test('parses seconds', () => {
    expect(parseRetryAfterCooldown('30', BASE, MAX)).toBe(30000);
  });

  test('clamps to minimum', () => {
    expect(parseRetryAfterCooldown('1', BASE, MAX)).toBe(BASE);
  });

  test('clamps to maximum', () => {
    expect(parseRetryAfterCooldown('1000', BASE, MAX)).toBe(MAX);
  });

  test('parses HTTP-date', () => {
    const future = new Date(Date.now() + 30000).toUTCString();
    const result = parseRetryAfterCooldown(future, BASE, MAX);
    expect(result).toBeGreaterThanOrEqual(BASE);
    expect(result).toBeLessThanOrEqual(MAX);
  });

  test('returns base for invalid date', () => {
    expect(parseRetryAfterCooldown('not-a-date', BASE, MAX)).toBe(BASE);
  });
});
