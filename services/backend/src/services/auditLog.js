/**
 * Audit Log — JSONL-based tool execution audit trail.
 *
 * Every tool execution is logged with parameters, result, permission
 * decision, and elapsed time. Supports querying, per-module stats and rotation.
 *
 * Record shape (8 mandatory fields, one JSON object per line):
 *   timestamp  ISO 8601
 *   tool       tool / operation name
 *   params     sanitized — SENSITIVE_KEYS → '***', `_`-prefixed keys dropped
 *   result     { success: boolean, error?: first sentence, <= ERROR_CHARS }
 *   permission allow | deny | allow-session | allow-always | unknown
 *   elapsed    ms
 *   user       OS user
 *   sessionId  per-process session id
 *
 * Log file: <app home>/audit.jsonl
 * Rotation: KHY_AUDIT_MAX_BYTES (10MB) → .1 → .2 → .3, oldest dropped.
 *
 * Every write path is fail-soft: a broken disk, a read-only home or a failed
 * rotation must never propagate into the caller. The audit trail is evidence,
 * not control flow.
 */
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const envInt = require('../utils/envInt');

// ── Tunables ────────────────────────────────────────────────────────
// Read per call (not frozen at require time) so a test or an operator can
// retune without restarting the process — and so nothing here is a magic
// number buried in a branch (AGENTS 规则 1).

/** Rotate once the live file reaches this many bytes. */
const _maxSize = () => envInt('KHY_AUDIT_MAX_BYTES', 10 * 1024 * 1024, { min: 4096 });
/** How many `.N` generations to retain. 0 disables rotation (truncate instead). */
const _maxBackups = () => envInt('KHY_AUDIT_MAX_BACKUPS', 3, { min: 0, max: 99 });
/** Hard cap on the stored `result.error` string. */
const _errorChars = () => envInt('KHY_AUDIT_ERROR_CHARS', 200, { min: 40 });
/** Hard cap on any single stored param value. */
const _paramChars = () => envInt('KHY_AUDIT_PARAM_CHARS', 200, { min: 40 });
/**
 * Idempotency window. Two calls carrying an identical fingerprint inside this
 * window collapse to one line. 0 disables dedupe entirely.
 *
 * The fingerprint includes `elapsed`, which is what makes this safe: an
 * accidental double-log replays the *same* entry object (identical elapsed),
 * while a genuinely repeated execution almost never lands on the same
 * millisecond. The residual false-positive is a repeat of a zero-elapsed event
 * (e.g. the same tool denied twice with the same params inside the window);
 * set KHY_AUDIT_DEDUPE_WINDOW_MS=0 if that matters more than deduplication.
 */
const _dedupeWindowMs = () => envInt('KHY_AUDIT_DEDUPE_WINDOW_MS', 2000, { min: 0 });
/** How many recent fingerprints to remember (bounded — never grows unbounded). */
const _dedupeMemory = () => envInt('KHY_AUDIT_DEDUPE_MEMORY', 64, { min: 1, max: 4096 });

const SENSITIVE_KEYS = ['password', 'apiKey', 'token', 'secret', 'key', 'credential'];

let _auditFile = null;

/** Absolute path of the live audit file (resolved once, then cached). */
function _file() {
  if (_auditFile) {
    return _auditFile;
  }
  let home;
  try {
    home = require('../utils/dataHome').getAppHome();
  } catch {
    home = path.join(os.homedir(), '.khyquant');
  }
  _auditFile = path.join(home, 'audit.jsonl');
  return _auditFile;
}

// ── Write ───────────────────────────────────────────────────────────

/**
 * Log a tool execution event. Idempotent inside the dedupe window.
 *
 * @param {object} entry
 * @param {string} entry.tool - Tool / operation name
 * @param {object} [entry.params] - Parameters (secrets masked here, not by the caller)
 * @param {object} [entry.result] - Execution result summary ({ success, error })
 * @param {string} [entry.permission] - Permission decision (allow/deny/allow-session/allow-always)
 * @param {number} [entry.elapsed] - Execution time in ms
 * @param {string} [entry.user] - User identifier
 * @param {string} [entry.sessionId] - Session identifier
 * @param {string} [entry.dedupeKey] - Explicit idempotency key; overrides the
 *        derived fingerprint when the caller knows the retry identity itself.
 * @returns {{written: boolean, deduped: boolean, reason?: string}} Never throws.
 */
function logToolExecution(entry) {
  if (!entry || !entry.tool) {
    return { written: false, deduped: false, reason: 'no-tool' };
  }

  const record = {
    timestamp: new Date().toISOString(),
    tool: entry.tool,
    params: _sanitizeParams(entry.params),
    result: _summarizeResult(entry.result),
    permission: entry.permission || 'unknown',
    elapsed: entry.elapsed || 0,
    user: entry.user || process.env.USER || process.env.USERNAME || 'unknown',
    sessionId: entry.sessionId || _sessionId,
  };

  if (_isDuplicate(entry.dedupeKey || _fingerprint(record))) {
    return { written: false, deduped: true, reason: 'duplicate-within-window' };
  }

  try {
    _ensureDir();
    _rotateIfNeeded();
    fs.appendFileSync(_file(), JSON.stringify(record) + '\n');
    return { written: true, deduped: false };
  } catch (err) {
    /* audit logging failure is non-critical — report it, never throw */
    return { written: false, deduped: false, reason: _firstSentence(err?.message || err) };
  }
}

// ── Read / Query ────────────────────────────────────────────────────

/**
 * Query the audit log with filters.
 *
 * @param {object} [filter]
 * @param {string} [filter.tool] - Filter by exact tool name
 * @param {string} [filter.toolPrefix] - Filter by tool-name prefix (module scope)
 * @param {string} [filter.since] - ISO date string (entries at/after this date)
 * @param {string} [filter.until] - ISO date string (entries at/before this date)
 * @param {boolean} [filter.success] - Filter by success/failure
 * @param {number} [filter.limit=50] - Max entries to return
 * @returns {object[]} Matching log entries (most recent first)
 */
function queryAuditLog(filter = {}) {
  const limit = filter.limit || 50;

  try {
    const file = _file();
    if (!fs.existsSync(file)) {
      return [];
    }

    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Parse in reverse (most recent first)
    const entries = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < limit * 2; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        entries.push(entry);
      } catch {
        /* skip malformed lines */
      }
    }

    // Apply filters
    let filtered = entries;

    if (filter.tool) {
      filtered = filtered.filter((e) => e.tool === filter.tool);
    }
    if (filter.toolPrefix) {
      filtered = filtered.filter((e) => String(e.tool || '').startsWith(filter.toolPrefix));
    }
    if (filter.since) {
      const since = new Date(filter.since).getTime();
      filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= since);
    }
    if (filter.until) {
      const until = new Date(filter.until).getTime();
      filtered = filtered.filter((e) => new Date(e.timestamp).getTime() <= until);
    }
    if (filter.success !== undefined) {
      filtered = filtered.filter((e) => (filter.success ? e.result?.success : !e.result?.success));
    }

    return filtered.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Aggregated statistics, optionally scoped to one module.
 *
 * @param {object} [opts]
 * @param {string} [opts.module] - Tool-name prefix to scope to (e.g. 'context-compress')
 * @param {number} [opts.limit=10000] - How many recent entries to aggregate over
 * @returns {{totalCalls:number, byTool:object, byPermission:object, errorCount:number,
 *            deniedCount:number, avgElapsed:number, recentErrors:object[], module:string|null}}
 */
function getModuleStats(opts = {}) {
  const module_ = typeof opts.module === 'string' && opts.module ? opts.module : null;
  const entries = queryAuditLog({
    limit: opts.limit || 10000,
    ...(module_ ? { toolPrefix: module_ } : {}),
  });

  const byTool = {};
  const byPermission = {};
  let totalElapsed = 0;
  let errorCount = 0;

  for (const entry of entries) {
    byTool[entry.tool] = (byTool[entry.tool] || 0) + 1;
    byPermission[entry.permission] = (byPermission[entry.permission] || 0) + 1;
    totalElapsed += entry.elapsed || 0;
    if (entry.result && !entry.result.success) {
      errorCount++;
    }
  }

  return {
    totalCalls: entries.length,
    byTool,
    byPermission,
    errorCount,
    deniedCount: byPermission.deny || 0,
    avgElapsed: entries.length > 0 ? Math.round(totalElapsed / entries.length) : 0,
    recentErrors: entries.filter((e) => e.result && !e.result.success).slice(0, 5),
    module: module_,
  };
}

/**
 * Get aggregated audit statistics across every tool.
 * Retained name — `telemetryService` and the ops handlers call this.
 * @returns {object} Stats summary
 */
function getAuditStats() {
  return getModuleStats();
}

// ── Management ──────────────────────────────────────────────────────

/**
 * Clear the audit log, keeping the cleared content as a `.bak` snapshot.
 *
 * Exactly one snapshot generation is kept: a second clear replaces the first,
 * and the return value says so rather than discarding it silently.
 *
 * @returns {{cleared:boolean, lines:number, backupPath:string|null,
 *            replacedPrevious:boolean, error?:string}}
 */
function clearAuditLog() {
  const file = _file();
  const backupPath = `${file}.bak`;
  try {
    if (!fs.existsSync(file)) {
      return { cleared: false, lines: 0, backupPath: null, replacedPrevious: false };
    }
    const lines = _countLines(file);
    const replacedPrevious = fs.existsSync(backupPath);
    if (replacedPrevious) {
      // Windows fs.renameSync refuses an existing destination (EPERM/EEXIST),
      // so the previous snapshot has to go before the new one takes its place.
      fs.unlinkSync(backupPath);
    }
    fs.renameSync(file, backupPath);
    _recentFps.clear(); // a cleared log must not keep deduping against its own past
    return { cleared: true, lines, backupPath, replacedPrevious };
  } catch (err) {
    return {
      cleared: false,
      lines: 0,
      backupPath: null,
      replacedPrevious: false,
      error: _firstSentence(err?.message || err),
    };
  }
}

/**
 * Get the audit log file path.
 * @returns {string}
 */
function getAuditFilePath() {
  return _file();
}

// ── Internal helpers ────────────────────────────────────────────────

const _sessionId = `s_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

/** fingerprint → last-append epoch ms. Bounded by _dedupeMemory(). */
const _recentFps = new Map();

function _fingerprint(record) {
  return crypto
    .createHash('sha1')
    .update(
      [
        record.tool,
        JSON.stringify(record.params),
        JSON.stringify(record.result),
        record.permission,
        String(record.elapsed),
        record.sessionId,
      ].join('\u0000')
    )
    .digest('hex')
    .slice(0, 16);
}

/** True when this fingerprint was already appended inside the dedupe window. */
function _isDuplicate(fp) {
  const windowMs = _dedupeWindowMs();
  if (windowMs <= 0) {
    return false;
  }
  const now = Date.now();
  const seenAt = _recentFps.get(fp);
  if (seenAt !== undefined && now - seenAt < windowMs) {
    return true;
  }
  // Drop expired entries, then bound the map by insertion order (Map iterates
  // oldest-first, so shifting the front is exactly LRU-by-age here).
  for (const [k, t] of _recentFps) {
    if (now - t >= windowMs) {
      _recentFps.delete(k);
    } else {
      break;
    }
  }
  _recentFps.delete(fp); // re-insert at the tail so ordering stays age-sorted
  _recentFps.set(fp, now);
  const cap = _dedupeMemory();
  while (_recentFps.size > cap) {
    _recentFps.delete(_recentFps.keys().next().value);
  }
  return false;
}

function _ensureDir() {
  const dir = path.dirname(_file());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function _countLines(file) {
  try {
    const content = fs.readFileSync(file, 'utf-8').trim();
    return content ? content.split('\n').filter(Boolean).length : 0;
  } catch {
    return 0;
  }
}

/**
 * Rotate the live file once it reaches the size threshold: drop the oldest
 * generation, shift `.i` → `.i+1`, then move the live file to `.1`.
 *
 * The previous implementation started the shift loop at `MAX_BACKUPS - 1`, so
 * `.3` was never removed and `.2 → .3` renamed onto an existing path. On
 * Windows `fs.renameSync` refuses a non-empty destination, so that threw, the
 * catch swallowed it, and rotation silently stopped working the moment all
 * three generations existed — after which audit.jsonl grew without bound. The
 * `if (i + 1 > MAX_BACKUPS) unlinkSync(from)` guard could never fire, because
 * `i` peaked at `MAX_BACKUPS - 1`.
 *
 * @returns {boolean} true if a rotation happened.
 */
function _rotateIfNeeded() {
  const file = _file();
  try {
    if (!fs.existsSync(file)) {
      return false;
    }
    if (fs.statSync(file).size < _maxSize()) {
      return false;
    }

    const keep = _maxBackups();
    if (keep <= 0) {
      fs.unlinkSync(file); // rotation disabled → reset in place, keep no history
      return true;
    }

    for (let i = keep; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (!fs.existsSync(from)) {
        continue;
      }
      if (i >= keep) {
        fs.unlinkSync(from); // oldest generation falls outside the window
        continue;
      }
      const to = `${file}.${i + 1}`;
      if (fs.existsSync(to)) {
        fs.unlinkSync(to);
      }
      fs.renameSync(from, to);
    }

    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    /* rotation failure must never block the append */
    return false;
  }
}

/**
 * Sanitize parameters before logging (mask sensitive values, bound the size).
 */
function _sanitizeParams(params) {
  if (!params || typeof params !== 'object') {
    return {};
  }
  const sanitized = {};
  const cap = _paramChars();

  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith('_')) {
      continue;
    } // Skip internal fields
    if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase()))) {
      sanitized[k] = '***';
    } else if (typeof v === 'string' && v.length > cap) {
      sanitized[k] = v.slice(0, cap) + `... (${v.length} chars)`;
    } else if (v && typeof v === 'object') {
      // Nested structures are kept verbatim while small, but a large one is
      // summarized: an un-bounded `{edits: [...]}` would otherwise put whole
      // file bodies into the audit trail and blow past the rotation threshold
      // in a handful of lines.
      const json = _safeJson(v);
      sanitized[k] = json.length > cap ? json.slice(0, cap) + `... (${json.length} chars)` : v;
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

function _safeJson(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[uncloneable]'; // circular / getter-throwing objects
  }
}

/**
 * First sentence of an error message, capped at ERROR_CHARS.
 *
 * Full-width terminators end a sentence unconditionally. An ASCII `.`/`!`/`?`
 * only counts when followed by a space or end-of-string AND not preceded by a
 * digit — otherwise `open 'C:\a\b.js'`, `v1.2.3` and `1. item` all get cut at
 * the first dot, which throws away the part of the message that identifies the
 * failure.
 *
 * @param {*} input
 * @returns {string}
 */
function _firstSentence(input) {
  const s = String(input == null ? '' : input?.message || input)
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) {
    return '';
  }
  const cap = _errorChars();
  const cjk = s.search(/[。！？]/);
  const ascii = s.search(/(?<![0-9])[.!?](?= |$)/);
  const ends = [cjk, ascii].filter((i) => i >= 0);
  const cut = ends.length ? Math.min(...ends) + 1 : s.length;
  return s.slice(0, Math.min(cut, cap));
}

/**
 * Summarize result for logging (avoid storing large outputs).
 * `error` keeps only the first sentence — a stack-carrying message would
 * otherwise dominate the line and defeat scanning the trail by eye.
 */
function _summarizeResult(result) {
  if (!result || typeof result !== 'object') {
    return { success: false };
  }
  const err = result.error;
  return {
    success: !!result.success,
    error: err ? _firstSentence(err) : undefined,
  };
}

/** @internal Reset resolved path + dedupe memory. Tests only. */
function _resetForTest() {
  _auditFile = null;
  _recentFps.clear();
}

module.exports = {
  logToolExecution,
  queryAuditLog,
  getModuleStats,
  getAuditStats,
  clearAuditLog,
  getAuditFilePath,
  SENSITIVE_KEYS,
  _internals: { _firstSentence, _sanitizeParams, _rotateIfNeeded, _fingerprint },
  _resetForTest,
};
