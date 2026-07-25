'use strict';

/**
 * truncateDisplayWidthBudget.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 修「工具入参/表格单元格截断溢出列宽」。toolDisplay 的 `_truncateDisplayWidth` 在需要
 * 截断时返回 `${out}...`,而 `out` 已被填到**恰好 limit** 列宽 → 加上 3 列的 `...` 后总宽
 * 达 `limit + 3`,溢出调用方给的列预算(`_sanitizeToolTableCell(v,24)`、`_truncateNaturalText`
 * 用的 40/80/88/100/120)。同仓 `formatters.truncateToWidth` 早就为省略号预留了 3 列,这个
 * 姊妹函数漏了 → 工具头行/入参行比其列位宽 3 列,把对齐搅乱。
 *
 * 开门(KHY_TRUNCATE_WIDTH_BUDGET 默认开)→ 截断时**为省略号预留 3 列**:内容填到
 * `limit - 3`,再接 `...`,总宽 ≤ limit;整串本就 ≤ limit 时原样返回(不加省略号,与历史一致)。
 * 关门(0/false/off/no)→ 逐字节回退历史行为(填到 limit 再溢出接 `...`)。
 *
 * `widthOf`(显示宽度测量器,通常 formatters.displayWidth)由 call-site 注入,叶子不自 require
 * 渲染层(保持零业务耦合、可单测)。传入 `source` 由 call-site 归一(去空白折叠/trim),`limit`
 * 由 call-site 保证为 >0 的有限数;本叶子只做「按显示宽度切到预算内」这一步。绝不抛:任何异常
 * 回退历史分支。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];
const ELLIPSIS = '...';
const ELLIPSIS_WIDTH = 3; // ASCII `...` = 3 显示列(与 formatters 的省略号预留同)。

function isEnabled(env = process.env) {
  const raw = env && env.KHY_TRUNCATE_WIDTH_BUDGET;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 历史行为(逐字节回退基准):填到 limit,一旦下一个字符会越界即接 `...`(总宽可能 = limit+3)。
function _legacy(source, limit, widthOf) {
  let width = 0;
  let out = '';
  for (const ch of Array.from(source)) {
    const chWidth = widthOf(ch);
    if (width + chWidth > limit) {
      return out ? `${out}${ELLIPSIS}` : ELLIPSIS;
    }
    out += ch;
    width += chWidth;
  }
  return out;
}

// 预算行为:整串 ≤ limit → 原样;否则给省略号预留 3 列,内容填到 limit-3,总宽 ≤ limit。
function _budgeted(source, limit, widthOf) {
  const chars = Array.from(source);
  let total = 0;
  for (const ch of chars) total += widthOf(ch);
  if (total <= limit) return source; // 完整放得下 → 不截断、不加省略号(与历史一致)。

  // 预算不足以容纳省略号(极端窄列)→ 返回宽度安全的前缀,绝不溢出(不硬塞会越界的 `...`)。
  const budget = limit >= ELLIPSIS_WIDTH ? limit - ELLIPSIS_WIDTH : 0;
  let width = 0;
  let out = '';
  for (const ch of chars) {
    const chWidth = widthOf(ch);
    if (width + chWidth > budget) break;
    out += ch;
    width += chWidth;
  }
  if (out) return `${out}${ELLIPSIS}`;
  // 一个字符都放不进预算:limit≥3 时省略号自身正好 ≤ limit;limit<3 时返回空串(宁可空也不溢出)。
  return limit >= ELLIPSIS_WIDTH ? ELLIPSIS : '';
}

/**
 * 按显示宽度把 source 截断到 limit 列以内(省略号计入预算)。
 * @param {string} source   已归一的源串(call-site 保证非空)。
 * @param {number} limit    目标最大显示宽度(call-site 保证 >0 有限)。
 * @param {(ch:string)=>number} widthOf 单字符显示宽度测量器(注入)。
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function truncateWidth(source, limit, widthOf, env = process.env) {
  try {
    const fn = typeof widthOf === 'function' ? widthOf : (ch) => Array.from(String(ch)).length;
    return isEnabled(env) ? _budgeted(String(source), limit, fn) : _legacy(String(source), limit, fn);
  } catch {
    // 兜底:退化为不带省略号的原样返回,绝不抛。
    return String(source == null ? '' : source);
  }
}

module.exports = { isEnabled, truncateWidth, ELLIPSIS, ELLIPSIS_WIDTH };
