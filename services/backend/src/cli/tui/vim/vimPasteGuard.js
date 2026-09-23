'use strict';

/**
 * Vim paste blow-up guard (p / P) — pure leaf, behavior-faithful split from
 * operators.js. Public surface of operators.js re-binds these via require, so
 * its exports stay byte-identical.
 *
 * The vim count prefix is capped at MAX_VIM_COUNT (10000, types.js), but the
 * paste register is raw pasted human text — unbounded. `content.repeat(count)`
 * (charwise) or the `count × contentLines` push loop (linewise) multiplies the
 * two: a single ~54 KB paste yanked then `10000p` builds a 540 M-char string →
 * `RangeError: Invalid string length`, and the dispatch in useVimInput
 * (result.execute()) has no try/catch, so that RangeError tears down the Ink
 * render loop = TUI crash. The linewise branch instead freezes the event loop
 * (10000 × 5000 lines = 5·10⁷ pushes, multi-second) then OOMs on join.
 *
 * MAX_PASTE_OUTPUT bounds the *product* (total chars charwise / total lines
 * linewise). It sits far above any realistic interactive paste-repeat yet well
 * below V8's ~536 M string limit and the multi-second freeze zone, so normal
 * pastes are byte-identical. Gated by KHY_VIM_PASTE_CAP (default on); off →
 * legacy unbounded multiply.
 */
const _PASTE_CAP_OFF = ['0', 'false', 'off', 'no'];
const MAX_PASTE_OUTPUT = 10_000_000;
function _pasteCapEnabled() {
  return !_PASTE_CAP_OFF.includes(
    String((process.env && process.env.KHY_VIM_PASTE_CAP) || '')
      .trim()
      .toLowerCase()
  );
}

// Largest repeat count that keeps `unit * count` within MAX_PASTE_OUTPUT
// (always ≥ 1 so a single paste is never suppressed). `unit` is the per-repeat
// cost: content.length charwise, contentLines.length linewise.
function _clampPasteCount(count, unit) {
  if (!_pasteCapEnabled()) {
    return count;
  }
  if (!Number.isFinite(count) || count <= 1 || !unit) {
    return count;
  }
  if (unit * count <= MAX_PASTE_OUTPUT) {
    return count;
  }
  return Math.max(1, Math.floor(MAX_PASTE_OUTPUT / unit));
}

module.exports = {
  _pasteCapEnabled,
  _clampPasteCount,
  MAX_PASTE_OUTPUT,
};
