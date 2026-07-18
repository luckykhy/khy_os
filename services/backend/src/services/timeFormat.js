'use strict';

/**
 * timeFormat.js — Human-friendly duration and relative time formatting.
 *
 * Ported from OpenClaw's format-duration.ts + format-relative.ts.
 * Provides:
 *   - formatDurationSeconds: "1.5s", "45 seconds"
 *   - formatDurationPrecise: "500ms", "1.23s"
 *   - formatDurationCompact: "2m5s", "1h30m", "5d"
 *   - formatDurationHuman: single-unit rounding "5s", "3m", "2h"
 *   - formatTimeAgo: "5m ago", "just now"
 *   - formatRelativeTimestamp: "5m ago" or "in 2h" (handles future)
 */

// ── Duration Formatting ────────────────────────────────────────────

/**
 * Format duration as seconds with decimal places.
 *
 * @param {number} ms - Duration in milliseconds
 * @param {object} [opts]
 * @param {number} [opts.decimals=1]
 * @param {'s'|'seconds'} [opts.unit='s']
 * @returns {string} e.g., "1.5s", "45 seconds"
 */
function formatDurationSeconds(ms, opts = {}) {
  if (!Number.isFinite(ms)) return 'unknown';
  const decimals = opts.decimals ?? 1;
  const unit = opts.unit || 's';

  const seconds = ms / 1000;
  let str = seconds.toFixed(decimals);
  // Trim trailing zeros: "1.50" → "1.5", "2.00" → "2"
  str = str.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');

  return unit === 'seconds' ? `${str} seconds` : `${str}s`;
}

/**
 * Format duration with sub-second precision.
 *   < 1s → "500ms"
 *   >= 1s → "1.23s"
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDurationPrecise(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return formatDurationSeconds(ms, { decimals: 2 });
}

/**
 * Format duration as compact multi-unit string.
 *   "500ms", "45s", "2m5s", "1h30m", "3d2h"
 *
 * @param {number} [ms]
 * @param {object} [opts]
 * @param {boolean} [opts.spaced=false] - Use spaces: "2m 5s" vs "2m5s"
 * @returns {string|undefined} undefined if input is null/non-finite
 */
function formatDurationCompact(ms, opts = {}) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const sep = opts.spaced ? ' ' : '';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  // Days
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d${sep}${remHours}h` : `${days}d`;
  }

  // Hours
  if (hours > 0) {
    return minutes > 0 ? `${hours}h${sep}${minutes}m` : `${hours}h`;
  }

  // Minutes
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m${sep}${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}

/**
 * Format duration as single human-readable unit.
 *   "500ms", "5s", "3m", "2h", "5d"
 *
 * @param {number} [ms]
 * @param {string} [fallback='n/a']
 * @returns {string}
 */
function formatDurationHuman(ms, fallback = 'n/a') {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return fallback;
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.round(hours / 24);
  return `${days}d`;
}

// ── Relative Time Formatting ───────────────────────────────────────

/**
 * Format a duration as relative time.
 *   "just now", "5m ago", "3h ago", "2d ago"
 *
 * @param {number} durationMs - How many milliseconds ago
 * @param {object} [opts]
 * @param {boolean} [opts.suffix=true] - Include "ago" suffix
 * @param {string} [opts.fallback='unknown']
 * @returns {string}
 */
function formatTimeAgo(durationMs, opts = {}) {
  const fallback = opts.fallback ?? 'unknown';
  const suffix = opts.suffix !== false;

  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return fallback;

  const seconds = Math.round(durationMs / 1000);

  if (seconds < 60) {
    return suffix ? 'just now' : `${seconds}s`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return suffix ? `${minutes}m ago` : `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return suffix ? `${hours}h ago` : `${hours}h`;
  }

  const days = Math.round(hours / 24);
  return suffix ? `${days}d ago` : `${days}d`;
}

/**
 * Format a timestamp relative to now.
 * Handles both past ("5m ago") and future ("in 2h").
 *
 * @param {number} timestampMs - Epoch timestamp in milliseconds
 * @param {object} [opts]
 * @param {boolean} [opts.dateFallback=false] - Show date for >7 days
 * @param {string} [opts.timezone] - IANA timezone for date fallback
 * @param {string} [opts.fallback='n/a']
 * @returns {string}
 */
function formatRelativeTimestamp(timestampMs, opts = {}) {
  const fallback = opts.fallback ?? 'n/a';
  if (timestampMs == null || !Number.isFinite(timestampMs)) return fallback;

  const diff = Date.now() - timestampMs;
  const absDiff = Math.abs(diff);
  const isPast = diff >= 0;
  const seconds = Math.round(absDiff / 1000);

  if (seconds < 60) {
    return isPast ? 'just now' : 'in <1m';
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return isPast ? `${minutes}m ago` : `in ${minutes}m`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return isPast ? `${hours}h ago` : `in ${hours}h`;
  }

  const days = Math.round(hours / 24);
  if (days < 7) {
    return isPast ? `${days}d ago` : `in ${days}d`;
  }

  // Date fallback for very old timestamps
  if (opts.dateFallback) {
    try {
      const fmt = new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
        ...(opts.timezone ? { timeZone: opts.timezone } : {}),
      });
      return fmt.format(new Date(timestampMs));
    } catch {
      // Fall through to days
    }
  }

  return isPast ? `${days}d ago` : `in ${days}d`;
}

module.exports = {
  formatDurationSeconds,
  formatDurationPrecise,
  formatDurationCompact,
  formatDurationHuman,
  formatTimeAgo,
  formatRelativeTimestamp,
};
