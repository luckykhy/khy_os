'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { getDataDir } = require('../utils/dataHome');
const { detectErrorKindDeep } = require('../services/errorClassifier');
const { isRetryableError } = require('../services/retryWithBackoff');
const { getTmpDir } = require('../tools/platformUtils');

const TASK_STATUSES = Object.freeze([
  'queued',
  'claimed',
  'running',
  'retry_wait',
  'pausing',
  'paused',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'dead_letter',
]);

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'dead_letter']);

const STATUS_TRANSITIONS = Object.freeze({
  queued: new Set(['claimed', 'cancelling', 'cancelled']),
  claimed: new Set(['running', 'retry_wait', 'cancelling', 'cancelled', 'failed']),
  running: new Set(['retry_wait', 'pausing', 'cancelling', 'succeeded', 'failed']),
  retry_wait: new Set(['claimed', 'dead_letter', 'cancelling', 'cancelled']),
  pausing: new Set(['paused', 'cancelling', 'cancelled']),
  paused: new Set(['running', 'cancelling', 'cancelled']),
  cancelling: new Set(['cancelled']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  dead_letter: new Set(),
});

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 3_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
// Per-task history caps: `task_attempts[id]` and `task_checkpoints[id]` grew
// without bound (one entry per retry / per checkpointed step). A long-running
// task could accumulate thousands of entries that are then re-serialized to disk
// on every _persist(). Trim to the most-recent N; resume only ever needs the
// latest valid checkpoint, and attempt_count is tracked on the task itself.
const _posIntEnv = (raw, def) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const MAX_ATTEMPTS_PER_TASK = _posIntEnv(process.env.KHY_TASK_ATTEMPTS_MAX, 200);
const MAX_CHECKPOINTS_PER_TASK = _posIntEnv(process.env.KHY_TASK_CHECKPOINTS_MAX, 500);

// 「不同入口唯一数据」:TUI 与 web 后端是不同进程,共享同一份磁盘存储
// (large_task_runtime.json)。首次 _ensureLoaded 后 in-memory `state` 永不再读盘,
// 于是 A 进程看不到 B 进程写入的任务 → 唯一数据被内存副本破坏。此门(默认开)让
// 读操作在磁盘 mtime 前进时(说明外部进程写过)重新对齐到磁盘 SSOT。
// 关闭(0/false/off/no)则逐字节回退到旧行为(loaded 后永不重读)。
const _RELOAD_STALE_FALSY = new Set(['0', 'false', 'off', 'no']);
function _reloadOnStaleEnabled() {
  const raw = process.env.KHY_TASK_STORE_RELOAD_ON_STALE;
  if (raw == null || raw === '') return true; // default-on
  return !_RELOAD_STALE_FALSY.has(String(raw).trim().toLowerCase());
}
function _statMtimeMs(targetPath) {
  try {
    return fs.statSync(targetPath).mtimeMs;
  } catch {
    return null; // missing / unreadable → treat as not-stale (fail-soft, never throw)
  }
}
const SANDBOX_FALLBACK_STORE_PATH = path.join(getTmpDir(), 'khy-large-tasks', 'large_task_runtime.json');
const DEFAULT_NON_RETRYABLE_ERROR_TYPES = Object.freeze([
  'auth',
  'authentication_error',
  'permission_denied',
  'forbidden',
  'unauthorized',
  'invalid_request',
  'validation_error',
  'invalid_argument',
  'not_found',
  'resource_not_found',
  'idempotency_conflict',
  'idempotency_key_required',
  'executor_required',
  'circuit_open',
  'task_cancelled',
]);
const DEFAULT_NON_RETRYABLE_STATUS_CODES = Object.freeze([400, 401, 403, 404, 409, 422]);
const DEFAULT_NON_RETRYABLE_ERROR_KINDS = Object.freeze(['auth', 'context_length', 'refusal']);
const DEFAULT_RETRYABLE_ERROR_KINDS = Object.freeze(['timeout', 'network', 'rate_limit']);
const DEFAULT_RETRY_POLICY = Object.freeze({
  non_retryable_error_types: DEFAULT_NON_RETRYABLE_ERROR_TYPES,
  non_retryable_status_codes: DEFAULT_NON_RETRYABLE_STATUS_CODES,
  non_retryable_error_kinds: DEFAULT_NON_RETRYABLE_ERROR_KINDS,
  retryable_error_kinds: DEFAULT_RETRYABLE_ERROR_KINDS,
  default_retryable: true,
});
const RETRY_POLICY_APPROVAL_DEFAULT_TTL_MS = 10 * 60_000;
const RETRY_POLICY_APPROVAL_MAX_TTL_MS = 7 * 24 * 60 * 60_000;
const RETRY_POLICY_APPROVAL_RETENTION_MAX_COUNT = 200_000;
const RETRY_POLICY_APPROVAL_RETENTION_MAX_AGE_MS = 365 * 24 * 60 * 60_000;
const DEFAULT_RETRY_POLICY_APPROVAL_RETENTION = Object.freeze({
  ticket_max_total: 5_000,
  event_max_total: 20_000,
  terminal_ticket_max_count: 2_000,
  terminal_ticket_max_age_ms: 30 * 24 * 60 * 60_000,
  event_max_age_ms: 90 * 24 * 60 * 60_000,
});

function _fallbackStorePathFromCwd() {
  return path.join(process.cwd(), '.khy-runtime', 'tasks', 'large_task_runtime.json');
}

function _normalizeStatusCode(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function _normalizeErrorType(type) {
  return String(type || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function _normalizeErrorKind(kind) {
  return String(kind || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function _parseBooleanStrict(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  }
  return fallback;
}

function _normalizeStringTokenList(value, normalizer, fallback = []) {
  const input = Array.isArray(value) ? value : fallback;
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const normalized = normalizer(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function _normalizeNumberList(value, fallback = []) {
  const input = Array.isArray(value) ? value : fallback;
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const normalized = _normalizeStatusCode(item);
    if (!Number.isFinite(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  out.sort((a, b) => a - b);
  return out;
}

function _compileRetryPolicy(input = {}, fallback = DEFAULT_RETRY_POLICY) {
  const base = (fallback && typeof fallback === 'object') ? fallback : DEFAULT_RETRY_POLICY;
  const patch = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};

  const nonRetryableErrorTypes = _normalizeStringTokenList(
    patch.non_retryable_error_types,
    _normalizeErrorType,
    base.non_retryable_error_types || DEFAULT_NON_RETRYABLE_ERROR_TYPES
  );
  const nonRetryableStatusCodes = _normalizeNumberList(
    patch.non_retryable_status_codes,
    base.non_retryable_status_codes || DEFAULT_NON_RETRYABLE_STATUS_CODES
  );
  const nonRetryableErrorKinds = _normalizeStringTokenList(
    patch.non_retryable_error_kinds,
    _normalizeErrorKind,
    base.non_retryable_error_kinds || DEFAULT_NON_RETRYABLE_ERROR_KINDS
  );
  const retryableErrorKinds = _normalizeStringTokenList(
    patch.retryable_error_kinds,
    _normalizeErrorKind,
    base.retryable_error_kinds || DEFAULT_RETRYABLE_ERROR_KINDS
  );
  const defaultRetryable = _parseBooleanStrict(
    patch.default_retryable,
    _parseBooleanStrict(base.default_retryable, true)
  );

  return {
    non_retryable_error_types: Object.freeze(nonRetryableErrorTypes),
    non_retryable_status_codes: Object.freeze(nonRetryableStatusCodes),
    non_retryable_error_kinds: Object.freeze(nonRetryableErrorKinds),
    retryable_error_kinds: Object.freeze(retryableErrorKinds),
    default_retryable: defaultRetryable,
    non_retryable_error_type_set: new Set(nonRetryableErrorTypes),
    non_retryable_status_code_set: new Set(nonRetryableStatusCodes),
    non_retryable_error_kind_set: new Set(nonRetryableErrorKinds),
    retryable_error_kind_set: new Set(retryableErrorKinds),
  };
}

function _retryPolicySnapshot(policy) {
  const source = policy && typeof policy === 'object' ? policy : _compileRetryPolicy({}, DEFAULT_RETRY_POLICY);
  return {
    non_retryable_error_types: [...(source.non_retryable_error_types || [])],
    non_retryable_status_codes: [...(source.non_retryable_status_codes || [])],
    non_retryable_error_kinds: [...(source.non_retryable_error_kinds || [])],
    retryable_error_kinds: [...(source.retryable_error_kinds || [])],
    default_retryable: _parseBooleanStrict(source.default_retryable, true),
  };
}

function _normalizeRetryPolicyPatch(value = {}) {
  const patch = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  const out = {};

  if (patch.non_retryable_error_types !== undefined) {
    out.non_retryable_error_types = _normalizeStringTokenList(
      Array.isArray(patch.non_retryable_error_types) ? patch.non_retryable_error_types : [],
      _normalizeErrorType,
      []
    );
  }
  if (patch.non_retryable_status_codes !== undefined) {
    out.non_retryable_status_codes = _normalizeNumberList(
      Array.isArray(patch.non_retryable_status_codes) ? patch.non_retryable_status_codes : [],
      []
    );
  }
  if (patch.non_retryable_error_kinds !== undefined) {
    out.non_retryable_error_kinds = _normalizeStringTokenList(
      Array.isArray(patch.non_retryable_error_kinds) ? patch.non_retryable_error_kinds : [],
      _normalizeErrorKind,
      []
    );
  }
  if (patch.retryable_error_kinds !== undefined) {
    out.retryable_error_kinds = _normalizeStringTokenList(
      Array.isArray(patch.retryable_error_kinds) ? patch.retryable_error_kinds : [],
      _normalizeErrorKind,
      []
    );
  }
  if (patch.default_retryable !== undefined) {
    const parsed = _parseBooleanStrict(patch.default_retryable, null);
    if (typeof parsed === 'boolean') {
      out.default_retryable = parsed;
    }
  }

  return out;
}

function _canonicalizeRetryPolicyPatchForHash(value = {}) {
  const normalized = _normalizeRetryPolicyPatch(value);
  const out = {};
  if (Array.isArray(normalized.non_retryable_error_types)) {
    out.non_retryable_error_types = [...normalized.non_retryable_error_types].sort();
  }
  if (Array.isArray(normalized.non_retryable_status_codes)) {
    out.non_retryable_status_codes = [...normalized.non_retryable_status_codes].sort((a, b) => a - b);
  }
  if (Array.isArray(normalized.non_retryable_error_kinds)) {
    out.non_retryable_error_kinds = [...normalized.non_retryable_error_kinds].sort();
  }
  if (Array.isArray(normalized.retryable_error_kinds)) {
    out.retryable_error_kinds = [...normalized.retryable_error_kinds].sort();
  }
  if (typeof normalized.default_retryable === 'boolean') {
    out.default_retryable = normalized.default_retryable;
  }
  return out;
}

function _computeRetryPolicyPatchHash(value = {}) {
  const canonical = _canonicalizeRetryPolicyPatchForHash(value);
  const json = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(json).digest('hex');
}

function _boundedInteger(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function _boundedDurationMs(value, fallbackMs, maxMs) {
  if (value === undefined || value === null || value === '') return fallbackMs;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallbackMs;
  if (n <= 0) return 0;
  return Math.min(maxMs, Math.max(1_000, Math.round(n)));
}

function _normalizeRetryPolicyApprovalRetention(input = {}) {
  const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  return {
    ticket_max_total: _boundedInteger(
      source.ticket_max_total ?? source.ticketMaxTotal,
      DEFAULT_RETRY_POLICY_APPROVAL_RETENTION.ticket_max_total,
      100,
      RETRY_POLICY_APPROVAL_RETENTION_MAX_COUNT
    ),
    event_max_total: _boundedInteger(
      source.event_max_total ?? source.eventMaxTotal,
      DEFAULT_RETRY_POLICY_APPROVAL_RETENTION.event_max_total,
      100,
      RETRY_POLICY_APPROVAL_RETENTION_MAX_COUNT
    ),
    terminal_ticket_max_count: _boundedInteger(
      source.terminal_ticket_max_count ?? source.terminalTicketMaxCount,
      DEFAULT_RETRY_POLICY_APPROVAL_RETENTION.terminal_ticket_max_count,
      0,
      RETRY_POLICY_APPROVAL_RETENTION_MAX_COUNT
    ),
    terminal_ticket_max_age_ms: _boundedDurationMs(
      source.terminal_ticket_max_age_ms ?? source.terminalTicketMaxAgeMs,
      DEFAULT_RETRY_POLICY_APPROVAL_RETENTION.terminal_ticket_max_age_ms,
      RETRY_POLICY_APPROVAL_RETENTION_MAX_AGE_MS
    ),
    event_max_age_ms: _boundedDurationMs(
      source.event_max_age_ms ?? source.eventMaxAgeMs,
      DEFAULT_RETRY_POLICY_APPROVAL_RETENTION.event_max_age_ms,
      RETRY_POLICY_APPROVAL_RETENTION_MAX_AGE_MS
    ),
  };
}

function _candidateStorePaths(primaryPath) {
  const candidates = [];
  for (const candidate of [primaryPath, _fallbackStorePathFromCwd(), SANDBOX_FALLBACK_STORE_PATH]) {
    if (!candidate) continue;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

function _firstWritablePath(primaryPath) {
  const candidates = _candidateStorePaths(primaryPath);
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return primaryPath;
}

function createLargeTaskRuntimeStore(options = {}) {
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  let storePath = options.storePath || _firstWritablePath(path.join(getDataDir('tasks'), 'large_task_runtime.json'));
  const eventBus = new EventEmitter();
  eventBus.setMaxListeners(200);
  let retryPolicy = _compileRetryPolicy(options.retry_policy || options.retryPolicy || {}, DEFAULT_RETRY_POLICY);
  let approvalRetention = _normalizeRetryPolicyApprovalRetention(
    options.approval_retention || options.approvalRetention || {}
  );

  let loaded = false;
  let loadedMtimeMs = null;
  let state = _emptyState();

  // True only when reload-on-stale is enabled AND the on-disk store has advanced
  // past the mtime we last loaded/persisted (i.e. another entry point wrote it).
  function _isStoreStale() {
    if (!_reloadOnStaleEnabled()) return false;
    const m = _statMtimeMs(storePath);
    if (m == null) return false; // file gone/unreadable → keep in-memory copy
    if (loadedMtimeMs == null) return true; // never recorded → reload to be safe
    return m > loadedMtimeMs;
  }

  function _emptyState() {
    return {
      schema_version: 1,
      next_seq: 1,
      next_event_id: 1,
      next_policy_event_id: 1,
      next_retry_policy_approval_event_id: 1,
      next_retry_policy_approval_retention_event_id: 1,
      retry_policy: _retryPolicySnapshot(retryPolicy),
      retry_policy_approval_retention: _clone(approvalRetention),
      next_retry_policy_approval_seq: 1,
      tasks: {},
      task_attempts: {},
      task_checkpoints: {},
      task_events: [],
      retry_policy_events: [],
      retry_policy_approval_tickets: [],
      retry_policy_approval_events: [],
      retry_policy_approval_retention_events: [],
      idempotency_records: {},
    };
  }

  function _ensureLoaded() {
    if (loaded) {
      if (!_isStoreStale()) return;
      loaded = false; // stale: fall through and re-align to the shared on-disk SSOT
    }
    loaded = true;
    for (const candidate of _candidateStorePaths(storePath)) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw);
        storePath = candidate;
        state = {
          ..._emptyState(),
          ...(parsed || {}),
          retry_policy: parsed?.retry_policy || parsed?.retryPolicy || _retryPolicySnapshot(retryPolicy),
          retry_policy_approval_retention: parsed?.retry_policy_approval_retention
            || parsed?.retryPolicyApprovalRetention
            || _clone(approvalRetention),
          tasks: parsed?.tasks || {},
          task_attempts: parsed?.task_attempts || {},
          task_checkpoints: parsed?.task_checkpoints || {},
          task_events: Array.isArray(parsed?.task_events) ? parsed.task_events : [],
          retry_policy_events: Array.isArray(parsed?.retry_policy_events) ? parsed.retry_policy_events : [],
          retry_policy_approval_tickets: Array.isArray(parsed?.retry_policy_approval_tickets)
            ? parsed.retry_policy_approval_tickets
            : [],
          retry_policy_approval_events: Array.isArray(parsed?.retry_policy_approval_events)
            ? parsed.retry_policy_approval_events
            : [],
          retry_policy_approval_retention_events: Array.isArray(parsed?.retry_policy_approval_retention_events)
            ? parsed.retry_policy_approval_retention_events
            : [],
          idempotency_records: parsed?.idempotency_records || {},
        };
        retryPolicy = _compileRetryPolicy(state.retry_policy || {}, retryPolicy);
        state.retry_policy = _retryPolicySnapshot(retryPolicy);
        approvalRetention = _normalizeRetryPolicyApprovalRetention(
          state.retry_policy_approval_retention || state.retryPolicyApprovalRetention || approvalRetention
        );
        state.retry_policy_approval_retention = _clone(approvalRetention);
        if (!Number.isFinite(state.next_event_id) || state.next_event_id <= 0) {
          const maxEventId = state.task_events.reduce((max, event) => {
            const current = Number(event?.event_id || 0);
            return Number.isFinite(current) && current > max ? current : max;
          }, 0);
          state.next_event_id = maxEventId + 1;
        }
        if (!Number.isFinite(state.next_seq) || state.next_seq <= 0) {
          state.next_seq = _rebuildNextSeq(state.tasks);
        }
        if (!Number.isFinite(state.next_policy_event_id) || state.next_policy_event_id <= 0) {
          const maxPolicyEventId = (Array.isArray(state.retry_policy_events) ? state.retry_policy_events : [])
            .reduce((max, event) => {
              const current = Number(event?.policy_event_id || 0);
              return Number.isFinite(current) && current > max ? current : max;
            }, 0);
          state.next_policy_event_id = maxPolicyEventId + 1;
        }
        if (!Number.isFinite(state.next_retry_policy_approval_seq) || state.next_retry_policy_approval_seq <= 0) {
          const maxApprovalSeq = (Array.isArray(state.retry_policy_approval_tickets)
            ? state.retry_policy_approval_tickets
            : [])
            .reduce((max, ticket) => {
              const current = Number(ticket?.seq || 0);
              return Number.isFinite(current) && current > max ? current : max;
            }, 0);
          state.next_retry_policy_approval_seq = maxApprovalSeq + 1;
        }
        if (
          !Number.isFinite(state.next_retry_policy_approval_event_id)
          || state.next_retry_policy_approval_event_id <= 0
        ) {
          const maxApprovalEventId = (Array.isArray(state.retry_policy_approval_events)
            ? state.retry_policy_approval_events
            : [])
            .reduce((max, event) => {
              const current = Number(event?.approval_event_id || 0);
              return Number.isFinite(current) && current > max ? current : max;
            }, 0);
          state.next_retry_policy_approval_event_id = maxApprovalEventId + 1;
        }
        if (
          !Number.isFinite(state.next_retry_policy_approval_retention_event_id)
          || state.next_retry_policy_approval_retention_event_id <= 0
        ) {
          const maxRetentionEventId = (Array.isArray(state.retry_policy_approval_retention_events)
            ? state.retry_policy_approval_retention_events
            : [])
            .reduce((max, event) => {
              const current = Number(event?.retention_event_id || 0);
              return Number.isFinite(current) && current > max ? current : max;
            }, 0);
          state.next_retry_policy_approval_retention_event_id = maxRetentionEventId + 1;
        }
        loadedMtimeMs = _statMtimeMs(storePath);
        return;
      } catch {
        // Try next candidate.
      }
    }
    state = _emptyState();
    _persist();
    loadedMtimeMs = _statMtimeMs(storePath);
  }

  function _rebuildNextSeq(tasks) {
    let maxSeq = 0;
    for (const id of Object.keys(tasks || {})) {
      const match = id.match(/-(\d+)$/);
      if (!match) continue;
      const seq = Number.parseInt(match[1], 10);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    }
    return maxSeq + 1;
  }

  function _persist() {
    const candidates = options.storePath
      ? [storePath]
      : _candidateStorePaths(storePath);
    let lastErr = null;
    for (const candidate of candidates) {
      try {
        const dir = path.dirname(candidate);
        fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${candidate}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
        fs.renameSync(tmpPath, candidate);
        storePath = candidate;
        loadedMtimeMs = _statMtimeMs(candidate);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  function _nowIso() {
    return new Date(nowFn()).toISOString();
  }

  function _clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function _newTaskId(type = 'task') {
    const scope = String(type || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 18) || 'task';
    const seq = state.next_seq++;
    const suffix = crypto.randomBytes(2).toString('hex');
    return `${scope}-${suffix}-${seq}`;
  }

  function _assertValidStatus(status) {
    if (!TASK_STATUSES.includes(status)) {
      throw new Error(`Invalid task status: ${status}`);
    }
  }

  function canTransition(fromStatus, toStatus) {
    _assertValidStatus(fromStatus);
    _assertValidStatus(toStatus);
    if (fromStatus === toStatus) return true;
    const allowed = STATUS_TRANSITIONS[fromStatus];
    return Boolean(allowed && allowed.has(toStatus));
  }

  function _assertTransition(task, toStatus) {
    _assertValidStatus(toStatus);
    const fromStatus = task.status;
    if (fromStatus === toStatus) return;
    if (TERMINAL_STATUSES.has(fromStatus)) {
      throw new Error(`Terminal task is immutable: ${task.id} is ${fromStatus}`);
    }
    if (!canTransition(fromStatus, toStatus)) {
      throw new Error(`Invalid task transition: ${fromStatus} -> ${toStatus}`);
    }
  }

  function _setTaskStatus(task, toStatus, extra = {}) {
    _assertTransition(task, toStatus);
    const nowIso = _nowIso();
    const fromStatus = task.status;
    task.status = toStatus;
    task.updated_at = nowIso;
    if (TERMINAL_STATUSES.has(toStatus)) {
      task.completed_at = nowIso;
      task.lease_owner = null;
      task.lease_until = null;
    }
    if (extra.next_run_at !== undefined) task.next_run_at = extra.next_run_at;
    if (extra.lease_owner !== undefined) task.lease_owner = extra.lease_owner;
    if (extra.lease_until !== undefined) task.lease_until = extra.lease_until;
    if (extra.heartbeat_at !== undefined) task.heartbeat_at = extra.heartbeat_at;
    if (extra.progress_pct !== undefined) task.progress_pct = _normalizeProgress(extra.progress_pct);
    if (extra.last_error !== undefined) task.last_error = extra.last_error;
    if (extra.last_result !== undefined) task.last_result = extra.last_result;
    _recordTaskEvent({
      trace_id: task.trace_id,
      task_id: task.id,
      attempt_no: task.attempt_count,
      state_from: fromStatus,
      state_to: toStatus,
      latency_ms: _taskLatencyMs(task, nowIso),
      error_type: task.last_error?.type || null,
      retryable: typeof task.last_error?.retryable === 'boolean' ? task.last_error.retryable : null,
      retry_classification: task.last_error?.retry_classification || null,
      error_kind: task.last_error?.error_kind || null,
      status_code: _normalizeStatusCode(task.last_error?.status_code),
      at: nowIso,
    });
    return { from_status: fromStatus, to_status: toStatus };
  }

  function _taskLatencyMs(task, nowIso) {
    const createdMs = Date.parse(task.created_at);
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs) || nowMs < createdMs) return 0;
    return nowMs - createdMs;
  }

  function _recordTaskEvent(event) {
    if (!Array.isArray(state.task_events)) state.task_events = [];
    const record = {
      event_id: state.next_event_id++,
      trace_id: event.trace_id || null,
      task_id: event.task_id || null,
      attempt_no: Number.isFinite(Number(event.attempt_no)) ? Number(event.attempt_no) : 0,
      state_from: event.state_from || null,
      state_to: event.state_to || null,
      latency_ms: Number.isFinite(Number(event.latency_ms)) ? Number(event.latency_ms) : 0,
      error_type: event.error_type || null,
      retryable: typeof event.retryable === 'boolean' ? event.retryable : null,
      retry_classification: event.retry_classification || null,
      error_kind: event.error_kind || null,
      status_code: _normalizeStatusCode(event.status_code),
      at: event.at || _nowIso(),
    };
    state.task_events.push(record);
    if (state.task_events.length > 20_000) {
      state.task_events.splice(0, state.task_events.length - 20_000);
    }
    try {
      eventBus.emit('task_event', _clone(record));
    } catch {
      // Event listeners are best-effort.
    }
  }

  function _recordRetryPolicyEvent(event) {
    if (!Array.isArray(state.retry_policy_events)) state.retry_policy_events = [];
    const record = {
      policy_event_id: state.next_policy_event_id++,
      trace_id: event.trace_id || null,
      actor: event.actor || null,
      source: event.source || null,
      reason: event.reason || null,
      changed: event.changed === true,
      patch: event.patch && typeof event.patch === 'object' ? _clone(event.patch) : {},
      before_policy: event.before_policy && typeof event.before_policy === 'object'
        ? _clone(event.before_policy)
        : _retryPolicySnapshot(DEFAULT_RETRY_POLICY),
      after_policy: event.after_policy && typeof event.after_policy === 'object'
        ? _clone(event.after_policy)
        : _retryPolicySnapshot(DEFAULT_RETRY_POLICY),
      at: event.at || _nowIso(),
    };
    state.retry_policy_events.push(record);
    if (state.retry_policy_events.length > 5_000) {
      state.retry_policy_events.splice(0, state.retry_policy_events.length - 5_000);
    }
    return record;
  }

  function _recordRetryPolicyApprovalRetentionEvent(event) {
    if (!Array.isArray(state.retry_policy_approval_retention_events)) {
      state.retry_policy_approval_retention_events = [];
    }
    const record = {
      retention_event_id: state.next_retry_policy_approval_retention_event_id++,
      trace_id: event.trace_id || null,
      actor: event.actor || null,
      source: event.source || null,
      reason: event.reason || null,
      changed: event.changed === true,
      patch: event.patch && typeof event.patch === 'object' ? _clone(event.patch) : {},
      before_retention: event.before_retention && typeof event.before_retention === 'object'
        ? _clone(event.before_retention)
        : {},
      after_retention: event.after_retention && typeof event.after_retention === 'object'
        ? _clone(event.after_retention)
        : {},
      at: event.at || _nowIso(),
    };
    state.retry_policy_approval_retention_events.push(record);
    if (state.retry_policy_approval_retention_events.length > 5_000) {
      state.retry_policy_approval_retention_events.splice(
        0,
        state.retry_policy_approval_retention_events.length - 5_000
      );
    }
    try {
      eventBus.emit('retry_policy_approval_retention_event', _clone(record));
    } catch {
      // Event listeners are best-effort.
    }
    return record;
  }

  function _recordRetryPolicyApprovalEvent(event) {
    if (!Array.isArray(state.retry_policy_approval_events)) state.retry_policy_approval_events = [];
    const record = {
      approval_event_id: state.next_retry_policy_approval_event_id++,
      ticket_id: event.ticket_id || null,
      trace_id: event.trace_id || null,
      event_type: event.event_type || null,
      status_from: event.status_from || null,
      status_to: event.status_to || null,
      actor: event.actor || null,
      reason: event.reason || null,
      risk_level: event.risk_level || null,
      at: event.at || _nowIso(),
      ticket: event.ticket && typeof event.ticket === 'object' ? _clone(event.ticket) : null,
    };
    state.retry_policy_approval_events.push(record);
    if (state.retry_policy_approval_events.length > approvalRetention.event_max_total) {
      state.retry_policy_approval_events.splice(
        0,
        state.retry_policy_approval_events.length - approvalRetention.event_max_total
      );
    }
    try {
      eventBus.emit('retry_policy_approval_event', _clone(record));
    } catch {
      // Event listeners are best-effort.
    }
    return record;
  }

  function _findRetryPolicyApprovalTicketIndex(ticketId) {
    const key = String(ticketId || '').trim();
    if (!key) return -1;
    const list = Array.isArray(state.retry_policy_approval_tickets) ? state.retry_policy_approval_tickets : [];
    return list.findIndex((ticket) => String(ticket?.ticket_id || '') === key);
  }

  function _isTerminalRetryPolicyApprovalStatus(status) {
    return status === 'consumed' || status === 'rejected' || status === 'expired';
  }

  function _approvalTicketTerminalAtMs(ticket) {
    if (!ticket || typeof ticket !== 'object') return null;
    const candidates = [
      ticket.consumed_at,
      ticket.rejected_at,
      ticket.expired_at,
      ticket.expires_at,
      ticket.created_at,
    ];
    for (const candidate of candidates) {
      const parsed = Date.parse(String(candidate || ''));
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function _pruneRetryPolicyApprovalArtifacts(nowMs = nowFn()) {
    let changed = false;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : nowFn();

    if (!Array.isArray(state.retry_policy_approval_tickets)) {
      state.retry_policy_approval_tickets = [];
      changed = true;
    }
    if (!Array.isArray(state.retry_policy_approval_events)) {
      state.retry_policy_approval_events = [];
      changed = true;
    }

    // Keep terminal approval tickets bounded by age first.
    if (approvalRetention.terminal_ticket_max_age_ms > 0) {
      const cutoff = now - approvalRetention.terminal_ticket_max_age_ms;
      const nextTickets = state.retry_policy_approval_tickets.filter((ticket) => {
        if (!_isTerminalRetryPolicyApprovalStatus(String(ticket?.status || ''))) return true;
        const terminalAt = _approvalTicketTerminalAtMs(ticket);
        return !Number.isFinite(terminalAt) || terminalAt >= cutoff;
      });
      if (nextTickets.length !== state.retry_policy_approval_tickets.length) {
        state.retry_policy_approval_tickets = nextTickets;
        changed = true;
      }
    }

    // Then bound terminal ticket count without deleting active/pending/approved tickets.
    if (approvalRetention.terminal_ticket_max_count >= 0) {
      const terminalTickets = state.retry_policy_approval_tickets
        .map((ticket, index) => ({ ticket, index }))
        .filter((item) => _isTerminalRetryPolicyApprovalStatus(String(item.ticket?.status || '')))
        .sort((a, b) => {
          const aMs = _approvalTicketTerminalAtMs(a.ticket);
          const bMs = _approvalTicketTerminalAtMs(b.ticket);
          const av = Number.isFinite(aMs) ? aMs : -Infinity;
          const bv = Number.isFinite(bMs) ? bMs : -Infinity;
          return av - bv;
        });
      const overflow = terminalTickets.length - approvalRetention.terminal_ticket_max_count;
      if (overflow > 0) {
        const dropIndexes = new Set(terminalTickets.slice(0, overflow).map((item) => item.index));
        state.retry_policy_approval_tickets = state.retry_policy_approval_tickets
          .filter((_, index) => !dropIndexes.has(index));
        changed = true;
      }
    }

    // Final hard cap for total ticket count.
    if (state.retry_policy_approval_tickets.length > approvalRetention.ticket_max_total) {
      state.retry_policy_approval_tickets = state.retry_policy_approval_tickets
        .slice(state.retry_policy_approval_tickets.length - approvalRetention.ticket_max_total);
      changed = true;
    }

    // Keep approval events bounded by age then count.
    if (approvalRetention.event_max_age_ms > 0) {
      const cutoff = now - approvalRetention.event_max_age_ms;
      const nextEvents = state.retry_policy_approval_events.filter((event) => {
        const atMs = Date.parse(String(event?.at || ''));
        return !Number.isFinite(atMs) || atMs >= cutoff;
      });
      if (nextEvents.length !== state.retry_policy_approval_events.length) {
        state.retry_policy_approval_events = nextEvents;
        changed = true;
      }
    }
    if (state.retry_policy_approval_events.length > approvalRetention.event_max_total) {
      state.retry_policy_approval_events = state.retry_policy_approval_events
        .slice(state.retry_policy_approval_events.length - approvalRetention.event_max_total);
      changed = true;
    }

    return changed;
  }

  function _expireRetryPolicyApprovalTickets(nowMs = nowFn(), options = {}) {
    const list = Array.isArray(state.retry_policy_approval_tickets) ? state.retry_policy_approval_tickets : [];
    let changed = false;
    const expireAtIso = new Date(Number.isFinite(Number(nowMs)) ? Number(nowMs) : nowFn()).toISOString();
    for (const ticket of list) {
      if (!ticket || ticket.status !== 'pending') continue;
      const expiresMs = Date.parse(String(ticket.expires_at || ''));
      if (!Number.isFinite(expiresMs) || expiresMs >= nowMs) continue;
      const previousStatus = ticket.status;
      ticket.status = 'expired';
      ticket.expired_at = expireAtIso;
      _recordRetryPolicyApprovalEvent({
        ticket_id: ticket.ticket_id,
        trace_id: ticket.trace_id || null,
        event_type: 'ticket_expired',
        status_from: previousStatus,
        status_to: 'expired',
        actor: null,
        reason: 'ticket_expired',
        risk_level: ticket.risk_level || null,
        ticket,
      });
      changed = true;
    }
    if (changed && options.persist !== false) {
      _persist();
    }
    return changed;
  }

  function _maintainRetryPolicyApprovalArtifacts(options = {}) {
    const nowMs = Number.isFinite(Number(options.now_ms)) ? Number(options.now_ms) : nowFn();
    const changedByExpire = _expireRetryPolicyApprovalTickets(nowMs, { persist: false });
    const changedByPrune = _pruneRetryPolicyApprovalArtifacts(nowMs);
    const changed = changedByExpire || changedByPrune;
    if (changed && options.persist !== false) {
      _persist();
    }
    return changed;
  }

  function _normalizeProgress(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 100) return 100;
    return Math.round(n);
  }

  function _getTaskOrThrow(taskId) {
    const task = state.tasks[taskId];
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  function _appendAttempt(taskId, attemptRecord) {
    if (!Array.isArray(state.task_attempts[taskId])) {
      state.task_attempts[taskId] = [];
    }
    const list = state.task_attempts[taskId];
    list.push(attemptRecord);
    if (list.length > MAX_ATTEMPTS_PER_TASK) {
      list.splice(0, list.length - MAX_ATTEMPTS_PER_TASK);
    }
  }

  function createTask(input = {}) {
    _ensureLoaded();
    const createdAt = _nowIso();
    const id = input.id || _newTaskId(input.type);
    if (state.tasks[id]) throw new Error(`Task already exists: ${id}`);

    const task = {
      id,
      type: String(input.type || 'generic'),
      status: 'queued',
      payload_json: input.payload_json || {},
      priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
      attempt_count: 0,
      max_attempts: Math.max(1, Number(input.max_attempts || 3) || 3),
      next_run_at: input.next_run_at || createdAt,
      lease_owner: null,
      lease_until: null,
      heartbeat_at: null,
      progress_pct: _normalizeProgress(input.progress_pct || 0),
      idempotency_key: input.idempotency_key || null,
      trace_id: input.trace_id || `trace-${id}`,
      created_at: createdAt,
      updated_at: createdAt,
      completed_at: null,
      last_error: null,
      last_result: null,
    };

    if (task.idempotency_key) {
      for (const existing of Object.values(state.tasks)) {
        if (existing.idempotency_key && existing.idempotency_key === task.idempotency_key) {
          throw new Error(`Duplicate idempotency_key: ${task.idempotency_key}`);
        }
      }
    }

    state.tasks[id] = task;
    _persist();
    return _clone(task);
  }

  function getTask(taskId) {
    _ensureLoaded();
    const task = state.tasks[taskId];
    return task ? _clone(task) : null;
  }

  function listTasks(filter = {}) {
    _ensureLoaded();
    let tasks = Object.values(state.tasks);
    if (filter.status) tasks = tasks.filter((task) => task.status === filter.status);
    if (filter.type) tasks = tasks.filter((task) => task.type === filter.type);
    if (filter.source) {
      tasks = tasks.filter((task) => task.payload_json && task.payload_json.source === filter.source);
    }
    if (filter.id_prefix) tasks = tasks.filter((task) => task.id.startsWith(filter.id_prefix));
    tasks.sort((a, b) => {
      const pa = Number(a.priority || 100);
      const pb = Number(b.priority || 100);
      if (pa !== pb) return pa - pb;
      return String(a.created_at).localeCompare(String(b.created_at));
    });
    return tasks.map(_clone);
  }

  function updateTaskFields(taskId, patch = {}) {
    _ensureLoaded();
    const task = _getTaskOrThrow(taskId);
    if (TERMINAL_STATUSES.has(task.status) && patch.status === undefined) {
      const allowedKeys = ['payload_json', 'last_result', 'updated_at'];
      const keys = Object.keys(patch);
      if (keys.some((key) => !allowedKeys.includes(key))) {
        throw new Error(`Terminal task is immutable: ${task.id} is ${task.status}`);
      }
    }

    if (patch.payload_json !== undefined) task.payload_json = patch.payload_json;
    if (patch.priority !== undefined) task.priority = Number(patch.priority) || task.priority;
    if (patch.next_run_at !== undefined) task.next_run_at = patch.next_run_at;
    if (patch.progress_pct !== undefined) task.progress_pct = _normalizeProgress(patch.progress_pct);
    if (patch.lease_owner !== undefined) task.lease_owner = patch.lease_owner;
    if (patch.lease_until !== undefined) task.lease_until = patch.lease_until;
    if (patch.heartbeat_at !== undefined) task.heartbeat_at = patch.heartbeat_at;
    if (patch.last_error !== undefined) task.last_error = patch.last_error;
    if (patch.last_result !== undefined) task.last_result = patch.last_result;
    if (patch.status !== undefined) _setTaskStatus(task, patch.status, patch);
    else task.updated_at = _nowIso();

    _persist();
    return _clone(task);
  }

  function transitionTask(taskId, toStatus, extra = {}) {
    _ensureLoaded();
    const task = _getTaskOrThrow(taskId);
    _setTaskStatus(task, toStatus, extra);
    _persist();
    return _clone(task);
  }

  function claimTask(taskId, workerId, options = {}) {
    _ensureLoaded();
    const task = _getTaskOrThrow(taskId);
    const now = nowFn();
    const leaseMs = Math.max(1_000, Number(options.leaseMs || DEFAULT_LEASE_MS) || DEFAULT_LEASE_MS);
    const nowIso = new Date(now).toISOString();
    const leaseUntil = new Date(now + leaseMs).toISOString();

    if (task.status === 'retry_wait') {
      const dueAt = new Date(task.next_run_at || task.updated_at).getTime();
      if (Number.isFinite(dueAt) && dueAt > now) {
        return null;
      }
    }

    _setTaskStatus(task, 'claimed', {
      lease_owner: workerId,
      lease_until: leaseUntil,
      heartbeat_at: nowIso,
    });
    _persist();
    return _clone(task);
  }

  function claimNextTask(workerId, options = {}) {
    _ensureLoaded();
    const now = nowFn();
    const candidates = Object.values(state.tasks)
      .filter((task) => task.status === 'queued' || task.status === 'retry_wait')
      .filter((task) => {
        if (task.status !== 'retry_wait') return true;
        const dueAt = new Date(task.next_run_at || task.updated_at).getTime();
        return !Number.isFinite(dueAt) || dueAt <= now;
      })
      .sort((a, b) => {
        const pa = Number(a.priority || 100);
        const pb = Number(b.priority || 100);
        if (pa !== pb) return pa - pb;
        return String(a.created_at).localeCompare(String(b.created_at));
      });

    if (candidates.length === 0) return null;
    return claimTask(candidates[0].id, workerId, options);
  }

  function startTask(taskId, workerId) {
    _ensureLoaded();
    const task = _getTaskOrThrow(taskId);
    if (task.lease_owner && workerId && task.lease_owner !== workerId) {
      throw new Error(`Task claimed by another worker: ${task.lease_owner}`);
    }
    const nowIso = _nowIso();
    _setTaskStatus(task, 'running', { heartbeat_at: nowIso });
    _persist();
    return _clone(task);
  }

  function heartbeatTask(taskId, workerId, options = {}) {
    _ensureLoaded();
    const task = _getTaskOrThrow(taskId);
    if (task.lease_owner && workerId && task.lease_owner !== workerId) {
      throw new Error(`Task lease owner mismatch: ${task.lease_owner} != ${workerId}`);
    }
    const leaseMs = Math.max(1_000, Number(options.leaseMs || DEFAULT_LEASE_MS) || DEFAULT_LEASE_MS);
    const now = nowFn();
    task.heartbeat_at = new Date(now).toISOString();
    task.lease_until = new Date(now + leaseMs).toISOString();
    task.updated_at = task.heartbeat_at;
    _persist();
    return _clone(task);
  }

  function markSucceeded(taskId, workerId, result, options = {}) {
    _ensureLoaded();
    const task = _getTaskOrThrow(taskId);
    if (task.lease_owner && workerId && task.lease_owner !== workerId) {
      throw new Error(`Task lease owner mismatch: ${task.lease_owner} != ${workerId}`);
    }
    const nowIso = _nowIso();
    const attemptNo = task.attempt_count + 1;
    task.attempt_count = attemptNo;
    task.last_result = result ?? null;

    _appendAttempt(taskId, {
      task_id: taskId,
      attempt_no: attemptNo,
      worker_id: workerId || null,
      started_at: task.heartbeat_at || task.updated_at,
      ended_at: nowIso,
      result_status: 'succeeded',
      error_type: null,
      error_message: null,
      retryable: null,
      retry_classification: null,
      error_kind: null,
      status_code: null,
      retry_delay_ms: 0,
    });

    _setTaskStatus(task, 'succeeded', {
      progress_pct: options.progress_pct === undefined ? 100 : options.progress_pct,
      last_result: result ?? null,
      heartbeat_at: nowIso,
    });
    _persist();
    return _clone(task);
  }

  function _normalizeFailureInput(err) {
    if (!err) {
      return { type: 'unknown_error', message: 'Unknown task failure', status_code: null };
    }
    if (typeof err === 'string') {
      return { type: 'error', message: err, status_code: null };
    }
    const type = String(err.type || err.code || 'error');
    const message = String(err.message || err.error || 'Task failed');
    const statusRaw = err.status ?? err.statusCode ?? err.response?.status ?? null;
    const statusCode = Number.parseInt(statusRaw, 10);
    return {
      type,
      message,
      status_code: Number.isFinite(statusCode) ? statusCode : null,
    };
  }

  function classifyFailureRetryability(err, failure, options = {}) {
    const effectivePolicy = _compileRetryPolicy(
      options.retry_policy || options.retryPolicy || {},
      retryPolicy
    );
    if (typeof options.retryable === 'boolean') {
      return {
        retryable: options.retryable,
        reason: 'explicit_option',
        error_kind: null,
      };
    }

    if (err && typeof err === 'object') {
      if (err.permanent === true || err.non_retryable === true) {
        return { retryable: false, reason: 'explicit_non_retryable_flag', error_kind: null };
      }
      if (typeof err.retryable === 'boolean') {
        return { retryable: err.retryable, reason: 'error_retryable_flag', error_kind: null };
      }
    }

    const normalizedType = _normalizeErrorType(failure?.type);
    if (normalizedType && effectivePolicy.non_retryable_error_type_set.has(normalizedType)) {
      return { retryable: false, reason: 'non_retryable_error_type', error_kind: null };
    }

    const statusCode = Number.parseInt(failure?.status_code, 10);
    if (Number.isFinite(statusCode) && effectivePolicy.non_retryable_status_code_set.has(statusCode)) {
      return { retryable: false, reason: 'non_retryable_status_code', error_kind: null };
    }

    const errorKind = _normalizeErrorKind(detectErrorKindDeep(err || failure));
    if (errorKind && effectivePolicy.non_retryable_error_kind_set.has(errorKind)) {
      return { retryable: false, reason: 'non_retryable_error_kind', error_kind: errorKind };
    }
    if (errorKind && effectivePolicy.retryable_error_kind_set.has(errorKind)) {
      return { retryable: true, reason: 'retryable_error_kind', error_kind: errorKind };
    }

    if (isRetryableError(err || failure)) {
      return { retryable: true, reason: 'retryable_error_pattern', error_kind: errorKind || null };
    }

    if (_parseBooleanStrict(effectivePolicy.default_retryable, true)) {
      return { retryable: true, reason: 'default_retryable', error_kind: errorKind || null };
    }
    return { retryable: false, reason: 'default_non_retryable', error_kind: errorKind || null };
  }

  function _computeRetryDelayMs(attemptCount, options = {}) {
    if (options.retry_delay_ms !== undefined) {
      const fixed = Number(options.retry_delay_ms);
      if (Number.isFinite(fixed) && fixed >= 0) return Math.round(fixed);
    }
    const base = Math.max(200, Number(options.retry_base_delay_ms || DEFAULT_RETRY_DELAY_MS) || DEFAULT_RETRY_DELAY_MS);
    const cap = Math.max(base, Number(options.retry_cap_delay_ms || MAX_RETRY_DELAY_MS) || MAX_RETRY_DELAY_MS);
    const jitterPct = Math.min(1, Math.max(0, Number(options.jitter_pct ?? 0.2)));
    const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attemptCount - 1)));
    const jitter = exp * jitterPct;
    return Math.max(0, Math.round(exp - jitter + Math.random() * jitter * 2));
  }

  function markFailed(taskId, workerId, err, options = {}) {
    _ensureLoaded();
    const task = _getTaskOrThrow(taskId);
    if (task.lease_owner && workerId && task.lease_owner !== workerId) {
      throw new Error(`Task lease owner mismatch: ${task.lease_owner} != ${workerId}`);
    }

    const failure = _normalizeFailureInput(err);
    const retryClassification = classifyFailureRetryability(err, failure, options);
    const attemptNo = task.attempt_count + 1;
    task.attempt_count = attemptNo;
    task.last_error = {
      ...failure,
      retryable: retryClassification.retryable,
      retry_classification: retryClassification.reason,
      error_kind: retryClassification.error_kind,
    };

    const retryDelayMs = _computeRetryDelayMs(attemptNo, options);
    const nextRunAt = new Date(nowFn() + retryDelayMs).toISOString();
    const canRetry = retryClassification.retryable && attemptNo < task.max_attempts;

    const terminalResultStatus = retryClassification.retryable ? 'dead_letter' : 'failed';

    _appendAttempt(taskId, {
      task_id: taskId,
      attempt_no: attemptNo,
      worker_id: workerId || null,
      started_at: task.heartbeat_at || task.updated_at,
      ended_at: _nowIso(),
      result_status: canRetry ? 'retry_wait' : terminalResultStatus,
      error_type: failure.type,
      error_message: failure.message,
      retryable: retryClassification.retryable,
      retry_classification: retryClassification.reason,
      error_kind: retryClassification.error_kind,
      status_code: failure.status_code,
      retry_delay_ms: canRetry ? retryDelayMs : 0,
    });

    if (canRetry) {
      _setTaskStatus(task, 'retry_wait', {
        next_run_at: nextRunAt,
        last_error: task.last_error,
      });
      _persist();
      return {
        task: _clone(task),
        retry_scheduled: true,
        retry_delay_ms: retryDelayMs,
        retry_classification: retryClassification.reason,
      };
    }

    if (!retryClassification.retryable) {
      _setTaskStatus(task, 'failed', {
        next_run_at: null,
        last_error: task.last_error,
      });
      _persist();
      return {
        task: _clone(task),
        retry_scheduled: false,
        dead_letter: false,
        retry_delay_ms: 0,
        retry_classification: retryClassification.reason,
      };
    }

    _setTaskStatus(task, 'retry_wait', {
      next_run_at: nextRunAt,
      last_error: task.last_error,
    });
    _setTaskStatus(task, 'dead_letter', {
      next_run_at: null,
      last_error: task.last_error,
    });
    _persist();
    return {
      task: _clone(task),
      retry_scheduled: false,
      dead_letter: true,
      retry_delay_ms: 0,
      retry_classification: retryClassification.reason,
    };
  }

  function cancelTask(taskId, reason = 'cancelled') {
    _ensureLoaded();
    const task = _getTaskOrThrow(taskId);
    if (TERMINAL_STATUSES.has(task.status)) return _clone(task);
    _setTaskStatus(task, 'cancelling', {
      last_error: { type: 'cancelled', message: String(reason || 'cancelled') },
    });
    _setTaskStatus(task, 'cancelled', {
      last_error: { type: 'cancelled', message: String(reason || 'cancelled') },
    });
    _persist();
    return _clone(task);
  }

  function saveCheckpoint(taskId, checkpoint = {}) {
    _ensureLoaded();
    _getTaskOrThrow(taskId);
    const stepNo = Number.isFinite(Number(checkpoint.step_no))
      ? Number(checkpoint.step_no)
      : Number.isFinite(Number(checkpoint.stepNo))
        ? Number(checkpoint.stepNo)
        : 0;
    const cp = {
      task_id: taskId,
      step_no: stepNo,
      progress_pct: _normalizeProgress(checkpoint.progress_pct ?? checkpoint.progressPct ?? 0),
      state_blob_json: checkpoint.state_blob_json ?? checkpoint.stateBlob ?? {},
      schema_version: Number.isFinite(Number(checkpoint.schema_version))
        ? Number(checkpoint.schema_version)
        : Number.isFinite(Number(checkpoint.schemaVersion))
          ? Number(checkpoint.schemaVersion)
          : 1,
      created_at: _nowIso(),
    };
    if (!Array.isArray(state.task_checkpoints[taskId])) {
      state.task_checkpoints[taskId] = [];
    }
    state.task_checkpoints[taskId].push(cp);
    const cps = state.task_checkpoints[taskId];
    if (cps.length > MAX_CHECKPOINTS_PER_TASK) {
      cps.splice(0, cps.length - MAX_CHECKPOINTS_PER_TASK);
    }
    state.tasks[taskId].progress_pct = cp.progress_pct;
    state.tasks[taskId].updated_at = cp.created_at;
    _persist();
    return _clone(cp);
  }

  function listCheckpoints(taskId) {
    _ensureLoaded();
    const list = Array.isArray(state.task_checkpoints[taskId]) ? state.task_checkpoints[taskId] : [];
    return list.map(_clone);
  }

  function getLatestCheckpoint(taskId, options = {}) {
    _ensureLoaded();
    const list = Array.isArray(state.task_checkpoints[taskId]) ? state.task_checkpoints[taskId] : [];
    if (list.length === 0) return null;
    const allowedSchemas = Array.isArray(options.allowed_schema_versions)
      ? new Set(options.allowed_schema_versions.map((n) => Number(n)))
      : null;
    for (let i = list.length - 1; i >= 0; i--) {
      const cp = list[i];
      if (!allowedSchemas || allowedSchemas.has(Number(cp.schema_version))) {
        return _clone(cp);
      }
    }
    return null;
  }

  function resumeFromCheckpoint(taskId, options = {}) {
    _ensureLoaded();
    const task = _getTaskOrThrow(taskId);
    const checkpoint = getLatestCheckpoint(taskId, options);
    if (!checkpoint) {
      return { resumed: false, reason: 'checkpoint_not_found', task: _clone(task) };
    }

    if (TERMINAL_STATUSES.has(task.status)) {
      throw new Error(`Cannot resume terminal task: ${task.id} is ${task.status}`);
    }

    const nextPayload = {
      ...(task.payload_json || {}),
      resume_from_checkpoint: checkpoint,
    };
    task.payload_json = nextPayload;
    task.progress_pct = checkpoint.progress_pct;
    task.updated_at = _nowIso();
    _persist();

    return {
      resumed: true,
      checkpoint: _clone(checkpoint),
      task: _clone(task),
    };
  }

  async function executeIdempotentSideEffect(input = {}) {
    _ensureLoaded();
    const scope = String(input.scope || 'default').trim() || 'default';
    const idempotencyKey = String(input.idempotency_key || input.idempotencyKey || '').trim();
    if (!idempotencyKey) {
      throw new Error('idempotency_key is required for side-effect operations');
    }
    const executor = input.executor;
    if (typeof executor !== 'function') {
      throw new Error('executor function is required for side-effect operations');
    }

    const intentHash = input.intent_hash || input.intentHash || null;
    const scopeStore = state.idempotency_records[scope] || {};
    const existing = scopeStore[idempotencyKey] || null;

    if (existing) {
      if (intentHash && existing.intent_hash && existing.intent_hash !== intentHash) {
        return {
          ok: false,
          code: 'idempotency_conflict',
          message: 'idempotency_key conflicts with previous intent',
          record: _clone(existing),
        };
      }
      if (existing.status === 'in_progress') {
        return {
          ok: false,
          code: 'idempotency_in_progress',
          message: 'same idempotency_key request is already in progress',
          record: _clone(existing),
        };
      }
      if (existing.status === 'succeeded') {
        return {
          ok: true,
          replayed: true,
          result: _clone(existing.result_json),
          record: _clone(existing),
        };
      }
    }

    const createdAt = _nowIso();
    const record = {
      scope,
      idempotency_key: idempotencyKey,
      intent_hash: intentHash,
      status: 'in_progress',
      result_json: null,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    state.idempotency_records[scope] = scopeStore;
    scopeStore[idempotencyKey] = record;
    _persist();

    try {
      const result = await executor();
      record.status = 'succeeded';
      record.result_json = result ?? null;
      record.updated_at = _nowIso();
      _persist();
      return {
        ok: true,
        replayed: false,
        result: _clone(record.result_json),
        record: _clone(record),
      };
    } catch (err) {
      record.status = 'failed';
      record.error_message = String(err?.message || err || 'side-effect failed');
      record.updated_at = _nowIso();
      _persist();
      throw err;
    }
  }

  function requeueExpiredLeases(options = {}) {
    _ensureLoaded();
    const now = options.nowMs === undefined ? nowFn() : Number(options.nowMs);
    let requeued = 0;
    for (const task of Object.values(state.tasks)) {
      if ((task.status !== 'claimed' && task.status !== 'running') || !task.lease_until) continue;
      const leaseUntil = new Date(task.lease_until).getTime();
      if (!Number.isFinite(leaseUntil) || leaseUntil > now) continue;
      _setTaskStatus(task, 'retry_wait', {
        next_run_at: _nowIso(),
        lease_owner: null,
        lease_until: null,
        last_error: {
          type: 'lease_expired',
          message: 'Worker lease expired; task returned to retry queue',
        },
      });
      requeued++;
    }
    if (requeued > 0) _persist();
    return { requeued };
  }

  function deleteTask(taskId) {
    _ensureLoaded();
    if (!state.tasks[taskId]) return false;
    delete state.tasks[taskId];
    delete state.task_attempts[taskId];
    delete state.task_checkpoints[taskId];
    _persist();
    return true;
  }

  function getAttempts(taskId) {
    _ensureLoaded();
    const attempts = Array.isArray(state.task_attempts[taskId]) ? state.task_attempts[taskId] : [];
    return attempts.map(_clone);
  }

  function listTaskEvents(filter = {}) {
    _ensureLoaded();
    let events = Array.isArray(state.task_events) ? state.task_events : [];
    if (filter.task_id) {
      events = events.filter((event) => event.task_id === filter.task_id);
    }
    if (filter.trace_id) {
      events = events.filter((event) => event.trace_id === filter.trace_id);
    }
    if (filter.state_to) {
      events = events.filter((event) => event.state_to === filter.state_to);
    }
    if (filter.state_from) {
      events = events.filter((event) => event.state_from === filter.state_from);
    }
    if (filter.after_at) {
      const afterMs = Date.parse(String(filter.after_at));
      if (Number.isFinite(afterMs)) {
        events = events.filter((event) => {
          const atMs = Date.parse(String(event.at));
          return Number.isFinite(atMs) && atMs > afterMs;
        });
      }
    }
    if (filter.after_id !== undefined && filter.after_id !== null) {
      const afterId = Number(filter.after_id);
      if (Number.isFinite(afterId) && afterId >= 0) {
        events = events.filter((event) => Number(event.event_id || 0) > afterId);
      }
    }
    const limit = Math.max(1, Math.min(5000, Number(filter.limit || events.length) || events.length));
    if (events.length > limit) {
      events = events.slice(events.length - limit);
    }
    return events.map(_clone);
  }

  function getTaskAudit(taskId) {
    _ensureLoaded();
    return {
      task: getTask(taskId),
      attempts: getAttempts(taskId),
      checkpoints: listCheckpoints(taskId),
      events: listTaskEvents({ task_id: taskId }),
    };
  }

  function _quantile(sortedValues, q) {
    if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0;
    const pos = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * q) - 1));
    return sortedValues[pos];
  }

  function getMetricsSnapshot() {
    _ensureLoaded();
    const tasks = Object.values(state.tasks || {});
    const attempts = Object.values(state.task_attempts || {}).flat();

    const queueDepth = tasks.filter((task) => task.status === 'queued' || task.status === 'retry_wait').length;
    const terminalTasks = tasks.filter((task) => TERMINAL_STATUSES.has(task.status));
    const succeeded = terminalTasks.filter((task) => task.status === 'succeeded').length;
    const deadLetter = terminalTasks.filter((task) => task.status === 'dead_letter').length;

    const successRate = terminalTasks.length > 0 ? (succeeded / terminalTasks.length) : 0;
    const deadLetterRate = terminalTasks.length > 0 ? (deadLetter / terminalTasks.length) : 0;
    const retryEvents = attempts.filter((attempt) => attempt.result_status === 'retry_wait').length;
    const retryRate = attempts.length > 0 ? (retryEvents / attempts.length) : 0;

    const claimLatencies = [];
    for (const task of tasks) {
      const createdMs = Date.parse(task.created_at);
      if (!Number.isFinite(createdMs)) continue;
      const claimEvent = (state.task_events || []).find((event) => event.task_id === task.id && event.state_to === 'claimed');
      if (!claimEvent) continue;
      const claimMs = Date.parse(claimEvent.at);
      if (!Number.isFinite(claimMs) || claimMs < createdMs) continue;
      claimLatencies.push(claimMs - createdMs);
    }
    claimLatencies.sort((a, b) => a - b);

    return {
      queue_depth: queueDepth,
      success_rate: successRate,
      retry_rate: retryRate,
      dead_letter_rate: deadLetterRate,
      claim_latency_ms: {
        p95: _quantile(claimLatencies, 0.95),
        p99: _quantile(claimLatencies, 0.99),
      },
      event_subscriber_total: eventBus.listenerCount('task_event'),
      task_total: tasks.length,
      terminal_total: terminalTasks.length,
      attempt_total: attempts.length,
      event_total: Array.isArray(state.task_events) ? state.task_events.length : 0,
    };
  }

  function getSnapshot() {
    _ensureLoaded();
    return _clone(state);
  }

  function resetForTests(options = {}) {
    retryPolicy = _compileRetryPolicy(options.retry_policy || options.retryPolicy || {}, DEFAULT_RETRY_POLICY);
    approvalRetention = _normalizeRetryPolicyApprovalRetention(
      options.approval_retention || options.approvalRetention || {}
    );
    state = _emptyState();
    loaded = true;
    eventBus.removeAllListeners('task_event');
    eventBus.removeAllListeners('retry_policy_approval_event');
    eventBus.removeAllListeners('retry_policy_approval_retention_event');
    if (options.persist !== false) {
      _persist();
    } else {
      try { fs.unlinkSync(storePath); } catch { /* ignore */ }
    }
  }

  function subscribeTaskEvents(listener) {
    if (typeof listener !== 'function') {
      throw new Error('subscribeTaskEvents requires a listener function');
    }
    eventBus.on('task_event', listener);
    return () => {
      eventBus.off('task_event', listener);
    };
  }

  function subscribeRetryPolicyApprovalEvents(listener) {
    if (typeof listener !== 'function') {
      throw new Error('subscribeRetryPolicyApprovalEvents requires a listener function');
    }
    eventBus.on('retry_policy_approval_event', listener);
    return () => {
      eventBus.off('retry_policy_approval_event', listener);
    };
  }

  function subscribeRetryPolicyApprovalRetentionEvents(listener) {
    if (typeof listener !== 'function') {
      throw new Error('subscribeRetryPolicyApprovalRetentionEvents requires a listener function');
    }
    eventBus.on('retry_policy_approval_retention_event', listener);
    return () => {
      eventBus.off('retry_policy_approval_retention_event', listener);
    };
  }

  function getRetryPolicy() {
    _ensureLoaded();
    return _retryPolicySnapshot(retryPolicy);
  }

  function getRetryPolicyApprovalRetention() {
    _ensureLoaded();
    return _clone(approvalRetention);
  }

  function updateRetryPolicyApprovalRetention(nextRetention = {}, meta = {}) {
    _ensureLoaded();
    if (!nextRetention || typeof nextRetention !== 'object' || Array.isArray(nextRetention)) {
      throw new Error('retry_policy_approval_retention must be an object');
    }
    const before = _clone(approvalRetention);
    const merged = _normalizeRetryPolicyApprovalRetention({
      ...before,
      ...nextRetention,
    });
    const changed = JSON.stringify(before) !== JSON.stringify(merged);
    approvalRetention = merged;
    state.retry_policy_approval_retention = _clone(approvalRetention);
    const event = _recordRetryPolicyApprovalRetentionEvent({
      trace_id: meta.trace_id || null,
      actor: meta.actor || null,
      source: meta.source || 'runtime',
      reason: meta.reason || null,
      patch: _clone(nextRetention),
      before_retention: before,
      after_retention: _clone(approvalRetention),
      changed,
    });
    if (changed) {
      _maintainRetryPolicyApprovalArtifacts({ persist: false });
      _persist();
    }
    return {
      retention: _clone(approvalRetention),
      changed,
      event: _clone(event),
    };
  }

  function setRetryPolicyApprovalRetention(nextRetention = {}) {
    return updateRetryPolicyApprovalRetention(nextRetention).retention;
  }

  function createRetryPolicyApprovalTicket(input = {}) {
    _ensureLoaded();
    _maintainRetryPolicyApprovalArtifacts({ persist: false });
    const patch = _normalizeRetryPolicyPatch(input.patch || {});
    const patchHash = _computeRetryPolicyPatchHash(patch);
    const nowMs = nowFn();
    const nowIso = new Date(nowMs).toISOString();
    const ttlInput = Number(input.ttl_ms ?? input.ttlMs ?? RETRY_POLICY_APPROVAL_DEFAULT_TTL_MS);
    const ttlMs = Number.isFinite(ttlInput)
      ? Math.max(1_000, Math.min(RETRY_POLICY_APPROVAL_MAX_TTL_MS, Math.round(ttlInput)))
      : RETRY_POLICY_APPROVAL_DEFAULT_TTL_MS;
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    const seq = Number(state.next_retry_policy_approval_seq || 1);
    state.next_retry_policy_approval_seq = seq + 1;
    const seqBase36 = seq.toString(36).padStart(6, '0');
    const suffix = crypto.randomBytes(3).toString('hex');

    const ticket = {
      ticket_id: `rpap-${seqBase36}-${suffix}`,
      seq,
      status: 'pending',
      trace_id: input.trace_id || null,
      requester: input.requester || null,
      reason: input.reason || null,
      risk_level: input.risk_level || 'high',
      risk_reason: input.risk_reason || null,
      patch,
      patch_hash: patchHash,
      created_at: nowIso,
      expires_at: expiresAt,
      approved_by: null,
      approved_at: null,
      rejected_by: null,
      rejected_at: null,
      rejected_reason: null,
      consumed_at: null,
      expired_at: null,
    };

    if (!Array.isArray(state.retry_policy_approval_tickets)) {
      state.retry_policy_approval_tickets = [];
    }
    state.retry_policy_approval_tickets.push(ticket);
    _recordRetryPolicyApprovalEvent({
      ticket_id: ticket.ticket_id,
      trace_id: ticket.trace_id || null,
      event_type: 'ticket_created',
      status_from: null,
      status_to: 'pending',
      actor: ticket.requester || null,
      reason: ticket.reason || null,
      risk_level: ticket.risk_level || null,
      ticket,
    });
    _pruneRetryPolicyApprovalArtifacts();
    _persist();
    return _clone(ticket);
  }

  function getRetryPolicyApprovalTicket(ticketId) {
    _ensureLoaded();
    _maintainRetryPolicyApprovalArtifacts();
    const index = _findRetryPolicyApprovalTicketIndex(ticketId);
    if (index < 0) return null;
    const ticket = state.retry_policy_approval_tickets[index];
    return ticket ? _clone(ticket) : null;
  }

  function listRetryPolicyApprovalTickets(filter = {}) {
    _ensureLoaded();
    _maintainRetryPolicyApprovalArtifacts();
    let tickets = Array.isArray(state.retry_policy_approval_tickets) ? state.retry_policy_approval_tickets : [];
    if (filter.status) {
      tickets = tickets.filter((ticket) => String(ticket?.status || '') === String(filter.status));
    }
    if (filter.trace_id) {
      tickets = tickets.filter((ticket) => ticket.trace_id === filter.trace_id);
    }
    const limit = Math.max(1, Math.min(5_000, Number(filter.limit || tickets.length) || tickets.length));
    tickets = [...tickets].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    if (tickets.length > limit) {
      tickets = tickets.slice(0, limit);
    }
    return tickets.map(_clone);
  }

  function listRetryPolicyApprovalEvents(filter = {}) {
    _ensureLoaded();
    _maintainRetryPolicyApprovalArtifacts();
    let events = Array.isArray(state.retry_policy_approval_events) ? state.retry_policy_approval_events : [];
    if (filter.after_id !== undefined && filter.after_id !== null) {
      const afterId = Number.parseInt(filter.after_id, 10);
      if (Number.isFinite(afterId) && afterId >= 0) {
        events = events.filter((event) => Number(event.approval_event_id || 0) > afterId);
      }
    }
    if (filter.trace_id) {
      events = events.filter((event) => event.trace_id === filter.trace_id);
    }
    if (filter.ticket_id) {
      events = events.filter((event) => event.ticket_id === filter.ticket_id);
    }
    if (filter.event_type) {
      events = events.filter((event) => event.event_type === filter.event_type);
    }
    const limit = Math.max(1, Math.min(5_000, Number(filter.limit || events.length) || events.length));
    if (events.length > limit) {
      events = events.slice(events.length - limit);
    }
    return events.map(_clone);
  }

  function approveRetryPolicyApprovalTicket(ticketId, reviewer = null) {
    _ensureLoaded();
    _maintainRetryPolicyApprovalArtifacts({ persist: false });
    const index = _findRetryPolicyApprovalTicketIndex(ticketId);
    if (index < 0) return null;
    const ticket = state.retry_policy_approval_tickets[index];
    const nowIso = _nowIso();
    if (ticket.status !== 'pending') return _clone(ticket);
    const previousStatus = ticket.status;
    ticket.status = 'approved';
    ticket.approved_by = reviewer || null;
    ticket.approved_at = nowIso;
    _recordRetryPolicyApprovalEvent({
      ticket_id: ticket.ticket_id,
      trace_id: ticket.trace_id || null,
      event_type: 'ticket_approved',
      status_from: previousStatus,
      status_to: ticket.status,
      actor: reviewer || null,
      reason: null,
      risk_level: ticket.risk_level || null,
      ticket,
    });
    _pruneRetryPolicyApprovalArtifacts();
    _persist();
    return _clone(ticket);
  }

  function rejectRetryPolicyApprovalTicket(ticketId, reviewer = null, reason = 'rejected_by_reviewer') {
    _ensureLoaded();
    _maintainRetryPolicyApprovalArtifacts({ persist: false });
    const index = _findRetryPolicyApprovalTicketIndex(ticketId);
    if (index < 0) return null;
    const ticket = state.retry_policy_approval_tickets[index];
    const nowIso = _nowIso();
    if (ticket.status !== 'pending') return _clone(ticket);
    const previousStatus = ticket.status;
    ticket.status = 'rejected';
    ticket.rejected_by = reviewer || null;
    ticket.rejected_at = nowIso;
    ticket.rejected_reason = String(reason || 'rejected_by_reviewer');
    _recordRetryPolicyApprovalEvent({
      ticket_id: ticket.ticket_id,
      trace_id: ticket.trace_id || null,
      event_type: 'ticket_rejected',
      status_from: previousStatus,
      status_to: ticket.status,
      actor: reviewer || null,
      reason: ticket.rejected_reason,
      risk_level: ticket.risk_level || null,
      ticket,
    });
    _pruneRetryPolicyApprovalArtifacts();
    _persist();
    return _clone(ticket);
  }

  function consumeRetryPolicyApprovalTicket(ticketId, input = {}) {
    _ensureLoaded();
    _maintainRetryPolicyApprovalArtifacts({ persist: false });
    const index = _findRetryPolicyApprovalTicketIndex(ticketId);
    if (index < 0) {
      return { ok: false, code: 'ticket_not_found', message: 'approval ticket not found.' };
    }
    const ticket = state.retry_policy_approval_tickets[index];
    if (ticket.status === 'expired') {
      return { ok: false, code: 'ticket_expired', message: 'approval ticket expired.' };
    }
    if (ticket.status !== 'approved') {
      return { ok: false, code: 'ticket_not_approved', message: `approval ticket status is ${ticket.status}.` };
    }
    if (ticket.consumed_at) {
      return { ok: false, code: 'ticket_already_consumed', message: 'approval ticket already consumed.' };
    }
    const expectedPatchHash = _computeRetryPolicyPatchHash(input.patch || {});
    if (ticket.patch_hash && expectedPatchHash !== ticket.patch_hash) {
      return { ok: false, code: 'ticket_patch_mismatch', message: 'approval ticket patch does not match request.' };
    }

    const previousStatus = ticket.status;
    ticket.status = 'consumed';
    ticket.consumed_at = _nowIso();
    _recordRetryPolicyApprovalEvent({
      ticket_id: ticket.ticket_id,
      trace_id: ticket.trace_id || null,
      event_type: 'ticket_consumed',
      status_from: previousStatus,
      status_to: ticket.status,
      actor: input.actor || null,
      reason: null,
      risk_level: ticket.risk_level || null,
      ticket,
    });
    _pruneRetryPolicyApprovalArtifacts();
    _persist();
    return { ok: true, ticket: _clone(ticket) };
  }

  function listRetryPolicyApprovalRetentionEvents(filter = {}) {
    _ensureLoaded();
    let events = Array.isArray(state.retry_policy_approval_retention_events)
      ? state.retry_policy_approval_retention_events
      : [];
    if (filter.after_id !== undefined && filter.after_id !== null) {
      const afterId = Number.parseInt(filter.after_id, 10);
      if (Number.isFinite(afterId) && afterId >= 0) {
        events = events.filter((event) => Number(event.retention_event_id || 0) > afterId);
      }
    }
    if (filter.trace_id) {
      events = events.filter((event) => event.trace_id === filter.trace_id);
    }
    if (filter.actor) {
      events = events.filter((event) => event.actor === filter.actor);
    }
    const limit = Math.max(1, Math.min(5_000, Number(filter.limit || events.length) || events.length));
    if (events.length > limit) {
      events = events.slice(events.length - limit);
    }
    return events.map(_clone);
  }

  function listRetryPolicyEvents(filter = {}) {
    _ensureLoaded();
    let events = Array.isArray(state.retry_policy_events) ? state.retry_policy_events : [];
    if (filter.after_id !== undefined && filter.after_id !== null) {
      const afterId = Number.parseInt(filter.after_id, 10);
      if (Number.isFinite(afterId) && afterId >= 0) {
        events = events.filter((event) => Number(event.policy_event_id || 0) > afterId);
      }
    }
    if (filter.trace_id) {
      events = events.filter((event) => event.trace_id === filter.trace_id);
    }
    const limit = Math.max(1, Math.min(5_000, Number(filter.limit || events.length) || events.length));
    if (events.length > limit) {
      events = events.slice(events.length - limit);
    }
    return events.map(_clone);
  }

  function updateRetryPolicy(nextPolicy = {}, meta = {}) {
    _ensureLoaded();
    const before = getRetryPolicy();
    const patch = _normalizeRetryPolicyPatch(nextPolicy);
    retryPolicy = _compileRetryPolicy(patch, retryPolicy);
    const after = getRetryPolicy();
    state.retry_policy = _clone(after);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    const event = _recordRetryPolicyEvent({
      trace_id: meta.trace_id || null,
      actor: meta.actor || null,
      source: meta.source || 'runtime',
      reason: meta.reason || null,
      patch,
      before_policy: before,
      after_policy: after,
      changed,
    });
    _persist();
    return {
      policy: after,
      changed,
      event: _clone(event),
    };
  }

  function setRetryPolicy(nextPolicy = {}, meta = {}) {
    return updateRetryPolicy(nextPolicy, meta).policy;
  }

  return {
    TASK_STATUSES,
    TERMINAL_STATUSES: new Set(TERMINAL_STATUSES),
    canTransition,
    createTask,
    getTask,
    listTasks,
    updateTaskFields,
    transitionTask,
    claimTask,
    claimNextTask,
    startTask,
    heartbeatTask,
    markSucceeded,
    markFailed,
    cancelTask,
    saveCheckpoint,
    listCheckpoints,
    getLatestCheckpoint,
    resumeFromCheckpoint,
    executeIdempotentSideEffect,
    requeueExpiredLeases,
    deleteTask,
    getAttempts,
    listTaskEvents,
    getTaskAudit,
    getMetricsSnapshot,
    subscribeTaskEvents,
    getRetryPolicy,
    getRetryPolicyApprovalRetention,
    updateRetryPolicyApprovalRetention,
    setRetryPolicyApprovalRetention,
    listRetryPolicyApprovalRetentionEvents,
    subscribeRetryPolicyApprovalRetentionEvents,
    createRetryPolicyApprovalTicket,
    getRetryPolicyApprovalTicket,
    listRetryPolicyApprovalTickets,
    listRetryPolicyApprovalEvents,
    approveRetryPolicyApprovalTicket,
    rejectRetryPolicyApprovalTicket,
    consumeRetryPolicyApprovalTicket,
    listRetryPolicyEvents,
    updateRetryPolicy,
    setRetryPolicy,
    subscribeRetryPolicyApprovalEvents,
    getSnapshot,
    resetForTests,
    getStorePath: () => storePath,
  };
}

const defaultStore = createLargeTaskRuntimeStore();

module.exports = {
  TASK_STATUSES,
  TERMINAL_STATUSES,
  STATUS_TRANSITIONS,
  createLargeTaskRuntimeStore,
  ...defaultStore,
};
