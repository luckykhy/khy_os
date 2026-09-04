'use strict';

const retry = require('../../src/utils/retry');

describe('retry', () => {
  test('returns result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await retry(fn, 3, 10);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on failure', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('success');
    const result = await retry(fn, 3, 10);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('throws after max retries', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    await expect(retry(fn, 2, 10)).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  test('uses exponential backoff', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');
    const start = Date.now();
    await retry(fn, 3, 50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});
