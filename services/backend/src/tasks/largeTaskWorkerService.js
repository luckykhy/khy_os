'use strict';

const runtimeStore = require('./largeTaskRuntimeStore');
const { createLargeTaskOrchestrator } = require('./largeTaskOrchestrator');

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 3_000;
const DEFAULT_RETRY_CAP_DELAY_MS = 300_000;
const DEFAULT_RETRY_JITTER_PCT = 0.2;
const DEFAULT_MAX_RUNS_PER_TICK = 3;

const _parseBoolean = (value, fallback = false) => require('../utils/parseBoolean')(value, fallback, { extended: false });

function _parseIntInRange(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function _parseFloatInRange(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function _normalizeSchemaVersions(value, fallback = null) {
  if (!Array.isArray(value)) return fallback;
  const versions = value
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  return versions.length > 0 ? versions : null;
}

function _normalizeRetryPolicy(value, fallback = null) {
  const source = (value && typeof value === 'object' && !Array.isArray(value))
    ? value
    : (fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : null);
  if (!source) return null;

  const out = {};
  if (Array.isArray(source.non_retryable_error_types)) {
    out.non_retryable_error_types = source.non_retryable_error_types
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (Array.isArray(source.non_retryable_status_codes)) {
    out.non_retryable_status_codes = source.non_retryable_status_codes
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isFinite(item));
  }
  if (Array.isArray(source.non_retryable_error_kinds)) {
    out.non_retryable_error_kinds = source.non_retryable_error_kinds
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (Array.isArray(source.retryable_error_kinds)) {
    out.retryable_error_kinds = source.retryable_error_kinds
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (typeof source.default_retryable === 'boolean') {
    out.default_retryable = source.default_retryable;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function _clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function _nowIso(nowFn) {
  return new Date(nowFn()).toISOString();
}

function _normalizeWorkerConfig(input = {}, fallback = {}) {
  const intervalMs = _parseIntInRange(input.interval_ms, fallback.interval_ms ?? DEFAULT_INTERVAL_MS, 200, 300_000);
  const leaseMs = _parseIntInRange(input.lease_ms, fallback.lease_ms ?? DEFAULT_LEASE_MS, 1_000, 600_000);
  const heartbeatMs = _parseIntInRange(input.heartbeat_ms, fallback.heartbeat_ms ?? DEFAULT_HEARTBEAT_MS, 500, 120_000);
  const idleTimeoutMs = _parseIntInRange(
    input.idle_timeout_ms,
    fallback.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
    0,
    24 * 60 * 60 * 1000
  );
  const retryBaseDelayMs = _parseIntInRange(
    input.retry_base_delay_ms,
    fallback.retry_base_delay_ms ?? DEFAULT_RETRY_BASE_DELAY_MS,
    200,
    3_600_000
  );
  const retryCapDelayMs = _parseIntInRange(
    input.retry_cap_delay_ms,
    fallback.retry_cap_delay_ms ?? DEFAULT_RETRY_CAP_DELAY_MS,
    retryBaseDelayMs,
    3_600_000
  );

  return {
    interval_ms: intervalMs,
    lease_ms: leaseMs,
    heartbeat_ms: heartbeatMs,
    idle_timeout_ms: idleTimeoutMs,
    retry_base_delay_ms: retryBaseDelayMs,
    retry_cap_delay_ms: retryCapDelayMs,
    retry_jitter_pct: _parseFloatInRange(
      input.retry_jitter_pct,
      fallback.retry_jitter_pct ?? DEFAULT_RETRY_JITTER_PCT,
      0,
      1
    ),
    dry_run: _parseBoolean(input.dry_run, fallback.dry_run !== false),
    commit: _parseBoolean(input.commit, fallback.commit === true),
    max_runs_per_tick: _parseIntInRange(
      input.max_runs_per_tick,
      fallback.max_runs_per_tick ?? DEFAULT_MAX_RUNS_PER_TICK,
      1,
      200
    ),
    allowed_checkpoint_schema_versions: _normalizeSchemaVersions(
      input.allowed_checkpoint_schema_versions,
      fallback.allowed_checkpoint_schema_versions ?? null
    ),
    retry_policy: _normalizeRetryPolicy(input.retry_policy || input.retryPolicy, fallback.retry_policy ?? null),
  };
}

function createLargeTaskWorkerService(options = {}) {
  const runtime = options.runtime || runtimeStore;
  const workerId = String(options.workerId || 'large-task-worker-service');
  const orchestrator = options.orchestrator || createLargeTaskOrchestrator({ runtime, workerId });
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  const logger = options.logger || null;
  const defaultTaskHandler = options.taskHandler || null;

  let timer = null;
  let tickPromise = null;
  let startedAt = null;
  let stoppedAt = null;
  let config = _normalizeWorkerConfig(options.defaultConfig || {}, {});

  let tickTotal = 0;
  let runTotal = 0;
  let runSuccessTotal = 0;
  let runFailureTotal = 0;
  let runRetryTotal = 0;
  let runDeadLetterTotal = 0;
  let lastTick = null;
  let lastError = null;

  function _logInfo(message) {
    if (!logger || typeof logger.info !== 'function') return;
    try { logger.info(message); } catch { /* ignore logger failure */ }
  }

  function _logWarn(message) {
    if (logger && typeof logger.warn === 'function') {
      try { logger.warn(message); } catch { /* ignore logger failure */ }
      return;
    }
    _logInfo(message);
  }

  function _resolveTaskHandler(candidate = null) {
    const resolved = typeof candidate === 'function' ? candidate : defaultTaskHandler;
    if (typeof resolved !== 'function') {
      throw new Error('Large task worker requires a task handler function');
    }
    return resolved;
  }

  function _compactRunResult(runResult) {
    if (!runResult || typeof runResult !== 'object') return null;
    return {
      task_id: runResult.task?.id || null,
      ok: Boolean(runResult.ok),
      code: runResult.code || null,
      retry_scheduled: Boolean(runResult.retry_scheduled),
      dead_letter: Boolean(runResult.dead_letter),
      latency_ms: Number(runResult.latency_ms || 0),
      error_message: runResult.error?.message || null,
    };
  }

  function _safeMetrics() {
    try {
      return runtime.getMetricsSnapshot();
    } catch {
      return { queue_depth: 0 };
    }
  }

  function _buildStatus() {
    const metrics = _safeMetrics();
    return {
      running: Boolean(timer),
      in_flight_tick: Boolean(tickPromise),
      worker_id: workerId,
      started_at: startedAt,
      stopped_at: stoppedAt,
      config: _clone(config),
      queue_depth: Number(metrics.queue_depth || 0),
      counters: {
        tick_total: tickTotal,
        run_total: runTotal,
        run_success_total: runSuccessTotal,
        run_failure_total: runFailureTotal,
        run_retry_total: runRetryTotal,
        run_dead_letter_total: runDeadLetterTotal,
      },
      last_tick: lastTick ? _clone(lastTick) : null,
      last_error: lastError ? _clone(lastError) : null,
    };
  }

  async function _executeTick({ trigger = 'manual', taskHandler }) {
    const tickConfig = _clone(config);
    const startMs = nowFn();
    const summary = {
      trigger,
      started_at: new Date(startMs).toISOString(),
      finished_at: null,
      duration_ms: 0,
      run_budget: tickConfig.max_runs_per_tick,
      queue_depth_before: Number(_safeMetrics().queue_depth || 0),
      queue_depth_after: 0,
      requeued_leases: 0,
      executed: 0,
      succeeded: 0,
      failed: 0,
      retry_scheduled: 0,
      dead_letter: 0,
      idle: true,
      last_run: null,
    };

    tickTotal += 1;
    _logInfo(
      `[LargeTaskWorker] Execute task queue tick target=large_tasks trigger=${trigger} ` +
      `run_budget=${summary.run_budget} queue_depth_before=${summary.queue_depth_before}`
    );

    try {
      const requeueResult = runtime.requeueExpiredLeases();
      summary.requeued_leases = Number(requeueResult?.requeued || 0);

      for (let index = 0; index < tickConfig.max_runs_per_tick; index += 1) {
        const runResult = await orchestrator.runNext(taskHandler, {
          dry_run: tickConfig.dry_run,
          commit: tickConfig.commit,
          lease_ms: tickConfig.lease_ms,
          heartbeat_ms: tickConfig.heartbeat_ms,
          idle_timeout_ms: tickConfig.idle_timeout_ms,
          retry_base_delay_ms: tickConfig.retry_base_delay_ms,
          retry_cap_delay_ms: tickConfig.retry_cap_delay_ms,
          retry_jitter_pct: tickConfig.retry_jitter_pct,
          allowed_checkpoint_schema_versions: tickConfig.allowed_checkpoint_schema_versions,
          retry_policy: tickConfig.retry_policy,
        });

        if (!runResult) break;

        summary.executed += 1;
        runTotal += 1;
        summary.last_run = _compactRunResult(runResult);

        if (runResult.ok) {
          summary.succeeded += 1;
          runSuccessTotal += 1;
        } else {
          summary.failed += 1;
          runFailureTotal += 1;
          if (runResult.retry_scheduled) {
            summary.retry_scheduled += 1;
            runRetryTotal += 1;
          }
          if (runResult.dead_letter) {
            summary.dead_letter += 1;
            runDeadLetterTotal += 1;
          }
        }
      }

      summary.idle = (summary.executed === 0 && summary.requeued_leases === 0);
      summary.queue_depth_after = Number(_safeMetrics().queue_depth || 0);
      summary.finished_at = _nowIso(nowFn);
      summary.duration_ms = Math.max(0, nowFn() - startMs);
      lastTick = summary;
      lastError = null;

      _logInfo(
        `[LargeTaskWorker] Complete task queue tick target=large_tasks executed=${summary.executed}/${summary.run_budget} ` +
        `succeeded=${summary.succeeded} failed=${summary.failed} queue_depth_after=${summary.queue_depth_after} ` +
        `duration_ms=${summary.duration_ms}`
      );

      return _clone(summary);
    } catch (error) {
      const message = String(error?.message || error || 'Worker tick failed');
      lastError = {
        at: _nowIso(nowFn),
        message,
        type: String(error?.type || error?.code || 'worker_tick_error'),
      };
      summary.finished_at = _nowIso(nowFn);
      summary.duration_ms = Math.max(0, nowFn() - startMs);
      summary.queue_depth_after = Number(_safeMetrics().queue_depth || 0);
      summary.error = _clone(lastError);
      lastTick = summary;

      _logWarn(
        `[LargeTaskWorker] Fail task queue tick target=large_tasks trigger=${trigger} ` +
        `duration_ms=${summary.duration_ms} message="${message}"`
      );
      return _clone(summary);
    }
  }

  function _refreshTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    timer = setInterval(() => {
      if (tickPromise) return;
      tickPromise = _executeTick({
        trigger: 'interval',
        taskHandler: _resolveTaskHandler(),
      }).finally(() => {
        tickPromise = null;
      });
    }, config.interval_ms);
    if (timer.unref) timer.unref();
  }

  async function runTick(input = {}) {
    const trigger = String(input.trigger || 'manual');
    if (tickPromise) {
      return tickPromise;
    }
    tickPromise = _executeTick({
      trigger,
      taskHandler: _resolveTaskHandler(input.task_handler),
    }).finally(() => {
      tickPromise = null;
    });
    return tickPromise;
  }

  async function start(input = {}) {
    const alreadyRunning = Boolean(timer);
    config = _normalizeWorkerConfig(input, config);
    const runNow = _parseBoolean(input.run_now, true);

    if (!alreadyRunning) {
      startedAt = _nowIso(nowFn);
      stoppedAt = null;
      _refreshTimer();
      _logInfo(
        `[LargeTaskWorker] Start queue worker target=large_tasks interval_ms=${config.interval_ms} ` +
        `run_budget=${config.max_runs_per_tick} dry_run=${config.dry_run} commit=${config.commit}`
      );
    } else {
      _refreshTimer();
    }

    if (runNow) {
      await runTick({
        trigger: alreadyRunning ? 'start_refresh' : 'start',
        task_handler: input.task_handler,
      });
    }

    return {
      started: !alreadyRunning,
      status: _buildStatus(),
    };
  }

  async function stop() {
    const wasRunning = Boolean(timer);
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    stoppedAt = _nowIso(nowFn);
    if (tickPromise) {
      try { await tickPromise; } catch { /* handled in _executeTick */ }
    }
    if (wasRunning) {
      _logInfo('[LargeTaskWorker] Stop queue worker target=large_tasks running=0');
    }
    return {
      stopped: wasRunning,
      status: _buildStatus(),
    };
  }

  return {
    start,
    stop,
    runTick,
    status: _buildStatus,
    getConfig: () => _clone(config),
  };
}

const defaultWorkerService = createLargeTaskWorkerService();

module.exports = {
  createLargeTaskWorkerService,
  ...defaultWorkerService,
};
