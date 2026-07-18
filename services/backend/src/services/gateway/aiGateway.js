/**
 * AI Gateway — central service that routes AI requests through
 * a priority-ordered cascade of adapters:
 *   1. CLI tools (Claude Code, Codex, Aider)
 *   2. Cloud API providers (MultiFreeService)
 *   3. Web relay (manual browser-based relay, always available)
 *
 * Singleton export — matches project convention.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createKeyedRateLimiter } = require('../rateLimiter');
// Model-name SSOT: codex probe-model fallback flows from constants/models.js.
const { PRIMARY: MODELS } = require('../../constants/models');
const { retryWithBackoff, isRetryableError, parseRetryAfter } = require('../retryWithBackoff');
const { diagnostics, generateTraceId: genDiagTraceId } = require('../diagnosticEvents');
const { usageTracker } = require('../usageTracker');
const { evaluateGuard, formatWarning: formatGuardWarning } = require('../contextWindowGuard');
let _adaptiveConfig = null;
try {
  _adaptiveConfig = require('../adaptiveConfig');
} catch { _adaptiveConfig = null; }
let _traceAudit = null;
try {
  _traceAudit = require('../traceAuditService');
  _traceAudit.ensureDiagnosticsBridge();
} catch {
  _traceAudit = null;
}
const keySelector = require('./keySelector');
const localLLMAdapter = require('./adapters/localLLMAdapter');
let localLLMService = null;
try {
  localLLMService = require('../localLLMService');
} catch {
  localLLMService = null;
}
const cliToolAdapter = require('./adapters/cliToolAdapter');
const opencodeAdapter = require('./adapters/opencodeAdapter');
const kiroAdapter = require('./adapters/kiroAdapter');
const cursorAdapter = require('./adapters/cursorAdapter');
const traeAdapter = require('./adapters/traeAdapter');
const claudeAdapter = require('./adapters/claudeAdapter');
const codexAdapter = require('./adapters/codexAdapter');
const windsurfAdapter = require('./adapters/windsurfAdapter');
const vscodeAdapter = require('./adapters/vscodeAdapter');
const warpAdapter = require('./adapters/warpAdapter');
const ollamaAdapter = require('./adapters/ollamaAdapter');
const cursor2apiAdapter = require('./adapters/cursor2apiAdapter');
const relayApiAdapter = require('./adapters/relayApiAdapter');
const apiAdapter = require('./adapters/apiAdapter');
const webRelayAdapter = require('./adapters/webRelayAdapter');
const clipboardRelayAdapter = require('./adapters/clipboardRelayAdapter');
const { createSequentialQueue } = require('../sequentialQueue');
const { RedisHealthStore } = require('./redisHealthStore');
const { createRedisRateLimiter } = require('./redisRateLimiter');
const { createRequestDedup } = require('./requestDedup');
const { ChannelHealthBroadcaster } = require('./channelHealthBroadcaster');
const modelCuration = require('./modelCuration');
const failureExplainer = require('./failureExplainer');

let _cachedSafeKill = (child) => {
  try {
    if (child && typeof child.kill === 'function') child.kill('SIGTERM');
  } catch { /* best effort */ }
};
try {
  const platformUtils = require('../../tools/platformUtils');
  if (platformUtils && typeof platformUtils.safeKill === 'function') {
    _cachedSafeKill = platformUtils.safeKill;
  }
} catch { /* keep fallback */ }

function safeKillChildProc(child) {
  if (typeof _cachedSafeKill === 'function') {
    try {
      _cachedSafeKill(child);
      return;
    } catch { /* fallback below */ }
  }
  try {
    if (child && typeof child.kill === 'function') child.kill('SIGTERM');
  } catch { /* best effort */ }
}

// ── Live model switching ────────────
let _modelSwitch;
try {
  const { getInstance: getModelSwitch } = require('../liveModelSwitch');
  _modelSwitch = getModelSwitch();
} catch { _modelSwitch = null; }

// ── Advanced diagnostics ────────────
let _advDiag;
try {
  const { getInstance: getAdvDiag } = require('../advancedDiagnostics');
  _advDiag = getAdvDiag();
} catch { _advDiag = null; }

// ── Error classification (enhanced with errorClassifier) ────────────
const { detectErrorKindDeep, formatErrorMessage: fmtError, isRetryable: _ecIsRetryable } = require('../errorClassifier');

function _isReconnectOrChannelClosedMessage(message = '') {
  const lower = String(message || '').toLowerCase();
  return /reconnecting|channel closed|failed to record rollout items|transport issue during rollout recording/.test(lower);
}

function _isTransientGatewayTransportMessage(message = '') {
  const lower = String(message || '').toLowerCase();
  if (_isReconnectOrChannelClosedMessage(lower)) return true;
  return /stream idle timeout|socket hang up/.test(lower);
}

// ── Adapter origin classification (single source of truth) ────────────
// Human-readable source labels per adapter key. Used by the model-listing
// endpoint so the UI can show whether a model is local or cloud, and where a
// cloud model comes from. Override/extend at runtime via KHY_ADAPTER_SOURCE_LABELS
// (a JSON object: { "<adapterKey>": "<label>" }).
const _DEFAULT_ADAPTER_SOURCE_LABELS = {
  // ── Local model runtimes ──
  ollama: '本地 · Ollama',
  localLLM: '本地 · llama.cpp',
  // ── Cloud structured adapters ──
  kiro: '云端 · Kiro (AWS CodeWhisperer)',
  cursor: '云端 · Cursor',
  cursor2api: '云端 · Cursor (cursor2api)',
  trae: '云端 · Trae',
  claude: '云端 · Anthropic Claude',
  codex: '云端 · OpenAI Codex',
  api: '云端 · 自定义 API',
  // ── IDE bridges ──
  windsurf: '云端 · Windsurf',
  vscode: '云端 · VS Code',
  warp: '云端 · Warp',
  relay_api: '云端 · 中转 API',
  // ── Relay / assist channels ──
  cli: '本地 · CLI 工具',
  relay: '中继 · 浏览器手动转发',
  clipboard: '中继 · 剪贴板转发',
};

function _resolveAdapterSourceLabels() {
  const labels = { ..._DEFAULT_ADAPTER_SOURCE_LABELS };
  const raw = String(process.env.KHY_ADAPTER_SOURCE_LABELS || '').trim();
  if (raw) {
    try {
      const override = JSON.parse(raw);
      if (override && typeof override === 'object') {
        for (const [k, v] of Object.entries(override)) {
          if (v != null) labels[String(k)] = String(v);
        }
      }
    } catch { /* malformed env → keep defaults */ }
  }
  return labels;
}

const _ADAPTER_SOURCE_LABELS = _resolveAdapterSourceLabels();

// Recover an HTTP status code that an upstream/transport library embedded in the
// error *message* but never surfaced as a numeric field — most notably axios's
// "Request failed with status code 504", where the returned result keeps
// statusCode:0 and the only evidence of the 504 is the text. Only matches when an
// explicit status/HTTP context word precedes the code, and only accepts 4xx/5xx,
// so a stray 3-digit number (a port, an id, "exited with code 1", a model name)
// can never be misread as a status.
function _httpStatusFromMessage(message = '') {
  const m = String(message || '').match(/(?:status(?:\s*code)?|http(?:\s*status)?)\D{0,4}(\d{3})\b/i);
  if (!m) return 0;
  const code = parseInt(m[1], 10);
  return code >= 400 && code <= 599 ? code : 0;
}

function classifyError(status, message = '') {
  const rawMessage = String(message || '');
  const lower = rawMessage.toLowerCase();
  if (/adapter\s+\S+\s+idle timeout|stream idle timeout|\bidle timeout\b/.test(lower)) return 'timeout';

  // Distinguish explicit user/abort-controller cancellation from generic "canceled":
  // many upstream CLIs use plain "canceled" for process/channel interruption.
  // We only classify as "cancelled" when message clearly indicates an abort signal.
  if (/aborterror|abort_err|\baborted\b|\brequest aborted\b|\babort(ed)? by\b|signal aborted|user[-\s]?cancel/.test(lower)) {
    return 'cancelled';
  }
  if (/\bcancelled\b|\bcanceled\b/.test(lower)) return 'process';
  if (_isReconnectOrChannelClosedMessage(lower)) return 'network';
  if (/adapter\s+\S+\s+queue timeout|queue task timeout/.test(lower)) return 'timeout';
  if (/\b(?:econnreset|econnrefused|enotfound|ehostunreach|enetunreach|eai_again)\b|fetch failed|socket hang up|getaddrinfo|network error/.test(lower)) {
    return 'network';
  }

  // Unified structured detection (errorClassifier now covers all 13 kinds)
  if (status || rawMessage) {
    const errObj = { code: status, message: rawMessage };
    const kind = detectErrorKindDeep(errObj);
    if (kind) return kind;
  }

  // Minimal residual fallback for patterns errorClassifier may miss
  if (/did not respond within|stream stalled|unresponsive/.test(lower)) return 'timeout';
  if (/adapter .* unavailable|not installed|command .* not found/.test(lower)) return 'unavailable';

  // Status-code fallback (for bare numeric status without message)
  if (status === 400) return 'bad_request';
  if (status === 408 || status === 504) return 'timeout';

  // Root-cause fix for "一次失败处处失败 / api 链接不稳定": axios & several adapters
  // return {success:false, error:"Request failed with status code 504/404", statusCode:0}
  // — the HTTP code lives ONLY in the message, so every check above misses it and we
  // fall to 'unknown'. 'unknown' then gets a long "broken channel" cooldown (20s base)
  // that the circuit breaker escalates toward 300s, and EVERY distinct upstream fault
  // (transient 504, permanent 404) collapses into the same undifferentiated bucket and
  // is cached/blocked identically — exactly the reported "one failure → everything
  // fails". When no numeric status was supplied, recover the embedded code and
  // re-classify it so a 504 reads as transient `timeout` (short 10s window) and a 404
  // as `model_not_found` (honest diagnostic). Guarded by `!status` → byte-identical
  // when a status was already provided; the recursive call passes a truthy status, so
  // it can never recurse a second time.
  if (!status) {
    const embedded = _httpStatusFromMessage(rawMessage);
    if (embedded) return classifyError(embedded, '');
  }

  return 'unknown';
}

function _sanitizeFailureMessage(message, maxLen = 220) {
  const text = String(fmtError(message || '') || message || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'unknown error';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function _normalizeAdapterSig(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'adapter';
  if (s === 'localllm' || s === 'local llm' || s.includes('local (') || s.includes('本地模型')) return 'localllm';
  if (s === 'codex' || s.includes('openai codex')) return 'codex';
  if (s === 'claude' || s.includes('anthropic')) return 'claude';
  if (s === 'ollama' || s.includes('ollama')) return 'ollama';
  if (s === 'api' || s.includes('multifree')) return 'api';
  if (s === 'relay' || s.includes('relay')) return 'relay';
  return s;
}

function _buildFailureReasonSection(attempts = [], maxLines = 8) {
  if (!Array.isArray(attempts) || attempts.length === 0) return '';
  const failedRaw = attempts.filter(a => a && a.success === false);
  if (failedRaw.length === 0) return '';
  // 让本轮新鲜 live 失败(真实 statusCode、非 virtualSkip)排在陈旧缓存跳过之前,避免
  // 238s 前缓存的 404 盖过本轮真实的 429(门控 KHY_FAILURE_REASON_RANKING,关则原序回退)。
  let failed = failedRaw;
  try {
    failed = require('./failureReasonRanking').rankFailedAttempts(failedRaw);
  } catch { /* fail-soft:排序不可用则用原插入序 */ }

  const lines = [];
  const seen = new Set();
  let uniqueFailedCount = 0;
  for (const attempt of failed) {
    const adapter = String(attempt.adapterKey || attempt.provider || 'adapter').trim() || 'adapter';
    const adapterSig = _normalizeAdapterSig(attempt.adapterKey || attempt.provider || 'adapter');
    const statusCode = attempt.statusCode || attempt.status || attempt.code;
    const statusNum = Number(statusCode);
    const status = Number.isFinite(statusNum) && statusNum > 0 ? ` (${statusNum})` : '';
    const errType = String(attempt.errorType || classifyError(statusCode, attempt.error || '') || '').trim();
    const errTypeSig = errType.toLowerCase();
    const kind = errType ? ` [${errType}]` : '';
    const err = _sanitizeFailureMessage(attempt.error || attempt.message || 'unknown error');
    const sig = `${adapterSig}|${Number.isFinite(statusNum) ? statusNum : 0}|${errTypeSig}|${err}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    uniqueFailedCount += 1;
    if (lines.length < Math.max(1, maxLines)) {
      let line = `- ${adapter}${status}${kind}: ${err}`;
      // model_not_found 显示纠偏(modelExistenceEvidence):有证据表明模型已送达上游(参数/token 类
      // 报错、或送出串为复合 id)时追加注解,消解「刚嫌 token 太大、转头又说找不到模型」的矛盾。
      // 只改显示不改分类;门关 / 无证据 → 逐字节回退原行。绝不抛。
      if (errTypeSig === 'model_not_found') {
        try {
          line = require('./modelExistenceEvidence').annotateModelNotFoundLine({
            line,
            errorType: errType,
            message: attempt.error || attempt.message || '',
            model: attempt.model,
            attempts: failed,
            env: process.env,
          });
        } catch { /* 叶子不可用 → 今日行 */ }
      }
      lines.push(line);
    }
  }

  if (lines.length === 0) return '';
  if (uniqueFailedCount > lines.length) {
    lines.push(`- ... 还有 ${uniqueFailedCount - lines.length} 条失败记录`);
  }
  return `真实失败原因:\n${lines.join('\n')}`;
}

function _prependFailureReason(baseContent, attempts, maxLines = 8) {
  const reason = _buildFailureReasonSection(attempts, maxLines);
  const body = String(baseContent || '').trim();
  if (!reason) return body;
  if (/真实失败原因/.test(body)) return body;
  return body ? `${reason}\n\n${body}` : reason;
}

function _shouldUseFastFail(errorType = '') {
  const t = String(errorType || '').toLowerCase();
  return t === 'auth' || t === 'permission' || t === 'unavailable' || t === 'process';
}

// Transient errors (rate_limit, overloaded, timeout, network) get a shorter
// cooldown so we skip the adapter briefly rather than retrying immediately,
// but don't hold it off as long as permanent errors (auth/unavailable).
//
// `unknown` and `model_not_found` are added here deliberately: previously they
// were excluded from BOTH _shouldUseFastFail and this map, so _getRecentFastFail
// returned null for the first 2 failures — the cascade re-selected the same dead
// adapter (e.g. a relay 404 → model_not_found, or an unclassified IDE error) on
// every pass and burned the global retry budget to "总尝试次数超限" before the
// circuit breaker's 3rd-failure threshold. A short skip window lets the cascade
// move to a healthy adapter immediately; the cooldown self-heal ticker probes
// and releases the adapter early if it recovers, so a one-off blip is cheap.
//
// `empty` is DELIBERATELY ABSENT from this map (and from _shouldUseFastFail).
// An empty HTTP-200 reply means the channel is healthy but the model produced no
// text — a model-behavior blip (common for weak models right after a tool call),
// not a degraded channel. Giving it a cross-request cooldown is exactly the
// reported incoherence: a user asking "summarize my desktop" got one empty reply,
// the channel was cooled for 20s, and every re-ask within that window fast-failed
// with "recent unknown failure cached: Empty response (cooldown 16s)" — forcing
// 5-6 re-asks. With no cooldown, the re-ask goes straight back to the same healthy
// channel. Bounded same-request retry / forced-summary / salvage of already-fetched
// tool data is owned by the tool loop, so a one-off empty never reaches the user.
const _TRANSIENT_COOLDOWN_MS = {
  rate_limit: _parseMs(process.env.GATEWAY_RATE_LIMIT_COOLDOWN_MS, 20000, 5000),
  overloaded: _parseMs(process.env.GATEWAY_OVERLOADED_COOLDOWN_MS, 15000, 5000),
  timeout:    _parseMs(process.env.GATEWAY_TIMEOUT_COOLDOWN_MS, 10000, 3000),
  network:    _parseMs(process.env.GATEWAY_NETWORK_COOLDOWN_MS, 12000, 3000),
  unknown:    _parseMs(process.env.GATEWAY_UNKNOWN_COOLDOWN_MS, 20000, 5000),
  model_not_found: _parseMs(process.env.GATEWAY_MODEL_NOT_FOUND_COOLDOWN_MS, 30000, 5000),
};
function _transientCooldownMs(errorType = '') {
  return _TRANSIENT_COOLDOWN_MS[String(errorType || '').toLowerCase()] || 0;
}

function _parseMs(raw, fallback, min = 0) {
  const parsed = parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, parsed);
}

function _parsePositiveInt(raw, fallback, min = 1, max = 16) {
  const parsed = parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

function _parseNonNegativeInt(raw, fallback, max = 16) {
  const parsed = parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, parsed);
}

// Parse a fractional ratio in [min, max] (default [0,1]) for error-rate
// thresholds. Out-of-range or non-numeric values fall back to the default so a
// bad env value can never disable the circuit breaker silently.
function _parseFloat01(raw, fallback, min = 0, max = 1) {
  const parsed = parseFloat(String(raw ?? fallback));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function _isRetryableResultErrorType(errorType = '') {
  return _ecIsRetryable(String(errorType || '').trim().toLowerCase());
}

const KHY_PROTOCOL_PRIORITY_BLOCK = [
  '# KHY Protocol Priority',
  'The KHY protocol and project instructions have the highest priority within this gateway request.',
  'If KHY project instructions define language behavior, they override lower-priority compat files such as CLAUDE.md and AGENTS.md.',
  'Default to Chinese for user-facing replies unless the user explicitly requests another language.',
].join('\n');
const CODEX_GENERATION_PROBE_PROMPT = '只用一句中文回复：已收到，不要调用工具。';

function _injectKhyProtocolSystem(system = '') {
  const inherited = String(system || '').trim();
  if (!inherited) return KHY_PROTOCOL_PRIORITY_BLOCK;
  if (inherited.includes('# KHY Protocol Priority')) return inherited;
  return `${KHY_PROTOCOL_PRIORITY_BLOCK}\n\n${inherited}`;
}

const KHY_EXPECTED_CHINESE_LANGUAGE_BLOCK = [
  '# Language',
  'KHY expected output: Simplified Chinese.',
  'Reply to the user in Simplified Chinese.',
  'The first visible sentence must be in Simplified Chinese.',
  'Do not begin with English.',
].join('\n');

function _injectKhyExpectedLanguageSystem(system = '', promptText = '', requestOptions = {}, entryKey = '') {
  const inherited = String(system || '').trim();
  const normalizedEntryKey = String(entryKey || '').trim().toLowerCase();
  if (normalizedEntryKey !== 'codex') return inherited;
  if (_requestsExplicitEnglishOutput(promptText, requestOptions)) return inherited;
  if (!_requestsChineseOutput(promptText, requestOptions)) return inherited;
  if (_resolveExpectedKhyLanguage(promptText, requestOptions) !== 'zh') return inherited;
  if (inherited.includes('KHY expected output: Simplified Chinese.')) return inherited;
  if (!inherited) return KHY_EXPECTED_CHINESE_LANGUAGE_BLOCK;
  return `${KHY_EXPECTED_CHINESE_LANGUAGE_BLOCK}\n\n${inherited}`;
}

function _injectKhyProtocolPrompt(prompt = '', options = {}) {
  const raw = String(prompt || '');
  const system = String(options.system || '').trim();
  if (!system) return raw;
  if (/^\[KHY PRIORITY DIRECTIVE\]/.test(raw)) return raw;

  const prefix = [
    '[KHY PRIORITY DIRECTIVE]',
    '- KHY protocol instructions are the highest-priority rules for this request.',
    '- If KHY project instructions define language behavior, they override lower-priority compat files.',
    '- Default to Chinese for user-facing replies unless the user explicitly requests another language.',
    '',
  ].join('\n');
  return `${prefix}${raw}`;
}

function _buildKhyProtocolDebugSummary(prompt = '', options = {}) {
  const system = String(options.system || '').trim();
  const promptText = String(prompt || '');
  let promptCapsules = [];
  let capsuleMode = 'unknown';
  let capsuleReasons = [];
  try {
    const { getOnDemandPromptSectionDecision } = require('../../constants/prompts');
    const enabledTools = Array.isArray(options.tools)
      ? options.tools.map(tool => String(tool?.name || '')).filter(Boolean)
      : [];
    const decision = getOnDemandPromptSectionDecision({
      userMessage: options.userMessage,
      taskScale: options.taskScale,
      enabledTools,
      promptFeatures: options.promptFeatures,
      forceAllPromptSections: options.forceAllPromptSections,
    });
    promptCapsules = Array.isArray(decision?.ids) ? decision.ids : [];
    capsuleMode = String(decision?.mode || 'unknown');
    capsuleReasons = Array.isArray(decision?.reasons) ? decision.reasons : [];
  } catch { /* best effort */ }
  return {
    hasSystem: !!system,
    systemLength: system.length,
    promptLength: promptText.length,
    systemPreview: system ? _sanitizeFailureMessage(system, 220) : '',
    promptPreview: promptText ? _sanitizeFailureMessage(promptText, 220) : '',
    capsuleMode,
    promptCapsules,
    capsuleReasons,
  };
}

function _extractTextFromMessageContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        if (typeof item.text === 'string') return item.text;
        if (typeof item.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return '';
}

function _collectLanguageDirectiveTexts(promptText = '', requestOptions = {}) {
  const parts = [];
  if (typeof requestOptions.userMessage === 'string') {
    parts.push(requestOptions.userMessage);
  }
  if (Array.isArray(requestOptions.messages)) {
    for (const message of requestOptions.messages) {
      if (!message) continue;
      const role = String(message.role || '').trim().toLowerCase();
      if (role && role !== 'user') continue;
      const text = _extractTextFromMessageContent(message.content ?? message.text ?? message.message ?? '');
      if (text) parts.push(text);
    }
  }
  if (typeof promptText === 'string' && promptText.trim()) {
    parts.push(promptText);
  }
  return parts.filter(Boolean);
}

function _requestsExplicitEnglishOutput(promptText = '', requestOptions = {}) {
  const texts = _collectLanguageDirectiveTexts(promptText, requestOptions);
  if (texts.length === 0) return false;
  const combined = texts.join('\n').toLowerCase();
  const envLang = String(requestOptions.khyLanguage || process.env.KHY_LANGUAGE || '').trim().toLowerCase();
  if (['english', 'en'].includes(envLang)) return true;
  return /(?:reply|respond|answer|write|speak|continue|communicate)(?:\s+only|\s+entirely)?\s+in english\b|english only|use english|please use english|in english please|请用英文|请用英语|用英文回复|用英语回复|英文回答|英语回答|请讲英文|请讲英语/.test(combined);
}

function _requestsChineseOutput(promptText = '', requestOptions = {}) {
  const texts = _collectLanguageDirectiveTexts(promptText, requestOptions);
  if (texts.length === 0) return false;
  const combined = texts.join('\n');
  const lowered = combined.toLowerCase();
  const envLang = String(requestOptions.khyLanguage || process.env.KHY_LANGUAGE || '').trim().toLowerCase();
  if (['chinese', 'zh', 'zh-cn', 'zh_cn', 'cn'].includes(envLang)) return true;
  if (/请用中文|请用简体中文|用中文回复|用中文回答|中文回复|中文回答|中文输出|请讲中文|请继续用中文/.test(combined)) {
    return true;
  }
  if (/(?:reply|respond|answer|write|speak|continue|communicate)(?:\s+only|\s+entirely)?\s+in (?:simplified\s+)?chinese\b|chinese only|use chinese|please use chinese|in chinese please/.test(lowered)) {
    return true;
  }
  return _looksLikeChineseScript(combined);
}

function _resolveExpectedKhyLanguage(promptText = '', requestOptions = {}) {
  const envLang = String(requestOptions.khyLanguage || process.env.KHY_LANGUAGE || '').trim().toLowerCase();
  if (['english', 'en'].includes(envLang)) return 'en';
  if (['chinese', 'zh', 'zh-cn', 'zh_cn', 'cn'].includes(envLang)) return 'zh';
  if (_requestsExplicitEnglishOutput(promptText, requestOptions)) return 'en';
  if (_requestsChineseOutput(promptText, requestOptions)) return 'zh';
  return 'zh';
}

function _injectKhyChineseRecoverySystem(system = '') {
  const recoveryBlock = [
    '# KHY Language Recovery',
    'Previous attempt started in English and violated the Chinese reply requirement.',
    'Retry in Simplified Chinese for all user-facing text.',
    'Do not begin the answer in English.',
    'All visible headings, bullets, and summaries must remain in Simplified Chinese.',
    'English is only allowed inside code, file paths, logs, or quoted identifiers.',
  ].join('\n');
  const inherited = String(system || '').trim();
  if (!inherited) return recoveryBlock;
  if (inherited.includes('# KHY Language Recovery')) return inherited;
  return `${recoveryBlock}\n\n${inherited}`;
}

function _injectKhyChineseRecoveryPrompt(prompt = '') {
  const raw = String(prompt || '');
  if (/^\[KHY LANGUAGE RECOVERY\]/.test(raw)) return raw;
  const prefix = [
    '[KHY LANGUAGE RECOVERY]',
    '- The previous attempt started in English and violated the Chinese reply requirement.',
    '- Retry this answer in Simplified Chinese.',
    '- Do not begin with English.',
    '- Keep all visible headings, bullets, and summaries in Simplified Chinese.',
    '- If English identifiers are necessary, keep only the identifiers in English and explain them in Chinese.',
    '',
  ].join('\n');
  return `${prefix}${raw}`;
}

function _buildLanguageMismatchFailureMessage(languageConsistency = null) {
  const detected = String(languageConsistency?.detectedLanguage || 'unknown').trim() || 'unknown';
  const expected = String(languageConsistency?.expectedLanguage || 'zh').trim() || 'zh';
  const sample = String(languageConsistency?.textSample || '').trim();
  return sample
    ? `首段语言偏航（检测=${detected}，期望=${expected}，sample=${sample}）`
    : `首段语言偏航（检测=${detected}，期望=${expected}）`;
}

function _shouldAutoRecoverCodexChineseMismatch(entryKey = '', languageConsistency = null, promptText = '', requestOptions = {}, recoveryState = {}) {
  if (String(entryKey || '').trim().toLowerCase() !== 'codex') return false;
  if (!languageConsistency || languageConsistency.matchesExpectation !== false) return false;
  if (String(languageConsistency.expectedLanguage || 'zh').trim().toLowerCase() !== 'zh') return false;
  if (String(languageConsistency.detectedLanguage || '').trim().toLowerCase() !== 'en') return false;
  if (String(languageConsistency.source || '').trim().toLowerCase() === 'first_chunk' && !requestOptions._khyVisibleUserStream) {
    return false;
  }
  if ((Number(recoveryState?.retriesUsed || 0) >= Number(recoveryState?.maxRetries || 0))) return false;
  if (_requestsExplicitEnglishOutput(promptText, requestOptions)) return false;
  if (!_requestsChineseOutput(promptText, requestOptions)) return false;
  return true;
}

function _resolveCodexChineseRecoveryRetryBudget(entryKey = '', promptText = '', requestOptions = {}) {
  if (String(entryKey || '').trim().toLowerCase() !== 'codex') return 0;
  if (_requestsExplicitEnglishOutput(promptText, requestOptions)) return 0;
  if (!_requestsChineseOutput(promptText, requestOptions)) return 0;
  if (_resolveExpectedKhyLanguage(promptText, requestOptions) !== 'zh') return 0;
  return _parseNonNegativeInt(
    requestOptions.codexLanguageRecoveryRetries ?? process.env.KHY_CODEX_LANGUAGE_RECOVERY_RETRIES ?? 1,
    1,
    2
  );
}

function _createCodexChineseChunkGate(entryKey = '', adapterDisplayName = '', promptText = '', requestOptions = {}, attemptAbort = null, emitStatus = () => {}) {
  if (String(entryKey || '').trim().toLowerCase() !== 'codex') return null;
  if (_requestsExplicitEnglishOutput(promptText, requestOptions)) return null;
  if (!_requestsChineseOutput(promptText, requestOptions)) return null;

  const expectedLanguage = _resolveExpectedKhyLanguage(promptText, requestOptions);
  let firstDecisiveVisibleChecked = false;
  let mismatchInfo = null;

  return {
    get mismatchInfo() {
      return mismatchInfo;
    },
    handleChunk(chunk) {
      const normalized = _normalizeVisibleChunkText(chunk);
      if (!normalized) return { forward: true };
      if (firstDecisiveVisibleChecked) return { forward: true };

      const assessment = _classifyKhyLanguageExpectation(normalized, expectedLanguage);
      if (assessment.language === 'unknown') {
        return { forward: true };
      }
      firstDecisiveVisibleChecked = true;
      if (assessment.matchesExpectation) {
        return { forward: true };
      }

      mismatchInfo = {
        adapter: 'codex',
        adapterName: adapterDisplayName || 'codex',
        riskyAdapter: true,
        source: 'first_chunk',
        textSample: assessment.sample,
        summary: assessment.summary,
        detectedLanguage: assessment.language,
        expectedLanguage: assessment.expectedLanguage,
        matchesExpectation: false,
      };
      emitStatus(`${adapterDisplayName || 'codex'} 首段语言纠偏：检测=${assessment.language}，期望=${assessment.expectedLanguage}，正在中断当前输出并准备重试`);
      try {
        attemptAbort?.abort(`language mismatch first_chunk (${assessment.language}->${assessment.expectedLanguage})`);
      } catch { /* best effort */ }
      return { forward: false };
    },
  };
}

const KHY_LANGUAGE_RISKY_ADAPTERS = new Set(
  String(process.env.KHY_LANGUAGE_RISKY_ADAPTERS || 'codex,claude,cursor,cursor2api,trae,windsurf,vscode,warp,relay_api,relay,cli,kiro')
    .split(',')
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
);

function _normalizeLanguageAdapterKey(adapterLike = null) {
  if (!adapterLike) return '';
  if (typeof adapterLike === 'string') return String(adapterLike).trim().toLowerCase();
  return String(adapterLike.key || adapterLike.type || adapterLike.adapter || adapterLike.name || '')
    .trim()
    .toLowerCase();
}

function _isKhyLanguageRiskyAdapter(adapterLike = null) {
  const key = _normalizeLanguageAdapterKey(adapterLike);
  if (!key) return false;
  return KHY_LANGUAGE_RISKY_ADAPTERS.has(key);
}

function _looksLikeChineseScript(text = '') {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(text || ''));
}

function _looksLikeEnglishScript(text = '') {
  const normalized = String(text || '').replace(/[`~!@#$%^&*()_\-+=[\]{};:'",.<>/?\\|0-9]/g, ' ');
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  const asciiWordCount = tokens.filter((token) => /^[A-Za-z][A-Za-z'-]*$/.test(token)).length;
  return asciiWordCount >= 3 || (asciiWordCount >= 1 && tokens.length === asciiWordCount);
}

function _normalizeVisibleChunkText(chunk = null) {
  if (!chunk) return '';
  const type = String(chunk.type || '').trim().toLowerCase();
  if (type && type !== 'text' && type !== 'message' && type !== 'content' && type !== 'delta') return '';
  const text = String(chunk.text || chunk.content || chunk.delta || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text;
}

function _classifyKhyLanguageExpectation(text = '', expectedLanguage = 'zh') {
  const normalizedExpectedLanguage = String(expectedLanguage || 'zh').trim().toLowerCase() === 'en' ? 'en' : 'zh';
  const sample = String(text || '').replace(/\s+/g, ' ').trim();
  if (!sample) {
    return {
      language: 'unknown',
      matchesExpectation: true,
      expectedLanguage: normalizedExpectedLanguage,
      summary: '尚未检测到可见正文',
      sample: '',
    };
  }

  const hasChinese = _looksLikeChineseScript(sample);
  const looksEnglish = _looksLikeEnglishScript(sample);
  let language = 'unknown';
  if (hasChinese) language = 'zh';
  else if (looksEnglish) language = 'en';

  const expectsEnglish = normalizedExpectedLanguage === 'en';
  const matchesExpectation = expectsEnglish ? language !== 'zh' : language !== 'en';
  const summary = expectsEnglish
    ? (matchesExpectation
      ? (language === 'en' ? '首段正文符合 KHY 英文预期' : '首段正文未判定为中文，暂不视为偏航')
      : '首段正文疑似中文，偏离 KHY 英文预期')
    : (matchesExpectation
      ? (language === 'zh' ? '首段正文符合 KHY 中文预期' : '首段正文未判定为英文，暂不视为偏航')
      : '首段正文疑似英文，偏离 KHY 中文预期');
  return {
    language,
    matchesExpectation,
    expectedLanguage: normalizedExpectedLanguage,
    summary,
    sample: _sanitizeFailureMessage(sample, 160),
  };
}

function _createKhyLanguageConsistencyTracker(entry, requestOptions = {}, promptText = '') {
  const adapterKey = _normalizeLanguageAdapterKey(entry);
  const adapterName = (() => {
    try {
      return entry?.adapter?.getStatus?.().name || entry?.name || adapterKey || 'unknown';
    } catch {
      return entry?.name || adapterKey || 'unknown';
    }
  })();
  const requestId = String(requestOptions.requestId || requestOptions._diagTraceId || '').trim();
  const traceId = String(requestOptions._diagTraceId || '').trim();
  const sessionId = String(requestOptions.sessionId || '').trim() || null;
  const riskyAdapter = _isKhyLanguageRiskyAdapter(adapterKey);
  const expectedLanguage = _resolveExpectedKhyLanguage(promptText, requestOptions);
  let firstVisibleText = '';
  let firstVisibleLogged = false;
  let firstDecisiveText = '';
  let firstDecisiveAssessment = null;
  let finalVisibleLogged = false;

  const _logLanguageEvent = (phase, visibleText = '', assessmentOverride = null) => {
    const normalized = String(visibleText || '').replace(/\s+/g, ' ').trim();
    if (!normalized || !_traceAudit || !riskyAdapter) return;
    const assessment = assessmentOverride || _classifyKhyLanguageExpectation(normalized, expectedLanguage);
    try {
      _traceAudit.logEvent(`agent.language.${phase}`, {
        requestId,
        adapter: adapterKey,
        adapterName,
        expectedLanguage: assessment.expectedLanguage,
        detectedLanguage: assessment.language,
        matchesExpectation: assessment.matchesExpectation,
        riskyAdapter,
        promptPreview: _sanitizeFailureMessage(promptText, 120),
        textSample: assessment.sample,
        summary: assessment.summary,
      }, {
        sessionId,
        traceId: traceId || null,
        requestId: requestId || null,
        source: 'ai-gateway',
        visibility: 'internal',
      });
    } catch { /* best effort */ }
  };

  return {
    captureChunk(chunk) {
      const normalized = _normalizeVisibleChunkText(chunk);
      if (!normalized) return;
      if (!firstVisibleText) firstVisibleText = normalized;
      const assessment = _classifyKhyLanguageExpectation(normalized, expectedLanguage);
      if (assessment.language === 'unknown') return;
      if (!firstDecisiveText) {
        firstDecisiveText = normalized;
        firstDecisiveAssessment = assessment;
      }
      if (!firstVisibleLogged) {
        firstVisibleLogged = true;
        _logLanguageEvent('first_chunk', normalized, assessment);
      }
    },
    finalize(result = null) {
      const finalText = String(result?.content || '').replace(/\s+/g, ' ').trim();
      const visibleText = firstDecisiveText || finalText || firstVisibleText;
      if (!visibleText) return null;
      if (!finalVisibleLogged) {
        finalVisibleLogged = true;
        _logLanguageEvent('final_response', visibleText);
      }
      const assessment = firstDecisiveText && visibleText === firstDecisiveText && firstDecisiveAssessment
        ? firstDecisiveAssessment
        : _classifyKhyLanguageExpectation(visibleText, expectedLanguage);
      return {
        adapter: adapterKey,
        adapterName,
        riskyAdapter,
        source: firstDecisiveText ? 'first_chunk' : (finalText ? 'final_response' : 'first_chunk'),
        textSample: assessment.sample,
        summary: assessment.summary,
        expectedLanguage: assessment.expectedLanguage,
        detectedLanguage: assessment.language,
        matchesExpectation: assessment.matchesExpectation,
      };
    },
  };
}

function _appendKhyProtocolDebugLog(entry, prompt = '', options = {}, summary = null) {
  const targetFile = String(process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE || '').trim();
  if (!targetFile) return;

  const info = summary || _buildKhyProtocolDebugSummary(prompt, options);
  const adapterKey = String(entry?.key || '').trim() || 'unknown';
  let providerName = adapterKey;
  try {
    providerName = entry?.adapter?.getStatus?.().name || adapterKey;
  } catch { /* best effort */ }

  const normalizedProvider = String(providerName || adapterKey)
    .replace(/\r?\n+/g, ' ')
    .trim() || adapterKey;
  const lines = [
    `[${new Date().toISOString()}] adapter=${adapterKey} provider="${normalizedProvider}"`,
    `has_system=${info.hasSystem ? '1' : '0'} system_length=${info.systemLength} prompt_length=${info.promptLength}`,
    `capsule_mode=${info.capsuleMode || 'unknown'} prompt_capsules="${Array.isArray(info.promptCapsules) && info.promptCapsules.length > 0 ? info.promptCapsules.join(',') : '-'}" capsule_reasons="${Array.isArray(info.capsuleReasons) && info.capsuleReasons.length > 0 ? info.capsuleReasons.join(',') : '-'}"`,
    `system_preview=${info.systemPreview || '(empty)'}`,
    `prompt_preview=${info.promptPreview || '(empty)'}`,
    '',
  ];

  try {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.appendFileSync(targetFile, `${lines.join('\n')}\n`, 'utf8');
  } catch { /* best effort */ }
}

// Adapters that may override the system prompt downstream (their own upstream
// re-injects/replaces it). Hoisted to a module constant (Ch2「不要每轮重建可复用
// 结构」): _rankAdaptersForDefaultRoute maps the risk probe over ALL adapters on
// every round-trip, so rebuilding this 11-element literal Set per call meant ~16
// throwaway allocations per request. The set is a compile-time constant; the sole
// consumer uses it read-only for a single .has() membership test.
const _PROMPT_OVERRIDE_ADAPTERS = new Set([
  'codex',
  'claude',
  'cursor',
  'trae',
  'windsurf',
  'vscode',
  'warp',
  'cursor2api',
  'relay',
  'clipboard',
  'cli',
]);

function _adapterMayOverridePromptDownstream(adapterKey = '') {
  const key = String(adapterKey || '').trim().toLowerCase();
  return _PROMPT_OVERRIDE_ADAPTERS.has(key);
}

function _getKhyProtocolPriorityRisk(adapterLike = null) {
  const adapterKey = String(
    typeof adapterLike === 'string'
      ? adapterLike
      : (adapterLike?.type || adapterLike?.adapter || adapterLike?.key || '')
  ).trim().toLowerCase();
  const adapterName = String(
    typeof adapterLike === 'string'
      ? adapterLike
      : (adapterLike?.name || adapterLike?.adapterName || adapterLike?.provider || adapterLike?.type || adapterLike?.key || '')
  ).trim();

  if (!adapterKey && !adapterName) {
    return {
      adapterKey: '',
      adapterName: '',
      risky: false,
      level: 'info',
      reason: 'no_active_adapter',
      summary: '当前无激活通道，待请求时仍会由 KHY 网关注入最高优先级协议',
      detail: '当前无激活通道，待请求时仍会由 KHY 网关注入最高优先级协议',
      recommendation: '',
    };
  }

  const displayName = adapterName || adapterKey || 'unknown';
  const risky = _adapterMayOverridePromptDownstream(adapterKey);
  if (!risky) {
    return {
      adapterKey,
      adapterName: displayName,
      risky: false,
      level: 'info',
      reason: 'gateway_enforced',
      summary: `${displayName} 已由 KHY 网关注入最高优先级协议`,
      detail: `${displayName} 已由 KHY 网关注入最高优先级协议，当前未发现上游覆盖风险`,
      recommendation: '',
    };
  }

  return {
    adapterKey,
    adapterName: displayName,
    risky: true,
    level: 'warn',
    reason: 'upstream_hidden_system_prompt',
    summary: `${displayName} 可能在 KHY 之后仍追加上游隐藏 system prompt`,
    detail: `${displayName} 可能在 KHY 之后仍追加上游隐藏 system prompt；如出现语言不一致，建议开启 KHY_GATEWAY_DEBUG_PROMPT=1，必要时设置 KHY_GATEWAY_DEBUG_PROMPT_FILE，并优先切换到 api / relay_api / ollama / localLLM 复核`,
    recommendation: '开启 KHY_GATEWAY_DEBUG_PROMPT=1；如需落盘，设置 KHY_GATEWAY_DEBUG_PROMPT_FILE；必要时切换到 api / relay_api / ollama / localLLM 复核',
  };
}

const PROCESS_SENSITIVE_ADAPTER_KEYS = new Set([
  'cli',
  'codex',
  'claude',
  'kiro',
  'cursor',
  'trae',
  'windsurf',
  'vscode',
  'warp',
  'cursor2api',
]);

const DEFAULT_PROCESS_FAILOVER_CANDIDATES = ['relay_api', 'api', 'relay', 'ollama'];
const DEFAULT_API_POOL_PROVIDER_ALIASES = Object.freeze({
  openai: 'openai',
  gpt: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  trae: 'trae',
  deepseek: 'deepseek',
  qwen: 'qwen',
  alibaba: 'qwen',
  dashscope: 'qwen',
  glm: 'glm',
  zhipu: 'glm',
  doubao: 'doubao',
  wenxin: 'wenxin',
  baidu: 'wenxin',
  relay: 'relay',
});
const DEFAULT_API_POOL_TO_SERVICE_PROVIDER = Object.freeze({
  openai: 'openai',
  anthropic: 'anthropic',
  trae: 'trae',
  deepseek: 'openai',
  qwen: 'alibaba',
  glm: 'zhipu',
  doubao: 'openai',
  wenxin: 'baidu',
  relay: 'openai',
});
const DEFAULT_API_POOL_DEFAULT_MODEL_MAP = Object.freeze({
  deepseek: 'deepseek-chat',
  doubao: 'doubao-pro-32k',
  qwen: 'qwen-plus',
  glm: 'glm-4-plus',
  wenxin: 'ERNIE-Bot',
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  trae: 'gpt-4o',
  relay: 'gpt-4o-mini',
});

const DEFAULT_ROUTE_BASE_PRIORITY = Object.freeze({
  api: 0,
  relay_api: 1,
  kiro: 2,
  cursor: 3,
  trae: 4,
  claude: 5,
  codex: 6,
  windsurf: 7,
  vscode: 8,
  warp: 9,
  cursor2api: 10,
  ollama: 11,
  localllm: 12,
  cli: 13,
  relay: 14,
  clipboard: 15,
});

const DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS = new Set(['relay', 'clipboard']);

function _formatRouteAgeMs(ageMs = 0) {
  const safeAgeMs = Math.max(0, Number(ageMs || 0));
  const totalSeconds = Math.max(1, Math.round(safeAgeMs / 1000));
  if (totalSeconds >= 3600) return `${Math.round(totalSeconds / 3600)}h`;
  if (totalSeconds >= 60) return `${Math.round(totalSeconds / 60)}m`;
  return `${totalSeconds}s`;
}

function _resolveDefaultRouteTuning() {
  return {
    codexCliPenalty: _parseMs(process.env.GATEWAY_DEFAULT_ROUTE_CODEX_CLI_PENALTY || '45', 45, 5),
    recentFailurePenalty: _parseMs(process.env.GATEWAY_DEFAULT_ROUTE_RECENT_FAILURE_PENALTY || '70', 70, 10),
    stallPenalty: _parseMs(process.env.GATEWAY_DEFAULT_ROUTE_STALL_PENALTY || '120', 120, 20),
    transportPenalty: _parseMs(process.env.GATEWAY_DEFAULT_ROUTE_TRANSPORT_PENALTY || '70', 70, 10),
    recoveryPenalty: _parseMs(process.env.GATEWAY_DEFAULT_ROUTE_RECOVERY_PENALTY || '20', 20, 5),
    protocolRiskPenalty: _parseMs(process.env.GATEWAY_DEFAULT_ROUTE_PROTOCOL_RISK_PENALTY || '15', 15, 0),
    // Honors an explicit 0 (disable) — unlike _parseMs which coerces 0 to the
    // default. Any non-negative integer is accepted; invalid input → default 30.
    cacheGougingPenalty: (() => {
      const v = parseInt(String(process.env.GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY ?? '30'), 10);
      return Number.isFinite(v) && v >= 0 ? v : 30;
    })(),
    stallWindowMs: _parseMs(process.env.GATEWAY_DEFAULT_ROUTE_STALL_WINDOW_MS || '1800000', 1800000, 60000),
    transportWindowMs: _parseMs(process.env.GATEWAY_DEFAULT_ROUTE_TRANSPORT_WINDOW_MS || '900000', 900000, 30000),
    recoveryQuietMs: _parseMs(process.env.GATEWAY_DEFAULT_ROUTE_RECOVERY_QUIET_MS || '300000', 300000, 30000),
    healthyPenaltyCeiling: _parseMs(process.env.GATEWAY_DEFAULT_ROUTE_HEALTHY_PENALTY_CEILING || '40', 40, 0),
    summaryPenaltyFloor: _parseMs(process.env.GATEWAY_DEFAULT_ROUTE_SUMMARY_PENALTY_FLOOR || '25', 25, 0),
  };
}

const _parseJsonMap = require('../../utils/parseJsonObjectMap');

function _getApiPoolAliasMap() {
  const extra = _parseJsonMap(process.env.GATEWAY_API_POOL_PROVIDER_ALIAS_MAP || '');
  const merged = { ...DEFAULT_API_POOL_PROVIDER_ALIASES };
  for (const [k, v] of Object.entries(extra)) {
    const key = String(k || '').trim().toLowerCase();
    const value = String(v || '').trim().toLowerCase();
    if (!key || !value) continue;
    merged[key] = value;
  }
  return merged;
}

function _getApiPoolToServiceMap() {
  const extra = _parseJsonMap(process.env.GATEWAY_API_POOL_SERVICE_MAP || '');
  const merged = { ...DEFAULT_API_POOL_TO_SERVICE_PROVIDER };
  for (const [k, v] of Object.entries(extra)) {
    const key = String(k || '').trim().toLowerCase();
    const value = String(v || '').trim().toLowerCase();
    if (!key || !value) continue;
    merged[key] = value;
  }
  return merged;
}

function _getApiPoolDefaultModelMap() {
  const extra = _parseJsonMap(process.env.GATEWAY_API_POOL_DEFAULT_MODEL_MAP || '');
  const merged = { ...DEFAULT_API_POOL_DEFAULT_MODEL_MAP };
  for (const [k, v] of Object.entries(extra)) {
    const key = String(k || '').trim().toLowerCase();
    const value = String(v || '').trim();
    if (!key || !value) continue;
    merged[key] = value;
  }
  return merged;
}

function _normalizeApiPoolProvider(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (!normalized) return null;
  const aliases = _getApiPoolAliasMap();
  return aliases[normalized] || normalized;
}

function _resolveApiPoolProviderForRequest(options = {}) {
  const explicitPool = _normalizeApiPoolProvider(options.apiPoolProvider);
  if (explicitPool) return explicitPool;

  const explicitProvider = _normalizeApiPoolProvider(options.provider);
  if (explicitProvider) return explicitProvider;

  const model = String(options.model || '').trim();
  const scoped = model.match(/^([a-z0-9_-]+)[:/](.+)$/i);
  if (scoped) {
    const fromModel = _normalizeApiPoolProvider(scoped[1]);
    if (fromModel) return fromModel;
  }

  // ── 通配兜底守卫(wildcardPoolGuard,门控 KHY_WILDCARD_POOL_GUARD 默认开)──
  // 走到这里 = 显式 apiPoolProvider / provider / scoped 前缀全落空,只剩盲通配
  // GATEWAY_API_POOL_PROVIDER。若裸模型厂商是已登记 preset 却无运行时池、且≠通配池,盲落必打
  // 错端点(实测 agnes-2.0-flash → open.bigmodel.cn → 400 code 1211)。此时返回 null:该 `api`
  // 通道不认领请求,转清晰失败(登记/pool:model 指引)。显式/scoped 命中的路由在上方已返回,永不
  // 到此;门关/异常 → 逐字节回退到原样盲落(今日行为)。
  const wildcard = _normalizeApiPoolProvider(process.env.GATEWAY_API_POOL_PROVIDER || '');
  if (wildcard && model) {
    try {
      const guard = require('./wildcardPoolGuard');
      if (guard.isEnabled(process.env)) {
        const presets = require('./providerPresets').getProviderPresets();
        const knownPresetIds = Array.isArray(presets) ? presets.map(p => p && p.id).filter(Boolean) : [];
        let registeredPools = [];
        try { registeredPools = require('../apiKeyPool').getProviders(); } catch { /* pool 不可用 → 空 */ }
        const verdict = guard.evaluateWildcardModel({ model, wildcardPool: wildcard, knownPresetIds, registeredPools });
        if (verdict && verdict.mismatch) return null;
      }
    } catch { /* 守卫不可用 → 保持原样盲落 */ }
  }

  return wildcard;
}

function _mapApiPoolProviderToServiceProvider(poolProvider) {
  const mapped = _getApiPoolToServiceMap()[String(poolProvider || '').toLowerCase()] || null;
  return mapped || null;
}

function _defaultModelForApiPoolProvider(poolProvider) {
  const normalized = String(poolProvider || '').toLowerCase();
  if (normalized === 'deepseek') return process.env.DEEPSEEK_MODEL || _getApiPoolDefaultModelMap().deepseek;
  if (normalized === 'doubao') return process.env.DOUBAO_MODEL || _getApiPoolDefaultModelMap().doubao;
  if (normalized === 'qwen') return process.env.QWEN_MODEL || _getApiPoolDefaultModelMap().qwen;
  if (normalized === 'glm') return process.env.GLM_MODEL || process.env.ZHIPU_MODEL || _getApiPoolDefaultModelMap().glm;
  if (normalized === 'wenxin') return process.env.WENXIN_MODEL || _getApiPoolDefaultModelMap().wenxin;
  if (normalized === 'anthropic') return process.env.ANTHROPIC_MODEL || _getApiPoolDefaultModelMap().anthropic;
  if (normalized === 'openai') return process.env.OPENAI_MODEL || _getApiPoolDefaultModelMap().openai;
  if (normalized === 'trae') return process.env.TRAE_MODEL || _getApiPoolDefaultModelMap().trae;
  if (normalized === 'relay') return process.env.RELAY_API_MODEL || process.env.OPENAI_MODEL || _getApiPoolDefaultModelMap().relay;
  const mapped = _getApiPoolDefaultModelMap()[normalized];
  if (mapped) return mapped;
  return null;
}

function _isProcessSensitiveAdapter(adapterKey) {
  const key = String(adapterKey || '').trim().toLowerCase();
  return PROCESS_SENSITIVE_ADAPTER_KEYS.has(key);
}

// HTTP OpenAI-compatible relay adapters whose endpoint is user-configurable
// (RELAY_API_ENDPOINT etc.). A dead endpoint here must be allowed to relax
// strict preferred routing so a healthy native channel can take over.
const HTTP_RELAY_ADAPTER_KEYS = new Set(['relay_api', 'api', 'relay']);

function _isHttpRelayAdapter(adapterKey) {
  const key = String(adapterKey || '').trim().toLowerCase();
  return HTTP_RELAY_ADAPTER_KEYS.has(key);
}

// Error types that indicate the relay endpoint itself is dead / misconfigured
// (as opposed to a live-but-throttled or auth-rejected endpoint). A 404 is
// classified as `model_not_found` by the gateway classifier, which is exactly
// the dead-relay case users hit. auth/rate_limit/unsupported are deliberately
// excluded so a throttled endpoint (e.g. GLM 1302) is retried in place / key-
// rotated rather than cascaded away.
const DEAD_ENDPOINT_ERROR_TYPES = new Set([
  'model_not_found',
  'unavailable',
  'bad_request',
  'server_error',
]);

function _isDeadEndpointErrorType(errorType) {
  const type = String(errorType || '').trim().toLowerCase();
  return DEAD_ENDPOINT_ERROR_TYPES.has(type);
}

function _parseProcessFailoverCandidates(raw) {
  const list = String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_PROCESS_FAILOVER_CANDIDATES;
}

function _resolveResultErrorType(statusCode, message, explicitType) {
  const rawType = String(explicitType || '').trim();
  if (!rawType || rawType.toLowerCase() === 'unknown') {
    return classifyError(statusCode, message);
  }
  return rawType;
}

function _extractResultErrorMessage(result) {
  const direct = _sanitizeFailureMessage(result?.error || result?.message || '');
  if (direct && direct !== 'unknown error') return direct;
  if (Array.isArray(result?.attempts)) {
    for (const attempt of result.attempts) {
      if (!attempt || attempt.success !== false) continue;
      const attemptMsg = _sanitizeFailureMessage(attempt.error || attempt.message || '');
      if (attemptMsg && attemptMsg !== 'unknown error') return attemptMsg;
    }
  }
  const content = _sanitizeFailureMessage(result?.content || '');
  if (content && content !== 'unknown error') return content;
  return 'unknown error';
}

// relay_api / api 模型名别名 → 完整 Anthropic model ID
const _RELAY_MODEL_ALIASES = {
  'claude-sonnet-4.5': 'claude-sonnet-4-5-20250514',
  'claude-sonnet-4': 'claude-sonnet-4-20250514',
  'claude-opus-4': 'claude-opus-4-20250514',
  'claude-haiku-3.5': 'claude-3-5-haiku-20241022',
  'claude sonnet 4.5': 'claude-sonnet-4-5-20250514',
  'claude sonnet 4': 'claude-sonnet-4-20250514',
  'claude opus 4': 'claude-opus-4-20250514',
};

// 裸 tier 别名(haiku/sonnet/opus)→ dated Anthropic id 的安全网。内置子 agent
// (Explore/khyGuide 'haiku'、statuslineSetup 'sonnet')把模型钉死为裸 tier 别名;
// 主修在 AgentTool 里按「当前通道可用模型」自动挑选,但若可用性查询失败而盲回退到
// 裸别名,relay_api/api 仍会把非法 model id 原样发给 provider 被拒。此表把这些裸别名
// 兜底解析为「现有别名目录中已用的同一 dated id」(目录补全,非新模型选择)。
// 门控 KHY_RELAY_BARE_ALIAS 默认开;关 → 裸别名原样透传(今日字节行为)。
const _RELAY_BARE_TIER_ALIASES = {
  haiku: 'claude-3-5-haiku-20241022', // 与 'claude-haiku-3.5' 同目标
  sonnet: 'claude-sonnet-4-20250514', // 与 'claude-sonnet-4' / RELAY_DEFAULT_MODELS 同
  opus: 'claude-opus-4-20250514', // 与 'claude-opus-4' 同
};
const _RELAY_BARE_ALIAS_FALSY = new Set(['0', 'false', 'off', 'no']);
function _bareAliasEnabled() {
  try {
    const raw = process.env.KHY_RELAY_BARE_ALIAS;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_RELAY_BARE_ALIAS_FALSY.has(v);
  } catch {
    return true;
  }
}

// 门控 KHY_RELAY_COMPOSITE_MODEL_STRIP(默认开):relay_api 发线前把 khy 内部三段式路由 id
// `api:<pool>:<model>` 剥成裸模型名,避免上游(bigmodel 等)收到内部 id 回 1211「模型不存在」。
// 关(0/false/off/no)→ 逐字节回退原样透传。异常一律回退开(保护默认)。
function _relayCompositeStripEnabled() {
  try {
    const raw = process.env.KHY_RELAY_COMPOSITE_MODEL_STRIP;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_RELAY_BARE_ALIAS_FALSY.has(v);
  } catch {
    return true;
  }
}

function normalizeModelForAdapter(adapterKey, model) {
  if (!model || typeof model !== 'string') return model;
  const m = model.trim();
  if (!m) return model;

  if (adapterKey === 'codex') {
    // Codex 不认识 Claude 模型名 — 重映射为 codex 自有模型（级联兼容）
    if (/^claude[-_]/i.test(m) || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) {
      return 'gpt-5.3-codex';
    }
  }
  if (adapterKey === 'claude') {
    // Prevent carrying non-Claude model ids into Claude CLI requests.
    // Claude adapter should only receive claude-* style model ids.
    if (!/^claude[-_]/i.test(m)) {
      return null;
    }
  }

  // relay_api / api: 将简短模型名映射为 Anthropic 完整 model ID
  if (adapterKey === 'relay_api' || adapterKey === 'api') {
    // relay_api 把 model 原样写进 HTTP 请求体发往上游(如 bigmodel /chat/completions)。若 khy
    // 内部三段式路由 id `api:<pool>:<model>`(如 `api:glm:glm-4.7-flash`)漏到这里,上游只认裸
    // 模型名(`glm-4.7-flash`)→ **所有模型**都回 400 code 1211「模型不存在」(实测:文本 4.7 与
    // 识图 4.6v 同因)。`api` 适配器自身经 parseProviderModel 剥前缀解析 pool,绝不能在此剥;仅
    // relay_api 需在发线前剥成裸模型。门控 KHY_RELAY_COMPOSITE_MODEL_STRIP 默认开,关 → 原样透传。
    if (adapterKey === 'relay_api' && _relayCompositeStripEnabled()) {
      const m3 = m.match(/^api[:/][a-z0-9_-]+[:/](.+)$/i);
      if (m3 && m3[1]) return m3[1].trim();
    }
    const aliased = _RELAY_MODEL_ALIASES[m.toLowerCase()];
    if (aliased) return aliased;
    // 安全网:裸 tier 别名(haiku/sonnet/opus)兜底解析为 dated id(门控可关回退原透传)。
    if (_bareAliasEnabled()) {
      const bare = _RELAY_BARE_TIER_ALIASES[m.toLowerCase()];
      if (bare) return bare;
    }
    // relay_api 直连 api.trae.ai,不认自定义 provider 模型。auto/级联误带进来的外来模型
    // (如 agnes-2.0-flash,归 api 代理 + apihub.agnes-ai.com 路由)会必然 404 model_not_found
    // 并被缓存 cooldown。不属 relay 可服务家族 → 丢弃(null)让通道用自有默认模型。对称于上方
    // claude 通道的防护;仅 relay_api——`api` 是代理,honor PROXY_MODEL_ROUTE_MAP 能正确转发
    // 自定义 provider,绝不在其上丢弃。门控 KHY_RELAY_MODEL_GUARD 默认开,关 → 原样透传。
    if (adapterKey === 'relay_api') {
      try {
        const guard = require('./relayModelGuard');
        if (guard.isEnabled(process.env) && !guard.isRelayServableModel(m)) return null;
      } catch { /* 叶子不可用 → 保持原样透传 */ }
    }
  }

  return model;
}

function resolvePreferredModelForAdapter(adapterKey, model) {
  const normalized = normalizeModelForAdapter(adapterKey, model);
  if (!normalized || typeof normalized !== 'string') return null;
  const trimmed = normalized.trim();
  return trimmed || null;
}

// OCR 兜底的可复用核心：把图像转成文本片段(纯函数式，依赖 ocrSnippetService /
// imageService)。两处调用——cascade 内 _visionFallback、prep 期"无视觉候选"——
// 共用同一套提取逻辑，避免散落重复。返回每张图的明细 {text, confidence, needsAiFallback}
// (可能为空数组)。confidence/needsAiFallback 由 OCR 引擎自评透传，供上层决定是否给低置信
// 文本追加诚实告诫(见 ocrConfidenceCaveat 纯叶子);此前这两个质量信号一路被丢弃。
function extractImageOcrDetails(images, { maxImages = 3, maxChars = 1200 } = {}) {
  const details = [];
  if (!Array.isArray(images) || images.length === 0) return details;
  let ocrSnippet;
  let imageService;
  try {
    ocrSnippet = require('../ocrSnippetService');
    imageService = require('../imageService');
  } catch {
    return details;
  }
  for (const img of images.slice(0, maxImages)) {
    let ocrResult = null;
    if (img && img._filePath) {
      ocrResult = ocrSnippet.extractImageOcrSnippet(img._filePath, img.mimeType || 'image/png', { maxChars });
    } else if (img && (img.base64 || img.dataUrl)) {
      const tmpPath = imageService.saveBase64ToTemp(img.base64 || img.dataUrl, img.mimeType || 'image/png');
      if (tmpPath) {
        ocrResult = ocrSnippet.extractImageOcrSnippet(tmpPath, img.mimeType || 'image/png', { maxChars });
        try { require('fs').unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
    if (ocrResult && ocrResult.success && ocrResult.text) {
      details.push({
        text: ocrResult.text,
        confidence: Number(ocrResult.confidence) || 0,
        needsAiFallback: ocrResult.needsAiFallback === true,
        truncated: ocrResult.truncated === true,
        lang: ocrResult.lang || '',
        requestedLang: ocrResult.requestedLang || '',
        orientationCorrected: Number(ocrResult.orientationCorrected) || 0,
        upscaledFactor: Number(ocrResult.upscaledFactor) || 0,
      });
    }
  }
  return details;
}

// 向后兼容薄封装:老调用方(rate-limit 兜底等)只要文本数组。委托 extractImageOcrDetails
// 取 text 字段,输出与旧实现逐字节等价(同样的 success && text 过滤、同样的顺序)。
function extractImageOcrTexts(images, opts) {
  return extractImageOcrDetails(images, opts).map((d) => d.text);
}

// 透明视觉降级(OCR 文本 / 读不出)时,若 GLM 视觉门控开但用户尚未配置 GLM key,则在 prompt
// 末尾追加一句「配 GLM 视觉 key 我就能直接看图」的面向模型邀约(单一真源
// visionOcrFallback.buildVisionKeyConfigOffer,受 KHY_VISION_OCR_KEY_INVITE 门控)。
// 仅当 glmVisionOn && !glmKeyReady 时才尝试;门控关/叶子不可用/无缺失 → 原样返回 prompt,
// 逐字节回退。fail-soft:绝不抛。
function _appendVisionKeyOffer(prompt, glmVisionOn, glmKeyReady) {
  if (!glmVisionOn || glmKeyReady) return prompt;
  try {
    const offer = require('./visionOcrFallback').buildVisionKeyConfigOffer({
      glmKeyMissing: true,
      env: process.env,
    });
    if (offer) return `${prompt || ''}\n\n${offer}`;
  } catch { /* 叶子不可用 → 保持原 prompt */ }
  return prompt;
}

// 限流(429/瞬态)终局 OCR 兜底执行器(用户报 2026-07「一发送图片就 429、图片不会被
// 正确识别」)。视觉路径在**终局**(级联穷尽 / 缓存冷却短路,无健康通道可走)以瞬态类错误
// (rate_limit/overloaded/timeout/network)失败、且本轮仍握图时,退回本地 OCR 把图中文字读出来
// 诚实回给用户,而非甩一个 429 让用户干等冷却窗口。判定收口在纯叶子 visionOcrFallback
// (门控 KHY_VISION_RATE_LIMIT_OCR 默认开)。绝不谎报:OCR 取不到文本 → 返回 null 落回原限流
// 失败;绝不中途抢图:调用点只在两条终局路径(见 4580 缓存短路 / 5736 级联穷尽)。
//
// @returns {object|null} 成功兜底 → finishResult 的返回值;不满足/无文本 → null(调用方按原路径继续)。
function tryRateLimitOcrRescue({ images, prompt, errorType, finishResult, allAttempts, emitStatus, env }) {
  try {
    const fb = require('./visionOcrFallback');
    if (!fb.shouldRateLimitOcrRescue({ errorType, hasImage: Array.isArray(images) && images.length > 0, env })) {
      return null;
    }
    const ocrTexts = extractImageOcrTexts(images, { maxImages: 3, maxChars: 1200 });
    if (!ocrTexts.length) return null; // 无文本(照片/场景/缺字库):诚实落回原限流失败,不谎报。
    const note = fb.buildRateLimitOcrNote({ count: ocrTexts.length, env });
    if (!note) return null; // 门控关(理论上 shouldRateLimitOcrRescue 已挡,双保险)。
    const ocrBlock = ocrTexts.map((t, i) => `【图片${i + 1} OCR 文本】\n${t}`).join('\n\n');
    const content = `${prompt ? `${prompt}\n\n` : ''}${note}\n\n${ocrBlock}`;
    if (typeof emitStatus === 'function') {
      emitStatus(`视觉通道被限流,已用本地 OCR 兜底识别图片文字(${ocrTexts.length} 张)`);
    }
    return finishResult({
      success: true,
      content,
      provider: 'ocr-local',
      adapter: 'ocr-fallback',
      errorType: null,
      attempts: Array.isArray(allAttempts) ? allAttempts : [],
      degraded: true,
      degradedReason: 'rate_limit_ocr_fallback',
    }, { response: { content, provider: 'ocr-local', adapter: 'ocr-fallback' } });
  } catch {
    return null; // 兜底自身异常绝不打断原失败返回路径。
  }
}

// 枚举与给定 model 同属一个 provider 的兄弟模型(用于"带图自动改选同 provider 的
// 视觉模型")。SenseNova 三个模型同在 api/sensenova pool 下，所以"切到 u1"= 同
// provider 换 model。best-effort：解析失败/无 provider 时返回空数组(决策会退回 OCR)。
function collectProviderSiblingModels(model) {
  const bare = String(model || '').trim();
  if (!bare) return [];
  try {
    const apiAdapter = require('./adapters/apiAdapter');
    const parsed = typeof apiAdapter.parseProviderModel === 'function'
      ? apiAdapter.parseProviderModel(bare)
      : { provider: null, model: bare, poolProvider: null };
    const bareModel = String(parsed.model || bare).trim().toLowerCase();
    const poolKey = String(parsed.poolProvider || parsed.provider || '').trim().toLowerCase();

    const registry = require('../customProviderRegistry');
    const providers = registry.listProviders();
    let owner = null;
    if (poolKey) {
      owner = providers.find(p => String(p.poolKey || '').toLowerCase() === poolKey) || null;
    }
    if (!owner) {
      owner = providers.find(p => Array.isArray(p.models)
        && p.models.some(m => String(m || '').trim().toLowerCase() === bareModel)) || null;
    }
    return owner && Array.isArray(owner.models) ? owner.models.slice() : [];
  } catch {
    return [];
  }
}

function buildPreferredAdapterRecoveryHint(preferredAdapter, error, errorType, model, hasImage) {
  const adapter = String(preferredAdapter || '').trim() || 'unknown';
  const adapterKey = adapter.toLowerCase();
  const adapterDisplay = ({
    cli: 'CLI 工具桥接',
    codex: 'Codex',
    claude: 'Claude',
    kiro: 'Kiro',
    cursor: 'Cursor',
    trae: 'Trae',
    windsurf: 'Windsurf',
    vscode: 'VSCode',
    warp: 'Warp',
    localllm: '本地模型',
    ollama: 'Ollama',
    api: 'API',
    relay: 'Web Relay',
  })[adapterKey] || adapter;
  const lower = String(error || '').toLowerCase();
  const abortLike = /aborterror|abort_err|\baborted\b|\brequest aborted\b|\babort(ed)? by\b|signal aborted|user[-\s]?cancel/.test(lower);
  const processCanceledLike = !abortLike && /\bcancelled\b|\bcanceled\b/.test(lower);
  // model_not_found(永久配置错误)专用恢复行 —— 门控 KHY_MODEL_NOT_FOUND_RECOVERY(默认开);
  // 关或非 model_not_found → null → 逐字节回退到今日通用/其它分支。errorType 由 strict 硬失败点透传
  // (裸 `Request failed with status code 404` 消息不含类型词)。fail-soft。
  let modelNotFoundLines = null;
  try {
    modelNotFoundLines = require('./modelNotFoundRecovery').buildModelNotFoundRecoveryLines({
      adapterDisplay,
      errorType,
      message: error,
      model,
      hasImage,
    });
  } catch { modelNotFoundLines = null; }
  const lines = [
    processCanceledLike
      ? `已选择模型通道请求失败（进程中断/非用户取消）: ${error || 'canceled'}`
      : `已选择模型通道请求失败: ${error || 'unknown error'}`,
    '',
    '建议下一步:',
    '  1) 运行 `khy gateway status` 查看各通道实测状态',
    '  2) 运行 `khy gateway model` 仅选择“可执行”模型',
  ];
  if (processCanceledLike) {
    lines.push(`  3) 运行 \`khy gateway reconnect ${adapter}\` 强制重连后重试`);
    lines.push('  4) 默认会自动放宽 strict 并尝试兜底通道；如被手动关闭可设置 GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS=true');
  } else if (modelNotFoundLines) {
    for (const l of modelNotFoundLines) lines.push(l);
  } else if (lower.includes('apikeysource') || lower.includes('auth') || lower.includes('unauthorized') || lower.includes('login')) {
    if (adapterKey === 'cli') {
      const cliTarget = lower.includes('claude') ? 'Claude Code'
        : (lower.includes('codex') ? 'Codex' : 'Codex/Claude');
      lines.push(`  3) 重新登录 ${cliTarget} 后再试`);
    } else {
      lines.push(`  3) 重新登录 ${adapterDisplay} 后再试`);
    }
  } else if (_isReconnectOrChannelClosedMessage(lower)) {
    if (adapterKey === 'cli') {
      const cliTarget = lower.includes('claude') ? 'Claude Code'
        : (lower.includes('codex') ? 'Codex' : 'Codex/Claude');
      lines.push(`  3) 重启 ${cliTarget} CLI 会话并重试`);
    } else {
      lines.push(`  3) 重启 ${adapterDisplay} CLI 会话并重试`);
    }
  } else if (lower.includes('loopback listen is not permitted') || lower.includes('listen eperm')) {
    lines.push('  3) 运行 `khy doctor` 检查本地监听能力与本地模型后端');
    lines.push('  4) 若处于沙箱/受限环境，请切换到 API/桥接通道（khy gateway model）');
  } else if (lower.includes('timeout')) {
    lines.push('  3) 检查网络/代理后重试');
  } else if (lower.includes('bridge canceled') || lower.includes('handshake timeout') || lower.includes('without emitting stream-json')) {
    lines.push(`  3) Claude CLI 桥接模式异常 — 尝试设置 GATEWAY_CLAUDE_MODE=direct 直连 API`);
    lines.push('  4) 或配置 RELAY_API_ENDPOINT + RELAY_API_KEY 启用中继兜底');
    lines.push('  5) 运行 `khy doctor` 检查 Claude CLI 版本兼容性');
  }
  return lines.join('\n');
}

function normalizeAbortReason(reason) {
  if (!reason) return 'aborted';
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason.message === 'string') return reason.message;
  try { return JSON.stringify(reason); } catch { return String(reason); }
}

function createAbortError(reason) {
  const err = new Error(normalizeAbortReason(reason));
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw createAbortError(signal.reason || 'aborted');
  }
}

function createLinkedAbortController(parentSignal) {
  const controller = new AbortController();
  let detach = () => {};

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else if (typeof parentSignal.addEventListener === 'function') {
      const onAbort = () => {
        try { controller.abort(parentSignal.reason); } catch { /* ignore */ }
      };
      parentSignal.addEventListener('abort', onAbort, { once: true });
      detach = () => {
        try { parentSignal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      };
    }
  }

  return {
    controller,
    signal: controller.signal,
    abort: (reason) => {
      if (!controller.signal.aborted) {
        try { controller.abort(reason); } catch { /* ignore */ }
      }
    },
    cleanup: detach,
  };
}

class AIGateway {
  constructor() {
    this._adapters = [
      // ── 云端结构化适配器（原生 tool_use，最可靠）──
      { key: 'kiro', adapter: kiroAdapter, priority: 0, enabled: true },
      { key: 'cursor', adapter: cursorAdapter, priority: 1, enabled: true },
      { key: 'trae', adapter: traeAdapter, priority: 2, enabled: true },
      { key: 'claude', adapter: claudeAdapter, priority: 3, enabled: true },
      { key: 'codex', adapter: codexAdapter, priority: 4, enabled: true },
      { key: 'api', adapter: apiAdapter, priority: 5, enabled: true },
      // ── IDE bridge（依赖 IDE 进程，次可靠）──
      { key: 'windsurf', adapter: windsurfAdapter, priority: 6, enabled: true },
      { key: 'vscode', adapter: vscodeAdapter, priority: 7, enabled: true },
      { key: 'warp', adapter: warpAdapter, priority: 8, enabled: true },
      { key: 'cursor2api', adapter: cursor2apiAdapter, priority: 9, enabled: true },
      { key: 'relay_api', adapter: relayApiAdapter, priority: 10, enabled: true },
      // ── 本地模型（无/弱 function calling，最低优先级）──
      { key: 'ollama', adapter: ollamaAdapter, priority: 11, enabled: true },
      { key: 'localLLM', adapter: localLLMAdapter, priority: 12, enabled: true },
      // ── 辅助通道 ──
      { key: 'cli', adapter: cliToolAdapter, priority: 13, enabled: true },
      { key: 'relay', adapter: webRelayAdapter, priority: 14, enabled: true },
      { key: 'clipboard', adapter: clipboardRelayAdapter, priority: 15, enabled: true },
      // ── 外部代码编辑器(定向指挥,不抢占自动 LLM 回退)──
      // opencode 有自己的 provider/model 配置,不应成为通用聊天的默认回退,故置于
      // 最低自动优先级;显式 preferredAdapter:'opencode' / subagent_type:'opencode'
      // 走定向路由不受此顺序影响。
      { key: 'opencode', adapter: opencodeAdapter, priority: 16, enabled: true },
    ];
    this._initialized = false;
    this._initPromise = null;

    // Per-model context window cache (populated from adapter listModels/generate responses)
    this._contextWindowCache = new Map();

    // Capability registry for capability-aware model selection
    try {
      const { CapabilityRegistry } = require('./capabilityRegistry');
      this._capabilityRegistry = new CapabilityRegistry(this);
    } catch { this._capabilityRegistry = null; }

    // ── 适配器检测缓存（避免每次 generate() 都重新检测 16 个适配器）──
    this._detectCache = new Map(); // key → { available: bool, timestamp: number }
    const DETECT_CACHE_TTL_MS = 60_000; // 60s 缓存
    for (const entry of this._adapters) {
      const originalDetect = entry.adapter.detect.bind(entry.adapter);
      entry.adapter.detect = (forceRefresh) => {
        const cacheKey = entry.key;
        const cached = this._detectCache.get(cacheKey);
        if (!forceRefresh && cached && (Date.now() - cached.timestamp) < DETECT_CACHE_TTL_MS) {
          return cached.available;
        }
        const result = originalDetect(forceRefresh);
        if (result && typeof result.then === 'function') {
          return result.then(available => {
            this._detectCache.set(cacheKey, { available, timestamp: Date.now() });
            return available;
          });
        }
        this._detectCache.set(cacheKey, { available: !!result, timestamp: Date.now() });
        return !!result;
      };
    }

    // ── Redis-backed state (graceful degradation to in-memory) ──────────
    const _getRedisClient = () => {
      try {
        const { getRedisClient } = require('@khy/shared/services/cacheService');
        return getRedisClient();
      } catch { return null; }
    };
    const redisHealthEnabled = String(process.env.GATEWAY_REDIS_HEALTH_ENABLED || 'true').toLowerCase() !== 'false';
    this._healthStore = redisHealthEnabled
      ? new RedisHealthStore({ getRedisClient: _getRedisClient })
      : new RedisHealthStore({ getRedisClient: () => null }); // pure memory mode

    // Distributed rate limiter (Redis ZSET sliding window, fallback to memory)
    const redisRlEnabled = String(process.env.GATEWAY_REDIS_RATELIMIT_ENABLED || 'true').toLowerCase() !== 'false';
    this._distributedLimiter = createRedisRateLimiter({
      getRedisClient: redisRlEnabled ? _getRedisClient : () => null,
      maxRequests: 10,
      windowMs: 60000,
    });

    // Request deduplication
    this._dedup = createRequestDedup({ getRedisClient: _getRedisClient });

    // Channel health broadcaster
    let notifyAll = null;
    try {
      const ns = require('../notificationService');
      if (ns && typeof ns.broadcastToAll === 'function') {
        notifyAll = ns.broadcastToAll.bind(ns);
      }
    } catch { /* notificationService not available */ }
    this._healthBroadcaster = new ChannelHealthBroadcaster({
      healthStore: this._healthStore,
      broadcast: (type, data) => {
        try {
          if (notifyAll) notifyAll({ type, ...data });
        } catch { /* notificationService not available */ }
      },
    });

    // Anti-ban: token bucket rate limiter (per adapter) — kept as fast in-memory fallback
    this._requestLog = {};          // key → timestamps of recent requests
    this._adapterFailures = {};     // key → consecutive failure count (synced with healthStore)
    this._lastRefreshTime = 0;      // last adapter re-detection time
    // Local adapters that don't need rate limiting (also the authoritative
    // local-vs-cloud classifier — see getAdapterOrigin). Extend via
    // KHY_LOCAL_ADAPTERS (comma-separated adapter keys).
    this._localAdapters = new Set(['localLLM', 'ollama']);
    const extraLocal = String(process.env.KHY_LOCAL_ADAPTERS || '').trim();
    if (extraLocal) {
      for (const k of extraLocal.split(',').map(s => s.trim()).filter(Boolean)) {
        this._localAdapters.add(k);
      }
    }
    // Recent adapter failure cache for fast-fail (prevents repeated stalls on dead channels)
    this._adapterLastError = {};
    // Cooldown self-heal probe state (adapterKey -> in-flight promise / meta)
    this._cooldownSelfHealInFlight = new Map();
    this._cooldownSelfHealMeta = {};
    this._cooldownSelfHealTimer = null;
    this._cooldownSelfHealMidpointTimers = new Map();
    // Fixed-window rate limiter (replaces manual timestamp tracking for new callers)
    this._keyedLimiter = createKeyedRateLimiter({ maxRequests: 10, windowMs: 60_000 });
    // Per-adapter sequential queue (prevents concurrent bridge collisions).
    // Keep a bounded timeout so a stuck adapter task cannot block all followers forever.
    // Timeout only releases queue progression; the underlying task may still finish later.
    const queueTimeoutMs = Math.max(
      0,
      parseInt(process.env.GATEWAY_ADAPTER_QUEUE_TIMEOUT_MS || '300000', 10) || 300000
    );
    this._adapterQueue = createSequentialQueue({ taskTimeoutMs: queueTimeoutMs });
    const defaultSerializedAdapters = [
      'localLLM',
      'ollama',
      'codex',
      'claude',
      'cli',
      'clipboard',
    ];
    const serializedEnvList = String(process.env.GATEWAY_SERIAL_ADAPTERS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const parallelEnvSet = new Set(
      String(process.env.GATEWAY_PARALLEL_ADAPTERS || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    );
    this._serializedAdapterKeys = new Set(
      (serializedEnvList.length > 0 ? serializedEnvList : defaultSerializedAdapters)
    );
    if (parallelEnvSet.size > 0) {
      for (const key of Array.from(this._serializedAdapterKeys)) {
        if (parallelEnvSet.has(String(key || '').toLowerCase())) {
          this._serializedAdapterKeys.delete(key);
        }
      }
    }
  }




}


// Cooldown / adapter-failure methods live in a sibling module and are mixed onto the prototype here
// (bodies byte-identical; `this` binds at call time). Wire the mixin + inject the module-scope helper
// deps BEFORE constructing the singleton, since the constructor path may touch these methods.
const { AIGatewayCooldownMethods, setAiGatewayCooldownMethodsDeps } = require('./aiGatewayCooldownMethods');
Object.assign(AIGateway.prototype, AIGatewayCooldownMethods);
setAiGatewayCooldownMethodsDeps({
  _adaptiveConfig, _isProcessSensitiveAdapter, _isReconnectOrChannelClosedMessage, _parseFloat01,
  _parseMs, _parsePositiveInt, _resolveApiPoolProviderForRequest, _sanitizeFailureMessage,
  _shouldUseFastFail, _transientCooldownMs,
});

// Routing / timeout / lifecycle methods live in a sibling module and are mixed onto the prototype here
// (bodies byte-identical; `this` binds at call time). Wire + inject the module-scope deps BEFORE
// constructing the singleton, since the constructor path may touch these methods.
const { AIGatewayRoutingMethods, setAiGatewayRoutingMethodsDeps } = require('./aiGatewayRoutingMethods');
Object.assign(AIGateway.prototype, AIGatewayRoutingMethods);
setAiGatewayRoutingMethodsDeps({
  _appendKhyProtocolDebugLog, _buildKhyProtocolDebugSummary, _formatRouteAgeMs, _getKhyProtocolPriorityRisk,
  _injectKhyExpectedLanguageSystem, _injectKhyProtocolPrompt, _injectKhyProtocolSystem, _isProcessSensitiveAdapter,
  _parseMs, _parseProcessFailoverCandidates, _resolveDefaultRouteTuning,
  DEFAULT_ROUTE_BASE_PRIORITY, DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS, kiroAdapter, ollamaAdapter, localLLMService,
});

// Model / adapter-accessor / verification methods live in a sibling module and are mixed onto the
// prototype here (bodies byte-identical; `this` binds at call time). Wire + inject the host-internal
// deps BEFORE constructing the singleton, since the constructor path may touch these methods.
const { AIGatewayModelMethods, setAiGatewayModelMethodsDeps } = require('./aiGatewayModelMethods');
Object.assign(AIGateway.prototype, AIGatewayModelMethods);
setAiGatewayModelMethodsDeps({
  safeKillChildProc, _shouldUseFastFail, _parseMs, _getKhyProtocolPriorityRisk,
  _extractResultErrorMessage, resolvePreferredModelForAdapter,
  _ADAPTER_SOURCE_LABELS, CODEX_GENERATION_PROBE_PROMPT,
});

// The core generate() method lives in a sibling module and is mixed onto the prototype here (body
// byte-identical; `this` binds at call time). Wire + inject the host-internal helpers BEFORE
// constructing the singleton. The three module lets are captured at their load-time final values.
const { AIGatewayGenerateMethod, setAiGatewayGenerateMethodDeps } = require('./aiGatewayGenerateMethod');
Object.assign(AIGateway.prototype, AIGatewayGenerateMethod);
setAiGatewayGenerateMethodDeps({
  _advDiag, _modelSwitch, _traceAudit,
  _appendVisionKeyOffer, _buildLanguageMismatchFailureMessage, _createCodexChineseChunkGate,
  _createKhyLanguageConsistencyTracker, _defaultModelForApiPoolProvider, _extractResultErrorMessage,
  _injectKhyChineseRecoveryPrompt, _injectKhyChineseRecoverySystem, _isDeadEndpointErrorType,
  _isHttpRelayAdapter, _isProcessSensitiveAdapter, _isRetryableResultErrorType,
  _isTransientGatewayTransportMessage, _mapApiPoolProviderToServiceProvider, _normalizeApiPoolProvider,
  _parseMs, _parsePositiveInt, _prependFailureReason, _resolveApiPoolProviderForRequest,
  _resolveCodexChineseRecoveryRetryBudget, _resolveResultErrorType, _shouldAutoRecoverCodexChineseMismatch,
  buildPreferredAdapterRecoveryHint, classifyError, collectProviderSiblingModels,
  createLinkedAbortController, extractImageOcrTexts, extractImageOcrDetails, normalizeAbortReason, normalizeModelForAdapter,
  resolvePreferredModelForAdapter, throwIfAborted, tryRateLimitOcrRescue,
});
const gateway = new AIGateway();
gateway.classifyError = classifyError;

/**
 * Notify the live model switch about a manual model change from /model.
 * Without this, _modelSwitch.getActiveModel() returns the old value
 * and overrides process.env.GATEWAY_PREFERRED_MODEL on the next generate().
 */
gateway.syncModelSwitch = function syncModelSwitch(model) {
  if (_modelSwitch && model) {
    try {
      _modelSwitch.switchModel(model, { reason: 'gateway_preference', persist: false, force: true });
    } catch { /* best effort */ }
  }
};

module.exports = gateway;
module.exports.getCapabilityRegistry = () => gateway._capabilityRegistry;
// 暴露「同 provider 兄弟模型」枚举,供 imageOcr 工具判定是否存在可用视觉模型(SSOT
// 复用,避免在工具里另写一份 provider/pool 解析)。纯函数,无副作用。
module.exports.collectProviderSiblingModels = collectProviderSiblingModels;

// Publish generate() through the zero-dependency provider sink so best-effort
// callers (e.g. opt-in session-trace LLM compression) can reach it without
// importing this 6000-line gateway and getting pulled into the giant SCC
// ([DESIGN-ARCH-051] §6.9). A closure preserves the AIGateway `this` binding.
require('../llmGenerateSink').setLlmGenerateProvider((prompt, options) => gateway.generate(prompt, options));

module.exports.__test__ = {
  _adapterMayOverridePromptDownstream,
  _injectKhyProtocolSystem,
  _injectKhyProtocolPrompt,
  _buildKhyProtocolDebugSummary,
  _appendKhyProtocolDebugLog,
  _getKhyProtocolPriorityRisk,
  normalizeModelForAdapter,
  resolvePreferredModelForAdapter,
  buildPreferredAdapterRecoveryHint,
  _isHttpRelayAdapter,
  _isProcessSensitiveAdapter,
  _isDeadEndpointErrorType,
  _resolveApiPoolProviderForRequest,
};
