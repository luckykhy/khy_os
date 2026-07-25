'use strict';

/**
 * starEmphasisFlanking.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 修「斜体正则吞正文星号」。markdownRenderer 的行内斜体链用历史正则
 *   `/(?<!\*)\*([^*\n]+)\*(?!\*)/g`
 * ——它只挡**相邻**星号(`**bold**` 归 bold 规则),却不管 CommonMark 的「侧接
 * (flanking)」规则:定界星号紧贴空白时**不构成** emphasis。于是一行普通正文里成对
 * 出现、两侧带空格的星号被误当斜体定界:
 *   - 算式 `area = a * b * c` → `* b *` 被吃成斜体 ` b `;
 *   - 剥星路径(表格宽度计算的 `.replace(re,'$1')`)把用户手写的**字面星号**直接删掉
 *     → `a * b * c` 变 `a  b  c`,宽度/内容双双失真。
 *
 * 对齐姊妹叶子 `underscoreEmphasis.js` 的 flanking 守卫,但星号与下划线有一处关键差异:
 * CommonMark 允许**词内**星号 emphasis(`foo*bar*baz`),故本叶子**只加空白侧接守卫**
 * (`(?=\S)` 开定界符后非空白 / `(?<=\S)` 闭定界符前非空白),**不加**下划线那样的
 * 词边界守卫 `(?<!\w)`/`(?!\w)`。其余与历史正则逐字节同构:非相邻星号(`(?<!\*)`/`(?!\*)`)、
 * 不跨行(`[^*\n]`)、单捕获组 `$1=内文`——故渲染回调 `(_m,t)=>c().italic(t)` 与
 * `'$1'` 剥星两类 call-site 都**零改语义**,只是不再命中带空白侧接的假定界。
 *
 * 门控 KHY_STAR_EMPHASIS_FLANKING(默认开,仅 `0/false/off/no` 关):
 *   - 开 → 返回 flanking-aware 正则;
 *   - 关 → 逐字节返回历史正则(与今日行为完全一致)。
 *
 * 关于共享正则实例:`String.prototype.replace(globalRegExp, …)` 按规范每次调用前把
 * lastIndex 置 0、完成后复位,故模块级单例正则可安全跨多个 .replace 复用(与
 * underscoreEmphasis 的 RE_* 同做法),无 lastIndex 串扰。切勿把这些实例用于 .test()/.exec()。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// flanking-aware:开定界符后非空白、闭定界符前非空白;其余同历史(非相邻星号、不跨行、单组)。
const RE_FLANKING = /(?<!\*)\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\*)/g;
// 历史正则(逐字节回退基准)。
const RE_LEGACY = /(?<!\*)\*([^*\n]+)\*(?!\*)/g;

/**
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function starEmphasisEnabled(env = process.env) {
  const raw = env && env.KHY_STAR_EMPHASIS_FLANKING;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 返回行内斜体应使用的正则:开门 → flanking-aware;关门/异常 → 历史正则。
 * 返回的是模块级单例(供 .replace 复用),不要拿去 .test()/.exec()。
 * @param {Record<string,string>} [env]
 * @returns {RegExp}
 */
function italicStarRegex(env = process.env) {
  try {
    return starEmphasisEnabled(env) ? RE_FLANKING : RE_LEGACY;
  } catch {
    return RE_LEGACY;
  }
}

module.exports = {
  starEmphasisEnabled,
  italicStarRegex,
  RE_FLANKING,
  RE_LEGACY,
};
