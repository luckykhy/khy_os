'use strict';

/**
 * cjkInputNormalize — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让 CC 前端显示背后的**后端逻辑**对齐。」
 * CC 在「期望数字 / 期望空格」的输入边界上,会先把 **CJK 全角(zenkaku)字符**归一到
 * 半角再解析——见 CC 源 `src/utils/stringUtils.ts` 的 `normalizeFullWidthDigits` /
 * `normalizeFullWidthSpace`,被 `CustomSelect/use-select-input.ts`(菜单数字快捷选择)、
 * `FeedbackSurvey/useDebouncedDigitInput.ts`、`SkillImprovementSurvey.tsx` 等**数字输入
 * 上下文**调用。其后端逻辑:CJK-IME 常产出全角数字「０-９」与全角空格 U+3000,直接
 * 喂给 `\d` / `parseInt` 会**静默失败**(`\d` 只认 ASCII 0-9、`parseInt('２')===NaN`),
 * 所以 CC 在解析前先归一。
 *
 * Khy 是**中文 CLI**,这个缺口比 CC 更突出却完全缺失(全仓库零全角归一):用户用中文
 * 输入法敲 `session show ２`、`#２` 时,`/^#?(\d+)$/` 不匹配全角「２」→ 索引解析失败。
 * 本叶子把 CC 这两个归一函数**逐字节忠实移植**为 Khy 各处「期望数字的引用 / 索引」解析
 * 的单一真源,并提供门控包装 `normalizeNumericInput`——这样 Khy 解析数字输入的口径,就是
 * CC 用**同一套算法**(全角→半角偏移 0xFEE0、U+3000→U+0020)处理的,而非另写近似。
 *
 * 对齐基准(CC 源 src/utils/stringUtils.ts,逐分支移植):
 *   normalizeFullWidthDigits(s): s.replace(/[０-９]/g, ch => fromCharCode(ch.charCodeAt(0) - 0xFEE0))
 *   normalizeFullWidthSpace(s):  s.replace(/　/g, ' ')
 *
 * 门控:KHY_CJK_INPUT_NORMALIZE(默认开)。=0/false/off/no → 关。叶子的两个移植函数**不**
 * 自查门控(移植即忠实);门控由包装 `normalizeNumericInput` 用来决定走归一还是逐字节回退。
 */

function cjkNormalizeEnabled(env = process.env) {
  const flag = String((env && env.KHY_CJK_INPUT_NORMALIZE) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * CC `normalizeFullWidthDigits` 的忠实移植:全角数字「０-９」(U+FF10..U+FF19)→ 半角
 * 「0-9」(偏移恒为 0xFEE0)。非字符串输入先 String 化(绝不抛);无全角数字 → 原样返回。
 * @param {string} input
 * @returns {string}
 */
function normalizeFullWidthDigits(input) {
  const s = String(input == null ? '' : input);
  return s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

/**
 * CC `normalizeFullWidthSpace` 的忠实移植:全角空格 U+3000 → 半角空格 U+0020。
 * @param {string} input
 * @returns {string}
 */
function normalizeFullWidthSpace(input) {
  const s = String(input == null ? '' : input);
  return s.replace(/　/g, ' ');
}

/**
 * 门控包装:用于「期望数字 / 期望空格」的输入解析边界(会话引用、索引选择等)。
 * 门控开 → 归一全角数字 + 全角空格(CC 数字输入上下文的合并意图);
 * 门控关 → **原样返回**入参(逐字节回退,解析口径与历史完全一致)。
 *
 * 刻意只在「期望数字」的解析点调用,绝不对自由文本(AI 提示词)整体归一——那会改变用户
 * 本想保留的全角字符(与 CC 一致:CC 也只在 select / digit-survey 等数字字段归一)。
 * @param {string} raw
 * @param {object} [env]
 * @returns {string}
 */
function normalizeNumericInput(raw, env) {
  if (!cjkNormalizeEnabled(env)) return raw;
  return normalizeFullWidthSpace(normalizeFullWidthDigits(raw));
}

module.exports = {
  cjkNormalizeEnabled,
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
  normalizeNumericInput,
};
