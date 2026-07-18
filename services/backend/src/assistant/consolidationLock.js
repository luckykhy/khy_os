/**
 * Consolidation Lock — prevent concurrent auto-dream processes.
 *
 * Uses a lock file with PID contents and mtime as last-consolidated timestamp.
 * Stale locks (holder process dead or lock >1h old) are automatically released.
 *
 * Ported from Claude Code's autoDream/consolidationLock.ts.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HOLDER_STALE_MS = 60 * 60 * 1000; // 1 hour

function _lockPath() {
  const { getDataDir } = require('../utils/dataHome');
  return path.join(getDataDir('memory'), '.consolidate-lock');
}

/**
 * Check if a process is running by PID.
 * @param {number} pid
 * @returns {boolean}
 */
function _isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the timestamp of last successful consolidation.
 * @returns {number} Epoch ms, or 0 if never consolidated
 */
function readLastConsolidatedAt() {
  try {
    const lockFile = _lockPath();
    if (!fs.existsSync(lockFile)) return 0;
    return fs.statSync(lockFile).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Try to acquire the consolidation lock.
 *
 * @returns {{ acquired: boolean, priorMtime: number, blockedBy?: number }}
 */
function tryAcquireLock() {
  const lockFile = _lockPath();

  // Check existing lock
  try {
    if (fs.existsSync(lockFile)) {
      const content = fs.readFileSync(lockFile, 'utf-8').trim();
      const holderPid = parseInt(content, 10);

      if (holderPid && _isProcessRunning(holderPid)) {
        // Lock holder is alive
        const lockAge = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (lockAge < HOLDER_STALE_MS) {
          return { acquired: false, priorMtime: 0, blockedBy: holderPid };
        }
        // Stale lock — holder may be hung, take over
      }
      // Dead holder or stale lock — safe to take over
    }
  } catch { /* lock file corrupt, take over */ }

  // Record prior mtime for rollback
  let priorMtime = 0;
  try {
    if (fs.existsSync(lockFile)) {
      priorMtime = fs.statSync(lockFile).mtimeMs;
    }
  } catch { /* ignore */ }

  // Write our PID
  fs.writeFileSync(lockFile, String(process.pid), 'utf-8');

  // Race check: re-read to confirm we won
  try {
    const content = fs.readFileSync(lockFile, 'utf-8').trim();
    if (parseInt(content, 10) !== process.pid) {
      return { acquired: false, priorMtime: 0 };
    }
  } catch {
    return { acquired: false, priorMtime: 0 };
  }

  return { acquired: true, priorMtime };
}

/**
 * Release the consolidation lock (updates mtime to "now" as consolidation timestamp).
 */
function releaseLock() {
  try {
    const lockFile = _lockPath();
    // Touch the file to update mtime (marks consolidation time)
    const now = new Date();
    fs.utimesSync(lockFile, now, now);
  } catch { /* ignore */ }
}

/**
 * Rollback lock to prior state (used on dream failure).
 * @param {number} priorMtime - 0 means delete the lock file
 */
function rollbackLock(priorMtime) {
  const lockFile = _lockPath();
  try {
    if (priorMtime === 0) {
      fs.unlinkSync(lockFile);
    } else {
      // Restore prior mtime
      const t = new Date(priorMtime);
      fs.writeFileSync(lockFile, '', 'utf-8');
      fs.utimesSync(lockFile, t, t);
    }
  } catch { /* ignore */ }
}

module.exports = {
  readLastConsolidatedAt,
  tryAcquireLock,
  releaseLock,
  rollbackLock,
};
