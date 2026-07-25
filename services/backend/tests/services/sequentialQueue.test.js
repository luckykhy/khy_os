'use strict';

/**
 * Tests for sequentialQueue.js — per-key sequential execution
 * with task timeout eviction.
 */

const {
  createSequentialQueue,
  DEFAULT_TASK_TIMEOUT_MS,
} = require('../../src/services/sequentialQueue');

describe('createSequentialQueue — serial execution', () => {
  test('tasks for same key execute in order', async () => {
    const order = [];
    const enqueue = createSequentialQueue({ taskTimeoutMs: 5000 });

    const p1 = enqueue('key', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
      return 'a';
    });
    const p2 = enqueue('key', async () => {
      order.push(2);
      return 'b';
    });
    const p3 = enqueue('key', async () => {
      order.push(3);
      return 'c';
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('tasks for different keys execute in parallel', async () => {
    const enqueue = createSequentialQueue({ taskTimeoutMs: 5000 });
    const log = [];
    const start = Date.now();

    const p1 = enqueue('a', async () => {
      await new Promise((r) => setTimeout(r, 50));
      log.push('a');
    });
    const p2 = enqueue('b', async () => {
      await new Promise((r) => setTimeout(r, 50));
      log.push('b');
    });

    await Promise.all([p1, p2]);
    const elapsed = Date.now() - start;
    // Parallel: should complete in ~50ms, not ~100ms
    expect(elapsed).toBeLessThan(150);
    expect(log).toContain('a');
    expect(log).toContain('b');
  });

  test('returns task results', async () => {
    const enqueue = createSequentialQueue({ taskTimeoutMs: 5000 });
    const result = await enqueue('key', async () => 42);
    expect(result).toBe(42);
  });

  test('propagates task errors', async () => {
    const enqueue = createSequentialQueue({ taskTimeoutMs: 5000 });
    await expect(
      enqueue('key', async () => { throw new Error('task error'); })
    ).rejects.toThrow('task error');
  });

  test('subsequent tasks run even after earlier task failure', async () => {
    const enqueue = createSequentialQueue({ taskTimeoutMs: 5000 });
    const p1 = enqueue('key', async () => { throw new Error('fail'); }).catch(() => 'caught');
    const p2 = enqueue('key', async () => 'success');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('caught');
    expect(r2).toBe('success');
  });
});

describe('createSequentialQueue — getPending', () => {
  test('tracks pending count per key', async () => {
    const enqueue = createSequentialQueue({ taskTimeoutMs: 5000 });
    let resolve1;
    const p1 = enqueue('key', () => new Promise((r) => { resolve1 = r; }));
    enqueue('key', async () => 'done');

    expect(enqueue.getPending('key')).toBe(2);
    // The first task's Promise executor only runs once the queue dispatches it
    // on a microtask, so resolve1 is assigned asynchronously — wait for it.
    await new Promise((r) => setTimeout(r, 0));
    resolve1();
    await p1;
    // After first task resolves, pending count should decrease
    // Wait for microtask
    await new Promise((r) => setTimeout(r, 10));
    expect(enqueue.getPending('key')).toBeLessThanOrEqual(1);
  });
});

describe('createSequentialQueue — task timeout', () => {
  test('advances queue when task exceeds timeout', async () => {
    const onTaskTimeout = jest.fn();
    const enqueue = createSequentialQueue({
      taskTimeoutMs: 50,
      onTaskTimeout,
    });

    const p1 = enqueue('key', async () => {
      await new Promise((r) => setTimeout(r, 5000)); // hangs
    });
    const p2 = enqueue('key', async () => 'task2-done');

    const result = await p2;
    expect(result).toBe('task2-done');
    expect(onTaskTimeout).toHaveBeenCalledWith('key', 50);
  });
});

describe('constants', () => {
  test('DEFAULT_TASK_TIMEOUT_MS is 5 minutes', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(300000);
  });
});
