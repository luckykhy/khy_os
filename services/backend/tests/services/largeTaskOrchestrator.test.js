'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLargeTaskRuntimeStore } = require('../../src/tasks/largeTaskRuntimeStore');
const { createLargeTaskOrchestrator } = require('../../src/tasks/largeTaskOrchestrator');
const { resetAll: resetCircuitBreakers } = require('../../src/services/circuitBreaker');

describe('largeTaskOrchestrator', () => {
  let tempDir;
  let storePath;

  beforeEach(() => {
    resetCircuitBreakers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-large-task-orch-'));
    storePath = path.join(tempDir, 'runtime.json');
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('runs plan and commit phases with idempotent side effects', async () => {
    const runtime = createLargeTaskRuntimeStore({ storePath });
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'orch-worker',
    });
    const task = orchestrator.createTask({
      type: 'orch-task',
      payload_json: { value: 1 },
      max_attempts: 3,
    });

    let commitCount = 0;
    const result = await orchestrator.runTask(task.id, async (ctx) => {
      const plan = await ctx.plan(async (draft) => ({
        dryRun: draft.dryRun,
        checkpoint: draft.checkpoint,
      }));
      expect(plan.dryRun).toBe(true);

      const committed = await ctx.commit({
        scope: 'orch',
        idempotency_key: 'idem-orch-1',
        intent_hash: 'intent-orch-1',
        executor: async () => {
          commitCount++;
          return { committed: true };
        },
      });
      expect(committed.ok).toBe(true);
      return { plan, committed: committed.result };
    }, {
      dry_run: false,
      commit: true,
      heartbeat_ms: 500,
      lease_ms: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(commitCount).toBe(1);
    expect(result.task.status).toBe('succeeded');
  });

  test('returns dead letter after repeated failures', async () => {
    const runtime = createLargeTaskRuntimeStore({ storePath });
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'orch-worker',
    });
    const task = orchestrator.createTask({
      type: 'orch-fail-task',
      max_attempts: 2,
    });

    const first = await orchestrator.runTask(task.id, async () => {
      throw new Error('transient failure');
    }, {
      dry_run: false,
      commit: false,
      heartbeat_ms: 500,
      lease_ms: 10_000,
      retry_base_delay_ms: 1,
      retry_cap_delay_ms: 1,
      retry_jitter_pct: 0,
    });

    expect(first.ok).toBe(false);
    expect(first.retry_scheduled).toBe(true);

    const runtimeTask = runtime.getTask(task.id);
    runtime.updateTaskFields(task.id, { next_run_at: new Date(Date.now() - 1000).toISOString() });

    const second = await orchestrator.runTask(task.id, async () => {
      throw new Error('final failure');
    }, {
      dry_run: false,
      commit: false,
      heartbeat_ms: 500,
      lease_ms: 10_000,
      retry_base_delay_ms: 1,
      retry_cap_delay_ms: 1,
      retry_jitter_pct: 0,
    });

    expect(second.ok).toBe(false);
    expect(second.dead_letter).toBe(true);
    expect(runtime.getTask(task.id).status).toBe('dead_letter');
    expect(runtimeTask.id).toBe(task.id);
  });

  test('uses checkpoint data on restart', async () => {
    const runtimeA = createLargeTaskRuntimeStore({ storePath });
    const orchestratorA = createLargeTaskOrchestrator({
      runtime: runtimeA,
      workerId: 'orch-worker',
    });
    const task = orchestratorA.createTask({
      type: 'orch-checkpoint-task',
      max_attempts: 3,
    });
    runtimeA.saveCheckpoint(task.id, {
      step_no: 3,
      progress_pct: 45,
      schema_version: 1,
      state_blob_json: { step: 3 },
    });

    const runtimeB = createLargeTaskRuntimeStore({ storePath });
    const orchestratorB = createLargeTaskOrchestrator({
      runtime: runtimeB,
      workerId: 'orch-worker',
    });
    const result = await orchestratorB.runTask(task.id, async (ctx) => {
      expect(ctx.checkpoint.step_no).toBe(3);
      return { resumed: true };
    }, {
      dry_run: true,
      commit: false,
      heartbeat_ms: 500,
      lease_ms: 10_000,
      allowed_checkpoint_schema_versions: [1],
    });

    expect(result.ok).toBe(true);
    expect(result.result.resumed).toBe(true);
  });

  test('marks task as cancelled when control plane cancels during execution', async () => {
    const runtime = createLargeTaskRuntimeStore({ storePath });
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'orch-worker',
    });
    const task = orchestrator.createTask({
      type: 'orch-cancel-task',
      max_attempts: 3,
    });

    const runPromise = orchestrator.runTask(task.id, async (ctx) => {
      for (let i = 0; i < 10; i += 1) {
        ctx.ensureNotCancelled();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { done: true };
    }, {
      dry_run: true,
      commit: false,
      heartbeat_ms: 500,
      lease_ms: 10_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    runtime.cancelTask(task.id, 'cancelled in test');

    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.error.type).toBe('task_cancelled');
    expect(runtime.getTask(task.id).status).toBe('cancelled');
  });

  test('returns paused result when control plane pauses during execution', async () => {
    const runtime = createLargeTaskRuntimeStore({ storePath });
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'orch-worker',
    });
    const task = orchestrator.createTask({
      type: 'orch-pause-task',
      max_attempts: 3,
    });

    const runPromise = orchestrator.runTask(task.id, async (ctx) => {
      for (let i = 0; i < 50; i += 1) {
        ctx.ensureNotCancelled();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { done: true };
    }, {
      dry_run: true,
      commit: false,
      heartbeat_ms: 500,
      lease_ms: 10_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    runtime.transitionTask(task.id, 'pausing');
    runtime.transitionTask(task.id, 'paused');

    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.paused).toBe(true);
    expect(result.retry_scheduled).toBe(false);
    expect(result.error.type).toBe('task_paused');
    expect(runtime.getTask(task.id).status).toBe('paused');
  });

  test('times out idle execution using sliding activity timeout', async () => {
    const runtime = createLargeTaskRuntimeStore({ storePath });
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'orch-worker',
    });
    const task = orchestrator.createTask({
      type: 'orch-idle-timeout-task',
      max_attempts: 3,
    });

    const result = await orchestrator.runTask(task.id, async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { done: true };
    }, {
      dry_run: true,
      commit: false,
      heartbeat_ms: 500,
      lease_ms: 10_000,
      idle_timeout_ms: 40,
      retry_base_delay_ms: 1,
      retry_cap_delay_ms: 1,
      retry_jitter_pct: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.retry_scheduled).toBe(true);
    expect(result.error.type).toBe('task_idle_timeout');
    expect(runtime.getTask(task.id).status).toBe('retry_wait');
  });

  test('does not idle-timeout when handler keeps reporting activity', async () => {
    const runtime = createLargeTaskRuntimeStore({ storePath });
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'orch-worker',
    });
    const task = orchestrator.createTask({
      type: 'orch-idle-active-task',
      max_attempts: 3,
    });

    const result = await orchestrator.runTask(task.id, async (ctx) => {
      for (let i = 0; i < 5; i += 1) {
        ctx.markActivity();
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      return { done: true };
    }, {
      dry_run: true,
      commit: false,
      heartbeat_ms: 500,
      lease_ms: 10_000,
      idle_timeout_ms: 30,
    });

    expect(result.ok).toBe(true);
    expect(result.task.status).toBe('succeeded');
  });

  test('opens side-effect circuit breaker after repeated commit failures and fails fast', async () => {
    const runtime = createLargeTaskRuntimeStore({ storePath });
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'orch-worker',
      commitCircuitBreakerOptions: {
        failureThreshold: 2,
        resetTimeoutMs: 60_000,
        maxResetTimeoutMs: 60_000,
        slidingWindowMs: 60_000,
        successThreshold: 1,
      },
    });

    const createAndRun = async (taskType) => {
      const task = orchestrator.createTask({
        type: taskType,
        max_attempts: 1,
      });
      return orchestrator.runTask(task.id, async (ctx) => {
        const commitResult = await ctx.commit({
          scope: 'external_api',
          idempotency_key: `${taskType}-idem`,
          intent_hash: `${taskType}-intent`,
          executor: async () => {
            throw new Error('downstream unavailable');
          },
        });
        return { commitResult };
      }, {
        dry_run: false,
        commit: true,
      });
    };

    const first = await createAndRun('orch-cb-1');
    expect(first.ok).toBe(false);
    expect(first.error.message).toContain('downstream unavailable');

    const second = await createAndRun('orch-cb-2');
    expect(second.ok).toBe(false);
    expect(second.error.message).toContain('downstream unavailable');

    const thirdTask = orchestrator.createTask({
      type: 'orch-cb-3',
      max_attempts: 1,
    });
    const third = await orchestrator.runTask(thirdTask.id, async (ctx) => {
      const commitResult = await ctx.commit({
        scope: 'external_api',
        idempotency_key: 'orch-cb-3-idem',
        intent_hash: 'orch-cb-3-intent',
        executor: async () => ({ ok: true }),
      });
      expect(commitResult.ok).toBe(false);
      expect(commitResult.code).toBe('circuit_open');
      expect(commitResult.breaker.state).toBe('open');
      return { commitResult };
    }, {
      dry_run: false,
      commit: true,
    });

    expect(third.ok).toBe(true);
    expect(third.result.commitResult.code).toBe('circuit_open');
    const breakerStatus = orchestrator.getCommitCircuitStatus('external_api');
    expect(breakerStatus.state).toBe('open');
  });

  test('does not retry non-retryable failures from handler', async () => {
    const runtime = createLargeTaskRuntimeStore({ storePath });
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'orch-worker',
    });
    const task = orchestrator.createTask({
      type: 'orch-non-retry-task',
      max_attempts: 4,
    });

    const err = new Error('validation failed');
    err.type = 'validation_error';
    err.retryable = false;

    const result = await orchestrator.runTask(task.id, async () => {
      throw err;
    }, {
      dry_run: false,
      commit: false,
      heartbeat_ms: 500,
      lease_ms: 10_000,
    });

    expect(result.ok).toBe(false);
    expect(result.retry_scheduled).toBe(false);
    expect(result.dead_letter).toBe(false);
    expect(runtime.getTask(task.id).status).toBe('failed');
  });

  test('respects run-level retry policy override for default non-retryable behavior', async () => {
    const runtime = createLargeTaskRuntimeStore({ storePath });
    const orchestrator = createLargeTaskOrchestrator({
      runtime,
      workerId: 'orch-worker',
    });
    const task = orchestrator.createTask({
      type: 'orch-policy-override-task',
      max_attempts: 4,
    });

    const result = await orchestrator.runTask(task.id, async () => {
      throw new Error('non classified failure');
    }, {
      dry_run: false,
      commit: false,
      heartbeat_ms: 500,
      lease_ms: 10_000,
      retry_policy: {
        default_retryable: false,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.retry_scheduled).toBe(false);
    expect(result.dead_letter).toBe(false);
    expect(runtime.getTask(task.id).status).toBe('failed');
    expect(runtime.getTask(task.id).last_error.retry_classification).toBe('default_non_retryable');
  });
});
