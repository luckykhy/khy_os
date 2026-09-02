'use strict';

/**
 * classifyKhyError.js — 把任意错误归类成 KhyError 七件套（backend 委托层）。
 *
 * 单一真源在 `@khy/shared/src/errorEnvelope.js`（前后端共用），
 * 这里只是 backend 的 re-export，让 service 层 require 路径保持稳定。
 *
 * 为什么不全删掉：因为很多 backend 文件 `require('../utils/classifyKhyError')`，
 * 把它们一起重写的工作量 > 留一层薄代理。代理只做一件事：把 shared 的能力
 * 用 khyError.js 的工厂重新包装，让返回的对象保留 backend Error 原型链，
 * 既有 `err instanceof Error` / `err.cause` 的检查照旧可用。
 */

const { toKhyError, khyError, isKhyError } = require('./khyError');
const shared = require('../../../../platform/packages/shared/src/errorEnvelope');

/**
 * 把 shared 的 Error 实例（轻量版）转换为 backend 的 Error（七件套）。
 * shared 那边为了零依赖只走 new Error + 直接挂字段，没走 khyError 工厂。
 * 这里把字段补齐，确保既有 isKhyError / category / severity / hint 都非空。
 */
function _toBackendKhy(sharedEnv) {
  if (isKhyError(sharedEnv)) return sharedEnv;
  // 透传七件套字段
  const err = new Error(String(sharedEnv.message || sharedEnv.code || 'UNKNOWN'));
  err.code = sharedEnv.code;
  err.hint = sharedEnv.hint;
  err.recoverable = !!sharedEnv.recoverable;
  err.retryable = !!sharedEnv.retryable;
  err.category = sharedEnv.category;
  err.severity = sharedEnv.severity;
  err.actionable = sharedEnv.actionable !== false;
  err.isKhyError = true;
  if (sharedEnv.cause !== undefined) err.cause = sharedEnv.cause;
  return err;
}

function classifyKhyError(err, opts = {}) {
  const extra = opts.extra && typeof opts.extra === 'object' ? opts.extra : {};
  // ① 已是 backend KhyError：原样透传
  if (isKhyError(err)) return err;
  // ② 委托 shared 做完整归类（前后端共用真源）
  const sharedEnv = shared.classifyKhyError(err, opts);
  const backendEnv = _toBackendKhy(sharedEnv);
  // ③ 仅在 shared 真兜底到 UNKNOWN 时，才保留 err.code 上挂的 code。
  // 否则 STATUS_TABLE / ERRNO_TABLE 命中时的「重写 code」是有意义的
  // （比如 ENOENT → IO_FAILED），不能被 err.code 反向覆盖。
  if (backendEnv.code === 'UNKNOWN' && err && typeof err.code === 'string' && err.code) {
    backendEnv.code = String(err.code);
  }
  // ④ 允许 extra 覆盖
  if (Object.keys(extra).length > 0) {
    return khyError(backendEnv.code, backendEnv.message, { ...backendEnv, ...extra });
  }
  return backendEnv;
}

function ensureKhyError(err, opts = {}) {
  const enriched = classifyKhyError(err, opts);
  // 兜底：万一同步漂移，从 shared 重新查表
  if (!enriched.category) enriched.category = shared.getCategorySpec().code;
  if (!enriched.severity) enriched.severity = shared.getSeveritySpec().code;
  return enriched;
}

module.exports = {
  classifyKhyError,
  ensureKhyError,
  // 暴露内部表供测试 / 文档使用
  _internals: {
    STATUS_TABLE: shared.STATUS_TABLE,
    ERRNO_TABLE: shared.ERRNO_TABLE,
    NAME_TABLE: shared.NAME_TABLE,
    MESSAGE_TABLE: shared.MESSAGE_TABLE,
  },
};