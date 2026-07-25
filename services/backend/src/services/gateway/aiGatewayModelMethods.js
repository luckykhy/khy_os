'use strict';

/**
 * Model / adapter-accessor / verification methods (extracted from services/gateway/aiGateway.js).
 *
 * A cohesive cluster of AIGateway instance methods covering: auto model selection, sub-model generation,
 * local-adapter helpers, status + adapter accessors (getStatus / getAdapter / getActiveAdapter /
 * getRelayAdapter / getFirstAvailableAdapter …), channel health snapshot + reset, failover-order
 * accessors, per-adapter generation / model listing, model + tool-calling verification (with background
 * probe), destroy, and testAdapter.
 *
 * Relocated verbatim (byte-identical bodies) into a same-directory sibling and mixed back onto
 * AIGateway.prototype via Object.assign in the host. Object-shorthand method syntax is identical to
 * class-method syntax, so the only transform was appending a comma after each method close; `this` binds
 * at call time on the prototype, keeping bodies byte-identical. Stable module singletons the methods
 * reference (path / child_process.spawn / MODELS / retry helpers / diagnostics / webRelayAdapter /
 * modelCuration) are re-required here by the same names (require returns the cached singleton, so the
 * bodies stay byte-identical); the host-internal helpers/consts (safeKillChildProc, the fast-fail / ms
 * parsers, khy-protocol risk, result-error extractor, preferred-model resolver, adapter-source labels,
 * codex probe prompt) are injected via setAiGatewayModelMethodsDeps to avoid a require cycle back into
 * aiGateway.js. The methods perform IO (adapter calls, spawning probes, network), so this is NOT a pure
 * zero-IO leaf.
 */

const path = require('path');
const { spawn } = require('child_process');
const { PRIMARY: MODELS } = require('../../constants/models');
const { retryWithBackoff, isRetryableError, parseRetryAfter } = require('../retryWithBackoff');
const { diagnostics } = require('../diagnosticEvents');
const webRelayAdapter = require('./adapters/webRelayAdapter');
const modelCuration = require('./modelCuration');

// Host-internal helpers/consts injected once at host load (see setter). The 6 functions are hoisted
// declarations on the host; the value deps (adapter-source labels, codex probe prompt) are set-once
// consts. All value deps use `!== undefined` guards.
let safeKillChildProc = null;
let _shouldUseFastFail = null;
let _parseMs = null;
let _getKhyProtocolPriorityRisk = null;
let _extractResultErrorMessage = null;
let resolvePreferredModelForAdapter = null;
let _ADAPTER_SOURCE_LABELS = null;
let CODEX_GENERATION_PROBE_PROMPT = null;

function setAiGatewayModelMethodsDeps(deps = {}) {
  if (typeof deps.safeKillChildProc === 'function') safeKillChildProc = deps.safeKillChildProc;
  if (typeof deps._shouldUseFastFail === 'function') _shouldUseFastFail = deps._shouldUseFastFail;
  if (typeof deps._parseMs === 'function') _parseMs = deps._parseMs;
  if (typeof deps._getKhyProtocolPriorityRisk === 'function') _getKhyProtocolPriorityRisk = deps._getKhyProtocolPriorityRisk;
  if (typeof deps._extractResultErrorMessage === 'function') _extractResultErrorMessage = deps._extractResultErrorMessage;
  if (typeof deps.resolvePreferredModelForAdapter === 'function') resolvePreferredModelForAdapter = deps.resolvePreferredModelForAdapter;
  if (deps._ADAPTER_SOURCE_LABELS !== undefined) _ADAPTER_SOURCE_LABELS = deps._ADAPTER_SOURCE_LABELS;
  if (deps.CODEX_GENERATION_PROBE_PROMPT !== undefined) CODEX_GENERATION_PROBE_PROMPT = deps.CODEX_GENERATION_PROBE_PROMPT;
}

const AIGatewayModelMethods = {
  /**
   * Auto-select the best available model.
   * Priority: user preference > habit > capability score > priority order.
   * @param {string} [taskType] - 'conversation', 'analysis', 'code', 'reasoning'
   * @returns {{ adapter: string, model: string|null, reason: string }}
   */
  autoSelectModel(taskType = 'conversation', options = {}) {
    if (!this._initialized) {
      // Quick sync check
      for (const entry of this._adapters) {
        if (entry.enabled && entry.adapter.detect()) {
          entry.available = true;
        }
      }
    }

    const healthRankedAdapters = this._orderAdaptersByDefaultRoutePreference(this._adapters, {
      ...options,
      taskType,
      detectIfNeeded: !this._initialized,
    });
    const healthRankMap = new Map(
      healthRankedAdapters.map((entry, index) => [String(entry?.key || ''), index])
    );
    const sortByHealthRoute = (entries = []) => [...entries].sort((a, b) => {
      const aPos = healthRankMap.has(String(a?.key || ''))
        ? healthRankMap.get(String(a?.key || ''))
        : Number.MAX_SAFE_INTEGER;
      const bPos = healthRankMap.has(String(b?.key || ''))
        ? healthRankMap.get(String(b?.key || ''))
        : Number.MAX_SAFE_INTEGER;
      if (aPos !== bPos) return aPos - bPos;
      return Number(a?.priority || 0) - Number(b?.priority || 0);
    });

    // 0. Protocol-aware pre-filter: if model name hints at a protocol,
    //    prefer adapters that support it
    let protocolFilteredAdapters = null;
    if (options.model) {
      try {
        const { inferProtocolFromModel, isProtocolSupported } = require('./adapters/_protocolRegistry');
        const hintedProtocol = inferProtocolFromModel(options.model);
        if (hintedProtocol) {
          const filtered = healthRankedAdapters.filter(
            a => a.enabled && a.available && isProtocolSupported(a.key, hintedProtocol)
          );
          if (filtered.length > 0) protocolFilteredAdapters = filtered;
        }
      } catch { /* protocol registry unavailable */ }
    }

    // 1. Check user preference
    const preferred = process.env.GATEWAY_PREFERRED_ADAPTER;
    if (preferred && preferred !== 'auto') {
      const entry = this._adapters.find(a => a.key === preferred && a.enabled);
      if (entry && (entry.available || entry.adapter.detect())) {
        return {
          adapter: preferred,
          model: process.env.GATEWAY_PREFERRED_MODEL || null,
          reason: 'user_preference',
        };
      }
    }

    // 2. Check habit-based preference
    try {
      const { getPreferredModel } = require('../usageHabitService');
      const habit = getPreferredModel(taskType);
      if (habit && habit.adapter) {
        const entry = this._adapters.find(a => a.key === habit.adapter && a.enabled);
        const assessment = this._assessDefaultRouteCandidate(entry, {
          ...options,
          taskType,
          detectIfNeeded: !this._initialized,
        });
        if (entry && entry.available && assessment && assessment.healthyDefault) {
          return { adapter: habit.adapter, model: habit.model || null, reason: 'learned_habit' };
        }
      }
    } catch { /* best effort */ }

    // 3. Capability-based matching via registry
    try {
      const { TASK_REQUIREMENTS } = require('./capabilityRegistry');
      const reqs = TASK_REQUIREMENTS[taskType];
      if (reqs && this._capabilityRegistry) {
        const ranked = this._capabilityRegistry.bestAdaptersFor(reqs, { onlyAvailable: false, limit: 10 });
        for (const candidate of ranked) {
          const entry = this._adapters.find(a => a.key === candidate.key && a.enabled && a.available);
          if (entry) {
            return { adapter: candidate.key, model: null, reason: `capability_match_${taskType}` };
          }
        }
      }
    } catch { /* capability registry not available, use legacy fallback */ }

    // 3b. Legacy fallback: static task preferences
    const TASK_PREFERENCES = {
      reasoning: ['api', 'claude', 'cursor', 'codex', 'ollama'],
      code: ['api', 'claude', 'cursor', 'kiro', 'codex'],
      analysis: ['api', 'claude', 'cursor', 'ollama', 'windsurf', 'warp'],
      conversation: null,
    };
    const taskOrder = TASK_PREFERENCES[taskType];
    if (taskOrder) {
      const searchSet = protocolFilteredAdapters || healthRankedAdapters;
      for (const key of taskOrder) {
        const entry = searchSet.find(a => a.key === key && a.enabled && a.available);
        if (entry) {
          return { adapter: key, model: null, reason: `best_for_${taskType}` };
        }
      }
    }

    // 4. Fallback: first available by priority (protocol-filtered if applicable)
    const fallbackSet = protocolFilteredAdapters || healthRankedAdapters;
    for (const entry of fallbackSet) {
      if (!entry.enabled || !entry.available) continue;
      if (entry.key === 'relay') continue; // relay is last resort
      return { adapter: entry.key, model: null, reason: 'priority_order' };
    }

    // 4b. If protocol filter was too strict, fall back to all adapters
    if (protocolFilteredAdapters) {
      for (const entry of sortByHealthRoute(this._adapters)) {
        if (!entry.enabled || !entry.available) continue;
        if (entry.key === 'relay') continue;
        return { adapter: entry.key, model: null, reason: 'priority_order_no_protocol_match' };
      }
    }

    // 5. Relay as absolute fallback
    return { adapter: 'relay', model: null, reason: 'fallback' };
  },

  /**
   * Generate with a specific sub-model (for delegation from main model).
   * @param {string} prompt
   * @param {string} adapterKey - specific adapter to use
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async generateWithSubModel(prompt, adapterKey, options = {}) {
    if (!this._initialized) await this.init();

    const entry = this._adapters.find(a => a.key === adapterKey && a.enabled);
    if (!entry || (!entry.available && !options.forceAdapter)) {
      return {
        success: false,
        content: `Sub-model adapter "${adapterKey}" is not available.`,
        provider: 'none',
        adapter: adapterKey,
        attempts: [{ provider: adapterKey, success: false, error: 'not_available' }],
      };
    }

    try {
      const result = await retryWithBackoff(
        () => this._generateWithAdapterIsolation(entry, prompt, options),
        {
          attempts: 2,
          minDelayMs: 1000,
          maxDelayMs: 10000,
          label: `submodel:${adapterKey}`,
          shouldRetry: (err) => isRetryableError(err),
          retryAfterMs: (err) => parseRetryAfter(err),
        }
      );
      return result;
    } catch (err) {
      return {
        success: false,
        content: err.message,
        provider: entry.adapter.getStatus().name,
        adapter: adapterKey,
        attempts: [{ provider: adapterKey, success: false, error: err.message }],
      };
    }
  },

  /**
   * Get status of all adapters (for display).
   */
  /**
   * Whether an adapter key refers to a locally-running model runtime.
   * Single source of truth, backed by this._localAdapters.
   */
  isLocalAdapter(key) {
    return this._localAdapters.has(String(key || ''));
  },

  /**
   * First enabled + available locally-running model adapter, in priority order
   * (ollama before localLLM). Returns the adapter key, or null when no local
   * model is running. Used by forced local mode (/local) to prefer an actual
   * local LLM over the deterministic brain when one is loaded.
   * @returns {string|null}
   */
  getAvailableLocalAdapter() {
    if (!Array.isArray(this._adapters)) return null;
    const locals = this._adapters
      .filter(e => e.enabled && e.available && this.isLocalAdapter(e.key))
      .sort((a, b) => (a.priority || 0) - (b.priority || 0));
    return locals.length ? locals[0].key : null;
  },

  /**
   * Classify an adapter as local vs cloud and return a human-readable source
   * label (e.g. "本地 · Ollama", "云端 · Anthropic Claude"). Consumed by the
   * model-listing endpoint so the UI can show provenance.
   * @param {string} key adapter key
   * @returns {{ kind: 'local'|'cloud', source: string }}
   */
  getAdapterOrigin(key) {
    const k = String(key || '');
    const kind = this.isLocalAdapter(k) ? 'local' : 'cloud';
    const source = _ADAPTER_SOURCE_LABELS[k] || (kind === 'local' ? '本地模型' : '云端模型');
    return { kind, source };
  },

  getStatus() {
    return this._adapters.map(entry => {
      const status = entry.adapter.getStatus();
      const cached = this._adapterLastError[entry.key] || null;
      let recent = null;
      if (cached) {
        const fallbackCooldownMs = _parseMs(process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS || '30000', 30000, 5000);
        const cooldownMs = _parseMs(cached.cooldownMs, fallbackCooldownMs, 5000);
        const elapsedMs = Date.now() - Number(cached.at || 0);
        if (elapsedMs <= cooldownMs && (cached.circuitOpen || _shouldUseFastFail(cached.errorType))) {
          recent = {
            ...cached,
            cooldownMs,
            remainingMs: Math.max(0, cooldownMs - elapsedMs),
          };
        }
      }
      const lastError = cached ? {
        at: cached.at,
        errorType: cached.errorType,
        error: cached.error,
        coolingDown: !!recent,
        cooldownMs: cached.cooldownMs || null,
        remainingMs: recent?.remainingMs || 0,
      } : null;
      const cooldownHint = recent
        ? ` · cooldown ${Math.max(1, Math.ceil((recent.remainingMs || 0) / 1000))}s`
        : '';
      const detailWithFailure = lastError
        ? `${status.detail || ''}${status.detail ? ' · ' : ''}last failure [${lastError.errorType}]: ${lastError.error}${cooldownHint}`
        : status.detail;
      return {
        ...status,
        detail: detailWithFailure,
        lastError,
        enabled: entry.enabled,
        priority: entry.priority,
      };
    });
  },

  getKhyProtocolPriorityRisk(adapterLike = null) {
    return _getKhyProtocolPriorityRisk(adapterLike);
  },

  /**
   * Get the key of the first available adapter (e.g. 'localLLM', 'ollama', 'api').
   * Used by ai.js to determine timeout strategy before generation starts.
   */
  getFirstAvailableAdapter() {
    const preferred = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase();
    if (preferred && preferred !== 'auto') {
      const entry = this._adapters.find(a => a.key === preferred && a.enabled);
      if (entry && entry.adapter.detect()) return entry.key;
    }
    const recommended = this.getDefaultRouteRecommendation({ detectIfNeeded: true });
    if (recommended?.adapter) return recommended.adapter;
    for (const entry of this._orderAdaptersByDefaultRoutePreference(this._adapters, { detectIfNeeded: true })) {
      if (!entry.enabled) continue;
      try { if (entry.adapter.detect()) return entry.key; } catch { /* skip */ }
    }
    return null;
  },

  /**
   * Get the first available adapter (for banner display).
   * Returns status object with activeModel if a preferred model is set.
   */
  getActiveAdapter() {
    const preferredAdapter = process.env.GATEWAY_PREFERRED_ADAPTER;
    const preferredModel = process.env.GATEWAY_PREFERRED_MODEL;
    const attachModelForEntry = (entryKey, statusObj) => {
      statusObj.key = entryKey;
      const shouldAttachPreferred = !!preferredAdapter && preferredAdapter !== 'auto' && entryKey === preferredAdapter;
      const resolved = shouldAttachPreferred ? resolvePreferredModelForAdapter(entryKey, preferredModel) : null;
      statusObj.activeModel = resolved || statusObj.activeModel || null;
      return statusObj;
    };

    if (!this._initialized) {
      // Quick sync detection (no async needed for status display).
      // Respect preferred adapter first to avoid mismatched adapter/model display.
      try {
        if (preferredAdapter && preferredAdapter !== 'auto') {
          const preferredEntry = this._adapters.find(a => a.key === preferredAdapter && a.enabled);
          if (preferredEntry && preferredEntry.adapter.detect()) {
            return attachModelForEntry(preferredEntry.key, preferredEntry.adapter.getStatus());
          }
        }
        for (const entry of this._adapters) {
          if (!entry.enabled) continue;
          if (entry.adapter.detect()) {
            return attachModelForEntry(entry.key, entry.adapter.getStatus());
          }
        }
      } catch { /* ignore */ }
      return null;
    }

    // If preferred adapter is set, try it first
    if (preferredAdapter) {
      const entry = this._adapters.find(a => a.key === preferredAdapter && a.enabled);
      if (entry) {
        const status = entry.adapter.getStatus();
        if (status.available) {
          return attachModelForEntry(entry.key, status);
        }
      }
    }

    const recommended = this.getDefaultRouteRecommendation();
    if (recommended?.adapter) {
      const entry = this._adapters.find(a => a.key === recommended.adapter && a.enabled);
      if (entry) {
        const status = entry.adapter.getStatus();
        if (status.available) {
          return attachModelForEntry(entry.key, status);
        }
      }
    }

    for (const entry of this._orderAdaptersByDefaultRoutePreference(this._adapters)) {
      if (!entry.enabled) continue;
      const status = entry.adapter.getStatus();
      if (status.available) {
        return attachModelForEntry(entry.key, status);
      }
    }
    return null;
  },

  /**
   * Get the web relay adapter directly (for `gateway relay` command).
   */
  getRelayAdapter() {
    return webRelayAdapter;
  },

  /**
   * Get a specific adapter by key (for IDE commands).
   */
  getAdapter(key) {
    const entry = this._adapters.find(a => a.key === key);
    return entry ? entry.adapter : null;
  },

  // ── 通道健康可视化 / 故障转移顺序管理（供 CLI `khy channels` 调用）──────────

  /**
   * 汇总每个适配器的熔断/冷却/错误率/用户顺序，供 CLI 健康面板渲染。
   * 合并健康存储（连续失败、cooldown、窗口错误率）与本地镜像（circuitReason、
   * half-open 观察态），并标注用户自定义故障转移顺序位次。
   * @returns {Promise<Array<object>>}
   */
  async getChannelHealthSnapshot() {
    const adapterKeys = this._adapters.map((a) => a.key);
    let states = {};
    try {
      states = await this._healthStore.getAllAdapterStates(adapterKeys);
    } catch { states = {}; }

    const userOrder = (() => {
      try {
        const store = require('./failoverOrderStore');
        const { enabled, order, source } = store.getFailoverOrder();
        return { enabled, order: Array.isArray(order) ? order : [], source };
      } catch { return { enabled: false, order: [], source: 'default' }; }
    })();
    const orderPos = new Map(userOrder.order.map((k, i) => [String(k), i + 1]));

    return this._adapters.map((entry) => {
      const key = entry.key;
      const st = states[key] || {};
      const mirror = this._adapterLastError[key] || null;
      // 电路态：open（熔断中）/ half_open（恢复观察）/ closed（正常）。
      let circuitState = 'closed';
      if (mirror && mirror.circuitOpen) circuitState = 'open';
      else if (mirror && mirror.halfOpen) circuitState = 'half_open';
      else if (st.inCooldown) circuitState = 'open';
      return {
        key,
        enabled: !!entry.enabled,
        priority: Number(entry.priority || 0),
        circuitState,
        circuitReason: (mirror && mirror.circuitReason) || null,
        inCooldown: !!st.inCooldown,
        cooldownRemainingMs: Number(st.cooldownRemainingMs || 0),
        failureCount: Number(st.failureCount || 0),
        consecutiveSuccesses: Number(st.consecutiveSuccesses || 0),
        windowTotal: Number(st.windowTotal || 0),
        windowFailed: Number(st.windowFailed || 0),
        errorRate: Number(st.errorRate || 0),
        lastError: st.lastError || (mirror ? { errorType: mirror.errorType, error: mirror.error } : null),
        failoverPosition: orderPos.has(String(key)) ? orderPos.get(String(key)) : null,
      };
    });
  },

  /**
   * 手动恢复一个通道（清除熔断/冷却/失败计数），对标 cc-switch MANUAL_RESET。
   * @param {string} key 适配器 key
   * @returns {Promise<boolean>} 通道存在并已重置时返回 true
   */
  async resetChannel(key) {
    const target = String(key || '').trim().toLowerCase();
    const entry = this._adapters.find((a) => a.key === target);
    if (!entry) return false;
    await this._clearAdapterFailure(target);
    return true;
  },

  /**
   * 读取当前生效的用户故障转移顺序（透传 failoverOrderStore，供 CLI 显示）。
   */
  getFailoverOrder() {
    try {
      return require('./failoverOrderStore').getFailoverOrder();
    } catch {
      return { enabled: false, order: [], source: 'default' };
    }
  },

  /**
   * 设置用户故障转移顺序并使路由缓存失效（下次路由立即生效）。
   * @param {string[]} list 通道 key 列表（按优先顺序）
   */
  setFailoverOrder(list) {
    const result = require('./failoverOrderStore').setFailoverOrder(list);
    this._invalidateFailoverOrderCache();
    return result;
  },

  /**
   * 清除用户故障转移顺序（回退全自动评分路由）并使缓存失效。
   */
  clearFailoverOrder() {
    const result = require('./failoverOrderStore').clearFailoverOrder();
    this._invalidateFailoverOrderCache();
    return result;
  },

  /**
   * Generate using a specific adapter + model (for IDE commands).
   */
  async generateWithAdapter(adapterKey, prompt, options = {}) {
    const entry = this._adapters.find(a => a.key === adapterKey && a.enabled);
    if (!entry) throw new Error(`Adapter "${adapterKey}" not found`);
    return this._generateWithAdapterIsolation(entry, prompt, options);
  },

  /**
   * List models from a specific IDE adapter.
   *
   * The per-adapter curation layer (hidden/added/renamed/default) is merged here
   * so every consumer — web 可用模型 card, TUI /model selector, startup picker,
   * arena — sees the same list the user configured. One external key often
   * unlocks several models for a provider; those user-added ids surface through
   * this single point. applyOverrides is pure/idempotent, so the management
   * server re-applying it for verify-status projection stays correct.
   */
  async listModels(adapterKey) {
    const adapter = this.getAdapter(adapterKey);
    const raw = adapter?.listModels ? await adapter.listModels() : [];
    return modelCuration.applyOverrides(adapterKey, Array.isArray(raw) ? raw : []);
  },

  /**
   * Verify a single model is actually usable by running a minimal real-generation
   * probe through the strict gateway path. Caches the result (TTL) in modelCuration
   * so the UI can show per-model verify status without re-probing on every list.
   *
   * Adapters that cannot meaningfully target a specific model id (no generate fn)
   * degrade to 'unknown' rather than reporting a misleading 'failed' — we never
   * paint a model green/red on a probe the adapter cannot honor.
   *
   * @param {string} adapterKey
   * @param {string} modelId
   * @returns {Promise<{status:'verified'|'failed'|'unknown', latencyMs:number|null, error?:string}>}
   */
  async verifyModel(adapterKey, modelId) {
    const key = String(adapterKey || '');
    const model = String(modelId || '');
    const entry = this._adapters.find(a => a.key === key);
    if (!entry || !entry.adapter) {
      const out = { status: 'failed', latencyMs: null, error: 'adapter not found' };
      modelCuration.recordVerify(key, model, out.status, out.latencyMs, out.error);
      return out;
    }
    if (typeof entry.adapter.generate !== 'function') {
      const out = { status: 'unknown', latencyMs: null, error: 'adapter cannot probe a specific model' };
      modelCuration.recordVerify(key, model, out.status, out.latencyMs, out.error);
      return out;
    }

    const timeoutMs = Math.max(
      4000,
      parseInt(process.env.KHY_MODEL_VERIFY_PROBE_TIMEOUT_MS || '15000', 10) || 15000
    );
    const t0 = Date.now();
    try {
      const probe = await this.generate('Reply with exactly: OK', {
        preferredAdapter: key,
        preferredModel: model,
        model,
        preferredStrict: true,
        maxTotalAttempts: 1,
        maxRetryDelayBudgetMs: 1000,
        maxTokens: 16,
        temperature: 0,
        top_p: 1,
        thinking: false,
        timeoutMs,
        firstResponseTimeoutMs: timeoutMs,
        disableProviderFallback: true,
        strictAutoRelaxOnProcess: false,
      });
      const text = String(probe?.content || probe?.thinking || '').trim();
      if (probe?.success && text) {
        const out = { status: 'verified', latencyMs: Date.now() - t0 };
        modelCuration.recordVerify(key, model, out.status, out.latencyMs, null);
        return out;
      }
      const out = {
        status: 'failed',
        latencyMs: Date.now() - t0,
        error: _extractResultErrorMessage(probe) || 'empty generation',
      };
      modelCuration.recordVerify(key, model, out.status, out.latencyMs, out.error);
      return out;
    } catch (err) {
      const out = { status: 'failed', latencyMs: Date.now() - t0, error: err.message || String(err) };
      modelCuration.recordVerify(key, model, out.status, out.latencyMs, out.error);
      return out;
    }
  },

  /**
   * Live-probe whether a model can do NATIVE function calling, and persist the
   * verdict so the decision SSOT (modelToolingCapability) uses MEASURED capability
   * instead of name-based guessing ("不硬编码,实测为准").
   *
   * Mirrors verifyModel: a single strict, non-fallback generation — but it ships a
   * trivial tool and asks the model to call it, then interprets the result via
   * toolCallingProbe (native tool_calls observed → 'native'; text-only → 'text';
   * failure/empty → 'unknown', not recorded). `_toolCapProbe:true` makes the strip
   * gates keep the tools on the wire and prevents recursive background probing.
   *
   * @param {string} adapterKey
   * @param {string} modelId
   * @returns {Promise<{verdict:'native'|'text'|'unknown', latencyMs:number|null, error?:string}>}
   */
  async verifyToolCalling(adapterKey, modelId) {
    const probe = require('./toolCallingProbe');
    const store = require('./toolCapabilityStore');
    const key = String(adapterKey || '');
    const model = String(modelId || '');
    const entry = this._adapters.find(a => a.key === key);
    if (!entry || !entry.adapter || typeof entry.adapter.generate !== 'function') {
      return { verdict: 'unknown', latencyMs: null, error: 'adapter cannot probe a specific model' };
    }
    const timeoutMs = Math.max(
      4000,
      parseInt(process.env.KHY_TOOL_CAP_PROBE_TIMEOUT_MS || '15000', 10) || 15000
    );
    const t0 = Date.now();
    try {
      const result = await this.generate(probe.PROBE_PROMPT, {
        preferredAdapter: key,
        preferredModel: model,
        model,
        preferredStrict: true,
        maxTotalAttempts: 1,
        maxRetryDelayBudgetMs: 1000,
        maxTokens: 64,
        temperature: 0,
        top_p: 1,
        thinking: false,
        timeoutMs,
        firstResponseTimeoutMs: timeoutMs,
        disableProviderFallback: true,
        strictAutoRelaxOnProcess: false,
        tools: [probe.TRIVIAL_TOOL],
        _toolCapProbe: true,
      });
      const { verdict } = probe.interpretProbeResult(result);
      const latencyMs = Date.now() - t0;
      if (verdict === 'native' || verdict === 'text') {
        store.recordVerdict(model, verdict, { source: 'probe', latencyMs });
      }
      return { verdict, latencyMs };
    } catch (err) {
      return { verdict: 'unknown', latencyMs: Date.now() - t0, error: err.message || String(err) };
    }
  },

  /**
   * Fire-and-forget background tool-calling probe on first use of an un-measured
   * channel. De-duped per (adapter, model) via an in-flight set so concurrent
   * requests trigger at most one probe. Never blocks the current turn, never throws.
   */
  _maybeBackgroundProbeToolCalling(adapterKey, model) {
    try {
      const probe = require('./toolCallingProbe');
      if (!probe.isEnabled()) return;
      const m = probe.normalizeModel(model);
      if (!m || !adapterKey) return;
      const store = require('./toolCapabilityStore');
      if (store.getVerdict(m) !== null) return; // 已有新鲜实测,无需重测
      this._toolCapProbeInFlight = this._toolCapProbeInFlight || new Set();
      const key = `${adapterKey}::${m}`;
      if (this._toolCapProbeInFlight.has(key)) return;
      this._toolCapProbeInFlight.add(key);
      Promise.resolve()
        .then(() => this.verifyToolCalling(adapterKey, model))
        .catch(() => { /* best effort */ })
        .finally(() => { try { this._toolCapProbeInFlight.delete(key); } catch { /* ignore */ } });
    } catch { /* best effort */ }
  },

  /**
   * Tear down all adapters.
   */
  async destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this._stopCooldownSelfHealTicker();
    if (this._modelRefreshTimer) {
      clearInterval(this._modelRefreshTimer);
      this._modelRefreshTimer = null;
    }
    if (this._healthBroadcaster && typeof this._healthBroadcaster.stop === 'function') {
      try {
        this._healthBroadcaster.stop();
      } catch { /* best effort */ }
    }
    if (this._dedup && typeof this._dedup.destroy === 'function') {
      try {
        this._dedup.destroy();
      } catch { /* best effort */ }
    }
    if (this._healthStore && typeof this._healthStore.destroy === 'function') {
      try {
        await this._healthStore.destroy();
      } catch { /* best effort */ }
    }
    const errors = [];
    for (const entry of this._adapters) {
      if (!entry?.adapter?.destroy) continue;
      try {
        await entry.adapter.destroy();
      } catch (err) {
        errors.push({ key: entry.key, error: err });
      }
    }
    this._initialized = false;
    this._initPromise = null;
    this._adapterFailures = {};
    this._adapterLastError = {};
    this._cooldownSelfHealMeta = {};
    this._cooldownSelfHealInFlight.clear();
    this._clearAllCooldownSelfHealMidpointTimers();
    this._requestLog = {};
    this._lastRefreshTime = 0;
    if (errors.length > 0) {
      const summary = errors.map(e => `${e.key}: ${e.error?.message || String(e.error)}`).join('; ');
      const err = new Error(`Gateway destroy completed with adapter cleanup errors: ${summary}`);
      err.cleanupErrors = errors;
      throw err;
    }
  },

  /**
   * Test adapter connectivity with a lightweight request.
   * Two-step test pattern (inspired by cc-haha ProviderTestResult):
   *   Step 1: detect() — is the adapter reachable?
   *   Step 2: listModels() or generate ping — can it actually serve requests?
   *   Step 3 (selected adapters): real generation smoke test.
   * @param {string} adapterKey
   * @returns {Promise<{connectivity: {success,latencyMs,error?}, models?: {success,latencyMs,error?,count?}, generation?: {success,latencyMs,error?}}>}
   */
  async testAdapter(adapterKey, options = {}) {
    const entry = this._adapters.find(a => a.key === adapterKey);
    if (!entry || !entry.adapter) {
      return { connectivity: { success: false, latencyMs: 0, error: 'Adapter not found' } };
    }

    const quickMode = !!options.quick;
    const timeoutMs = Math.max(
      2000,
      parseInt(
        String(
          options.timeoutMs
          || process.env.GATEWAY_TEST_TIMEOUT_MS
          || 6000
        ),
        10
      ) || 6000
    );
    const generationProbeTimeoutMs = Math.max(
      0,
      parseInt(
        String(
          options.probeGenerationTimeoutMs
          || process.env.GATEWAY_GENERATION_PROBE_TIMEOUT_MS
          || 0
        ),
        10
      ) || 0
    );
    const result = { connectivity: null, models: null };
    const collectRuntimeDiagnostics = (diagOptions = {}) => {
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
    };

    // Step 1: Basic detection / connectivity
    const t1 = Date.now();
    let step1Timer = null;
    try {
      let ok;
      // Relay needs a real bind check; detect() is intentionally optimistic.
      if (adapterKey === 'relay' && typeof entry.adapter.start === 'function') {
        ok = await Promise.race([
          entry.adapter.start().then(() => true),
          new Promise((_, rej) => {
            step1Timer = setTimeout(() => rej(new Error(`timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
          }),
        ]);
      } else if (entry.adapter.detectAsync) {
        ok = await Promise.race([
          entry.adapter.detectAsync(true),
          new Promise((_, rej) => {
            step1Timer = setTimeout(() => rej(new Error(`timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
          }),
        ]);
      } else {
        ok = entry.adapter.detect(true);
      }
      result.connectivity = { success: !!ok, latencyMs: Date.now() - t1 };
      if (!ok) result.connectivity.error = 'not detected';
    } catch (err) {
      result.connectivity = { success: false, latencyMs: Date.now() - t1, error: err.message };
    } finally {
      if (step1Timer) clearTimeout(step1Timer);
    }

    if (!result.connectivity.success) return result;

    // Step 2: Model listing (if supported) — verifies API actually works
    if (entry.adapter.listModels) {
      const t2 = Date.now();
      let step2Timer = null;
      try {
        const models = await Promise.race([
          entry.adapter.listModels(),
          new Promise((_, rej) => {
            step2Timer = setTimeout(() => rej(new Error(`timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
          }),
        ]);
        result.models = {
          success: true,
          latencyMs: Date.now() - t2,
          count: Array.isArray(models) ? models.length : 0,
          list: Array.isArray(models) ? models.slice(0, 10) : [],
        };
      } catch (err) {
        result.models = { success: false, latencyMs: Date.now() - t2, error: err.message };
      } finally {
        if (step2Timer) clearTimeout(step2Timer);
      }
    }

    // Step 3: For adapters with frequent "detected but unusable" cases, run a tiny real-generation probe.
    // This avoids status false positives (e.g. codex command exists but request path is broken).
    if (!quickMode && adapterKey === 'codex' && typeof entry.adapter.generate === 'function') {
      const t3 = Date.now();
      try {
        // Probe through the real gateway strict path so status reflects the same
        // language injection, strict routing and meaningful-progress watchdog
        // used by interactive/sample requests.
        const timeoutMs = generationProbeTimeoutMs > 0
          ? Math.max(12000, generationProbeTimeoutMs)
          : Math.max(
            12000,
            parseInt(
              process.env.GATEWAY_CODEX_STATUS_PROBE_TIMEOUT_MS
              || process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS
              || process.env.KHY_GATEWAY_SAMPLE_FIRST_RESPONSE_TIMEOUT_MS
              || '20000',
              10
            ) || 20000
          );
        const preferredProbeModel = process.env.GATEWAY_PREFERRED_MODEL || '';
        const isCodexModel = /^(gpt[-_]|o\d)/i.test(preferredProbeModel);
        const probeModel = isCodexModel
          ? preferredProbeModel
          : (
            (Array.isArray(result.models?.list) && result.models.list[0] && (result.models.list[0].id || result.models.list[0].name))
              || MODELS.codexProbe
          );
        const probe = await this.generate(CODEX_GENERATION_PROBE_PROMPT, {
          preferredAdapter: 'codex',
          preferredStrict: true,
          preferredModel: probeModel,
          model: probeModel,
          maxTotalAttempts: 1,
          maxRetryDelayBudgetMs: 1000,
          maxTokens: 64,
          temperature: 0,
          top_p: 1,
          thinking: false,
          timeoutMs,
          firstResponseTimeoutMs: timeoutMs,
          disableProviderFallback: true,
          strictAutoRelaxOnProcess: false,
        });

        if (probe?.success && String(probe?.content || '').trim()) {
          result.generation = {
            success: true,
            latencyMs: Date.now() - t3,
            diagnostics: probe?.diagnostics || null,
          };
        } else {
          result.generation = {
            success: false,
            latencyMs: Date.now() - t3,
            error: _extractResultErrorMessage(probe),
            diagnostics: probe?.diagnostics || null,
          };
        }
      } catch (err) {
        result.generation = { success: false, latencyMs: Date.now() - t3, error: err.message };
      }
    }

    // Local LLM can appear "available" when model file exists, while runtime load
    // actually fails (e.g. GGUF mismatch, backend boot timeout). Probe a tiny
    // generation once so model-selection UI does not show false "available".
    if (!quickMode && adapterKey === 'localLLM' && typeof entry.adapter.generate === 'function') {
      const t3 = Date.now();
      try {
        const probeTimeout = generationProbeTimeoutMs > 0
          ? Math.max(4000, generationProbeTimeoutMs)
          : Math.max(4000, parseInt(process.env.GATEWAY_LOCAL_LLM_PROBE_TIMEOUT_MS || '30000', 10));
        const probePromise = entry.adapter.generate('Reply with exactly: OK', {
          maxTokens: 32,
          temperature: 0,
          top_p: 1,
          think: false, // Disable thinking for probe (avoids slow startup)
        });
        let probeTimer = null;
        const timeoutPromise = new Promise((_, reject) => {
          probeTimer = setTimeout(() => reject(new Error(`localLLM timeout (${probeTimeout}ms)`)), probeTimeout);
          if (probeTimer.unref) probeTimer.unref();
        });
        const probe = await Promise.race([probePromise, timeoutPromise]);
        if (probeTimer) clearTimeout(probeTimer);
        const text = String(probe?.content || '').trim();
        if (probe?.success && text) {
          result.generation = { success: true, latencyMs: Date.now() - t3 };
        } else {
          result.generation = {
            success: false,
            latencyMs: Date.now() - t3,
            error: probe?.error || 'empty generation',
          };
        }
      } catch (err) {
        result.generation = {
          success: false,
          latencyMs: Date.now() - t3,
          error: err.message || String(err),
        };
      }
    }

    // Claude CLI can be detected but unusable when login/API auth is missing.
    // Run a short non-interactive probe to catch this and avoid false "available".
    if (!quickMode && adapterKey === 'claude') {
      const t3 = Date.now();
      try {
        const timeoutMs = generationProbeTimeoutMs > 0
          ? Math.max(6000, generationProbeTimeoutMs)
          : Math.max(6000, parseInt(process.env.GATEWAY_CLAUDE_PROBE_TIMEOUT_MS || '10000', 10));
        const rawProbeModel = (process.env.GATEWAY_PREFERRED_MODEL || '').trim();
        const probeModel = rawProbeModel.includes('::')
          ? rawProbeModel.split('::')[0].trim()
          : rawProbeModel;
        const args = [
          '-p',
          '--output-format', 'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--permission-mode', 'bypassPermissions',
        ];
        if (probeModel && /^claude[-_]/i.test(probeModel)) {
          args.push('--model', probeModel);
        }
        const runClaudeProbe = (argv) => new Promise((resolve) => {
          let stdout = '', stderr = '';
          const child = spawn('claude', argv, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
          const timer = setTimeout(() => { safeKillChildProc(child); resolve({ stdout, stderr, status: null, timedOut: true }); }, timeoutMs);
          child.stdout.on('data', d => { stdout += d; if (stdout.length > 2 * 1024 * 1024) safeKillChildProc(child); });
          child.stderr.on('data', d => { stderr += d; });
          child.stdin.write('Reply with exactly: OK');
          child.stdin.end();
          child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, status: code, timedOut: false }); });
          child.on('error', (err) => { clearTimeout(timer); resolve({ stdout, stderr: err.message, status: 1, timedOut: false }); });
        });
        const evaluateProbe = (probe) => {
          const combined = `${probe.stdout}\n${probe.stderr}`.toLowerCase();
          // `apiKeySource:"none"` can still be valid when Claude Code uses local login/session.
          // Only treat explicit auth failures as "login unavailable".
          const authMissing = combined.includes('api_retry')
            || combined.includes('unauthorized')
            || combined.includes('not authenticated');
          const hasUsableContent = combined.includes('"type":"assistant"')
            || combined.includes('"type":"text"')
            || combined.includes('"type":"result"');
          const success = !probe.timedOut && probe.status === 0 && hasUsableContent && !authMissing;
          return { combined, authMissing, hasUsableContent, success };
        };
        let probe = await runClaudeProbe(args);
        let evaluated = evaluateProbe(probe);

        // If model-qualified probe fails (common with adapter suffix model ids), retry once without --model.
        if (!evaluated.success && args.includes('--model') && !evaluated.authMissing && !probe.timedOut) {
          const retryArgs = args.slice();
          const modelIdx = retryArgs.indexOf('--model');
          if (modelIdx >= 0) retryArgs.splice(modelIdx, 2);
          const retry = await runClaudeProbe(retryArgs);
          const retryEval = evaluateProbe(retry);
          if (retryEval.success) {
            probe = retry;
            evaluated = retryEval;
          }
        }

        if (evaluated.success) {
          result.generation = { success: true, latencyMs: Date.now() - t3 };
        } else {
          const reason = probe.timedOut
            ? `claude probe timeout after ${timeoutMs}ms`
            : (evaluated.authMissing ? 'claude auth/login unavailable' : (String(probe.stderr).trim() || `claude exited with code ${probe.status}`));
          result.generation = {
            success: false,
            latencyMs: Date.now() - t3,
            error: reason,
            diagnostics: collectRuntimeDiagnostics({ preferCategory: 'stall' }) || collectRuntimeDiagnostics(),
          };
        }
      } catch (err) {
        result.generation = {
          success: false,
          latencyMs: Date.now() - t3,
          error: err.message || String(err),
          diagnostics: collectRuntimeDiagnostics({ preferCategory: 'stall' }) || collectRuntimeDiagnostics(),
        };
      }
    }

    // Cursor/Windsurf/Trae can appear available from local token/cache only.
    // Run a tiny generation probe to ensure the remote channel actually works.
    if (
      !quickMode
      && (adapterKey === 'cursor' || adapterKey === 'windsurf' || adapterKey === 'trae')
      && typeof entry.adapter.generate === 'function'
    ) {
      const t3 = Date.now();
      try {
        const probeTimeout = generationProbeTimeoutMs > 0
          ? Math.max(6000, generationProbeTimeoutMs)
          : Math.max(
            6000,
            parseInt(
              (adapterKey === 'trae'
                ? (process.env.GATEWAY_TRAE_PROBE_TIMEOUT_MS || process.env.GATEWAY_IDE_PROBE_TIMEOUT_MS || '10000')
                : (process.env.GATEWAY_IDE_PROBE_TIMEOUT_MS || '10000')),
              10
            )
          );
        const probeModels = Array.isArray(result.models?.list) ? result.models.list : [];
        const preferredProbeModel = probeModels.find((model) => model && model.isDefault) || probeModels[0] || null;
        const probeModel = preferredProbeModel ? (preferredProbeModel.id || preferredProbeModel.name || '') : '';
        const probePromise = entry.adapter.generate('Reply with exactly: OK', {
          model: probeModel || undefined,
          maxTokens: 32,
          temperature: 0,
          top_p: 1,
          think: false,
        });
        let probeTimer2 = null;
        const timeoutPromise = new Promise((_, reject) => {
          probeTimer2 = setTimeout(() => reject(new Error(`${adapterKey} probe timeout (${probeTimeout}ms)`)), probeTimeout);
          if (probeTimer2.unref) probeTimer2.unref();
        });
        const probe = await Promise.race([probePromise, timeoutPromise]);
        if (probeTimer2) clearTimeout(probeTimer2);
        const text = String(probe?.content || '').trim();
        if (probe?.success && text) {
          result.generation = { success: true, latencyMs: Date.now() - t3 };
        } else {
          result.generation = {
            success: false,
            latencyMs: Date.now() - t3,
            error: probe?.error || 'empty generation',
          };
        }
      } catch (err) {
        result.generation = {
          success: false,
          latencyMs: Date.now() - t3,
          error: err.message || String(err),
        };
      }
    }

    // Relay API can pass detect/listModels while configured default model is invalid.
    // Probe a tiny real generation to verify model-serving path.
    if (!quickMode && adapterKey === 'relay_api' && typeof entry.adapter.generate === 'function') {
      const t3 = Date.now();
      try {
        const probeTimeout = generationProbeTimeoutMs > 0
          ? Math.max(6000, generationProbeTimeoutMs)
          : Math.max(6000, parseInt(process.env.GATEWAY_RELAY_API_PROBE_TIMEOUT_MS || '10000', 10));
        const modelList = Array.isArray(result.models?.list) ? result.models.list : [];
        const remotePreferred = modelList.find((m) => String(m?.discoverySource || '').toLowerCase() === 'remote' && m?.isDefault)
          || modelList.find((m) => String(m?.discoverySource || '').toLowerCase() === 'remote')
          || modelList.find((m) => m && m.isDefault)
          || modelList[0]
          || null;
        const probeModel = remotePreferred ? (remotePreferred.id || remotePreferred.name || '') : '';
        const probePromise = entry.adapter.generate('Reply with exactly: OK', {
          model: probeModel || undefined,
          maxTokens: 24,
          temperature: 0,
          top_p: 1,
          // Connectivity probe: the outcome is surfaced through the model
          // picker, so suppress the adapter's own 4xx console noise. A
          // misconfigured endpoint (e.g. RELAY_API_ENDPOINT pointed at a
          // non-OpenAI host) must not spam the console on every probe.
          _probe: true,
        });
        let probeTimer3 = null;
        const timeoutPromise = new Promise((_, reject) => {
          probeTimer3 = setTimeout(() => reject(new Error(`relay_api probe timeout (${probeTimeout}ms)`)), probeTimeout);
          if (probeTimer3.unref) probeTimer3.unref();
        });
        const probe = await Promise.race([probePromise, timeoutPromise]);
        if (probeTimer3) clearTimeout(probeTimer3);
        const text = String(probe?.content || '').trim();
        if (probe?.success && text) {
          result.generation = { success: true, latencyMs: Date.now() - t3 };
        } else {
          result.generation = {
            success: false,
            latencyMs: Date.now() - t3,
            error: probe?.error || 'empty generation',
          };
        }
      } catch (err) {
        result.generation = {
          success: false,
          latencyMs: Date.now() - t3,
          error: err.message || String(err),
        };
      }
    }

    if (result.generation && result.generation.success === false && !result.generation.diagnostics) {
      result.generation.diagnostics = collectRuntimeDiagnostics({ preferCategory: 'stall' }) || collectRuntimeDiagnostics();
    }
    return result;
  },
};

module.exports = { AIGatewayModelMethods, setAiGatewayModelMethodsDeps };
