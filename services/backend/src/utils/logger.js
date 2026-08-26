'use strict';

/**
 * 后端 logger 门面 —— 在 @khy/shared 的 winston 实例上补一个「控制台音量」旋钮。
 *
 * shared 那边只按 `NODE_ENV !== 'production'` 决定挂不挂 Console transport。这条规则
 * 对 `npm run dev` 的服务器是对的(终端就是拿来看日志的),对 khy CLI 却是错的:交互式
 * CLI 的终端属于启动横幅和 TUI,内部审计日志插进去就是噪音 —— 启动时那几行
 * `2026-… [info] [DB Health] …` 正是这么来的,还会跟 `\r` 覆写的引导进度行抢同一行。
 *
 * 这里不动 shared(它同时服务 ai-backend 与后端服务器),只在后端门面上暴露音量控制:
 * 两个 DailyRotateFile transport 一律不受影响,日志照旧全量落盘,改的只是终端可见性。
 */

const logger = require('@khy/shared/utils/logger');

/**
 * 调整控制台 transport 的最低输出级别;文件 transport 不受影响。
 *
 * @param {string} level - winston 级别名。例如 'warn' 只放行 warn/error。
 * @param {object} [target] - 目标 logger(测试注入),默认共享实例。
 * @returns {boolean} 是否找到并调整了控制台 transport。
 */
function setConsoleLevel(level, target = logger) {
  let changed = false;
  try {
    for (const transport of (target && target.transports) || []) {
      if (transport && transport.name === 'console') {
        transport.level = level;
        changed = true;
      }
    }
  } catch {
    // 音量调节是尽力而为:调不动最多是终端吵一点,绝不能因此拖垮启动。
  }
  return changed;
}

logger.setConsoleLevel = setConsoleLevel;

module.exports = logger;
