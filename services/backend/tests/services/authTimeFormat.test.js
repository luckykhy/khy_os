'use strict';

const {
  isEnabled,
  formatAuthTimestamp,
  deriveSessionExpiry,
} = require('../../../src/services/authTimeFormat');

describe('authTimeFormat', () => {
  describe('isEnabled', () => {
    test('returns true by default', () => {
      expect(isEnabled({})).toBe(true);
    });

    test('returns false when disabled', () => {
      expect(isEnabled({ KHY_AUTH_DATE_SANE: '0' })).toBe(false);
    });
  });

  describe('formatAuthTimestamp', () => {
    test('formats valid ISO string', () => {
      const result = formatAuthTimestamp('2024-01-15T10:30:00.000Z');
      expect(result).toContain('2024');
      expect(result).not.toBe('未知');
    });

    test('formats Date object', () => {
      const result = formatAuthTimestamp(new Date('2024-01-15T10:30:00.000Z'));
      expect(result).toContain('2024');
    });

    test('formats timestamp', () => {
      const ts = Date.UTC(2024, 0, 15, 10, 30, 0);
      const result = formatAuthTimestamp(ts);
      expect(result).toContain('2024');
    });

    test('returns fallback for null', () => {
      expect(formatAuthTimestamp(null)).toBe('未知');
    });

    test('returns fallback for undefined', () => {
      expect(formatAuthTimestamp(undefined)).toBe('未知');
    });

    test('returns fallback for invalid date', () => {
      expect(formatAuthTimestamp('invalid')).toBe('未知');
    });

    test('uses custom fallback', () => {
      expect(formatAuthTimestamp(null, { fallback: 'N/A' })).toBe('N/A');
    });

    test('marks expired dates', () => {
      const past = new Date('2020-01-01').toISOString();
      const result = formatAuthTimestamp(past, { markExpired: true, now: Date.now() });
      expect(result).toContain('已过期');
    });

    test('does not mark future dates as expired', () => {
      const future = new Date('2099-01-01').toISOString();
      const result = formatAuthTimestamp(future, { markExpired: true, now: Date.now() });
      expect(result).not.toContain('已过期');
    });
  });

  describe('deriveSessionExpiry', () => {
    test('uses existing expiresAt if valid', () => {
      const expiresAt = new Date('2024-12-31').toISOString();
      const result = deriveSessionExpiry(expiresAt, null, 7 * 24 * 3600 * 1000);
      expect(result).toContain('2024-12-31');
    });

    test('derives from loginAt + maxAgeMs', () => {
      const loginAt = new Date('2024-01-01').toISOString();
      const maxAgeMs = 7 * 24 * 3600 * 1000;
      const result = deriveSessionExpiry(null, loginAt, maxAgeMs);
      expect(result).toContain('2024-01-08');
    });

    test('returns null when no valid loginAt', () => {
      expect(deriveSessionExpiry(null, null, 7 * 24 * 3600 * 1000)).toBeNull();
    });

    test('returns null for invalid maxAgeMs', () => {
      const loginAt = new Date('2024-01-01').toISOString();
      expect(deriveSessionExpiry(null, loginAt, -1)).toBeNull();
      expect(deriveSessionExpiry(null, loginAt, 0)).toBeNull();
    });
  });
});
