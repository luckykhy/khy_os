'use strict';

/**
 * Tests for toolError.js — ToolError class, error codes,
 * structured results, AI context formatting, and error inference.
 */

const {
  ToolError,
  ERROR_CODES,
  DEFAULT_HINTS,
} = require('../../src/services/toolError');

describe('ToolError constructor', () => {
  test('creates error with correct code and message', () => {
    const err = new ToolError('TIMEOUT', 'Request timed out');
    expect(err.name).toBe('ToolError');
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toBe('Request timed out');
    expect(err instanceof Error).toBe(true);
  });

  test('applies default hint when none provided', () => {
    const err = new ToolError('TIMEOUT', 'timeout');
    expect(err.hint).toBe(DEFAULT_HINTS.TIMEOUT);
  });

  test('uses custom hint when provided', () => {
    const err = new ToolError('TIMEOUT', 'timeout', { hint: 'Custom hint' });
    expect(err.hint).toBe('Custom hint');
  });

  test('defaults recoverable to true and retryable to false', () => {
    const err = new ToolError('EXECUTION_ERROR', 'err');
    expect(err.recoverable).toBe(true);
    expect(err.retryable).toBe(false);
  });

  test('falls back to EXECUTION_ERROR for unknown codes', () => {
    const err = new ToolError('BOGUS_CODE', 'err');
    expect(err.code).toBe('EXECUTION_ERROR');
  });

  test('preserves originalError reference', () => {
    const orig = new Error('root cause');
    const err = new ToolError('NETWORK_ERROR', 'fail', { originalError: orig });
    expect(err.originalError).toBe(orig);
  });
});

describe('ToolError.toStructuredResult', () => {
  test('returns structured error object', () => {
    const err = new ToolError('PERMISSION_DENIED', 'No access', { retryable: false });
    const result = err.toStructuredResult();
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('PERMISSION_DENIED');
    expect(result.error.message).toBe('No access');
    expect(result.error.retryable).toBe(false);
    expect(result.error.recoverable).toBe(true);
    expect(result.error.hint).toBeTruthy();
  });
});

describe('ToolError.toAIContext', () => {
  test('formats error for AI consumption', () => {
    const err = new ToolError('TIMEOUT', 'Timed out after 30s', { retryable: true });
    const ctx = err.toAIContext();
    expect(ctx).toContain('[ERROR:TIMEOUT]');
    expect(ctx).toContain('Timed out after 30s');
    expect(ctx).toContain('Retryable: yes');
  });

  test('includes hint in output', () => {
    const err = new ToolError('INVALID_ARGS', 'Bad params', { hint: 'Check the schema' });
    const ctx = err.toAIContext();
    expect(ctx).toContain('Hint: Check the schema');
  });
});

describe('ToolError.fromGenericError', () => {
  test('wraps timeout errors as TIMEOUT', () => {
    const orig = new Error('Connection timed out');
    orig.code = 'ETIMEDOUT';
    const wrapped = ToolError.fromGenericError(orig);
    expect(wrapped.code).toBe('TIMEOUT');
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.originalError).toBe(orig);
  });

  test('wraps network errors as NETWORK_ERROR', () => {
    const orig = new Error('Connection refused');
    orig.code = 'ECONNREFUSED';
    const wrapped = ToolError.fromGenericError(orig);
    expect(wrapped.code).toBe('NETWORK_ERROR');
  });

  test('wraps ENOENT as RESOURCE_NOT_FOUND', () => {
    const orig = new Error('File not found');
    orig.code = 'ENOENT';
    const wrapped = ToolError.fromGenericError(orig);
    expect(wrapped.code).toBe('RESOURCE_NOT_FOUND');
  });

  test('wraps EACCES as PERMISSION_DENIED', () => {
    const orig = new Error('Permission denied');
    orig.code = 'EACCES';
    const wrapped = ToolError.fromGenericError(orig);
    expect(wrapped.code).toBe('PERMISSION_DENIED');
  });

  test('wraps unknown errors as EXECUTION_ERROR', () => {
    const orig = new Error('Something weird happened');
    const wrapped = ToolError.fromGenericError(orig);
    expect(wrapped.code).toBe('EXECUTION_ERROR');
  });
});

describe('ToolError.isToolError', () => {
  test('returns true for ToolError instances', () => {
    const err = new ToolError('TIMEOUT', 'test');
    expect(ToolError.isToolError(err)).toBe(true);
  });

  test('returns true for duck-typed ToolError', () => {
    const fake = { name: 'ToolError', code: 'TIMEOUT' };
    expect(ToolError.isToolError(fake)).toBe(true);
  });

  test('returns false for plain Error', () => {
    expect(ToolError.isToolError(new Error('plain'))).toBe(false);
    expect(ToolError.isToolError(null)).toBe(false);
  });
});

describe('ERROR_CODES', () => {
  test('contains expected error codes', () => {
    expect(ERROR_CODES.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
    expect(ERROR_CODES.TIMEOUT).toBe('TIMEOUT');
    expect(ERROR_CODES.INVALID_ARGS).toBe('INVALID_ARGS');
    expect(ERROR_CODES.NETWORK_ERROR).toBe('NETWORK_ERROR');
    expect(ERROR_CODES.EXECUTION_ERROR).toBe('EXECUTION_ERROR');
    expect(ERROR_CODES.RESOURCE_NOT_FOUND).toBe('RESOURCE_NOT_FOUND');
    expect(ERROR_CODES.TOOL_UNAVAILABLE).toBe('TOOL_UNAVAILABLE');
  });
});
