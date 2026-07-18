'use strict';

/**
 * resultLineGlyph — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 目标(承 Goal「khy 做事像 Claude Code 一样结构化」):统一**工具结果/摘要行**的起首
 * 字形。CC 把结果行收在一个暗色 `⎿` elbow 下(如 `⎿ Read 42 lines (ctrl+o to expand)`),
 * 与「正文输出」同一视觉语言;Khy 旧版结果摘要行用绿色 `✓ 摘要`,与命令正文的 `⎿`
 * 割裂。本叶子只决定**结果行的起首字形与颜色**——
 *   - 门控开(默认):`⎿ ` 暗色(no color,继承终端),与命令正文 elbow 一致;
 *   - 门控关:逐字节回退到旧绿色 `✓ ` 摘要行。
 *
 * 注意:只管**结果/摘要行**的字形。工具**头行**的状态字形(◆ 运行 / ✓ 成功 / ✗ 失败)
 * 以及分组状态计数(✓2 ✗1 ◆1)是另一套语义,**不在本叶子范围**,绝不触碰。
 *
 * 门控:KHY_RESULT_ELBOW(默认开)。=0/false/off/no → 关 → 与改动前逐字节等价。
 */

function resultElbowEnabled(env = process.env) {
  const flag = String((env && env.KHY_RESULT_ELBOW) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * 结果/摘要行的起首装饰单一真源。
 * @param {object} [env=process.env]
 * @returns {{glyph:string,color:(string|undefined),dim:boolean}}
 *   glyph 起首字形(含尾随空格);color ink Text color(undefined=继承);dim 是否暗色。
 */
function resultLineLead(env = process.env) {
  return resultElbowEnabled(env)
    ? { glyph: '⎿ ', color: undefined, dim: true } // CC: 暗色 elbow,与命令正文同语言
    : { glyph: '✓ ', color: 'green', dim: true };   // legacy 字节回退:绿色对勾
}

module.exports = { resultElbowEnabled, resultLineLead };
