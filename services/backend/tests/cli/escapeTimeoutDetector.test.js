'use strict';
const {
  resolveEscapeCodeTimeout,
  OVERRIDE_ENV,
  MIN_TIMEOUT_MS,
  SSH_TIMEOUT_MS,
  DUMB_TERM_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
} = require('./escapeTimeoutDetector');
// ── Constants ────────────────────────────────────────────────────────────────
// ── resolveEscapeCodeTimeout ─────────────────────────────────────────────────

describe('Escape Timeout Detector', () => {
  test('constants: expected values', () => {
      expect(OVERRIDE_ENV).toBe('KHY_INPUT_ESCAPE_TIMEOUT_MS');
      expect(MIN_TIMEOUT_MS).toBe(10);
      expect(SSH_TIMEOUT_MS).toBe(200);
      expect(DUMB_TERM_TIMEOUT_MS).toBe(200);
      expect(DEFAULT_TIMEOUT_MS).toBe(120);
  });

  test('resolveEscapeCodeTimeout: default returns 120ms', () => {
      expect(resolveEscapeCodeTimeout({})).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('resolveEscapeCodeTimeout: explicit override wins', () => {
      expect(resolveEscapeCodeTimeout({ [OVERRIDE_ENV]: '300' })).toBe(300);
      expect(resolveEscapeCodeTimeout({ [OVERRIDE_ENV]: '50' })).toBe(50);
  });

  test('resolveEscapeCodeTimeout: override respects minimum floor', () => {
      expect(resolveEscapeCodeTimeout({ [OVERRIDE_ENV]: '5' })).toBe(MIN_TIMEOUT_MS);
      expect(resolveEscapeCodeTimeout({ [OVERRIDE_ENV]: '0' })).toBe(MIN_TIMEOUT_MS);
      expect(resolveEscapeCodeTimeout({ [OVERRIDE_ENV]: '-100' })).toBe(MIN_TIMEOUT_MS);
  });

  test('resolveEscapeCodeTimeout: SSH session �?200ms', () => {
      expect(resolveEscapeCodeTimeout({ SSH_CONNECTION: '192.168.1.1' })).toBe(SSH_TIMEOUT_MS);
  });

  test('resolveEscapeCodeTimeout: dumb terminal �?200ms', () => {
      expect(resolveEscapeCodeTimeout({ TERM: 'dumb' })).toBe(DUMB_TERM_TIMEOUT_MS);
      expect(resolveEscapeCodeTimeout({ TERM: 'DUMB' })).toBe(DUMB_TERM_TIMEOUT_MS);
      expect(resolveEscapeCodeTimeout({ TERM: 'Dumb' })).toBe(DUMB_TERM_TIMEOUT_MS);
  });

  test('resolveEscapeCodeTimeout: SSH overrides dumb terminal', () => {
      // SSH takes precedence over TERM=dumb
      assert.equal(
        resolveEscapeCodeTimeout({ SSH_CONNECTION: 'x', TERM: 'dumb' }),
        SSH_TIMEOUT_MS
      );
  });

  test('resolveEscapeCodeTimeout: override wins over SSH and dumb', () => {
      assert.equal(
        resolveEscapeCodeTimeout({
          [OVERRIDE_ENV]: '500',
          SSH_CONNECTION: 'x',
          TERM: 'dumb',
        }),
        500
      );
  });

  test('resolveEscapeCodeTimeout: non-numeric override �?default', () => {
      expect(resolveEscapeCodeTimeout({ [OVERRIDE_ENV]: 'abc' })).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('resolveEscapeCodeTimeout: whitespace-only override �?default', () => {
      expect(resolveEscapeCodeTimeout({ [OVERRIDE_ENV]: '   ' })).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('resolveEscapeCodeTimeout: null env �?default', () => {
      expect(resolveEscapeCodeTimeout(null)).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('resolveEscapeCodeTimeout: Windows Terminal (WT_SESSION) �?default', () => {
      expect(resolveEscapeCodeTimeout({ WT_SESSION: 'uuid' })).toBe(DEFAULT_TIMEOUT_MS);
  });

});

