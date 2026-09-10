'use strict';

/**
 * ccTaskEstimate.js — 任务时间预估（ZCode 对齐：侧栏显示 2m/9h/1d 预估）
 *
 * 基于任务复杂度（工具调用数、任务类型、历史数据）估算完成时间。
 * 格式对齐 ZCode 的侧栏预估显示。
 *
 * 参考：ZCode 任务时间预估（"2m", "9h", "1d"）
 */

// 基础耗时（秒）— 按任务类型
const BASE_DURATION = Object.freeze({
  read: 2,       // 读取操作
  write: 5,      // 写入操作
  edit: 8,       // 编辑操作
  search: 3,     // 搜索操作
  bash: 10,      // 命令执行
  analyze: 15,   // 分析操作
  default: 5,    // 默认
});

// 工具名 → 任务类型映射
const TOOL_TYPE = Object.freeze({
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Glob: 'search',
  Grep: 'search',
  Bash: 'bash',
  BashOutput: 'bash',
  NotebookEdit: 'edit',
});

/**
 * 根据工具名获取任务类型
 */
function toolToType(toolName) {
  return TOOL_TYPE[toolName] || 'default';
}

/**
 * 格式化时长为 ZCode 风格（2m / 9h / 1d）
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (seconds < 0) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/**
 * 估算单个任务耗时（秒）
 * @param {{ tool: string, args?: object }} step
 * @returns {number}
 */
function estimateStep(step) {
  const type = toolToType(step.tool || '');
  let base = BASE_DURATION[type] || BASE_DURATION.default;

  // 根据参数复杂度调整
  if (step.args) {
    const argStr = JSON.stringify(step.args);
    if (argStr.length > 200) base *= 1.5; // 复杂参数
    if (argStr.length > 500) base *= 1.5; // 更复杂
  }

  return base;
}

/**
 * 估算一组任务总耗时
 * @param {Array<{ tool: string, args?: object }>} steps
 * @returns {number} 总秒数
 */
function estimateTotal(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  return steps.reduce((sum, step) => sum + estimateStep(step), 0);
}

/**
 * 为子 Agent 任务生成预估
 * @param {{ name: string, steps?: Array }} agent
 * @returns {{ seconds: number, label: string }}
 */
function estimateAgent(agent) {
  const seconds = estimateTotal(agent.steps || []);
  return {
    seconds,
    label: formatDuration(seconds),
  };
}

/**
 * 为所有子 Agent 生成预估
 * @param {Array<{ name: string, steps?: Array }>} agents
 * @returns {Array<{ name: string, seconds: number, label: string }>}
 */
function estimateAllAgents(agents) {
  if (!Array.isArray(agents)) return [];
  return agents.map((agent) => ({
    name: agent.name,
    ...estimateAgent(agent),
  }));
}

module.exports = {
  formatDuration,
  estimateStep,
  estimateTotal,
  estimateAgent,
  estimateAllAgents,
  BASE_DURATION,
  TOOL_TYPE,
};
