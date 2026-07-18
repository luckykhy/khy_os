/**
 * KHY upgraded AI entry — hardened prompt, purified input, compact context,
 * NL tool gateway fallback for models without native tool calling.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let _chalk, _fmt;
const chalk = () => (_chalk ??= (require('chalk').default || require('chalk')));
const fmt = () => (_fmt ??= require('./formatters'));

const runtime = require('../services/khyUpgradeRuntime');
const { foldOutput } = require('./toolDisplayPolicy');

// ── God-file split (Option C): shared state singleton + isolated chat mega-construct ──
const _chatState = require('./aiChatState');
const _aiChatCore = require('./aiChatCore');
// Names defined in aiChatCore this host re-exports / references (hoisted core fns; safe to destructure now).
const {
  chat, _stripHarnessScaffolding, _assessTaskDifficulty, _buildStructuredMessages, _isContextOverflowFailure, checkModelCapability
} = _aiChatCore;

// The chat core calls the aiGatewayGenerateHelpers sibling, which needs host trace/logging accessors +
// getService (all hoisted function declarations here). This wiring must run at HOST load (real fns), not
// inside the relocated core body (where those accessors are injected later). Host also re-imports the one
// salvage helper it re-exports. Both modules share the cached aiGatewayGenerateHelpers singleton.
const _aiGGH = require('./aiGatewayGenerateHelpers');
_aiGGH.setAiGatewayGenerateHelpersDeps({ _resolveAuditTraceContext, _logStandaloneLlmRequest, _logStandaloneLlmResponse, getService });
const _salvageRecentToolResult = _aiGGH._salvageRecentToolResult;

let _service = null;
let _traceAudit = null;
let _chatLatencyAutoTuner = null;
let _localWarmupAttemptedAdapters = new Set();
let _localWarmupInFlight = new Map();
let _liveSessionId = null;         // stable id for the current live session (JSONL transcript in ~/.khy/sessions)
let _activeGatewayRequestSeq = 0;
const _activeGatewayRequests = new Map();

// Session-priming state (once-per-session / once-per-topic memory recall).
// `_chatState.primedSessionId` starts null so the FIRST turn of any session primes;
// `_chatState.lastPrimeTopicTokens` is the token-set baseline the topic-switch detector
// compares against. Mirrors the once-per-session precedent at repl.js
// (`_costThresholdWarned`). Purely display-side: never affects model behavior.

const MAX_HISTORY = 80;
const GLOBAL_CONVO_DIR = path.join(os.homedir(), '.khyquant', 'conversations');
const MAX_SAVED_CONVERSATIONS = 50; // per-folder limit (more generous than before)
const DEFAULT_AUTO_RESUME_WINDOW_MIN = 180;
const DEFAULT_PROJECT_MEMORY_MAX_CHARS = 5000;
const PROJECT_MEMORY_CONTEXT_TAG = '[ProjectMemoryBootstrap v1]';
const DEFAULT_AUTO_RESUME_SEGMENT_MODE = 'period';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function _registerActiveGatewayRequest(abortController, meta = {}) {
  if (!abortController || typeof abortController.abort !== 'function') return '';
  _activeGatewayRequestSeq += 1;
  const requestId = `req-${Date.now().toString(36)}-${_activeGatewayRequestSeq}`;
  _activeGatewayRequests.set(requestId, {
    abortController,
    createdAt: Date.now(),
    adapter: String(meta.adapter || '').trim(),
  });
  return requestId;
}

function _unregisterActiveGatewayRequest(requestId) {
  if (!requestId) return;
  _activeGatewayRequests.delete(requestId);
}

function cancelActiveRequest(reason = 'Interrupted by user') {
  const entries = Array.from(_activeGatewayRequests.entries());
  if (entries.length === 0) return false;
  const abortReason = reason instanceof Error ? reason : new Error(String(reason || 'Interrupted by user'));
  let cancelled = false;
  for (const [requestId, info] of entries) {
    try {
      const ctrl = info && info.abortController;
      if (ctrl && !ctrl.signal?.aborted) {
        ctrl.abort(abortReason);
        cancelled = true;
      }
    } catch { /* best effort */ }
    _activeGatewayRequests.delete(requestId);
  }
  return cancelled;
}

/**
 * 刀105:把「本轮回复被用户中断」记进模型可见历史(_chatState.messages),对齐 CC 的
 * [Request interrupted by user]。ESC/`/i` 中断时 chat() 抛 AbortError 冒出、跳过结尾的
 * assistant push → 历史停在悬空 user 且无中断标记;下一句「改用 X」进来会成两条连续 user、
 * 模型无从得知上一轮被打断。本函数由 abort 检测点(useQueryBridge 的 aborted 分支等)调用,
 * 补一条 assistant 回合(部分回复 + 中断标记 / 仅标记)。
 *
 * 文案与门控由纯叶子 services/interruptionMarker 单一真源。fail-soft:任何异常都不抛。
 * 门控 KHY_INTERRUPT_MARKER 关 → 叶子返 null → 本函数 no-op(逐字节回退今日:不记录标记)。
 *
 * 竞态守卫:仅当历史最后一条是悬空的 user/tool 回合(本轮 assistant 从未落)才补标记,
 * 避免正常完成后误加或重复补标记。
 * @param {string} [partialText] 中断时已生成的部分回复(调用方从 liveRef 抓取注入)
 * @param {object} [env]
 * @returns {boolean} 是否记录了标记
 */
function recordInterruption(partialText, env = process.env) {
  try {
    const leaf = require('../services/interruptionMarker');
    const content = leaf.buildInterruptedAssistantContent(partialText, env);
    if (content == null) return false; // 门控关 → no-op(逐字节回退)
    const last = _chatState.messages.length ? _chatState.messages[_chatState.messages.length - 1] : null;
    const lastRole = String((last && last.role) || '').toLowerCase();
    if (lastRole !== 'user' && lastRole !== 'tool') return false; // 非悬空回合 → 不补
    _chatState.messages.push({ role: 'assistant', content });
    if (_chatState.messages.length > MAX_HISTORY) _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);
    try { _persistLiveSession(); } catch { /* best effort:持久化失败不影响本次记录 */ }
    return true;
  } catch {
    return false;
  }
}

function _getTraceAudit() {
  if (_traceAudit !== null) return _traceAudit || null;
  try {
    _traceAudit = require('../services/traceAuditService');
    if (typeof _traceAudit.ensureDiagnosticsBridge === 'function') {
      _traceAudit.ensureDiagnosticsBridge();
    }
  } catch {
    _traceAudit = false;
  }
  return _traceAudit || null;
}

function _resolveAuditTraceContext(opts = {}) {
  const traceId = String(opts._diagTraceId || '').trim() || crypto.randomBytes(16).toString('hex');
  const requestId = String(opts.requestId || traceId).trim() || traceId;
  const sessionId = String(opts.sessionId || '').trim() || null;
  opts._diagTraceId = traceId;
  opts.requestId = requestId;
  const traceAudit = _getTraceAudit();
  if (traceAudit && sessionId) {
    try { traceAudit.attachTrace(traceId, sessionId); } catch { /* best effort */ }
  }
  return {
    traceAudit,
    traceId,
    requestId,
    sessionId,
  };
}

function _logStandaloneLlmRequest(traceCtx, prompt, opts = {}, meta = {}) {
  if (!traceCtx?.traceAudit) return;
  try {
    traceCtx.traceAudit.logEvent('llm.request', {
      requestId: traceCtx.requestId,
      requestedModel: meta.requestedModel || opts.model || 'auto',
      preferredAdapter: meta.preferredAdapter || opts.preferredAdapter || opts.adapter || 'auto',
      prompt,
      hasTools: Array.isArray(opts.tools) && opts.tools.length > 0,
      messagesCount: Array.isArray(opts.messages) ? opts.messages.length : 0,
      strictPreferred: opts.strictPreferred !== false,
      localPath: meta.localPath || null,
    }, {
      sessionId: traceCtx.sessionId,
      traceId: traceCtx.traceId,
      requestId: traceCtx.requestId,
      source: meta.source || 'ai-chat',
      visibility: 'internal',
    });
  } catch { /* non-critical */ }
}

function _logStandaloneLlmResponse(traceCtx, result, meta = {}) {
  if (!traceCtx?.traceAudit) return;
  const content = String(
    result?.content
    ?? result?.reply
    ?? meta.content
    ?? ''
  ).trim();
  const success = result?.success !== false;
  const errorText = meta.error
    || result?.error
    || (!success ? content : null)
    || null;
  try {
    traceCtx.traceAudit.logEvent('llm.response', {
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
    }, {
      sessionId: traceCtx.sessionId,
      traceId: traceCtx.traceId,
      requestId: traceCtx.requestId,
      source: meta.source || 'ai-chat',
      visibility: 'internal',
    });
  } catch { /* non-critical */ }
}

/**
 * Get the per-folder conversation directory.
 * Uses projectMemoryService to derive a hash-based path for the current working directory.
 * Falls back to the global directory if projectMemoryService is unavailable.
 */
function getConvoDir(cwd) {
  try {
    const { getProjectDir } = require('../services/projectMemoryService');
    const projDir = getProjectDir(cwd || process.cwd());
    const dir = path.join(projDir, 'conversations');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return GLOBAL_CONVO_DIR;
  }
}

function _generateSessionId() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fallthrough */ }
  const tsHex = Date.now().toString(16).slice(-12).padStart(12, '0');
  const rand = crypto.randomBytes(10).toString('hex'); // 20 chars
  return `${tsHex}-${rand.slice(0, 4)}-${rand.slice(4, 8)}-${rand.slice(8, 12)}-${rand.slice(12)}`;
}

function _ensureLiveSessionId() {
  if (!_liveSessionId) _liveSessionId = _generateSessionId();
  return _liveSessionId;
}

/**
 * Persist the live conversation to ~/.khy/sessions via sessionPersistence.
 * Writes an append-only JSONL transcript + JSON snapshot and refreshes the
 * search index. Best-effort: never throws into the chat flow.
 * Disable with KHY_DISABLE_SESSION_PERSIST=1.
 */
function _persistLiveSession() {
  if (process.env.KHY_DISABLE_SESSION_PERSIST === '1' || process.env.KHY_DISABLE_SESSION_PERSIST === 'true') {
    return;
  }
  if (!_chatState.messages || _chatState.messages.length === 0) return;
  try {
    const sp = require('../services/sessionPersistence');
    const info = _getModelInfo();
    sp.persistSession(_ensureLiveSessionId(), {
      messages: _chatState.messages,
      model: info.model || '',
      metadata: { cwd: process.cwd(), adapter: info.adapter || '' },
    });
  } catch { /* persistence is best-effort */ }
}

/**
 * Surgically un-commit the single message a failed `chat()` invocation appended
 * to the authoritative `_chatState.messages` history (DESIGN-ARCH-046). Pops ONLY the
 * exact message identified by reference identity, and only if it is still the
 * tail — so prior tool iterations (mission progress) are never discarded, and a
 * concurrent trim that already removed it is a safe no-op. This prevents the
 * "orphan user turn" (a user message with no assistant reply) that breaks
 * role-alternation and corrupts the next turn's model context. The user's intent
 * is not lost: the loop's empty-reply retry re-supplies the message cleanly,
 * and a non-retried failure had no answer to build on anyway.
 */
function _uncommitOrphanTurn(committedMsg) {
  if (!committedMsg) return;
  if (_chatState.messages.length > 0 && _chatState.messages[_chatState.messages.length - 1] === committedMsg) {
    _chatState.messages.pop();
  }
}

// The capture-side trigger/tier classification now lives in the single-source
// pure-leaf `services/memoryTrigger.js` (explicit「请记住」vs proactive vs none,
// plus tier inference). `_maybeAutoSaveMemory` below delegates to it.

/**
 * Deterministically capture a memory from the user's input — the capture side of
 * the layered-memory goal. Delegates the *decision* (explicit「请记住」vs a
 * conservative proactive candidate vs nothing) and the *tier* to the pure-leaf
 * `memoryTrigger.classify`, then routes the write through
 * `memoryEngine.addStructuredMemory`, which owns:
 *   - explicit「请记住」⇒ reliably persisted (the user's instruction is authoritative);
 *   - proactive stable facts (identity / durable preferences) ⇒ captured without asking;
 *   - tier routing: short_term ⇒ in-session store (forgotten at session end),
 *     cross_session/permanent ⇒ disk;
 *   - information update: a stable topic key (e.g. `user-name`) re-declared later
 *     supersedes in place via decideUpdate instead of stacking duplicates.
 * A fallback that does not rely on the model proactively writing memory files.
 * Best-effort: never throws into the chat flow. Respects KHY_DISABLE_MEMORY.
 *
 * @param {string} userMessage
 * @returns {boolean} true if a memory was captured
 */
function _maybeAutoSaveMemory(userMessage) {
  if (process.env.KHY_DISABLE_MEMORY === '1' || process.env.KHY_DISABLE_MEMORY === 'true') return false;

  let decision;
  try {
    decision = require('../services/memoryTrigger').classify(userMessage);
  } catch {
    return false;
  }
  if (!decision || decision.kind === 'none') return false;

  // instruction candidate → route to the instruction-file review queue (NOT the
  // memory store). Writing khy.md/agent.md happens only after the user approves;
  // this just enqueues the proposal. Best-effort, never throws into the chat flow.
  if (decision.kind === 'instruction') {
    try {
      const note = String(decision.note || '').trim();
      if (!note) return false;
      const store = require('../services/instructionReviewStore');
      const res = store.enqueue({
        note,
        target: decision.target || 'khy',
        scope: decision.scope || 'project',
        source: 'auto',
      });
      return !!(res && res.success && !res.skipped);
    } catch {
      return false;
    }
  }

  const note = String(decision.note || '').trim();
  if (!note) return false;

  // Stable topic key when provided (so re-declarations supersede); otherwise
  // derive a per-note slug so distinct facts coexist as separate memories.
  const title = note.split('\n')[0].slice(0, 40);
  const name = decision.name
    || (title.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '') || 'note').slice(0, 48);

  try {
    const engine = require('../services/memoryEngine');
    const res = engine.addStructuredMemory({
      type: decision.type || 'user',
      name,
      content: note,
      description: title,
      tier: decision.tier, // memoryEngine routes short_term ⇒ session store, else disk
    });
    // Return a structured descriptor (still truthy on success ⇒ backward-compatible
    // with any boolean consumer) so the caller can surface an honest "已写入…" notice
    // (memoryOpsNotice). `action`/`ephemeral` distinguish disk-persist vs in-session
    // vs already-exists. Non-success ⇒ false (silent), matching the prior contract.
    if (!(res && res.success)) return false;
    return {
      kind: 'memory',
      success: true,
      name,
      type: decision.type || 'user',
      tier: decision.tier,
      action: res.action,
      ephemeral: res.ephemeral === true,
    };
  } catch {
    return false;
  }
}

function _getAutoResumeWindowMs() {
  const raw = parseInt(String(process.env.KHY_AUTO_RESUME_WINDOW_MIN || DEFAULT_AUTO_RESUME_WINDOW_MIN), 10);
  if (Number.isFinite(raw) && raw <= 0) return 0;
  const mins = Number.isFinite(raw) ? raw : DEFAULT_AUTO_RESUME_WINDOW_MIN;
  return Math.max(5, mins) * 60 * 1000;
}

function _getAutoResumeSegmentMode() {
  const raw = String(process.env.KHY_AUTO_RESUME_SEGMENT_MODE || DEFAULT_AUTO_RESUME_SEGMENT_MODE).trim().toLowerCase();
  if (!raw) return DEFAULT_AUTO_RESUME_SEGMENT_MODE;
  if (['off', 'none', 'disable', 'disabled', 'false', '0'].includes(raw)) return 'none';
  if (['ampm', 'am_pm', 'halfday', 'am-pm'].includes(raw)) return 'ampm';
  if (['period', 'daypart', 'timeslot', 'segment'].includes(raw)) return 'period';
  return DEFAULT_AUTO_RESUME_SEGMENT_MODE;
}

function _localDateKey(date) {
  const parts = _getDatePartsInTimezone(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function _periodBucket(date) {
  const parts = _getDatePartsInTimezone(date);
  const h = parts.hour;
  if (h < 6) return 'late-night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function _segmentKey(date, mode) {
  if (mode === 'ampm') {
    const parts = _getDatePartsInTimezone(date);
    return parts.hour < 12 ? 'am' : 'pm';
  }
  if (mode === 'period') return _periodBucket(date);
  return 'all';
}

function _getTimezoneForSession() {
  const tz = String(process.env.KHY_TIMEZONE || DEFAULT_TIMEZONE).trim();
  return tz || DEFAULT_TIMEZONE;
}

function _getDatePartsInTimezone(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const fallback = {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    hour: date.getHours(),
  };

  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: _getTimezoneForSession(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    const tokens = fmt.formatToParts(date);
    const byType = {};
    for (const token of tokens) byType[token.type] = token.value;
    const hour = parseInt(String(byType.hour || fallback.hour), 10);
    return {
      year: String(byType.year || fallback.year),
      month: String(byType.month || fallback.month).padStart(2, '0'),
      day: String(byType.day || fallback.day).padStart(2, '0'),
      hour: Number.isFinite(hour) ? hour : fallback.hour,
    };
  } catch {
    return fallback;
  }
}

function _isSameAutoResumeSegment(lastDate, nowDate) {
  const mode = _getAutoResumeSegmentMode();
  if (mode === 'none') return true;
  if (_localDateKey(lastDate) !== _localDateKey(nowDate)) return false;
  return _segmentKey(lastDate, mode) === _segmentKey(nowDate, mode);
}

function _getProjectMemoryCandidates(cwd = process.cwd()) {
  const files = [];
  try {
    const { getMemoryDir, getProjectDir } = require('../services/projectMemoryService');
    const memoryDir = getMemoryDir(cwd);
    const projectDir = getProjectDir(cwd);
    files.push(path.join(memoryDir, 'memory.md'));
    files.push(path.join(memoryDir, 'MEMORY.md'));
    files.push(path.join(projectDir, 'memory.md'));
    files.push(path.join(projectDir, 'MEMORY.md'));
  } catch { /* ignore */ }
  try {
    const { getProjectDataHome } = require('../utils/dataHome');
    files.push(path.join(getProjectDataHome(), 'memory', 'MEMORY.md'));
  } catch {
    files.push(path.join(os.homedir(), '.khy', 'memory', 'MEMORY.md'));
  }
  return [...new Set(files)];
}

function loadProjectMemoryContext(options = {}) {
  try {
    const alreadyInjected = _chatState.messages.some((m) => (
      String(m?.role || '').toLowerCase() === 'tool'
      && String(m?.content || '').includes(PROJECT_MEMORY_CONTEXT_TAG)
    ));
    if (alreadyInjected && !options.force) {
      return { loaded: false, reason: 'already-loaded' };
    }

    const rawMaxChars = parseInt(String(process.env.KHY_PROJECT_MEMORY_MAX_CHARS || DEFAULT_PROJECT_MEMORY_MAX_CHARS), 10);
    const maxChars = Math.max(400, Number.isFinite(rawMaxChars) ? rawMaxChars : DEFAULT_PROJECT_MEMORY_MAX_CHARS);
    const cwd = options.cwd || process.cwd();
    const candidates = _getProjectMemoryCandidates(cwd);

    for (const filePath of candidates) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const content = String(fs.readFileSync(filePath, 'utf-8') || '').trim();
        if (!content) continue;

        const truncated = content.length > maxChars;
        const summary = truncated ? `${content.slice(0, maxChars)}\n\n[Memory truncated for context budget]` : content;
        const payload = [
          PROJECT_MEMORY_CONTEXT_TAG,
          `source: ${filePath}`,
          'Use this memory as background context. User latest explicit instructions always win.',
          '',
          summary,
        ].join('\n');

        if (options.prepend) _chatState.messages = [{ role: 'tool', content: payload }, ..._chatState.messages];
        else _chatState.messages.push({ role: 'tool', content: payload });
        if (_chatState.messages.length > MAX_HISTORY) _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);

        return {
          loaded: true,
          file: filePath,
          chars: Math.min(content.length, maxChars),
          truncated,
        };
      } catch { /* try next candidate */ }
    }
  } catch { /* ignore */ }

  return { loaded: false, reason: 'not-found' };
}
const ENV_PATH = process.env.KHY_ENV_FILE
  ? path.resolve(process.env.KHY_ENV_FILE)
  : path.resolve(__dirname, '../../.env');
const AI_UNRESTRICTED_ENV = 'KHY_AI_UNRESTRICTED';
const AI_TECH_DETAILS_ENV = 'KHY_AI_TECH_DETAILS';

const EFFORT_PRESETS = {
  max:    { temperature: 0.2, maxTokens: 32768, label: '最高精度', thinking: { budgetTokens: 10000 } },
  high:   { temperature: 0.3, maxTokens: 16384, label: '高' },
  medium: { temperature: 0.5, maxTokens: 8192, label: '标准' },
  low:    { temperature: 0.7, maxTokens: 4096, label: '快速' },
};

/**
 * Keep extended thinking with the MAIN agent. A sub-agent is a hands-on
 * executor (the teacher's "thinking must be done by the main agent" rule), so it
 * must not draw the 'max' preset — the only one carrying a `thinking` budget.
 * Downgrade 'max'→'high' for sub-agents; every other level (high/medium/low) is
 * already thinking-free and passes through unchanged. The escape hatch
 * KHY_SUBAGENT_ALLOW_THINKING=1 restores 'max' for debugging/experiments.
 *
 * Pure and exported so the single chokepoint in chat() and the unit test share
 * one implementation.
 *
 * @param {string} effort - the resolved effort level
 * @param {{isSubagent?: boolean, allowThinking?: boolean}} [ctx]
 * @returns {string}
 */
function _clampSubagentEffort(effort, ctx = {}) {
  const isSubagent = !!ctx.isSubagent;
  const allowThinking = ctx.allowThinking != null
    ? !!ctx.allowThinking
    : String(process.env.KHY_SUBAGENT_ALLOW_THINKING || '').trim() === '1';
  if (isSubagent && !allowThinking && effort === 'max') return 'high';
  return effort;
}

const MODEL_CAPABILITIES = {
  // Anthropic Claude
  'claude-opus-4':       { code: 5, reasoning: 5, creative: 5, context: 1000000, label: 'Claude Opus 4' },
  'claude-sonnet-4':     { code: 5, reasoning: 5, creative: 4, context: 1000000, label: 'Claude Sonnet 4' },
  'claude-3-5-sonnet':   { code: 5, reasoning: 5, creative: 4, context: 200000, label: 'Claude 3.5 Sonnet' },
  'claude-haiku-4':      { code: 4, reasoning: 4, creative: 3, context: 200000, label: 'Claude Haiku 4' },
  'claude-3-haiku':      { code: 3, reasoning: 3, creative: 3, context: 200000, label: 'Claude 3 Haiku' },
  // OpenAI GPT
  // GPT-5 family (incl. codex) — 1M context window. `codex` is listed as its
  // own key because real ids are `gpt-5.x-codex…`, which do NOT substring-match a
  // `gpt-5-codex` key; the bare `codex` key catches every codex variant.
  // This is ONLY the pre-gateway family fallback: a real window from codex
  // config.toml `model_context_window` or the provider /models API is sourced by
  // the gateway and overrides this at runtime (codexAdapter.listModels).
  'gpt-5-codex':         { code: 5, reasoning: 5, creative: 4, context: 1000000, label: 'GPT-5 Codex' },
  'codex':               { code: 5, reasoning: 5, creative: 4, context: 1000000, label: 'GPT-5 Codex' },
  'gpt-5':               { code: 5, reasoning: 5, creative: 5, context: 1000000, label: 'GPT-5' },
  'gpt-4.1':             { code: 5, reasoning: 5, creative: 4, context: 1047576, label: 'GPT-4.1' },
  'gpt-4.1-mini':        { code: 4, reasoning: 4, creative: 3, context: 1047576, label: 'GPT-4.1 Mini' },
  'gpt-4.1-nano':        { code: 3, reasoning: 3, creative: 2, context: 1047576, label: 'GPT-4.1 Nano' },
  'gpt-4o':              { code: 5, reasoning: 4, creative: 4, context: 128000, label: 'GPT-4o' },
  'gpt-4o-mini':         { code: 3, reasoning: 3, creative: 3, context: 128000, label: 'GPT-4o Mini' },
  'o3':                  { code: 5, reasoning: 5, creative: 4, context: 200000, label: 'o3' },
  'o4-mini':             { code: 4, reasoning: 5, creative: 3, context: 200000, label: 'o4-mini' },
  // DeepSeek
  'deepseek-v3':         { code: 5, reasoning: 4, creative: 3, context: 128000, label: 'DeepSeek V3' },
  'deepseek-r1':         { code: 5, reasoning: 5, creative: 3, context: 128000, label: 'DeepSeek R1' },
  'deepseek-v2':         { code: 4, reasoning: 4, creative: 3, context: 128000, label: 'DeepSeek V2' },
  // Google Gemini
  'gemini-2.5-pro':      { code: 5, reasoning: 5, creative: 4, context: 1048576, label: 'Gemini 2.5 Pro' },
  'gemini-2.5-flash':    { code: 4, reasoning: 4, creative: 3, context: 1048576, label: 'Gemini 2.5 Flash' },
  'gemini-2.0-flash':    { code: 4, reasoning: 4, creative: 3, context: 1048576, label: 'Gemini 2.0 Flash' },
  // Qwen (通义千问)
  'qwen3':               { code: 5, reasoning: 5, creative: 4, context: 131072, label: '通义千问 Qwen3' },
  'qwen-plus':           { code: 4, reasoning: 4, creative: 3, context: 131072, label: '通义千问 Plus' },
  'qwen-turbo':          { code: 3, reasoning: 3, creative: 3, context: 131072, label: '通义千问 Turbo' },
  // 其他
  'glm-4':               { code: 3, reasoning: 3, creative: 3, context: 128000, label: 'GLM-4' },
  'llama-3.3':           { code: 3, reasoning: 3, creative: 2, context: 128000, label: 'Llama 3.3 (Groq)' },
  'llama-4-maverick':    { code: 4, reasoning: 4, creative: 3, context: 1048576, label: 'Llama 4 Maverick' },
};

// Request-analysis helpers (context budgeting + multimodal/vision routing) extracted to a sibling
// module (aiRequestAnalysis.js). The verbatim function bodies live there; host callers re-import the
// five entry points by the same names. Inject the two read-only capability tables + the task-scale /
// gateway accessors the moved bodies reference (runtime is re-required inside the leaf).
const {
  _resolveModelContextLimit, _guessModelHint, _estimateContextTokens, _resolveContextBudget,
  _applyVisionRouting, setAiRequestAnalysisDeps,
} = require('./aiRequestAnalysis');
// Request-parsing / stream-interception helpers (inline tool-call markers, streaming tool
// interceptor, gateway error classifiers, task-scale sizing, ReDoS-guarded file-reference
// extraction, lightweight-input / greeting detection, and user-language detection) extracted to a
// sibling module (aiRequestParsers.js). Host callers re-import them by the same names. Bound BEFORE
// the setAiRequestAnalysisDeps() call below so _resolveTaskScale is available to inject.
const {
  _TOOL_CALL_MARKERS, _partialToolMarkerTailLen, _STREAM_TOOL_RAWINPUT_OFF, _streamToolRawInputEnabled,
  _resolveToolBlockInput, _createStreamToolInterceptor, _classifyGatewayThrownError,
  _isFirstTokenSignalChunk, _isTransientGatewayErrorType, _resolveTaskScale, FILEREF_MAX_TOKEN,
  _fileRefRedosGuardEnabled, _extractFileReferences, _isLightweightConversationInput,
  _buildGreetingQuickReply, _extractRequestedLanguage, _detectUserInputLanguage, _hasLanguageRuleInPrompt,
  _buildLanguageFallbackDirective,
} = require('./aiRequestParsers');
setAiRequestAnalysisDeps({ EFFORT_PRESETS, MODEL_CAPABILITIES, _resolveTaskScale, getGateway });


function _envToBool(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes' || s === 'y';
}

function _onOff(v) {
  return v ? chalk().green('ON') : chalk().dim('OFF');
}

function _markFailure() {
  if (!process.exitCode || process.exitCode === 0) {
    process.exitCode = 1;
  }
}

function _setEnvVar(key, value) {
  let envContent = '';
  try { envContent = fs.readFileSync(ENV_PATH, 'utf-8'); } catch { /* no .env */ }
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, line);
  } else {
    envContent = envContent.trimEnd() + '\n' + line + '\n';
  }
  fs.writeFileSync(ENV_PATH, envContent, 'utf-8');
  process.env[key] = String(value);
}

function _getEnvVar(key) {
  const runtimeVal = process.env[key];
  if (runtimeVal !== undefined && String(runtimeVal).trim() !== '') {
    return String(runtimeVal).trim();
  }
  try {
    const envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    const regex = new RegExp(`^${key}=(.*)$`, 'm');
    const match = envContent.match(regex);
    if (!match) return '';
    return String(match[1] || '').trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return '';
  }
}

function _normalizeSwitchInput(options = {}, args = []) {
  const o = { ...options };
  const firstArg = String(args[0] || '').toLowerCase();
  if (firstArg === 'on') o.on = true;
  if (firstArg === 'off') o.off = true;
  if (firstArg === 'status') o.status = true;
  return o;
}

function _readSwitchStates() {
  const techEnabled = _envToBool(_getEnvVar(AI_TECH_DETAILS_ENV));
  const unrestrictedEnabled = _envToBool(_getEnvVar(AI_UNRESTRICTED_ENV));
  return { techEnabled, unrestrictedEnabled };
}

function _readOwnerControlStatus() {
  try {
    const owner = require('../services/ownerControlService');
    return owner.getOwnerControlStatus();
  } catch {
    return { configured: false, updatedAt: null, version: 1 };
  }
}

async function _askSecret(message) {
  const { promptCompat } = require('./uiPrompt');
  const { secret } = await promptCompat([{
    type: 'password',
    name: 'secret',
    message,
    mask: '*',
    validate: v => String(v || '').trim().length > 0 || 'Secret cannot be empty',
  }]);
  return String(secret || '').trim();
}

async function _requireOwnerSecret(options = {}) {
  const owner = require('../services/ownerControlService');
  if (!owner.isOwnerControlConfigured()) {
    return {
      ok: false,
      error: 'Owner control is not initialized. Run: ai owner init',
    };
  }

  let secret = String(
    options.secret
      || options.key
      || options.token
      || options.ownerSecret
      || options['owner-secret']
      || ''
  ).trim();

  if (!secret && process.stdin.isTTY && process.stdout.isTTY) {
    try {
      secret = await _askSecret('Owner secret:');
    } catch {
      return { ok: false, error: 'Owner secret is required.' };
    }
  }

  if (!secret) {
    return {
      ok: false,
      error: 'Owner secret is required. Use --secret <value> or run in interactive terminal.',
    };
  }

  const verify = owner.verifyOwnerSecret(secret);
  if (!verify.ok) {
    return { ok: false, error: verify.error || 'Owner secret verification failed.' };
  }
  return { ok: true, secret };
}

function getService() {
  if (!_service) {
    const MultiFreeService = require('../services/multiFreeService');
    _service = new MultiFreeService();
  }
  return _service;
}

function getGateway() {
  if (!_chatState.gateway) {
    _chatState.gateway = require('../services/gateway/aiGateway');
  }
  return _chatState.gateway;
}

function getChatLatencyAutoTuner() {
  if (!_chatLatencyAutoTuner) {
    _chatLatencyAutoTuner = require('../services/chatLatencyAutoTuner');
  }
  return _chatLatencyAutoTuner;
}

function _isLocalAdapterKey(key) {
  const normalized = String(key || '').trim().toLowerCase();
  return normalized === 'localllm' || normalized === 'ollama';
}

function _resolveLocalWarmupTarget(gateway, preferredAdapterHint = undefined) {
  const preferred = String(
    preferredAdapterHint !== undefined
      ? preferredAdapterHint
      : (process.env.GATEWAY_PREFERRED_ADAPTER || '')
  ).trim().toLowerCase();
  if (_isLocalAdapterKey(preferred)) return preferred;
  if (preferred && preferred !== 'auto') return '';
  try {
    const firstAvailable = String(gateway.getFirstAvailableAdapter?.() || '').trim().toLowerCase();
    if (_isLocalAdapterKey(firstAvailable)) return firstAvailable;
  } catch { /* best effort */ }
  return '';
}

function _toGatewayLocalKey(key) {
  return String(key || '').trim().toLowerCase() === 'localllm' ? 'localLLM' : 'ollama';
}

let _localAiAutoEnvCache = null;
function _getLocalAiAutoEnv() {
  if (_localAiAutoEnvCache) return _localAiAutoEnvCache;
  try {
    const hw = require('../services/hardwareProfileService');
    const tuning = hw && typeof hw.recommendLocalAiTuning === 'function'
      ? hw.recommendLocalAiTuning('auto')
      : null;
    _localAiAutoEnvCache = (tuning && tuning.env) ? tuning.env : {};
  } catch {
    _localAiAutoEnvCache = {};
  }
  return _localAiAutoEnvCache;
}

function _readIntWithAutoDefault(envKey, autoDefault, hardFallback) {
  const raw = process.env[envKey];
  if (raw !== undefined && String(raw).trim() !== '') {
    const v = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(v)) return v;
  }
  const autoV = parseInt(String(autoDefault || ''), 10);
  if (Number.isFinite(autoV)) return autoV;
  return hardFallback;
}

// Reasoning models (qwen3 / qwq / deepseek-r1 …) emit a long <think> block
// before the final answer. Under a small num_predict cap the budget is spent
// thinking and the answer is truncated to empty. Detect them so the cap can
// reserve extra headroom. Pattern is env-extendable (no hardcoded allowlist).
function _isLocalThinkingModel(model) {
  const name = String(model || '').toLowerCase();
  if (!name) return false;
  const extra = String(process.env.KHY_OLLAMA_THINKING_MODELS || '').trim();
  if (extra) {
    try { if (new RegExp(extra, 'i').test(name)) return true; } catch { /* bad regex → ignore */ }
  }
  return /(qwen3|qwq|deepseek-r1|[-_/]r1[:\b-]|marco-o1|openthinker|reflection|exaone-deep|phi-?4-?reasoning|reasoning|thinking|cogito)/i.test(name);
}

function _resolveLocalPreferredMaxTokens(baseTokens, context = {}) {
  const normalizedBase = Math.max(64, parseInt(baseTokens, 10) || 2048);
  const isLocalPreferredAdapter = !!context.isLocalPreferredAdapter;
  const preferredAdapter = String(context.preferredAdapter || '').trim().toLowerCase();
  const localLLMStatus = context.localLLMStatus || null;
  const autoEnv = _getLocalAiAutoEnv();
  const disableCapRaw = process.env.KHY_LOCAL_DISABLE_TOKEN_CAP !== undefined
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
      _readIntWithAutoDefault('KHY_OLLAMA_MAX_TOKENS', autoEnv.KHY_OLLAMA_MAX_TOKENS, fallbackWarmCap)
    );
    // Thinking models need the reasoning budget on top of the answer budget.
    // Boost the cap (multiplier + absolute floor) so the final answer is not
    // truncated to empty. Both knobs are env-tunable.
    if (context.isThinkingModel) {
      const tMult = Math.max(1, parseFloat(process.env.KHY_OLLAMA_THINKING_MULTIPLIER || '2.5') || 2.5);
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
  const warmupOnceRaw = process.env.KHY_LOCAL_WARMUP_ONCE !== undefined
    ? process.env.KHY_LOCAL_WARMUP_ONCE
    : autoEnv.KHY_LOCAL_WARMUP_ONCE;
  if (String(warmupOnceRaw || 'false').toLowerCase() === 'false') return;

  const gateway = getGateway();
  if (!gateway._initialized) await gateway.init();

  const target = _resolveLocalWarmupTarget(gateway, options.preferredAdapter);
  if (!target) return;
  if (_localWarmupAttemptedAdapters.has(target)) return;

  const existing = _localWarmupInFlight.get(target);
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
      try { onStatus(`${adapterLabel} 预热中（仅首次），正在发送预热 ping...`); } catch { /* best effort */ }
    }

    const warmupRun = gateway.generateWithAdapter(gatewayAdapterKey, 'Reply with exactly: OK', {
      maxTokens: 24,
      temperature: 0,
      top_p: 1,
      timeoutMs: maxWaitMs,
      userMessage: '[warmup]',
    }).catch((err) => ({ success: false, error: err && err.message ? err.message : String(err) }));

    const timeoutToken = Symbol('warmup-timeout');
    const raced = await Promise.race([
      warmupRun,
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(timeoutToken), maxWaitMs + 300);
        if (t.unref) t.unref();
      }),
    ]);

    if (raced === timeoutToken) {
      if (onStatus) {
        try {
          onStatus(`${adapterLabel} 预热仍在进行（>${Math.round(maxWaitMs / 1000)}s），将并行继续并直接发起正式请求...`);
        } catch { /* best effort */ }
      }
      return;
    }

    if (raced && raced.success) {
      if (onStatus) {
        try { onStatus(`${adapterLabel} 预热完成，开始正式请求...`); } catch { /* best effort */ }
      }
      return;
    }

    if (onStatus) {
      const reason = String((raced && (raced.error || raced.content)) || 'unknown').replace(/\s+/g, ' ').trim().slice(0, 100);
      try { onStatus(`${adapterLabel} 预热失败（${reason || 'unknown'}），将直接发起正式请求...`); } catch { /* best effort */ }
    }
  })();

  _localWarmupInFlight.set(target, warmupTask);
  try {
    await warmupTask;
  } finally {
    _localWarmupAttemptedAdapters.add(target);
    _localWarmupInFlight.delete(target);
  }
}

function getSecurityDir() {
  try {
    const { getSecurityDirective } = require('../services/securityGuardService');
    return getSecurityDirective() || '';
  } catch {
    return '';
  }
}

function saveConversation() {
  if (_chatState.messages.length === 0) return { success: false, reason: 'empty' };
  try {
    const convoDir = getConvoDir();
    if (!fs.existsSync(convoDir)) fs.mkdirSync(convoDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const suffix = Math.random().toString(36).slice(2, 6);
    const filename = `${timestamp}-${suffix}.json`;
    const sessionId = _generateSessionId();

    // Save a compacted summary instead of raw messages so that /resume
    // loads a concise, high-value context rather than the full history.
    const snapshotMessages = _chatState.messages.slice();
    const originalCount = snapshotMessages.length;
    let savedMessages = snapshotMessages;

    if (originalCount > 6) {
      // Temporarily swap _chatState.messages to compact the snapshot without
      // mutating the live conversation (session may continue).
      const liveMessages = _chatState.messages;
      _chatState.messages = snapshotMessages;
      try {
        compactHistory({
          keepRecent: Math.min(6, Math.max(2, Math.floor(originalCount * 0.2))),
          mode: 'aggressive',
        });
        savedMessages = _chatState.messages;
      } finally {
        _chatState.messages = liveMessages;
      }
    }

    const data = {
      sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      messages: savedMessages,
      messageCount: savedMessages.length,
      originalMessageCount: originalCount,
    };
    const filePath = path.join(convoDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    const files = fs.readdirSync(convoDir).filter(f => f.endsWith('.json')).sort();
    while (files.length > MAX_SAVED_CONVERSATIONS) {
      fs.unlinkSync(path.join(convoDir, files.shift()));
    }
    _persistLiveSession();   // fallback: also converge to ~/.khy/sessions on explicit save
    return {
      success: true,
      sessionId,
      file: filename,
      filePath,
      timestamp: data.timestamp,
      messageCount: data.messageCount,
    };
  } catch {
    return { success: false, reason: 'write_failed' };
  }
}

function loadLastConversation() {
  try {
    const convoDir = getConvoDir();
    if (!fs.existsSync(convoDir)) return null;
    const files = fs.readdirSync(convoDir).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) return null;
    const latest = fs.readFileSync(path.join(convoDir, files[files.length - 1]), 'utf-8');
    return JSON.parse(latest);
  } catch {
    return null;
  }
}

function listConversations() {
  try {
    const convoDir = getConvoDir();
    if (!fs.existsSync(convoDir)) return [];
    const files = fs.readdirSync(convoDir).filter(f => f.endsWith('.json')).sort().reverse();
    return files.map(file => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(convoDir, file), 'utf-8'));
        const sessionId = String(data.sessionId || '').trim() || String(file).replace(/\.json$/i, '');
        return {
          file,
          sessionId,
          timestamp: data.timestamp,
          messageCount: data.messageCount || data.messages?.length || 0,
        };
      } catch {
        return { file, sessionId: String(file).replace(/\.json$/i, ''), timestamp: '', messageCount: 0 };
      }
    });
  } catch {
    return [];
  }
}

function findConversationByRef(ref) {
  const key = String(ref || '').trim();
  if (!key) return null;
  const convos = listConversations();
  if (convos.length === 0) return null;

  const normalizedFile = key.endsWith('.json') ? key : `${key}.json`;
  const lower = key.toLowerCase();
  const lowerFile = normalizedFile.toLowerCase();

  let match = convos.find(c => c.file === key || c.file === normalizedFile || c.sessionId === key);
  if (match) return match;

  match = convos.find(c => {
    const sid = String(c.sessionId || '').toLowerCase();
    const file = String(c.file || '').toLowerCase();
    return sid === lower || file === lower || file === lowerFile;
  });
  if (match) return match;

  const sidPrefix = convos.filter(c => String(c.sessionId || '').toLowerCase().startsWith(lower));
  if (sidPrefix.length === 1) return sidPrefix[0];

  const filePrefix = convos.filter(c => String(c.file || '').replace(/\.json$/i, '').toLowerCase().startsWith(lower));
  if (filePrefix.length === 1) return filePrefix[0];

  return null;
}

function resumeConversation(file) {
  try {
    let data;
    if (file) {
      const convoDir = getConvoDir();
      data = JSON.parse(fs.readFileSync(path.join(convoDir, file), 'utf-8'));
    } else {
      data = loadLastConversation();
    }
    if (data && data.messages && data.messages.length > 0) {
      const rawMessages = data.messages.slice(-MAX_HISTORY);
      const originalCount = rawMessages.length;

      // Instead of restoring raw messages directly, compact them into a
      // concise summary so the new session starts clean with only the
      // essential context from the previous conversation.
      _chatState.messages = rawMessages;
      const compactResult = compactHistory({
        keepRecent: Math.min(4, Math.max(2, Math.floor(rawMessages.length * 0.15))),
        mode: 'aggressive',
      });

      return {
        success: true,
        messageCount: _chatState.messages.length,
        originalCount,
        compacted: compactResult.changed,
        timestamp: data.timestamp,
      };
    }
  } catch {}
  return { success: false };
}

function autoResumeLastSession() {
  try {
    // Per-folder session: load from current directory's conversation store
    const last = loadLastConversation();
    if (!last || !last.timestamp || !last.messages || last.messages.length === 0) return null;
    const lastAt = new Date(last.timestamp);
    if (!Number.isFinite(lastAt.getTime())) return null;
    const now = new Date();
    if (!_isSameAutoResumeSegment(lastAt, now)) return null;
    // No cwd check needed — storage is already per-folder via getConvoDir()
    const elapsed = Date.now() - lastAt.getTime();
    const maxAge = _getAutoResumeWindowMs();
    if (maxAge <= 0) return null;
    if (elapsed > maxAge) return null;
    _chatState.messages = last.messages.slice(-MAX_HISTORY);
    // A5: 标记 session 恢复，防止 contextCompressor 立即重新压缩已压缩内容
    try { require('../services/contextCompressor').markSessionResumed(); } catch {}
    return { resumed: true, messageCount: _chatState.messages.length, timestamp: last.timestamp, cwd: last.cwd };
  } catch {
    return null;
  }
}

/**
 * Resume a persisted session from the rich JSONL store (~/.khy/sessions) into the
 * live conversation. Unlike `resumeConversation` (which reads the legacy
 * ~/.khyquant/conversations summary store and compacts), this restores the full
 * transcript verbatim and — crucially — pins `_liveSessionId` to the resumed id
 * so subsequent turns append to the *same* JSONL transcript instead of forking a
 * new one. Mirrors `autoResumeLastSession`'s context-resumed marking.
 *
 * Meaningful inside the interactive REPL (the router dispatches in-process and
 * shares this module's `_chatState.messages`); in a one-shot CLI invocation the restored
 * context is loaded but the process exits before another turn can use it.
 *
 * @param {string} sessionId
 * @param {object} [opts] - forwarded to sessionPersistence.restoreSession (e.g. leafUuid)
 * @returns {{ success: boolean, sessionId?: string, messageCount?: number, title?: string, model?: string, source?: string, error?: string }}
 */
function resumePersistedSession(sessionId, opts = {}) {
  if (!sessionId) return { success: false, error: 'EMPTY_ID' };
  try {
    const sp = require('../services/sessionPersistence');
    const data = sp.restoreSession(sessionId, opts);
    if (!data || !Array.isArray(data.messages) || data.messages.length === 0) {
      return { success: false, error: 'NOT_FOUND' };
    }

    _chatState.messages = data.messages
      .map((m) => {
        const out = { role: m.role, content: m.content };
        // 让逐回合回溯的 checkpointId 在 resume 后存活(门控关 → 恒等,out 只含 role/content)。
        try { require('../services/rewindResume').carryRewindFields(m, out); } catch { /* fail-soft */ }
        return out;
      })
      .slice(-MAX_HISTORY);

    // Continue the same transcript: future turns append here, not a fresh id.
    _liveSessionId = sessionId;

    // Prevent contextCompressor from immediately re-compacting restored context.
    try { require('../services/contextCompressor').markSessionResumed(); } catch { /* optional */ }

    return {
      success: true,
      sessionId,
      messageCount: _chatState.messages.length,
      title: data.title || '',
      model: data.model || '',
      source: data._source || '',
    };
  } catch (e) {
    return { success: false, error: (e && e.message) ? e.message : 'ERROR' };
  }
}

/**
 * Resume the most-recent FULL persisted session (Store B / JSONL transcript)
 * for the current working directory, falling back to the most-recent session of
 * any project when none was recorded under this cwd. This is the full-fidelity
 * counterpart to `resumeConversation` (which restores the legacy summary store):
 * it powers bare `/resume` so that, after a Ctrl-C exit, the next launch can
 * restore the complete conversation rather than a compacted summary.
 *
 * @param {object} [opts] forwarded to {@link resumePersistedSession}
 * @returns {{success:boolean, sessionId?:string, messageCount?:number,
 *   title?:string, model?:string, source?:string, error?:string}}
 *   `{ success:false, error:'EMPTY' }` when no persisted session exists.
 */
function resumeLastPersistedSession(opts = {}) {
  try {
    const sp = require('../services/sessionPersistence');
    const all = sp.listPersistedSessions({ limit: 200 });
    if (!Array.isArray(all) || all.length === 0) {
      return { success: false, error: 'EMPTY' };
    }
    // listPersistedSessions returns most-recent-first; prefer this cwd's bucket
    // (matching the scope the `session` browser uses) before any-project.
    const cwd = process.cwd();
    const scoped = all.filter(s => s && s.cwd === cwd);
    const pick = (scoped.length > 0 ? scoped : all)[0];
    if (!pick || !pick.sessionId) return { success: false, error: 'EMPTY' };
    return resumePersistedSession(pick.sessionId, opts);
  } catch (e) {
    return { success: false, error: (e && e.message) ? e.message : 'ERROR' };
  }
}

/**
 * @returns {string|null} the current live session id (JSONL transcript in
 * ~/.khy/sessions), or null when no turn has been persisted yet this session.
 */
function getLiveSessionId() {
  return _liveSessionId;
}

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
    if (!adapter && active?.name) adapter = String(active.name).trim();
    if (!model && active?.activeModel) model = String(active.activeModel).trim();
    if (!model && active?.name) model = String(active.name).trim();
  } catch { /* best effort */ }

  return {
    adapter: adapter || null,
    model: model || null,
  };
}

function enableStudyMode() { _chatState.studyMode = true; }
function disableStudyMode() { _chatState.studyMode = false; }
function isStudyMode() { return _chatState.studyMode; }

async function handleAiStatus(options = {}) {
  const { printSuccess, printError, printInfo, withSpinner } = fmt();
  const quick = !!options.quick;
  const status = getAiStatus();
  const switchStates = _readSwitchStates();
  const ownerStatus = _readOwnerControlStatus();

  if (status.available) {
    printSuccess(`AI 服务可用 — ${status.provider}`);
    if (status.configuredProviders.length > 1) {
      printInfo(`已配置 ${status.configuredProviders.length} 个提供商: ${status.configuredProviders.join(', ')}`);
    }
    if (!quick) {
      const svc = getService();
      const test = await withSpinner('测试 AI 连接...', () => svc.testConnection());
      if (test.success) printSuccess(`连接正常 (${test.provider})`);
      else printError('连接测试失败');
    } else {
      printInfo('快速状态模式：已跳过实时连通性测试');
    }
  } else {
    printError('未配置 AI 密钥');
    printInfo('运行 ai config 配置 API 密钥');
    try {
      const hint = require('../services/gateway/gatewayGuide').guideHintLine();
      if (hint) printInfo(hint);
    } catch { /* hint optional */ }
  }

  console.log('');
  printInfo(`技术细节开关: ${_onOff(switchStates.techEnabled)}`);
  printInfo(`开放模式开关: ${_onOff(switchStates.unrestrictedEnabled)}`);
  printInfo(`Owner 控制: ${ownerStatus.configured ? chalk().green('CONFIGURED') : chalk().yellow('NOT CONFIGURED')}`);
  if (ownerStatus.updatedAt) {
    printInfo(`Owner 更新: ${new Date(ownerStatus.updatedAt).toLocaleString('zh-CN')}`);
  }
  if (!ownerStatus.configured) {
    printInfo('建议先运行 ai owner init 初始化 Owner Secret，再使用 ai tech/ai unrestricted');
  }
}

async function handleAiConfig() {
  fmt().printInfo('此命令已迁移到 khy gateway config，正在跳转...');
  const { handleGatewayConfig } = require('./handlers/gateway');
  await handleGatewayConfig();
}

function setEffort(level) {
  if (EFFORT_PRESETS[level]) {
    _chatState.currentEffort = level;
    return true;
  }
  return false;
}

function getEffort() { return _chatState.currentEffort; }
function getEffortPresets() { return EFFORT_PRESETS; }

/**
 * The effort the ACTIVE adapter actually applies — for display/truth.
 * The codex adapter does not honor KHY's `_chatState.currentEffort`: codex CLI reads its
 * own config.toml `model_reasoning_effort`. So when codex is the active adapter,
 * the real effort is that config value, not the KHY global. Every other adapter
 * is driven by `_chatState.currentEffort`. Best-effort; never throws into the UI.
 */
function getActiveEffort() {
  try {
    let adapterName = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase();
    if (!adapterName) {
      const gw = require('../services/gateway/aiGateway');
      const active = typeof gw.getActiveAdapter === 'function' ? gw.getActiveAdapter() : null;
      adapterName = String(active && active.name || '').trim().toLowerCase();
    }
    if (adapterName === 'codex') {
      const codex = require('../services/gateway/adapters/codexAdapter');
      const real = typeof codex.getConfiguredEffort === 'function' ? codex.getConfiguredEffort() : null;
      if (real) return real;
    }
  } catch { /* gateway/adapter not ready — fall back to KHY global */ }
  return _chatState.currentEffort;
}

function setThinkingEnabled(enabled) { _chatState.thinkingEnabled = !!enabled; }
function isThinkingEnabled() { return _chatState.thinkingEnabled; }

/**
 * Check if the current model natively supports extended_thinking (Claude API).
 * Models that don't support it will get CoT prompt injection instead.
 */
function _modelSupportsNativeThinking(modelHint) {
  const m = String(modelHint || '').toLowerCase();
  // Claude Opus 4+ and Claude Sonnet 4+ have native extended_thinking
  return /claude-(opus|sonnet)-4/i.test(m) || /claude-3-5-sonnet/i.test(m);
}

/**
 * Resolve the DeepSeek model variant that matches the /thinking toggle.
 *
 * DeepSeek splits reasoning across two model ids: `deepseek-reasoner` (R1) streams
 * a `reasoning_content` channel, while `deepseek-chat` (V3) emits none. So the
 * /thinking toggle only has teeth on DeepSeek if it actually swaps the model:
 *   - thinking ON  → reasoner, so there IS reasoning to display+fold;
 *   - thinking OFF → chat,     so we drop the reasoning latency/token cost.
 *
 * Returns the model id to switch to, or null when no swap applies (the hint is not
 * a DeepSeek variant, or it is already on the correct one). Pure and env-free so it
 * is unit-testable and never touches any other provider.
 */
function _resolveDeepseekThinkingModel(modelHint, thinkingEnabled) {
  const m = String(modelHint || '').trim().toLowerCase();
  const isChat = m === 'deepseek-chat' || m === 'deepseek-v3' || m === 'deepseek';
  const isReasoner = m === 'deepseek-reasoner' || m === 'deepseek-r1';
  if (!isChat && !isReasoner) return null; // not a DeepSeek toggle target
  if (thinkingEnabled && isChat) return 'deepseek-reasoner';
  if (!thinkingEnabled && isReasoner) return 'deepseek-chat';
  return null; // already on the right variant
}

/**
 * CoT (chain-of-thought) system prompt injection for non-native thinking models.
 * Instructs the model to wrap its reasoning in <think>...</think> tags.
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
 * Streaming-aware: handles partial tags across multiple chunks.
 */
function _createThinkTagInterceptor(originalOnChunk) {
  let insideThink = false;
  let tagBuffer = '';        // accumulates partial tag matches like "<thi" or "</thi"
  const TAG_OPEN = '<think>';
  const TAG_CLOSE = '</think>';

  return function interceptedOnChunk(chunk) {
    if (!chunk || chunk.type !== 'text' || typeof chunk.text !== 'string') {
      // Pass non-text chunks through unchanged
      if (originalOnChunk) originalOnChunk(chunk);
      return;
    }

    const text = chunk.text;
    let i = 0;
    let textBuf = '';
    let thinkBuf = '';

    function flushText() {
      if (textBuf) {
        if (originalOnChunk) originalOnChunk({ ...chunk, type: 'text', text: textBuf });
        textBuf = '';
      }
    }

    function flushThink() {
      if (thinkBuf) {
        if (originalOnChunk) originalOnChunk({ ...chunk, type: 'thinking', text: thinkBuf });
        thinkBuf = '';
      }
    }

    while (i < text.length) {
      const ch = text[i];

      // Check for tag boundaries
      if (ch === '<') {
        tagBuffer = '<';
        i++;
        continue;
      }

      if (tagBuffer) {
        tagBuffer += ch;
        i++;
        // Check if tagBuffer matches a complete tag
        if (tagBuffer === TAG_OPEN) {
          if (!insideThink) flushText();
          insideThink = true;
          tagBuffer = '';
          continue;
        }
        if (tagBuffer === TAG_CLOSE) {
          if (insideThink) flushThink();
          insideThink = false;
          tagBuffer = '';
          continue;
        }
        // Check if tagBuffer is still a valid prefix of either tag
        if (TAG_OPEN.startsWith(tagBuffer) || TAG_CLOSE.startsWith(tagBuffer)) {
          continue; // keep accumulating
        }
        // Not a valid tag prefix — flush buffer as content
        const flushed = tagBuffer;
        tagBuffer = '';
        for (const c of flushed) {
          if (insideThink) thinkBuf += c;
          else textBuf += c;
        }
        continue;
      }

      // Normal character
      if (insideThink) {
        thinkBuf += ch;
      } else {
        textBuf += ch;
      }
      i++;
    }

    // Flush remaining content (tagBuffer stays for next chunk)
    if (insideThink) flushThink();
    else flushText();
  };
}

// Guards against writing the same auto-checkpoint twice within one process run
// (e.g. clearHistory 之后又 EOF 退出)。仅进程内内存标记,新会话自然复位。
let _lastAutoCheckpointSig = '';

/**
 * 「会话结束自动进度检查点」安全网(门控 KHY_PROGRESS_AUTO_CHECKPOINT,嵌 KHY_PROGRESS_LOG 下)。
 *
 * 在会话结束的接缝(clearHistory=/clear·/new·/reset·双 Ctrl+C;以及 repl EOF 退出)调用:
 * 若模型本会话**没**手动调过 RecordProgress、且这段确像跨会话的学习/工作,就用**确定性启发式**
 * (绝不调 LLM)从当前 _chatState.messages 蒸馏一条 {主题,已覆盖,下一步} 追加进项目 PROGRESS.md,闭合
 * 「下次从零」的环。绝不抛、绝不阻塞退出路径:任何异常都吞掉。
 *
 * @param {string} [reason] 触发来源(仅用于将来诊断,不影响行为)
 * @returns {boolean} 是否实际写入了一条自动检查点
 */
function maybeAutoCheckpointProgress(reason) {
  try {
    let leaf;
    try { leaf = require('../services/memoryEngine/sessionCheckpoint'); } catch { return false; }
    if (!leaf || typeof leaf.buildAutoCheckpoint !== 'function') return false;

    // 蒸馏前用会话快照(clearHistory 会在本调用之后清空 _chatState.messages)。
    const messages = Array.isArray(_chatState.messages) ? _chatState.messages : [];
    if (messages.length === 0) return false;

    let folderName = '';
    try { folderName = path.basename(process.cwd()) || ''; } catch { folderName = ''; }

    const entry = leaf.buildAutoCheckpoint({
      messages,
      studyMode: _chatState.studyMode === true,
      folderName,
      env: process.env,
    });
    if (!entry || !entry.topic || !entry.covered) return false;

    // 进程内去重:同一条(主题+覆盖点)只写一次,避免 /clear 后又 EOF 造成重复。
    const sig = `${entry.topic} ${entry.covered}`;
    if (sig === _lastAutoCheckpointSig) return false;

    let memdir;
    try { memdir = require('../memdir/memdir'); } catch { return false; }
    if (!memdir || typeof memdir.appendProjectProgress !== 'function') return false;
    const res = memdir.appendProjectProgress(entry);
    if (res && res.ok) {
      _lastAutoCheckpointSig = sig;
      return true;
    }
    return false;
  } catch {
    return false; // 安全网绝不能拖垮会话结束/退出路径
  }
}

function clearHistory() {
  // 先于清空历史做「会话结束自动检查点」安全网(蒸馏需要 _chatState.messages 尚在)。
  try { maybeAutoCheckpointProgress('clearHistory'); } catch { /* never blocks reset */ }
  _chatState.messages = [];
  _chatState.gatewayPreflightDone = false;
  _chatState.gatewayPreflightInFlight = null;
  _localWarmupAttemptedAdapters = new Set();
  _localWarmupInFlight = new Map();
  _chatState.pendingTaskGuard = null;
  _chatState.lastSubstantivePrompt = '';
  _chatState.lastSubstantiveAt = 0;
  _liveSessionId = null;   // next turn starts a fresh ~/.khy/sessions transcript
  // Drop any ephemeral role overlay (DESIGN-ARCH-059 #3): a temporary role must
  // not survive a session reset (/new, /reset, /clear, double-Ctrl+C). No-op when
  // none is active (e.g. the web daemon, which never adopts an ephemeral role).
  try { require('../services/roleService').clearActiveRole(); } catch { /* optional */ }
  // Forget short-term session memory (layer 1, point 5): a session reset ends the
  // session, so its in-process short-term memories are forgotten. Persistent
  // (cross_session / permanent) memories on disk are untouched. Fail-soft.
  try { require('../services/memoryEngine').sessionMemory.clear(); } catch { /* optional */ }
}

function _normalizeSummaryText(text = '', maxLen = 220) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(16, maxLen - 1))}…`;
}

function getConversationStats() {
  const stats = {
    totalMessages: _chatState.messages.length,
    userMessages: 0,
    assistantMessages: 0,
    toolMessages: 0,
    systemMessages: 0,
    otherMessages: 0,
    effort: _chatState.currentEffort,
    studyMode: _chatState.studyMode,
  };

  // 用户消息计数走 isHumanTurn SSOT(cli/messagePredicates,门控 KHY_HUMAN_TURN_COUNT):
  // khy 把工具结果载体(`[Tool Result]…` / 结构化 tool_result 块)与压缩摘要
  // (`[ContextCompact …]`)也 push 成 role:'user',旧逻辑把它们全算进「用户」→
  // /context 与 会话摘要 的「用户 X」系统性多算。门控关 → 逐字节回退每条 user 都 +1。
  let _htMod = null;
  try { _htMod = require('./messagePredicates'); } catch { _htMod = null; }
  const _htOn = !!_htMod && _htMod.humanTurnCountEnabled(process.env);
  for (const msg of _chatState.messages) {
    const role = String(msg?.role || '').toLowerCase();
    if (role === 'user') {
      if (_htOn) {
        const kind = _htMod.userMessageKind(msg);
        if (kind === 'tool') stats.toolMessages += 1;        // 工具结果载体
        else if (kind === 'meta') stats.otherMessages += 1;  // 压缩摘要(合成)
        else stats.userMessages += 1;                        // 真人回合
      } else {
        stats.userMessages += 1;
      }
    }
    else if (role === 'assistant') stats.assistantMessages += 1;
    else if (role === 'tool') stats.toolMessages += 1;
    else if (role === 'system') stats.systemMessages += 1;
    else stats.otherMessages += 1;
  }

  return stats;
}

function getConversation() {
  return _chatState.messages.map((msg) => ({ ...msg }));
}

function _messageHasToolUse(msg) {
  const c = msg && msg.content;
  return Array.isArray(c) && c.some((b) => b && b.type === 'tool_use');
}

/**
 * Manually snip messages out of the live conversation context — the user-driven
 * counterpart to compactConversation()'s automatic summarization. Aligns with
 * Claude Code's Snip: drop content the user judges no longer worth its tokens.
 *
 * Modes (first match wins):
 *   - options.range = [a, b]  → remove 1-based message indices a..b (inclusive)
 *   - options.count = N       → remove the last N messages
 *   - (default)               → remove the most recent turn: from the last
 *                               `user` message through the end
 *
 * After removal, a trailing assistant message whose tool_use blocks just lost
 * their tool_results is popped too, so stored history stays API-valid. (The
 * request builder's ensureToolResultPairing() also repairs pairing at send
 * time, including mid-history orphans; this only keeps _chatState.messages tidy.)
 *
 * @param {object} [options]
 * @returns {{success:boolean, changed:boolean, previousCount:number, nextCount:number, removedCount:number, mode:string, error?:string}}
 */
function snipConversation(options = {}) {
  const previousCount = _chatState.messages.length;
  const done = (changed, mode) => ({
    success: true,
    changed,
    previousCount,
    nextCount: _chatState.messages.length,
    removedCount: previousCount - _chatState.messages.length,
    mode,
  });

  if (previousCount === 0) return done(false, 'empty');

  let mode;
  if (Array.isArray(options.range) && options.range.length === 2) {
    const a = Math.floor(Number(options.range[0]));
    const b = Math.floor(Number(options.range[1]));
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) {
      return {
        success: false,
        changed: false,
        previousCount,
        nextCount: previousCount,
        removedCount: 0,
        mode: 'invalid-range',
        error: '无效区间，用法: snip <起>-<止>（1 起始，含端点）',
      };
    }
    const start = a - 1;
    if (start >= previousCount) return done(false, 'out-of-range');
    const end = Math.min(b, previousCount); // inclusive, clamped
    _chatState.messages.splice(start, end - start);
    mode = 'range';
  } else if (Number.isFinite(Number(options.count)) && Number(options.count) > 0) {
    const count = Math.min(Math.floor(Number(options.count)), previousCount);
    _chatState.messages.splice(previousCount - count, count);
    mode = 'count';
  } else {
    // Default: most recent turn = from the last `user` message through the end.
    let idx = -1;
    for (let i = _chatState.messages.length - 1; i >= 0; i--) {
      if (String(_chatState.messages[i]?.role || '').toLowerCase() === 'user') { idx = i; break; }
    }
    const from = idx >= 0 ? idx : Math.max(0, _chatState.messages.length - 1);
    _chatState.messages.splice(from);
    mode = 'turn';
  }

  // Tidy: drop a now-trailing assistant message that carries unresolved tool_use
  // (its tool_results were just removed), so stored history stays API-valid.
  while (
    _chatState.messages.length > 0
    && String(_chatState.messages[_chatState.messages.length - 1].role || '').toLowerCase() === 'assistant'
    && _messageHasToolUse(_chatState.messages[_chatState.messages.length - 1])
  ) {
    _chatState.messages.pop();
  }

  return done(_chatState.messages.length !== previousCount, mode);
}

/**
 * Rewind model history to just before the N-th user message counted from the end
 * (1-based: 1 = most recent user turn). Removes that user message and everything
 * after it. Delegates to snipConversation for the splice + the trailing
 * unresolved-tool_use tidy, so stored history stays API-valid.
 *
 * Used by the TUI double-ESC rewind (services/cli/tui/rewindControl.js) and the
 * legacy readline `/rewind` command. The "N-th user message from the end" key is
 * what bridges the UI transcript and this _chatState.messages store: every UI user turn
 * maps 1:1, in order, to one user message here.
 *
 * @param {number} nFromEnd
 * @returns {{success:boolean, changed:boolean, previousCount:number, nextCount:number, removedCount:number, mode:string, error?:string}}
 */
function rewindToUserTurn(nFromEnd) {
  const previousCount = _chatState.messages.length;
  const n = Math.floor(Number(nFromEnd));
  if (!Number.isFinite(n) || n < 1) {
    return {
      success: false, changed: false, previousCount,
      nextCount: previousCount, removedCount: 0, mode: 'invalid',
      error: '无效轮次序号,须为 >= 1 的整数(1 = 最近一条用户消息)',
    };
  }
  const userIdx = [];
  for (let i = 0; i < _chatState.messages.length; i++) {
    if (String(_chatState.messages[i] && _chatState.messages[i].role || '').toLowerCase() === 'user') userIdx.push(i);
  }
  if (n > userIdx.length) {
    return {
      success: false, changed: false, previousCount,
      nextCount: previousCount, removedCount: 0, mode: 'out-of-range',
      error: `仅有 ${userIdx.length} 条用户消息,无法回溯到第 ${n} 条`,
    };
  }
  const from = userIdx[userIdx.length - n]; // 0-based index of the target user msg
  return snipConversation({ range: [from + 1, _chatState.messages.length] }); // 1-based inclusive
}

/**
 * Build a compact, authoritative summary string for a contiguous message segment.
 * Mirrors compactHistory's point-extraction (user/assistant/tool bullets) but for
 * an arbitrary tail range, so summarizeFromUserTurn can collapse "from here on".
 * @param {Array} segment
 * @param {{instructions?:string, focus?:string}} [options]
 * @returns {string}
 */
function _buildSegmentSummary(segment, options = {}) {
  const focus = _normalizeSummaryText(options.instructions || options.focus || '', 300);
  const MAX_POINT_CHARS = 220;
  const MAX_ITEMS = 8;
  const MAX_SUMMARY_CHARS = 4000;
  const toText = (c) => {
    try { return require('../services/contentBlockUtils').contentToText(c); }
    catch { return String(c || ''); }
  };
  const userPoints = [];
  const assistantPoints = [];
  const toolPoints = [];
  const pushUnique = (arr, text, limit) => {
    if (!text || arr.length >= limit) return;
    if (arr.includes(text)) return;
    arr.push(text);
  };
  for (const msg of Array.isArray(segment) ? segment : []) {
    const role = String(msg && msg.role || '').toLowerCase();
    const normalized = _normalizeSummaryText(toText(msg && msg.content), MAX_POINT_CHARS);
    if (!normalized) continue;
    if (role === 'user') pushUnique(userPoints, normalized, MAX_ITEMS);
    else if (role === 'assistant') pushUnique(assistantPoints, normalized, MAX_ITEMS);
    else if (role === 'tool') pushUnique(toolPoints, normalized, Math.ceil(MAX_ITEMS / 2));
  }
  const lines = [];
  lines.push(`[SummarizeFromHere @ ${new Date().toISOString()}]`);
  lines.push(`Summarized ${Array.isArray(segment) ? segment.length : 0} message(s) from the selected turn onward.`);
  if (focus) lines.push(`Focus priority: ${focus}`);
  if (userPoints.length) {
    lines.push('');
    lines.push('User requests in this range:');
    userPoints.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  if (assistantPoints.length) {
    lines.push('');
    lines.push('Assistant actions/conclusions in this range:');
    assistantPoints.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  if (toolPoints.length) {
    lines.push('');
    lines.push('Tool outcomes in this range:');
    toolPoints.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  lines.push('');
  lines.push('Treat this as authoritative memory for the summarized turns; do not re-ask settled points.');
  let summary = lines.join('\n').trim();
  if (summary.length > MAX_SUMMARY_CHARS) summary = `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
  return summary;
}

/**
 * Summarize model history "from here": keep everything BEFORE the N-th user turn
 * (same "N-th user message from the end" key as rewindToUserTurn) and collapse
 * that user turn plus everything after it into a single compact summary message.
 * Unlike rewindToUserTurn (which DISCARDS the tail), this PRESERVES the tail's
 * gist as authoritative memory, so the model keeps context without the tokens.
 *
 * CC parity: MessageSelector's 'Summarize from here' (option value 'summarize').
 *
 * Role alternation (stored history must stay API-valid — no user-user /
 * assistant-assistant adjacency, and the NEXT real user turn must alternate):
 * the summary is appended after the kept prefix as a 'user' message followed by a
 * short 'assistant' bridge — UNLESS the kept prefix already ends with a user turn,
 * in which case the summary is emitted as 'assistant' with no bridge.
 *
 * @param {number} nFromEnd  1-based user-turn index from the end (1 = most recent)
 * @param {{instructions?:string, focus?:string}} [options]
 * @returns {{success:boolean, changed:boolean, summarized?:boolean, previousCount:number, nextCount:number, summarizedCount:number, mode:string, summaryChars?:number, error?:string}}
 */
function summarizeFromUserTurn(nFromEnd, options = {}) {
  const previousCount = _chatState.messages.length;
  const n = Math.floor(Number(nFromEnd));
  if (!Number.isFinite(n) || n < 1) {
    return {
      success: false, changed: false, previousCount,
      nextCount: previousCount, summarizedCount: 0, mode: 'invalid',
      error: '无效轮次序号,须为 >= 1 的整数(1 = 最近一条用户消息)',
    };
  }
  const userIdx = [];
  for (let i = 0; i < _chatState.messages.length; i++) {
    if (String(_chatState.messages[i] && _chatState.messages[i].role || '').toLowerCase() === 'user') userIdx.push(i);
  }
  if (n > userIdx.length) {
    return {
      success: false, changed: false, previousCount,
      nextCount: previousCount, summarizedCount: 0, mode: 'out-of-range',
      error: `仅有 ${userIdx.length} 条用户消息,无法回溯到第 ${n} 条`,
    };
  }
  const from = userIdx[userIdx.length - n]; // 0-based index of the target user msg
  const kept = _chatState.messages.slice(0, from);
  const toSummarize = _chatState.messages.slice(from);
  if (toSummarize.length === 0) {
    return {
      success: true, changed: false, summarized: false, previousCount,
      nextCount: previousCount, summarizedCount: 0, mode: 'none',
    };
  }

  const summary = _buildSegmentSummary(toSummarize, options);
  const lastKeptRole = String(kept.length ? (kept[kept.length - 1] && kept[kept.length - 1].role) : '').toLowerCase();
  if (lastKeptRole === 'user') {
    // Prefix ends with a user turn → emit summary as assistant (keeps alternation;
    // the next real user turn then alternates assistant→user).
    _chatState.messages = [...kept, { role: 'assistant', content: summary }];
  } else {
    // Prefix ends with assistant / is empty → summary as user + an assistant bridge,
    // so the NEXT real user turn alternates after the bridge (no user-user → API 400).
    _chatState.messages = [
      ...kept,
      { role: 'user', content: summary },
      { role: 'assistant', content: '好的，我已了解此处之后的对话摘要，继续处理你的请求。' },
    ];
  }
  if (_chatState.messages.length > MAX_HISTORY) _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);

  return {
    success: true,
    changed: true,
    summarized: true,
    previousCount,
    nextCount: _chatState.messages.length,
    summarizedCount: toSummarize.length,
    mode: 'summarize',
    summaryChars: summary.length,
  };
}

function getContextLimit(modelHint = '') {
  const hint = String(modelHint || '').trim() || _guessModelHint();
  return _resolveModelContextLimit(hint);
}

function compactConversation(options = {}) {
  return compactHistory(options);
}

function compactHistory(options = {}) {
  const previousCount = _chatState.messages.length;
  const keepRecent = Math.max(
    4,
    Math.min(40, Number.isFinite(Number(options.keepRecent)) ? Math.floor(Number(options.keepRecent)) : 12)
  );
  const focus = _normalizeSummaryText(options.instructions || options.focus || '', 300);

  if (previousCount <= (keepRecent + 1)) {
    return {
      success: true,
      changed: false,
      previousCount,
      nextCount: previousCount,
      compactedCount: 0,
      keepRecent,
      mode: 'none',
    };
  }

  const modeConfigs = {
    light: {
      maxItems: 4,
      maxToolItems: 2,
      maxPointChars: 160,
      maxSummaryChars: 2400,
      continuityHint: 'Prefer concise continuation and ask for missing details early.',
    },
    balanced: {
      maxItems: 6,
      maxToolItems: 3,
      maxPointChars: 220,
      maxSummaryChars: 3800,
      continuityHint: 'Continue from established decisions and prioritize recent constraints.',
    },
    aggressive: {
      maxItems: 10,
      maxToolItems: 5,
      maxPointChars: 300,
      maxSummaryChars: 6200,
      continuityHint: 'Retain as much decision history as possible and avoid re-asking settled topics.',
    },
  };

  let mode = String(options.mode || 'balanced').trim().toLowerCase();
  if (mode === 'auto') {
    if (previousCount >= 60 || keepRecent <= 8) mode = 'aggressive';
    else if (previousCount >= 28) mode = 'balanced';
    else mode = 'light';
  }
  if (!modeConfigs[mode]) mode = 'balanced';
  const cfg = modeConfigs[mode];

  const boundary = Math.max(0, previousCount - keepRecent);
  const toCompact = _chatState.messages.slice(0, boundary);
  const keepTail = _chatState.messages.slice(boundary);

  const userPoints = [];
  const assistantPoints = [];
  const toolPoints = [];

  const pushUnique = (arr, text, limit) => {
    if (!text || arr.length >= limit) return;
    if (arr.includes(text)) return;
    arr.push(text);
  };

  // Prefer recent history points from the compacted segment.
  for (const msg of [...toCompact].reverse()) {
    const role = String(msg?.role || '').toLowerCase();
    const normalized = _normalizeSummaryText((() => {
      try { return require('../services/contentBlockUtils').contentToText(msg?.content); } catch { return String(msg?.content || ''); }
    })(), cfg.maxPointChars);
    if (!normalized) continue;

    if (role === 'user') {
      pushUnique(userPoints, normalized, cfg.maxItems);
      continue;
    }
    if (role === 'assistant') {
      pushUnique(assistantPoints, normalized, cfg.maxItems);
      continue;
    }
    if (role === 'tool') {
      pushUnique(toolPoints, normalized, cfg.maxToolItems);
    }
  }

  const latestTailUser = [...keepTail].reverse().find(m => String(m?.role || '').toLowerCase() === 'user');
  const latestTailAssistant = [...keepTail].reverse().find(m => String(m?.role || '').toLowerCase() === 'assistant');

  const lines = [];
  lines.push(`[ContextCompact v2 @ ${new Date().toISOString()}]`);
  lines.push(`Mode: ${mode}. Compacted: ${toCompact.length}. Kept recent turns: ${keepTail.length}.`);
  lines.push(`Continuation rule: ${cfg.continuityHint}`);
  if (focus) lines.push(`Focus priority: ${focus}`);

  if (userPoints.length > 0) {
    lines.push('');
    lines.push('Primary user goals already discussed:');
    userPoints.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
  }

  if (assistantPoints.length > 0) {
    lines.push('');
    lines.push('Established assistant conclusions/actions:');
    assistantPoints.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
  }

  if (toolPoints.length > 0) {
    lines.push('');
    lines.push('Tool outcomes worth retaining:');
    toolPoints.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
  }

  lines.push('');
  lines.push('Pending context to resume immediately:');
  if (latestTailUser) {
    lines.push(`- Latest user turn: ${_normalizeSummaryText((() => { try { return require('../services/contentBlockUtils').contentToText(latestTailUser.content); } catch { return String(latestTailUser.content || ''); } })(), 260)}`);
  }
  if (latestTailAssistant) {
    lines.push(`- Latest assistant turn: ${_normalizeSummaryText((() => { try { return require('../services/contentBlockUtils').contentToText(latestTailAssistant.content); } catch { return String(latestTailAssistant.content || ''); } })(), 260)}`);
  }
  if (!latestTailUser && !latestTailAssistant) {
    lines.push('- No recent tail content was available.');
  }

  // Preserve the active task anchor so continuation commands work after compaction
  if (_chatState.lastSubstantivePrompt) {
    lines.push('');
    lines.push('Active task anchor (verbatim user request):');
    lines.push(`"${_chatState.lastSubstantivePrompt.slice(0, 400)}"`);
  }

  lines.push('');
  lines.push('Resume instructions:');
  lines.push('1. Treat this compact block as authoritative memory for earlier turns.');
  lines.push('2. Do not re-ask solved questions unless user explicitly reopens them.');
  lines.push('3. Prioritize recent tail turns over older compacted bullets when conflicts appear.');

  let summary = lines.join('\n').trim();
  if (summary.length > cfg.maxSummaryChars) {
    summary = `${summary.slice(0, cfg.maxSummaryChars - 1)}…`;
  }

  // 修复: 压缩摘要用 user 角色，并确保与 keepTail 之间角色交替正确
  // 之前用 role:'tool' 会被 _buildStructuredMessages 转为 user，与 keepTail 首条 user 消息
  // 形成连续 user-user，导致 API 400。
  const summaryMsg = { role: 'user', content: summary };

  // 确保角色交替：如果 keepTail 第一条也是 user，插入一个 assistant 桥接
  const firstKept = keepTail[0];
  const firstKeptRole = String(firstKept?.role || '').toLowerCase();
  if (firstKeptRole === 'user') {
    _chatState.messages = [summaryMsg, { role: 'assistant', content: '好的，我已了解上下文，继续处理你的请求。' }, ...keepTail];
  } else {
    _chatState.messages = [summaryMsg, ...keepTail];
  }
  if (_chatState.messages.length > MAX_HISTORY) _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);

  return {
    success: true,
    changed: true,
    previousCount,
    nextCount: _chatState.messages.length,
    compactedCount: toCompact.length,
    keepRecent,
    mode,
    summaryChars: summary.length,
  };
}


async function handleAiOwner(action = 'status', options = {}) {
  const { printSuccess, printError, printInfo } = fmt();
  const owner = require('../services/ownerControlService');
  const cmd = String(action || 'status').toLowerCase();

  if (cmd === 'status') {
    const st = owner.getOwnerControlStatus();
    printInfo(`Owner 控制: ${st.configured ? chalk().green('CONFIGURED') : chalk().yellow('NOT CONFIGURED')}`);
    if (st.updatedAt) {
      printInfo(`最近更新: ${new Date(st.updatedAt).toLocaleString('zh-CN')}`);
    }
    if (!st.configured) {
      printInfo('运行 ai owner init 初始化 Owner Secret');
    }
    return;
  }

  if (cmd === 'init') {
    if (owner.isOwnerControlConfigured()) {
      printError('Owner 控制已初始化。若要更换请使用 ai owner rotate');
      _markFailure();
      return;
    }

    let secret = String(options.secret || options.key || '').trim();
    let confirm = String(options.confirm || '').trim();
    if (!secret) secret = await _askSecret('Set owner secret (at least 8 chars):');
    if (!confirm) confirm = await _askSecret('Confirm owner secret:');
    if (secret !== confirm) {
      printError('Secret confirmation mismatch.');
      _markFailure();
      return;
    }

    const result = owner.initializeOwnerControl(secret);
    if (!result.ok) {
      printError(result.error || 'Owner control initialization failed.');
      _markFailure();
      return;
    }
    printSuccess('Owner control initialized.');
    printInfo('后续敏感开关操作需要 Owner Secret 验证。');
    return;
  }

  if (cmd === 'rotate') {
    const verify = await _requireOwnerSecret(options);
    if (!verify.ok) {
      printError(verify.error);
      _markFailure();
      return;
    }

    let nextSecret = String(options.next || options.new || '').trim();
    let confirm = String(options.confirm || '').trim();
    if (!nextSecret) nextSecret = await _askSecret('New owner secret (at least 8 chars):');
    if (!confirm) confirm = await _askSecret('Confirm new owner secret:');
    if (nextSecret !== confirm) {
      printError('New secret confirmation mismatch.');
      _markFailure();
      return;
    }

    const rotated = owner.rotateOwnerSecret(verify.secret, nextSecret);
    if (!rotated.ok) {
      printError(rotated.error || 'Owner secret rotate failed.');
      _markFailure();
      return;
    }
    printSuccess('Owner secret rotated.');
    return;
  }

  printError('用法: ai owner status | ai owner init | ai owner rotate');
  _markFailure();
}

async function handleAiTech(options = {}, args = []) {
  const { printSuccess, printError, printInfo, printWarn } = fmt();
  const opts = _normalizeSwitchInput(options, args);
  const { techEnabled } = _readSwitchStates();

  if (!!opts.on === !!opts.off) {
    if (opts.status || (!opts.on && !opts.off)) {
      printInfo(`技术细节开关当前状态: ${_onOff(techEnabled)}`);
      if (!techEnabled) {
        printInfo('开启后可回答项目架构与实现细节。');
      }
      return;
    }
    printError('用法: ai tech --on | ai tech --off | ai tech --status');
    _markFailure();
    return;
  }

  const verify = await _requireOwnerSecret(opts);
  if (!verify.ok) {
    printError(verify.error);
    _markFailure();
    return;
  }

  const nextVal = opts.on ? 'true' : 'false';
  _setEnvVar(AI_TECH_DETAILS_ENV, nextVal);
  printSuccess(`技术细节开关已${opts.on ? '开启' : '关闭'} (${AI_TECH_DETAILS_ENV}=${nextVal})`);
  if (opts.on) {
    printWarn('技术细节模式已开启，AI 可回答项目实现细节；上线发布前建议关闭。');
  } else {
    printInfo('生产发布建议：保持技术细节开关关闭。');
  }
}

async function handleAiUnrestricted(options = {}, args = []) {
  const { printSuccess, printError, printInfo, printWarn } = fmt();
  const opts = _normalizeSwitchInput(options, args);
  const { unrestrictedEnabled } = _readSwitchStates();

  if (!!opts.on === !!opts.off) {
    if (opts.status || (!opts.on && !opts.off)) {
      printInfo(`开放模式当前状态: ${_onOff(unrestrictedEnabled)}`);
      return;
    }
    printError('用法: ai unrestricted --on | ai unrestricted --off | ai unrestricted --status');
    _markFailure();
    return;
  }

  const verify = await _requireOwnerSecret(opts);
  if (!verify.ok) {
    printError(verify.error);
    _markFailure();
    return;
  }

  const nextVal = opts.on ? 'true' : 'false';
  _setEnvVar(AI_UNRESTRICTED_ENV, nextVal);
  printSuccess(`开放模式已${opts.on ? '开启' : '关闭'} (${AI_UNRESTRICTED_ENV}=${nextVal})`);
  if (opts.on) {
    printWarn('开放模式会放宽安全拦截，请仅在受控环境临时使用。');
  } else {
    printInfo('标准安全策略已恢复。');
  }
}


// Inject the host-defined bindings the isolated chat core calls (all defined above by now).
_aiChatCore.setAiChatCoreDeps({
  COT_INJECTION_PROMPT, EFFORT_PRESETS, MAX_HISTORY, MODEL_CAPABILITIES,
  _applyVisionRouting, _buildGreetingQuickReply, _buildLanguageFallbackDirective, _clampSubagentEffort,
  _classifyGatewayThrownError, _createStreamToolInterceptor, _createThinkTagInterceptor, _ensureLiveSessionId,
  _estimateContextTokens, _extractFileReferences, _getModelInfo, _getStudyModeRuntimeMeta,
  _guessModelHint, _isFirstTokenSignalChunk, _isLightweightConversationInput, _isLocalThinkingModel,
  _isTransientGatewayErrorType, _logStandaloneLlmRequest, _logStandaloneLlmResponse, _maybeAutoSaveMemory,
  _maybeWarmupLocalPreferredOnce, _modelSupportsNativeThinking, _persistLiveSession, _registerActiveGatewayRequest,
  _resolveAuditTraceContext, _resolveContextBudget, _resolveDeepseekThinkingModel, _resolveLocalPreferredMaxTokens,
  _resolveModelContextLimit, _resolveTaskScale, _uncommitOrphanTurn, _unregisterActiveGatewayRequest,
  getChatLatencyAutoTuner, getGateway, getSecurityDir, getService,
});

module.exports = {
  getAiStatus,
  getActiveProvider,
  handleAiStatus,
  handleAiConfig,
  chat,
  cancelActiveRequest,
  recordInterruption,
  clearHistory,
  maybeAutoCheckpointProgress,
  saveConversation,
  loadLastConversation,
  listConversations,
  findConversationByRef,
  resumeConversation,
  resumePersistedSession,
  resumeLastPersistedSession,
  getLiveSessionId,
  autoResumeLastSession,
  loadProjectMemoryContext,
  setEffort,
  getEffort,
  getActiveEffort,
  getEffortPresets,
  setThinkingEnabled,
  isThinkingEnabled,
  getConversationStats,
  getConversation,
  getContextLimit,
  compactConversation,
  compactHistory,
  snipConversation,
  rewindToUserTurn,
  summarizeFromUserTurn,
  enableStudyMode,
  disableStudyMode,
  isStudyMode,
  checkModelCapability,
  handleAiOwner,
  handleAiTech,
  handleAiUnrestricted,
  EFFORT_PRESETS,
  _clampSubagentEffort,
  MODEL_CAPABILITIES,
  getSystemPrompt: async () => runtime.makeSystemPrompt(getSecurityDir(), _getModelInfo()),
  __test__: {
    _createStreamToolInterceptor,
    _partialToolMarkerTailLen,
    _isContextOverflowFailure,
    // DESIGN-ARCH-046 orphan-turn regression seam: operate on the real
    // module-closure `_chatState.messages` so the test verifies authoritative state.
    _uncommitOrphanTurn,
    _pushRawMessage: (m) => { _chatState.messages.push(m); return _chatState.messages[_chatState.messages.length - 1]; },
    // 空响应救援（anti-truncation）：纯函数，便于单测捞回逻辑与回溯窗口。
    _salvageRecentToolResult,
    // /thinking 开关有牙化：DeepSeek reasoner/chat 变体路由（纯函数，可单测）。
    _resolveDeepseekThinkingModel,
    // ReDoS 守卫：文件引用抽取（纯函数，可单测线性化与保真）。
    _extractFileReferences,
    _fileRefRedosGuardEnabled,
    // Fix F 根因（dogfood）：流式工具块取真参数(rawInput)而非展示摘要(input)。
    _resolveToolBlockInput,
    _streamToolRawInputEnabled,
    // 能力硬约束假阳性根因：难度评分前剥离 harness 注入的 [System:…] 脚手架，
    // 避免 planning/key-findings 前言里的「根本原因」等词把 reasoning 需求抬到 4，
    // 把 "你好" 这类裸问候误判成需要强推理而硬拦。纯函数，可单测。
    _stripHarnessScaffolding,
    _assessTaskDifficulty,
  },
};

// Self-register the non-chat AI seams on neutral ports so the services layer
// reaches them without a reverse require (DESIGN-ARCH-021, Batch 3). Legit
// cli → services direction; exports unchanged. The chat() model-call core is
// intentionally NOT exposed here — its three reverse edges stay a separate effort.
try {
  require('../services/modelCapabilityPort').registerModelCapabilityChecker(checkModelCapability);
} catch { /* port unavailable — capability pre-check degrades to skipped */ }
try {
  require('../services/aiSessionPort').registerAiSession({
    handleAiStatus,
    handleAiConfig,
    clearHistory,
  });
} catch { /* port unavailable — /status /config /new fallback degrades */ }
try {
  require('../services/aiChatPort').registerAiChat(chat);
} catch { /* port unavailable — ultraplan/workflow chat fallback degrades */ }
try {
  require('../services/aiConversationPort').registerAiConversation({
    getEffort,
    saveConversation,
    loadLastConversation,
    clearHistory,
  });
} catch { /* port unavailable — queryEngine conversation-state ops degrade to no-op */ }

