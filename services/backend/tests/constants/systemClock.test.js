'use strict';

const {
  isEnabled,
  legacyDateLine,
  formatSystemClockLines,
  clockCacheKey,
} = require('../../src/constants/systemClock');

describe('systemClock', () => {
  describe('isEnabled', () => {
    test('returns true when env not set', () => {
      expect(isEnabled({})).toBe(true);
      expect(isEnabled()).toBe(true);
    });

    test('returns true for non-off values', () => {
      expect(isEnabled({ KHY_SYSTEM_CLOCK: '1' })).toBe(true);
      expect(isEnabled({ KHY_SYSTEM_CLOCK: 'true' })).toBe(true);
      expect(isEnabled({ KHY_SYSTEM_CLOCK: 'yes' })).toBe(true);
    });

    test('returns false for off values', () => {
      expect(isEnabled({ KHY_SYSTEM_CLOCK: '0' })).toBe(false);
      expect(isEnabled({ KHY_SYSTEM_CLOCK: 'false' })).toBe(false);
      expect(isEnabled({ KHY_SYSTEM_CLOCK: 'off' })).toBe(false);
      expect(isEnabled({ KHY_SYSTEM_CLOCK: 'no' })).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(isEnabled({ KHY_SYSTEM_CLOCK: 'FALSE' })).toBe(false);
      expect(isEnabled({ KHY_SYSTEM_CLOCK: 'OFF' })).toBe(false);
    });
  });

  describe('legacyDateLine', () => {
    test('formats date correctly', () => {
      const now = new Date('2024-03-15T10:30:00Z');
      const result = legacyDateLine(now);
      expect(result).toMatch(/ - Current date: 2024-03-15/);
    });

    test('pads month and day', () => {
      const now = new Date('2024-01-05T00:00:00Z');
      const result = legacyDateLine(now);
      expect(result).toContain('2024-01-05');
    });
  });

  describe('formatSystemClockLines', () => {
    test('returns legacy line when disabled', () => {
      const now = new Date('2024-03-15T10:30:00+08:00');
      const result = formatSystemClockLines({ now, env: { KHY_SYSTEM_CLOCK: 'off' } });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/ - Current date:/);
    });

    test('returns full clock lines when enabled', () => {
      const now = new Date('2024-03-15T10:30:45+08:00');
      const result = formatSystemClockLines({ now, env: {}, offsetMinutes: 480 });
      expect(result).toHaveLength(3);
      expect(result[0]).toMatch(/ - Current date: 2024-03-15 \(Friday\)/);
      expect(result[1]).toMatch(/ - Current time: 10:30:45 \(UTC\+08:00\)/);
      expect(result[2]).toMatch(/ - Current timestamp \(ISO 8601\):/);
    });

    test('includes timezone when provided', () => {
      const now = new Date('2024-03-15T10:30:45+08:00');
      const result = formatSystemClockLines({ now, env: {}, offsetMinutes: 480, timeZone: 'Asia/Shanghai' });
      expect(result[1]).toContain('Asia/Shanghai');
    });

    test('handles negative offset', () => {
      const now = new Date('2024-03-15T10:30:45-05:00');
      const result = formatSystemClockLines({ now, env: {}, offsetMinutes: -300 });
      expect(result[1]).toContain('UTC-05:00');
    });

    test('uses current time when now not provided', () => {
      const result = formatSystemClockLines({ env: {}, offsetMinutes: 0 });
      expect(result).toHaveLength(3);
      expect(result[0]).toMatch(/ - Current date:/);
    });
  });

  describe('clockCacheKey', () => {
    test('returns empty string when disabled', () => {
      expect(clockCacheKey({ env: { KHY_SYSTEM_CLOCK: 'off' } })).toBe('');
    });

    test('returns time bucket when enabled', () => {
      const now = new Date('2024-03-15T10:30:45Z');
      const result = clockCacheKey({ now, env: {} });
      expect(result).toMatch(/^t\d+$/);
    });

    test('respects custom bucket seconds', () => {
      const now = new Date('2024-03-15T10:30:45Z');
      const result = clockCacheKey({ now, env: { KHY_SYSTEM_CLOCK_BUCKET_SECONDS: '60' } });
      expect(result).toMatch(/^t\d+$/);
    });
  });
});
