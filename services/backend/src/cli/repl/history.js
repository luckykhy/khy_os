/**
 * Command history persistence (~/.khyquant_history).
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. Owns the history file path/cap constants and performs the
 * one-time secure-permission (0600) initialization on require, exactly as the
 * original top-of-repl.js side effect did.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeChmod } = require('../../tools/platformUtils');

const HISTORY_FILE = path.join(os.homedir(), '.khyquant_history');
const MAX_HISTORY = 500;

// Ensure history file has secure permissions (0600)
try {
  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, '');
  }
  safeChmod(HISTORY_FILE, 0o600);
} catch { /* best effort */ }

/**
 * Load command history from file.
 */
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return fs.readFileSync(HISTORY_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);
    }
  } catch { /* ignore */ }
  return [];
}

let _writeTimer = null;
let _pendingHistory = null;

/**
 * Save command history to file (debounced async write).
 */
function saveHistory(sessionHistory) {
  _pendingHistory = sessionHistory;
  if (_writeTimer) return; // 已有待写批次
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    const toWrite = _pendingHistory;
    _pendingHistory = null;
    try {
      // 追加当前 session 历史到文件，保留之前 session 的记录（用于 resume 等）
      const existing = loadHistory();
      const merged = [...existing, ...toWrite].slice(-MAX_HISTORY);
      fs.promises.writeFile(HISTORY_FILE, merged.join('\n') + '\n').catch(() => {});
    } catch { /* ignore */ }
  }, 1000);
}

/**
 * Flush pending history synchronously (called on process exit).
 */
function flushHistorySync() {
  if (!_pendingHistory) return;
  try {
    if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
    const existing = loadHistory();
    const merged = [...existing, ..._pendingHistory].slice(-MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, merged.join('\n') + '\n');
    _pendingHistory = null;
  } catch { /* ignore */ }
}
process.on('exit', flushHistorySync);

module.exports = {
  HISTORY_FILE,
  MAX_HISTORY,
  loadHistory,
  saveHistory,
  flushHistorySync,
};
