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
const inkRuntime = require('../inkRuntime');

// Lazy CJK-aware width (string-width under the hood). Lazy + cached so the ink
// subtree doesn't pull formatters at module-load; falls back to code-unit length.
let _displayWidth = null;
function dwidth(s) {
  if (_displayWidth === null) {
    try { _displayWidth = require('../../formatters').displayWidth || false; }
    catch { _displayWidth = false; }
  }
  if (_displayWidth) {
    try { return _displayWidth(s); } catch { /* fall through */ }
  }
  return String(s == null ? '' : s).length;
}

const MARKER_W = 2; // "❯ " (line 0) / "  " (continuation) — both 2 columns.

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
  if (line === '') return [{ text: '', start: 0, end: 0 }];
  const segs = [];
  let segStart = 0; // utf16 offset of current segment start
  let segW = 0;     // display width accumulated in current segment
  let idx = 0;      // running utf16 offset
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
  if (total <= cap) return { rows: lineRows, truncatedAbove: false, truncatedBelow: false };

  let caretIdx = lineRows.findIndex((r) => r.caretCol != null);
  if (caretIdx < 0) caretIdx = total - 1; // no caret (e.g. busy) → anchor on the tail

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
    if (caretIdx < start) { start = caretIdx; end = start + content; }
    else if (caretIdx >= end) { start = caretIdx - content + 1; end = start + content; }
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
      if (below) below = false; else if (above) above = false;
      markers = (above ? 1 : 0) + (below ? 1 : 0);
    }
    const out = [];
    if (above) out.push({ kind: 'ellipsis', side: 'above', hidden: start });
    for (let i = start; i < end; i++) out.push(lineRows[i]);
    if (below) out.push({ kind: 'ellipsis', side: 'below', hidden: total - end });
    // truncated* reflect REAL hidden content, even when a marker was dropped.
    return { rows: out, truncatedAbove: start > 0, truncatedBelow: end < total };
  }
  // Defensive fallback (should be unreachable): the caret row alone.
  return { rows: [lineRows[caretIdx]], truncatedAbove: caretIdx > 0, truncatedBelow: caretIdx < total - 1 };
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
 * @param {{value?:string, offset?:number, cols?:number, placeholder?:string, maxRows?:number}} p
 * @returns {{rows:Array, lineRowCount:number, avail:number, truncatedAbove:boolean, truncatedBelow:boolean}}
 *   rows: [{ kind:'line', isFirstOfValue:bool, text:string, caretCol:number|null,
 *            isPlaceholder?:bool, placeholder?:string }
 *          | { kind:'ellipsis', side:'above'|'below', hidden:number }]
 *   lineRowCount: number of 'line' rows produced BEFORE windowing (the
 *     anti-spill invariant: equals total wrapped segments).
 */
function layoutPromptRows({ value = '', offset = 0, cols = 80, placeholder = '', maxRows = 0 } = {}) {
  const width = (Number(cols) > 0 ? Number(cols) : 80);
  // Reserve marker (2) + 1 caret cell + 1 margin slack so a row — even with the
  // trailing caret block on a full segment — never reaches the terminal's
  // pending-wrap cell (the same hazard the border avoids with cols-1).
  const avail = Math.max(1, width - MARKER_W - 2);

  const showPlaceholder = value.length === 0 && !!placeholder;
  const lines = value.split('\n');

  // Locate caret in (logical line, column) space — UTF-16, matching `offset`.
  let caretLine = 0;
  let caretCol = 0;
  {
    let remaining = Math.max(0, offset | 0);
    for (let i = 0; i < lines.length; i++) {
      if (remaining <= lines[i].length) { caretLine = i; caretCol = remaining; break; }
      remaining -= lines[i].length + 1; // +1 for the "\n"
      caretLine = i; // clamp: if offset overshoots, stay on the last line
      caretCol = lines[i].length;
    }
  }

  const rows = [];
  for (let li = 0; li < lines.length; li++) {
    const segs = wrapByWidth(lines[li], avail);

    // Which wrapped segment holds the caret on this line? Prefer the segment
    // whose [start, end) contains caretCol; a caret exactly on a soft-wrap
    // boundary lands at the START of the next segment (editor-natural), and an
    // end-of-line caret stays on the final segment.
    let caretSeg = -1;
    if (li === caretLine) {
      caretSeg = segs.length - 1;
      for (let s = 0; s < segs.length; s++) {
        const isLast = s === segs.length - 1;
        if (caretCol < segs[s].end || (caretCol === segs[s].end && isLast)) { caretSeg = s; break; }
      }
    }

    for (let s = 0; s < segs.length; s++) {
      const isFirstOfValue = li === 0 && s === 0;
      if (showPlaceholder && isFirstOfValue) {
        rows.push({ kind: 'line', lineIndex: li, isFirstOfValue: true, text: '', caretCol: null, isPlaceholder: true, placeholder });
        continue;
      }
      rows.push({
        kind: 'line',
        lineIndex: li,
        isFirstOfValue,
        text: segs[s].text,
        caretCol: s === caretSeg ? (caretCol - segs[s].start) : null,
      });
    }
  }

  // Height cap: when the wrapped input would overflow `maxRows`, show only a
  // caret-centered window (display-only; `value` and lineRowCount are unchanged).
  const lineRowCount = rows.length;
  const budget = Number(maxRows) > 0 ? Math.floor(Number(maxRows)) : 0;
  if (budget && lineRowCount > budget) {
    const win = windowRows(rows, budget);
    return { rows: win.rows, lineRowCount, avail, truncatedAbove: win.truncatedAbove, truncatedBelow: win.truncatedBelow };
  }
  return { rows, lineRowCount, avail, truncatedAbove: false, truncatedBelow: false };
}

function PromptFrame({ value = '', offset = 0, busy, placeholder = '', accent = null, vimMode = null }) {
  const rt = inkRuntime.get();
  const { Box, Text } = rt;
  const h = React.createElement;
  // Fix 1a — 系统 IME 真实光标跟随。ink 6.8.0 `useCursor().setCursorPosition({x,y})`
  // 让被藏起来的硬件光标锚到 caret 处,系统拼音候选窗便贴着输入位置弹出(截图诉求)。
  // hooks 规则要求无条件调用;`rt.useCursor` 进程内稳定(ink 只加载一次),旧版无此导出时
  // cursorApi=null → 永不设位置 = 光标恒隐藏 = 逐字节 legacy。
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const cursorApi = typeof rt.useCursor === 'function' ? rt.useCursor() : null;
  const caretRowRef = React.useRef(null);
  const cols = (process.stdout.columns || 80);
  const borderColor = busy ? undefined : (accent || 'cyan');
  // Leave one cell of slack: a separator that is EXACTLY the terminal width sits
  // on the auto-wrap margin, where many emulators hold the cursor in a "pending
  // wrap" state, making the terminal's row count disagree with ink's logical-line
  // count and leaving residual lines on reflow. `cols - 1` keeps the rule visually
  // full-width without tripping it. The input rows below use the same principle
  // via layoutPromptRows (marker + caret + slack reserved).
  const border = '─'.repeat(Math.max(1, cols - 1));
  // In vim NORMAL the caret is a solid green block (vs. the default inverse
  // block); INSERT and non-vim keep the plain inverse caret.
  const caretProps = vimMode === 'NORMAL'
    ? { inverse: true, color: 'green' }
    : { inverse: true };

  // Cap the input box height so a huge paste can't grow the box past the
  // viewport and displace itself (the same anti-staircase rule StreamingBlock
  // applies). Leave headroom for the streaming preview above and the footer /
  // completion menu below; never below 4 so short input is always fully shown.
  const vrows = (process.stdout.rows && process.stdout.rows > 0) ? process.stdout.rows : 24;
  const maxRows = Math.max(4, vrows - 10);

  // layoutPromptRows re-wraps the WHOLE buffer (O(len) string-width) — pure in
  // {value,offset,cols,placeholder,maxRows}. PromptFrame re-renders on EVERY App
  // state change (keystroke, 1s busy nowTick, hint/footer timers), so without a
  // memo a multi-KB paste sitting in the box gets re-wrapped on every unrelated
  // render = input/heartbeat lag. Memoize on those inputs (byte-identical rows).
  // Gate KHY_PROMPT_LAYOUT_MEMO off → recompute every render (today's behavior).
  // useMemo is called unconditionally (hooks rule); its result is used only when
  // the gate is on, else we recompute directly = clean byte-revert.
  const _layoutMemoOn = require('./promptLayoutMemo').isPromptLayoutMemoEnabled(process.env);
  const _layoutMemoized = React.useMemo(
    () => layoutPromptRows({ value, offset, cols, placeholder, maxRows }),
    [value, offset, cols, placeholder, maxRows],
  );
  const { rows } = _layoutMemoOn
    ? _layoutMemoized
    : layoutPromptRows({ value, offset, cols, placeholder, maxRows });

  // Fix 1a — 渲染期计算并设定真实光标绝对坐标。`setCursorPosition` 只写 ref(渲染期安全,
  // 见 ink use-cursor.js),读的是**上一帧已提交**布局(caretRowRef.current),一帧滞后对
  // IME 锚点无感、下次击键自纠。启用条件:门控开 && TTY && 非 busy && 非占位;任一不满足或
  // 沿 yoga 链求坐标抛错 → setCursorPosition(undefined) = 光标隐藏 = 现状(IME 不跟随)。
  if (cursorApi) {
    try {
      const caretGeometry = require('./caretGeometry');
      const placeholderActive = value.length === 0 && !!placeholder;
      const enabled = caretGeometry.imeCursorEnabled(process.env)
        && !!process.stdout.isTTY && !busy && !placeholderActive;
      const caretRow = enabled ? rows.find((r) => r.kind === 'line' && r.caretCol != null) : null;
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
        const x = absLeft + MARKER_W + dwidth(before);
        cursorApi.setCursorPosition({ x, y: absTop });
      } else {
        cursorApi.setCursorPosition(undefined);
      }
    } catch {
      try { cursorApi.setCursorPosition(undefined); } catch { /* noop */ }
    }
  }

  const renderRow = (row, idx) => {
    if (row.kind === 'ellipsis') {
      const label = row.side === 'above'
        ? `  ⋯ 上方还有 ${row.hidden} 行（输入已折叠，内容未丢失）`
        : `  ⋯ 下方还有 ${row.hidden} 行（输入已折叠，内容未丢失）`;
      return h(Box, { key: `r${idx}` }, h(Text, { dimColor: true }, label));
    }

    const marker = row.isFirstOfValue
      ? h(Text, { bold: true, color: accent || 'cyan' }, '❯ ')
      : h(Text, { dimColor: true }, '  ');

    if (row.isPlaceholder) {
      return h(Box, { key: `r${idx}` }, marker,
        h(Text, { inverse: true }, ' '),
        h(Text, { dimColor: true }, row.placeholder)
      );
    }

    if (row.caretCol == null) {
      return h(Box, { key: `r${idx}` }, marker, h(Text, null, row.text || ''));
    }

    const col = row.caretCol;
    const before = row.text.slice(0, col);
    const cursorChar = col < row.text.length ? row.text[col] : ' ';
    const after = col < row.text.length ? row.text.slice(col + 1) : '';
    return h(Box, { key: `r${idx}`, ref: caretRowRef }, marker,
      h(Text, null, before),
      h(Text, caretProps, cursorChar),
      h(Text, null, after)
    );
  };

  return h(Box, { flexDirection: 'column' },
    h(Text, { color: borderColor, dimColor: busy }, border),
    ...rows.map(renderRow),
    h(Text, { color: borderColor, dimColor: busy }, border)
  );
}

PromptFrame.layoutPromptRows = layoutPromptRows;
PromptFrame.wrapByWidth = wrapByWidth;
PromptFrame.windowRows = windowRows;

module.exports = PromptFrame;
