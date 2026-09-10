'use strict';

/**
 * ccToolFormat.js —— 工具参数摘要格式化
 *
 * CC 模式下工具调用卡片中参数的展示格式化。
 *
 * 参考：[DESIGN-ARCH-081] Phase 3: 消息显示格式
 */

/**
 * 截断路径（保留首尾）
 */
function truncatePath(p, max) {
  if (!p) return '';
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  if (parts.length > 2) return parts[0] + '/…/' + parts[parts.length - 1];
  return p.slice(0, max - 1) + '…';
}

/**
 * 截断命令
 */
function truncateCommand(c, max) {
  if (!c) return '';
  if (c.length <= max) return c;
  return c.slice(0, max - 3) + '…';
}

/**
 * 截断字符串
 */
function truncateString(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '…';
}

/**
 * 生成工具参数摘要（一行）
 */
function summarizeToolParams(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return truncatePath(input.file_path, 40);
    case 'Bash':
      return truncateCommand(input.command, 40);
    case 'Grep':
      return truncateString(input.pattern, 30);
    case 'Glob':
      return input.pattern || '*';
    case 'WebFetch':
      return truncateString(input.url, 40);
    case 'WebSearch':
      return truncateString(input.query, 30);
    default:
      return JSON.stringify(input).slice(0, 40);
  }
}

/**
 * 格式化工具参数为多行展示
 */
function formatToolParams(name, input) {
  if (!input) return [];
  const lines = [];
  for (const [key, value] of Object.entries(input)) {
    const valStr = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
    lines.push(`  ${key}: ${valStr}`);
  }
  return lines;
}

/**
 * 生成工具结果摘要
 */
function summarizeToolResult(result) {
  if (!result) return '';
  const lines = result.split('\n').length;
  return `${lines} lines`;
}

module.exports = {
  truncatePath,
  truncateCommand,
  truncateString,
  summarizeToolParams,
  formatToolParams,
  summarizeToolResult,
};
