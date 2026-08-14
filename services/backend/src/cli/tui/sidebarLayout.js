'use strict';

/**
 * sidebarLayout — pure leaf: decides whether the wide-terminal sidebar renders
 * and how wide it is. Zero IO, zero side effects, deterministic, never throws.
 *
 * Gates (all env-driven, no hardcoded endpoints/paths):
 *  - KHY_SIDEBAR              default on; 0/false/off/no (case-insensitive,
 *                             trimmed) → off
 *  - KHY_SIDEBAR_MIN_COLS     minimum terminal columns to activate (default 120;
 *                             invalid value falls back to 120)
 *  - KHY_SIDEBAR_MIN_ROWS     minimum terminal rows for the fullscreen gate
 *                             (default 24; invalid → 24). Floor so a tiny window
 *                             that equals its own session max never qualifies.
 *  - KHY_SIDEBAR_WIDTH_RATIO  relative width: round(cols * ratio) (default 0.16;
 *                             invalid → 0.16), clamped into [WIDTH_MIN, WIDTH_MAX]
 *  - KHY_SIDEBAR_WIDTH_MIN    width clamp lower bound (default 24; invalid → 24)
 *  - KHY_SIDEBAR_WIDTH_MAX    width clamp upper bound (default 36; invalid → 36)
 *  - KHY_SIDEBAR_WIDTH        legacy explicit ABSOLUTE width in columns; when
 *                             set and valid it wins over the ratio (clamped)
 *  - KHY_SIDEBAR_BG           sidebar background color (opencode-style flat
 *                             block). 0/false/off/no → disabled (null); valid
 *                             color (hex / chalk name / rgb() / ansi256()) →
 *                             used as-is; unset or invalid → default DEFAULT_BG
 *  - KHY_SIDEBAR_MAX_RATIO    relative STABLE HEIGHT for the sidebar:
 *                             stable = min(round(rows * ratio), rows - MIN_CHROME)
 *                             (default 0.85; invalid → 0.85; 0/false/off/no →
 *                             disabled → hug content). The value is BOTH a
 *                             floor and a ceiling: short content is padded up
 *                             to it (the sidebar never collapses when the left
 *                             column streams a lot of output) and long content
 *                             is truncated down to it (capSidebarLines marker)
 *  - KHY_SIDEBAR_MIN_CHROME   rows reserved below the sidebar row for the
 *                             full-width chrome (prompt + footer + hint +
 *                             budget margin; default 10; invalid → 10) — keeps
 *                             live-region total height strictly below rows
 *  - KHY_SIDEBAR_FULLSCREEN_TOL  tolerance (cols/rows) when comparing the
 *                             current size against the session max (default 2)
 *  - KHY_SIDEBAR_ZOOM_TOL     max |cols-ratio − rows-ratio| for a resize to be
 *                             classified as a font zoom (default 0.15) — see
 *                             classifyResize
 *  - KHY_TERM_FALLBACK_COLS / KHY_TERM_FALLBACK_ROWS  the ASSUMED terminal
 *                             size when the terminal reports none (Windows
 *                             PowerShell/conpty may leave columns/rows
 *                             undefined; defaults 80/24). Single source for
 *                             every fallback reader — scattered `|| 80`
 *                             literals are what let frames disagree and
 *                             flicker the board.
 *  - KHY_TERM_STICKY_DIMS    sticky dimension resolution (default on;
 *                             0/false/off/no → off): when a frame reads
 *                             null/undefined but the PREVIOUS frame had a
 *                             valid value, the previous value is reused
 *                             instead of dropping to the assumed fallback —
 *                             Windows conpty can oscillate 120 → undefined →
 *                             120 between frames, and each drop re-layouts
 *                             the whole tree (board jitter/ghosting). See
 *                             stickyDim.
 *  - KHY_SIDEBAR_MIN_COLS_FALLBACK  RELAXED activation threshold used ONLY
 *                             when the size is unknown (cols passed as
 *                             null/undefined; default 80): the standard
 *                             120-col gate would otherwise hide the board
 *                             forever on terminals that never report a size.
 *  - KHY_SIDEBAR_STACK_MAX_RATIO  OPTIONAL extra guard on the post-first-
 *                             message board's height CEILING (the board hugs
 *                             its content; the ceiling only caps growth):
 *                             when set and valid (0 < ratio ≤ 1) the ceiling
 *                             is further capped at round(rows * ratio);
 *                             unset or invalid → ceiling = rows - minChrome —
 *                             see sidebarFillRows
 *
 * 右栏(railLayout)对本表的影响 —— 看板默认已经不在 ink 树里了:
 *  - KHY_SIDEBAR_RAIL(默认开,见 railLayout.js)让看板改为「预留最右侧几列 + 绝对坐标
 *    带外画」,从屏幕顶行铺到底。此时看板不再占活动区的任何一行,于是本表里所有约束
 *    HEIGHT 的门控对它统统失效:KHY_SIDEBAR_MAX_RATIO、KHY_SIDEBAR_MIN_CHROME、
 *    KHY_SIDEBAR_STACK_MAX_RATIO 只对 KHY_SIDEBAR_RAIL=0 的树内看板仍然生效。
 *  - 仍然共用的是 WIDTH 与颜色一族:KHY_SIDEBAR(总开关)、KHY_SIDEBAR_MIN_COLS、
 *    KHY_SIDEBAR_WIDTH*、KHY_SIDEBAR_BG —— 一份宽度/配色口径,两种模式视觉一致。
 *  - 右栏也不看 isFullscreen(会话最大尺寸)判定:那是为「偷活动区高度」设的门槛,
 *    右栏不偷高度,判定只剩列宽阈值(railLayout 头部有完整理由)。
 */

const DEFAULT_WIDTH = 30; // legacy fallback when cols is unusable
// Narrower default board (user feedback, second pass): 0.20 → 0.16 of the
// terminal width, hard-capped at 36 columns instead of 48. Relative ratio
// stays the default and preferred path; KHY_SIDEBAR_WIDTH remains an explicit
// absolute override.
const DEFAULT_WIDTH_RATIO = 0.16;
const DEFAULT_WIDTH_MIN = 24;
const DEFAULT_WIDTH_MAX = 36;
const DEFAULT_MIN_COLS = 120;
const DEFAULT_MIN_ROWS = 24;
// Assumed terminal size when the terminal reports none (columns/rows
// undefined under Windows PowerShell/conpty). SINGLE SOURCE: every consumer
// must resolve through fallbackCols/fallbackRows instead of local literals.
const DEFAULT_FALLBACK_COLS = 80;
const DEFAULT_FALLBACK_ROWS = 24;
// Relaxed activation threshold applied ONLY when the size is unknown: the
// assumed 80 columns must be able to pass the gate, or the board is
// permanently hidden on terminals that never report a size.
const DEFAULT_MIN_COLS_FALLBACK = 80;
// Task #22: 0.72 → 0.85 — the taller board covers the blank band that used
// to sit between the conversation header and the panel's top edge (a taller
// live frame scrolls stale static rows out, pulling the top edge up). The
// rows - minChrome ceiling still hard-caps small terminals, so the
// stable + chrome ≤ rows invariant is untouched.
const DEFAULT_MAX_RATIO = 0.85;
const DEFAULT_MIN_CHROME = 10;
const DEFAULT_FULLSCREEN_TOL = 2;
// Font-zoom heuristic tolerance: a resize whose cols/rows both scale in the
// SAME direction with ratios within this delta is treated as a Ctrl+wheel
// font zoom, not a real window resize (KHY_SIDEBAR_ZOOM_TOL overrides).
const DEFAULT_ZOOM_TOL = 0.15;
// Default sidebar background: a neutral gray one step lighter than typical
// dark-theme terminal backgrounds (#000–#1e1e1e range), matching opencode's
// flat right-column look without washing out dim foreground text.
const DEFAULT_BG = '#2e2e2e';
// Shapes ink's colorize() actually understands: #hex(3|6), chalk color names
// (letters only), rgb(r,g,b), ansi256(n). Anything else → fall back to default
// rather than passing garbage through to chalk.
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const NAME_RE = /^[a-z]+$/i;
const RGB_RE = /^rgb\(\s?\d+,\s?\d+,\s?\d+\s?\)$/;
const ANSI256_RE = /^ansi256\(\s?(\d+)\s?\)$/;

// ── task-board polish knobs (stage 1) — every tunable is a named constant with
// an env override, mirroring the DEFAULT_* + _posNum/_off pattern above so no
// literal ever scatters into the runtime/panel code. ────────────────────────
// Activation hysteresis in columns (KHY_SIDEBAR_HYSTERESIS): dead-band around
// the min-cols gate so a terminal parked on the threshold cannot flap the
// board on/off frame to frame. 0 disables the dead-band; invalid → 2.
const DEFAULT_HYSTERESIS = 2;
// Vertical border glyph for the rail (KHY_SIDEBAR_BORDER_CHAR). Single visible
// character; empty/whitespace → default box-drawing bar.
const RAIL_BORDER_CHAR = '│';
// Dim ratio applied to faded notification rows (KHY_SIDEBAR_NOTIFY_FADE): a
// number in [0,1]; invalid → 0.7.
const DEFAULT_NOTIFY_FADE_RATIO = 0.7;
// Default key that toggles board focus when focus mode is on
// (KHY_SIDEBAR_FOCUS_KEY). Single lowercase letter; invalid → 'b'.
const DEFAULT_FOCUS_KEY = 'b';

/**
 * Parse a positive number from an env var; '' / invalid / ≤0 → NaN.
 * @param {NodeJS.ProcessEnv|undefined} env
 * @param {string} name
 * @returns {number} NaN when unusable
 */
function _posNum(env, name) {
  const raw = String((env && env[name]) || '').trim();
  if (raw === '') {
    return NaN;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

/**
 * True when the env var is explicitly OFF (0/false/off/no, case-insensitive,
 * trimmed) — the DEFAULT-ON switch shape shouldShowSidebar/stickyDim already
 * inline; centralized here so opt-out switches share one truth table.
 * @param {NodeJS.ProcessEnv|undefined} env
 * @param {string} name
 * @returns {boolean}
 */
function _off(env, name) {
  const v = String((env && env[name]) || '')
    .trim()
    .toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * True ONLY when the env var is explicitly ON (1/true/on/yes, case-insensitive,
 * trimmed) — the symmetric DEFAULT-OFF counterpart to _off, for opt-in switches
 * whose absence means disabled. Never throws.
 * @param {NodeJS.ProcessEnv|undefined} env
 * @param {string} name
 * @returns {boolean}
 */
function _on(env, name) {
  const v = String((env && env[name]) || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Sticky resolution of ONE raw terminal dimension (pure — the caller owns the
 * cache and passes the previous resolved value back in):
 *  - raw is a valid positive number → floor(raw) (and the caller should cache it)
 *  - raw is null/undefined (size unknown) → floor(prev) when prev is a valid
 *    positive number and the sticky gate is on; otherwise null ("unknown" —
 *    callers apply their single-source fallback + relaxed gate)
 *  - anything else (NaN/0/negative — measured garbage) → 0 (strictly rejected,
 *    never made sticky: garbage is a MEASUREMENT, unknown is the absence of one)
 * Gate KHY_TERM_STICKY_DIMS (default on; off-writings 0/false/off/no disable
 * stickiness → unknown always resolves to null, byte-identical to the
 * pre-sticky behavior). Deterministic, never throws.
 * @param {number|null|undefined} raw - this frame's raw reading
 * @param {number|null|undefined} prev - last sticky-resolved valid value
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number|null} positive number = usable; null = unknown; 0 = garbage
 */
function stickyDim(raw, prev, env = process.env) {
  if (raw != null) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  const v = String((env && env.KHY_TERM_STICKY_DIMS) || '')
    .trim()
    .toLowerCase();
  const on = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  const p = Number(prev);
  if (on && prev != null && Number.isFinite(p) && p > 0) {
    return Math.floor(p);
  }
  return null;
}

/**
 * Resolve the sidebar width RELATIVE to the terminal: round(cols * ratio),
 * clamped into [KHY_SIDEBAR_WIDTH_MIN, KHY_SIDEBAR_WIDTH_MAX] (defaults 24/48).
 * Ratio via KHY_SIDEBAR_WIDTH_RATIO (default 0.20; invalid → 0.20). Legacy
 * KHY_SIDEBAR_WIDTH (explicit absolute columns) wins when set and valid
 * (clamped). Unusable cols → legacy default 30 (clamped). Never throws.
 * @param {number} cols - current terminal columns
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function sidebarWidth(cols, env = process.env) {
  let lo = _posNum(env, 'KHY_SIDEBAR_WIDTH_MIN');
  let hi = _posNum(env, 'KHY_SIDEBAR_WIDTH_MAX');
  lo = Number.isFinite(lo) ? Math.round(lo) : DEFAULT_WIDTH_MIN;
  hi = Number.isFinite(hi) ? Math.round(hi) : DEFAULT_WIDTH_MAX;
  if (lo > hi) {
    lo = DEFAULT_WIDTH_MIN;
    hi = DEFAULT_WIDTH_MAX;
  } // inverted bounds → defaults
  const clamp = (n) => Math.min(hi, Math.max(lo, n));
  // Legacy explicit absolute width takes precedence (backwards compatible).
  const abs = _posNum(env, 'KHY_SIDEBAR_WIDTH');
  if (Number.isFinite(abs)) {
    return clamp(Math.round(abs));
  }
  const r = _posNum(env, 'KHY_SIDEBAR_WIDTH_RATIO');
  const ratio = Number.isFinite(r) && r < 1 ? r : DEFAULT_WIDTH_RATIO;
  const c = Number(cols);
  if (!Number.isFinite(c) || c <= 0) {
    return clamp(DEFAULT_WIDTH);
  }
  return clamp(Math.round(c * ratio));
}

/**
 * Assumed terminal COLUMNS when the terminal reports none
 * (KHY_TERM_FALLBACK_COLS, default 80; invalid → 80).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function fallbackCols(env = process.env) {
  const n = _posNum(env, 'KHY_TERM_FALLBACK_COLS');
  return Number.isFinite(n) ? Math.round(n) : DEFAULT_FALLBACK_COLS;
}

/**
 * Assumed terminal ROWS when the terminal reports none
 * (KHY_TERM_FALLBACK_ROWS, default 24; invalid → 24).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function fallbackRows(env = process.env) {
  const n = _posNum(env, 'KHY_TERM_FALLBACK_ROWS');
  return Number.isFinite(n) ? Math.round(n) : DEFAULT_FALLBACK_ROWS;
}

/**
 * Relaxed min-cols threshold for the UNKNOWN-size (fallback) state
 * (KHY_SIDEBAR_MIN_COLS_FALLBACK, default 80; invalid → 80). Kept separate
 * from minCols so relaxing the fallback gate can never widen the real gate.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function minColsFallback(env = process.env) {
  const n = _posNum(env, 'KHY_SIDEBAR_MIN_COLS_FALLBACK');
  return Number.isFinite(n) ? Math.round(n) : DEFAULT_MIN_COLS_FALLBACK;
}

/**
 * Shared min-cols threshold resolver (KHY_SIDEBAR_MIN_COLS, default 120;
 * invalid → 120). Single source for both the sidebar gate and the wide-terminal
 * gate so the two thresholds can never drift. Exported so UI copy (e.g. the
 * Ctrl+T narrow-terminal hint) can quote the same threshold.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function minCols(env = process.env) {
  const rawMin = Number(String((env && env.KHY_SIDEBAR_MIN_COLS) || '').trim());
  return Number.isFinite(rawMin) && rawMin > 0 ? rawMin : DEFAULT_MIN_COLS;
}

/**
 * Min-rows floor resolver for the fullscreen gate (KHY_SIDEBAR_MIN_ROWS,
 * default 24; invalid → 24). Prevents a tiny window — whose current size
 * trivially equals its own session max — from qualifying as fullscreen.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function minRows(env = process.env) {
  const n = _posNum(env, 'KHY_SIDEBAR_MIN_ROWS');
  return Number.isFinite(n) ? n : DEFAULT_MIN_ROWS;
}

/**
 * Pure width gate: is the terminal "maximized" (wide enough for wide-only UI
 * such as the inline task panel)? Deliberately independent of KHY_SIDEBAR so
 * turning the sidebar off does not hide other wide-terminal features.
 * @param {number} cols - current terminal columns
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isWideTerminal(cols, env = process.env) {
  // Unknown terminal size (cols null/undefined — conpty reported nothing):
  // gate the ASSUMED width against the RELAXED fallback threshold instead of
  // the 120-col floor, so the board is not permanently hidden on terminals
  // that never report a size. Garbage (NaN/0/negative) stays false.
  if (cols == null) {
    return fallbackCols(env) >= minColsFallback(env);
  }
  const c = Number(cols);
  return Number.isFinite(c) && c >= minCols(env);
}

/**
 * Session-max fullscreen heuristic (pure): the terminal cannot read the OS
 * "window maximized" signal, so App tracks the LARGEST cols/rows seen this
 * session (monotonic) and the current size counts as fullscreen when it is
 * within tolerance of that max on BOTH axes. Floors (minCols / minRows) stop
 * a small window — trivially equal to its own max — from qualifying.
 * Tolerance via KHY_SIDEBAR_FULLSCREEN_TOL (default 2; invalid → 2).
 * @param {number} cols - current terminal columns
 * @param {number} rows - current terminal rows
 * @param {number} maxCols - largest columns seen this session
 * @param {number} maxRows - largest rows seen this session
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isFullscreen(cols, rows, maxCols, maxRows, env = process.env) {
  // Unknown terminal size (either axis null/undefined): substitute the
  // assumed single-source size and gate the columns against the RELAXED
  // fallback threshold. The rows floor is skipped for an assumed size — it
  // guards a MEASURED small window, which an assumption is not.
  const unknown = cols == null || rows == null;
  const c = unknown ? fallbackCols(env) : Number(cols);
  const r = unknown ? fallbackRows(env) : Number(rows);
  const mc = Number(maxCols);
  const mr = Number(maxRows);
  if (!Number.isFinite(c) || !Number.isFinite(r)) {
    return false;
  }
  // Session max must be a POSITIVE number — Number(null) is 0 and would
  // otherwise sneak past the finite check and satisfy `>= 0 - tol`.
  if (!Number.isFinite(mc) || mc <= 0 || !Number.isFinite(mr) || mr <= 0) {
    return false;
  }
  // Minimum floors: too narrow / too short is never "fullscreen".
  if (unknown) {
    if (c < minColsFallback(env)) {
      return false;
    }
  } else if (c < minCols(env) || r < minRows(env)) {
    return false;
  }
  const rawTol = String((env && env.KHY_SIDEBAR_FULLSCREEN_TOL) || '').trim();
  const t = rawTol === '' ? NaN : Number(rawTol);
  const tol = Number.isFinite(t) && t >= 0 ? Math.round(t) : DEFAULT_FULLSCREEN_TOL;
  return c >= mc - tol && r >= mr - tol;
}

/**
 * Decide whether the sidebar should render: KHY_SIDEBAR off-writings → false
 * (mirrors FooterBar's env-flag pattern 0/false/off/no); otherwise the
 * session-max fullscreen verdict (isFullscreen) decides — the sidebar only
 * shows when the window is at its largest observed size (“maximized”).
 * @param {number} cols - current terminal columns
 * @param {number} rows - current terminal rows
 * @param {number} maxCols - largest columns seen this session
 * @param {number} maxRows - largest rows seen this session
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function shouldShowSidebar(cols, rows, maxCols, maxRows, env = process.env) {
  const v = String((env && env.KHY_SIDEBAR) || '')
    .trim()
    .toLowerCase();
  const on = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  if (!on) {
    return false;
  }
  return isFullscreen(cols, rows, maxCols, maxRows, env);
}

/**
 * Resolve the sidebar background color from env.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} null when disabled; otherwise a color string ink accepts
 */
function sidebarBg(env = process.env) {
  const raw = String((env && env.KHY_SIDEBAR_BG) || '').trim();
  const v = raw.toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') {
    return null;
  }
  if (raw === '') {
    return DEFAULT_BG;
  }
  // ansi256(n): shape alone is not enough — chalk only accepts 0–255, so an
  // out-of-range n falls back to the default instead of feeding chalk garbage.
  const ansiMatch = ANSI256_RE.exec(raw);
  if (ansiMatch) {
    const n = Number(ansiMatch[1]);
    return n >= 0 && n <= 255 ? raw : DEFAULT_BG;
  }
  if (HEX_RE.test(raw) || NAME_RE.test(raw) || RGB_RE.test(raw)) {
    return raw;
  }
  return DEFAULT_BG; // invalid value → fall back, never feed garbage to chalk
}

/**
 * Relative STABLE HEIGHT for the sidebar (task #20). The sidebar must occupy
 * a CONSTANT share of the vertical space between the transcript and the
 * prompt — independent of how much the left column (model output) renders —
 * so it never collapses during long streaming turns:
 *   stable = min(round(rows * maxRatio), rows - minChrome)
 * The value is BOTH a floor and a ceiling: SidebarPanel applies it as a
 * minHeight (short content → padded with bg block / blank rows) AND as the
 * cap fed to capSidebarLines (long content → truncated with an honest marker).
 * maxRatio via KHY_SIDEBAR_MAX_RATIO (default 0.85; off-writings → 0 =
 * disabled → hug content); minChrome via KHY_SIDEBAR_MIN_CHROME (default 10)
 * keeps the upper row + full-width chrome strictly below rows (anti
 * scroll-jump: stable ≤ rows - minChrome always holds).
 * @param {number} rows - current terminal rows
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} 0 = disabled (hug content); otherwise the stable rows
 */
function sidebarStableRows(rows, env = process.env) {
  const v = String((env && env.KHY_SIDEBAR_MAX_RATIO) || '')
    .trim()
    .toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') {
    return 0;
  } // disabled → hug
  const r = Number(rows);
  if (!Number.isFinite(r) || r <= 0) {
    return 0;
  }
  const mr = _posNum(env, 'KHY_SIDEBAR_MAX_RATIO');
  const maxRatio = Number.isFinite(mr) && mr <= 1 ? mr : DEFAULT_MAX_RATIO;
  const mc = _posNum(env, 'KHY_SIDEBAR_MIN_CHROME');
  const minChrome = Number.isFinite(mc) ? Math.round(mc) : DEFAULT_MIN_CHROME;
  const ceiling = Math.floor(r) - minChrome; // structural safety ceiling
  if (ceiling <= 0) {
    return 1;
  } // tiny terminal → hard floor of a single row
  return Math.max(1, Math.min(ceiling, Math.round(r * maxRatio)));
}

/**
 * Monotonic session-max update (pure — D2 fix): compute the next session-max
 * dimensions from this frame's resolved size. ONLY a MEASURED size (dimsKnown
 * true) may grow the max — when the terminal reports nothing the caller's
 * cols/rows hold the ASSUMED fallback (fallbackCols/fallbackRows), and letting
 * an assumption into the max would corrupt the fullscreen baseline whenever
 * conpty oscillates real ↔ undefined between frames (the intermittent board
 * show/hide flicker). Non-finite / non-positive inputs never grow the max.
 * Always returns a NEW object; never throws.
 * @param {boolean} dimsKnown - true when cols/rows are real measurements
 * @param {number} cols - this frame's resolved columns
 * @param {number} rows - this frame's resolved rows
 * @param {number} maxCols - current session-max columns
 * @param {number} maxRows - current session-max rows
 * @returns {{cols: number, rows: number}}
 */
function nextSessionMax(dimsKnown, cols, rows, maxCols, maxRows) {
  const mc = Number(maxCols);
  const mr = Number(maxRows);
  const out = {
    cols: Number.isFinite(mc) ? mc : 0,
    rows: Number.isFinite(mr) ? mr : 0,
  };
  if (dimsKnown !== true) {
    return out;
  }
  const c = Number(cols);
  const r = Number(rows);
  if (Number.isFinite(c) && c > 0 && c > out.cols) {
    out.cols = c;
  }
  if (Number.isFinite(r) && r > 0 && r > out.rows) {
    out.rows = r;
  }
  return out;
}

/**
 * Classify a terminal dimension change (pure, for the zoom-immunity gate):
 *  - 'zoom'   — cols and rows scaled in the SAME direction (both grew or both
 *               shrank) with near-equal ratios (|rc − rr| ≤ tol): the terminal
 *               grid changed because the FONT size changed (Ctrl+wheel), not
 *               because the window moved — the sidebar verdict must not flip.
 *  - 'resize' — any other change (single-axis, opposite directions, ratios
 *               too far apart) or an unusable previous size (first frame).
 *  - 'none'   — dimensions unchanged, or the new size is unusable.
 * Tolerance via KHY_SIDEBAR_ZOOM_TOL (default 0.15; invalid → 0.15).
 * Deterministic, never throws.
 * @param {number} prevCols - previous effective terminal columns
 * @param {number} prevRows - previous effective terminal rows
 * @param {number} newCols - new terminal columns
 * @param {number} newRows - new terminal rows
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'zoom'|'resize'|'none'}
 */
function classifyResize(prevCols, prevRows, newCols, newRows, env = process.env) {
  const nc = Number(newCols);
  const nr = Number(newRows);
  if (!Number.isFinite(nc) || nc <= 0 || !Number.isFinite(nr) || nr <= 0) {
    return 'none';
  }
  const pc = Number(prevCols);
  const pr = Number(prevRows);
  // First frame / unusable previous size → treat as an ordinary resize.
  if (!Number.isFinite(pc) || pc <= 0 || !Number.isFinite(pr) || pr <= 0) {
    return 'resize';
  }
  if (nc === pc && nr === pr) {
    return 'none';
  }
  const rc = nc / pc;
  const rr = nr / pr;
  const t = _posNum(env, 'KHY_SIDEBAR_ZOOM_TOL');
  const tol = Number.isFinite(t) ? t : DEFAULT_ZOOM_TOL;
  const sameDirection = (rc > 1 && rr > 1) || (rc < 1 && rr < 1);
  return sameDirection && Math.abs(rc - rr) <= tol ? 'zoom' : 'resize';
}

/**
 * Height CEILING for the post-first-message sidebar (任务#8/#11): the board
 * shares a flex row with the left live column, top edge glued to the message
 * area's bottom edge; its height HUGS the content (shown rows =
 * min(content, ceiling) — no padding, the bottom edge floats with the
 * content) and this value only caps how far it may GROW:
 *   ceiling = rows - minChrome, hard floor 1 on tiny terminals
 * minChrome via KHY_SIDEBAR_MIN_CHROME (default 10) — rows reserved below the
 * row for the full-width chrome (prompt + footer + hint + budget margin), so
 * ceiling + chrome ≤ rows always holds (anti scroll-jump, same invariant as
 * the startup stable height — the board can never reach the prompt chrome).
 * Optional guard: KHY_SIDEBAR_STACK_MAX_RATIO — ONLY when explicitly set and
 * valid (0 < ratio ≤ 1) the ceiling is further capped at round(rows * ratio);
 * unset or invalid → no extra cap. Unusable rows → 0. Deterministic, never
 * throws.
 * @param {number} rows - current terminal rows
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} 0 = unusable rows; otherwise the ceiling row count
 */
function sidebarFillRows(rows, env = process.env) {
  const r = Number(rows);
  if (!Number.isFinite(r) || r <= 0) {
    return 0;
  }
  const mc = _posNum(env, 'KHY_SIDEBAR_MIN_CHROME');
  const minChrome = Number.isFinite(mc) ? Math.round(mc) : DEFAULT_MIN_CHROME;
  const fill = Math.max(1, Math.floor(r) - minChrome);
  const raw = _posNum(env, 'KHY_SIDEBAR_STACK_MAX_RATIO');
  if (Number.isFinite(raw) && raw <= 1) {
    return Math.max(1, Math.min(fill, Math.round(r * raw)));
  }
  return fill;
}

/**
 * Columns available to the LEFT (main) live column while the board shares the
 * flex row (任务#12): row = [main column (flexGrow) | board (fixed width,
 * flexShrink 0)], so any soft-wrap / visual-row math for streaming text must
 * budget against cols - sidebarWidth — measuring against the FULL terminal
 * width undercounts wrapped rows, the live region overflows the viewport and
 * ink's erase mis-count smears text across the board and pushes it down:
 *   main = cols - sidebarWidth(cols, env)
 * This is the TRUE geometry — never inflated. A former max(floor, main) lift
 * (任务#16 review, Major) could OVERSTATE the width under narrow-terminal env
 * overrides (e.g. cols=40 → board 24 → real 16, yet 20 was returned), which
 * under-counts soft-wrapped visual rows and re-opens the staircase/fullscreen
 * repaint risk. Overstating is the only unsafe direction (understating merely
 * clamps harder), so no floor is applied. Unusable cols or board ≥ cols → 0
 * (callers fall back to their legacy full-width path instead of receiving
 * broken geometry). Deterministic, never throws.
 * @param {number} cols - current terminal columns
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} 0 = unusable cols / no room left; otherwise the main column width
 */
function mainColumnCols(cols, env = process.env) {
  const c = Number(cols);
  if (!Number.isFinite(c) || c <= 0) {
    return 0;
  }
  const main = Math.floor(c) - sidebarWidth(c, env);
  return main > 0 ? main : 0;
}

/**
 * Activation hysteresis width in columns (KHY_SIDEBAR_HYSTERESIS): a dead-band
 * around the min-cols gate that keeps a terminal parked on the threshold from
 * flapping the board on/off between frames. An explicit 0 DISABLES the
 * dead-band; any other non-positive / invalid value falls back to the default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} >= 0 columns
 */
function hysteresisCols(env = process.env) {
  const raw = String((env && env.KHY_SIDEBAR_HYSTERESIS) || '').trim();
  if (raw === '0') {
    return 0;
  } // explicit opt-out of the dead-band
  const n = _posNum(env, 'KHY_SIDEBAR_HYSTERESIS');
  return Number.isFinite(n) ? Math.round(n) : DEFAULT_HYSTERESIS;
}

/**
 * Wide-terminal gate WITH activation hysteresis on the min-cols threshold — the
 * ONLY axis hysteresis touches (railGateOn / mainColumnCols room are gated
 * elsewhere). A terminal parked right on the boundary (119↔120) would otherwise
 * flap the board on/off between frames; the dead-band asks for a stricter entry
 * than exit:
 *  - wasActive === true  → stay active while cols >= minCols - hysteresisCols
 *  - wasActive === false → activate only once cols >= minCols
 * hysteresisCols === 0 collapses both thresholds to minCols (no dead-band, byte
 * identical to isWideTerminal for known cols). Unknown size (cols null/undefined)
 * ignores wasActive entirely and defers to the RELAXED fallback gate
 * (isWideTerminal), so the first unknown frame is never trapped in a dead-band.
 * Deterministic, never throws.
 * @param {number|null|undefined} cols - current terminal columns
 * @param {boolean} wasActive - the previous activation verdict
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function railActiveHysteresis(cols, wasActive, env = process.env) {
  // Unknown size → relaxed fallback gate; the dead-band is a MEASURED-width
  // concept and must not gate an assumption (first-frame 80-col lock).
  if (cols == null) {
    return isWideTerminal(cols, env);
  }
  const c = Number(cols);
  if (!Number.isFinite(c) || c <= 0) {
    return false;
  }
  const floor = minCols(env);
  const deadband = hysteresisCols(env);
  // Clamp the exit dead-band so an absurd hysteresis (e.g. 9999) cannot lock the
  // rail permanently ON. Left unbounded, the exit threshold (floor - deadband)
  // goes negative and an already-active rail stays on at every positive column
  // count. The dead-band's only job is anti-flap around the boundary, so it may
  // relax the entry gate at most down to the RELAXED wide floor (minColsFallback,
  // the same threshold unknown sizes use) and never below it. This keeps the
  // exit threshold in [minColsFallback, floor] — always >= 0 and always a real
  // gate, so a genuinely narrow terminal still drops the rail. The default
  // dead-band (2) is far below this cap, so normal behavior is byte-identical.
  const maxBand = Math.max(0, floor - minColsFallback(env));
  const exitBand = Math.min(deadband, maxBand);
  const threshold = wasActive === true ? floor - exitBand : floor;
  return c >= threshold;
}

/**
 * Vertical border glyph for the rail (KHY_SIDEBAR_BORDER_CHAR): the first
 * visible (non-whitespace) character of the override, else the default
 * box-drawing bar. Never throws.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} exactly one character
 */
function borderChar(env = process.env) {
  const raw = String((env && env.KHY_SIDEBAR_BORDER_CHAR) || '');
  for (const ch of raw) {
    if (ch.trim() !== '') {
      return ch;
    } // first visible code point wins
  }
  return RAIL_BORDER_CHAR;
}

/**
 * Rail border switch (KHY_SIDEBAR_BORDER): default ON; only the off-writings
 * (0/false/off/no) hide the border. Mirrors the KHY_SIDEBAR gate semantics.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function borderOn(env = process.env) {
  return !_off(env, 'KHY_SIDEBAR_BORDER');
}

/**
 * Dim ratio for faded notification rows (KHY_SIDEBAR_NOTIFY_FADE): a number in
 * [0,1]; anything outside that range / invalid falls back to the default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} in [0,1]
 */
function notifyFadeRatio(env = process.env) {
  const raw = String((env && env.KHY_SIDEBAR_NOTIFY_FADE) || '').trim();
  if (raw === '') {
    return DEFAULT_NOTIFY_FADE_RATIO;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_NOTIFY_FADE_RATIO;
}

/**
 * Board scroll switch (KHY_SIDEBAR_SCROLL): default OFF — opt in only with an
 * explicit on-writing (1/true/on/yes).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function scrollEnabled(env = process.env) {
  return _on(env, 'KHY_SIDEBAR_SCROLL');
}

/**
 * Board focus switch (KHY_SIDEBAR_FOCUS): default OFF — opt in only with an
 * explicit on-writing (1/true/on/yes).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function focusEnabled(env = process.env) {
  return _on(env, 'KHY_SIDEBAR_FOCUS');
}

/**
 * Key that toggles board focus (KHY_SIDEBAR_FOCUS_KEY): a single lowercase
 * letter (the first character, lowercased); invalid / non-letter → default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} one lowercase letter
 */
function focusKey(env = process.env) {
  const raw = String((env && env.KHY_SIDEBAR_FOCUS_KEY) || '')
    .trim()
    .toLowerCase();
  const ch = raw.charAt(0);
  return /^[a-z]$/.test(ch) ? ch : DEFAULT_FOCUS_KEY;
}

module.exports = {
  sidebarWidth,
  shouldShowSidebar,
  sidebarBg,
  isWideTerminal,
  isFullscreen,
  minCols,
  minRows,
  fallbackCols,
  fallbackRows,
  minColsFallback,
  sidebarStableRows,
  sidebarFillRows,
  mainColumnCols,
  classifyResize,
  stickyDim,
  nextSessionMax,
  hysteresisCols,
  railActiveHysteresis,
  borderChar,
  borderOn,
  notifyFadeRatio,
  scrollEnabled,
  focusEnabled,
  focusKey,
};
