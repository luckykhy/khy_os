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
 * **对抗式自愈(2026-09-05)**:引入 `adaptiveUnderscorePolicy(text)` —— 一段文本里如果
 * 下划线密度高且大多是 snake_case / 路径词内用法,而非真正的 Markdown 强调,就判定
 * 为「滥用」并**自动禁用**本段渲染的下划线强调。于是:
 *   - `some_function_name` 多变量/路径密集的代码段 → 自动关,下划线原样显示
 *   - `This is _emphasized_ text` 少量真正的强调 → 仍然开,_emphasized_ 正确斜体
 *   = 下划线「必要时可用,滥用时自动抑制」的对抗式自愈。
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

// ── 对抗式自愈:下划线滥用检测 ─────────────────────────────────────────────────
// 滥用判据:文本中下划线密度高,且绝大多数是词内用法(snake_case / 路径分隔),而不是
// Markdown 强调(两侧紧邻非单词字符边界)。两项都超阈值才判滥用。
//
// 例:「set my_var and run getUserName_or_default_now」
//   - total_=3, snake_=3 → ratio=1.0 > 0.6 且 total ≥ 5? 否(3<5) → 不判滥用 → 仍开
//   - 实际渲染时 `my_var` 因词内守卫不命中,`getUserName_or_default_now` 同理,
//     即使开也不会误斜体。阈值兜底短文本安全。
//
// 例:「see /usr/local/bin/my_app_dir/config_file_path for some_var_name_and_other」
//   - total_=7, snake_=7 → ratio=1.0 > 0.6 且 total ≥ 5 → 判滥用 → 自动关
//
// 例:「This is _emphasized_ text with _italic_」
//   - total_=4, snake_=0 → ratio=0 < 0.6 → 不判滥用 → 仍开 → 正确斜体

// 总下划线数下限:低于此数无论比例都不判滥用(短文本安全兜底)。
const ABUSE_MIN_TOTAL = 5;
// 词内下划线占比下限:≥此比例才判滥用。
const ABUSE_SNAKE_RATIO = 0.6;
// 词内下划线匹配:下标字母/数字夹一个下划线(a_b 形式)。全局匹配计数。
const _SNAKE_UNDERSCORE_RE = /\w(?:_+\w)+/g;
// 「强调可用」下划线:外侧为非单词字符(可构成强调定界)。
const _EMPHASIS_CANDIDATE_RE = /(?:(?<!\w)_|_(?!\w))/g;

/**
 * 纯函数:检测一段文本是否「滥用下划线」。
 * @param {string} text
 * @returns {{abuse:boolean, total:number, snake:number, ratio:number}}
 */
function detectUnderscoreAbuse(text) {
  const s = String(text == null ? '' : text);
  if (!s) {
    return { abuse: false, total: 0, snake: 0, ratio: 0 };
  }
  const total = (s.match(/_/g) || []).length;
  if (total < ABUSE_MIN_TOTAL) {
    return { abuse: false, total, snake: 0, ratio: 0 };
  }
  // 词内下划线:连续 snake_case 段里每个下划线都计数。
  const snakeMatches = s.match(_SNAKE_UNDERSCORE_RE) || [];
  let snake = 0;
  for (const m of snakeMatches) {
    snake += (m.match(/_/g) || []).length;
  }
  const ratio = total > 0 ? snake / total : 0;
  return { abuse: ratio >= ABUSE_SNAKE_RATIO, total, snake, ratio };
}

/**
 * 自适应下划线策略(对抗式自愈入口)。
 *
 * 门控 KHY_UNDERSCORE_EMPHASIS:
 *   - 显式关(0/false/off/no) → 永远 false
 *   - 显式开(1/true/on/yes/adaptive) → 看 text 滥用与否
 *     - adaptive(默认):滥用 → false;否则 true
 *     - 1/true/on/yes:始终 true(legacy,不会自愈)
 *   - 未设置 → 同 adaptive
 *
 * @param {string} [text] 待渲染文本(用于滥用判定)。
 * @param {Record<string,string>} [env]
 * @returns {boolean} true = 启用下划线强调
 */
function adaptiveUnderscorePolicy(text, env = process.env) {
  const flag = String((env && env.KHY_UNDERSCORE_EMPHASIS) || '')
    .trim()
    .toLowerCase();
  // 显式关闭。
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') {
    return false;
  }
  // 显式强制开启(不含 adaptive)→ 始终开,不检测滥用。
  if (flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes') {
    return true;
  }
  // adaptive(默认) / 未设置:检测滥用,滥用时自动关。
  const { abuse } = detectUnderscoreAbuse(text);
  return !abuse;
}

/**
 * 门控 KHY_UNDERSCORE_EMPHASIS(默认开)。仅 `0/false/off/no` 关闭 → call-site
 * 跳过本步 → 逐字节回退(下划线原样不动,= 历史行为)。
 *
 * 注意:本函数**不传 text**,用于不需要按文本自适应的场景(如健康检查、legacy 调用)。
 * 渲染路径应改用 `adaptiveUnderscorePolicy(text, env)` 以获得对抗式自愈能力。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function underscoreEmphasisEnabled(env = process.env) {
  const flag = String((env && env.KHY_UNDERSCORE_EMPHASIS) || '')
    .trim()
    .toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * 把 `_italic_` / `__bold__` / `___bold-italic___` 经词内守卫转换为样式化文本。
 * @param {string} text 输入文本(call-site 保证行内代码已被占位符替换保护)。
 * @param {{italic:Function,bold:Function,boldItalic:Function}} styler chalk 应用器。
 * @returns {string}
 */
function applyUnderscoreEmphasis(text, styler) {
  if (typeof text !== 'string' || text.indexOf('_') === -1) {
    return text;
  }
  if (
    !styler ||
    typeof styler.italic !== 'function' ||
    typeof styler.bold !== 'function' ||
    typeof styler.boldItalic !== 'function'
  ) {
    return text;
  }
  return text
    .replace(RE_BOLD_ITALIC, (_m, t) => styler.boldItalic(t))
    .replace(RE_BOLD, (_m, t) => styler.bold(t))
    .replace(RE_ITALIC, (_m, t) => styler.italic(t));
}

module.exports = {
  underscoreEmphasisEnabled,
  adaptiveUnderscorePolicy,
  detectUnderscoreAbuse,
  applyUnderscoreEmphasis,
  RE_BOLD_ITALIC,
  RE_BOLD,
  RE_ITALIC,
  ABUSE_MIN_TOTAL,
  ABUSE_SNAKE_RATIO,
};
