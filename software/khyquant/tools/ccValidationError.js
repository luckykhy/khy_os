'use strict';

/**
 * ccValidationError — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让 CC 前端显示背后的**后端逻辑**对齐。」
 * 工具入参校验失败时,返回给**模型**的 error 串就是模型自我纠正的唯一依据。
 * CC `src/utils/toolErrors.ts` `formatZodValidationError` 把校验失败刻意做成
 * 「human-readable and LLM friendly」(其 docstring 原话):
 *   - **按类分组**:缺失必填 / 多余参数 / 类型不符;
 *   - **嵌套路径**`formatValidationPath(['todos',0,'activeForm']) → 'todos[0].activeForm'`;
 *   - **带工具名的标题** + 逐条换行:`${tool} failed due to the following ${issues|issue}:\n…`。
 * 而 Khy 历史一律 `Validation failed: a; b; c`——无工具名、无分组、分号平铺、无嵌套路径,
 * 模型更难按图纠正。本叶子逐字节移植 CC 的分组/措辞/路径后端逻辑。
 *
 * 门控:KHY_CC_VALIDATION_ERROR(默认开)。=0/false/off/no → 关 →
 *   `formatValidationError` **逐字节回退** 历史串 `Validation failed: ${errors.join('; ')}`。
 *
 * 诚实边界:CC 的「多余参数」(unrecognized_keys)源自其 Zod `.strict()` schema;Khy
 * `validateParams` 从不检测 schema 之外的多余键(只遍历 schema keys),故本叶子保留 `unexpected`
 * 分组以**忠实对齐 CC 的格式化器**,但**不**主动引入「多余参数即拒」——那是校验**策略**变更
 * (会拒掉今天被静默放行的调用),非显示背后逻辑,刻意不在本刀做。
 */

function ccValidationErrorEnabled(env = process.env) {
  const flag = String((env && env.KHY_CC_VALIDATION_ERROR) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * 逐字节移植 CC `formatValidationPath`:把 Zod 风格的属性路径数组渲染成可读串。
 *   ['todos', 0, 'activeForm'] → 'todos[0].activeForm'
 * 数字段 → `[n]`(数组下标);其余 → 首段裸名,后续 `.name`。
 * @param {Array<string|number>} path
 * @returns {string}
 */
function formatValidationPath(path) {
  if (!Array.isArray(path) || path.length === 0) return '';
  return path.reduce((acc, segment, index) => {
    const segmentStr = String(segment);
    if (typeof segment === 'number') {
      return `${String(acc)}[${segmentStr}]`;
    }
    return index === 0 ? segmentStr : `${String(acc)}.${segmentStr}`;
  }, '');
}

function _paramOf(issue) {
  if (issue && Array.isArray(issue.path)) return formatValidationPath(issue.path);
  return String(issue && issue.param != null ? issue.param : '');
}

/**
 * 校验失败串的单一格式化入口。
 * @param {string} toolName  工具名(用于 CC 风格标题;缺失 → 中性主语)。
 * @param {object|Array} validation  `validateParams` 的结果 `{ valid, errors, issues? }`,
 *        或一个裸 error 串数组。`issues`(可选,结构化分类)存在时走 CC 分组;否则走「信封」回退。
 * @param {object} [env]
 * @returns {string}
 */
function formatValidationError(toolName, validation, env) {
  const errors = Array.isArray(validation)
    ? validation
    : (validation && Array.isArray(validation.errors) ? validation.errors : []);
  // 历史串(门控关 / 兜底逐字节回退所用,与三 call-site 旧行为完全一致)。
  const legacy = `Validation failed: ${errors.join('; ')}`;
  if (!ccValidationErrorEnabled(env)) return legacy;

  const name = (typeof toolName === 'string' && toolName.trim()) ? toolName.trim() : 'The tool call';
  const issues = (validation && !Array.isArray(validation) && Array.isArray(validation.issues))
    ? validation.issues
    : null;

  // 有结构化 issues(builtin / 默认 registry validate 经 validateParams)→ CC 分组 + 措辞 + 路径。
  if (issues && issues.length) {
    const missing = [];
    const unexpected = [];
    const typeMismatch = [];
    const other = [];
    for (const issue of issues) {
      if (!issue || typeof issue !== 'object') continue;
      const p = _paramOf(issue);
      if (issue.kind === 'missing') {
        missing.push(`The required parameter \`${p}\` is missing`);
      } else if (issue.kind === 'unexpected') {
        unexpected.push(`An unexpected parameter \`${p}\` was provided`);
      } else if (issue.kind === 'type') {
        typeMismatch.push(
          `The parameter \`${p}\` type is expected as \`${issue.expected}\` but provided as \`${issue.received}\``
        );
      } else {
        // 约束类(minLength/min/enum/pattern…):忠实保留 Khy 原句(CC「无更好信息则退原消息」之精神)。
        other.push(String(issue.message != null ? issue.message : ''));
      }
    }
    const parts = [...missing, ...unexpected, ...typeMismatch, ...other].filter(Boolean);
    if (parts.length === 0) return legacy; // 防呆:issues 全空 → 退历史串
    const noun = parts.length > 1 ? 'issues' : 'issue';
    return `${name} failed due to the following ${noun}:\n${parts.join('\n')}`;
  }

  // 无结构化 issues(如 registry 工具自带的定制 validate 只返 {valid,errors})→ 仅对齐 CC 的
  // 「标题 + 逐条换行」信封,逐条沿用原 error 串(不臆造分类/措辞)。
  if (!errors.length) return legacy;
  const noun = errors.length > 1 ? 'issues' : 'issue';
  return `${name} failed due to the following ${noun}:\n${errors.join('\n')}`;
}

/**
 * `formatValidationError` 自产串的**自识别**判据(单一真源:谁产串谁定签名)。
 * 本格式化器只可能产两种形状,二者都在此忠实匹配:
 *   ① 门控关 / 兜底回退:`Validation failed: …`(`legacy`)。
 *   ② 门控开 CC 分组:`${name} failed due to the following ${issue|issues}:\n…`。
 * 供 display 层(`cli/ccUserFacingToolError`)判断「这条 error 是不是入参校验失败串」,
 * 以便对**人**折叠成一行(对**模型**仍发完整分组串)。与 CC 在 React 层凭
 * `trimmed.includes('InputValidationError: ')` 识别校验错误**同一原理**(谁定义谁匹配),
 * 非模糊启发式。绝不抛、非串恒 false。
 * @param {*} text
 * @returns {boolean}
 */
function isValidationErrorMessage(text) {
  if (typeof text !== 'string' || !text) return false;
  if (/^Validation failed: /.test(text)) return true;
  return / failed due to the following (?:issue|issues):/.test(text);
}

module.exports = {
  ccValidationErrorEnabled,
  formatValidationPath,
  formatValidationError,
  isValidationErrorMessage,
};
