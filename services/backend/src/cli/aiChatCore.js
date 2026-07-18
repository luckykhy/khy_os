'use strict';

/**
 * aiChatCore — the chat mega-construct isolated from cli/ai.js (god-file split, isolation-as-goal).
 *
 * `chat()` plus its task-classification / structured-message / capability / context-overflow cluster
 * (original ai.js lines 2239..5957) is an irreducible ~3.7k-line routine that could not be split
 * byte-identically (it shares 12 reassigned module lets with the host). Per the user-approved Option C it
 * is relocated here; the 12 shared bindings live in the required-once ./aiChatState singleton, and the 27
 * host-defined names this band calls (4 data consts + 23 helper fns) are injected once at host load via
 * setAiChatCoreDeps — before chat() is ever invoked — so no require cycle back into ai.js is needed.
 * The host imports the 6 names defined here that it re-exports / references (chat + 5 helpers). Several
 * relocated helpers perform IO and the routine drives network/timers, so this is NOT a pure zero-IO leaf.
 */

const path = require('path');
const crypto = require('crypto');
const runtime = require('../services/khyUpgradeRuntime');
const _chatState = require('./aiChatState');

// Relocated block-only state (was ai.js `let _autoTuneAnnouncement` @27; referenced only inside this band).
let _autoTuneAnnouncement = { profile: '', preset: '', at: 0 };

// ── Host-injected bindings (set once at host load via setAiChatCoreDeps, before chat() runs) ──
let COT_INJECTION_PROMPT = null;
let EFFORT_PRESETS = null;
let MAX_HISTORY = null;
let MODEL_CAPABILITIES = null;
let _applyVisionRouting = null;
let _buildGreetingQuickReply = null;
let _buildLanguageFallbackDirective = null;
let _clampSubagentEffort = null;
let _classifyGatewayThrownError = null;
let _createStreamToolInterceptor = null;
let _createThinkTagInterceptor = null;
let _ensureLiveSessionId = null;
let _estimateContextTokens = null;
let _extractFileReferences = null;
let _getModelInfo = null;
let _getStudyModeRuntimeMeta = null;
let _guessModelHint = null;
let _isFirstTokenSignalChunk = null;
let _isLightweightConversationInput = null;
let _isLocalThinkingModel = null;
let _isTransientGatewayErrorType = null;
let _logStandaloneLlmRequest = null;
let _logStandaloneLlmResponse = null;
let _maybeAutoSaveMemory = null;
let _maybeWarmupLocalPreferredOnce = null;
let _modelSupportsNativeThinking = null;
let _persistLiveSession = null;
let _registerActiveGatewayRequest = null;
let _resolveAuditTraceContext = null;
let _resolveContextBudget = null;
let _resolveDeepseekThinkingModel = null;
let _resolveLocalPreferredMaxTokens = null;
let _resolveModelContextLimit = null;
let _resolveTaskScale = null;
let _uncommitOrphanTurn = null;
let _unregisterActiveGatewayRequest = null;
let getChatLatencyAutoTuner = null;
let getGateway = null;
let getSecurityDir = null;
let getService = null;
function setAiChatCoreDeps(deps = {}) {
  if (deps.COT_INJECTION_PROMPT !== undefined) COT_INJECTION_PROMPT = deps.COT_INJECTION_PROMPT;
  if (deps.EFFORT_PRESETS !== undefined) EFFORT_PRESETS = deps.EFFORT_PRESETS;
  if (deps.MAX_HISTORY !== undefined) MAX_HISTORY = deps.MAX_HISTORY;
  if (deps.MODEL_CAPABILITIES !== undefined) MODEL_CAPABILITIES = deps.MODEL_CAPABILITIES;
  if (deps._applyVisionRouting !== undefined) _applyVisionRouting = deps._applyVisionRouting;
  if (deps._buildGreetingQuickReply !== undefined) _buildGreetingQuickReply = deps._buildGreetingQuickReply;
  if (deps._buildLanguageFallbackDirective !== undefined) _buildLanguageFallbackDirective = deps._buildLanguageFallbackDirective;
  if (deps._clampSubagentEffort !== undefined) _clampSubagentEffort = deps._clampSubagentEffort;
  if (deps._classifyGatewayThrownError !== undefined) _classifyGatewayThrownError = deps._classifyGatewayThrownError;
  if (deps._createStreamToolInterceptor !== undefined) _createStreamToolInterceptor = deps._createStreamToolInterceptor;
  if (deps._createThinkTagInterceptor !== undefined) _createThinkTagInterceptor = deps._createThinkTagInterceptor;
  if (deps._ensureLiveSessionId !== undefined) _ensureLiveSessionId = deps._ensureLiveSessionId;
  if (deps._estimateContextTokens !== undefined) _estimateContextTokens = deps._estimateContextTokens;
  if (deps._extractFileReferences !== undefined) _extractFileReferences = deps._extractFileReferences;
  if (deps._getModelInfo !== undefined) _getModelInfo = deps._getModelInfo;
  if (deps._getStudyModeRuntimeMeta !== undefined) _getStudyModeRuntimeMeta = deps._getStudyModeRuntimeMeta;
  if (deps._guessModelHint !== undefined) _guessModelHint = deps._guessModelHint;
  if (deps._isFirstTokenSignalChunk !== undefined) _isFirstTokenSignalChunk = deps._isFirstTokenSignalChunk;
  if (deps._isLightweightConversationInput !== undefined) _isLightweightConversationInput = deps._isLightweightConversationInput;
  if (deps._isLocalThinkingModel !== undefined) _isLocalThinkingModel = deps._isLocalThinkingModel;
  if (deps._isTransientGatewayErrorType !== undefined) _isTransientGatewayErrorType = deps._isTransientGatewayErrorType;
  if (deps._logStandaloneLlmRequest !== undefined) _logStandaloneLlmRequest = deps._logStandaloneLlmRequest;
  if (deps._logStandaloneLlmResponse !== undefined) _logStandaloneLlmResponse = deps._logStandaloneLlmResponse;
  if (deps._maybeAutoSaveMemory !== undefined) _maybeAutoSaveMemory = deps._maybeAutoSaveMemory;
  if (deps._maybeWarmupLocalPreferredOnce !== undefined) _maybeWarmupLocalPreferredOnce = deps._maybeWarmupLocalPreferredOnce;
  if (deps._modelSupportsNativeThinking !== undefined) _modelSupportsNativeThinking = deps._modelSupportsNativeThinking;
  if (deps._persistLiveSession !== undefined) _persistLiveSession = deps._persistLiveSession;
  if (deps._registerActiveGatewayRequest !== undefined) _registerActiveGatewayRequest = deps._registerActiveGatewayRequest;
  if (deps._resolveAuditTraceContext !== undefined) _resolveAuditTraceContext = deps._resolveAuditTraceContext;
  if (deps._resolveContextBudget !== undefined) _resolveContextBudget = deps._resolveContextBudget;
  if (deps._resolveDeepseekThinkingModel !== undefined) _resolveDeepseekThinkingModel = deps._resolveDeepseekThinkingModel;
  if (deps._resolveLocalPreferredMaxTokens !== undefined) _resolveLocalPreferredMaxTokens = deps._resolveLocalPreferredMaxTokens;
  if (deps._resolveModelContextLimit !== undefined) _resolveModelContextLimit = deps._resolveModelContextLimit;
  if (deps._resolveTaskScale !== undefined) _resolveTaskScale = deps._resolveTaskScale;
  if (deps._uncommitOrphanTurn !== undefined) _uncommitOrphanTurn = deps._uncommitOrphanTurn;
  if (deps._unregisterActiveGatewayRequest !== undefined) _unregisterActiveGatewayRequest = deps._unregisterActiveGatewayRequest;
  if (deps.getChatLatencyAutoTuner !== undefined) getChatLatencyAutoTuner = deps.getChatLatencyAutoTuner;
  if (deps.getGateway !== undefined) getGateway = deps.getGateway;
  if (deps.getSecurityDir !== undefined) getSecurityDir = deps.getSecurityDir;
  if (deps.getService !== undefined) getService = deps.getService;
}

function _classifyTaskType(message) {
  if (!message) return 'conversation';
  const lower = message.toLowerCase();
  if (/回测|backtest|策略|strategy/.test(lower)) return 'backtest';
  if (/分析|analyze|评估|诊断/.test(lower)) return 'analysis';
  if (/数据|data|下载|fetch/.test(lower)) return 'dataFetch';
  if (/策略|strategy|signal|信号/.test(lower)) return 'strategy';
  return 'conversation';
}

/**
 * Strip harness-injected scaffolding from a user message before task-difficulty
 * scoring. The planning / key-findings preambles are prepended as `[System: ...]`
 * blocks separated from the real user text by a blank line (`\n\n`), and may
 * contain their own square brackets (e.g. the planning example `[read]`), so we
 * split on the blank-line boundary and drop leading segments that begin with
 * `[System:` rather than trying to bracket-match. Also removes any residual
 * `<finding>` / `<execution_plan>` scaffolding. Scoring-only: the untouched
 * message is still what reaches the model — this just prevents harness prose
 * (e.g. the key-findings "根本原因" hint) from inflating the required capability
 * and hard-blocking trivial user input like "你好".
 */
function _stripHarnessScaffolding(input) {
  const raw = String(input || '');
  if (!raw) return raw;
  try {
    const text = raw
      .replace(/<finding\b[\s\S]*?<\/finding>/gi, ' ')
      .replace(/<execution_plan\b[\s\S]*?<\/execution_plan>/gi, ' ');
    const segments = text.split(/\n{2,}/);
    while (segments.length > 1 && /^\s*\[System:/i.test(segments[0])) {
      segments.shift();
    }
    const stripped = segments.join('\n\n').trim();
    return stripped || raw;
  } catch (_e) {
    return raw;
  }
}

function _assessTaskDifficulty(input) {
  const cleaned = _stripHarnessScaffolding(input);
  const lower = cleaned.toLowerCase();
  const required = { code: 1, reasoning: 1, creative: 1, contextNeeded: 0 };

  if (/重构|refactor|实现|implement|debug|修复|写代码|编码|class\s|function\s|async\s|promise/.test(lower)) required.code = 4;
  if (/分析|analyze|推理|reason|比较|对比|为什么|原因|策略设计|复杂/.test(lower)) required.reasoning = 4;
  if (/设计|design|创意|创建|generate|生成|写文章|write\s/.test(lower)) required.creative = 3;
  if (cleaned.length > 3000 || /全部|所有文件|整个项目|complete|comprehensive/.test(lower)) {
    required.contextNeeded = cleaned.length * 4;
  }

  return required;
}

function checkModelCapability(input) {
  let currentModel = null;
  try {
    const gw = _chatState.gateway || require('../services/gateway/aiGateway');
    const active = (gw && typeof gw.getActiveAdapter === 'function') ? gw.getActiveAdapter() : null;
    if (active) {
      currentModel = active.activeModel || active.model || active.name || null;
    }
    if (!currentModel) {
      const status = (gw && typeof gw.getStatus === 'function') ? gw.getStatus() : null;
      if (Array.isArray(status)) {
        const activeRec = status.find(s => s && (s.active || s.isActive)) || status[0];
        currentModel = activeRec?.activeModel || activeRec?.model || activeRec?.name || null;
      } else if (status && typeof status === 'object') {
        currentModel = status.activeModel || status.model || status.name || null;
      }
    }
  } catch (e) { console.error('[ai] 模型状态获取失败:', e?.message); }
  if (!currentModel) {
    currentModel = String(process.env.GATEWAY_PREFERRED_MODEL || '').trim() || null;
  }
  if (!currentModel) return null;

  const lowerModel = currentModel.toLowerCase();
  let cap = null;
  const sortedCaps = Object.entries(MODEL_CAPABILITIES)
    .sort((a, b) => String(b[0] || '').length - String(a[0] || '').length);
  for (const [key, val] of sortedCaps) {
    if (lowerModel === key || lowerModel.includes(key)) { cap = val; break; }
  }
  if (!cap) return null;

  const taskReq = _assessTaskDifficulty(input);
  const issues = [];
  if (taskReq.code > cap.code) issues.push(`代码能力不足 (需要 ${taskReq.code}/5, 当前 ${cap.code}/5)`);
  if (taskReq.reasoning > cap.reasoning) issues.push(`推理能力不足 (需要 ${taskReq.reasoning}/5, 当前 ${cap.reasoning}/5)`);
  if (taskReq.contextNeeded > cap.context * 0.8) issues.push(`上下文可能不够 (估计需要 ${Math.round(taskReq.contextNeeded / 1000)}k, 限制 ${Math.round(cap.context / 1000)}k)`);
  if (issues.length === 0) return null;

  const better = Object.entries(MODEL_CAPABILITIES)
    .filter(([key]) => !lowerModel.includes(key))
    .filter(([, m]) => m.code >= taskReq.code && m.reasoning >= taskReq.reasoning && m.context >= (taskReq.contextNeeded || 0))
    .sort((a, b) => (b[1].code + b[1].reasoning) - (a[1].code + a[1].reasoning))
    .slice(0, 3);

  return {
    issues,
    recommendations: better.map(([key, m]) => ({ key, label: m.label })),
  };
}

/**
 * Build structured messages array for adapters that support native message format.
 * This preserves role boundaries instead of flattening into a single string.
 * 支持 Anthropic content blocks（tool_use/tool_result）直接透传。
 * @param {string} systemPrompt
 * @param {Array} messages
 * @returns {Array<{role: string, content: string|Array}>}
 */
function _buildStructuredMessages(systemPrompt, messages) {
  let _contentToText;
  try { _contentToText = require('../services/contentBlockUtils').contentToText; } catch { _contentToText = (c) => String(c || ''); }

  const result = [{ role: 'system', content: systemPrompt }];
  for (const msg of messages) {
    if (msg.role === 'system') {
      // 中间 system 消息（如 contextCompressor 摘要）转为 user 角色
      result.push({ role: 'user', content: _contentToText(msg.content) });
    } else if (msg.role === 'tool') {
      result.push({ role: 'user', content: `[Tool Result]\n${_contentToText(msg.content)}` });
    } else if (Array.isArray(msg.content)) {
      // 结构化 content blocks（assistant+tool_use 或 user+tool_result）— 直接透传
      result.push({ role: msg.role, content: msg.content });
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }

  // A1: 统一角色交替守卫 — 一处修复，所有路径受益
  const { enforceRoleAlternation } = require('../services/contextCompressor');
  const alternated = enforceRoleAlternation(result);

  // A2: tool_use/tool_result 配对修复 — 确保每个 assistant 消息中的 tool_use block
  // 在下一个 user 消息中都有对应的 tool_result。
  // 对标 Claude Code ensureToolResultPairing(): 未配对时注入 placeholder tool_result，
  // 而不是降级 assistant 的 tool_use blocks 为纯文本（降级会丢失结构化上下文）。
  try {
    const { ensureToolResultPairing } = require('../services/contentBlockUtils');
    ensureToolResultPairing(alternated);
  } catch { /* contentBlockUtils not available — skip pairing repair */ }

  return alternated;
}

async function _gatewayGenerate(conversationPrompt, fullSystemPrompt, messages, userMessage, opts, effortPreset) {
  const gw = getGateway();
  if (!gw._initialized) await gw.init();

  // top_p is locked by runtime — never allow external override
  const lockedTopP = runtime.lockTopP(userMessage);

  // Inject tool definitions so the model knows what tools are available
  let toolDefs;
  try {
    const { getToolDefinitions } = require('../services/toolCalling');
    toolDefs = getToolDefinitions();
    // Apply tool profile filter from agent context (e.g. 'explore' → read-only tools)
    if (opts._agentContext?.toolFilter) {
      const { filterToolsByProfile } = require('../tools/toolProfile');
      const toolsMap = new Map(toolDefs.map(t => [t.name || t.function?.name, t]));
      const filtered = filterToolsByProfile(toolsMap, opts._agentContext.toolFilter);
      toolDefs = [...filtered.values()];
    }
    // Apply disallowedTools denylist as secondary safety layer
    if (opts._agentContext?.disallowedTools?.length > 0) {
      const deny = new Set(opts._agentContext.disallowedTools);
      toolDefs = toolDefs.filter(t => !deny.has(t.name) && !deny.has(t.function?.name));
    }
  } catch { toolDefs = undefined; }

  // Forced-summarization turn (toolUseLoop Fix #3): when the loop asks the model
  // to write a closing summary from already-gathered tool data, suppress all
  // function-calling so the model can ONLY produce text. Offering no tools is the
  // reliable lever here — a forced tool_choice would suppress the text instead,
  // the exact opposite of what a summary turn needs. Weak models (e.g.
  // sensenova-flash-lite / minimax) otherwise keep re-calling the same tool and
  // never write the closing answer ("工具✓ 但没输出").
  if (opts._forceNoTools) toolDefs = undefined;

  // Build structured messages array for adapters that support it
  const structuredMessages = _buildStructuredMessages(fullSystemPrompt, messages);

  // Gateway request watchdogs: abort only when the chain stops making progress.
  // Unlike Promise.race-only timeout, this aborts underlying adapter work so
  // stale streams cannot continue printing after fallback.
  const preferredAdapter = String(
    opts.preferredAdapter !== undefined
      ? opts.preferredAdapter
      : (process.env.GATEWAY_PREFERRED_ADAPTER || '')
  ).trim().toLowerCase();
  // Detect if a local adapter will be used: either user explicitly preferred it,
  // or the gateway's first available adapter is local (localLLM/ollama).
  let isLocalPreferredAdapter = preferredAdapter === 'localllm' || preferredAdapter === 'ollama';
  if (!isLocalPreferredAdapter && !preferredAdapter) {
    try {
      const firstAvailable = gw.getFirstAvailableAdapter?.();
      if (firstAvailable && (firstAvailable === 'localLLM' || firstAvailable === 'ollama')) {
        isLocalPreferredAdapter = true;
      }
    } catch { /* best effort */ }
  }
  let localLLMStatus = null;
  let localHotAttached = false;
  if (isLocalPreferredAdapter && preferredAdapter !== 'ollama') {
    try {
      const localLLMService = require('../services/localLLMService');
      if (localLLMService && typeof localLLMService.tryAdoptHotRunner === 'function') {
        const adopted = await localLLMService.tryAdoptHotRunner();
        localHotAttached = !!(adopted && adopted.adopted);
      }
      if (localLLMService && typeof localLLMService.getStatus === 'function') {
        localLLMStatus = localLLMService.getStatus();
      }
    } catch { /* best effort */ }
  }

  const defaultStallTimeoutMs = isLocalPreferredAdapter ? 240000 : 300000;
  let GATEWAY_STALL_TIMEOUT_MS = parseInt(
    process.env.KHY_GATEWAY_STALL_TIMEOUT_MS
    || process.env.KHY_GATEWAY_TIMEOUT_MS
    || String(defaultStallTimeoutMs),
    10
  );
  const allowShortLocalHard = String(process.env.KHY_LOCAL_ALLOW_SHORT_HARD_TIMEOUT || 'false').toLowerCase() === 'true';
  let hardTimeoutAutoRaised = false;
  if (isLocalPreferredAdapter && !allowShortLocalHard) {
    const warmMinHardTimeoutMs = Math.max(
      30000,
      parseInt(process.env.KHY_LOCAL_MIN_HARD_TIMEOUT_MS || '120000', 10) || 120000
    );
    const coldMinHardTimeoutMs = Math.max(
      warmMinHardTimeoutMs,
      parseInt(process.env.KHY_LOCAL_COLD_HARD_TIMEOUT_MS || '180000', 10) || 180000
    );
    const degradedMinHardTimeoutMs = Math.max(
      coldMinHardTimeoutMs,
      parseInt(process.env.KHY_LOCAL_DEGRADED_HARD_TIMEOUT_MS || '210000', 10) || 210000
    );
    const minRequiredStallTimeoutMs = localLLMStatus?.lastError
      ? degradedMinHardTimeoutMs
      : (localLLMStatus && localLLMStatus.available && !localLLMStatus.loaded
        ? coldMinHardTimeoutMs
        : warmMinHardTimeoutMs);
    if (GATEWAY_STALL_TIMEOUT_MS < minRequiredStallTimeoutMs) {
      GATEWAY_STALL_TIMEOUT_MS = minRequiredStallTimeoutMs;
      hardTimeoutAutoRaised = true;
    }
  }
  const defaultIdleTimeoutMs = isLocalPreferredAdapter
    ? Math.min(120000, Math.max(0, GATEWAY_STALL_TIMEOUT_MS - 10000))
    : Math.min(45000, Math.max(0, GATEWAY_STALL_TIMEOUT_MS - 5000));
  const configuredIdleTimeoutMs = Math.max(
    0,
    parseInt(
      process.env.KHY_GATEWAY_IDLE_TIMEOUT_MS
      || String(defaultIdleTimeoutMs),
      10
    )
  );
  const allowShortLocalIdle = String(process.env.KHY_LOCAL_ALLOW_SHORT_IDLE || 'false').toLowerCase() === 'true';
  const baseMinLocalIdleTimeoutMs = Math.max(
    10000,
    parseInt(process.env.KHY_LOCAL_MIN_IDLE_TIMEOUT_MS || '30000', 10) || 30000
  );
  let minLocalIdleTimeoutMs = baseMinLocalIdleTimeoutMs;
  if (isLocalPreferredAdapter && !allowShortLocalIdle) {
    const coldMinIdleTimeoutMs = Math.max(
      minLocalIdleTimeoutMs,
      parseInt(process.env.KHY_LOCAL_COLD_IDLE_TIMEOUT_MS || '90000', 10) || 90000
    );
    const degradedMinIdleTimeoutMs = Math.max(
      coldMinIdleTimeoutMs,
      parseInt(process.env.KHY_LOCAL_DEGRADED_IDLE_TIMEOUT_MS || '120000', 10) || 120000
    );
    if (localLLMStatus?.lastError) {
      minLocalIdleTimeoutMs = degradedMinIdleTimeoutMs;
    } else if (localLLMStatus && localLLMStatus.available && !localLLMStatus.loaded) {
      minLocalIdleTimeoutMs = coldMinIdleTimeoutMs;
    }
  }
  let GATEWAY_IDLE_TIMEOUT_MS = isLocalPreferredAdapter && !allowShortLocalIdle && configuredIdleTimeoutMs > 0
    ? Math.min(
      Math.max(0, GATEWAY_STALL_TIMEOUT_MS - 5000),
      Math.max(configuredIdleTimeoutMs, minLocalIdleTimeoutMs)
    )
    : configuredIdleTimeoutMs;
  if (
    isLocalPreferredAdapter
    && configuredIdleTimeoutMs > 0
    && GATEWAY_IDLE_TIMEOUT_MS > configuredIdleTimeoutMs
    && typeof opts.onStatus === 'function'
  ) {
    try {
      opts.onStatus({
        phase: 'request',
        message: `检测到本地通道 idle 超时配置过短，已自动调整为 ${Math.round(GATEWAY_IDLE_TIMEOUT_MS / 1000)}s 以提升稳定性。`,
      });
    } catch { /* best effort */ }
  }
  if (hardTimeoutAutoRaised && typeof opts.onStatus === 'function') {
    try {
      opts.onStatus({
        phase: 'request',
        message: `检测到本地通道链路停滞超时配置过短，已自动调整为 ${Math.round(GATEWAY_STALL_TIMEOUT_MS / 1000)}s 以提升稳定性。`,
      });
    } catch { /* best effort */ }
  }

  // Optional stability multiplier (used by recovery retry paths).
  const stabilityTimeoutMultiplierRaw = Number(
    opts._stabilityTimeoutMultiplier
      || process.env.KHY_GATEWAY_STABILITY_TIMEOUT_MULTIPLIER
      || 1
  );
  const stabilityTimeoutMultiplier = Number.isFinite(stabilityTimeoutMultiplierRaw)
    ? Math.max(1, Math.min(3, stabilityTimeoutMultiplierRaw))
    : 1;
  if (stabilityTimeoutMultiplier > 1) {
    GATEWAY_STALL_TIMEOUT_MS = Math.round(GATEWAY_STALL_TIMEOUT_MS * stabilityTimeoutMultiplier);
    if (GATEWAY_IDLE_TIMEOUT_MS > 0) {
      GATEWAY_IDLE_TIMEOUT_MS = Math.min(
        Math.max(1000, Math.round(GATEWAY_IDLE_TIMEOUT_MS * stabilityTimeoutMultiplier)),
        Math.max(0, GATEWAY_STALL_TIMEOUT_MS - 1000),
      );
    }
    if (typeof opts.onStatus === 'function') {
      try {
        opts.onStatus({
          phase: 'request',
          message: `稳定性重试已放宽链路停滞窗口 ×${stabilityTimeoutMultiplier.toFixed(2)}（stall ${Math.round(GATEWAY_STALL_TIMEOUT_MS / 1000)}s）`,
        });
      } catch { /* best effort */ }
    }
  }

  const abortController = new AbortController();
  let settled = false;
  let lastActivityTs = Date.now();
  let lastHeartbeatSec = -1;
  let localWarmupStage = -1;
  const localWarmupLabel = preferredAdapter === 'ollama' ? 'Ollama' : '本地模型';
  if (localHotAttached && typeof opts.onStatus === 'function') {
    try {
      opts.onStatus({
        phase: 'request',
        message: `${localWarmupLabel} 检测到热启动状态，已直接复用已加载引擎。`,
      });
    } catch { /* best effort */ }
  }
  const localWarmupStages = [
    { sec: 8, message: `${localWarmupLabel} 预热中：首次加载模型约需 30-120 秒（取决于模型大小和硬件）` },
    { sec: 20, message: `${localWarmupLabel} 正在加载模型与上下文，仍在运行...` },
    { sec: 45, message: `${localWarmupLabel} 仍在推理中；若为首次运行，这个耗时是常见现象。` },
  ];

  const markActivity = () => {
    lastActivityTs = Date.now();
  };

  const guardCallback = (fn, { mark = true } = {}) => {
    if (typeof fn !== 'function') return undefined;
    return (...args) => {
      if (settled) return undefined;
      if (mark) markActivity();
      return fn(...args);
    };
  };

  const resolvedMaxTokens = _resolveLocalPreferredMaxTokens(effortPreset.maxTokens, {
    isLocalPreferredAdapter,
    preferredAdapter,
    localLLMStatus,
    isThinkingModel: _isLocalThinkingModel(opts.preferredModel),
  });
  if (resolvedMaxTokens.capped && typeof opts.onStatus === 'function') {
    try {
      const capLabel = preferredAdapter === 'ollama' ? 'Ollama' : '本地模型';
      opts.onStatus({
        phase: 'request',
        message: `${capLabel} 已启用快速响应上限：maxTokens ${effortPreset.maxTokens} -> ${resolvedMaxTokens.maxTokens}`,
      });
    } catch { /* best effort */ }
  }

  const activeRequestId = _registerActiveGatewayRequest(abortController, {
    adapter: opts.preferredAdapter || preferredAdapter,
  });
  let generatePromise;
  try {
    generatePromise = gw.generate(conversationPrompt, {
      temperature: runtime.lockTemperature(userMessage),
      top_p: lockedTopP,
      maxTokens: resolvedMaxTokens.maxTokens,
      taskScale: opts.taskScale,
      sessionId: opts.sessionId,
      requestId: opts.requestId,
      _diagTraceId: opts._diagTraceId,
      strictPreferred: opts.strictPreferred,
      preferredAdapter: opts.preferredAdapter,
      preferredModel: opts.preferredModel,
      preferredStrict: opts.preferredStrict,
      _intentDirective: opts._intentDirective,
      userMessage,
      onChunk: guardCallback(opts.onChunk, { mark: true }),
      onControlRequest: guardCallback(opts.onControlRequest, { mark: true }),
      onFallback: guardCallback(opts.onFallback, { mark: true }),
      onWait: guardCallback(opts.onWait, { mark: true }),
      images: opts.images,
      system: fullSystemPrompt,
      messages,
      tools: toolDefs,
      structuredMessages,
      // /thinking controls the request, not just display: when off we send no
      // thinking budget and flag thinkingEnabled:false so native-thinking models
      // (Claude) skip extended_thinking and we pay no reasoning cost.
      thinking: _chatState.thinkingEnabled ? (effortPreset.thinking || undefined) : undefined,
      thinkingEnabled: _chatState.thinkingEnabled,
      abortSignal: abortController.signal,
    });
  } catch (err) {
    _unregisterActiveGatewayRequest(activeRequestId);
    throw err;
  }

  return new Promise((resolve, reject) => {
    let stallWatchdog = null;
    let idlePoll = null;
    const clearTimers = () => {
      if (stallWatchdog) clearInterval(stallWatchdog);
      stallWatchdog = null;
      if (idlePoll) clearInterval(idlePoll);
      idlePoll = null;
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      _unregisterActiveGatewayRequest(activeRequestId);
      clearTimers();
      fn(value);
    };

    const abortAndReject = (message) => {
      const err = message instanceof Error ? message : new Error(String(message || 'AI gateway aborted'));
      if (!abortController.signal.aborted) {
        try { abortController.abort(err); } catch { /* ignore */ }
      }
      finish(reject, err);
    };

    stallWatchdog = setInterval(() => {
      if (settled) return;
      const now = Date.now();
      const silentFor = now - lastActivityTs;
      if (silentFor >= GATEWAY_STALL_TIMEOUT_MS) {
        abortAndReject(new Error(`AI 网关链路停滞超时：已 ${Math.round(GATEWAY_STALL_TIMEOUT_MS / 1000)}s 无活动，所有适配器均未推进`));
        return;
      }
    }, 1000);
    stallWatchdog.unref?.();

    if (GATEWAY_IDLE_TIMEOUT_MS > 0 && GATEWAY_IDLE_TIMEOUT_MS < GATEWAY_STALL_TIMEOUT_MS) {
      idlePoll = setInterval(() => {
        if (settled) return;
        const idleFor = Date.now() - lastActivityTs;
        const idleSec = Math.floor(idleFor / 1000);
        if (idleSec >= 8 && typeof opts.onStatus === 'function') {
          if (isLocalPreferredAdapter) {
            while (
              localWarmupStage + 1 < localWarmupStages.length
              && idleSec >= localWarmupStages[localWarmupStage + 1].sec
            ) {
              localWarmupStage += 1;
              try {
                opts.onStatus({
                  phase: 'request',
                  message: localWarmupStages[localWarmupStage].message,
                  elapsed: idleFor,
                });
              } catch { /* best effort */ }
            }
          }

          const heartbeatStep = isLocalPreferredAdapter ? 3 : 5;
          const bucket = Math.floor(idleSec / heartbeatStep);
          if (bucket !== lastHeartbeatSec) {
            lastHeartbeatSec = bucket;
            try {
              opts.onStatus({
                phase: 'request',
                message: isLocalPreferredAdapter
                  ? `请求本地模型 | 阶段: 模型预热或推理等待 | 目标: ${localWarmupLabel} | 进度: 已 ${idleSec}s 未收到新输出 | 已耗时: ${idleSec}s`
                  : `请求上游模型 | 阶段: 等待模型响应 | 目标: AI 网关 | 进度: 已 ${idleSec}s 未收到新输出 | 已耗时: ${idleSec}s`,
                elapsed: idleFor,
              });
            } catch { /* best effort */ }
          }
        }
        if (idleFor >= GATEWAY_IDLE_TIMEOUT_MS) {
          const idleTimeoutSec = Math.round(GATEWAY_IDLE_TIMEOUT_MS / 1000);
          const idleTimeoutHint = isLocalPreferredAdapter
            ? '（本地模型可能仍在预热中）'
            : '';
          abortAndReject(new Error(`AI 网关空闲超时：${idleTimeoutSec} 秒，流已停滞${idleTimeoutHint}`));
        }
      }, 1000);
      idlePoll.unref?.();
    }

    generatePromise
      .then((result) => finish(resolve, result))
      .catch((err) => finish(reject, err));
  });
}

async function _preflightGatewayAvailability(options = {}) {
  if (_chatState.gatewayPreflightDone) return;
  if (_chatState.gatewayPreflightInFlight) return _chatState.gatewayPreflightInFlight;
  _chatState.gatewayPreflightInFlight = (async () => {
    const gw = getGateway();
    const runtimeIsKhy = String(process.env.KHY_RUNTIME_MODE || '').trim().toLowerCase() === 'khy';
    if (!gw._initialized) await gw.init();
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const maxBudgetMs = Math.max(
      600,
      parseInt(process.env.KHY_PREFLIGHT_MAX_MS || (runtimeIsKhy ? '1800' : '6000'), 10)
    );
    const adapterProbeTimeoutMs = Math.max(
      600,
      parseInt(process.env.KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS || (runtimeIsKhy ? '900' : '3000'), 10)
    );
    const maxAutoCandidates = Math.max(
      1,
      parseInt(process.env.KHY_PREFLIGHT_MAX_CANDIDATES || (runtimeIsKhy ? '2' : '3'), 10)
    );
    const startedAt = Date.now();

    const testAdapterQuickly = async (adapterKey) => {
      try {
        return await Promise.race([
          gw.testAdapter(adapterKey, { quick: true, timeoutMs: adapterProbeTimeoutMs }),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), adapterProbeTimeoutMs + 120);
            if (t.unref) t.unref();
          }),
        ]);
      } catch {
        return null;
      }
    };

    // If caller already selected a preferred adapter, test its live connectivity once.
    const preferred = String(
      options.preferredAdapter !== undefined
        ? options.preferredAdapter
        : (process.env.GATEWAY_PREFERRED_ADAPTER || '')
    ).trim();
    if (preferred && preferred !== 'auto') {
      if (onProgress) onProgress(`预检首选通道: ${preferred}`);
      const probe = await testAdapterQuickly(preferred);
      const connectivityOk = !!probe?.connectivity?.success;
      const generationOk = probe?.generation ? !!probe.generation.success : true;
      const modelsOk = probe?.models ? !!probe.models.success : true;
      // Respect explicit user selection: do not silently rewrite preferred adapter
      // during preflight. If probe fails, keep current preference and let strict
      // execution return a clear error instead of auto-switching to another path.
      if (connectivityOk && generationOk && modelsOk) return;
      return;
    }

    // Auto-pick first operational adapter, skip relay-like adapters for chat by default.
    const statuses = gw.getStatus().filter(s => s.enabled && s.available).slice(0, maxAutoCandidates);
    for (const s of statuses) {
      if (Date.now() - startedAt >= maxBudgetMs) break;
      if (['relay', 'relay_api', 'clipboard'].includes(s.type)) continue;
      if (onProgress) onProgress(`预检通道: ${s.type}`);
      const probe = await testAdapterQuickly(s.type);
      const connectivityOk = !!probe?.connectivity?.success;
      const generationOk = probe?.generation ? !!probe.generation.success : true;
      const modelsOk = probe?.models ? !!probe.models.success : true;
      if (connectivityOk && generationOk && modelsOk) {
        process.env.GATEWAY_PREFERRED_ADAPTER = s.type;
        process.env.GATEWAY_PREFERRED_STRICT = 'true';
        try { gw.setActiveChannel(s.type); } catch { /* lifecycle reconcile is best-effort */ }
        return;
      }
    }
  })();
  try {
    await _chatState.gatewayPreflightInFlight;
  } finally {
    _chatState.gatewayPreflightDone = true;
    _chatState.gatewayPreflightInFlight = null;
  }
}

function _isStrictPreferredFailure(result) {
  if (!result || result.success) return false;
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
  if (!result || result.success) return false;
  const errorType = String(result.errorType || '').toLowerCase();
  if (errorType === 'context_length' || errorType === 'context_overflow' || errorType === 'payload_too_large') {
    return true;
  }
  try {
    const { classifyError } = require('../services/errorClassifier');
    const status = result.statusCode || result.status || 0;
    const message = String(result.content || result.error || result.errorType || '');
    return classifyError(status, message).shouldCompress === true;
  } catch {
    const message = String(result.content || result.error || '').toLowerCase();
    return /prompt[_\s-]?too[_\s-]?long|context[_\s-]?length|too many tokens|maximum context/.test(message);
  }
}

function _shouldKeepStrictPreferred(opts = {}) {
  if (opts.strictPreferred === true) return true;
  if (opts.strictPreferred === false) return false;
  const preferredStrictRaw = opts.preferredStrict !== undefined
    ? opts.preferredStrict
    : process.env.GATEWAY_PREFERRED_STRICT;
  if (String(preferredStrictRaw).toLowerCase() === 'false') return false;
  const preferred = String(
    opts.preferredAdapter !== undefined
      ? opts.preferredAdapter
      : (process.env.GATEWAY_PREFERRED_ADAPTER || '')
  ).trim();
  return !!(preferred && preferred !== 'auto');
}

function _isStrictPreferredEnabled(opts = {}) {
  return _shouldKeepStrictPreferred(opts);
}

// Gateway generation helpers (tool-fallback reply, tool-result salvage/plan/work-summary/progress
// label, natural tool-call idle-timeout runner, gateway failure formatting, direct generation, and
// task-self-awareness gating) extracted to a sibling module (aiGatewayGenerateHelpers.js). Host
// callers re-import them by the same names; the moved bodies reference host trace/logging accessors
// + getService, injected below (all hoisted function declarations, so the setter is load-safe).
const {
  _buildToolFallbackReply, _salvageRecentToolResult, _extractPlan, _buildWorkSummary, _toolProgressLabel,
  _runNaturalToolCallWithIdleTimeout, _formatGatewayFailureDetails, _directGenerate,
  _shouldInjectTaskSelfAwareness, setAiGatewayGenerateHelpersDeps,
} = require('./aiGatewayGenerateHelpers');

function _buildTaskSelfAwarenessPrompt(userMessage = '', opts = {}) {
  try {
    const scale = _resolveTaskScale(userMessage, opts);
    const runtimeMeta = _getStudyModeRuntimeMeta(opts.preferredAdapter, opts.preferredModel);
    const effort = String(opts.effort || _chatState.currentEffort || 'medium').trim();
    const { getSelfAwarenessProfile } = require('../services/knowledgeTeachingService');
    const profile = getSelfAwarenessProfile({
      studyMode: _chatState.studyMode,
      adapter: runtimeMeta.adapter,
      model: runtimeMeta.model,
      effort,
    });

    const modelCheck = checkModelCapability(userMessage);
    const caps = Array.isArray(profile.capabilities) ? profile.capabilities.slice(0, 4) : [];
    const limits = Array.isArray(profile.boundaries) ? profile.boundaries.slice(0, 4) : [];
    const capsBlock = caps.map((s, i) => `${i + 1}. ${s}`).join('\n') || '1. 按当前配置执行标准任务。';
    const limitsBlock = limits.map((s, i) => `${i + 1}. ${s}`).join('\n') || '1. 未检出显著边界风险。';

    const modelRisk = modelCheck && Array.isArray(modelCheck.issues) && modelCheck.issues.length > 0
      ? modelCheck.issues.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '1. 当前模型能力未检出明显短板。';
    const modelSuggest = modelCheck && Array.isArray(modelCheck.recommendations) && modelCheck.recommendations.length > 0
      ? modelCheck.recommendations.map((r, i) => `${i + 1}. ${r.label || r.key}`).join('\n')
      : '1. 保持当前模型并优先分步执行。';

    return [
      '### KHY_TASK_SELF_AWARENESS_GUIDE',
      '你在执行任务前必须先做能力自检，并将自检结果用于执行策略。',
      '',
      '执行规范:',
      '1) 先写明本轮任务目标与完成标准。',
      '2) 输出“已知/假设/未知”，未知项不得伪装为确定事实。',
      '3) 若能力或上下文不足，优先拆分任务并先完成可验证子任务。',
      '4) 回答必须包含可验证结果（检查点、命令输出摘要或证据）。',
      '',
      `任务规模: ${scale}`,
      `当前通道: ${profile.runtime?.adapter || 'auto'} / ${profile.runtime?.model || 'auto'} / effort=${effort}`,
      '',
      '可用能力:',
      capsBlock,
      '',
      '能力边界:',
      limitsBlock,
      '',
      '模型风险自检:',
      modelRisk,
      '',
      '模型改进建议:',
      modelSuggest,
    ].join('\n');
  } catch {
    return '';
  }
}

function _taskGuardHardModeEnabled() {
  const raw = String(process.env.KHY_TASK_SELF_AWARENESS_HARD || 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'n'].includes(raw);
}

function _taskGuardTtlMs() {
  const raw = parseInt(String(process.env.KHY_TASK_SELF_AWARENESS_HARD_TTL_MS || '900000'), 10);
  if (!Number.isFinite(raw) || raw <= 0) return 900000;
  return Math.max(30000, Math.min(24 * 60 * 60 * 1000, raw));
}

function _expirePendingTaskGuard() {
  if (!_chatState.pendingTaskGuard) return;
  if (Date.now() >= Number(_chatState.pendingTaskGuard.expiresAt || 0)) {
    _chatState.pendingTaskGuard = null;
  }
}

function _createTaskGuardId() {
  return `tg-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}

// Detect short continuation commands: "继续", "go on", "continue", etc.
// Single source: services/query/continuation.js (lifted here to avoid regex drift).
const {
  isContinuationCommand: _isContinuationCommand,
  isResumableError: _isResumableError,
  CONTINUE_HINT: _CONTINUE_HINT,
} = require('../services/query/continuation');

function _parseTaskGuardCommand(input = '') {
  const text = String(input || '').trim();
  if (!text) return { confirm: false, cancel: false, id: '' };

  const confirmMatch = text.match(/^(?:确认执行|继续执行|确认|confirm|approve|yes)(?:\s+([a-z0-9-]+))?$/i);
  if (confirmMatch) {
    return { confirm: true, cancel: false, id: String(confirmMatch[1] || '').trim().toLowerCase() };
  }

  const cancelMatch = text.match(/^(?:取消执行|取消|cancel|abort)(?:\s+([a-z0-9-]+))?$/i);
  if (cancelMatch) {
    return { confirm: false, cancel: true, id: String(cancelMatch[1] || '').trim().toLowerCase() };
  }

  return { confirm: false, cancel: false, id: '' };
}

function _buildHardGuardPlan(userMessage = '', hardIssues = [], recommendations = []) {
  const taskSummary = String(userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '当前任务';
  const issues = (hardIssues || []).slice(0, 3).map((x, i) => `${i + 1}. ${x}`).join('\n') || '1. 未识别到硬性风险。';
  const recs = (recommendations || []).slice(0, 3).map((r, i) => `${i + 1}. ${r.label || r.key || '保持当前模型分步执行'}`).join('\n') || '1. 保持当前模型并严格分步验证。';

  return [
    `目标: 完成「${taskSummary}」并保持结果可验证`,
    '步骤:',
    '1. 锁定验收标准：先明确交付物、边界条件和失败定义。',
    '2. 缩小风险面：优先选择更匹配模型或把任务拆成可独立验证的小步骤。',
    '3. 先做最小可验证子任务，给出证据后再扩展。',
    '4. 每一步输出“已知/假设/未知”，避免伪确定性。',
    '',
    '当前能力风险:',
    issues,
    '',
    '建议通道/模型调整:',
    recs,
  ].join('\n');
}

function _resolveHardTaskGuard(userMessage = '', opts = {}) {
  _expirePendingTaskGuard();
  const parsedCommand = _parseTaskGuardCommand(userMessage);

  if (_chatState.pendingTaskGuard) {
    const expectedId = String(_chatState.pendingTaskGuard.id || '').toLowerCase();
    const matchesId = !parsedCommand.id || parsedCommand.id === expectedId;

    if (parsedCommand.cancel) {
      if (matchesId) {
        const oldId = _chatState.pendingTaskGuard.id;
        _chatState.pendingTaskGuard = null;
        return {
          action: 'cancelled',
          reply: `已取消受限任务（${oldId}）。如需重新执行，请重新描述任务。`,
        };
      }
      return {
        action: 'blocked',
        reply: `取消口令不匹配。当前待确认任务: ${expectedId}\n请使用: 取消执行 ${expectedId}`,
      };
    }

    if (parsedCommand.confirm) {
      if (matchesId) {
        const pending = _chatState.pendingTaskGuard;
        _chatState.pendingTaskGuard = null;
        return {
          action: 'confirmed',
          replayMessage: pending.originalUserMessage,
          guardId: pending.id,
        };
      }
      return {
        action: 'blocked',
        reply: `确认口令不匹配。当前待确认任务: ${expectedId}\n请使用: 确认执行 ${expectedId}`,
      };
    }
  }

  if (!_taskGuardHardModeEnabled()) return { action: 'none' };
  if (opts._taskGuardConfirmed || opts.disableHardTaskGuard) return { action: 'none' };

  const text = String(userMessage || '').trim();
  if (!text) return { action: 'none' };

  const scale = _resolveTaskScale(text, opts);
  if (scale === 'small' && !/实现|重构|修复|改造|端到端|完整|full|implement|refactor|fix/i.test(text)) {
    return { action: 'none' };
  }

  const modelCheck = checkModelCapability(text);
  if (!modelCheck || !Array.isArray(modelCheck.issues) || modelCheck.issues.length === 0) {
    return { action: 'none' };
  }

  const hardIssues = modelCheck.issues.filter((issue) => !/(上下文可能不够|context)/i.test(String(issue || '')));
  if (hardIssues.length === 0) return { action: 'none' };

  const hardMin = Math.max(1, parseInt(String(process.env.KHY_TASK_GUARD_HARD_ISSUES_MIN || '2'), 10) || 2);
  const complexMinIssues = Math.max(1, parseInt(String(process.env.KHY_TASK_GUARD_COMPLEX_ISSUES_MIN || '1'), 10) || 1);
  const complexMinChars = Math.max(80, parseInt(String(process.env.KHY_TASK_GUARD_COMPLEX_MIN_CHARS || '160'), 10) || 160);
  const isComplex = scale === 'large' || text.length >= complexMinChars;
  const shouldBlock = hardIssues.length >= hardMin || (isComplex && hardIssues.length >= complexMinIssues);
  if (!shouldBlock) return { action: 'none' };

  const guardId = _createTaskGuardId();
  const expiresAt = Date.now() + _taskGuardTtlMs();
  const plan = _buildHardGuardPlan(text, hardIssues, modelCheck.recommendations || []);
  _chatState.pendingTaskGuard = {
    id: guardId,
    createdAt: Date.now(),
    expiresAt,
    originalUserMessage: text,
    issues: hardIssues,
    recommendations: Array.isArray(modelCheck.recommendations) ? modelCheck.recommendations : [],
    scale,
    plan,
  };

  const expireSec = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  const reply = [
    `能力硬约束触发（任务ID: ${guardId}）`,
    '原因: 当前任务需求与模型能力存在高风险不匹配，已暂停自动执行。',
    '',
    plan,
    '',
    `确认执行（将在约 ${expireSec}s 后过期）: 确认执行 ${guardId}`,
    `取消任务: 取消执行 ${guardId}`,
  ].join('\n');

  return {
    action: 'blocked',
    reply,
    guardId,
    scale,
  };
}

function _resolveGatewayRecoveryRetries(opts = {}) {
  const explicit = parseInt(String(opts._gatewayRecoveryRetries ?? ''), 10);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(3, explicit));
  const scale = String(opts.taskScale || '').trim().toLowerCase();
  if (scale === 'small') {
    const parsedSmall = parseInt(String(process.env.KHY_GATEWAY_RECOVERY_RETRIES_SMALL || '1'), 10);
    return Number.isFinite(parsedSmall) ? Math.max(0, Math.min(2, parsedSmall)) : 1;
  }
  if (scale === 'large') {
    const parsedLarge = parseInt(String(process.env.KHY_GATEWAY_RECOVERY_RETRIES_LARGE || '2'), 10);
    return Number.isFinite(parsedLarge) ? Math.max(0, Math.min(3, parsedLarge)) : 2;
  }
  const parsed = parseInt(String(process.env.KHY_GATEWAY_RECOVERY_RETRIES || '1'), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return Math.min(3, parsed);
}

function _resolveGatewayRecoveryDelayMs(attemptIndex = 0) {
  const base = Math.max(300, parseInt(String(process.env.KHY_GATEWAY_RECOVERY_BASE_DELAY_MS || '1200'), 10) || 1200);
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
async function _waitGatewayRecoveryWithCountdown(onStatus, { errType, attempt, maxAttempts, waitMs }) {
  const emit = (remainingMs) => {
    if (typeof onStatus !== 'function') return;
    let message;
    try {
      const rc = require('./retryCountdown');
      message = rc.buildRetryStatusMessage({ errType, attempt, maxAttempts, remainingMs });
    } catch {
      // Leaf unavailable → fall back to the exact legacy static string.
      message = `网关连接波动（${errType}），正在进行稳定性重试 ${attempt}/${maxAttempts}...`;
    }
    try { onStatus({ phase: 'request', message }); } catch { /* best effort */ }
  };

  let enabled = false;
  try { enabled = require('./retryCountdown').isRetryCountdownEnabled(process.env); } catch { enabled = false; }

  if (!enabled) {
    // Legacy path: one static status, then blind wait (byte-identical to before).
    emit(waitMs);
    await new Promise(r => setTimeout(r, waitMs));
    return;
  }

  // Countdown path: re-emit the status roughly once per second toward 0.
  const started = Date.now();
  emit(waitMs);
  let remaining = waitMs;
  while (remaining > 0) {
    const tick = Math.min(1000, remaining);
    await new Promise(r => setTimeout(r, tick));
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
  try { rl = require('./rateLimitRetry'); } catch { rl = null; }
  const emit = (remainingMs) => {
    if (typeof onStatus !== 'function') return;
    let message;
    try {
      message = rl
        ? rl.buildRetryStatusMessage({ round, maxRounds, remainingMs, env: process.env })
        : `API 限流(429)，正在自动重试（第 ${round}/${maxRounds} 轮）...`;
    } catch {
      message = `API 限流(429)，正在自动重试（第 ${round}/${maxRounds} 轮）...`;
    }
    try { onStatus({ phase: 'request', message }); } catch { /* best effort */ }
  };

  const started = Date.now();
  emit(waitMs);
  let remaining = waitMs;
  while (remaining > 0) {
    const tick = Math.min(1000, remaining);
    await new Promise(r => setTimeout(r, tick));
    remaining = waitMs - (Date.now() - started);
    emit(remaining > 0 ? remaining : 0);
  }
}


async function _generateWithStreamIntercept(conversationPrompt, fullSystemPrompt, messages, userMessage, opts, preset) {
  const interceptor = _createStreamToolInterceptor(opts.onChunk, {
    suppressPrefixOnToolCall: opts.suppressPrefixOnToolCall === true,
    routeToolPrefaceToNarration: opts.routeToolPrefaceToNarration === true,
    streamingExecutor: opts._streamingExecutor || null, // Phase 7
  });
  // Wrap onFallback to clear interceptor pending buffer when adapter
  // switches, preventing duplicate text from the failed adapter's partial
  // stream being flushed alongside the successful adapter's full stream.
  const wrappedOnFallback = typeof opts.onFallback === 'function'
    ? (...args) => { interceptor.reset(); return opts.onFallback(...args); }
    : opts.onFallback;
  const wrappedOpts = { ...opts, onChunk: interceptor.onChunk, onFallback: wrappedOnFallback };

  let result;
  try {
    result = await _gatewayGenerate(conversationPrompt, fullSystemPrompt, messages, userMessage, wrappedOpts, preset);
  } catch (err) {
    let gatewayErr = String(err && err.message ? err.message : err || 'unknown gateway error')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
    let gatewayErrType = _classifyGatewayThrownError(err);

    // Stability recovery: transient failures get one (configurable) retry round.
    const recoveryRetries = _resolveGatewayRecoveryRetries(wrappedOpts);
    const alreadyRetried = !!wrappedOpts._gatewayRecoveryRetried;
    const canRecover = recoveryRetries > 0 && !alreadyRetried && _isTransientGatewayErrorType(gatewayErrType);
    if (canRecover) {
      const relaxStrict = String(process.env.KHY_GATEWAY_RECOVERY_RELAX_STRICT || 'true').toLowerCase() !== 'false';
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
            _stabilityTimeoutMultiplier: 1.25 + (retryIdx * 0.35),
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
          gatewayErr = String(retryErr && retryErr.message ? retryErr.message : retryErr || gatewayErr)
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
        : (process.env.GATEWAY_PREFERRED_ADAPTER || '')
    ).trim().toLowerCase();
    const skipDirectFallback = strictPreferred
      && preferred
      && preferred !== 'auto'
      && (gatewayErrType === 'timeout' || gatewayErrType === 'cancelled');

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
          const fallbackMsg = (result && result.content) ? String(result.content) : '所有 AI 通道不可用。';
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

async function chat(userMessage, opts = {}) {
  const startTime = Date.now();
  if (opts && typeof opts === 'object') {
    if (!opts._diagTraceId) {
      const requestIdHint = String(opts.requestId || '').trim();
      opts._diagTraceId = /^[a-f0-9]{32}$/i.test(requestIdHint)
        ? requestIdHint
        : crypto.randomBytes(16).toString('hex');
    }
    if (!opts.requestId) {
      opts.requestId = opts._diagTraceId;
    }
  }
  const onStatus = opts.onStatus || (() => {});
  const runtimeIsKhy = String(process.env.KHY_RUNTIME_MODE || '').trim().toLowerCase() === 'khy';
  const ttftProfile = runtimeIsKhy ? 'khy_chat_interactive' : 'default_chat';
  let firstTokenAt = 0;
  let firstTokenType = '';
  let latencySampleRecorded = false;
  const autoTuneStatusMinGapMs = (() => {
    const fallback = runtimeIsKhy ? 180000 : 300000;
    const parsed = Number.parseInt(String(process.env.KHY_CHAT_AUTOTUNE_STATUS_MIN_GAP_MS || fallback), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(3600000, Math.max(20000, parsed));
  })();

  const _markFirstTokenIfNeeded = (chunk) => {
    if (firstTokenAt > 0) return;
    if (!_isFirstTokenSignalChunk(chunk)) return;
    firstTokenAt = Date.now();
    firstTokenType = String(chunk?.type || '').trim().toLowerCase() || 'unknown';
  };

  const _recordLatencySample = (meta = {}) => {
    if (latencySampleRecorded) return null;
    latencySampleRecorded = true;
    try {
      const tuner = getChatLatencyAutoTuner();
      if (!tuner || typeof tuner.recordChatFirstTokenSample !== 'function') return null;
      const hasSyntheticFirstToken = !!meta.syntheticFirstToken;
      const hasFirstToken = firstTokenAt > 0 || hasSyntheticFirstToken;
      const elapsedMs = hasFirstToken
        ? (firstTokenAt > 0 ? (firstTokenAt - startTime) : Math.max(0, Date.now() - startTime))
        : Math.max(0, Date.now() - startTime);
      return tuner.recordChatFirstTokenSample({
        profile: ttftProfile,
        elapsedMs,
        hasFirstToken,
        success: meta.success !== false,
        adapter: meta.adapter || '',
        errorType: meta.errorType || '',
        firstTokenType,
      });
    } catch {
      return null;
    }
  };

  const _maybeAnnounceAutoTune = (sampleResult) => {
    if (!sampleResult || !sampleResult.tuned) return;
    const preset = String(sampleResult.preset || '').trim().toLowerCase();
    if (!preset) return;
    const profile = String(sampleResult.profile || ttftProfile).trim() || ttftProfile;
    const now = Date.now();
    const changed = preset !== _autoTuneAnnouncement.preset || profile !== _autoTuneAnnouncement.profile;
    if (!changed && (now - _autoTuneAnnouncement.at) < autoTuneStatusMinGapMs) return;
    _autoTuneAnnouncement = { profile, preset, at: now };
    const summary = sampleResult.summary || {};
    const p50 = Math.max(0, Number.parseInt(String(summary.p50 || 0), 10) || 0);
    const p95 = Math.max(0, Number.parseInt(String(summary.p95 || 0), 10) || 0);
    const count = Math.max(0, Number.parseInt(String(summary.count || 0), 10) || 0);
    const failures = Math.max(0, Number.parseInt(String(summary.failureCount || 0), 10) || 0);
    onStatus({
      phase: 'request',
      message: `已自动优化网关参数：档位 ${preset}，首包 P50/P95=${p50}/${p95}ms，失败 ${failures}/${count}`,
      elapsed: now - startTime,
    });
  };

  onStatus({ phase: 'init', message: '初始化...', elapsed: 0 });

  const requestTaskScale = _resolveTaskScale(userMessage, opts);
  const lightweightConversation = _isLightweightConversationInput(userMessage, { scale: requestTaskScale });
  const _autoSaved = _maybeAutoSaveMemory(userMessage);   // deterministic NL memory capture (does not depend on the model)
  // 「写记忆时明确告知用户」:确定性捕获若真写入一条记忆,渲一行 onStatus 告知(此前返回值
  // 被直接丢弃 ⇒ 静默写记忆)。gate KHY_MEMORY_NOTICE 默认开;关闭 ⇒ notice='' ⇒ 不 onStatus
  // (字节回退)。fail-soft:notice 渲染绝不抛。
  try {
    const notice = require('../services/memoryOpsNotice').formatWriteNotice(_autoSaved);
    if (notice) onStatus({ phase: 'init', message: notice, elapsed: Date.now() - startTime });
  } catch { /* notice is best-effort — never breaks the chat flow */ }
  onStatus({
    phase: 'init',
    message: `任务规模识别: ${requestTaskScale}${lightweightConversation ? '（轻量对话，优先首包速度）' : ''}`,
    elapsed: Date.now() - startTime,
  });

  const greetingFastPathEnabled = String(process.env.KHY_GREETING_FASTPATH || 'false').trim().toLowerCase() !== 'false';
  const greetingInput = String(userMessage || '').trim();
  const useGreetingFastPath = greetingFastPathEnabled
    && !_chatState.studyMode
    && !opts._isFollowUp
    && _chatState.messages.length === 0
    && (!Array.isArray(opts.images) || opts.images.length === 0)
    && runtime.isGreeting(greetingInput);
  if (useGreetingFastPath) {
    const traceCtx = _resolveAuditTraceContext(opts);
    onStatus({
      phase: 'init',
      message: '识别到纯问候，启用极速回复（步骤 1/2）',
      elapsed: Date.now() - startTime,
    });
    const reply = _buildGreetingQuickReply(greetingInput);
    _logStandaloneLlmRequest(traceCtx, greetingInput, opts, {
      source: 'ai-fastpath',
      requestedModel: 'khy-fastpath',
      preferredAdapter: 'khy-fastpath',
      localPath: '_buildGreetingQuickReply',
    });
    _chatState.messages.push({ role: 'user', content: greetingInput });
    _chatState.messages.push({ role: 'assistant', content: reply });
    if (_chatState.messages.length > MAX_HISTORY) _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);
    _persistLiveSession();   // greeting fast-path also records to ~/.khy/sessions
    const elapsed = Date.now() - startTime;
    _logStandaloneLlmResponse(traceCtx, {
      success: true,
      content: reply,
      provider: 'khy-fastpath',
      adapter: 'khy-fastpath',
      attempts: [],
      tokenUsage: null,
    }, {
      source: 'ai-fastpath',
      provider: 'khy-fastpath',
      adapter: 'khy-fastpath',
      model: 'khy-fastpath',
      durationMs: elapsed,
      localPath: '_buildGreetingQuickReply',
    });
    onStatus({
      phase: 'summary',
      message: '极速回复已完成（已跳过预检、RAG 与工具链）',
      elapsed,
    });
    onStatus({ phase: 'done', message: '完成', elapsed });
    const tuneResult = _recordLatencySample({
      success: true,
      adapter: 'khy-fastpath',
      errorType: '',
      syntheticFirstToken: true,
    });
    _maybeAnnounceAutoTune(tuneResult);
    return {
      reply,
      thinking: null,
      commands: [],
      provider: 'khy-fastpath',
      adapter: 'khy-fastpath',
      tokenUsage: null,
      toolSummary: null,
      toolCallLog: [],
      toolUseBlocks: [],
      stopReason: 'stop',
      retrieval: null,
      elapsed,
      effort: _chatState.currentEffort,
    };
  }

  // 教学意图分流 (借鉴分析 #5): a teaching statement ("你是…", "绝不…", "以后…")
  // is captured onto the active companion's AgentFS asset instead of entering the
  // tool-use loop. Guarded so plan-step follow-ups and explicit opt-out are exempt.
  const teachGateEnabled = String(process.env.KHY_TEACH_GATE || 'on').trim().toLowerCase() !== 'off';
  const useTeachGate = teachGateEnabled
    && !_chatState.studyMode
    && !opts._isFollowUp
    && (!Array.isArray(opts.images) || opts.images.length === 0);
  if (useTeachGate) {
    let teachDetection = null;
    try {
      const { detectTeaching } = require('../services/intentGate');
      teachDetection = detectTeaching(userMessage);
    } catch { teachDetection = null; }
    if (teachDetection && teachDetection.isTeaching) {
      let capture = { captured: false, reason: 'unavailable' };
      try {
        const { captureTeaching } = require('../services/teachingService');
        capture = captureTeaching({ text: userMessage, detection: teachDetection });
      } catch (e) { capture = { captured: false, reason: 'error', error: e.message }; }

      const TARGET_LABEL = { persona: '人格', principles: '红线原则', memory: '记忆账本' };
      const label = TARGET_LABEL[teachDetection.target] || teachDetection.target;
      let reply;
      if (capture.captured) {
        reply = `已记入当前同伴「${capture.companionId}」的${label}（${capture.asset}）。\n> ${capture.line}`;
      } else if (capture.reason === 'no-active-companion') {
        reply = `识别到这是一条教学（${label}），但当前没有激活的同伴可记入。\n先用 \`companion use <id>\` 激活一个同伴，再教它。`;
      } else {
        reply = `识别到这是一条教学（${label}），但写入失败（${capture.reason || '未知原因'}）。`;
      }

      const traceCtx = _resolveAuditTraceContext(opts);
      onStatus({ phase: 'init', message: `识别到教学意图（${label}），直接记入同伴资产，跳过工具链`, elapsed: Date.now() - startTime });
      _logStandaloneLlmRequest(traceCtx, String(userMessage || ''), opts, {
        source: 'ai-teachgate',
        requestedModel: 'khy-teachgate',
        preferredAdapter: 'khy-teachgate',
        localPath: 'teachingService.captureTeaching',
      });
      _chatState.messages.push({ role: 'user', content: String(userMessage || '') });
      _chatState.messages.push({ role: 'assistant', content: reply });
      if (_chatState.messages.length > MAX_HISTORY) _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);
      _persistLiveSession();
      const elapsed = Date.now() - startTime;
      _logStandaloneLlmResponse(traceCtx, {
        success: true, content: reply, provider: 'khy-teachgate', adapter: 'khy-teachgate', attempts: [], tokenUsage: null,
      }, {
        source: 'ai-teachgate', provider: 'khy-teachgate', adapter: 'khy-teachgate', model: 'khy-teachgate', durationMs: elapsed, localPath: 'teachingService.captureTeaching',
      });
      onStatus({ phase: 'done', message: '完成', elapsed });
      return {
        reply, thinking: null, commands: [], provider: 'khy-teachgate', adapter: 'khy-teachgate',
        tokenUsage: null, toolSummary: null, toolCallLog: [], toolUseBlocks: [], stopReason: 'stop',
        retrieval: null, elapsed, effort: _chatState.currentEffort,
      };
    }
  }

  const taskGuardDecision = _resolveHardTaskGuard(userMessage, opts);
  if (taskGuardDecision.action === 'blocked') {
    onStatus({
      phase: 'init',
      message: '任务硬约束: 已暂停自动执行，等待用户确认（步骤 1/1）',
      elapsed: Date.now() - startTime,
    });
    onStatus({
      phase: 'done',
      message: '等待确认',
      elapsed: Date.now() - startTime,
      ok: false,
      errorType: 'capability_guard',
    });
    return {
      reply: taskGuardDecision.reply,
      commands: [],
      errorType: 'capability_guard',
    };
  }
  if (taskGuardDecision.action === 'cancelled') {
    onStatus({
      phase: 'done',
      message: '已取消受限任务',
      elapsed: Date.now() - startTime,
      ok: true,
    });
    return {
      reply: taskGuardDecision.reply,
      commands: [],
      errorType: 'none',
    };
  }
  if (taskGuardDecision.action === 'confirmed' && taskGuardDecision.replayMessage) {
    userMessage = taskGuardDecision.replayMessage;
    // Mark confirmed so the replay bypasses capability assessment (fix confirm loop bug).
    opts._taskGuardConfirmed = true;
    onStatus({
      phase: 'init',
      message: `任务硬约束确认通过: ${taskGuardDecision.guardId || ''}，开始执行原任务（步骤 1/1）`,
      elapsed: Date.now() - startTime,
    });
  }

  // Snapshot preferred routing at request start to avoid cross-talk when
  // concurrent chats mutate process.env in the same process.
  const requestPreferredAdapter = String(
    opts.preferredAdapter !== undefined
      ? opts.preferredAdapter
      : (process.env.GATEWAY_PREFERRED_ADAPTER || '')
  ).trim();
  let requestPreferredModel = String(
    opts.preferredModel !== undefined
      ? opts.preferredModel
      : (process.env.GATEWAY_PREFERRED_MODEL || '')
  ).trim();
  // /thinking has teeth on DeepSeek: route to the reasoner (R1) when thinking is on
  // so there is a real reasoning_content stream to display+fold, and back to chat
  // (V3) when off to drop the reasoning cost. Only fires when the effective model
  // is a known DeepSeek variant — every other provider is left untouched. The hint
  // falls back to the active adapter's model when the caller did not pin one.
  {
    const deepseekModelHint = requestPreferredModel || (_getModelInfo().model || '');
    const swappedDeepseekModel = _resolveDeepseekThinkingModel(deepseekModelHint, _chatState.thinkingEnabled);
    if (swappedDeepseekModel) requestPreferredModel = swappedDeepseekModel;
  }
  const requestPreferredStrict = opts.preferredStrict !== undefined
    ? opts.preferredStrict
    : (String(process.env.GATEWAY_PREFERRED_STRICT || '').toLowerCase() !== 'false');
  let multimodalInput = {
    images: Array.isArray(opts.images) ? [...opts.images] : [],
    mediaKinds: Array.isArray(opts.images) && opts.images.length > 0 ? ['image'] : [],
    nonImageMedia: [],
    preferredAdapters: [],
    warnings: [],
    promptAugment: '',
    detectedCount: 0,
  };
  try {
    const { prepareMultimodalInput, prepareMultimodalInputAsync } = require('../services/multimodalInputService');
    if (typeof prepareMultimodalInputAsync === 'function') {
      multimodalInput = await prepareMultimodalInputAsync(userMessage, {
        ...opts,
        onStatus,
      });
    } else {
      multimodalInput = prepareMultimodalInput(userMessage, {
        ...opts,
        onStatus,
      });
    }
    const kinds = Array.isArray(multimodalInput.mediaKinds) ? multimodalInput.mediaKinds : [];
    const nonImageCount = Array.isArray(multimodalInput.nonImageMedia) ? multimodalInput.nonImageMedia.length : 0;
    if (kinds.length > 0) {
      onStatus({
        phase: 'init',
        message: `多模态输入检测: ${kinds.join('+')}（media ${Math.max(0, nonImageCount)}/image ${Math.max(0, (multimodalInput.images || []).length)}）`,
        elapsed: Date.now() - startTime,
      });
    }
    if (Array.isArray(multimodalInput.warnings) && multimodalInput.warnings.length > 0) {
      onStatus({
        phase: 'request',
        message: `多模态输入提示: ${String(multimodalInput.warnings[0] || '').slice(0, 160)}`,
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 共享回合感知(单次):intentGate.detectModes(userMessage) 是纯函数,同一 userMessage 多次
  // 调用结果恒等。历史上 multimodalIntentRouter / clarificationCards / promptIntentRepair 三个
  // 叶子各自重复调用一次(3 次)——既是浪费,也让「各叶子各自盲扫」而非共享同一份对本回合的
  // 事实判断。这里收敛为回合开始算一次的 `_turnModes`,传给三个叶子,使它们基于同一份感知决策
  // (更深一层的「贯通」)。逐字节等价:三处原本独立计算的 modes 与此恒同。intentGate 缺失时
  // 回退空数组(与各叶子原本的 try/catch 兜底一致)。
  let _turnModes = [];
  try {
    _turnModes = require('../services/intentGate').detectModes(userMessage).modes || [];
  } catch { /* intentGate optional */ }

  // 多模态意图路由(防混乱):当用户同时给出 文本/图片/音频/视频/khyos 等多路异构输入,
  // 而提示词不清晰时,确定性地分别识别每一路并注入消歧指令,避免模型把各路内容混为一谈或
  // 静默丢弃其中一路。单一真源 multimodalIntentRouter;提示词清晰、单一模态、或意图模式
  // 已明确时不注入(系统提示词字节不变)。门控 KHY_MULTIMODAL_INTENT_ROUTER 默认开。
  let _multimodalIntentDirective = '';
  try {
    const { routeMultimodalIntent } = require('../services/multimodalIntentRouter');
    const _mmDecision = routeMultimodalIntent({
      text: userMessage,
      mediaKinds: Array.isArray(multimodalInput.mediaKinds) ? multimodalInput.mediaKinds : [],
      imageCount: Array.isArray(multimodalInput.images) ? multimodalInput.images.length : 0,
      nonImageMedia: Array.isArray(multimodalInput.nonImageMedia) ? multimodalInput.nonImageMedia : [],
      modes: _turnModes,
      options: opts,
    });
    if (_mmDecision && _mmDecision.directive) {
      _multimodalIntentDirective = _mmDecision.directive;
      onStatus({
        phase: 'init',
        message: `多模态意图识别: ${_mmDecision.inventory.map(c => c.channel).join('+')}(提示词不清,已启用分路消歧·不混淆)`,
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 体察人的惰性:提示词不清晰(纯引用/敷衍动词/空文本+媒体)且无意图模式时,确定性地提示
  // 模型用「选项卡」帮用户把真实需求选出来(多张卡可左右切换·每张可多选·系统自动补「可讨论」
  // 与自由输入)。单一真源 clarificationCards,清晰度判据复用 multimodalIntentRouter。注入
  // 系统提示词而非用户消息;门控 KHY_CLARIFICATION_CARDS 默认开(关闭则 sp 字节不变)。
  let _clarificationDirective = '';
  try {
    const { routeClarification } = require('../services/clarificationCards');
    const _clar = routeClarification({
      text: userMessage,
      hasMedia: Array.isArray(multimodalInput.mediaKinds) && multimodalInput.mediaKinds.length > 0,
      modes: _turnModes,
      options: opts,
    });
    if (_clar && _clar.directive) {
      _clarificationDirective = _clar.directive;
      onStatus({
        phase: 'init',
        message: '提示词不清晰:已启用「选项卡澄清」(多张卡可左右切换·每张可多选·含「可讨论」出口)',
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 奔赴真实意图:提示词「乱」(错别字/漏字/语序颠倒/混入乱码·零宽·控制字符)时,先确定性地
  // 提示模型**自己结合前后文语境做一次善意理解**(纠错→复述意图→直接推进),而非一律反问;
  // 只有关键点经语境仍判不准才落到「选项卡澄清」。单一真源 promptIntentRepair(清晰度判据复用
  // multimodalIntentRouter·意图模式复用 clarificationCards)。注入系统提示词而非用户消息;门控
  // KHY_PROMPT_INTENT_REPAIR 默认开(关闭则 sp 字节不变)。与上面的「选项卡澄清」互补可同时注入。
  let _promptIntentRepairDirective = '';
  try {
    const { routeIntentRepair } = require('../services/promptIntentRepair');
    const _repair = routeIntentRepair({
      text: userMessage,
      hasMedia: Array.isArray(multimodalInput.mediaKinds) && multimodalInput.mediaKinds.length > 0,
      modes: _turnModes,
      options: opts,
    });
    if (_repair && _repair.directive) {
      _promptIntentRepairDirective = _repair.directive;
      onStatus({
        phase: 'init',
        message: '提示词较「乱」:已启用「先结合语境理解·奔赴真实意图」(纠错→复述→推进,关键点才反问)',
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 清理 C/D 盘时把「扫描深度」「颗粒细度」交给用户决定:检测到清盘意图(清理动作+磁盘目标)时,
  // 确定性地提示模型**先用 AskUserQuestion** 把这两个维度做成选项卡让用户选,再据选择给 DiskCleanup
  // 传 maxDepth/granularity。单一真源 diskCleanupClarify(也是「选项→工具参数」的映射真源)。注入系统
  // 提示词;门控 KHY_DISK_CLEANUP_CLARIFY 默认开(关闭则 sp 字节不变)。与「选项卡澄清」正交互补。
  let _diskCleanupClarifyDirective = '';
  try {
    const { routeDiskCleanupClarify } = require('../services/diskCleanupClarify');
    const _dc = routeDiskCleanupClarify({ text: userMessage, options: opts });
    if (_dc && _dc.directive) {
      _diskCleanupClarifyDirective = _dc.directive;
      onStatus({
        phase: 'init',
        message: '检测到清盘意图:已提示先让用户选「扫描深度 + 颗粒细度」再清',
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 抽出错误信号(≥2 条且有修复意图/像日志),在进入修复模式前强制走「枚举模式」三步走
  // (列全部错误→确认覆盖完整性→排序逐个修),并要求收尾自检。KHY 哲学:用代码兜底模型的
  // 不确定性。单一真源 errorEnumerationGuard。注入系统提示词;门控 KHY_ERROR_ENUMERATION
  // 默认开(关闭则 sp 字节不变)。收尾的确定性覆盖回核在 toolUseLoop 侧。
  let _errorEnumerationDirective = '';
  try {
    const { routeErrorEnumeration } = require('../services/errorEnumerationGuard');
    const _ee = routeErrorEnumeration({
      text: userMessage,
      hasMedia: Array.isArray(multimodalInput.mediaKinds) && multimodalInput.mediaKinds.length > 0,
      options: opts,
    });
    if (_ee && _ee.directive) {
      _errorEnumerationDirective = _ee.directive;
      onStatus({
        phase: 'init',
        message: `检测到多错误诊断任务(${_ee.count} 条):先枚举完整错误清单,再逐个修复`,
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 该不该联网搜索:有的任务知识库本就能答(定义/原理/写代码/算数/翻译/创作)不必贸然联网;
  // 反过来时效/实时/显式联网请求又不能凭记忆。确定性三档判定(required/optional/skip),只在
  // required 或 skip 时注入一段系统指令(optional 字节不变),最终是否搜索仍由模型执行。单一真源
  // searchNecessity(时效零漏判复用 searchFreshness)。媒体输入不参与该判定。门控 KHY_SEARCH_NECESSITY 默认开。
  let _searchNecessityDirective = '';
  try {
    const { routeSearchNecessity } = require('../services/search/searchNecessity');
    const _need = routeSearchNecessity({
      text: userMessage,
      hasMedia: Array.isArray(multimodalInput.mediaKinds) && multimodalInput.mediaKinds.length > 0,
    });
    if (_need && _need.directive) {
      _searchNecessityDirective = _need.directive;
      const _kind = _need.assessment && _need.assessment.directiveKind;
      onStatus({
        phase: 'init',
        message: _kind === 'skip'
          ? '搜索必要性:这题大概率知识库可答,已提示优先直接作答(确不确定再联网核实)'
          : '搜索必要性:时效/实时问题,已提示先联网取最新数据再答(务必传 freshness)',
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 地面真值:凡能靠代码确定性算出的绝对真理(算术 / 进制),绝不信任模型心算——用精确有理数
  // (BigInt,零浮点误差)算出真值,注入系统提示词命令模型「直接采用、禁止重算」,结果仍交由
  // 模型表达 / 应用。单一真源 groundTruth。门控 KHY_GROUND_TRUTH 默认开。
  let _groundTruthDirective = '';
  try {
    const { routeGroundTruth } = require('../services/groundTruth');
    const _gt = routeGroundTruth({ text: userMessage });
    if (_gt && _gt.directive) {
      _groundTruthDirective = _gt.directive;
      onStatus({
        phase: 'init',
        message: `地面真值:已用确定性代码精确算出 ${_gt.facts.length} 处算式的真值,注入供模型直接采用(不信任心算/浮点)`,
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // ── 数学解题协议:给数学题(含图片给题)就分步骤解、解完自检、并产出机器可核验块 ──────
  // goal「希望我给 khy 数学题,如微积分、方程组……可能以图片的形式给出,khy 可以正确解题,
  // 能给出步骤」。命中数学题时注入 [SYSTEM:] 协议命模型:带图先准确转写+复述确认+读不出如实说、
  // 一律分步骤、精确值、解完回代自检、对可代入复核的解附 ```khy-check 块(生成后由 answerVerifier
  // 经 groundTruth 精确有理数代入复核)。单一真源 mathSolvePolicy。门控 KHY_MATH_SOLVE 默认开。
  let _mathSolveDirective = '';
  try {
    const { routeMathSolve } = require('../services/mathSolvePolicy');
    const _hasImage = (Array.isArray(multimodalInput.images) && multimodalInput.images.length > 0)
      || (Array.isArray(opts.images) && opts.images.length > 0);
    const _ms = routeMathSolve({ text: userMessage, hasImage: _hasImage });
    if (_ms && _ms.directive) {
      _mathSolveDirective = _ms.directive;
      onStatus({
        phase: 'init',
        message: `数学解题:识别到数学题(${_ms.kinds.join('+') || 'general'})${_hasImage ? '·含图片' : ''},已注入分步骤+自检+确定性代入复核协议`,
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // ── 测试编写协议:让用户让 khy「给项目写测试」时,产出真实有效、可重复、能抓回归的测试 ──
  // goal「教会 khyos 怎么给项目写些测试」。命中「写/补/生成 + 测试/用例」意图时注入 [SYSTEM:] 协议:
  // 先对齐项目既有框架与约定、测行为非实现、成体系覆盖(正常/边界/错误/不变量)、确定性隔离杜绝 flaky、
  // 断言要有意义、写完实际运行看证据、诚实边界(绝不为变绿迁就当前可能有 bug 的输出)。单一真源
  // testWritingPolicy。门控 KHY_TEST_WRITING 默认开。与 constraints 的「跑测试验证」正交(一个管写一个管验)。
  let _testWritingDirective = '';
  try {
    const { routeTestWriting } = require('../services/testWritingPolicy');
    const _tw = routeTestWriting({ text: userMessage });
    if (_tw && _tw.directive) {
      _testWritingDirective = _tw.directive;
      onStatus({
        phase: 'init',
        message: `测试编写:识别到写测试意图(${_tw.kinds.join('+') || 'general'}),已注入对齐框架+成体系覆盖+确定性+跑出证据协议`,
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // ── 图片路径未附图护栏:消息含本地图片路径但本轮无图片附件时,禁止模型 DIY OCR 死循环 ──
  // goal「识别图片 / 修复识别图片问题」。某些 chat 通道(web/协作)曾把打字粘的图片路径以纯文本
  // 送进来、不附图,纯文本模型就反复 Read 路径 + Bash 跑 python/tesseract 自己 OCR 直到撞循环守卫。
  // 这是与具体通道无关的护栏:只要进到模型这层时「消息含图片路径且没有任何图片附件」,就注入指令
  // 命模型绝不自己 OCR、改用 khy 原生视觉/OCR 或如实告知看不到图。单一真源 inlineImageOcrGuardPolicy。
  // 门控 KHY_INLINE_IMAGE_OCR_GUARD 默认开。
  let _inlineImageOcrGuardDirective = '';
  try {
    const { buildInlineImageOcrGuardDirective } = require('../services/gateway/inlineImageOcrGuardPolicy');
    const _hasAttachedImage = (Array.isArray(multimodalInput.images) && multimodalInput.images.length > 0)
      || (Array.isArray(opts.images) && opts.images.length > 0);
    const _guard = buildInlineImageOcrGuardDirective({ message: userMessage, hasAttachedImage: _hasAttachedImage });
    if (_guard) {
      _inlineImageOcrGuardDirective = _guard;
      onStatus({
        phase: 'init',
        message: '图片护栏:消息含图片路径但本轮未附图,已注入禁 DIY-OCR 指令(改用原生视觉/OCR 或如实告知)',
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }


  // goal「但也不只是计算,我希望其他能算的有确定答案的也是…公理与定理也优先使用,不要靠模型
  // 的猜测」。模型模式下经 routeDeterministicFacts 把权威真值注入系统提示词,命令模型直接采用而
  // 非凭记忆回忆;本地模式由 localBrainService 注册同一叶子作答。单一真源 deterministicFacts。
  // 门控 KHY_DETERMINISTIC_FACTS 默认开。
  let _deterministicFactsDirective = '';
  try {
    const { routeDeterministicFacts } = require('../services/deterministicFacts');
    const _dfres = routeDeterministicFacts({ text: userMessage });
    if (_dfres && _dfres.directive) {
      _deterministicFactsDirective = _dfres.directive;
      onStatus({
        phase: 'init',
        message: `确定性真值:已取 ${_dfres.facts.length} 处权威真值(单位换算/常数/定理),注入供模型直接采用(不靠记忆猜测)`,
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // ── 改动反馈(khy 被改动时不一声不吭)──────────────────────────────────────
  // goal「khyos 被修改时不要一声不吭…会主动根据其它 ai 的 khy 修改情况,向 ai 反馈修改的对
  // 还是不对」。后台常驻 watcher(changeWatchService)在其它 AI 改了 khy 源码后跑机器校验并落盘
  // 一条 verdict;这里在每轮对话开头 best-effort 跑一次侦测(无 daemon 常驻时也能反馈),读出尚未
  // 反馈过的判定,注入为 [SYSTEM:] 指令——让 khyos 主动告诉模型「你刚才对 khy 的改动对/不对」,
  // 并标记 consumed 防止对同一判定重复灌。单一真源 changeWatchVerdict。门控 KHY_CHANGE_WATCH。
  let _changeWatchDirective = '';
  try {
    const changeWatch = require('../services/changeWatchService');
    if (changeWatch.isWatchEnabled(process.env)) {
      try { await changeWatch.checkOnce(); } catch { /* detect best-effort */ }
      // 内部消费者通道:与原生 PrePrompt 钩子共用 'khy-internal' ID,同一轮不重复注入;
      // 外部 AI 工具走各自 consumerId(见 `khy verdict emit`),与此互不抢占。
      const _pending = changeWatch.consumePendingInjection('khy-internal');
      if (_pending && _pending.directive) {
        _changeWatchDirective = String(_pending.directive);
        onStatus({
          phase: 'init',
          message: `改动反馈:khyos 对最近一次 khy 改动判为「${_pending.verdict}」,主动反馈给模型`,
          elapsed: Date.now() - startTime,
        });
      }
    }
  } catch { /* non-critical */ }

  // ── 用户授权 + 自然语言驱动配置(用户是最高权限,别甩开关给用户)────────────────
  // goal「在 khyos 中用户是最高权限,自然语言驱动可以完成一切,而不是只给出需要显式声明什么
  // 开关、需要用户自己去文件中修改」。每轮注入一段原则指令:用户最高权限、要改设置就由模型直接
  // 调用 `Configure` 工具改掉并持久化,绝不回复「请设置环境变量 / 请自己去文件里改」。若本轮已
  // 把自然语言确定性解析出具体开关意图,附上能力+动作让模型立即执行。单一真源 nlConfigResolver。
  // 门控 KHY_NL_CONFIG 默认开。
  let _nlConfigDirective = '';
  try {
    const { routeConfigIntent } = require('../services/config/nlConfigResolver');
    const _cfg = routeConfigIntent({ text: userMessage });
    if (_cfg && _cfg.directive) {
      _nlConfigDirective = _cfg.directive;
      if (_cfg.intent && _cfg.intent.envKey) {
        const _act = _cfg.intent.action === 'off' ? '关闭' : '开启';
        onStatus({
          phase: 'init',
          message: `自然语言配置:已识别意图「${_act} ${_cfg.intent.summary || _cfg.intent.envKey}」,将由 khyos 直接改并持久化(无需你改文件)`,
          elapsed: Date.now() - startTime,
        });
      }
    }
  } catch { /* non-critical */ }

  // 自然语言驱动「动作」(不只是配置开关):goal「自然语言要能驱动一切」。当本轮是「让 khy 去做
  // 某件事」的动作请求时(典型:找/修自己的 bug、去开源平台学最火的项目),注入一段确定性指令命令
  // 模型用**既有**工具/子系统真正去做(Grep/Read/lintCode+evolutionPolicy 自查修复;forgeSearch/
  // forgeRecon/gitClone 平台学习),带安全栏与诚实边界,绝不回复「我做不到/请你手动」。仅命中时注入
  // (零噪声)。与 nlConfigResolver 正交(它管开关,本件管动作)。单一真源 nlActionResolver。
  // 门控 KHY_NL_ACTION 默认开。
  let _nlActionDirective = '';
  try {
    const { routeActionIntent } = require('../services/config/nlActionResolver');
    const _nlAct = routeActionIntent({ text: userMessage });
    if (_nlAct && _nlAct.directive) {
      _nlActionDirective = _nlAct.directive;
      const _actSummary = (_nlAct.intent && (_nlAct.intent.summary || _nlAct.intent.id)) || '动作';
      onStatus({
        phase: 'init',
        message: `自然语言驱动:已识别动作意图「${_actSummary}」,将用既有工具直接执行`,
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 自然语言驱动哲学落地:当本轮是「给一段哲学内容、想把它应用到软件项目」的请求时,注入一段确定性
  // 协议指令,命令模型走「忠实提炼内核 → 建显式类比映射表(哲学概念→软件构造)→ 转可执行架构 →
  // 真用软件实现 → 诚实标注强/弱类比」,而非把哲学复述一遍或写比喻散文。仅命中时注入(零噪声)。与
  // nlConfig/nlAction 正交。单一真源 philosophyDesignResolver。门控 KHY_PHILOSOPHY_DESIGN 默认开。
  let _philosophyDesignDirective = '';
  try {
    const { routePhilosophyIntent } = require('../services/config/philosophyDesignResolver');
    const _phil = routePhilosophyIntent({ text: userMessage });
    if (_phil && _phil.directive) {
      _philosophyDesignDirective = _phil.directive;
      onStatus({
        phase: 'init',
        message: '自然语言驱动:已识别「哲学 → 软件」意图,将建立类比映射并用软件实现',
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 懒人资深工程师 / 最小代码方法论(学自 ponytail):当本轮是「让 Khyos 写/改代码」的请求时,
  // 注入一段确定性指令命令模型按「懒人阶梯」(YAGNI→复用→标准库→原生→已装依赖→一行→最小代码)
  // 写最小代码、修根因、用 `// lazy:` 标注简化。零假阳性:写诗/解释/翻译不触发。单一真源
  // codeLaziness。门控 KHY_CODE_LAZINESS 默认开,强度读 KHY_CODE_LAZINESS_LEVEL(lite/full/ultra)。
  let _lazinessDirective = '';
  try {
    const { routeCodeLaziness } = require('../services/codeLaziness');
    const _lz = routeCodeLaziness({ text: userMessage });
    if (_lz && _lz.directive) {
      _lazinessDirective = _lz.directive;
      onStatus({
        phase: 'init',
        message: `懒人方法论(${_lz.level}):已识别编码请求,将按「最小代码」阶梯实现`,
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 收尾总结「根因/改动/验证」三段式(deliverySummaryFormat;goal「总结我希望也是和你一样
  // 结构化的:根因,改动,验证」):当本轮是实质工程任务(修复/实现/重构/改动代码)时,注入一段
  // protocol-tier 指令,命模型完成后按「根因(问题成因/需求取证·文件:行)/改动(文件·函数·门控)/
  // 验证(实际跑过的测试·守卫·回归证据·诚实红线)」三段式收尾。零假阳性:纯提问/闲聊/检索不触发。
  // 单一真源 deliverySummaryFormat。门控 KHY_DELIVERY_SUMMARY_FORMAT 默认开。
  let _deliverySummaryFormatDirective = '';
  try {
    const { routeDeliverySummary } = require('../services/deliverySummaryFormat');
    const _ds = routeDeliverySummary({ text: userMessage });
    if (_ds && _ds.directive) {
      _deliverySummaryFormatDirective = _ds.directive;
      onStatus({
        phase: 'init',
        message: '识别到工程任务:收尾将按「根因 / 改动 / 验证」三段式结构化总结',
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 的第三方文档、又说「参照/按照这个方法配置」时,弱模型易误判成「用户要安装那个工具」并生成
  // 安装待办。注入一段确定性指令:别执行安装命令、别建安装待办,把文档里的连接参数(baseURL/
  // apiKey/model)映射到 khy 自身配置(SENSENOVA_API_KEY / khy gateway model / .env),歧义时先
  // 澄清。零假阳性:安装命令 + 配置/参照语言须同现。单一真源 nlInstallVsConfigGuard。门控
  // KHY_INSTALL_CONFIG_GUARD 默认开。
  let _installConfigGuardDirective = '';
  try {
    const { resolve: _routeInstallConfig } = require('../services/config/nlInstallVsConfigGuard');
    const _icg = _routeInstallConfig(userMessage);
    if (_icg && _icg.directive) {
      _installConfigGuardDirective = _icg.directive;
      onStatus({
        phase: 'init',
        message: '识别到「安装文档 + 配置意图」歧义:将把连接参数映射到 khy 自身配置,而非安装第三方工具',
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  // 持久目标(对齐 Claude Code /goal):若当前项目设有持久目标,每轮注入一段指令让模型持续朝它
  // 推进。单一真源 goalCore;持久化在 goalStore(~/.khyos/goals)。门控 KHY_GOAL 默认开。
  // 有界终止态(KHY_GOAL_BOUNDED 默认开):advanceActiveGoalDirective **每轮递增**轮次计数并
  // 注入剩余预算;耗尽那一轮一次性注入终止指令并退役目标 → 之后停止注入(结构上不再无限跑)。
  let _goalDirective = '';
  try {
    const { advanceActiveGoalDirective } = require('../services/goalStore');
    _goalDirective = advanceActiveGoalDirective({ cwd: process.cwd() }) || '';
    if (_goalDirective) {
      const _terminal = _goalDirective.indexOf('终止态(exhausted)') !== -1;
      onStatus({
        phase: 'init',
        message: _terminal
          ? '持久目标:已达轮次预算上限,本轮进入终止态(产出完成/现状报告后停止推进)'
          : '持久目标:已加载当前项目目标,本轮将持续朝它推进',
        elapsed: Date.now() - startTime,
      });
    }
  } catch { /* non-critical */ }

  const userOnChunk = typeof opts.onChunk === 'function' ? opts.onChunk : null;
  let _lastMirroredStatusText = '';
  let _lastMirroredStatusAt = 0;
  const _mirroredStatusDedupMs = (() => {
    const raw = process.env.KHY_AI_STATUS_DEDUP_MS || process.env.GATEWAY_STATUS_DEDUP_MS || '1500';
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 200) return 1500;
    return parsed;
  })();
  const mirrorGatewayStatusWhenChunkHandled = String(
    process.env.KHY_MIRROR_GATEWAY_STATUS_WHEN_ONCHUNK || 'false'
  ).toLowerCase() === 'true';
  const shouldMirrorGatewayStatus = !userOnChunk || mirrorGatewayStatusWhenChunkHandled;
  const _mirrorGatewayStatusToOnStatus = (chunk) => {
    if (!shouldMirrorGatewayStatus) return;
    if (!chunk || chunk.type !== 'status' || typeof onStatus !== 'function') return;
    const text = String(chunk.text || '').trim();
    if (!text) return;
    const now = Date.now();
    // De-duplicate short-burst repeated status lines from adapter retries.
    if (text === _lastMirroredStatusText && (now - _lastMirroredStatusAt) < _mirroredStatusDedupMs) return;
    _lastMirroredStatusText = text;
    _lastMirroredStatusAt = now;
    onStatus({ phase: 'request', message: text, elapsed: now - startTime });
  };
  // Intercept <think> tags for non-native models so reasoning renders as thinking
  // chunks. With the toggle off we already suppress CoT injection / thinking budget
  // upstream; the display guard below stays as a final belt-and-suspenders in case a
  // model (e.g. a user-pinned reasoner) still emits a reasoning channel.
  const activeModelForThinking = requestPreferredModel || (_getModelInfo().model || '');
  const isNativeThinking = _modelSupportsNativeThinking(activeModelForThinking);
  const thinkInterceptedOnChunk = (!isNativeThinking && userOnChunk)
    ? _createThinkTagInterceptor(userOnChunk)
    : userOnChunk;

  // When display is off, suppress thinking chunks from reaching the UI
  const effectiveOnChunk = thinkInterceptedOnChunk
    ? (chunk) => {
        if (!_chatState.thinkingEnabled && chunk && chunk.type === 'thinking') return; // suppress display
        thinkInterceptedOnChunk(chunk);
      }
    : null;

  const baseChatOpts = {
    ...opts,
    images: Array.isArray(multimodalInput.images) ? multimodalInput.images : opts.images,
    documents: Array.isArray(multimodalInput.documents) ? multimodalInput.documents : [],
    _mediaKinds: Array.isArray(multimodalInput.mediaKinds) ? multimodalInput.mediaKinds : [],
    _multimodalPreferredAdapters: Array.isArray(multimodalInput.preferredAdapters) ? multimodalInput.preferredAdapters : [],
    _multimodalIntentDirective,
    _clarificationDirective,
    _promptIntentRepairDirective,
    _diskCleanupClarifyDirective,
    _searchNecessityDirective,
    _groundTruthDirective,
    _mathSolveDirective,
    _testWritingDirective,
    _inlineImageOcrGuardDirective,
    _deterministicFactsDirective,
    _errorEnumerationDirective,
    _changeWatchDirective,
    _nlConfigDirective,
    _nlActionDirective,
    _philosophyDesignDirective,
    _lazinessDirective,
    _installConfigGuardDirective,
    _deliverySummaryFormatDirective,
    _goalDirective,
    preferredAdapter: requestPreferredAdapter,
    preferredModel: requestPreferredModel,
    preferredStrict: requestPreferredStrict,
    taskScale: requestTaskScale,
    onChunk: (chunk) => {
      _markFirstTokenIfNeeded(chunk);
      if (effectiveOnChunk) {
        try { effectiveOnChunk(chunk); } catch { /* best effort */ }
      }
      _mirrorGatewayStatusToOnStatus(chunk);
    },
  };
  const chatOpts = _applyVisionRouting(baseChatOpts, onStatus, startTime);
  const effectivePreferredAdapter = String(chatOpts.preferredAdapter || '').trim();

  try {
    const nonBlockingPreflight = String(
      process.env.KHY_PREFLIGHT_NON_BLOCKING || 'true'
    ).toLowerCase() === 'true';
    if (nonBlockingPreflight) {
      onStatus({ phase: 'init', message: '预检后台进行中（不阻塞本次请求）', elapsed: Date.now() - startTime });
      _preflightGatewayAvailability({
        preferredAdapter: effectivePreferredAdapter,
        onProgress: (text) => onStatus({ phase: 'init', message: String(text || '预检中...'), elapsed: Date.now() - startTime }),
      }).catch(() => {});
    } else {
      await _preflightGatewayAvailability({
        preferredAdapter: effectivePreferredAdapter,
        onProgress: (text) => onStatus({ phase: 'init', message: String(text || '预检中...'), elapsed: Date.now() - startTime }),
      });
    }
  } catch { /* best effort */ }

  try {
    const { analyzeInput } = require('../services/securityGuardService');
    const check = analyzeInput(userMessage);
    if (!check.safe) {
      return { reply: check.refusal, commands: [], provider: 'security', blocked: true };
    }
  } catch {}

  // Directive extraction: strip inline directives before purification
  let _directives = { audioAsVoice: false, replyTo: null, replyToCurrent: false };
  let cleanedUserMessage = userMessage;
  try {
    const { extractDirectives, stripDirectives } = require('../services/directiveParser');
    _directives = extractDirectives(userMessage);
    cleanedUserMessage = stripDirectives(userMessage);
  } catch { /* directiveParser not available */ }

  // 轻量输入预处理（DESIGN-ARCH-019）：在送入模型前，过滤「乱输入」纯噪声
  // （控制/零宽字符、刷屏标点、过量空白/空行、连续重复行），降低 token 消耗。
  // 防呆：只清噪声不动有效信息；代码块整段保护；任何异常/退化即回退原文，绝不阻断。
  // 仅作用于用户原文，不触及下方 promptAugment 上下文、提示词与模型调用逻辑。
  try {
    cleanedUserMessage = require('../services/inputSanitizer').sanitizeForModel(cleanedUserMessage);
  } catch { /* inputSanitizer 不可用 → 用原文继续 */ }

  if (multimodalInput.promptAugment) {
    cleanedUserMessage = `${cleanedUserMessage}\n\n${multimodalInput.promptAugment}`.trim();
  }

  // Determine if current adapter supports native tool_use (Claude, Relay, Kiro, etc.)
  // Cloud models with native tool use don't benefit from filler stripping — it risks
  // destroying meaningful content (e.g. "请求体" → "求体").
  let _skipFillerStrip = false;
  try {
    const gw = getGateway();
    const active = gw.getActiveAdapter?.();
    const adapterName = String(active?.name || '').toLowerCase();
    _skipFillerStrip = /^(kiro|cursor|trae|claude|codex|api|windsurf|vscode|warp|cursor2api|relay_api)$/i.test(adapterName);
  } catch { /* best effort */ }

  const purified = runtime.inputPurify(cleanedUserMessage, { isFollowUp: _chatState.messages.length > 0, skipFillerStrip: _skipFillerStrip });
  let processedMessage = purified.purified;
  let ragContext = '';
  let ragMeta = null;

  const skipRagForSmallTask = String(process.env.KHY_SKIP_RAG_FOR_SMALL_TASK || 'true').trim().toLowerCase() !== 'false';
  const shouldSkipRag = skipRagForSmallTask && requestTaskScale === 'small';
  if (shouldSkipRag) {
    onStatus({
      phase: 'init',
      message: '轻量任务优化: 跳过 RAG 检索以降低首包延迟',
      elapsed: Date.now() - startTime,
    });
  }
  if (!opts._isFollowUp && !shouldSkipRag) {
    try {
      const rag = require('../services/ragRetrievalService');
      if (rag && typeof rag.isEnabled === 'function' && rag.isEnabled()) {
        onStatus({
          phase: 'init',
          message: 'RAG 检索: 正在召回知识库与历史会话上下文（步骤 2/3）',
          elapsed: Date.now() - startTime,
        });
        const retrieval = (typeof rag.buildRetrievalContext === 'function')
          ? rag.buildRetrievalContext(processedMessage, { isFollowUp: false })
          : null;
        ragMeta = retrieval?.meta || null;
        if (retrieval && retrieval.used && retrieval.context) {
          ragContext = String(retrieval.context || '').trim();
          onStatus({
            phase: 'init',
            message: `RAG 检索: 已注入 ${ragMeta?.selectedCount || 0} 条上下文（步骤 3/3）`,
            elapsed: Date.now() - startTime,
          });
        } else {
          onStatus({
            phase: 'init',
            message: 'RAG 检索: 未命中可用上下文（步骤 3/3）',
            elapsed: Date.now() - startTime,
          });
        }
      }
    } catch { /* RAG is non-blocking */ }
  }

  // Codebase pre-fetch: for obvious code questions, run a lightweight explore search
  // before the main model call, injecting results alongside RAG context.
  let codebaseContext = '';
  let _prefetchFiles = [];
  if (!opts._isFollowUp && !shouldSkipRag && !opts._agentContext) {
    try {
      const { isCodebaseQuery } = require('../services/codebaseIntentClassifier');
      const codeIntent = isCodebaseQuery(processedMessage);
      if (codeIntent.isCodebase) {
        onStatus({
          phase: 'init',
          message: `代码库预取: 正在搜索相关文件 (${codeIntent.type})...`,
          elapsed: Date.now() - startTime,
        });
        const exploreTool = require('../tools/exploreTool');
        const prefetchSoftTimeoutMs = Math.max(
          800,
          parseInt(process.env.KHY_PREFETCH_MAX_MS || '2000', 10) || 2000
        );
        const prefetchTimeoutToken = Symbol('prefetch-timeout');
        const prefetchResult = await Promise.race([
          exploreTool.execute({ query: processedMessage, max_results: 8 }),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve(prefetchTimeoutToken), prefetchSoftTimeoutMs);
            if (t.unref) t.unref();
          }),
        ]);
        if (prefetchResult === prefetchTimeoutToken) {
          onStatus({
            phase: 'init',
            message: `代码库预取: 超过 ${Math.round(prefetchSoftTimeoutMs / 1000)}s 未返回首批结果，先继续主请求`,
            elapsed: Date.now() - startTime,
          });
        } else if (prefetchResult?.success && prefetchResult?.data) {
          const d = prefetchResult.data;
          const parts = [];
          if (d.files_found?.length > 0) {
            parts.push(`Relevant files: ${d.files_found.join(', ')}`);
          }
          if (d.file_previews?.length > 0) {
            for (const fp of d.file_previews) {
              if (fp.preview && !fp.preview.startsWith('[')) {
                parts.push(`--- ${fp.path} (${fp.lines || '?'} lines) ---\n${fp.preview}`);
              }
            }
          }
          codebaseContext = parts.join('\n\n');
          _prefetchFiles = d.files_found || [];
          onStatus({
            phase: 'init',
            message: `代码库预取: 找到 ${d.files_found?.length || 0} 个相关文件`,
            elapsed: Date.now() - startTime,
          });
        }
      }
    } catch { /* codebase pre-fetch is non-blocking */ }
  }

  if (opts._isFollowUp) {
    // Structured path: build proper assistant message with tool_use blocks,
    // then user message with tool_result blocks. This matches the Anthropic
    // multi-turn tool-use format: assistant(text+tool_use) → user(tool_result).
    const assistantToolUseBlocks = opts._assistantToolUseBlocks;
    // Signed thinking blocks to echo back for extended-thinking continuity.
    // Absent for non-thinking models → behavior unchanged.
    const assistantThinkingBlocks = opts._assistantThinkingBlocks;
    const _hasToolUseBlocks = Array.isArray(assistantToolUseBlocks) && assistantToolUseBlocks.length > 0;
    const _hasThinkingBlocks = Array.isArray(assistantThinkingBlocks) && assistantThinkingBlocks.length > 0;
    if (_hasToolUseBlocks || _hasThinkingBlocks) {
      // Build structured assistant message: thinking + text + tool_use content blocks
      try {
        const { buildAssistantContent } = require('../services/contentBlockUtils');
        // Get the last assistant reply text from _chatState.messages (it was the AI response
        // that contained tool_use blocks, but may not have been pushed yet).
        // The previous assistant message was already pushed by toolUseLoop's
        // conversationMessages tracking — we need to update the last assistant
        // message in _chatState.messages to include thinking/tool_use blocks.
        const lastAssistant = _chatState.messages.length > 0 && _chatState.messages[_chatState.messages.length - 1].role === 'assistant'
          ? _chatState.messages[_chatState.messages.length - 1]
          : null;
        if (lastAssistant && typeof lastAssistant.content === 'string') {
          lastAssistant.content = buildAssistantContent(lastAssistant.content, assistantToolUseBlocks, assistantThinkingBlocks);
        }
      } catch { /* fallback: leave assistant message as plain text */ }
    }

    // Push tool_result as structured content blocks when available
    const structuredBlocks = opts._structuredToolResultBlocks;
    if (structuredBlocks && Array.isArray(structuredBlocks) && structuredBlocks.length > 0) {
      _chatState.messages.push({ role: 'user', content: structuredBlocks });
    } else {
      // Fallback: plain text tool result (NL tool loop or no tool_use_id)
      // 使用 role:'user' 而非 role:'tool' — 'tool' 不是 Anthropic API 标准角色，
      // 某些适配器会静默丢弃，导致模型看不到工具执行结果。
      _chatState.messages.push({ role: 'user', content: `[Tool Result]\n${processedMessage}` });
    }
  } else {
    // Continuation command detection: if the user says "继续"/"continue"/etc.,
    // re-inject the original task prompt so the model stays on target.
    if (_isContinuationCommand(userMessage)) {
      if (_chatState.lastSubstantivePrompt) {
        processedMessage = `继续执行之前的任务。原始需求如下：\n"${_chatState.lastSubstantivePrompt.slice(0, 500)}"\n\n请从上次停止的地方继续，不要重复已完成的工作。`;
      }
      // Don't update the anchor — keep pointing at the original task
    } else if (processedMessage.trim().length > 5) {
      // Record as new substantive task (save verbatim, not purified)
      _chatState.lastSubstantivePrompt = userMessage;
      _chatState.lastSubstantiveAt = Date.now();
    }
    const _userMsg = { role: 'user', content: processedMessage };
    // 把本回合的工作区检查点 id(若调用方此前确实拍了快照)盖在这条 user 消息上,
    // 让逐回合回溯能精确恢复到「这条消息发出前」的代码(单一真源 rewindResume;
    // 门控关或本回合无快照 → out 只含 role/content,字节回退)。
    try {
      require('../services/rewindResume').carryRewindFields(
        { checkpointId: opts && opts.turnCheckpointId }, _userMsg,
      );
    } catch { /* fail-soft */ }
    _chatState.messages.push(_userMsg);
  }

  if (_chatState.messages.length > MAX_HISTORY) _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);

  // DESIGN-ARCH-046 (authoritative-history extension): remember the exact message
  // THIS call just appended to `_chatState.messages` — the array that builds conversationPrompt
  // and is what the model actually sees. On a failed/empty turn we surgically
  // un-commit ONLY this one message (see _uncommitOrphanTurn), never the prior tool
  // iterations that carry mission progress. This kills the "orphan user turn" (a user
  // message with no assistant pair) that breaks role-alternation and feeds the next
  // turn corrupted context — the real REPL pollution vector, distinct from the
  // queryEngine-level ledger that chatStateIsolation handles.
  const _turnCommittedMsg = _chatState.messages.length > 0 ? _chatState.messages[_chatState.messages.length - 1] : null;

  // Greeting shortcut: when the user sends a simple greeting, replace the
  // heavy system prompt with a minimal conversational one so ALL adapters
  // (including cliToolAdapter / Claude Code bridge) respond naturally instead
  // of assuming the user wants financial calculations.
  const _isGreeting = purified.intent === '问候' && _chatState.messages.length <= 1;
  const taskScaleForPrompt = _resolveTaskScale(userMessage, chatOpts);
  const shouldInjectTaskSelfAwareness = _shouldInjectTaskSelfAwareness(userMessage, chatOpts)
    && (!_chatState.studyMode || taskScaleForPrompt === 'large');
  const intentAssuranceDebugEnabled = (() => {
    const raw = opts.intentAssuranceDebug ?? opts._intentAssuranceDebug ?? process.env.KHY_INTENT_ASSURANCE_DEBUG;
    const normalized = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  })();
  const externalIntentAssuranceDirective = String(chatOpts._intentAssuranceDirective || '').trim();
  const externalIntentAssuranceMeta = (chatOpts._intentAssuranceMeta && typeof chatOpts._intentAssuranceMeta === 'object')
    ? chatOpts._intentAssuranceMeta
    : null;
  const intentAssurance = _isGreeting
    ? {
      shouldInject: false,
      directive: '',
      requestClass: '',
      primaryObjective: '',
      constraints: [],
      detailAnchors: [],
      tailDetails: [],
      detailCount: 0,
      constraintCount: 0,
      tailDetailCount: 0,
      summary: null,
    }
    : externalIntentAssuranceDirective
      ? {
        shouldInject: true,
        directive: externalIntentAssuranceDirective,
        requestClass: String(externalIntentAssuranceMeta?.requestClass || '').trim(),
        primaryObjective: String(
          externalIntentAssuranceMeta?.primaryObjective
          || externalIntentAssuranceMeta?.summary
          || '',
        ).trim(),
        constraints: Array.isArray(externalIntentAssuranceMeta?.constraints)
          ? externalIntentAssuranceMeta.constraints.slice(0, 5)
          : [],
        detailAnchors: Array.isArray(externalIntentAssuranceMeta?.detailAnchors)
          ? externalIntentAssuranceMeta.detailAnchors.slice(0, 8)
          : [],
        tailDetails: Array.isArray(externalIntentAssuranceMeta?.tailDetails)
          ? externalIntentAssuranceMeta.tailDetails.slice(0, 4)
          : [],
        detailCount: Number(externalIntentAssuranceMeta?.detailCount || 0),
        constraintCount: Number(externalIntentAssuranceMeta?.constraintCount || 0),
        tailDetailCount: Number(externalIntentAssuranceMeta?.tailDetailCount || 0),
        summary: externalIntentAssuranceMeta?.summary || null,
      }
      : runtime.buildIntentAssuranceDirective(cleanedUserMessage, {
        purifiedQuestion: processedMessage,
        intent: purified.intent,
      });
  const effort = chatOpts.effort || _chatState.currentEffort;
  // coding/ultrawork 任务自动提升到 high preset，确保足够的 maxTokens 和低温度
  const rawEffectiveEffort = (() => {
    // 20 倍模式(twentyXMode):开启则每个任务顶格投入 —— effort 直接顶到 max
    // (唯一携带扩展思考预算的档)。关 → 逐字节回退到下面的常规解析。opt-in 默认关。
    try {
      const { resolveTwentyXEffort } = require('../services/twentyXMode');
      const boosted = resolveTwentyXEffort(effort);
      if (boosted === 'max') return 'max';
    } catch { /* twentyXMode 不可用 → 常规解析 */ }
    if (effort === 'high' || effort === 'max') return effort;
    try {
      const { detectModes } = require('../services/intentGate');
      const detected = detectModes(userMessage);
      if (detected.modes.includes('coding') || detected.modes.includes('ultrawork')) return 'high';
    } catch { /* intentGate not available */ }
    return effort;
  })();
  // Thinking stays with the main agent: a sub-agent never draws the 'max'
  // (extended-thinking) preset. Single chokepoint — applied after the auto-bump
  // so coding/ultrawork sub-agents still get 'high', just never 'max'.
  const effectiveEffort = _clampSubagentEffort(rawEffectiveEffort, { isSubagent: !!chatOpts._isSubagent });
  const preset = EFFORT_PRESETS[effectiveEffort] || EFFORT_PRESETS.high;
  let taskSelfAwarenessInjected = false;

  // DESIGN-ARCH-049 (capability B): precompute the weak-model "recommended path"
  // block here in the async scope, so the synchronous prompt builder below can
  // append it. Gated by KHY_TRAJ_GUIDE_INJECT (default off → null, sp unchanged);
  // the injector re-checks model strength + map relevance. Best-effort.
  let trajectoryGuideBlock = null;
  try {
    const guideConfig = require('../services/trajectoryGuide/config');
    if (guideConfig.isGuideInjectEnabled()) {
      const { buildGuideBlock } = require('../services/trajectoryGuide/guideInjector');
      trajectoryGuideBlock = await buildGuideBlock({ userMessage, modelId: _getModelInfo().model });
    }
  } catch { /* guidance is best-effort; never interrupt the current turn */ }

  const fullSystemPrompt = await (async () => {
    if (_isGreeting) {
      return [
        'You are khy OS, a friendly and helpful AI assistant.',
        'Respond in the same language the user used.',
        'The user sent a casual greeting. Respond naturally — say hello,',
        'briefly introduce yourself, and ask how you can help today.',
        'Keep it warm and concise (2-3 sentences).',
        'Do NOT mention calculation, financial analysis, stock trading, or any specific tool.',
      ].join(' ');
    }
    let sp = await runtime.makeSystemPrompt(
      getSecurityDir(),
      _getModelInfo(),
      [],
      {
        userMessage,
        taskScale: taskScaleForPrompt,
        // Resolved model window → lets makeSystemPrompt shrink the static prompt
        // for short-context (small) models. Cheap cached gateway lookup; 0/unknown
        // and large windows leave the prompt byte-identical to today.
        contextWindow: _resolveModelContextLimit(_guessModelHint(chatOpts)),
      }
    );
    // Claude Code SDK alignment: `--system-prompt` (print mode) overrides the
    // STATIC base prompt. The dynamic safety / tool-protocol / intent / memory
    // directives appended below are intentionally preserved so tool calling and
    // language/safety guarantees keep working under a custom persona. Because the
    // base is replaced here at position 0 — ahead of ~140 lines of operational
    // scaffolding that would otherwise dominate instruction-following — the
    // override is ALSO re-affirmed at end-salience just before `return sp`.
    const _spOverride = typeof chatOpts.systemPrompt === 'string' ? chatOpts.systemPrompt.trim() : '';
    if (_spOverride) sp = _spOverride;
    // Inject intentGate directives into system prompt (not user message)
    // to avoid AI treating them as prompt injection.
    //
    // 整合层(单一真源 directiveComposer):历史上这里是一堵扁平拼接墙——每个意图叶子一行
    // `if (d) sp += '\n\n' + d`,固定源码顺序、无优先级、无冲突协调;多路意图同时命中时模型
    // 收到一堆等权的「先做 X」指令,只能挑一个(=「功能堆砌、无法贯通」的物理形态)。现改由
    // directiveComposer 按 tier(guard 真值/护栏在前,protocol 工作流在后)编排,并在 ≥2 套
    // 工作流协议同时生效时插入一段确定性「协调头」,把零散指令串成一套有次序的执行计划。
    // 门控 KHY_DIRECTIVE_COMPOSER 默认开;关闭 → 逐字节回退到历史拼接(顺序与内容字节一致)。
    // entries 顺序即历史 inject 顺序,务必保持(composer 关门控时按此顺序 join)。
    const intentDirective = String(chatOpts._intentDirective || '').trim();
    const multimodalIntentDirective = String(chatOpts._multimodalIntentDirective || '').trim();
    const promptIntentRepairDirective = String(chatOpts._promptIntentRepairDirective || '').trim();
    const clarificationDirective = String(chatOpts._clarificationDirective || '').trim();
    const diskCleanupClarifyDirective = String(chatOpts._diskCleanupClarifyDirective || '').trim();
    const searchNecessityDirective = String(chatOpts._searchNecessityDirective || '').trim();
    const groundTruthDirective = String(chatOpts._groundTruthDirective || '').trim();
    const mathSolveDirective = String(chatOpts._mathSolveDirective || '').trim();
    const testWritingDirective = String(chatOpts._testWritingDirective || '').trim();
    const inlineImageOcrGuardDirective = String(chatOpts._inlineImageOcrGuardDirective || '').trim();
    const deterministicFactsDirective = String(chatOpts._deterministicFactsDirective || '').trim();
    const errorEnumerationDirective = String(chatOpts._errorEnumerationDirective || '').trim();
    const changeWatchDirective = String(chatOpts._changeWatchDirective || '').trim();
    const nlConfigDirective = String(chatOpts._nlConfigDirective || '').trim();
    const nlActionDirective = String(chatOpts._nlActionDirective || '').trim();
    const philosophyDesignDirective = String(chatOpts._philosophyDesignDirective || '').trim();
    const lazinessDirective = String(chatOpts._lazinessDirective || '').trim();
    const installConfigGuardDirective = String(chatOpts._installConfigGuardDirective || '').trim();
    const goalDirective = String(chatOpts._goalDirective || '').trim();
    const deliverySummaryFormatDirective = String(chatOpts._deliverySummaryFormatDirective || '').trim();
    // intentAssurance(「用户真实意图」最根本真值:主目标 / 硬约束 / 必保锚点)历史上被单独
    // 注入在整合层之后(line 5104),与协调计划脱节——正是「功能无法贯通」的物理形态。门控开
    // 时把它作为领头 guard 纳入整合层,让协调头之下的多套协议显式为这个主目标服务;门控关时
    // 退回历史路径(整合层之后单独注入),逐字节等价。
    const _composerOn = (() => {
      try { return require('../services/directiveComposer').isComposerEnabled(opts); }
      catch { return true; }
    })();
    const _intentAssuranceDirectiveText =
      (intentAssurance.shouldInject && intentAssurance.directive)
        ? String(intentAssurance.directive).trim()
        : '';
    try {
      const { composeDirectives } = require('../services/directiveComposer');
      const _composed = composeDirectives({
        // 顺序 = 历史 ai.js inject 顺序(门控关时逐字节回退依赖它)。门控开时 intentAssurance
        // 作为领头 guard 置于 entries 之首,由整合层按 tier 排到所有 guard 最前。
        entries: [
          ...(_composerOn && _intentAssuranceDirectiveText
            ? [{ key: 'intentAssurance', directive: _intentAssuranceDirectiveText }]
            : []),
          { key: 'intent', directive: intentDirective },
          { key: 'multimodalIntent', directive: multimodalIntentDirective },
          { key: 'promptIntentRepair', directive: promptIntentRepairDirective },
          { key: 'clarification', directive: clarificationDirective },
          { key: 'diskCleanupClarify', directive: diskCleanupClarifyDirective },
          { key: 'searchNecessity', directive: searchNecessityDirective },
          { key: 'groundTruth', directive: groundTruthDirective },
          { key: 'mathSolve', directive: mathSolveDirective },
          { key: 'testWriting', directive: testWritingDirective },
          { key: 'inlineImageOcrGuard', directive: inlineImageOcrGuardDirective },
          { key: 'deterministicFacts', directive: deterministicFactsDirective },
          { key: 'errorEnumeration', directive: errorEnumerationDirective },
          { key: 'changeWatch', directive: changeWatchDirective },
          { key: 'nlConfig', directive: nlConfigDirective },
          { key: 'nlAction', directive: nlActionDirective },
          { key: 'philosophyDesign', directive: philosophyDesignDirective },
          { key: 'laziness', directive: lazinessDirective },
          { key: 'installConfigGuard', directive: installConfigGuardDirective },
          { key: 'goal', directive: goalDirective },
          { key: 'deliverySummaryFormat', directive: deliverySummaryFormatDirective },
        ],
        options: opts,
      });
      if (_composed) {
        sp += '\n\n' + _composed;
      }
    } catch {
      // fail-soft:整合层意外失败 → 退回历史扁平拼接(逐字节等价),绝不丢任何指令。
      for (const d of [
        intentDirective, multimodalIntentDirective, promptIntentRepairDirective,
        clarificationDirective, diskCleanupClarifyDirective, searchNecessityDirective, groundTruthDirective,
        mathSolveDirective, testWritingDirective, inlineImageOcrGuardDirective, deterministicFactsDirective,
        errorEnumerationDirective, changeWatchDirective, nlConfigDirective,
        nlActionDirective, philosophyDesignDirective, lazinessDirective, installConfigGuardDirective, goalDirective,
        deliverySummaryFormatDirective,
      ]) {
        if (d) sp += '\n\n' + d;
      }
      // 整合层抛错且门控本应开 → 这里补注 intentAssurance(尾部,等价历史位置),
      // 因为下面的单独注入仅在门控关时触发,catch 路径绝不丢失意图保护这条最关键真值。
      if (_composerOn && _intentAssuranceDirectiveText) {
        sp += '\n\n' + _intentAssuranceDirectiveText;
      }
    }
    // 门控关 → 历史路径:整合层之后单独注入 intentAssurance(逐字节等价)。
    // 门控开 → intentAssurance 已作为领头 guard 进入整合层(或 catch 已补注),此处不再重复。
    if (!_composerOn && intentAssurance.shouldInject && intentAssurance.directive) {
      sp += '\n\n' + intentAssurance.directive;
    }
    // DESIGN-ARCH-049 (capability B): for weak models only, append a "recommended
    // path" distilled from a past successful trajectory. The block is precomputed
    // asynchronously before this (synchronous) builder runs; here we only append
    // it. Gated by KHY_TRAJ_GUIDE_INJECT (default off → sp byte-identical).
    if (trajectoryGuideBlock) {
      sp += '\n\n' + trajectoryGuideBlock;
    }
    if (_chatState.studyMode) {
      try {
        const { buildStudyModePromptContext } = require('../services/knowledgeTeachingService');
        const runtimeMeta = _getStudyModeRuntimeMeta(chatOpts.preferredAdapter, chatOpts.preferredModel);
        const studyPrompt = buildStudyModePromptContext({
          studyMode: true,
          adapter: runtimeMeta.adapter,
          model: runtimeMeta.model,
          effort,
        });
        if (studyPrompt) sp += '\n\n' + studyPrompt;
      } catch { /* non-blocking */ }
    }
    if (shouldInjectTaskSelfAwareness) {
      const taskPrompt = _buildTaskSelfAwarenessPrompt(userMessage, { ...chatOpts, effort });
      if (taskPrompt) {
        sp += '\n\n' + taskPrompt;
        taskSelfAwarenessInjected = true;
      }
    }
    // Proactive Memory Engine (Module 2) + session-start/topic-switch priming.
    // Injection order: proactive (keyword × recency) → priming (tier × recency,
    // query-INDEPENDENT) → short-term session memory. `_memSurfaced` collects the
    // filenames shown here so the later [RELEVANT_MEMORY] block never repeats them
    // (dedup). Gates KHY_PROACTIVE_MEMORY / KHY_MEMORY_SESSION_PRIME /
    // KHY_MEMORY_RECALL_DEDUP all default on; sp is byte-identical when off.
    // Fail-soft: memory must never break prompt assembly.
    // Stashed on `opts.__memSurfaced` because the [RELEVANT_MEMORY] recall block
    // below lives in a shallower scope; `opts` is the only channel both share.
    const _memSurfaced = new Set();
    opts.__memSurfaced = _memSurfaced;
    try {
      const memoryEngine = require('../services/memoryEngine');
      const _dedupOn = !['0', 'false', 'off', 'no'].includes(
        String(process.env.KHY_MEMORY_RECALL_DEDUP == null ? '' : process.env.KHY_MEMORY_RECALL_DEDUP).trim().toLowerCase());

      // 1) Proactive (query-relevant). With dedup on, use the variant that also
      //    reports surfaced filenames; otherwise keep the byte-identical legacy call.
      if (_dedupOn) {
        const proactive = memoryEngine.buildProactiveMemoryResult(userMessage);
        if (proactive && proactive.text) {
          sp += '\n\n' + proactive.text;
          for (const fn of proactive.filenames) _memSurfaced.add(fn);
        }
      } else {
        const proactiveSection = memoryEngine.buildProactiveSystemSection(userMessage);
        if (proactiveSection) sp += '\n\n' + proactiveSection;
      }

      // 2) Session-start / topic-switch priming: durable memories by tier × recency
      //    with NO query-overlap requirement — the gap the proactive path leaves on
      //    greetings / topic switches. Fires once per session (sessionId change) and
      //    once per topic (deterministic Jaccard vs the last prime's tokens).
      try {
        const memdir = require('../memdir');
        const sid = _ensureLiveSessionId();
        const curTokens = memdir._tokenizeForRecall(userMessage);
        const isNewSession = _chatState.primedSessionId !== sid;
        const switched = memoryEngine.topicSwitch.isTopicSwitch(curTokens, _chatState.lastPrimeTopicTokens);
        if (isNewSession || switched) {
          const prime = memoryEngine.buildSessionPrimingSection({ exclude: _memSurfaced });
          if (prime && prime.text) {
            sp += '\n\n' + prime.text;
            for (const fn of prime.filenames) _memSurfaced.add(fn);
          }
          // Reset the topic baseline only on an actual prime, so each topic primes
          // at most once (subsequent same-topic turns stay above the switch threshold).
          _chatState.primedSessionId = sid;
          _chatState.lastPrimeTopicTokens = curTokens;
        }
      } catch { /* priming best-effort — never breaks prompt assembly */ }

      // 3) Short-term session memory (layer 1): memories recorded within THIS session
      //    (tier=short_term, never persisted), relevant to the current topic.
      //    Forgotten at session end. Strict no-op when empty / disabled. Fail-soft.
      const sessionSection = memoryEngine.buildSessionMemorySection(userMessage);
      if (sessionSection) sp += '\n\n' + sessionSection;
    } catch { /* memory engine optional — fall through unchanged */ }
    // 「回忆时明确告知用户」:上面主动 / 预热 / 短期三段召回把具名记忆折进系统提示,`_memSurfaced`
    // 收齐了这些**具名可核**的召回文件名(此前只用于 [RELEVANT_MEMORY] 去重,从不面向用户播报)。
    // 在此渲一行 onStatus 告知用户「回忆了什么」。gate KHY_MEMORY_NOTICE 默认开;关闭 ⇒ notice=''
    // ⇒ 不 onStatus(字节回退)。只播报具名召回(under-claim 是诚实的)。fail-soft:绝不抛。
    try {
      const recallNotice = require('../services/memoryOpsNotice').formatRecallNotice(_memSurfaced);
      if (recallNotice) onStatus({ phase: 'init', message: recallNotice, elapsed: Date.now() - startTime });
    } catch { /* recall notice is best-effort — never breaks prompt assembly */ }
    // 会话拓扑「你在这里」+ 一次性 insight 注入(学自 Stello:节点不知全局,只靠注入的
    // YOU-ARE-HERE 串感知自己在拓扑网中的位置;insight 是一次性收件箱,注入一次即清)。
    // 均 fail-soft、各走自己的门控(here-line=KHY_SESSION_TOPOLOGY,insight=KHY_SESSION_SLOTS)、
    // 空则 no-op(sp 字节不变)。memory 槽刻意**绝不**在此注入(对齐 Stello 的不对称:外向只读)。
    try {
      const forest = require('../services/session/sessionForestService');
      const here = forest.buildHereLineForCurrent();
      if (here) sp += '\n\n' + here;
      const { insightText } = forest.consumeInsightForCurrent();
      if (insightText) sp += '\n\n' + insightText;
    } catch { /* topology injection best-effort — never breaks prompt assembly */ }
    // Adaptive usage habits ("太懂我了"): learn the user's explicit response-style
    // corrections once, then apply them on every turn so they never have to repeat
    // themselves. A remark like "太长了" / "直接做，别给计划" is mapped to a
    // recordResponseFeedback signal and persisted; getHabitContext() then injects a
    // [使用习惯] block. Learning + application happen in the SAME turn, so the very
    // response that drew the correction already adapts. Gated by KHY_USAGE_HABITS
    // (default on; =0/off/false/no → byte-identical sp). Fail-soft throughout.
    try {
      const _hb = String(process.env.KHY_USAGE_HABITS == null ? '' : process.env.KHY_USAGE_HABITS).trim().toLowerCase();
      if (!['0', 'false', 'off', 'no'].includes(_hb)) {
        const habits = require('../services/usageHabitService');
        const { detectPreferenceSignal } = require('../services/preferenceSignals');
        // Learn only on the user-facing first turn. When this chat() runs inside
        // runToolUseLoop (the default TUI / classic REPL / AgentTool), `userMessage`
        // is the per-iteration prompt with planning/key-findings text injected,
        // which the short-remark gate would reject — so read the loop-threaded
        // clean original. `_isFollowUp` (set by the loop on iteration>1) keeps us
        // from re-recording the same signal every iteration. Direct ai().chat()
        // callers have neither field, so behavior is unchanged for them.
        if (!opts._isFollowUp) {
          const sig = detectPreferenceSignal(opts._originalUserMessage || userMessage);
          if (sig) habits.recordResponseFeedback(sig);
        }
        const habitContext = habits.getHabitContext();
        if (habitContext) sp += '\n\n' + habitContext;
      }
    } catch { /* usage habits optional — never breaks prompt assembly */ }
    // Periodic Memory Distillation (Module 3): once per interval, identify which
    // memories should be forgotten (empty / near-duplicate / stale) vs. kept.
    // Default mode is report-only — it changes NOTHING on disk; it only stamps
    // the run and, when there is something worth pruning, hints to the model so
    // it can proactively suggest `/memory distill`. Forgetting always means
    // ARCHIVING (reversible), never hard-delete. Auto-archive requires an
    // explicit opt-in (KHY_MEMORY_DISTILL_AUTO=archive). Fail-soft throughout.
    try {
      const distiller = require('../services/memoryEngine/distiller');
      const distillRun = distiller.maybeDistill();
      if (distillRun && !distillRun.skipped && distillRun.plan && distillRun.plan.forget.length > 0) {
        const f = distillRun.plan.forget.length;
        const acted = distillRun.applied
          ? `已自动归档 ${distillRun.result ? distillRun.result.archived.length : f} 条（可经 /memory distill restore 恢复）。`
          : `尚未改动任何记忆。如确有帮助，可主动、简短地提示用户：运行 /memory distill 可查看并归档（可恢复）。`;
        sp += `\n\n[MEMORY_DISTILLATION] 定期记忆蒸馏：检测到 ${f} 条记忆可能可以忘记（空/重复/陈旧）。${acted}`;
      }
    } catch { /* distillation optional — never breaks prompt assembly */ }
    // Inject task decomposition guidance for large tasks
    if (taskScaleForPrompt === 'large') {
      sp += '\n\n# Large Task Decomposition\n'
        + 'When facing a complex task with multiple independent parts:\n'
        + '1. Identify independent subtasks that can run in parallel.\n'
        + '2. Use the Agent tool with a `subtasks` array to execute them concurrently.\n'
        + '3. Each subtask must be self-contained with all context it needs.\n'
        + '4. After all subtasks complete, synthesize a unified summary covering all results.';
    }
    // Lightweight conversation (jokes, greetings, simple Q&A): suppress
    // structured analysis output that pollutes the delivery.
    if (lightweightConversation) {
      const isJokeOrStory = /笑话|段子|joke|riddle|故事|story/i.test(userMessage);
      if (isJokeOrStory) {
        const kind = /故事|story/i.test(userMessage) ? '故事' : '笑话';
        sp += `\n\n# 轻量对话 — ${kind}\n`
          + `直接输出${kind}，不要输出任何分析框架、目标与完成标准、已知/假设/未知等。\n`
          + '格式要求：\n'
          + `1. ${kind}是交付产物，注意排版：每个段落首行缩进两个全角空格（"　　"），对话换行清晰\n`
          + (kind === '故事'
            ? '2. 故事内容必须与软件工程相关（程序员生活、项目开发、技术决策、团队协作等），有情节有结尾\n'
            : '')
          + `${kind === '故事' ? '3' : '2'}. ${kind}结束后空一行，用"💡"开头附一条与${kind}内容直接相关的软件工程知识点：\n`
          + `   - 知识点必须从${kind}中出现的具体技术概念、工具、行为或术语延伸\n`
          + '   - 例如：笑话提到"debug"→讲调试技巧；提到"递归"→讲递归与迭代取舍；提到"git"→讲版本控制实践\n'
          + '   - 优先选择实用、具体的软件工程知识（设计模式、算法、架构原则、工具链、最佳实践等）\n'
          + '   - 不要选与笑话无关的随机知识点\n'
          + `${kind === '故事' ? '4' : '3'}. 知识点不超过两行，简洁实用，每次讲不同的知识点`;
      } else {
        sp += '\n\n# 轻量对话\n'
          + '这是一个简单的对话请求。直接回答，不要输出任何分析框架、'
          + '目标与完成标准、已知/假设/未知、可验证结果等结构化内容。'
          + '只输出用户要求的内容本身。';
      }
    }
    // CoT injection for non-native thinking models. Gated by /thinking: when the
    // toggle is off we skip the <think> instruction entirely so the model spends
    // no tokens on a reasoning block the user asked not to produce.
    if (!_isGreeting && _chatState.thinkingEnabled) {
      const activeModel = requestPreferredModel || (_getModelInfo().model || '');
      if (!_modelSupportsNativeThinking(activeModel)) {
        sp += COT_INJECTION_PROMPT;
      }
    }
    const languageFallback = _buildLanguageFallbackDirective(userMessage, sp);
    if (languageFallback) sp += `\n\n${languageFallback}`;
    // Re-affirm the `--system-prompt` override at end-salience so it governs as the
    // authoritative instruction (Claude Code's full-replace intent) without our
    // removing the safety / tool scaffolding it depends on.
    if (_spOverride) {
      sp += '\n\n[SYSTEM_PROMPT — governing instruction, authoritative]\n' + _spOverride;
    }
    // Claude Code SDK alignment: `--append-system-prompt` (print mode) appends
    // extra guidance to the fully-assembled system prompt.
    const _spAppend = typeof chatOpts.appendSystemPrompt === 'string' ? chatOpts.appendSystemPrompt.trim() : '';
    if (_spAppend) sp += '\n\n' + _spAppend;
    return sp;
  })();
  if (taskSelfAwarenessInjected) {
    onStatus({
      phase: 'init',
      message: `任务自检: 已注入能力边界与执行策略（${taskScaleForPrompt}，步骤 1/1）`,
      elapsed: Date.now() - startTime,
    });
  }
  if (intentAssurance.shouldInject) {
    onStatus({
      phase: 'init',
      message: `意图保护: 已提取主目标、${intentAssurance.constraintCount || 0} 条约束、${intentAssurance.detailCount || 0} 个细节锚点（步骤 1/1）`,
      elapsed: Date.now() - startTime,
    });
  }
  if (intentAssuranceDebugEnabled && !_isGreeting) {
    const debugMessage = intentAssurance.shouldInject
      ? `意图保护调试: 来源 ${externalIntentAssuranceDirective ? 'external' : 'runtime'}，主目标 1 条，约束 ${intentAssurance.constraintCount || 0} 条，锚点 ${intentAssurance.detailCount || 0} 个，尾部补充 ${intentAssurance.tailDetailCount || 0} 条（步骤 1/1）`
      : '意图保护调试: 当前请求较短或噪音较少，未额外注入保护指令，直接按原始问题处理（步骤 1/1）';
    onStatus({
      phase: 'intent_assurance_debug',
      message: debugMessage,
      text: debugMessage,
      elapsed: Date.now() - startTime,
      source: externalIntentAssuranceDirective ? 'external' : 'runtime',
      shouldInject: !!intentAssurance.shouldInject,
      requestClass: String(intentAssurance.requestClass || '').trim(),
      primaryObjective: String(intentAssurance.primaryObjective || intentAssurance.summary || '').trim(),
      summary: String(intentAssurance.summary || '').trim(),
      constraints: Array.isArray(intentAssurance.constraints) ? intentAssurance.constraints.slice(0, 5) : [],
      detailAnchors: Array.isArray(intentAssurance.detailAnchors) ? intentAssurance.detailAnchors.slice(0, 8) : [],
      tailDetails: Array.isArray(intentAssurance.tailDetails) ? intentAssurance.tailDetails.slice(0, 4) : [],
      detailCount: Number(intentAssurance.detailCount || 0),
      constraintCount: Number(intentAssurance.constraintCount || 0),
      tailDetailCount: Number(intentAssurance.tailDetailCount || 0),
    });
  }
  // Emit execution brief for medium+ tasks — after data collection (RAG + pre-fetch)
  if (taskScaleForPrompt !== 'small' && !_isGreeting && !lightweightConversation) {
    // Merge file references: pre-fetch results (real codebase hits) + regex extraction (user-mentioned)
    const regexFiles = _extractFileReferences(userMessage);
    const mergedFiles = [...new Set([..._prefetchFiles, ...regexFiles])].slice(0, 12);
    // Build analysis line from collected data
    const analysisParts = [taskScaleForPrompt === 'large' ? '大型任务' : '中型任务'];
    if (mergedFiles.length > 0) analysisParts.push(`涉及 ${mergedFiles.length} 个文件`);
    if (ragMeta?.selectedCount > 0) analysisParts.push(`${ragMeta.selectedCount} 条知识库上下文`);
    if (codebaseContext) analysisParts.push('已预取代码');
    // P2: Build steps from intent assurance data (constraints + detail anchors)
    const briefSteps = [];
    if (intentAssurance) {
      const obj = String(intentAssurance.primaryObjective || intentAssurance.summary || '').trim();
      if (obj) briefSteps.push(obj);
      if (Array.isArray(intentAssurance.constraints)) {
        for (const c of intentAssurance.constraints.slice(0, 4)) {
          const s = String(c).trim();
          if (s && s.length > 3) briefSteps.push(s);
        }
      }
      if (Array.isArray(intentAssurance.detailAnchors)) {
        for (const d of intentAssurance.detailAnchors.slice(0, 3)) {
          const s = String(d).trim();
          if (s && s.length > 3 && !briefSteps.includes(s)) briefSteps.push(s);
        }
      }
    }
    onStatus({
      phase: 'execution_brief',
      request: userMessage.slice(0, 150),
      scale: taskScaleForPrompt,
      analysis: analysisParts.join('，'),
      steps: briefSteps.length > 0 ? briefSteps : undefined,
      files: mergedFiles,
    });
  }

  const contextPlan = _resolveContextBudget(chatOpts, preset, userMessage);
  const contextBudget = contextPlan.contextBudget;

  // Preemptive context routing (Phase 5)
  let compactMessages;
  let _wasCompacted = false;
  let _aggressiveCompacted = false;

  // Compaction progress plumbing — lets the TUI render a "Compacting
  // conversation…" progress bar tied to the real compression stages emitted by
  // buildSlidingWindow (prune → guard → AI summary → done).
  const _compactStartedAt = Date.now();
  const _compactTokensBefore = (() => {
    try { return _estimateContextTokens(_chatState.messages, fullSystemPrompt, processedMessage); }
    catch { return 0; }
  })();
  let _compactStartEmitted = false;
  const _emitCompactStart = () => {
    if (_compactStartEmitted) return;
    _compactStartEmitted = true;
    onStatus({ phase: 'compacting', stage: 'starting', pct: 5, tokensBefore: _compactTokensBefore, startedAt: _compactStartedAt });
  };
  const _compactOnPhase = ({ stage, pct }) => {
    _emitCompactStart();
    onStatus({ phase: 'compacting', stage, pct, tokensBefore: _compactTokensBefore, startedAt: _compactStartedAt });
  };

  try {
    // s08 L3 preservation: persist oversized tool results to disk BEFORE any
    // routing/truncation runs, so the routing layer only ever shrinks the short
    // <persisted-output> marker instead of discarding real output. In-place on
    // _chatState.messages — persistence is one-way and idempotent (markers are skipped on
    // re-run), so a large result is offloaded once and never re-grows the cost.
    const { persistOversizedToolResults } = require('../services/query/compactPipeline');
    const _persisted = persistOversizedToolResults(_chatState.messages);
    if (_persisted.persistedCount > 0) {
      // Independent, transparent signal — not part of the compacting flow.
      onStatus({ phase: 'tool-result-persisted', count: _persisted.persistedCount, freedChars: _persisted.freedChars });
    }
  } catch (e) {
    console.error('[ai] tool-result persistence skipped:', e?.message);
  }

  try {
    const { routeContextStrategy, truncateToolResults } = require('../services/contextRouter');
    const route = routeContextStrategy(_chatState.messages, fullSystemPrompt, processedMessage, contextBudget);
    if (route.route === 'fits') {
      compactMessages = [..._chatState.messages];
    } else if (route.route === 'truncate_tool_results_only') {
      _emitCompactStart();
      compactMessages = _chatState.messages.map(m => ({ ...m }));
      truncateToolResults(compactMessages, route.overflow);
      _wasCompacted = true;
    } else if (route.route === 'compact_only') {
      _emitCompactStart();
      compactMessages = await runtime.buildSlidingWindow(_chatState.messages, contextBudget, { onPhase: _compactOnPhase });
      _wasCompacted = true;
    } else { // compact_then_truncate
      _emitCompactStart();
      compactMessages = await runtime.buildSlidingWindow(_chatState.messages, contextBudget, { onPhase: _compactOnPhase });
      truncateToolResults(compactMessages, route.overflow);
      _wasCompacted = true;
    }
  } catch (e) {
    // B4: context routing 失败日志
    console.error('[ai] context routing 异常, 回退到 slidingWindow:', e?.message);
    // Fallback: use sliding window directly
    _emitCompactStart();
    compactMessages = await runtime.buildSlidingWindow(_chatState.messages, contextBudget, { onPhase: _compactOnPhase });
    _wasCompacted = true;
  }

  // Hard guard: if estimation is still above budget, force a stricter second compaction pass.
  // A4: 如果已包含摘要，只允许 tool truncation，不重新 buildSlidingWindow
  try {
    const estimated = _estimateContextTokens(compactMessages, fullSystemPrompt, processedMessage);
    if (estimated > contextBudget) {
      const hasExistingSummary = compactMessages.some(m =>
        typeof m.content === 'string' && (
          m.content.includes('[Compressed context summary]') ||
          m.content.includes('[ContextCompact v2')
        )
      );
      if (hasExistingSummary) {
        // 已有摘要 — 只做 tool truncation，避免双重压缩破坏结构
        const { truncateToolResults } = require('../services/contextRouter');
        const overflow = estimated - contextBudget;
        truncateToolResults(compactMessages, overflow);
        _wasCompacted = true;
      } else {
        const strictBudget = Math.max(4096, Math.floor(contextBudget * 0.82));
        compactMessages = await runtime.buildSlidingWindow(compactMessages, strictBudget);
        _wasCompacted = true;
        _aggressiveCompacted = true;
      }
    }
  } catch { /* best effort */ }

  // Notify caller that conversation was compacted
  if (_wasCompacted) {
    // Estimate the post-compaction occupancy so the UI can show the REAL
    // reduction (before → after) instead of just a "compacted" flag. Same
    // estimator used by the hard guard above, so the number is consistent.
    const _compactTokensAfter = (() => {
      try { return _estimateContextTokens(compactMessages, fullSystemPrompt, processedMessage); }
      catch { return 0; }
    })();
    onStatus({
      phase: 'compacted',
      message: 'Conversation compacted (ctrl+o for history)',
      tokensBefore: _compactTokensBefore,
      tokensAfter: _compactTokensAfter,
      durationMs: Date.now() - _compactStartedAt,
    });
    if (_aggressiveCompacted) {
      onStatus({
        phase: 'compacted',
        message: `上下文接近上限，已执行强化压缩（预算 ${Math.round(contextBudget / 1000)}k）`,
      });
    }
  }

  let promptMessages = compactMessages;
  // s09 load-path #2: pull memory bodies relevant to this turn (ranked, capped)
  // and fold them into the final user message, alongside RAG/codebase context.
  let memoryContext = '';
  try {
    // Exclude memories already surfaced by the proactive / priming blocks so a
    // memory is never injected twice in one turn (KHY_MEMORY_RECALL_DEDUP). When
    // dedup is off the set is empty ⇒ same selection as before.
    const _memExclude = (opts && opts.__memSurfaced instanceof Set) ? opts.__memSurfaced : new Set();
    const _unifiedOn = !['0', 'false', 'off', 'no'].includes(
      String(process.env.KHY_MEMORY_RECALL_UNIFIED == null ? '' : process.env.KHY_MEMORY_RECALL_UNIFIED).trim().toLowerCase());
    if (_unifiedOn) {
      // Recency-aware SSOT: rank by keyword × recency (scoring.rankMemories) so the
      // relevant block matches the proactive block's ordering. Honors exclude.
      const memoryEngine = require('../services/memoryEngine');
      memoryContext = String(memoryEngine.buildRelevantMemorySection(userMessage, { exclude: _memExclude }) || '').trim();
    } else {
      // Legacy path (recency-blind overlap). Passing an empty exclude keeps this
      // byte-identical to the pre-existing call.
      const memdir = require('../memdir');
      if (typeof memdir.loadRelevantMemories === 'function') {
        memoryContext = String(memdir.loadRelevantMemories(userMessage, { exclude: _memExclude }) || '').trim();
      }
    }
  } catch { /* memory recall is best-effort */ }
  if ((ragContext || codebaseContext || memoryContext) && compactMessages.length > 0) {
    const lastIndex = compactMessages.length - 1;
    promptMessages = compactMessages.map((msg, idx) => {
      if (idx !== lastIndex) return msg;
      const parts = [
        (() => { try { return require('../services/contentBlockUtils').contentToText(msg.content); } catch { return String(msg.content || ''); } })(),
      ];
      if (memoryContext) {
        parts.push('', '[RELEVANT_MEMORY]', memoryContext, '[/RELEVANT_MEMORY]');
      }
      if (ragContext) {
        parts.push('', '[RAG_CONTEXT]', ragContext, '[/RAG_CONTEXT]');
      }
      if (codebaseContext) {
        parts.push('', '[CODEBASE_CONTEXT]', codebaseContext, '[/CODEBASE_CONTEXT]');
      }
      return { ...msg, content: parts.join('\n') };
    });
  }
  const conversationPrompt = runtime.buildFlatConversation(fullSystemPrompt, promptMessages);

  try {
    await _maybeWarmupLocalPreferredOnce({
      preferredAdapter: effectivePreferredAdapter,
      onStatus: (text) => onStatus({ phase: 'init', message: String(text || '本地模型预热中...'), elapsed: Date.now() - startTime }),
    });
  } catch { /* best effort */ }

  const preferredAdapter = String(effectivePreferredAdapter || '').trim().toLowerCase();
  const localPreferred = preferredAdapter === 'localllm' || preferredAdapter === 'ollama';
  let requestMessage = localPreferred
    ? '请求 AI 服务...（本地模型首轮可能需要 30-120 秒预热）'
    : '请求 AI 服务...';
  try {
    const gw = getGateway();
    const preferredStatus = (gw.getStatus?.() || []).find(
      (s) => String(s?.type || '').trim().toLowerCase() === preferredAdapter
    );
    const remainingMs = Number(preferredStatus?.lastError?.remainingMs || 0);
    if (preferredStatus?.lastError?.coolingDown && remainingMs > 0) {
      const remainSec = Math.max(1, Math.ceil(remainingMs / 1000));
      requestMessage = localPreferred
        ? `请求 AI 服务...（本地通道处于冷却期，约 ${remainSec}s 后恢复；本次可能快速返回）`
        : `请求 AI 服务...（首选通道处于冷却期，约 ${remainSec}s 后恢复；本次可能快速返回）`;
    }
  } catch { /* best effort */ }
  if (localPreferred && !requestMessage.includes('冷却期')) {
    try {
      const localSvc = require('../services/localLLMService');
      let hotAttached = false;
      if (typeof localSvc.tryAdoptHotRunner === 'function') {
        const adopted = await localSvc.tryAdoptHotRunner();
        hotAttached = !!(adopted && adopted.adopted);
      }
      const status = localSvc.getStatus?.() || {};
      if (hotAttached || status.loaded) {
        requestMessage = '请求 AI 服务...（检测到本地模型已热启动，预计更快返回）';
      } else {
        const loopbackOk = await localSvc.canListenLoopback?.();
        if (loopbackOk === false) {
          const reason = String(status.loopbackListenError || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          requestMessage = reason
            ? `请求 AI 服务...（当前运行环境限制本地监听，可能快速失败：${reason}）`
            : '请求 AI 服务...（当前运行环境限制本地监听，可能快速失败）';
        }
      }
    } catch { /* best effort */ }
  }
  onStatus({
    phase: 'request',
    message: requestMessage,
    elapsed: Date.now() - startTime,
  });

  let firstPass = await _generateWithStreamIntercept(
    conversationPrompt,
    fullSystemPrompt,
    compactMessages,
    userMessage,
    chatOpts,
    preset
  );
  let result = firstPass.result;

  // If strict preferred is explicitly disabled, allow one relaxed retry.
  // Otherwise preserve strict mode so we don't silently fall back to relay.
  if (_isStrictPreferredFailure(result) && chatOpts.strictPreferred !== false && !_shouldKeepStrictPreferred(chatOpts)) {
    onStatus({ phase: 'request', message: '首选通道失败，尝试自动回退...', elapsed: Date.now() - startTime });
    const retryPass = await _generateWithStreamIntercept(
      conversationPrompt,
      fullSystemPrompt,
      compactMessages,
      userMessage,
      { ...chatOpts, strictPreferred: false },
      preset
    );
    // Always surface the retry outcome (success or failure) so users don't get
    // stuck with the initial strict-preferred error after fallback was attempted.
    if (retryPass && retryPass.result) {
      result = retryPass.result;
      firstPass = retryPass;
    }
  }

  // s08 reactive compaction: proactive compaction estimates tokens locally, but
  // the API's real count can still exceed the budget and reject the request with
  // prompt_too_long. Mirror Claude Code's reactiveCompact safety net — recompact
  // far more aggressively, then retry the generation ONCE. Without this, an
  // estimator/tokenizer divergence surfaces as a hard failure to the user instead
  // of being silently recovered.
  if (_isContextOverflowFailure(result)) {
    try {
      const reactiveBudget = Math.max(4096, Math.floor(contextBudget * 0.5));
      onStatus({
        phase: 'compacting',
        stage: 'reactive',
        pct: 5,
        message: `上下文超出模型上限，正在反应式压缩后重试（预算 ${Math.round(reactiveBudget / 1000)}k）`,
        tokensBefore: _compactTokensBefore,
        startedAt: _compactStartedAt,
      });
      const reactiveMessages = await runtime.buildSlidingWindow(
        compactMessages,
        reactiveBudget,
        { onPhase: _compactOnPhase }
      );
      const reactivePrompt = runtime.buildFlatConversation(fullSystemPrompt, reactiveMessages);
      onStatus({ phase: 'compacted', message: '已执行反应式压缩，重新请求 AI...' });
      const reactivePass = await _generateWithStreamIntercept(
        reactivePrompt,
        fullSystemPrompt,
        reactiveMessages,
        userMessage,
        chatOpts,
        preset
      );
      if (reactivePass && reactivePass.result) {
        result = reactivePass.result;
        firstPass = reactivePass;
        compactMessages = reactiveMessages;
      }
    } catch (e) {
      console.error('[ai] reactive compaction 失败:', e?.message);
    }
  }

  // API 限流(429)自动重试:对齐 Claude Code「Retrying… (attempt X/Y)」。限流是瞬态,
  // 请求根本没发出去,正确做法是**等冷却窗口过去再原样重发**,而非把失败甩给用户手动
  // 「继续」。自动退避重试至多 N 轮(默认 10),逐轮明文显示「第 n/N 轮」与剩余秒数。
  // 门控 KHY_RATE_LIMIT_AUTORETRY 关 → maxRounds=0 → 跳过整个循环,逐字节回退到今日行为。
  try {
    const _rl = require('./rateLimitRetry');
    const _rlMax = _rl.maxRounds(process.env);
    if (_rlMax > 0 && result && result.success === false && _rl.isRateLimitErrorType(result.errorType)) {
      for (let round = 1; round <= _rlMax; round++) {
        // 必须等到本轮的冷却窗口过去,否则重发只会再次命中网关的缓存快速失败。
        const waitMs = _rl.resolveCooldownMs(result, round - 1);
        await _waitRateLimitRetryWithCountdown(onStatus, { round, maxRounds: _rlMax, waitMs });

        const rlPass = await _generateWithStreamIntercept(
          conversationPrompt,
          fullSystemPrompt,
          compactMessages,
          userMessage,
          chatOpts,
          preset
        );
        if (rlPass && rlPass.result) {
          result = rlPass.result;
          firstPass = rlPass;
        }
        if (result && result.success) {
          onStatus({
            phase: 'request',
            message: `限流已恢复，第 ${round} 轮重试成功`,
            elapsed: Date.now() - startTime,
          });
          break;
        }
        // 变成别的错误(非限流)→ 交给下方常规失败处理,不再空转限流重试。
        if (!_rl.isRateLimitErrorType(result && result.errorType)) break;
      }
      // 全部耗尽仍限流:给结果补一句「已自动重试 N 轮」,下方失败分支照常带出诊断 + 「继续」。
      if (result && result.success === false && _rl.isRateLimitErrorType(result.errorType)) {
        try {
          const note = _rl.buildExhaustedNote(_rlMax);
          if (result.content && !String(result.content).includes(note)) {
            result = { ...result, content: `${result.content}\n\n${note}` };
          } else if (!result.content) {
            result = { ...result, content: note };
          }
        } catch { /* best effort note */ }
      }
    }
  } catch (e) {
    console.error('[ai] rate-limit auto-retry 失败:', e?.message);
  }

  if (!result || !result.success) {
    const compactFailureReason = String(
      (result && (result.content || result.error || result.errorType)) || 'AI 请求失败'
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);

    const elapsed = Date.now() - startTime;
    onStatus({
      phase: 'request',
      message: `失败原因: ${compactFailureReason || 'AI 请求失败'}`,
      elapsed,
    });
    onStatus({
      phase: 'done',
      message: '失败',
      elapsed,
      ok: false,
      errorType: (result && result.errorType) || 'unknown',
    });

    let errorMsg = (result && result.content) ? result.content : 'AI 请求失败。';
    const failureDetails = _formatGatewayFailureDetails(result);
    if (failureDetails && !/真实失败原因/.test(errorMsg)) {
      errorMsg = `${errorMsg}\n\n${failureDetails}`;
    }
    const tuneResult = _recordLatencySample({
      success: false,
      errorType: (result && result.errorType) || 'unknown',
      adapter: (result && (result.adapter || result.provider)) || 'none',
    });
    _maybeAnnounceAutoTune(tuneResult);
    // DESIGN-ARCH-046: un-commit this turn's orphaned user message from the
    // authoritative history so the failed request does not corrupt the next turn.
    _uncommitOrphanTurn(_turnCommittedMsg);
    // 续接提示：可恢复类错误（网络熔断等）告知用户可说「继续」从断点推进，
    // 不可恢复类（安全/权限）不提示，避免诱导无意义重试。
    const _gwErrType = (result && result.errorType) || 'unknown';
    let _gwReply = errorMsg;
    let _gwResumable = _isResumableError(_gwErrType);
    if (_gwResumable && !/继续/.test(_gwReply)) {
      _gwReply = `${_gwReply}\n\n${_CONTINUE_HINT}`;
    }
    return {
      reply: _gwReply,
      commands: [],
      errorType: _gwErrType,
      failureDetails,
      resumable: _gwResumable,
      continueHint: _gwResumable ? _CONTINUE_HINT : null,
    };
  }

  let reply = String(result.content || '').trim();
  if (!reply && result.thinking) {
    // Model produced thinking but no content (e.g. all reasoning was in <think> block).
    // Use thinking as the reply so the user gets a response.
    reply = result.thinking.trim();
  }
  // When model returns only tool_use blocks with no text, synthesize a response
  // so the toolUseLoop can process the tool calls instead of showing "no reply"
  if (!reply && firstPass.toolUseBlocks && firstPass.toolUseBlocks.length > 0) {
    const toolNames = firstPass.toolUseBlocks.map(b => b.name || 'unknown').join(', ');
    reply = `[模型请求执行工具: ${toolNames}]`;
  }
  if (!reply) {
    const tuneResult = _recordLatencySample({
      success: false,
      errorType: 'empty_reply',
      adapter: (result && (result.adapter || result.provider)) || 'none',
    });
    _maybeAnnounceAutoTune(tuneResult);

    // 救援优先：模型空响应但历史里有「刚刚成功执行」的工具结果时，直接回显该结果，
    // 避免「工具已成功、却报『未返回有效回复』」的中途截断观感（实测：执行命令后追问
    // 「结果呢」连续空响应）。捞回失败则继续走下方诊断。
    const _salvaged = _salvageRecentToolResult(_chatState.messages);
    if (_salvaged) {
      _uncommitOrphanTurn(_turnCommittedMsg);
      return {
        reply: `${_salvaged}\n\n（注：AI 未生成额外总结，以上为工具的实际输出。需要的话可说「继续」让我据此分析。）`,
        commands: [],
        errorType: 'empty_reply_salvaged',
        provider: (result && (result.adapter || result.provider)) || null,
        resumable: true,
        continueHint: _CONTINUE_HINT,
      };
    }

    // 截断判定：适配器回传的 stopReason/finishReason 命中 length/max_tokens 时，
    // 这是确定性的「被截断」而非「可能」，措辞据此区分（避免误导用户排查网络）。
    const _stopReason = String((result && (result.stopReason || result.finishReason)) || '').toLowerCase();
    const _wasTruncated = /length|max[_-]?tokens|max[_-]?output/.test(_stopReason);

    // Diagnose: distinguish a genuine empty model reply from a backend that
    // actually failed (surfaced as "empty"), or a degraded tool subsystem.
    let emptyMsg = 'AI 未返回有效回复 — 请重试或检查连接';
    const failureDetails = _formatGatewayFailureDetails(result);
    if (failureDetails) {
      emptyMsg = `AI 未返回内容，但底层适配器有失败记录：\n\n${failureDetails}`;
    } else {
      const hints = [];
      // Only surface a subsystem-degradation hint when the user's request
      // actually relates to that subsystem — otherwise a plain greeting like
      // "你好" wrongly blames cheerio / image-gen. Intent is gated on the
      // message text; the degradation itself is still a fact-based check.
      const _msgText = String(userMessage || '').toLowerCase();
      const _looksLikeSearch = /搜索|查一下|查询|搜一下|最新|新闻|是谁|多少|什么时候|在哪|资料|search|lookup|news|latest/.test(_msgText);
      const _looksLikeImage = /画|绘|生成图|配图|图片|插画|海报|draw|image|picture|logo|图标/.test(_msgText);
      if (_looksLikeSearch) {
        try {
          const ws = require('../services/webSearchService');
          if (ws.isHtmlParsingAvailable && !ws.isHtmlParsingAvailable()) {
            hints.push('· 搜索子系统降级：cheerio 未安装，请在 services/backend 执行 npm install。');
          }
        } catch { /* ignore */ }
      }
      if (_looksLikeImage) {
        try {
          const igs = require('../services/imageGenService');
          if (igs.isAnyBackendConfigured && !igs.isAnyBackendConfigured()) {
            hints.push('· 如需绘图：未配置图像生成后端（设置 KHY_IMAGE_GEN_* 环境变量）。');
          }
        } catch { /* ignore */ }
      }
      if (hints.length) {
        emptyMsg += `\n\n可能原因：\n${hints.join('\n')}`;
      } else if (_wasTruncated) {
        // 确定性截断（finish_reason=length/max_tokens）：不写「可能」，直接给修复方向。
        emptyMsg += `\n\n原因：模型输出在生成总结前被 max_tokens 截断（finish_reason=${_stopReason}）。`
          + '请调大 KHY 网关 maxTokens（本地模型对应 num_predict），或说「继续」从断点续写。';
      } else {
        // Common local-model case: a small reasoning model spent its whole
        // output budget thinking and never emitted a final answer.
        emptyMsg += '\n\n可能原因：模型只输出了思考内容/被 max_tokens 截断，或上下文过长。'
          + '本地小模型可调大 num_predict（KHY 网关 maxTokens），或换更大模型重试。';
      }
    }

    // 续接提示：空响应（E01）可恢复——告知用户说「继续」即可从断点重试推进。
    if (!/继续/.test(emptyMsg)) {
      emptyMsg += `\n\n${_CONTINUE_HINT}`;
    }

    // DESIGN-ARCH-046: un-commit this turn's orphaned user message so an empty
    // reply does not strand it in the authoritative history. The loop's
    // empty-reply retry re-supplies the message cleanly (no duplicate stacking).
    _uncommitOrphanTurn(_turnCommittedMsg);
    return {
      reply: emptyMsg,
      commands: [],
      errorType: 'empty_reply',
      failureDetails,
      provider: (result && (result.adapter || result.provider)) || null,
      resumable: true,
      continueHint: _CONTINUE_HINT,
    };
  }

  const effectiveTaskScale = _resolveTaskScale(userMessage, opts);
  if (!opts.disableNaturalToolLoop) {
    // Intent-aware inner loop boost
    let intentInnerBoost = 0;
    try {
      const { detectModes, getLoopLimitBoost } = require('../services/intentGate');
      const detected = detectModes(userMessage);
      intentInnerBoost = getLoopLimitBoost(detected.modes).innerBoost;
    } catch { /* intentGate not available */ }

    // Natural language tool gateway loop (max 5 turns, with timeout + retry)
    const TOOL_LOOP_MAX = (effectiveTaskScale === 'large'
      ? Math.max(8, parseInt(String(process.env.KHY_TOOL_LOOP_MAX_LARGE || '12'), 10) || 12)
      : (effectiveTaskScale === 'small'
        ? Math.max(3, parseInt(String(process.env.KHY_TOOL_LOOP_MAX_SMALL || '4'), 10) || 4)
        : Math.max(5, parseInt(String(process.env.KHY_TOOL_LOOP_MAX || '8'), 10) || 8))
    ) + intentInnerBoost;
    const TOOL_LOOP_TIMEOUT_MS = effectiveTaskScale === 'large'
      ? Math.max(600000, parseInt(String(process.env.KHY_TOOL_LOOP_TIMEOUT_LARGE_MS || '900000'), 10) || 900000)
      : Math.max(120000, parseInt(String(process.env.KHY_TOOL_LOOP_TIMEOUT_MS || '180000'), 10) || 180000);
    let loopCount = 0;
    let consecutiveErrors = 0;
    // Track all tool results so we can fall back to them if follow-up generation fails
    const collectedToolResults = [];
    // Dedup: prevent model from calling same tool+params repeatedly
    const seenToolCalls = new Set();

    // ── Phase 1: Plan extraction ──
    // Extract [Plan] from the model's first response before entering the tool loop
    let workPlan = null;
    {
      const planInfo = _extractPlan(reply);
      if (planInfo.plan) {
        workPlan = planInfo.plan;
        reply = planInfo.cleaned;
        onStatus({ phase: 'plan', message: `计划：${workPlan}`, elapsed: Date.now() - startTime });
      }
    }

    while (loopCount < TOOL_LOOP_MAX) {
      const call = runtime.extractNaturalToolCall(reply);
      if (!call) break;

      // Duplicate detection: same tool + same args = skip and force reply from results
      const callKey = JSON.stringify({ a: call.action, p: call.arg });
      if (seenToolCalls.has(callKey)) {
        // Model is repeating itself — stop the loop and summarize
        reply = _buildToolFallbackReply(collectedToolResults);
        if (!reply) reply = 'Tool loop detected a repeated call. Stopping.';
        break;
      }
      seenToolCalls.add(callKey);

      loopCount += 1;

      // ── Phase 2: Progress reporting ──
      const progressLabel = _toolProgressLabel(call.action, call.arg);
      onStatus({
        phase: 'tool_progress',
        message: `[${loopCount}/${TOOL_LOOP_MAX}] ${progressLabel}`,
        toolName: call.action,
        // Structured arg ({file_path, pattern, command, …}) so the REPL can derive
        // the same "正在 … 里搜索" live target the TUI shows (shared statusLabels).
        toolArg: call.arg,
        step: loopCount,
        elapsed: Date.now() - startTime,
      });

      let toolResult;
      let toolSuccess = false;
      try {
        const executed = await _runNaturalToolCallWithIdleTimeout(call, {
          idleTimeoutMs: TOOL_LOOP_TIMEOUT_MS,
          onActivity: () => {
            onStatus({
              phase: 'tool_progress',
              message: `[${loopCount}/${TOOL_LOOP_MAX}] ${call.action} 执行中...`,
              toolName: call.action,
              step: loopCount,
              elapsed: Date.now() - startTime,
            });
          },
          onProgress: (payload) => {
            const msg = typeof payload === 'string' && payload.trim()
              ? payload.trim().slice(0, 120)
              : `${call.action} 执行中`;
            onStatus({
              phase: 'tool_progress',
              message: `[${loopCount}/${TOOL_LOOP_MAX}] ${msg}`,
              toolName: call.action,
              step: loopCount,
              elapsed: Date.now() - startTime,
            });
          },
        });
        if (executed && executed.success) {
          toolResult = `[Tool:${call.action}] ${executed.text}`;
          toolSuccess = true;
          consecutiveErrors = 0;
          onStatus({
            phase: 'tool_progress',
            message: `[${loopCount}/${TOOL_LOOP_MAX}] ${call.action} ✓`,
            toolName: call.action,
            step: loopCount,
            success: true,
            elapsed: Date.now() - startTime,
          });
        } else {
          toolResult = `[Tool:${call.action}] ERROR: ${(executed && executed.text) || 'failed'}`;
          consecutiveErrors += 1;
          onStatus({
            phase: 'tool_progress',
            message: `[${loopCount}/${TOOL_LOOP_MAX}] ${call.action} ✗`,
            toolName: call.action,
            step: loopCount,
            success: false,
            elapsed: Date.now() - startTime,
          });
        }
      } catch (e) {
        toolResult = `[Tool:${call.action}] ERROR: ${e.message}`;
        consecutiveErrors += 1;
        onStatus({
          phase: 'tool_progress',
          message: `[${loopCount}/${TOOL_LOOP_MAX}] ${call.action} ✗ ${e.message.slice(0, 60)}`,
          toolName: call.action,
          step: loopCount,
          success: false,
          elapsed: Date.now() - startTime,
        });
      }

      collectedToolResults.push({ action: call.action, arg: call.arg, result: toolResult, success: toolSuccess });

      // Bail out after 2 consecutive tool errors to avoid infinite failure loops
      if (consecutiveErrors >= 2) {
        _chatState.messages.push({ role: 'user', content: `[Tool Result]\n${toolResult}` });
        reply = _buildToolFallbackReply(collectedToolResults);
        reply += `\n\n⚠️ 工具连续失败 ${consecutiveErrors} 次，已停止工具循环。`;
        break;
      }

      _chatState.messages.push({ role: 'user', content: `[Tool Result]\n${toolResult}` });

      // Intent-aware nudge: if user asked to modify/edit and model only Read so far,
      // append a system hint to guide the model to call Edit next.
      if (toolSuccess && call.action === 'Read' && loopCount === 1) {
        const modifyIntent = /修改|改|编辑|添加|加一个|增加|替换|重构|重写|更新|删除|移除/i.test(userMessage)
          || /modify|edit|add|change|update|refactor|replace|remove|delete/i.test(userMessage);
        if (modifyIntent) {
          _chatState.messages.push({
            role: 'system',
            content: 'Reminder: The user asked you to MODIFY this file. You have read it — now call the Edit tool with exact old_string from the content above to make the change.',
          });
        }
      }

      // Preemptive context routing for loop path (Phase 5)
      let compactLoopMessages;
      try {
        const { routeContextStrategy, truncateToolResults } = require('../services/contextRouter');
        const loopRoute = routeContextStrategy(_chatState.messages, fullSystemPrompt, '', contextBudget);
        if (loopRoute.route === 'fits') {
          compactLoopMessages = [..._chatState.messages];
        } else if (loopRoute.route === 'truncate_tool_results_only') {
          compactLoopMessages = _chatState.messages.map(m => ({ ...m }));
          truncateToolResults(compactLoopMessages, loopRoute.overflow);
        } else if (loopRoute.route === 'compact_only') {
          compactLoopMessages = await runtime.buildSlidingWindow(_chatState.messages, contextBudget);
        } else {
          compactLoopMessages = await runtime.buildSlidingWindow(_chatState.messages, contextBudget);
          truncateToolResults(compactLoopMessages, loopRoute.overflow);
        }
      } catch {
        compactLoopMessages = await runtime.buildSlidingWindow(_chatState.messages, contextBudget);
      }

      try {
        const estimatedLoop = _estimateContextTokens(compactLoopMessages, fullSystemPrompt, '');
        if (estimatedLoop > contextBudget) {
          compactLoopMessages = await runtime.buildSlidingWindow(
            compactLoopMessages,
            Math.max(4096, Math.floor(contextBudget * 0.82))
          );
          onStatus({
            phase: 'compacted',
            message: `工具循环上下文过大，已强化压缩（预算 ${Math.round(contextBudget / 1000)}k）`,
            elapsed: Date.now() - startTime,
          });
        }
      } catch { /* best effort */ }

      if (!compactLoopMessages || compactLoopMessages.length === 0) {
        compactLoopMessages = await runtime.buildSlidingWindow(_chatState.messages, Math.max(4096, Math.floor(contextBudget * 0.82)));
      }

      const loopPrompt = runtime.buildFlatConversation(fullSystemPrompt, compactLoopMessages);

      const loopPass = await _generateWithStreamIntercept(
        loopPrompt,
        fullSystemPrompt,
        compactLoopMessages,
        userMessage,
        chatOpts,
        preset
      );
      let loopRes = loopPass.result;

      if (!loopRes || !loopRes.success) {
        // Retry once on generation failure
        try {
          loopRes = await _directGenerate(loopPrompt, userMessage, opts, preset);
        } catch {
          // Follow-up generation failed — fall back to tool results summary
          reply = _buildToolFallbackReply(collectedToolResults);
          break;
        }
        if (!loopRes || !loopRes.success) {
          reply = _buildToolFallbackReply(collectedToolResults);
          break;
        }
      }

      reply = String(loopRes.content || '').trim();
      if (!reply) {
        reply = _buildToolFallbackReply(collectedToolResults);
        break;
      }
    }

    // If loop exhausted: use collected tool results as the reply foundation
    if (loopCount >= TOOL_LOOP_MAX) {
      const hasRemainingCall = runtime.extractNaturalToolCall(reply);
      if (hasRemainingCall || !reply.trim()) {
        // Model was still trying to call tools — use accumulated results instead
        reply = _buildToolFallbackReply(collectedToolResults);
      }
    }

    // Final safety: strip any remaining raw <tool_call> tags from the reply
    reply = reply.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    if (!reply && collectedToolResults.length > 0) {
      reply = _buildToolFallbackReply(collectedToolResults);
    }

    // ── Phase 3: Work Summary ──
    // Extract model-provided [Summary] or generate one from tool results.
    // Emit as a status event but keep summary text in the reply if stripping
    // would leave it empty.
    if (collectedToolResults.length > 0) {
      let workSummary = null;
      const summaryMatch = reply.match(/\[Summary\]\s*(.+)$/m);
      if (summaryMatch) {
        workSummary = summaryMatch[1].trim();
        const stripped = reply.replace(summaryMatch[0], '').trim();
        // Only strip [Summary] tag from reply if there is other content left;
        // otherwise keep the summary text as the reply body (without the tag prefix).
        reply = stripped || workSummary;
      } else {
        // Model didn't provide a summary — generate one from tool results
        workSummary = _buildWorkSummary(collectedToolResults);
      }
      if (workSummary) {
        onStatus({
          phase: 'summary',
          message: `摘要：${workSummary}`,
          plan: workPlan,
          toolCount: collectedToolResults.length,
          elapsed: Date.now() - startTime,
        });
      }
    }

    // Strip [Plan] tags from reply but preserve content if it would be empty
    {
      const planLine = reply.match(/^\[Plan\]\s*.+$/m);
      if (planLine) {
        const stripped = reply.replace(planLine[0], '').trim();
        if (stripped) reply = stripped;
        else reply = reply.replace(/^\[Plan\]\s*/, '').trim();
      }
    }

    // Detect degenerate reply: model just echoed plan steps (e.g. "1) Read 2) Edit 3) Done")
    // instead of providing actual results. Replace with tool fallback.
    if (collectedToolResults.length > 0) {
      const trimmed = reply.trim();
      const looksLikePlanEcho = /^\d\)\s/.test(trimmed) && trimmed.split('\n').length <= 4 && trimmed.length < 200;
      if (looksLikePlanEcho) {
        reply = _buildToolFallbackReply(collectedToolResults);
      }
    }

    // Incomplete action detection: if user wanted modification but model only Read
    // and never called Edit/Write, append a diagnostic hint to the reply.
    if (collectedToolResults.length > 0) {
      const actionNames = collectedToolResults.map(t => t.action).filter(Boolean);
      const onlyRead = actionNames.length > 0 && actionNames.every(a => a === 'Read');
      const modifyIntent = /修改|改[成为]|编辑|添加|加一个|增加|替换|重构|重写|更新|删除|移除/i.test(userMessage)
        || /modify|edit|add.*param|change|update|refactor|replace|remove|delete/i.test(userMessage);
      if (onlyRead && modifyIntent) {
        reply += '\n\n> 提示：文件已读取，但修改尚未自动应用。你可以让我重试编辑，或根据上面的文件内容手动修改。';
      }
    }
  }

  _chatState.messages.push({ role: 'assistant', content: (() => {
    try {
      const { buildAssistantContent } = require('../services/contentBlockUtils');
      return buildAssistantContent(reply, firstPass.toolUseBlocks, firstPass.thinkingBlocks);
    } catch { return reply; }
  })(),
  // DESIGN-ARCH-047 P1: 溯源信封提示——据本轮实际 adapter/provider 身份判 producer/trust。
  // 经外部 agent 中转（codex/claude-code/relay）的正文标 CLAIMED；本地原生标 VERIFIED。
  // 仅元数据，appendMessage 持久化时落 `_khyTrace`，绝不进入模型可见内容。
  // P4: 仅对中转正文（producer != khy-local）确定性核对动作声称 vs 本地工具日志，矛盾注入
  // contradictions（fail-OPEN，无模型，绝不阻断 turn / 不改正文）。
  _khyProvenance: (() => {
    try {
      const traj = require('../services/trajectoryProvenance');
      const hint = traj.classify({ adapter: result.adapter, provider: result.provider, model: result.model });
      if (hint && hint.producer && hint.producer !== traj.PRODUCER.KHY_LOCAL) {
        const log = (collectedToolResults || []).map((t) => ({ tool: t.action, params: t.arg, success: t.success }));
        const { contradictions } = traj.claimReconciler.reconcile(reply, log);
        if (contradictions && contradictions.length) hint.contradictions = contradictions;
      }
      return hint;
    } catch { return undefined; }
  })(),
  });
  if (_chatState.messages.length > MAX_HISTORY) _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);
  _persistLiveSession();   // append-only JSONL transcript + snapshot to ~/.khy/sessions
  // 会话拓扑 consolidate(学自 Stello 的 fire-and-forget):每 N 轮把本会话 history 蒸馏进
  // memory 槽,供跨支综合/orchestrator 读取。刻意 **不 await**、`.catch(()=>{})`,绝不阻塞
  // 或翻红当轮(对齐 Stello consolidate)。门控 KHY_SESSION_SLOTS,节拍 KHY_CONSOLIDATE_EVERY。
  try {
    const _forest = require('../services/session/sessionForestService');
    Promise.resolve(_forest.consolidateCurrent({
      messages: _chatState.messages,
      sessionId: _ensureLiveSessionId(),
    })).catch(() => {});
  } catch { /* consolidate is best-effort — never affects the turn */ }

  let safeReply = reply;
  try {
    const { sanitizeOutput } = require('../services/securityGuardService');
    safeReply = sanitizeOutput(reply);
  } catch {}

  // Local enforcement of output formatting (replaces system prompt rules R1, R10, R14)
  safeReply = runtime.postProcessOutput(safeReply);

  let tokenUsage = result.tokenUsage || null;
  try {
    const { recordUsage, estimateTokens } = require('../services/tokenUsageService');
    if (!tokenUsage) {
      tokenUsage = {
        inputTokens: estimateTokens(conversationPrompt),
        outputTokens: estimateTokens(reply),
        totalTokens: estimateTokens(conversationPrompt) + estimateTokens(reply),
      };
    }
    recordUsage(result.provider || 'unknown', result.model || '', tokenUsage.inputTokens, tokenUsage.outputTokens, 0);
  } catch {}

  try {
    const { recordConversation } = require('../services/modelTrainingService');
    recordConversation(userMessage, reply, {
      provider: result.provider,
      model: result.model || '',
      tokenCount: tokenUsage ? tokenUsage.totalTokens : 0,
      quality: 'neutral',
    });
  } catch {}

  try {
    const { recordResponseStyle } = require('../services/agentCommunicationService');
    recordResponseStyle(userMessage, reply, { provider: result.provider });
  } catch {}

  try {
    const { extractKnowledge } = require('../services/knowledgeTeachingService');
    extractKnowledge(userMessage, reply);
  } catch {}

  try {
    const { recordModelUsage, recordInteraction: recordHabit } = require('../services/usageHabitService');
    const taskType = _classifyTaskType(userMessage);
    recordModelUsage(result.adapter || result.provider, result.model || '', taskType, 1);
    recordHabit(userMessage);
  } catch {}

  const elapsed = Date.now() - startTime;

  // Synthetic lifecycle events for Codex adapter (which bypasses natural tool loop)
  if (String(result.adapter || '').toLowerCase() === 'codex' && result.toolSummary) {
    // Only emit a plan status when the adapter actually ran tools — for simple
    // text-only replies (jokes, explanations, etc.) the "plan" would just be
    // the first sentence of the reply echoed back, which is noise.
    const ts = result.toolSummary;
    if (ts && ts.totalCalls > 0) {
      const firstSentence = safeReply.split(/[.。!\n]/)[0]?.trim();
      if (firstSentence && firstSentence.length > 5) {
        onStatus({ phase: 'plan', message: `计划：${firstSentence}`, elapsed });
      }
    }
    // Emit tool summary
    if (ts.totalCalls > 0) {
      // 时长走 ccFormatDurationOr SSOT(cli/ccFormat,门控 KHY_CC_FORMAT),与 turn-stats /
      // router agent 完成行 / spinner 同口径:门控开 → 305.0s 显 "5m 5s"、3.4s 显 "3s";
      // 关 → 逐字节回退原 `${toFixed(1)}s`。此前本行裸 toFixed(1) 是绕过 SSOT 的孤儿。
      let dur = '';
      if (ts.totalDurationMs > 0) {
        const _durLegacy = `${(ts.totalDurationMs / 1000).toFixed(1)}s`;
        dur = ` · ${require('./ccFormat').ccFormatDurationOr(ts.totalDurationMs, _durLegacy, process.env)}`;
      }
      onStatus({ phase: 'summary', message: `Codex 执行了 ${ts.totalCalls} 次工具调用${dur}`, elapsed });
    }
  }

  // Fallback delivery summary for black-box adapters (Codex, Claude Direct)
  // that run internal tool loops but may return truncated/incomplete replies.
  if (result.toolSummary && result.toolSummary.totalCalls > 0) {
    const replyLen = safeReply.replace(/\s/g, '').length;
    const hasSummaryIndicator = /完成|成功|已.*整理|已.*创建|summary|done|completed|organized/i.test(safeReply);
    if (replyLen < 100 || !hasSummaryIndicator) {
      const ts = result.toolSummary;
      // 同上:执行完成汇总行的耗时也走 ccFormatDurationOr SSOT(门控 KHY_CC_FORMAT),
      // 长 tool-loop 显 "5m 5s" 而非 "305.0s";门控关 → 逐字节回退原 `${toFixed(1)}s`。
      let dur = '';
      if (ts.totalDurationMs > 0) {
        const _durLegacy = `${(ts.totalDurationMs / 1000).toFixed(1)}s`;
        dur = require('./ccFormat').ccFormatDurationOr(ts.totalDurationMs, _durLegacy, process.env);
      }
      safeReply += `\n\n---\n执行完成（${ts.totalCalls} 次工具调用${dur ? `，耗时 ${dur}` : ''}）。`;
      const fileOps = Array.isArray(ts.fileOps) ? ts.fileOps : [];
      if (fileOps.length > 0) {
        const ops = fileOps
          .slice(0, 5)
          .map((op) => {
            const operation = String(op?.operation || '').toLowerCase();
            const fp = op?.path || op?.toPath || op?.fromPath || '';
            const fromPath = op?.fromPath || '';
            const toPath = op?.toPath || '';
            if (operation === 'rename') return fromPath && toPath ? `- 重命名 ${fromPath} -> ${toPath}` : null;
            if (operation === 'move') return fromPath && toPath ? `- 移动 ${fromPath} -> ${toPath}` : null;
            if (operation === 'delete') return fp ? `- 删除 ${fp}` : null;
            if (operation === 'modify') return fp ? `- 修改 ${fp}` : null;
            if (operation === 'create' || operation === 'scaffold') return fp ? `- 创建 ${fp}` : null;
            return fp ? `- 处理 ${fp}` : null;
          })
          .filter(Boolean);
        if (ops.length > 0) safeReply += '\n' + ops.join('\n');
      } else if (Array.isArray(result.toolCallLog) && result.toolCallLog.length > 0) {
        const ops = result.toolCallLog
          .filter(t => /bash|shell|write|edit|create/i.test(String(t.tool || '')))
          .slice(0, 5)
          .map(t => {
            const tool = String(t.tool || '');
            const p = t.params || {};
            if (/bash|shell/i.test(tool)) {
              const cmd = String(p.command || '').trim();
              return `- \`${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd}\`${t.success ? '' : ' (失败)'}`;
            }
            const fp = p.file_path || p.path || p.filePath || '';
            return fp ? `- ${/write|create/i.test(tool) ? '创建' : '修改'} ${fp}` : null;
          })
          .filter(Boolean);
        if (ops.length > 0) safeReply += '\n' + ops.join('\n');
      }
    }
  }

  onStatus({ phase: 'done', message: '完成', elapsed });

  try {
    const hud = require('./hudRenderer');
    if (tokenUsage?.inputTokens) {
      const limit = hud.getContextLimit(result.model || '');
      // 占用率喂入值走 SSOT:加回读/写缓存段(对齐 CC context.ts totalInputTokens
      // = input + cache_creation + cache_read;门控关 → 仅 inputTokens 字节回退)。
      const { contextResidentTokensOr } = require('./contextResidentTokens');
      hud.setContextUsage(contextResidentTokensOr(tokenUsage, tokenUsage.inputTokens, process.env), limit);
    }
    // Forward model/adapter/cost to HUD status bar
    const modelName = result.model || '';
    const adapterName = result.adapter || result.provider || '';
    let turnCostUSD = 0;
    try {
      const tokenSvc = require('../services/tokenUsageService');
      turnCostUSD = tokenSvc.estimateCost(
        tokenUsage?.inputTokens || 0,
        tokenUsage?.outputTokens || 0,
        modelName || adapterName,
      );
    } catch { /* cost estimation not critical */ }
    hud.updateModelInfo(modelName, adapterName, turnCostUSD);
  } catch {}

  const tuneResult = _recordLatencySample({
    success: true,
    adapter: (result && (result.adapter || result.provider)) || 'unknown',
    errorType: '',
    syntheticFirstToken: firstTokenAt <= 0 && !!safeReply,
  });
  _maybeAnnounceAutoTune(tuneResult);

  return {
    reply: safeReply,
    thinking: result.thinking || null,
    commands: [],
    provider: result.provider,
    adapter: result.adapter,
    tokenUsage,
    toolSummary: result.toolSummary || null,
    toolCallLog: result.toolCallLog || [],
    toolUseBlocks: firstPass.toolUseBlocks || [],
    thinkingBlocks: firstPass.thinkingBlocks || [],
    _streamingExecutor: firstPass._streamingExecutor || null, // Phase 7
    // Include finishReason so a streamed max_tokens cutoff is not lost here and the
    // truncation auto-continue can fire (mirrors the gateway result mapping).
    stopReason: result.stopReason || result.finishReason || null,
    retrieval: ragMeta,
    elapsed,
    effort,
  };
}

module.exports = {
  chat,
  _stripHarnessScaffolding,
  _assessTaskDifficulty,
  _buildStructuredMessages,
  _isContextOverflowFailure,
  checkModelCapability,
  setAiChatCoreDeps,
};
