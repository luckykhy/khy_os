'use strict';

const {
  khyError,
  isKhyError,
  toKhyError,
  formatKhyError,
  CODES,
} = require('../../src/utils/khyError');

describe('khyError', () => {
  describe('khyError', () => {
    test('creates error with code and message', () => {
      const err = khyError('TIMEOUT', '连接超时');
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('TIMEOUT');
      expect(err.message).toBe('连接超时');
      expect(err.isKhyError).toBe(true);
    });

    test('fills defaults from CODES', () => {
      const err = khyError('TIMEOUT', '连接超时');
      expect(err.hint).toBe(CODES.TIMEOUT.hint);
      expect(err.recoverable).toBe(CODES.TIMEOUT.recoverable);
      expect(err.retryable).toBe(CODES.TIMEOUT.retryable);
      expect(err.category).toBe(CODES.TIMEOUT.category);
      expect(err.severity).toBe(CODES.TIMEOUT.severity);
    });

    test('allows overriding defaults', () => {
      const err = khyError('TIMEOUT', '连接超时', {
        hint: '自定义提示',
        recoverable: false,
        retryable: false,
        category: 'custom',
        severity: 'fatal',
      });
      expect(err.hint).toBe('自定义提示');
      expect(err.recoverable).toBe(false);
      expect(err.retryable).toBe(false);
      expect(err.category).toBe('custom');
      expect(err.severity).toBe('fatal');
    });

    test('handles unregistered code', () => {
      const err = khyError('CUSTOM_CODE', '自定义错误');
      expect(err.code).toBe('CUSTOM_CODE');
      expect(err.category).toBe(CODES.UNKNOWN.category);
    });

    test('handles null/undefined code', () => {
      const err = khyError(null, '错误');
      expect(err.code).toBe('UNKNOWN');
    });

    test('adds suggestions', () => {
      const err = khyError('TIMEOUT', '连接超时', {
        suggestions: ['建议1', '建议2'],
      });
      expect(err.suggestions).toEqual(['建议1', '建议2']);
    });

    test('adds cause', () => {
      const cause = new Error('原始错误');
      const err = khyError('TIMEOUT', '连接超时', { cause });
      expect(err.cause).toBe(cause);
    });

    test('adds details', () => {
      const err = khyError('TIMEOUT', '连接超时', { details: { url: 'http://test.com' } });
      expect(err.details).toEqual({ url: 'http://test.com' });
    });
  });

  describe('isKhyError', () => {
    test('returns true for khyError', () => {
      const err = khyError('TIMEOUT', '连接超时');
      expect(isKhyError(err)).toBe(true);
    });

    test('returns false for regular Error', () => {
      expect(isKhyError(new Error('普通错误'))).toBe(false);
    });

    test('returns false for null/undefined', () => {
      expect(isKhyError(null)).toBe(false);
      expect(isKhyError(undefined)).toBe(false);
    });

    test('returns false for non-error object', () => {
      expect(isKhyError({ isKhyError: true })).toBe(false);
    });
  });

  describe('toKhyError', () => {
    test('passes through khyError', () => {
      const err = khyError('TIMEOUT', '连接超时');
      expect(toKhyError(err)).toBe(err);
    });

    test('wraps regular Error', () => {
      const original = new Error('原始错误');
      const result = toKhyError(original);
      expect(result.code).toBeDefined();
      expect(result.message).toBe('原始错误');
      expect(result.cause).toBe(original);
    });

    test('wraps string', () => {
      const result = toKhyError('错误信息');
      expect(result.message).toBe('错误信息');
    });

    test('uses fallback code', () => {
      const result = toKhyError(new Error('错误'), 'CUSTOM_CODE');
      expect(result.code).toBe('CUSTOM_CODE');
    });

    test('classifies EACCES as auth', () => {
      const err = new Error('权限不足');
      err.code = 'EACCES';
      const result = toKhyError(err);
      expect(result.category).toBe('auth');
    });

    test('classifies ENOENT as io', () => {
      const err = new Error('文件不存在');
      err.code = 'ENOENT';
      const result = toKhyError(err);
      expect(result.category).toBe('io');
    });

    test('classifies ETIMEDOUT as network', () => {
      const err = new Error('超时');
      err.code = 'ETIMEDOUT';
      const result = toKhyError(err);
      expect(result.category).toBe('network');
    });
  });

  describe('formatKhyError', () => {
    test('formats khyError', () => {
      const err = khyError('TIMEOUT', '连接超时');
      const result = formatKhyError(err);
      expect(result).toContain('[network]');
      expect(result).toContain('连接超时');
      expect(result).toContain('提示');
    });

    test('formats regular Error', () => {
      const result = formatKhyError(new Error('普通错误'));
      expect(result).toContain('普通错误');
    });
  });

  describe('CODES', () => {
    test('contains TIMEOUT', () => {
      expect(CODES.TIMEOUT).toBeDefined();
      expect(CODES.TIMEOUT.category).toBe('network');
    });

    test('contains MODULE_NOT_FOUND', () => {
      expect(CODES.MODULE_NOT_FOUND).toBeDefined();
      expect(CODES.MODULE_NOT_FOUND.category).toBe('config');
    });

    test('contains UNKNOWN', () => {
      expect(CODES.UNKNOWN).toBeDefined();
    });
  });
});
