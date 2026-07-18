/**
 * Claude Code Adapter — invoke Claude Code CLI as a standalone IDE adapter.
 *
 * Extends the existing cliToolAdapter pattern but supports:
 * - Model selection (--model flag)
 * - Model listing
 * - Dedicated IDE registration in the gateway
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const { detectErrorKindDeep, formatErrorMessage } = require('../../errorClassifier');
// Model-name SSOT: default Claude model flows from constants/models.js so
// switching the tier model edits one place (env ANTHROPIC_MODEL overrides first).
const { PRIMARY: MODELS } = require('../../../constants/models');
const { extractPrimaryApiKey } = require('../../apiKeyFormat');
const { isWin, platformShell, safeKill, getShellConfiguration } = require('../../../tools/platformUtils');
const { createAdapterRuntimeDiagnosticsStore } = require('../runtimeDiagnosticsStore');
const { toAnthropicImageBlocks, toAnthropicDocumentBlocks } = require('./_imageCompat');
const { processStreamEvent: _sharedProcessStreamEvent, createStreamState } = require('./_streamProcessor');
const { normalizeAbortReason, isAbortLikeError } = require('./_abortHelpers');
const { classifyAdapterError } = require('./_errorClassifiers');
const { createProtocolHandler } = require('./_protocolPipeline');
const { buildSuccess, buildFailure } = require('./_responseBuilder');
const { normalizeCacheUsage } = require('./_cacheUsage');
// Portable claude (便携版 ~/.khy/tools) spawn/detect helpers — shared leaf keeps
// this 2500-line-capped file's call sites tiny; never throws (falls back to bare).
const { portableSpawn: _portableClaudeSpawn, portableInstalled: _portableClaudeInstalled } =
  require('./portableAdapterSpawn').forTool('claude');

// Module-level Anthropic protocol handler — shared by all direct-mode calls
const _anthropicHandler = createProtocolHandler({ protocol: 'anthropic', adapterName: 'claude' });

// Lazy-loaded agentsight for trajectory recording (best-effort)
let _genaiEvents = null;
function genai() {
  if (_genaiEvents === null) {
    try { _genaiEvents = require('../../agentsight/genaiEvents'); }
    catch { _genaiEvents = false; }
  }
  return _genaiEvents || null;
}

const TIMEOUT_MS = parseInt(process.env.GATEWAY_CLAUDE_TIMEOUT_MS || '240000', 10);
const IDLE_TIMEOUT_MS = Math.max(0, parseInt(process.env.GATEWAY_CLAUDE_IDLE_TIMEOUT_MS || '180000', 10) || 0);
const HANDSHAKE_TIMEOUT_MS = Math.max(0, parseInt(process.env.GATEWAY_CLAUDE_HANDSHAKE_TIMEOUT_MS || '10000', 10) || 10000);
const MAX_BUFFER = 10 * 1024 * 1024;

// Direct mode constants — bypass CLI, call Anthropic Messages API directly
// Connection mode resolution:
//   GATEWAY_CLAUDE_MODE=direct  → always direct (Anthropic API), fail if no key
//   GATEWAY_CLAUDE_MODE=bridge  → always CLI subprocess
//   GATEWAY_CLAUDE_MODE=auto    → direct if API key present, else bridge (DEFAULT)
const _CLAUDE_MODE_RAW = String(process.env.GATEWAY_CLAUDE_MODE || 'auto').toLowerCase();
function _hasAnthropicKey() {
  const envKey = extractPrimaryApiKey(process.env.ANTHROPIC_API_KEY)
    || extractPrimaryApiKey(process.env.ANTHROPIC_AUTH_TOKEN)
    || extractPrimaryApiKey(process.env.CLAUDE_API_KEY);
  if (envKey) {
    return true;
  }
  // Fallback: check apiKeyPool for managed anthropic keys
  try {
    const pool = require('../../apiKeyPool');
    pool.init();
    return pool.hasAvailableKeys('anthropic');
  } catch { return false; }
}

/**
 * Resolve the Anthropic credential from environment, remembering its *source*.
 *
 * Precedence mirrors the pre-existing inline resolution (ANTHROPIC_API_KEY first).
 * The source matters downstream: the official Anthropic SDK / Claude Code send a
 * different auth header depending on which variable supplied the credential:
 *   - ANTHROPIC_API_KEY    → `x-api-key`             (official direct API)
 *   - ANTHROPIC_AUTH_TOKEN → `Authorization: Bearer` (relays / gateways proxying
 *     Anthropic; this is the header Claude Code itself sends for AUTH_TOKEN)
 *
 * Pure: reads env only, deterministic, never throws.
 * @param {object} [env=process.env]
 * @returns {{ apiKey: (string|null), source: (string|null) }}
 */
function _resolveAnthropicCredentialFromEnv(env = process.env) {
  const src = env || {};
  const fromApiKey = extractPrimaryApiKey(src.ANTHROPIC_API_KEY);
  if (fromApiKey) return { apiKey: fromApiKey, source: 'ANTHROPIC_API_KEY' };
  const fromAuthToken = extractPrimaryApiKey(src.ANTHROPIC_AUTH_TOKEN);
  if (fromAuthToken) return { apiKey: fromAuthToken, source: 'ANTHROPIC_AUTH_TOKEN' };
  const fromClaude = extractPrimaryApiKey(src.CLAUDE_API_KEY);
  if (fromClaude) return { apiKey: fromClaude, source: 'CLAUDE_API_KEY' };
  return { apiKey: null, source: null };
}

/**
 * Decide which auth header scheme to use for a resolved Anthropic credential.
 *
 * `auto` (default) is source-aware and mirrors the upstream SDK:
 *   ANTHROPIC_AUTH_TOKEN → 'bearer', everything else → 'x-api-key'.
 * `ANTHROPIC_AUTH_SCHEME` (auto|bearer|x-api-key|both) is a compatibility
 * override for relays with unusual expectations — NOT a feature gate: the default
 * already produces correct behaviour; forcing it off would only re-break
 * AUTH_TOKEN relays (which expect Bearer, not x-api-key).
 *
 * Pure: deterministic, never throws.
 * @param {string|null} source  from _resolveAnthropicCredentialFromEnv (or 'pool')
 * @param {object} [env=process.env]
 * @returns {'bearer'|'x-api-key'|'both'}
 */
function _resolveAnthropicAuthScheme(source, env = process.env) {
  const override = String(((env || {}).ANTHROPIC_AUTH_SCHEME) || '').trim().toLowerCase();
  if (override === 'bearer' || override === 'x-api-key' || override === 'both') return override;
  // auto (default): source-aware — AUTH_TOKEN relays expect Bearer.
  return source === 'ANTHROPIC_AUTH_TOKEN' ? 'bearer' : 'x-api-key';
}

/**
 * Build the auth header(s) for an Anthropic request.
 *   - 'x-api-key' → { 'x-api-key': key }            (official; byte-identical to legacy)
 *   - 'bearer'    → { Authorization: 'Bearer key' }  (relays / AUTH_TOKEN)
 *   - 'both'      → both headers                      (lenient relays; opt-in override)
 *
 * Pure: deterministic, never throws.
 * @param {string} apiKey
 * @param {'bearer'|'x-api-key'|'both'} scheme
 * @returns {object}
 */
function _buildAnthropicAuthHeaders(apiKey, scheme) {
  const key = String(apiKey || '');
  if (scheme === 'bearer') return { Authorization: `Bearer ${key}` };
  if (scheme === 'both') return { 'x-api-key': key, Authorization: `Bearer ${key}` };
  return { 'x-api-key': key };
}

function resolveConnectionMode() {
  if (_CLAUDE_MODE_RAW === 'direct') return 'direct';
  if (_CLAUDE_MODE_RAW === 'bridge' || _CLAUDE_MODE_RAW === 'cli') return 'bridge';
  // auto (default)
  return _hasAnthropicKey() ? 'direct' : 'bridge';
}
const DIRECT_MODE = _CLAUDE_MODE_RAW === 'direct';
const DIRECT_MAX_ITERATIONS = parseInt(process.env.GATEWAY_CLAUDE_DIRECT_MAX_ITERATIONS || '15', 10);
const DIRECT_TIMEOUT_MS = parseInt(process.env.GATEWAY_CLAUDE_DIRECT_TIMEOUT_MS || '120000', 10);
const DIRECT_MAX_OUTPUT = 16000; // truncate large tool outputs

// ── Tool deferral (defer_loading) helpers ──────────────────────────
function _deferralActive() {
  return process.env.KHY_DEFER_TOOLS !== '0';
}
// Lazy tier resolver (avoids a hard dependency cycle at module load).
let _modelTierMod;
function _resolveTier(model) {
  try {
    if (!_modelTierMod) _modelTierMod = require('../../modelTier');
    return _modelTierMod.resolveTier(model);
  } catch { return 'T2'; }
}

// Sticky opt-out: once the live API rejects (400) a request because of an
// added beta token, drop the optional T0 betas for the rest of this session
// instead of failing every subsequent request the same way.
let _betaOptOut = false;

// The Anthropic 1M-context beta (context-1m-2025-08-07) is offered for BOTH
// Opus 4.x (T0) and Sonnet 4.x (T1 default). It is NOT a frontier-only header
// like interleaved-thinking — it is a capability of those specific model
// families — so it is gated on the model family, not the tier.
function _is1MCapableModel(model) {
  return /(?:opus|sonnet)-?4/i.test(String(model || ''));
}

// Is the context-1m beta actually being SENT for this model right now? True iff
// the model family supports it, the env kill-switch is not off, and a prior 400
// has not stuck us into the opt-out. This is the single source of truth both for
// the header builder and for the downstream context-window clamp (see
// effectiveContextWindow) so the compaction budget never over-claims 1M when the
// header isn't live.
function is1MContextActive(model) {
  if (_betaOptOut) return false;
  if (process.env.KHY_BETA_1M_CONTEXT === '0') return false;
  return _is1MCapableModel(model);
}

// Build the anthropic-beta header. tool-search is always on (proven working).
// context-1m is added for any 1M-capable family (Opus 4 + Sonnet 4); interleaved
// thinking stays frontier-only (T0). Both are env-gated and suppressed once a 400
// has shown the account/model can't accept them.
function _buildBetaHeader(model) {
  const parts = ['tool-search-tool-2025-10-19'];
  if (is1MContextActive(model)) parts.push('context-1m-2025-08-07');
  if (!_betaOptOut && _resolveTier(model) === 'T0'
      && process.env.KHY_BETA_INTERLEAVED !== '0') {
    parts.push('interleaved-thinking-2025-05-14');
  }
  const extra = (process.env.KHY_ANTHROPIC_BETA || '').split(',').map(s => s.trim()).filter(Boolean);
  parts.push(...extra);
  return parts.join(',');
}

// Honest effective context window for a Claude model. A model may DECLARE a 1M
// window (KNOWN_MODELS / gateway cache), but the API only honours it when the
// context-1m beta is live. When the beta is stripped (400 fallback), disabled,
// or simply not applicable, the real ceiling is 200k — so the compaction budget
// must clamp to 200k or a long conversation overflows and 400s. Non-Claude
// models and sub-200k declarations pass through unchanged.
function effectiveContextWindow(model, declared) {
  const d = Number(declared) || 0;
  if (!/claude|opus|sonnet|haiku/i.test(String(model || ''))) return d;
  if (d > 200000 && !is1MContextActive(model)) return 200000;
  return d;
}

// Tier-aware default extended-thinking budget (used when no explicit budget is
// supplied, e.g. reasoning_effort !== 'auto'). Frontier models think harder by
// default; all other tiers keep the historical flat 10000 (zero regression).
function _defaultThinkingBudget(model) {
  return _resolveTier(model) === 'T0' ? 16000 : 10000;
}

// Read an axios error-response body (a Readable stream when responseType:'stream')
// into a bounded string so we can inspect why a 400 occurred.
function _readErrorBody(data) {
  return new Promise((resolve) => {
    if (!data || typeof data.on !== 'function') {
      try { resolve(String(data || '')); } catch { resolve(''); }
      return;
    }
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    data.on('data', (c) => { if (buf.length < 8192) buf += c.toString('utf8'); });
    data.on('end', finish);
    data.on('error', finish);
    setTimeout(finish, 2000); // never hang on a malformed error stream
  });
}

// On a 400 caused by an added T0 beta token, set the sticky opt-out and retry
// the SAME body once — _buildBetaHeader will now omit the optional betas.
// Returns { resp, strippedBetas } on success (strippedBetas = the optional beta
// tokens that the 400 named, for a user-facing notice), or null to let the
// caller rethrow. The retry itself is a functional self-heal and is NOT gated —
// only the caller's user-facing notice is gated (KHY_BETA_FALLBACK_NOTICE).
async function _maybeRetryWithoutBetas(err, http, baseUrl, body, ac, buildHeaders) {
  if (_betaOptOut) return null;                       // already stripped — don't loop
  if (!err || !err.response || err.response.status !== 400) return null;
  let text = '';
  try { text = await _readErrorBody(err.response.data); } catch { return null; }
  if (!/context-1m|interleaved-thinking/i.test(text)) return null;
  const strippedBetas = [];
  if (/context-1m/i.test(text)) strippedBetas.push('context-1m');
  if (/interleaved-thinking/i.test(text)) strippedBetas.push('interleaved-thinking');
  _betaOptOut = true;
  try {
    console.warn('[claudeAdapter] 400 on optional beta header — disabling 1M/interleaved betas for this session and retrying. '
      + 'Note: context budget may still assume 1M; watch for >200k overflows.');
  } catch { /* logging is best-effort */ }
  try {
    const resp = await http.post(`${baseUrl}/v1/messages`, body, {
      headers: buildHeaders(),                          // betas now suppressed
      responseType: 'stream',
      signal: ac.signal,
    });
    return { resp, strippedBetas };
  } catch { return null; }
}

// Simple hash for guardrail result comparison (Direct mode)
function _simpleResultHash(str) {
  let h = 0;
  const s = String(str || '').slice(0, 500);
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}
const DIRECT_SIMPLE_MAX_TOKENS = Math.max(
  64,
  parseInt(process.env.GATEWAY_CLAUDE_DIRECT_SIMPLE_MAX_TOKENS || '384', 10) || 384
);
const DIRECT_SIMPLE_MAX_ROUNDS = Math.max(
  1,
  parseInt(process.env.GATEWAY_CLAUDE_DIRECT_SIMPLE_MAX_ROUNDS || '2', 10) || 2
);

// Known Claude Code models (detected dynamically where possible)
const KNOWN_MODELS = [
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', isDefault: false, tier: 'ultra', category: 'reasoning', contextWindow: 1000000 },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', isDefault: false, tier: 'ultra', category: 'reasoning', contextWindow: 1000000 },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', isDefault: false, tier: 'ultra', category: 'reasoning', contextWindow: 1000000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', isDefault: true, tier: 'high', category: 'general', contextWindow: 1000000 },
  { id: 'claude-haiku-4-5-latest', name: 'Claude Haiku 4.5', isDefault: false, tier: 'medium', category: 'fast', contextWindow: 200000 },
];

let _available = null;
const _runtimeDiagnosticsStore = createAdapterRuntimeDiagnosticsStore('claude');
let _runtimeDiagnostics = _runtimeDiagnosticsStore.createEmptyDiagnostic();

function recordRuntimeDiagnostics(payload = {}) {
  _runtimeDiagnostics = _runtimeDiagnosticsStore.record(_runtimeDiagnostics, payload, {
    fallbackTrigger: 'unknown',
  });
}

function getRuntimeDiagnostics(options = {}) {
  return _runtimeDiagnosticsStore.get(_runtimeDiagnostics, options);
}

function snapshotClaudeBridgeProgress(progress = {}) {
  const now = Date.now();
  const startedAt = Number(progress.startedAt || now);
  const firstEventAt = Number(progress.firstEventAt || 0);
  const lastEventAt = Number(progress.lastEventAt || 0);
  return {
    launchMode: String(progress.launchMode || 'direct').trim() || 'direct',
    startedAt,
    firstEventSinceStartMs: firstEventAt > 0 ? Math.max(0, firstEventAt - startedAt) : null,
    lastEventAgeMs: lastEventAt > 0 ? Math.max(0, now - lastEventAt) : Math.max(0, now - startedAt),
    parsedEventCount: Number(progress.parsedEventCount || 0),
    controlRequestCount: Number(progress.controlRequestCount || 0),
    sawResult: !!progress.sawResult,
    contentChars: Number(progress.contentChars || 0),
    lastEventType: _runtimeDiagnosticsStore.compactText(progress.lastEventType || '', 80),
    stderrPreview: _runtimeDiagnosticsStore.compactText(progress.stderrPreview || '', 180),
    idleTimedOut: !!progress.idleTimedOut,
    handshakeTimedOut: !!progress.handshakeTimedOut,
  };
}

function classifyClaudeBridgeFailure(snapshot = {}) {
  if (snapshot.handshakeTimedOut) {
    return {
      trigger: 'bridge_handshake_timeout',
      summary: 'Claude bridge produced no usable stream-json events before handshake timeout',
    };
  }
  if (snapshot.idleTimedOut) {
    return {
      trigger: 'bridge_idle_timeout',
      summary: 'Claude bridge stopped making stream progress before result completion',
    };
  }
  if (Number(snapshot.parsedEventCount || 0) <= 0) {
    return {
      trigger: 'bridge_no_stream_events',
      summary: 'Claude bridge exited before any usable stream-json event arrived',
    };
  }
  return {
    trigger: 'bridge_process_failure',
    summary: 'Claude bridge failed after partial stream activity',
  };
}

function buildClaudeBridgeDiagnostics(snapshot = {}, message = '') {
  const classified = classifyClaudeBridgeFailure(snapshot);
  const progressSummary = _runtimeDiagnosticsStore.compactText([
    `trigger=${classified.trigger}`,
    `launch=${snapshot.launchMode || 'direct'}`,
    `events=${Number(snapshot.parsedEventCount || 0)}`,
    `first_event_ms=${snapshot.firstEventSinceStartMs === null ? 'none' : snapshot.firstEventSinceStartMs}`,
    `last_event_age_ms=${Number(snapshot.lastEventAgeMs || 0)}`,
    `last_event=${snapshot.lastEventType || 'none'}`,
    `control_requests=${Number(snapshot.controlRequestCount || 0)}`,
    `content_chars=${Number(snapshot.contentChars || 0)}`,
    `stderr=${snapshot.stderrPreview || 'none'}`,
  ].join(' | '), 640);
  return {
    trigger: classified.trigger,
    summary: classified.summary,
    progressSummary,
    progressEvidence: snapshot,
    message: _runtimeDiagnosticsStore.compactText(message || '', 240),
  };
}

function attachClaudeBridgeDiagnostics(err, progress = {}, overrides = {}) {
  const error = err instanceof Error ? err : new Error(String(err || 'unknown error'));
  const snapshot = snapshotClaudeBridgeProgress({
    ...progress,
    idleTimedOut: overrides.idleTimedOut ?? progress.idleTimedOut,
    handshakeTimedOut: overrides.handshakeTimedOut ?? progress.handshakeTimedOut,
  });
  const diagnostics = buildClaudeBridgeDiagnostics(snapshot, error.message || String(err || ''));
  if (overrides.trigger) diagnostics.trigger = String(overrides.trigger).trim();
  if (overrides.summary) diagnostics.summary = _runtimeDiagnosticsStore.compactText(overrides.summary, 240);
  error.diagnostics = diagnostics;
  return error;
}

function buildClaudeRuntimeDiagnosticsPayload(err, options = {}) {
  const diagnostics = err?.diagnostics || null;
  if (diagnostics) {
    return {
      requestId: options.requestId || '',
      healed: !!options.healed,
      trigger: diagnostics.trigger || 'bridge_process_failure',
      category: 'stall',
      phase: 'bridge',
      summary: diagnostics.summary || '',
      diagnosis: diagnostics.progressSummary || diagnostics.summary || '',
      lastError: err?.message || '',
    };
  }

  const rawMessage = String(err?.message || err || 'claude failed');
  const lower = rawMessage.toLowerCase();
  let trigger = 'bridge_process_failure';
  let summary = 'Claude bridge failed';
  if (lower.includes('handshake timeout')) {
    trigger = 'bridge_handshake_timeout';
    summary = 'Claude bridge handshake timed out before first stream event';
  } else if (lower.includes('idle timeout')) {
    trigger = 'bridge_idle_timeout';
    summary = 'Claude bridge timed out after stream activity stalled';
  } else if (lower.includes('without emitting stream-json output')) {
    trigger = 'bridge_no_stream_events';
    summary = 'Claude bridge exited without emitting stream-json output';
  } else if (lower.includes('bridge canceled')) {
    trigger = 'bridge_canceled';
    summary = 'Claude bridge canceled before usable completion';
  }
  return {
    requestId: options.requestId || '',
    healed: !!options.healed,
    trigger,
    category: trigger.includes('timeout') || trigger.includes('no_stream') || trigger.includes('canceled')
      ? 'stall'
      : inferBridgeCategory(trigger, options.healed),
    phase: options.phase || 'bridge',
    summary,
    diagnosis: _runtimeDiagnosticsStore.compactText(rawMessage, 640),
    lastError: rawMessage,
  };
}

function inferBridgeCategory(trigger = '', healed = false) {
  if (healed) return 'recovery';
  return /timeout|no_stream|canceled|stall/.test(String(trigger || '').toLowerCase()) ? 'stall' : 'transport';
}

function buildClaudeArgs(options = {}) {
  // Determine permission mode early — it affects arg construction
  const permissionMode = options.permissionMode || process.env.GATEWAY_CLAUDE_PERMISSION_MODE || 'bypassPermissions';

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (options.model) args.push('--model', options.model);

  // Permission mode
  args.push('--permission-mode', permissionMode);
  if (permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  }

  // Route permission prompts through stream-json control_request/control_response.
  // Even in bypassPermissions mode, Claude CLI may still emit control_request events
  // for certain operations — KHY auto-approves them via buildDefaultControlResponse.
  const permissionPromptTool = options.permissionPromptTool
    || process.env.GATEWAY_CLAUDE_PERMISSION_PROMPT_TOOL
    || 'stdio';
  if (permissionPromptTool) args.push('--permission-prompt-tool', permissionPromptTool);

  // Keep full Claude tool surface by default; only constrain when explicitly requested.
  const allowedTools = options.allowedTools || process.env.GATEWAY_CLAUDE_ALLOWED_TOOLS || '';
  if (allowedTools) args.push('--allowedTools', allowedTools);

  // Allow tool access to /tmp and current workspace by default so bridge tasks
  // can create files under the user's project path without interactive prompts.
  // Additional paths can be injected via env (comma-separated).
  const addDirs = [];
  if (process.env.GATEWAY_CLAUDE_ADD_TMP !== 'false') addDirs.push('/tmp');
  if (process.env.GATEWAY_CLAUDE_ADD_CWD !== 'false') {
    const cwd = process.env.KHYQUANT_CWD || process.env.PWD || process.cwd();
    if (cwd) addDirs.push(path.resolve(cwd));
  }
  const extraDirs = (process.env.GATEWAY_CLAUDE_ADD_DIRS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  addDirs.push(...extraDirs);
  for (const dir of Array.from(new Set(addDirs))) {
    if (!dir) continue;
    const normalized = path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(process.cwd(), dir);
    args.push('--add-dir', normalized);
  }

  return args;
}

function diagnoseClaudeLaunchIssue() {
  try {
    const probe = spawnSync('claude', ['--version'], {
      stdio: 'ignore',
      timeout: 5000,
      env: process.env,
    });
    if (probe && probe.error) {
      const code = probe.error.code || '';
      if (code === 'EPERM' || code === 'EACCES') {
        return `claude launch blocked (${code})`;
      }
      return probe.error.message || String(probe.error);
    }
  } catch (err) {
    const code = err && err.code ? err.code : '';
    if (code === 'EPERM' || code === 'EACCES') {
      return `claude launch blocked (${code})`;
    }
    if (err && err.message) return err.message;
  }
  return '';
}

function commandExists(cmd) {
  // Shared TTL availability cache: collapses the repeated synchronous
  // `claude --version` probes (preflight + getStatus + re-detect) that would
  // otherwise freeze the event loop on the first prompt of a session.
  return require('./_commandAvailability').isAvailable(cmd);
}

function commandExistsAsync(cmd, forceRefresh = false) {
  // Async sibling of commandExists: the gateway's parallel init prefers
  // detectAsync, and routing the CLI probe through execFile (not spawnSync)
  // keeps the Ink event loop free so the TUI stays responsive at startup
  // instead of freezing for the sum of the `--version` probe latencies.
  return require('./_commandAvailability').isAvailableAsync(cmd, { force: forceRefresh });
}

/**
 * Detect if Claude Code CLI is available.
 */
function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  _available = commandExists('claude');
  if (!_available && _portableClaudeInstalled()) _available = true;
  return _available;
}

/**
 * Async detection — also verifies Anthropic direct API reachability
 * when an API key is present, so the health-check catches endpoint
 * misconfigurations before the user selects a direct-mode model.
 */
async function detectAsync(forceRefresh = false) {
  // Non-blocking CLI existence probe (execFile, not spawnSync) so gateway init
  // never freezes the event loop. Mirrors detect()'s caching of `_available`.
  const cliOk = (_available !== null && !forceRefresh)
    ? _available
    : (_available = await commandExistsAsync('claude', forceRefresh));
  if (!_hasAnthropicKey()) return cliOk;

  // Lightweight check: HEAD-like GET to the API root.
  // Even a 401 (bad key) or 405 (method not allowed) proves the host is reachable;
  // a timeout or ECONNREFUSED means the endpoint is broken.
  try {
    const _probeCred = _resolveAnthropicCredentialFromEnv(process.env);
    let apiKey = _probeCred.apiKey;
    let credSource = _probeCred.source;
    let endpoint = process.env.ANTHROPIC_BASE_URL || '';
    if (!apiKey) {
      try {
        const pool = require('../../apiKeyPool');
        pool.init();
        const picked = pool.pick('anthropic');
        if (picked) { apiKey = picked.key; endpoint = picked.endpoint || ''; credSource = 'pool'; }
      } catch { /* pool unavailable */ }
    }
    if (!apiKey) return cliOk;

    const baseUrl = (endpoint || 'https://api.anthropic.com')
      .replace(/\/+$/, '')
      .replace(/\/v\d+$/, '');

    let http;
    try { http = require('axios'); } catch {
      http = require(path.resolve(process.cwd(), 'node_modules/axios'));
    }
    // A GET /v1/messages returns 405 (method not allowed) when the host is reachable.
    // Any non-timeout/non-ECONNREFUSED response means the endpoint is alive.
    await http.get(`${baseUrl}/v1/messages`, {
      headers: { ..._buildAnthropicAuthHeaders(apiKey, _resolveAnthropicAuthScheme(credSource, process.env)), 'anthropic-version': '2024-10-22' },
      timeout: 6000,
      validateStatus: () => true, // accept any HTTP status
    });
    return true;
  } catch (err) {
    // Network-level failure — direct mode is unreachable
    const msg = err && err.message ? err.message : String(err);
    if (/timeout|ECONNREFUSED|ENOTFOUND|ENETUNREACH/i.test(msg)) {
      // Direct unreachable but CLI might still work
      return cliOk;
    }
    return cliOk;
  }
}

/**
 * List available models.
 */
async function listModels() {
  const hasKey = _hasAnthropicKey();
  const out = [];
  for (const m of KNOWN_MODELS) {
    const base = {
      ...m,
      provider: 'claude',
      description: '',
      discoverySource: 'builtin',
    };
    // Auto entry — picks direct if key present, else bridge
    out.push({
      ...base,
      id: `${m.id}::auto`,
      name: m.name,
      isDefault: !!m.isDefault,
      connectionMode: 'auto',
      _baseModelId: m.id,
    });
    // Direct entry — only meaningful when API key is configured
    if (hasKey) {
      out.push({
        ...base,
        id: `${m.id}::direct`,
        name: m.name,
        isDefault: false,
        connectionMode: 'direct',
        _baseModelId: m.id,
      });
    }
    // Bridge entry — always available (uses Claude CLI subscription)
    out.push({
      ...base,
      id: `${m.id}::bridge`,
      name: m.name,
      isDefault: false,
      connectionMode: 'bridge',
      _baseModelId: m.id,
    });
  }
  return out;
}

// Parse a model id like "claude-opus-4-6::direct" into {modelId, mode}
function parseModelId(rawId) {
  const s = String(rawId || '');
  const idx = s.indexOf('::');
  if (idx === -1) return { modelId: s, mode: null };
  return { modelId: s.slice(0, idx), mode: s.slice(idx + 2).toLowerCase() || null };
}

function buildStreamUserMessage(prompt, rawUserMessage) {
  return {
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content: applyAgenticGuidancePrefix(prompt, rawUserMessage),
    },
    parent_tool_use_id: null,
  };
}

/**
 * Extract the raw user text from a flat conversation prompt.
 * buildFlatConversation produces: "<system>\n\nUSER: <text>".
 * We grab the last USER: line to detect greeting vs task.
 */
function _extractLastUserText(flatPrompt) {
  const lines = String(flatPrompt || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^USER:\s*(.*)/i);
    if (m) {
      // Collect subsequent lines that aren't a new role marker (multiline user messages)
      let text = m[1];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^(USER|ASSISTANT|SYSTEM|\[ToolResult\]):/i.test(lines[j])) break;
        text += '\n' + lines[j];
      }
      text = text.trim();
      // Skip system-injected USER messages (planning prompts, skill hints, etc.)
      // These start with [System or contain skill manifest data — not real user input.
      if (/^\[System/i.test(text)) continue;
      return text;
    }
  }
  return '';
}

/**
 * Optionally rewrite the prompt for simple greetings to avoid triggering
 * tool-heavy responses. For all other inputs, returns the prompt unchanged.
 * Suppressed by GATEWAY_CLAUDE_NO_GUIDANCE=1.
 */
function applyAgenticGuidancePrefix(prompt, rawUserMessage, options) {
  const raw = String(prompt || '');
  if (process.env.GATEWAY_CLAUDE_NO_GUIDANCE === '1') return raw;

  // Greeting detection: prefer the raw user message (before any system
  // injection by toolUseLoop/planning/skill hints).  Fall back to extracting
  // from the flat prompt only when rawUserMessage is not available.
  const userText = rawUserMessage
    ? String(rawUserMessage).replace(/\n\n\[System\b[\s\S]*/i, '').trim()
    : _extractLastUserText(raw);

  if (looksLikeSimpleGreeting(userText)) {
    return [
      'You are khy OS, a friendly and helpful AI assistant. Respond in the same language the user used.',
      'The user sent a casual greeting. Respond naturally — say hello, briefly introduce yourself,',
      'and ask how you can help today. Keep it warm and concise (2-3 sentences).',
      'Do NOT mention calculation, financial analysis, stock trading, or any specific tool.',
      '',
      `USER: ${userText}`,
    ].join('\n');
  }

  // Non-greeting: return prompt as-is. Execution guidance and intent
  // directives are already in the system prompt — no need to duplicate here.
  return raw;
}

function looksLikeSimpleGreeting(input = '') {
  try {
    const { isGreeting } = require('../../services/khyUpgradeRuntime');
    return isGreeting(input);
  } catch {
    // Fallback: minimal inline check if runtime not loadable
    const compact = String(input || '').trim().toLowerCase().replace(/[！!。.,，?？\s]/g, '');
    return new Set(['hi', 'hello', 'hey', '你好', '您好', '嗨']).has(compact);
  }
}

function looksLikeToolOrCodeTask(input = '') {
  const text = String(input || '');
  if (!text) return false;
  if (/[\\/]([\w.-]+[\\/])?[\w.-]+\.\w+/.test(text)) return true;
  return /(文件|代码|修复|报错|命令|shell|终端|路径|目录|脚本|整理|清理|安装|启动|停止|部署|创建|生成|下载|上传|搜索|查找|运行|打开|关闭|删除|移动|复制|压缩|解压|桌面|重命名|read|edit|write|grep|glob|bash|fix|bug|compile|build|test|error|stack|trace|implement|refactor|api|endpoint|database|sql|organize|setup|deploy|create|generate|download|upload|search|find|run|open|close|delete|move|copy|compress|cleanup|rename)/i.test(text);
}

function shouldUseDirectFastPath(prompt, options = {}) {
  const override = String(process.env.GATEWAY_CLAUDE_DIRECT_FAST_PATH || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(override)) return false;
  if (['1', 'true', 'on', 'yes'].includes(override)) return true;
  // Strip [System ...] blocks appended by agenticHarnessService._buildLoopInput
  const raw = String(options.userMessage || prompt || '')
    .replace(/\n\n\[System\b[\s\S]*/i, '').trim();
  if (!raw) return false;
  if (looksLikeToolOrCodeTask(raw)) return false;
  return looksLikeSimpleGreeting(raw);
}

function shellEscapeArg(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function buildSeededShellCommand(args, prompt) {
  const initialUserLine = JSON.stringify(buildStreamUserMessage(prompt));
  const cliArgs = Array.isArray(args) ? args.map(shellEscapeArg).join(' ') : '';
  return `{ printf '%s\\n' ${shellEscapeArg(initialUserLine)}; cat; } | claude ${cliArgs}`;
}

function buildDefaultControlResponse(requestId, request = {}) {
  const subtype = String(request.subtype || '');
  if (subtype === 'can_use_tool') {
    // Auto-allow tool use in gateway mode — KHY has already validated the
    // request at its own security layer. Denying here causes the Claude CLI
    // subprocess to hang waiting for interactive permission confirmation.
    //
    // IMPORTANT: Claude CLI validates the response with a Zod schema that
    // requires `updatedInput` (Record<string, unknown>) when behavior is
    // "allow". Omitting it causes a ZodError → "权限组件有问题".
    const toolInput = (request && typeof request === 'object' && request.input)
      ? request.input
      : {};
    return {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'allow',
          updatedInput: toolInput,
        },
      },
    };
  }

  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {},
    },
  };
}

function normalizeControlResponse(requestId, request, rawResponse) {
  const fallback = buildDefaultControlResponse(requestId, request);
  if (!rawResponse || typeof rawResponse !== 'object') return fallback;

  // Full envelope already provided by caller.
  if (rawResponse.type === 'control_response' && rawResponse.response && typeof rawResponse.response === 'object') {
    const resp = { ...rawResponse.response };
    if (!resp.request_id) resp.request_id = requestId;
    return { type: 'control_response', response: resp };
  }

  // Caller returned inner response object: { subtype, response?/error? }
  if (rawResponse.subtype || rawResponse.response || rawResponse.error) {
    const resp = { ...rawResponse };
    if (!resp.request_id) resp.request_id = requestId;
    if (!resp.subtype) resp.subtype = resp.error ? 'error' : 'success';
    return { type: 'control_response', response: resp };
  }

  // Caller returned SDK payload directly: { behavior, updatedInput, ... }
  if (Object.prototype.hasOwnProperty.call(rawResponse, 'behavior')) {
    const sdkPayload = { ...rawResponse };
    // Ensure updatedInput is present for "allow" — Claude CLI Zod schema requires it
    if (sdkPayload.behavior === 'allow' && !sdkPayload.updatedInput) {
      sdkPayload.updatedInput = (request && typeof request === 'object' && request.input) ? request.input : {};
    }
    return {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: sdkPayload,
      },
    };
  }

  return fallback;
}

function shouldRetryClaudeTransient(err) {
  if (!err || isAbortLikeError(err)) return false;
  const lower = String(err && err.message ? err.message : err || '').toLowerCase();
  return /reconnecting|channel closed|failed to record rollout items|socket hang up|econnreset|network error|fetch failed|temporarily unavailable|broken pipe|handshake timeout|bridge canceled/.test(lower);
}

function shouldFallbackBridgeToDirect(err, errorType = 'unknown') {
  if (!err || isAbortLikeError(err)) return false;
  if (errorType === 'process') return true;
  if (!['timeout', 'network', 'unknown'].includes(errorType)) return false;

  const lower = String(err && err.message ? err.message : err || '').toLowerCase();
  // Bridge-mode transient signatures where direct API mode may still succeed.
  return /stream-json|handshake timeout|bridge canceled|without emitting stream-json output|channel closed|reconnecting|spawn|exited with code|launch blocked|failed to record rollout items|socket hang up|econnreset|econnrefused|enotfound|eai_again|network error|fetch failed|getaddrinfo|proxy|timeout|timed out/.test(lower);
}

/**
 * Process a stream-json event from Claude Code.
 * Delegates to shared _streamProcessor with Claude-specific options:
 *   - repairJson=true (use safeJsonParse for broken streams)
 *   - trackGenai=true (record tool use & LLM call events)
 */
function processStreamEvent(event, onChunk, appendContent, state) {
  if (!state) state = createStreamState();
  return _sharedProcessStreamEvent(event, onChunk, appendContent, state, {
    repairJson: true,
    trackGenai: true,
    getGenai: genai,
    toolStopEventType: 'tool_use',
    handleTopLevelToolEvents: false,
  });
}

async function runClaudeAttempt({
  launchMode = 'direct',
  prompt,
  rawUserMessage,
  args,
  timeoutMs = null,
  onChunk,
  onControlRequest,
  abortSignal = null,
}) {
  return new Promise((resolve, reject) => {
    let child = null;
    let abortWatcher = null;
    let terminationEscalationTimer = null;
    let aborted = false;
    let abortReason = '';
    let finished = false;
    let idleTimer = null;
    let handshakeTimer = null;
    let lastSubprocessActivityAt = Date.now();
    let childCloseObserved = false;
    const bridgeProgress = {
      startedAt: Date.now(),
      launchMode,
      firstEventAt: 0,
      lastEventAt: Date.now(),
      parsedEventCount: 0,
      controlRequestCount: 0,
      sawResult: false,
      contentChars: 0,
      lastEventType: 'spawn',
      stderrPreview: '',
      idleTimedOut: false,
      handshakeTimedOut: false,
    };

    const killChildTree = (signal = 'SIGTERM') => {
      if (!child) return;
      safeKill(child, signal, 0);
    };

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const clearTerminationEscalation = () => {
      if (terminationEscalationTimer) {
        clearTimeout(terminationEscalationTimer);
        terminationEscalationTimer = null;
      }
    };

    const markSubprocessActivity = () => {
      lastSubprocessActivityAt = Date.now();
      bridgeProgress.lastEventAt = lastSubprocessActivityAt;
    };

    const scheduleTerminationEscalation = (graceMs, phaseLabel) => {
      if (!Number.isFinite(graceMs) || graceMs <= 0) return;
      clearTerminationEscalation();

      const waitForIdleThenForceKill = () => {
        if (childCloseObserved || !child) {
          clearTerminationEscalation();
          return;
        }
        const idleMs = Date.now() - lastSubprocessActivityAt;
        if (idleMs < graceMs) {
          terminationEscalationTimer = setTimeout(
            waitForIdleThenForceKill,
            Math.max(100, graceMs - idleMs)
          );
          terminationEscalationTimer.unref?.();
          return;
        }
        try {
          onChunk({
            type: 'status',
            text: `Claude subprocess still active after ${phaseLabel}; no shutdown progress for ${Math.round(idleMs / 1000)}s, forcing SIGKILL`,
          });
        } catch { /* best effort */ }
        killChildTree('SIGKILL');
        clearTerminationEscalation();
      };

      terminationEscalationTimer = setTimeout(waitForIdleThenForceKill, graceMs);
      terminationEscalationTimer.unref?.();
    };

    const cleanupAbortWatcher = () => {
      if (abortWatcher && abortSignal && typeof abortSignal.removeEventListener === 'function') {
        try { abortSignal.removeEventListener('abort', abortWatcher); } catch { /* ignore */ }
      }
      abortWatcher = null;
      clearIdleTimer();
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    };

    const finishWithError = (err) => {
      if (finished) return;
      finished = true;
      cleanupAbortWatcher();
      reject(err instanceof Error ? err : new Error(String(err || 'unknown error')));
    };

    const finishWithSuccess = (value) => {
      if (finished) return;
      finished = true;
      cleanupAbortWatcher();
      resolve(value);
    };

    const abortChild = (reason) => {
      if (aborted) return;
      aborted = true;
      abortReason = normalizeAbortReason(reason);
      try { onChunk({ type: 'status', text: `Claude request aborted: ${abortReason}` }); } catch { /* best effort */ }
      if (child && !child.killed) {
        killChildTree('SIGTERM');
        scheduleTerminationEscalation(1200, 'abort cleanup');
      }
      finishWithError(new Error(`Claude request aborted: ${abortReason}`));
    };

    if (abortSignal && abortSignal.aborted) {
      finishWithError(new Error(`Claude request aborted: ${normalizeAbortReason(abortSignal.reason)}`));
      return;
    }

    if (abortSignal && typeof abortSignal.addEventListener === 'function') {
      abortWatcher = () => abortChild(abortSignal.reason);
      abortSignal.addEventListener('abort', abortWatcher, { once: true });
    }

    // Bridge handshake status suppressed — the adapter pulse
    // ("Claude Code 正在生成响应（已耗时 Ns）") already communicates
    // progress, and emitting a status chunk here caused terminal flooding
    // in the interactive REPL (the spinner/keepalive/prompt repaint cycle
    // turned this one-shot message into repeating lines).

    let shouldWriteInitialUserLine = true;
    if (launchMode === 'seeded_shell') {
      const shellCmd = buildSeededShellCommand(args, prompt);
      const _cfg = getShellConfiguration({ login: true });
      const sh = { cmd: _cfg.executable, args: [..._cfg.argsPrefix, shellCmd] };
      child = spawn(sh.cmd, sh.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        signal: abortSignal || undefined,
        detached: !isWin,
      });
      shouldWriteInitialUserLine = false;
    } else {
      const launchCmd = isWin ? (process.env.COMSPEC || 'cmd.exe') : 'claude';
      const launchArgs = isWin ? ['/d', '/s', '/c', 'claude.cmd', ...args] : args;
      const _sp = _portableClaudeSpawn(args, launchCmd, launchArgs);
      child = spawn(_sp.command, _sp.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        signal: abortSignal || undefined,
        detached: !isWin,
      });
    }

    const parserState = createStreamState({ _traceId: null, _model: null });

    // Extract model from args for trajectory tracking
    const modelArgIdx = args.indexOf('--model');
    if (modelArgIdx >= 0 && modelArgIdx + 1 < args.length) {
      parserState._model = args[modelArgIdx + 1];
    }
    // Generate a trace ID for this attempt
    try {
      parserState._traceId = `claude_${Date.now()}_${require('crypto').randomBytes(4).toString('hex')}`;
    } catch { /* fallback */ }
    let fullContent = '';
    let buffer = '';
    // 跨 chunk 边界安全的 UTF-8 解码器:防 stream-json 里的中文/emoji 被劈成 U+FFFD(◆)。见 _sseTextDecoder.js。
    const _textDecoder = require('./_sseTextDecoder').createSseTextDecoder();
    let sawResult = false;
    let controlQueue = Promise.resolve();
    let stderr = '';
    let parsedEventCount = 0;
    let idleTimedOut = false;
    let handshakeTimedOut = false;
    const controlResponseCache = new Map(); // request_id -> normalized response
    const seenControlRequestIds = new Set();

    // Handshake timeout — if no stream-json events arrive within HANDSHAKE_TIMEOUT_MS,
    // the CLI likely failed silently. Kill early so callers can retry faster.
    // Use a shorter timeout for simple greetings to speed up adapter cascade.
    const isSimple = looksLikeSimpleGreeting(rawUserMessage || prompt);
    const effectiveHandshakeMs = isSimple
      ? Math.min(HANDSHAKE_TIMEOUT_MS, Math.max(2000, parseInt(process.env.GATEWAY_CLAUDE_HANDSHAKE_SIMPLE_MS || '4000', 10) || 4000))
      : HANDSHAKE_TIMEOUT_MS;
    const effectiveIdleTimeoutMs = (() => {
      const parsedAttemptTimeoutMs = Number.parseInt(timeoutMs, 10);
      if (Number.isFinite(parsedAttemptTimeoutMs) && parsedAttemptTimeoutMs > 0) {
        return Math.max(1000, parsedAttemptTimeoutMs);
      }
      if (IDLE_TIMEOUT_MS > 0) return IDLE_TIMEOUT_MS;
      if (TIMEOUT_MS > 0) return Math.max(1000, TIMEOUT_MS);
      return 0;
    })();
    if (effectiveHandshakeMs > 0) {
      handshakeTimer = setTimeout(() => {
        if (finished || aborted || parsedEventCount > 0) return;
        handshakeTimedOut = true;
        try { onChunk({ type: 'status', text: `Claude stream-json handshake timeout after ${effectiveHandshakeMs}ms — no events received, killing subprocess` }); } catch { /* best effort */ }
        killChildTree('SIGTERM');
        scheduleTerminationEscalation(2000, 'stream-json handshake timeout');
      }, effectiveHandshakeMs);
      handshakeTimer.unref?.();
    }

    const resetIdleTimer = () => {
      if (!effectiveIdleTimeoutMs || effectiveIdleTimeoutMs <= 0 || finished || aborted) return;
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        if (finished || aborted || !child || child.killed) return;
        idleTimedOut = true;
        try {
          onChunk({
            type: 'status',
            text: `Claude bridge idle timeout (${Math.round(effectiveIdleTimeoutMs / 1000)}s no stream activity), terminating subprocess`,
          });
        } catch { /* best effort */ }
        killChildTree('SIGTERM');
        scheduleTerminationEscalation(3000, 'idle timeout recovery');
      }, effectiveIdleTimeoutMs);
      idleTimer.unref?.();
    };
    resetIdleTimer();

    const writeInputLine = (obj) => {
      if (!obj || finished || aborted) return false;
      if (!child.stdin || child.stdin.destroyed || child.killed) return false;
      try {
        child.stdin.write(`${JSON.stringify(obj)}\n`);
        return true;
      } catch {
        return false;
      }
    };

    const queueControlResponse = (event) => {
      const requestId = String(event.request_id || '');
      const request = event.request || {};
      if (!requestId || !request || typeof request !== 'object') return;
      bridgeProgress.controlRequestCount += 1;
      bridgeProgress.lastEventType = 'control_request';
      bridgeProgress.lastEventAt = Date.now();

      if (controlResponseCache.has(requestId)) {
        const cached = controlResponseCache.get(requestId);
        if (!writeInputLine(cached)) {
          finishWithError(new Error('Failed to resend cached control_response to Claude'));
        }
        return;
      }

      if (!seenControlRequestIds.has(requestId)) {
        seenControlRequestIds.add(requestId);
        try {
          onChunk({ type: 'control_request', requestId, request });
        } catch { /* best effort */ }
      }

      controlQueue = controlQueue
        .then(async () => {
          if (aborted || finished) return;
          let callbackResponse = null;
          if (onControlRequest) {
            try {
              callbackResponse = await onControlRequest({ requestId, request, event });
            } catch (err) {
              callbackResponse = {
                subtype: 'error',
                error: err && err.message ? err.message : 'Control request handler failed',
              };
            }
          }

          const responseMessage = normalizeControlResponse(requestId, request, callbackResponse);
          controlResponseCache.set(requestId, responseMessage);
          // Debug: emit what we're sending back so traces can diagnose issues
          try { onChunk({ type: 'status', text: `[ctrl] ${requestId.slice(0,8)}→${JSON.stringify(responseMessage.response?.response || {}).slice(0,80)}` }); } catch { /* best effort */ }
          if (!writeInputLine(responseMessage)) {
            throw new Error('Failed to send control_response to Claude');
          }
        })
        .catch((err) => {
          if (aborted || finished || isAbortLikeError(err)) return;
          try { onChunk({ type: 'status', text: `Control request failed: ${err.message || err}` }); } catch {}
          finishWithError(err);
        });
    };

    // Stream error handlers — prevent silent data loss on pipe errors
    child.stdout.on('error', (err) => {
      if (finished || aborted) return;
      markSubprocessActivity();
      try { onChunk({ type: 'status', text: `stdout error: ${err.message}` }); } catch { /* best effort */ }
    });
    child.stderr.on('error', () => {
      if (finished || aborted) return;
      markSubprocessActivity();
    });

    child.stdout.on('data', (chunk) => {
      if (finished || aborted) return;
      markSubprocessActivity();
      resetIdleTimer();
      buffer += _textDecoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (finished || aborted) return;
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          parsedEventCount += 1;
          bridgeProgress.parsedEventCount = parsedEventCount;
          bridgeProgress.lastEventType = String(event.type || 'event');
          bridgeProgress.lastEventAt = Date.now();
          if (!bridgeProgress.firstEventAt) bridgeProgress.firstEventAt = bridgeProgress.lastEventAt;
          // First valid event — clear handshake timer
          if (parsedEventCount === 1 && handshakeTimer) {
            clearTimeout(handshakeTimer);
            handshakeTimer = null;
          }
          if (event.type === 'control_request') {
            queueControlResponse(event);
            continue;
          }
          processStreamEvent(event, onChunk, (text) => { fullContent += text; }, parserState);
          if (event.type === 'result') {
            sawResult = true;
            bridgeProgress.sawResult = true;
            try { child.stdin.end(); } catch { /* ignore */ }
          }
        } catch { /* not valid JSON */ }
      }
    });

    // Claude CLI >= 2.x outputs stream-json events to stderr (stdout stays clean for piping).
    // Parse stderr the same way as stdout so events are captured regardless of which fd they arrive on.
    let stderrJsonBuffer = '';
    child.stderr.on('data', (chunk) => {
      if (finished) return;
      markSubprocessActivity();
      resetIdleTimer();
      const raw = chunk.toString();
      stderrJsonBuffer += raw;
      const stderrLines = stderrJsonBuffer.split('\n');
      stderrJsonBuffer = stderrLines.pop();
      let anyJson = false;
      for (const line of stderrLines) {
        if (finished || aborted) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Attempt to parse as stream-json event
        if (trimmed.startsWith('{')) {
          try {
            const event = JSON.parse(trimmed);
            if (event && typeof event.type === 'string') {
              anyJson = true;
              parsedEventCount += 1;
              bridgeProgress.parsedEventCount = parsedEventCount;
              bridgeProgress.lastEventType = String(event.type || 'event');
              bridgeProgress.lastEventAt = Date.now();
              if (!bridgeProgress.firstEventAt) bridgeProgress.firstEventAt = bridgeProgress.lastEventAt;
              if (parsedEventCount === 1 && handshakeTimer) {
                clearTimeout(handshakeTimer);
                handshakeTimer = null;
              }
              if (event.type === 'control_request') {
                queueControlResponse(event);
                continue;
              }
              processStreamEvent(event, onChunk, (text) => { fullContent += text; }, parserState);
              if (event.type === 'result') {
                sawResult = true;
                bridgeProgress.sawResult = true;
                try { child.stdin.end(); } catch { /* ignore */ }
              }
              continue;
            }
          } catch { /* not valid JSON, fall through to accumulate as plain stderr */ }
        }
        // Non-JSON stderr line — accumulate for error diagnostics
        if (stderr.length < MAX_BUFFER) stderr += trimmed + '\n';
        if (trimmed) bridgeProgress.stderrPreview = trimmed;
      }
      // If we didn't parse any JSON from this chunk, accumulate the entire raw chunk
      if (!anyJson && stderr.length < MAX_BUFFER) {
        // Only accumulate if nothing was already added line-by-line above
        // (avoid double-counting)
      }
    });

    child.on('close', (code) => {
      childCloseObserved = true;
      clearTerminationEscalation();
      clearIdleTimer();
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
      if (finished) return;
      // Drain trailing stdout buffer
      const trailingBuf = buffer.trim();
      if (trailingBuf && trailingBuf.startsWith('{')) {
        try {
          const event = JSON.parse(trailingBuf);
          parsedEventCount += 1;
          bridgeProgress.parsedEventCount = parsedEventCount;
          bridgeProgress.lastEventType = String(event.type || 'event');
          bridgeProgress.lastEventAt = Date.now();
          if (!bridgeProgress.firstEventAt) bridgeProgress.firstEventAt = bridgeProgress.lastEventAt;
          if (event.type === 'control_request') {
            queueControlResponse(event);
          } else {
            processStreamEvent(event, onChunk, (text) => { fullContent += text; }, parserState);
            if (event.type === 'result') {
              sawResult = true;
              bridgeProgress.sawResult = true;
            }
          }
        } catch {
          if (trailingBuf.length > 5) {
            try { onChunk({ type: 'status', text: `Discarded incomplete trailing data (${trailingBuf.length} chars)` }); } catch { /* best effort */ }
          }
        }
      }
      // Drain trailing stderr JSON buffer (Claude CLI >= 2.x sends stream-json to stderr)
      const trailingStderrBuf = stderrJsonBuffer.trim();
      if (trailingStderrBuf && trailingStderrBuf.startsWith('{')) {
        try {
          const event = JSON.parse(trailingStderrBuf);
          if (event && typeof event.type === 'string') {
            parsedEventCount += 1;
            bridgeProgress.parsedEventCount = parsedEventCount;
            bridgeProgress.lastEventType = String(event.type || 'event');
            bridgeProgress.lastEventAt = Date.now();
            if (!bridgeProgress.firstEventAt) bridgeProgress.firstEventAt = bridgeProgress.lastEventAt;
            if (event.type === 'control_request') {
              queueControlResponse(event);
            } else {
              processStreamEvent(event, onChunk, (text) => { fullContent += text; }, parserState);
              if (event.type === 'result') {
                sawResult = true;
                bridgeProgress.sawResult = true;
              }
            }
          }
        } catch { /* incomplete */ }
      }
      Promise.resolve(controlQueue).finally(() => {
        if (finished || aborted) return;
        bridgeProgress.contentChars = fullContent.length;
        bridgeProgress.sawResult = sawResult;
        bridgeProgress.idleTimedOut = idleTimedOut;
        bridgeProgress.handshakeTimedOut = handshakeTimedOut;
        bridgeProgress.stderrPreview = bridgeProgress.stderrPreview || stderr.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
        if (idleTimedOut) {
          finishWithError(attachClaudeBridgeDiagnostics(
            new Error(`Claude stream idle timeout after ${effectiveIdleTimeoutMs}ms`),
            bridgeProgress,
            { idleTimedOut: true }
          ));
          return;
        }

        if (handshakeTimedOut) {
          finishWithError(attachClaudeBridgeDiagnostics(
            new Error('Claude stream-json handshake timeout — subprocess produced no events'),
            bridgeProgress,
            { handshakeTimedOut: true }
          ));
          return;
        }

        // Detect "canceled" in stderr — Claude CLI returns this when stream-json
        // bridge protocol fails internally (not a user abort).
        const stderrLower = stderr.trim().toLowerCase();
        if (!sawResult && !fullContent.trim() && /\bcancele?d\b/.test(stderrLower) && !isAbortLikeError({ message: stderr })) {
          finishWithError(attachClaudeBridgeDiagnostics(
            new Error(`Claude CLI bridge canceled (stderr: ${stderr.trim().slice(0, 200)})`),
            bridgeProgress,
            { trigger: 'bridge_canceled', summary: 'Claude bridge canceled before usable completion' }
          ));
          return;
        }

        const emptySilentExit = code === 0 && !sawResult && !fullContent.trim() && !stderr.trim() && parsedEventCount === 0;
        if (emptySilentExit) {
          finishWithError(attachClaudeBridgeDiagnostics(
            new Error('Claude exited without emitting stream-json output'),
            bridgeProgress,
            { trigger: 'bridge_no_stream_events', summary: 'Claude bridge exited without emitting stream-json output' }
          ));
          return;
        }

        if (code === 0 || sawResult || fullContent.trim()) {
          finishWithSuccess(fullContent.trim());
        } else {
          const diag = diagnoseClaudeLaunchIssue();
          const reason = stderr.trim() || diag || `claude exited with code ${code}`;
          try { onChunk({ type: 'status', text: `Claude process failed: ${reason}` }); } catch {}
          finishWithError(attachClaudeBridgeDiagnostics(
            new Error(reason),
            bridgeProgress,
            { summary: 'Claude bridge process exited before successful completion' }
          ));
        }
      });
    });

    child.on('error', (err) => {
      if (finished || aborted) return;
      markSubprocessActivity();
      try { onChunk({ type: 'status', text: `Claude process error: ${err.message}` }); } catch {}
      if (isAbortLikeError(err)) {
        abortChild(err);
      } else {
        finishWithError(err);
      }
    });

    child.stdin.on('error', () => {});
    if (shouldWriteInitialUserLine && !writeInputLine(buildStreamUserMessage(prompt, rawUserMessage))) {
      finishWithError(attachClaudeBridgeDiagnostics(
        new Error('Failed to send initial prompt to Claude'),
        bridgeProgress,
        { trigger: 'bridge_prompt_write_failed', summary: 'Claude bridge failed while writing the initial prompt to stdin' }
      ));
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct Mode — call Anthropic Messages API directly, execute tools locally.
// Activated by GATEWAY_CLAUDE_MODE=direct.
// Eliminates CLI subprocess overhead (~5s startup + control_request protocol).
// ─────────────────────────────────────────────────────────────────────────────

function buildDirectToolDefs() {
  const deferEnabled = _deferralActive();
  try {
    const registry = require('../../../tools/index');
    const pool = registry.assembleToolPool(undefined, 'coding');
    const defs = [];

    for (const [name, tool] of pool) {
      if (deferEnabled && tool.shouldDefer && !tool.alwaysLoad) {
        // Deferred: name-only stub — Anthropic server loads full schema on demand
        defs.push({ name, defer_loading: true });
      } else {
        const fd = tool.toFunctionDef();
        defs.push({
          name: fd.name,
          description: fd.description || '',
          input_schema: fd.parameters || { type: 'object', properties: {} },
        });
      }
    }

    // Append Anthropic server-side tool search so the model can discover deferred tools
    if (deferEnabled) {
      defs.push({
        type: 'tool_search_tool_regex_20251119',
        name: 'tool_search',
      });
    }

    return defs;
  } catch {
    // Fallback: hardcoded core tools (no deferral) when registry unavailable
    return [
      { name: 'Bash', description: 'Execute a shell command. Prefer Glob over find, Grep over grep, Read over cat, Edit over sed, Write over echo.', input_schema: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute' }, timeout: { type: 'number', description: 'Timeout in ms (max 60000)' } }, required: ['command'] } },
      { name: 'Read', description: 'Read a file from the filesystem. Returns content with line numbers (cat -n format).', input_schema: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path to the file' }, offset: { type: 'number', description: 'Line number to start from (1-based)' }, limit: { type: 'number', description: 'Number of lines to read' } }, required: ['file_path'] } },
      { name: 'Glob', description: 'Find files by glob pattern. Use instead of find command.', input_schema: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern (e.g. **/*.js)' }, path: { type: 'string', description: 'Directory to search in' } }, required: ['pattern'] } },
      { name: 'Grep', description: 'Search file contents with regex. Use instead of grep/rg command.', input_schema: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern to search' }, path: { type: 'string', description: 'File or directory to search' }, output_mode: { type: 'string', description: 'content, files_with_matches, or count' } }, required: ['pattern'] } },
      { name: 'Edit', description: 'Exact string replacement in files. Must Read the file first. Fails if old_string is not unique.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] } },
      { name: 'Write', description: 'Write/create a file. Must Read existing files first before overwriting.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
    ];
  }
}

/**
 * Direct tool dispatcher — bypasses `toolCalling.executeTool`'s routing chain
 * which prefers the legacy `read_file` builtin (no offset/limit, capped at
 * 10 000 chars) over the Claude-Code-compatible FileReadTool. We resolve each
 * Claude Code tool name to its canonical subdirectory implementation
 * (FileReadTool, FileEditTool, FileWriteTool, GrepTool, GlobTool) and call
 * `.execute()` directly with the exact Claude Code input schema.
 *
 * Falls back to `executeTool` for any tool not in our explicit map (e.g. Bash).
 */
// @deprecated — replaced by unified toolCalling.executeTool() path.
// Kept temporarily for rollback safety.
async function dispatchDirectTool(name, input) {
  const dir = (() => {
    switch (name) {
      case 'Read': return 'FileReadTool';
      case 'Edit': return 'FileEditTool';
      case 'Write': return 'FileWriteTool';
      case 'Grep': return 'GrepTool';
      case 'Glob': return 'GlobTool';
      default: return null;
    }
  })();

  if (dir) {
    try {
      const toolModule = require(`../../../tools/${dir}`);
      // toolModule is either an instance (module.exports = new FooTool()) or has .default
      const instance = (toolModule && typeof toolModule.execute === 'function')
        ? toolModule
        : (toolModule && toolModule.default && typeof toolModule.default.execute === 'function')
          ? toolModule.default
          : null;
      if (instance) {
        return await instance.execute(input || {}, {});
      }
    } catch (err) {
      // Fall through to executeTool fallback below
      return { success: false, error: `Direct tool load failed for ${name}: ${err.message}` };
    }
  }

  // Fallback for tools without a Claude-Code-compatible subdirectory (Bash etc.)
  const toolCalling = require('../../toolCalling');
  return await toolCalling.executeTool(name, input || {});
}

function buildDirectSystemPrompt() {
  const cwd = process.cwd();
  return [
    'You are a senior software engineer assistant with direct tool access.',
    'Execute tasks immediately — Read, Edit, verify, done.',
    '',
    'Rules:',
    '- When the prompt gives a file path and line number, Read ONLY that range. Do NOT search for what is already specified.',
    '- Do NOT re-read files you have already read.',
    '- After Edit, run ONE syntax check then output your summary.',
    '- Prefer Edit over Write for modifying existing files.',
    '- Read a file before editing it.',
    '- Use Glob to find files by name pattern. Use Grep to search file contents.',
    '- Use Bash for shell commands, compilation, and tests.',
    '- Keep code identifiers, comments, and logs in English.',
    '',
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}`,
  ].join('\n');
}

/**
 * Call Anthropic Messages API with streaming, parse SSE events.
 * Returns { content: string, toolUseBlocks: [], model, finishReason, usage, thinking }
 * (pipeline return shape). Passthrough mode returns a legacy shape with passthrough: true.
 */
async function callAnthropicStream(apiKey, baseUrl, body, emit, signal, passthroughOptions, authScheme) {
  let http;
  try { http = require('axios'); } catch {
    // Fallback: use the project-local axios
    http = require(path.resolve(process.cwd(), 'node_modules/axios'));
  }

  body.stream = true;

  // For streaming: use a connection-phase timeout only.
  // Once first bytes arrive, clear the timer — extended thinking / tool use
  // may run for minutes; killing the stream mid-flight causes needless failures.
  const connectTimeoutMs = Math.min(DIRECT_TIMEOUT_MS, 60_000);
  const streamIdleTimeoutMs = DIRECT_TIMEOUT_MS; // kill if no data for this long
  const ac = new AbortController();
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  const connectTimer = setTimeout(() => ac.abort(), connectTimeoutMs);

  const _postHeaders = () => ({
    ..._buildAnthropicAuthHeaders(apiKey, authScheme),
    'anthropic-version': '2024-10-22',
    ...(_deferralActive() ? { 'anthropic-beta': _buildBetaHeader(body.model) } : {}),
    'Content-Type': 'application/json',
  });

  let resp;
  try {
    resp = await http.post(`${baseUrl}/v1/messages`, body, {
      headers: _postHeaders(),
      responseType: 'stream',
      signal: ac.signal,
    });
    clearTimeout(connectTimer);
  } catch (err) {
    clearTimeout(connectTimer);
    // Beta auto-fallback: if the live API rejects the request (400) because of
    // an optional T0 beta token we added, drop those betas (sticky for the
    // session) and retry once with the proven-safe header. tool-search stays.
    const retried = await _maybeRetryWithoutBetas(err, http, baseUrl, body, ac, _postHeaders);
    if (retried) {
      resp = retried.resp;
      // Surface the silent beta downgrade to the user (relayApiAdapter uses the
      // same `{type:'notice'}` chunk for its tool-strip). Best-effort, gated by
      // KHY_BETA_FALLBACK_NOTICE inside the leaf — the retry above already ran.
      try {
        const { buildBetaFallbackNotice } = require('../../../cli/betaFallbackNotice');
        const notice = buildBetaFallbackNotice(retried.strippedBetas);
        if (notice) emit?.({ type: 'notice', text: notice });
      } catch { /* notice is best-effort — never block the stream */ }
    } else throw err;
  }

  // Stale stream detection: use shared StreamStaleDetector instead of manual setTimeout
  let _staleDetectorMod;
  try { _staleDetectorMod = require('./_streamStaleDetector'); } catch { _staleDetectorMod = null; }

  // ── Passthrough 模式：原始 SSE 直接转发，跳过 parse/reconstruct ──
  if (passthroughOptions && typeof passthroughOptions.onRawChunk === 'function') {
    return new Promise((resolve, reject) => {
      let staleDetector = null;
      if (_staleDetectorMod) {
        staleDetector = _staleDetectorMod.attachStaleDetector(resp.data, {
          provider: 'claude',
          abortController: ac,
          onWarn: (elapsed) => emit?.({ type: 'progress', message: `[stale-warn] No data for ${Math.round(elapsed / 1000)}s` }),
        });
      } else {
        // Fallback: manual idle timer
        var _idleTimer = setTimeout(() => ac.abort(), streamIdleTimeoutMs);
        var _resetIdle = () => { clearTimeout(_idleTimer); _idleTimer = setTimeout(() => ac.abort(), streamIdleTimeoutMs); };
      }
      resp.data.on('data', (chunk) => {
        if (!staleDetector) _resetIdle();
        passthroughOptions.onRawChunk(chunk);
      });
      resp.data.on('end', () => {
        if (staleDetector) staleDetector.stop(); else clearTimeout(_idleTimer);
        resolve({ content: [], model: '', stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, passthrough: true });
      });
      resp.data.on('error', (err) => {
        if (staleDetector) staleDetector.stop(); else clearTimeout(_idleTimer);
        reject(err);
      });
    });
  }

  // ── Non-passthrough: delegate SSE parsing to protocol pipeline ──
  // _anthropicHandler.parseStreamResponse handles SSE framing, content block
  // accumulation, tool_use JSON repair, and stale detection internally.
  // Stale detection options mirror the old attachStaleDetector behavior.
  const staleOpts = _staleDetectorMod ? {
    enableStaleDetection: true,
    staleOptions: {
      provider: 'claude',
      onStale: (elapsed) => {
        emit?.({ type: 'progress', message: `[stale-warn] No data for ${Math.round(elapsed / 1000)}s` });
        ac.abort();
      },
    },
  } : {};

  // Manual idle timer fallback when _staleDetectorMod is unavailable
  let _fallbackIdleTimer = null;
  const _clearFallbackIdle = () => { if (_fallbackIdleTimer) { clearTimeout(_fallbackIdleTimer); _fallbackIdleTimer = null; } };
  if (!_staleDetectorMod) {
    _fallbackIdleTimer = setTimeout(() => ac.abort(), streamIdleTimeoutMs);
    resp.data.on('data', () => {
      _clearFallbackIdle();
      _fallbackIdleTimer = setTimeout(() => ac.abort(), streamIdleTimeoutMs);
    });
  }

  try {
    const result = await _anthropicHandler.parseStreamResponse(resp.data, emit, {
      signal: ac.signal,
      ...staleOpts,
    });
    _clearFallbackIdle();
    return result;
  } catch (err) {
    _clearFallbackIdle();
    throw err;
  }
}

/**
 * Direct agentic loop: Anthropic Messages API → local tool execution → loop.
 */
async function runClaudeDirect(prompt, options = {}) {
  // Priority: env vars > apiKeyPool
  const _cred = _resolveAnthropicCredentialFromEnv(process.env);
  let apiKey = _cred.apiKey;
  let credSource = _cred.source;
  let poolKeyId = null;
  let poolEndpoint = null;

  if (!apiKey) {
    try {
      const pool = require('../../apiKeyPool');
      pool.init();
      const picked = pool.pick('anthropic');
      if (picked) {
        apiKey = picked.key;
        poolKeyId = picked.keyId;
        poolEndpoint = picked.endpoint || null;
        credSource = 'pool';
      }
    } catch { /* pool unavailable */ }
  }

  if (!apiKey) throw new Error('No Anthropic API key — set ANTHROPIC_API_KEY or add keys via API Key Pool');

  // Auth header scheme: AUTH_TOKEN relays expect `Authorization: Bearer`, official
  // api.anthropic.com expects `x-api-key`. Source-aware (see _resolveAnthropicAuthScheme).
  const authScheme = _resolveAnthropicAuthScheme(credSource, process.env);

  // Strip trailing /v1, /v1/, etc. — callAnthropicStream appends /v1/messages itself.
  const baseUrl = (poolEndpoint || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com')
    .replace(/\/+$/, '')
    .replace(/\/v\d+$/, '');
  const model = options.model || process.env.ANTHROPIC_MODEL || MODELS.sonnet;
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : () => {};
  const emit = (chunk) => { try { onChunk(chunk); } catch { /* best effort */ } };

  // Strip [System ...] blocks appended by agenticHarnessService._buildLoopInput
  // so greeting/fast-path detection sees only the actual user input.
  const rawUserMessage = String(options.userMessage || prompt || '')
    .replace(/\n\n\[System\b[\s\S]*/i, '').trim();
  const useDirectFastPath = shouldUseDirectFastPath(prompt, options);
  const promptForModel = useDirectFastPath
    ? (rawUserMessage || String(prompt || ''))
    : applyAgenticGuidancePrefix(prompt, rawUserMessage);
  const tools = useDirectFastPath ? [] : buildDirectToolDefs();
  const inheritedSystem = String(options.system || '').trim();
  let system = useDirectFastPath
    ? (inheritedSystem || [
      'You are a concise, helpful assistant.',
      'Respond directly and briefly.',
      'Do not use tools unless absolutely necessary.',
      `Working directory: ${process.cwd()}`,
      `Platform: ${process.platform}`,
    ].join('\n'))
    : (inheritedSystem || buildDirectSystemPrompt());
  // Append intentGate directive (e.g. CODING_DIRECTIVE, ULTRAWORK_DIRECTIVE)
  // so the model receives behavioural instructions in the system prompt.
  const intentDirective = String(options._intentDirective || '').trim();
  if (intentDirective && !useDirectFastPath) {
    system += '\n\n' + intentDirective;
  }

  // directRoundLimit no longer needed — toolUseLoop handles iteration.

  // Build conversation messages (with optional vision / document support)
  let userContent;
  const _imageBlocks = Array.isArray(options.images) && options.images.length > 0
    ? toAnthropicImageBlocks(options.images || []) : [];
  const _documentBlocks = Array.isArray(options.documents) && options.documents.length > 0
    ? toAnthropicDocumentBlocks(options.documents || []) : [];
  if (_imageBlocks.length > 0 || _documentBlocks.length > 0) {
    // Multi-modal: text + image(s)/document(s) in content array. Documents
    // (e.g. native PDF) give Opus full-fidelity reading beyond text extraction.
    userContent = [{ type: 'text', text: promptForModel }];
    for (const block of _documentBlocks) userContent.push(block);
    for (const block of _imageBlocks) userContent.push(block);
  } else {
    userContent = promptForModel;
  }
  // Build conversation messages: prefer structured multi-turn history from options,
  // fall back to single user message for backwards compatibility.
  let messages;
  if (Array.isArray(options.structuredMessages) && options.structuredMessages.length > 1) {
    // structuredMessages contains system + user/assistant turns.
    // Filter out system messages (handled via separate `system` param) and
    // ensure the current user message (with possible images) is the final entry.
    const historyMsgs = options.structuredMessages.filter(m => m.role !== 'system');
    // Replace or append the last user message with potentially image-augmented content.
    // 但如果最后一条 user 消息是结构化 tool_result content blocks，不覆盖 —
    // 它已经是正确的 Anthropic 格式，覆盖会丢失 tool_use_id 关联。
    const lastMsg = historyMsgs.length > 0 ? historyMsgs[historyMsgs.length - 1] : null;
    const lastIsToolResult = lastMsg && lastMsg.role === 'user'
      && Array.isArray(lastMsg.content)
      && lastMsg.content.some(b => b && b.type === 'tool_result');
    if (lastIsToolResult) {
      // tool_result 消息保持原样，不覆盖
      messages = historyMsgs;
    } else if (lastMsg && lastMsg.role === 'user') {
      historyMsgs[historyMsgs.length - 1] = { role: 'user', content: userContent };
      messages = historyMsgs;
    } else {
      historyMsgs.push({ role: 'user', content: userContent });
      messages = historyMsgs;
    }
  } else {
    messages = [{ role: 'user', content: userContent }];
  }

  const state = { toolCalls: 0, toolDurationMs: 0, finalText: [], toolCallLog: [], lastStopReason: null, toolUseBlocks: [], thinkingBlocks: [], totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0 };

  emit({
    type: 'status',
    text: useDirectFastPath
      ? `⚡ 直连 Anthropic API（快速路径）：model=${model}`
      : `⚡ 直连 Anthropic API：model=${model}, tools=${tools.length}`,
  });

  const startMs = Date.now();

  // ── Passthrough 模式：原始 SSE 直接转发，跳过工具循环 ──
  if (options.passthroughStream && typeof options.onRawChunk === 'function') {
    const body = {
      model,
      max_tokens: options.maxTokens || 16384,
      system,
      messages,
    };
    // 优先使用原始工具定义（保留服务端工具 type 字段如 web_search_20250305）
    const passthroughTools = options.rawTools || (tools.length > 0 ? tools : null);
    if (passthroughTools && passthroughTools.length > 0) {
      body.tools = passthroughTools;
      body.tool_choice = { type: 'auto' };
    }
    const thinkingAllowed = options.thinkingEnabled !== false;
    const wantThinking = thinkingAllowed && !useDirectFastPath && /opus|claude-4/i.test(model);
    if (wantThinking) {
      const budget = (options.thinking && (options.thinking.budgetTokens || options.thinking.budget_tokens))
        || _defaultThinkingBudget(model);
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.max_tokens = Math.max(body.max_tokens, budget + 4096);
    } else {
      body.thinking = { type: 'disabled' };
    }
    emit({ type: 'status', text: `⚡ Claude Direct Passthrough → ${baseUrl}` });
    const result = await callAnthropicStream(apiKey, baseUrl, body, emit, options.abortSignal, {
      onRawChunk: options.onRawChunk,
    }, authScheme);
    return {
      content: '',
      toolSummary: null,
      elapsedMs: Date.now() - startMs,
      passthrough: true,
    };
  }

  // P0-4: Single-round API call — tool loop is handled by toolUseLoop.js.
  // claudeAdapter only does: build body → call API → parse response → return.
  // If the model returns tool_use blocks, they are passed back as toolUseBlocks
  // for the upper layer (toolUseLoop) to execute and continue the loop.
  try {
    const isComplexInput = !useDirectFastPath;
    const effectiveTools = isComplexInput ? tools : [];

    // GAP 8: 3-breakpoint prompt caching — system, tools, conversation context
    // Set cache_control on the penultimate user message so the API can cache
    // all earlier conversation turns (stable context) separately from the latest turn.
    if (messages.length >= 3) {
      for (let i = messages.length - 2; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const content = messages[i].content;
          if (typeof content === 'string') {
            messages[i].content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
          } else if (Array.isArray(content) && content.length > 0) {
            const last = content[content.length - 1];
            content[content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
          }
          break;
        }
      }
    }

    // Break-cache (/break-cache, aligns with Claude Code): when a once-marker or
    // always-flag is active, prepend a unique nonce comment to the system prompt
    // so the prefix-cache hash changes and the next API call misses the cache.
    // Gate KHY_BREAK_CACHE default-on; off → returns '' (byte-identical, never
    // mutates `system`). The once-marker is consumed (deleted) here exactly once.
    try {
      const _bcNonce = require('../breakCacheState').consumeCacheBreakNonce(process.env);
      if (_bcNonce) system = _bcNonce + system;
    } catch { /* break-cache is best-effort; never block a request */ }

    // Stable-prefix mode (DESIGN-ARCH-047): when the system prompt carries the
    // dynamic boundary marker (only emitted under KHY_STABLE_PREFIX=1), split it
    // into a byte-stable static prefix (cache breakpoint here) + a volatile
    // dynamic suffix. The marker presence is the signal — when off, splitSystem
    // returns an empty prefix and we keep today's single-block behavior. Either
    // way the marker never reaches the wire (split/strip both remove it).
    //
    // TTL note: Anthropic `cache_control: ephemeral` entries live ~5 minutes.
    // Consecutive tool-use rounds within a request keep the prefix warm (each
    // turn refreshes the TTL); an idle gap > ~5 min lets it expire, so the next
    // request re-pays cache_creation on the prefix. No keep-alive ping is needed
    // — the tool loop's own cadence keeps it hot during active work.
    const _systemPart = (() => {
      let split;
      try {
        split = require('../../../constants/systemPromptBoundary').splitSystemPromptAtBoundary(system);
      } catch {
        split = { staticPrefix: '', dynamicSuffix: system };
      }
      if (split.staticPrefix) {
        const blocks = [{ type: 'text', text: split.staticPrefix, cache_control: { type: 'ephemeral' } }];
        if (split.dynamicSuffix) blocks.push({ type: 'text', text: split.dynamicSuffix });
        return blocks;
      }
      const plain = split.dynamicSuffix;
      return plain.length > 500
        ? [{ type: 'text', text: plain, cache_control: { type: 'ephemeral' } }]
        : plain;
    })();

    const body = {
      model,
      max_tokens: useDirectFastPath
        ? Math.min(options.maxTokens || DIRECT_SIMPLE_MAX_TOKENS, DIRECT_SIMPLE_MAX_TOKENS)
        : (options.maxTokens || 8192),
      system: _systemPart,
      messages,
    };
    if (effectiveTools.length > 0) {
      body.tools = effectiveTools;
      if (body.tools.length > 0) {
        const last = body.tools[body.tools.length - 1];
        body.tools[body.tools.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
      }
    }

    // Extended thinking
    const thinkingAllowed = options.thinkingEnabled !== false;
    const _explicitBudget = options.thinking && (options.thinking.budgetTokens || options.thinking.budget_tokens);
    const wantThinking = thinkingAllowed && !useDirectFastPath && (
      _explicitBudget
      || isComplexInput
    );
    if (wantThinking) {
      const budget = _explicitBudget || _defaultThinkingBudget(model);
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.max_tokens = Math.max(body.max_tokens, budget + 4096);
    } else {
      body.thinking = { type: 'disabled' };
    }

    // Force tool use based on intent gate mode
    if (effectiveTools.length > 0) {
      const intentChoice = String(options._intentToolChoice || '').trim();
      if (intentChoice === 'required') {
        body.tool_choice = { type: 'any' };
      } else {
        body.tool_choice = { type: 'auto' };
      }
    }

    let result = await callAnthropicStream(apiKey, baseUrl, body, emit, options.abortSignal, undefined, authScheme);

    // Record genai events
    const g = genai();
    if (g) {
      try {
        g.recordLLMCall({
          traceId: `claude_direct_${startMs}`,
          model: result.model || model,
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
          durationMs: Date.now() - startMs,
        });
      } catch { /* best effort */ }
    }

    state.lastStopReason = result.finishReason || null;

    // Accumulate token usage (含 prompt 缓存计费字段) across the direct-mode loop so
    // the cache-economy probe can see Claude-Direct — it sets cache_control, so its
    // hit rate is meaningful. Previously this path returned NO tokenUsage at all.
    if (result.usage) {
      state.totalInputTokens += result.usage.input_tokens || 0;
      state.totalOutputTokens += result.usage.output_tokens || 0;
      const _c = normalizeCacheUsage(result.usage);
      state.totalCacheReadTokens += _c.cacheReadInputTokens;
      state.totalCacheWriteTokens += _c.cacheWriteInputTokens;
    }

    // Pipeline returns { content: string, toolUseBlocks: [], model, finishReason, usage, thinking }
    // Text and thinking were already emitted via `emit` callback during streaming.
    const toolUseBlocks = result.toolUseBlocks || [];
    // Structured thinking blocks (with signature) for cross-turn continuity.
    // Empty for non-thinking responses → downstream behavior unchanged.
    let thinkingBlocks = Array.isArray(result.thinkingBlocks) ? result.thinkingBlocks : [];
    if (result.content) {
      state.finalText.push(result.content);
    }

    // Truncation recovery: if text response was cut off by max_tokens, continue
    if (toolUseBlocks.length === 0 && result.finishReason === 'length') {
      let continuationAttempts = 0;
      // Rebuild content blocks from pipeline result for the assistant continuation message
      let lastFinishReason = result.finishReason;
      while (lastFinishReason === 'length' && continuationAttempts < 3) {
        continuationAttempts++;
        emit({ type: 'status', text: `Claude Direct: 回复被截断，续传中 (${continuationAttempts}/3)` });
        // Reconstruct Anthropic-format content blocks for the assistant message.
        // Prefer signed thinking blocks (echo-back keeps extended-thinking valid);
        // fall back to the flat thinking string when no signed blocks are present.
        const assistantBlocks = [];
        if (Array.isArray(result.thinkingBlocks) && result.thinkingBlocks.length > 0) {
          for (const tb of result.thinkingBlocks) assistantBlocks.push(tb);
        } else if (result.thinking) {
          assistantBlocks.push({ type: 'thinking', thinking: result.thinking });
        }
        if (result.content) assistantBlocks.push({ type: 'text', text: result.content });
        messages.push({ role: 'assistant', content: assistantBlocks.length > 0 ? assistantBlocks : [{ type: 'text', text: '' }] });
        messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue from where you left off. Do not repeat what you already said.' }] });
        const contResult = await callAnthropicStream(apiKey, baseUrl, { ...body, messages: messages.slice() }, emit, options.abortSignal, undefined, authScheme);
        // contResult now uses pipeline shape — text already emitted via emit
        if (contResult.content) {
          state.finalText.push(contResult.content);
        }
        if (Array.isArray(contResult.thinkingBlocks) && contResult.thinkingBlocks.length > 0) {
          thinkingBlocks = contResult.thinkingBlocks;
        }
        lastFinishReason = contResult.finishReason;
        result = contResult;
      }
    }

    // If the model returned tool_use blocks, pass them back to toolUseLoop.
    // Do NOT execute tools here — that's toolUseLoop's responsibility.
    if (toolUseBlocks.length > 0) {
      state.lastStopReason = 'tool_use';
    }

    emit({ type: 'status', text: `Claude Direct: API call complete, ${toolUseBlocks.length} tool calls pending` });

    // Store toolUseBlocks for return
    state.toolUseBlocks = toolUseBlocks;
    state.thinkingBlocks = thinkingBlocks;
  } catch (loopErr) {
    if (poolKeyId) {
      try {
        const pool = require('../../apiKeyPool');
        const statusCode = loopErr.response?.status || loopErr.status || 0;
        pool.markFailure(poolKeyId, statusCode, loopErr.message || 'direct mode error');
      } catch { /* best effort */ }
    }
    throw loopErr;
  }

  // Track pool key success
  if (poolKeyId) {
    try { require('../../apiKeyPool').markSuccess(poolKeyId); } catch { /* best effort */ }
  }

  const content = state.finalText.join('\n').trim();
  return {
    content: content || '',
    toolSummary: { totalCalls: state.toolCalls, totalDurationMs: state.toolDurationMs },
    toolCallLog: state.toolCallLog,
    toolUseBlocks: state.toolUseBlocks || [],
    thinkingBlocks: state.thinkingBlocks || [],
    stopReason: state.lastStopReason,
    elapsedMs: Date.now() - startMs,
    tokenUsage: (state.totalInputTokens || state.totalOutputTokens
      || state.totalCacheReadTokens || state.totalCacheWriteTokens)
      ? {
        inputTokens: state.totalInputTokens,
        outputTokens: state.totalOutputTokens,
        totalTokens: state.totalInputTokens + state.totalOutputTokens,
        ...(state.totalCacheReadTokens || state.totalCacheWriteTokens
          ? { cacheReadInputTokens: state.totalCacheReadTokens, cacheWriteInputTokens: state.totalCacheWriteTokens }
          : {}),
      }
      : null,
  };
}

/**
 * Whether the bridge tool_use collector should prefer chunk.rawInput (the real
 * structured object) over chunk.input (a truncated DISPLAY summary string).
 *
 * Dogfood bug: `_streamProcessor` emits every tool_use chunk with BOTH `input`
 * (a short human-readable summary, e.g. `command=echo hi`) and `rawInput` (the
 * real object, e.g. `{command:"echo hi"}`). The bridge collector historically
 * read `chunk.input`, so a shell command round-tripped into `{raw:"command=…"}`
 * or — when the chunk was emitted at content_block_start before any
 * input_json_delta arrived — into `{}`, dropping the command entirely. A lost
 * command reaches the syscall gateway as an empty shell call →
 * classifyCommandRisk('') → critical → L2 → in a non-interactive (headless
 * `khy -p`/pipe/background) run the gateway fail-closes, so echo/node/sleep/
 * timeout could never actually run through the Claude Code CLI bridge. Reading
 * rawInput preserves the command; combined with the shell-tool risk match this
 * makes `echo` classify safe (L0, auto-run) and node/sleep/timeout L1. Local
 * gate (mirrors changeWatchService/_shellToolRiskMatchEnabled precedent) so the
 * fix byte-reverts to the summary path when disabled.
 */
const _BRIDGE_RAWINPUT_OFF = ['0', 'false', 'off', 'no'];
function _bridgeToolUseRawInputEnabled(env = process.env) {
  const v = String((env && env.KHY_BRIDGE_TOOLUSE_RAW_INPUT) || '').trim().toLowerCase();
  return !_BRIDGE_RAWINPUT_OFF.includes(v);
}

/**
 * Generate a response using Claude Code CLI.
 */
async function generate(prompt, options = {}) {
  const requestId = String(options.requestId || options._diagTraceId || '').trim();
  // ── Resolve connection mode ──
  // Priority: ::mode suffix in model id > options.directMode > env > auto
  let useDirect;
  let resolvedModel = options.model;
  if (typeof options.model === 'string' && options.model.includes('::')) {
    const parsed = parseModelId(options.model);
    resolvedModel = parsed.modelId;
    if (parsed.mode === 'direct') useDirect = true;
    else if (parsed.mode === 'bridge' || parsed.mode === 'cli') useDirect = false;
    else if (parsed.mode === 'auto') useDirect = _hasAnthropicKey();
  }
  if (useDirect === undefined) {
    if (options.directMode === true) useDirect = true;
    else if (options.directMode === false) useDirect = false;
    else useDirect = resolveConnectionMode() === 'direct';
  }
  // Replace options.model with the base model id (strip ::mode suffix)
  if (resolvedModel !== options.model) options = { ...options, model: resolvedModel };
  if (useDirect) {
    try {
      const result = await runClaudeDirect(prompt, options);
      return buildSuccess(result.content, {
        adapter: 'claude',
        provider: `Claude Direct (${options.model || process.env.ANTHROPIC_MODEL || MODELS.sonnet})`,
        mode: 'direct',
        passthrough: !!result.passthrough,
        toolSummary: result.toolSummary,
        toolCallLog: result.toolCallLog || [],
        toolUseBlocks: result.toolUseBlocks || [],
        thinkingBlocks: result.thinkingBlocks || [],
        stopReason: result.stopReason || null,
        elapsedMs: result.elapsedMs,
        attempts: [{ provider: 'Claude Direct', success: true }],
      });
    } catch (err) {
      const safeError = formatErrorMessage(err);
      recordRuntimeDiagnostics({
        requestId,
        healed: false,
        trigger: 'direct_failure',
        category: 'transport',
        phase: 'direct',
        summary: 'Claude direct API call failed',
        diagnosis: safeError || err.message,
        lastError: safeError || err.message,
      });
      return buildFailure(safeError || err.message, {
        adapter: 'claude',
        provider: 'Claude Direct',
        mode: 'direct',
        errorType: classifyAdapterError(err),
        diagnostics: {
          trigger: 'direct_failure',
          summary: 'Claude direct API call failed',
          progressSummary: _runtimeDiagnosticsStore.compactText(safeError || err.message, 320),
        },
        attempts: [{ provider: 'Claude Direct', success: false, error: safeError || err.message }],
      });
    }
  }

  // ── CLI mode (original path) ──
  if (!detect()) {
    return buildFailure('Claude Code CLI not installed (command "claude" not found)', {
      adapter: 'claude',
      provider: 'Claude Code',
      errorType: 'unavailable',
      attempts: [{ provider: 'Claude Code', success: false, error: 'Claude Code CLI not installed (command "claude" not found)', errorType: 'unavailable' }],
    });
  }

  const _rawOnChunk = options.onChunk || (() => {});
  // 收集 bridge 模式中的 tool_use 块和 stop_reason，确保返回值完整
  const _bridgeToolUseBlocks = [];
  const _bridgeBlockById = new Map(); // Fix F dedup: same id may emit empty@start then full@stop
  let _bridgeStopReason = null;
  const _bridgeRawInputEnabled = _bridgeToolUseRawInputEnabled();
  // Fix F: derive the tool input, preferring the real structured object
  // (chunk.rawInput) over the truncated display summary (chunk.input). See
  // _bridgeToolUseRawInputEnabled() for why the summary path dropped commands.
  const _coerceBridgeInput = (chunk) => {
    if (_bridgeRawInputEnabled
        && chunk.rawInput && typeof chunk.rawInput === 'object'
        && !Array.isArray(chunk.rawInput)
        && Object.keys(chunk.rawInput).length > 0) {
      return chunk.rawInput;
    }
    return typeof chunk.input === 'string'
      ? (() => { try { return JSON.parse(chunk.input); } catch { return { raw: chunk.input }; } })()
      : (chunk.input || {});
  };
  const onChunk = (chunk) => {
    if (chunk && chunk.type === 'tool_use' && chunk.tool) {
      const parsedInput = _coerceBridgeInput(chunk);
      if (_bridgeRawInputEnabled && chunk.id) {
        // Dedup by id, keeping the emission carrying the most input keys — the
        // content_block_start emission has an empty input, content_block_stop the
        // full one. Same object is shared between the map and the array, so the
        // in-place update is reflected in _bridgeToolUseBlocks.
        const prev = _bridgeBlockById.get(chunk.id);
        if (!prev) {
          const block = { name: chunk.tool, input: parsedInput, id: chunk.id };
          _bridgeBlockById.set(chunk.id, block);
          _bridgeToolUseBlocks.push(block);
        } else if (Object.keys(parsedInput || {}).length > Object.keys(prev.input || {}).length) {
          prev.input = parsedInput;
          prev.name = chunk.tool;
        }
      } else {
        _bridgeToolUseBlocks.push({
          name: chunk.tool,
          input: parsedInput,
          id: chunk.id || null,
        });
      }
    }
    if (chunk && chunk.type === 'result' && chunk.stopReason) {
      _bridgeStopReason = chunk.stopReason;
    }
    _rawOnChunk(chunk);
  };
  const onControlRequest = typeof options.onControlRequest === 'function'
    ? options.onControlRequest
    : null;
  const args = buildClaudeArgs(options);

  // Inject critical directives into the prompt for Bridge mode.
  // Bridge sends the flat conversation as a user message to Claude CLI,
  // which has its own system prompt. Prepend directives so they're
  // prominent enough to influence behavior.
  let bridgePrompt = prompt;

  // Strip [KHY PRIORITY DIRECTIVE] injected by aiGateway._injectKhyProtocolPrompt().
  // In bridge mode, Claude CLI has its own system prompt — the directive text in a
  // user message triggers Claude's prompt injection detection. The important parts
  // (language preference) are already extracted below from the system prompt.
  bridgePrompt = bridgePrompt.replace(
    /^\[KHY PRIORITY DIRECTIVE\]\n(?:- [^\n]*\n)*\n?/,
    ''
  );

  const bridgeIntentDirective = String(options._intentDirective || '').trim();
  if (bridgeIntentDirective) {
    bridgePrompt = bridgeIntentDirective + '\n\n' + bridgePrompt;
  }
  // Extract lightweight conversation & language directives from system prompt
  // so joke format / language rules survive bridge mode's own system prompt.
  const _bridgeSystem = String(options.system || '').trim();
  if (_bridgeSystem) {
    const _lwMatch = _bridgeSystem.match(/# 轻量对话[^\n]*\n[\s\S]*?(?=\n#\s|\n\n#|$)/);
    const _langMatch = _bridgeSystem.match(/# Language\n[^\n]+(?:\n[^\n#]+)*/);
    const _extraDirectives = [_lwMatch && _lwMatch[0], _langMatch && _langMatch[0]].filter(Boolean).join('\n\n');
    if (_extraDirectives) {
      bridgePrompt = _extraDirectives + '\n\n' + bridgePrompt;
    }
  }

  try {
    let content;
    try {
      content = await runClaudeAttempt({
        launchMode: 'direct',
        prompt: bridgePrompt,
        rawUserMessage: options.userMessage,
        args,
        timeoutMs: options.timeoutMs,
        onChunk,
        onControlRequest,
        abortSignal: options.abortSignal || null,
      });
    } catch (firstErr) {
      const firstErrMsg = String(firstErr && firstErr.message ? firstErr.message : '');
      const isBridgeProtocolFailure =
        firstErrMsg.includes('without emitting stream-json output') ||
        firstErrMsg.includes('handshake timeout') ||
        firstErrMsg.includes('bridge canceled');
      const shouldRetryWithSeededShell =
        process.platform !== 'win32' && isBridgeProtocolFailure;
      const shouldRetryTransient =
        !shouldRetryWithSeededShell &&
        process.env.GATEWAY_CLAUDE_RETRY_TRANSIENT !== 'false' &&
        shouldRetryClaudeTransient(firstErr);

      // Strip verbose/partial flags on retry — they can trigger edge-case bugs
      // in certain Claude CLI versions.
      const retryArgs = args.filter(a => a !== '--verbose' && a !== '--include-partial-messages');

      if (shouldRetryWithSeededShell) {
        try { onChunk({ type: 'status', text: 'Bridge protocol failure — retrying with seeded-shell mode (simplified args)' }); } catch { /* best effort */ }
        content = await runClaudeAttempt({
          launchMode: 'seeded_shell',
          prompt,
          rawUserMessage: options.userMessage,
          args: retryArgs,
          timeoutMs: options.timeoutMs,
          onChunk,
          onControlRequest,
          abortSignal: options.abortSignal || null,
        });
        recordRuntimeDiagnostics({
          requestId,
          healed: true,
          trigger: 'bridge_seeded_shell_recovered',
          category: 'recovery',
          phase: 'bridge',
          summary: 'Claude bridge recovered after retrying with seeded-shell mode',
          diagnosis: _runtimeDiagnosticsStore.compactText(firstErr?.diagnostics?.progressSummary || firstErrMsg || 'seeded shell retry recovered', 640),
          lastError: firstErrMsg,
        });
      } else if (shouldRetryTransient) {
        try { onChunk({ type: 'status', text: 'Claude transient failure detected, retrying once...' }); } catch { /* best effort */ }
        content = await runClaudeAttempt({
          launchMode: 'direct',
          prompt,
          rawUserMessage: options.userMessage,
          args,
          timeoutMs: options.timeoutMs,
          onChunk,
          onControlRequest,
          abortSignal: options.abortSignal || null,
        });
        recordRuntimeDiagnostics({
          requestId,
          healed: true,
          trigger: 'bridge_retry_recovered',
          category: 'recovery',
          phase: 'bridge',
          summary: 'Claude bridge recovered after a transient retry',
          diagnosis: _runtimeDiagnosticsStore.compactText(firstErr?.diagnostics?.progressSummary || firstErrMsg || 'transient retry recovered', 640),
          lastError: firstErrMsg,
        });
      } else {
        throw firstErr;
      }
    }

    // Content-driven stop signal (s01 agent-loop lesson): the presence of
    // tool_use blocks is authoritative, not the API's stop_reason. The direct
    // path already does this (runClaudeDirect); mirror it here so the bridge
    // path never reports a non-tool_use stop_reason while tool_use blocks exist.
    const _bridgeStopReasonFinal = _bridgeToolUseBlocks.length > 0
      ? 'tool_use'
      : (_bridgeStopReason || null);

    return buildSuccess(content, {
      adapter: 'claude',
      provider: `Claude Code (${options.model || 'default'})`,
      toolUseBlocks: _bridgeToolUseBlocks.length > 0 ? _bridgeToolUseBlocks : [],
      stopReason: _bridgeStopReasonFinal,
      attempts: [{ provider: 'Claude Code', success: true }],
    });
  } catch (err) {
    const safeError = formatErrorMessage(err);
    const errorType = classifyAdapterError(err);
    const runtimePayload = buildClaudeRuntimeDiagnosticsPayload(err, {
      requestId,
      healed: false,
      phase: useDirect ? 'direct' : 'bridge',
    });

    // Bridge-to-direct auto-fallback: on bridge transport/transient failures
    // and with Anthropic API key available, try direct mode as last resort.
    if (shouldFallbackBridgeToDirect(err, errorType) && _hasAnthropicKey()) {
      try {
        try { onChunk({ type: 'status', text: 'Bridge mode failed — auto-falling back to Anthropic Direct API' }); } catch { /* best effort */ }
        const directResult = await runClaudeDirect(prompt, options);
        recordRuntimeDiagnostics({
          requestId,
          healed: true,
          trigger: 'bridge_fallback_recovered',
          category: 'recovery',
          phase: 'bridge',
          summary: 'Claude bridge failed, then direct fallback recovered',
          diagnosis: runtimePayload.diagnosis,
          lastError: runtimePayload.lastError,
        });
        return buildSuccess(directResult.content, {
          adapter: 'claude',
          provider: `Claude Direct (bridge-fallback, ${options.model || process.env.ANTHROPIC_MODEL || MODELS.sonnet})`,
          mode: 'direct',
          toolSummary: directResult.toolSummary,
          toolUseBlocks: directResult.toolUseBlocks || [],
          stopReason: directResult.stopReason || null,
          elapsedMs: directResult.elapsedMs,
          attempts: [
            { provider: 'Claude Code (bridge)', success: false, error: safeError || err.message, errorType },
            { provider: 'Claude Direct (fallback)', success: true },
          ],
        });
      } catch (directErr) {
        const directSafe = formatErrorMessage(directErr);
        recordRuntimeDiagnostics(runtimePayload);
        return buildFailure(`Bridge failed: ${safeError || err.message}; Direct fallback also failed: ${directSafe || directErr.message}`, {
          adapter: 'claude',
          provider: 'Claude Code',
          errorType,
          diagnostics: err?.diagnostics || {
            trigger: runtimePayload.trigger,
            summary: runtimePayload.summary,
            progressSummary: runtimePayload.diagnosis,
          },
          attempts: [
            { provider: 'Claude Code (bridge)', success: false, error: safeError || err.message, errorType },
            { provider: 'Claude Direct (fallback)', success: false, error: directSafe || directErr.message },
          ],
        });
      }
    }

    recordRuntimeDiagnostics(runtimePayload);

    return buildFailure(safeError || err.message, {
      adapter: 'claude',
      provider: 'Claude Code',
      errorType,
      diagnostics: err?.diagnostics || {
        trigger: runtimePayload.trigger,
        summary: runtimePayload.summary,
        progressSummary: runtimePayload.diagnosis,
      },
      attempts: [{ provider: 'Claude Code', success: false, error: safeError || err.message, errorType }],
    });
  }
}

function getStatus() {
  detect();
  return {
    name: 'Claude Code',
    type: 'claude',
    available: _available,
    detail: _available ? 'claude CLI 可用' : '未检测到 claude 命令 · 可运行 khy tools install claude 安装便携版',
  };
}

function destroy() {
  _available = null;
  _runtimeDiagnostics = _runtimeDiagnosticsStore.createEmptyDiagnostic();
}

module.exports = {
  detect,
  detectAsync,
  listModels,
  generate,
  getStatus,
  destroy,
  getRuntimeDiagnostics,
  // Context-window honesty helpers — exported top-level so cli/ai.js can clamp
  // the compaction budget to the window the API will actually honour.
  is1MContextActive,
  effectiveContextWindow,
  __test__: {
    getRuntimeDiagnosticsFile: () => _runtimeDiagnosticsStore.getFile(),
    readPersistedRuntimeDiagnostics: (options = {}) => _runtimeDiagnosticsStore.readDiagnostic(options),
    readPersistedRuntimeDiagnosticsState: () => _runtimeDiagnosticsStore.readState(),
    clearPersistedRuntimeDiagnostics: () => _runtimeDiagnosticsStore.clear(),
    buildBetaHeader: (model) => _buildBetaHeader(model),
    defaultThinkingBudget: (model) => _defaultThinkingBudget(model),
    is1MCapableModel: (model) => _is1MCapableModel(model),
    setBetaOptOut: (v) => { _betaOptOut = !!v; },
    getBetaOptOut: () => _betaOptOut,
    bridgeToolUseRawInputEnabled: (env) => _bridgeToolUseRawInputEnabled(env),
    resolveAnthropicCredentialFromEnv: (env) => _resolveAnthropicCredentialFromEnv(env),
    resolveAnthropicAuthScheme: (source, env) => _resolveAnthropicAuthScheme(source, env),
    buildAnthropicAuthHeaders: (apiKey, scheme) => _buildAnthropicAuthHeaders(apiKey, scheme),
  },
};
