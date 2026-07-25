'use strict';

/**
 * contextProfile — single source of truth for window-proportional context
 * engineering knobs.
 *
 * Small models run on short context windows (8k–32k tokens). The rest of the
 * context pipeline was tuned with absolute floors that silently assume a
 * 128k–200k window:
 *   - contextWindowGuard: warnBelow=8000 / hardMin=4000 → on an 8k window the
 *     guard warns across the WHOLE window and blocks below half of it.
 *   - compact.shouldCompact: reserveTokens=4096 → reserves HALF of an 8k window.
 *   - tool-result caps: a single 5000-char result is ~15% of an 8k window.
 *
 * Those constants are correct on a large window (the floor only ever binds
 * BELOW, so a 200k window is unaffected) but wrong on a small one. This module
 * derives the same knobs proportionally so the short-context call sites stop
 * hardcoding numbers that only hold for large models. Big windows get byte-
 * identical results to the legacy constants — every derivation is a `min(...)`
 * cap that can only lower a value that the absolute floor pushed too high
 * relative to a small window.
 *
 * Pure + dependency-free on purpose: callers (contextWindowGuard,
 * compact/index, query/compactPipeline) require this, never the reverse, so it
 * can never introduce a cycle.
 *
 * Env overrides (escape hatches, same spirit as the KHY_* flags elsewhere):
 *   KHY_SHORT_CONTEXT_TOKENS        window at/below which a model is "short"     (default 32768)
 *   KHY_VERY_SHORT_CONTEXT_TOKENS   window at/below which a model is "very short" (default 16384)
 */

const DEFAULT_SHORT_CONTEXT_TOKENS = 32_768;
const DEFAULT_VERY_SHORT_CONTEXT_TOKENS = 16_384;

// Legacy absolute floors (mirror contextWindowGuard / compact). Kept here so
// the proportional math has a single home; the guard re-exports its own copies
// for backward compatibility.
const GUARD_HARD_MIN_TOKENS = 4_000;
const GUARD_WARN_BELOW_TOKENS = 8_000;
const GUARD_HARD_MIN_RATIO = 0.1;
const GUARD_WARN_BELOW_RATIO = 0.2;

// Proportional CAPS — a guard floor must never exceed this fraction of the
// window. On a 200k window 0.25/0.4 are far above the absolute floors so they
// never bind; on an 8k window they are what stops the floors from eating it.
const GUARD_HARD_MIN_CAP_RATIO = 0.25;
const GUARD_WARN_BELOW_CAP_RATIO = 0.4;

// Output reserve must never exceed this fraction of a (small) window.
const RESERVE_CAP_RATIO = 0.3;

// Per-tool-result char cap on a short window: ≤ this fraction of the window,
// expressed in chars (≈ tokens × 4).
const TOOL_RESULT_WINDOW_CHAR_RATIO = 0.1;
const CHARS_PER_TOKEN = 4;

/**
 * Read a positive integer env var, falling back to a default.
 * @param {string} name
 * @param {number} dflt
 * @returns {number}
 */
function _envInt(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function _shortThreshold() {
  return _envInt('KHY_SHORT_CONTEXT_TOKENS', DEFAULT_SHORT_CONTEXT_TOKENS);
}

function _veryShortThreshold() {
  return _envInt('KHY_VERY_SHORT_CONTEXT_TOKENS', DEFAULT_VERY_SHORT_CONTEXT_TOKENS);
}

function _normWindow(contextWindowTokens) {
  const w = Math.floor(Number(contextWindowTokens) || 0);
  return w > 0 ? w : 0;
}

/**
 * Classify a context window.
 *   'unknown'    — window not resolved yet (0/absent). Treated as NOT short so a
 *                  frontier model we simply haven't resolved is never wrongly
 *                  starved; callers that want to be conservative can check this.
 *   'very_short' — ≤ KHY_VERY_SHORT_CONTEXT_TOKENS (default 16k)
 *   'short'      — ≤ KHY_SHORT_CONTEXT_TOKENS (default 32k)
 *   'normal'     — everything larger
 * @param {number} contextWindowTokens
 * @returns {'unknown'|'very_short'|'short'|'normal'}
 */
function classifyWindow(contextWindowTokens) {
  const w = _normWindow(contextWindowTokens);
  if (w <= 0) return 'unknown';
  if (w <= _veryShortThreshold()) return 'very_short';
  if (w <= _shortThreshold()) return 'short';
  return 'normal';
}

/**
 * True when the window is short or very short (a real, resolved small window).
 * @param {number} contextWindowTokens
 * @returns {boolean}
 */
function isShortContext(contextWindowTokens) {
  const k = classifyWindow(contextWindowTokens);
  return k === 'short' || k === 'very_short';
}

/**
 * Guard thresholds that stay proportional on small windows.
 * Identical to the legacy `max(floor, window*ratio)` on large windows; the extra
 * `min(..., window*capRatio)` only ever lowers a floor that would otherwise be a
 * huge fraction of a small window.
 * @param {number} contextWindowTokens
 * @returns {{hardMinTokens:number, warnBelowTokens:number}}
 */
function deriveGuardThresholds(contextWindowTokens) {
  const w = _normWindow(contextWindowTokens);
  if (w <= 0) {
    return { hardMinTokens: GUARD_HARD_MIN_TOKENS, warnBelowTokens: GUARD_WARN_BELOW_TOKENS };
  }
  const hardMin = Math.min(
    Math.max(GUARD_HARD_MIN_TOKENS, Math.floor(w * GUARD_HARD_MIN_RATIO)),
    Math.floor(w * GUARD_HARD_MIN_CAP_RATIO),
  );
  const warn = Math.min(
    Math.max(GUARD_WARN_BELOW_TOKENS, Math.floor(w * GUARD_WARN_BELOW_RATIO)),
    Math.floor(w * GUARD_WARN_BELOW_CAP_RATIO),
  );
  // Guarantee warn ≥ hardMin (only matters at pathological tiny windows).
  return { hardMinTokens: hardMin, warnBelowTokens: Math.max(warn, hardMin) };
}

/**
 * Output reserve clamped to a small window. On a large window the requested
 * reserve passes through unchanged (the cap is far above it); on a small window
 * it can never exceed RESERVE_CAP_RATIO of the window, so the response budget
 * cannot swallow half an 8k window.
 * @param {number} contextWindowTokens
 * @param {number} [requested=4096]
 * @returns {number}
 */
function deriveReserveTokens(contextWindowTokens, requested = 4096) {
  const w = _normWindow(contextWindowTokens);
  const req = Math.max(256, Math.floor(Number(requested) || 4096));
  if (w <= 0) return req;
  return Math.min(req, Math.max(512, Math.floor(w * RESERVE_CAP_RATIO)));
}

/**
 * Per-tool-result char cap. Unchanged on normal/unknown windows (returns the
 * caller's default); on a short window a single result is capped to ~10% of the
 * window so one big file read / shell dump can't dominate the budget.
 * @param {number} contextWindowTokens
 * @param {number} [defaultChars=5000]
 * @returns {number}
 */
function deriveToolResultCap(contextWindowTokens, defaultChars = 5000) {
  const w = _normWindow(contextWindowTokens);
  const dflt = Math.max(500, Math.floor(Number(defaultChars) || 5000));
  if (w <= 0 || !isShortContext(w)) return dflt;
  const windowCap = Math.floor(w * CHARS_PER_TOKEN * TOOL_RESULT_WINDOW_CHAR_RATIO);
  return Math.max(800, Math.min(dflt, windowCap));
}

module.exports = {
  classifyWindow,
  isShortContext,
  deriveGuardThresholds,
  deriveReserveTokens,
  deriveToolResultCap,
  // constants (exposed for tests / downstream re-export)
  DEFAULT_SHORT_CONTEXT_TOKENS,
  DEFAULT_VERY_SHORT_CONTEXT_TOKENS,
  GUARD_HARD_MIN_TOKENS,
  GUARD_WARN_BELOW_TOKENS,
  GUARD_HARD_MIN_RATIO,
  GUARD_WARN_BELOW_RATIO,
};
