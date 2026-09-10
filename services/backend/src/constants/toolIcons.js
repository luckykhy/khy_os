'use strict';

/**
 * toolIcons.js — 四端统一工具图标映射(单一真源)。
 *
 * 不同端用不同渲染方式表达同一语义:
 *   CLI  → Unicode 字形 (▶ ▷ ◆ ◇ ⌕ ⊙ ◐ ☐) + legacy 回退 (> + ~ ? * #)
 *   TUI  → Ink <Text> 包裹 Unicode 字形
 *   Web  → KhyIcon SVG (kind: run/write/edit/search/network/agent/task)
 *   Mobile → 同 Web SVG 或 Unicode 字形
 *
 * 本模块只产{ unicode, kind, ascii } 映射表, 各端按能力选用。
 *
 * @module constants/toolIcons
 */

// 工具类别 → 图标语义映射
const TOOL_ICON_MAP = Object.freeze({
  // 执行类
  bash: { unicode: '▶', ascii: '>', kind: 'run', label: '执行' },
  shell: { unicode: '▶', ascii: '>', kind: 'run', label: '执行' },
  shellcommand: { unicode: '▶', ascii: '>', kind: 'run', label: '执行' },
  command: { unicode: '▶', ascii: '>', kind: 'run', label: '执行' },
  // 读取类
  read: { unicode: '▷', ascii: '>', kind: 'read', label: '读取' },
  readfile: { unicode: '▷', ascii: '>', kind: 'read', label: '读取' },
  notebookread: { unicode: '▷', ascii: '>', kind: 'read', label: '读取' },
  // 写入类
  write: { unicode: '◆', ascii: '+', kind: 'write', label: '写入' },
  writefile: { unicode: '◆', ascii: '+', kind: 'write', label: '写入' },
  createfile: { unicode: '◆', ascii: '+', kind: 'write', label: '写入' },
  // 编辑类
  edit: { unicode: '◇', ascii: '~', kind: 'edit', label: '编辑' },
  editfile: { unicode: '◇', ascii: '~', kind: 'edit', label: '编辑' },
  multiedit: { unicode: '◇', ascii: '~', kind: 'edit', label: '编辑' },
  notebookedit: { unicode: '◇', ascii: '~', kind: 'edit', label: '编辑' },
  // 搜索类
  glob: { unicode: '⌕', ascii: '?', kind: 'search', label: '搜索' },
  grep: { unicode: '⌕', ascii: '?', kind: 'search', label: '搜索' },
  find: { unicode: '⌕', ascii: '?', kind: 'search', label: '搜索' },
  findfiles: { unicode: '⌕', ascii: '?', kind: 'search', label: '搜索' },
  search: { unicode: '⌕', ascii: '?', kind: 'search', label: '搜索' },
  searchcontent: { unicode: '⌕', ascii: '?', kind: 'search', label: '搜索' },
  ls: { unicode: '⌕', ascii: '?', kind: 'search', label: '搜索' },
  // 网络类
  websearch: { unicode: '⊙', ascii: '@', kind: 'network', label: '网络' },
  webfetch: { unicode: '⊙', ascii: '@', kind: 'network', label: '网络' },
  // 代理类
  agent: { unicode: '◐', ascii: '*', kind: 'agent', label: '代理' },
  task: { unicode: '◐', ascii: '*', kind: 'agent', label: '代理' },
  // 任务类
  todowrite: { unicode: '☐', ascii: '#', kind: 'task', label: '任务' },
});

const DEFAULT_ICON = Object.freeze({ unicode: '●', ascii: '*', label: '工具' });

/**
 * 获取工具图标信息。
 * @param {string} toolName
 * @returns {{ unicode: string, ascii: string, kind?: string, label: string }}
 */
function getToolIcon(toolName) {
  const name = String(toolName || '')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  return TOOL_ICON_MAP[name] || DEFAULT_ICON;
}

/**
 * 获取工具图标(legacy Windows 感知)。
 * @param {string} toolName
 * @param {boolean} isLegacyWin
 * @returns {string} 单个字符
 */
function getToolIconChar(toolName, isLegacyWin = false) {
  const icon = getToolIcon(toolName);
  return isLegacyWin ? icon.ascii : icon.unicode;
}

module.exports = {
  TOOL_ICON_MAP,
  DEFAULT_ICON,
  getToolIcon,
  getToolIconChar,
};
