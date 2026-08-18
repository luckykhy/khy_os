'use strict';

/**
 * gateway/errorClassifier.js — error classification for AIGateway.
 *
 * Wraps the base errorClassifier module with gateway-specific error sets
 * and helpers, extracted from services/gateway/aiGateway.js.
 *
 * @module gateway/errorClassifier
 */

const {
  detectErrorKindDeep,
  formatErrorMessage: fmtError,
  isRetryable: _ecIsRetryable,
} = require('../errorClassifier');

// Error types that indicate a permanently dead endpoint (404, 4xx bad request,
// 5xx server error). These trigger the dead-endpoint relaxation path, allowing
// the gateway to fall through to alternative adapters instead of retrying the
// same broken endpoint.
const DEAD_ENDPOINT_ERROR_TYPES = new Set([
  'model_not_found',
  'unavailable',
  'bad_request',
  'server_error',
]);

/**
 * Check whether an error type signals a dead/unavailable endpoint.
 *
 * @param {string} errorType
 * @returns {boolean}
 */
function isDeadEndpointErrorType(errorType) {
  const type = String(errorType || '')
    .trim()
    .toLowerCase();
  return DEAD_ENDPOINT_ERROR_TYPES.has(type);
}

/**
 * Resolve the result error type from an explicit type, status code, and message.
 * Falls back to classifyError when no explicit type is provided.
 *
 * @param {number} statusCode
 * @param {string} message
 * @param {string} [explicitType]
 * @returns {string}
 */
function resolveResultErrorType(statusCode, message, explicitType) {
  const rawType = String(explicitType || '').trim();
  if (!rawType || rawType.toLowerCase() === 'unknown') {
    return classifyError(statusCode, message);
  }
  return rawType;
}

/**
 * Classify an error from status code and message. Delegates to the base
 * errorClassifier then applies gateway-specific patterns.
 *
 * @param {number} status
 * @param {string} message
 * @returns {string}
 */
function classifyError(status, message = '') {
  const rawMessage = String(message || '');
  const lower = rawMessage.toLowerCase();

  // Check for abort/cancellation first
  if (
    /aborterror|abort_err|\baborted\b|\brequest aborted\b|\babort(ed)? by\b|signal aborted|user[-\s]?cancel/.test(
      lower
    )
  ) {
    return 'cancelled';
  }
  if (/\bcancelled\b|\bcanceled\b/.test(lower)) {
    return 'process';
  }

  // Recover embedded HTTP status code from message (e.g. "Request failed with status code 504")
  if (!status || status < 400 || status > 599) {
    const embedded = httpStatusFromMessage(rawMessage);
    if (embedded) {
      status = embedded;
    }
  }

  // Status code short-circuits (gateway-specific: base classifier has no bare-code matches)
  if (status === 400) {
    return 'bad_request';
  }
  if (status === 408 || status === 504) {
    return 'timeout';
  }

  // Gateway-specific idle-timeout patterns (not in base classifier)
  if (/adapter\s+\S+\s+idle timeout|stream idle timeout|\bidle timeout\b/.test(lower)) {
    return 'timeout';
  }
  // Gateway-specific queue-timeout patterns
  if (/adapter\s+\S+\s+queue timeout|queue task timeout/.test(lower)) {
    return 'timeout';
  }
  // Residual unresponsive patterns
  if (/did not respond within|stream stalled|\bunresponsive\b/.test(lower)) {
    return 'timeout';
  }
  // Adapter unavailable / not-installed patterns
  if (/adapter\s+\S+\s+unavailable|not installed|command\s+\S+\s+not\s+found/.test(lower)) {
    return 'unavailable';
  }

  // Transport-reconnect messages from the codex / CLI-tool bridges mean the
  // CONNECTION stalled and can be retried — a transient NETWORK event, even
  // though the base classifier buckets `reconnecting` / `channel closed` /
  // `failed to record rollout items` under 'process' (a local process crash).
  // The gateway promotes these to 'network' so retry/cooling logic treats them
  // as transient (see cliToolAdapter.isTransientTransportMessage). Checked
  // before detectErrorKindDeep so messages the base leaves unclassified (e.g.
  // "failed to record rollout items") still land on 'network'.
  if (
    /reconnecting|channel closed|failed to record rollout items|transport issue during rollout recording/.test(
      lower
    )
  ) {
    return 'network';
  }

  // Try structured detection from errorClassifier
  if (status || rawMessage) {
    const errObj = { code: status, message: rawMessage };
    const kind = detectErrorKindDeep(errObj);
    if (kind) {
      return kind;
    }
  }

  // Residual patterns (gateway safety net)
  // 死连接/网络层错误全集:keep-alive 连接长空闲后被服务端关闭,复用时报
  // socket hang up / ECONNRESET / EPIPE 等——历史上这些消息退化成 unknown,
  // 吃了更长的冷却。在退化为 unknown 之前先兼容归入 network。
  if (
    /econnreset|econnrefused|econnaborted|enotfound|ehostunreach|enetunreach|etimedout|eai_again|epipe|broken pipe|connection reset|fetch failed|socket hang up|getaddrinfo|network error/.test(
      lower
    )
  ) {
    return 'network';
  }
  if (/timeout|timed?\s*out|deadline/.test(lower)) {
    return 'timeout';
  }
  if (/permission|denied|forbidden/.test(lower)) {
    return 'auth';
  }
  if (/rate\s*limit|throttl/.test(lower)) {
    return 'rate_limit';
  }
  if (/server\s*error/.test(lower)) {
    return 'server_error';
  }
  if (/not\s*found/.test(lower)) {
    return 'model_not_found';
  }

  return 'unknown';
}

/**
 * Check if a message indicates a reconnect or channel-closed event.
 *
 * @param {string} lower - Already-lowercased message
 * @returns {boolean}
 */
function isReconnectOrChannelClosedMessage(lower) {
  return /reconnecting|channel closed|failed to record rollout items|transport issue during rollout recording/.test(
    lower
  );
}

/**
 * Recover an HTTP status code embedded in an error message.
 *
 * @param {string} message
 * @returns {number}
 */
function httpStatusFromMessage(message = '') {
  const m = String(message || '').match(
    /(?:status(?:\s*code)?|http(?:\s*status)?)\D{0,4}(\d{3})\b/i
  );
  if (!m) {
    return 0;
  }
  const code = parseInt(m[1], 10);
  return code >= 400 && code <= 599 ? code : 0;
}

module.exports = {
  DEAD_ENDPOINT_ERROR_TYPES,
  isDeadEndpointErrorType,
  resolveResultErrorType,
  classifyError,
  isReconnectOrChannelClosedMessage,
  httpStatusFromMessage,
  detectErrorKindDeep,
  formatErrorMessage: fmtError,
  isRetryable: _ecIsRetryable,
};
