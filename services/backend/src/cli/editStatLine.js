'use strict';

/**
 * editStatLine.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 承 Goal(Thread 4)「不只显示对齐,更要 CC 显示背后的**后端逻辑**对齐」
 * (CC 源 /tmp/cc-src/claude-code-main)。这一刀对齐的是 CC
 * `src/components/FileEditToolUpdatedMessage.tsx` 里编辑结果摘要行
 *   Added <N> lines, removed <M> lines
 * 的**构造逻辑**——尤其是它一处刻意的语法规则:
 *
 *   {numAdditions === 0 ? 'R' : 'r'}emoved <M> line(s)
 *
 * 即:当本次编辑**只有删除没有新增**(additions === 0)时,"Removed" 是整句**句首**,
 * CC 把它**首字母大写**;而当它跟在 "Added N lines, " 之后(additions > 0)时,作为
 * 后半句保持**小写** "removed"。
 *
 * 真缺口(对照后):Khy 三处渲染路径各自 copy-paste 了**同一份** statParts 构造:
 *   - cli/toolDisplay.js(经典 REPL printFileOperation 的 ⎿ 结果行)
 *   - cli/diffRenderer.js(renderDiff 的 └ 统计页脚)
 *   - cli/tui/ink-components/ToolLines.js(TUI └ stat 行)
 * 三份都**恒用小写** `removed`:
 *   if (removed > 0) statParts.push(`removed ${removed} line${removed !== 1 ? 's' : ''}`);
 * → 纯删除编辑(added === 0)会渲染成句首小写的 "removed 3 lines",
 *   与 CC 的 "Removed 3 lines" 不一致。本叶子把这份构造收敛成**单一真源**并补上
 *   CC 的大小写规则,三处 call-site 都改调本叶子。
 *
 * 复数:CC 用 `numRemovals > 1 ? 'lines' : 'line'`;legacy 三处用 `removed !== 1 ? 's' : ''`。
 * 在被守卫的取值域(n > 0)内两者**完全等价**(1→单数、≥2→复数),故本叶子保留 `!== 1`
 * 以保证**门控关时与 legacy 逐字节一致**,同时门控开也与 CC 复数判定一致。
 *
 * 门控:KHY_EDIT_STAT_LINE(默认开)。=0/false/off/no → 关 → "removed" 恒小写,
 * 与三处 call-site 改动前**逐字节等价**;开 → 纯删除时句首 "Removed" 大写(CC 口径)。
 *
 * 刻意不纳入:CC 给数字加 <Text bold>(ink 终端样式),属各 call-site 自己的着色层
 * (REPL/diff 是 chalk dim 包裹整行、TUI 是 row 文本),本叶子只产出**纯文本**摘要串,
 * 大小写/复数/分隔符这层后端逻辑收敛即可,着色仍由各 call-site 决定。
 */

function editStatLineEnabled(env = process.env) {
  const flag = String((env && env.KHY_EDIT_STAT_LINE) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

function _nonNegInt(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * 构造 CC 风格编辑统计摘要串(单一真源)。返回纯文本(无前缀字形、无着色);
 * 两者皆为 0 → 返回 ''(call-site 据此决定是否渲染该行)。
 *
 * @param {number} added    新增行数
 * @param {number} removed  删除行数
 * @param {object} [env=process.env]
 * @returns {string} 例如 "Added 3 lines, removed 1 line" / "Removed 2 lines" / ""
 */
function buildEditStatLine(added, removed, env = process.env) {
  const a = _nonNegInt(added);
  const r = _nonNegInt(removed);
  const cc = editStatLineEnabled(env);
  const parts = [];
  if (a > 0) parts.push(`Added ${a} line${a !== 1 ? 's' : ''}`);
  if (r > 0) {
    // CC 句首/句中大小写规则:additions === 0(句首)→ 'R',否则(跟在 "Added …" 后)→ 'r'。
    // 门控关 → 恒 'r'(逐字节回退 legacy)。
    const lead = cc && a === 0 ? 'R' : 'r';
    parts.push(`${lead}emoved ${r} line${r !== 1 ? 's' : ''}`);
  }
  return parts.join(', ');
}

module.exports = { editStatLineEnabled, buildEditStatLine };
