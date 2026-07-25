'use strict';

/**
 * Routing / timeout / lifecycle methods (extracted from services/gateway/aiGateway.js).
 *
 * A cohesive cluster of AIGateway instance methods covering: per-adapter timeout resolution, default-route
 * candidate assessment / ranking (incl. UCB routing + failover-order preference + protocol-hint reorder),
 * process-failover promotion, adapter-isolated generation, reconnect / refresh, rate-limit enforcement,
 * init / background model refresh, active-channel lifecycle, and model context-window resolution.
 *
 * Relocated verbatim (byte-identical bodies) into a same-directory sibling and mixed back onto
 * AIGateway.prototype via Object.assign in the host. Object-shorthand method syntax is identical to
 * class-method syntax, so the only transform was appending a comma after each method close; `this` binds
 * at call time on the prototype, keeping bodies byte-identical. In-body relative require() paths resolve
 * identically from this sibling. Module-scope helpers/consts the methods reference (khy-protocol prompt
 * injectors + debug helpers, route-tuning tables, adapters, localLLMService, small parsers) are injected
 * via setAiGatewayRoutingMethodsDeps to avoid a require cycle back into aiGateway.js. The methods perform
 * IO (adapter calls, timers, network) and run only against a live gateway instance, so this is NOT a pure
 * zero-IO leaf.
 */

const path = require('path');

// Module-scope deps from aiGateway.js, injected once at host load (see setter). The 11 functions are
// hoisted declarations on the host; the value deps (route-tuning tables, adapters, localLLMService) are
// set once at host load. localLLMService can legitimately be null, so it uses a `!== undefined` guard.
let _appendKhyProtocolDebugLog = null;
let _buildKhyProtocolDebugSummary = null;
let _formatRouteAgeMs = null;
let _getKhyProtocolPriorityRisk = null;
let _injectKhyExpectedLanguageSystem = null;
let _injectKhyProtocolPrompt = null;
let _injectKhyProtocolSystem = null;
let _isProcessSensitiveAdapter = null;
let _parseMs = null;
let _parseProcessFailoverCandidates = null;
let _resolveDefaultRouteTuning = null;
let DEFAULT_ROUTE_BASE_PRIORITY = null;
let DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS = null;
let kiroAdapter = null;
let ollamaAdapter = null;
let localLLMService = null;

function setAiGatewayRoutingMethodsDeps(deps = {}) {
  if (typeof deps._appendKhyProtocolDebugLog === 'function') _appendKhyProtocolDebugLog = deps._appendKhyProtocolDebugLog;
  if (typeof deps._buildKhyProtocolDebugSummary === 'function') _buildKhyProtocolDebugSummary = deps._buildKhyProtocolDebugSummary;
  if (typeof deps._formatRouteAgeMs === 'function') _formatRouteAgeMs = deps._formatRouteAgeMs;
  if (typeof deps._getKhyProtocolPriorityRisk === 'function') _getKhyProtocolPriorityRisk = deps._getKhyProtocolPriorityRisk;
  if (typeof deps._injectKhyExpectedLanguageSystem === 'function') _injectKhyExpectedLanguageSystem = deps._injectKhyExpectedLanguageSystem;
  if (typeof deps._injectKhyProtocolPrompt === 'function') _injectKhyProtocolPrompt = deps._injectKhyProtocolPrompt;
  if (typeof deps._injectKhyProtocolSystem === 'function') _injectKhyProtocolSystem = deps._injectKhyProtocolSystem;
  if (typeof deps._isProcessSensitiveAdapter === 'function') _isProcessSensitiveAdapter = deps._isProcessSensitiveAdapter;
  if (typeof deps._parseMs === 'function') _parseMs = deps._parseMs;
  if (typeof deps._parseProcessFailoverCandidates === 'function') _parseProcessFailoverCandidates = deps._parseProcessFailoverCandidates;
  if (typeof deps._resolveDefaultRouteTuning === 'function') _resolveDefaultRouteTuning = deps._resolveDefaultRouteTuning;
  if (deps.DEFAULT_ROUTE_BASE_PRIORITY !== undefined) DEFAULT_ROUTE_BASE_PRIORITY = deps.DEFAULT_ROUTE_BASE_PRIORITY;
  if (deps.DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS !== undefined) DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS = deps.DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS;
  if (deps.kiroAdapter !== undefined) kiroAdapter = deps.kiroAdapter;
  if (deps.ollamaAdapter !== undefined) ollamaAdapter = deps.ollamaAdapter;
  if (deps.localLLMService !== undefined) localLLMService = deps.localLLMService;
}

const AIGatewayRoutingMethods = {
  _resolveAdapterTimeoutMs(adapterKey, fallbackTimeoutMs) {
    const fallbackMs = _parseMs(fallbackTimeoutMs, 60000, 1000);
    const envTimeout = process.env[`GATEWAY_${String(adapterKey || '').toUpperCase()}_TIMEOUT_MS`];
    if (String(envTimeout || '').trim()) {
      return _parseMs(envTimeout, fallbackMs, 1000);
    }

    const resolvedMs = _parseMs(
      process.env.GATEWAY_PER_ADAPTER_TIMEOUT_MS || String(fallbackMs),
      fallbackMs,
      1000
    );
    const normalizedAdapterKey = String(adapterKey || '').trim().toLowerCase();
    if (normalizedAdapterKey !== 'localllm' && normalizedAdapterKey !== 'ollama') {
      return resolvedMs;
    }

    if (normalizedAdapterKey === 'localllm') {
      let status = null;
      try {
        status = localLLMService && typeof localLLMService.getStatus === 'function'
          ? localLLMService.getStatus()
          : null;
      } catch {
        status = null;
      }
      if (!status || !status.available) return resolvedMs;

      const coldStartTimeoutMs = _parseMs(
        process.env.GATEWAY_LOCAL_LLM_COLD_TIMEOUT_MS || '180000',
        180000,
        Math.max(1000, resolvedMs)
      );
      const warmTimeoutMs = _parseMs(
        process.env.GATEWAY_LOCAL_LLM_WARM_TIMEOUT_MS || String(Math.max(90000, resolvedMs)),
        Math.max(90000, resolvedMs),
        1000
      );
      const degradedTimeoutMs = _parseMs(
        process.env.GATEWAY_LOCAL_LLM_DEGRADED_TIMEOUT_MS || String(Math.max(coldStartTimeoutMs, 210000)),
        Math.max(coldStartTimeoutMs, 210000),
        1000
      );

      if (status.lastError) return Math.max(resolvedMs, degradedTimeoutMs);
      if (!status.loaded) return Math.max(resolvedMs, coldStartTimeoutMs);
      return Math.max(1000, warmTimeoutMs);
    }

    let ollamaStatus = null;
    try {
      ollamaStatus = ollamaAdapter && typeof ollamaAdapter.getStatus === 'function'
        ? ollamaAdapter.getStatus()
        : null;
    } catch {
      ollamaStatus = null;
    }

    const ollamaWarmTimeoutMs = _parseMs(
      process.env.GATEWAY_OLLAMA_WARM_TIMEOUT_MS || String(Math.max(120000, resolvedMs)),
      Math.max(120000, resolvedMs),
      1000
    );
    const ollamaColdTimeoutMs = _parseMs(
      process.env.GATEWAY_OLLAMA_COLD_TIMEOUT_MS || String(Math.max(180000, ollamaWarmTimeoutMs)),
      Math.max(180000, ollamaWarmTimeoutMs),
      1000
    );
    const ollamaDegradedTimeoutMs = _parseMs(
      process.env.GATEWAY_OLLAMA_DEGRADED_TIMEOUT_MS || String(Math.max(210000, ollamaColdTimeoutMs)),
      Math.max(210000, ollamaColdTimeoutMs),
      1000
    );
    const recentOllamaFail = this._getRecentFastFail('ollama');
    if (recentOllamaFail) return Math.max(resolvedMs, ollamaDegradedTimeoutMs);
    if (ollamaStatus && ollamaStatus.available) return Math.max(resolvedMs, ollamaColdTimeoutMs);
    return Math.max(resolvedMs, ollamaWarmTimeoutMs);
  },

  _shouldSerializeAdapter(adapterKey) {
    const raw = String(adapterKey || '').trim();
    if (!raw) return false;
    if (this._serializedAdapterKeys.has(raw)) return true;
    const lower = raw.toLowerCase();
    for (const key of this._serializedAdapterKeys) {
      if (String(key || '').toLowerCase() === lower) return true;
    }
    return false;
  },

  _getDefaultRouteBasePriority(adapterKey = '') {
    const normalized = String(adapterKey || '').trim().toLowerCase();
    if (!normalized) return 999;
    if (Object.prototype.hasOwnProperty.call(DEFAULT_ROUTE_BASE_PRIORITY, normalized)) {
      return DEFAULT_ROUTE_BASE_PRIORITY[normalized];
    }
    return 999;
  },

  // 是否属于「人肉中转通道」(relay / clipboard)——需要人在场复制粘贴,不该作为自动兜底。
  // 复用唯一真源 DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS(见 aiGateway.js),不新造集合防漂移。
  _isManualFallbackOnlyKey(adapterKey = '') {
    if (!DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS) return false;
    return DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS.has(String(adapterKey || '').trim().toLowerCase());
  },

  _collectAdapterRuntimeDiagnostics(entry, diagOptions = {}) {
    if (!entry?.adapter || typeof entry.adapter.getRuntimeDiagnostics !== 'function') return null;
    try {
      const runtimeDiag = entry.adapter.getRuntimeDiagnostics({
        includePersisted: true,
        ...diagOptions,
      });
      return runtimeDiag && Number(runtimeDiag.at || 0) > 0 ? runtimeDiag : null;
    } catch {
      return null;
    }
  },

  _assessDefaultRouteCandidate(entry, options = {}) {
    if (!entry || !entry.adapter) return null;

    const tuning = _resolveDefaultRouteTuning();
    const adapterKey = String(entry.key || '').trim();
    const keyLower = adapterKey.toLowerCase();
    const status = (() => {
      try { return entry.adapter.getStatus(); } catch { return {}; }
    })();
    let available = entry.available;
    if (available !== true && available !== false && typeof status.available === 'boolean') {
      available = status.available;
    }
    if ((available === null || available === undefined) && options.detectIfNeeded && typeof entry.adapter.detect === 'function') {
      try {
        available = !!entry.adapter.detect();
        entry.available = available;
      } catch {
        available = false;
      }
    }
    const name = String(status.name || adapterKey || 'unknown').trim() || adapterKey || 'unknown';
    const basePriority = this._getDefaultRouteBasePriority(adapterKey);
    const reasons = [];
    const now = Date.now();
    const manualFallbackOnly = DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS.has(keyLower);
    const recentFailure = this._getRecentFastFail(adapterKey);
    const latestRuntime = this._collectAdapterRuntimeDiagnostics(entry);
    const stallRuntime = this._collectAdapterRuntimeDiagnostics(entry, { preferCategory: 'stall' });
    const transportRuntime = this._collectAdapterRuntimeDiagnostics(entry, { preferCategory: 'transport' });
    const recoveryRuntime = this._collectAdapterRuntimeDiagnostics(entry, { preferCategory: 'recovery' });
    const protocolRisk = _getKhyProtocolPriorityRisk({
      key: adapterKey,
      type: keyLower,
      name,
    });

    if (!entry.enabled) {
      return {
        adapter: adapterKey,
        type: keyLower,
        name,
        available: false,
        enabled: false,
        blocked: true,
        blockReason: 'disabled',
        manualFallbackOnly,
        basePriority,
        totalPenalty: 0,
        score: basePriority * 10,
        healthyDefault: false,
        reasons,
        protocolRisk,
      };
    }

    if (!available) {
      return {
        adapter: adapterKey,
        type: keyLower,
        name,
        available: false,
        enabled: true,
        blocked: true,
        blockReason: 'unavailable',
        manualFallbackOnly,
        basePriority,
        totalPenalty: 0,
        score: basePriority * 10,
        healthyDefault: false,
        reasons,
        protocolRisk,
      };
    }

    if (manualFallbackOnly && !options.includeManualFallback) {
      return {
        adapter: adapterKey,
        type: keyLower,
        name,
        available: true,
        enabled: true,
        blocked: true,
        blockReason: 'manual_fallback_only',
        manualFallbackOnly,
        basePriority,
        totalPenalty: 0,
        score: basePriority * 10,
        healthyDefault: false,
        reasons,
        protocolRisk,
      };
    }

    if (recentFailure) {
      reasons.push({
        code: 'recent_fast_fail',
        penalty: tuning.recentFailurePenalty,
        text: `最近 ${_formatRouteAgeMs(now - Number(recentFailure.at || now))} 内命中过 ${recentFailure.errorType || 'unknown'} 冷却`,
      });
    }

    const stallAgeMs = stallRuntime ? Math.max(0, now - Number(stallRuntime.at || 0)) : 0;
    if (stallRuntime && stallAgeMs <= tuning.stallWindowMs) {
      reasons.push({
        code: 'recent_stall',
        penalty: tuning.stallPenalty,
        text: `最近 ${_formatRouteAgeMs(stallAgeMs)} 内出现 ${stallRuntime.trigger || 'stall'}（${stallRuntime.diagnosis || stallRuntime.summary || '无进一步诊断'}）`,
      });
    }

    const transportAgeMs = transportRuntime ? Math.max(0, now - Number(transportRuntime.at || 0)) : 0;
    if (transportRuntime && transportAgeMs <= tuning.transportWindowMs) {
      reasons.push({
        code: 'recent_transport',
        penalty: tuning.transportPenalty,
        text: `最近 ${_formatRouteAgeMs(transportAgeMs)} 内出现 ${transportRuntime.trigger || 'transport'}（${transportRuntime.summary || transportRuntime.diagnosis || '无进一步诊断'}）`,
      });
    }

    const recoveryAgeMs = recoveryRuntime ? Math.max(0, now - Number(recoveryRuntime.at || 0)) : 0;
    if (recoveryRuntime && recoveryAgeMs <= tuning.recoveryQuietMs) {
      reasons.push({
        code: 'recovery_quiet_period',
        penalty: tuning.recoveryPenalty,
        text: `最近 ${_formatRouteAgeMs(recoveryAgeMs)} 内刚从异常恢复，仍处观察期`,
      });
    }

    const isCodexCliBridge = keyLower === 'codex' && !/direct/i.test(String(status.name || ''));
    if (isCodexCliBridge) {
      reasons.push({
        code: 'codex_cli_deprioritized',
        penalty: tuning.codexCliPenalty,
        text: 'Codex CLI 默认降级为次级兜底，优先更稳定的 API/远端通道',
      });
    }

    if (protocolRisk?.risky) {
      reasons.push({
        code: 'protocol_risk',
        penalty: tuning.protocolRiskPenalty,
        text: '存在上游隐藏 prompt 覆盖风险，默认稳定路由降低优先级',
      });
    }

    // Cache-economy soft penalty (DESIGN-ARCH-047): if the probe judges this
    // adapter as opaquely billing (never discloses cache fields across many
    // requests despite us sending a cacheable prefix), down-weight it in the
    // default route. Soft only — set GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY=0
    // to disable; NEVER sets `blocked` (the adapter stays a valid fallback).
    let cacheVerdict = '';
    try {
      cacheVerdict = require('./cacheEconomyStore').getVerdict(adapterKey);
    } catch { /* probe optional */ }
    if (cacheVerdict === 'opaque_suspected_gouging' && tuning.cacheGougingPenalty > 0) {
      reasons.push({
        code: 'cache_gouging',
        penalty: tuning.cacheGougingPenalty,
        text: '疑似缓存不透明计费（享受缓存却全价计费或不缓存），默认路由降权',
      });
    }

    // Latency-aware soft penalty (/goal「优化路由网关算法提升用户体验」): 健康但慢的通道
    // 在健康集内部轻度降权破平局。软罚分硬顶在 healthyPenaltyCeiling-1(慢≠不可用):单凭
    // 延迟永不把通道踢出健康集、永不 blocked。冷启动/陈旧样本不判罚。门控 KHY_ROUTE_LATENCY_AWARE
    // (关 / 叶子或 store 缺失 / 样本不足 → 不 push,totalPenalty 逐字节回退今天)。
    try {
      const lat = require('./routeLatencyPenalty');
      if (lat.isRouteLatencyAwareEnabled(process.env)) {
        const stats = require('./routeLatencyStore').getStats(`adapter:${adapterKey}`);
        const latReason = lat.buildLatencyReason(stats, {
          ceiling: tuning.healthyPenaltyCeiling,
          env: process.env,
        });
        if (latReason && latReason.penalty > 0) reasons.push(latReason);
      }
    } catch { /* 延迟感知可选,缺失/异常 → 不加罚分,逐字节回退今天 */ }

    const totalPenalty = reasons.reduce((sum, item) => sum + Number(item.penalty || 0), 0);
    const score = (basePriority * 10) + totalPenalty;
    return {
      adapter: adapterKey,
      type: keyLower,
      name,
      available: true,
      enabled: true,
      blocked: false,
      blockReason: '',
      manualFallbackOnly,
      basePriority,
      totalPenalty,
      score,
      healthyDefault: totalPenalty < tuning.healthyPenaltyCeiling,
      reasons,
      protocolRisk,
      latestRuntime,
    };
  },

  _rankAdaptersForDefaultRoute(options = {}) {
    const sourceEntries = Array.isArray(options.entries) && options.entries.length > 0
      ? options.entries
      : this._adapters;
    const assessments = sourceEntries
      .map((entry) => this._assessDefaultRouteCandidate(entry, options))
      .filter(Boolean);
    const eligible = assessments
      .filter((item) => !item.blocked)
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        if (a.basePriority !== b.basePriority) return a.basePriority - b.basePriority;
        return String(a.adapter || '').localeCompare(String(b.adapter || ''));
      });
    if (eligible.length > 0) {
      return {
        ranking: this._applyUcbRouting(eligible),
        assessments,
      };
    }
    const manualFallback = assessments
      .filter((item) => item.available && item.enabled)
      .sort((a, b) => {
        if (a.basePriority !== b.basePriority) return a.basePriority - b.basePriority;
        return String(a.adapter || '').localeCompare(String(b.adapter || ''));
      });
    return {
      ranking: manualFallback,
      assessments,
    };
  },

  // ── Phase C-1: UCB1 bandit routing (design doc §4.C) ──────────────────────
  // Grayscale-gated by KHY_UCB_ROUTING (default OFF → the penalty-score path is
  // unchanged, zero regression). When ON, the penalty score still decides which
  // adapters are *eligible* (blocked/unavailable filtering is untouched); UCB1
  // only re-orders the eligible set by learned reward (success rate × speed),
  // with the cooling state folded into the exploration term so a resting adapter
  // is not probed just for being under-sampled.
  _ucbRoutingEnabled() {
    return String(process.env.KHY_UCB_ROUTING || 'false').toLowerCase() === 'true';
  },

  _applyUcbRouting(eligible) {
    if (!this._ucbRoutingEnabled() || !Array.isArray(eligible) || eligible.length <= 1) {
      return eligible;
    }
    try {
      const ucb = require('./ucbRouter');
      const keys = eligible.map((item) => String(item.adapter || ''));
      const cooldownByKey = {};
      for (const item of eligible) {
        const recent = this._getRecentFastFail(item.adapter);
        if (recent && recent.remainingMs > 0) {
          cooldownByKey[String(item.adapter || '').toLowerCase()] = {
            remainingMs: recent.remainingMs,
            maxMs: recent.cooldownMs,
          };
        }
      }
      const ranked = ucb.rank(keys, { cooldownByKey });
      const order = new Map(ranked.map((r, index) => [r.adapter, index]));
      // Stable re-sort by UCB position; items unknown to the bandit keep their
      // incoming (penalty-score) order behind ranked ones.
      return [...eligible].sort((a, b) => {
        const ai = order.has(String(a.adapter || '').toLowerCase())
          ? order.get(String(a.adapter || '').toLowerCase()) : Number.MAX_SAFE_INTEGER;
        const bi = order.has(String(b.adapter || '').toLowerCase())
          ? order.get(String(b.adapter || '').toLowerCase()) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
    } catch {
      return eligible; // bandit optional — fall back to penalty order
    }
  },

  // Records one adapter outcome into the UCB bandit. Best-effort, no-throw, and a
  // no-op while UCB routing is disabled, so the request path is never affected.
  _recordAdapterOutcome(adapterKey, outcome) {
    if (!this._ucbRoutingEnabled()) return;
    try {
      require('./ucbRouter').recordOutcome(adapterKey, outcome || {});
    } catch { /* bandit optional */ }
  },

  // 读取用户自定义故障转移顺序（带短 TTL 缓存，避免每次路由都读磁盘）。
  // 返回 Map<key, index>（index 越小越优先）；未启用时返回 null。
  _getFailoverOrderMap() {
    const now = Date.now();
    if (this._failoverOrderCache && now < this._failoverOrderCache.expiresAt) {
      return this._failoverOrderCache.map;
    }
    let map = null;
    try {
      const store = require('./failoverOrderStore');
      const { enabled, order } = store.getFailoverOrder();
      if (enabled && Array.isArray(order) && order.length > 0) {
        map = new Map(order.map((key, index) => [String(key), index]));
      }
    } catch { /* store 不可用 → 回退全自动评分 */ }
    this._failoverOrderCache = { map, expiresAt: now + 5000 };
    return map;
  },

  // 使下一次 _getFailoverOrderMap 重新读取（CLI 写入顺序后调用）。
  _invalidateFailoverOrderCache() {
    this._failoverOrderCache = null;
  },

  _orderAdaptersByDefaultRoutePreference(entries = [], options = {}) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    if (list.length <= 1) return list;
    const routeRanking = this._rankAdaptersForDefaultRoute({
      ...options,
      entries: list,
    });
    const positionByKey = new Map(
      (routeRanking.ranking || []).map((item, index) => [String(item.adapter || ''), index])
    );
    // 用户自定义故障转移顺序：作为主排序键。列出的通道按其给定顺序优先，未列出
    // 的通道接在其后并沿用自动 penalty 排序为次级键。仅改变「尝试顺序」——熔断/
    // 冷却判定不受影响：被用户排到最前但处于 cooldown 的通道仍会被 _getRecentFastFail
    // 快速跳过、cascade 继续下一个（现有行为完整保留）。
    const userOrder = this._getFailoverOrderMap();
    return [...list].sort((a, b) => {
      if (userOrder) {
        const aKey = String(a?.key || '');
        const bKey = String(b?.key || '');
        const aUser = userOrder.has(aKey) ? userOrder.get(aKey) : Number.MAX_SAFE_INTEGER;
        const bUser = userOrder.has(bKey) ? userOrder.get(bKey) : Number.MAX_SAFE_INTEGER;
        if (aUser !== bUser) return aUser - bUser;
      }
      const aPos = positionByKey.has(String(a?.key || ''))
        ? positionByKey.get(String(a?.key || ''))
        : Number.MAX_SAFE_INTEGER;
      const bPos = positionByKey.has(String(b?.key || ''))
        ? positionByKey.get(String(b?.key || ''))
        : Number.MAX_SAFE_INTEGER;
      if (aPos !== bPos) return aPos - bPos;
      return Number(a?.priority || 0) - Number(b?.priority || 0);
    });
  },

  _reorderAdaptersByModelProtocolHint(entries = [], options = {}, routeControl = {}) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    if (list.length <= 1) return list;

    const model = String(options?.model || '').trim();
    if (!model) return list;

    let inferProtocolFromModel;
    let getProtocolForAdapter;
    let isProtocolSupported;
    try {
      ({ inferProtocolFromModel, getProtocolForAdapter, isProtocolSupported } = require('./adapters/_protocolRegistry'));
    } catch {
      return list;
    }

    const hintedProtocol = inferProtocolFromModel(model);
    if (!hintedProtocol) return list;

    const lockedKeys = new Set(
      (Array.isArray(routeControl?.preserveLeadingKeys) ? routeControl.preserveLeadingKeys : [])
        .map((key) => String(key || '').trim())
        .filter(Boolean)
    );
    const openaiPriority = [
      'api',
      'relay_api',
      'cursor2api',
      'cursor',
      'vscode',
      'windsurf',
      'trae',
      'ollama',
    ];
    const anthropicPriority = [
      'claude',
      'relay_api',
      'api',
    ];
    const codexPriority = [
      'codex',
      'api',
      'relay_api',
    ];
    const priorityListByProtocol = {
      openai: openaiPriority,
      responses: ['relay_api', 'api'],
      anthropic: anthropicPriority,
      codex: codexPriority,
    };
    const priorityIndex = new Map(
      (priorityListByProtocol[hintedProtocol] || [])
        .map((key, index) => [String(key || '').trim(), index])
    );
    const originalIndex = new Map(
      list.map((entry, index) => [String(entry?.key || ''), index])
    );
    const stablePrioritySort = (group) => [...group].sort((a, b) => {
      const aKey = String(a?.key || '');
      const bKey = String(b?.key || '');
      const aPriority = priorityIndex.has(aKey) ? priorityIndex.get(aKey) : Number.MAX_SAFE_INTEGER;
      const bPriority = priorityIndex.has(bKey) ? priorityIndex.get(bKey) : Number.MAX_SAFE_INTEGER;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return (originalIndex.get(aKey) ?? Number.MAX_SAFE_INTEGER)
        - (originalIndex.get(bKey) ?? Number.MAX_SAFE_INTEGER);
    });

    const locked = [];
    const exactMatch = [];
    const protocolCompatible = [];
    const fallback = [];

    for (const entry of list) {
      const adapterKey = String(entry?.key || '').trim();
      if (!adapterKey) {
        fallback.push(entry);
        continue;
      }
      if (lockedKeys.has(adapterKey)) {
        locked.push(entry);
        continue;
      }
      if (!isProtocolSupported(adapterKey, hintedProtocol)) {
        fallback.push(entry);
        continue;
      }
      const resolvedProtocol = getProtocolForAdapter(adapterKey, model, options);
      if (resolvedProtocol === hintedProtocol) {
        exactMatch.push(entry);
      } else {
        protocolCompatible.push(entry);
      }
    }

    return [
      ...locked,
      ...stablePrioritySort(exactMatch),
      ...stablePrioritySort(protocolCompatible),
      ...fallback,
    ];
  },

  /**
   * Cache-economy transparency report (DESIGN-ARCH-047): per-adapter cache hit
   * rate, whether the adapter discloses cache-billing fields, and a verdict
   * (transparent_caching | no_cache_benefit | opaque_suspected_gouging |
   * not_cacheable | insufficient_data). Used to surface relays that enjoy
   * upstream caching but bill full price.
   */
  getCacheEconomyReport() {
    try {
      return require('./cacheEconomyStore').getReport();
    } catch {
      return { adapters: {} };
    }
  },

  getDefaultRouteRecommendation(options = {}) {
    const { ranking, assessments } = this._rankAdaptersForDefaultRoute(options);
    const top = ranking[0] || null;
    if (!top) return null;

    const tuning = _resolveDefaultRouteTuning();
    const degradedAdapters = assessments
      .filter((item) => item && !item.blocked && item.adapter !== top.adapter && item.totalPenalty >= tuning.summaryPenaltyFloor)
      .sort((a, b) => b.totalPenalty - a.totalPenalty)
      .map((item) => ({
        adapter: item.adapter,
        type: item.type,
        name: item.name,
        score: item.score,
        totalPenalty: item.totalPenalty,
        reasons: item.reasons.map((reason) => reason.text),
      }));
    const primaryDegraded = degradedAdapters[0] || null;
    const summary = primaryDegraded
      ? `${top.name} (${top.adapter}) 当前更稳；${primaryDegraded.name} ${primaryDegraded.reasons[0]}，默认降级为次级兜底`
      : `${top.name} (${top.adapter}) 当前为默认稳定通道`;

    return {
      adapter: top.adapter,
      type: top.type,
      name: top.name,
      score: top.score,
      totalPenalty: top.totalPenalty,
      summary,
      reasons: top.reasons.map((reason) => reason.text),
      degradedAdapters,
      ranking: ranking.map((item) => ({
        adapter: item.adapter,
        type: item.type,
        name: item.name,
        score: item.score,
        totalPenalty: item.totalPenalty,
        healthyDefault: item.healthyDefault,
        reasons: item.reasons.map((reason) => reason.text),
      })),
    };
  },

  async _maybePromoteProcessFailoverAdapters(orderedAdapters, options = {}) {
    const list = Array.isArray(orderedAdapters) ? orderedAdapters : [];
    const preferredAdapter = String(options.preferredAdapter || '').trim();
    const strictPreferredOnly = !!options.strictPreferredOnly;
    const emitStatus = typeof options.emitStatus === 'function' ? options.emitStatus : () => {};
    const featureEnabled = String(
      process.env.GATEWAY_PROCESS_FAILOVER_PARALLEL_ENABLED || 'true'
    ).toLowerCase() !== 'false';

    if (!featureEnabled || strictPreferredOnly) return list;
    if (!preferredAdapter || preferredAdapter === 'auto') return list;
    if (!_isProcessSensitiveAdapter(preferredAdapter)) return list;

    const recentPreferredFail = await this._getRecentFastFail(preferredAdapter);
    const hasRecentProcessFailure = !!(recentPreferredFail && recentPreferredFail.errorType === 'process');
    const preferredFailureCount = Number(this._adapterFailures[preferredAdapter] || 0);
    if (!hasRecentProcessFailure && preferredFailureCount < 1) return list;
    if (recentPreferredFail) {
      this._maybeScheduleCooldownSelfHealProbe(preferredAdapter, recentPreferredFail, {
        emitStatus,
        adapterDisplayName: preferredAdapter,
        source: 'preferred_parallel_failover',
      });
    }

    const candidateKeys = _parseProcessFailoverCandidates(
      process.env.GATEWAY_PROCESS_FAILOVER_CANDIDATES || ''
    );
    if (candidateKeys.length === 0) return list;

    const byLowerKey = new Map(
      list.map(entry => [String(entry?.key || '').toLowerCase(), entry])
    );
    const candidateEntries = candidateKeys
      .map(key => byLowerKey.get(String(key || '').toLowerCase()))
      .filter(entry => entry && entry.enabled && entry.key !== preferredAdapter);
    if (candidateEntries.length === 0) return list;

    emitStatus(`检测到 ${preferredAdapter} 通道近期异常，正在并行探测远端兜底通道...`);

    const probeResults = await Promise.all(candidateEntries.map(async (entry) => {
      const statusName = (() => {
        try { return entry.adapter.getStatus().name || entry.key; } catch { return entry.key; }
      })();
      const recentFail = await this._getRecentFastFail(entry.key);
      if (recentFail) {
        this._maybeScheduleCooldownSelfHealProbe(entry.key, recentFail, {
          emitStatus,
          adapterDisplayName: statusName,
          source: 'candidate_parallel_failover',
        });
        return {
          key: entry.key,
          name: statusName,
          available: false,
          reason: `cooldown:${recentFail.errorType || 'unknown'}`,
        };
      }
      try {
        const available = entry.adapter.detectAsync
          ? await entry.adapter.detectAsync(true)
          : !!entry.adapter.detect(true);
        entry.available = !!available;
        return {
          key: entry.key,
          name: statusName,
          available: !!available,
          reason: available ? 'ok' : 'unavailable',
        };
      } catch {
        entry.available = false;
        return {
          key: entry.key,
          name: statusName,
          available: false,
          reason: 'detect_error',
        };
      }
    }));

    const availableByLower = new Map(
      probeResults
        .filter(item => item.available)
        .map(item => [String(item.key || '').toLowerCase(), item])
    );
    if (availableByLower.size === 0) {
      emitStatus('并行探测完成：未发现可用远端兜底通道');
      return list;
    }

    const promotedEntries = candidateKeys
      .map(key => byLowerKey.get(String(key || '').toLowerCase()))
      .filter(entry => entry && availableByLower.has(String(entry.key || '').toLowerCase()));
    if (promotedEntries.length === 0) return list;

    emitStatus(`并行探测完成：优先兜底通道 ${promotedEntries.map(e => {
      try { return e.adapter.getStatus().name || e.key; } catch { return e.key; }
    }).join(', ')}`);

    const promotedSet = new Set(promotedEntries.map(entry => entry.key));
    const preferredEntries = list.filter(entry => entry.key === preferredAdapter);
    const restEntries = list.filter(entry => entry.key !== preferredAdapter && !promotedSet.has(entry.key));
    return [
      ...preferredEntries,
      ...promotedEntries,
      ...restEntries,
    ];
  },

  async _generateWithAdapterIsolation(entry, prompt, adapterOptions = {}) {
    const { beforeRun, afterRun, onRunError, ...generateOptionsRaw } = adapterOptions || {};
    const injectedProtocolSystem = _injectKhyProtocolSystem(generateOptionsRaw.system || '');
    const generateOptions = {
      ...generateOptionsRaw,
      system: _injectKhyExpectedLanguageSystem(injectedProtocolSystem, prompt, generateOptionsRaw, entry?.key || ''),
    };
    // Auto-resolve protocol for this adapter + model combination
    try {
      const { getProtocolForAdapter } = require('./adapters/_protocolRegistry');
      generateOptions._resolvedProtocol = getProtocolForAdapter(
        entry.key, generateOptions.model || '', generateOptions
      );
    } catch { /* protocol registry unavailable — adapters use their defaults */ }
    const effectivePrompt = _injectKhyProtocolPrompt(prompt, generateOptions);
    const shouldEmitPromptDebug = String(process.env.KHY_GATEWAY_DEBUG_PROMPT || '').trim() === '1';
    const shouldWritePromptDebugFile = !!String(process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE || '').trim();
    if (shouldEmitPromptDebug || shouldWritePromptDebugFile) {
      try {
        const summary = _buildKhyProtocolDebugSummary(effectivePrompt, generateOptions);
        if (shouldEmitPromptDebug && typeof generateOptions.onChunk === 'function') {
          generateOptions.onChunk({
            type: 'status',
            text: `[debug] KHY prompt injection: system=${summary.systemLength} chars, prompt=${summary.promptLength} chars | system="${summary.systemPreview}" | prompt="${summary.promptPreview}"`,
          });
        }
        if (shouldWritePromptDebugFile) {
          _appendKhyProtocolDebugLog(entry, effectivePrompt, generateOptions, summary);
        }
      } catch { /* best effort */ }
    }
    const run = async () => {
      if (typeof beforeRun === 'function') {
        const precheck = await beforeRun();
        if (precheck && precheck.skip) {
          return {
            success: false,
            error: precheck.error || 'adapter skipped',
            errorType: precheck.errorType || 'unavailable',
            statusCode: 0,
            provider: entry.adapter.getStatus().name,
            adapter: entry.key,
            gatewaySkipFastFail: true,
            attempts: [],
          };
        }
      }
      try {
        const output = await entry.adapter.generate(effectivePrompt, generateOptions);
        if (typeof afterRun === 'function') {
          try { await afterRun(output); } catch { /* best effort */ }
        }
        return output;
      } catch (err) {
        if (typeof onRunError === 'function') {
          try { await onRunError(err); } catch { /* best effort */ }
        }
        throw err;
      }
    };
    if (!this._shouldSerializeAdapter(entry.key)) {
      return run();
    }

    const queueKey = `adapter:${entry.key}`;
    const pendingBefore = typeof this._adapterQueue.getPending === 'function'
      ? this._adapterQueue.getPending(queueKey)
      : 0;
    const statusName = (() => {
      try {
        return entry.adapter.getStatus().name || entry.key;
      } catch {
        return entry.key;
      }
    })();
    const emitQueueStatus = (text) => {
      if (!text || typeof adapterOptions.onChunk !== 'function') return;
      try {
        adapterOptions.onChunk({ type: 'status', text: String(text) });
      } catch { /* best effort */ }
    };

    let queuePulse = null;
    let queuedAt = 0;
    if (pendingBefore > 0) {
      queuedAt = Date.now();
      emitQueueStatus(`Adapter queueing: ${statusName} (${pendingBefore + 1} in line)`);
      const pulseMs = Math.max(
        1500,
        parseInt(process.env.GATEWAY_QUEUE_STATUS_PULSE_MS || '3000', 10) || 3000
      );
      let lastNoticeSec = -1;
      queuePulse = setInterval(() => {
        const waitedSec = Math.floor((Date.now() - queuedAt) / 1000);
        if (waitedSec <= lastNoticeSec) return;
        lastNoticeSec = waitedSec;
        emitQueueStatus(`Waiting for adapter slot: ${statusName} ${waitedSec}s`);
      }, pulseMs);
      queuePulse.unref?.();
    }

    const runWhenReady = async () => {
      if (queuePulse) {
        clearInterval(queuePulse);
        queuePulse = null;
        const waitedSec = Math.max(1, Math.round((Date.now() - queuedAt) / 1000));
        emitQueueStatus(`Adapter slot acquired: ${statusName} (+${waitedSec}s)`);
      }
      return run();
    };

    let queueResult;
    try {
      queueResult = await this._adapterQueue(queueKey, runWhenReady);
    } finally {
      if (queuePulse) {
        clearInterval(queuePulse);
        queuePulse = null;
      }
    }

    if (typeof queueResult === 'undefined') {
      throw new Error(`adapter ${entry.key} queue timeout`);
    }
    return queueResult;
  },

  /**
   * Force reconnect a specific adapter — clears circuit breaker, failure cache,
   * re-enables it, and re-detects availability.
   * Use after account switch, environment cleanup, or machine code update.
   * @param {string} adapterKey
   * @returns {Promise<{success: boolean, adapter: string, available: boolean, error?: string}>}
   */
  async forceReconnect(adapterKey) {
    const entry = this._adapters.find(a => a.key === adapterKey);
    if (!entry) {
      return { success: false, adapter: adapterKey, available: false, error: 'Adapter not found' };
    }

    // Clear all failure state
    await this._clearAdapterFailure(adapterKey);
    entry.enabled = true;

    // Call adapter's manualRefresh if available (e.g. kiroAdapter clears token cache)
    if (typeof entry.adapter.manualRefresh === 'function') {
      try { entry.adapter.manualRefresh(); } catch { /* ignore */ }
    }

    // Re-detect
    try {
      if (entry.adapter.detectAsync) {
        entry.available = await entry.adapter.detectAsync(true);
      } else {
        entry.available = entry.adapter.detect(true);
      }
    } catch {
      entry.available = false;
    }

    return {
      success: entry.available,
      adapter: adapterKey,
      available: entry.available,
    };
  },

  /**
   * Re-detect all adapters (called periodically or after failures).
   * Useful when IDEs update and new auth tokens become available.
   */
  async refreshAdapters() {
    // Re-detect independent adapters concurrently rather than serially ([MGMT-RPT-020] REQ-2026-009).
    await Promise.all(this._adapters.map(async (entry) => {
      if (!entry.enabled) return;
      try {
        if (entry.adapter.detectAsync) {
          entry.available = await entry.adapter.detectAsync(true);
        } else {
          entry.available = entry.adapter.detect(true); // force refresh
        }
      } catch {
        entry.available = false;
      }
    }));
    this._lastRefreshTime = Date.now();
    // Reconcile channel lifecycle after every (re)detection: a channel switch
    // routes through here, so deprecated channels are quiesced the moment the
    // user picks a different one (not on the next background tick).
    this._syncChannelLifecycle();
  },

  /**
   * Anti-ban: enforce minimum request interval with jitter (per adapter).
   * Uses token bucket algorithm — max 10 requests per minute per adapter.
   * Skips rate limiting for local adapters (e.g. Ollama).
   * @param {string} adapterKey
   * @param {object} [options] - { onWait: (key, ms) => void }
   */
  async _enforceRateLimit(adapterKey, options = {}) {
    // Skip rate limiting for local adapters
    if (this._localAdapters.has(adapterKey)) return;
    const runtimeIsKhy = String(process.env.KHY_RUNTIME_MODE || '').trim().toLowerCase() === 'khy';
    const fastInteractive = !!options.fastInteractive
      || (runtimeIsKhy && String(process.env.KHY_GATEWAY_FAST_RATE_LIMIT || 'true').toLowerCase() !== 'false');
    const rateLimitJitterMaxMs = _parseMs(
      options.rateLimitJitterMaxMs
      ?? process.env.GATEWAY_RATE_LIMIT_JITTER_MAX_MS
      ?? (fastInteractive ? '600' : '2000'),
      fastInteractive ? 600 : 2000,
      0
    );
    const maxRateLimitWaitMs = _parseMs(
      options.maxRateLimitWaitMs
      ?? process.env.GATEWAY_RATE_LIMIT_MAX_WAIT_MS
      ?? (fastInteractive ? '2500' : '120000'),
      fastInteractive ? 2500 : 120000,
      100
    );

    // Use distributed rate limiter (Redis or in-memory fallback)
    const result = await this._distributedLimiter.consume(adapterKey);

    if (!result.allowed) {
      // Rate limited — wait until window reopens + random jitter
      const waitMs = Number(result.retryAfterMs || 0) + Math.random() * rateLimitJitterMaxMs;
      const actualWait = Math.max(80, Math.min(maxRateLimitWaitMs, waitMs));
      if (actualWait > 2000 && options.onWait) {
        options.onWait(adapterKey, actualWait);
      }
      await new Promise(r => setTimeout(r, actualWait));
    }

    // Per-adapter exponential backoff on consecutive failures (capped at 10s for fast failover)
    const failures = this._adapterFailures[adapterKey] || 0;
    if (failures > 0) {
      const attemptIndex = Math.max(0, parseInt(options.attemptIndex, 10) || 0);
      const allowFirstAttemptBackoff = String(
        process.env.GATEWAY_FAILURE_BACKOFF_ON_FIRST_ATTEMPT || 'false'
      ).toLowerCase() === 'true';
      if (attemptIndex === 0 && !allowFirstAttemptBackoff) return;
      const baseFailureBackoffMs = _parseMs(
        options.baseFailureBackoffMs
        ?? process.env.GATEWAY_FAILURE_BACKOFF_BASE_MS
        ?? (fastInteractive ? '250' : '1000'),
        fastInteractive ? 250 : 1000,
        50
      );
      const maxFailureBackoffMs = _parseMs(
        options.maxFailureBackoffMs
        ?? process.env.GATEWAY_FAILURE_BACKOFF_CAP_MS
        ?? (fastInteractive ? '1800' : '10000'),
        fastInteractive ? 1800 : 10000,
        baseFailureBackoffMs
      );
      const backoffMs = require('../circuitBreaker').computeBackoffMs({
        baseMs: baseFailureBackoffMs,
        attempt: failures - 1,
        maxMs: maxFailureBackoffMs,
      });
      const jitter = Math.random() * backoffMs * 0.3;
      const totalWait = backoffMs + jitter;
      if (totalWait > 2000 && options.onWait) {
        options.onWait(adapterKey, totalWait);
      }
      await new Promise(r => setTimeout(r, totalWait));
    }
  },

  /**
   * Initialize the gateway: detect available adapters.
   * Safe to call multiple times (idempotent after first, race-safe).
   */
  async init() {
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit().catch((err) => {
      this._initPromise = null;
      throw err;
    });
    return this._initPromise;
  },

  async _doInit() {

    // Seed the built-in SenseNova channel idempotently so it is present even
    // when the user never ran `khy init` (fresh machine / first launch).
    try {
      require('../customProviderRegistrar').ensureBuiltinSenseNova();
    } catch { /* best effort — never block gateway init */ }

    // Seed the qoder reverse-proxy channels (OpenAI + Anthropic lines) only when
    // the user has opted in (QODER_PROXY_ENDPOINT/API_KEY or KHY_QODER_PROXY);
    // otherwise this is an internal no-op (avoids dead ECONNREFUSED entries).
    try {
      require('../customProviderRegistrar').ensureBuiltinQoder();
    } catch { /* best effort — never block gateway init */ }

    // Initialize Redis-backed health store (gracefully degrades to memory)
    await this._healthStore.init();

    // Periodic cleanup to prevent memory leaks from stale adapter data
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this._cleanupInterval = setInterval(() => this._cleanupStaleData(), 5 * 60 * 1000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
    this._startCooldownSelfHealTicker();

    // Respect environment toggles
    if (process.env.GATEWAY_CLI_ENABLED === 'false') {
      this._adapters.find(a => a.key === 'cli').enabled = false;
    }
    if (process.env.GATEWAY_OLLAMA_ENABLED === 'false') {
      this._adapters.find(a => a.key === 'ollama').enabled = false;
    }
    if (process.env.GATEWAY_RELAY_ENABLED === 'false') {
      this._adapters.find(a => a.key === 'relay').enabled = false;
    }

    // Respect IDE adapter toggles
    for (const ideKey of ['kiro', 'cursor', 'trae', 'claude', 'codex', 'windsurf', 'vscode', 'warp', 'cursor2api']) {
      const envKey = `GATEWAY_${ideKey.toUpperCase()}_ENABLED`;
      if (process.env[envKey] === 'false') {
        const entry = this._adapters.find(a => a.key === ideKey);
        if (entry) entry.enabled = false;
      }
    }

    // Run detection on all enabled adapters IN PARALLEL with timeout protection
    const INIT_TIMEOUT_MS = _parseMs(process.env.GATEWAY_INIT_TIMEOUT_MS || '15000', 15000, 3000);
    const detectionJobs = this._adapters
      .filter(e => e.enabled)
      .map(async (entry) => {
        let timerId = null;
        try {
          const detect = entry.adapter.detectAsync
            ? entry.adapter.detectAsync(true)
            : Promise.resolve(entry.adapter.detect(true));
          const timer = new Promise((_, rej) => {
            timerId = setTimeout(() => rej(new Error('detect timeout')), INIT_TIMEOUT_MS);
          });
          entry.available = await Promise.race([detect, timer]);
        } catch {
          entry.available = false;
        } finally {
          if (timerId) clearTimeout(timerId);
        }
      });
    await Promise.all(detectionJobs);

    // Start background model refresh timer (default 5 min)
    const MODEL_REFRESH_INTERVAL_MS = Math.max(60000,
      parseInt(process.env.MODEL_REFRESH_INTERVAL_MS || '300000', 10) || 300000);
    if (this._modelRefreshTimer) clearInterval(this._modelRefreshTimer);
    this._modelRefreshTimer = setInterval(() => this._refreshModelsBackground(), MODEL_REFRESH_INTERVAL_MS);
    if (this._modelRefreshTimer.unref) this._modelRefreshTimer.unref();

    this._initialized = true;
    this._initPromise = null;

    // Invalidate selfProfile cache so dynamic adapter counts refresh
    try { require('../selfProfile').invalidateStaticCache(); } catch { /* optional */ }

    // Start channel health broadcaster with detected adapter keys
    const adapterKeys = this._adapters.filter(a => a.enabled).map(a => a.key);
    this._healthBroadcaster.setAdapterKeys(adapterKeys);
    this._healthBroadcaster.start();

    // Quiesce deprecated channels immediately based on the current preference,
    // so a non-active channel never starts its background work in the first place.
    this._syncChannelLifecycle();
  },

  /**
   * Background model list refresh — keeps adapter model caches up to date.
   * Runs periodically so CLI `/model` always shows latest models.
   *
   * Channel-lifecycle aware: when the user has explicitly selected a channel
   * (GATEWAY_PREFERRED_ADAPTER set to a concrete adapter), the deprecated
   * channels must not perform non-essential background network work (token
   * refresh, model fetch). Only the active channel is refreshed here; the others
   * are quiesced via the lifecycle hook. In auto mode (no explicit preference)
   * every channel is refreshed as before. The active channel is never skipped
   * (hard constraint: never starve the channel actually in use).
   */
  async _refreshModelsBackground() {
    this._syncChannelLifecycle();
    const activeKey = this._resolveActiveChannelKey();
    // Refresh independent adapter model caches concurrently ([MGMT-RPT-020] REQ-2026-009).
    await Promise.all(this._adapters.map(async (entry) => {
      if (!entry.enabled || !entry.available) return;
      if (typeof entry.adapter.listModels !== 'function') return;
      // Deprecated channel under an explicit selection: skip its background
      // network work entirely (zombie-task suppression).
      if (activeKey && entry.key !== activeKey) return;
      try {
        const models = await entry.adapter.listModels();
        // Collect context window metadata from adapters that report it
        if (Array.isArray(models)) {
          for (const m of models) {
            const cw = m.contextWindow || m.context_length || m.context_window;
            if (cw && cw > 0 && m.id) {
              this._contextWindowCache.set(m.id, cw);
            }
          }
        }
      } catch { /* ignore */ }
    }));
  },

  /**
   * Resolve the currently active channel key from the explicit preference, or
   * null when in auto mode (no single channel is "the" active one).
   *
   * "auto" / empty → null (every channel may be tried; none is deprecated).
   * A concrete adapter key → that channel is active, all others are deprecated.
   */
  _resolveActiveChannelKey() {
    const raw = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (lower === 'auto') return null;
    if (lower === 'localllm') return 'localLLM';
    const matched = this._adapters.find(a => String(a.key || '').toLowerCase() === lower);
    return matched ? matched.key : null;
  },

  /**
   * Push the active/deprecated state down to every adapter that opts into the
   * channel lifecycle (duck-typed setChannelActive). This is how a deprecated
   * channel learns to (a) stop non-essential background work and (b) stop
   * escalating its internal anomalies to the UI. Adapters without the hook are
   * untouched (non-invasive). In auto mode every channel is treated as active so
   * nothing is wrongly quiesced.
   */
  _syncChannelLifecycle() {
    const activeKey = this._resolveActiveChannelKey();
    for (const entry of this._adapters) {
      const fn = entry.adapter && entry.adapter.setChannelActive;
      if (typeof fn !== 'function') continue;
      const active = !activeKey || entry.key === activeKey;
      try { fn.call(entry.adapter, active); } catch { /* lifecycle hook must never break routing */ }
    }
  },

  /**
   * Public channel-switch entry point: record the new preference and immediately
   * reconcile the lifecycle so the deprecated channel quiesces at once instead of
   * waiting for the next background tick. Safe to call before init() (the env is
   * set and the lifecycle re-runs at init time anyway).
   */
  setActiveChannel(key) {
    if (key != null && String(key).trim()) {
      process.env.GATEWAY_PREFERRED_ADAPTER = String(key).trim();
    }
    this._syncChannelLifecycle();
  },

  /**
   * Set the context window size for a model (called after generate with real data).
   */
  setModelContextWindow(modelId, contextWindow) {
    if (modelId && contextWindow > 0) {
      this._contextWindowCache.set(modelId, contextWindow);
    }
  },

  /**
   * Get the context window for a model.
   * Priority: adapter-reported cache → env override → 0 (unknown).
   * For unknown models, triggers async background refresh so next call has real data.
   */
  getModelContextWindow(modelId) {
    if (!modelId) return 0;
    // 1. Check adapter-reported cache (real data from API or model metadata)
    const cached = this._contextWindowCache.get(modelId);
    if (cached) return cached;
    // 2. Partial match in cache (model IDs often have version suffixes)
    const lower = modelId.toLowerCase();
    for (const [key, val] of this._contextWindowCache) {
      if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) return val;
    }
    // 3. Env override
    const envVal = parseInt(process.env.KHY_CONTEXT_WINDOW, 10);
    if (envVal > 0) return envVal;
    // 4. Trigger background refresh — next call will have real data
    this._resolveContextWindowAsync(modelId);
    return 0;
  },

  /**
   * Background: query adapters for a model's context window and cache it.
   * Non-blocking, fire-and-forget. Deduplicates concurrent calls for the same model.
   */
  _resolveContextWindowAsync(modelId) {
    if (!this._contextWindowPending) this._contextWindowPending = new Set();
    if (this._contextWindowPending.has(modelId)) return;
    this._contextWindowPending.add(modelId);
    (async () => {
      try {
        for (const entry of this._adapters) {
          if (!entry.enabled || !entry.available) continue;
          if (typeof entry.adapter.listModels !== 'function') continue;
          try {
            const models = await entry.adapter.listModels();
            if (!Array.isArray(models)) continue;
            for (const m of models) {
              const cw = m.contextWindow || m.context_length || m.context_window;
              if (cw && cw > 0 && m.id) {
                this._contextWindowCache.set(m.id, cw);
              }
            }
            // Check if we found it
            const found = this.getModelContextWindow(modelId);
            if (found > 0) break;
          } catch { /* adapter unavailable */ }
        }
      } catch { /* non-critical */ }
      finally { this._contextWindowPending.delete(modelId); }
    })();
  },
};

module.exports = { AIGatewayRoutingMethods, setAiGatewayRoutingMethodsDeps };
