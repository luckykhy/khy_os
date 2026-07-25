'use strict';

const runtimeStore = require('./largeTaskRuntimeStore');
const { getBreaker } = require('../services/circuitBreaker');

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const CANCELLATION_STATES = new Set(['cancelling', 'cancelled']);
const PAUSE_STATES = new Set(['pausing', 'paused']);
const DEFAULT_COMMIT_BREAKER_OPTIONS = Object.freeze({
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  maxResetTimeoutMs: 300_000,
  backoffMultiplier: 2,
  slidingWindowMs: 120_000,
  halfOpenMaxProbes: 1,
  successThreshold: 1,
});

function createLargeTaskOrchestrator(options = {}) {
  const runtime = options.runtime || runtimeStore;
  const workerId = String(options.workerId || 'large-task-orchestrator');
  const commitBreakerNamespace = String(options.commitCircuitBreakerNamespace || `large_task_commit:${workerId}`);
  const commitBreakerOptions = {
    ...DEFAULT_COMMIT_BREAKER_OPTIONS,
    ...(options.commitCircuitBreakerOptions && typeof options.commitCircuitBreakerOptions === 'object'
      ? options.commitCircuitBreakerOptions
      : {}),
  };

  function _normalizeScope(scope) {
    return String(scope || 'default')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'default';
  }

  function _getCommitBreaker(scope) {
    const normalizedScope = _normalizeScope(scope);
    const breakerName = `${commitBreakerNamespace}:${normalizedScope}`;
    return getBreaker(breakerName, commitBreakerOptions);
  }

  function createTask(input = {}) {
    return runtime.createTask({
      type: input.type || 'large_task',
      payload_json: input.payload_json || {},
      priority: input.priority,
      max_attempts: input.max_attempts,
      idempotency_key: input.idempotency_key || null,
      trace_id: input.trace_id || null,
      next_run_at: input.next_run_at || null,
    });
  }

  async function runTask(taskId, handler, runOptions = {}) {
    if (typeof handler !== 'function') {
      throw new Error('runTask requires a handler function');
    }

    const leaseMs = Math.max(1_000, Number(runOptions.lease_ms || DEFAULT_LEASE_MS) || DEFAULT_LEASE_MS);
    const heartbeatMs = Math.max(500, Number(runOptions.heartbeat_ms || DEFAULT_HEARTBEAT_MS) || DEFAULT_HEARTBEAT_MS);
    const idleTimeoutInput = Number(runOptions.idle_timeout_ms);
    const idleTimeoutMs = Number.isFinite(idleTimeoutInput)
      ? (idleTimeoutInput <= 0 ? 0 : Math.max(1, Math.round(idleTimeoutInput)))
      : DEFAULT_IDLE_TIMEOUT_MS;
    const allowedCheckpointSchemas = Array.isArray(runOptions.allowed_checkpoint_schema_versions)
      ? runOptions.allowed_checkpoint_schema_versions
      : null;
    const dryRun = runOptions.dry_run !== false;
    const commitEnabled = runOptions.commit === true;
    const signal = runOptions.signal || null;

    let task = runtime.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (task.status === 'queued' || task.status === 'retry_wait') {
      if (task.status === 'retry_wait') {
        runtime.updateTaskFields(taskId, { next_run_at: new Date().toISOString() });
      }
      const claimed = runtime.claimTask(taskId, workerId, { leaseMs });
      if (!claimed) {
        return {
          ok: false,
          code: 'not_claimed',
          message: `Task ${taskId} is not claimable yet`,
        };
      }
      task = claimed;
    }

    if (task.status === 'claimed') {
      task = runtime.startTask(taskId, workerId);
    } else if (task.status !== 'running') {
      throw new Error(`Task ${taskId} is not runnable from status "${task.status}"`);
    }

    const checkpoint = runtime.getLatestCheckpoint(taskId, {
      allowed_schema_versions: allowedCheckpointSchemas,
    });

    let heartbeatTimer = null;
    let idleWatchdogTimer = null;
    let idleTimeoutError = null;
    let lastActivityMs = Date.now();
    let startedAt = Date.now();

    const stopHeartbeat = () => {
      if (!heartbeatTimer) return;
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };

    const stopIdleWatchdog = () => {
      if (!idleWatchdogTimer) return;
      clearInterval(idleWatchdogTimer);
      idleWatchdogTimer = null;
    };

    const markActivity = () => {
      lastActivityMs = Date.now();
    };

    const buildIdleTimeoutError = (idleForMs) => {
      const timeoutError = new Error(
        `task idle timeout exceeded: idle ${idleForMs}ms > limit ${idleTimeoutMs}ms`
      );
      timeoutError.type = 'task_idle_timeout';
      timeoutError.retryable = true;
      timeoutError.idle_for_ms = idleForMs;
      timeoutError.idle_timeout_ms = idleTimeoutMs;
      return timeoutError;
    };

    const ensureWithinIdleWindow = (throwOnViolation = true) => {
      if (idleTimeoutMs <= 0) return;
      const idleForMs = Date.now() - lastActivityMs;
      if (idleForMs <= idleTimeoutMs) return;
      if (!idleTimeoutError) {
        idleTimeoutError = buildIdleTimeoutError(idleForMs);
      }
      if (throwOnViolation) {
        throw idleTimeoutError;
      }
    };

    heartbeatTimer = setInterval(() => {
      try {
        runtime.heartbeatTask(taskId, workerId, { leaseMs });
      } catch {
        // Best-effort heartbeat.
      }
    }, heartbeatMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    if (idleTimeoutMs > 0) {
      const idleCheckIntervalMs = Math.max(200, Math.min(2_000, Math.round(idleTimeoutMs / 4)));
      idleWatchdogTimer = setInterval(() => {
        ensureWithinIdleWindow(false);
      }, idleCheckIntervalMs);
      if (idleWatchdogTimer.unref) idleWatchdogTimer.unref();
    }

    const ensureNotCancelled = () => {
      ensureWithinIdleWindow(true);
      if (idleTimeoutError) {
        throw idleTimeoutError;
      }
      if (signal?.aborted) {
        const reason = signal.reason ? String(signal.reason) : 'aborted';
        throw new Error(`task aborted: ${reason}`);
      }
      const latest = runtime.getTask(taskId);
      if (!latest) {
        const missingError = new Error(`task missing: ${taskId}`);
        missingError.type = 'task_missing';
        throw missingError;
      }
      if (CANCELLATION_STATES.has(latest.status)) {
        const cancelledError = new Error(`task cancelled by control plane: ${latest.status}`);
        cancelledError.type = 'task_cancelled';
        throw cancelledError;
      }
      if (PAUSE_STATES.has(latest.status)) {
        const pausedError = new Error(`task paused by control plane: ${latest.status}`);
        pausedError.type = 'task_paused';
        throw pausedError;
      }
    };

    const ctx = {
      taskId,
      workerId,
      traceId: task.trace_id,
      attemptNo: Number(task.attempt_count || 0) + 1,
      dryRun,
      commitEnabled,
      checkpoint,
      payload: task.payload_json || {},
      signal,
      ensureNotCancelled,
      markActivity,
      heartbeat: () => {
        ensureNotCancelled();
        const hb = runtime.heartbeatTask(taskId, workerId, { leaseMs });
        markActivity();
        return hb;
      },
      reportProgress: (progressPct) => {
        ensureNotCancelled();
        const updated = runtime.updateTaskFields(taskId, {
          progress_pct: progressPct,
          heartbeat_at: new Date().toISOString(),
        });
        markActivity();
        return updated;
      },
      saveCheckpoint: (cp) => {
        ensureNotCancelled();
        const saved = runtime.saveCheckpoint(taskId, cp || {});
        markActivity();
        return saved;
      },
      loadCheckpoint: () => {
        ensureNotCancelled();
        const loaded = runtime.getLatestCheckpoint(taskId, {
          allowed_schema_versions: allowedCheckpointSchemas,
        });
        markActivity();
        return loaded;
      },
      plan: async (fn) => {
        if (typeof fn !== 'function') return null;
        ensureNotCancelled();
        const planned = await fn({
          taskId,
          workerId,
          traceId: task.trace_id,
          dryRun: true,
          checkpoint,
          payload: task.payload_json || {},
          signal,
          ensureNotCancelled,
        });
        markActivity();
        return planned;
      },
      commit: async (input = {}) => {
        const {
          scope = task.type || 'large_task',
          idempotency_key: idempotencyKey,
          intent_hash: intentHash,
          executor,
        } = input || {};

        if (dryRun || !commitEnabled) {
          return {
            ok: false,
            code: 'commit_required',
            dry_run: dryRun,
            message: 'Side-effect operation requires commit=true and dry_run=false',
          };
        }

        const resolvedKey = String(idempotencyKey || task.idempotency_key || '').trim();
        if (!resolvedKey) {
          return {
            ok: false,
            code: 'idempotency_key_required',
            message: 'Side-effect operation requires idempotency_key',
          };
        }
        if (typeof executor !== 'function') {
          return {
            ok: false,
            code: 'executor_required',
            message: 'Side-effect operation requires executor function',
          };
        }

        ensureNotCancelled();
        const breaker = _getCommitBreaker(scope);
        try {
          const committed = await breaker.execute(async () => runtime.executeIdempotentSideEffect({
            scope,
            idempotency_key: resolvedKey,
            intent_hash: intentHash || null,
            executor,
          }));
          markActivity();
          return committed;
        } catch (error) {
          if (String(error?.name || '') === 'CircuitBreakerOpenError') {
            const retryAfterMs = Number(error?.retryAfterMs || 0);
            markActivity();
            return {
              ok: false,
              code: 'circuit_open',
              scope: _normalizeScope(scope),
              message: `Side-effect circuit is open for scope "${_normalizeScope(scope)}"`,
              retry_after_ms: retryAfterMs,
              breaker: breaker.getStatus(),
            };
          }
          throw error;
        }
      },
    };

    try {
      markActivity();
      ensureNotCancelled();
      if (checkpoint) {
        runtime.resumeFromCheckpoint(taskId, {
          allowed_schema_versions: allowedCheckpointSchemas,
        });
        markActivity();
      }
      const result = await handler(ctx);
      ensureNotCancelled();
      const succeeded = runtime.markSucceeded(taskId, workerId, result ?? null, { progress_pct: 100 });
      stopHeartbeat();
      stopIdleWatchdog();
      return {
        ok: true,
        task: succeeded,
        result: result ?? null,
        latency_ms: Date.now() - startedAt,
      };
    } catch (error) {
      stopHeartbeat();
      stopIdleWatchdog();
      if (String(error?.type || '').trim() === 'task_cancelled') {
        const cancelledTask = runtime.cancelTask(taskId, error?.message || 'cancelled by control plane');
        return {
          ok: false,
          cancelled: true,
          task: cancelledTask,
          retry_scheduled: false,
          dead_letter: false,
          retry_delay_ms: 0,
          error: {
            type: 'task_cancelled',
            message: String(error?.message || 'task cancelled'),
          },
          latency_ms: Date.now() - startedAt,
        };
      }
      if (String(error?.type || '').trim() === 'task_paused') {
        const pausedTask = runtime.getTask(taskId);
        return {
          ok: false,
          paused: true,
          task: pausedTask,
          retry_scheduled: false,
          dead_letter: false,
          retry_delay_ms: 0,
          error: {
            type: 'task_paused',
            message: String(error?.message || 'task paused'),
          },
          latency_ms: Date.now() - startedAt,
        };
      }
      const failed = runtime.markFailed(taskId, workerId, error, {
        retry_base_delay_ms: runOptions.retry_base_delay_ms,
        retry_cap_delay_ms: runOptions.retry_cap_delay_ms,
        jitter_pct: runOptions.retry_jitter_pct,
        retry_policy: runOptions.retry_policy || runOptions.retryPolicy || null,
      });
      return {
        ok: false,
        task: failed.task,
        retry_scheduled: Boolean(failed.retry_scheduled),
        dead_letter: Boolean(failed.dead_letter),
        retry_delay_ms: Number(failed.retry_delay_ms || 0),
        error: {
          type: String(error?.type || error?.code || 'error'),
          message: String(error?.message || error || 'Task failed'),
        },
        latency_ms: Date.now() - startedAt,
      };
    }
  }

  async function runNext(handler, runOptions = {}) {
    if (typeof handler !== 'function') {
      throw new Error('runNext requires a handler function');
    }
    runtime.requeueExpiredLeases();
    const leaseMs = Math.max(1_000, Number(runOptions.lease_ms || DEFAULT_LEASE_MS) || DEFAULT_LEASE_MS);
    const claimed = runtime.claimNextTask(workerId, { leaseMs });
    if (!claimed) return null;
    return runTask(claimed.id, handler, runOptions);
  }

  return {
    createTask,
    runTask,
    runNext,
    getMetrics: () => runtime.getMetricsSnapshot(),
    getTaskAudit: (taskId) => runtime.getTaskAudit(taskId),
    getCommitCircuitStatus: (scope) => _getCommitBreaker(scope).getStatus(),
  };
}

const defaultOrchestrator = createLargeTaskOrchestrator();

module.exports = {
  createLargeTaskOrchestrator,
  ...defaultOrchestrator,
};
