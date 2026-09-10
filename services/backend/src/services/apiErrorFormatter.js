'use strict';

/**
 * apiErrorFormatter.js — 四端统一 API 错误格式化(服务层单一真源)。
 *
 * 把后端错误归一为 Web/Mobile 可消费的结构化 JSON, 与 CLI/TUI 共享同一套
 * 错误分类 + 修复建议逻辑(经 cliErrorDescriptor.describeCliError)。
 *
 * 四端错误契约:
 *   CLI  → printErrorPanel({ title, message, reason, suggestions, stack })
 *   TUI  → showError({ title, message, code }) + stderr 前缀对齐 CLI
 *   Web  → el-alert / KhyEmpty 消费 { code, title, reason, suggestions, kind }
 *   Mobile → toast / alert 消费 { code, title, reason, suggestions, kind }
 *
 * 本模块只产结构化对象(零 IO), 由 routes 层写入 res.json()。
 */

const { describeCliError, _kindLabel } = require('./cliErrorDescriptor');

/**
 * 把任意错误归一为四端统一的结构化错误对象。
 *
 * @param {unknown} err  Error / 字符串 / {error|message, exitCode|status, stderr}
 * @param {object} [opts]
 * @param {number} [opts.httpStatus]  HTTP 状态码(可显式覆盖)
 * @param {string} [opts.context]    命令/操作上下文(如命令名、路径)
 * @param {string} [opts.fallbackReason] 兜底原因文案
 * @returns {{
 *   success: false,
 *   code: string,          // 稳定错误码(如 AUTH_FAILED, RATE_LIMITED, NETWORK_ERROR)
 *   title: string,         // 中文标题(如 "认证失败")
 *   reason: string,        // 真实原因(不含堆栈)
 *   suggestions: string[], // 可操作修复建议(永不为空)
 *   kind: string,          // 错误类别(如 auth, network, rate_limit)
 *   httpStatus: number,    // 建议 HTTP 状态码
 *   exitCode: number|undefined, // 进程退出码(如有)
 * }}
 */
function formatApiError(err, opts = {}) {
  const desc = describeCliError(err, opts);
  const kind = desc.kind || 'unknown';
  const code = _kindToCode(kind, desc.exitCode);
  const httpStatus = opts.httpStatus || _kindToHttpStatus(kind, desc.exitCode);

  return {
    success: false,
    code,
    title: desc.title,
    reason: desc.reason,
    suggestions: desc.suggestions,
    kind,
    httpStatus,
    exitCode: desc.exitCode,
  };
}

/**
 * 把错误类别映射为稳定错误码(Web/Mobile 用 switch/case 分发)。
 * @param {string} kind
 * @param {number|undefined} exitCode
 * @returns {string}
 */
function _kindToCode(kind, exitCode) {
  const map = {
    network: 'NETWORK_ERROR',
    timeout: 'TIMEOUT',
    rate_limit: 'RATE_LIMITED',
    context_length: 'CONTEXT_TOO_LONG',
    auth: exitCode === 403 ? 'FORBIDDEN' : 'AUTH_FAILED',
    permission: 'PERMISSION_DENIED',
    billing: 'BILLING_INSUFFICIENT',
    model_not_found: 'MODEL_NOT_FOUND',
    overloaded: 'UPSTREAM_OVERLOADED',
    server_error: 'UPSTREAM_ERROR',
    refusal: 'CONTENT_REFUSED',
    cancelled: 'CANCELLED',
    process: 'PROCESS_ERROR',
  };
  return map[kind] || 'UNKNOWN_ERROR';
}

/**
 * 把错误类别映射为建议 HTTP 状态码。
 * @param {string} kind
 * @param {number|undefined} exitCode
 * @returns {number}
 */
function _kindToHttpStatus(kind, exitCode) {
  // 有显式 HTTP 退出码且是标准 4xx/5xx 时优先采用
  if (typeof exitCode === 'number' && exitCode >= 400 && exitCode < 600) {
    return exitCode;
  }
  const map = {
    network: 502,
    timeout: 504,
    rate_limit: 429,
    context_length: 413,
    auth: 401,
    permission: 403,
    billing: 402,
    model_not_found: 404,
    overloaded: 503,
    server_error: 502,
    refusal: 422,
    cancelled: 499,
    process: 500,
  };
  return map[kind] || 500;
}

/**
 * Express 错误响应辅助: 直接写入 res。
 * 用法: `res.status(httpStatus).json(formatApiError(err))`
 *
 * @param {import('express').Response} res
 * @param {unknown} err
 * @param {object} [opts]
 */
function sendApiError(res, err, opts = {}) {
  const formatted = formatApiError(err, opts);
  res.status(formatted.httpStatus).json(formatted);
}

module.exports = {
  formatApiError,
  sendApiError,
  _kindToCode,
  _kindToHttpStatus,
};
