'use strict';

/**
 * toolResultTransparency — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 目标(承 Goal「khy 做事更结构化、并透明原命令的真实结果」):让**非命令类**工具
 * (Read/Grep 之外携带真实文本结果的工具,如 WebFetch、写文件确认串等)也能像
 * Claude Code 那样,在 ⎿ 下**透明显示其真实输出体**——而不是只甩一行「✓ 摘要」把
 * 原始结果遮住。命令类(shell)工具早已这样显示;本叶子只负责回答两个纯粹的判定:
 *   1) 透明化是否开启(门控);
 *   2) 一个工具结果里「真实输出体」是什么(单一真源,与 projectToolResultForView /
 *      ToolLines.resultPreview 同口径:text > content > output)。
 *
 * 渲染本身仍在 ToolLines(ink)里;本叶子绝不渲染、绝不碰 IO、绝不抛。
 *
 * 门控:KHY_TOOL_RESULT_TRANSPARENT(默认开)。=0/false/off/no → 关 →
 * ToolLines 回退到原「✓ 摘要 / ✓ 完成」一行,逐字节等价。
 */

function transparencyEnabled(env = process.env) {
  const flag = String((env && env.KHY_TOOL_RESULT_TRANSPARENT) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * 取出工具结果的「真实输出体」。与 ToolLines.resultPreview / projectToolResultForView
 * 完全同口径(text > content > output),纯文本化后去尾空白判定:有内容 → 返回原串,
 * 否则 → ''。非字符串体走 JSON 序列化;任何异常 → ''(绝不抛)。
 * @param {any} result
 * @returns {string}
 */
function selectResultBody(result) {
  try {
    if (!result) return '';
    const raw = result.text || result.content || result.output || '';
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return s && s.trim() ? s : '';
  } catch {
    return '';
  }
}

/**
 * 是否应对该结果渲染「透明输出体」:门控开 且 存在真实输出体。
 * @param {any} result
 * @param {object} [env]
 * @returns {boolean}
 */
function shouldRenderTransparentBody(result, env = process.env) {
  return transparencyEnabled(env) && selectResultBody(result) !== '';
}

module.exports = {
  transparencyEnabled,
  selectResultBody,
  shouldRenderTransparentBody,
};
