/**
 * Command history persistence (~/.khyquant_history).
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. Owns the history file path/cap constants and performs the
 * one-time secure-permission (0600) initialization on require, exactly as the
 * original top-of-repl.js side effect did.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { safeChmod } = require('../../tools/platformUtils');

// Legacy history file at the user-home root (pre portable-aware resolution).
function _legacyHistoryFile() {
  return path.join(os.homedir(), '.khyquant_history');
}

// Resolve the history file lazily via the portable-aware app home so portable
// deployments keep command history inside the install directory. Falls back
// to the legacy user-home root location when dataHome is unavailable.
function _historyFile() {
  try {
    const { getAppHome } = require('../../utils/dataHome');
    return path.join(getAppHome(), '.khyquant_history');
  } catch {
    return _legacyHistoryFile();
  }
}

const MAX_HISTORY = 500;

// Ensure history file has secure permissions (0600)
try {
  const historyFile = _historyFile();
  if (!fs.existsSync(historyFile)) {
    fs.writeFileSync(historyFile, '');
  }
  safeChmod(historyFile, 0o600);
} catch {
  /* best effort */
}

/**
 * Load command history from file.
 */
function loadHistory() {
  try {
    const file = _historyFile();
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);
      if (lines.length > 0) {
        return lines;
      }
    }
    // Read-only legacy compat: fall back to the historical ~/.khyquant_history
    // when the new location is empty (writes always go to _historyFile()).
    const legacy = _legacyHistoryFile();
    if (legacy !== file && fs.existsSync(legacy)) {
      return fs.readFileSync(legacy, 'utf-8').split(/\r?\n/).filter(Boolean);
    }
  } catch {
    /* ignore */
  }
  return [];
}

let _writeTimer = null;
let _pendingHistory = null;

/**
 * Merge a newly announced batch into the not-yet-written pending batch.
 *
 * Two caller contracts share this module and both must survive the debounce:
 *   - replSession re-sends the **whole session list** on every save;
 *   - the Ink TUI (`useTextInput`) sends **one entry per submit`.
 * Plain assignment (`_pendingHistory = sessionHistory`) satisfies the first and
 * silently drops every entry of a burst for the second: only the last call
 * within the 1s window ever reached the file, so quickly typed commands vanished
 * from the next session's ↑ history (BUG-66).
 *
 * Stitching the batches at their longest overlap serves both: a growing
 * full-list call (`[A,B]` then `[B,C,D]`) collapses to `[A,B,C,D]`, while two
 * single entries (`[A]` then `[B]`) accumulate to `[A,B]`.
 */
function _mergePending(prev, batch) {
  const next = Array.isArray(batch) ? batch : [];
  if (!Array.isArray(prev) || prev.length === 0) return next.slice();
  const maxK = Math.min(prev.length, next.length);
  for (let k = maxK; k > 0; k -= 1) {
    let overlap = true;
    for (let i = 0; i < k; i += 1) {
      if (prev[prev.length - k + i] !== next[i]) {
        overlap = false;
        break;
      }
    }
    if (overlap) return prev.concat(next.slice(k));
  }
  return prev.concat(next);
}

/**
 * Save command history to file (debounced async write).
 */
function saveHistory(sessionHistory) {
  _pendingHistory = _mergePending(_pendingHistory, sessionHistory);
  if (_writeTimer) {
    return;
  } // 已有待写批次
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    const toWrite = _pendingHistory;
    _pendingHistory = null;
    try {
      // 追加当前 session 历史到文件，保留之前 session 的记录（用于 resume 等）
      const existing = loadHistory();
      const merged = [...existing, ...toWrite].slice(-MAX_HISTORY);
      fs.promises.writeFile(_historyFile(), merged.join('\n') + '\n').catch(() => {});
    } catch {
      /* ignore */
    }
  }, 1000);
}

/**
 * Flush pending history synchronously (called on process exit).
 */
function flushHistorySync() {
  if (!_pendingHistory) {
    return;
  }
  try {
    if (_writeTimer) {
      clearTimeout(_writeTimer);
      _writeTimer = null;
    }
    const existing = loadHistory();
    const merged = [...existing, ..._pendingHistory].slice(-MAX_HISTORY);
    fs.writeFileSync(_historyFile(), merged.join('\n') + '\n');
    _pendingHistory = null;
  } catch {
    /* ignore */
  }
}
process.on('exit', flushHistorySync);

module.exports = {
  MAX_HISTORY,
  loadHistory,
  saveHistory,
  flushHistorySync,
};

// Legacy compatibility: HISTORY_FILE used to be a hardcoded constant; expose
// it as a lazy getter (returns a string path, works with destructuring).
Object.defineProperty(module.exports, 'HISTORY_FILE', {
  get: _historyFile,
  enumerable: true,
});
