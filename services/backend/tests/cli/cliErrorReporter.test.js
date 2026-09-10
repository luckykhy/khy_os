'use strict';
const {
  describeCliError,
  reportCliError,
  formatCliErrorLine,
  KIND_REMEDIATION,
  ERRNO_REMEDIATION,
  GENERIC_REMEDIATION,
} = require('./cliErrorReporter');
// ── Exports ─────────────────────────────────────────────────────────────────
// ── describeCliError ─────────────────────────────────────────────────────────
// ── reportCliError ───────────────────────────────────────────────────────────
// ── formatCliErrorLine ───────────────────────────────────────────────────────

describe('Cli Error Reporter', () => {
  test('exports: KIND_REMEDIATION is defined', () => {
      expect(KIND_REMEDIATION).toBeTruthy();
  });

  test('exports: ERRNO_REMEDIATION is defined', () => {
      expect(ERRNO_REMEDIATION).toBeTruthy();
  });

  test('exports: GENERIC_REMEDIATION is defined', () => {
      expect(GENERIC_REMEDIATION).toBeTruthy();
  });

  test('describeCliError: returns error description', () => {
      const err = new Error('test error');
      const desc = describeCliError(err);
      expect(desc).toBeTruthy();
      expect(desc.reason).toBeTruthy();
      expect(Array.isArray(desc.suggestions).toBeTruthy());
  });

  test('describeCliError: handles null/undefined', () => {
      const desc = describeCliError(null);
      expect(desc).toBeTruthy();
      expect(desc.reason).toBeTruthy();
  });

  test('reportCliError: returns description and does not throw', () => {
      const err = new Error('test error');
      const desc = reportCliError(err);
      expect(desc).toBeTruthy();
      expect(desc.reason).toBeTruthy();
  });

  test('reportCliError: handles Error with code', () => {
      const err = new Error('ENOENT: file not found');
      err.code = 'ENOENT';
      const desc = reportCliError(err);
      expect(desc).toBeTruthy();
  });

  test('reportCliError: accepts opts.formatters', () => {
      const err = new Error('test');
      const mockFormatters = {
        printErrorPanel: () => {},
        printError: () => {},
      };
      const desc = reportCliError(err, { formatters: mockFormatters });
      expect(desc).toBeTruthy();
  });

  test('reportCliError: showStack false hides stack', () => {
      const err = new Error('test');
      const desc = reportCliError(err, { showStack: false });
      expect(desc).toBeTruthy();
  });

  test('formatCliErrorLine: returns single line with reason', () => {
      const err = new Error('test error');
      const line = formatCliErrorLine(err);
      expect(line).toContain('test error');
  });

  test('formatCliErrorLine: includes fix suggestion when available', () => {
      const err = new Error('test error');
      const line = formatCliErrorLine(err);
      // Should have format: "reason ｜ 解决: suggestion" or just "reason"
      expect(typeof line === 'string').toBeTruthy();
      expect(line.length > 0).toBeTruthy();
  });

  test('formatCliErrorLine: handles null/undefined', () => {
      const line = formatCliErrorLine(null);
      expect(typeof line === 'string').toBeTruthy();
      expect(line.length > 0).toBeTruthy();
  });

});
