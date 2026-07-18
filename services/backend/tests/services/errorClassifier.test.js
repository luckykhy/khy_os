'use strict';

/**
 * Tests for services/errorClassifier.js — structured error classification.
 */

const errorClassifier = require('../../src/services/errorClassifier');

describe('errorClassifier exports', () => {
  test('exports all expected functions', () => {
    expect(typeof errorClassifier.detectErrorKind).toBe('function');
    expect(typeof errorClassifier.detectErrorKindDeep).toBe('function');
    expect(typeof errorClassifier.extractErrorCode).toBe('function');
    expect(typeof errorClassifier.hasErrnoCode).toBe('function');
    expect(typeof errorClassifier.collectErrorCandidates).toBe('function');
    expect(typeof errorClassifier.formatErrorMessage).toBe('function');
    expect(typeof errorClassifier.formatUncaughtError).toBe('function');
    expect(typeof errorClassifier.redactSensitiveText).toBe('function');
  });

  test('exports ERROR_KIND_PATTERNS', () => {
    expect(typeof errorClassifier.ERROR_KIND_PATTERNS).toBe('object');
    expect(errorClassifier.ERROR_KIND_PATTERNS).toHaveProperty('timeout');
    expect(errorClassifier.ERROR_KIND_PATTERNS).toHaveProperty('rate_limit');
    expect(errorClassifier.ERROR_KIND_PATTERNS).toHaveProperty('auth');
    expect(errorClassifier.ERROR_KIND_PATTERNS).toHaveProperty('network');
  });
});

describe('detectErrorKind', () => {
  test('detects timeout errors', () => {
    const err = new Error('request timed out');
    expect(errorClassifier.detectErrorKind(err)).toBe('timeout');
  });

  test('detects timeout by code', () => {
    const err = new Error('connection failed');
    err.code = 'ETIMEDOUT';
    expect(errorClassifier.detectErrorKind(err)).toBe('timeout');
  });

  test('detects rate limit errors', () => {
    const err = new Error('rate limit exceeded');
    expect(errorClassifier.detectErrorKind(err)).toBe('rate_limit');
  });

  test('detects auth errors', () => {
    const err = new Error('invalid api key');
    expect(errorClassifier.detectErrorKind(err)).toBe('auth');
  });

  test('detects network errors by code', () => {
    const err = new Error('failed');
    err.code = 'ECONNREFUSED';
    expect(errorClassifier.detectErrorKind(err)).toBe('network');
  });

  test('detects context length errors', () => {
    const err = new Error('maximum context length exceeded');
    expect(errorClassifier.detectErrorKind(err)).toBe('context_length');
  });

  test('returns undefined for unclassifiable errors', () => {
    const err = new Error('something random happened');
    expect(errorClassifier.detectErrorKind(err)).toBeUndefined();
  });
});

describe('detectErrorKindDeep', () => {
  test('traverses cause chain', () => {
    const inner = new Error('request timed out');
    const outer = new Error('request failed');
    outer.cause = inner;
    expect(errorClassifier.detectErrorKindDeep(outer)).toBe('timeout');
  });

  test('handles circular cause references', () => {
    const err = new Error('circular');
    err.cause = err; // circular
    // Should not infinite loop, just return undefined or a kind
    expect(() => errorClassifier.detectErrorKindDeep(err)).not.toThrow();
  });
});

describe('extractErrorCode', () => {
  test('extracts string code', () => {
    const err = new Error('fail');
    err.code = 'ECONNRESET';
    expect(errorClassifier.extractErrorCode(err)).toBe('ECONNRESET');
  });

  test('extracts numeric status', () => {
    const err = new Error('fail');
    err.status = 429;
    expect(errorClassifier.extractErrorCode(err)).toBe('429');
  });

  test('returns undefined for plain Error', () => {
    expect(errorClassifier.extractErrorCode(new Error('plain'))).toBeUndefined();
  });

  test('returns undefined for non-object', () => {
    expect(errorClassifier.extractErrorCode('string error')).toBeUndefined();
    expect(errorClassifier.extractErrorCode(null)).toBeUndefined();
  });
});

describe('redactSensitiveText', () => {
  test('redacts OpenAI API key', () => {
    const text = 'Error with key sk-abcdefghijklmnopqrstuvwx';
    const redacted = errorClassifier.redactSensitiveText(text);
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    // Should keep prefix and suffix hints
    expect(redacted).toContain('sk-abc');
  });

  test('redacts GitHub PAT', () => {
    const text = 'Token ghp_1234567890abcdefghij1234';
    const redacted = errorClassifier.redactSensitiveText(text);
    expect(redacted).not.toContain('ghp_1234567890abcdefghij1234');
  });

  test('returns empty string for null/undefined', () => {
    expect(errorClassifier.redactSensitiveText(null)).toBe('');
    expect(errorClassifier.redactSensitiveText(undefined)).toBe('');
  });

  test('passes through text without secrets unchanged', () => {
    const safe = 'This is a normal error message';
    expect(errorClassifier.redactSensitiveText(safe)).toBe(safe);
  });
});

describe('formatErrorMessage', () => {
  test('formats Error instance', () => {
    const err = new Error('test failure');
    const msg = errorClassifier.formatErrorMessage(err);
    expect(msg).toContain('test failure');
  });

  test('formats string error', () => {
    expect(errorClassifier.formatErrorMessage('string error')).toBe('string error');
  });

  test('formats cause chain', () => {
    const inner = new Error('root cause');
    const outer = new Error('wrapper');
    outer.cause = inner;
    const msg = errorClassifier.formatErrorMessage(outer);
    expect(msg).toContain('wrapper');
    expect(msg).toContain('root cause');
  });
});
