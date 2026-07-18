'use strict';

function buildTraceId(req) {
  const incoming = req.headers['x-trace-id'];
  if (typeof incoming === 'string' && incoming.trim()) {
    return incoming.trim();
  }
  return `large_task_${Date.now()}`;
}

// 收敛到 utils/trimIfString 单一真源(逐字节委托,调用点不变)
const trimmedString = require('../../utils/trimIfString');

function parseIntInRange(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

const parseBoolean = (value, fallback = false) => require('../../utils/parseBoolean')(value, fallback, { extended: false });

function parseSchemaVersions(value) {
  if (!Array.isArray(value)) return null;
  const versions = value
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  return versions.length > 0 ? versions : null;
}

function parseRetryPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};

  if (Array.isArray(value.non_retryable_error_types)) {
    out.non_retryable_error_types = value.non_retryable_error_types
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (Array.isArray(value.non_retryable_status_codes)) {
    out.non_retryable_status_codes = value.non_retryable_status_codes
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isFinite(item));
  }
  if (Array.isArray(value.non_retryable_error_kinds)) {
    out.non_retryable_error_kinds = value.non_retryable_error_kinds
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (Array.isArray(value.retryable_error_kinds)) {
    out.retryable_error_kinds = value.retryable_error_kinds
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (typeof value.default_retryable === 'boolean') {
    out.default_retryable = value.default_retryable;
  }

  return Object.keys(out).length > 0 ? out : null;
}

function buildRunOptions(input = {}) {
  return {
    dry_run: parseBoolean(input.dry_run, true),
    commit: parseBoolean(input.commit, false),
    heartbeat_ms: parseIntInRange(input.heartbeat_ms, 15_000, 500, 120_000),
    lease_ms: parseIntInRange(input.lease_ms, 60_000, 1_000, 600_000),
    idle_timeout_ms: parseIntInRange(input.idle_timeout_ms, 120_000, 0, 24 * 60 * 60 * 1000),
    retry_base_delay_ms: parseIntInRange(input.retry_base_delay_ms, 3_000, 200, 3_600_000),
    retry_cap_delay_ms: parseIntInRange(input.retry_cap_delay_ms, 300_000, 200, 3_600_000),
    retry_jitter_pct: Number.isFinite(Number(input.retry_jitter_pct))
      ? Math.max(0, Math.min(1, Number(input.retry_jitter_pct)))
      : 0.2,
    allowed_checkpoint_schema_versions: parseSchemaVersions(input.allowed_checkpoint_schema_versions),
    retry_policy: parseRetryPolicy(input.retry_policy || input.retryPolicy),
  };
}

function buildWorkerStartOptions(input = {}) {
  return {
    ...buildRunOptions(input),
    interval_ms: parseIntInRange(input.interval_ms, 2_000, 200, 300_000),
    max_runs_per_tick: parseIntInRange(input.max_runs_per_tick, 3, 1, 200),
    run_now: parseBoolean(input.run_now, true),
  };
}

function headerAsString(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

function parseAfterEventId(req) {
  const fromQuery = req.query?.after_id;
  if (fromQuery !== undefined && fromQuery !== null && String(fromQuery).trim() !== '') {
    const parsed = Number.parseInt(fromQuery, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const fromHeader = headerAsString(req.headers['last-event-id']);
  if (!fromHeader) return 0;
  const parsed = Number.parseInt(fromHeader, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function normalizePayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

function normalizeSteps(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((step, index) => {
      if (!step || typeof step !== 'object') return null;
      const action = trimmedString(step.action || step.type).toLowerCase();
      if (!action) return null;
      return {
        action,
        index,
        key: trimmedString(step.key),
        value: step.value,
        progress_pct: step.progress_pct,
        sleep_ms: step.sleep_ms,
        checkpoint: step.checkpoint,
        state_blob_json: step.state_blob_json,
        schema_version: step.schema_version,
        idempotency_key: trimmedString(step.idempotency_key),
        intent_hash: trimmedString(step.intent_hash),
        scope: trimmedString(step.scope),
        effect_result: step.effect_result,
        fail_message: trimmedString(step.fail_message),
      };
    })
    .filter(Boolean);
}

function normalizeStatusCode(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRetryFlag(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function normalizeEventRecord(event) {
  if (!event || typeof event !== 'object') return event;
  return {
    ...event,
    retryable: normalizeRetryFlag(event.retryable),
    retry_classification: trimmedString(event.retry_classification) || null,
    error_kind: trimmedString(event.error_kind) || null,
    status_code: normalizeStatusCode(event.status_code),
  };
}

function normalizeAttemptRecord(attempt) {
  if (!attempt || typeof attempt !== 'object') return attempt;
  return {
    ...attempt,
    retryable: normalizeRetryFlag(attempt.retryable),
    retry_classification: trimmedString(attempt.retry_classification) || null,
    error_kind: trimmedString(attempt.error_kind) || null,
    status_code: normalizeStatusCode(attempt.status_code),
  };
}

function normalizeTaskAudit(audit) {
  if (!audit || typeof audit !== 'object') {
    return {
      task: null,
      attempts: [],
      checkpoints: [],
      events: [],
    };
  }
  return {
    task: audit.task || null,
    attempts: Array.isArray(audit.attempts) ? audit.attempts.map(normalizeAttemptRecord) : [],
    checkpoints: Array.isArray(audit.checkpoints) ? audit.checkpoints : [],
    events: Array.isArray(audit.events) ? audit.events.map(normalizeEventRecord) : [],
  };
}

module.exports = {
  buildRunOptions,
  buildTraceId,
  buildWorkerStartOptions,
  headerAsString,
  normalizeEventRecord,
  normalizePayload,
  normalizeTaskAudit,
  normalizeSteps,
  parseAfterEventId,
  parseBoolean,
  parseIntInRange,
  trimmedString,
};
