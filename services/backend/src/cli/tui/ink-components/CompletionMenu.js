'use strict';

/**
 * CompletionMenu — inline dropdown for slash-command and @file completion.
 * Visual model follows Claude Code: a bordered list under the prompt, the
 * selected row highlighted, command/description in two columns.
 *
 * Features:
 * - ESC exits cleanly (no residual traces via React unmount)
 * - Standardized format with border, two-column layout
 * - Page navigation with PageUp/PageDown or [/] keys
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');
// 折叠/裁剪的计费口径与另两个选择器同源：视觉行 = wrapCell.visualRows。
const { clipCell, visualRows, visWidth } = require('../wrapCell');

const MAX_VISIBLE = 10;
const ITEMS_PER_PAGE = MAX_VISIBLE;
// 圆角边框 2 + paddingX 1×2：框内可用列 = cols − marginLeft − 本常量。
const BOX_CHROME_COLS = 4;
// 圆角边框 2 + 页脚 1：一页至少占 3 视觉行 ⇒ 高度预算先减它才得到「能画几条」。
const BOX_CHROME_ROWS = 3;
// 一个框最低 4 行（边框 2 + 1 条 + 页脚 1）。预算低于它就不是「少画几条」而是
// 「画不下」—— 那时整框让位（渲染 null、账本 0 行），把行留给转录与输入框：
// 补全看不见还能重敲，转录被 ink 的 fullscreen 清屏抹掉才是真丢了东西。
const MIN_FRAME_ROWS = BOX_CHROME_ROWS + 1;

/**
 * 页脚那一行的文案 —— 也是**账本**的一部分：它在 40 列下会从 1 行折成 2 行，
 * 少扣一行就等于主内容槽多报一行(BUG-59 同族，见 BUG-60)。
 * 退档阶梯照 BUG-58 的做法：整句 → 去种类前缀 → 去选择键 → 只剩退出键 → 按显示列截断。
 * 「Esc 取消」永远优先留在屏上，页码次之（用户先看怎么退，再看自己在第几页）。
 */
function footerLabel(kind, page, totalPages, innerCols) {
  const kindName = kind === 'slash' ? '斜杠命令' : '文件';
  const pg = `${page + 1}/${totalPages}`;
  const cands = [
    `  ${kindName} · ${pg} · Tab/Enter 选择 · Esc 取消`,
    `  ${pg} · Tab/Enter 选择 · Esc 取消`,
    `  ${pg} · Esc 取消`,
    `  Esc 取消`,
  ];
  const cap = Number(innerCols) > 0 ? Math.floor(Number(innerCols)) : 0;
  if (!cap) return cands[0];
  for (const t of cands) if (visWidth(t) <= cap) return t;
  return clipCell(cands[cands.length - 1], cap);
}

/**
 * 一页能画几条 —— 宽度与**高度**双约束。改前只按 `ITEMS_PER_PAGE=10` 定页，
 * 于是 10 行高的终端里一个框 = 边框 2 + 10 + 页脚 1 = 13 行，比屏还高：
 * ink 走 fullscreen 清屏，用户敲 `/` 后连输入框一起看不见(BUG-60 的矮屏分支)。
 * `maxRows` 是账本给这个框留出的行数；未知(0/undefined)→ 逐字节保持今日 10 条一页。
 */
function perPageFor(maxRows) {
  const cap = Number(maxRows) > 0 ? Math.floor(Number(maxRows)) : 0;
  if (!cap) return ITEMS_PER_PAGE;
  return Math.max(1, Math.min(ITEMS_PER_PAGE, cap - BOX_CHROME_ROWS));
}

/**
 * 「这个预算画得下框吗」—— 账本与 paint 共用同一判据(见 `MIN_FRAME_ROWS`)。
 * 预算未知(0/undefined)→ 视作不受高度约束，逐字节保持今日形态。
 */
function frameFits(maxRows) {
  const cap = Number(maxRows) > 0 ? Math.floor(Number(maxRows)) : 0;
  return !cap || cap >= MIN_FRAME_ROWS;
}

/**
 * 横向下预算 —— 账本与 paint 的**唯一**几何来源。一条形如
 * `marker(2) + label + gap(2) + desc`，四者相加必须 ≤ 框内宽，否则 ink 把这条
 * 折成 2 视觉行：帧高就成了宽度的函数，而 `menuRowCount` 按「一条 = 一行」记账
 * 会当场失真(BUG-60 在 20 列实测 28 画 / 4 记)。改前 label 栏固定钳到 28、
 * desc 栏有 `Math.max(8, …)` 的地板，窄槽里两栏一起顶穿框内宽。
 * `descMax`：null = 宽度未知走 legacy 不钳；0 = 整栏消失；>0 = 钳到该列数。
 */
function menuGeom({ completion, page = 0, cols, marginLeft = 0, maxRows = 0 } = {}) {
  const items = (completion && Array.isArray(completion.items) && completion.items) || [];
  const total = items.length;
  const perPage = perPageFor(maxRows);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.max(0, Math.min(Math.floor(Number(page)) || 0, totalPages - 1));
  const pageStart = currentPage * perPage;
  const visible = items.slice(pageStart, Math.min(total, pageStart + perPage));
  const inner =
    Number.isFinite(cols) && Number(cols) > 0
      ? Math.max(1, Math.floor(Number(cols)) - (Math.max(0, Number(marginLeft) || 0) + BOX_CHROME_COLS))
      : 0;
  const widestLabel = visible.reduce((w, it) => Math.max(w, visWidth(it.label || '')), 0);
  if (!inner) {
    return {
      visible,
      currentPage,
      totalPages,
      perPage,
      inner: 0,
      labelWidth: Math.min(28, widestLabel),
      descMax: null,
    };
  }
  const labelWidth = Math.max(1, Math.min(28, widestLabel, inner - 2));
  const budget = inner - 4 - labelWidth;
  // 一栏至少 8 显示列才读得出东西，不如整栏让位给条目本身。
  return { visible, currentPage, totalPages, perPage, inner, labelWidth, descMax: budget >= 8 ? budget : 0 };
}

/**
 * 帧高（视觉行）单一真源：`App.js` 的 `_viewportHeight` 用它扣行，
 * 组件用它画行。入参形状与 CompletionMenu 的 props 一致。
 * 每条 item 恰好 1 视觉行（`menuGeom` 已保证一条 ≤ 框内宽），页脚按 `inner` 计折行。
 */
function menuRowCount({ completion, page = 0, cols, marginLeft = 0, maxRows = 0 } = {}) {
  if (!completion || !completion.active || !Array.isArray(completion.items) || completion.items.length === 0) {
    return 0;
  }
  // 画不下 = 一帧都不占（组件同一判据 return null），账本随之归零。
  if (!frameFits(maxRows)) return 0;
  const g = menuGeom({ completion, page, cols, marginLeft, maxRows });
  const footerRows = g.inner ? visualRows(footerLabel(completion.kind, g.currentPage, g.totalPages, g.inner), g.inner) : 1;
  return g.visible.length + footerRows + 2;
}

function CompletionMenu({ completion, selectedIndex, marginLeft = 0, page = 0, cols, maxRows = 0 }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!completion || !completion.active || completion.items.length === 0) {
    return null;
  }
  if (!frameFits(maxRows)) return null;

  // Both columns of a row must be budgeted in **display columns** (CJK = 2), not
  // UTF-16 units, and each column must be clamped to its own budget. `padEnd`
  // counts units, so a Chinese @file label was under-padded (description column
  // drifted per row) and inflated the description budget by the same amount —
  // re-introducing exactly the wrap-and-misalign the clamp below exists to
  // prevent. A label wider than the cap likewise escaped clamping. (BUG-47)
  let fmt = null;
  try {
    fmt = require('../../formatters');
  } catch {
    fmt = null; // fail-soft: fall back to the legacy unit-based accounting
  }
  const _clip = (s, w) => (fmt && fmt.displayWidth(s) > w ? fmt.truncateToWidth(s, w) : s);
  const _pad = (s, w) => (fmt ? fmt.padToWidth(s, w) : String(s).padEnd(w));

  // Geometry comes from the same pure function the ledger bills with: page clamping,
  // visible slice, label column width, the description budget and the height-budgeted
  // page size (BUG-60).
  const g = menuGeom({ completion, page, cols, marginLeft, maxRows });
  const { visible, currentPage, totalPages, labelWidth, descMax } = g;
  const pageStart = currentPage * g.perPage;

  // A long description overflows the row and Ink wraps it onto a continuation
  // line that starts at the box's left edge — misaligned under the description
  // column (visible for e.g. `/advisor`). When a real terminal width is known,
  // clamp each description to one display line so rows never wrap; when even the
  // clamped column would not fit, the description is dropped for that frame
  // rather than buying height with it. Without `cols` the old behavior is
  // preserved byte-for-byte (`descMax === null`).
  const rows = visible.map((it, i) => {
    const idx = pageStart + i;
    const selected = idx === selectedIndex;
    const label = _pad(_clip(it.label || '', labelWidth), labelWidth);
    let desc = it.desc;
    if (descMax === 0) desc = null;
    else if (fmt && descMax > 0 && desc && fmt.displayWidth(desc) > descMax) {
      desc = fmt.truncateToWidth(desc, descMax);
    }
    return h(
      Box,
      { key: it.value || idx },
      h(
        Text,
        { color: selected ? 'black' : 'cyan', backgroundColor: selected ? 'cyan' : undefined },
        (selected ? '› ' : '  ') + label
      ),
      desc ? h(Text, { dimColor: true }, '  ' + desc) : null
    );
  });

  // marginLeft 让下拉横向对齐输入光标列(Fix 1b,门控 KHY_COMPLETION_FOLLOW_CURSOR
  // 在 App.js 侧判定;关时传 0 → 贴左=逐字节 legacy)。Math.max 防负值兜底。
  const margin = Math.max(0, Number(marginLeft) || 0);
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'gray',
      paddingX: 1,
      marginLeft: margin,
    },
    ...rows,
    h(Text, { dimColor: true }, footerLabel(completion.kind, currentPage, totalPages, g.inner))
  );
}

CompletionMenu.menuRowCount = menuRowCount;
CompletionMenu.footerLabel = footerLabel;
CompletionMenu.menuGeom = menuGeom;
CompletionMenu.perPageFor = perPageFor;
CompletionMenu.frameFits = frameFits;
CompletionMenu.ITEMS_PER_PAGE = ITEMS_PER_PAGE;
CompletionMenu.BOX_CHROME_COLS = BOX_CHROME_COLS;
CompletionMenu.BOX_CHROME_ROWS = BOX_CHROME_ROWS;
CompletionMenu.MIN_FRAME_ROWS = MIN_FRAME_ROWS;

module.exports = CompletionMenu;
