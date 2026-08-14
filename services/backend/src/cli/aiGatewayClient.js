/**
 * aiGatewayClient.js — Gateway request tracking, trace/audit logging, and local adapter warmup.
 *
 * Extracted from the ai.js god-file. Houses the abort-controller registry for
 * in-flight gateway requests, the diagnostic trace/audit bridge, and the
 * once-per-session local-model warmup logic (Ollama / localLLM).
 *
 * @module cli/aiGatewayClient
 */
'use strict';

// ── Imports ──
const crypto = require('crypto');

const _localState = require('./aiLocalState');

// ── Deps (injected by host ai.js via setAiGatewayClientDeps) ──
const _deps = {};
function setAiGatewayClientDeps(d) {
  Object.assign(_deps, d);
}

// ── Gateway Request Registry ──

function _registerActiveGatewayRequest(abortController, meta = {}) {
  if (!abortController || typeof abortController.abort !== 'function') {
    return '';
  }
  _localState.activeGatewayRequestSeq += 1;
  const requestId = `req-${Date.now().toString(36)}-${_localState.activeGatewayRequestSeq}`;
  _localState.activeGatewayRequests.set(requestId, {
    abortController,
    createdAt: Date.now(),
    adapter: String(meta.adapter || '').trim(),
  });
  return requestId;
}

function _unregisterActiveGatewayRequest(requestId) {
  if (!requestId) {
    return;
  }
  _localState.activeGatewayRequests.delete(requestId);
}

function cancelActiveRequest(reason = 'Interrupted by user') {
  const entries = Array.from(_localState.activeGatewayRequests.entries());
  if (entries.length === 0) {
    return false;
  }
  const abortReason =
    reason instanceof Error ? reason : new Error(String(reason || 'Interrupted by user'));
  let cancelled = false;
  for (const [requestId, info] of entries) {
    try {
      const ctrl = info && info.abortController;
      if (ctrl && !ctrl.signal?.aborted) {
        ctrl.abort(abortReason);
        cancelled = true;
      }
    } catch {
      /* best effort */
    }
    _localState.activeGatewayRequests.delete(requestId);
  }
  return cancelled;
}

// ── Trace / Audit ──

function _getTraceAudit() {
  if (_localState.traceAudit !== null) {
    return _localState.traceAudit || null;
  }
  try {
    _localState.traceAudit = require('../services/traceAuditService');
    if (typeof _localState.traceAudit.ensureDiagnosticsBridge === 'function') {
      _localState.traceAudit.ensureDiagnosticsBridge();
    }
  } catch {
    _localState.traceAudit = false;
  }
  return _localState.traceAudit || null;
}

function _resolveAuditTraceContext(opts = {}) {
  const traceId = String(opts._diagTraceId || '').trim() || crypto.randomBytes(16).toString('hex');
  const requestId = String(opts.requestId || traceId).trim() || traceId;
  const sessionId = String(opts.sessionId || '').trim() || null;
  opts._diagTraceId = traceId;
  opts.requestId = requestId;
  const traceAudit = _getTraceAudit();
  if (traceAudit && sessionId) {
    try {
      traceAudit.attachTrace(traceId, sessionId);
    } catch {
      /* best effort */
    }
  }
  return {
    traceAudit,
    traceId,
    requestId,
    sessionId,
  };
}

function _logStandaloneLlmRequest(traceCtx, prompt, opts = {}, meta = {}) {
  if (!traceCtx?.traceAudit) {
    return;
  }
  try {
    traceCtx.traceAudit.logEvent(
      'llm.request',
      {
        requestId: traceCtx.requestId,
        requestedModel: meta.requestedModel || opts.model || 'auto',
        preferredAdapter: meta.preferredAdapter || opts.preferredAdapter || opts.adapter || 'auto',
        prompt,
        hasTools: Array.isArray(opts.tools) && opts.tools.length > 0,
        messagesCount: Array.isArray(opts.messages) ? opts.messages.length : 0,
        strictPreferred: opts.strictPreferred !== false,
        localPath: meta.localPath || null,
      },
      {
        sessionId: traceCtx.sessionId,
        traceId: traceCtx.traceId,
        requestId: traceCtx.requestId,
        source: meta.source || 'ai-chat',
        visibility: 'internal',
      }
    );
  } catch {
    /* non-critical */
  }
}

function _logStandaloneLlmResponse(traceCtx, result, meta = {}) {
  if (!traceCtx?.traceAudit) {
    return;
  }
  const content = String(result?.content ?? result?.reply ?? meta.content ?? '').trim();
  const success = result?.success !== false;
  const errorText = meta.error || result?.error || (!success ? content : null) || null;
  try {
    traceCtx.traceAudit.logEvent(
      'llm.response',
      {
        requestId: traceCtx.requestId,
        success,
        model: result?.model || meta.model || 'unknown',
        provider: result?.provider || meta.provider || 'unknown',
        adapter: result?.adapter || meta.adapter || null,
        errorType: result?.errorType || meta.errorType || null,
        error: errorText,
        contentPreview: content || null,
        attempts: Array.isArray(result?.attempts) ? result.attempts : [],
        tokenUsage: result?.tokenUsage || null,
        durationMs: meta.durationMs || null,
        localPath: meta.localPath || null,
      },
      {
        sessionId: traceCtx.sessionId,
        traceId: traceCtx.traceId,
        requestId: traceCtx.requestId,
        source: meta.source || 'ai-chat',
        visibility: 'internal',
      }
    );
  } catch {
    /* non-critical */
  }
}

// ── Local Adapter Helpers ──

function _isLocalAdapterKey(key) {
  const normalized = String(key || '')
    .trim()
    .toLowerCase();
  return normalized === 'localllm' || normalized === 'ollama';
}

function _resolveLocalWarmupTarget(gateway, preferredAdapterHint = undefined) {
  const preferred = String(
    preferredAdapterHint !== undefined
      ? preferredAdapterHint
      : process.env.GATEWAY_PREFERRED_ADAPTER || ''
  )
    .trim()
    .toLowerCase();
  if (_isLocalAdapterKey(preferred)) {
    return preferred;
  }
  if (preferred && preferred !== 'auto') {
    return '';
  }
  try {
    const firstAvailable = String(gateway.getFirstAvailableAdapter?.() || '')
      .trim()
      .toLowerCase();
    if (_isLocalAdapterKey(firstAvailable)) {
      return firstAvailable;
    }
  } catch {
    /* best effort */
  }
  return '';
}

function _toGatewayLocalKey(key) {
  return String(key || '')
    .trim()
    .toLowerCase() === 'localllm'
    ? 'localLLM'
    : 'ollama';
}

function _getLocalAiAutoEnv() {
  if (_localState.localAiAutoEnvCache) {
    return _localState.localAiAutoEnvCache;
  }
  try {
    const hw = require('../services/hardwareProfileService');
    const tuning =
      hw && typeof hw.recommendLocalAiTuning === 'function'
        ? hw.recommendLocalAiTuning('auto')
        : null;
    _localState.localAiAutoEnvCache = tuning && tuning.env ? tuning.env : {};
  } catch {
    _localState.localAiAutoEnvCache = {};
  }
  return _localState.localAiAutoEnvCache;
}

function _readIntWithAutoDefault(envKey, autoDefault, hardFallback) {
  const raw = process.env[envKey];
  if (raw !== undefined && String(raw).trim() !== '') {
    const v = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(v)) {
      return v;
    }
  }
  const autoV = parseInt(String(autoDefault || ''), 10);
  if (Number.isFinite(autoV)) {
    return autoV;
  }
  return hardFallback;
}

// Reasoning models (qwen3 / qwq / deepseek-r1 …) emit a long <think> block
// before the final answer. Under a small num_predict cap the budget is spent
// thinking and the answer is truncated to empty. Detect them so the cap can
// reserve extra headroom. Pattern is env-extendable (no hardcoded allowlist).
function _isLocalThinkingModel(model) {
  const name = String(model || '').toLowerCase();
  if (!name) {
    return false;
  }
  const extra = String(process.env.KHY_OLLAMA_THINKING_MODELS || '').trim();
  if (extra) {
    try {
      if (new RegExp(extra, 'i').test(name)) {
        return true;
      }
    } catch {
      /* bad regex → ignore */
    }
  }
  return /(qwen3|qwq|deepseek-r1|[-_/]r1[:\b-]|marco-o1|openthinker|reflection|exaone-deep|phi-?4-?reasoning|reasoning|thinking|cogito)/i.test(
    name
  );
}

function _resolveLocalPreferredMaxTokens(baseTokens, context = {}) {
  const normalizedBase = Math.max(64, parseInt(baseTokens, 10) || 2048);
  const isLocalPreferredAdapter = !!context.isLocalPreferredAdapter;
  const preferredAdapter = String(context.preferredAdapter || '')
    .trim()
    .toLowerCase();
  const localLLMStatus = context.localLLMStatus || null;
  const autoEnv = _getLocalAiAutoEnv();
  const disableCapRaw =
    process.env.KHY_LOCAL_DISABLE_TOKEN_CAP !== undefined
      ? process.env.KHY_LOCAL_DISABLE_TOKEN_CAP
      : autoEnv.KHY_LOCAL_DISABLE_TOKEN_CAP;
  const disableCap = String(disableCapRaw || 'false').toLowerCase() === 'true';
  if (!isLocalPreferredAdapter || disableCap) {
    return { maxTokens: normalizedBase, capped: false, cap: normalizedBase };
  }

  const fallbackWarmCap = Math.max(
    256,
    _readIntWithAutoDefault('KHY_LOCAL_WARM_MAX_TOKENS', autoEnv.KHY_LOCAL_WARM_MAX_TOKENS, 4096)
  );
  const fallbackColdCap = Math.max(
    128,
    _readIntWithAutoDefault('KHY_LOCAL_COLD_MAX_TOKENS', autoEnv.KHY_LOCAL_COLD_MAX_TOKENS, 3072)
  );
  let cap = fallbackWarmCap;
  if (preferredAdapter === 'ollama') {
    cap = Math.max(
      128,
      _readIntWithAutoDefault(
        'KHY_OLLAMA_MAX_TOKENS',
        autoEnv.KHY_OLLAMA_MAX_TOKENS,
        fallbackWarmCap
      )
    );
    // Thinking models need the reasoning budget on top of the answer budget.
    // Boost the cap (multiplier + absolute floor) so the final answer is not
    // truncated to empty. Both knobs are env-tunable.
    if (context.isThinkingModel) {
      const tMult = Math.max(
        1,
        parseFloat(process.env.KHY_OLLAMA_THINKING_MULTIPLIER || '2.5') || 2.5
      );
      const tMin = Math.max(
        512,
        parseInt(process.env.KHY_OLLAMA_THINKING_MIN_TOKENS || '6144', 10) || 6144
      );
      cap = Math.max(Math.round(cap * tMult), tMin);
    }
  } else if (localLLMStatus && localLLMStatus.loaded === false) {
    cap = fallbackColdCap;
  }

  const resolved = Math.max(64, Math.min(normalizedBase, cap));
  return {
    maxTokens: resolved,
    capped: resolved < normalizedBase,
    cap,
  };
}

async function _maybeWarmupLocalPreferredOnce(options = {}) {
  const autoEnv = _getLocalAiAutoEnv();
  const warmupOnceRaw =
    process.env.KHY_LOCAL_WARMUP_ONCE !== undefined
      ? process.env.KHY_LOCAL_WARMUP_ONCE
      : autoEnv.KHY_LOCAL_WARMUP_ONCE;
  if (String(warmupOnceRaw || 'false').toLowerCase() === 'false') {
    return;
  }

  const gateway = _deps.getGateway();
  if (!gateway.isInitialized()) {
    await gateway.init();
  }

  const target = _resolveLocalWarmupTarget(gateway, options.preferredAdapter);
  if (!target) {
    return;
  }
  if (_localState.localWarmupAttemptedAdapters.has(target)) {
    return;
  }

  const existing = _localState.localWarmupInFlight.get(target);
  if (existing) {
    await existing;
    return;
  }

  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
  const adapterLabel = target === 'ollama' ? 'Ollama' : '本地模型';
  const maxWaitMs = Math.max(
    1000,
    _readIntWithAutoDefault(
      target === 'ollama' ? 'KHY_OLLAMA_WARMUP_WAIT_MS' : 'KHY_LOCAL_WARMUP_WAIT_MS',
      target === 'ollama' ? autoEnv.KHY_OLLAMA_WARMUP_WAIT_MS : autoEnv.KHY_LOCAL_WARMUP_WAIT_MS,
      target === 'ollama' ? 8000 : 30000
    )
  );
  const gatewayAdapterKey = _toGatewayLocalKey(target);

  const warmupTask = (async () => {
    if (onStatus) {
      try {
        onStatus(`${adapterLabel} 预热中（仅首次），正在发送预热 ping...`);
      } catch {
        /* best effort */
      }
    }

    const warmupRun = gateway
      .generateWithAdapter(gatewayAdapterKey, 'Reply with exactly: OK', {
        maxTokens: 24,
        temperature: 0,
        top_p: 1,
        timeoutMs: maxWaitMs,
        userMessage: '[warmup]',
      })
      .catch((err) => ({ success: false, error: err && err.message ? err.message : String(err) }));

    const timeoutToken = Symbol('warmup-timeout');
    const raced = await Promise.race([
      warmupRun,
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(timeoutToken), maxWaitMs + 300);
        if (t.unref) {
          t.unref();
        }
      }),
    ]);

    if (raced === timeoutToken) {
      if (onStatus) {
        try {
          onStatus(
            `${adapterLabel} 预热仍在进行（>${Math.round(maxWaitMs / 1000)}s），将并行继续并直接发起正式请求...`
          );
        } catch {
          /* best effort */
        }
      }
      return;
    }

    if (raced && raced.success) {
      if (onStatus) {
        try {
          onStatus(`${adapterLabel} 预热完成，开始正式请求...`);
        } catch {
          /* best effort */
        }
      }
      return;
    }

    if (onStatus) {
      const reason = String((raced && (raced.error || raced.content)) || 'unknown')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
      try {
        onStatus(`${adapterLabel} 预热失败（${reason || 'unknown'}），将直接发起正式请求...`);
      } catch {
        /* best effort */
      }
    }
  })();

  _localState.localWarmupInFlight.set(target, warmupTask);
  try {
    await warmupTask;
  } finally {
    _localState.localWarmupAttemptedAdapters.add(target);
    _localState.localWarmupInFlight.delete(target);
  }
}

// ── Exports ──
module.exports = {
  setAiGatewayClientDeps,
  _registerActiveGatewayRequest,
  _unregisterActiveGatewayRequest,
  cancelActiveRequest,
  _getTraceAudit,
  _resolveAuditTraceContext,
  _logStandaloneLlmRequest,
  _logStandaloneLlmResponse,
  _isLocalAdapterKey,
  _resolveLocalWarmupTarget,
  _toGatewayLocalKey,
  _getLocalAiAutoEnv,
  _readIntWithAutoDefault,
  _isLocalThinkingModel,
  _resolveLocalPreferredMaxTokens,
  _maybeWarmupLocalPreferredOnce,
};
