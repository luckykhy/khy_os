'use strict';

const { classifyKhyError, ensureKhyError, _internals } = require('../../src/utils/classifyKhyError');

describe('classifyKhyError', () => {
  test('classifies Error objects', () => {
    const err = new Error('test error');
    const result = classifyKhyError(err);
    expect(result).toBeDefined();
    expect(result.isKhyError).toBe(true);
  });

  test('handles string errors', () => {
    const result = classifyKhyError('string error');
    expect(result.isKhyError).toBe(true);
  });

  test('handles null/undefined', () => {
    const result = classifyKhyError(null);
    expect(result.isKhyError).toBe(true);
  });

  test('ensureKhyError adds category and severity', () => {
    const err = new Error('test');
    const result = ensureKhyError(err);
    expect(result.category).toBeDefined();
    expect(result.severity).toBeDefined();
  });

  test('exposes internal tables', () => {
    expect(_internals.STATUS_TABLE).toBeDefined();
    expect(_internals.ERRNO_TABLE).toBeDefined();
  });
});

