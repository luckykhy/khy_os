/**
 * Audit Log — JSONL-based tool execution audit trail.
 *
 * Every tool execution is logged with parameters, result, permission
 * decision, and elapsed time. Supports querying and rotation.
 *
 * Log file: ~/.khyquant/audit.log (JSONL format)
 * Rotation: 10MB max, keeps 3 backups
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const AUDIT_FILE = path.join(os.homedir(), '.khyquant', 'audit.log');
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BACKUPS = 3;

// ── Write ───────────────────────────────────────────────────────────

/**
 * Log a tool execution event.
 *
 * @param {object} entry
 * @param {string} entry.tool - Tool name
 * @param {object} [entry.params] - Sanitized parameters (secrets masked)
 * @param {object} [entry.result] - Execution result summary
 * @param {string} [entry.permission] - Permission decision (allow/deny/allow-session/allow-always)
 * @param {number} [entry.elapsed] - Execution time in ms
 * @param {string} [entry.user] - User identifier
 * @param {string} [entry.sessionId] - Session identifier
 */
function logToolExecution(entry) {
  if (!entry || !entry.tool) return;

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

  try {
    _ensureDir();
    _rotateIfNeeded();
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n');
  } catch { /* audit logging failure is non-critical */ }
}

// ── Read / Query ────────────────────────────────────────────────────

/**
 * Query the audit log with filters.
 *
 * @param {object} [filter]
 * @param {string} [filter.tool] - Filter by tool name
 * @param {string} [filter.since] - ISO date string (entries after this date)
 * @param {string} [filter.until] - ISO date string (entries before this date)
 * @param {boolean} [filter.success] - Filter by success/failure
 * @param {number} [filter.limit=50] - Max entries to return
 * @returns {object[]} Matching log entries (most recent first)
 */
function queryAuditLog(filter = {}) {
  const limit = filter.limit || 50;

  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];

    const content = fs.readFileSync(AUDIT_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Parse in reverse (most recent first)
    const entries = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < limit * 2; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        entries.push(entry);
      } catch { /* skip malformed lines */ }
    }

    // Apply filters
    let filtered = entries;

    if (filter.tool) {
      filtered = filtered.filter(e => e.tool === filter.tool);
    }
    if (filter.since) {
      const since = new Date(filter.since).getTime();
      filtered = filtered.filter(e => new Date(e.timestamp).getTime() >= since);
    }
    if (filter.until) {
      const until = new Date(filter.until).getTime();
      filtered = filtered.filter(e => new Date(e.timestamp).getTime() <= until);
    }
    if (filter.success !== undefined) {
      filtered = filtered.filter(e =>
        filter.success ? e.result?.success : !e.result?.success
      );
    }

    return filtered.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Get aggregated audit statistics.
 *
 * @returns {object} Stats summary
 */
function getAuditStats() {
  const entries = queryAuditLog({ limit: 10000 });

  const byTool = {};
  const byPermission = {};
  let totalElapsed = 0;
  let errorCount = 0;

  for (const entry of entries) {
    byTool[entry.tool] = (byTool[entry.tool] || 0) + 1;
    byPermission[entry.permission] = (byPermission[entry.permission] || 0) + 1;
    totalElapsed += entry.elapsed || 0;
    if (entry.result && !entry.result.success) errorCount++;
  }

  return {
    totalCalls: entries.length,
    byTool,
    byPermission,
    errorCount,
    deniedCount: byPermission.deny || 0,
    avgElapsed: entries.length > 0 ? Math.round(totalElapsed / entries.length) : 0,
    recentErrors: entries.filter(e => e.result && !e.result.success).slice(0, 5),
  };
}

// ── Management ──────────────────────────────────────────────────────

/**
 * Clear the audit log (archives to .bak first).
 */
function clearAuditLog() {
  try {
    if (fs.existsSync(AUDIT_FILE)) {
      const backupPath = AUDIT_FILE + '.cleared.' + Date.now();
      fs.renameSync(AUDIT_FILE, backupPath);
    }
  } catch { /* best effort */ }
}

/**
 * Get the audit log file path.
 * @returns {string}
 */
function getAuditFilePath() {
  return AUDIT_FILE;
}

// ── Internal helpers ────────────────────────────────────────────────

const _sessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

function _ensureDir() {
  const dir = path.dirname(AUDIT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Rotate log file if it exceeds MAX_SIZE.
 */
function _rotateIfNeeded() {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return;
    const stat = fs.statSync(AUDIT_FILE);
    if (stat.size < MAX_SIZE) return;

    // Shift existing backups
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const from = `${AUDIT_FILE}.${i}`;
      const to = `${AUDIT_FILE}.${i + 1}`;
      if (fs.existsSync(from)) {
        if (i + 1 > MAX_BACKUPS) {
          fs.unlinkSync(from);
        } else {
          fs.renameSync(from, to);
        }
      }
    }

    // Move current to .1
    fs.renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
  } catch { /* rotation failure is non-critical */ }
}

/**
 * Sanitize parameters before logging (mask sensitive values).
 */
function _sanitizeParams(params) {
  if (!params || typeof params !== 'object') return {};
  const sanitized = {};
  const SENSITIVE_KEYS = ['password', 'apiKey', 'token', 'secret', 'key', 'credential'];

  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith('_')) continue; // Skip internal fields
    if (SENSITIVE_KEYS.some(s => k.toLowerCase().includes(s.toLowerCase()))) {
      sanitized[k] = '***';
    } else if (typeof v === 'string' && v.length > 200) {
      sanitized[k] = v.slice(0, 200) + `... (${v.length} chars)`;
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

/**
 * Summarize result for logging (avoid storing large outputs).
 */
function _summarizeResult(result) {
  if (!result || typeof result !== 'object') return { success: false };
  return {
    success: !!result.success,
    error: result.error ? String(result.error).slice(0, 200) : undefined,
  };
}

module.exports = {
  logToolExecution,
  queryAuditLog,
  getAuditStats,
  clearAuditLog,
  getAuditFilePath,
};
