'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const _ctxStore = new AsyncLocalStorage();
const _sessions = new Map();
const _traceToSession = new Map();
let _defaultContext = { sessionId: null, traceId: null, requestId: null, role: null };
let _bridgeAttached = false;

// ── Bounded in-memory retention ──────────────────────────────────────────────
// `_sessions` and `_traceToSession` are summary/lookup caches for a long-running
// process. Without eviction they grow forever (every session + every traceId —
// and the diagnostics bridge mints a fresh traceId per request). The on-disk
// JSONL files remain the source of truth, so evicting an idle in-memory record
// is non-fatal: getSessionMeta returns null and logEvent lazily recreates a rec.
// Eviction = idle TTL + a hard LRU cap on sessions, plus a FIFO size cap on the
// trace map as an independent safety net. All knobs are env-tunable.
const _posInt = (raw, def) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const MAX_SESSIONS = _posInt(process.env.KHY_AUDIT_MAX_SESSIONS, 2000);
const MAX_TRACE_MAP = _posInt(process.env.KHY_AUDIT_MAX_TRACE_MAP, 20000);
const SESSION_TTL_MS = _posInt(process.env.KHY_AUDIT_SESSION_TTL_MS, 6 * 60 * 60 * 1000); // 6h idle
const SWEEP_INTERVAL_MS = _posInt(process.env.KHY_AUDIT_SWEEP_MS, 5 * 60 * 1000); // every 5min
let _sweepTimer = null;

// Evict idle/overflow sessions and the trace mappings that point at them.
function _sweepStale(now = Date.now()) {
  const evicted = [];
  // 1. TTL: drop sessions whose last activity is older than the idle window.
  for (const [id, rec] of _sessions) {
    const last = rec.lastActivityMs
      || Date.parse(rec.endedAt || rec.startedAt || '')
      || 0;
    if (now - last > SESSION_TTL_MS) {
      _sessions.delete(id);
      evicted.push(id);
    }
  }
  // 2. LRU cap: if still over the hard limit, evict the least-recently-active.
  if (_sessions.size > MAX_SESSIONS) {
    const sorted = [..._sessions.entries()]
      .sort((a, b) => (a[1].lastActivityMs || 0) - (b[1].lastActivityMs || 0));
    const overflow = _sessions.size - MAX_SESSIONS;
    for (let i = 0; i < overflow; i += 1) {
      _sessions.delete(sorted[i][0]);
      evicted.push(sorted[i][0]);
    }
  }
  // 3. Drop trace→session entries that point at an evicted session.
  if (evicted.length) {
    const gone = new Set(evicted);
    for (const [trace, sid] of _traceToSession) {
      if (gone.has(sid)) _traceToSession.delete(trace);
    }
  }
  // 4. Independent FIFO safety net for the trace map (covers traces registered
  // via setCurrentSession/attachTrace that never had a _sessions record). Map
  // preserves insertion order, so the first keys are the oldest.
  if (_traceToSession.size > MAX_TRACE_MAP) {
    const overflow = _traceToSession.size - MAX_TRACE_MAP;
    let i = 0;
    for (const trace of _traceToSession.keys()) {
      if (i >= overflow) break;
      _traceToSession.delete(trace);
      i += 1;
    }
  }
  return { sessions: _sessions.size, traceMap: _traceToSession.size };
}

// Lazily start one unref'd sweep timer. Skipped under the test runtime so jest
// never sees a lingering open handle (tests drive _sweepStale directly).
function _ensureSweeper() {
  if (_sweepTimer || _isTestRuntime()) return;
  _sweepTimer = setInterval(() => {
    try { _sweepStale(); } catch { /* best effort */ }
  }, SWEEP_INTERVAL_MS);
  _sweepTimer.unref?.();
}

let _pgPool = null;
let _pgInitPromise = null;
let _pgChain = Promise.resolve();

function _expandHome(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function _isTestRuntime() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'test'
    || String(process.env.JEST_WORKER_ID || '').trim() !== '';
}

function _auditRoot() {
  const fromEnv = _expandHome(process.env.KHY_TRACE_AUDIT_DIR || process.env.KHY_OBSERVABILITY_DIR || '');
  if (fromEnv) return path.resolve(fromEnv);
  if (_isTestRuntime()) {
    const workerId = String(process.env.JEST_WORKER_ID || '0').trim() || '0';
    return path.join(os.tmpdir(), 'khy-audit-jest', `worker-${workerId}`);
  }
  return path.join(os.homedir(), '.khy', 'audit');
}

const AUDIT_ROOT = _auditRoot();
const EVENTS_FILE = path.join(AUDIT_ROOT, 'trace-events.jsonl');
const SESSION_DIR = path.join(AUDIT_ROOT, 'sessions');
const SUMMARY_DIR = path.join(AUDIT_ROOT, 'summaries');
const EXPORT_DIR = path.join(AUDIT_ROOT, 'exports');

function _ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function _ensureAuditDirs() {
  _ensureDir(AUDIT_ROOT);
  _ensureDir(SESSION_DIR);
  _ensureDir(SUMMARY_DIR);
  _ensureDir(EXPORT_DIR);
}

function _sessionFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(SESSION_DIR, `${safe}.jsonl`);
}

function _safeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function _safeTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

const _sensitiveKeyRe = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|session|private[_-]?key|access[_-]?key)/i;
const _reasoningKeyRe = /(reasoning|thinking|chain[_-]?of[_-]?thought|scratchpad|cot|internal[_-]?notes?)/i;
const _reasoningPreviewRe = /<think>[\s\S]*?<\/think>/gi;

function _clipText(value, maxLen = 1200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function _sanitizeValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (_sensitiveKeyRe.test(String(key || ''))) return '***redacted***';

  if (typeof value === 'string') {
    const withoutThink = value.replace(_reasoningPreviewRe, '[redacted-thinking]');
    return _clipText(withoutThink, 2000);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function') return '[function]';
  if (value instanceof Date) return value.toISOString();
  if (depth >= 5) return '[max-depth]';

  if (Array.isArray(value)) {
    const maxItems = 64;
    const out = value.slice(0, maxItems).map((item) => _sanitizeValue(item, key, depth + 1, seen));
    if (value.length > maxItems) out.push(`[+${value.length - maxItems} items]`);
    return out;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = {};
    const keys = Object.keys(value).slice(0, 120);
    for (const k of keys) {
      if (String(k).startsWith('_') && k !== '_diagTraceId') continue;
      out[k] = _sanitizeValue(value[k], k, depth + 1, seen);
    }
    if (Object.keys(value).length > keys.length) {
      out.__truncatedKeys = Object.keys(value).length - keys.length;
    }
    return out;
  }

  return _clipText(String(value), 400);
}

function _stripReasoningFields(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(_reasoningPreviewRe, '[redacted-thinking]');
  if (Array.isArray(value)) return value.map((item) => _stripReasoningFields(item));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (_reasoningKeyRe.test(k)) continue;
    out[k] = _stripReasoningFields(v);
  }
  return out;
}

function _internalRoleSet() {
  const raw = process.env.KHY_AUDIT_INTERNAL_ROLES || 'owner,admin,auditor';
  return new Set(
    raw
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean)
  );
}

function _canViewInternal(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (!normalized) return false;
  return _internalRoleSet().has(normalized);
}

function _toIso(ts) {
  const d = ts ? new Date(ts) : new Date();
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

function _appendJsonLine(filePath, row) {
  try {
    _ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf-8');
  } catch {
    // best effort
  }
}

function _writeLocal(event) {
  _appendJsonLine(EVENTS_FILE, event);
  _appendJsonLine(_sessionFile(event.sessionId), event);
}

function _headersFromEnv(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    return {};
  }
  return {};
}

async function _sendHttp(endpoint, payload, extraHeaders = {}) {
  if (!endpoint) return;
  const timeoutMs = Math.max(500, parseInt(process.env.KHY_AUDIT_HTTP_TIMEOUT_MS || '2000', 10) || 2000);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    timer.unref?.();
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch {
    // best effort
  }
}

function _dispatchRemoteSinks(event) {
  const enableRemote = String(process.env.KHY_AUDIT_REMOTE_SINKS || 'true').toLowerCase() !== 'false';
  if (!enableRemote) return;

  setImmediate(() => {
    const httpEndpoint = String(process.env.KHY_AUDIT_HTTP_ENDPOINT || '').trim();
    if (httpEndpoint) {
      const headers = _headersFromEnv(process.env.KHY_AUDIT_HTTP_HEADERS || '');
      _sendHttp(httpEndpoint, event, headers).catch(() => {});
    }

    const clickhouseEndpoint = String(process.env.KHY_AUDIT_CLICKHOUSE_ENDPOINT || '').trim();
    if (clickhouseEndpoint) {
      const headers = _headersFromEnv(process.env.KHY_AUDIT_CLICKHOUSE_HEADERS || '');
      const body = `${JSON.stringify(event)}\n`;
      const timeoutMs = Math.max(500, parseInt(process.env.KHY_AUDIT_HTTP_TIMEOUT_MS || '2000', 10) || 2000);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
        timer.unref?.();
        fetch(clickhouseEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body,
          signal: ctrl.signal,
        }).finally(() => clearTimeout(timer)).catch(() => {});
      } catch {
        // best effort
      }
    }

    const postgresDsn = String(process.env.KHY_AUDIT_POSTGRES_DSN || '').trim();
    if (postgresDsn) {
      _pgChain = _pgChain.then(() => _insertPostgres(postgresDsn, event)).catch(() => {});
    }
  });
}

async function _initPostgres(dsn) {
  if (_pgPool) return _pgPool;
  if (_pgInitPromise) return _pgInitPromise;
  _pgInitPromise = (async () => {
    const { Pool } = require('pg');
    _pgPool = new Pool({ connectionString: dsn });
    await _pgPool.query(`
      CREATE TABLE IF NOT EXISTS khy_trace_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT,
        trace_id TEXT,
        event_type TEXT,
        visibility TEXT,
        ts TIMESTAMPTZ,
        payload JSONB
      );
    `);
    await _pgPool.query('CREATE INDEX IF NOT EXISTS khy_trace_events_session_idx ON khy_trace_events (session_id);');
    await _pgPool.query('CREATE INDEX IF NOT EXISTS khy_trace_events_trace_idx ON khy_trace_events (trace_id);');
    return _pgPool;
  })().catch((err) => {
    _pgInitPromise = null;
    throw err;
  });
  return _pgInitPromise;
}

async function _insertPostgres(dsn, event) {
  try {
    const pool = await _initPostgres(dsn);
    await pool.query(
      `INSERT INTO khy_trace_events (event_id, session_id, trace_id, event_type, visibility, ts, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.id,
        event.sessionId || null,
        event.traceId || null,
        event.type || null,
        event.visibility || 'summary',
        event.timestamp || null,
        JSON.stringify(event),
      ]
    );
  } catch {
    // best effort
  }
}

function _normalizeContext(ctx = {}) {
  const role = String(ctx.role || ctx.actorRole || '').trim().toLowerCase() || null;
  const sessionId = ctx.sessionId ? String(ctx.sessionId) : null;
  const traceId = ctx.traceId ? String(ctx.traceId) : null;
  const requestId = ctx.requestId ? String(ctx.requestId) : (traceId || null);
  return { sessionId, traceId, requestId, role };
}

function getContext() {
  const active = _ctxStore.getStore() || {};
  return {
    sessionId: active.sessionId || _defaultContext.sessionId || null,
    traceId: active.traceId || _defaultContext.traceId || null,
    requestId: active.requestId || _defaultContext.requestId || active.traceId || _defaultContext.traceId || null,
    role: active.role || _defaultContext.role || null,
  };
}

function setCurrentSession(sessionId, context = {}) {
  const normalized = _normalizeContext({ ...context, sessionId });
  _defaultContext = {
    sessionId: normalized.sessionId || _defaultContext.sessionId || null,
    traceId: normalized.traceId || _defaultContext.traceId || null,
    requestId: normalized.requestId || normalized.traceId || _defaultContext.requestId || _defaultContext.traceId || null,
    role: normalized.role || _defaultContext.role || null,
  };
  if (normalized.traceId && normalized.sessionId) {
    _traceToSession.set(normalized.traceId, normalized.sessionId);
  }
  return { ..._defaultContext };
}

function runWithContext(context, fn) {
  const merged = { ...getContext(), ..._normalizeContext(context || {}) };
  return _ctxStore.run(merged, fn);
}

function attachTrace(traceId, sessionId) {
  const trace = String(traceId || '').trim();
  const session = String(sessionId || '').trim();
  if (!trace || !session) return;
  _traceToSession.set(trace, session);
}

function startSession(meta = {}) {
  _ensureAuditDirs();
  const sessionId = String(meta.sessionId || _safeId('sess'));
  const traceId = String(meta.traceId || _safeTraceId());
  const requestId = String(meta.requestId || traceId);
  const nowIso = new Date().toISOString();
  const rec = {
    sessionId,
    traceId,
    requestId,
    startedAt: nowIso,
    endedAt: null,
    events: 0,
    meta: _sanitizeValue(meta || {}),
    summary: null,
    lastActivityMs: Date.now(),
  };
  _sessions.set(sessionId, rec);
  _traceToSession.set(traceId, sessionId);
  setCurrentSession(sessionId, { traceId, requestId, role: meta.role || meta.actorRole || null });
  logEvent('session.start', {
    reason: meta.reason || null,
    source: meta.source || null,
    cwd: process.cwd(),
    pid: process.pid,
  }, {
    sessionId,
    traceId,
    requestId,
    role: meta.role || meta.actorRole || null,
    visibility: 'summary',
    source: 'trace-audit',
    persistSessionMeta: false,
  });
  return { sessionId, traceId, startedAt: nowIso };
}

function _resolveSessionId(traceId, sessionId) {
  if (sessionId) return String(sessionId);
  const trace = String(traceId || '').trim();
  if (trace && _traceToSession.has(trace)) return _traceToSession.get(trace);
  const ctx = getContext();
  if (ctx.sessionId) return ctx.sessionId;
  return String(_safeId('sess'));
}

function _resolveTraceId(traceId, sessionId) {
  if (traceId) return String(traceId);
  const ctx = getContext();
  if (ctx.traceId) return ctx.traceId;
  if (sessionId) {
    const rec = _sessions.get(sessionId);
    if (rec && rec.traceId) return rec.traceId;
  }
  return null;
}

function logEvent(type, payload = {}, ctx = {}) {
  _ensureAuditDirs();
  _ensureSweeper();
  const mergedCtx = { ...getContext(), ..._normalizeContext(ctx || {}) };
  const sessionId = _resolveSessionId(mergedCtx.traceId, mergedCtx.sessionId);
  const traceId = _resolveTraceId(mergedCtx.traceId, sessionId);
  const requestId = String(mergedCtx.requestId || traceId || '').trim() || null;
  if (traceId) _traceToSession.set(traceId, sessionId);

  const visibility = String(ctx.visibility || 'summary').toLowerCase();
  const event = {
    id: _safeId('evt'),
    type: String(type || 'unknown'),
    timestamp: _toIso(ctx.timestamp || Date.now()),
    ts: Number(ctx.timestamp || Date.now()),
    sessionId,
    traceId,
    requestId,
    spanId: ctx.spanId || null,
    parentSpanId: ctx.parentSpanId || null,
    source: ctx.source || 'khy-os',
    visibility,
    data: _sanitizeValue(payload || {}),
  };

  _writeLocal(event);
  _dispatchRemoteSinks(event);

  const rec = _sessions.get(sessionId) || {
    sessionId,
    traceId: traceId || null,
    requestId,
    startedAt: event.timestamp,
    endedAt: null,
    events: 0,
    meta: {},
    summary: null,
  };
  rec.events = (rec.events || 0) + 1;
  if (!rec.traceId && traceId) rec.traceId = traceId;
  if (!rec.requestId && requestId) rec.requestId = requestId;
  rec.lastActivityMs = Date.now();
  _sessions.set(sessionId, rec);
  return event;
}

function _readJsonLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function _internalSummaryData(event) {
  const d = event.data || {};
  return {
    model: d.model || d.requestedModel || null,
    provider: d.provider || d.adapter || d.adapterKey || null,
    tool: d.tool || d.toolName || null,
    success: d.success === true,
    denied: !!d.denied,
    permission: d.permission || null,
    statusCode: d.statusCode || null,
    durationMs: d.durationMs || d.elapsedMs || d.elapsed || null,
    inputTokens: d.inputTokens || null,
    outputTokens: d.outputTokens || null,
    totalTokens: d.totalTokens || null,
    error: d.error ? _clipText(d.error, 200) : null,
    redacted: true,
  };
}

function _projectEventForRole(event, role, includeReasoning = false) {
  const cloned = JSON.parse(JSON.stringify(event));
  const canInternal = _canViewInternal(role);
  if (!includeReasoning || !canInternal) {
    cloned.data = _stripReasoningFields(cloned.data);
  }
  if (!canInternal && String(cloned.visibility || 'summary') === 'internal') {
    cloned.data = _internalSummaryData(cloned);
  }
  return cloned;
}

function getSessionEvents(sessionId, options = {}) {
  const role = String(options.role || 'viewer').toLowerCase();
  const includeReasoning = options.includeReasoning === true;
  const limit = Math.max(1, parseInt(options.limit || '5000', 10) || 5000);
  const file = _sessionFile(sessionId);
  const rows = _readJsonLines(file);
  const projected = rows.map((row) => _projectEventForRole(row, role, includeReasoning));
  return projected.slice(Math.max(0, projected.length - limit));
}

function listSessions(limit = 100) {
  _ensureAuditDirs();
  try {
    const files = fs.readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const filePath = path.join(SESSION_DIR, f);
        const stat = fs.statSync(filePath);
        return {
          sessionId: f.replace(/\.jsonl$/i, ''),
          filePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

async function exportSessionJson(sessionId, options = {}) {
  const role = String(options.role || process.env.KHY_AUDIT_EXPORT_ROLE || 'viewer').toLowerCase();
  const includeReasoning = options.includeReasoning === true;
  const events = getSessionEvents(sessionId, { role, includeReasoning, limit: options.limit || 1000000 });
  const name = String(sessionId || _safeId('session')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const outFile = options.outFile
    ? path.resolve(_expandHome(options.outFile))
    : path.join(EXPORT_DIR, `${name}.${role}.json`);

  _ensureDir(path.dirname(outFile));
  const payload = {
    exportedAt: new Date().toISOString(),
    sessionId: name,
    role,
    includeReasoning,
    eventCount: events.length,
    events,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf-8');

  const uploadS3 = options.uploadS3 === true || String(process.env.KHY_AUDIT_EXPORT_S3 || 'false').toLowerCase() === 'true';
  let s3Key = null;
  if (uploadS3) {
    s3Key = await _tryUploadToS3(outFile, options.s3Key || `audit-exports/${path.basename(outFile)}`);
  }

  return { outFile, eventCount: events.length, s3Key };
}

async function _tryUploadToS3(localPath, key) {
  const bucket = String(process.env.KHY_AUDIT_S3_BUCKET || '').trim();
  if (!bucket) return null;
  try {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const region = process.env.KHY_AUDIT_S3_REGION || process.env.AWS_REGION || 'us-east-1';
    const client = new S3Client({ region });
    const body = fs.readFileSync(localPath);
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
    }));
    return key;
  } catch {
    return null;
  }
}

function buildSessionSummary(sessionId, options = {}) {
  const events = getSessionEvents(sessionId, {
    role: options.role || 'admin',
    includeReasoning: options.includeReasoning === true,
    limit: options.limit || 200000,
  });
  const { buildSessionSummary: buildSummary, writeSessionSummary } = require('./sessionTraceSummary');
  const rec = _sessions.get(sessionId);
  const summary = buildSummary(events, {
    sessionId,
    traceId: rec?.traceId || options.traceId || null,
    reason: options.reason || null,
  });
  const files = writeSessionSummary(sessionId, summary, SUMMARY_DIR);
  if (rec) rec.summary = files;
  return { summary, ...files };
}

async function generateSessionSummary(sessionId, options = {}) {
  const base = buildSessionSummary(sessionId, options);
  const { compressSummaryWithLLM } = require('./sessionTraceSummary');
  const llmSummary = await compressSummaryWithLLM(base.summary, options);
  if (llmSummary) {
    const llmPath = path.join(SUMMARY_DIR, `${String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_')}.llm.md`);
    fs.writeFileSync(llmPath, llmSummary, 'utf-8');
    return { ...base, llmPath };
  }
  return base;
}

function endSession(sessionId, options = {}) {
  const id = String(sessionId || getContext().sessionId || '').trim();
  if (!id) return { sessionId: null, summaryPath: null };
  const rec = _sessions.get(id) || {
    sessionId: id,
    traceId: options.traceId || getContext().traceId || null,
    startedAt: null,
    endedAt: null,
    events: 0,
    meta: {},
    summary: null,
  };
  rec.endedAt = new Date().toISOString();
  rec.lastActivityMs = Date.now();
  _sessions.set(id, rec);
  logEvent('session.end', {
    reason: options.reason || 'normal',
    totalEvents: rec.events || 0,
  }, {
    sessionId: id,
    traceId: rec.traceId || options.traceId || null,
    role: options.role || getContext().role || null,
    visibility: 'summary',
    source: 'trace-audit',
  });

  let summaryPath = null;
  let summaryJsonPath = null;
  const autoSummary = options.autoSummary !== false;
  if (autoSummary) {
    try {
      const out = buildSessionSummary(id, { reason: options.reason || 'normal', role: 'admin' });
      summaryPath = out.mdPath;
      summaryJsonPath = out.jsonPath;
    } catch {
      summaryPath = null;
      summaryJsonPath = null;
    }
  }
  return { sessionId: id, summaryPath, summaryJsonPath };
}

function ensureDiagnosticsBridge() {
  if (_bridgeAttached) return;
  try {
    const { diagnostics } = require('./diagnosticEvents');
    diagnostics.on('*', (event) => {
      if (!event || !event.type) return;
      const visibility = (event.type === 'model_request' || event.type === 'model_response') ? 'internal' : 'summary';
      logEvent(`diag.${event.type}`, {
        ...(event.data || {}),
        attention: event.attention || null,
      }, {
        sessionId: _traceToSession.get(event.traceId) || null,
        traceId: event.traceId || null,
        requestId: event.requestId || event.traceId || null,
        spanId: event.spanId || null,
        parentSpanId: event.parentSpanId || null,
        source: 'diagnostics',
        visibility,
        timestamp: event.timestamp || Date.now(),
      });
    });
    _bridgeAttached = true;
  } catch {
    _bridgeAttached = false;
  }
}

function getStorageStatus() {
  return {
    root: AUDIT_ROOT,
    eventsFile: EVENTS_FILE,
    sessionDir: SESSION_DIR,
    summaryDir: SUMMARY_DIR,
    exportDir: EXPORT_DIR,
    sinks: {
      local: true,
      http: !!String(process.env.KHY_AUDIT_HTTP_ENDPOINT || '').trim(),
      clickhouse: !!String(process.env.KHY_AUDIT_CLICKHOUSE_ENDPOINT || '').trim(),
      postgres: !!String(process.env.KHY_AUDIT_POSTGRES_DSN || '').trim(),
      s3: !!String(process.env.KHY_AUDIT_S3_BUCKET || '').trim(),
    },
  };
}

function getSessionMeta(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const rec = _sessions.get(id);
  if (!rec) return null;
  return { ...rec };
}

function getLatestDeliveryRequestSummary(options = {}) {
  const sessionId = _resolveRecentSessionId(options);
  if (!sessionId) {
    return {
      ok: false,
      reason: 'no_session',
      summary: '当前无活动会话，尚无法评估交付链路',
    };
  }

  const events = getSessionEvents(sessionId, {
    role: options.role || 'admin',
    includeReasoning: false,
    limit: options.limit || 500,
  });
  if (!Array.isArray(events) || events.length === 0) {
    return {
      ok: false,
      reason: 'no_events',
      sessionId,
      summary: '当前会话尚无审计事件，无法评估交付链路',
    };
  }

  const latestWithRequestId = [...events].reverse().find((event) => String(event?.requestId || '').trim());
  const requestId = String(options.requestId || latestWithRequestId?.requestId || '').trim();
  if (!requestId) {
    return {
      ok: false,
      reason: 'no_request_id',
      sessionId,
      summary: '当前会话尚无 requestId 事件，无法定位最近一次交付链路',
    };
  }

  const related = events.filter((event) => String(event?.requestId || '').trim() === requestId);
  const snapshot = _buildRequestFlowSnapshot(related, requestId);
  return {
    ok: true,
    sessionId,
    ...snapshot,
  };
}

function _findLatestLanguageEvent(events, requestId = '') {
  const normalizedRequestId = String(requestId || '').trim();
  const related = [...events].filter((event) => {
    const type = String(event?.type || '').trim();
    if (type !== 'agent.language.first_chunk' && type !== 'agent.language.final_response') {
      return false;
    }
    if (!normalizedRequestId) return true;
    return String(event?.requestId || '').trim() === normalizedRequestId;
  });
  if (related.length === 0) return null;
  const preferredFirstChunk = [...related].reverse().find(
    (event) => String(event?.type || '').trim() === 'agent.language.first_chunk'
  );
  if (preferredFirstChunk) return preferredFirstChunk;
  return related[related.length - 1] || null;
}

function _buildRequestFlowSnapshot(related = [], requestId = '') {
  const normalizedRequestId = String(requestId || '').trim();
  const hasModelRequest = related.some((event) => event.type === 'diag.model_request' || event.type === 'llm.request');
  const hasToolCall = related.some((event) => event.type === 'diag.tool_call' || event.type === 'agent.tool.call');
  const hasToolResult = related.some((event) => event.type === 'diag.tool_result' || event.type === 'agent.tool.result');
  const hasModelResponse = related.some((event) => event.type === 'diag.model_response' || event.type === 'llm.response');
  const hasToolLoopContext = related.some((event) => {
    const type = String(event?.type || '').trim();
    const source = String(event?.source || '').trim().toLowerCase();
    return type === 'agent.loop.start'
      || source === 'tool-loop'
      || type === 'agent.tool.call'
      || type === 'agent.tool.result'
      || type === 'diag.tool_call'
      || type === 'diag.tool_result';
  });
  const deliveryFinalEvent = [...related].reverse().find((event) => event.type === 'agent.delivery.final') || null;
  const hasDeliveryFinal = !!deliveryFinalEvent;
  const hasDeliveryConclusion = deliveryFinalEvent?.data?.hasConclusion === true;
  const lastEvent = related[related.length - 1] || null;
  const hasChainEvidence = hasModelRequest || hasToolCall || hasToolResult || hasModelResponse;

  if (!hasChainEvidence && hasDeliveryFinal) {
    const status = hasDeliveryConclusion ? 'completed' : 'summary_only';
    const summary = hasDeliveryConclusion
      ? `最近一次交付已完成（requestId=${normalizedRequestId}；仅记录最终交付事件）`
      : `最近一次仅记录到最终交付事件（requestId=${normalizedRequestId}）；暂缺请求/响应明细，无法判定链路是否断裂`;
    return {
      requestId: normalizedRequestId,
      status,
      brokenStage: null,
      summary,
      eventCount: related.length,
      checks: {
        modelRequest: false,
        toolCall: false,
        toolResult: false,
        modelResponse: false,
        deliveryFinal: true,
        deliveryConclusion: hasDeliveryConclusion,
      },
      lastEvent: lastEvent ? {
        type: lastEvent.type,
        timestamp: lastEvent.timestamp,
        source: lastEvent.source,
      } : null,
    };
  }

  if (hasModelRequest && hasModelResponse && !hasDeliveryFinal && !hasToolLoopContext) {
    return {
      requestId: normalizedRequestId,
      status: 'response_only',
      brokenStage: null,
      summary: `最近一次请求已收到模型答复（requestId=${normalizedRequestId}；独立 chat 路径未记录 agent.delivery.final）`,
      eventCount: related.length,
      checks: {
        modelRequest: hasModelRequest,
        toolCall: hasToolCall,
        toolResult: hasToolResult,
        modelResponse: hasModelResponse,
        deliveryFinal: hasDeliveryFinal,
        deliveryConclusion: hasDeliveryConclusion,
      },
      lastEvent: lastEvent ? {
        type: lastEvent.type,
        timestamp: lastEvent.timestamp,
        source: lastEvent.source,
      } : null,
    };
  }

  const status = hasModelRequest && hasModelResponse && hasDeliveryConclusion
    ? 'completed'
    : (hasModelRequest || hasToolCall || hasToolResult ? 'incomplete' : 'unknown');
  const brokenStage = hasModelRequest && !hasModelResponse
    ? (!hasToolCall ? 'before_tool_call' : (!hasToolResult ? 'tool_execution' : 'after_tool_result'))
    : (hasModelResponse && hasDeliveryFinal && !hasDeliveryConclusion ? 'final_conclusion' : (hasModelResponse && !hasDeliveryFinal ? 'delivery_event_missing' : null));
  const summary = status === 'completed'
    ? `最近一次交付链路已完成（requestId=${normalizedRequestId}）`
    : `最近一次交付链路可能断裂（requestId=${normalizedRequestId}${brokenStage ? `，阶段=${brokenStage}` : ''}）`;

  return {
    requestId: normalizedRequestId,
    status,
    brokenStage,
    summary,
    eventCount: related.length,
    checks: {
      modelRequest: hasModelRequest,
      toolCall: hasToolCall,
      toolResult: hasToolResult,
      modelResponse: hasModelResponse,
      deliveryFinal: hasDeliveryFinal,
      deliveryConclusion: hasDeliveryConclusion,
    },
    lastEvent: lastEvent ? {
      type: lastEvent.type,
      timestamp: lastEvent.timestamp,
      source: lastEvent.source,
    } : null,
  };
}

function getLatestLanguageConsistencySummary(options = {}) {
  const sessionId = _resolveRecentSessionId(options);
  if (!sessionId) {
    return {
      ok: false,
      reason: 'no_session',
      summary: '当前无活动会话，尚无法评估语言一致性',
    };
  }

  const events = getSessionEvents(sessionId, {
    role: options.role || 'admin',
    includeReasoning: false,
    limit: options.limit || 500,
  });
  if (!Array.isArray(events) || events.length === 0) {
    return {
      ok: false,
      reason: 'no_events',
      sessionId,
      summary: '当前会话尚无审计事件，无法评估语言一致性',
    };
  }

  const latestWithRequestId = [...events].reverse().find((event) => String(event?.requestId || '').trim());
  const targetRequestId = String(options.requestId || latestWithRequestId?.requestId || '').trim();
  const languageEvent = _findLatestLanguageEvent(events, targetRequestId);
  if (!languageEvent) {
    const related = targetRequestId
      ? events.filter((event) => String(event?.requestId || '').trim() === targetRequestId)
      : [];
    const requestState = related.length > 0 ? _buildRequestFlowSnapshot(related, targetRequestId) : null;
    if (requestState?.checks?.modelRequest && !requestState?.checks?.modelResponse) {
      return {
        ok: false,
        reason: 'awaiting_model_output_for_request',
        blockedBy: 'pre_response_stall',
        sessionId,
        requestId: targetRequestId || null,
        requestState,
        summary: `requestId=${targetRequestId} 尚无语言一致性审计事件；当前请求仍停在模型响应前（阶段=${requestState.brokenStage || 'unknown'}）`,
      };
    }
    if (requestState?.checks?.modelResponse) {
      return {
        ok: false,
        reason: 'language_audit_missing_after_response',
        blockedBy: 'language_audit_gap',
        sessionId,
        requestId: targetRequestId || null,
        requestState,
        summary: `requestId=${targetRequestId} 已收到模型响应，但尚无语言一致性审计事件；请复查语言审计钩子或当前适配器输出路径`,
      };
    }
    return {
      ok: false,
      reason: targetRequestId ? 'no_language_event_for_request' : 'no_language_event',
      sessionId,
      requestId: targetRequestId || null,
      requestState,
      summary: targetRequestId
        ? `requestId=${targetRequestId} 尚无语言一致性审计事件`
        : '当前尚无语言一致性审计事件',
    };
  }

  const requestId = String(languageEvent.requestId || '').trim() || null;
  const data = languageEvent.data || {};
  const matchesExpectation = data.matchesExpectation !== false;
  const detectedLanguage = String(data.detectedLanguage || 'unknown');
  const expectedLanguage = String(data.expectedLanguage || 'zh');
  const adapter = String(data.adapterName || data.adapter || 'unknown');
  const sourceType = String(languageEvent.type || '').trim();
  const source = sourceType === 'agent.language.first_chunk' ? 'first_chunk' : 'final_response';
  const summary = matchesExpectation
    ? `最近一次语言一致性正常（adapter=${adapter}，requestId=${requestId || '-'}，来源=${source}）`
    : `最近一次语言一致性异常（adapter=${adapter}，requestId=${requestId || '-'}，检测=${detectedLanguage}，期望=${expectedLanguage}，来源=${source}）`;

  return {
    ok: true,
    sessionId,
    requestId,
    status: matchesExpectation ? 'aligned' : 'mismatch',
    adapter,
    source,
    detectedLanguage,
    expectedLanguage,
    matchesExpectation,
    riskyAdapter: data.riskyAdapter !== false,
    textSample: String(data.textSample || '').trim(),
    summary,
    event: {
      type: languageEvent.type,
      timestamp: languageEvent.timestamp,
      source: languageEvent.source,
    },
  };
}

function _resolveRecentSessionId(options = {}) {
  const explicit = String(options.sessionId || getContext().sessionId || '').trim();
  if (explicit) return explicit;
  const sessions = listSessions(options.sessionLimit || 20);
  if (!Array.isArray(sessions) || sessions.length === 0) return '';
  return String(sessions[0]?.sessionId || '').trim();
}

function _findSessionIdForRequest(requestId, options = {}) {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId) return '';

  const sessionLimit = Math.max(
    1,
    parseInt(
      options.requestLookupSessionLimit
      || process.env.KHY_AUDIT_REQUEST_LOOKUP_SESSION_LIMIT
      || '50',
      10
    ) || 50
  );
  const sessions = listSessions(sessionLimit);
  for (const session of sessions) {
    const sessionId = String(session?.sessionId || '').trim();
    if (!sessionId) continue;
    const rows = _readJsonLines(_sessionFile(sessionId));
    if (rows.some((row) => String(row?.requestId || '').trim() === normalizedRequestId)) {
      return sessionId;
    }
  }
  return '';
}

function _resolveSessionIdForRequest(options = {}) {
  const explicitSessionId = String(options.sessionId || '').trim();
  if (explicitSessionId) return explicitSessionId;

  const explicitRequestId = String(options.requestId || '').trim();
  if (explicitRequestId) {
    const matchedSessionId = _findSessionIdForRequest(explicitRequestId, options);
    if (matchedSessionId) return matchedSessionId;
  }

  return _resolveRecentSessionId(options);
}

function _collectRequestEvents(options = {}) {
  const sessionId = _resolveSessionIdForRequest(options);
  if (!sessionId) {
    return {
      ok: false,
      reason: 'no_session',
      summary: '当前无可用审计会话，无法复盘 requestId',
    };
  }

  const events = getSessionEvents(sessionId, {
    role: options.role || 'admin',
    includeReasoning: false,
    limit: options.limit || 1000,
  });
  if (!Array.isArray(events) || events.length === 0) {
    return {
      ok: false,
      reason: 'no_events',
      sessionId,
      summary: '当前会话尚无审计事件，无法复盘 requestId',
    };
  }

  const latestWithRequestId = [...events].reverse().find((event) => String(event?.requestId || '').trim());
  const requestId = String(options.requestId || latestWithRequestId?.requestId || '').trim();
  if (!requestId) {
    return {
      ok: false,
      reason: 'no_request_id',
      sessionId,
      summary: '当前会话尚无 requestId 事件，无法复盘',
    };
  }

  const related = events.filter((event) => String(event?.requestId || '').trim() === requestId);
  if (related.length === 0) {
    return {
      ok: false,
      reason: 'request_not_found',
      sessionId,
      requestId,
      summary: `未找到 requestId=${requestId} 对应的审计事件`,
    };
  }

  return {
    ok: true,
    sessionId,
    requestId,
    events,
    related,
  };
}

function _mapTraceStage(eventType) {
  const type = String(eventType || '').trim();
  if (!type) return 'unknown';
  if (type === 'diag.model_request' || type === 'llm.request') return 'model_request';
  if (type === 'diag.tool_call' || type === 'agent.tool.call') return 'tool_call';
  if (type === 'diag.tool_result' || type === 'agent.tool.result') return 'tool_result';
  if (type === 'diag.model_response' || type === 'llm.response') return 'model_response';
  if (type === 'agent.delivery.final') return 'delivery_final';
  if (type === 'agent.language.first_chunk') return 'language_first_chunk';
  if (type === 'agent.language.final_response') return 'language_final_response';
  if (type === 'session.start') return 'session_start';
  if (type === 'session.end') return 'session_end';
  return 'other';
}

function getRequestTraceSummary(options = {}) {
  const collected = _collectRequestEvents(options);
  if (!collected.ok) return collected;

  const delivery = getLatestDeliveryRequestSummary({
    ...options,
    sessionId: collected.sessionId,
    requestId: collected.requestId,
  });
  const language = getLatestLanguageConsistencySummary({
    ...options,
    sessionId: collected.sessionId,
    requestId: collected.requestId,
  });
  const relatedLanguage = language && (
    language.ok
    || String(language.requestId || '').trim() === collected.requestId
  ) ? language : null;

  const related = collected.related;
  const typeCounts = {};
  for (const event of related) {
    const key = String(event?.type || 'unknown');
    typeCounts[key] = (typeCounts[key] || 0) + 1;
  }
  const lastEvent = related[related.length - 1] || null;
  const firstEvent = related[0] || null;
  const timeline = related.slice(-12).map((event) => ({
    stage: _mapTraceStage(event.type),
    type: event.type,
    timestamp: event.timestamp,
    source: event.source,
  }));
  const summaryParts = [];
  summaryParts.push(delivery?.summary || `requestId=${collected.requestId}`);
  if (relatedLanguage?.summary) summaryParts.push(relatedLanguage.summary);
  if (lastEvent?.type) summaryParts.push(`最后事件=${lastEvent.type}`);

  return {
    ok: true,
    sessionId: collected.sessionId,
    requestId: collected.requestId,
    summary: summaryParts.join('；'),
    totalEvents: related.length,
    firstEvent: firstEvent ? {
      type: firstEvent.type,
      timestamp: firstEvent.timestamp,
      source: firstEvent.source,
    } : null,
    lastEvent: lastEvent ? {
      type: lastEvent.type,
      timestamp: lastEvent.timestamp,
      source: lastEvent.source,
    } : null,
    delivery: delivery && delivery.ok ? delivery : null,
    language: relatedLanguage,
    typeCounts,
    timeline,
  };
}

module.exports = {
  AUDIT_ROOT,
  EVENTS_FILE,
  SESSION_DIR,
  SUMMARY_DIR,
  EXPORT_DIR,
  startSession,
  endSession,
  logEvent,
  getSessionEvents,
  listSessions,
  exportSessionJson,
  buildSessionSummary,
  generateSessionSummary,
  ensureDiagnosticsBridge,
  getStorageStatus,
  getSessionMeta,
  getLatestDeliveryRequestSummary,
  getLatestLanguageConsistencySummary,
  getRequestTraceSummary,
  setCurrentSession,
  runWithContext,
  getContext,
  attachTrace,
  // ── Retention / test hooks ──
  _sweepStale,
  _retentionStats: () => ({
    sessions: _sessions.size,
    traceMap: _traceToSession.size,
    maxSessions: MAX_SESSIONS,
    maxTraceMap: MAX_TRACE_MAP,
    sessionTtlMs: SESSION_TTL_MS,
  }),
  _resetForTest: () => {
    _sessions.clear();
    _traceToSession.clear();
    if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
  },
};
