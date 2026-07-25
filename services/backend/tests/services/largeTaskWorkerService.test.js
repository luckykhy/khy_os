'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLargeTaskRuntimeStore } = require('../../src/tasks/largeTaskRuntimeStore');
const { createLargeTaskOrchestrator } = require('../../src/tasks/largeTaskOrchestrator');
const { createLargeTaskWorkerService } = require('../../src/tasks/largeTaskWorkerService');

describe('largeTaskWorkerService', () => {
  let tempDir;
  let storePath;
  let nowMs;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-large-task-worker-'));
    storePath = path.join(tempDir, 'runtime.json');
    nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function buildRuntime() {
    return createLargeTaskRuntimeStore({
      storePath,
      nowFn: () => nowMs,
    });
  }

  test('supports idempotent start and stop with stable status snapshots', async () => {
    const runtime = buildRuntime();
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'worker-start-stop',
    });
    const worker = createLargeTaskWorkerService({
      runtime,
      orchestrator,
      nowFn: () => nowMs,
      taskHandler: async () => ({ ok: true }),
      defaultConfig: {
        interval_ms: 5_000,
        max_runs_per_tick: 1,
        dry_run: true,
        commit: false,
      },
    });

    const firstStart = await worker.start({ run_now: false });
    expect(firstStart.started).toBe(true);
    expect(firstStart.status.running).toBe(true);

    const secondStart = await worker.start({ run_now: false, interval_ms: 3_000 });
    expect(secondStart.started).toBe(false);
    expect(secondStart.status.running).toBe(true);
    expect(secondStart.status.config.interval_ms).toBe(3_000);

    const firstStop = await worker.stop();
    expect(firstStop.stopped).toBe(true);
    expect(firstStop.status.running).toBe(false);

    const secondStop = await worker.stop();
    expect(secondStop.stopped).toBe(false);
    expect(secondStop.status.running).toBe(false);
  });

  test('consumes queued tasks in runTick', async () => {
    const runtime = buildRuntime();
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'worker-consume',
    });
    const worker = createLargeTaskWorkerService({
      runtime,
      orchestrator,
      nowFn: () => nowMs,
      taskHandler: async (ctx) => ({ task_id: ctx.taskId }),
      defaultConfig: {
        dry_run: true,
        commit: false,
        max_runs_per_tick: 2,
      },
    });

    const task = runtime.createTask({
      type: 'worker-consume-task',
      max_attempts: 3,
      payload_json: { source: 'test' },
    });

    const summary = await worker.runTick({ trigger: 'test_consume' });
    expect(summary.executed).toBe(1);
    expect(summary.succeeded).toBe(1);

    const updated = runtime.getTask(task.id);
    expect(updated.status).toBe('succeeded');
    expect(worker.status().queue_depth).toBe(0);
  });

  test('does not execute retry_wait task before next_run_at is due', async () => {
    const runtime = buildRuntime();
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'worker-retry-due',
    });
    const attempts = new Map();
    const worker = createLargeTaskWorkerService({
      runtime,
      orchestrator,
      nowFn: () => nowMs,
      taskHandler: async (ctx) => {
        const count = (attempts.get(ctx.taskId) || 0) + 1;
        attempts.set(ctx.taskId, count);
        if (count === 1) {
          throw new Error('fail once');
        }
        return { attempt: count };
      },
      defaultConfig: {
        dry_run: false,
        commit: false,
        max_runs_per_tick: 1,
        retry_base_delay_ms: 5_000,
        retry_cap_delay_ms: 5_000,
        retry_jitter_pct: 0,
      },
    });

    const task = runtime.createTask({
      type: 'worker-retry-task',
      max_attempts: 3,
      payload_json: {},
    });

    const first = await worker.runTick({ trigger: 'retry_first' });
    expect(first.executed).toBe(1);
    expect(first.failed).toBe(1);
    expect(runtime.getTask(task.id).status).toBe('retry_wait');

    const second = await worker.runTick({ trigger: 'retry_not_due' });
    expect(second.executed).toBe(0);
    expect(runtime.getTask(task.id).status).toBe('retry_wait');

    nowMs += 5_100;
    const third = await worker.runTick({ trigger: 'retry_due' });
    expect(third.executed).toBe(1);
    expect(third.succeeded).toBe(1);
    expect(runtime.getTask(task.id).status).toBe('succeeded');
  });

  test('moves tasks to dead_letter after retry budget in worker loop', async () => {
    const runtime = buildRuntime();
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'worker-dead-letter',
    });
    const worker = createLargeTaskWorkerService({
      runtime,
      orchestrator,
      nowFn: () => nowMs,
      taskHandler: async () => {
        throw new Error('always fail');
      },
      defaultConfig: {
        dry_run: false,
        commit: false,
        max_runs_per_tick: 1,
        retry_base_delay_ms: 1_000,
        retry_cap_delay_ms: 1_000,
        retry_jitter_pct: 0,
      },
    });

    const task = runtime.createTask({
      type: 'worker-dead-letter-task',
      max_attempts: 2,
      payload_json: {},
    });

    const first = await worker.runTick({ trigger: 'dead_letter_first' });
    expect(first.executed).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.dead_letter).toBe(0);
    expect(runtime.getTask(task.id).status).toBe('retry_wait');

    nowMs += 1_100;
    const second = await worker.runTick({ trigger: 'dead_letter_second' });
    expect(second.executed).toBe(1);
    expect(second.failed).toBe(1);
    expect(second.dead_letter).toBe(1);

    const finalTask = runtime.getTask(task.id);
    expect(finalTask.status).toBe('dead_letter');
    expect(finalTask.attempt_count).toBe(2);
  });

  test('propagates idle timeout config and retries idle tasks', async () => {
    const runtime = buildRuntime();
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'worker-idle-timeout',
    });
    const worker = createLargeTaskWorkerService({
      runtime,
      orchestrator,
      nowFn: () => nowMs,
      taskHandler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { done: true };
      },
      defaultConfig: {
        dry_run: true,
        commit: false,
        max_runs_per_tick: 1,
        idle_timeout_ms: 30,
        retry_base_delay_ms: 1_000,
        retry_cap_delay_ms: 1_000,
        retry_jitter_pct: 0,
      },
    });

    const task = runtime.createTask({
      type: 'worker-idle-timeout-task',
      max_attempts: 3,
      payload_json: {},
    });

    const summary = await worker.runTick({ trigger: 'idle_timeout' });
    expect(summary.executed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.retry_scheduled).toBe(1);
    expect(worker.status().config.idle_timeout_ms).toBe(30);

    const updated = runtime.getTask(task.id);
    expect(updated.status).toBe('retry_wait');
    expect(updated.last_error.type).toBe('task_idle_timeout');
  });

  test('propagates retry_policy config and disables retry when configured', async () => {
    const runtime = buildRuntime();
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'worker-policy-config',
    });
    const worker = createLargeTaskWorkerService({
      runtime,
      orchestrator,
      nowFn: () => nowMs,
      taskHandler: async () => {
        throw new Error('generic worker failure');
      },
      defaultConfig: {
        dry_run: true,
        commit: false,
        max_runs_per_tick: 1,
        retry_policy: {
          default_retryable: false,
        },
      },
    });

    const task = runtime.createTask({
      type: 'worker-policy-task',
      max_attempts: 3,
      payload_json: {},
    });

    const summary = await worker.runTick({ trigger: 'retry_policy' });
    expect(summary.executed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.retry_scheduled).toBe(0);
    expect(worker.status().config.retry_policy.default_retryable).toBe(false);

    const updated = runtime.getTask(task.id);
    expect(updated.status).toBe('failed');
    expect(updated.last_error.retry_classification).toBe('default_non_retryable');
  });
});
