'use strict';

const tryOr = require('../../src/utils/tryOr');

describe('tryOr', () => {
  test('returns fn result on success', () => {
    expect(tryOr(() => 42, 0)).toBe(42);
  });

  test('returns default on error', () => {
    expect(tryOr(() => { throw new Error('fail'); }, 'default')).toBe('default');
  });

  test('does not catch async errors', async () => {
    const fn = () => Promise.reject(new Error('async'));
    // tryOr returns the rejected promise, doesn't catch it
    await expect(fn()).rejects.toThrow('async');
  });

  test('handles null default', () => {
    expect(tryOr(() => { throw new Error(); }, null)).toBe(null);
  });

  test('handles undefined default', () => {
    expect(tryOr(() => { throw new Error(); }, undefined)).toBe(undefined);
  });
});
