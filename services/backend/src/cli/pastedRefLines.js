'use strict';

/**
 * pastedRefLines — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让 CC 前端显示背后的**后端逻辑**对齐。」
 * 当用户粘贴多行文本,CLI 把它折成一枚 `[Pasted text #N +M lines]` 的「胶囊」(pill)
 * 内联进提示行。那个 **M** 不是随手拿的「行数」——CC 源 `src/history.ts` 有一个**专用**
 * 单一真源 `getPastedTextRefNumLines`,它**数的是换行符个数**(而非行数),并对
 * `\r\n` / 裸 `\r` / `\n` 各归一计一次:
 *
 *   // CC src/history.ts:43-49(注释逐字保留):
 *   // "line1\nline2\nline3" → +2 lines(不是 3 lines)。We preserve that behavior.
 *   export function getPastedTextRefNumLines(text) {
 *     return (text.match(/\r\n|\r|\n/g) || []).length
 *   }
 *
 * 即:无尾随换行的内容,M = 行数 − 1(故 3 行文本显 "+2 lines")。这是 CC **刻意**的
 * 后端逻辑——胶囊里的 "+M" 是「首行之外**额外**多少行」的增量记号,不是总行数。
 *
 * Khy 历史缺口:三处粘贴胶囊渲染各自写 `text.split('\n').length`(= 行数 = CC 值 +1),
 * 且 `split('\n')` 不归一 `\r\n`/裸 `\r`(CRLF 粘贴会多计且残留 `\r`,老式 Mac 裸 `\r`
 * 文本整段被当 1 行)。本叶子把 CC `getPastedTextRefNumLines` 逐字节移植为单一真源。
 *
 * 门控:KHY_PASTED_REF_LINES(默认开)。=0/false/off/no → 关。叶子不自查门控改算法
 * (移植即忠实);门控由**调用方**经 `pastedRefLineCountOr(text, legacy, env)` 决定走
 * CC 口径还是逐字节回退各自历史的 `split('\n').length`。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_PASTED_REF_LINES;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * CC `getPastedTextRefNumLines` 的忠实移植:数换行符个数(`\r\n`/`\r`/`\n` 各计一次)。
 * @param {string} text
 * @returns {number}  非字符串/空 → 0(绝不抛)。
 */
function countPastedRefLines(text) {
  const s = String(text == null ? '' : text);
  const m = s.match(/\r\n|\r|\n/g);
  return m ? m.length : 0;
}

/**
 * 「门控 + call-site legacy」包装(镜像 `ccFormatTokensOr`/`ccFormatCostOr` 同惯例)。
 * 门控开 → `countPastedRefLines(text)`(CC 换行数);门控关 → 原样返回 call-site 传入的
 * legacy(逐字节回退到各自历史的 `split('\n').length` 口径,绝不串味)。
 *
 * @param {string} text    粘贴的原始文本。
 * @param {number} legacy  call-site 历史计数(门控关时返回)。
 * @param {object} [env]   环境变量(仅读门控)。
 * @returns {number}
 */
function pastedRefLineCountOr(text, legacy, env = process.env) {
  if (!isEnabled(env)) return legacy;
  return countPastedRefLines(text);
}

module.exports = { isEnabled, countPastedRefLines, pastedRefLineCountOr };
