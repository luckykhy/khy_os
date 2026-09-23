'use strict';

/**
 * PromptFrame — bordered multi-line input area with a visible caret.
 *
 * Accepts the raw value plus a caret `offset` (UTF-16 index into value). The
 * caret line/column is derived locally so multi-line input (Shift+Enter or
 * pasted text) renders correctly with the cursor in the right place.
 *
 * ── Anti-spill (输入内容跑到输入框下方) ──────────────────────────────────────
 * Ink's incremental eraser counts the LOGICAL line count of the previous frame
 * (cursor-up + clear N lines). But the terminal HARD-WRAPS any rendered line
 * wider than the viewport into several VISUAL rows. If we hand Ink one logical
 * line that is wider than the terminal, Ink records "1 row" while the terminal
 * shows 2+, so the next repaint under-erases and the wrapped overflow of the
 * input persists BELOW the box — input bleeding into the output region. It is
 * intermittent because it only triggers once a single input line's width + the
 * "❯ " marker reaches the terminal margin (long input / narrow terminal).
 *
 * The border already dodges this with `cols - 1` slack; the input text did not.
 * The fix is to pre-wrap every input line to a width that fits within the
 * viewport (CJK-aware) and render EACH wrapped segment as its own row, so the
 * logical line count Ink erases always equals the visual rows the terminal
 * shows. `layoutPromptRows` is pure (no Ink) and exported for regression tests.
 *
 * ── Height cap (long-paste corollary) ───────────────────────────────────────
 * Per-line wrapping fixes WIDTH but trades it for HEIGHT: a multi-thousand-char
 * paste now wraps into dozens of rows. If the input box alone grows past the
 * viewport, Ink under-erases again — this time on the box itself. So when the
 * wrapped row count exceeds `maxRows`, we render a caret-centered WINDOW of rows
 * with dim "⋯" markers for the hidden head/tail. The full `value` is untouched
 * (no data loss — windowing is display-only, like any editor's scroll), the
 * caret row is always inside the window, and the box height is hard-bounded so
 * it can never overflow the viewport and displace itself.
 */
const React = require('react');

// 宽度单一真源(DESIGN-ARCH-103 P0-3 / H4/H8):组件不再自读 process.stdout,
// 边框宽度只从 props(width) 收 —— App 调一次 contentWidth() 下发全树。
// effectiveCols 仅作无 props 调用方(旧测试/直接渲染)的兜底,不再是主路径。
const { effectiveCols } = require('../effectiveCols');
const { clipCell, fitBorder, visWidth } = require('../wrapCell');
const inkRuntime = require('../inkRuntime');
// 有效列宽单一真源:右栏(railLayout)激活时 ink 只能画到 cols - 栏宽,整行边框若仍按
// 全宽拉就会伸进槽位。门控关 → 返回真实列宽 → 逐字节 legacy。

// Lazy CJK-aware width (string-width under the hood). Lazy + cached so the ink
// subtree doesn't pull formatters at module-load; falls back to code-unit length.
let _displayWidth = null;
function dwidth(s) {
  if (_displayWidth === null) {
    try {
      _displayWidth = require('../../formatters').displayWidth || false;
    } catch {
      _displayWidth = false;
    }
  }
  if (_displayWidth) {
    try {
      return _displayWidth(s);
    } catch {
      /* fall through */
    }
  }
  return String(s == null ? '' : s).length;
}

const MARKER_W = 2; // "❯ " (line 0) / "  " (continuation) — both 2 columns.
const MIC_COLS = 5; // ' MIC ' — inline on the first row only (see micInline below).
const BORDER_ROWS = 2; // 顶边框 + 底边框，各 1 视觉行。

/**
 * Legacy single-cell width reader, kept for the NO-props fallback path.
 * New call sites pass width/rows explicitly (H8); this only guards
 * direct-`ink.render(<PromptFrame/>)` without App wiring.
 */
function _legacyCols() {
  try {
    return effectiveCols(80);
  } catch {
    return 80;
  }
}

/**
 * Legacy rows reader (no-props fallback only). 102 §4.7: height =
 * clamp(floor(rows/3), 3, 10) — replaced the old `max(4, rows-10)`.
 */
function _legacyMaxRows() {
  const r =
    typeof process !== 'undefined' &&
    process.stdout &&
    Number(process.stdout.rows) > 0
      ? Math.floor(Number(process.stdout.rows))
      : 24;
  return Math.max(3, Math.min(10, Math.floor(r / 3)));
}

/**
 * 102 §4.7 行数预算：props.rows 给了就按 clamp(floor(rows/3),3,10)，
 * 无 props 走 _legacyMaxRows()。账本与 paint 共用此式（BUG-59：两处各写一份
 * 就会漂移，谁漂移谁少扣行）。
 */
function resolveMaxRows(rows) {
  const rowBudget = Number(rows) > 0 ? Math.floor(Number(rows)) : null;
  return rowBudget == null ? _legacyMaxRows() : Math.max(3, Math.min(10, Math.floor(rowBudget / 3)));
}

/**
 * Wrap a single logical line into width-bounded visual segments.
 *
 * Returns `[{ text, start, end }]` where start/end are UTF-16 offsets into
 * `line`. An empty line yields one empty segment so it still renders (and can
 * hold the caret). A lone char wider than `avail` is kept on its own segment
 * rather than looping forever (the `idx > segStart` guard).
 * @param {string} line
 * @param {number} avail max display width per segment (>=1)
 * @returns {Array<{text:string,start:number,end:number}>}
 */
function wrapByWidth(line, avail) {
  const cap = Math.max(1, avail | 0);
  if (line === '') {
    return [{ text: '', start: 0, end: 0 }];
  }
  const segs = [];
  let segStart = 0; // utf16 offset of current segment start
  let segW = 0; // display width accumulated in current segment
  let idx = 0; // running utf16 offset
  for (const ch of line) {
    const w = dwidth(ch);
    if (segW + w > cap && idx > segStart) {
      segs.push({ text: line.slice(segStart, idx), start: segStart, end: idx });
      segStart = idx;
      segW = 0;
    }
    segW += w;
    idx += ch.length;
  }
  segs.push({ text: line.slice(segStart, idx), start: segStart, end: idx });
  return segs;
}

/**
 * Pick a caret-centered window of `budget` total rows out of `lineRows`,
 * reserving slots for "⋯" markers when content is hidden above/below. Pure.
 *
 * Guarantees: the returned 'line' rows always include the caret row (if any);
 * total returned rows (lines + markers) never exceeds `budget`; and when a side
 * is truncated an `{kind:'ellipsis', side, hidden}` row marks it.
 *
 * @param {Array} lineRows the full, already-wrapped 'line' rows
 * @param {number} budget max total rows (>=1)
 * @returns {{rows:Array, truncatedAbove:boolean, truncatedBelow:boolean}}
 */
function windowRows(lineRows, budget) {
  const total = lineRows.length;
  const cap = Math.max(1, budget | 0);
  if (total <= cap) {
    return { rows: lineRows, truncatedAbove: false, truncatedBelow: false };
  }

  let caretIdx = lineRows.findIndex((r) => r.caretCol != null);
  if (caretIdx < 0) {
    // 无光标：占位符窗格锚在**头部**（提示语从头读才有意义），正文（busy 态无
    // 光标）仍锚尾部（要看最新输入）。
    caretIdx = lineRows.length && lineRows.every((r) => r.isPlaceholder) ? 0 : total - 1;
  }

  // Shrink the content window until it + its markers fit the budget. Two passes
  // converge: try `cap` content rows (likely both sides hidden → 2 markers →
  // overflow), then `cap - markers`, which fits. The caret row is always kept,
  // so content never drops below 1; at very tiny budgets the markers are dropped
  // rather than the caret (visibility wins over the truncation hint).
  let content = cap;
  for (let iter = 0; iter < 3; iter++) {
    content = Math.max(1, Math.min(content, cap, total));
    let start = caretIdx - Math.floor(content / 2);
    start = Math.max(0, Math.min(start, total - content));
    let end = start + content;
    // Guarantee the caret row is inside [start, end).
    if (caretIdx < start) {
      start = caretIdx;
      end = start + content;
    } else if (caretIdx >= end) {
      start = caretIdx - content + 1;
      end = start + content;
    }
    start = Math.max(0, start);
    end = Math.min(total, start + content);
    let above = start > 0;
    let below = end < total;
    let markers = (above ? 1 : 0) + (below ? 1 : 0);

    if (content + markers > cap && content > 1) {
      content = cap - markers; // shrink content to make room for the markers, retry
      continue;
    }
    // content is at the floor (1) — if markers still don't fit, drop them (below
    // first). The caret row is non-negotiable; the truncation hint is not.
    while (content + markers > cap && markers > 0) {
      if (below) {
        below = false;
      } else if (above) {
        above = false;
      }
      markers = (above ? 1 : 0) + (below ? 1 : 0);
    }
    const out = [];
    if (above) {
      out.push({ kind: 'ellipsis', side: 'above', hidden: start });
    }
    for (let i = start; i < end; i++) {
      out.push(lineRows[i]);
    }
    if (below) {
      out.push({ kind: 'ellipsis', side: 'below', hidden: total - end });
    }
    // truncated* reflect REAL hidden content, even when a marker was dropped.
    return { rows: out, truncatedAbove: start > 0, truncatedBelow: end < total };
  }
  // Defensive fallback (should be unreachable): the caret row alone.
  return {
    rows: [lineRows[caretIdx]],
    truncatedAbove: caretIdx > 0,
    truncatedBelow: caretIdx < total - 1,
  };
}

/**
 * Pure layout: turn (value, caret offset, terminal width) into the row model
 * the component renders. Guarantees that every 'line' row fits the viewport, so
 * logical rows == visual rows (no Ink under-erase → no input spill).
 *
 * When `maxRows` is given and the wrapped input exceeds it, the rows are reduced
 * to a caret-centered window (see windowRows) so the box height stays bounded —
 * `value` is never altered, only how much of it is displayed at once.
 *
 * @param {{value?:string, offset?:number, cols?:number, placeholder?:string, maxRows?:number, micCols?:number}} p
 * @returns {{rows:Array, lineRowCount:number, avail:number, truncatedAbove:boolean, truncatedBelow:boolean}}
 *   rows: [{ kind:'line', isFirstOfValue:bool, text:string, caretCol:number|null,
 *            isPlaceholder?:bool }
 *          | { kind:'ellipsis', side:'above'|'below', hidden:number }]
 *   lineRowCount: number of 'line' rows produced BEFORE windowing (the
 *     anti-spill invariant: equals total wrapped segments).
 */
function layoutPromptRows({
  value = '',
  offset = 0,
  cols = 80,
  placeholder = '',
  maxRows = 0,
  micCols = 0,
} = {}) {
  const width = Number(cols) > 0 ? Number(cols) : 80;
  // Reserve marker (2) + 1 caret cell + 1 margin slack so a row — even with the
  // trailing caret block on a full segment — never reaches the terminal's
  // pending-wrap cell (the same hazard the border avoids with cols-1).
  const avail = Math.max(1, width - MARKER_W - 2);

  const showPlaceholder = value.length === 0 && !!placeholder;
  const lines = value.split('\n');
  // 首行除了 marker 还内联 MIC(5 列)，占位符行再多一格反白光标 —— paint 与
  // billing 必须同源，否则 ink 按容器宽硬折，逻辑行 ≠ 视觉行(= 本文件顶部
  // anti-spill 段描述的那个「输入跑到框下方」)，且框高无从预算(BUG-59)。
  const firstAvail = Math.max(
    1,
    avail - Math.max(0, micCols | 0) - (showPlaceholder ? 1 : 0)
  );

  // Locate caret in (logical line, column) space — UTF-16, matching `offset`.
  let caretLine = 0;
  let caretCol = 0;
  {
    let remaining = Math.max(0, offset | 0);
    for (let i = 0; i < lines.length; i++) {
      if (remaining <= lines[i].length) {
        caretLine = i;
        caretCol = remaining;
        break;
      }
      remaining -= lines[i].length + 1; // +1 for the "\n"
      caretLine = i; // clamp: if offset overshoots, stay on the last line
      caretCol = lines[i].length;
    }
  }

  const rows = [];
  for (let li = 0; li < lines.length; li++) {
    const segs = wrapByWidth(lines[li], li === 0 ? firstAvail : avail);

    // Which wrapped segment holds the caret on this line? Prefer the segment
    // whose [start, end) contains caretCol; a caret exactly on a soft-wrap
    // boundary lands at the START of the next segment (editor-natural), and an
    // end-of-line caret stays on the final segment.
    let caretSeg = -1;
    if (li === caretLine) {
      caretSeg = segs.length - 1;
      for (let s = 0; s < segs.length; s++) {
        const isLast = s === segs.length - 1;
        if (caretCol < segs[s].end || (caretCol === segs[s].end && isLast)) {
          caretSeg = s;
          break;
        }
      }
    }

    for (let s = 0; s < segs.length; s++) {
      const isFirstOfValue = li === 0 && s === 0;
      if (showPlaceholder && isFirstOfValue) {
        // 占位文案按 BUG-12 裁决**整条折行、永不截断** —— 所以它必须和正文一样
        // 被切成「一段 = 一视觉行」，交给我们自己的行模型；此前它整串塞进一行，
        // 由 ink 去硬折，行数既不进 lineRowCount 也不进账本。
        const phSegs = wrapByWidth(placeholder, firstAvail);
        for (let ps = 0; ps < phSegs.length; ps++) {
          rows.push({
            kind: 'line',
            lineIndex: li,
            isFirstOfValue: ps === 0,
            text: phSegs[ps].text,
            caretCol: null,
            isPlaceholder: true,
          });
        }
        continue;
      }
      rows.push({
        kind: 'line',
        lineIndex: li,
        isFirstOfValue,
        text: segs[s].text,
        caretCol: s === caretSeg ? caretCol - segs[s].start : null,
      });
    }
  }

  // Height cap: when the wrapped input would overflow `maxRows`, show only a
  // caret-centered window (display-only; `value` and lineRowCount are unchanged).
  const lineRowCount = rows.length;
  const budget = Number(maxRows) > 0 ? Math.floor(Number(maxRows)) : 0;
  if (budget && lineRowCount > budget) {
    const win = windowRows(rows, budget);
    return {
      rows: win.rows,
      lineRowCount,
      avail,
      truncatedAbove: win.truncatedAbove,
      truncatedBelow: win.truncatedBelow,
    };
  }
  return { rows, lineRowCount, avail, truncatedAbove: false, truncatedBelow: false };
}

/**
 * One-slot memo over `layoutPromptRows` (same inputs ⇒ byte-identical rows).
 *
 * Why a module cache on top of the component's `React.useMemo`: the App ledger
 * now asks this leaf for the frame height on **every** render, and the component
 * asks for the rows on the same render. Without a shared cache that is two
 * O(buffer)-wide wraps per frame — exactly the heartbeat/keystroke lag the
 * in-component memo exists to prevent. Key includes the full `value`: building
 * the key is a memcpy, while the thing it protects (per-char display width) is
 * the expensive part.
 */
let _layoutCache = null;
function layoutPromptRowsCached(spec) {
  const key = [
    spec.value == null ? '' : spec.value,
    spec.offset | 0,
    spec.cols,
    spec.maxRows | 0,
    spec.micCols | 0,
    spec.placeholder == null ? '' : spec.placeholder,
  ].join('\u0000');
  if (_layoutCache && _layoutCache.key === key) return _layoutCache.result;
  const result = layoutPromptRows(spec);
  _layoutCache = { key, result };
  return result;
}

/**
 * 折叠提示行文案。它也必须只占 1 视觉行 —— 否则账本又少扣一行（同 BUG-59 根因）。
 * 宽终端下逐字节保持今日文案；装不下则退到短版，再退到按显示列截断。
 */
function ellipsisLabel(side, hidden, cols) {
  const head = `  ⋯ ${side === 'above' ? '上方' : '下方'}还有 ${hidden} 行`;
  const full = `${head}（输入已折叠，内容未丢失）`;
  const cap = Number(cols) > 0 ? Math.max(1, Math.floor(Number(cols)) - 2) : 0;
  if (!cap || visWidth(full) <= cap) return full;
  if (visWidth(head) <= cap) return head;
  return clipCell(head, cap);
}

/**
 * 帧高（视觉行）单一真源 —— 账本用它扣行，组件用它画行，两者不可能再漂移。
 * 纯函数、无 Ink：入参形状与 PromptFrame 的 props 一致。
 */
function frameRowCount({
  value = '',
  offset = 0,
  cols,
  placeholder = '',
  rows,
  mic = null,
} = {}) {
  const width = Number(cols) > 0 ? Math.floor(Number(cols)) : _legacyCols();
  const laid = layoutPromptRowsCached({
    value,
    offset,
    cols: width,
    placeholder,
    maxRows: resolveMaxRows(rows),
    micCols: mic ? MIC_COLS : 0,
  });
  return BORDER_ROWS + laid.rows.length;
}

function PromptFrame({
  value = '',
  offset = 0,
  busy,
  placeholder = '',
  accent = null,
  vimMode = null,
  mic = null,
  // ── DESIGN-ARCH-103 H8: dimensions come from App (contentWidth/contentHeight)
  // as props; the legacy stdout readers below are fallbacks only. ──
  width,
  rows,
}) {
  const rt = inkRuntime.get();
  const { Box, Text } = rt;
  const h = React.createElement;
  // Mic button hover state (mouse layer fires onMouseOver/onMouseOut; no mouse
  // events → stays false, harmless). Idle state survives App re-renders because
  // React keeps this component instance mounted across them.
  const [micHover, setMicHover] = React.useState(false);
  // Fix 1a — 系统 IME 真实光标跟随。ink 6.8.0 `useCursor().setCursorPosition({x,y})`
  // 让被藏起来的硬件光标锚到 caret 处,系统拼音候选窗便贴着输入位置弹出(截图诉求)。
  // hooks 规则要求无条件调用;`rt.useCursor` 进程内稳定(ink 只加载一次),旧版无此导出时
  // cursorApi=null → 永不设位置 = 光标恒隐藏 = 逐字节 legacy。
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const cursorApi = typeof rt.useCursor === 'function' ? rt.useCursor() : null;
  const caretRowRef = React.useRef(null);

  // H8: width only from props; the legacy reader is a no-props fallback.
  // `|| 0` lets falsy/absent props (0, undefined, null) drop to the legacy
  // reader instead of falling back to a stale hard-coded 80.
  const cols = Number(width) > 0 ? Math.floor(Number(width)) : _legacyCols();
  // H4: BOTH borders are produced by the SAME fitBorder() call shape, so they
  // are equal-width by construction. busy no longer dims/vanishes the border
  // (dim + undefined color ≈ invisible in some terminals) — it only switches
  // the gutter glyph '─' → '╌'.
  const borderColor = accent || 'cyan';
  const topBorderRow = fitBorder(cols, { left: '╭', right: '╮', busy });
  const bottomBorderRow = fitBorder(cols, { left: '╰', right: '╯', busy });

  // ── H4 dev assertion: machine-verifiable "border normal" check ────────────
  // Never throw during an ink frame (a throw would kill the whole tree) — a
  // dev stderr line is enough; prod stays silent.
  if (process.env.NODE_ENV !== 'production') {
    try {
      const ok = visWidth(topBorderRow) === cols && visWidth(bottomBorderRow) === cols;
      if (!ok) {
        process.stderr.write(
          `[PromptFrame] H4 border-width assert failed: top=${visWidth(topBorderRow)} bottom=${visWidth(bottomBorderRow)} width=${cols}\n`
        );
      }
    } catch {
      /* noop */
    }
  }

  // ── MIC 移出边框(DESIGN-ARCH-103 §4.4 修正 4)────────────────────────────
  // 旧实现在顶边框行内嵌 5 列 ` MIC ` Box 并把边框二次减法 `cols-1-5`,
  // 边界宽度下顶边框会断成两行。新结构:MIC 是输入行内的内联元素
  // (`❯ [MIC] …`),顶/底边框恒为完整 fitBorder(cols),等宽由构造保证。
  const micInline = mic
    ? h(
        Box,
        {
          onClick: mic.onClick,
          onMouseOver: () => setMicHover(true),
          onMouseOut: () => setMicHover(false),
        },
        h(
          Text,
          {
            color: mic.active ? 'white' : micHover ? 'black' : accent || 'cyan',
            backgroundColor: mic.active ? 'magenta' : micHover ? 'white' : undefined,
          },
          ' MIC '
        )
      )
    : null;
  const topBorder = h(Text, { color: borderColor }, topBorderRow);

  // In vim NORMAL the caret is a solid green block (vs. the default inverse
  // block); INSERT and non-vim keep the plain inverse caret.
  const caretProps = vimMode === 'NORMAL' ? { inverse: true, color: 'green' } : { inverse: true };

  // 高度钳制(102 §4.7):rows 来自 props(contentHeight);无 props 时兜底走
  // 102 公式 clamp(floor(rows/3),3,10),不再用 `rows - 10`。
  // 式子本身在 resolveMaxRows() —— 账本(frameRowCount)与 paint 共用同一份。
  const micCols = mic ? MIC_COLS : 0;
  const maxRows = resolveMaxRows(rows);

  // layoutPromptRows re-wraps the WHOLE buffer (O(len) string-width) — pure in
  // {value,offset,cols,placeholder,maxRows,micCols}. PromptFrame re-renders on
  // EVERY App state change (keystroke, 1s busy nowTick, hint/footer timers), so
  // without a memo a multi-KB paste sitting in the box gets re-wrapped on every
  // unrelated render = input/heartbeat lag. Memoize on those inputs
  // (byte-identical rows).
  // Gate KHY_PROMPT_LAYOUT_MEMO off → recompute every render (today's behavior).
  // useMemo is called unconditionally (hooks rule); its result is used only when
  // the gate is on, else we recompute directly = clean byte-revert.
  // 无论走哪条分支，layoutPromptRowsCached 都在：App 账本每帧也要一次行数，
  // 两处命中同一格缓存 ⇒ 每帧仍只有一次全缓冲折行。
  const _layoutMemoOn = require('./promptLayoutMemo').isPromptLayoutMemoEnabled(process.env);
  const _spec = { value, offset, cols, placeholder, maxRows, micCols };
  const _layoutMemoized = React.useMemo(() => layoutPromptRows(_spec), [
    value,
    offset,
    cols,
    placeholder,
    maxRows,
    micCols,
  ]);
  const { rows: inputRows } = _layoutMemoOn
    ? _layoutMemoized
    : layoutPromptRowsCached(_spec);
  const inputRowList = inputRows;

  // Fix 1a — 渲染期计算并设定真实光标绝对坐标。`setCursorPosition` 只写 ref(渲染期安全,
  // 见 ink use-cursor.js),读的是**上一帧已提交**布局(caretRowRef.current),一帧滞后对
  // IME 锚点无感、下次击键自纠。启用条件:门控开 && TTY && 非 busy && 非占位;任一不满足或
  // 沿 yoga 链求坐标抛错 → setCursorPosition(undefined) = 光标隐藏 = 现状(IME 不跟随)。
  if (cursorApi) {
    try {
      const caretGeometry = require('./caretGeometry');
      const placeholderActive = value.length === 0 && !!placeholder;
      const enabled =
        caretGeometry.imeCursorEnabled(process.env) &&
        !!process.stdout.isTTY &&
        !busy &&
        !placeholderActive;
      const caretRow = enabled
        ? inputRowList.find((r) => r.kind === 'line' && r.caretCol != null)
        : null;
      const node = caretRowRef.current;
      if (caretRow && node && node.yogaNode) {
        // 沿 parentNode 链累加 yoga 相对坐标 → 相对 Ink 输出原点的绝对 (x,y)。
        let absLeft = 0;
        let absTop = 0;
        for (let n = node; n && n.yogaNode; n = n.parentNode) {
          absLeft += Number(n.yogaNode.getComputedLeft()) || 0;
          absTop += Number(n.yogaNode.getComputedTop()) || 0;
        }
        const before = caretRow.text.slice(0, caretRow.caretCol);
        // 行内前缀 = marker(2) [+ MIC(5)，仅 ❯ 行]，yoga 链只给到行 Box 的左边界。
        const inlinePrefix = MARKER_W + (caretRow.isFirstOfValue ? micCols : 0);
        const x = absLeft + inlinePrefix + dwidth(before);
        cursorApi.setCursorPosition({ x, y: absTop });
      } else {
        cursorApi.setCursorPosition(undefined);
      }
    } catch {
      try {
        cursorApi.setCursorPosition(undefined);
      } catch {
        /* noop */
      }
    }
  }

  const renderRow = (row, idx) => {
    if (row.kind === 'ellipsis') {
      return h(
        Box,
        { key: `r${idx}` },
        h(Text, { dimColor: true }, ellipsisLabel(row.side, row.hidden, cols))
      );
    }

    // 对齐 layout-preview.html:输入框标记为绿色粗体 `>`,与预览图 prompt-marker 一致。
    // 注意:MARKER_W=2,故用 "> " 保持 2 列宽,与续行 "  " 对齐。
    const marker = row.isFirstOfValue
      ? h(Text, { bold: true, color: 'green' }, '> ')
      : h(Text, { dimColor: true }, '  ');

    // MIC 内联:仅第一行(❯ 行)在标记后插入,宽度预算不受边框切割影响。
    const micCell = row.isFirstOfValue && micInline ? micInline : null;

    if (row.isPlaceholder) {
      // 反白光标格只在占位文案的第一段前出现一次；续行是纯 dim 文本（行首 2 列
      // 由 marker 占位），与 layoutPromptRows 的 firstAvail/avail 分账一致。
      return h(
        Box,
        { key: `r${idx}` },
        marker,
        micCell,
        row.isFirstOfValue ? h(Text, { inverse: true }, ' ') : null,
        h(Text, { dimColor: true }, row.text || '')
      );
    }

    if (row.caretCol == null) {
      return h(Box, { key: `r${idx}` }, marker, micCell, h(Text, null, row.text || ''));
    }

    const col = row.caretCol;
    const before = row.text.slice(0, col);
    const cursorChar = col < row.text.length ? row.text[col] : ' ';
    const after = col < row.text.length ? row.text.slice(col + 1) : '';
    return h(
      Box,
      { key: `r${idx}`, ref: caretRowRef },
      marker,
      micCell,
      h(Text, null, before),
      h(Text, caretProps, cursorChar),
      h(Text, null, after)
    );
  };

  return h(
    Box,
    { flexDirection: 'column' },
    topBorder,
    ...inputRowList.map(renderRow),
    h(Text, { color: borderColor }, bottomBorderRow)
  );
}

PromptFrame.layoutPromptRows = layoutPromptRows;
PromptFrame.layoutPromptRowsCached = layoutPromptRowsCached;
PromptFrame.wrapByWidth = wrapByWidth;
PromptFrame.windowRows = windowRows;
PromptFrame.ellipsisLabel = ellipsisLabel;
PromptFrame.resolveMaxRows = resolveMaxRows;
// 账本真源：App.js 的 `_viewportHeight` 用它扣输入框行，组件用它画行。
PromptFrame.frameRowCount = frameRowCount;
PromptFrame.MIC_COLS = MIC_COLS;
PromptFrame.BORDER_ROWS = BORDER_ROWS;

module.exports = PromptFrame;
