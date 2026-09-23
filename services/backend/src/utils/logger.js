'use strict';

/**
 * logger.js — 统一日志门面（winston 实例 + CLI 兼容面）
 *
 * 真身是 `@khy/shared`（本地 vendor 副本 `vendor/shared/src/utils/logger.js`）导出的
 * winston logger：DailyRotateFile 落盘 + 开发期 Console transport。历史上 backend
 * 自带一个轻量 console 实现，与 shared 版并行演化成两个真源 —— CLI 侧只好拿
 * `require('../utils/logger').setConsoleLevel('warn')` 去降 winston 的控制台音量
 * （bin/khy.js），落到这个文件上却是 no-op：降音量从未生效，DB Health 审计日志照旧
 * 打进用户终端。本门面重新指向唯一真源，并把 KHY_LOG_LEVEL 的 npm 级别语义
 * （LEVELS 表）和 CLI 启动需要的 setConsoleLevel 作为兼容面挂回去。
 *
 * 使用方式：
 *   const logger = require('./logger');
 *   logger.info('message');            // winston：落盘 + 控制台
 *   logger.setConsoleLevel('warn');    // 只降控制台 transport，文件 transport 不动
 *   logger.LEVELS.info;                // KHY_LOG_LEVEL 级别表（兼容旧消费方）
 */

const sharedLogger = require('../../vendor/shared/src/utils/logger');

// KHY_LOG_LEVEL 级别表 —— winston 自己用 npm 级别字符串（'silent'/'error'/...），
// 这里保留历史 LEVELS 映射给可能还在用数值序的消费方。只读语义：winston 的
// 运行级别由 LOG_LEVEL / logger.level 决定，KHY_LOG_LEVEL 不再被门面消费。
const LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * 只调控制台 transport 的级别，文件 transport 一律不动。
 *
 * CLI 启动时内部审计日志会以 `[info] [DB Health] …` 打进用户终端并撞碎引导进度
 * 行。降的必须只是控制台音量 —— 文件 transport 若被一并降级，日志就真的丢了，
 * 而不是「不显示」（见 bin/khy.js `_quietConsoleLogsForCli`）。
 *
 * @param {string} level - winston npm 级别（'error'|'warn'|'info'|'debug'…）
 * @param {object} [target] - 要调的 logger；缺省调本模块的真身。
 *   畸形目标（null/无 transports）不抛 —— 音量调节绝不能拖垮启动路径。
 * @returns {boolean} 是否真的调到了控制台 transport；没有控制台 transport
 *   （如 NODE_ENV=production 不挂 Console）时如实返回 false。
 */
function setConsoleLevel(level, target) {
  const t = target === undefined || target === null ? sharedLogger : target;
  if (!t || !Array.isArray(t.transports)) return false;
  const consoleTransport = t.transports.find((tr) => tr && tr.name === 'console');
  if (!consoleTransport) return false;
  consoleTransport.level = level;
  return true;
}

sharedLogger.LEVELS = LEVELS;
sharedLogger.setConsoleLevel = setConsoleLevel;

module.exports = sharedLogger;
