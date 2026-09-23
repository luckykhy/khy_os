'use strict';

/**
 * sidebarRail (runtime) — owns the state and the WRITES for the right-rail task
 * board. All geometry and byte-building lives in the pure `railLayout` leaf;
 * this module holds the mutable pieces: the stream, the latest board snapshot,
 * suspend state, and the last painted geometry (needed to wipe a STALE gutter
 * after a resize).
 *
 * How the paint reaches the terminal — the load-bearing design decision:
 *   paintBytes() performs NO IO. It returns a string that app.jsx's stdout Proxy
 *   APPENDS to whatever frame ink is already writing, so ink's whole-line erase
 *   and our repaint land in ONE write() syscall. There is therefore no moment in
 *   which the gutter is erased but not yet repainted — which is the only
 *   reliable way to keep the rail flicker-free. A post-render React effect
 *   cannot make that guarantee (its timing relative to ink's own write is not
 *   controlled by us).
 *
 * Because paintBytes() never writes, the Proxy can never re-enter this module.
 * The few writes that DO happen here (suspend / resize-shrink / disable) go to
 * the REAL stdout captured at enable() — never to the Proxy — so they cannot
 * recurse either, and they cannot pick up a rail suffix of their own.
 *
 * No repaint timer is needed: App's existing 1s `nowTick` heartbeat re-renders
 * the live region, ink writes a frame, and the rail rides along.
 *
 * API shape deliberately mirrors runtime/topicBar.js (enable / isEnabled /
 * suspend / resume / onResize / disable + a process exit hook) so App's existing
 * lifecycle call sites gain one adjacent line each.
 */

const railLayout = require('../railLayout');

let _state = {
  enabled: false,
  suspended: false,
  stdout: null,
  snapshot: null, // the latest _sidebarProps pushed from App's render
  lastGeom: null, // geometry of the most recent paint (for stale-clear)
  lastPaintBytes: '', // identical frames need no second terminal repaint
  dims: null, // sticky-RESOLVED {cols, rows} pushed from App's render (SSOT)
  lastValidDims: null, // last VALID {cols, rows} — the sticky fallback setDims reuses
  chrome: null, // footer rows below the prompt border (App pushes via setChrome)
  scrollOffset: 0, // 阶段四: board scroll window offset (App pushes via setNav)
  focusIndex: -1, // 阶段四: selected line index, -1 = no selection / unfocused
};

// ── lazy deps (never on the module's critical require path) ─────────────────
// Each dep is required at most ONCE on success and reused across every _fit
// call (previously re-required per call). Failures are NOT cached — a transient
// require error can still recover on a later call; only a resolved module is
// memoized. _resetLazyCacheForTest() clears them (mirrors
// effectiveCols._resetStickyColsForTest).
let _measureCache;
let _sidebarPanelCache;
let _chalkCache;

/** CJK-aware display width, same measurer SidebarPanel uses. */
function _measure() {
  if (_measureCache) {
    return _measureCache;
  }
  try {
    const dw = require('../../formatters').displayWidth;
    if (typeof dw === 'function') {
      _measureCache = dw;
      return _measureCache;
    }
  } catch {
    /* fall through */
  }
  return (s) => String(s).length; // not cached: retry the require next call
}

function _sidebarPanel() {
  if (_sidebarPanelCache) {
    return _sidebarPanelCache;
  }
  try {
    _sidebarPanelCache = require('../ink-components/SidebarPanel');
    return _sidebarPanelCache;
  } catch {
    return null;
  }
}

function _chalk() {
  if (_chalkCache) {
    return _chalkCache;
  }
  try {
    _chalkCache = require('chalk');
    return _chalkCache;
  } catch {
    return null;
  }
}

/**
 * Test-only: clear the lazy dep caches so suites can simulate a fresh module
 * (mirrors effectiveCols._resetStickyColsForTest). Failed lookups are already
 * un-cached; this resets the successful ones.
 */
function _resetLazyCacheForTest() {
  _measureCache = undefined;
  _sidebarPanelCache = undefined;
  _chalkCache = undefined;
}

/**
 * Apply a line descriptor's fg styling ({color, dim, bold}) via chalk.
 *
 * Safe to nest inside the row's background SGR: chalk closes fg/dim/bold with
 * their SPECIFIC terminators (39 / 22), never a full `0m` reset, so the
 * background survives to the end of the row. chalk level 0 (no color support)
 * returns the text untouched.
 * The selected row (阶段四 focus nav) is drawn reverse-video via chalk.inverse:
 * it self-closes with SGR 27 (not a full 0m reset), so like dim/bold/color it
 * cannot leak into the next row — buildRailPaint still owns the final teardown.
 * @param {string} text
 * @param {object|null} line
 * @returns {string}
 */
function _style(text, line) {
  if (!line) {
    return text;
  }
  const chalk = _chalk();
  if (!chalk) {
    return text;
  }
  try {
    let s = text;
    if (line.color && typeof chalk[line.color] === 'function') {
      s = chalk[line.color](s);
    }
    if (line.dim) {
      s = chalk.dim(s);
    }
    if (line.bold) {
      s = chalk.bold(s);
    }
    // Reverse-video highlight last so it wraps the fully-styled + padded row.
    if (line.selected && typeof chalk.inverse === 'function') {
      s = chalk.inverse(s);
    }
    return s;
  } catch {
    return text; // styling is cosmetic — never let it break the paint
  }
}

/**
 * The width fitter injected into railLayout.buildRailPaint: truncate + pad to
 * EXACTLY `width` display columns using SidebarPanel's own helpers, so the rail
 * and the legacy in-tree board share one padding/truncation口径 and can never
 * drift apart visually.
 *
 * One leading space reproduces the in-tree box's `paddingX: 1` left gutter; the
 * padding to `width - 1` supplies the right one.
 * @param {string} text
 * @param {number} width
 * @param {object|null} line
 * @returns {string}
 */
function _fit(text, width, line) {
  const panel = _sidebarPanel();
  const inner = Math.max(0, width - 1);
  if (!panel || typeof panel.padLineToWidth !== 'function') {
    const s = String(text == null ? '' : text).slice(0, inner);
    return ' ' + s + ' '.repeat(Math.max(0, inner - s.length));
  }
  const measure = _measure();
  const cut =
    typeof panel.truncateToWidth === 'function'
      ? panel.truncateToWidth(text, inner, measure)
      : text;
  return ' ' + _style(panel.padLineToWidth(cut, inner, measure), line);
}

// ── geometry / content ─────────────────────────────────────────────────────

/**
 * Left-border descriptor for buildRailPaint: the border glyph + switch come
 * from the sidebarLayout pure leaf (KHY_SIDEBAR_BORDER / _BORDER_CHAR); the
 * dim-gray styling is applied HERE (chalk lives in the runtime, not the pure
 * leaf). chalk.dim/gray self-close their SGR (22/39) without clearing the
 * background, so the border cannot bleed into bg or content. Border off, chalk
 * missing, or the leaf unavailable all degrade safely (bare char / no border).
 * @param {NodeJS.ProcessEnv} env
 * @returns {{str: string, cols: number}} cols 0 ⇒ byte-identical legacy paint
 */
function _border(env) {
  let sb;
  try {
    sb = require('../sidebarLayout');
  } catch {
    return { str: '', cols: 0, ghost: false };
  }
  try {
    if (!sb.borderOn(env)) {
      return { str: '', cols: 0, ghost: false };
    }
    // Ghost border (KHY_GHOST_BORDER=1): 边框由 CUP 光标定位叠加绘制，不占内容字符流，
    // 复制时不带走框线（对齐 OpenCode 行为，[DESIGN-ARCH-079] §11.6）。
    // 门控 off（默认）→ 返回字符边框（chalk.dim(gray)），逐字节 legacy。
    let ghostOn = false;
    try {
      ghostOn = require('../../ghostBorder').isGhostBorderEnabled(env);
    } catch {
      ghostOn = false;
    }
    const ch = sb.borderChar(env);
    if (ghostOn) {
      // Ghost 模式：buildRailPaint 收到 {str:'', cols:0, ghost:true} 时会在整块
      // 之外用 CUP 单独叠加竖线（见 _ghostBorderOverlay 调用点），本行不画边框字符。
      return { str: '', cols: 0, ghost: true, char: ch };
    }
    const chalk = _chalk();
    if (!chalk) {
      return { str: ch, cols: 1, ghost: false };
    } // no chalk → bare glyph
    return { str: chalk.dim(chalk.gray(ch)), cols: 1, ghost: false };
  } catch {
    return { str: '', cols: 0, ghost: false }; // styling is cosmetic — never break the paint
  }
}

/**
 * Ghost border overlay: 把一列竖线用 CUP 绝对坐标叠加绘制到看板左侧（整块之外），
 * 不占用 buildRailPaint 的内容流 → 复制时不带走框线。KHY_GHOST_BORDER=1 时才调用；
 * 门控 off 时 buildRailPaint 已走字符边框路径，本函数不会被调用（逐字节 legacy）。
 *
 * 复用 railLayout.buildRailPaint 同一套 CUP + DECSC/DECRC 包裹 + SGR 自闭序列，
 * 保证与看板正文落在同一次 write()（sidebarRail paintBytes 契约），不引入第二
 * 个渲染时机。
 * @param {{left:number, top:number, height:number}} geom
 * @param {string} ch - 边框字符（'│'）
 * @returns {string}
 */
function _ghostBorderOverlay(geom, ch) {
  if (!geom || geom.height <= 0) {
    return '';
  }
  let ghostBorder;
  try {
    ghostBorder = require('../../ghostBorder');
  } catch {
    return ''; // leaf unavailable → 静默降级（与 ghost 门控本身 fail-soft 一致）
  }
  // 竖线从看板顶行画到底行（含端点），列 = 看板左缘（与 buildRailPaint 的 geom.left 一致）
  return ghostBorder.ghostVerticalBorder(geom.left, geom.top, geom.top + geom.height - 1, ch || '│');
}

/**
 * Current geometry; null when inactive. SINGLE-SOURCE ACTIVATION (anti
 * jitter/ghosting): App pushes its sticky-resolved dimensions every render via
 * setDims(), and the painter derives its geometry from THAT pair — the exact
 * inputs the ink tree used for its own narrowing (_railContentCols) — so the
 * in-tree board and this painter can never disagree within a frame (double
 * board / gutter painted at stale coordinates). Windows conpty oscillating
 * columns (120 → undefined → 120) between App's render and ink's write can no
 * longer move the gutter. Before the first push (or if App is somehow absent)
 * the dims are unknown → railGeometry substitutes the single-source fallback
 * (sidebarLayout.fallbackCols/Rows); the painter NEVER reads the raw stream, so
 * a stdout read racing App's own resolution can no longer fork the geometry.
 */
function _geometry() {
  const out = _state.stdout;
  if (!out) {
    return null;
  }
  const d = _state.dims;
  // SINGLE-SOURCE geometry: consume ONLY App's sticky-resolved pushed dims.
  // Unknown axis (null) → railGeometry applies the single-source fallback; we
  // deliberately do NOT read out.columns/out.rows here (divergent-path root).
  const cols = d ? d.cols : null;
  const rows = d ? d.rows : null;
  // Pass the pushed footer chrome height so the geometry can bottom-anchor the
  // board (chrome null → legacy top-anchored fill). This is the FILL slot used
  // to size line-building; paintBytes re-derives the HUG geometry once the line
  // count is known.
  const g = railLayout.railGeometry(cols, rows, process.env, { bottomChrome: _state.chrome });
  return g.on ? g : null;
}

/**
 * Bottom-anchored HUG geometry for `contentRows` lines. Meaningful only after App
 * has pushed the footer chrome height via setChrome(); with chrome null it is
 * identical to the legacy fill geometry. See railLayout.railGeometry (BOTTOM
 * anchor supersedes the old top-anchor rule).
 * @param {number} contentRows
 */
function _hugGeometry(contentRows) {
  const out = _state.stdout;
  if (!out) {
    return null;
  }
  const d = _state.dims;
  // Same single-source rule as _geometry: never read the raw stream.
  const cols = d ? d.cols : null;
  const rows = d ? d.rows : null;
  const g = railLayout.railGeometry(cols, rows, process.env, {
    bottomChrome: _state.chrome,
    contentRows,
  });
  return g.on ? g : null;
}

/** Board lines for the current snapshot, sized to the gutter width. */
function _lines(geom) {
  const panel = _sidebarPanel();
  if (!panel || typeof panel.buildSidebarLines !== 'function' || !_state.snapshot) {
    return [];
  }
  try {
    // 阶段四 virtualization: buildSidebarLines is the SINGLE windowing authority.
    // When the scroll flag is on we feed it the clamped offset so it returns
    // ONLY the maxRows-tall visible slice (with ↑/↓ hidden-count indicators);
    // buildRailPaint then paints exactly that slice. Flag OFF → we pass NO
    // scrollOffset, so buildSidebarLines runs its byte-identical legacy path
    // (completed-fold overflow, no window). selectedIdx is fed only while a row
    // is actually selected (focusIndex ≥ 0) so the reverse-video highlight rides
    // the descriptor into _style.
    let scrollOn = false;
    try {
      scrollOn = require('../sidebarLayout').scrollEnabled(process.env);
    } catch {
      scrollOn = false;
    }
    const extra = {};
    if (scrollOn) {
      extra.scrollOffset = _state.scrollOffset;
    }
    if (_state.focusIndex >= 0) {
      extra.selectedIdx = _state.focusIndex;
    }
    // maxRows = 槽位高度:让 buildSidebarLines 的「已完成项折叠」溢出策略在右栏
    // 与树内看板用同一口径生效(超高才折叠,空间够则完成项正常列出)。
    return (
      panel.buildSidebarLines({
        ..._state.snapshot,
        width: geom.width,
        maxRows: geom.height,
        ...extra,
      }) || []
    );
  } catch {
    return []; // fail-soft: an empty rail beats a broken TUI
  }
}

/** Write directly to the REAL stdout (bypasses the Proxy — see module header). */
function _writeRaw(bytes) {
  if (!bytes || !_state.stdout) {
    return;
  }
  try {
    _state.stdout.write(bytes);
  } catch {
    /* terminal already gone */
  }
}

// ── lifecycle ──────────────────────────────────────────────────────────────

let _exitHooked = false;
function _installExitHook() {
  if (_exitHooked) {
    return;
  }
  _exitHooked = true;
  const off = () => {
    try {
      disable();
    } catch {
      /* terminal already gone */
    }
  };
  process.once('exit', off);
  process.once('SIGINT', off);
  process.once('SIGTERM', off);
}

/**
 * Enable the rail. Returns true when it is actually active — App uses the
 * return value to decide whether to keep the legacy in-tree SidebarPanel.
 * Requires the env gate AND a real TTY (a pipe has no addressable cells).
 * Idempotent.
 * @param {object} [stdout] - defaults to process.stdout (must be the REAL one)
 * @returns {boolean}
 */
function enable(stdout) {
  if (_state.enabled) {
    return true;
  }
  if (!railLayout.railGateOn(process.env)) {
    return false;
  }
  const out = stdout || process.stdout;
  let isTTY = !!(out && out.isTTY);
  if (!isTTY) {
    try {
      isTTY = !!require('./terminalCapabilities').detectCapabilities(out).isTTY;
    } catch {
      /* keep */
    }
  }
  if (!isTTY) {
    return false;
  }
  _state = {
    enabled: true,
    suspended: false,
    stdout: out,
    snapshot: _state.snapshot,
    lastGeom: null,
    lastPaintBytes: '',
    dims: _state.dims,
    lastValidDims: _state.lastValidDims,
    chrome: _state.chrome,
    scrollOffset: _state.scrollOffset,
    focusIndex: _state.focusIndex,
  };
  _installExitHook();
  return true;
}

function isEnabled() {
  return _state.enabled;
}

/**
 * Is the rail currently claiming terminal columns? Narrower than isEnabled():
 * false on a too-narrow terminal even when enabled. App reads this to decide
 * whether SidebarPanel leaves the ink tree.
 * @returns {boolean}
 */
function isActive() {
  return !!(_state.enabled && !_state.suspended && _geometry());
}

/**
 * Current viewport height in rows (阶段四): App reads this to feed useSidebarNav
 * `visibleRows`. 0 when the rail is inactive. Reads the last pushed geometry, so
 * App gets the PREVIOUS frame's height — an off-by-one-frame value that the nav
 * clamp math tolerates (the panel re-clamps the offset every paint anyway).
 * @returns {number}
 */
function viewportRows() {
  const g = _geometry();
  return g && g.height > 0 ? g.height : 0;
}

/**
 * Push the latest board props (App's `_sidebarProps`). Cheap value assignment —
 * the lines are only built when a paint actually happens, so the rail always
 * paints the newest snapshot even for frames triggered by unrelated writes.
 * @param {object|null} props
 */
function setSnapshot(props) {
  _state.snapshot = props || null;
}

/**
 * Push App's sticky-resolved terminal size (the SAME pair its ink tree was
 * narrowed against). Normalized here with the EXACT trichotomy of
 * sidebarLayout.stickyDim so the painter and the ink tree resolve identical
 * geometry:
 *  - finite positive number → floor(value), and cached as the last valid reading
 *  - null/undefined (size unknown) → reuse the last valid value (sticky, so a
 *    conpty oscillation frame keeps the board still) or null when there is no
 *    prior valid value → railGeometry substitutes the single-source fallback
 *  - NaN/0/negative (measured garbage) → 0 (geometry goes off) and NEVER cached
 * Cheap value assignment — no IO, no rebuild. Never throws (leaf-missing path
 * inlines the same trichotomy without stickiness).
 * @param {number|null|undefined} cols
 * @param {number|null|undefined} rows
 */
function setDims(cols, rows) {
  let stickyDim = null;
  try {
    stickyDim = require('../sidebarLayout').stickyDim;
  } catch {
    /* leaf unavailable */
  }
  const lv = _state.lastValidDims || { cols: null, rows: null };
  const resolve = (v, prevValid) => {
    if (typeof stickyDim === 'function') {
      return stickyDim(v, prevValid, process.env);
    }
    // Leaf unavailable → same trichotomy inline, minus the sticky reuse.
    if (v == null) {
      return null;
    }
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const c = resolve(cols, lv.cols);
  const r = resolve(rows, lv.rows);
  _state.dims = { cols: c, rows: r };
  // Cache ONLY valid readings — null (unknown) / 0 (garbage) must never overwrite
  // the last valid value the sticky branch falls back to (D1 caching contract).
  _state.lastValidDims = {
    cols: typeof c === 'number' && c > 0 ? c : lv.cols,
    rows: typeof r === 'number' && r > 0 ? r : lv.rows,
  };
}

/**
 * Push the footer chrome height so the board can BOTTOM-anchor (task #7): its
 * last row aligns with the input box's bottom border and the block hugs its
 * content growing UPWARD. App passes the SAME booleans it feeds
 * resolveStreamReserve; the row count is derived by the railLayout.railBottomChrome
 * pure leaf here (App only forwards params). Passing null/undefined restores the
 * legacy top-anchored fill. Cheap value assignment — no IO, no rebuild.
 * @param {{collabActive?: boolean, topicInFooter?: boolean}|number|null|undefined} chrome
 */
function setChrome(chrome) {
  if (chrome == null) {
    _state.chrome = null;
    return;
  }
  const n = typeof chrome === 'number' ? chrome : railLayout.railBottomChrome(chrome, process.env);
  _state.chrome = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Push the board nav state (阶段四): the clamped scroll offset and the selected
 * line index. App pushes this every frame (mirrors setDims/setChrome/setSnapshot)
 * from useSidebarNav; the values are consumed by _lines/paintBytes only when the
 * scroll/focus flags are on, so a legacy (flag-off) frame that never calls setNav
 * keeps the defaults (offset 0, index -1) → byte-identical paint. Cheap value
 * assignment — no IO, no rebuild. Never throws.
 * @param {{scrollOffset?: number, focusIndex?: number}|null} nav
 */
function setNav(nav) {
  if (nav == null) {
    _state.scrollOffset = 0;
    _state.focusIndex = -1;
    return;
  }
  const off = Math.floor(Number(nav.scrollOffset));
  const idx = Math.floor(Number(nav.focusIndex));
  _state.scrollOffset = Number.isFinite(off) && off > 0 ? off : 0;
  _state.focusIndex = Number.isFinite(idx) && idx >= 0 ? idx : -1;
}

/**
 * The bytes that paint the rail, to be appended to an ink frame write.
 * Returns '' whenever the rail must stay out of the way.
 * @param {boolean} [force=false] repaint even when the generated frame is unchanged
 * @returns {string}
 */
function paintBytes(force = false) {
  if (!_state.enabled || _state.suspended) {
    return '';
  }
  const fill = _geometry();
  if (!fill) {
    // 几何刚失效(变窄/行数不足):把上一次画过的槽位清掉一次,否则旧像素
    // 会留在不再归看板管的区域里。buildRailClear(null) → ''(无残留即无字节)。
    const prev = _state.lastGeom;
    _state.lastGeom = null;
    _state.lastPaintBytes = '';
    return railLayout.buildRailClear(prev);
  }
  let bg = null;
  try {
    bg = require('../sidebarLayout').sidebarBg(process.env);
  } catch {
    bg = null;
  }
  // Build lines against the FILL slot height (the max paintable rows), then
  // bottom-anchor hug: with a pushed chrome height, re-derive the geometry so the
  // board's LAST row sits on the input box's bottom border and the block hugs the
  // built line count, growing UPWARD. No chrome → legacy top-anchored fill.
  const lines = _lines(fill);
  const geom = _state.chrome == null ? fill : _hugGeometry(lines.length);
  if (!geom) {
    const prev = _state.lastGeom;
    _state.lastGeom = null;
    _state.lastPaintBytes = '';
    return railLayout.buildRailClear(prev);
  }
  let bytes = '';
  // Geometry changed since the last paint (resize / content grew or shrank in
  // bottom-anchor mode): wipe the OLD gutter first, then paint the new geometry.
  // The onResize hook is where the old+new union-clear happens (root cause B
  // fix); within one paint, only `old` cells exist on screen, so a plain
  // old-geometry clear here is complete and keeps the no-change path emitting
  // zero bytes (byte-revert guarantee of the lastPaintBytes dedupe).
  const prev = _state.lastGeom;
  if (
    prev &&
    (prev.left !== geom.left ||
      prev.width !== geom.width ||
      prev.height !== geom.height ||
      prev.top !== geom.top)
  ) {
    bytes += railLayout.buildRailClear(prev);
  }
  const border = _border(process.env);
  const painted = railLayout.buildRailPaint({
    lines,
    geom,
    bg,
    fit: _fit,
    border: border.str,
    borderCols: border.cols,
  });
  bytes += painted;
  // Ghost border: 边框不经内容流（border.cols === 0 && border.ghost），
  // 而是 CUP 绝对坐标叠加到看板左缘整列 —— 复制时不带走框线。
  // KHY_GHOST_BORDER off 时 border.ghost 恒为 false，本段逐字节无输出。
  if (border.ghost && geom.on) {
    bytes += _ghostBorderOverlay(geom, border.char);
  }
  _state.lastGeom = geom;
  if (!force && bytes === _state.lastPaintBytes) {
    return '';
  }
  _state.lastPaintBytes = bytes;
  return bytes;
}

/**
 * The bytes that BLANK the gutter, to be PREPENDED to an ink frame write —
 * i.e. BEFORE ink's own bytes (paintBytes goes after them). 残影根因修复:
 * ink 帧把新消息提交进 <Static> 时会滚屏,屏上已画的看板像素会随整屏一起被
 * 卷进 scrollback,重绘只覆盖当前视口 → 旧看板帧(旧主题/模型行)在回滚区
 * 反复堆叠。先清后写:滚动发生时槽位已是空白,卷上去的只有空格;帧尾
 * paintBytes 再画回最新内容。清 → 帧 → 画三段仍在同一次 write() 里落地,
 * 不存在「清了还没画」的可观察瞬间。No IO — 与 paintBytes 同契约。
 * @returns {string} '' when there is nothing to clear
 */
function clearBytes(force = false) {
  if (!_state.enabled || _state.suspended) {
    return '';
  }
  const cur = _geometry();
  const prev = _state.lastGeom;
  // No prior paint → nothing to blank.
  if (!prev) {
    return '';
  }
  // Geometry unchanged since the last paint and we already emitted it → the
  // gutter is blank-then-painted within that same write() (paintBytes cleared
  // the old cells before repainting), so nothing new to clear here. This is
  // the byte-revert dedupe: skip only when the stable frame is confirmed.
  if (!force && prev && cur && cur.on === prev.on &&
    prev.left === cur.left && prev.top === cur.top &&
    prev.width === cur.width && prev.height === cur.height &&
    _state.lastPaintBytes) {
    return '';
  }
  // Otherwise (geometry changed — resize/shrink, or a forced repaint) the
  // OLD geometry's gutter cells are stale and must be blanked by the caller
  // BEFORE the next frame's ink bytes. Clear the old slot, keep lastGeom so the
  // subsequent paintBytes() can paint the new geometry.
  return railLayout.buildRailClear(prev);
}

/**
 * Yield the gutter to an interactive sub-command (/model, /review …). Those own
 * the whole terminal after App calls app.clear(), so the rail must be GONE, not
 * merely stale.
 */
function suspend() {
  if (!_state.enabled || _state.suspended) {
    return;
  }
  _state.suspended = true;
  _writeRaw(railLayout.buildRailClear(_state.lastGeom));
  _state.lastGeom = null;
  _state.lastPaintBytes = '';
}

/** Counterpart to suspend(); the next ink frame repaints the rail. */
function resume() {
  if (!_state.enabled) {
    return false;
  }
  _state.suspended = false;
  return true;
}

/**
 * Resize hook. Clears the geometry the last paint used so a shrink cannot leave
 * cells behind, then lets the next frame paint the new geometry. Called from
 * App's resize effect, inside the same syncWrite coalescing window.
 */
function onResize() {
  if (!_state.enabled || _state.suspended) {
    return;
  }
  const prev = _state.lastGeom;
  const geom = _geometry();
  if (!prev) {
    return;
  }
  // P0-2 (root cause B): erase the UNION of old + new geometry in one pass, so
  // a shrink cannot leave stale cells in `old \ new`. When the union equals the
  // previous geometry (no visible change — e.g. only the terminal's height
  // grew) there is nothing new to wipe, so skip the write entirely.
  const union = railLayout.unionGeom(prev, geom);
  const same =
    prev.on === union.on &&
    prev.left === union.left &&
    prev.top === union.top &&
    prev.width === union.width &&
    prev.height === union.height;
  if (same) {
    return;
  }
  _writeRaw(railLayout.buildRailClear(union));
  _state.lastGeom = null;
  _state.lastPaintBytes = '';
}

/** Blank the gutter and tear down. Idempotent — safe on every exit path. */
function disable() {
  if (!_state.enabled) {
    _state.lastGeom = null;
    return;
  }
  _writeRaw(railLayout.buildRailClear(_state.lastGeom));
  _state = {
    enabled: false,
    suspended: false,
    stdout: null,
    snapshot: null,
    lastGeom: null,
    lastPaintBytes: '',
    dims: null,
    lastValidDims: null,
    chrome: null,
    scrollOffset: 0,
    focusIndex: -1,
  };
}

module.exports = {
  enable,
  isEnabled,
  isActive,
  setSnapshot,
  setDims,
  setChrome,
  setNav,
  paintBytes,
  clearBytes,
  suspend,
  resume,
  onResize,
  disable,
  viewportRows,
  _resetLazyCacheForTest,
};
