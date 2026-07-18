'use strict';

/**
 * Unit tests for timeFormat.js — pure function tests.
 *
 * This module has zero external dependencies, so every function
 * can be tested with precise input/output assertions.
 */

const {
  formatDurationSeconds,
  formatDurationPrecise,
  formatDurationCompact,
  formatDurationHuman,
  formatTimeAgo,
  formatRelativeTimestamp,
} = require('../../src/services/timeFormat');

describe('timeFormat', () => {
  // ── formatDurationSeconds ──────────────────────────────────────────

  describe('formatDurationSeconds', () => {
    test('formats milliseconds as seconds', () => {
      expect(formatDurationSeconds(1500)).toBe('1.5s');
      expect(formatDurationSeconds(2000)).toBe('2s');
      expect(formatDurationSeconds(450)).toBe('0.5s');
    });

    test('respects decimals option', () => {
      expect(formatDurationSeconds(1234, { decimals: 2 })).toBe('1.23s');
      expect(formatDurationSeconds(1234, { decimals: 0 })).toBe('1s');
    });

    test('uses "seconds" unit when specified', () => {
      expect(formatDurationSeconds(45000, { unit: 'seconds' })).toBe('45 seconds');
    });

    test('returns "unknown" for non-finite input', () => {
      expect(formatDurationSeconds(NaN)).toBe('unknown');
      expect(formatDurationSeconds(Infinity)).toBe('unknown');
    });

    test('trims trailing zeros', () => {
      expect(formatDurationSeconds(2000)).toBe('2s');
      expect(formatDurationSeconds(1500)).toBe('1.5s');
    });
  });

  // ── formatDurationPrecise ──────────────────────────────────────────

  describe('formatDurationPrecise', () => {
    test('formats sub-second as milliseconds', () => {
      expect(formatDurationPrecise(500)).toBe('500ms');
      expect(formatDurationPrecise(0)).toBe('0ms');
      expect(formatDurationPrecise(999)).toBe('999ms');
    });

    test('formats >= 1s with 2 decimal precision', () => {
      expect(formatDurationPrecise(1234)).toBe('1.23s');
      expect(formatDurationPrecise(5000)).toBe('5s');
    });

    test('returns "unknown" for non-finite input', () => {
      expect(formatDurationPrecise(NaN)).toBe('unknown');
    });
  });

  // ── formatDurationCompact ──────────────────────────────────────────

  describe('formatDurationCompact', () => {
    test('formats sub-second as milliseconds', () => {
      expect(formatDurationCompact(500)).toBe('500ms');
    });

    test('formats seconds', () => {
      expect(formatDurationCompact(5000)).toBe('5s');
      expect(formatDurationCompact(45000)).toBe('45s');
    });

    test('formats minutes and seconds', () => {
      expect(formatDurationCompact(125000)).toBe('2m5s');
    });

    test('formats hours and minutes', () => {
      expect(formatDurationCompact(5400000)).toBe('1h30m');
    });

    test('formats days and hours', () => {
      expect(formatDurationCompact(93600000)).toBe('1d2h'); // 26 hours
    });

    test('formats days without remainder', () => {
      expect(formatDurationCompact(86400000)).toBe('1d'); // exactly 24h
    });

    test('uses spaces when spaced option is true', () => {
      expect(formatDurationCompact(125000, { spaced: true })).toBe('2m 5s');
    });

    test('returns undefined for null, non-finite, or non-positive', () => {
      expect(formatDurationCompact(null)).toBeUndefined();
      expect(formatDurationCompact(NaN)).toBeUndefined();
      expect(formatDurationCompact(-1)).toBeUndefined();
      expect(formatDurationCompact(0)).toBeUndefined();
    });
  });

  // ── formatDurationHuman ────────────────────────────────────────────

  describe('formatDurationHuman', () => {
    test('formats as single unit', () => {
      expect(formatDurationHuman(500)).toBe('500ms');
      expect(formatDurationHuman(5000)).toBe('5s');
      expect(formatDurationHuman(180000)).toBe('3m');
      expect(formatDurationHuman(7200000)).toBe('2h');
      expect(formatDurationHuman(432000000)).toBe('5d');
    });

    test('returns fallback for invalid input', () => {
      expect(formatDurationHuman(null)).toBe('n/a');
      expect(formatDurationHuman(NaN)).toBe('n/a');
      expect(formatDurationHuman(-100)).toBe('n/a');
    });

    test('respects custom fallback', () => {
      expect(formatDurationHuman(null, 'N/A')).toBe('N/A');
    });
  });

  // ── formatTimeAgo ──────────────────────────────────────────────────

  describe('formatTimeAgo', () => {
    test('returns "just now" for < 60s', () => {
      expect(formatTimeAgo(5000)).toBe('just now');
      expect(formatTimeAgo(30000)).toBe('just now');
    });

    test('formats minutes ago', () => {
      expect(formatTimeAgo(300000)).toBe('5m ago');
    });

    test('formats hours ago', () => {
      expect(formatTimeAgo(7200000)).toBe('2h ago');
    });

    test('formats days ago for >= 48h', () => {
      expect(formatTimeAgo(172800000)).toBe('2d ago');
    });

    test('returns without suffix when suffix=false', () => {
      expect(formatTimeAgo(5000, { suffix: false })).toBe('5s');
      expect(formatTimeAgo(300000, { suffix: false })).toBe('5m');
    });

    test('returns fallback for invalid input', () => {
      expect(formatTimeAgo(null)).toBe('unknown');
      expect(formatTimeAgo(-100)).toBe('unknown');
    });
  });

  // ── formatRelativeTimestamp ────────────────────────────────────────

  describe('formatRelativeTimestamp', () => {
    test('returns "just now" for recent past timestamps', () => {
      const recent = Date.now() - 10000; // 10 seconds ago
      expect(formatRelativeTimestamp(recent)).toBe('just now');
    });

    test('returns "Xm ago" for past timestamps', () => {
      const fiveMinAgo = Date.now() - 300000;
      expect(formatRelativeTimestamp(fiveMinAgo)).toBe('5m ago');
    });

    test('returns "in Xm" for future timestamps', () => {
      const fiveMinFuture = Date.now() + 300000;
      expect(formatRelativeTimestamp(fiveMinFuture)).toBe('in 5m');
    });

    test('returns "Xd ago" for old timestamps', () => {
      const tenDaysAgo = Date.now() - 10 * 86400000;
      expect(formatRelativeTimestamp(tenDaysAgo)).toBe('10d ago');
    });

    test('returns fallback for invalid input', () => {
      expect(formatRelativeTimestamp(null)).toBe('n/a');
      expect(formatRelativeTimestamp(NaN)).toBe('n/a');
    });

    test('respects custom fallback', () => {
      expect(formatRelativeTimestamp(null, { fallback: 'N/A' })).toBe('N/A');
    });
  });
});
