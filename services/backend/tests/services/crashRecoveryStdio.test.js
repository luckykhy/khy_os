'use strict';

/**
 * Regression tests for the self-feeding EPIPE loop (crashRecovery).
 *
 * History: a broken stdout/stderr pipe escalates write() failures to
 * uncaughtException. crashRecovery's handler treats EPIPE as benign, logs it
 * via console.warn — which writes to the same dead pipe — looping forever and
 * writing gigabytes of identical log lines (observed 2026-07-28, 2026-08-28).
 *
 * Fix: installStdioErrorGuard() attaches 'error' listeners to stdout/stderr so
 * a dead pipe never escalates to uncaughtException. These tests pin that the
 * guard registers exactly once and is idempotent.
 *
 * NOTE: the guard is a module singleton (installed once per process). The first
 * installStdioErrorGuard() call in this suite registers the real listener; all
 * later assertions measure that single registration. This matches production:
 * server.js / TUI both call crashRecovery.install() exactly once.
 */

const crashRecovery = require('../../src/services/crashRecovery');

describe('crashRecovery.installStdioErrorGuard', () => {
  test('attaches exactly one error listener to stdout', () => {
    crashRecovery.installStdioErrorGuard();
    expect(process.stdout.listenerCount('error')).toBe(1);
  });

  test('attaches exactly one error listener to stderr', () => {
    crashRecovery.installStdioErrorGuard();
    expect(process.stderr.listenerCount('error')).toBe(1);
  });

  test('is idempotent — installing again adds no extra listeners', () => {
    crashRecovery.installStdioErrorGuard();
    crashRecovery.installStdioErrorGuard();
    expect(process.stdout.listenerCount('error')).toBe(1);
    expect(process.stderr.listenerCount('error')).toBe(1);
  });
});
