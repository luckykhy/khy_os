'use strict';

const _withTimeout = require('../../src/utils/withTimeout');

describe('withTimeout', () => {
  test('resolves with value when promise resolves before timeout', async () => {
    const result = await _withTimeout(Promise.resolve('success'), 1000);
    expect(result).toBe('success');
  });

  test('resolves with __timeout when timeout expires', async () => {
    const slowPromise = new Promise((resolve) => setTimeout(resolve, 5000));
    const result = await _withTimeout(slowPromise, 50);
    expect(result).toEqual({ __timeout: true });
  });

  test('resolves with __error when promise rejects', async () => {
    const result = await _withTimeout(Promise.reject(new Error('fail')), 1000);
    expect(result).toEqual({ __error: true });
  });

  test('does not reject', async () => {
    await expect(_withTimeout(Promise.reject(new Error('fail')), 100)).resolves.toBeDefined();
  });
});
