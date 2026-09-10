'use strict';

const _withTimeout = require('../../src/utils/withTimeout');

describe('withTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('resolves with value if promise settles first', async () => {
    const promise = Promise.resolve('success');
    const resultPromise = _withTimeout(promise, 1000);
    jest.advanceTimersByTime(500);
    const result = await resultPromise;
    expect(result).toBe('success');
  });

  test('resolves with timeout sentinel if not settled', async () => {
    const promise = new Promise(() => {}); // never settles
    const resultPromise = _withTimeout(promise, 1000);
    jest.advanceTimersByTime(1000);
    const result = await resultPromise;
    expect(result).toEqual({ __timeout: true });
  });

  test('resolves with error sentinel if rejected', async () => {
    const promise = Promise.reject(new Error('fail'));
    const resultPromise = _withTimeout(promise, 1000);
    jest.advanceTimersByTime(500);
    const result = await resultPromise;
    expect(result).toEqual({ __error: true });
  });
});

