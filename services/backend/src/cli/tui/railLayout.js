'use strict';

/**
 * railLayout — pure leaf for the RIGHT RAIL (右栏) task board: decides whether
 * the rail is active, how wide the reserved gutter is, where it sits on screen,
 * and what exact bytes paint it. Zero IO, zero side effects, deterministic,
 * never throws.
 *
 * Why a rail at all: the in-tree board (SidebarPanel inside App's flex row) can
 * only ever start where ink's LIVE region starts — i.e. immediately below the
 * committed <Static> scrollback — so it is structurally pinned to the bottom of
 * the viewport and the whole right side above it is wasted. The rail keeps the
 * <Static> + native-scrollback output model untouched and instead:
 *   1. narrows everything ink renders to contentCols() = cols - railWidth, so
 *      ink NEVER writes into the rightmost columns, and
 *   2. paints the board into that reserved gutter out of band, at absolute
 *      cursor coordinates, from screen row 1 downwards.
 *
 * Gate decision is COLS-ONLY on purpose. The in-tree board additionally
 * required the session-max "fullscreen" verdict (sidebarLayout.isFullscreen)
 * because it stole vertical space from the live region and had to stay inside
 * the anti-scroll-jump budget. The rail costs zero live-region rows, so that
 * condition is dropped — and dropping it matters: the narrowing decision is
 * read by deep components (Transcript, PromptFrame, ToolLines) that have no
 * access to App's session-max refs. A cols-only predicate is computable
 * identically in every caller with NO shared state, which is what guarantees
 * the painter and the narrowing can never disagree. A disagreement would mean
 * either ink writing into the painted gutter or a blank reserved strip.
 *
 * Gates:
 *  - KHY_SIDEBAR_RAIL   the rail itself, DEFAULT ON. Only an explicit
 *                       off-writing (0/false/off/no, case-insensitive, trimmed)
 *                       disables it. Off → contentCols() returns the full width
 *                       and railGeometry().on is false → the legacy in-tree board
 *                       renders exactly as before, byte for byte. That is the
 *                       escape hatch if a terminal mishandles the out-of-band
 *                       paint.
 *  - KHY_SIDEBAR        respected as the master switch (same off-writings), so
 *                       turning the sidebar off turns the rail off too.
 *  - KHY_SIDEBAR_MIN_COLS / KHY_SIDEBAR_WIDTH* / KHY_SIDEBAR_BG
 *                       reused as-is from sidebarLayout (width + activation
 *                       threshold + background), so the rail and the legacy
 *                       board share one width/color口径.
 *
 * NOT applicable to the rail (they bound the live region's height, which the
 * rail no longer contributes to): KHY_SIDEBAR_MAX_RATIO, KHY_SIDEBAR_MIN_CHROME,
 * KHY_SIDEBAR_STACK_MAX_RATIO.
 */

const sidebarLayout = require('./sidebarLayout');

/** Off-writings shared with sidebarLayout / FooterBar. */
function _off(env, name) {
  const v = String((env && env[name]) || '')
    .trim()
    .toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * Env-only half of the gate: the rail is ON unless KHY_SIDEBAR_RAIL is an
 * explicit off-writing, and KHY_SIDEBAR (master switch) also disables it. Split
 * out so callers can cheaply short-circuit before touching geometry, and so
 * tests can pin the two switches independently.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function railGateOn(env = process.env) {
  if (_off(env, 'KHY_SIDEBAR_RAIL')) {
    return false;
  }
  if (_off(env, 'KHY_SIDEBAR')) {
    return false;
  }
  return true;
}

/**
 * Is the rail active for this terminal width? Gate + wide-terminal threshold
 * (KHY_SIDEBAR_MIN_COLS, default 120) + "there is actually room left for
 * content". The last condition is what keeps a narrow-terminal env override
 * (e.g. KHY_SIDEBAR_WIDTH=40 on a 40-column terminal) from reserving the whole
 * screen and leaving ink zero columns.
 * Unknown size (cols null/undefined — Windows PowerShell/conpty can report
 * nothing): the gate is evaluated against the assumed single-source fallback
 * size with the RELAXED threshold (sidebarLayout.minColsFallback), so the
 * board is not permanently hidden. Garbage cols (NaN/0/negative) stay false.
 *
 * `lastActive` (optional): when a boolean is passed, the wide-terminal axis
 * uses sidebarLayout.railActiveHysteresis(cols, lastActive, env) instead of the
 * plain isWideTerminal gate, so a caller that threads the previous verdict gets
 * a dead-band around the min-cols boundary (119↔120 anti-flip). When omitted
 * (undefined) the verdict is byte-identical to the pre-hysteresis behavior —
 * every internal caller (contentCols/railGeometry) deliberately omits it, so
 * hysteresis is driven ONLY where the previous state is tracked (effectiveCols).
 * @param {number|null|undefined} cols - current terminal columns (null/undefined = unknown)
 * @param {NodeJS.ProcessEnv} [env]
 * @param {boolean} [lastActive] - previous activation verdict; enables hysteresis
 * @returns {boolean}
 */
function railActive(cols, env = process.env, lastActive) {
  if (!railGateOn(env)) {
    return false;
  }
  const wide =
    typeof lastActive === 'boolean'
      ? sidebarLayout.railActiveHysteresis(cols, lastActive, env)
      : sidebarLayout.isWideTerminal(cols, env);
  if (!wide) {
    return false;
  }
  const c = cols == null ? sidebarLayout.fallbackCols(env) : cols;
  return sidebarLayout.mainColumnCols(c, env) > 0;
}

/**
 * SINGLE SOURCE OF TRUTH for the effective column count of everything ink
 * renders. Every render path that used to read process.stdout.columns directly
 * must go through here, because overstating the width is the one unsafe
 * direction: it under-counts soft-wrapped visual rows, the live region
 * overflows the viewport and ink's erase mis-count smears text (the staircase /
 * fullscreen-repaint failure documented at sidebarLayout.js:332-344).
 *
 * Rail off → the real width, unchanged. Unknown cols (null/undefined) with the
 * rail active in fallback state → the NARROWED assumed width, so ink and the
 * out-of-band painter can never disagree about the reserved gutter; unknown
 * cols with the rail off → 0 so callers keep their own legacy fallback.
 * Garbage cols (NaN/0/negative) → 0 as before.
 * @param {number|null|undefined} cols - current terminal columns (null/undefined = unknown)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} 0 = unusable input; otherwise the width ink may render into
 */
function contentCols(cols, env = process.env) {
  const unknown = cols == null;
  const c = unknown ? sidebarLayout.fallbackCols(env) : Number(cols);
  if (!Number.isFinite(c) || c <= 0) {
    return 0;
  }
  const full = Math.floor(c);
  // Pass the ORIGINAL unknown-ness through so the gate applies the relaxed
  // fallback threshold exactly like the painter's railGeometry does.
  if (!railActive(unknown ? null : full, env)) {
    return unknown ? 0 : full;
  }
  const main = sidebarLayout.mainColumnCols(full, env);
  return main > 0 ? main : unknown ? 0 : full;
}

/**
 * Default footer rows painted BELOW the prompt's bottom border. The permission
 * line and the budget/status line are ALWAYS present in FooterBar (2 rows).
 * Single source of truth, overridable via KHY_SIDEBAR_RAIL_BOTTOM_CHROME.
 */
const DEFAULT_BOTTOM_CHROME = 2;

/**
 * Default number of rows to shift the whole bottom-anchored board UPWARD, so it
 * sits farther from the terminal's bottom edge (the "暂无任务" placeholder used to
 * hug the very bottom-right corner). This is an INDEPENDENT dimension from
 * bottomChrome: chrome models footer rows that already exist below the prompt
 * border, whereas this offset is a deliberate visual lift on top of that anchor.
 * Single source of truth, overridable via KHY_SIDEBAR_RAIL_TOP_OFFSET; set it to
 * 0 to restore the exact original bottom-anchored behavior.
 */
const DEFAULT_RAIL_TOP_OFFSET = 6;

/**
 * Rows to lift the bottom-anchored board upward. Base = DEFAULT_RAIL_TOP_OFFSET,
 * overridable via KHY_SIDEBAR_RAIL_TOP_OFFSET. Parsing口径 mirrors
 * railBottomChrome exactly: a non-negative integer wins, anything else
 * (empty/negative/non-numeric) falls back to the default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} rows to shift up (>= 0)
 */
function railTopOffset(env = process.env) {
  let offset = DEFAULT_RAIL_TOP_OFFSET;
  const raw = env && env.KHY_SIDEBAR_RAIL_TOP_OFFSET;
  const n = Number(raw);
  if (raw != null && String(raw).trim() !== '' && Number.isFinite(n) && n >= 0) {
    offset = Math.floor(n);
  }
  return offset;
}

/**
 * How many terminal rows sit BELOW the input box's bottom border, i.e. the
 * FooterBar block the out-of-band board must clear so its last row lands exactly
 * on that border. Base = the two always-on footer lines (permission + budget);
 * the collaboration line (bridge running) and the topic-fallback line (pinned
 * topic bar unavailable) add one row each. The caller reports those two with the
 * SAME booleans App feeds resolveStreamReserve, so this count and the live-region
 * budget can never drift. Base is a single source of truth, env-overridable.
 * @param {{collabActive?: boolean, topicInFooter?: boolean}} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} footer rows below the prompt border (>= 0)
 */
function railBottomChrome(opts = {}, env = process.env) {
  let base = DEFAULT_BOTTOM_CHROME;
  const raw = env && env.KHY_SIDEBAR_RAIL_BOTTOM_CHROME;
  const n = Number(raw);
  if (raw != null && String(raw).trim() !== '' && Number.isFinite(n) && n >= 0) {
    base = Math.floor(n);
  }
  let rows = base;
  if (opts && opts.collabActive) {
    rows += 1;
  }
  if (opts && opts.topicInFooter) {
    rows += 1;
  }
  return rows;
}

/**
 * Screen geometry of the reserved gutter, in 1-based terminal coordinates.
 *
 * VERTICAL ANCHOR — BOTTOM anchor is the user's latest requirement (task #7):
 * the board's LAST row must sit on the input box's bottom border and the block
 * grows UPWARD from there, hugging exactly its content. This SUPERSEDES the
 * earlier TOP-anchor rule ("post-first-message board pinned to the live region's
 * top edge via alignSelf/justifyContent flex-start", recorded in project memory):
 * the board no longer starts at screen row 1 — its bottom edge is the fixed
 * point and its top floats up with the content.
 *   - `opts.bottomChrome` = footer rows below the prompt border (see
 *     railBottomChrome). The bottom edge = rows - bottomChrome (clamped to the
 *     pending-wrap-safe range [1, rows-1]).
 *   - `opts.contentRows` = measured board line count. Given → HUG: height =
 *     min(contentRows, availableRows), top = bottom - height + 1. Omitted → the
 *     full paintable slot (top=1) so the caller can size line-building first.
 *
 * No `opts.bottomChrome` → LEGACY top anchor, byte-for-byte unchanged:
 * height = rows - 1 deliberately skips the BOTTOM screen row because writing
 * into the last cell of the last row sets the terminal's pending-wrap flag,
 * which conhost has historically mishandled (a stray scroll desyncs ink's line
 * accounting for the whole frame). Every existing caller/test keeps this path.
 *
 * Unknown size (cols/rows null/undefined): geometry is computed from the
 * assumed single-source fallback size (sidebarLayout.fallbackCols/Rows) with
 * the relaxed gate, matching contentCols' narrowing decision byte for byte.
 * @param {number|null|undefined} cols
 * @param {number|null|undefined} rows
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{bottomChrome?: number|null, contentRows?: number|null}} [opts]
 * @returns {{on: boolean, width: number, left: number, top: number, height: number}}
 */
function railGeometry(cols, rows, env = process.env, opts = {}) {
  const off = { on: false, width: 0, left: 0, top: 1, height: 0 };
  const colsUnknown = cols == null;
  const c = colsUnknown ? sidebarLayout.fallbackCols(env) : Number(cols);
  const r = rows == null ? sidebarLayout.fallbackRows(env) : Number(rows);
  if (!Number.isFinite(c) || !Number.isFinite(r)) {
    return off;
  }
  const C = Math.floor(c);
  const R = Math.floor(r);
  if (C <= 0 || R < 2) {
    return off;
  } // R < 2 → height would be 0 → nothing to paint
  if (!railActive(colsUnknown ? null : C, env)) {
    return off;
  }
  const width = sidebarLayout.sidebarWidth(C, env);
  if (width <= 0 || width >= C) {
    return off;
  }
  const left = C - width + 1;

  const bc = opts && opts.bottomChrome;
  if (bc == null || !Number.isFinite(Number(bc))) {
    // Legacy top anchor: fill from row 1 to rows-1 (skip pending-wrap row).
    return { on: true, width, left, top: 1, height: R - 1 };
  }
  const chrome = Math.max(0, Math.floor(Number(bc)));
  let topOffset = railTopOffset(env);
  // Bottom edge = the input box's bottom border row, lifted by topOffset, then
  // clamped to the pending-wrap-safe range so we never write the last cell of
  // the last row and never push the board off-screen (bottom stays >= 1). The
  // relative layout above is preserved — this only translates the whole block up.
  let bottom = Math.max(1, Math.min(R - 1, R - chrome - topOffset));
  let avail = bottom; // rows 1..bottom are paintable (bottom rows total)
  // Small-terminal guard (task #2): when the offset FITS within the post-chrome
  // space (bottom did not underflow) yet fewer than 3 rows remain paintable,
  // decay the offset LOCALLY so at least 3 rows survive — a tall-but-narrow
  // window must not lose the whole board to the default lift. A pathologically
  // large offset that already underflowed to the row-1 clamp (topOffset >
  // R - chrome) is left untouched: reducing it would contradict the explicit
  // over-offset safety. The DEFAULT_RAIL_TOP_OFFSET constant/getter is NOT
  // mutated — only this frame's local lift. Normal terminals (avail >= 3) are
  // byte-for-byte unchanged.
  if (avail < 3 && topOffset <= R - chrome) {
    topOffset = Math.max(0, R - chrome - 3);
    bottom = Math.max(1, Math.min(R - 1, R - chrome - topOffset));
    avail = bottom;
  }
  const cr = opts.contentRows;
  if (cr == null || !Number.isFinite(Number(cr))) {
    // Fill mode: content not measured yet — hand back the full paintable slot so
    // the caller can build lines against `height`, then re-derive with contentRows.
    return { on: true, width, left, top: 1, height: avail };
  }
  const height = Math.max(0, Math.min(Math.floor(Number(cr)), avail));
  if (height <= 0) {
    return off;
  } // empty board → reserve nothing
  return { on: true, width, left, top: bottom - height + 1, height };
}

/**
 * ASCII-only fallback for the width fitter. The runtime layer injects the REAL
 * one (SidebarPanel.truncateToWidth + padLineToWidth over
 * formatters.displayWidth) so the rail and the in-tree board pad/truncate
 * identically; this exists so the leaf stays unit-testable on its own and so a
 * missing injection degrades to something safe rather than throwing.
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function _naiveFit(text, width) {
  const s = String(text == null ? '' : text);
  if (s.length >= width) {
    return s.slice(0, width);
  }
  return s + ' '.repeat(width - s.length);
}

// ── ANSI ────────────────────────────────────────────────────────────────────
const DECSC = '\x1b7'; // save cursor. Preferred over CSI s: supported by
const DECRC = '\x1b8'; // restore cursor. conhost, Windows Terminal, xterm.
const SGR_RESET = '\x1b[0m';

/**
 * Resolve a color string into an SGR background sequence. Only the shapes
 * sidebarLayout.sidebarBg can return are handled (#hex6/#hex3, rgb(), ansi256(),
 * chalk color name); a name we cannot map to a raw SGR code yields '' (no
 * background) rather than garbage on the wire — the rail then paints plain text.
 * @param {string|null} bg
 * @returns {string} '' when there is no usable background
 */
function bgSequence(bg) {
  const raw = String(bg == null ? '' : bg).trim();
  if (raw === '') {
    return '';
  }
  let m = /^#([0-9a-f]{6})$/i.exec(raw);
  if (m) {
    const n = parseInt(m[1], 16);
    return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
  }
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw);
  if (m) {
    const d = (x) => parseInt(x + x, 16);
    return `\x1b[48;2;${d(m[1])};${d(m[2])};${d(m[3])}m`;
  }
  m = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/.exec(raw);
  if (m) {
    const cl = (x) => Math.max(0, Math.min(255, Number(x)));
    return `\x1b[48;2;${cl(m[1])};${cl(m[2])};${cl(m[3])}m`;
  }
  m = /^ansi256\(\s?(\d+)\s?\)$/.exec(raw);
  if (m) {
    const n = Number(m[1]);
    return n >= 0 && n <= 255 ? `\x1b[48;5;${n}m` : '';
  }
  const NAMES = {
    black: 40,
    red: 41,
    green: 42,
    yellow: 43,
    blue: 44,
    magenta: 45,
    cyan: 46,
    white: 47,
    gray: 100,
    grey: 100,
  };
  const code = NAMES[raw.toLowerCase()];
  return code ? `\x1b[${code}m` : '';
}

/**
 * Build the bytes that paint `lines` into the gutter.
 *
 * Shape: DECSC, then one absolute-positioned run per row, then DECRC. There is
 * deliberately NO newline / carriage return anywhere in the output — a single
 * '\n' at the bottom row would scroll the screen and desync ink's frame-erase
 * line counting, which is exactly how the abandoned DECSTBM approach broke
 * (runtime/topicBar.js:7-16). Restoring the cursor at the end means ink's own
 * accounting sees no cursor movement at all, so these bytes can be appended to
 * ANY ink frame write.
 *
 * Rows beyond `lines` are painted as blank (background-filled) so the block
 * stays visually continuous and stale content from a previous, longer paint can
 * never survive underneath.
 * @param {{lines: Array<{text: string}|string>, geom: object, bg?: string|null,
 *          fit?: (text: string, width: number, line?: object) => string,
 *          border?: string, borderCols?: number}} opts
 *   `border` (optional): a pre-styled left-border string the CALLER computed
 *   (sidebarRail owns chalk/env — railLayout stays pure and reads no env). It
 *   must self-terminate its own SGR (chalk closes dim with 22 / color with 39,
 *   neither of which clears the background) so it cannot bleed into the bg or
 *   the content. `borderCols` is the VISIBLE width it occupies (1 for a single
 *   glyph); the fitter is asked for `geom.width - borderCols` so border + text
 *   still total exactly geom.width. Omitted / borderCols 0 → byte-identical to
 *   the pre-border output.
 * @returns {string} '' when there is nothing to paint
 */
function buildRailPaint(opts = {}) {
  const geom = opts.geom;
  if (!geom || !geom.on || geom.height <= 0 || geom.width <= 0) {
    return '';
  }
  const fit = typeof opts.fit === 'function' ? opts.fit : _naiveFit;
  const lines = Array.isArray(opts.lines) ? opts.lines : [];
  const bgSeq = bgSequence(opts.bg);
  const border = typeof opts.border === 'string' ? opts.border : '';
  let borderCols = Number(opts.borderCols) > 0 ? Math.floor(Number(opts.borderCols)) : 0;
  // Pathological narrow rail: the border must never claim more columns than the
  // whole rail owns, or border + a forced >=1 content column would overrun
  // geom.width (e.g. geom.width === 1 with a single-glyph border). borderCols
  // 0 / omitted is untouched, so non-border output stays byte-identical.
  if (borderCols > geom.width) {
    borderCols = geom.width;
  }
  const contentWidth = Math.max(0, geom.width - borderCols);
  let out = DECSC;
  for (let i = 0; i < geom.height; i++) {
    const row = geom.top + i;
    const raw = lines[i];
    const line = raw && typeof raw === 'object' ? raw : null;
    const text = line ? line.text : raw;
    out += `\x1b[${row};${geom.left}H`;
    if (bgSeq) {
      out += bgSeq;
    }
    // Border sits AFTER bgSeq so its cell shares the sidebar background; its own
    // SGR (dim/color) self-closes without touching the bg, so content styling
    // starts clean and the final reset still owns row teardown.
    if (border) {
      out += border;
    }
    out += fit(text == null ? '' : String(text), contentWidth, line);
    if (bgSeq) {
      out += SGR_RESET;
    }
  }
  return out + DECRC;
}

/**
 * Build the bytes that blank the gutter (exit, suspend for an interactive
 * sub-command, and the shrink half of a resize where the OLD geometry must be
 * wiped before the new one is painted). No background color — the goal is to
 * hand those cells back to the terminal's default, not to leave a gray band.
 * @param {object} geom - a railGeometry() result (its own or a stale one)
 * @returns {string} '' when there is nothing to clear
 */
function buildRailClear(geom) {
  if (!geom || !geom.on || geom.height <= 0 || geom.width <= 0) {
    return '';
  }
  const blank = ' '.repeat(geom.width);
  let out = DECSC;
  for (let i = 0; i < geom.height; i++) {
    out += `\x1b[${geom.top + i};${geom.left}H` + blank;
  }
  return out + DECRC;
}

module.exports = {
  railGateOn,
  railActive,
  contentCols,
  railBottomChrome,
  railTopOffset,
  railGeometry,
  bgSequence,
  buildRailPaint,
  buildRailClear,
  DECSC,
  DECRC,
};
