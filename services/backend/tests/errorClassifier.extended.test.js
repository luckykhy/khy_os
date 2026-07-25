'use strict';

const {
  detectErrorKind,
  detectErrorKindDeep,
  classifyErrorFull,
  isRetryable,
  suggestRecoveryAction,
  ERROR_KIND_PATTERNS,
} = require('../src/services/errorClassifier');

describe('errorClassifier — extended kinds', () => {
  // ── Original 6 kinds (regression) ────────────────────────────────

  test('detects refusal', () => {
    expect(detectErrorKind({ message: 'content_filter triggered' })).toBe('refusal');
  });

  test('detects timeout', () => {
    expect(detectErrorKind({ message: 'request timed out' })).toBe('timeout');
    expect(detectErrorKind({ code: 'ETIMEDOUT' })).toBe('timeout');
  });

  test('detects rate_limit', () => {
    expect(detectErrorKind({ message: 'too many requests' })).toBe('rate_limit');
    expect(detectErrorKind({ code: '429' })).toBe('rate_limit');
  });

  test('detects context_length', () => {
    expect(detectErrorKind({ message: 'too many tokens for context_window' })).toBe('context_length');
  });

  test('detects auth', () => {
    expect(detectErrorKind({ message: 'invalid api key' })).toBe('auth');
    expect(detectErrorKind({ code: '401' })).toBe('auth');
  });

  test('detects network', () => {
    expect(detectErrorKind({ message: 'fetch failed' })).toBe('network');
    expect(detectErrorKind({ code: 'ECONNREFUSED' })).toBe('network');
  });

  // ── 7 New kinds ──────────────────────────────────────────────────

  test('detects overloaded', () => {
    expect(detectErrorKind({ message: 'service overloaded' })).toBe('overloaded');
    expect(detectErrorKind({ code: '529' })).toBe('overloaded');
  });

  test('detects server_error', () => {
    expect(detectErrorKind({ message: 'internal server error' })).toBe('server_error');
    expect(detectErrorKind({ code: '502' })).toBe('server_error');
  });

  test('detects billing', () => {
    expect(detectErrorKind({ message: 'insufficient_quota' })).toBe('billing');
    expect(detectErrorKind({ code: '402' })).toBe('billing');
  });

  test('detects model_not_found', () => {
    expect(detectErrorKind({ message: 'model not found' })).toBe('model_not_found');
  });

  test('detects cancelled', () => {
    expect(detectErrorKind({ message: 'request aborted by user' })).toBe('cancelled');
  });

  test('detects process', () => {
    expect(detectErrorKind({ message: 'channel closed unexpectedly' })).toBe('process');
    expect(detectErrorKind({ message: 'exited with code 1' })).toBe('process');
  });

  test('detects permission', () => {
    expect(detectErrorKind({ message: 'permission denied' })).toBe('permission');
    expect(detectErrorKind({ code: 'EACCES' })).toBe('permission');
  });

  // ── classifyErrorFull ────────────────────────────────────────────

  test('classifyErrorFull returns structured result', () => {
    const result = classifyErrorFull(529, 'overloaded');
    expect(result.kind).toBe('overloaded');
    expect(result.retryable).toBe(true);
    expect(result.action).toBe('retry');
  });

  test('classifyErrorFull for auth returns reauth action', () => {
    const result = classifyErrorFull(401, 'unauthorized');
    expect(result.kind).toBe('auth');
    expect(result.retryable).toBe(false);
    expect(result.action).toBe('reauth');
  });

  test('classifyErrorFull for context_length returns compress action', () => {
    const result = classifyErrorFull(null, 'too many tokens');
    expect(result.kind).toBe('context_length');
    expect(result.action).toBe('compress');
  });

  test('classifyErrorFull returns unknown for unrecognized errors', () => {
    const result = classifyErrorFull(null, 'something weird happened');
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
    expect(result.action).toBe('abort');
  });

  // ── isRetryable ──────────────────────────────────────────────────

  test('isRetryable positive cases', () => {
    expect(isRetryable('timeout')).toBe(true);
    expect(isRetryable('network')).toBe(true);
    expect(isRetryable('rate_limit')).toBe(true);
    expect(isRetryable('overloaded')).toBe(true);
    expect(isRetryable('server_error')).toBe(true);
    expect(isRetryable('process')).toBe(true);
  });

  test('isRetryable negative cases', () => {
    expect(isRetryable('auth')).toBe(false);
    expect(isRetryable('refusal')).toBe(false);
    expect(isRetryable('billing')).toBe(false);
    expect(isRetryable('model_not_found')).toBe(false);
    expect(isRetryable('cancelled')).toBe(false);
    expect(isRetryable('permission')).toBe(false);
    expect(isRetryable('unknown')).toBe(false);
  });

  // ── suggestRecoveryAction ────────────────────────────────────────

  test('suggestRecoveryAction mapping', () => {
    expect(suggestRecoveryAction('context_length')).toBe('compress');
    expect(suggestRecoveryAction('rate_limit')).toBe('credential_rotate');
    expect(suggestRecoveryAction('billing')).toBe('credential_rotate');
    expect(suggestRecoveryAction('model_not_found')).toBe('fallback_model');
    expect(suggestRecoveryAction('auth')).toBe('reauth');
    expect(suggestRecoveryAction('timeout')).toBe('retry');
    expect(suggestRecoveryAction('network')).toBe('retry');
    expect(suggestRecoveryAction('refusal')).toBe('abort');
    expect(suggestRecoveryAction('cancelled')).toBe('abort');
  });

  // ── ERROR_KIND_PATTERNS completeness ─────────────────────────────

  test('ERROR_KIND_PATTERNS has all 13 kinds', () => {
    const kinds = Object.keys(ERROR_KIND_PATTERNS);
    expect(kinds).toContain('refusal');
    expect(kinds).toContain('timeout');
    expect(kinds).toContain('rate_limit');
    expect(kinds).toContain('context_length');
    expect(kinds).toContain('auth');
    expect(kinds).toContain('network');
    expect(kinds).toContain('overloaded');
    expect(kinds).toContain('server_error');
    expect(kinds).toContain('billing');
    expect(kinds).toContain('model_not_found');
    expect(kinds).toContain('cancelled');
    expect(kinds).toContain('process');
    expect(kinds).toContain('permission');
    expect(kinds.length).toBe(13);
  });
});
