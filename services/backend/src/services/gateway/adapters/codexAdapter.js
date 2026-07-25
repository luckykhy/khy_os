/**
 * Codex Adapter — invoke OpenAI Codex CLI or direct Responses API.
 *
 * Two modes:
 *   cli    (default) — spawns `codex exec --json`, Codex manages its own tool loop
 *   direct — calls Responses API directly (provider-agnostic), KHY manages tool loop with native tools
 *
 * Set GATEWAY_CODEX_MODE=direct to use the API mode with Glob/Grep/Read/Edit/Write.
 *
 * Direct mode provider config (in priority order):
 *   1. codex config.toml providerBaseUrl (from readCodexConfig())
 *   2. CODEX_DIRECT_BASE_URL env var
 *   3. OPENAI_BASE_URL env var
 *   4. https://api.openai.com/v1 (default)
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { extractPrimaryApiKey } = require('../../apiKeyFormat');
const { toCodexInputImages } = require('./_imageCompat');
const { safeKill } = require('../../../tools/platformUtils');
const { createAdapterRuntimeDiagnosticsStore } = require('../runtimeDiagnosticsStore');
const { normalizeAbortReason, isAbortLikeError } = require('./_abortHelpers');
const { classifyAdapterError: _sharedClassify } = require('./_errorClassifiers');
const { connectThroughProxy: _sharedConnectProxy } = require('./_proxyTunnel');
const { buildSuccess, buildFailure } = require('./_responseBuilder');
const { normalizeCacheUsage } = require('./_cacheUsage');
const { splitShellArgs } = require('../../shellSafetyValidator');
const {
  extractMessageText,
  extractThinkingTags,
  extractReasoningText,
  parseDirectResponse,
} = require('./_responsesFormat');
// Portable codex (便携版 ~/.khy/tools) spawn/detect helpers — shared leaf keeps
// this 2500-line-capped file's call sites tiny; never throws (falls back to bare).
const { portableSpawn: _portableCodexSpawn, portableInstalled: _portableCodexInstalled } =
  require('./portableAdapterSpawn').forTool('codex');

// ── Codex 事件流解释(已抽取为叶子 ./codexEventStream.js)────────────────────
// stdout_json 事件 → 归一化进度/工具/文件操作证据。零可变模块态;仅
// appendCodexExecDebugLog 写调试日志(KHY_GATEWAY_DEBUG_PROMPT_FILE)。宿主
// runCodexExec/generate 及 __test__ 按 **同名 re-import** 接回,调用点字节不变。
const {
  compactText, appendCodexExecDebugLog, isReconnectChannelClosed,
  summarizeValue, getItemType, inferToolName, inferToolInput, inferToolOutput, isToolLike,
  normalizeTrackedFileOperation, classifyTrackedRelocation, dedupeTrackedFileOps,
  extractTrackedFileOpsFromShellCommand, inferTrackedFileOps,
  createCodexProgressEvidence, recordCodexProgressEvent, classifyCodexPreResponseStall,
  snapshotCodexProgressEvidence, formatCodexProgressEvidence, createCodexProgressTimeoutError,
  appendCodexExecProgressLog, buildCodexProgressDiagnostics, emitCodexEvent,
} = require('./codexEventStream');

const DEFAULT_IDLE_TIMEOUT_MS = parseInt(
  process.env.GATEWAY_CODEX_TIMEOUT_MS
  || process.env.KHY_CODEX_TIMEOUT_MS
  || '300000',
  10
);
const PROBE_TIMEOUT_MS = 4000;
const VERSION_PROBE_TIMEOUT_MS = 3500;
const MAX_BUFFER = 10 * 1024 * 1024;

// PascalCase tool names exposed to the Codex Responses API in direct mode.
// Hoisted to module scope (Ch2「不要每轮重建可复用结构」): buildDirectToolDefs runs
// once per Codex model round-trip and formerly rebuilt this literal Set each call.
// Consumed read-only (`.has`); never mutated/returned. (The per-call `seen` dedup
// Set in buildDirectToolDefs is legitimately per-call state and stays inline.)
const _CODEX_DIRECT_ALLOWED_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'web_search']);

// ── Direct mode constants ─────────────────────────────────────────
const CODEX_MODE = String(process.env.GATEWAY_CODEX_MODE || 'cli').trim().toLowerCase();
const CODEX_DIRECT_TIMEOUT_MS = parseInt(process.env.CODEX_DIRECT_TIMEOUT_MS || '120000', 10);
const CODEX_DIRECT_MAX_ITERATIONS = parseInt(process.env.CODEX_DIRECT_MAX_ITERATIONS || '10', 10);

// Prompt-based thinking for models without native reasoning output
const THINKING_INSTRUCTION = [
  '# Thinking Mode',
  'You MUST show your reasoning process before answering.',
  'Wrap your thinking in <thinking>...</thinking> tags.',
  'Think step-by-step: analyze the question, consider approaches, then act.',
  'The <thinking> block must appear BEFORE any tool calls or final answer.',
  'Example:',
  '<thinking>',
  'The user wants to fix a bug in auth.js. I should first read the file to understand the current logic.',
  '</thinking>',
].join('\n');

// Auto-raise gateway per-adapter timeout for direct mode (multi-turn tool loop needs more time)
if (CODEX_MODE === 'direct' && !process.env.GATEWAY_CODEX_TIMEOUT_MS) {
  process.env.GATEWAY_CODEX_TIMEOUT_MS = '120000';
}

// Fallback models if config cannot be read
const FALLBACK_MODELS = [
  { id: 'o4-mini', name: 'o4-mini', isDefault: true },
  { id: 'o3', name: 'o3', isDefault: false },
  { id: 'gpt-4.1', name: 'GPT-4.1', isDefault: false },
];

let _available = null;
let _lastDetectError = '';
let _execProbeOk = null;
let _lastExecProbeError = '';
let _configCache = null;
let _providerModels = null; // cached set of model IDs from provider API
const _runtimeDiagnosticsStore = createAdapterRuntimeDiagnosticsStore('codex');
let _runtimeDiagnostics = createEmptyRuntimeDiagnostics();

function resolveExecIdleTimeoutMs(options = {}) {
  const explicitIdleTimeout = parseInt(String(options.idleTimeoutMs ?? ''), 10);
  const envIdleTimeout = parseInt(
    process.env.GATEWAY_CODEX_IDLE_TIMEOUT_MS
    || process.env.KHY_CODEX_IDLE_TIMEOUT_MS
    || '',
    10
  );
  const resolvedTimeoutMs = resolveExecTimeoutMs(options);
  const minIdleTimeoutMs = Math.max(
    60000,
    parseInt(process.env.GATEWAY_CODEX_MIN_IDLE_TIMEOUT_MS || '180000', 10) || 180000
  );

  let idleTimeoutMs = explicitIdleTimeout;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    idleTimeoutMs = envIdleTimeout;
  }
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    idleTimeoutMs = Math.max(DEFAULT_IDLE_TIMEOUT_MS, resolvedTimeoutMs);
  }
  return Math.max(minIdleTimeoutMs, idleTimeoutMs);
}

function resolveExecFirstResponseTimeoutMs(options = {}) {
  const explicitFirstResponseTimeout = parseInt(String(options.firstResponseTimeoutMs ?? ''), 10);
  const envFirstResponseTimeout = parseInt(
    process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS
    || process.env.KHY_CODEX_FIRST_RESPONSE_TIMEOUT_MS
    || '',
    10
  );
  const resolvedTimeoutMs = resolveExecTimeoutMs(options);

  let firstResponseTimeoutMs = explicitFirstResponseTimeout;
  if (!Number.isFinite(firstResponseTimeoutMs) || firstResponseTimeoutMs <= 0) {
    firstResponseTimeoutMs = envFirstResponseTimeout;
  }
  if (!Number.isFinite(firstResponseTimeoutMs) || firstResponseTimeoutMs <= 0) {
    firstResponseTimeoutMs = Math.min(resolvedTimeoutMs, 45000);
  }

  return Math.max(1000, Math.min(resolvedTimeoutMs, firstResponseTimeoutMs));
}

function safeEmitStatus(options, text) {
  if (!options || typeof options.onChunk !== 'function') return;
  try { options.onChunk({ type: 'status', text: String(text || '') }); } catch { /* best effort */ }
}

const _isPathWithin = require('../../../utils/isPathWithin');

function getCodexHomeContext() {
  const envHome = String(process.env.HOME || '').trim();
  const resolvedHome = envHome || os.homedir() || '';
  const tmpDir = String(os.tmpdir() || '').trim();
  const isTempHome = !!resolvedHome && !!tmpDir && _isPathWithin(tmpDir, resolvedHome);
  return {
    homeDir: resolvedHome,
    tmpDir,
    isTempHome,
  };
}

function shouldAttachTempHomeHint(message = '') {
  const lower = String(message || '').toLowerCase();
  return (
    /timeout|reconnecting|channel closed|stream disconnected|tls handshake eof|failed to connect to websocket|error sending request for url/.test(lower)
    || /temporary dir|helper binaries|refusing to create helper binaries/.test(lower)
  );
}

function appendTempHomeHint(message = '', homeContext = null) {
  const context = homeContext || getCodexHomeContext();
  if (!context.isTempHome) return String(message || '');
  if (!shouldAttachTempHomeHint(message)) return String(message || '');
  const hint = `home_hint=temp_home:${compactText(context.homeDir, 120)}; codex_cli_temp_home_may_break_tls_or_helper_setup`;
  const current = String(message || '');
  if (current.includes('home_hint=temp_home:')) return current;
  return current ? `${current} | ${hint}` : hint;
}

function createEmptyRuntimeDiagnostics() {
  return _runtimeDiagnosticsStore.createEmptyDiagnostic();
}

function normalizeRuntimeDiagnostics(payload = {}, fallbackTrigger = '') {
  return _runtimeDiagnosticsStore.normalizeDiagnostic(payload, fallbackTrigger);
}

function createEmptyPersistedRuntimeDiagnosticsState() {
  return _runtimeDiagnosticsStore.createEmptyState();
}

function normalizePersistedRuntimeDiagnosticsState(payload = null) {
  return _runtimeDiagnosticsStore.normalizeState(payload);
}

function getCodexRuntimeDiagnosticsFile() {
  return _runtimeDiagnosticsStore.getFile();
}

function writePersistedRuntimeDiagnosticsState(payload = null) {
  _runtimeDiagnosticsStore.writeState(payload);
}

function readPersistedRuntimeDiagnosticsState() {
  return _runtimeDiagnosticsStore.readState();
}

function writePersistedRuntimeDiagnostics(payload = null) {
  _runtimeDiagnosticsStore.writeDiagnostic(payload);
}

function readPersistedRuntimeDiagnostics(options = {}) {
  return _runtimeDiagnosticsStore.readDiagnostic(options);
}

function clearPersistedRuntimeDiagnostics() {
  _runtimeDiagnosticsStore.clear();
}

function recordRuntimeDiagnostics(payload = {}) {
  _runtimeDiagnostics = _runtimeDiagnosticsStore.record(_runtimeDiagnostics, payload, {
    fallbackTrigger: 'unknown',
  });
}

function getRuntimeDiagnostics(options = {}) {
  return _runtimeDiagnosticsStore.get(_runtimeDiagnostics, options);
}

function escapeRegExp(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseTomlSection(content = '', sectionName = '') {
  const key = String(sectionName || '').trim();
  if (!key) return '';
  const pattern = new RegExp(`\\[${escapeRegExp(key)}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
  const matched = String(content || '').match(pattern);
  return matched ? String(matched[1] || '') : '';
}

function extractQuotedValue(source = '', key = '') {
  const k = String(key || '').trim();
  if (!k) return null;
  const matched = String(source || '').match(new RegExp(`^\\s*${escapeRegExp(k)}\\s*=\\s*"([^"]+)"\\s*$`, 'm'));
  return matched ? String(matched[1] || '').trim() : null;
}

// Extract an unquoted numeric TOML value, e.g. `model_context_window = 1000000`.
// Codex CLI's own config keys (model_context_window / model_max_output_tokens)
// are bare integers, so extractQuotedValue (quoted-string only) can't read them.
function extractNumericValue(source = '', key = '') {
  const k = String(key || '').trim();
  if (!k) return null;
  const matched = String(source || '').match(
    new RegExp(`^\\s*${escapeRegExp(k)}\\s*=\\s*([0-9_]+)\\s*$`, 'm')
  );
  if (!matched) return null;
  const n = parseInt(String(matched[1]).replace(/_/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isOpenAIBaseUrl(rawUrl = '') {
  const input = String(rawUrl || '').trim();
  if (!input) return false;
  try {
    const parsed = new URL(input);
    return parsed.hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return /api\.openai\.com/i.test(input);
  }
}

function hasCustomProviderConfig(config = {}) {
  const modelProvider = String(config.modelProvider || '').trim().toLowerCase();
  if (modelProvider && modelProvider !== 'openai' && modelProvider !== 'oss') return true;
  if (config.providerBaseUrl && !isOpenAIBaseUrl(config.providerBaseUrl)) return true;
  return false;
}

function isLikelyProviderTransportFailure(message = '') {
  const lower = String(message || '').toLowerCase();
  return (
    /reconnecting|channel closed|failed to record rollout items|stream disconnected|error sending request for url/.test(lower)
    || /network|fetch failed|socket hang up|getaddrinfo|econn|enotfound|ehostunreach|enetunreach|tls|proxy/.test(lower)
    || /timeout|timed out|deadline exceeded|http 5\d\d/.test(lower)
  );
}

function buildOpenAIFallbackArgs(baseArgs = []) {
  const args = Array.isArray(baseArgs) ? baseArgs.slice() : [];
  // Avoid carrying custom-provider model slug into OpenAI fallback.
  const modelIdx = args.indexOf('--model');
  if (modelIdx >= 0) args.splice(modelIdx, 2);
  args.push('-c', 'model_provider="openai"');
  args.push('-c', 'openai_base_url="https://api.openai.com/v1"');
  const fallbackModel = String(process.env.GATEWAY_CODEX_OPENAI_FALLBACK_MODEL || '').trim();
  if (fallbackModel) args.push('-c', `model="${fallbackModel}"`);
  return args;
}

function shouldTryOpenAIFallback(message = '', config = {}, options = {}) {
  const enabled = String(
    process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED
    || process.env.GATEWAY_CODEX_PROVIDER_FALLBACK_OPENAI
    || 'true'
  ).toLowerCase() !== 'false';
  if (!enabled) return false;
  if (options && options.disableProviderFallback) return false;
  if (!hasCustomProviderConfig(config)) return false;
  return isLikelyProviderTransportFailure(message);
}

function resolveExecTimeoutMs(options = {}) {
  const envTimeout = parseInt(
    process.env.GATEWAY_CODEX_TIMEOUT_MS
    || process.env.KHY_CODEX_TIMEOUT_MS
    || String(DEFAULT_IDLE_TIMEOUT_MS),
    10
  ) || DEFAULT_IDLE_TIMEOUT_MS;
  const hasExplicitTimeout = options.timeoutMs !== undefined && options.timeoutMs !== null && options.timeoutMs !== '';
  let timeoutMs = hasExplicitTimeout
    ? parseInt(options.timeoutMs, 10)
    : envTimeout;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = envTimeout;
  timeoutMs = Math.max(15000, timeoutMs);

  const modelHint = String(options.model || '').toLowerCase();
  const maxTokens = parseInt(options.maxTokens || 0, 10) || 0;
  const highComplexity = !!options.thinking
    || maxTokens >= 4096
    || /claude-opus|opus|gpt-5|o3|o4|reason/i.test(modelHint);

  // For high-effort/high-context requests, avoid premature 45s class timeouts.
  if (!hasExplicitTimeout && highComplexity) {
    timeoutMs = Math.max(timeoutMs, 120000);
  }

  const maxTimeout = Math.max(
    30000,
    parseInt(process.env.GATEWAY_CODEX_MAX_TIMEOUT_MS || '86400000', 10) || 86400000
  );
  timeoutMs = Math.min(timeoutMs, maxTimeout);
  return timeoutMs;
}

function probeCodexVersion() {
  try {
    const r = spawnSync('codex', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
      env: process.env,
    });
    if (r && !r.error && r.status === 0) {
      const out = compactText((r.stdout || r.stderr || '').trim(), 120) || 'ok';
      return { ok: true, detail: out };
    }
    if (r && r.error) return { ok: false, detail: compactText(r.error.message || String(r.error), 120) || 'probe error' };
    return { ok: false, detail: compactText(`exit ${r?.status}`, 120) };
  } catch (err) {
    return { ok: false, detail: compactText(err && err.message ? err.message : String(err), 120) || 'probe exception' };
  }
}

function diagnoseReconnectFailure(errMessage = '') {
  const parts = [];
  const versionProbe = probeCodexVersion();
  parts.push(versionProbe.ok ? `codex=${versionProbe.detail}` : `codex_probe=${versionProbe.detail}`);

  const execUsable = probeExecUsable(true);
  if (!execUsable) {
    parts.push(`exec_probe=${compactText(_lastExecProbeError || 'unavailable', 120)}`);
  } else {
    parts.push('exec_probe=ok');
  }

  const config = readCodexConfig() || {};
  if (config.model) parts.push(`config_model=${compactText(config.model, 64)}`);
  if (config.profile) parts.push(`profile=${compactText(config.profile, 64)}`);
  if (config.providerBaseUrl) parts.push(`provider=${compactText(config.providerBaseUrl, 96)}`);
  if (/sandbox/i.test(String(errMessage || ''))) parts.push('hint=retry_no_sbx');

  return compactText(parts.join('; '), 320);
}

function maybeSelfHealReconnect(options = {}) {
  const autoHealEnabled = String(
    process.env.GATEWAY_CODEX_AUTO_DISABLE_SANDBOX_ON_RECONNECT || 'true'
  ).toLowerCase() !== 'false';
  if (!autoHealEnabled) return false;

  const current = String(process.env.GATEWAY_CODEX_SANDBOX || 'workspace-write').trim().toLowerCase();
  if (!current || current === 'none') return false;

  process.env.GATEWAY_CODEX_SANDBOX = 'none';
  safeEmitStatus(options, 'Codex 自愈: 已临时禁用 sandbox（仅当前进程），后续请求将自动重试该模式');
  return true;
}

function hasMeaningfulPlainOutput(chunk) {
  return !!compactText(chunk, 200);
}

/**
 * Parse codex config.toml to extract configured model and provider info.
 */
function readCodexConfig() {
  if (_configCache) return _configCache;
  const homeDir = require('os').homedir();
  const candidates = [
    path.join(homeDir, '.codex', 'config.toml'),
    path.join(homeDir, '.config', 'codex', 'config.toml'),
  ];
  for (const configPath of candidates) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const content = fs.readFileSync(configPath, 'utf-8');
      const result = { model: null, profile: null, modelProvider: null, providerBaseUrl: null, modelContextWindow: null, modelReasoningEffort: null };

      // Extract top-level model
      result.model = extractQuotedValue(content, 'model') || null;

      // Extract profile
      result.profile = extractQuotedValue(content, 'profile') || null;
      result.modelProvider = extractQuotedValue(content, 'model_provider') || null;
      // Codex-native context window declaration (bare integer). Lets the user
      // pin the real window in config.toml without any code change — the
      // anti-hardcode source of truth.
      result.modelContextWindow = extractNumericValue(content, 'model_context_window');
      // Codex-native reasoning effort (quoted string: minimal/low/medium/high/xhigh).
      // codex CLI reads this from config.toml directly — KHY does not override it —
      // so it is the real effort the model uses when the codex adapter is active.
      result.modelReasoningEffort = extractQuotedValue(content, 'model_reasoning_effort') || null;

      // Extract profile-specific settings (override top-level)
      if (result.profile) {
        const profileSection = parseTomlSection(content, `profiles.${result.profile}`);
        const pModel = extractQuotedValue(profileSection, 'model');
        if (pModel) result.model = pModel;
        const pProvider = extractQuotedValue(profileSection, 'model_provider');
        if (pProvider) result.modelProvider = pProvider;
        const pCtx = extractNumericValue(profileSection, 'model_context_window');
        if (pCtx) result.modelContextWindow = pCtx;
        const pEffort = extractQuotedValue(profileSection, 'model_reasoning_effort');
        if (pEffort) result.modelReasoningEffort = pEffort;
      }

      // Extract provider base_url (prefer selected provider section)
      if (result.modelProvider) {
        const providerSection = (
          parseTomlSection(content, `model_providers.${result.modelProvider}`)
          || parseTomlSection(content, `providers.${result.modelProvider}`)
        );
        const providerUrl = extractQuotedValue(providerSection, 'base_url');
        if (providerUrl) result.providerBaseUrl = providerUrl;
      }
      if (!result.providerBaseUrl) {
        const providerMatch = content.match(/base_url\s*=\s*"([^"]+)"/);
        if (providerMatch) result.providerBaseUrl = providerMatch[1];
      }

      _configCache = result;
      return result;
    } catch { /* ignore */ }
  }
  _configCache = {};
  return _configCache;
}

function commandExists(cmd) {
  // Shared TTL availability cache: the gateway re-probes availability several
  // times per turn (preflight + getStatus + re-detect, all via `detect(true)`),
  // and each raw `spawnSync('<cmd> --version')` blocks the event loop. Routing
  // through the cache collapses that storm while still surfacing the probe error
  // for diagnostics via `_lastDetectError`.
  const result = require('./_commandAvailability').check(cmd);
  _lastDetectError = result.ok ? '' : (result.error || '');
  return result.ok;
}

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  // Direct mode only needs CODEX_API_KEY (or pool key), no CLI binary required
  if (CODEX_MODE === 'direct') {
    _available = !!extractPrimaryApiKey(process.env.CODEX_API_KEY);
    if (!_available) {
      try {
        const pool = require('../../apiKeyPool');
        pool.init();
        _available = pool.hasAvailableKeys('codex') || pool.hasAvailableKeys('openai');
      } catch { /* pool unavailable */ }
    }
    _lastDetectError = _available ? '' : 'CODEX_API_KEY not set and no pool keys';
    return _available;
  }
  _available = commandExists('codex');
  // Portable-first: a codex under ~/.khy/tools (or KHY_CODEX_BIN) is off PATH, so
  // commandExists misses it — count a portable install as available too.
  if (!_available && _portableCodexInstalled()) _available = true;
  if (forceRefresh) {
    _execProbeOk = null;
    _lastExecProbeError = '';
  }
  return _available;
}

/**
 * Async detection. Direct mode is key-only (no spawn) so it stays synchronous;
 * CLI mode routes the `codex --version` existence probe through execFile (not
 * spawnSync) so the gateway's parallel init never freezes the event loop —
 * keeping the TUI responsive at startup instead of stalling for the probe
 * latency. Detection outcome is identical to detect(); only the probe is async.
 */
async function detectAsync(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  if (CODEX_MODE === 'direct') return detect(forceRefresh);
  const result = await require('./_commandAvailability').checkAsync('codex', { force: forceRefresh });
  _lastDetectError = result.ok ? '' : (result.error || '');
  _available = result.ok;
  if (forceRefresh) {
    _execProbeOk = null;
    _lastExecProbeError = '';
  }
  return _available;
}

function probeExecUsable(forceRefresh = false) {
  if (!forceRefresh && _execProbeOk !== null) return _execProbeOk;
  try {
    const r = spawnSync('codex', ['exec', '--help'], {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
      env: process.env,
    });
    if (r && !r.error && r.status === 0) {
      _execProbeOk = true;
      _lastExecProbeError = '';
      return true;
    }
    if (r && r.error) {
      _lastExecProbeError = r.error.message || String(r.error);
    } else {
      _lastExecProbeError = `codex exec --help exit ${r?.status}`;
    }
    _execProbeOk = false;
    return false;
  } catch (err) {
    _lastExecProbeError = err.message || String(err);
    _execProbeOk = false;
    return false;
  }
}

function resolveUpstreamProviderMeta(config = {}) {
  const provider = String(config.modelProvider || '').trim() || 'openai';
  const rawBaseUrl = String(config.providerBaseUrl || '').trim();
  if (!rawBaseUrl) return { provider, host: '' };
  try {
    const u = new URL(rawBaseUrl);
    return { provider, host: u.host || u.hostname || rawBaseUrl };
  } catch {
    return { provider, host: rawBaseUrl };
  }
}

async function listModels() {
  const config = readCodexConfig();
  const configModel = config.model;
  const upstreamMeta = resolveUpstreamProviderMeta(config);
  const transportMode = CODEX_MODE === 'direct' ? 'direct' : 'bridge';

  // Try to fetch models from the provider's API
  if (config.providerBaseUrl) {
    try {
      const envKey = extractPrimaryApiKey(process.env.CODEX_API_KEY)
        || extractPrimaryApiKey(process.env.OPENAI_API_KEY)
        || '';
      if (envKey) {
        const https = require('https');
        const http = require('http');
        const url = new URL(`${config.providerBaseUrl}/models`);
        const client = url.protocol === 'https:' ? https : http;
        const models = await new Promise((resolve, reject) => {
          const req = client.get(url, { headers: { Authorization: `Bearer ${envKey}` }, timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                resolve((parsed.data || []).map(m => ({
                  id: m.id,
                  name: m.id,
                  isDefault: m.id === configModel,
                  provider: 'codex',
                  description: '',
                  // Carry the provider-reported context window when present so the
                  // gateway caches REAL data instead of a static guess. Config
                  // model_context_window wins for the configured model.
                  contextWindow:
                    (m.id === configModel ? config.modelContextWindow : 0)
                    || m.context_length || m.context_window || m.max_context_window_tokens
                    || undefined,
                  discoverySource: 'remote',
                  connectionMode: transportMode,
                  upstreamProvider: upstreamMeta.provider,
                  upstreamHost: upstreamMeta.host,
                })));
              } catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
        });
        if (models && models.length > 0) {
          _providerModels = new Set(models.map(m => m.id));
          return models;
        }
      }
    } catch { /* fallback below */ }
  }

  // Fallback: use config model + known defaults
  if (configModel) {
    return [
      {
        id: configModel,
        name: configModel,
        isDefault: true,
        provider: 'codex',
        description: '',
        // Sourced from codex config.toml model_context_window when set; omitted
        // otherwise so the gateway → ai.js family fallback decides (not hardcoded here).
        contextWindow: config.modelContextWindow || undefined,
        discoverySource: 'config',
        connectionMode: transportMode,
        upstreamProvider: upstreamMeta.provider,
        upstreamHost: upstreamMeta.host,
      },
      ...FALLBACK_MODELS
        .filter(m => m.id !== configModel)
        .map(m => ({
          ...m,
          isDefault: false,
          provider: 'codex',
          description: '',
          discoverySource: 'builtin',
          connectionMode: transportMode,
          upstreamProvider: upstreamMeta.provider,
          upstreamHost: upstreamMeta.host,
        })),
    ];
  }

  return FALLBACK_MODELS.map(m => ({
    ...m,
    provider: 'codex',
    description: '',
    discoverySource: 'builtin',
    connectionMode: transportMode,
    upstreamProvider: upstreamMeta.provider,
    upstreamHost: upstreamMeta.host,
  }));
}

function isUserModelAllowed(modelId, config = {}) {
  const chosen = String(modelId || '').trim();
  if (!chosen) return false;
  if (chosen === config.model) return true;
  // If provider model catalog is not loaded yet, optimistically allow user-selected model.
  // Unknown-model failures are already handled by retry logic without --model.
  if (!_providerModels || _providerModels.size === 0) return true;
  return _providerModels.has(chosen);
}

function buildCliPrompt(prompt, options = {}) {
  const raw = String(prompt || '');
  const system = String(options.system || '').trim();
  const messages = Array.isArray(options.messages) ? options.messages : [];
  if (!system && messages.length === 0) return raw;

  // Codex CLI mode only gets a single flattened stdin prompt. Prepend a compact
  // reminder so the highest-priority KHY language rule remains salient even when
  // the flattened conversation contains older compat instruction text.
  const parts = [
    '[KHY PRIORITY DIRECTIVE]',
    '- Follow the highest-priority KHY project instructions first.',
    '- If KHY project instructions define language behavior, they override lower-priority compat files.',
    '- In this workspace, default to Chinese for user-facing replies unless the user explicitly requests another language.',
  ];

  // Extract critical behavioral directives from the system prompt.
  // The full system prompt is too large for CLI stdin, but lightweight
  // conversation directives (joke format, language rules) must survive
  // or the model falls back to its built-in English code-review behavior.
  const lightweightMatch = system.match(/# 轻量对话[^\n]*\n[\s\S]*?(?=\n#\s|\n\n#|$)/);
  if (lightweightMatch) {
    parts.push('');
    parts.push(lightweightMatch[0].trim());
  }
  const languageMatch = system.match(/# Language\n[^\n]+(?:\n[^\n#]+)*/);
  if (languageMatch) {
    parts.push('');
    parts.push(languageMatch[0].trim());
  }

  let contentToText = (content) => String(content || '');
  try { contentToText = require('../../contentBlockUtils').contentToText; } catch { /* fallback */ }

  const normalizeCliLine = (value, maxLen = 1200) => {
    return compactText(String(value || '').replace(/\s+/g, ' ').trim(), maxLen);
  };

  const recentConversationLines = [];
  if (messages.length > 0) {
    const recentMessages = messages.slice(-6);
    for (const message of recentMessages) {
      const role = String(message?.role || '').trim().toLowerCase();
      if (!role || role === 'system') continue;
      const text = normalizeCliLine(contentToText(message?.content), 1600);
      if (!text) continue;
      const label = role === 'assistant'
        ? 'Assistant'
        : (role === 'user' ? 'User' : role);
      recentConversationLines.push(`- ${label}: ${text}`);
    }
  }

  let latestUserRequest = '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message?.role || '').trim().toLowerCase() !== 'user') continue;
    const text = normalizeCliLine(contentToText(message?.content), 4000);
    if (!text) continue;
    latestUserRequest = text;
    break;
  }
  if (!latestUserRequest) {
    latestUserRequest = normalizeCliLine(raw, 4000);
  }

  if (recentConversationLines.length > 0) {
    parts.push('');
    parts.push('# Recent Conversation');
    parts.push(recentConversationLines.join('\n'));
  }
  if (latestUserRequest) {
    parts.push('');
    parts.push('# Current Request');
    parts.push(latestUserRequest);
  } else if (raw) {
    parts.push('');
    parts.push('# Raw Prompt Fallback');
    parts.push(normalizeCliLine(raw, 4000));
  }

  return parts.join('\n').trim();
}

function runCodexExec(prompt, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = resolveExecTimeoutMs(options);
    const idleTimeoutMs = resolveExecIdleTimeoutMs(options);
    const firstResponseTimeoutMs = resolveExecFirstResponseTimeoutMs(options);
    const abortSignal = options.abortSignal || null;

    const isWin = process.platform === 'win32';
    // Spawn preflight (active bypass): when codex HOME is inside a temp dir it is
    // the known cause of reconnect/handshake failures (helper binaries / TLS).
    // Probe writability up front so an obviously-broken environment fails fast
    // instead of paying the spawn + full first-response window. Only the
    // temp-home case is probed to avoid false positives on normal homes.
    const homeContext = getCodexHomeContext();
    if (homeContext.isTempHome) {
      let homeWritable = true;
      try {
        const probe = path.join(homeContext.homeDir, `.khy-codex-preflight-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
      } catch {
        homeWritable = false;
      }
      let preflight = { ok: true };
      try {
        preflight = require('../codexStallPolicy').evaluateSpawnPreflight({
          homeDir: homeContext.homeDir,
          homeWritable,
        });
      } catch { preflight = { ok: true }; }
      if (!preflight.ok) {
        appendCodexExecDebugLog('spawn_preflight_failed', {
          code: preflight.code || 'preflight_failed',
          home: homeContext.homeDir,
        });
        const err = new Error(appendTempHomeHint(
          `codex spawn preflight failed: ${preflight.reason || preflight.code}`,
          homeContext
        ));
        err.code = 'CODEX_SPAWN_PREFLIGHT_FAILED';
        err.codexPreflightCode = preflight.code || 'preflight_failed';
        try {
          if (options.onChunk) {
            options.onChunk({ type: 'status', text: `Codex 预检失败，跳过启动: ${preflight.reason || preflight.code}` });
          }
        } catch { /* best effort */ }
        reject(err);
        return;
      }
    }
    // win32: codex.cmd is a shim — invoke via cmd.exe explicitly instead of
    // shell:true. An args array + shell:true triggers Node DEP0190 (deprecation
    // warning leaks to the terminal); this form is equivalent without it.
    // Portable-first: resolvePortableSpawn returns a `node <entry>` spec when a
    // portable codex is installed under ~/.khy/tools (fixes Windows ENOENT);
    // gate off / not installed → byte-equivalent cmd.exe/codex fallback.
    const _fbCmd = isWin ? (process.env.COMSPEC || 'cmd.exe') : 'codex';
    const _fbArgs = isWin ? ['/d', '/s', '/c', 'codex.cmd', ...args] : args;
    const _sp = _portableCodexSpawn(args, _fbCmd, _fbArgs);
    const child = spawn(
      _sp.command,
      _sp.args,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        windowsHide: isWin,
      },
    );
    appendCodexExecDebugLog('spawn', {
      pid: child?.pid || '',
      json: args.includes('--json') ? '1' : '0',
      timeout_ms: timeoutMs,
      idle_timeout_ms: idleTimeoutMs,
      first_response_timeout_ms: firstResponseTimeoutMs,
      args: args.join(' '),
    });

    if (options.onChunk) {
      try { options.onChunk({ type: 'status', text: 'Codex 启动中...' }); } catch { /* best effort */ }
      if (idleTimeoutMs > 120000) {
        try { options.onChunk({ type: 'status', text: `Codex 已启用延长空闲等待窗口：${Math.round(idleTimeoutMs / 1000)}s` }); } catch { /* best effort */ }
      }
    }

    const jsonMode = args.includes('--json');
    let stdout = '';
    let stdoutBuffer = '';
    // 跨 chunk 边界安全的 UTF-8 解码器:防 CLI 输出的中文/emoji 被劈成 U+FFFD(◆)。见 _sseTextDecoder.js。
    const _textDecoder = require('./_sseTextDecoder').createSseTextDecoder();
    let stderr = '';
    const state = {
      finalParts: [],
      toolCalls: 0,
      toolDurationMs: 0,
      activeTools: new Map(),
      fileOps: [],  // Track file operations for completion panel
    };
    const progressEvidence = createCodexProgressEvidence();
    let finished = false;
    let heartbeatTimer = null;
    let idleTimer = null;
    let firstResponseTimer = null;
    let killedByIdleTimeout = false;
    let killedByFirstResponseTimeout = false;
    let firstResponseTimeoutError = null;
    let sawTransientTransportWarning = false;
    let lastTransientTransportMessage = '';
    let lastActivityAt = Date.now();
    let sawMeaningfulResponseOutput = false;
    const killChild = (signal = 'SIGKILL', escalateMs = signal === 'SIGTERM' ? 1500 : 0) => {
      appendCodexExecDebugLog('kill', {
        pid: child?.pid || '',
        signal,
        escalate_ms: escalateMs,
      });
      // Some mocked or transient child-process objects may not expose pid yet.
      // In that case, call child.kill directly as a best-effort fallback.
      if ((!child || !child.pid) && child && typeof child.kill === 'function') {
        try { child.kill(signal); return; } catch { /* continue to safeKill */ }
      }
      safeKill(child, signal, escalateMs);
    };
    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const clearFirstResponseTimer = () => {
      if (firstResponseTimer) {
        clearTimeout(firstResponseTimer);
        firstResponseTimer = null;
      }
    };
    const scheduleIdleTimeout = () => {
      if (finished || killedByIdleTimeout) return;
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        if (finished || killedByIdleTimeout) return;
        const idleMs = Date.now() - lastActivityAt;
        killedByIdleTimeout = true;
        try {
          if (options.onChunk) {
            options.onChunk({
              type: 'status',
              text: `Codex idle timeout: no subprocess output for ${Math.round(idleMs / 1000)}s, stopping request`,
            });
          }
        } catch { /* best effort */ }
        killChild('SIGTERM', 1500);
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    const touchActivity = () => {
      lastActivityAt = Date.now();
      scheduleIdleTimeout();
    };
    const markMeaningfulResponseOutput = () => {
      if (sawMeaningfulResponseOutput) return;
      sawMeaningfulResponseOutput = true;
      clearFirstResponseTimer();
      appendCodexExecProgressLog('meaningful_output', progressEvidence);
    };

    let abortWatcher = null;
    const done = (err, value) => {
      if (finished) return;
      finished = true;
      clearIdleTimer();
      clearFirstResponseTimer();
      clearInterval(heartbeatTimer);
      if (abortWatcher && abortSignal && typeof abortSignal.removeEventListener === 'function') {
        try { abortSignal.removeEventListener('abort', abortWatcher); } catch { /* ignore */ }
      }
      appendCodexExecDebugLog('done', err
        ? {
            outcome: 'reject',
            error_code: err.code || '',
            error_name: err.name || '',
            error: err.message || String(err),
          }
        : {
            outcome: 'resolve',
            content_len: String(value?.content || '').length,
            tool_calls: Number(value?.toolSummary?.totalCalls || 0),
          });
      if (err) reject(err);
      else resolve(value);
    };

    const abortChild = (reason) => {
      const err = new Error(`codex request aborted: ${normalizeAbortReason(reason)}`);
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      killChild('SIGKILL');
      done(err);
    };

    if (abortSignal && abortSignal.aborted) {
      appendCodexExecDebugLog('abort_preflight', {
        reason: normalizeAbortReason(abortSignal.reason),
      });
      abortChild(abortSignal.reason);
      return;
    }

    if (abortSignal && typeof abortSignal.addEventListener === 'function') {
      abortWatcher = () => {
        appendCodexExecDebugLog('abort_signal', {
          reason: normalizeAbortReason(abortSignal.reason),
        });
        abortChild(abortSignal.reason);
      };
      abortSignal.addEventListener('abort', abortWatcher, { once: true });
    }

    const startedAt = Date.now();
    const heartbeatIntervalMs = Math.max(
      3000,
      parseInt(process.env.GATEWAY_CODEX_HEARTBEAT_MS || '10000', 10) || 10000
    );
    heartbeatTimer = setInterval(() => {
      if (finished || !options.onChunk) return;
      const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      try { options.onChunk({ type: 'status', text: `等待 OpenAI Codex 流式输出（已等待 ${elapsedSec}s）` }); } catch { /* best effort */ }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    scheduleIdleTimeout();
    appendCodexExecDebugLog('first_response_timer_armed', {
      timeout_ms: firstResponseTimeoutMs,
    });
    firstResponseTimer = setTimeout(() => {
      if (finished || killedByFirstResponseTimeout || sawMeaningfulResponseOutput) return;
      killedByFirstResponseTimeout = true;
      const progressSummary = formatCodexProgressEvidence(progressEvidence);
      firstResponseTimeoutError = createCodexProgressTimeoutError(
        `codex first response timeout after ${firstResponseTimeoutMs}ms without meaningful model progress`,
        progressEvidence
      );
      try {
        if (options.onChunk) {
          options.onChunk({
            type: 'status',
            text: progressSummary
              ? `Codex first response timeout: no meaningful model progress for ${Math.round(firstResponseTimeoutMs / 1000)}s, stopping request, ${progressSummary}`
              : `Codex first response timeout: no meaningful model progress for ${Math.round(firstResponseTimeoutMs / 1000)}s, stopping request`,
          });
        }
      } catch { /* best effort */ }
      appendCodexExecProgressLog('first_response_timeout_fired', progressEvidence, {
        timeout_ms: firstResponseTimeoutMs,
      });
      killChild('SIGTERM', 1500);
      // Do not wait for the child "close" event here: some codex launches can
      // ignore/lag process teardown after SIGTERM, which would keep the outer
      // gateway request pending and hide the adapter-level timeout evidence.
      done(firstResponseTimeoutError);
    }, firstResponseTimeoutMs);
    firstResponseTimer.unref?.();

    // Active bypass (within-request): a GENUINE reconnect loop (multiple
    // transport warnings with zero meaningful model output) means the transport
    // is dead. Fire the first-response timeout early instead of burning the full
    // window. A single startup reconnect hiccup must NOT bail (normal startup
    // noise — see gatewayAdapters.stability.test.js "keeps first-response
    // timeout armed for startup noise"), so the threshold is strictly > 1.
    const reconnectLoopBailThreshold = Math.max(
      2,
      parseInt(process.env.GATEWAY_CODEX_RECONNECT_BAIL_THRESHOLD || '3', 10) || 3
    );
    const maybeEarlyBailOnReconnectLoop = () => {
      if (finished || killedByFirstResponseTimeout || sawMeaningfulResponseOutput) return;
      let bail = false;
      try {
        const snapshot = snapshotCodexProgressEvidence(progressEvidence);
        bail = require('../codexStallPolicy').shouldEarlyBailOnReconnectLoop(snapshot, {
          threshold: reconnectLoopBailThreshold,
        });
      } catch { bail = false; }
      if (!bail) return;
      killedByFirstResponseTimeout = true;
      const progressSummary = formatCodexProgressEvidence(progressEvidence);
      firstResponseTimeoutError = createCodexProgressTimeoutError(
        `codex first response bypass: reconnect loop (>= ${reconnectLoopBailThreshold} transport warnings) without meaningful model progress`,
        progressEvidence
      );
      try {
        if (options.onChunk) {
          options.onChunk({
            type: 'status',
            text: progressSummary
              ? `Codex reconnect loop detected, bypassing without waiting full window, ${progressSummary}`
              : 'Codex reconnect loop detected, bypassing without waiting full window',
          });
        }
      } catch { /* best effort */ }
      appendCodexExecProgressLog('reconnect_loop_early_bail', progressEvidence, {
        threshold: reconnectLoopBailThreshold,
      });
      killChild('SIGTERM', 1500);
      done(firstResponseTimeoutError);
    };

    child.stdout.on('data', (chunk) => {
      touchActivity();
      if (stdout.length < MAX_BUFFER) stdout += chunk;
      const text = _textDecoder.write(chunk);
      if (!jsonMode) {
        if (hasMeaningfulPlainOutput(text)) {
          recordCodexProgressEvent(progressEvidence, {
            channel: 'stdout',
            kind: 'plain_output',
            summary: text,
            stage: 'plain_output',
            meaningful: true,
          });
          markMeaningfulResponseOutput();
        }
        if (options.onChunk) options.onChunk({ type: 'text', text });
        return;
      }
      stdoutBuffer += text;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let event = null;
        try { event = JSON.parse(line); } catch { /* non-JSON line from CLI wrapper */ }
        if (event && typeof event === 'object') {
          if (emitCodexEvent(event, state, options, progressEvidence, 'stdout_json')) markMeaningfulResponseOutput();
          else maybeEarlyBailOnReconnectLoop();
        } else if (/reconnecting|channel closed|failed to record rollout items/i.test(line)) {
          recordCodexProgressEvent(progressEvidence, {
            channel: 'stdout',
            kind: 'transport_warning',
            summary: line,
            reconnectWarning: true,
          });
          if (options.onChunk) options.onChunk({ type: 'status', text: line });
          maybeEarlyBailOnReconnectLoop();
        } else if (hasMeaningfulPlainOutput(line)) {
          recordCodexProgressEvent(progressEvidence, {
            channel: 'stdout',
            kind: 'plain_output',
            summary: line,
            stage: 'plain_output',
            meaningful: true,
          });
          markMeaningfulResponseOutput();
        }
      }
    });
    // Codex CLI may output JSON events to stderr (same pattern as Claude CLI >= 2.x).
    // Parse JSON lines from stderr; accumulate non-JSON as plain error text.
    let stderrJsonBuffer = '';
    child.stderr.on('data', (chunk) => {
      touchActivity();
      const raw = chunk.toString();
      stderrJsonBuffer += raw;
      const stderrLines = stderrJsonBuffer.split('\n');
      stderrJsonBuffer = stderrLines.pop();
      for (const line of stderrLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (jsonMode && trimmed.startsWith('{')) {
          try {
            const event = JSON.parse(trimmed);
            if (event && typeof event === 'object' && typeof event.type === 'string') {
              if (emitCodexEvent(event, state, options, progressEvidence, 'stderr_json')) markMeaningfulResponseOutput();
              else maybeEarlyBailOnReconnectLoop();
              continue;
            }
          } catch { /* not valid JSON, fall through */ }
        }
        // Non-JSON stderr — accumulate for error diagnostics
        if (stderr.length < MAX_BUFFER) stderr += trimmed + '\n';
        recordCodexProgressEvent(progressEvidence, {
          channel: 'stderr',
          kind: isReconnectChannelClosed(trimmed) ? 'transport_warning' : 'stderr',
          summary: trimmed,
          stage: 'stderr_output',
          reconnectWarning: isReconnectChannelClosed(trimmed),
        });
        if (isReconnectChannelClosed(trimmed)) {
          sawTransientTransportWarning = true;
          lastTransientTransportMessage = compactText(trimmed, 220) || 'codex transport issue during rollout recording';
          safeEmitStatus(options, `Codex transport issue detected, waiting for recovery: ${lastTransientTransportMessage}`);
          maybeEarlyBailOnReconnectLoop();
        }
      }
    });

    child.on('close', (code) => {
      appendCodexExecDebugLog('close', {
        code,
        killed_by_idle: killedByIdleTimeout ? '1' : '0',
        killed_by_first_response: killedByFirstResponseTimeout ? '1' : '0',
      });
      // Drain trailing stdout JSON buffer
      if (jsonMode && stdoutBuffer.trim()) {
        try {
          const evt = JSON.parse(stdoutBuffer.trim());
          emitCodexEvent(evt, state, options, progressEvidence, 'stdout_json');
        } catch { /* ignore trailing partial */ }
      }
      // Drain trailing stderr buffer.
      // Important: some codex builds emit a single stderr line without trailing
      // newline, so we must not drop this tail on process close.
      const trailingStderr = stderrJsonBuffer.trim();
      if (trailingStderr) {
        let consumedAsJson = false;
        if (jsonMode && trailingStderr.startsWith('{')) {
          try {
            const evt = JSON.parse(trailingStderr);
            if (evt && typeof evt === 'object' && typeof evt.type === 'string') {
              if (emitCodexEvent(evt, state, options, progressEvidence, 'stderr_json')) markMeaningfulResponseOutput();
              consumedAsJson = true;
            }
          } catch { /* fall through and treat as plain stderr text */ }
        }
        if (!consumedAsJson) {
          if (stderr.length < MAX_BUFFER) stderr += `${trailingStderr}\n`;
          recordCodexProgressEvent(progressEvidence, {
            channel: 'stderr',
            kind: isReconnectChannelClosed(trailingStderr) ? 'transport_warning' : 'stderr',
            summary: trailingStderr,
            stage: 'stderr_output',
            reconnectWarning: isReconnectChannelClosed(trailingStderr),
          });
          if (isReconnectChannelClosed(trailingStderr)) {
            sawTransientTransportWarning = true;
            lastTransientTransportMessage = compactText(trailingStderr, 220) || 'codex transport issue during rollout recording';
          }
        }
      }

      if (killedByIdleTimeout) {
        done(new Error(`codex idle timeout after ${idleTimeoutMs}ms without subprocess output`));
        return;
      }
      if (killedByFirstResponseTimeout) {
        done(firstResponseTimeoutError || createCodexProgressTimeoutError(
          `codex first response timeout after ${firstResponseTimeoutMs}ms without meaningful model progress`,
          progressEvidence
        ));
        return;
      }

      if (code === 0) {
        const content = jsonMode
          ? state.finalParts.join('\n').trim()
          : stdout.trim();
        if (content) {
          done(null, {
            content,
            toolSummary: {
              totalCalls: state.toolCalls,
              totalDurationMs: state.toolDurationMs,
              fileOps: state.fileOps.length > 0 ? state.fileOps : undefined,
            },
          });
          return;
        }
      }
      if (sawTransientTransportWarning && !stderr.trim()) {
        stderr = lastTransientTransportMessage || 'codex transport issue during rollout recording';
      }
      done(new Error(stderr.trim() || `codex exited with code ${code}`));
    });

    child.on('error', (err) => {
      appendCodexExecDebugLog('child_error', {
        error: err?.message || String(err),
      });
      done(err);
    });
    child.stdin.on('error', (err) => {
      appendCodexExecDebugLog('stdin_error', {
        error: err?.message || String(err),
      });
    });
    const cliPrompt = buildCliPrompt(prompt, options);
    appendCodexExecDebugLog('stdin_write', {
      bytes: Buffer.byteLength(cliPrompt),
    });
    child.stdin.write(cliPrompt);
    appendCodexExecDebugLog('stdin_end');
    child.stdin.end();
  });
}

// ═══════════════════════════════════════════════════════════════════
// ── Direct API Mode — call Responses API with KHY tools ──────────
// ═══════════════════════════════════════════════════════════════════

/**
 * HTTP client for Responses API. Supports proxy + abort signal.
 */
function makeDirectRequest(url, body, { timeout = CODEX_DIRECT_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const err = new Error(`codex direct request aborted: ${normalizeAbortReason(signal.reason)}`);
      err.name = 'AbortError';
      reject(err);
      return;
    }

    let settled = false;
    let activeReq = null;
    let connectReq = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      }
      fn(value);
    };
    const finishResolve = (v) => finish(resolve, v);
    const finishReject = (e) => finish(reject, e);
    const onAbort = () => {
      const err = new Error(`codex direct request aborted: ${normalizeAbortReason(signal ? signal.reason : null)}`);
      err.name = 'AbortError';
      try { if (connectReq && !connectReq.destroyed) connectReq.destroy(err); } catch { /* ignore */ }
      try { if (activeReq && !activeReq.destroyed) activeReq.destroy(err); } catch { /* ignore */ }
      finishReject(err);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);

    // Resolve API key: env > apiKeyPool (codex or openai provider)
    let codexApiKey = extractPrimaryApiKey(process.env.CODEX_API_KEY) || '';
    if (!codexApiKey) {
      try {
        const pool = require('../../apiKeyPool');
        pool.init();
        const picked = pool.pick('codex') || pool.pick('openai');
        if (picked) codexApiKey = picked.key;
      } catch { /* pool unavailable */ }
    }

    const headers = {
      'Authorization': `Bearer ${codexApiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };

    const handleResponse = (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const msg = parsed.error?.message || parsed.message || `HTTP ${res.statusCode}`;
            finishReject(new Error(`Codex API error ${res.statusCode}: ${msg}`));
          } else {
            finishResolve(parsed);
          }
        } catch {
          finishReject(new Error(`Codex API: invalid JSON response (HTTP ${res.statusCode})`));
        }
      });
    };

    // Proxy support via shared _proxyTunnel (Phase 2C)
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY ||
                     process.env.http_proxy || process.env.HTTP_PROXY;
    let effectiveProxy = proxyUrl;
    try {
      const sidecar = require('../tlsSidecar');
      if (sidecar.shouldProxy(parsed.hostname)) effectiveProxy = sidecar.getProxyUrl();
    } catch { /* sidecar not available */ }

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
      timeout,
    };

    const sendDirect = () => {
      activeReq = mod.request(reqOptions, handleResponse);
      activeReq.on('error', finishReject);
      activeReq.on('timeout', () => { activeReq.destroy(); finishReject(new Error('request timeout')); });
      activeReq.write(payload);
      activeReq.end();
    };

    if (effectiveProxy && parsed.protocol === 'https:') {
      _sharedConnectProxy(effectiveProxy, parsed.hostname, parsed.port || 443, timeout)
        .then((socket) => {
          activeReq = https.request({ ...reqOptions, socket, agent: false }, handleResponse);
          activeReq.on('error', finishReject);
          activeReq.on('timeout', () => { activeReq.destroy(); finishReject(new Error('request timeout')); });
          activeReq.write(payload);
          activeReq.end();
        })
        .catch(() => { sendDirect(); });
      return;
    }

    sendDirect();
  });
}

/**
 * Build Responses API tool definitions from KHY's native tool registry.
 */
function buildDirectToolDefs() {
  try {
    const { getToolDefinitions } = require('../../toolCalling');
    const defs = getToolDefinitions();
    // PascalCase names only — claudeCompat handles aliases at execution time
    const seen = new Set();
    return defs.filter(d => {
      if (!_CODEX_DIRECT_ALLOWED_TOOLS.has(d.name) || seen.has(d.name)) return false;
      seen.add(d.name);
      return true;
    }).map(d => ({
      type: 'function',
      name: d.name,
      description: d.description || '',
      parameters: d.parameters || { type: 'object', properties: {} },
    }));
  } catch {
    // Fallback: minimal tool set
    return [
      { type: 'function', name: 'Bash', description: 'Execute a shell command', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute' } }, required: ['command'] } },
      { type: 'function', name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute file path' } }, required: ['file_path'] } },
      { type: 'function', name: 'Glob', description: 'Find files by glob pattern', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern like **/*.js' } }, required: ['pattern'] } },
      { type: 'function', name: 'Grep', description: 'Search file contents with regex', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern' }, path: { type: 'string', description: 'Directory to search' } }, required: ['pattern'] } },
      { type: 'function', name: 'Edit', description: 'Edit a file with string replacement', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'File path' }, old_string: { type: 'string', description: 'Text to replace' }, new_string: { type: 'string', description: 'Replacement text' } }, required: ['file_path', 'old_string', 'new_string'] } },
      { type: 'function', name: 'Write', description: 'Write/create a file', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'File content' } }, required: ['file_path', 'content'] } },
      { type: 'function', name: 'web_search', description: 'Search the web for current information (news, docs, prices, etc.)', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query (max 200 chars)' } }, required: ['query'] } },
    ];
  }
}

/**
 * Build system prompt for direct mode — structured function calling.
 *
 * Design principles:
 * - Reuse KHY's assembled system prompt when available so project instructions
 *   (khy.md / CLAUDE.md / AGENTS.md precedence) remain effective in direct mode
 * - Fall back to a compact built-in prompt only when no upstream system prompt exists
 * - ~3K chars — enough context for intelligent behavior, not so much it drowns tool defs
 * - Core rules extracted from HARDCORE (khyUpgradeRuntime.js:7-231), adapted for Responses API
 * - No <tool_call> XML syntax (Direct mode uses native function calling)
 * - No [Plan]/[Summary] tags (ai.js synthesizes lifecycle events)
 */
function buildDirectSystemPrompt(options = {}) {
  const inherited = String(options.system || '').trim();
  if (inherited) {
    // Even with inherited prompt, append thinking instructions if enabled
    if (options.thinking) {
      return inherited + '\n\n' + THINKING_INSTRUCTION;
    }
    return inherited;
  }

  const cwd = process.cwd();
  const platform = process.platform;
  const parts = [
    // ── 1. Role & Capabilities ──
    'You are an expert-level software engineering assistant embedded in KHY OS.',
    'You help users with: code reading/writing/debugging/refactoring, file management,',
    'shell operations, system tasks, and technical analysis.',
    '',

    // ── 2. Core Rules ──
    '# Core Rules',
    '1. ACT IMMEDIATELY. Call tools right away. NEVER ask "shall I proceed?" or "if you agree".',
    '   Do NOT describe what you would do — just do it. No filler, no preamble.',
    '2. Think before acting: understand intent → pick right tool → execute → summarize concisely.',
    '3. Same tool + same params = call only once. Never repeat identical calls.',
    '4. When unsure, say so honestly. Never fabricate file contents or code behavior.',
    '5. On error: diagnose root cause first, then try alternatives. Never retry the same failing call.',
    '6. When asked about code, files, or project structure, ALWAYS use tools first. Never guess.',
    '7. When asked to CREATE a file, you MUST call Write. When asked to MODIFY a file, you MUST call Edit.',
    '8. Keep answers SHORT: 3-5 sentences for simple questions, 8-10 max for complex ones.',
    '9. Respond in the SAME LANGUAGE as the user\'s message. Code/comments stay in English.',
    '',

    // ── 3. Tool Selection ──
    '# Tool Selection (mandatory)',
    '- Find files by name/pattern → Glob (NOT Bash with find/ls)',
    '- Search text inside files → Grep (NOT Bash with grep/rg, NOT Glob-then-Read)',
    '- Read a file → Read (NOT Bash with cat/head/tail)',
    '- Edit a file (exact string replacement) → Edit (NOT Bash with sed/awk)',
    '- Create/overwrite a file → Write (NOT Bash with echo/cat)',
    '- Shell commands (git, npm, build, test, etc.) → Bash',
    '',
    'NEVER use Bash for operations that have a dedicated tool.',
    'If Glob/Grep returns 0 results, try a broader pattern before giving up.',
    'For large files (>300 lines), use Read with offset+limit to read specific sections,',
    'or use Grep to locate the target first. Do NOT read the entire large file.',
    'To find a function definition, use Grep with output_mode "content" — NOT Glob (Glob searches names, not content).',
    '',

    // ── 4. Edit Tool — Critical Rules ──
    '# Edit Tool Rules',
    '- ALWAYS Read the file first before calling Edit. You need exact content.',
    '- old_string must be copied VERBATIM from the Read result — exact whitespace, indentation, line breaks.',
    '- Do NOT include line numbers in old_string (Read shows "N\\t<content>", use only <content>).',
    '- Include enough surrounding context in old_string to make it unique in the file.',
    '- If you need to replace all occurrences, use replace_all: true.',
    '',

    // ── 5. Error Recovery ──
    '# Error Recovery',
    '- File not found → use Glob to search for the correct path, then retry.',
    '- Edit old_string not found → Re-Read the file, copy the exact text, retry.',
    '- Permission denied → inform the user.',
    '- Command failed → read the error, diagnose, try alternative approach.',
    '- NEVER retry the exact same failing call. Always change something.',
    '',

    // ── 6. Code Quality & Safety ──
    '# Code Quality',
    '- Read files before modifying. Never modify code you haven\'t read.',
    '- Prefer editing existing files over creating new ones.',
    '- Before creating a file with Write, check if it already exists using Glob.',
    '- Don\'t add features beyond what was asked. Don\'t over-engineer.',
    '- Be careful with security: no XSS, SQL injection, or command injection.',
    '- For destructive/irreversible actions, confirm with the user first.',
    '',

    // ── 7. Multi-Step Tasks ──
    '# Multi-Step Tasks',
    '- For complex tasks, plan your steps: locate → read → analyze → act → verify.',
    '- For cross-file tasks, use Grep to batch-locate all targets first, then process each.',
    '- Don\'t waste iterations reading files one by one — use Grep for bulk discovery.',
    '',

    // ── 8. Environment ──
    `Working directory: ${cwd}`,
    `Platform: ${platform}`,
  ];

  if (options.thinking) {
    parts.push('', THINKING_INSTRUCTION);
  }

  return parts.join('\n');
}

/**
 * Core agentic loop for direct API mode.
 * Calls the configured Responses API provider, executes tools via KHY's toolCalling, feeds results back.
 * Provider is configurable: codex config.toml > CODEX_DIRECT_BASE_URL > OPENAI_BASE_URL > api.openai.com
 */
async function runCodexDirect(prompt, options = {}) {
  const config = readCodexConfig() || {};
  // Provider-agnostic: resolve base URL from multiple sources
  const baseUrl = config.providerBaseUrl
    || String(process.env.CODEX_DIRECT_BASE_URL || '').trim()
    || String(process.env.OPENAI_BASE_URL || '').trim()
    || 'https://api.openai.com/v1';
  // Validate options.model against known provider models before using it.
  // Gateway's _modelSwitch may inject a model from another adapter (e.g., 'qwen3.5:4b')
  // that the Codex provider doesn't support.
  const defaultModel = String(process.env.CODEX_DIRECT_MODEL || '').trim() || config.model || 'codex-mini';
  let model = defaultModel;
  if (options.model && isUserModelAllowed(options.model, config)) model = options.model;
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;
  const emit = (chunk) => { if (onChunk) { try { onChunk(chunk); } catch { /* best effort */ } } };

  const toolDefs = buildDirectToolDefs();
  const systemPrompt = buildDirectSystemPrompt(options);

  // Build initial input — include images in OpenAI vision format if provided
  const userContent = [{ type: 'input_text', text: prompt }];
  const codexImages = toCodexInputImages(options.images || []);
  if (codexImages.length > 0) {
    // 内联图片旁前置一条说明:图已内联、直接看就行、磁盘上没有对应文件,别用 Read/Glob 当
    // 文件去打开。否则配合下方第一轮 tool_choice 强制,模型会幻觉一个文件名(如
    // sample_inspect.png)去 Read → ENOENT → 继续乱找,做一堆多余的事。单一真源
    // visionDirectTurnPolicy.buildInlineImageNote;门控关 / 叶子不可用 → note 为 null →
    // 不注入,userContent 逐字节回退。
    let _inlineNote = null;
    try {
      _inlineNote = require('../visionDirectTurnPolicy').buildInlineImageNote({ count: codexImages.length });
    } catch { /* 叶子不可用 → 保持原文本 */ }
    if (_inlineNote) userContent[0].text = `${_inlineNote}\n\n${prompt || ''}`;
    for (const imageItem of codexImages) userContent.push(imageItem);
  }
  const input = [
    { type: 'message', role: 'user', content: userContent },
  ];

  const state = {
    finalParts: [],
    toolCalls: 0,
    toolDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  };

  // Dedup: prevent repeated identical tool calls
  const seenCalls = new Set();

  if (process.env.CODEX_DIRECT_DEBUG === '1') {
    emit({ type: 'status', text: `[debug] tools: ${toolDefs.length}, model: ${model}, endpoint: ${baseUrl}` });
    emit({ type: 'status', text: `[debug] tool names: ${toolDefs.map(t => t.name).join(', ')}` });
    emit({ type: 'status', text: `[debug] system prompt length: ${systemPrompt.length} chars` });
  }
  emit({ type: 'status', text: 'Codex Direct 启动中...' });

  for (let iteration = 0; iteration < CODEX_DIRECT_MAX_ITERATIONS; iteration++) {
    emit({ type: 'status', text: `Codex Direct: round ${iteration + 1}` });

    // Force tool invocation on the first round to prevent the model from
    // replying with plain text instructions instead of actually executing tools.
    // Subsequent rounds use "auto" so the model can produce a final text answer
    // once the necessary tool calls are complete.
    // 例外:本轮带内联图片时**不**强制(纯描述/分析请求,纯文本回答才正确;强制会逼模型
    // 幻觉文件名去 Read,做多余事)。单一真源 visionDirectTurnPolicy.shouldForceFirstToolCall;
    // 门控关 / 叶子不可用 → 逐字节回退到「仅第一轮强制」legacy 语义。
    let _forceFirstToolCall = iteration === 0;
    try {
      _forceFirstToolCall = require('../visionDirectTurnPolicy').shouldForceFirstToolCall({
        iteration,
        hasImage: codexImages.length > 0,
      });
    } catch { /* 叶子不可用 → legacy 行为 */ }
    const toolChoice = _forceFirstToolCall ? 'required' : 'auto';

    const requestBody = {
      model,
      instructions: systemPrompt,
      input,
      tools: toolDefs,
      tool_choice: toolChoice,
      max_output_tokens: options.maxTokens || 4096,
      temperature: options.temperature ?? 0.7,
      stream: false,
      reasoning: { summary: 'detailed' },
    };

    // Emit periodic heartbeats during API call to prevent gateway idle timeout
    const reqStart = Date.now();
    const heartbeatInterval = setInterval(() => {
      const elapsed = ((Date.now() - reqStart) / 1000).toFixed(0);
      emit({ type: 'status', text: `Codex Direct: waiting for model response... ${elapsed}s` });
    }, 5000);

    if (process.env.CODEX_DIRECT_DEBUG === '1') {
      const payloadSize = JSON.stringify(requestBody).length;
      emit({ type: 'status', text: `[debug] POST ${baseUrl}/responses, payload: ${payloadSize} bytes, tools: ${toolDefs.length}` });
    }

    let response;
    try {
      response = await makeDirectRequest(
        `${baseUrl}/responses`,
        requestBody,
        { timeout: CODEX_DIRECT_TIMEOUT_MS, signal: options.abortSignal || null },
      );
      if (process.env.CODEX_DIRECT_DEBUG === '1') {
        emit({ type: 'status', text: `[debug] response received in ${((Date.now() - reqStart) / 1000).toFixed(1)}s` });
      }
    } catch (err) {
      emit({ type: 'status', text: `API error (${((Date.now() - reqStart) / 1000).toFixed(1)}s): ${compactText(err.message, 100)}` });
      throw err;
    } finally {
      clearInterval(heartbeatInterval);
    }

    // Debug: log raw response structure for diagnostics
    if (process.env.CODEX_DIRECT_DEBUG === '1') {
      const debugKeys = Object.keys(response || {}).join(', ');
      const outputLen = Array.isArray(response.output) ? response.output.length : 'N/A';
      const textField = typeof response.text === 'string' ? response.text.slice(0, 200) : (response.text ? JSON.stringify(response.text).slice(0, 200) : 'N/A');
      emit({ type: 'status', text: `[debug] keys: ${debugKeys}, output: ${outputLen}, status: ${response.status || 'none'}` });
      emit({ type: 'status', text: `[debug] text field: ${textField}` });
      const toolCount = Array.isArray(response.tools) ? response.tools.length : 'N/A';
      const toolChoice = JSON.stringify(response.tool_choice || 'N/A').slice(0, 100);
      emit({ type: 'status', text: `[debug] tools: ${toolCount}, tool_choice: ${toolChoice}, model: ${response.model || 'N/A'}` });
      if (response.usage) emit({ type: 'status', text: `[debug] usage: in=${response.usage.input_tokens} out=${response.usage.output_tokens}` });
      if (Array.isArray(response.output)) {
        for (const item of response.output.slice(0, 5)) {
          emit({ type: 'status', text: `[debug] item: type=${item.type}, role=${item.role || '-'}, keys=${Object.keys(item).join(',')}` });
        }
      }
    }

    // Note: response.text is a config object (format/verbosity), NOT response content.
    // Content comes from response.output items.

    // Accumulate token usage from this API round
    if (response.usage) {
      state.totalInputTokens += response.usage.input_tokens || 0;
      state.totalOutputTokens += response.usage.output_tokens || 0;
      const { cacheReadInputTokens, cacheWriteInputTokens } = normalizeCacheUsage(response.usage);
      state.totalCacheReadTokens += cacheReadInputTokens;
      state.totalCacheWriteTokens += cacheWriteInputTokens;
    }

    const { textParts, functionCalls, reasoningParts } = parseDirectResponse(response.output);

    // Emit reasoning/thinking content before text
    for (const reasoning of reasoningParts) {
      emit({ type: 'thinking', text: reasoning });
    }

    // Accumulate text
    for (const text of textParts) {
      state.finalParts.push(text);
      emit({ type: 'text', text });
    }

    // Done if no tool calls requested
    // Note: some Responses API providers return status=completed even with function_calls,
    // so we rely on functionCalls.length, not status alone.
    if (functionCalls.length === 0) {
      emit({ type: 'status', text: 'Codex Direct 完成' });
      break;
    }

    // Execute tool calls — auto-approve since the user already approved the AI request.
    // Without this, interactive permission prompts hang in non-interactive/piped mode.
    let toolCalling, claudeCompat;
    try {
      toolCalling = require('../../toolCalling');
      claudeCompat = require('../../claudeCompat');
    } catch (err) {
      emit({ type: 'status', text: 'Tool system unavailable' });
      break;
    }

    // DESIGN-ARCH-047 P3: 隔离注入调用。这些 functionCall 来自外部中转 agent
    // （origin=relay:codex），过去被无条件自动批准执行 —— 调用注入的无人值守执行面。
    // 现改为：隔离闸开启时（默认 ON）**绝不**强开全局 dangerous mode；每个中转调用经
    // quarantinePolicy 裁决，非交互且无批准 → 隔离不执行（fail-CLOSED）。仅当显式
    // `KHY_TRAJECTORY_QUARANTINE=0`（逃生口）时保留旧的自动批准行为以便迁移。
    let quarantinePolicy, riskGate;
    try {
      quarantinePolicy = require('../../trajectoryProvenance/quarantinePolicy');
      riskGate = require('../../riskGate');
    } catch { /* 隔离子系统不可用：退回旧行为（下方按 gateEnabled=false 处理） */ }
    const gateEnabled = quarantinePolicy ? quarantinePolicy.isGateEnabled() : false;
    const interactive = !!(process.stdin && process.stdin.isTTY);
    const relayProducer = 'codex';

    // 仅在逃生口（隔离闸关闭）下沿用旧的全局自动批准；闸开启时不碰全局 dangerous mode。
    const wasDangerous = toolCalling.isDangerousMode();
    const useLegacyAutoApprove = !gateEnabled;
    const willEnableDangerous = useLegacyAutoApprove && !wasDangerous;

    // 防呆④ 不变式：中转 origin + 隔离闸开启 → 严禁自动开启全局 dangerous mode。
    // 当前逻辑下 willEnableDangerous 仅在闸关闭时为真，故正常不触发；此断言锁死「日后
    // 任何改动若让中转调用在闸开启时自动开 dangerous mode」必当场抛错。
    if (quarantinePolicy) {
      quarantinePolicy.assertNoAutoDangerous({ producer: relayProducer, enablingDangerous: willEnableDangerous, gateEnabled });
    }
    if (willEnableDangerous) toolCalling.enableDangerousMode();

    for (const fc of functionCalls) {
      // Dedup check
      const dedupKey = `${fc.name}:${fc.arguments}`;
      if (seenCalls.has(dedupKey)) {
        // Append skip result and continue
        input.push({ type: 'function_call', call_id: fc.call_id, name: fc.name, arguments: fc.arguments });
        input.push({ type: 'function_call_output', call_id: fc.call_id, output: JSON.stringify({ error: 'Duplicate call skipped' }) });
        continue;
      }
      seenCalls.add(dedupKey);

      state.toolCalls++;

      // Parse arguments
      let parsedArgs = {};
      try { parsedArgs = typeof fc.arguments === 'string' ? JSON.parse(fc.arguments) : (fc.arguments || {}); } catch {
        const { safeJsonParse } = require('../safeJsonParse');
        parsedArgs = typeof fc.arguments === 'string' ? safeJsonParse(fc.arguments, {}) : (fc.arguments || {});
      }

      // Normalize tool name/params via claudeCompat
      const normalized = claudeCompat.normalizeToolCall(fc.name, parsedArgs);

      emit({
        type: 'tool_use',
        tool: fc.name,
        input: compactText(JSON.stringify(parsedArgs), 120),
        id: fc.call_id,
      });

      const start = Date.now();
      let result;
      // DESIGN-ARCH-047 P3: 每个中转调用经隔离策略裁决。非交互且无批准 → 隔离不执行
      // （fail-CLOSED），返回 error 工具结果并标 QUARANTINED；绝不静默自动跑。
      let quarantined = false;
      if (quarantinePolicy) {
        let riskLevel;
        try { riskLevel = riskGate && riskGate.assess(normalized.name, normalized.params).riskLevel; } catch { /* 评级仅透明展示 */ }
        const verdict = quarantinePolicy.decide({
          producer: relayProducer,
          interactive,
          preApproved: wasDangerous, // 用户已在更高层批准（既存 dangerous）才算预批准
          gateEnabled,
          riskLevel,
        });
        if (verdict.action === quarantinePolicy.ACTION.QUARANTINE) {
          quarantined = true;
          result = { success: false, error: verdict.reason, _khyTrace: { v: 1, producer: relayProducer, trust: 'quarantined', kind: 'tool_call' } };
          emit({ type: 'status', text: `⚠ quarantined: ${fc.name}（中转调用需批准）` });
        }
      }
      if (!quarantined) {
      try {
        result = await toolCalling.executeTool(normalized.name, normalized.params);
      } catch (err) {
        result = { success: false, error: err.message || 'tool execution failed' };
      }
      }
      const elapsed = Date.now() - start;
      state.toolDurationMs += elapsed;

      // Build output string for the model
      let outputStr;
      if (result && result.success) {
        const content = result.output || result.content || result.result || result.text || 'success';
        outputStr = typeof content === 'string' ? content : JSON.stringify(content);
        // Cap large outputs to prevent context overflow
        if (outputStr.length > 8000) outputStr = outputStr.slice(0, 8000) + '\n...(truncated)';
      } else {
        outputStr = JSON.stringify({ error: (result && result.error) || 'tool execution failed' });
      }

      emit({
        type: 'tool_result',
        id: fc.call_id,
        content: compactText(outputStr, 180),
      });

      // Append function_call + result to input for next API turn
      input.push({ type: 'function_call', call_id: fc.call_id, name: fc.name, arguments: typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments) });
      input.push({ type: 'function_call_output', call_id: fc.call_id, output: outputStr });
    }

    // Restore previous permission mode (only if we enabled it on this pass).
    if (willEnableDangerous) toolCalling.disableDangerousMode();
  }

  const content = state.finalParts.join('\n').trim();
  const hasUsage = state.totalInputTokens > 0 || state.totalOutputTokens > 0;
  return {
    content: content || 'Codex Direct: no response generated',
    toolSummary: {
      totalCalls: state.toolCalls,
      totalDurationMs: state.toolDurationMs,
    },
    tokenUsage: hasUsage ? {
      inputTokens: state.totalInputTokens,
      outputTokens: state.totalOutputTokens,
      totalTokens: state.totalInputTokens + state.totalOutputTokens,
      ...(state.totalCacheReadTokens || state.totalCacheWriteTokens
        ? { cacheReadInputTokens: state.totalCacheReadTokens, cacheWriteInputTokens: state.totalCacheWriteTokens }
        : {}),
    } : undefined,
  };
}

/**
 * Direct mode generate wrapper — same return shape as CLI mode.
 */
async function generateDirect(prompt, options = {}) {
  if (!detect()) {
    return buildFailure(_lastDetectError || 'CODEX_API_KEY not configured', {
      adapter: 'codex',
      provider: 'Codex (direct)',
      errorType: 'auth',
      attempts: [{ provider: 'Codex (direct)', success: false, error: 'CODEX_API_KEY not set' }],
    });
  }

  const config = readCodexConfig() || {};
  // Same model validation as runCodexDirect — don't blindly use gateway-injected model
  const directDefaultModel = String(process.env.CODEX_DIRECT_MODEL || '').trim() || config.model || 'codex-mini';
  let usedModel = directDefaultModel;
  if (options.model && isUserModelAllowed(options.model, config)) usedModel = options.model;

  try {
    if (options.onChunk) {
      try { options.onChunk({ type: 'status', text: `Codex Direct (${usedModel})` }); } catch { /* best effort */ }
    }

    const result = await runCodexDirect(prompt, options);
    return buildSuccess(result.content, {
      adapter: 'codex',
      provider: `Codex Direct (${usedModel})`,
      model: usedModel,
      toolSummary: result.toolSummary,
      tokenUsage: result.tokenUsage || undefined,
      attempts: [{ provider: 'Codex (direct)', success: true }],
    });
  } catch (err) {
    // Use shared error classifier (Phase 2C)
    const errorType = _sharedClassify(err, { statusCode: err?.statusCode });

    return buildFailure(err.message, {
      adapter: 'codex',
      provider: 'Codex (direct)',
      errorType,
      attempts: [{ provider: 'Codex (direct)', success: false, error: err.message }],
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// ── App-launch intent interception ──────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// Detect simple "open <app>" prompts and execute via KHY's unified tool chain
// instead of delegating to Codex CLI (which cannot set DISPLAY or use .desktop files).
const _OPEN_APP_RE = /^(?:打开|启动|运行|open|launch|start|run)\s*(.+)$/i;

async function _tryAppLaunchIntent(prompt, options) {
  // Use the raw user message (not the full conversationPrompt that includes system prompt + history)
  // so regex can match short inputs like "打开火狐" / "open firefox".
  const rawUserMessage = String(options?.userMessage || '').trim();
  const text = rawUserMessage || String(prompt || '').trim();
  const m = _OPEN_APP_RE.exec(text);
  if (!m) return null;

  const appQuery = m[1].trim();
  if (!appQuery || appQuery.length > 30) return null; // Too long to be an app name

  // Check against APP_ALIAS_MAP to verify this is actually an app
  let toolCalling;
  try { toolCalling = require('../../services/toolCalling'); } catch { return null; }
  const candidates = toolCalling._buildAppCandidates(appQuery);
  if (!candidates || candidates.length === 0) return null;

  // At least one candidate must match a known alias
  const aliasMap = toolCalling.APP_ALIAS_MAP;
  const hasKnownApp = candidates.some(c =>
    aliasMap[c] || Object.values(aliasMap).includes(c)
  );
  if (!hasKnownApp) return null;

  // Execute via KHY's open_app tool
  const { onChunk } = options;
  if (onChunk) {
    onChunk({ type: 'tool_use', tool: 'open_app', input: appQuery, id: 'app_launch_0' });
  }

  try {
    const result = await toolCalling.executeTool('open_app', { name: appQuery });
    const ok = result && result.success;
    const output = ok
      ? (result.output || `已启动 ${appQuery}`)
      : (result.error || `无法启动 ${appQuery}`);

    if (onChunk) {
      onChunk({ type: 'tool_result', id: 'app_launch_0', content: output });
    }

    return ok
      ? buildSuccess(output, {
          adapter: 'codex',
          provider: 'KHY open_app',
          model: 'native',
          attempts: [{ provider: 'KHY open_app', success: true }],
        })
      : buildFailure(output, {
          adapter: 'codex',
          provider: 'KHY open_app',
          model: 'native',
          attempts: [{ provider: 'KHY open_app', success: false }],
        });
  } catch (err) {
    const errMsg = `启动失败: ${err.message}`;
    if (onChunk) {
      onChunk({ type: 'tool_result', id: 'app_launch_0', content: errMsg });
    }
    return null; // Fall through to normal Codex flow
  }
}

// ═══════════════════════════════════════════════════════════════════
// ── CLI Mode (existing) ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

async function generate(prompt, options = {}) {
  // NOTE: app-launch intent 拦截已提升到 gateway 层 (appLaunchInterceptor.js)，
  // 在 adapter cascade 之前统一处理，此处不再重复拦截。
  const homeContext = getCodexHomeContext();
  if (homeContext.isTempHome) {
    safeEmitStatus(
      options,
      `Codex 环境提示: 当前 HOME=${homeContext.homeDir} 位于临时目录；Codex CLI 可能因 helper/bin 或 TLS 会话问题出现 reconnect / handshake eof。`
    );
  }

  // Branch: direct API mode bypasses CLI entirely
  // Also force direct mode when images are present — CLI stdin is text-only
  if (CODEX_MODE === 'direct' || (Array.isArray(options.images) && options.images.length > 0)) {
    return generateDirect(prompt, options);
  }

  if (!detect()) {
    return buildFailure('codex CLI not found', {
      adapter: 'codex',
      provider: 'Codex',
      attempts: [],
    });
  }
  if (!probeExecUsable()) {
    return buildFailure(_lastExecProbeError || 'codex exec unavailable', {
      adapter: 'codex',
      provider: 'Codex',
      errorType: 'unknown',
      attempts: [{ provider: 'Codex', success: false, error: _lastExecProbeError || 'codex exec unavailable' }],
    });
  }

  const args = ['exec', '--color', 'never', '--skip-git-repo-check'];
  if (process.env.GATEWAY_CODEX_JSON !== 'false') {
    args.push('--json');
  }
  const sandboxMode = String(process.env.GATEWAY_CODEX_SANDBOX || 'workspace-write').trim();
  if (sandboxMode && sandboxMode !== 'none') {
    args.push('--sandbox', sandboxMode);
  }

  const codexConfig = readCodexConfig() || {};

  // Only pass --model if it's known to be available on the configured provider.
  // Passing an unsupported model causes codex to enter a reconnect loop.
  let usedModel = null;
  if (options.model) {
    if (isUserModelAllowed(options.model, codexConfig)) {
      args.push('--model', options.model);
      usedModel = options.model;
    } else {
      usedModel = codexConfig.model || null;
    }
  }

  let providerModel = usedModel || 'default';
  try {
    let execResult;

    try {
      execResult = await runCodexExec(prompt, args, {
        ...options,
        model: providerModel,
      });
    } catch (firstErr) {
      const firstErrMessage = String(firstErr?.message || '');
      const firstResponseTimedOut = firstErr?.code === 'CODEX_FIRST_RESPONSE_TIMEOUT'
        || /codex first response timeout after \d+ms without meaningful model progress/i.test(firstErrMessage);
      if (firstResponseTimedOut) throw firstErr;

      const msg = firstErrMessage.toLowerCase();
      const retryArgs = args.slice();
      let shouldRetry = false;

      // Old codex versions may not support --json.
      if (retryArgs.includes('--json') && /(unknown|unrecognized|unexpected).*(--json|json)/i.test(msg)) {
        const ji = retryArgs.indexOf('--json');
        if (ji >= 0) {
          retryArgs.splice(ji, 1);
          shouldRetry = true;
        }
      }

      // Model mismatch can trigger backend reconnect; retry once without --model.
      if (usedModel && /(unknown model|invalid model|model .*not found|unsupported model|model_not_found)/i.test(msg)) {
        const mi = retryArgs.indexOf('--model');
        if (mi >= 0) {
          retryArgs.splice(mi, 2);
          providerModel = 'default';
          shouldRetry = true;
        }
      }

      // Some codex builds fail under strict sandbox; retry without explicit sandbox flag.
      if (!shouldRetry && /(reconnecting|channel closed|failed to record rollout items|sandbox)/i.test(msg)) {
        const si = retryArgs.indexOf('--sandbox');
        if (si >= 0) {
          retryArgs.splice(si, 2);
          shouldRetry = true;
        }
      }

      if (!shouldRetry) throw firstErr;
      if (options.onChunk) {
        try {
          options.onChunk({ type: 'status', text: 'Codex 重试中（自动降级参数）...' });
        } catch { /* best effort */ }
      }
      execResult = await runCodexExec(prompt, retryArgs, {
        ...options,
        model: providerModel,
      });
    }

    return buildSuccess(execResult.content, {
      adapter: 'codex',
      provider: `Codex (${providerModel})`,
      toolSummary: execResult.toolSummary || { totalCalls: 0, totalDurationMs: 0 },
      attempts: [{ provider: 'Codex', success: true }],
    });
  } catch (err) {
    const rawMessage = String(err && err.message ? err.message : err || 'codex failed');
    const isFirstResponseTimeout = err?.code === 'CODEX_FIRST_RESPONSE_TIMEOUT'
      || /codex first response timeout after \d+ms without meaningful model progress/i.test(rawMessage);
    const codexDiagnostics = buildCodexProgressDiagnostics(
      err?.codexProgressEvidence || null,
      err?.codexProgressSummary || ''
    );
    let classifyMessage = rawMessage;
    let finalErrorMessage = appendTempHomeHint(rawMessage, homeContext);

    // Custom provider transport failure fallback:
    // when config points to a non-OpenAI provider and transport is unhealthy,
    // retry once with OpenAI provider override.
    if (!isFirstResponseTimeout && shouldTryOpenAIFallback(rawMessage, codexConfig, options)) {
      safeEmitStatus(options, 'Codex 检测到自定义 provider 异常，尝试回退 OpenAI provider...');
      const fallbackArgs = buildOpenAIFallbackArgs(args);
      try {
        const fallbackResult = await runCodexExec(prompt, fallbackArgs, {
          ...options,
          model: 'default',
        });
        safeEmitStatus(options, 'Codex provider 回退成功（OpenAI）');
        recordRuntimeDiagnostics({
          healed: true,
          diagnosis: 'provider_fallback=openai',
          lastError: rawMessage,
          trigger: 'provider_fallback_recovered',
        });
        return buildSuccess(fallbackResult.content, {
          adapter: 'codex',
          provider: 'Codex (openai-fallback)',
          toolSummary: fallbackResult.toolSummary || { totalCalls: 0, totalDurationMs: 0 },
          attempts: [
            { provider: 'Codex', success: false, error: rawMessage },
            { provider: 'Codex (openai-fallback)', success: true },
          ],
        });
      } catch (fallbackErr) {
        const fallbackMsg = String(fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr || 'openai fallback failed');
        safeEmitStatus(options, `Codex provider 回退失败: ${compactText(fallbackMsg, 120)}`);
        classifyMessage = appendTempHomeHint(fallbackMsg, homeContext);
        finalErrorMessage = `${rawMessage} | openai_fallback=${compactText(fallbackMsg, 240)}`;
      }
    }

    if (!isFirstResponseTimeout && isReconnectChannelClosed(classifyMessage || rawMessage)) {
      safeEmitStatus(options, 'Codex 通道异常，执行快速自检...');
      const healed = maybeSelfHealReconnect(options);
      // If self-heal changed sandbox mode, run one immediate retry without explicit
      // sandbox flag before returning a hard failure.
      if (healed) {
        const healedRetryArgs = args.slice();
        const sandboxIdx = healedRetryArgs.indexOf('--sandbox');
        if (sandboxIdx >= 0) {
          healedRetryArgs.splice(sandboxIdx, 2);
        }
        safeEmitStatus(options, 'Codex 自愈后重试中...');
        try {
          const healedResult = await runCodexExec(prompt, healedRetryArgs, {
            ...options,
            model: providerModel,
          });
          safeEmitStatus(options, 'Codex 自愈后重试成功');
          recordRuntimeDiagnostics({
            healed: true,
            diagnosis: 'recovered_after_retry',
            lastError: rawMessage,
            trigger: 'reconnect_recovered',
          });
          return buildSuccess(healedResult.content, {
            adapter: 'codex',
            provider: `Codex (${providerModel})`,
            toolSummary: healedResult.toolSummary || { totalCalls: 0, totalDurationMs: 0 },
            attempts: [{ provider: 'Codex', success: true }],
          });
        } catch (retryErr) {
          classifyMessage = appendTempHomeHint(
            String(retryErr && retryErr.message ? retryErr.message : retryErr || rawMessage),
            homeContext
          );
        }
      }

      const diagnosis = diagnoseReconnectFailure(classifyMessage || rawMessage);
      recordRuntimeDiagnostics({
        healed,
        diagnosis,
        lastError: classifyMessage || rawMessage,
        trigger: 'reconnect',
      });
      if (diagnosis) {
        safeEmitStatus(options, `Codex 自检: ${diagnosis}`);
      }
      const extras = [];
      if (healed) extras.push('self_heal=mode_none');
      if (diagnosis) extras.push(`diagnosis=${diagnosis}`);
      if (extras.length > 0) {
        finalErrorMessage = `${classifyMessage || rawMessage} | ${extras.join(' | ')}`;
      }
    }

    finalErrorMessage = appendTempHomeHint(finalErrorMessage, homeContext);
    if (isFirstResponseTimeout) {
      recordRuntimeDiagnostics({
        healed: false,
        diagnosis: codexDiagnostics?.progressSummary || `stall=${codexDiagnostics?.stallFingerprint || 'unknown'}`,
        lastError: finalErrorMessage,
        trigger: 'first_response_timeout',
      });
    }

    const lower = String(classifyMessage || rawMessage).toLowerCase();
    let errorType = 'unknown';
    if (isAbortLikeError(err)) errorType = 'cancelled';
    else if (isFirstResponseTimeout) errorType = 'timeout';
    else if (/\bcancelled\b|\bcanceled\b/.test(lower)) errorType = 'process';
    else if (lower.includes('timeout')) errorType = 'timeout';
    else if (lower.includes('eacces') || lower.includes('eperm')) errorType = 'permission';
    else if (lower.includes('enoent') || lower.includes('not found')) errorType = 'unavailable';
    else if (lower.includes('unauthorized') || lower.includes('api key') || lower.includes('login')) errorType = 'auth';
    else if (lower.includes('rate') && lower.includes('limit')) errorType = 'rate_limit';
    else if (isReconnectChannelClosed(lower)) errorType = 'network';
    else if (/spawn|exited with code/.test(lower)) errorType = 'process';

    return buildFailure(finalErrorMessage, {
      adapter: 'codex',
      provider: 'Codex',
      errorType,
      diagnostics: codexDiagnostics || undefined,
      attempts: [{ provider: 'Codex', success: false, error: finalErrorMessage }],
    });
  }
}

function getStatus() {
  detect();
  const config = readCodexConfig() || {};
  const upstreamMeta = resolveUpstreamProviderMeta(config);
  const isOpenAiLike = !upstreamMeta.provider
    || String(upstreamMeta.provider).toLowerCase() === 'openai'
    || String(upstreamMeta.provider).toLowerCase() === 'oss';
  const codexName = isOpenAiLike ? 'OpenAI Codex' : `Codex CLI (${upstreamMeta.provider})`;
  if (CODEX_MODE === 'direct') {
    return {
      name: 'Codex Direct API',
      type: 'codex',
      available: _available,
      detail: _available
        ? `Direct API 可用 (${compactText(config.providerBaseUrl || process.env.CODEX_DIRECT_BASE_URL || process.env.OPENAI_BASE_URL || 'api.openai.com', 60)})`
        : `CODEX_API_KEY 未配置${_lastDetectError ? ` (${_lastDetectError})` : ''}`,
    };
  }
  const transportLabel = CODEX_MODE === 'direct' ? '直连' : '桥接';
  return {
    name: codexName,
    type: 'codex',
    available: _available,
    detail: _available
      ? `codex CLI ${transportLabel}可用${upstreamMeta.host ? ` · 上游 ${upstreamMeta.host}` : ''}`
      : `未检测到 codex 命令${_lastDetectError ? ` (${_lastDetectError})` : ''} · 可运行 khy tools install codex 安装便携版`,
  };
}

function destroy() {
  _available = null;
  _execProbeOk = null;
  _lastDetectError = '';
  _lastExecProbeError = '';
  _configCache = null;
  _providerModels = null;
  _runtimeDiagnostics = createEmptyRuntimeDiagnostics();
}

/**
 * The reasoning effort codex actually uses, sourced from config.toml
 * `model_reasoning_effort`. Returns a normalized lowercase string
 * (minimal/low/medium/high/xhigh) or null when unset. Used by the footer to
 * show the real effort instead of KHY's unrelated global effort setting.
 */
function getConfiguredEffort() {
  const effort = String(readCodexConfig().modelReasoningEffort || '').trim().toLowerCase();
  return effort || null;
}

// ── Codex upstream provider configuration (cc-switch-inspired) ──────────────
//
// The codex CLI is fully upstream-agnostic: it reads `~/.codex/config.toml`
// (model_provider + [model_providers.<name>].base_url) and `~/.codex/auth.json`
// (OPENAI_API_KEY). "mindflow" is never hardcoded anywhere — it is simply the
// value some users happen to have in their config. These helpers let the admin
// UI point codex at ANY OpenAI-compatible upstream by writing those two files,
// mirroring cc-switch's provider-driven live-write (atomic write + backup, no
// TOML parse dependency — we edit fields section-aware and re-emit the managed
// [model_providers.<name>] block).

const VALID_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const VALID_WIRE_APIS = ['responses', 'chat'];

/** Resolve the config.toml / auth.json paths, preferring an existing config. */
function resolveCodexConfigPaths() {
  const homeDir = require('os').homedir();
  const candidates = [
    path.join(homeDir, '.codex'),
    path.join(homeDir, '.config', 'codex'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'config.toml'))) {
      return { dir, configPath: path.join(dir, 'config.toml'), authPath: path.join(dir, 'auth.json') };
    }
  }
  // Default to the canonical ~/.codex when nothing exists yet.
  const dir = candidates[0];
  return { dir, configPath: path.join(dir, 'config.toml'), authPath: path.join(dir, 'auth.json') };
}

/** TOML key-name sanitizer (matches cc-switch sanitize_provider_name). */
function sanitizeProviderName(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '') || 'custom';
}

/**
 * Upsert a top-level (preamble) `key = value` pair: text before the first
 * `[section]` header. Keeps section bodies untouched so we never clobber a key
 * with the same name nested inside a table.
 */
function upsertPreambleKey(content = '', key = '', valueLiteral = '') {
  const lines = String(content).split('\n');
  let firstSection = lines.findIndex((l) => /^\s*\[/.test(l));
  if (firstSection < 0) firstSection = lines.length;
  const head = lines.slice(0, firstSection);
  const tail = lines.slice(firstSection);
  const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let replaced = false;
  for (let i = 0; i < head.length; i += 1) {
    if (keyRe.test(head[i])) { head[i] = `${key} = ${valueLiteral}`; replaced = true; break; }
  }
  if (!replaced) head.push(`${key} = ${valueLiteral}`);
  return head.concat(tail).join('\n');
}

/** Remove a `[sectionName]` table (header + its body up to the next header). */
function removeTomlSection(content = '', sectionName = '') {
  const lines = String(content).split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const m = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (m) {
      skipping = m[1].trim() === sectionName;
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/** Atomic write with a single .khy-bak backup of the prior contents. */
function atomicWriteWithBackup(targetPath, data) {
  try {
    if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, `${targetPath}.khy-bak`);
  } catch { /* backup is best-effort */ }
  const tmp = `${targetPath}.khy-tmp`;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, targetPath);
}

/**
 * Read-only snapshot of the current codex upstream, for the admin UI.
 * Never exposes the API key value — only whether one is present.
 */
function getCodexUpstreamSnapshot() {
  const config = readCodexConfig() || {};
  const { configPath, authPath } = resolveCodexConfigPaths();
  let hasApiKey = false;
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')) || {};
    hasApiKey = !!String(auth.OPENAI_API_KEY || '').trim();
  } catch { /* no auth.json */ }
  return {
    provider: config.modelProvider || '',
    model: config.model || '',
    baseUrl: config.providerBaseUrl || '',
    reasoningEffort: config.modelReasoningEffort || '',
    contextWindow: config.modelContextWindow || null,
    hasApiKey,
    configPath,
    configExists: fs.existsSync(configPath),
  };
}

/**
 * Point codex at an OpenAI-compatible upstream by writing config.toml +
 * auth.json. Preserves all unrelated config content; only the managed fields
 * (model_provider/model/model_reasoning_effort) and the target
 * [model_providers.<name>] block are rewritten.
 *
 * @param {object} opts
 * @param {string} opts.providerName  upstream label → TOML table name (sanitized)
 * @param {string} opts.baseUrl       OpenAI-compatible base URL
 * @param {string} opts.model         model id (e.g. gpt-5.3-codex)
 * @param {string} [opts.reasoningEffort] minimal|low|medium|high|xhigh
 * @param {string} [opts.wireApi]     responses|chat (default responses)
 * @param {string} [opts.apiKey]      OPENAI_API_KEY → auth.json (omitted = keep existing)
 * @returns {{configPath,authPath,provider,baseUrl,model,reasoningEffort,wireApi}}
 */
function setCodexUpstream(opts = {}) {
  const providerNameRaw = String(opts.providerName || '').trim();
  const baseUrl = String(opts.baseUrl || '').trim();
  const model = String(opts.model || '').trim();
  if (!providerNameRaw) throw new Error('providerName is required');
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!model) throw new Error('model is required');
  try { new URL(baseUrl); } catch { throw new Error('baseUrl must be a valid http(s) URL'); }

  const reasoningEffort = String(opts.reasoningEffort || '').trim().toLowerCase();
  if (reasoningEffort && !VALID_REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error(`reasoningEffort must be one of ${VALID_REASONING_EFFORTS.join('|')}`);
  }
  const wireApi = (String(opts.wireApi || 'responses').trim().toLowerCase()) || 'responses';
  if (!VALID_WIRE_APIS.includes(wireApi)) {
    throw new Error(`wireApi must be one of ${VALID_WIRE_APIS.join('|')}`);
  }
  const provider = sanitizeProviderName(providerNameRaw);
  const apiKey = opts.apiKey != null ? String(opts.apiKey).trim() : null;

  const { dir, configPath, authPath } = resolveCodexConfigPaths();
  fs.mkdirSync(dir, { recursive: true });

  let content = '';
  try { content = fs.readFileSync(configPath, 'utf-8'); } catch { content = ''; }

  content = upsertPreambleKey(content, 'model_provider', `"${provider}"`);
  content = upsertPreambleKey(content, 'model', `"${model}"`);
  if (reasoningEffort) {
    content = upsertPreambleKey(content, 'model_reasoning_effort', `"${reasoningEffort}"`);
  }

  // Rebuild the managed provider table from scratch so stale base_url/wire_api
  // never linger.
  content = removeTomlSection(content, `model_providers.${provider}`);
  const block = [
    `[model_providers.${provider}]`,
    `name = "${provider}"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "${wireApi}"`,
    `requires_openai_auth = true`,
  ].join('\n');
  content = `${content.replace(/\n*$/, '\n')}\n${block}\n`;

  atomicWriteWithBackup(configPath, content);

  if (apiKey) {
    let auth = {};
    try { auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')) || {}; } catch { auth = {}; }
    auth.OPENAI_API_KEY = apiKey;
    atomicWriteWithBackup(authPath, `${JSON.stringify(auth, null, 2)}\n`);
  }

  _configCache = null; // force re-read on next status/footer query
  return { configPath, authPath, provider, baseUrl, model, reasoningEffort: reasoningEffort || null, wireApi };
}

module.exports = {
  detect,
  detectAsync,
  listModels,
  generate,
  getStatus,
  getRuntimeDiagnostics,
  getConfiguredEffort,
  getCodexUpstreamSnapshot,
  setCodexUpstream,
  destroy,
  __test__: {
    sanitizeProviderName,
    upsertPreambleKey,
    removeTomlSection,
    buildCliPrompt,
    buildDirectSystemPrompt,
    resolveExecIdleTimeoutMs,
    resolveExecFirstResponseTimeoutMs,
    isReconnectChannelClosed,
    createCodexProgressEvidence,
    recordCodexProgressEvent,
    classifyCodexPreResponseStall,
    snapshotCodexProgressEvidence,
    formatCodexProgressEvidence,
    getCodexRuntimeDiagnosticsFile,
    readPersistedRuntimeDiagnostics,
    readPersistedRuntimeDiagnosticsState,
    clearPersistedRuntimeDiagnostics,
    normalizeTrackedFileOperation,
    classifyTrackedRelocation,
    dedupeTrackedFileOps,
    extractTrackedFileOpsFromShellCommand,
    inferTrackedFileOps,
    buildDirectToolDefs,
  },
};
