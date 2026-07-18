'use strict';

/**
 * toolErrorFold — pure decision for how many tool-ERROR detail lines to show and
 * how many to fold behind an honest marker. Single source so the ink TUI error
 * branch stops silently dropping the tail of a multi-line error.
 *
 * Aligns CC `src/components/FallbackToolUseErrorMessage.tsx`: a tool error is
 * capped at `MAX_RENDERED_LINES` (10) when collapsed, with a separate dim footer
 *   "… +N lines (ctrl+o to see all)"
 * (`plusLines = countCharInString(error,'\n') + 1 - MAX_RENDERED_LINES`), and the
 * FULL error is shown when verbose / expanded (Ctrl+O). Khy historically rendered
 * `String(reason).split('\n').slice(0, 3)` in the error branch — a silent 3-line
 * cap that (a) drops everything past line 3 with NO marker (the user cannot tell
 * the error continues) and (b) ignores `expanded`, so Ctrl+O never reveals the
 * rest — the same "silently truncated, Ctrl+O is a lie" class 刀17 fixed for
 * literal stdout. This leaf produces only the {shown, hidden} decision; colouring
 * (red lines, dim marker) and the marker wording stay at the call-site.
 *
 * Gate KHY_TOOL_ERROR_FOLD (default on): CC head-cap (10) + hidden count + expand
 * reveals all. Gate off / unset-to-0 → byte-identical legacy silent 3-line cap
 * ({ shown: lines.slice(0,3), hidden: 0 }, unaffected by `expanded`).
 *
 * Pure, dependency-free, never throws.
 */

// CC FallbackToolUseErrorMessage MAX_RENDERED_LINES.
const ERR_RENDERED_LINES = 10;
// Legacy silent cap (byte-fallback when the gate is off).
const LEGACY_ERR_LINES = 3;

function toolErrorFoldEnabled(env = process.env) {
  const v = String((env && env.KHY_TOOL_ERROR_FOLD) || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Decide which error detail lines to render and how many are folded away.
 * @param {string[]} lines    full error reason, already split on '\n'
 * @param {boolean}  expanded Ctrl+O state — true reveals the whole error
 * @param {object}   env      process.env (for the gate)
 * @returns {{ shown: string[], hidden: number }}
 */
function planErrorFold(lines, expanded, env = process.env) {
  const arr = Array.isArray(lines) ? lines : [];
  // Gate off → legacy: silent head cap, no marker, ignore expanded.
  if (!toolErrorFoldEnabled(env)) {
    return { shown: arr.slice(0, LEGACY_ERR_LINES), hidden: 0 };
  }
  // Expanded (Ctrl+O) → reveal everything, honest to the promise.
  if (expanded) {
    return { shown: arr, hidden: 0 };
  }
  // Collapsed → CC head cap + honest hidden count.
  return {
    shown: arr.slice(0, ERR_RENDERED_LINES),
    hidden: Math.max(0, arr.length - ERR_RENDERED_LINES),
  };
}

module.exports = {
  planErrorFold,
  toolErrorFoldEnabled,
  ERR_RENDERED_LINES,
  LEGACY_ERR_LINES,
};
