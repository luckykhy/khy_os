'use strict';

/**
 * webTools.js — `/web-tools` 命令入口（薄壳）。对齐 Claude Code `/web-tools`：
 * 查看当前联网搜索后端 (Kiro MCP) 与运行期动态引擎 (search_engines.json /
 * KHY_SEARCH_EXTRA_ENGINES) 配置，并给出编辑指引。
 *
 * 分层：
 *   - IO（探测后端 / 读盘）  → services/webToolsService.js::gatherWebToolsStatus
 *   - 纯文案（渲染）         → cli/webToolsFormat.js::formatWebTools
 *   - 本 handler             → 串联两者、打印
 *
 * 门控 KHY_WEB_TOOLS 默认开；关 → 命令不接管（返回 false，字节回退：命令视作未知）。
 */

const { printInfo, printError } = require('../formatters');
const { webToolsEnabled, formatWebTools } = require('../webToolsFormat');

/**
 * `/web-tools` 入口。
 * @param {string} subCommand
 * @param {string[]} [args]
 * @param {object} [options]
 * @returns {Promise<boolean>} 是否接管该命令（门控关 → false）。
 */
async function handleWebTools(subCommand, args = [], options = {}) {
  if (!webToolsEnabled(process.env)) {
    printInfo('web-tools 命令未启用（KHY_WEB_TOOLS 为关）。');
    return false;
  }

  let data;
  try {
    const svc = require('../../services/webToolsService');
    data = await svc.gatherWebToolsStatus({ env: process.env });
  } catch (e) {
    printError(`采集联网搜索配置失败：${(e && e.message) || e}`);
    return true;
  }

  if (!data || !data.success) {
    printError((data && data.error) || '采集联网搜索配置失败。');
    return true;
  }

  const text = formatWebTools(data, process.env);
  if (text) {
    printInfo(text);
  } else {
    // 门控在采集后被关，或渲染返回空——退化为最简可读输出。
    printInfo(`搜索后端：Kiro MCP ${data.backend && data.backend.available ? '可用' : '不可用'}`);
  }
  return true;
}

module.exports = { handleWebTools };
