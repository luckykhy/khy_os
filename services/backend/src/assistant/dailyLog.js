/**
 * Daily Log — append-only markdown logs for KAIROS assistant mode.
 *
 * Logs stored at: ~/.khyquant/memory/logs/YYYY/MM/YYYY-MM-DD.md
 * Each entry has a timestamp header. Files auto-created on first write.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function _logsDir() {
  const { getDataDir } = require('../utils/dataHome');
  return getDataDir('memory', 'logs');
}

/**
 * Get the log file path for a given date.
 * @param {Date} [date]
 * @returns {string}
 */
function _logPath(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dir = path.join(_logsDir(), String(y), m);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return path.join(dir, `${y}-${m}-${d}.md`);
}

/**
 * Append an entry to today's log.
 * @param {string} entry - Markdown content to append
 */
function appendLog(entry) {
  const logFile = _logPath();
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const content = `## ${time}\n${entry}\n\n`;

  // Create file with header if it doesn't exist
  if (!fs.existsSync(logFile)) {
    const dateStr = now.toISOString().split('T')[0];
    fs.writeFileSync(logFile, `# Daily Log — ${dateStr}\n\n`, 'utf-8');
  }

  fs.appendFileSync(logFile, content, 'utf-8');
}

/**
 * Read today's log.
 * @returns {string|null}
 */
function readTodayLog() {
  return readLogForDate(new Date());
}

/**
 * Read log for a specific date.
 * @param {Date} date
 * @returns {string|null}
 */
function readLogForDate(date) {
  const logFile = _logPath(date);
  try {
    if (!fs.existsSync(logFile)) return null;
    return fs.readFileSync(logFile, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Get recent logs for the last N days.
 * @param {number} days
 * @returns {Array<{date: string, content: string}>}
 */
function getRecentLogs(days = 7) {
  const results = [];
  const now = new Date();

  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const content = readLogForDate(date);
    if (content) {
      results.push({
        date: date.toISOString().split('T')[0],
        content,
      });
    }
  }

  return results;
}

/**
 * Get the total number of log files (proxy for session count).
 * @returns {number}
 */
function getLogFileCount() {
  try {
    const baseDir = _logsDir();
    let count = 0;
    const years = fs.readdirSync(baseDir).filter(f => /^\d{4}$/.test(f));
    for (const year of years) {
      const months = fs.readdirSync(path.join(baseDir, year)).filter(f => /^\d{2}$/.test(f));
      for (const month of months) {
        const files = fs.readdirSync(path.join(baseDir, year, month)).filter(f => f.endsWith('.md'));
        count += files.length;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

module.exports = {
  appendLog, readTodayLog, readLogForDate, getRecentLogs, getLogFileCount,
};
