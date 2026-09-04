'use strict';

const { wrapError, formatError, ERROR_CODES } = require('../../src/utils/userFriendlyError');

describe('userFriendlyError', () => {
  describe('wrapError', () => {
    test('returns null for null error', () => {
      expect(wrapError(null)).toBeNull();
    });

    test('wraps known error codes', () => {
      const err = new Error('test');
      err.code = 'EADDRINUSE';
      const result = wrapError(err);
      expect(result.code).toBe('NET_001');
      expect(result.message).toBe('端口已被占用');
    });

    test('wraps unknown error codes', () => {
      const err = new Error('unknown error');
      err.code = 'UNKNOWN_CODE';
      const result = wrapError(err);
      expect(result.code).toBe('UNKNOWN');
      expect(result.message).toBe('unknown error');
    });

    test('includes context', () => {
      const err = new Error('test');
      const result = wrapError(err, 'test context');
      expect(result.context).toBe('test context');
    });
  });

  describe('formatError', () => {
    test('returns empty string for null', () => {
      expect(formatError(null)).toBe('');
    });

    test('formats wrapped error', () => {
      const err = new Error('test');
      err.code = 'EADDRINUSE';
      const wrapped = wrapError(err);
      const result = formatError(wrapped);
      expect(result).toContain('端口已被占用');
      expect(result).toContain('NET_001');
    });
  });

  describe('ERROR_CODES', () => {
    test('has network error codes', () => {
      expect(ERROR_CODES.EADDRINUSE).toBeDefined();
      expect(ERROR_CODES.ECONNREFUSED).toBeDefined();
      expect(ERROR_CODES.ETIMEDOUT).toBeDefined();
      expect(ERROR_CODES.ENOTFOUND).toBeDefined();
    });

    test('has filesystem error codes', () => {
      expect(ERROR_CODES.ENOENT).toBeDefined();
      expect(ERROR_CODES.EACCES).toBeDefined();
      expect(ERROR_CODES.EEXIST).toBeDefined();
      expect(ERROR_CODES.ENOSPC).toBeDefined();
    });
  });
});
