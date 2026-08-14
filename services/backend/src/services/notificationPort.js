'use strict';

/**
 * notificationPort.js — neutral port for background-event → TUI notifications.
 *
 * Background events (background agent task completed/failed, turn completed)
 * need to surface proactively in the TUI, but services must never require the
 * CLI layer (that reverse edge re-creates the giant SCC). Same registered-port
 * paradigm as compactionUiPort: the CLI layer self-registers its renderer on
 * load (legit cli → services direction); the services layer emits through this
 * port. When nothing is registered (headless service / test) every emit is a
 * silent no-op.
 *
 * Anti-flood buffer: the module keeps only the most recent notifications
 * (KHY_NOTIFY_MAX, default 5, floor 1) and merges ADJACENT same-type
 * notifications into one entry (count + latest message) so a burst of
 * background completions cannot flood the panel. No timers here — expiry /
 * dismissal is the consumer's job.
 *
 * Zero dependencies — a true leaf, so it can never participate in a cycle.
 * Never throws.
 */

// ── constants (single place; no magic numbers scattered below) ──
const DEFAULT_NOTIFY_MAX = 5; // default buffer capacity
const NOTIFY_MAX_FLOOR = 1; // hard lower bound for KHY_NOTIFY_MAX
const NOTIFY_MAX_ENV = 'KHY_NOTIFY_MAX';
const VALID_LEVELS = ['info', 'warn', 'error'];
const DEFAULT_LEVEL = 'info';

let _renderer = null; // (notification) => void, registered by the CLI layer
let _buffer = []; // most recent notifications, oldest first

/** Resolve buffer capacity: env override wins, clamped to the floor. */
function _maxNotifications() {
  const raw = parseInt(String(process.env[NOTIFY_MAX_ENV] || ''), 10);
  if (Number.isFinite(raw)) {
    return Math.max(NOTIFY_MAX_FLOOR, raw);
  }
  return DEFAULT_NOTIFY_MAX;
}

/** Normalize an arbitrary level value into the closed enum. */
function _normalizeLevel(level) {
  return VALID_LEVELS.indexOf(level) !== -1 ? level : DEFAULT_LEVEL;
}

/**
 * Register the notification renderer. Called by the CLI layer on load.
 * Passing anything that is not a function clears the registration.
 */
function registerNotificationRenderer(fn) {
  _renderer = typeof fn === 'function' ? fn : null;
}

/**
 * Emit a notification through the port.
 *
 * The entry is always buffered (merged with the previous entry when the type
 * matches) so a consumer registering later can still pick it up via
 * getRecentNotifications(). Rendering degrades silently: unregistered renderer
 * or a throwing callback → returns false, never throws.
 *
 * @param {{ type?:string, level?:string, title?:string, detail?:string, timestamp?:number }} notification
 * @returns {boolean} true if rendered, false if degraded (no renderer / threw).
 */
function emitNotification(notification) {
  try {
    const n = notification && typeof notification === 'object' ? notification : {};
    const entry = {
      type: String(n.type || 'generic'),
      level: _normalizeLevel(n.level),
      title: String(n.title == null ? '' : n.title),
      detail: String(n.detail == null ? '' : n.detail),
      timestamp: Number.isFinite(n.timestamp) ? Number(n.timestamp) : Date.now(),
      count: 1,
    };
    const last = _buffer[_buffer.length - 1];
    if (last && last.type === entry.type) {
      // Adjacent same-type burst → one entry: bump count, keep latest message,
      // suffix the title with the running total.
      entry.count = last.count + 1;
      entry.title = `${entry.title}（共 ${entry.count} 条）`;
      _buffer[_buffer.length - 1] = entry;
    } else {
      _buffer.push(entry);
      const max = _maxNotifications();
      if (_buffer.length > max) {
        _buffer.splice(0, _buffer.length - max);
      }
    }
    if (!_renderer) {
      return false;
    }
    try {
      _renderer(entry);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Shallow copy of the current buffer (oldest first), for a consumer's initial
 * render after it registers.
 * @returns {Array<{ type:string, level:string, title:string, detail:string, timestamp:number, count:number }>}
 */
function getRecentNotifications() {
  return _buffer.slice();
}

/** @internal Reset registration and buffer for testing. */
function _resetForTest() {
  _renderer = null;
  _buffer = [];
}

module.exports = {
  DEFAULT_NOTIFY_MAX,
  registerNotificationRenderer,
  emitNotification,
  getRecentNotifications,
  _resetForTest,
};
