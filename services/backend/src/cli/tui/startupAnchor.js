'use strict';

/**
 * startupAnchor — pure leaf that anchors the TUI's FIRST frame to the BOTTOM
 * of the screen. Zero IO, deterministic, never throws.
 *
 * Why: ink renders the live region at the current cursor position and flows
 * top-down, so on a fresh session in a tall terminal the prompt + footer sit
 * near the TOP with a large blank area below (the「下面留下了大量的空白」
 * report). Writing rows-1 newlines BEFORE ink's first render scrolls the
 * existing shell output up into native scrollback and lands the cursor on the
 * last row, so the input box + footer hug the terminal's bottom edge from
 * frame 1 — matching the steady-state layout once scrollback fills.
 *
 * This also CLOSES the bottom-anchor contract gap of the right-rail board:
 * railGeometry's bottom anchor assumes the footer sits flush with the screen
 * bottom (bottom = rows - bottomChrome - topOffset). At startup that only held
 * by coincidence; with the pad the assumption is true from the first frame, so
 * the board can never float detached below the footer on tall terminals.
 *
 * THE SCROLLBACK TRADE-OFF (goal 2026-08-07): a naive '\n'.repeat(rows-1) pad
 * leaves rows-1 blank lines in NATIVE SCROLLBACK between the pre-TUI output
 * (e.g. the "已登录" line) and the welcome banner — the「登录成功和版本号之间大量
 * 空白」report when scrolling back. The fix moves the cursor to the last row
 * with a Cursor Position (CUP) escape (\x1b[<row>;1H) instead of emitting
 * newlines. CUP does NOT enter scrollback, so the gap disappears while the
 * first-frame bottom-anchor effect is preserved: ink then writes its output
 * from the last row and the terminal scrolls the content into place exactly as
 * before.
 *
 * Gate: KHY_TUI_ANCHOR_BOTTOM, DEFAULT ON — only an explicit off-writing
 * (0/false/off/no, case-insensitive, trimmed; same口径 as railLayout/_off)
 * disables it. Non-TTY streams (pipes/CI redirects) always get '' so the pad
 * can never pollute captured output. Rows resolve through the SAME single
 * sources the rest of the TUI uses: sidebarLayout.stickyDim (trichotomy) and
 * sidebarLayout.fallbackRows for unknown/garbage — never a local literal.
 * The row count is clamped to >= 2 so a degenerate 1-row terminal stays safe.
 */

const sidebarLayout = require('./sidebarLayout');

/** Off-writings shared with sidebarLayout / railLayout / FooterBar. */
function _off(env, name) {
  const v = String((env && env[name]) || '')
    .trim()
    .toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * Env-only half of the gate: ON unless KHY_TUI_ANCHOR_BOTTOM is an explicit
 * off-writing. Split out so callers/tests can pin the switch independently.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function anchorBottomEnabled(env = process.env) {
  return !_off(env, 'KHY_TUI_ANCHOR_BOTTOM');
}

/**
 * The ANSI anchor bytes to write to the REAL stdout right before ink's first
 * render. '' whenever the anchor must stay out of the way (gate off / non-TTY).
 *
 * Uses a Cursor Position escape (\x1b[<rows>;1H) to move to the last row —
 * NOT a '\n'.repeat(rows-1) pad — so the anchor never leaves blank lines in
 * native scrollback between the pre-TUI output and the banner.
 *
 * @param {{isTTY?: boolean, rows?: number}|null|undefined} stream - the real
 *        stdout (tests pass a plain object; only isTTY and rows are read)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function anchorBottomPad(stream, env = process.env) {
  if (!anchorBottomEnabled(env)) {
    return '';
  }
  if (!stream || !stream.isTTY) {
    return '';
  } // pipes/CI: never pollute redirected output
  // Single-source rows resolution: stickyDim trichotomy (no prior value at
  // startup → prev null), unknown (null) / garbage (0) → fallbackRows.
  let rows = null;
  try {
    rows = sidebarLayout.stickyDim(stream.rows, null, env);
  } catch {
    rows = null;
  }
  if (typeof rows !== 'number' || !Number.isFinite(rows) || rows <= 0) {
    rows = sidebarLayout.fallbackRows(env);
  }
  const target = Math.max(2, Math.floor(rows)); // never < 2 rows down
  // CUP to the last row: moves the cursor without adding newlines to scrollback.
  return `\x1b[${target};1H`;
}

module.exports = { anchorBottomEnabled, anchorBottomPad };
