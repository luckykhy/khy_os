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

/**
 * Save command history to file.
 */
function saveHistory(sessionHistory) {
  try {
    // 追加当前 session 历史到文件，保留之前 session 的记录（用于 resume 等）
    const existing = loadHistory();
    const merged = [...existing, ...sessionHistory].slice(-MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, merged.join('\n') + '\n');
  } catch { /* ignore */ }
}

module.exports = {
  HISTORY_FILE,
  MAX_HISTORY,
  loadHistory,
  saveHistory,
};
