'use strict';

const retry = require('../../src/utils/retry');

describe('retry', () => {
  test('returns result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await retry(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on failure then succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('success');

    const result = await retry(fn, 3, 10);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('throws after exhausting retries', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    await expect(retry(fn, 2, 10)).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('uses default maxRetries of 3', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    await expect(retry(fn, 0, 10)).rejects.toThrow('fail');
  });

  test('delay doubles each retry', async () => {
    const delays = [];
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = jest.fn((cb, ms) => {
      delays.push(ms);
      return originalSetTimeout(cb, 0);
    });

    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValue(new Error('fail'));

    await retry(fn, 3, 100).catch(() => {});
    expect(delays.slice(0, 3)).toEqual([100, 200, 400]);

    global.setTimeout = originalSetTimeout;
  });

  test('handles non-Error throws', async () => {
    const fn = jest.fn().mockRejectedValue('string error');
    await expect(retry(fn, 0, 10)).rejects.toBe('string error');
  });

  test('handles synchronous throw in fn', async () => {
    const fn = jest.fn(() => {
      throw new Error('sync throw');
    });
    await expect(retry(fn, 1, 10)).rejects.toThrow('sync throw');
  });

  test('succeeds on last attempt', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockRejectedValueOnce(new Error('fail3'))
      .mockResolvedValue('ok');

    const result = await retry(fn, 3, 10);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

