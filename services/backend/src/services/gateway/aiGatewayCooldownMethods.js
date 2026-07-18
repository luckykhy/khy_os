'use strict';

/**
 * AIGateway cooldown / adapter-failure methods (extracted from services/gateway/aiGateway.js).
 *
 * A cohesive cluster of instance methods covering adapter-failure recording + clearing, account-pool
 * auth-error handling, vision-describe cooldown bypass/pin decisions, fast-fail bookkeeping, and the
 * cooldown self-heal probe machinery (schedule / trigger / tick / ticker / config). Relocated verbatim
 * as a prototype mixin: the host does Object.assign(AIGateway.prototype, AIGatewayCooldownMethods), so
 * every method body stays byte-identical and `this` binds to the gateway instance at call time.
 *
 * The bodies reference a handful of aiGateway.js module-scope helpers (all stable / set-once) which are
 * injected via setAiGatewayCooldownMethodsDeps to avoid a require cycle back into aiGateway.js. `path`
 * and the four in-body require() calls resolve identically from this same-directory sibling. The methods
 * perform IO (timers, account-pool persistence, circuit-breaker calls), so this is NOT a pure zero-IO
 * leaf.
 */

const path = require('path');

// aiGateway.js module-scope helpers injected at host load (stable references / set-once value).
let _adaptiveConfig = null;
let _isProcessSensitiveAdapter = null;
let _isReconnectOrChannelClosedMessage = null;
let _parseFloat01 = null;
let _parseMs = null;
let _parsePositiveInt = null;
let _resolveApiPoolProviderForRequest = null;
let _sanitizeFailureMessage = null;
let _shouldUseFastFail = null;
let _transientCooldownMs = null;
function setAiGatewayCooldownMethodsDeps(deps = {}) {
  if (deps._adaptiveConfig !== undefined) _adaptiveConfig = deps._adaptiveConfig;
  if (typeof deps._isProcessSensitiveAdapter === 'function') _isProcessSensitiveAdapter = deps._isProcessSensitiveAdapter;
  if (typeof deps._isReconnectOrChannelClosedMessage === 'function') _isReconnectOrChannelClosedMessage = deps._isReconnectOrChannelClosedMessage;
  if (typeof deps._parseFloat01 === 'function') _parseFloat01 = deps._parseFloat01;
  if (typeof deps._parseMs === 'function') _parseMs = deps._parseMs;
  if (typeof deps._parsePositiveInt === 'function') _parsePositiveInt = deps._parsePositiveInt;
  if (typeof deps._resolveApiPoolProviderForRequest === 'function') _resolveApiPoolProviderForRequest = deps._resolveApiPoolProviderForRequest;
  if (typeof deps._sanitizeFailureMessage === 'function') _sanitizeFailureMessage = deps._sanitizeFailureMessage;
  if (typeof deps._shouldUseFastFail === 'function') _shouldUseFastFail = deps._shouldUseFastFail;
  if (typeof deps._transientCooldownMs === 'function') _transientCooldownMs = deps._transientCooldownMs;
}

// Prototype mixin — Object.assign'd onto AIGateway.prototype by the host (see module doc).
const AIGatewayCooldownMethods = {
  /**
   * Periodic cleanup of stale adapter data to prevent memory leaks.
   */
  _cleanupStaleData() {
    const validKeys = new Set(this._adapters.map(a => a.key));
    for (const key of Object.keys(this._requestLog)) {
      if (!validKeys.has(key)) delete this._requestLog[key];
      else if (this._requestLog[key].length > 100) {
        this._requestLog[key] = this._requestLog[key].slice(-100);
      }
    }
    for (const key of Object.keys(this._adapterFailures)) {
      if (!validKeys.has(key)) delete this._adapterFailures[key];
      else if (this._adapterFailures[key] > 20) this._adapterFailures[key] = 20;
    }
    for (const key of Object.keys(this._adapterLastError)) {
      if (!validKeys.has(key)) delete this._adapterLastError[key];
    }
    for (const key of Object.keys(this._cooldownSelfHealMeta)) {
      if (!validKeys.has(key)) delete this._cooldownSelfHealMeta[key];
    }
    for (const key of Array.from(this._cooldownSelfHealInFlight.keys())) {
      if (!validKeys.has(key)) this._cooldownSelfHealInFlight.delete(key);
    }
    for (const key of Array.from(this._cooldownSelfHealMidpointTimers.keys())) {
      if (!validKeys.has(key)) this._clearCooldownSelfHealMidpointTimer(key);
    }
  },

  _clearCooldownSelfHealMidpointTimer(adapterKey) {
    const current = this._cooldownSelfHealMidpointTimers.get(adapterKey);
    if (current && current.timer) {
      clearTimeout(current.timer);
    }
    this._cooldownSelfHealMidpointTimers.delete(adapterKey);
  },

  _clearAllCooldownSelfHealMidpointTimers() {
    for (const key of Array.from(this._cooldownSelfHealMidpointTimers.keys())) {
      this._clearCooldownSelfHealMidpointTimer(key);
    }
  },

  _scheduleCooldownSelfHealMidpointTimer(adapterKey, failureAt, midpointAt) {
    const cfg = this._resolveCooldownSelfHealConfig();
    if (!cfg.enabled) return false;
    const failureTs = Number(failureAt || 0);
    const midpointTs = Number(midpointAt || 0);
    if (!Number.isFinite(failureTs) || failureTs <= 0) return false;
    if (!Number.isFinite(midpointTs) || midpointTs <= 0) return false;

    this._clearCooldownSelfHealMidpointTimer(adapterKey);
    const delayMs = Math.max(0, midpointTs - Date.now());
    const timer = setTimeout(() => {
      this._cooldownSelfHealMidpointTimers.delete(adapterKey);
      const recent = this._getRecentFastFail(adapterKey);
      if (!recent) return;
      if (Number(recent.at || 0) !== failureTs) return;
      this._triggerMidpointSelfHealProbe(adapterKey, recent, {
        source: 'timer_midpoint_exact',
      });
    }, delayMs);
    if (timer.unref) timer.unref();

    this._cooldownSelfHealMidpointTimers.set(adapterKey, {
      timer,
      failureAt: failureTs,
      midpointAt: midpointTs,
    });
    this._cooldownSelfHealMeta[adapterKey] = {
      ...this._cooldownSelfHealMeta[adapterKey],
      midpointAt: midpointTs,
      midpointTimerForFailureAt: failureTs,
      midpointTimerArmedAt: Date.now(),
      lastOutcome: 'midpoint_timer_armed',
    };
    return true;
  },

  _triggerMidpointSelfHealProbe(adapterKey, recentFail = null, options = {}) {
    const recent = recentFail || this._getRecentFastFail(adapterKey);
    if (!recent) return false;
    const now = Date.now();
    const meta = this._cooldownSelfHealMeta[adapterKey] || {};
    const failureAt = Number(recent.at || 0);
    const midpointAt = Number(meta.midpointAt || 0) > 0
      ? Number(meta.midpointAt)
      : (failureAt + Math.max(1000, Math.floor(Number(recent.cooldownMs || 0) / 2)));
    if (!Number.isFinite(midpointAt) || now < midpointAt) return false;
    if (meta.midpointProbeForFailureAt && Number(meta.midpointProbeForFailureAt) === failureAt) return false;

    const statusName = (() => {
      const entry = this._adapters.find(a => a.key === adapterKey);
      if (!entry) return adapterKey;
      try { return entry.adapter.getStatus().name || adapterKey; } catch { return adapterKey; }
    })();

    const scheduled = this._maybeScheduleCooldownSelfHealProbe(adapterKey, recent, {
      source: String(options.source || 'timer_midpoint'),
      adapterDisplayName: statusName,
    });
    if (!scheduled) return false;

    this._cooldownSelfHealMeta[adapterKey] = {
      ...this._cooldownSelfHealMeta[adapterKey],
      midpointAt,
      midpointProbeForFailureAt: failureAt,
      midpointProbeAt: now,
      lastOutcome: `midpoint_probe_scheduled:${String(options.source || 'timer_midpoint')}`,
    };
    return true;
  },

  async _recordAdapterFailure(adapterKey, errorType, error, meta = null) {
    const normalizedType = String(errorType || '').trim() || 'unknown';
    const normalizedTypeLower = normalizedType.toLowerCase();
    // 载荷(payload)级失败:本次带附件,且失败是上游对该附件内容的拒绝/不支持格式
    // (bad_request / model_not_found / 不支持格式)。通道是健康的——只有这一次带附件的
    // 请求内容上游读不了。与下方 `empty` 同理:不该毒化整条通道(否则一个坏文件会让后续
    // 连纯文本请求都被熔断 fast-fail)。判定收口在纯叶子 attachmentFailurePolicy(门控
    // KHY_ATTACHMENT_FAILURE_POLICY 默认开;关闭→恒 false→circuitEligible 与今天逐字节相同)。
    let _payloadScopedFailure = false;
    if (meta && meta.attachmentPresent) {
      try {
        _payloadScopedFailure = require('./attachmentFailurePolicy').isPayloadScopedFailure({
          hasAttachment: true,
          errorType: normalizedType,
          error,
        });
      } catch { /* 叶子不可用则按原熔断路径 */ }
    }
    this._recordAdapterOutcome(adapterKey, { success: false, at: Date.now() });
    const stallFingerprint = (meta && typeof meta === 'object')
      ? String(meta.stallFingerprint || '')
      : '';
    // 记录造成本次失败的模型串,让 model_not_found 冷却能按模型放行(modelNotFoundCooldownScope):
    // 复合 id 撞 404 后剥成裸名的修正请求(不同模型串)不该被同一通道的冷却连坐。additive 字段,
    // 缺失时下游按今日「按通道」冷却逐字节回退。
    const failedModel = (meta && typeof meta === 'object')
      ? String(meta.model || '').trim()
      : '';
    const cooldownMs = this._resolveFastFailCooldownMs(adapterKey, normalizedType, error, stallFingerprint);
    const now = Date.now();
    const sanitizedError = _sanitizeFailureMessage(error || 'unknown error');
    const previousLocalFailures = Number(this._adapterFailures[adapterKey] || 0);

    // Keep local mirror hot immediately (before any async I/O) so fast-fail
    // checks in the same tick can observe this failure.
    this._adapterLastError[adapterKey] = {
      at: now,
      errorType: normalizedType,
      error: sanitizedError,
      cooldownMs,
      circuitOpen: false,
      ...(failedModel ? { model: failedModel } : {}),
    };
    this._adapterFailures[adapterKey] = previousLocalFailures + 1;

    const consecutiveFailures = await this._healthStore.getFailureCount(adapterKey);
    const failureCountAfterRecord = consecutiveFailures + 1;

    // Circuit breaker: if adapter fails 5+ times consecutively, extend cooldown
    // to 60s regardless of error type (prevents hammering a dead adapter)
    const CIRCUIT_BREAKER_THRESHOLD = _parsePositiveInt(
      process.env.GATEWAY_CIRCUIT_BREAKER_THRESHOLD, 3, 2, 20
    );
    const CIRCUIT_BREAKER_COOLDOWN_MS = _parseMs(
      process.env.GATEWAY_CIRCUIT_BREAKER_COOLDOWN_MS || '30000', 30000, 10000
    );
    // 'empty' is excluded for the same reason it is kept out of the transient
    // cooldown map: an empty HTTP-200 reply is a model-behavior blip, not a
    // channel-health signal. Letting repeated empties open the circuit would cool
    // the ONLY available channel for 30s+ and re-create the reported incoherence
    // (re-asks blocked after a few empties). Same-request empty recovery is owned
    // by the tool loop; the channel must stay available for the next re-ask.
    const circuitEligible = !_payloadScopedFailure
      && !['network', 'timeout', 'rate_limit', 'overloaded', 'cancelled', 'empty'].includes(normalizedTypeLower);

    // Error-rate circuit breaking (借鉴 cc-switch error_rate_threshold/min_requests):
    // record this failure into the sliding window, then open the circuit when the
    // windowed error rate crosses the threshold AND enough requests have been
    // sampled. min_requests floors the sample size so a flaky adapter that
    // alternates success/failure trips on RATE rather than only on a consecutive
    // streak. Conservative defaults (10 reqs / 0.6 rate) mean small samples
    // degrade to the legacy consecutive-failure logic — behavior unchanged.
    const ERR_RATE_THRESHOLD = _parseFloat01(
      process.env.GATEWAY_CIRCUIT_ERROR_RATE_THRESHOLD, 0.6, 0, 1
    );
    const ERR_RATE_MIN_REQUESTS = _parsePositiveInt(
      process.env.GATEWAY_CIRCUIT_MIN_REQUESTS, 10, 1, 1000
    );
    let windowStats = { total: 0, failed: 0, rate: 0 };
    try {
      await this._healthStore.recordWindowOutcome(adapterKey, false);
      windowStats = await this._healthStore.getWindowStats(adapterKey);
    } catch { /* window counters are best-effort; never block failure recording */ }
    const rateOpen = circuitEligible
      && windowStats.total >= ERR_RATE_MIN_REQUESTS
      && windowStats.rate >= ERR_RATE_THRESHOLD;

    // Exponential cooldown escalation. The backoff math lives in circuitBreaker.js
    // (single source — C-4): baseCooldown · 2^min(over, maxSteps), capped. The cap
    // and step bound are env-tunable (defaults preserve the prior 5min / 4-step
    // behavior exactly) so there is no inline magic number here.
    const overThreshold = Math.max(0, failureCountAfterRecord - CIRCUIT_BREAKER_THRESHOLD);
    const consecutiveOpen = circuitEligible && failureCountAfterRecord >= CIRCUIT_BREAKER_THRESHOLD;
    const circuitOpen = consecutiveOpen || rateOpen;
    const CIRCUIT_BREAKER_MAX_COOLDOWN_MS = _parseMs(
      process.env.GATEWAY_CIRCUIT_BREAKER_MAX_COOLDOWN_MS || '300000', 300000, CIRCUIT_BREAKER_COOLDOWN_MS
    );
    const CIRCUIT_BREAKER_MAX_BACKOFF_STEPS = _parsePositiveInt(
      process.env.GATEWAY_CIRCUIT_BREAKER_MAX_BACKOFF_STEPS, 4, 1, 16
    );
    const effectiveCooldownMs = circuitOpen
      ? require('../circuitBreaker').computeBackoffMs({
        baseMs: Math.max(cooldownMs, CIRCUIT_BREAKER_COOLDOWN_MS),
        attempt: overThreshold,
        maxSteps: CIRCUIT_BREAKER_MAX_BACKOFF_STEPS,
        maxMs: CIRCUIT_BREAKER_MAX_COOLDOWN_MS,
      })
      : cooldownMs;

    // Trigger reason mirrors cc-switch's distinct circuit events so the health
    // snapshot/CLI can explain WHY a channel opened (rate vs consecutive streak).
    const circuitReason = circuitOpen
      ? (consecutiveOpen ? (rateOpen ? 'consecutive+error_rate' : 'consecutive') : 'error_rate')
      : null;

    const record = {
      at: now,
      errorType: normalizedType,
      error: sanitizedError,
      cooldownMs: effectiveCooldownMs,
      circuitOpen,
      circuitReason,
      errorRate: windowStats.rate,
      ...(stallFingerprint ? { stallFingerprint } : {}),
      ...(failedModel ? { model: failedModel } : {}),
    };

    // Persist to Redis (or memory fallback)
    await this._healthStore.incrFailure(adapterKey);
    await this._healthStore.recordLastError(adapterKey, record, effectiveCooldownMs + 10000);
    if (circuitOpen) {
      await this._healthStore.setCooldown(adapterKey, effectiveCooldownMs);
      await this._healthStore.resetHalfOpen(adapterKey);
    }

    // Keep legacy in-memory copy for sync reads that haven't been migrated
    this._adapterLastError[adapterKey] = record;
    this._adapterFailures[adapterKey] = failureCountAfterRecord;
    this._cooldownSelfHealMeta[adapterKey] = {
      failureAt: now,
      cooldownMs: effectiveCooldownMs,
      midpointAt: now + Math.max(1000, Math.floor(effectiveCooldownMs / 2)),
      midpointProbeForFailureAt: null,
      nextAllowedAt: now,
      lastAttemptAt: 0,
      lastOutcome: 'failure_recorded',
    };
    this._scheduleCooldownSelfHealMidpointTimer(
      adapterKey,
      now,
      this._cooldownSelfHealMeta[adapterKey].midpointAt
    );

    // Broadcast health event
    this._healthBroadcaster.recordRequestActivity(adapterKey, 'failure', normalizedType);

    // FastMode 自适应降级: rate_limit/overloaded → 可能触发全局冷却
    if (_adaptiveConfig) {
      try { _adaptiveConfig.getFastModeManager().recordError(normalizedType); } catch { /* non-fatal */ }
    }
  },

  async _clearAdapterFailure(adapterKey) {
    // UCB bandit: a recovery/success outcome (no latency sample here → neutral
    // speed credit). No-op while UCB routing is disabled.
    this._recordAdapterOutcome(adapterKey, { success: true, at: Date.now() });

    // success_threshold recovery gating (借鉴 cc-switch HALF_OPEN_TO_CLOSED):
    // only when the circuit was OPEN / half-open do we require N consecutive
    // successes before fully clearing it. Capture the recovery state from the
    // SYNCHRONOUS fast-fail mirror BEFORE any async I/O — symmetric to
    // _recordAdapterFailure, which keeps the mirror hot before it awaits.
    const last = this._adapterLastError[adapterKey];
    const inRecovery = !!(last && (last.circuitOpen || last.halfOpen));

    // Anti-jitter: for a non-recovery (fault-free) clear, drop the LOCAL fast-fail
    // mirror immediately, before the awaits below. Otherwise a concurrent request
    // reading `_getRecentFastFail` during the await window would still see a stale
    // failure for an already-recovered channel and skip it. The half-open branch
    // deliberately keeps the mirror (relaxed) until the success streak is met.
    if (!inRecovery) {
      this._clearCooldownSelfHealMidpointTimer(adapterKey);
      delete this._adapterLastError[adapterKey];
      this._adapterFailures[adapterKey] = 0;
      delete this._cooldownSelfHealMeta[adapterKey];
      this._cooldownSelfHealInFlight.delete(adapterKey);
    }

    // Record this success into the error-rate window (success counts toward the
    // denominator) before any reset, so the windowed rate reflects real traffic.
    try { await this._healthStore.recordWindowOutcome(adapterKey, true); } catch { /* best effort */ }

    if (inRecovery) {
      const SUCCESS_THRESHOLD = _parsePositiveInt(
        process.env.GATEWAY_CIRCUIT_SUCCESS_THRESHOLD, 2, 1, 10
      );
      let consecutive = 1;
      try { consecutive = await this._healthStore.recordSuccess(adapterKey); } catch { /* best effort */ }
      if (consecutive < SUCCESS_THRESHOLD) {
        // Half-open observation: keep the failure history in the store but relax
        // the LOCAL fast-fail mirror (at:0 → elapsed always exceeds cooldown, so
        // _getRecentFastFail returns null) so subsequent requests can probe and
        // build the success streak. A fresh failure re-opens the circuit fast
        // because the store's consecutive-failure count is still elevated and
        // _recordAdapterFailure's resetHalfOpen() drops the streak.
        this._adapterLastError[adapterKey] = {
          ...last,
          circuitOpen: false,
          halfOpen: true,
          consecutiveSuccesses: consecutive,
          cooldownMs: 0,
          at: 0,
        };
        this._clearCooldownSelfHealMidpointTimer(adapterKey);
        delete this._cooldownSelfHealMeta[adapterKey];
        this._cooldownSelfHealInFlight.delete(adapterKey);
        this._healthBroadcaster.recordRequestActivity(
          adapterKey, 'success', `half-open ${consecutive}/${SUCCESS_THRESHOLD}`
        );
        return;
      }
      // Threshold met → drop the half-open counter and fall through to full clear.
      try { await this._healthStore.resetHalfOpen(adapterKey); } catch { /* best effort */ }
    }

    this._clearCooldownSelfHealMidpointTimer(adapterKey);
    delete this._adapterLastError[adapterKey];
    this._adapterFailures[adapterKey] = 0;
    delete this._cooldownSelfHealMeta[adapterKey];
    this._cooldownSelfHealInFlight.delete(adapterKey);
    await this._healthStore.clearFailure(adapterKey);
    this._healthBroadcaster.recordRequestActivity(adapterKey, 'success', 'circuit cleared');

    // FastMode: 成功恢复 → 重置错误计数
    if (_adaptiveConfig) {
      try { _adaptiveConfig.getFastModeManager().recordSuccess(); } catch { /* non-fatal */ }
    }
  },

  /**
   * Handle auth errors for account-pool-based adapters (kiro/cursor/trae/windsurf).
   * Routes to banActiveAccount (permanent) or cooldownAccount (recoverable).
   */
  async _handleAccountPoolAuthError(adapterKey, errorType, errorMessage, emitStatus) {
    const ACCOUNT_POOL_ADAPTERS = ['kiro', 'cursor', 'trae', 'windsurf'];
    if (!ACCOUNT_POOL_ADAPTERS.includes(adapterKey)) return;

    const isPermanent = errorType === 'auth_permanent'
      || /suspended|banned|locked|deactivated|revoked|invalid.?key|terminated/i.test(errorMessage || '');

    try {
      const accountPool = require('../accountPool');

      if (isPermanent) {
        const banResult = await accountPool.banActiveAccount(adapterKey);
        if (banResult?.switched) {
          emitStatus(`已封禁 ${adapterKey} 账号 #${banResult.bannedId}，自动切换到 #${banResult.nextId} (${banResult.label})`);
        } else if (banResult) {
          emitStatus(`已封禁 ${adapterKey} 账号 #${banResult.bannedId}，无其他可用账号`);
        }
      } else {
        const cooldownMs = adapterKey === 'kiro' ? 60000 : 120000;
        const cooldownResult = await accountPool.cooldownAccount(adapterKey, cooldownMs);
        if (cooldownResult?.switched) {
          emitStatus(`${adapterKey} 账号 #${cooldownResult.cooldownId} 冷却 ${cooldownMs / 1000}s，切换到 #${cooldownResult.nextId} (${cooldownResult.label})`);
        } else if (cooldownResult) {
          emitStatus(`${adapterKey} 账号 #${cooldownResult.cooldownId} 冷却 ${cooldownMs / 1000}s，无其他可用账号`);
        }
      }
    } catch { /* account pool not available */ }
  },

  /**
   * 判断是否应对某条已缓存的 fast-fail 冷却「放行」——仅用于视觉 describe 透传遇 model_not_found。
   *
   * 背景:fast-fail 冷却按 adapter 键控,但 `model_not_found`(404,模型名对本账号不可用/未开通)
   * 本质是**按模型**的错误。视觉 describe 级联在同一 GLM 池内从主视觉模型(glm-4.6v-flash,部分
   * 账号未实名 → 404)有序降级到次选(glm-4v-flash,几乎恒可用);若主模型的 model_not_found 冷却
   * 挡住同池的次选,级联永远救不回。describe 透传恒带**显式候选 model**,该显式模型理应获得真实
   * 尝试,而非被另一个模型的 404 连坐。故仅在此精确条件下放行,其它错误类型/非 describe 请求不变。
   *
   * 纯判定:零副作用、绝不抛。
   * @param {object} options  generate() 的 options(需含 `_visionDescribePass`)
   * @param {object} cached   _getRecentFastFail 返回的缓存失败项(含 `errorType`)
   * @returns {boolean}       true → 放行(视为未冷却,继续真实尝试)
   */
  _shouldBypassCooldownForVisionDescribe(options, cached) {
    try {
      if (!options || !options._visionDescribePass) return false;
      if (!cached) return false;
      return String(cached.errorType || '').toLowerCase() === 'model_not_found';
    } catch {
      return false;
    }
  },

  /**
   * 视觉 describe 嵌套 generate() 应否把 `preferredAdapter` 钉到 `api` 适配器。
   *
   * 背景/根因(实测「图像识别始终 404」):describe 级联给嵌套 generate() 传
   * `apiPoolProvider`(如 'glm')以定向 GLM 视觉端点,但该字段**只在 `api` 适配器内部**
   * 被消费(_resolveApiPoolProviderForRequest → 仅 entry.key==='api')。若不同时把
   * preferredAdapter 钉到 'api',嵌套调用会从头跑完整适配器级联(kiro→cursor→trae→…→api),
   * 排在 api 前面的 OpenAI 兼容通道先接住请求、拿到裸视觉模型名(glm-4.6v-flash)打到自己的
   * 上游 → 那里没有此模型 → `OpenAI: 404 model_not_found`,识图永远失败(报错前缀 OpenAI 即
   * 证据:请求根本没到智谱端点)。故:有 poolHint → 钉 api 适配器;无 poolHint(裸候选,默认
   * 同池)→ 不钉,让级联自然解析(逐字节回退旧行为)。
   *
   * 纯判定:零副作用、绝不抛。
   * @param {string|undefined} poolHint  归一化后的 api pool provider 名(如 'glm')
   * @returns {boolean}  true → 应钉 preferredAdapter:'api' + strictPreferred
   */
  _shouldPinApiAdapterForVisionDescribe(poolHint) {
    try {
      return !!String(poolHint == null ? '' : poolHint).trim();
    } catch {
      return false;
    }
  },

  _getRecentFastFail(adapterKey) {

    // Fast path: synchronous in-memory mirror.
    const item = this._adapterLastError[adapterKey] || null;
    if (!item) return null;
    const fallbackCooldownMs = _parseMs(process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS || '30000', 30000, 5000);
    const cooldownMs = _parseMs(item.cooldownMs, fallbackCooldownMs, 5000);
    const elapsedMs = Date.now() - Number(item.at || 0);
    if (elapsedMs > cooldownMs) return null;
    // Circuit breaker: always fast-fail when circuit is open, regardless of error type
    if (!item.circuitOpen && !_shouldUseFastFail(item.errorType)) {
      // Transient errors (rate_limit, timeout, network, overloaded) get a shorter
      // cooldown window — skip the adapter briefly instead of retrying immediately.
      const transientMs = _transientCooldownMs(item.errorType);
      if (!transientMs || elapsedMs > transientMs) return null;
      return {
        ...item,
        cooldownMs: transientMs,
        remainingMs: Math.max(0, transientMs - elapsedMs),
      };
    }

    return {
      ...item,
      cooldownMs,
      remainingMs: Math.max(0, cooldownMs - elapsedMs),
    };
  },

  _resolveCooldownSelfHealConfig() {
    return {
      enabled: String(process.env.GATEWAY_COOLDOWN_SELF_HEAL_ENABLED || 'true').toLowerCase() !== 'false',
      minRemainingMs: _parseMs(
        process.env.GATEWAY_COOLDOWN_SELF_HEAL_MIN_REMAINING_MS || '2500',
        2500,
        1000
      ),
      minIntervalMs: _parseMs(
        process.env.GATEWAY_COOLDOWN_SELF_HEAL_MIN_INTERVAL_MS || '7000',
        7000,
        1000
      ),
      successQuietMs: _parseMs(
        process.env.GATEWAY_COOLDOWN_SELF_HEAL_SUCCESS_QUIET_MS || '45000',
        45000,
        5000
      ),
      failureRetryMs: _parseMs(
        process.env.GATEWAY_COOLDOWN_SELF_HEAL_FAILURE_RETRY_MS || '15000',
        15000,
        3000
      ),
      probeTimeoutMs: _parseMs(
        process.env.GATEWAY_COOLDOWN_SELF_HEAL_PROBE_TIMEOUT_MS || '9000',
        9000,
        2000
      ),
      generationProbeTimeoutMs: _parseMs(
        process.env.GATEWAY_COOLDOWN_SELF_HEAL_PROBE_GENERATION_TIMEOUT_MS || '7000',
        7000,
        2000
      ),
      tickMs: _parseMs(
        process.env.GATEWAY_COOLDOWN_SELF_HEAL_TICK_MS || '3000',
        3000,
        1000
      ),
    };
  },

  async _runCooldownSelfHealTick() {
    const cfg = this._resolveCooldownSelfHealConfig();
    if (!cfg.enabled) return;
    const keys = Object.keys(this._adapterLastError || {});
    for (const adapterKey of keys) {
      const recent = this._getRecentFastFail(adapterKey);
      if (!recent) continue;
      this._triggerMidpointSelfHealProbe(adapterKey, recent, { source: 'timer_midpoint_tick' });
    }
  },

  _startCooldownSelfHealTicker() {
    this._stopCooldownSelfHealTicker();
    const cfg = this._resolveCooldownSelfHealConfig();
    if (!cfg.enabled) return;
    const tick = () => {
      this._runCooldownSelfHealTick().catch(() => {});
    };
    this._cooldownSelfHealTimer = setInterval(tick, cfg.tickMs);
    if (this._cooldownSelfHealTimer.unref) this._cooldownSelfHealTimer.unref();
    for (const [adapterKey, recent] of Object.entries(this._adapterLastError || {})) {
      if (!recent) continue;
      const failureAt = Number(recent.at || 0);
      const cooldownMs = Number(recent.cooldownMs || 0);
      if (!Number.isFinite(failureAt) || failureAt <= 0) continue;
      const midpointAt = failureAt + Math.max(1000, Math.floor(cooldownMs / 2));
      this._scheduleCooldownSelfHealMidpointTimer(adapterKey, failureAt, midpointAt);
    }
    tick();
  },

  _stopCooldownSelfHealTicker() {
    if (this._cooldownSelfHealTimer) {
      clearInterval(this._cooldownSelfHealTimer);
      this._cooldownSelfHealTimer = null;
    }
    this._clearAllCooldownSelfHealMidpointTimers();
  },

  _isHealthyProbeResult(probeResult) {
    if (!probeResult || typeof probeResult !== 'object') return false;
    const connectivityOk = !!probeResult.connectivity?.success;
    if (!connectivityOk) return false;
    if (Object.prototype.hasOwnProperty.call(probeResult, 'generation')) {
      return !!probeResult.generation?.success;
    }
    if (Object.prototype.hasOwnProperty.call(probeResult, 'models')) {
      return !!probeResult.models?.success;
    }
    return true;
  },

  _maybeScheduleCooldownSelfHealProbe(adapterKey, recentFail = null, options = {}) {
    const cfg = this._resolveCooldownSelfHealConfig();
    if (!cfg.enabled) return false;
    const entry = this._adapters.find(a => a.key === adapterKey && a.enabled);
    if (!entry) return false;
    const cached = recentFail || this._getRecentFastFail(adapterKey);
    if (!cached) return false;
    if ((cached.remainingMs || 0) < cfg.minRemainingMs) return false;
    const now = Date.now();
    const meta = this._cooldownSelfHealMeta[adapterKey] || {};
    if (this._cooldownSelfHealInFlight.has(adapterKey)) return false;
    if (meta.nextAllowedAt && now < meta.nextAllowedAt) return false;
    if (meta.lastAttemptAt && (now - meta.lastAttemptAt) < cfg.minIntervalMs) return false;

    const emitStatus = typeof options.emitStatus === 'function' ? options.emitStatus : () => {};
    const adapterDisplayName = String(options.adapterDisplayName || (() => {
      try { return entry.adapter.getStatus().name || adapterKey; } catch { return adapterKey; }
    })());
    const sourceLabel = String(options.source || 'generate').trim() || 'generate';
    const shouldDeepProbe = _isProcessSensitiveAdapter(adapterKey)
      || adapterKey === 'relay_api'
      || adapterKey === 'api'
      || adapterKey === 'relay';

    this._cooldownSelfHealMeta[adapterKey] = {
      ...meta,
      lastAttemptAt: now,
      nextAllowedAt: now + cfg.minIntervalMs,
      lastSource: sourceLabel,
    };

    const probePromise = (async () => {
      try {
        emitStatus(`冷却探活: 已启动 ${adapterDisplayName} 通道后台健康检测（目标: 提前解除冷却）`);
        this._healthBroadcaster.recordRequestActivity(
          adapterKey,
          'attempt',
          `cooldown_self_heal_probe:${sourceLabel}`
        );
        const probeResult = await this.testAdapter(adapterKey, {
          quick: !shouldDeepProbe,
          timeoutMs: cfg.probeTimeoutMs,
          probeGenerationTimeoutMs: shouldDeepProbe ? cfg.generationProbeTimeoutMs : 0,
        });
        if (this._isHealthyProbeResult(probeResult)) {
          await this._clearAdapterFailure(adapterKey);
          this._cooldownSelfHealMeta[adapterKey] = {
            ...this._cooldownSelfHealMeta[adapterKey],
            lastSuccessAt: Date.now(),
            nextAllowedAt: Date.now() + cfg.successQuietMs,
            lastOutcome: 'recovered',
          };
          emitStatus(`冷却探活完成: ${adapterDisplayName} 通道已恢复（已提前解除冷却）`);
          this._healthBroadcaster.recordRequestActivity(
            adapterKey,
            'success',
            `cooldown_self_heal_probe_recovered:${sourceLabel}`
          );
          return;
        }
        const retryAt = Date.now() + cfg.failureRetryMs;
        this._cooldownSelfHealMeta[adapterKey] = {
          ...this._cooldownSelfHealMeta[adapterKey],
          nextAllowedAt: retryAt,
          lastOutcome: 'still_unhealthy',
        };
        emitStatus(`冷却探活结果: ${adapterDisplayName} 通道仍异常（继续冷却，稍后再探活）`);
        this._healthBroadcaster.recordRequestActivity(
          adapterKey,
          'failure',
          `cooldown_self_heal_probe_still_unhealthy:${sourceLabel}`
        );
      } catch (err) {
        const retryAt = Date.now() + cfg.failureRetryMs;
        this._cooldownSelfHealMeta[adapterKey] = {
          ...this._cooldownSelfHealMeta[adapterKey],
          nextAllowedAt: retryAt,
          lastOutcome: `probe_error:${err?.message || 'unknown'}`,
        };
        emitStatus(`冷却探活错误: ${adapterDisplayName} 通道检测失败（将保持冷却）`);
        this._healthBroadcaster.recordRequestActivity(
          adapterKey,
          'failure',
          `cooldown_self_heal_probe_error:${err?.message || 'unknown'}`
        );
      } finally {
        this._cooldownSelfHealInFlight.delete(adapterKey);
      }
    })();

    this._cooldownSelfHealInFlight.set(adapterKey, probePromise);
    return true;
  },

  _resolveFastFailCooldownMs(adapterKey, errorType, error, stallFingerprint = '') {
    const baseCooldownMs = _parseMs(process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS || '30000', 30000, 5000);
    if (String(adapterKey || '').toLowerCase() !== 'codex') return baseCooldownMs;

    // Active bypass: a known-bad pre-response stall fingerprint escalates the
    // codex fast-fail cooldown so the next request virtual-skips codex (via
    // inspectCachedFastFail) and cascades to api/relay_api/direct instead of
    // burning another full first-response window. 'none'/unknown → ×1.
    const stallMultiplier = (() => {
      try {
        return require('./codexStallPolicy').resolveStallCooldownMultiplier(stallFingerprint);
      } catch {
        return 1;
      }
    })();
    const applyStall = (ms) => Math.round(_parseMs(ms, ms, baseCooldownMs) * stallMultiplier);

    const errorKind = String(errorType || '').toLowerCase();
    const message = String(error || '').toLowerCase();
    const processCooldownMs = _parseMs(
      process.env.GATEWAY_FAST_FAIL_CODEX_PROCESS_COOLDOWN_MS || '30000',
      30000,
      baseCooldownMs
    );
    const reconnectCooldownMs = _parseMs(
      process.env.GATEWAY_FAST_FAIL_CODEX_RECONNECT_COOLDOWN_MS || String(processCooldownMs),
      processCooldownMs,
      baseCooldownMs
    );
    const networkCooldownMs = _parseMs(
      process.env.GATEWAY_FAST_FAIL_CODEX_NETWORK_COOLDOWN_MS || '60000',
      60000,
      baseCooldownMs
    );
    const timeoutCooldownMs = _parseMs(
      process.env.GATEWAY_FAST_FAIL_CODEX_TIMEOUT_COOLDOWN_MS || '45000',
      45000,
      baseCooldownMs
    );

    if (errorKind === 'process') {
      if (_isReconnectOrChannelClosedMessage(message) || /without emitting stream-json/.test(message)) {
        return applyStall(reconnectCooldownMs);
      }
      return applyStall(processCooldownMs);
    }
    if (errorKind === 'network') return applyStall(networkCooldownMs);
    if (errorKind === 'timeout') return applyStall(timeoutCooldownMs);
    return applyStall(baseCooldownMs);
  },
};

module.exports = { AIGatewayCooldownMethods, setAiGatewayCooldownMethodsDeps };
