'use strict';

/**
 * historyBrowseDecision — pure decision leaf for ↑/↓ history browsing while the
 * prompt buffer already holds text (a draft or a previously recalled entry).
 *
 * Background (the bug this fixes): the TUI's arrow-routing block forwards ↑/↓ to
 * the text input's history navigation only when the buffer is empty. Once the
 * first ↑ recalls the latest entry the buffer is no longer empty, so a
 * single-line buffer fell into the "EDITING" branch which SWALLOWED vertical
 * arrows — you could only ever go back ONE entry and had to clear the line
 * before ↑ would recall the entry before it. Claude Code / bash / zsh / readline
 * all keep browsing instead: ↑ walks back through every entry while the live
 * draft is stashed and restored when ↓ walks past the newest entry (the draft
 * stash already lives in useTextInput, so forwarding here loses nothing).
 *
 * A multiline buffer must still forward so the cursor can move interiorly
 * line-by-line (useTextInput only browses history once the cursor is on the
 * boundary line); that path was never broken and is unconditional here.
 *
 * Gate KHY_HISTORY_BROWSE_EDITING ∈ {0,false,off,no} (case-insensitive) restores
 * the legacy "swallow single-line vertical arrows while text is present"
 * behaviour, byte-identical. Default on.
 *
 * Pure leaf: no IO, no requires, deterministic, never throws.
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * @param {object} [env=process.env]
 * @returns {boolean} true unless KHY_HISTORY_BROWSE_EDITING is a falsy token.
 */
function historyBrowseWhileEditingEnabled(env = process.env) {
  const flag = String((env && env.KHY_HISTORY_BROWSE_EDITING) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

/**
 * Decide whether a vertical arrow (↑/↓) pressed while the buffer is non-empty
 * should be FORWARDED to the text input (→ cursor move and/or history browse) or
 * SWALLOWED (legacy single-line behaviour).
 *
 * Caller guarantees the buffer is non-empty (the "EDITING" branch). A multiline
 * buffer always forwards; a single-line buffer forwards only when the gate is on.
 *
 * @param {object} args
 * @param {boolean} args.hasNewline whether the current buffer contains '\n'
 * @param {object} [args.env=process.env]
 * @returns {boolean} true = forward to text input; false = swallow.
 */
function shouldBrowseHistoryWhileEditing({ hasNewline, env = process.env } = {}) {
  if (hasNewline) return true; // multiline: forward for interior cursor moves
  return historyBrowseWhileEditingEnabled(env);
}

module.exports = { historyBrowseWhileEditingEnabled, shouldBrowseHistoryWhileEditing };
