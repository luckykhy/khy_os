'use strict';

const parseRetryAfterCooldown = require('../../src/utils/parseRetryAfterCooldown');

describe('parseRetryAfterCooldown', () => {
  const BASE = 10000;
  const MAX = 600000;

  describe('falsy values', () => {
    test('null returns base', () => {
      expect(parseRetryAfterCooldown(null)).toBe(BASE);
    });

    test('undefined returns base', () => {
      expect(parseRetryAfterCooldown(undefined)).toBe(BASE);
    });

    test('empty string returns base', () => {
      expect(parseRetryAfterCooldown('')).toBe(BASE);
    });

    test('0 returns base', () => {
      expect(parseRetryAfterCooldown(0)).toBe(BASE);
    });

    test('false returns base', () => {
      expect(parseRetryAfterCooldown(false)).toBe(BASE);
    });
  });

  describe('numeric seconds', () => {
    test('positive integer seconds clamped to base when below', () => {
      expect(parseRetryAfterCooldown('5')).toBe(BASE);
    });

    test('seconds within range returned as milliseconds', () => {
      expect(parseRetryAfterCooldown('30')).toBe(30000);
    });

    test('seconds exceeding max clamped to max', () => {
      expect(parseRetryAfterCooldown('10000')).toBe(MAX);
    });

    test('numeric value 1 returns base (1000ms < base)', () => {
      expect(parseRetryAfterCooldown(1)).toBe(BASE);
    });

    test('numeric value 120 returns 120000ms', () => {
      expect(parseRetryAfterCooldown(120)).toBe(120000);
    });

    test('float seconds floored via multiplication', () => {
      expect(parseRetryAfterCooldown('10.5')).toBe(10500);
    });

    test('negative number returns base', () => {
      expect(parseRetryAfterCooldown('-5')).toBe(BASE);
    });

    test('zero string returns base', () => {
      expect(parseRetryAfterCooldown('0')).toBe(BASE);
    });
  });

  describe('HTTP-date strings', () => {
    test('future HTTP-date returns clamped delta', () => {
      const future = new Date(Date.now() + 30000).toUTCString();
      const result = parseRetryAfterCooldown(future);
      expect(result).toBeGreaterThanOrEqual(BASE);
      expect(result).toBeLessThanOrEqual(MAX);
    });

    test('past HTTP-date returns base', () => {
      const past = new Date(Date.now() - 60000).toUTCString();
      expect(parseRetryAfterCooldown(past)).toBe(BASE);
    });

    test('very far future HTTP-date clamped to max', () => {
      const farFuture = new Date(Date.now() + 3600000).toUTCString();
      expect(parseRetryAfterCooldown(farFuture)).toBe(MAX);
    });
  });

  describe('invalid values', () => {
    test('non-numeric non-date string returns base', () => {
      expect(parseRetryAfterCooldown('invalid')).toBe(BASE);
    });

    test('object returns base', () => {
      expect(parseRetryAfterCooldown({})).toBe(BASE);
    });

    test('array returns base', () => {
      expect(parseRetryAfterCooldown([])).toBe(BASE);
    });
  });

  describe('custom base/max', () => {
    test('custom base used when value falsy', () => {
      expect(parseRetryAfterCooldown(null, 5000, 300000)).toBe(5000);
    });

    test('custom max clamps high value', () => {
      expect(parseRetryAfterCooldown('100', 5000, 30000)).toBe(30000);
    });

    test('custom base floors low value', () => {
      expect(parseRetryAfterCooldown('1', 5000, 300000)).toBe(5000);
    });
  });
});
