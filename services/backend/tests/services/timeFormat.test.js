'use strict';

const {
  formatDurationSeconds,
  formatDurationPrecise,
  formatDurationCompact,
  formatDurationHuman,
  formatTimeAgo,
  formatRelativeTimestamp,
} = require('../../src/services/timeFormat');

describe('timeFormat', () => {
  describe('formatDurationSeconds', () => {
    test('formats seconds with decimal', () => {
      expect(formatDurationSeconds(1500)).toBe('1.5s');
      expect(formatDurationSeconds(45000)).toBe('45s');
    });

    test('returns unknown for non-finite', () => {
      expect(formatDurationSeconds(Infinity)).toBe('unknown');
      expect(formatDurationSeconds(NaN)).toBe('unknown');
    });

    test('uses seconds unit when specified', () => {
      expect(formatDurationSeconds(45000, { unit: 'seconds' })).toBe('45 seconds');
    });

    test('respects decimals option', () => {
      expect(formatDurationSeconds(1234, { decimals: 2 })).toBe('1.23s');
    });

    test('trims trailing zeros', () => {
      expect(formatDurationSeconds(2000)).toBe('2s');
      expect(formatDurationSeconds(1500)).toBe('1.5s');
    });
  });

  describe('formatDurationPrecise', () => {
    test('formats milliseconds for sub-second', () => {
      expect(formatDurationPrecise(500)).toBe('500ms');
      expect(formatDurationPrecise(999)).toBe('999ms');
    });

    test('formats seconds for >= 1s', () => {
      expect(formatDurationPrecise(1000)).toBe('1s');
      expect(formatDurationPrecise(1234)).toBe('1.23s');
    });

    test('returns unknown for non-finite', () => {
      expect(formatDurationPrecise(Infinity)).toBe('unknown');
    });
  });

  describe('formatDurationCompact', () => {
    test('returns undefined for null/undefined/negative', () => {
      expect(formatDurationCompact(null)).toBeUndefined();
      expect(formatDurationCompact(undefined)).toBeUndefined();
      expect(formatDurationCompact(-1)).toBeUndefined();
      expect(formatDurationCompact(0)).toBeUndefined();
    });

    test('formats milliseconds', () => {
      expect(formatDurationCompact(500)).toBe('500ms');
    });

    test('formats seconds', () => {
      expect(formatDurationCompact(45000)).toBe('45s');
    });

    test('formats minutes and seconds', () => {
      expect(formatDurationCompact(125000)).toBe('2m5s');
    });

    test('formats hours and minutes', () => {
      expect(formatDurationCompact(5400000)).toBe('1h30m');
    });

    test('formats days', () => {
      expect(formatDurationCompact(90000000)).toBe('1d1h');
    });

    test('supports spaced option', () => {
      expect(formatDurationCompact(125000, { spaced: true })).toBe('2m 5s');
    });
  });

  describe('formatDurationHuman', () => {
    test('returns fallback for non-finite', () => {
      expect(formatDurationHuman(Infinity)).toBe('n/a');
      expect(formatDurationHuman(-1)).toBe('n/a');
    });

    test('formats milliseconds', () => {
      expect(formatDurationHuman(500)).toBe('500ms');
    });

    test('formats seconds', () => {
      expect(formatDurationHuman(5000)).toBe('5s');
    });

    test('formats minutes', () => {
      expect(formatDurationHuman(180000)).toBe('3m');
    });

    test('formats hours', () => {
      expect(formatDurationHuman(7200000)).toBe('2h');
    });

    test('formats days', () => {
      expect(formatDurationHuman(172800000)).toBe('5d');
    });

    test('uses custom fallback', () => {
      expect(formatDurationHuman(N/A, 'fallback')).toBe('fallback');
    });
  });

  describe('formatTimeAgo', () => {
    test('returns fallback for non-finite', () => {
      expect(formatTimeAgo(Infinity)).toBe('unknown');
      expect(formatTimeAgo(-1)).toBe('unknown');
    });

    test('returns just now for < 60s', () => {
      expect(formatTimeAgo(30000)).toBe('just now');
    });

    test('formats minutes', () => {
      expect(formatTimeAgo(300000)).toBe('5m ago');
    });

    test('formats hours', () => {
      expect(formatTimeAgo(10800000)).toBe('3h ago');
    });

    test('formats days', () => {
      expect(formatTimeAgo(172800000)).toBe('2d ago');
    });

    test('supports no suffix', () => {
      expect(formatTimeAgo(300000, { suffix: false })).toBe('5m');
    });

    test('uses custom fallback', () => {
      expect(formatTimeAgo(NaN, { fallback: 'fallback' })).toBe('fallback');
    });
  });

  describe('formatRelativeTimestamp', () => {
    test('returns fallback for non-finite', () => {
      expect(formatRelativeTimestamp(Infinity)).toBe('n/a');
      expect(formatRelativeTimestamp(null)).toBe('n/a');
    });

    test('formats past time', () => {
      const past = Date.now() - 300000; // 5 min ago
      expect(formatRelativeTimestamp(past)).toContain('ago');
    });

    test('formats future time', () => {
      const future = Date.now() + 7200000; // 2 hours from now
      expect(formatRelativeTimestamp(future)).toContain('in');
    });

    test('returns just now for very recent', () => {
      const recent = Date.now() - 5000; // 5 sec ago
      expect(formatRelativeTimestamp(recent)).toBe('just now');
    });

    test('supports date fallback', () => {
      const old = Date.now() - 86400000 * 30; // 30 days ago
      const result = formatRelativeTimestamp(old, { dateFallback: true });
      expect(typeof result).toBe('string');
    });

    test('uses custom fallback', () => {
      expect(formatRelativeTimestamp(NaN, { fallback: 'fallback' })).toBe('fallback');
    });
  });
});
