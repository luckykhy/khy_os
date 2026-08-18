'use strict';

/**
 * Heal Audit — JSONL-based self-healing audit trail.
 *
 * Logs automatic recovery actions (watchdog restarts, dependency healing,
 * gateway fallback, etc.) for operational visibility and compliance.
 *
 * Record shape:
 *   timestamp  ISO 8601
 *   action     heal action type (e.g., 'watchdog_restart_attempt')
 *   target     affected component (e.g., 'daemon', 'gateway')
 *   reason     why the heal was triggered (optional)
 *   details    structured metadata (object)
 *   message    human-readable description
 *   user       OS user
 *   sessionId  per-process session id
 *
 * Log file: <app home>/heal-audit.jsonl
 * Rotation: 10MB → .1 → .2 → .3, oldest dropped.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BACKUPS = 3;

let _auditFile = null;
let _sessionId = null;

/**
 * Get absolute path of the heal audit file.
 */
function _file() {
  if (_auditFile) {
    return _auditFile;
  }
  let home;
  try {
    home = require('./dataHome').getAppHome();
  } catch {
    home = path.join(os.homedir(), '.khyquant');
  }
  _auditFile = path.join(home, 'heal-audit.jsonl');
  return _auditFile;
}

/**
 * Get or create session ID.
 */
function _getSessionId() {
  if (!_sessionId) {
    _sessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }
  return _sessionId;
}

/**
 * Ensure parent directory exists.
 */
function _ensureDir() {
  const dir = path.dirname(_file());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Rotate the log file if it exceeds size threshold.
 */
function _rotateIfNeeded() {
  const file = _file();
  try {
    if (!fs.existsSync(file)) {
      return false;
    }
    if (fs.statSync(file).size < MAX_SIZE) {
      return false;
    }

    // Remove oldest backup and shift generations
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
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a heal audit entry.
 *
 * @param {object} entry
 * @param {string} entry.action - Action type (e.g., 'watchdog_restart_attempt')
 * @param {string} entry.target - Affected component (e.g., 'daemon')
 * @param {string} [entry.reason] - Why the heal was triggered
 * @param {object} [entry.details] - Structured metadata
 * @param {string} [entry.message] - Human-readable description
 * @returns {Promise<{written: boolean, reason?: string}>} Never throws.
 */
async function writeHealAudit(entry) {
  if (!entry || !entry.action || !entry.target) {
    return { written: false, reason: 'missing-required-fields' };
  }

  const record = {
    timestamp: new Date().toISOString(),
    action: entry.action,
    target: entry.target,
    reason: entry.reason || null,
    details: entry.details || {},
    message: entry.message || '',
    user: process.env.USER || process.env.USERNAME || 'unknown',
    sessionId: _getSessionId(),
  };

  try {
    _ensureDir();
    _rotateIfNeeded();
    fs.appendFileSync(_file(), JSON.stringify(record) + '\n', 'utf-8');
    return { written: true };
  } catch (err) {
    // Never throw - heal audit failure is non-critical
    return { written: false, reason: err?.message || String(err) };
  }
}

/**
 * Query the heal audit log.
 *
 * @param {object} [filter]
 * @param {string} [filter.action] - Filter by action type
 * @param {string} [filter.target] - Filter by target
 * @param {string} [filter.since] - ISO date string
 * @param {string} [filter.until] - ISO date string
 * @param {number} [filter.limit=50] - Max entries to return
 * @returns {object[]} Matching entries (most recent first)
 */
function queryHealAudit(filter = {}) {
  const limit = filter.limit || 50;

  try {
    const file = _file();
    if (!fs.existsSync(file)) {
      return [];
    }

    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const entries = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < limit * 2; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        entries.push(entry);
      } catch {
        /* skip malformed lines */
      }
    }

    let filtered = entries;

    if (filter.action) {
      filtered = filtered.filter((e) => e.action === filter.action);
    }
    if (filter.target) {
      filtered = filtered.filter((e) => e.target === filter.target);
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
 * Get the heal audit file path.
 */
function getHealAuditFilePath() {
  return _file();
}

/**
 * Clear the heal audit log (for testing).
 */
function clearHealAudit() {
  const file = _file();
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    return { cleared: true };
  } catch (err) {
    return { cleared: false, error: err?.message || String(err) };
  }
}

module.exports = {
  writeHealAudit,
  queryHealAudit,
  getHealAuditFilePath,
  clearHealAudit,
};
