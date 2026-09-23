'use strict';

/**
 * HelpMenu — keyboard shortcut reference, toggled with "?" on an empty prompt.
 * Mirrors Claude Code's PromptInputHelpMenu content, scoped to KHY bindings.
 */
const React = require('react');

const keybindingCatalog = require('../../../services/keybindings');
const inkRuntime = require('../inkRuntime');
const { clipCell, visualRows, pickerRowBudget, visWidth } = require('../wrapCell');
// 键位单一真源:精简浮层与 /keybindings 完整列举同源此叶子,绝不在此再内联一份。

// 显示宽度对齐 + 键列紧凑化(2026-09-19 BUG-11):
//   ① 原实现 padEnd(keyWidth+2) 按**字符数**对齐,而键列含「↑ / ↓」、描述列含
//      CJK——终端显示宽度≠字符数,视觉上 gaps 忽宽忽窄。改用全渲染层显示宽度
//      SSOT(formatters.displayWidth,经 displayWidthMemo 记忆)按列宽对齐。
//   ② catalog 标签统一「Ctrl + C」带空格风格,长键(如「Shift/Alt + Enter」)把
//      键列撑到 17+ 字符,右侧描述被推远、整面板难扫读。仅在**本浮层的键列**
//      剥掉 '+' 两侧空格(Ctrl+C / Shift/Alt+Enter),信息零丢失;catalog
//      单一真源与 /keybindings 完整列表不动。键宽按当前条目动态取最大值,
//      故 catalog 改键位(BUG-35 后精简组为「Ctrl + J」)无需同步此处。
const _compactKey = (k) => String(k).replace(/\s*\+\s*/g, '+');
const _dw = (s) => {
  try {
    const { getDisplayWidth } = require('../../displayWidthMemo');
    const { displayWidth } = require('../../formatters');
    return getDisplayWidth(String(s), displayWidth);
  } catch {
    return String(s).length; // fail-soft:退回字符数
  }
};

const SHORTCUTS = keybindingCatalog.keybindingCatalog.getEssentialShortcuts();

/**
 * `cols`/`rows` = App.js 给它的那块**内容槽**的尺寸（它替换的是主视口，不是覆盖屏）。
 * 都不传时逐字节保持今日形态。
 */
function HelpMenu({ cols, rows } = {}) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  const keyWidth = Math.max(...SHORTCUTS.map(([k]) => _dw(_compactKey(k))));

  // 一 item 一视觉行 + 帧高不超过内容槽(BUG-58)：描述列是中文一句话（最宽 43 显示列），
  // 40 列终端上长项折成 2 行 ⇒ 整框从 18 涨到 20 行（30 列 24 行），而内容槽的预算
  // (App.js `_viewportHeight`，实测 80×24 下 = 18) 不随宽度缩小 —— 超出部分被 ink 的
  // 整屏重画推走，框的顶边框先掉。窄屏时优先收缩**行**（清单是摘要，全量在 /keybindings），
  // 收缩不了才截**列**。两者都必须让用户看得出少看了什么。
  const r = Math.floor(Number(rows));
  const hasR = Number.isFinite(r) && r > 0;

  // 键列定宽：pad 公式让每条 key 恰好占 keyWidth + 2 列，所以描述预算可一次算好。
  const keyCol = keyWidth + 2;
  const innerCols = Number(cols) > 0 ? Math.max(1, Math.floor(Number(cols)) - 4) : 0; // 2 边框 + paddingX 1×2
  // 预算走 wrapCell 的同一把尺（太窄时返回 0 = 不裁，宁折行也不留一排省略号）。
  const descBudget = pickerRowBudget(Number(cols) || 0, ' '.repeat(keyCol), '');

  const items = SHORTCUTS.map(([k, d]) => {
    const key = _compactKey(k);
    const pad = ' '.repeat(Math.max(1, keyWidth - _dw(key) + 2));
    return { key: key + pad, desc: descBudget > 0 ? clipCell(d, descBudget) : d };
  });

  // 「还有 N 条」必须自己占一行：整句在 40 列(内宽 36)下是 44 显示列，直接裁会把
  // `/keybindings` 从中间截断（`/keybinding…`），指针反而读不懂。所以逐级换短版本，
  // 只有连命令名本身都放不下时才裁。
  const hintOf = (n) => {
    const cands = [
      `… 另有 ${n} 条快捷键，运行 /keybindings 看全量`,
      `… 另有 ${n} 条 · /keybindings`,
      `/keybindings`,
    ];
    for (const t of cands) if (visWidth(t) <= innerCols) return t;
    return clipCell(cands[cands.length - 1], innerCols);
  };
  // 上下边框 2 + 标题行 + 清单 + 可选的「还有 N 条」。行高一律按同一把尺折行计数，
  // 不假设「一条 = 一行」——那个假设正是本缺陷的成因。
  function projectedRows(n, withHint) {
    if (!hasR || !innerCols) return 0;
    const list = items.slice(0, n).reduce((a, it) => a + visualRows(`${it.key}${it.desc}`, innerCols), 0);
    return 2 + visualRows('键盘快捷键', innerCols) + list + (withHint ? visualRows(hintOf(SHORTCUTS.length - n), innerCols) : 0);
  }

  let shown = items.length;
  let hiddenHint = null;
  if (hasR && innerCols > 0 && projectedRows(shown, false) > r) {
    while (shown > 1 && projectedRows(shown, true) > r) shown -= 1;
    hiddenHint = hintOf(SHORTCUTS.length - shown);
  }

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
    h(Text, { bold: true }, '键盘快捷键'),
    ...items.slice(0, shown).map((it, i) => h(
      Box,
      { key: i },
      h(Text, { color: 'cyan' }, it.key),
      h(Text, { dimColor: true }, it.desc)
    )),
    hiddenHint ? h(Text, { dimColor: true }, hiddenHint) : null
  );
}

module.exports = HelpMenu;
