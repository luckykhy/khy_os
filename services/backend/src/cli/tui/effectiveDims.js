'use strict';

/**
 * effectiveDims — the SINGLE source of truth for usable terminal dimensions.
 *
 * DESIGN-ARCH-102 P4/H8: width always comes from contentWidth(), height always
 * from contentHeight(); components must NEVER read process.stdout themselves.
 * This module is the ONE place that reads stdout.columns / stdout.rows, and it
 * applies the sticky-dimension rule to BOTH axes so a conpty frame that
 * reports undefined/0 for one axis cannot desync the layout (root cause D:
 * un-stickified row heights fed different fallbacks into different call sites).
 *
 * Sticky rule (shared by cols and rows, same cache holder discipline as the
 * legacy effectiveCols.js this replaces): a POSITIVE reading updates the cache;
 * an UNKNOWN reading (undefined/null) reuses the last valid value (gated by
 * KHY_TERM_STICKY_DIMS, default on); a GARBAGE reading (0/NaN) is a measurement
 * result, not an unknown — it returns 0 and never sticks.
 *
 * Band model (DESIGN-ARCH-103 R1-2, replaces the railActiveHysteresis boolean):
 * the sidebar narrows width only INSIDE a dead band with dual thresholds —
 * enter at cols >= 120, exit only at cols <= 108 — and inside the band the
 * width is quantized to a multiple of 4, so 1..3-column drag jitter produces
 * zero reflow. See bandCols().
 *
 * effectiveCols.js remains as a byte-compatible alias re-exporting this module.
 */

const BAND_ENTER = 120; // enter the narrowing band at >= 120 cols
const BAND_EXIT = 108; // exit only at <= 108 cols (12-col dead zone)
const QUANTUM = 4; // in-band width quantized to a multiple of 4

// Last VALID cols / rows readings (module-level on purpose: deep components and
// App must resolve through the SAME caches, or their verdicts diverge within a
// frame — the double-board / blank-gutter failure).
let _lastValidCols = null;
let _lastValidRows = null;
// Last rail-activation verdict (same holder discipline).
let _lastRailActive = false;

/**
 * @param {*} raw - explicit dimension reading (mid-resolution path)
 * @returns {number|null} floored positive; 0 = garbage; null = unknown
 */
function stickyDimOf(raw) {
  if (raw == null) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

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
 * Sticky raw terminal rows — the symmetric row ledger (root cause D fix).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number|null} positive = usable; null = unknown; 0 = garbage reading
 */
function stickyRows(env = process.env) {
  const raw = typeof process !== 'undefined' && process.stdout ? process.stdout.rows : 0;
  let v;
  try {
    v = require('./sidebarLayout').stickyDim(raw, _lastValidRows, env);
  } catch {
    v =
      raw == null
        ? null
        : Number.isFinite(Number(raw)) && Number(raw) > 0
          ? Math.floor(Number(raw))
          : 0;
  }
  if (typeof v === 'number' && v > 0) {
    _lastValidRows = v;
  }
  return v;
}

/**
 * The single width accessor. Replaces effectiveCols(fallback).
 * @param {number|null} [colsArg] - explicit current cols; null/undefined → sticky cache
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [fallback=80] - value when no usable width is known
 * @returns {number}
 */
function contentWidth(colsArg = null, env = process.env, fallback = 80) {
  const raw = colsArg == null ? stickyCols(env) : stickyDimOf(colsArg);
  try {
    const rail = require('./railLayout');
    const sb = require('./sidebarLayout');
    const unknown = raw == null;
    const c = unknown ? sb.fallbackCols(env) : Number(raw);
    if (Number.isFinite(c) && c > 0) {
      const full = Math.floor(c);
      // DESIGN-ARCH-103 R1-2 band model (single source, local bandCols below):
      // rail narrows width only INSIDE the band — enter at >= BAND_ENTER (120),
      // exit only at <= BAND_EXIT (108) — threaded through the previous verdict
      // so a terminal parked on the boundary cannot flap. This supersedes the
      // legacy 2-column railActiveHysteresis dead-band; the legacy rail.railActive
      // path stays on the other call sites (contentCols/railGeometry) which do
      // not thread a previous verdict.
      const band = bandCols(full, _lastRailActive, env);
      _lastRailActive = band.active;
      if (band.active) {
        // Narrowing starts from the FULL width (mainColumnCols = full -
        // sidebarWidth) — the quantized value only decides activation, never
        // the subtracted base. (Same contract as railLayout.contentCols.)
        const main = sb.mainColumnCols(full, env);
        if (main > 0) {
          return main;
        }
      }
      if (!unknown) {
        return full;
      }
    }
  } catch {
    /* leaf unavailable → legacy width below */
  }
  const r = Number(raw);
  return Number.isFinite(r) && r > 0 ? Math.floor(r) : fallback;
}

/**
 * @param {number|null} [rowsArg]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [fallback=24]
 * @returns {number}
 */
function contentHeight(rowsArg = null, env = process.env, fallback = 24) {
  const raw = rowsArg == null ? stickyRows(env) : stickyDimOf(rowsArg);
  const r = Number(raw);
  if (Number.isFinite(r) && r > 0) {
    return Math.floor(r);
  }
  try {
    const sb = require('./sidebarLayout');
    if (typeof sb.fallbackRows === 'function') {
      return sb.fallbackRows(env);
    }
  } catch {
    /* leaf unavailable */
  }
  return Number.isFinite(r) && r > 0 ? Math.floor(r) : fallback;
}

/**
 * R1-2 band model: enter the narrowing band at >= BAND_ENTER, exit only at
 * <= BAND_EXIT (12-col dead zone). Inside the band the value is quantized to a
 * multiple of QUANTUM, so 1..3-col jitter does not reflow the tree.
 *
 * @param {number} cols - a resolved, POSITIVE col count (use stickyCols first)
 * @param {boolean} [wasActive] - previous in-band verdict (dead-zone threading)
 * @returns {{active: boolean, quantized: number}}
 */
function bandCols(cols, wasActive = false, env = process.env) {
  const c = Number(cols);
  if (!Number.isFinite(c) || c <= 0) {
    return { active: false, quantized: 0 };
  }
  // The band model only matters when the out-of-band rail is actually the
  // active path (KHY_SIDEBAR_RAIL opt-in). Gate off → no narrowing, ever.
  let gateOn = false;
  try {
    gateOn = require('./railLayout').railGateOn(env);
  } catch {
    /* leaf unavailable → band stays off */
  }
  if (!gateOn) {
    return { active: false, quantized: c };
  }
  let active;
  if (wasActive === true) {
    active = c > BAND_EXIT; // exit at/below the exit threshold (108)
  } else {
    active = c >= BAND_ENTER; // enter at the enter threshold
  }
  const q = Math.max(QUANTUM, Math.round(c / QUANTUM) * QUANTUM);
  return { active, quantized: active ? q : c };
}

/** Test-only: reset all sticky caches so suites can simulate a fresh session. */
function _resetStickyForTest() {
  _lastValidCols = null;
  _lastValidRows = null;
  _lastRailActive = false;
}

/** Back-compat alias for the legacy test hook name. */
const _resetStickyColsForTest = _resetStickyForTest;

module.exports = {
  stickyCols,
  stickyRows,
  contentWidth,
  contentHeight,
  bandCols,
  BAND_ENTER,
  BAND_EXIT,
  QUANTUM,
  _resetStickyForTest,
  _resetStickyColsForTest,
};
