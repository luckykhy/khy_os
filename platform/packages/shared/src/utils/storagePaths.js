'use strict';

/**
 * @pattern Chain of Responsibility, Strategy
 *
 * storagePaths.js — 日志目录的唯一解析口径（纯函数，env 注入，零 IO）。
 *
 * 三个部署级 env 依次让位：KHY_LOG_HOME → KHY_DATA_HOME/logs →
 * KHYQUANT_DATA_HOME/logs → KHY_LOG_DIR。KHY_LOG_DIR 排在最后是刻意的：它是
 * 测试隔离钩子（tests/jest.logIsolation.setup.js），不是部署开关，不能盖过
 * 「<data home>/logs」这条正式契约。
 *
 * 分层：写入落 `<root>/active`，归档落 `<root>/archive`。回滚开关
 * KHY_LOG_LAYOUT=legacy 让写入回到 `<root>` 本身 —— 归档目录**不受开关影响**，
 * 因为已经压好的历史归档不该因为切回 legacy 就从视野里消失（cleanup 仍要能扫到
 * 它们，否则旧归档就成了永远不被回收的孤儿）。
 */

const path = require('path');

function resolveLogDir(env = process.env, fallbackDir = path.join(__dirname, '../../logs')) {
  // KHY_LOG_DIR sits below the data homes on purpose: it is the test-isolation
  // hook (tests/jest.logIsolation.setup.js), not a deployment knob, and must not
  // outrank the canonical <data home>/logs contract.
  const configured = env.KHY_LOG_HOME
    || (env.KHY_DATA_HOME && path.join(env.KHY_DATA_HOME, 'logs'))
    || (env.KHYQUANT_DATA_HOME && path.join(env.KHYQUANT_DATA_HOME, 'logs'))
    || env.KHY_LOG_DIR;
  return configured ? path.resolve(configured) : fallbackDir;
}

function resolveLogWriteDir(env = process.env, fallbackDir) {
  const root = resolveLogDir(env, fallbackDir);
  return String(env.KHY_LOG_LAYOUT || 'active').toLowerCase() === 'legacy'
    ? root
    : path.join(root, 'active');
}

function resolveLogArchiveDir(env = process.env, fallbackDir) {
  return path.join(resolveLogDir(env, fallbackDir), 'archive');
}

module.exports = { resolveLogDir, resolveLogWriteDir, resolveLogArchiveDir };
