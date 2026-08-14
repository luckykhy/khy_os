'use strict';

/**
 * effectiveCols — the ONE accessor every render path uses to learn how many
 * columns it may paint into.
 *
 * Why it exists: with the right rail active (railLayout), ink is confined to
 * `cols - railWidth` and the remaining columns are painted out of band. Any
 * render path that still measured against the FULL terminal width would emit
 * lines wider than its container; those soft-wrap into extra VISUAL rows that
 * the live-region height ledger never counted, the live region overflows the
 * viewport and ink's erase mis-count smears the frame — the staircase /
 * fullscreen-repaint failure documented at sidebarLayout.js:332-344.
 * Overstating the width is the only unsafe direction, so every reader funnels
 * through here.
 *
 * Impure by design (it reads process.stdout and process.env) — the geometry math
 * itself stays in the pure railLayout leaf. Never throws: a missing leaf, a
 * broken require, or an unusable `columns` all degrade to the caller's own
 * legacy fallback, which makes the rail-off path byte-identical to the
 * pre-rail code.
 *
 * Sticky columns (anti frame-to-frame jitter): Windows conpty can oscillate
 * columns between a valid value and undefined ACROSS frames (120 → undefined →
 * 120). Every reader funnels through stickyCols(), which holds the SINGLE
 * module-level cache of the last valid reading and applies the pure
 * sidebarLayout.stickyDim rule — an undefined frame reuses the last valid
 * width instead of dropping to the assumed fallback, so the narrowing verdict
 * (and with it the whole ink layout) cannot flip on a phantom frame. Gate
 * KHY_TERM_STICKY_DIMS (default on) lives in the same pure leaf.
 */

// Last VALID columns reading (module-level on purpose: deep components and App
// must resolve through the SAME cache, or their verdicts could diverge within
// a frame — which is exactly the double-board / blank-gutter failure).
let _lastValidCols = null;

// Last rail-activation verdict (module-level, same holder discipline as
// _lastValidCols): threaded back into railActive so the 119↔120 boundary gets a
// dead-band (railActiveHysteresis) and the narrowing decision cannot flap on
// phantom width jitter. Initial false = "not yet active"; the first unknown
// frame still activates via the relaxed fallback gate (hysteresis ignores
// wasActive when the size is unknown), so this never traps the 80-col lock.
let _lastRailActive = false;

/**
 * Sticky raw terminal columns — the one place process.stdout.columns is read.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number|null} positive = usable; null = unknown; 0 = garbage reading
 */
function stickyCols(env = process.env) {
  const raw = typeof process !== 'undefined' && process.stdout ? process.stdout.columns : 0;
  let v;
  try {
    v = require('./sidebarLayout').stickyDim(raw, _lastValidCols, env);
  } catch {
    // Leaf unavailable → pre-sticky behavior (raw passthrough trichotomy).
    v =
      raw == null
        ? null
        : Number.isFinite(Number(raw)) && Number(raw) > 0
          ? Math.floor(Number(raw))
          : 0;
  }
  if (typeof v === 'number' && v > 0) {
    _lastValidCols = v;
  }
  return v;
}

/**
 * @param {number} [fallback=80] - value to return when the terminal reports no
 *   usable width. Pass `undefined` when the caller's downstream API treats
 *   "unknown width" specially (ToolLines' clip helpers do).
 * @returns {number|undefined}
 */
function effectiveCols(fallback = 80) {
  const raw = stickyCols(process.env);
  try {
    const rail = require('./railLayout');
    const sb = require('./sidebarLayout');
    const unknown = raw == null;
    const c = unknown ? sb.fallbackCols(process.env) : Number(raw);
    if (Number.isFinite(c) && c > 0) {
      const full = Math.floor(c);
      // Hysteresis-aware activation (119↔120 anti-flip): thread the cached last
      // verdict so a width parked on the boundary keeps its narrowing decision.
      // Unknown size still resolves via the relaxed fallback gate inside
      // railActiveHysteresis, so the first unknown frame is not trapped in the
      // dead-band. Result equals contentCols() byte-for-byte except when the
      // dead-band deliberately holds the previous verdict on a boundary jitter.
      const active = rail.railActive(unknown ? null : full, process.env, _lastRailActive);
      _lastRailActive = active;
      if (active) {
        const main = sb.mainColumnCols(full, process.env);
        if (main > 0) {
          return main;
        }
      }
      // Inactive / no room: full real width when known; unknown falls through to
      // the caller's own legacy fallback (matches contentCols' unknown→0 path).
      if (!unknown) {
        return full;
      }
    }
  } catch {
    /* leaf unavailable → legacy width below */
  }
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Test-only: reset the sticky cache so suites can simulate a fresh session. */
function _resetStickyColsForTest() {
  _lastValidCols = null;
  _lastRailActive = false;
}

module.exports = { effectiveCols, stickyCols, _resetStickyColsForTest };
