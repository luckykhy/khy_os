'use strict';

/**
 * bottomDecorationRepaintMemo — 经典 REPL 底部装饰(rule+footer)重绘串的单槽记忆(纯叶子)。
 *
 * 承 keystroke 流畅性同族(渲染热路径每键字符串重拼)。
 *
 * 根因:`repl.js::_buildBottomDecorationRepaint(metrics)` 在 `rl._refreshLine`(**每按键**)里被调,
 * 每次用 ~6 段字符串拼接重建整段 bottom-decoration ANSI 序列(下移 rowsBelowCursor + gap 行清行 +
 * rule + footer + 上移 + 光标复位)。其中 `_cachedBottomRule`/`_cachedBottomFooter` 已缓存,但**外层
 * ANSI 拼装每键从头重跑**。在单一可视行内连续键入(最常见)时,`rowsBelowCursor`/gap/rule/footer 全不变,
 * 只有 `cursorCol` 逐键 +1 → 整串几乎相同却每键全量重拼。
 *
 * 修:输出可拆成 **cursorCol-无关的前缀**(下移 + gap 清行 + rule + footer + 上移)+ **cursorCol-相关的
 * 尾部**(`\x1b[{col+1}G` 光标复位)。前缀是 `(rowsBelowCursor, gapRows, rule, footer)` 的纯函数 →
 * 单槽记忆前缀,每键只补一段廉价的 `\x1b[{col+1}G`。输出与历史逐字节一致(只是不再每键重拼前缀)。
 *
 * 纯叶子纪律:零 IO、确定性(缓存进程内)、绝不抛;门控关 / 异常 → `computeFullFn()`(逐字节回退)。
 *
 * 门控 `KHY_BOTTOM_DECORATION_REPAINT_MEMO` 默认开;关 → 每次现拼,逐字节等价历史。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_BOTTOM_DECORATION_REPAINT_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 现拼 cursorCol-无关的前缀(下移 + gap 清行 + rule + footer + 上移)。
 * 与 repl.js 历史拼装逐字节一致(去掉末尾 `\x1b[{col+1}G`)。
 * @param {number} rowsBelowCursor
 * @param {number} gapRows
 * @param {string} rule
 * @param {string} footer
 * @returns {string}
 */
function buildPrefix(rowsBelowCursor, gapRows, rule, footer) {
  let out = '';
  if (rowsBelowCursor > 0) out += `\x1b[${rowsBelowCursor}B`;
  for (let i = 0; i < gapRows; i++) {
    out += '\x1b[1B\x1b[2K\x1b[1G';
  }
  out += '\x1b[1B\x1b[2K\x1b[1G' + rule;
  out += '\x1b[1B\x1b[2K\x1b[1G' + footer;

  const rowsReturn = rowsBelowCursor + gapRows + 2;
  if (rowsReturn > 0) out += `\x1b[${rowsReturn}A`;
  return out;
}

// str 单槽:命中 (rowsBelowCursor, gapRows, rule, footer) 未变即复用前缀。
let _slot = null; // { rowsBelowCursor, gapRows, rule, footer, prefix }

/**
 * 取(或首拼)cursorCol-无关前缀,按 (rowsBelowCursor,gapRows,rule,footer) 单槽记忆。
 * @param {object} key { rowsBelowCursor, gapRows, rule, footer }
 * @returns {string}
 */
function getPrefix(key, env = process.env) {
  try {
    if (!isEnabled(env) || !key) {
      const k = key || {};
      return buildPrefix(k.rowsBelowCursor, k.gapRows, k.rule, k.footer);
    }
    const { rowsBelowCursor, gapRows, rule, footer } = key;
    if (
      _slot &&
      _slot.rowsBelowCursor === rowsBelowCursor &&
      _slot.gapRows === gapRows &&
      _slot.rule === rule &&
      _slot.footer === footer &&
      typeof _slot.prefix === 'string'
    ) {
      return _slot.prefix;
    }
    const prefix = buildPrefix(rowsBelowCursor, gapRows, rule, footer);
    _slot = { rowsBelowCursor, gapRows, rule, footer, prefix };
    return prefix;
  } catch {
    try {
      const k = key || {};
      return buildPrefix(k.rowsBelowCursor, k.gapRows, k.rule, k.footer);
    } catch { return ''; }
  }
}

/**
 * 组装完整重绘串(前缀经单槽记忆 + 廉价的 cursorCol 复位尾部)。
 * @param {object} key { rowsBelowCursor, gapRows, rule, footer, cursorCol }
 * @returns {string}
 */
function getRepaint(key, env = process.env) {
  try {
    const k = key || {};
    const prefix = getPrefix(k, env);
    const col = Number.isFinite(k.cursorCol) ? k.cursorCol : 0;
    return prefix + `\x1b[${col + 1}G`;
  } catch { return ''; }
}

// 测试/生命周期钩子。
function _clear() { _slot = null; }
function _hasSlot() { return _slot != null; }

module.exports = {
  isEnabled,
  buildPrefix,
  getPrefix,
  getRepaint,
  _clear,
  _hasSlot,
  OFF_VALUES,
};
