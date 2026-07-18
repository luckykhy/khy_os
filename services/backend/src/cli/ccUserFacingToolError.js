'use strict';

/**
 * ccUserFacingToolError — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让 CC 前端显示背后的**后端逻辑**对齐。」
 *
 * CC `src/components/FallbackToolUseErrorMessage.tsx` 把工具失败串**分两个受众**:
 *   - 给**模型**的 tool_result 保留**完整**校验分组串(`formatZodValidationError`,
 *     模型自我纠正的唯一依据);
 *   - 给**人**的默认(非 verbose)视图把入参校验失败折成**一行** `Invalid tool parameters`
 *     —— `if (!verbose && trimmed.includes('InputValidationError: ')) error = 'Invalid tool parameters'`,
 *     完整细节仅经全局 Ctrl+O(transcript)展开可见。
 *
 * Khy 历史在**默认 TUI** 渲染器(`cli/tui/ink-components/ToolLines.js` 的 isErr 分支)把那条
 * **面向模型**的多行分组校验串**原样**铺给人(它落在刀18 的 10 行折叠阈值之内,故不被折叠)——
 * 同一份串既发模型又显给人,从不像 CC 那样**按受众拆分**。本叶子补齐「给人折叠、给模型完整」的
 * 后端逻辑:仅在**折叠态**(非 expanded)把**本仓自产的**入参校验失败串替换为单行
 * `Invalid tool parameters`;**展开态(Ctrl+O)** 返回完整分组串(与既有 expanded 恢复一致);
 * 模型侧 tool_result **完全不动**(本叶子只在 display 层调用)。
 *
 * 诚实边界:
 *   - 判据**只认本仓 `tools/ccValidationError` 自产的两种串**(`isValidationErrorMessage`,
 *     签名由产串方 SSOT 拥有)——绝不正则猜测任意工具的失败文本,绝不臆造数据;
 *     与 CC 凭 `includes('InputValidationError: ')` 识别自家校验错误**同一原理**。
 *   - 非校验类失败(bash 退码、权限拒绝、网络错误等)**逐字节原样透传**——它们对人有信息量,
 *     CC 也只折叠校验类。
 *   - **可恢复**:折叠后完整细节仍可经既有全局 Ctrl+O(`expanded`)看到(=CC 的 transcript 拆分),
 *     故折叠不丢信息。
 *   - 不引入 CC 的 `Error:` 前缀归一(改动面遍及所有工具错误、且 Khy 错误本地化措辞各有其设计,
 *     非清晰缺口)——刻意不在本刀做。
 *
 * 门控:KHY_USER_FACING_TOOL_ERROR(默认开)。=0/false/off/no → 关 →
 *   `collapseValidationErrorForDisplay` **逐字节回退**(原样返回入参文本,不折叠)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

function userFacingToolErrorEnabled(env = process.env) {
  const flag = String((env && env.KHY_USER_FACING_TOOL_ERROR) || '').trim().toLowerCase();
  return !_FALSY.has(flag);
}

/** CC 的人类侧折叠文案(逐字节对齐 `FallbackToolUseErrorMessage` 的 `'Invalid tool parameters'`)。 */
const COLLAPSED_VALIDATION_TEXT = 'Invalid tool parameters';

/**
 * 给**人**显示用的工具失败串折叠。仅折叠**本仓自产的入参校验失败串**,且仅在折叠态。
 *
 *   - 门控关 → 原样返回 `text`(逐字节回退)。
 *   - `opts.expanded`(Ctrl+O 展开)→ 原样返回 `text`(显示完整分组细节)。
 *   - `text` 非串 → 原样返回。
 *   - `text` 是本仓校验失败串(`isValidationErrorMessage`)→ 返回 `'Invalid tool parameters'`。
 *   - 其余(非校验类失败)→ 原样返回。
 *
 * 纯函数:不读 IO(除门控 env)、不抛、不改入参。
 *
 * @param {*} text  既有 `errorText(result)` 的产物(给人看的失败文本)。
 * @param {{ expanded?: boolean }} [opts]
 * @param {object} [env]
 * @returns {*}  折叠后的串,或原样 `text`。
 */
function collapseValidationErrorForDisplay(text, opts = {}, env = process.env) {
  if (!userFacingToolErrorEnabled(env)) return text;
  if (opts && opts.expanded) return text;
  if (typeof text !== 'string') return text;
  let isValidation = false;
  try {
    isValidation = require('../tools/ccValidationError').isValidationErrorMessage(text);
  } catch {
    isValidation = false; // 产串方不可用 → 保守不折叠(原样透传)
  }
  return isValidation ? COLLAPSED_VALIDATION_TEXT : text;
}

module.exports = {
  userFacingToolErrorEnabled,
  collapseValidationErrorForDisplay,
  COLLAPSED_VALIDATION_TEXT,
};
