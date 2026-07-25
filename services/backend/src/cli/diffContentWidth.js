'use strict';

/**
 * diffContentWidth — pure leaf SSOT for "how wide may a diff CONTENT cell be" in
 * the ink TUI, and whether a long line is CLIPPED (collapsed glance) or WRAPPED
 * (expanded, no content loss).
 *
 * Why this exists (CC alignment, the logic behind the display):
 *   CC's StructuredDiff/Fallback.tsx::formatDiff derives a per-line content budget
 *   from the LIVE terminal width —
 *       availableContentWidth = max(1, safeWidth - maxWidth - 1 - diffPrefixWidth)
 *   — and renders each diff line with `wrapText(code, availableContentWidth, 'wrap')`,
 *   so long lines WRAP across rows and NOTHING is ever dropped.
 *   The ink TUI (ToolLines.renderDiffRows) instead hard-cut every diff line at a
 *   FIXED 100 chars via `clip(text, 100)` — regardless of terminal width AND
 *   regardless of the expanded (Ctrl+O) state. That silently hid code past column
 *   100 even when the user explicitly pressed Ctrl+O to "see the full change",
 *   contradicting ToolLines' own stated expansion-honesty principle, and it
 *   over/under-shot narrow/wide terminals (100 wraps awkwardly on an 80-col TTY).
 *
 * What this leaf decides (pure arithmetic only — terminal columns are INJECTED by
 * the ink call-site; this leaf never reads stdout):
 *   - gate off (KHY_DIFF_CONTENT_WIDTH = 0/false/off/no) → return LEGACY_CLIP (100),
 *     byte-identical to the historical fixed cut.
 *   - gate on + expanded → return Infinity → caller passes full text to ink, which
 *     wraps it to the terminal width (CC's wrapText('wrap') behaviour, no loss).
 *   - gate on + collapsed → return a width-aware single-row budget derived from the
 *     live columns minus the gutter + sigil prefix + left margins, floored at a sane
 *     minimum so a narrow terminal still shows something.
 *
 * Returning a NUMBER (with Infinity for the no-clip case) lets the call-site keep
 * its existing `clip(text, width)` helper untouched: clip(s, Infinity) === s.
 */

// Historical fixed cut. Returned verbatim when the gate is off → byte-identical.
const LEGACY_CLIP = 100;
// Fallback when the terminal width is unknown (non-TTY / test env).
const DEFAULT_COLUMNS = 80;
// Chars consumed after the right-aligned gutter number by the sigil + its spaces:
// add/del render `${num} + ` / `${num} - ` and ctx renders `${num}   ` → 3 cols.
const PREFIX_EXTRA = 3;
// Left margins ahead of the diff Box: the tool block Box (marginLeft 1) plus the
// diff column Box (marginLeft 2) = 3 columns reserved before content begins.
const MARGIN = 3;
// Never clip a collapsed line below this — keeps something readable on tiny TTYs.
const MIN_CONTENT = 20;

function diffContentWidthEnabled(env = process.env) {
  const flag = String((env && env.KHY_DIFF_CONTENT_WIDTH) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

function _posInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Width to pass to the call-site's `clip(text, width)` for diff CONTENT cells.
 *   gate off            → LEGACY_CLIP (100)                  [byte-identical]
 *   gate on + expanded  → Infinity (no clip → ink wraps full content, CC no-loss)
 *   gate on + collapsed → max(MIN_CONTENT, columns - gutter - PREFIX_EXTRA - MARGIN)
 *
 * @param {{columns?:number, gutterWidth?:number, expanded?:boolean, env?:object}} opts
 * @returns {number}
 */
function diffClipWidth({ columns, gutterWidth, expanded = false, env = process.env } = {}) {
  if (!diffContentWidthEnabled(env)) return LEGACY_CLIP;
  if (expanded) return Infinity;
  const cols = _posInt(columns, DEFAULT_COLUMNS);
  const gw = _posInt(gutterWidth, 1);
  return Math.max(MIN_CONTENT, cols - gw - PREFIX_EXTRA - MARGIN);
}

module.exports = {
  diffContentWidthEnabled,
  diffClipWidth,
  LEGACY_CLIP,
};
