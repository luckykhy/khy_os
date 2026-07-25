'use strict';

/**
 * retryWithBackoff.js — Exponential backoff retry with jitter.
 *
 * Ported from OpenClaw's retry.ts:
 *   - Configurable attempts, delay bounds, jitter
 *   - shouldRetry predicate for error classification
 *   - retryAfterMs parser for server backpressure (Retry-After header)
 *   - onRetry callback for telemetry
 *
 * Constants:
 *   DEFAULT_ATTEMPTS = 3
 *   DEFAULT_MIN_DELAY = 300ms
 *   DEFAULT_MAX_DELAY = 30000ms
 *   DEFAULT_JITTER = 1.0 (±100%)
 */

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MIN_DELAY = 300;
const DEFAULT_MAX_DELAY = 30000;
const DEFAULT_JITTER = 1.0;

// ── Persistent retry mode (CI / unattended) ─────────────────────────────
// Enabled via KHY_UNATTENDED_RETRY=true. For 429/529 errors only.
// Keeps retrying with capped backoff until the rate window resets or
// an absolute cap (6h) is reached. Emits heartbeat every 30s to keep
// CI hosts alive.
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000;   // 5 min cap per sleep
const PERSISTENT_ABSOLUTE_CAP_MS = 6 * 60 * 60 * 1000; // 6 hour hard stop
const HEARTBEAT_INTERVAL_MS = 30_000;                // 30s keepalive

/**
 * Execute a function with exponential backoff retry.
 *
 * @param {function} fn - Async function to execute
 * @param {object} [opts]
 * @param {number} [opts.attempts=3] - Max attempts (1 = no retry)
 * @param {number} [opts.minDelayMs=300] - Minimum delay between retries
 * @param {number} [opts.maxDelayMs=30000] - Maximum delay between retries
 * @param {number} [opts.jitter=1.0] - Jitter fraction [0,1]. 1.0 = ±100%
 * @param {string} [opts.label] - Diagnostic label for logging
 * @param {function} [opts.shouldRetry] - (err, attempt) => boolean. Default: always retry
 * @param {function} [opts.retryAfterMs] - (err) => number|undefined. Extract Retry-After from error
 * @param {function} [opts.onRetry] - (info: RetryInfo) => void. Called before each retry sleep
 * @param {AbortSignal} [opts.signal] - AbortSignal for cancellation
 * @returns {Promise<T>} Result of fn()
 */
async function retryWithBackoff(fn, opts = {}) {
  const {
    attempts = DEFAULT_ATTEMPTS,
    minDelayMs = DEFAULT_MIN_DELAY,
    maxDelayMs = DEFAULT_MAX_DELAY,
    jitter = DEFAULT_JITTER,
    label,
    shouldRetry,
    retryAfterMs,
    onRetry,
    signal,
  } = opts;

  const maxAttempts = Math.max(1, Math.floor(attempts));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check abort before each attempt
    if (signal?.aborted) {
      throw new Error(`Retry aborted${label ? ` (${label})` : ''}`);
    }

    try {
      return await fn(attempt);
    } catch (err) {
      // Last attempt — throw without retry
      if (attempt >= maxAttempts) throw err;

      // Check if error is retryable
      if (shouldRetry && !shouldRetry(err, attempt)) throw err;

      // Calculate delay
      let baseDelay;

      // Check for server-specified retry-after
      const serverDelay = retryAfterMs ? retryAfterMs(err) : undefined;
      if (serverDelay != null && serverDelay > 0) {
        baseDelay = Math.max(serverDelay, minDelayMs);
      } else {
        // Exponential backoff: minDelay * 2^(attempt-1)
        baseDelay = minDelayMs * Math.pow(2, attempt - 1);
      }

      // Apply jitter: ±(jitter * baseDelay)
      if (jitter > 0) {
        const jitterRange = jitter * baseDelay;
        baseDelay += (Math.random() * 2 - 1) * jitterRange;
      }

      // Clamp to [minDelayMs, maxDelayMs]
      const delayMs = Math.min(maxDelayMs, Math.max(minDelayMs, Math.round(baseDelay)));

      // Emit retry callback
      if (onRetry) {
        onRetry({
          attempt,
          maxAttempts,
          delayMs,
          err,
          label,
        });
      }

      // Sleep with abort support
      await _sleep(delayMs, signal);
    }
  }
}

/**
 * Parse Retry-After from HTTP-style errors.
 * Handles both seconds (integer) and date (HTTP-date) formats.
 *
 * @param {Error|object} err
 * @returns {number|undefined} milliseconds to wait
 */
function parseRetryAfter(err) {
  const header = err?.response?.headers?.['retry-after']
    || err?.headers?.['retry-after']
    || err?.retryAfter;

  if (header == null) return undefined;

  // Integer seconds
  const seconds = Number(header);
  if (!isNaN(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }

  // HTTP-date format
  try {
    const date = new Date(header);
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Common shouldRetry predicate for HTTP errors.
 * Retries on 429 (rate limit), 5xx (server error), network errors.
 *
 * @param {Error|object} err
 * @returns {boolean}
 */
function isRetryableError(err) {
  if (!err) return false;

  // Network errors — by error code first.
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND'
      || err.code === 'ECONNREFUSED' || err.code === 'EAI_AGAIN') {
    return true;
  }

  // HTTP status codes
  const status = err.status || err.statusCode || err.response?.status;
  if (status === 429) return true; // Rate limited
  if (status >= 500 && status < 600) return true; // Server error

  // Anthropic/OpenAI overloaded
  if (err.type === 'overloaded_error') return true;
  if (/overloaded|rate.?limit|too.?many.?requests|capacity/i.test(err.message || '')) {
    return true;
  }

  // Network errors by MESSAGE TEXT (aligns with classifyError's Stage-9 pattern).
  // OpenAI/undici transient failures often arrive as a codeless Error whose only
  // signal is the message string 'socket hang up' — without this branch such
  // failures were classified non-retryable, forcing the user to type 「继续」 to
  // resume a truncated turn. Matching here lets retryWithBackoff auto-recover.
  if (/socket hang up|connection reset|network error|dns|econnreset|etimedout|eai_again/i.test(err.message || '')) {
    return true;
  }

  return false;
}

function _sleep(ms, signal) {
  // 门控 KHY_RETRY_SLEEP_LISTENER_CLEANUP(默认开):legacy 写法把清理包装事后赋给局部 resolve,
  // 但 setTimeout 已捕获原始 resolve → 正常完成时 removeEventListener 永不跑 → abort 监听器泄漏。
  // 门开走清理路径(定时器回调先摘监听器再 resolve);门关/异常 → 逐字节回退 legacy 泄漏写法。
  let _cleanup = true;
  try { _cleanup = require('./retrySleepCleanup').retrySleepCleanupEnabled(process.env); }
  catch { _cleanup = true; }
  return new Promise((resolve, reject) => {
    if (!signal) { setTimeout(resolve, ms); return; }
    if (_cleanup) {
      let onAbort = null;
      const done = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const timer = setTimeout(done, ms);
      onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Retry sleep aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      return;
    }
    // ── legacy path (byte-for-byte original; retains the listener leak) ──
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Retry sleep aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // Clean up listener after sleep completes
    const origResolve = resolve;
    resolve = () => {
      signal.removeEventListener('abort', onAbort);
      origResolve();
    };
  });
}

/**
 * Check if an error qualifies for persistent retry (capacity/rate errors).
 * @param {Error|object} err
 * @returns {boolean}
 */
function isPersistentRetryable(err) {
  if (!err) return false;
  const status = err.status || err.statusCode || err.response?.status;
  if (status === 429 || status === 529) return true;
  if (err.type === 'overloaded_error') return true;
  if (/overloaded|too.?many.?requests|capacity/i.test(err.message || '')) return true;
  return false;
}

/**
 * Persistent retry mode for CI/unattended environments.
 *
 * Unlike normal retry, this keeps retrying capacity errors (429/529) with
 * capped exponential backoff and periodic heartbeat output. Designed for
 * long-running CI jobs where dropping the request is worse than waiting.
 *
 * Enable via: KHY_UNATTENDED_RETRY=true environment variable.
 *
 * @param {function} fn - Async function to execute
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.onHeartbeat] - (info) => void. Called every 30s during waits.
 * @param {function} [opts.onRetry] - (info) => void.
 * @param {string} [opts.label]
 * @returns {Promise<T>}
 */
async function persistentRetry(fn, opts = {}) {
  const { signal, onHeartbeat, onRetry, label } = opts;
  const startTime = Date.now();
  let attempt = 0;

  while (true) {
    if (signal?.aborted) {
      throw new Error(`Persistent retry aborted${label ? ` (${label})` : ''}`);
    }

    attempt++;
    try {
      return await fn(attempt);
    } catch (err) {
      // Only persist on capacity errors
      if (!isPersistentRetryable(err)) throw err;

      // Check absolute cap
      const elapsed = Date.now() - startTime;
      if (elapsed >= PERSISTENT_ABSOLUTE_CAP_MS) {
        throw new Error(
          `Persistent retry exceeded ${Math.round(PERSISTENT_ABSOLUTE_CAP_MS / 3600000)}h cap after ${attempt} attempts${label ? ` (${label})` : ''}: ${err.message}`
        );
      }

      // Calculate delay: exponential with cap
      const serverDelay = parseRetryAfter(err);
      let delayMs;
      if (serverDelay && serverDelay > 0) {
        delayMs = Math.min(serverDelay, PERSISTENT_MAX_BACKOFF_MS);
      } else {
        delayMs = Math.min(DEFAULT_MIN_DELAY * Math.pow(2, attempt - 1), PERSISTENT_MAX_BACKOFF_MS);
      }

      if (onRetry) {
        onRetry({ attempt, delayMs, err, label, persistent: true });
      }

      // Chunk long sleep into heartbeat intervals
      let slept = 0;
      while (slept < delayMs) {
        if (signal?.aborted) throw new Error('Persistent retry aborted during sleep');
        const chunk = Math.min(HEARTBEAT_INTERVAL_MS, delayMs - slept);
        await _sleep(chunk, signal);
        slept += chunk;
        if (onHeartbeat && slept < delayMs) {
          onHeartbeat({
            attempt,
            elapsed: Date.now() - startTime,
            remainingMs: delayMs - slept,
            label,
          });
        }
      }
    }
  }
}

/**
 * Check if persistent retry mode is enabled.
 * @returns {boolean}
 */
function isPersistentRetryEnabled() {
  const v = process.env.KHY_UNATTENDED_RETRY || '';
  return v === 'true' || v === '1';
}

// ── 错误分类驱动差异化重试（借鉴 Claude Code withRetry + Hermes error_classifier） ──

// ── FailoverReason — 18 种故障分类 (借鉴 Hermes Agent error_classifier.py) ──
const FailoverReason = Object.freeze({
  AUTH: 'auth',
  AUTH_PERMANENT: 'auth_permanent',
  BILLING: 'billing',
  RATE_LIMIT: 'rate_limit',
  OVERLOADED: 'overloaded',
  SERVER_ERROR: 'server_error',
  TIMEOUT: 'timeout',
  CONTEXT_OVERFLOW: 'context_overflow',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  IMAGE_TOO_LARGE: 'image_too_large',
  MODEL_NOT_FOUND: 'model_not_found',
  PROVIDER_POLICY_BLOCKED: 'provider_policy_blocked',
  FORMAT_ERROR: 'format_error',
  THINKING_SIGNATURE: 'thinking_signature',
  LONG_CONTEXT_TIER: 'long_context_tier',
  NETWORK: 'network',
  UNKNOWN: 'unknown',
});

/**
 * ClassifiedError — 结构化错误信封 (借鉴 Hermes Agent ClassifiedError).
 * 携带恢复提示 (recovery hints)，调用方只需读取布尔标志即可决定恢复策略。
 */
class ClassifiedError {
  /**
   * @param {object} opts
   * @param {string} opts.reason - FailoverReason 值
   * @param {boolean} [opts.retryable=true]
   * @param {boolean} [opts.shouldCompress=false] - 上下文溢出时压缩
   * @param {boolean} [opts.shouldRotateCredential=false] - 认证失败时切换凭证
   * @param {boolean} [opts.shouldFallback=false] - 模型不可用时降级
   * @param {number|null} [opts.retryAfter=null] - 速率限制退避时间 (ms)
   * @param {string} [opts.detail='']
   * @param {Error} [opts.originalError]
   */
  constructor(opts = {}) {
    this.reason = opts.reason || FailoverReason.UNKNOWN;
    this.retryable = opts.retryable !== false;
    this.shouldCompress = opts.shouldCompress || false;
    this.shouldRotateCredential = opts.shouldRotateCredential || false;
    this.shouldFallback = opts.shouldFallback || false;
    this.retryAfter = opts.retryAfter || null;
    this.detail = opts.detail || '';
    this.originalError = opts.originalError || null;
  }

  /** 获取推荐的恢复策略 (按优先级排序) */
  get recoveryHints() {
    const hints = [];
    if (this.shouldCompress) hints.push('compress_context');
    if (this.shouldRotateCredential) hints.push('rotate_credential');
    if (this.shouldFallback) hints.push('fallback_model');
    if (this.retryable && this.retryAfter) hints.push(`wait_${this.retryAfter}ms`);
    if (this.retryable && !this.retryAfter) hints.push('retry_with_backoff');
    return hints;
  }

  /** 将分类结果转为简单字符串 (向后兼容 classifyError 旧接口) */
  get kind() {
    // 映射 FailoverReason → ERROR_KIND_STRATEGIES key
    const mapping = {
      [FailoverReason.RATE_LIMIT]: 'rate_limit',
      [FailoverReason.OVERLOADED]: 'overloaded',
      [FailoverReason.SERVER_ERROR]: 'server_error',
      [FailoverReason.TIMEOUT]: 'timeout',
      [FailoverReason.NETWORK]: 'network',
      [FailoverReason.CONTEXT_OVERFLOW]: 'context_length',
      [FailoverReason.PAYLOAD_TOO_LARGE]: 'context_length',
      [FailoverReason.AUTH]: 'auth',
      [FailoverReason.AUTH_PERMANENT]: 'auth',
      [FailoverReason.BILLING]: 'auth',
    };
    return mapping[this.reason] || 'unknown';
  }
}

/**
 * 错误分类映射表。
 * 不同类型的错误使用不同的重试策略，避免对所有错误一刀切退避。
 */
const ERROR_KIND_STRATEGIES = Object.freeze({
  rate_limit: {
    attempts: 5,
    minDelayMs: 30000,   // 30s 基础（配合 Retry-After）
    maxDelayMs: 120000,
    jitter: 0.5,
    description: 'API 速率限制 (429)',
  },
  overloaded: {
    attempts: 3,
    minDelayMs: 2000,    // 2s 基础 + 高 jitter
    maxDelayMs: 30000,
    jitter: 1.0,
    description: 'API 过载 (529/overloaded)',
    // 第 3 次触发 model fallback 标记
    triggerFallbackOnLastAttempt: true,
  },
  server_error: {
    attempts: 2,
    minDelayMs: 1000,
    maxDelayMs: 10000,
    jitter: 0.8,
    description: '服务端错误 (5xx)',
  },
  timeout: {
    attempts: 2,         // 直接重试 1 次
    minDelayMs: 500,
    maxDelayMs: 3000,
    jitter: 0.3,
    description: '请求超时',
  },
  network: {
    attempts: 3,
    minDelayMs: 1000,
    maxDelayMs: 15000,
    jitter: 0.8,
    description: '网络错误 (ECONNRESET/DNS)',
  },
  context_length: {
    attempts: 1,         // 不重试 — 触发 ReactiveCompact
    minDelayMs: 0,
    maxDelayMs: 0,
    jitter: 0,
    description: '上下文超长 (prompt_too_long)',
    triggerCompact: true,
  },
  auth: {
    attempts: 1,         // 不重试
    minDelayMs: 0,
    maxDelayMs: 0,
    jitter: 0,
    description: '认证/账单错误 (401/403/402)',
  },
  unknown: {
    attempts: 2,
    minDelayMs: 1000,
    maxDelayMs: 10000,
    jitter: 0.5,
    description: '未知错误',
  },
});

/**
 * 分类错误类型（从错误对象提取错误种类）。
 * 返回 ClassifiedError 结构化信封 (含恢复提示)。
 *
 * 8 阶段优先级管线 (借鉴 Hermes classify_api_error):
 * billing > auth > rate_limit > overloaded > context_overflow > model_not_found > timeout > network > server_error
 *
 * @param {Error|object} err
 * @param {object} [opts]
 * @param {boolean} [opts.asString=false] - 向后兼容: true 时返回字符串
 * @returns {ClassifiedError|string}
 */
function classifyError(err, opts = {}) {
  if (!err) {
    return opts.asString ? 'unknown' : new ClassifiedError({ reason: FailoverReason.UNKNOWN });
  }

  const status = err.status || err.statusCode || err.response?.status || 0;
  const msg = String(err.message || '').toLowerCase();
  const errType = String(err.type || '').toLowerCase();
  const retryAfterMs = parseRetryAfter(err) || null;

  let classified;

  // Stage 1: billing (不可重试)
  if (/billing|payment|insufficient.?fund|quota exceeded|credit/i.test(msg) || status === 402) {
    classified = new ClassifiedError({
      reason: FailoverReason.BILLING,
      retryable: false,
      shouldRotateCredential: true,
      detail: '账单/配额错误',
      originalError: err,
    });
  }
  // Stage 2: auth
  else if ([401, 403].includes(status) || /auth|unauthorized|forbidden|invalid.?key|api.?key/i.test(msg)) {
    const permanent = /invalid.?key|revoked|deactivated|suspended|banned|locked|terminated/i.test(msg);
    classified = new ClassifiedError({
      reason: permanent ? FailoverReason.AUTH_PERMANENT : FailoverReason.AUTH,
      retryable: !permanent,
      shouldRotateCredential: true,
      detail: permanent ? '认证永久失败' : '认证错误 (可能临时)',
      originalError: err,
    });
  }
  // Stage 3: rate_limit
  else if (status === 429 || /rate.?limit|too.?many.?requests/i.test(msg)) {
    classified = new ClassifiedError({
      reason: FailoverReason.RATE_LIMIT,
      retryable: true,
      retryAfter: retryAfterMs,
      shouldRotateCredential: true,
      detail: 'API 速率限制',
      originalError: err,
    });
  }
  // Stage 4: overloaded
  else if (status === 529 || errType === 'overloaded_error' || /overloaded|capacity/i.test(msg)) {
    classified = new ClassifiedError({
      reason: FailoverReason.OVERLOADED,
      retryable: true,
      shouldFallback: true,
      detail: 'API 过载',
      originalError: err,
    });
  }
  // Stage 5: context_overflow
  else if (/prompt.?too.?long|context.?length|too many tokens/i.test(msg) || status === 413) {
    const isImage = /image.?too.?large/i.test(msg);
    classified = new ClassifiedError({
      reason: isImage ? FailoverReason.IMAGE_TOO_LARGE : FailoverReason.CONTEXT_OVERFLOW,
      retryable: false,
      shouldCompress: !isImage,
      detail: isImage ? '图片过大' : '上下文超长',
      originalError: err,
    });
  }
  // Stage 6: model_not_found
  else if (/model.?not.?found|does not exist|no.?such.?model/i.test(msg) || status === 404) {
    classified = new ClassifiedError({
      reason: FailoverReason.MODEL_NOT_FOUND,
      retryable: false,
      shouldFallback: true,
      detail: '模型不存在',
      originalError: err,
    });
  }
  // Stage 7: thinking_signature
  else if (/thinking.?signature|thinking.?block/i.test(msg)) {
    classified = new ClassifiedError({
      reason: FailoverReason.THINKING_SIGNATURE,
      retryable: true,
      detail: 'Thinking signature 错误',
      originalError: err,
    });
  }
  // Stage 8: timeout
  else if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT' || /timed?\s*out|timeout/i.test(msg)) {
    classified = new ClassifiedError({
      reason: FailoverReason.TIMEOUT,
      retryable: true,
      detail: '请求超时',
      originalError: err,
    });
  }
  // Stage 9: network
  else if (['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err.code)
           || /socket hang up|network|dns|connection reset|econnreset/i.test(msg)) {
    classified = new ClassifiedError({
      reason: FailoverReason.NETWORK,
      retryable: true,
      detail: '网络错误',
      originalError: err,
    });
  }
  // Stage 10: server_error
  else if (status >= 500 && status < 600) {
    classified = new ClassifiedError({
      reason: FailoverReason.SERVER_ERROR,
      retryable: true,
      detail: `服务端错误 (${status})`,
      originalError: err,
    });
  }
  // Stage 11: provider_policy
  else if (/policy|content.?filter|safety|blocked/i.test(msg)) {
    classified = new ClassifiedError({
      reason: FailoverReason.PROVIDER_POLICY_BLOCKED,
      retryable: false,
      detail: '提供商策略拦截',
      originalError: err,
    });
  }
  // Fallback: unknown
  else {
    classified = new ClassifiedError({
      reason: FailoverReason.UNKNOWN,
      retryable: true,
      detail: msg.slice(0, 200),
      originalError: err,
    });
  }

  // 向后兼容
  if (opts.asString) return classified.kind;
  return classified;
}

/**
 * 按错误种类执行差异化重试。
 * 自动分类错误并应用对应策略，比通用 retryWithBackoff 更精准。
 *
 * @param {function} fn - Async function to execute
 * @param {object} [opts]
 * @param {string} [opts.label]
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.onRetry]
 * @param {function} [opts.onFallback] - 第 N 次失败触发 model fallback 时调用
 * @param {function} [opts.onCompact] - context_length 触发 ReactiveCompact 时调用
 * @param {function} [opts.onClassified] - (ClassifiedError) => void, 每次分类时回调
 * @returns {Promise<T>}
 */
async function retryByErrorKind(fn, opts = {}) {
  const { label, signal, onRetry, onFallback, onCompact, onClassified } = opts;
  let lastClassified = null;

  try {
    return await fn(1);
  } catch (firstErr) {
    lastClassified = classifyError(firstErr);
    const lastErrorKind = lastClassified.kind;
    const strategy = ERROR_KIND_STRATEGIES[lastErrorKind] || ERROR_KIND_STRATEGIES.unknown;

    // 通知调用方分类结果
    if (onClassified) try { onClassified(lastClassified); } catch { /* ignore */ }

    // 执行恢复提示
    if (lastClassified.shouldCompress && onCompact) {
      try { onCompact(firstErr); } catch { /* ignore */ }
    }

    // 不重试的类型
    if (strategy.attempts <= 1 || !lastClassified.retryable) {
      throw firstErr;
    }

    // 使用 retryWithBackoff 执行后续重试
    return retryWithBackoff(
      async (attempt) => {
        try {
          return await fn(attempt);
        } catch (err) {
          const classified = classifyError(err);
          if (onClassified) try { onClassified(classified); } catch { /* ignore */ }

          // 检查恢复提示
          if (classified.shouldRotateCredential && onFallback) {
            try { onFallback(err, lastErrorKind); } catch { /* ignore */ }
          }
          if (strategy.triggerFallbackOnLastAttempt && attempt >= strategy.attempts - 1) {
            if (onFallback) try { onFallback(err, lastErrorKind); } catch { /* ignore */ }
          }
          throw err;
        }
      },
      {
        attempts: strategy.attempts - 1,
        minDelayMs: lastClassified.retryAfter || strategy.minDelayMs,
        maxDelayMs: strategy.maxDelayMs,
        jitter: strategy.jitter,
        label: `${label || 'retryByErrorKind'}:${lastErrorKind}`,
        signal,
        shouldRetry: (err) => {
          const c = classifyError(err);
          return c.retryable && (c.kind === lastErrorKind || isRetryableError(err));
        },
        retryAfterMs: parseRetryAfter,
        onRetry,
      }
    );
  }
}

module.exports = {
  retryWithBackoff,
  retryByErrorKind,
  classifyError,
  ClassifiedError,
  FailoverReason,
  ERROR_KIND_STRATEGIES,
  persistentRetry,
  isPersistentRetryEnabled,
  isPersistentRetryable,
  parseRetryAfter,
  isRetryableError,
  DEFAULT_ATTEMPTS,
  DEFAULT_MIN_DELAY,
  DEFAULT_MAX_DELAY,
  DEFAULT_JITTER,
  PERSISTENT_MAX_BACKOFF_MS,
  PERSISTENT_ABSOLUTE_CAP_MS,
  HEARTBEAT_INTERVAL_MS,
  // Exposed for tests only (not part of the public retry surface).
  _sleep,
};
