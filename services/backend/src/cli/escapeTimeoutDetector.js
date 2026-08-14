'use strict';

/**
 * escapeTimeoutDetector — pure leaf (zero IO, deterministic, never throws, unit-testable).
 *
 * Resolves readline's `escapeCodeTimeout` (ms): the window readline waits to
 * disambiguate a lone ESC keypress from the start of a multi-byte escape
 * sequence (arrows, function keys, bracketed paste). Too short over a laggy
 * link splits sequences into garbage; too long hurts perceived responsiveness.
 *
 * Goal: MORE tolerance on high-latency terminals, with NO regression elsewhere.
 * The default preserves the legacy 120ms window; SSH/dumb widen it for latency
 * tolerance. Nothing is faster than legacy by default.
 *
 * Precedence (highest first):
 *   1. KHY_INPUT_ESCAPE_TIMEOUT_MS env override — always wins when set.
 *   2. SSH_CONNECTION present  → remote latency needs a wider, more tolerant window.
 *   3. TERM === 'dumb'         → minimal/unknown terminal, longest/most conservative.
 *   4. WT_SESSION / everything else → legacy 120ms default (no regression).
 */

// Env var that lets an operator pin the timeout regardless of detection.
const OVERRIDE_ENV = 'KHY_INPUT_ESCAPE_TIMEOUT_MS';

// Responsiveness floor: never wait less than this (matches legacy Math.max(10, …)).
const MIN_TIMEOUT_MS = 10;
// Remote SSH sessions: longest, most tolerant window to absorb network jitter
// between ESC bytes (prevents split arrow-key/paste sequences over high latency).
const SSH_TIMEOUT_MS = 200;
// Dumb terminals: conservative/longest window for slow/minimal emulators.
const DUMB_TERM_TIMEOUT_MS = 200;
// Local terminals (Windows Terminal, iTerm, etc.) and the default fallback.
// Preserves the legacy 120ms default so no terminal becomes more aggressive.
const DEFAULT_TIMEOUT_MS = 120;

/**
 * Resolve the escapeCodeTimeout in milliseconds for the current environment.
 * @param {Object} [env=process.env] environment map (injectable for tests)
 * @returns {number} timeout in ms, never below MIN_TIMEOUT_MS
 */
function resolveEscapeCodeTimeout(env = process.env) {
  const e = env || {};

  // 1. Explicit override always wins (highest precedence), clamped to the floor.
  const raw = e[OVERRIDE_ENV];
  if (raw != null && String(raw).trim() !== '') {
    const parsed = parseInt(String(raw), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(MIN_TIMEOUT_MS, parsed);
    }
  }

  // 2. Remote SSH session → longer, more tolerant disambiguation window.
  if (String(e.SSH_CONNECTION || '').trim()) {
    return SSH_TIMEOUT_MS;
  }

  // 3. Dumb terminal → longest/most conservative window.
  if (
    String(e.TERM || '')
      .trim()
      .toLowerCase() === 'dumb'
  ) {
    return DUMB_TERM_TIMEOUT_MS;
  }

  // 4. Windows Terminal / default → legacy 120ms window (no regression).
  return DEFAULT_TIMEOUT_MS;
}

module.exports = {
  resolveEscapeCodeTimeout,
  OVERRIDE_ENV,
  MIN_TIMEOUT_MS,
  SSH_TIMEOUT_MS,
  DUMB_TERM_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
};
