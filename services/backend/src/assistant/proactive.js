/**
 * Proactive Mode — idle tick system for KAIROS assistant.
 *
 * When the REPL is idle, periodically checks for:
 * - Pending tasks that need attention
 * - Auto-dream eligibility
 * - Optional ambient information
 *
 * Ported from Claude Code's proactive/index.ts.
 */
'use strict';

// ── State ──────────────────────────────────────────────────────────

let _active = false;
let _paused = false;
let _timer = null;
let _listeners = [];

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Public API ─────────────────────────────────────────────────────

/**
 * Check if proactive mode is active.
 * @returns {boolean}
 */
function isProactiveActive() {
  return _active && !_paused;
}

/**
 * Activate proactive mode.
 * @param {number} [intervalMs] - Tick interval
 * @param {function} [onTick] - Callback on each tick
 */
function activate(intervalMs, onTick) {
  if (_active) return;
  _active = true;
  _paused = false;

  const interval = intervalMs || DEFAULT_INTERVAL_MS;
  _timer = setInterval(() => {
    if (_paused) return;
    _runTick(onTick);
  }, interval);

  // Don't keep process alive
  if (_timer.unref) _timer.unref();

  _emit('activated');
}

/**
 * Deactivate proactive mode.
 */
function deactivate() {
  _active = false;
  _paused = false;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _emit('deactivated');
}

/**
 * Pause proactive mode (e.g., when user is typing).
 */
function pause() {
  if (!_active) return;
  _paused = true;
  _emit('paused');
}

/**
 * Resume proactive mode.
 */
function resume() {
  if (!_active) return;
  _paused = false;
  _emit('resumed');
}

/**
 * Register a state change listener.
 * @param {function} listener - Called with (event: string)
 * @returns {function} Unsubscribe function
 */
function subscribe(listener) {
  _listeners.push(listener);
  return () => {
    _listeners = _listeners.filter(l => l !== listener);
  };
}

// ── Internal ───────────────────────────────────────────────────────

function _emit(event) {
  for (const listener of _listeners) {
    try { listener(event); } catch { /* ignore listener errors */ }
  }
}

async function _runTick(onTick) {
  try {
    // Check auto-dream eligibility
    const { shouldDream } = require('./autoDream');
    const dreamCheck = shouldDream();
    if (dreamCheck.needed) {
      _emit('dream-needed');
    }

    // Call user-provided tick handler
    if (onTick) {
      await onTick({ dreamNeeded: dreamCheck.needed, dreamReason: dreamCheck.reason });
    }
  } catch { /* tick error, silently continue */ }
}

module.exports = {
  isProactiveActive,
  activate,
  deactivate,
  pause,
  resume,
  subscribe,
};
