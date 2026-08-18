'use strict';

/**
 * Watchdog Service — automatic daemon/tray crash recovery.
 *
 * Periodically checks daemon health via heartbeat and automatically restarts
 * on consecutive failures. Uses exponential backoff to prevent restart storms.
 *
 * Features:
 * - Configurable heartbeat interval (KHY_WATCHDOG_INTERVAL env, default 10s)
 * - 3 consecutive heartbeat failures trigger restart
 * - Exponential backoff: 5s → 10s → 20s → max 60s
 * - Stops after 5 consecutive restart failures
 * - Writes healAudit for each restart attempt
 */

const daemonManager = require('./daemonManager');
const { writeHealAudit } = require('../utils/healAudit');
const healAuditService = require('./healAuditService');

const DEFAULT_INTERVAL_MS = parseInt(process.env.KHY_WATCHDOG_INTERVAL || '10000', 10);
const MIN_INTERVAL_MS = 5000;
const MAX_INTERVAL_MS = 300000;
const HEARTBEAT_FAILURE_THRESHOLD = 3;
const MAX_RESTART_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 60000;
const BACKOFF_MULTIPLIER = 2;

let _timer = null;
let _enabled = false;
let _intervalMs = DEFAULT_INTERVAL_MS;
let _consecutiveFailures = 0;
let _consecutiveRestartFailures = 0;
let _lastRestartAt = 0;
let _currentBackoffMs = INITIAL_BACKOFF_MS;
let _abandonedAt = null;

/**
 * Normalize interval to safe bounds.
 */
function _normalizeInterval(intervalMs) {
  const n = parseInt(String(intervalMs || ''), 10);
  if (!Number.isFinite(n)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, n));
}

/**
 * Check daemon health via status call.
 * @returns {Promise<boolean>}
 */
async function _checkHealth() {
  try {
    const status = await daemonManager.daemonStatus();
    return status.running === true;
  } catch {
    return false;
  }
}

/**
 * Attempt to restart the daemon with exponential backoff.
 */
async function _attemptRestart() {
  // Check if we've exceeded max attempts
  if (_consecutiveRestartFailures >= MAX_RESTART_ATTEMPTS) {
    if (!_abandonedAt) {
      _abandonedAt = Date.now();
      const msg = `watchdog 已放弃重启 daemon (${_consecutiveRestartFailures}/${MAX_RESTART_ATTEMPTS} 次失败)，请手动 khy daemon restart`;

      // Write audit log
      await writeHealAudit({
        action: 'watchdog_abandoned',
        target: 'daemon',
        reason: 'max_restart_attempts_exceeded',
        details: {
          consecutiveFailures: _consecutiveRestartFailures,
          maxAttempts: MAX_RESTART_ATTEMPTS,
        },
        message: msg,
      });

      // Unified heal audit
      healAuditService.logHealEvent({
        component: 'watchdog',
        action: 'abandoned',
        target: 'daemon',
        result: 'failure',
        details: {
          consecutiveFailures: _consecutiveRestartFailures,
          maxAttempts: MAX_RESTART_ATTEMPTS,
        },
      });
    }
    return false;
  }

  // Calculate backoff delay
  const now = Date.now();
  const timeSinceLastRestart = now - _lastRestartAt;
  if (timeSinceLastRestart < _currentBackoffMs) {
    // Still in backoff window, skip this attempt
    return false;
  }

  _consecutiveRestartFailures++;
  _lastRestartAt = now;

  const attemptMsg = `重启 daemon 进程，第 ${_consecutiveRestartFailures}/${MAX_RESTART_ATTEMPTS} 次尝试`;

  try {
    // Write audit log before restart attempt
    await writeHealAudit({
      action: 'watchdog_restart_attempt',
      target: 'daemon',
      reason: 'consecutive_heartbeat_failures',
      details: {
        attemptNumber: _consecutiveRestartFailures,
        maxAttempts: MAX_RESTART_ATTEMPTS,
        backoffMs: _currentBackoffMs,
        consecutiveHeartbeatFailures: _consecutiveFailures,
      },
      message: attemptMsg,
    });

    // Unified heal audit
    healAuditService.logHealEvent({
      component: 'watchdog',
      action: 'restart_attempt',
      target: 'daemon',
      result: 'pending',
      details: {
        attemptNumber: _consecutiveRestartFailures,
        maxAttempts: MAX_RESTART_ATTEMPTS,
        backoffMs: _currentBackoffMs,
        consecutiveHeartbeatFailures: _consecutiveFailures,
      },
    });

    // Attempt restart
    const result = daemonManager.daemonRestart();

    // Success - reset failure counters and backoff
    _consecutiveFailures = 0;
    _consecutiveRestartFailures = 0;
    _currentBackoffMs = INITIAL_BACKOFF_MS;
    _abandonedAt = null;

    await writeHealAudit({
      action: 'watchdog_restart_success',
      target: 'daemon',
      details: {
        pid: result.pid,
        port: result.port,
      },
      message: `daemon 重启成功 (PID ${result.pid}, port ${result.port})`,
    });

    // Unified heal audit
    healAuditService.logHealEvent({
      component: 'watchdog',
      action: 'restart_success',
      target: 'daemon',
      result: 'success',
      details: {
        pid: result.pid,
        port: result.port,
      },
    });

    return true;
  } catch (err) {
    // Restart failed - increase backoff
    _currentBackoffMs = Math.min(_currentBackoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);

    await writeHealAudit({
      action: 'watchdog_restart_failed',
      target: 'daemon',
      reason: 'restart_error',
      details: {
        attemptNumber: _consecutiveRestartFailures,
        maxAttempts: MAX_RESTART_ATTEMPTS,
        nextBackoffMs: _currentBackoffMs,
        error: err?.message || String(err),
      },
      message: `daemon 重启失败 (${_consecutiveRestartFailures}/${MAX_RESTART_ATTEMPTS}): ${err?.message || err}`,
    });

    // Unified heal audit
    healAuditService.logHealEvent({
      component: 'watchdog',
      action: 'restart_failed',
      target: 'daemon',
      result: 'failure',
      details: {
        attemptNumber: _consecutiveRestartFailures,
        maxAttempts: MAX_RESTART_ATTEMPTS,
        nextBackoffMs: _currentBackoffMs,
        error: err?.message || String(err),
      },
    });

    return false;
  }
}

/**
 * Heartbeat check loop.
 */
async function _tick() {
  if (!_enabled) {
    return;
  }

  // Skip if we've abandoned restart attempts
  if (_abandonedAt) {
    return;
  }

  const healthy = await _checkHealth();

  if (healthy) {
    // Reset failure counter on successful heartbeat
    _consecutiveFailures = 0;
  } else {
    // Increment failure counter
    _consecutiveFailures++;

    // Trigger restart after threshold
    if (_consecutiveFailures >= HEARTBEAT_FAILURE_THRESHOLD) {
      await _attemptRestart();
    }
  }
}

/**
 * Start the watchdog service.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] - Heartbeat interval
 * @returns {object}
 */
function start(opts = {}) {
  if (_enabled && _timer) {
    return { changed: false, ...status() };
  }

  stop(); // Clean up any existing timer

  _intervalMs = _normalizeInterval(opts.intervalMs);
  _enabled = true;
  _consecutiveFailures = 0;
  _consecutiveRestartFailures = 0;
  _currentBackoffMs = INITIAL_BACKOFF_MS;
  _abandonedAt = null;

  _timer = setInterval(() => {
    _tick().catch(() => {
      /* best effort - never crash watchdog */
    });
  }, _intervalMs);

  if (typeof _timer.unref === 'function') {
    _timer.unref();
  }

  return { changed: true, ...status() };
}

/**
 * Stop the watchdog service.
 * @returns {object}
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _enabled = false;
  return status();
}

/**
 * Get watchdog status.
 * @returns {object}
 */
function status() {
  return {
    enabled: _enabled,
    intervalMs: _intervalMs,
    consecutiveFailures: _consecutiveFailures,
    consecutiveRestartFailures: _consecutiveRestartFailures,
    currentBackoffMs: _currentBackoffMs,
    abandoned: !!_abandonedAt,
    abandonedAt: _abandonedAt ? new Date(_abandonedAt).toISOString() : null,
    lastRestartAt: _lastRestartAt ? new Date(_lastRestartAt).toISOString() : null,
  };
}

/**
 * Manually trigger a health check and restart if needed.
 * Used by baseSelfCheckService when daemon is detected as down.
 * @returns {Promise<boolean>} - true if restart was triggered
 */
async function triggerRecovery() {
  if (!_enabled) {
    return false;
  }

  if (_abandonedAt) {
    return false;
  }

  const healthy = await _checkHealth();
  if (!healthy) {
    _consecutiveFailures = HEARTBEAT_FAILURE_THRESHOLD; // Force threshold
    return await _attemptRestart();
  }

  return false;
}

/**
 * Reset the watchdog state (for testing or manual recovery).
 */
function reset() {
  _consecutiveFailures = 0;
  _consecutiveRestartFailures = 0;
  _currentBackoffMs = INITIAL_BACKOFF_MS;
  _abandonedAt = null;
  _lastRestartAt = 0;
}

module.exports = {
  start,
  stop,
  status,
  triggerRecovery,
  reset,
  constants: {
    DEFAULT_INTERVAL_MS,
    HEARTBEAT_FAILURE_THRESHOLD,
    MAX_RESTART_ATTEMPTS,
    INITIAL_BACKOFF_MS,
    MAX_BACKOFF_MS,
  },
};
