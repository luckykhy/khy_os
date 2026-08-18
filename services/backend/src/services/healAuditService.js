'use strict';

/**
 * Heal Audit Service — unified self-healing audit trail.
 *
 * Collects all self-repair actions across the system into a single JSONL log
 * for retrospective query and frequency monitoring.
 *
 * Record shape (one JSON object per line, ≤64KB):
 *   timestamp  ISO 8601
 *   component  sourceHeal | dbHealth | watchdog | configGuard | selfCheck
 *   action     repair action taken (e.g., 'file_restored', 'db_vacuum', 'daemon_restart')
 *   target     what was acted on (file path, db name, service name, etc.)
 *   result     success | failure | partial
 *   details    optional object with action-specific metadata
 *   reverted   optional boolean (true if action was rolled back)
 *
 * Log file: .khy/logs/heal-audit.jsonl
 * Rotation: 10MB max → .1 → .2 → .3, oldest dropped.
 *
 * Fail-soft: every write path silently catches errors — a broken disk or
 * permission issue must never propagate into the caller or block a heal action.
 */

const fs = require('fs');
const path = require('path');

// ── Tunables ────────────────────────────────────────────────────────

const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BACKUPS = 3;
const MAX_RECORD_SIZE = 64 * 1024; // 64KB per line

let _logFile = null;

/**
 * Resolve the heal-audit.jsonl file path.
 * .khy/logs/heal-audit.jsonl (created if missing).
 */
function _file() {
  if (_logFile) {
    return _logFile;
  }
  const khyDir = path.join(process.cwd(), '.khy');
  const logsDir = path.join(khyDir, 'logs');
  _logFile = path.join(logsDir, 'heal-audit.jsonl');
  return _logFile;
}

function _ensureDir() {
  const dir = path.dirname(_file());
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* fail-soft */
    }
  }
}

/**
 * Rotate the log file: .3 deleted → .2→.3 → .1→.2 → live→.1
 */
function _rotateIfNeeded() {
  const file = _file();
  try {
    if (!fs.existsSync(file)) {
      return;
    }
    if (fs.statSync(file).size < MAX_SIZE) {
      return;
    }

    // Drop oldest generation first
    for (let i = MAX_BACKUPS; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (!fs.existsSync(from)) {
        continue;
      }
      if (i >= MAX_BACKUPS) {
        fs.unlinkSync(from);
        continue;
      }
      const to = `${file}.${i + 1}`;
      if (fs.existsSync(to)) {
        fs.unlinkSync(to);
      }
      fs.renameSync(from, to);
    }

    fs.renameSync(file, `${file}.1`);
  } catch {
    /* rotation failure must never block the append */
  }
}

/**
 * Log a heal event.
 *
 * @param {object} entry
 * @param {string} entry.component - sourceHeal | dbHealth | watchdog | configGuard | selfCheck
 * @param {string} entry.action - repair action taken
 * @param {string} entry.target - what was acted on
 * @param {string} [entry.result='success'] - success | failure | partial
 * @param {object} [entry.details] - optional metadata
 * @param {boolean} [entry.reverted] - optional rollback flag
 * @returns {boolean} true if written (never throws)
 */
function logHealEvent(entry) {
  if (!entry || !entry.component || !entry.action || !entry.target) {
    return false;
  }

  const record = {
    timestamp: new Date().toISOString(),
    component: String(entry.component),
    action: String(entry.action),
    target: String(entry.target),
    result: entry.result || 'success',
    ...(entry.details ? { details: entry.details } : {}),
    ...(entry.reverted !== undefined ? { reverted: entry.reverted } : {}),
  };

  try {
    let line = JSON.stringify(record);
    if (line.length > MAX_RECORD_SIZE) {
      // Truncate details if oversized
      const truncated = { ...record, details: '[truncated]' };
      line = JSON.stringify(truncated);
      if (line.length > MAX_RECORD_SIZE) {
        return false; // still too large, drop it
      }
    }

    _ensureDir();
    _rotateIfNeeded();
    fs.appendFileSync(_file(), line + '\n', 'utf-8');
    return true;
  } catch {
    /* fail-soft: audit write failure never propagates */
    return false;
  }
}

/**
 * Query heal events with filters.
 *
 * @param {object} [filter]
 * @param {string} [filter.component] - filter by component name
 * @param {string} [filter.since] - ISO date string (entries at/after)
 * @param {string} [filter.until] - ISO date string (entries at/before)
 * @param {number} [filter.last] - return last N entries (most recent first)
 * @returns {object[]} matching entries (most recent first)
 */
function queryHealEvents(filter = {}) {
  const limit = filter.last || 50;

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

    if (filter.component) {
      filtered = filtered.filter((e) => e.component === filter.component);
    }
    if (filter.since) {
      const since = new Date(filter.since).getTime();
      filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= since);
    }
    if (filter.until) {
      const until = new Date(filter.until).getTime();
      filtered = filtered.filter((e) => new Date(e.timestamp).getTime() <= until);
    }

    return filtered.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Count heal events in the last N milliseconds.
 * @param {number} windowMs - time window in milliseconds
 * @returns {number} event count
 */
function countRecentEvents(windowMs = 3600000) {
  const since = new Date(Date.now() - windowMs).toISOString();
  return queryHealEvents({ since, last: 10000 }).length;
}

/**
 * Get the heal-audit.jsonl file path.
 * @returns {string}
 */
function getHealAuditFilePath() {
  return _file();
}

module.exports = {
  logHealEvent,
  queryHealEvents,
  countRecentEvents,
  getHealAuditFilePath,
};
