'use strict';

/**
 * underscoreEmphasis.js — Pure-leaf CommonMark underscore-emphasis transform,
 * aligning the logic behind Claude Code's inline markdown emphasis.
 *
 * 对齐 CC `src/utils/markdown.ts`:CC 用 `marked` 词法器按 CommonMark 解析行内
 * 强调,`em → chalk.italic` / `strong → chalk.bold`,**同时识别** `*`/`**` 与
 * `_`/`__` 两种定界符,并套用 CommonMark 的「左/右侧侧接(flanking)」规则——
 * `_emphasis_` 斜体,而 `my_var_name` 的词内下划线**保持字面**。
 *
 * khy 历史真缺口=`markdownRenderer.js` 的行内强调链**只认星号**(`***`/`**`/`*`),
 * 完全没有下划线规则 → `_italic_` / `__bold__`(标准 CommonMark·模型常产出)
 * 在 khy 里连定界符一起原样上屏(`_emphasized_` 字面显示),强调丢失。
 *
 * **承重设计点 = 词内守卫**(防 `snake_case` 误斜体,正是 khy 当初省略下划线的
 * 原因):每个定界符**外侧**必须紧邻「非单词字符」边界(`(?<!\w)` 开 / `(?!\w)`
 * 闭),**内侧**必须紧邻非空白(`(?=\S)` 开 / `(?<=\S)` 闭)。于是:
 *   - `_foo_` / `__foo__` / `___foo___`(被空白或标点包围)→ 套样式
 *   - `some_function_name`(下划线两侧皆单词字符)→ 字面保留
 *   - `_a_b_`(词内连缀)→ 无匹配(对齐 CommonMark intraword 忽略)
 *
 * 纯叶子:零 IO、零业务 require、确定性。样式应用(chalk)经 `styler` 注入留在
 * call-site(同 `blockquoteStyle`/`orderedListAlign` 把判定留叶子、着色留 renderer)。
 */

// 三种定界符,长在前(先 `___` 再 `__` 再 `_`),内容非贪婪且不跨下划线/换行。
// 外侧 `(?<!\w)`/`(?!\w)` = 词内守卫;内侧 `(?=\S)`/`(?<=\S)` = CommonMark 定界符
// 须紧贴非空白内容。
const RE_BOLD_ITALIC = /(?<!\w)___(?=\S)([^\n]+?)(?<=\S)___(?!\w)/g;
const RE_BOLD = /(?<!\w)__(?=\S)([^\n]+?)(?<=\S)__(?!\w)/g;
const RE_ITALIC = /(?<!\w)_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g;

/**
 * 门控 KHY_UNDERSCORE_EMPHASIS(默认开)。仅 `0/false/off/no` 关闭 → call-site
 * 跳过本步 → 逐字节回退(下划线原样不动,= 历史行为)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function underscoreEmphasisEnabled(env = process.env) {
  const flag = String((env && env.KHY_UNDERSCORE_EMPHASIS) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * 把 `_italic_` / `__bold__` / `___bold-italic___` 经词内守卫转换为样式化文本。
 * @param {string} text 输入文本(call-site 保证行内代码已被占位符替换保护)。
 * @param {{italic:Function,bold:Function,boldItalic:Function}} styler chalk 应用器。
 * @returns {string}
 */
function applyUnderscoreEmphasis(text, styler) {
  if (typeof text !== 'string' || text.indexOf('_') === -1) return text;
  if (!styler || typeof styler.italic !== 'function'
    || typeof styler.bold !== 'function' || typeof styler.boldItalic !== 'function') {
    return text;
  }
  return text
    .replace(RE_BOLD_ITALIC, (_m, t) => styler.boldItalic(t))
    .replace(RE_BOLD, (_m, t) => styler.bold(t))
    .replace(RE_ITALIC, (_m, t) => styler.italic(t));
}

module.exports = {
  underscoreEmphasisEnabled,
  applyUnderscoreEmphasis,
  RE_BOLD_ITALIC,
  RE_BOLD,
  RE_ITALIC,
};
