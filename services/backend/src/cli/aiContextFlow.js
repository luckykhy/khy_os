/**
 * aiContextFlow.js — Context overflow detection, strict-preferred logic, recovery/retry, and stream interception.
 *
 * Extracted from aiChatCore.js. Contains context overflow failure detection, strict preferred
 * adapter logic, gateway recovery retry with countdown, rate-limit retry, and the
 * _generateWithStreamIntercept orchestrator that wraps gateway calls with stream tool interception
 * and recovery logic.
 *
 * @module cli/aiContextFlow
 */
'use strict';

// ── Imports ──
const { _gatewayGenerate } = require('./aiMessageBuilder');

// ── Host-injected deps (set via setAiContextFlowDeps) ──
let _createStreamToolInterceptor = null;
let _classifyGatewayThrownError = null;
let _isTransientGatewayErrorType = null;
let _directGenerate = null;

function setAiContextFlowDeps(deps = {}) {
  if (deps._createStreamToolInterceptor !== undefined) {
    _createStreamToolInterceptor = deps._createStreamToolInterceptor;
  }
  if (deps._classifyGatewayThrownError !== undefined) {
    _classifyGatewayThrownError = deps._classifyGatewayThrownError;
  }
  if (deps._isTransientGatewayErrorType !== undefined) {
    _isTransientGatewayErrorType = deps._isTransientGatewayErrorType;
  }
  if (deps._directGenerate !== undefined) {
    _directGenerate = deps._directGenerate;
  }
}

// ── Context Overflow Detection ──

function _isStrictPreferredFailure(result) {
  if (!result || result.success) {
    return false;
  }
  const msg = String(result.content || result.error || '');
  return /已选择模型通道(请求失败|不可用)/.test(msg);
}

/**
 * Detect whether a failed generation result is a context-overflow / prompt_too_long
 * error (s08 reactive-compaction trigger). The proactive compaction pass estimates
 * tokens locally; the API's real count can still exceed the budget, in which case
 * the request is rejected and we must recompact more aggressively before retrying.
 *
 * @param {object} result - Failed gateway result ({ success:false, content?, error?, errorType?, statusCode? })
 * @returns {boolean}
 */
function _isContextOverflowFailure(result) {
  if (!result || result.success) {
    return false;
  }
  const errorType = String(result.errorType || '').toLowerCase();
  if (
    errorType === 'context_length' ||
    errorType === 'context_overflow' ||
    errorType === 'payload_too_large'
  ) {
    return true;
  }
  try {
    const { classifyError } = require('../services/errorClassifier');
    const status = result.statusCode || result.status || 0;
    const message = String(result.content || result.error || result.errorType || '');
    return classifyError(status, message).shouldCompress === true;
  } catch {
    const message = String(result.content || result.error || '').toLowerCase();
    return /prompt[_\s-]?too[_\s-]?long|context[_\s-]?length|too many tokens|maximum context/.test(
      message
    );
  }
}

// ── Strict Preferred Logic ──

function _shouldKeepStrictPreferred(opts = {}) {
  if (opts.strictPreferred === true) {
    return true;
  }
  if (opts.strictPreferred === false) {
    return false;
  }
  const preferredStrictRaw =
    opts.preferredStrict !== undefined
      ? opts.preferredStrict
      : process.env.GATEWAY_PREFERRED_STRICT;
  if (String(preferredStrictRaw).toLowerCase() === 'false') {
    return false;
  }
  const preferred = String(
    opts.preferredAdapter !== undefined
      ? opts.preferredAdapter
      : process.env.GATEWAY_PREFERRED_ADAPTER || ''
  ).trim();
  return !!(preferred && preferred !== 'auto');
}

function _isStrictPreferredEnabled(opts = {}) {
  return _shouldKeepStrictPreferred(opts);
}

// ── Gateway Recovery ──

function _resolveGatewayRecoveryRetries(opts = {}) {
  const explicit = parseInt(String(opts._gatewayRecoveryRetries ?? ''), 10);
  if (Number.isFinite(explicit)) {
    return Math.max(0, Math.min(3, explicit));
  }
  const scale = String(opts.taskScale || '')
    .trim()
    .toLowerCase();
  if (scale === 'small') {
    const parsedSmall = parseInt(String(process.env.KHY_GATEWAY_RECOVERY_RETRIES_SMALL || '1'), 10);
    return Number.isFinite(parsedSmall) ? Math.max(0, Math.min(2, parsedSmall)) : 1;
  }
  if (scale === 'large') {
    const parsedLarge = parseInt(String(process.env.KHY_GATEWAY_RECOVERY_RETRIES_LARGE || '2'), 10);
    return Number.isFinite(parsedLarge) ? Math.max(0, Math.min(3, parsedLarge)) : 2;
  }
  const parsed = parseInt(String(process.env.KHY_GATEWAY_RECOVERY_RETRIES || '1'), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 1;
  }
  return Math.min(3, parsed);
}

function _resolveGatewayRecoveryDelayMs(attemptIndex = 0) {
  const base = Math.max(
    300,
    parseInt(String(process.env.KHY_GATEWAY_RECOVERY_BASE_DELAY_MS || '1200'), 10) || 1200
  );
  const exp = Math.min(3, Math.max(0, attemptIndex));
  const jitter = Math.random() * 300;
  return Math.round(base * Math.pow(1.7, exp) + jitter);
}

/**
 * Wait out a gateway-recovery backoff while surfacing a live countdown status
 * (aligns with Claude Code's "Retrying in N seconds… (attempt X/Y)"). The
 * per-second display text is decided by the pure leaf cli/retryCountdown.js;
 * this shell owns the timers/IO. Gate off (or any failure) → byte-identical
 * legacy behaviour: a single static status then a blind setTimeout(waitMs).
 */
async function _waitGatewayRecoveryWithCountdown(
  onStatus,
  { errType, attempt, maxAttempts, waitMs }
) {
  const emit = (remainingMs) => {
    if (typeof onStatus !== 'function') {
      return;
    }
    let message;
    try {
      const rc = require('./retryCountdown');
      message = rc.buildRetryStatusMessage({ errType, attempt, maxAttempts, remainingMs });
    } catch {
      // Leaf unavailable → fall back to the exact legacy static string.
      message = `网关连接波动（${errType}），正在进行稳定性重试 ${attempt}/${maxAttempts}...`;
    }
    try {
      onStatus({ phase: 'request', message });
    } catch {
      /* best effort */
    }
  };

  let enabled = false;
  try {
    enabled = require('./retryCountdown').isRetryCountdownEnabled(process.env);
  } catch {
    enabled = false;
  }

  if (!enabled) {
    // Legacy path: one static status, then blind wait (byte-identical to before).
    emit(waitMs);
    await new Promise((r) => setTimeout(r, waitMs));
    return;
  }

  // Countdown path: re-emit the status roughly once per second toward 0.
  const started = Date.now();
  emit(waitMs);
  let remaining = waitMs;
  while (remaining > 0) {
    const tick = Math.min(1000, remaining);
    await new Promise((r) => setTimeout(r, tick));
    remaining = waitMs - (Date.now() - started);
    emit(remaining > 0 ? remaining : 0);
  }
}

/**
 * Wait out a rate-limit (429) backoff while surfacing a live "第 n/N 轮" countdown,
 * mirroring Claude Code's "Retrying in N seconds… (attempt X/Y)". Per-second display
 * text comes from the pure leaf cli/rateLimitRetry.js; this shell owns the timers/IO.
 * Unlike the transient-recovery countdown, rate-limit waits must actually elapse the
 * gateway cooldown window — retrying before it expires just re-hits the cached fast-fail.
 */
async function _waitRateLimitRetryWithCountdown(onStatus, { round, maxRounds, waitMs }) {
  let rl = null;
  try {
    rl = require('./rateLimitRetry');
  } catch {
    rl = null;
  }
  const emit = (remainingMs) => {
    if (typeof onStatus !== 'function') {
      return;
    }
    let message;
    try {
      message = rl
        ? rl.buildRetryStatusMessage({ round, maxRounds, remainingMs, env: process.env })
        : `API 限流(429)，正在自动重试（第 ${round}/${maxRounds} 轮）...`;
    } catch {
      message = `API 限流(429)，正在自动重试（第 ${round}/${maxRounds} 轮）...`;
    }
    try {
      onStatus({ phase: 'request', message });
    } catch {
      /* best effort */
    }
  };

  const started = Date.now();
  emit(waitMs);
  let remaining = waitMs;
  while (remaining > 0) {
    const tick = Math.min(1000, remaining);
    await new Promise((r) => setTimeout(r, tick));
    remaining = waitMs - (Date.now() - started);
    emit(remaining > 0 ? remaining : 0);
  }
}

// ── Stream Intercept + Recovery Orchestrator ──

async function _generateWithStreamIntercept(
  conversationPrompt,
  fullSystemPrompt,
  messages,
  userMessage,
  opts,
  preset
) {
  const interceptor = _createStreamToolInterceptor(opts.onChunk, {
    suppressPrefixOnToolCall: opts.suppressPrefixOnToolCall === true,
    routeToolPrefaceToNarration: opts.routeToolPrefaceToNarration === true,
    streamingExecutor: opts._streamingExecutor || null, // Phase 7
  });
  // Wrap onFallback to clear interceptor pending buffer when adapter
  // switches, preventing duplicate text from the failed adapter's partial
  // stream being flushed alongside the successful adapter's full stream.
  const wrappedOnFallback =
    typeof opts.onFallback === 'function'
      ? (...args) => {
          interceptor.reset();
          return opts.onFallback(...args);
        }
      : opts.onFallback;
  const wrappedOpts = { ...opts, onChunk: interceptor.onChunk, onFallback: wrappedOnFallback };

  let result;
  try {
    result = await _gatewayGenerate(
      conversationPrompt,
      fullSystemPrompt,
      messages,
      userMessage,
      wrappedOpts,
      preset
    );
  } catch (err) {
    let gatewayErr = String(err && err.message ? err.message : err || 'unknown gateway error')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
    let gatewayErrType = _classifyGatewayThrownError(err);

    // Stability recovery: transient failures get one (configurable) retry round.
    const recoveryRetries = _resolveGatewayRecoveryRetries(wrappedOpts);
    const alreadyRetried = !!wrappedOpts._gatewayRecoveryRetried;
    const canRecover =
      recoveryRetries > 0 && !alreadyRetried && _isTransientGatewayErrorType(gatewayErrType);
    if (canRecover) {
      const relaxStrict =
        String(process.env.KHY_GATEWAY_RECOVERY_RELAX_STRICT || 'true').toLowerCase() !== 'false';
      for (let retryIdx = 0; retryIdx < recoveryRetries; retryIdx++) {
        const waitMs = _resolveGatewayRecoveryDelayMs(retryIdx);
        await _waitGatewayRecoveryWithCountdown(wrappedOpts.onStatus, {
          errType: gatewayErrType,
          attempt: retryIdx + 1,
          maxAttempts: recoveryRetries,
          waitMs,
        });
        try {
          const retryOpts = {
            ...wrappedOpts,
            _gatewayRecoveryRetried: true,
            _gatewayRecoveryRetries: 0,
            _stabilityTimeoutMultiplier: 1.25 + retryIdx * 0.35,
          };
          if (relaxStrict) {
            retryOpts.strictPreferred = false;
            retryOpts.preferredStrict = false;
          }
          result = await _gatewayGenerate(
            conversationPrompt,
            fullSystemPrompt,
            messages,
            userMessage,
            retryOpts,
            preset
          );
          interceptor.finalize();
          const retryIntercepted = interceptor.getToolUseBlocks();
          const retryFromResult = Array.isArray(result?.toolUseBlocks) ? result.toolUseBlocks : [];
          return {
            result,
            streamToolCallDetected: interceptor.hasToolCall() || retryFromResult.length > 0,
            toolUseBlocks: retryIntercepted.length > 0 ? retryIntercepted : retryFromResult,
          };
        } catch (retryErr) {
          gatewayErr = String(
            retryErr && retryErr.message ? retryErr.message : retryErr || gatewayErr
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 220);
          gatewayErrType = _classifyGatewayThrownError(retryErr);
        }
      }
    }

    // Default: keep a direct-generate fallback for resilience, but preserve
    // the original gateway failure reason when fallback also fails.
    // Set KHY_GATEWAY_THROW_FALLBACK=false to disable fallback and fail fast.
    const strictPreferred = _isStrictPreferredEnabled(opts);
    const preferred = String(
      opts.preferredAdapter !== undefined
        ? opts.preferredAdapter
        : process.env.GATEWAY_PREFERRED_ADAPTER || ''
    )
      .trim()
      .toLowerCase();
    const skipDirectFallback =
      strictPreferred &&
      preferred &&
      preferred !== 'auto' &&
      (gatewayErrType === 'timeout' || gatewayErrType === 'cancelled');

    if (process.env.KHY_GATEWAY_THROW_FALLBACK === 'false' || skipDirectFallback) {
      result = {
        success: false,
        errorType: gatewayErrType,
        content: skipDirectFallback
          ? `AI 网关异常: ${gatewayErr}\n\n已跳过云端兜底，避免掩盖首选通道（${preferred}）故障。`
          : `AI 网关异常: ${gatewayErr}`,
      };
    } else {
      try {
        result = await _directGenerate(conversationPrompt, userMessage, wrappedOpts, preset);
        if (!result || !result.success) {
          const fallbackMsg =
            result && result.content ? String(result.content) : '所有 AI 通道不可用。';
          result = {
            success: false,
            errorType: (result && result.errorType) || gatewayErrType,
            content: `AI 网关异常: ${gatewayErr}\n\n${fallbackMsg}`,
          };
        }
      } catch (e) {
        console.error('[ai] directGenerate 回退失败:', e?.message);
        result = {
          success: false,
          errorType: gatewayErrType,
          content: `AI 网关异常: ${gatewayErr}`,
        };
      }
    }
  }

  interceptor.finalize();
  // 合并两个来源的 toolUseBlocks：
  // 1. interceptor 从流式 chunk 中收集（type: 'tool_use'）
  // 2. gateway result 中直接携带（非流式路径或适配器不发 chunk 时）
  const intercepted = interceptor.getToolUseBlocks();
  const fromResult = Array.isArray(result?.toolUseBlocks) ? result.toolUseBlocks : [];
  const mergedToolUseBlocks = intercepted.length > 0 ? intercepted : fromResult;
  // Signed thinking blocks only ride on the gateway result (not stream-intercepted).
  const thinkingBlocks = Array.isArray(result?.thinkingBlocks) ? result.thinkingBlocks : [];
  return {
    result,
    streamToolCallDetected: interceptor.hasToolCall() || fromResult.length > 0,
    toolUseBlocks: mergedToolUseBlocks,
    thinkingBlocks,
    _streamingExecutor: interceptor.getStreamingExecutor(), // Phase 7
  };
}

// ── Exports ──
module.exports = {
  _isContextOverflowFailure,
  _isStrictPreferredFailure,
  _shouldKeepStrictPreferred,
  _isStrictPreferredEnabled,
  _resolveGatewayRecoveryRetries,
  _resolveGatewayRecoveryDelayMs,
  _waitGatewayRecoveryWithCountdown,
  _waitRateLimitRetryWithCountdown,
  _generateWithStreamIntercept,
  setAiContextFlowDeps,
};
