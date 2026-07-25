'use strict';

/**
 * sequentialQueue.js — Per-key serial task queue with deadlock prevention.
 *
 * Ported from OpenClaw's sequential-queue.ts.
 * Provides:
 *   - FIFO execution per key (same key = serial, different keys = parallel)
 *   - Bounded blocking time to prevent starvation
 *   - Automatic cleanup on promise settlement
 *   - Task timeout eviction (task continues in background, queue advances)
 */

const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create a per-key sequential queue.
 *
 * @param {object} [options]
 * @param {number} [options.taskTimeoutMs=300000] - Max time per task (0 = no timeout)
 * @param {function} [options.onTaskTimeout] - (key, timeoutMs) => void
 * @returns {function(key: string, task: () => Promise<void>): Promise<void>}
 *
 * @example
 *   const enqueue = createSequentialQueue({ taskTimeoutMs: 10000 });
 *   // Same key → serial execution
 *   enqueue('exchange-binance', () => submitOrder(order1));
 *   enqueue('exchange-binance', () => submitOrder(order2));
 *   // Different key → parallel execution
 *   enqueue('exchange-okx', () => submitOrder(order3));
 */
function createSequentialQueue(options = {}) {
  const queues = new Map();
  const pendingCounts = new Map();
  const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  const enqueue = function enqueue(key, task) {
    const queueKey = String(key || '');
    const previous = queues.get(queueKey) || Promise.resolve();
    pendingCounts.set(queueKey, (pendingCounts.get(queueKey) || 0) + 1);
    const wrapped = async () => {
      try {
        return await _boundedRun(queueKey, task, taskTimeoutMs, options.onTaskTimeout);
      } finally {
        const left = (pendingCounts.get(queueKey) || 1) - 1;
        if (left > 0) pendingCounts.set(queueKey, left);
        else pendingCounts.delete(queueKey);
      }
    };
    const next = previous.then(wrapped, wrapped);
    queues.set(queueKey, next);

    // Cleanup: remove from map when this promise settles
    // (only if it's still the latest for this key)
    const cleanup = () => {
      if (queues.get(queueKey) === next) {
        queues.delete(queueKey);
      }
    };
    next.then(cleanup, cleanup);

    return next;
  };

  enqueue.getPending = (key) => pendingCounts.get(String(key || '')) || 0;
  return enqueue;
}

/**
 * Run a task with a timeout boundary.
 * If the task exceeds the timeout, the queue advances and the task
 * is signalled to abort via AbortController.
 */
async function _boundedRun(key, task, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return task();
  }

  const abortController = new AbortController();
  let timeoutHandle;
  const timeoutToken = Symbol('queue-timeout');
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      try { onTimeout?.(key, timeoutMs); } catch {}
      // Signal the task to abort so it doesn't continue as an orphan
      abortController.abort(new Error(`Queue task timeout (${timeoutMs}ms)`));
      resolve(timeoutToken);
    }, timeoutMs);
    if (timeoutHandle.unref) timeoutHandle.unref();
  });

  try {
    const raceResult = await Promise.race([task(abortController.signal), timeoutPromise]);
    if (raceResult === timeoutToken) return undefined;
    return raceResult;
  } catch (err) {
    // If the task threw because of abort, return gracefully
    if (abortController.signal.aborted) return undefined;
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    // Ensure abort on any exit path (task finished or timed out)
    if (!abortController.signal.aborted) abortController.abort();
  }
}

module.exports = {
  createSequentialQueue,
  DEFAULT_TASK_TIMEOUT_MS,
};
