/**
 * @pattern Interpreter
 */
'use strict';

/**
 * _errorClassifiers.js — 统一的适配器级错误分类
 *
 * 合并了 claudeAdapter (classifyClaudeError)、ollamaAdapter (classifyOllamaError)、
 * localLLMAdapter (classifyLocalErrorType)、cliToolAdapter (classifyCliErrorType)、
 * relayApiAdapter (_classifyRelayFailure + _isTransientRelayError) 的错误分类逻辑。
 *
 * 返回值: 'timeout' | 'auth' | 'permission' | 'network' | 'rate_limit' |
 *         'process' | 'cancelled' | 'unavailable' | 'unsupported' |
 *         'server_error' | 'bad_request' | 'unknown'
 */

const { isAbortLikeError } = require('./_abortHelpers');

// 瞬态错误状态码（用于重试判断）
const TRANSIENT_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

// GLM/智谱把「模型不存在/未开通」语义藏在 HTTP 400 + code 1211 + 中文消息「模型不存在」里,
// 而非标准的 404 model_not_found。英文-only 的 model_not_found 匹配串(model not found /
// does not exist)+ code 404 全都漏掉它 → 降级成 bad_request → 视觉降级链、冷却放行、
// modelNotFoundRecovery 恢复提示三处全部失灵(文本 glm-4.7-flash 与识图 glm-4.6v-flash 同因)。
// 命中「模型不存在」或错误码 1211 时,把它正名为 model_not_found —— 这是**语义等价**的映射
// (账号未领取该免费模型 = 该模型对本账号不存在),而非改变分类语义。
// 门控 KHY_GLM_CN_MODEL_NOT_FOUND(默认开):关(0/false/off/no)→ 逐字节回退旧行为(→bad_request)。
const _GLM_CN_MODEL_NOT_FOUND_OFF = new Set(['0', 'false', 'off', 'no']);
function _glmCnModelNotFoundEnabled() {
  try {
    const v = String(process.env.KHY_GLM_CN_MODEL_NOT_FOUND == null
      ? '' : process.env.KHY_GLM_CN_MODEL_NOT_FOUND).trim().toLowerCase();
    return !_GLM_CN_MODEL_NOT_FOUND_OFF.has(v);
  } catch {
    return true;
  }
}

/**
 * 判断是否为瞬态（可重试）错误。
 * @param {Error|null} err
 * @param {number} statusCode - HTTP 状态码
 * @param {string} errorText - 错误文本
 * @returns {boolean}
 */
function isTransientError(err, statusCode = 0, errorText = '') {
  const status = Number(statusCode || 0);
  if (TRANSIENT_STATUS_CODES.has(status)) return true;
  const msg = String(errorText || err?.message || '').toLowerCase();
  if (!msg) return false;
  if (/request timeout|proxy timeout|timed out|deadline exceeded/.test(msg)) return true;
  if (/(?:econnreset|econnrefused|enotfound|ehostunreach|enetunreach|eai_again|socket hang up|fetch failed|getaddrinfo|network error|broken pipe)/.test(msg)) return true;
  if (/client network socket disconnected before secure tls connection was established/.test(msg)) return true;
  if (/temporarily unavailable|service unavailable|bad gateway/.test(msg)) return true;
  return false;
}

/**
 * 统一的适配器错误分类函数。
 *
 * 兼容多种调用签名：
 *   classifyAdapterError(err)
 *   classifyAdapterError(err, { statusCode, adapterHint })
 *
 * @param {Error|string|*} err - 错误对象或错误消息
 * @param {object} [opts]
 * @param {number} [opts.statusCode=0] - HTTP 状态码
 * @param {string} [opts.adapterHint=''] - 适配器名称提示（用于特定分类逻辑）
 * @returns {string} 错误类型
 */
function classifyAdapterError(err, { statusCode = 0, adapterHint = '' } = {}) {
  const status = Number(statusCode || 0);
  const message = String(err && err.message ? err.message : err || '');
  const lower = message.toLowerCase();

  // 1. Abort 检测（最高优先级，避免被 detectErrorKindDeep 误分类）
  if (isAbortLikeError(err)) return 'cancelled';

  // 1b. GLM/智谱 code 1211「模型不存在」(账号未领取该免费模型)——语义等价 model_not_found。
  //     智谱以 HTTP 400 + 中文消息返回此语义,英文-only 的 model_not_found 匹配串会漏掉它,
  //     导致降级成 bad_request(视觉降级链/冷却放行/恢复提示全部失灵)。门控默认开,关则回退。
  if (_glmCnModelNotFoundEnabled() && (/模型不存在/.test(message) || /code["'\s:=]*1211\b/.test(lower))) {
    return 'model_not_found';
  }

  // 2. 尝试使用 errorClassifier 的结构化检测（如果可用）
  try {
    const { detectErrorKindDeep } = require('../../errorClassifier');
    if (typeof detectErrorKindDeep === 'function') {
      const structured = detectErrorKindDeep(err || { message });
      if (structured) return structured;
    }
  } catch { /* errorClassifier 不可用，继续正则匹配 */ }

  // 3. cancelled/process (非 abort 类型的取消)
  if (/\bcancelled\b|\bcanceled\b/.test(lower)) return 'process';

  // 4. 超时
  if (/timeout|timed out|deadline exceeded|unresponsive|stalled/.test(lower)) return 'timeout';

  // 5. 认证
  if (status === 401 || status === 403 ||
      /unauthorized|forbidden|invalid api key|apikeysource|not authenticated|auth unavailable|login/.test(lower)) {
    return 'auth';
  }

  // 6. 权限
  if (/permission denied|operation not permitted|access denied|sandbox|eacces|eperm/.test(lower)) {
    return 'permission';
  }

  // 7. 网络
  if (/\b(?:econnreset|econnrefused|enotfound|ehostunreach|enetunreach|eai_again)\b|network error|fetch failed|socket hang up|getaddrinfo|proxy/i.test(lower)) {
    return 'network';
  }
  if (isTransientError(null, status, lower)) return 'network';

  // 8. 进程错误（CLI/bridge 相关）
  if (/without emitting stream-json output|channel closed|reconnecting|launch blocked|exited with code|spawn|handshake timeout|bridge canceled|process error|failed to record rollout items/.test(lower)) {
    return 'process';
  }
  // localLLM 进程类错误
  if (/socket hang up|broken pipe/.test(lower)) return 'process';

  // 9. 限流
  if (status === 429 || /rate.?limit|too many requests/.test(lower)) return 'rate_limit';

  // 10. 不可用
  if (/not installed|command .* not found|not found|no inference backend available|model file/.test(lower)) {
    if (status !== 404 || !/api|endpoint/i.test(lower)) return 'unavailable';
  }

  // 11. 不支持（localLLM 特有）
  if (/not support|unsupported/.test(lower)) return 'unsupported';

  // 12. HTTP 状态码兜底
  if (status === 404) return 'unavailable';
  if (status >= 500 && status < 600) return 'server_error';
  if (status >= 400) return 'bad_request';

  return 'unknown';
}

/**
 * Ensure a response has an errorType field.
 * If missing or 'unknown', runs classifyAdapterError to fill it.
 * No-op for success responses.
 *
 * @param {object} result - Adapter response
 * @returns {object} Same result with errorType guaranteed
 */
function ensureErrorType(result) {
  if (!result || result.success) return result;
  if (!result.errorType || result.errorType === 'unknown') {
    result.errorType = classifyAdapterError(
      result.error || result,
      { statusCode: result.statusCode }
    );
  }
  return result;
}

module.exports = {
  classifyAdapterError,
  isTransientError,
  ensureErrorType,
  TRANSIENT_STATUS_CODES,
};
