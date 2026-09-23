'use strict';

/**
 * ccLayout.js —— 布局计算（绝对值 + 相对值混合）
 *
 * 参考：[DESIGN-ARCH-081] 绝对值 vs 相对值设置
 */

// ── 绝对值常量 ──────────────────────────────────────────────────────────────

const ABSOLUTE = Object.freeze({
  statusBarHeight: 1,       // 状态栏高度：绝对 1 行
  inputMinHeight: 1,        // 输入框最小高度：绝对 1 行
  toolParamIndent: 2,       // 工具参数缩进：绝对 2 空格
  borderWidth: 1,           // 分割线宽度：绝对 1 字符
  tabIndent: 2,             // Tab 缩进：绝对 2 空格
  messagePaddingX: 0,       // 消息内边距：CC 模式无
});

// ── 边框字符（绝对精确） ────────────────────────────────────────────────────

const BOX_CHARS = Object.freeze({
  horizontal: '─',
  vertical: '│',
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  leftT: '├',
  rightT: '┤',
  topT: '┬',
  bottomT: '┴',
  cross: '┼',
  // 简化圆角
  roundTopLeft: '╭',
  roundTopRight: '╮',
  roundBottomLeft: '╯',
  roundBottomRight: '╰',
});

// ── 状态栏分隔符 ────────────────────────────────────────────────────────────

const STATUS_SEPARATOR = ' │ '; // U+2502 + 两侧空格

// ── 布局计算函数 ────────────────────────────────────────────────────────────

// DESIGN-ARCH-102 §4.2: the sidebar width formula has ONE source —
// sidebarLayout.sidebarWidth(cols, env) = clamp(round(cols × 0.16), 24, 36).
// The legacy cc-local `min(30, cols × 0.25)` was removed: at 120 cols it
// produced 30 vs sidebarLayout's 24, and the two formulas diverging was a
// deterministic ghosting source (staircase on resize). CcApp now gets its
// sidebar width through getLayout() → this single source.

/**
 * 计算主内容区宽度
 * @param {number} cols - 终端列数
 * @param {number} sidebarW - 看板宽度（0 表示看板隐藏）
 * @returns {number}
 */
function mainContentWidth(cols, sidebarW = 0) {
  return cols - sidebarW;
}

/**
 * 计算消息区域高度
 * @param {number} rows - 终端行数
 * @param {number} inputHeight - 输入框高度
 * @returns {number}
 */
function messageAreaHeight(rows, inputHeight = 1) {
  return rows - ABSOLUTE.statusBarHeight - inputHeight;
}

/**
 * 计算输入框最大高度
 * @param {number} rows - 终端行数
 * @returns {number}
 */
function inputMaxHeight(rows) {
  return Math.min(10, Math.floor(rows * 0.3));
}

/** 宿主没给 maxRows 时的回落值（= CcPromptInput 的 prop 默认值，同值异处即债）。 */
const INPUT_MAX_ROWS_DEFAULT = 10;

/**
 * 输入框**实际画几行** —— 高度窗口化的上限。
 *
 * 唯一真源：组件（CcPromptInput）与投影（ccMessageProjection）都必须调它。
 * 两边此前各写一份 `min(maxRows, floor(rows × 0.3))`；BUG-81 把组件那份改成
 * 只信宿主给的 maxRows 之后，投影仍留着旧式子 —— 账本与画面一旦分叉，
 * 拖选行号整体错位。抄一次是债，抄两次是事故。
 *
 * - 宿主没传（null / undefined / NaN）→ 回落 INPUT_MAX_ROWS_DEFAULT；
 * - 宿主给了 0 或负数（例如 `inputMaxHeight(3) === 0` 的退化终端）→ 1 行，
 *   输入框总得画得出来。
 *
 * @param {number|null|undefined} maxRows
 * @returns {number}
 */
function inputRenderRows(maxRows) {
  const n = Number(maxRows);
  if (maxRows == null || !Number.isFinite(n)) {
    return INPUT_MAX_ROWS_DEFAULT;
  }
  return Math.max(1, Math.floor(n));
}

/**
 * 输入框高度窗口的**唯一**算式：给出「画哪几行 + 要不要省略号」，并保证
 * `内容行 + 省略号行 ≤ inputRenderRows(maxRows)`。
 *
 * BUG-84：此前组件与投影各自写 `slice(start, end)`，窗口取满 `maxRenderRows`
 * 之后**再往上追加** 1–2 行省略号 —— 于是「账本 N 行 / 实画 N+2 行」。宿主
 * （CcApp）按 `layout.inputMaxHeight` 给消息区扣预算，这 2 行从没入过账：
 * 实测 100×24 账本 7 行、实画 9 行；100×12 账本 3、实画 5（每个高度都差 2）。
 * 按 chromeBudget 的算式代回去：满窗 + 折叠提示行 + 流式行的那一帧正好
 * `= rows`，而 ink 是在 `outputHeight >= rows` 时才走全屏分支（BUG-77b 实测），
 * 也就是说这 2 行把 slack 2 吃干净，任何一笔额外开销都会换来整屏残影。
 *
 * 收敛方式：省略号也是输入框画出来的行，就得从输入框的预算里出。窗口内容行数
 * 取 `cap - 省略号数`，两边（组件与投影）都调这一个函数 —— 与 inputRenderRows
 * 同样的理由：抄一次是债，抄两次是事故。
 *
 * @param {number} total - 折行后的总行数
 * @param {number|null|undefined} maxRows - 宿主给的 `layout.inputMaxHeight`
 * @param {number} caretRow - 光标所在行（0-based）；非法时按末行
 * @returns {{start:number,end:number,above:boolean,below:boolean,
 *   rows:number,cap:number}} rows = 实际占屏行数（含省略号）
 */
function inputWindow(total, maxRows, caretRow) {
  const cap = inputRenderRows(maxRows);
  const t = Math.max(0, Math.floor(Number(total)) || 0);
  if (t <= cap) {
    return { start: 0, end: t, above: false, below: false, rows: t, cap };
  }
  let caret = Math.floor(Number(caretRow));
  if (!Number.isFinite(caret)) caret = t - 1;
  caret = Math.min(t - 1, Math.max(0, caret));
  // 一块标记 = 一行屏，必须从 cap 里出。窗口要盖住光标行，被藏起的两侧又各要
  // 一块标记，所以「内容行数 k」与「标记数 m」互相牵制：k 越小越容易只藏一侧。
  // 于是对 m 穷举（m 最多 2，cap≥3 时才可能装得下两块标记），取**占屏最多**且
  // 自洽（实际需要的标记数 ≤ m）的那一档：光标贴边时省下的标记行会还给内容，
  // 光标居中时两块标记照旧。旧式子的病根是「先取满 cap 行内容再追加标记」，
  // rows 恒等于 cap + need。
  const maxMarkers = Math.min(2, cap - 1);
  let best = null;
  for (let m = 0; m <= maxMarkers; m += 1) {
    const w = windowAround(t, cap - m, caret);
    const need = (w.start > 0 ? 1 : 0) + (w.end < t ? 1 : 0);
    if (need > m) continue;
    const cand = shape(w, t, m, cap);
    if (!best || cand.rows > best.rows) best = cand;
  }
  // 一档都不自洽只发生在预算太小（cap=1，或 cap=2 且光标居中）：内容行不能让，
  // 标记只能留一块 —— 给「藏得更多」的那一侧，平手用上侧。cap=1 连一块都放不下。
  if (!best) best = shape(windowAround(t, cap - maxMarkers, caret), t, maxMarkers, cap);
  return best;
}

/** 以 caretRow 为中心取 `k` 行内容，贴到边界时整窗平移（不缩小）。 */
function windowAround(total, k, caretRow) {
  const rows = Math.max(1, Math.floor(k));
  const half = Math.floor(rows / 2);
  let start = Math.max(0, Math.min(total - rows, caretRow - half));
  const end = Math.min(total, start + rows);
  start = Math.max(0, end - rows);
  return { start, end };
}

/** 把一次窗口选择摊平成返回值；标记只画 `m` 块，两侧都藏不下时砍掉信息少的一侧。 */
function shape(win, total, m, cap) {
  const hiddenAbove = win.start;
  const hiddenBelow = total - win.end;
  let above = hiddenAbove > 0;
  let below = hiddenBelow > 0;
  if (above && below && m < 2) {
    if (hiddenBelow > hiddenAbove) above = false;
    else below = false;
  }
  if (m < 1) { above = false; below = false; }
  return {
    start: win.start,
    end: win.end,
    above,
    below,
    rows: (win.end - win.start) + (above ? 1 : 0) + (below ? 1 : 0),
    cap,
  };
}

/**
 * 计算补全菜单最大高度
 * @param {number} rows - 终端行数
 * @returns {number}
 */
function completionMaxHeight(rows) {
  return Math.min(15, Math.floor(rows * 0.4));
}

/**
 * 计算帮助菜单宽度
 * @param {number} cols - 终端列数
 * @returns {number}
 */
function helpMenuWidth(cols) {
  return Math.min(80, Math.floor(cols * 0.8));
}

/**
 * 计算工具名显示宽度
 * @param {number} cols - 终端列数
 * @returns {number}
 */
function toolNameWidth(cols) {
  return Math.max(10, Math.min(20, Math.floor(cols * 0.15)));
}

/**
 * 判断是否应显示右侧看板（DESIGN-ARCH-102 §4.4: 阈值只读 sidebarLayout.minCols，
 * 默认 120，可配）。不再硬编码 >= 120，避免与 railLayout/contentWidth 的判定分叉。
 * @param {number} cols - 终端列数
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function shouldShowSidebar(cols, env = process.env) {
  try {
    return Number(cols) >= require('../sidebarLayout').minCols(env);
  } catch {
    return Number(cols) >= 120;
  }
}

/**
 * P0-2 (frame-height discipline): the maximum number of rows CcApp's committed
 * message list may occupy, computed from the same geometry getLayout already
 * owns. Everything the fixed chrome renders OUTSIDE the message list is
 * pre-charged so that logo + agent tree + message bar + toast + status line +
 * prompt input + streaming row + frame slack never push a frame past
 * `rows` (the ink fullscreen repaint that duplicates the transcript in the
 * scrollback — [IMPL-RPT-044]).
 *
 * Fixed chrome shares (absolute, per current components):
 *   CcLogo        = marginY 1×2 + 1 content row (+1 when subtitle shown)
 *   CcMessageBar  = 1 row (border round, paddingX only)
 *   each CcToast  = 1 row
 *   CcStatusLine  = 1 row
 *   CcStreamingMessage = 1 row + marginTop 1 (busy only)
 * Frame slack of 2 absorbs wrap surprises (a long status segment wrapping on a
 * narrow terminal) — a cap that overfills by a row re-triggers the very
 * fullscreen repaint it exists to prevent.
 *
 * @param {number} cols - terminal columns (unused by the arithmetic, kept for
 *   signature stability / future width-aware shares)
 * @param {number} rows - terminal rows
 * @param {{inputRows?:number, streaming?:boolean, messageBar?:boolean,
 *   toasts?:number, agentTreeRows?:number, logoSubtitle?:boolean}} [shares]
 * @returns {number} ≥ 0; 0 disables the cap only for degenerate geometry
 *   (callers fall back to rendering everything when ≤ 0)
 */
function messageAreaCap(cols, rows, shares = {}) {
  // Single chrome ledger (DESIGN-ARCH-103 P0-5 / H1): the arithmetic now lives
  // in chromeBudget; this keeps the legacy signature and CC-specific logo rows.
  try {
    return require('../chromeBudget').messageAreaCapCompat(cols, rows, shares);
  } catch {
    /* leaf unavailable → legacy arithmetic below */
  }
  const n = Math.floor(Number(rows));
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  const inputRows = Math.max(1, Math.floor(Number(shares.inputRows) || 1));
  const logoRows = 2 /* marginY */ + 1 /* content */ + (shares.logoSubtitle === false ? 0 : 1);
  const agentTreeRows = Math.max(0, Math.floor(Number(shares.agentTreeRows) || 0));
  const streamingRows = shares.streaming ? 2 /* marginTop + row */ : 0;
  const messageBarRows = shares.messageBar ? 1 : 0;
  const toastRows = Math.max(0, Math.floor(Number(shares.toasts) || 0));
  const chrome =
    logoRows +
    agentTreeRows +
    streamingRows +
    messageBarRows +
    toastRows +
    ABSOLUTE.statusBarHeight +
    inputRows +
    2; /* frame slack */
  // Parity with chromeBudget.ccCapAtLogoRows: the trailer row ink spends on
  // `output + '\n'` (BUG-77b).
  return Math.max(0, n - chrome - 1);
}

/**
 * BUG-77b: the CC chrome degradation ladder — a thin adapter over
 * chromeBudget.ccChromePlan so that CcApp takes ALL of its layout arithmetic
 * from this module (no second copy of the formula, which is what drifted in
 * BUG-82/BUG-83). Returns `{ cap, logoRows, subtitle, banner, hint }`: the
 * message window budget AND the decorative chrome shape that budget was
 * computed for — the caller must render both from this one object.
 *
 * @param {number} rows - terminal rows
 * @param {{inputRows?:number, streaming?:boolean, messageBar?:boolean,
 *   toasts?:number, agentTreeRows?:number, logoSubtitle?:boolean,
 *   extraRows?:number}} [shares]
 * @param {number} [contentRows] BUG-92：窗口恒留那条消息实画几行
 * @returns {{cap:number, logoRows:number, subtitle:boolean, banner:boolean,
 *   hint:boolean, msgGap:boolean, busyGap:boolean}}
 */
function ccChromePlan(...args) {
  // **必须整串转发**：本函数是 chromeBudget 的薄适配器，写成
  // `(rows, shares) => …(rows, shares)` 会把后来新增的位置参数静默吞掉 ——
  // 调用方照样拿到一个「看起来合理」的 plan，只是它永远按最宽松的档算
  // （BUG-92 的 2J 就是这么在账本已修、画面却不动的状态下留下的）。
  return require('../chromeBudget').ccChromePlan(...args);
}

/**
 * 获取完整布局参数
 */
function getLayout(cols, rows) {
  // 102 §4.2: sidebar width from the single source (sidebarLayout.sidebarWidth).
  let sbWidth = 0;
  try {
    const sb = require('../sidebarLayout');
    sbWidth = shouldShowSidebar(cols) ? sb.sidebarWidth(cols) : 0;
  } catch {
    sbWidth = shouldShowSidebar(cols) ? Math.max(24, Math.min(36, Math.round(cols * 0.16))) : 0;
  }
  return {
    cols,
    rows,
    sidebarWidth: sbWidth,
    mainWidth: mainContentWidth(cols, sbWidth),
    messageHeight: messageAreaHeight(rows),
    inputMaxHeight: inputMaxHeight(rows),
    completionMaxHeight: completionMaxHeight(rows),
    helpMenuWidth: helpMenuWidth(cols),
    toolNameWidth: toolNameWidth(cols),
    statusBarHeight: ABSOLUTE.statusBarHeight,
    showSidebar: sbWidth > 0,
  };
}

/**
 * P0-3: sanitize one terminal-dimension reading for CcApp's resize listener.
 * conpty can momentarily report undefined OR 0 — they are NOT the same case:
 * 0 is a garbage measurement that must be REJECTED, undefined is "unknown" and
 * should also not overwrite a stable value. Only a finite positive number is
 * worth committing; null means "keep the previous value". Mirrors the explicit
 * tri-state rule App.js's _resolveResizeCols applies (Review Major 2: no `||`
 * chains — `||` conflates 0 with undefined).
 * @param {*} value - raw stdout.columns / stdout.rows reading
 * @returns {number|null} floored positive int, or null when unusable
 */
function sanitizeDim(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return Math.floor(n);
}

/**
 * BUG-83: the CC surface's ONE resolution of the terminal size.
 *
 * CcApp used to carry its own copy of the rules (`process.stdout.rows || 24` at
 * mount, `sanitizeDim` + `if (c)` in the resize listener). That silently dropped
 * two things the rest of the repo guarantees:
 *   - the documented `KHY_TERM_FALLBACK_ROWS/COLS` contract ([DESIGN-ARCH-079]
 *     环境变量表 / [DESIGN-ARCH-101] 规则 7「未知尺寸用 fallback 尺寸」) — the
 *     operator's only remedy when conpty reports 0/undefined;
 *   - the STICKY reuse (effectiveDims's shared cache; App.js:5561 calls it
 *     根因 B: a frame where the size is momentarily unknown must reuse the last
 *     valid reading instead of collapsing and re-laying out).
 * Same lesson as the sidebar-width note above: two formulas diverge.
 *
 * Delegates, never reads stdout itself, never throws.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{cols:number, rows:number}} finite positives, always
 */
function ccTerminalDims(env = process.env) {
  const fallback = { cols: 80, rows: 24 };
  let sticky = null;
  try {
    const eff = require('../effectiveDims');
    sticky = { cols: eff.stickyCols(env), rows: eff.stickyRows(env) };
  } catch {
    /* leaf unavailable → assumed size below */
  }
  let sb = null;
  try {
    sb = require('../sidebarLayout');
  } catch {
    /* leaf unavailable → literals below */
  }
  return {
    cols:
      sanitizeDim(sticky && sticky.cols)
      ?? (sb ? sb.fallbackCols(env) : fallback.cols),
    rows:
      sanitizeDim(sticky && sticky.rows)
      ?? (sb ? sb.fallbackRows(env) : fallback.rows),
  };
}

module.exports = {
  ABSOLUTE,
  BOX_CHARS,
  STATUS_SEPARATOR,
  mainContentWidth,
  messageAreaHeight,
  messageAreaCap,
  ccChromePlan,
  inputMaxHeight,
  inputRenderRows,
  inputWindow,
  INPUT_MAX_ROWS_DEFAULT,
  completionMaxHeight,
  helpMenuWidth,
  toolNameWidth,
  shouldShowSidebar,
  getLayout,
  sanitizeDim,
  ccTerminalDims,
};
