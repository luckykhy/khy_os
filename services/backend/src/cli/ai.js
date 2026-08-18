/**
 * KHY upgraded AI entry — hardened prompt, purified input, compact context,
 * NL tool gateway fallback for models without native tool calling.
 *
 * This file is the main entry point (require('./ai')) and orchestrates the
 * sub-modules: aiGatewayClient, aiSession, aiConversationOps. It retains
 * constants, service accessors, model capabilities, effort/thinking logic,
 * and the dependency-injection wiring to aiChatCore.
 *
 * @module cli/ai
 */
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const runtime = require('../services/khyUpgradeRuntime');

const _aiChatCore = require('./aiChatCore');
const _chatState = require('./aiChatState');
const _aiConversationOps = require('./aiConversationOps');
const _aiGatewayClient = require('./aiGatewayClient');
const _aiGGH = require('./aiGatewayGenerateHelpers');
const _localState = require('./aiLocalState');
const { foldOutput } = require('./toolDisplayPolicy');

// ── Shared state singletons ──

// ── God-file split: chat core (already extracted) ──
const {
  chat,
  _stripHarnessScaffolding,
  _assessTaskDifficulty,
  _buildStructuredMessages,
  _isContextOverflowFailure,
  checkModelCapability,
} = _aiChatCore;

// ── Sub-modules (extracted from this file) ──
const _aiSession = require('./aiSession');

// ── Gateway Generate Helpers (sibling module) ──
_aiGGH.setAiGatewayGenerateHelpersDeps({
  _resolveAuditTraceContext: _aiGatewayClient._resolveAuditTraceContext,
  _logStandaloneLlmRequest: _aiGatewayClient._logStandaloneLlmRequest,
  _logStandaloneLlmResponse: _aiGatewayClient._logStandaloneLlmResponse,
  getService,
});
const _salvageRecentToolResult = _aiGGH._salvageRecentToolResult;

// ── Request-analysis helpers ──
const {
  _resolveModelContextLimit,
  _guessModelHint,
  _estimateContextTokens,
  _resolveContextBudget,
  _applyVisionRouting,
  setAiRequestAnalysisDeps,
} = require('./aiRequestAnalysis');

// ── Request-parsing / stream-interception helpers ──
const {
  _TOOL_CALL_MARKERS,
  _partialToolMarkerTailLen,
  _STREAM_TOOL_RAWINPUT_OFF,
  _streamToolRawInputEnabled,
  _resolveToolBlockInput,
  _createStreamToolInterceptor,
  _classifyGatewayThrownError,
  _isFirstTokenSignalChunk,
  _isTransientGatewayErrorType,
  _resolveTaskScale,
  FILEREF_MAX_TOKEN,
  _fileRefRedosGuardEnabled,
  _extractFileReferences,
  _isLightweightConversationInput,
  _buildGreetingQuickReply,
  _extractRequestedLanguage,
  _detectUserInputLanguage,
  _hasLanguageRuleInPrompt,
  _buildLanguageFallbackDirective,
} = require('./aiRequestParsers');

// ── Constants ──
const EFFORT_PRESETS = {
  max: { temperature: 0.2, maxTokens: 32768, label: '最高精度', thinking: { budgetTokens: 10000 } },
  high: { temperature: 0.3, maxTokens: 16384, label: '高' },
  medium: { temperature: 0.5, maxTokens: 8192, label: '标准' },
  low: { temperature: 0.7, maxTokens: 4096, label: '快速' },
};

const MODEL_CAPABILITIES = {
  // Anthropic Claude
  'claude-opus-4': { code: 5, reasoning: 5, creative: 5, context: 1000000, label: 'Claude Opus 4' },
  'claude-sonnet-4': {
    code: 5,
    reasoning: 5,
    creative: 4,
    context: 1000000,
    label: 'Claude Sonnet 4',
  },
  'claude-3-5-sonnet': {
    code: 5,
    reasoning: 5,
    creative: 4,
    context: 200000,
    label: 'Claude 3.5 Sonnet',
  },
  'claude-3-7-sonnet': {
    code: 5,
    reasoning: 5,
    creative: 4,
    context: 200000,
    label: 'Claude 3.7 Sonnet',
  },
  'claude-haiku-4': {
    code: 4,
    reasoning: 4,
    creative: 3,
    context: 200000,
    label: 'Claude Haiku 4',
  },
  'claude-3-haiku': {
    code: 3,
    reasoning: 3,
    creative: 3,
    context: 200000,
    label: 'Claude 3 Haiku',
  },
  // OpenAI GPT
  'gpt-5-codex': { code: 5, reasoning: 5, creative: 4, context: 1000000, label: 'GPT-5 Codex' },
  codex: { code: 5, reasoning: 5, creative: 4, context: 1000000, label: 'GPT-5 Codex' },
  'gpt-5': { code: 5, reasoning: 5, creative: 5, context: 1000000, label: 'GPT-5' },
  'gpt-4.1': { code: 5, reasoning: 5, creative: 4, context: 1047576, label: 'GPT-4.1' },
  'gpt-4.1-mini': { code: 4, reasoning: 4, creative: 3, context: 1047576, label: 'GPT-4.1 Mini' },
  'gpt-4.1-nano': { code: 3, reasoning: 3, creative: 2, context: 1047576, label: 'GPT-4.1 Nano' },
  'gpt-4o': { code: 5, reasoning: 4, creative: 4, context: 128000, label: 'GPT-4o' },
  'gpt-4o-mini': { code: 3, reasoning: 3, creative: 3, context: 128000, label: 'GPT-4o Mini' },
  o3: { code: 5, reasoning: 5, creative: 4, context: 200000, label: 'o3' },
  'o4-mini': { code: 4, reasoning: 5, creative: 3, context: 200000, label: 'o4-mini' },
  // DeepSeek
  'deepseek-v3': { code: 5, reasoning: 4, creative: 3, context: 128000, label: 'DeepSeek V3' },
  'deepseek-r1': { code: 5, reasoning: 5, creative: 3, context: 128000, label: 'DeepSeek R1' },
  'deepseek-v2': { code: 4, reasoning: 4, creative: 3, context: 128000, label: 'DeepSeek V2' },
  // Google Gemini
  'gemini-2.5-pro': {
    code: 5,
    reasoning: 5,
    creative: 4,
    context: 1048576,
    label: 'Gemini 2.5 Pro',
  },
  'gemini-2.5-flash': {
    code: 4,
    reasoning: 4,
    creative: 3,
    context: 1048576,
    label: 'Gemini 2.5 Flash',
  },
  'gemini-2.0-flash': {
    code: 4,
    reasoning: 4,
    creative: 3,
    context: 1048576,
    label: 'Gemini 2.0 Flash',
  },
  // Qwen (通义千问)
  qwen3: { code: 5, reasoning: 5, creative: 4, context: 131072, label: '通义千问 Qwen3' },
  'qwen-plus': { code: 4, reasoning: 4, creative: 3, context: 131072, label: '通义千问 Plus' },
  'qwen-turbo': { code: 3, reasoning: 3, creative: 3, context: 131072, label: '通义千问 Turbo' },
  // 其他
  'kimi-k2': { code: 4, reasoning: 4, creative: 4, context: 131072, label: 'Kimi K2' },
  'glm-4': { code: 3, reasoning: 3, creative: 3, context: 128000, label: 'GLM-4' },
  'llama-3.3': { code: 3, reasoning: 3, creative: 2, context: 128000, label: 'Llama 3.3 (Groq)' },
  'llama-4-maverick': {
    code: 4,
    reasoning: 4,
    creative: 3,
    context: 1048576,
    label: 'Llama 4 Maverick',
  },
};

// ── Inject deps to request analysis (needs constants + accessors defined above) ──
setAiRequestAnalysisDeps({ EFFORT_PRESETS, MODEL_CAPABILITIES, _resolveTaskScale, getGateway });

// ── Service Accessors ──

function getService() {
  if (!_localState.service) {
    const MultiFreeService = require('../services/multiFreeService');
    _localState.service = new MultiFreeService();
  }
  return _localState.service;
}

function getGateway() {
  if (!_chatState.gateway) {
    _chatState.gateway = require('../services/gateway/aiGateway');
  }
  return _chatState.gateway;
}

function getChatLatencyAutoTuner() {
  if (!_localState.chatLatencyAutoTuner) {
    _localState.chatLatencyAutoTuner = require('../services/chatLatencyAutoTuner');
  }
  return _localState.chatLatencyAutoTuner;
}

function getSecurityDir() {
  try {
    const { getSecurityDirective } = require('../services/securityGuardService');
    return getSecurityDirective() || '';
  } catch {
    return '';
  }
}

// ── Model Info / Provider ──

function getAiStatus() {
  return getService().getStatus();
}

function getActiveProvider() {
  try {
    const gw = getGateway();
    const active = gw.getActiveAdapter();
    if (active) {
      const suffix = active.activeModel ? ` · ${active.activeModel}` : '';
      return `${active.name}${suffix}`;
    }
  } catch {}
  const svc = getService();
  const provider = svc.getAvailableProvider();
  return provider ? provider.name : null;
}

function _getModelInfo() {
  try {
    const gw = getGateway();
    const active = gw.getActiveAdapter();
    if (active) {
      return { model: active.activeModel || active.name, adapter: active.name };
    }
  } catch {}
  return {};
}

function _getStudyModeRuntimeMeta(preferredAdapter, preferredModel) {
  let adapter = String(preferredAdapter || '').trim();
  let model = String(preferredModel || '').trim();

  try {
    const gw = getGateway();
    const active = gw.getActiveAdapter?.();
    if (!adapter && active?.name) {
      adapter = String(active.name).trim();
    }
    if (!model && active?.activeModel) {
      model = String(active.activeModel).trim();
    }
    if (!model && active?.name) {
      model = String(active.name).trim();
    }
  } catch {
    /* best effort */
  }

  return {
    adapter: adapter || null,
    model: model || null,
  };
}

// ── Study Mode ──

function enableStudyMode() {
  _chatState.studyMode = true;
}

function disableStudyMode() {
  _chatState.studyMode = false;
}

function isStudyMode() {
  return _chatState.studyMode;
}

// ── Effort Management ──

function setEffort(level) {
  if (EFFORT_PRESETS[level]) {
    _chatState.currentEffort = level;
    return true;
  }
  return false;
}

function getEffort() {
  return _chatState.currentEffort;
}

function getEffortPresets() {
  return EFFORT_PRESETS;
}

/**
 * The effort the ACTIVE adapter actually applies — for display/truth.
 */
function getActiveEffort() {
  try {
    let adapterName = String(process.env.GATEWAY_PREFERRED_ADAPTER || '')
      .trim()
      .toLowerCase();
    if (!adapterName) {
      const gw = require('../services/gateway/aiGateway');
      const active = typeof gw.getActiveAdapter === 'function' ? gw.getActiveAdapter() : null;
      adapterName = String((active && active.name) || '')
        .trim()
        .toLowerCase();
    }
    if (adapterName === 'codex') {
      const codex = require('../services/gateway/adapters/codexAdapter');
      const real =
        typeof codex.getConfiguredEffort === 'function' ? codex.getConfiguredEffort() : null;
      if (real) {
        return real;
      }
    }
  } catch {
    /* gateway/adapter not ready — fall back to KHY global */
  }
  return _chatState.currentEffort;
}

/**
 * Pure and exported so the single chokepoint in chat() and the unit test share
 * one implementation.
 */
function _clampSubagentEffort(effort, ctx = {}) {
  const isSubagent = !!ctx.isSubagent;
  const allowThinking =
    ctx.allowThinking != null
      ? !!ctx.allowThinking
      : String(process.env.KHY_SUBAGENT_ALLOW_THINKING || '').trim() === '1';
  if (isSubagent && !allowThinking && effort === 'max') {
    return 'high';
  }
  return effort;
}

// ── Thinking Management ──

function setThinkingEnabled(enabled) {
  _chatState.thinkingEnabled = !!enabled;
}

function isThinkingEnabled() {
  return _chatState.thinkingEnabled;
}

/**
 * Check if the current model natively supports extended_thinking (Claude API).
 */
function _modelSupportsNativeThinking(modelHint) {
  const m = String(modelHint || '').toLowerCase();
  return /claude-(opus|sonnet)-4/i.test(m) || /claude-3-5-sonnet/i.test(m);
}

/**
 * Resolve the DeepSeek model variant that matches the /thinking toggle.
 */
function _resolveDeepseekThinkingModel(modelHint, thinkingEnabled) {
  const m = String(modelHint || '')
    .trim()
    .toLowerCase();
  const isChat = m === 'deepseek-chat' || m === 'deepseek-v3' || m === 'deepseek';
  const isReasoner = m === 'deepseek-reasoner' || m === 'deepseek-r1';
  if (!isChat && !isReasoner) {
    return null;
  }
  if (thinkingEnabled && isChat) {
    return 'deepseek-reasoner';
  }
  if (!thinkingEnabled && isReasoner) {
    return 'deepseek-chat';
  }
  return null;
}

/**
 * CoT (chain-of-thought) system prompt injection for non-native thinking models.
 */
const COT_INJECTION_PROMPT = [
  '\n\n# Chain-of-Thought Reasoning',
  'Before answering, show your step-by-step reasoning process inside <think>...</think> tags.',
  'The thinking section should contain your analysis, planning, and intermediate reasoning.',
  'After </think>, output your final answer normally.',
  'Example format:',
  '<think>',
  '[Your step-by-step reasoning here]',
  '</think>',
  '[Your final answer here]',
].join('\n');

/**
 * Wraps an onChunk callback to intercept <think>...</think> tags from text chunks
 * and re-emit them as { type: 'thinking' } chunks for TUI display.
 *
 * The returned function carries a `finalize()` method that MUST be called once the
 * stream ends. CoT here is prompt-injected (COT_INJECTION_PROMPT), not a native
 * reasoning channel, so the closing tag is never guaranteed: a model can simply
 * forget it, or max_tokens can truncate mid-reasoning. Without finalize() such a
 * turn stays `insideThink` forever and every character lands in the thinking
 * channel — the user sees only "💭 思考 · N 字" and an empty answer, even though
 * the model did reply. finalize() fails OPEN: if the tag never closed and the text
 * channel emitted nothing at all, the buffered content is released as text.
 * Showing raw reasoning is bad; showing a blank turn is worse.
 */
function _createThinkTagInterceptor(originalOnChunk) {
  let insideThink = false;
  let tagBuffer = '';
  let emittedText = false;
  let pendingThink = '';
  let lastChunkMeta = null;
  // Models honouring COT_INJECTION_PROMPT emit either the short `<think>` form we
  // ask for or the long `<thinking>` form they were trained on (QWEN does the
  // latter). Recognising only the short form left the whole reasoning block in the
  // text channel, so raw tags rendered in the answer. Matching is case-insensitive
  // because the casing is likewise not guaranteed.
  const TAGS_OPEN = ['<think>', '<thinking>'];
  const TAGS_CLOSE = ['</think>', '</thinking>'];
  const isOpenTag = (s) => TAGS_OPEN.includes(s.toLowerCase());
  const isCloseTag = (s) => TAGS_CLOSE.includes(s.toLowerCase());
  const ALL_TAGS = [...TAGS_OPEN, ...TAGS_CLOSE];
  // No tag is a prefix of another (`<think>` closes with `>` where `<thinking>`
  // continues with `i`), so a complete match is always unambiguous.
  const isTagPrefix = (s) => {
    const low = s.toLowerCase();
    return ALL_TAGS.some((t) => t.startsWith(low));
  };

  function interceptedOnChunk(chunk) {
    if (!chunk || chunk.type !== 'text' || typeof chunk.text !== 'string') {
      if (originalOnChunk) {
        originalOnChunk(chunk);
      }
      return;
    }
    // Preserve non-text fields (sessionId, sequence, meta, ...) so
    // deferred emissions (commit / finalize) look like real chunks.
    const { text, ...meta } = chunk;
    lastChunkMeta = meta;

    let i = 0;
    let textBuf = '';
    let thinkBuf = '';

    function flushText() {
      if (textBuf) {
        emittedText = true;
        if (originalOnChunk) {
          originalOnChunk({ ...chunk, type: 'text', text: textBuf });
        }
        textBuf = '';
      }
    }

    function flushThink() {
      if (thinkBuf) {
        pendingThink += thinkBuf;
        thinkBuf = '';
      }
    }

    function commitThink() {
      if (pendingThink) {
        if (originalOnChunk) {
          originalOnChunk({ ...lastChunkMeta, type: 'thinking', text: pendingThink });
        }
        pendingThink = '';
      }
    }

    while (i < text.length) {
      const ch = text[i];

      if (ch === '<') {
        tagBuffer = '<';
        i++;
        continue;
      }

      if (tagBuffer) {
        tagBuffer += ch;
        i++;
        if (isOpenTag(tagBuffer)) {
          if (!insideThink) {
            flushText();
          }
          insideThink = true;
          tagBuffer = '';
          continue;
        }
        if (isCloseTag(tagBuffer)) {
          if (insideThink) {
            flushThink();
            commitThink();
          }
          insideThink = false;
          tagBuffer = '';
          continue;
        }
        if (isTagPrefix(tagBuffer)) {
          continue;
        }
        const flushed = tagBuffer;
        tagBuffer = '';
        for (const c of flushed) {
          if (insideThink) {
            thinkBuf += c;
          } else {
            textBuf += c;
          }
        }
        continue;
      }

      if (insideThink) {
        thinkBuf += ch;
      } else {
        textBuf += ch;
      }
      i++;
    }

    if (insideThink) {
      flushThink();
      pendingThink += textBuf;
    } else {
      flushText();
    }
  }

  interceptedOnChunk.finalize = function finalize() {
    if (insideThink && pendingThink) {
      /**
       * Stream ended with <think> still open. Fail OPEN: only when the text
       * channel never emitted anything do we release the buffered reasoning as
       * text, so the user gets *some* reply. If some text already streamed (the
       * model answered and then thought again, or emitted partial prose), keep
       * the reasoning hidden — a blank turn is worse than raw thinking, but
       * duplicating/interspersing reasoning between real answer text is worse.
       */
      if (!emittedText && originalOnChunk) {
        originalOnChunk({ ...lastChunkMeta, type: 'text', text: pendingThink });
      }
      pendingThink = '';
    }
    insideThink = false;
  };

  return interceptedOnChunk;
}

// ── Wire sub-module deps ──

_aiGatewayClient.setAiGatewayClientDeps({ getGateway });

_aiSession.setAiSessionDeps({
  _getModelInfo,
  compactHistory: _aiConversationOps.compactHistory,
});

_aiConversationOps.setAiConversationOpsDeps({
  getAiStatus,
  getService,
  getGateway,
  _guessModelHint,
  _resolveModelContextLimit,
});

// ── Inject deps to aiChatCore ──
const { resolveMaxHistory } = require('../constants/chatHistoryDefaults');
_aiChatCore.setAiChatCoreDeps({
  COT_INJECTION_PROMPT,
  EFFORT_PRESETS,
  MAX_HISTORY: resolveMaxHistory(process.env),
  MODEL_CAPABILITIES,
  _applyVisionRouting,
  _buildGreetingQuickReply,
  _buildLanguageFallbackDirective,
  _clampSubagentEffort,
  _classifyGatewayThrownError,
  _createStreamToolInterceptor,
  _createThinkTagInterceptor,
  _ensureLiveSessionId: _aiSession._ensureLiveSessionId,
  _estimateContextTokens,
  _extractFileReferences,
  _getModelInfo,
  _getStudyModeRuntimeMeta,
  _guessModelHint,
  _isFirstTokenSignalChunk,
  _isLightweightConversationInput,
  _isLocalThinkingModel: _aiGatewayClient._isLocalThinkingModel,
  _isTransientGatewayErrorType,
  _logStandaloneLlmRequest: _aiGatewayClient._logStandaloneLlmRequest,
  _logStandaloneLlmResponse: _aiGatewayClient._logStandaloneLlmResponse,
  _maybeAutoSaveMemory: _aiSession._maybeAutoSaveMemory,
  _maybeWarmupLocalPreferredOnce: _aiGatewayClient._maybeWarmupLocalPreferredOnce,
  _modelSupportsNativeThinking,
  _persistLiveSession: _aiSession._persistLiveSession,
  _registerActiveGatewayRequest: _aiGatewayClient._registerActiveGatewayRequest,
  _resolveAuditTraceContext: _aiGatewayClient._resolveAuditTraceContext,
  _resolveContextBudget,
  _resolveDeepseekThinkingModel,
  _resolveLocalPreferredMaxTokens: _aiGatewayClient._resolveLocalPreferredMaxTokens,
  _resolveModelContextLimit,
  _resolveTaskScale,
  _uncommitOrphanTurn: _aiSession._uncommitOrphanTurn,
  _unregisterActiveGatewayRequest: _aiGatewayClient._unregisterActiveGatewayRequest,
  getChatLatencyAutoTuner,
  getGateway,
  getSecurityDir,
  getService,
});

// ── Exports ──
module.exports = {
  getAiStatus,
  getActiveProvider,
  handleAiStatus: _aiConversationOps.handleAiStatus,
  handleAiConfig: _aiConversationOps.handleAiConfig,
  chat,
  cancelActiveRequest: _aiGatewayClient.cancelActiveRequest,
  recordInterruption: _aiSession.recordInterruption,
  clearHistory: _aiConversationOps.clearHistory,
  maybeAutoCheckpointProgress: _aiConversationOps.maybeAutoCheckpointProgress,
  saveConversation: _aiSession.saveConversation,
  loadLastConversation: _aiSession.loadLastConversation,
  listConversations: _aiSession.listConversations,
  findConversationByRef: _aiSession.findConversationByRef,
  resumeConversation: _aiSession.resumeConversation,
  resumePersistedSession: _aiSession.resumePersistedSession,
  resumeLastPersistedSession: _aiSession.resumeLastPersistedSession,
  scopeSession: _aiSession.scopeSession,
  getLiveSessionId: _aiSession.getLiveSessionId,
  autoResumeLastSession: _aiSession.autoResumeLastSession,
  loadProjectMemoryContext: _aiSession.loadProjectMemoryContext,
  setEffort,
  getEffort,
  getActiveEffort,
  getEffortPresets,
  setThinkingEnabled,
  isThinkingEnabled,
  getConversationStats: _aiConversationOps.getConversationStats,
  getConversation: _aiConversationOps.getConversation,
  snapshotHistoryTurn: _aiConversationOps.snapshotHistoryTurn,
  reconcileTurnHistory: _aiConversationOps.reconcileTurnHistory,
  getContextLimit: _aiConversationOps.getContextLimit,
  compactConversation: _aiConversationOps.compactConversation,
  compactHistory: _aiConversationOps.compactHistory,
  snipConversation: _aiConversationOps.snipConversation,
  rewindToUserTurn: _aiConversationOps.rewindToUserTurn,
  summarizeFromUserTurn: _aiConversationOps.summarizeFromUserTurn,
  enableStudyMode,
  disableStudyMode,
  isStudyMode,
  checkModelCapability,
  handleAiOwner: _aiConversationOps.handleAiOwner,
  handleAiTech: _aiConversationOps.handleAiTech,
  handleAiUnrestricted: _aiConversationOps.handleAiUnrestricted,
  EFFORT_PRESETS,
  _clampSubagentEffort,
  MODEL_CAPABILITIES,
  getSystemPrompt: async () => {
    // Fire-and-forget geolocation prewarm: fill geolocationService's in-memory
    // cache in the background so later (synchronous) prompt assembly can inject
    // an approximate city-level location. NEVER await (must not block session
    // startup) and NEVER surface errors.
    try {
      require('../services/geolocationService')
        .getLocation()
        .catch(() => {});
    } catch {
      /* geolocation optional — prompt assembly proceeds without it */
    }
    return runtime.makeSystemPrompt(getSecurityDir(), _getModelInfo());
  },
  __test__: {
    _createStreamToolInterceptor,
    _createThinkTagInterceptor,
    _partialToolMarkerTailLen,
    _isContextOverflowFailure,
    _uncommitOrphanTurn: _aiSession._uncommitOrphanTurn,
    _pushRawMessage: (m) => {
      _chatState.messages.push(m);
      return _chatState.messages[_chatState.messages.length - 1];
    },
    _salvageRecentToolResult,
    _resolveDeepseekThinkingModel,
    _extractFileReferences,
    _fileRefRedosGuardEnabled,
    _resolveToolBlockInput,
    _streamToolRawInputEnabled,
    _stripHarnessScaffolding,
    _assessTaskDifficulty,
  },
};

// Self-register the non-chat AI seams on neutral ports so the services layer
// reaches them without a reverse require (DESIGN-ARCH-021, Batch 3).
try {
  require('../services/modelCapabilityPort').registerModelCapabilityChecker(checkModelCapability);
} catch {
  /* port unavailable — capability pre-check degrades to skipped */
}
try {
  require('../services/aiSessionPort').registerAiSession({
    handleAiStatus: _aiConversationOps.handleAiStatus,
    handleAiConfig: _aiConversationOps.handleAiConfig,
    clearHistory: _aiConversationOps.clearHistory,
  });
} catch {
  /* port unavailable — /status /config /new fallback degrades */
}
try {
  require('../services/aiChatPort').registerAiChat(chat);
} catch {
  /* port unavailable — ultraplan/workflow chat fallback degrades */
}
try {
  require('../services/aiConversationPort').registerAiConversation({
    getEffort,
    saveConversation: _aiSession.saveConversation,
    loadLastConversation: _aiSession.loadLastConversation,
    clearHistory: _aiConversationOps.clearHistory,
  });
} catch {
  /* port unavailable — queryEngine conversation-state ops degrade to no-op */
}
