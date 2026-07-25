/**
 * @pattern Facade
 */
'use strict';

/**
 * _abortHelpers.js — AbortSignal 辅助函数
 *
 * 从 claudeAdapter / codexAdapter / ollamaAdapter / relayApiAdapter 中提取的
 * 完全相同的 abort 处理逻辑，统一复用。
 */

/**
 * 将 abort reason 标准化为字符串。
 * @param {*} reason - AbortSignal.reason 或任意值
 * @returns {string}
 */
function normalizeAbortReason(reason) {
  if (!reason) return 'aborted';
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason.message === 'string') return reason.message;
  try { return JSON.stringify(reason); } catch { return String(reason); }
}

/**
 * 创建一个 AbortError。
 * @param {*} reason - abort 原因
 * @param {string} [prefix='request aborted'] - 错误消息前缀
 * @returns {Error}
 */
function createAbortError(reason, prefix = 'request aborted') {
  const err = new Error(`${prefix}: ${normalizeAbortReason(reason)}`);
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

/**
 * 检测一个错误是否是 abort 类型的错误。
 * @param {*} err
 * @returns {boolean}
 */
function isAbortLikeError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return true;
  const msg = String(err && err.message ? err.message : err || '').toLowerCase();
  return /\baborted\b|\brequest aborted\b|\babort(ed)? by\b|signal aborted|user[-\s]?cancel|abort_err/.test(msg);
}

module.exports = {
  normalizeAbortReason,
  createAbortError,
  isAbortLikeError,
};
