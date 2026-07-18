'use strict';

/**
 * File History Service — pre-edit snapshot system with rewind capability.
 *
 * Before every file write/edit, a snapshot is taken. Users can rewind to
 * any prior version via /rewind. Modelled after Claude Code's fileHistory.ts.
 *
 * Storage: ~/.khyquant/file_history/<session_id>/<encoded_path>.json
 * Each JSON contains an array of { timestamp, content, reason } entries.
 *
 * Limits: MAX_SNAPSHOTS_PER_FILE snapshots per file, MAX_FILE_SIZE_BYTES
 * max file size for snapshotting (skip large binaries).
 *
 * @module fileHistoryService
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ── Constants ──────────────────────────────────────────────────────

const MAX_SNAPSHOTS_PER_FILE = 100;
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB — skip large files
const HISTORY_BASE_DIR = path.join(os.homedir(), '.khyquant', 'file_history');

// ── Session state ──────────────────────────────────────────────────

let _sessionId = null;

/**
 * Get or create the current session ID.
 * @returns {string}
 */
function getSessionId() {
  if (!_sessionId) {
    _sessionId = `s_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  }
  return _sessionId;
}

/**
 * Reset session (for new conversation).
 */
function resetSession() {
  _sessionId = null;
}

/**
 * Set an explicit session ID.
 * @param {string} id
 */
function setSessionId(id) {
  _sessionId = id;
}

// ── Path helpers ───────────────────────────────────────────────────

/**
 * Encode a file path into a safe filename for storage.
 * @param {string} filePath - Absolute file path
 * @returns {string}
 */
function _encodePathKey(filePath) {
  return crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
}

/**
 * Get the history file path for a given source file.
 * @param {string} filePath
 * @returns {string}
 */
function _getHistoryPath(filePath) {
  const sessionDir = path.join(HISTORY_BASE_DIR, getSessionId());
  return path.join(sessionDir, `${_encodePathKey(filePath)}.json`);
}

// ── Core API ───────────────────────────────────────────────────────

/**
 * Take a snapshot of a file before modification.
 *
 * @param {string} filePath - Absolute path to the file
 * @param {object} [options]
 * @param {string} [options.reason] - Why the snapshot was taken (e.g. 'editFile', 'writeFile')
 * @param {string} [options.content] - Pre-read content (avoids redundant read)
 * @returns {{ success: boolean, snapshotIndex?: number, error?: string }}
 */
function takeSnapshot(filePath, options = {}) {
  try {
    const resolved = path.resolve(filePath);

    // Read current content
    let content = options.content;
    if (content === undefined) {
      if (!fs.existsSync(resolved)) {
        // File doesn't exist yet — record empty snapshot
        content = '';
      } else {
        const stat = fs.statSync(resolved);
        if (stat.size > MAX_FILE_SIZE_BYTES) {
          return { success: false, error: 'File too large for snapshotting' };
        }
        content = fs.readFileSync(resolved, 'utf-8');
      }
    }

    // Load or create history
    const historyPath = _getHistoryPath(resolved);
    const historyDir = path.dirname(historyPath);
    if (!fs.existsSync(historyDir)) {
      fs.mkdirSync(historyDir, { recursive: true });
    }

    let history;
    try {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    } catch {
      history = { filePath: resolved, snapshots: [] };
    }

    // Check for duplicate (skip if content identical to last snapshot)
    const lastSnapshot = history.snapshots[history.snapshots.length - 1];
    if (lastSnapshot && lastSnapshot.content === content) {
      return { success: true, snapshotIndex: history.snapshots.length - 1, skipped: true };
    }

    // Add new snapshot
    history.snapshots.push({
      timestamp: Date.now(),
      content,
      reason: options.reason || 'unknown',
    });

    // Enforce max snapshots (remove oldest)
    while (history.snapshots.length > MAX_SNAPSHOTS_PER_FILE) {
      history.snapshots.shift();
    }

    fs.writeFileSync(historyPath, JSON.stringify(history), 'utf-8');
    return { success: true, snapshotIndex: history.snapshots.length - 1 };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get the full snapshot history for a file.
 *
 * @param {string} filePath - Absolute path
 * @returns {{ filePath: string, snapshots: Array<{ timestamp: number, content: string, reason: string }> } | null}
 */
function getHistory(filePath) {
  try {
    const resolved = path.resolve(filePath);
    const historyPath = _getHistoryPath(resolved);
    if (!fs.existsSync(historyPath)) return null;
    return JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Rewind a file to a specific snapshot index.
 *
 * @param {string} filePath - Absolute path
 * @param {number} snapshotIndex - Index in the snapshots array (0 = oldest)
 * @returns {{ success: boolean, restoredTimestamp?: number, error?: string }}
 */
function rewindTo(filePath, snapshotIndex) {
  try {
    const resolved = path.resolve(filePath);
    const history = getHistory(resolved);
    if (!history || !history.snapshots.length) {
      return { success: false, error: 'No history found for this file' };
    }

    if (snapshotIndex < 0 || snapshotIndex >= history.snapshots.length) {
      return { success: false, error: `Invalid index. Available: 0-${history.snapshots.length - 1}` };
    }

    const snapshot = history.snapshots[snapshotIndex];

    // Take a snapshot of current state before rewinding
    takeSnapshot(resolved, { reason: 'pre-rewind' });

    // Write the restored content
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, snapshot.content, 'utf-8');

    return { success: true, restoredTimestamp: snapshot.timestamp };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Rewind a file to the last snapshot (undo last change).
 *
 * @param {string} filePath - Absolute path
 * @returns {{ success: boolean, restoredTimestamp?: number, error?: string }}
 */
function undoLast(filePath) {
  const history = getHistory(path.resolve(filePath));
  if (!history || history.snapshots.length < 2) {
    return { success: false, error: 'Not enough history to undo' };
  }
  // Rewind to second-to-last (last is current state)
  return rewindTo(filePath, history.snapshots.length - 2);
}

/**
 * List all files with history in the current session.
 *
 * @returns {Array<{ filePath: string, snapshotCount: number, lastModified: number }>}
 */
function listTrackedFiles() {
  const sessionDir = path.join(HISTORY_BASE_DIR, getSessionId());
  if (!fs.existsSync(sessionDir)) return [];

  const results = [];
  const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const history = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf-8'));
      const last = history.snapshots[history.snapshots.length - 1];
      results.push({
        filePath: history.filePath,
        snapshotCount: history.snapshots.length,
        lastModified: last ? last.timestamp : 0,
      });
    } catch { /* skip corrupt */ }
  }

  return results.sort((a, b) => b.lastModified - a.lastModified);
}

/**
 * Get a diff-like summary between two snapshots.
 *
 * @param {string} filePath
 * @param {number} fromIndex
 * @param {number} toIndex
 * @returns {{ added: number, removed: number, preview: string } | null}
 */
function diffSnapshots(filePath, fromIndex, toIndex) {
  const history = getHistory(path.resolve(filePath));
  if (!history) return null;

  const from = history.snapshots[fromIndex];
  const to = history.snapshots[toIndex];
  if (!from || !to) return null;

  const fromLines = from.content.split('\n');
  const toLines = to.content.split('\n');

  // Simple line-based diff count
  const fromSet = new Set(fromLines);
  const toSet = new Set(toLines);

  let added = 0;
  let removed = 0;
  for (const line of toLines) {
    if (!fromSet.has(line)) added++;
  }
  for (const line of fromLines) {
    if (!toSet.has(line)) removed++;
  }

  // Build preview (first 10 changed lines)
  const changedLines = [];
  for (const line of toLines) {
    if (!fromSet.has(line) && line.trim()) {
      changedLines.push(`+ ${line}`);
      if (changedLines.length >= 5) break;
    }
  }
  for (const line of fromLines) {
    if (!toSet.has(line) && line.trim()) {
      changedLines.push(`- ${line}`);
      if (changedLines.length >= 10) break;
    }
  }

  return {
    added,
    removed,
    preview: changedLines.join('\n'),
  };
}

/**
 * Clean up old session histories (keep last N sessions).
 *
 * @param {number} [keepSessions=5]
 */
function cleanupOldSessions(keepSessions = 5) {
  try {
    if (!fs.existsSync(HISTORY_BASE_DIR)) return;
    const dirs = fs.readdirSync(HISTORY_BASE_DIR)
      .filter(d => d.startsWith('s_'))
      .sort()
      .reverse();

    for (let i = keepSessions; i < dirs.length; i++) {
      const dirPath = path.join(HISTORY_BASE_DIR, dirs[i]);
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch { /* ignore cleanup errors */ }
}

module.exports = {
  takeSnapshot,
  getHistory,
  rewindTo,
  undoLast,
  listTrackedFiles,
  diffSnapshots,
  cleanupOldSessions,
  getSessionId,
  setSessionId,
  resetSession,
  // Constants for testing
  MAX_SNAPSHOTS_PER_FILE,
  MAX_FILE_SIZE_BYTES,
};
