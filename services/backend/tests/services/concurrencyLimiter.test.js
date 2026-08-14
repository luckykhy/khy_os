'use strict';

/**
 * Tests for concurrencyLimiter.js — runWithConcurrency,
 * runWithConcurrencyAndTimeout, and mapWithConcurrency.
 */

const {
  runWithConcurrency,
  runWithConcurrencyAndTimeout,
  mapWithConcurrency,
} = require('../../src/services/concurrencyLimiter');

describe('runWithConcurrency', () => {
  test('returns empty results for no tasks', async () => {
    const { results, hasError } = await runWithConcurrency({
      tasks: [],
      limit: 5,
    });
    expect(results).toEqual([]);
    expect(hasError).toBe(false);
  });

  test('executes all tasks and returns ordered results', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ];
    const { results, hasError } = await runWithConcurrency({
      tasks,
      limit: 2,
    });
    expect(results).toEqual(['a', 'b', 'c']);
    expect(hasError).toBe(false);
  });

  test('enforces concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 10 }, () => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
    });

    await runWithConcurrency({ tasks, limit: 3 });
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  test('continue mode collects errors without stopping', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.reject(new Error('err-b')),
      () => Promise.resolve('c'),
    ];
    const { results, firstError, hasError } = await runWithConcurrency({
      tasks,
      limit: 1, // serial to ensure deterministic order
      errorMode: 'continue',
    });
    expect(hasError).toBe(true);
    expect(firstError.message).toBe('err-b');
    expect(results[0]).toBe('a');
    expect(results[2]).toBe('c');
  });

  test('stop mode halts on first error', async () => {
    const executed = [];
    const tasks = [
      async () => { executed.push(0); return 'a'; },
      async () => { executed.push(1); throw new Error('stop here'); },
      async () => { executed.push(2); return 'c'; },
    ];
    const { hasError } = await runWithConcurrency({
      tasks,
      limit: 1,
      errorMode: 'stop',
    });
    expect(hasError).toBe(true);
    // Task at index 2 should not have run (or be skipped)
    expect(executed).not.toContain(2);
  });

  test('calls onTaskComplete callback', async () => {
    const onTaskComplete = jest.fn();
    await runWithConcurrency({
      tasks: [() => Promise.resolve('x')],
      limit: 1,
      onTaskComplete,
    });
    expect(onTaskComplete).toHaveBeenCalledWith('x', 0);
  });

  test('calls onTaskError callback', async () => {
    const onTaskError = jest.fn();
    await runWithConcurrency({
      tasks: [() => Promise.reject(new Error('fail'))],
      limit: 1,
      onTaskError,
    });
    expect(onTaskError).toHaveBeenCalledTimes(1);
    expect(onTaskError.mock.calls[0][1]).toBe(0);
  });
});

describe('runWithConcurrencyAndTimeout', () => {
  test('applies per-task timeout', async () => {
    const tasks = [
      async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return 'should-not-reach';
      },
    ];
    const { firstError, hasError } = await runWithConcurrencyAndTimeout({
      tasks,
      limit: 1,
      timeoutMs: 50,
    });
    expect(hasError).toBe(true);
    expect(firstError.message).toMatch(/timed out/);
  });
});

describe('mapWithConcurrency', () => {
  test('maps items through fn with concurrency', async () => {
    const results = await mapWithConcurrency(
      [1, 2, 3],
      async (item) => item * 10,
      2
    );
    expect(results).toEqual([10, 20, 30]);
  });

  test('throws first error on any failure', async () => {
    await expect(
      mapWithConcurrency(
        [1, 2],
        async (item) => { if (item === 2) throw new Error('map fail'); return item; },
        2
      )
    ).rejects.toThrow('map fail');
  });
});
