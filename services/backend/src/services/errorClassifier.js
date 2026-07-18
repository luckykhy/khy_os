'use strict';

/**
 * errorClassifier.js — Structured error analysis and classification.
 *
 * Ported from OpenClaw's errors.ts.
 * Provides:
 *   - Error kind detection: refusal, timeout, rate_limit, context_length
 *   - Cause chain traversal (handles circular references)
 *   - Error code/name/errno extraction
 *   - Sensitive token redaction in error messages
 *   - Human-readable error formatting
 */

// ── Error Kind Detection ───────────────────────────────────────────

/**
 * @typedef {'refusal'|'timeout'|'rate_limit'|'context_length'|'auth'|'network'|'overloaded'|'server_error'|'billing'|'model_not_found'|'cancelled'|'process'|'permission'} ErrorKind
 */

const ERROR_KIND_PATTERNS = {
  refusal: {
    messages: ['refusal', 'content_filter', 'sensitive', 'unhandled stop reason: refusal_policy'],
    codes: [],
  },
  timeout: {
    messages: ['timeout', 'timed out', 'deadline exceeded'],
    codes: ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'],
  },
  rate_limit: {
    messages: ['rate limit', 'too many requests', '429', 'rate_limit_exceeded'],
    codes: ['429'],
  },
  context_length: {
    messages: ['context length', 'too many tokens', 'token limit', 'context_window', 'maximum context', 'max_tokens', 'prompt is too long', 'prompt_too_long', 'prompt too long', 'input is too long', 'input too long', 'request too large', 'too large for', 'reduce the length'],
    codes: [],
  },
  auth: {
    messages: ['unauthorized', 'not authorized', 'not_authorized', 'invalid api key', 'authentication', '401', 'forbidden', '403', 'accessdeniedexception', 'forbiddenexception', 'expiredtokenexception', 'token expired', 'invalid_token', 'invalid token'],
    codes: ['401', '403'],
  },
  network: {
    messages: ['network error', 'fetch failed', 'socket hang up', 'getaddrinfo', 'secure tls connection was established'],
    codes: ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'],
  },
  // ── Extended kinds (unified from aiGateway.classifyError) ────────
  overloaded: {
    messages: ['overloaded', '529', 'service overloaded', 'capacity'],
    codes: ['529'],
  },
  server_error: {
    messages: ['internal server error', '500', '502', '503'],
    codes: ['500', '502', '503'],
  },
  billing: {
    messages: ['billing', 'insufficient_quota', 'payment required', '402'],
    codes: ['402'],
  },
  model_not_found: {
    messages: ['model not found', 'model_not_found', 'does not exist', 'no such model'],
    codes: ['404'],
  },
  cancelled: {
    messages: ['aborted', 'request aborted', 'abort_err', 'signal aborted'],
    codes: [],
  },
  process: {
    messages: ['channel closed', 'reconnecting', 'exited with code', 'spawn', 'launch blocked'],
    codes: [],
  },
  permission: {
    messages: ['permission denied', 'eacces', 'eperm', 'sandbox', 'operation not permitted', 'access denied'],
    codes: ['EACCES', 'EPERM'],
  },
};

/**
 * Detect the kind of error from its message, code, or name.
 *
 * @param {unknown} err
 * @returns {ErrorKind|undefined}
 */
function detectErrorKind(err) {
  const message = _extractMessage(err).toLowerCase();
  const code = extractErrorCode(err)?.toLowerCase() || '';
  const name = _readErrorName(err).toLowerCase();

  for (const [kind, patterns] of Object.entries(ERROR_KIND_PATTERNS)) {
    // Check message patterns
    for (const pattern of patterns.messages) {
      if (message.includes(pattern)) return kind;
    }
    // Check code patterns
    for (const codePattern of patterns.codes) {
      if (code === codePattern.toLowerCase() || name === codePattern.toLowerCase()) return kind;
    }
  }

  // Special case: TimeoutError name
  if (name === 'timeouterror' || name === 'aborterror') return 'timeout';

  return undefined;
}

// ── Error Code Extraction ──────────────────────────────────────────

/**
 * Extract the error code from an error object.
 * Handles `.code`, `.status`, `.statusCode` properties.
 *
 * @param {unknown} err
 * @returns {string|undefined}
 */
function extractErrorCode(err) {
  if (!err || typeof err !== 'object') return undefined;

  const code = err.code;
  if (typeof code === 'string' && code) return code;
  if (typeof code === 'number') return String(code);

  const status = err.status || err.statusCode;
  if (typeof status === 'number') return String(status);

  return undefined;
}

/**
 * Check if an error has a specific errno code.
 */
function hasErrnoCode(err, code) {
  return err && typeof err === 'object' && 'code' in err && err.code === code;
}

// ── Cause Chain Traversal ──────────────────────────────────────────

/**
 * Collect all error candidates from an error's cause chain + nested properties.
 * Handles circular references via Set.
 *
 * @param {unknown} err
 * @returns {unknown[]}
 */
function collectErrorCandidates(err) {
  const candidates = [];
  const seen = new Set();
  const queue = [err];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    candidates.push(current);

    // Traverse known nesting properties
    if (current.cause) queue.push(current.cause);
    if (current.reason) queue.push(current.reason);
    if (current.original) queue.push(current.original);
    if (current.error) queue.push(current.error);
    if (Array.isArray(current.errors)) {
      for (const e of current.errors) queue.push(e);
    }
  }

  return candidates;
}

/**
 * Detect error kind by traversing the full cause chain.
 * Returns the first matching kind found.
 *
 * @param {unknown} err
 * @returns {ErrorKind|undefined}
 */
function detectErrorKindDeep(err) {
  const candidates = collectErrorCandidates(err);
  for (const candidate of candidates) {
    const kind = detectErrorKind(candidate);
    if (kind) return kind;
  }
  return undefined;
}

// ── Error Message Formatting ───────────────────────────────────────

// Patterns for sensitive data redaction
const REDACT_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,                                          // OpenAI keys
  /\b(ghp_[A-Za-z0-9]{20,})\b/g,                                          // GitHub PATs
  /\b(gho_[A-Za-z0-9]{20,})\b/g,                                          // GitHub OAuth
  /Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=\/]{8,})/gi,          // Bearer tokens
  /"(?:apiKey|token|secret|password|accessToken)"\s*:\s*"([^"]{8,})"/g,    // JSON credentials
  /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\b\s*[=:]\s*["']?([^\s"']{8,})/gi, // ENV-style
];

/**
 * Redact sensitive tokens in text.
 * Shows first 6 + last 4 chars of detected secrets.
 */
function redactSensitiveText(text) {
  if (!text || typeof text !== 'string') return text || '';
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, token) => {
      if (!token || token.length < 12) return match.replace(token, '***');
      return match.replace(token, `${token.slice(0, 6)}...${token.slice(-4)}`);
    });
  }
  return result;
}

/**
 * Format an error into a human-readable string with cause chain.
 * Redacts sensitive tokens automatically.
 *
 * @param {unknown} err
 * @returns {string}
 */
function formatErrorMessage(err) {
  let formatted;

  if (err instanceof Error) {
    formatted = err.message || err.name || 'Error';
    // Walk cause chain
    let cause = err.cause;
    const seen = new Set([err]);
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof Error) {
        formatted += ` | ${cause.message || cause.name}`;
        cause = cause.cause;
      } else if (typeof cause === 'string') {
        formatted += ` | ${cause}`;
        break;
      } else {
        break;
      }
    }
  } else if (typeof err === 'string') {
    formatted = err;
  } else if (err && typeof err === 'object') {
    try {
      formatted = JSON.stringify(err);
    } catch {
      formatted = Object.prototype.toString.call(err);
    }
  } else {
    formatted = String(err);
  }

  return redactSensitiveText(formatted);
}

/**
 * Format an uncaught error (prefers stack trace).
 */
function formatUncaughtError(err) {
  if (err instanceof Error && hasErrnoCode(err, 'INVALID_CONFIG')) {
    return formatErrorMessage(err);
  }
  if (err instanceof Error && err.stack) {
    return redactSensitiveText(err.stack);
  }
  return formatErrorMessage(err);
}

// ── Internal Helpers ───────────────────────────────────────────────

function _extractMessage(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') return String(err.message || err.msg || '');
  return String(err || '');
}

function _readErrorName(err) {
  if (err && typeof err === 'object' && typeof err.name === 'string') return err.name;
  return '';
}

// ── G7: ErrorEnvelope — 统一错误信封 ──────────────────────────────
// 从 DeepSeek-TUI error_taxonomy.rs 学习，提供结构化错误封装

/**
 * 错误分类
 */
const CATEGORY = {
  NETWORK: 'network',
  AUTH: 'auth',
  RATE_LIMIT: 'rate_limit',
  CONTEXT: 'context',
  MODEL: 'model',
  INTERNAL: 'internal',
  PERMISSION: 'permission',
  BILLING: 'billing',
};

/**
 * 严重程度
 */
const SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  FATAL: 'fatal',
};

class ErrorEnvelope {
  /**
   * @param {string} category — CATEGORY 枚举值
   * @param {string} severity — SEVERITY 枚举值
   * @param {boolean} recoverable — 是否可恢复
   * @param {string} code — 错误码 (短标识)
   * @param {string} message — 人类可读消息
   * @param {object} [context] — 附加上下文
   */
  constructor(category, severity, recoverable, code, message, context = {}) {
    this.category = category;
    this.severity = severity;
    this.recoverable = recoverable;
    this.code = code;
    this.message = message;
    this.context = context;
    this.timestamp = Date.now();
  }

  /** 从已有错误对象创建 */
  static fromError(err) {
    const kind = detectErrorKindDeep(err) || 'unknown';
    const category = _kindToCategory(kind);
    const recoverable = isRetryable(kind);
    const severity = recoverable ? SEVERITY.WARNING : SEVERITY.ERROR;
    return new ErrorEnvelope(
      category, severity, recoverable,
      kind, formatErrorMessage(err),
      { originalCode: extractErrorCode(err) }
    );
  }

  /** 工厂：瞬态网络错误 */
  static network(msg) {
    return new ErrorEnvelope(CATEGORY.NETWORK, SEVERITY.WARNING, true, 'network', msg);
  }

  /** 工厂：认证错误 */
  static auth(msg) {
    return new ErrorEnvelope(CATEGORY.AUTH, SEVERITY.ERROR, false, 'auth', msg);
  }

  /** 工厂：上下文溢出 */
  static contextOverflow(msg) {
    return new ErrorEnvelope(CATEGORY.CONTEXT, SEVERITY.WARNING, true, 'context_overflow', msg);
  }

  /** 工厂：致命内部错误 */
  static fatal(msg) {
    return new ErrorEnvelope(CATEGORY.INTERNAL, SEVERITY.FATAL, false, 'fatal', msg);
  }

  /** 工厂：速率限制 */
  static rateLimit(msg) {
    return new ErrorEnvelope(CATEGORY.RATE_LIMIT, SEVERITY.WARNING, true, 'rate_limit', msg);
  }

  /** 工厂：权限错误 */
  static permission(msg) {
    return new ErrorEnvelope(CATEGORY.PERMISSION, SEVERITY.ERROR, false, 'permission', msg);
  }

  toJSON() {
    return {
      category: this.category,
      severity: this.severity,
      recoverable: this.recoverable,
      code: this.code,
      message: this.message,
      context: this.context,
      timestamp: this.timestamp,
    };
  }
}

function _kindToCategory(kind) {
  switch (kind) {
    case 'network': case 'timeout': return CATEGORY.NETWORK;
    case 'auth': return CATEGORY.AUTH;
    case 'rate_limit': case 'overloaded': return CATEGORY.RATE_LIMIT;
    case 'context_length': return CATEGORY.CONTEXT;
    case 'model_not_found': return CATEGORY.MODEL;
    case 'billing': return CATEGORY.BILLING;
    case 'permission': return CATEGORY.PERMISSION;
    default: return CATEGORY.INTERNAL;
  }
}

// ── High-Level Classification API ────────────────────────────────

const RETRYABLE_KINDS = new Set(['timeout', 'network', 'rate_limit', 'overloaded', 'server_error', 'process']);

/**
 * Check if an error kind is retryable.
 * @param {string} kind
 * @returns {boolean}
 */
function isRetryable(kind) {
  return RETRYABLE_KINDS.has(kind);
}

/**
 * Suggest a recovery action for an error kind.
 * @param {string} kind
 * @returns {'retry'|'compress'|'credential_rotate'|'fallback_model'|'reauth'|'abort'}
 */
function suggestRecoveryAction(kind) {
  switch (kind) {
    case 'context_length': return 'compress';
    case 'rate_limit':
    case 'billing':      return 'credential_rotate';
    case 'model_not_found': return 'fallback_model';
    case 'auth':          return 'reauth';
    default:
      return isRetryable(kind) ? 'retry' : 'abort';
  }
}

/**
 * Full structured error classification.
 * Combines status code + message into kind/retryable/action triple.
 *
 * @param {number|string|null} status - HTTP status or error code
 * @param {string} message - Error message text
 * @returns {{ kind: ErrorKind|'unknown', retryable: boolean, action: string }}
 */
function classifyErrorFull(status, message = '') {
  const errObj = {
    code: status,
    message: String(message || ''),
  };
  const kind = detectErrorKindDeep(errObj) || 'unknown';
  return {
    kind,
    retryable: isRetryable(kind),
    action: suggestRecoveryAction(kind),
  };
}

// ── ClassifiedError — multi-flag error classification ────────────

const SHOULD_COMPRESS_KINDS = new Set(['context_length']);
const SHOULD_ROTATE_CREDENTIAL_KINDS = new Set(['rate_limit', 'billing', 'auth']);
const SHOULD_FALLBACK_KINDS = new Set(['model_not_found', 'overloaded', 'server_error', 'process']);
const CONTENT_FILTERED_KINDS = new Set(['refusal']);

/**
 * ClassifiedError — comprehensive error classification with action flags.
 * Replaces scattered if-else chains in adapters with a single source of truth.
 *
 * @param {number|string|null} status - HTTP status or error code
 * @param {string|Error} errorOrMessage - Error object or message text
 * @returns {ClassifiedErrorResult}
 *
 * @typedef {object} ClassifiedErrorResult
 * @property {string} kind - Error kind (ErrorKind enum)
 * @property {boolean} retryable - Safe to retry with same params
 * @property {boolean} shouldCompress - Context too long, compress and retry
 * @property {boolean} shouldRotateCredential - Try a different API key/account
 * @property {boolean} shouldFallback - Try a different model/adapter
 * @property {boolean} contentFiltered - Response blocked by safety filter
 * @property {string} action - Primary suggested recovery action
 */
function classifyError(status, errorOrMessage = '') {
  const errObj = (errorOrMessage && typeof errorOrMessage === 'object')
    ? errorOrMessage
    : { code: status, message: String(errorOrMessage || '') };
  if (status && typeof errObj.code === 'undefined') errObj.code = status;

  const kind = detectErrorKindDeep(errObj) || 'unknown';
  return {
    kind,
    retryable: isRetryable(kind),
    shouldCompress: SHOULD_COMPRESS_KINDS.has(kind),
    shouldRotateCredential: SHOULD_ROTATE_CREDENTIAL_KINDS.has(kind),
    shouldFallback: SHOULD_FALLBACK_KINDS.has(kind),
    contentFiltered: CONTENT_FILTERED_KINDS.has(kind),
    action: suggestRecoveryAction(kind),
  };
}

// ── Auth Permanent Detection ──────────────────────────────────────

const AUTH_PERMANENT_PATTERNS = [
  /suspended/i, /banned/i, /locked/i, /deactivated/i,
  /revoked/i, /invalid.?key/i, /terminated/i,
];

/**
 * Check if an auth error message indicates a permanent (non-recoverable) condition.
 * Permanent = account suspended/banned/locked/deactivated/revoked/terminated.
 * Non-permanent (recoverable) = token expired, temporary 403, rate limit, etc.
 *
 * @param {string} message
 * @returns {boolean}
 */
function isAuthPermanent(message) {
  return AUTH_PERMANENT_PATTERNS.some(p => p.test(String(message || '')));
}

module.exports = {
  detectErrorKind,
  detectErrorKindDeep,
  extractErrorCode,
  hasErrnoCode,
  collectErrorCandidates,
  formatErrorMessage,
  formatUncaughtError,
  redactSensitiveText,
  classifyErrorFull,
  classifyError,
  isRetryable,
  suggestRecoveryAction,
  isAuthPermanent,
  AUTH_PERMANENT_PATTERNS,
  ERROR_KIND_PATTERNS,
  RETRYABLE_KINDS,
  SHOULD_COMPRESS_KINDS,
  SHOULD_ROTATE_CREDENTIAL_KINDS,
  SHOULD_FALLBACK_KINDS,
  // G7: ErrorEnvelope
  ErrorEnvelope,
  CATEGORY,
  SEVERITY,
};
