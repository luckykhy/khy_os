'use strict';

/**
 * alwaysAllowLabel.js — 权限对话框「始终允许(allow-always)」选项标签的动词口径单一真源。
 *
 * 背后逻辑(对齐 CC):CC 把权限对话按工具族分流成两个专用对话——
 *   - FilePermissionDialog(src/components/permissions/FilePermissionDialog/permissionOptions.tsx)
 *     写/编辑 → "Yes, allow all edits …";
 *   - BashPermissionRequest(.../BashPermissionRequest/bashToolUseOptions.tsx)
 *     bash → "Yes, and don't ask again for <suggestion>"(由 Haiku 实时生成命令前缀)。
 *   其余只读类工具走通用对话,措辞围绕「读取/访问」。
 *
 * khy 真缺口:`cli/ui/permissionDialog.js` 的单工具对话把 option-2 标签**硬编码**成
 *   `Yes, allow reading from <project> from this project`——对**所有**工具都说 "reading"。
 *   当用户其实在批准 Write/Edit(改文件)或 Bash(任意命令,如 rm -rf)时,标签谎称这是
 *   「读取」授权,而 `allow-always` 实际授予的是 `permissionStore.approve(permissionKey,'forever')`
 *   ——即「永久放行该工具」。这是用户可见的误导(把改写/危险操作描述成只读)。
 *
 * 诚实边界:
 *   - khy 无法复刻 CC 的 Haiku 命令前缀建议(那是模型调用;伪造前缀=臆造)。故 bash 只用
 *     真实、通用、不臆造的措辞「running commands」(忠实描述「永久放行 bash 工具」这一真实授权)。
 *   - 只覆盖**明确错且危险**的两族(写/编辑、bash),与 CC 的两个专用对话同构;
 *     read/search/fetch 等只读类工具「reading」本就成立,门控开也保持 legacy 不动。
 *   - 叶子零 chalk:返回含 `{project}` 占位符的纯字符串,由 call-site 注入 `chalk.bold(projectName)`。
 *
 * 门控 KHY_ALWAYS_ALLOW_LABEL 默认开;关 → 原样返回 call-site 传入的 legacyLabel(逐字节回退)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env) {
  const raw = env && env.KHY_ALWAYS_ALLOW_LABEL;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 与 permissionDialog.js::formatToolContent 同口径的名称归一(小写 + 去空白/下划线/连字符)。
function _normalize(toolName) {
  return String(toolName == null ? '' : toolName).toLowerCase().replace(/[\s_-]/g, '');
}

// 写/编辑族(改文件):对齐 CC FilePermissionDialog 的 "allow all edits"。
const WRITE_EDIT = new Set([
  'write', 'writefile', 'createfile',
  'edit', 'editfile', 'multiedit', 'notebookedit',
  'scaffold', 'scaffoldfiles',
]);

// bash/命令族:对齐 CC BashPermissionRequest(khy 用真实通用措辞,不臆造命令前缀)。
const BASH = new Set(['bash', 'shellcommand', 'command']);

/**
 * 选取「始终允许」选项标签。返回含 `{project}` 占位符的字符串,
 * call-site 负责 `.replace('{project}', chalk.bold(projectName))`。
 *
 * @param {string} toolName     工具名(原始,内部归一)。
 * @param {string} legacyLabel  call-site 传入的历史标签(含 `{project}` 占位符);门控关时原样返回。
 * @param {object} [env]        环境变量(仅读门控)。
 * @returns {string}
 */
function buildAlwaysAllowLabelOr(toolName, legacyLabel, env = process.env) {
  if (!isEnabled(env)) return legacyLabel;
  const name = _normalize(toolName);
  if (WRITE_EDIT.has(name)) {
    return 'Yes, allow all edits in {project} from this project';
  }
  if (BASH.has(name)) {
    return 'Yes, allow running commands in {project} from this project';
  }
  // 只读类工具:legacy 的 "reading" 本就成立,逐字节保留。
  return legacyLabel;
}

module.exports = { isEnabled, buildAlwaysAllowLabelOr };
