'use strict';

/**
 * concurrencyLimiter.js — Async concurrency limiter utility.
 *
 * Ported from OpenClaw's run-with-concurrency.ts.
 * Controls parallel execution slots for async task batches.
 * Worker pool pattern with atomic task acquisition.
 *
 * Error modes:
 *   'continue' — Execute all tasks, collect errors
 *   'stop'     — Halt remaining tasks on first error
 *
 * Usage:
 *   const { results, hasError } = await runWithConcurrency({
 *     tasks: urls.map(u => () => fetch(u)),
 *     limit: 5,
 *   });
 */

/**
 * Run async tasks with controlled concurrency.
 *
 * @param {object} params
 * @param {Array<function>} params.tasks - Array of () => Promise<T>
 * @param {number} params.limit - Max concurrent executions
 * @param {'continue'|'stop'} [params.errorMode='continue'] - Error handling mode
 * @param {function} [params.onTaskError] - (error, index) => void
 * @param {function} [params.onTaskComplete] - (result, index) => void
 * @returns {Promise<{ results: T[], firstError: unknown, hasError: boolean }>}
 */
async function runWithConcurrency(params) {
  const { tasks, limit, onTaskError, onTaskComplete } = params;
  const errorMode = params.errorMode || 'continue';

  if (tasks.length === 0) {
    return { results: [], firstError: undefined, hasError: false };
  }

  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results = new Array(tasks.length);
  let next = 0;
  let firstError;
  let hasError = false;

  // Worker pool: each worker pulls tasks from shared counter
  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      // Early exit on stop mode
      if (errorMode === 'stop' && hasError) return;

      // Atomic task acquisition (safe in single-threaded JS)
      const index = next++;
      if (index >= tasks.length) return;

      try {
        results[index] = await tasks[index]();
        if (onTaskComplete) onTaskComplete(results[index], index);
      } catch (error) {
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
        if (onTaskError) onTaskError(error, index);
        if (errorMode === 'stop') return;
      }
    }
  });

  await Promise.allSettled(workers);
  return { results, firstError, hasError };
}

/**
 * Run tasks with concurrency and timeout per task.
 *
 * @param {object} params - Same as runWithConcurrency + timeoutMs
 * @param {number} [params.timeoutMs=30000] - Per-task timeout
 * @returns {Promise<{ results: T[], firstError: unknown, hasError: boolean }>}
 */
async function runWithConcurrencyAndTimeout(params) {
  const timeoutMs = params.timeoutMs || 30_000;

  const wrappedTasks = params.tasks.map((task, i) => () => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Task ${i} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (timer.unref) timer.unref();

      task().then(
        result => { clearTimeout(timer); resolve(result); },
        error => { clearTimeout(timer); reject(error); }
      );
    });
  });

  return runWithConcurrency({ ...params, tasks: wrappedTasks });
}

/**
 * Simple concurrency-limited map.
 *
 * @param {T[]} items
 * @param {function} fn - (item: T, index: number) => Promise<R>
 * @param {number} limit
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, fn, limit) {
  const tasks = items.map((item, i) => () => fn(item, i));
  const { results, firstError, hasError } = await runWithConcurrency({
    tasks,
    limit,
    errorMode: 'continue',
  });
  if (hasError) throw firstError;
  return results;
}

module.exports = {
  runWithConcurrency,
  runWithConcurrencyAndTimeout,
  mapWithConcurrency,
};
