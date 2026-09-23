'use strict';

/**
 * cliLeafPort — neutral, zero-dependency IoC seam for the **pure-leaf utilities
 * that happen to live under cli/** but carry no CLI coupling of their own.
 *
 * Why this exists
 * ---------------
 * `archDebtScan` R1 forbids `src/services/**` from reaching up into `src/cli/**`.
 * Most R1 hits were genuine layering inversions, but a distinct sub-class turned
 * up repeatedly: service-layer code needing a **pure function** (no IO, no TUI,
 * no state) whose only sin is that it was authored inside cli/ because its first
 * consumer was a TUI component. Examples:
 *
 *   - cli/fullWidthInput.js      — 60 lines, ZERO requires: CJK full-width→half-width
 *   - cli/statusMessageFormatter — single `formatStatusMessage(text)`
 *   - cli/diffRenderer           — `computeStructuredDiffHunks` is a pure transform
 *
 * For these the inversion is not a real architectural violation — it's a
 * **misplaced file**. Ideally they'd be relocated to the service layer; that is a
 * separate, larger change (it touches every TUI call site). This port removes the
 * R1 edge **without moving files**, so the debt is gone either way and the
 * eventual relocation stays a pure refactor with no dependency-direction risk.
 *
 * Relationship to sibling ports
 * -----------------------------
 * Sibling ports (aiChatPort, sessionForestPort, …) each expose one
 * cohesive *capability*. This one is deliberately a **bag of unrelated pure
 * utilities** — they share only the property "pure leaf, authored in cli/". Grouping
 * them keeps the port count from growing one-per-leaf, at the cost of a wider
 * surface. If any member later grows real CLI coupling, split it into its own port.
 *
 * Contract
 * --------
 *   - Pure leaf — no imports, deterministic, offline.
 *   - Every entry independently nullable; non-function coerced to null so callers
 *     use a single `if (!x) return fallback` check.
 *   - Registration is per-key all-or-nothing: a partially-loaded cli can never hand
 *     back a half-wired surface.
 *   - Getters return the **function itself** (not the module) — callers get the
 *     narrowest possible handle, and there is no shared mutable module object to
 *     accidentally monkey-patch across layers.
 */

const _fns = {
  // cli/fullWidthInput.js
  normalizeFullWidthDigits: null,
  normalizeFullWidthSpace: null,
  fullWidthInputEnabled: null,

  // cli/statusMessageFormatter.js
  formatStatusMessage: null,

  // cli/diffRenderer.js — the pure half (the render* halves stay in cli/)
  computeStructuredDiffHunks: null,
  computeStructuredDiffStats: null,
};

const _pick = (v) => (typeof v === 'function' ? v : null);

/**
 * cli/ registers its pure-leaf utilities here on load.
 *
 * Unknown keys are ignored (a caller cannot inject arbitrary state), and a
 * non-function value clears the slot rather than storing garbage.
 *
 * @param {object} [ops]
 * @param {object} [ops.fullWidthInput]            cli/fullWidthInput exports
 * @param {object} [ops.statusMessageFormatter]    cli/statusMessageFormatter exports
 * @param {object} [ops.diffRenderer]              cli/diffRenderer exports
 */
function registerCliLeaves(ops = {}) {
  const fw = ops.fullWidthInput;
  if (fw && typeof fw === 'object') {
    _fns.normalizeFullWidthDigits = _pick(fw.normalizeFullWidthDigits);
    _fns.normalizeFullWidthSpace = _pick(fw.normalizeFullWidthSpace);
    _fns.fullWidthInputEnabled = _pick(fw.fullWidthInputEnabled);
  }

  const smf = ops.statusMessageFormatter;
  if (smf && typeof smf === 'object') {
    _fns.formatStatusMessage = _pick(smf.formatStatusMessage);
  }

  const dr = ops.diffRenderer;
  if (dr && typeof dr === 'object') {
    _fns.computeStructuredDiffHunks = _pick(dr.computeStructuredDiffHunks);
    _fns.computeStructuredDiffStats = _pick(dr.computeStructuredDiffStats);
  }
}

/** cli/fullWidthInput.normalizeFullWidthDigits, or null if cli never loaded. */
function getNormalizeFullWidthDigits() {
  return _fns.normalizeFullWidthDigits;
}

/** cli/fullWidthInput.normalizeFullWidthSpace, or null if cli never loaded. */
function getNormalizeFullWidthSpace() {
  return _fns.normalizeFullWidthSpace;
}

/** cli/fullWidthInput.fullWidthInputEnabled, or null if cli never loaded. */
function getFullWidthInputEnabled() {
  return _fns.fullWidthInputEnabled;
}

/** cli/statusMessageFormatter.formatStatusMessage, or null if cli never loaded. */
function getFormatStatusMessage() {
  return _fns.formatStatusMessage;
}

/** cli/diffRenderer.computeStructuredDiffHunks, or null if cli never loaded. */
function getComputeStructuredDiffHunks() {
  return _fns.computeStructuredDiffHunks;
}

/** cli/diffRenderer.computeStructuredDiffStats, or null if cli never loaded. */
function getComputeStructuredDiffStats() {
  return _fns.computeStructuredDiffStats;
}

function _resetForTest() {
  for (const k of Object.keys(_fns)) {
    _fns[k] = null;
  }
}

module.exports = {
  registerCliLeaves,
  getNormalizeFullWidthDigits,
  getNormalizeFullWidthSpace,
  getFullWidthInputEnabled,
  getFormatStatusMessage,
  getComputeStructuredDiffHunks,
  getComputeStructuredDiffStats,
  _resetForTest,
};
