/**
 * Kiro Adapter — connect to Kiro IDE's AI models via AWS CodeWhisperer.
 *
 * Reads Kiro's auth token from ~/.aws/sso/cache/kiro-auth-token.json,
 * auto-refreshes expired tokens (Social/IdC), and calls the Q Developer
 * streaming API for chat completions.
 *
 * Token logic ported from kiro-proxy (token-reader.js + q-client.js).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { sanitizeOutgoingHeaders } = require('./ipAnonymizer');

// ── Token paths ──────────────────────────────────────────────────────────
const SSO_CACHE_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache');
const KIRO_TOKEN_FILE = 'kiro-auth-token.json';

const SOCIAL_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 min pre-refresh buffer

const KIRO_PROFILE_PATHS = [
  path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
  path.join(os.homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
];

// ── Region → endpoint ────────────────────────────────────────────────────
const REGION_ENDPOINTS = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-west-1': 'https://q.eu-west-1.amazonaws.com',
  'ap-southeast-1': 'https://q.ap-southeast-1.amazonaws.com',
  'ap-northeast-1': 'https://q.ap-northeast-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com',
};
const DEFAULT_REGION = 'us-east-1';
const KIRO_VERSION = process.env.KIRO_VERSION || '0.11.107';
const TIMEOUT_MS = 120_000;

// ── In-memory state ──────────────────────────────────────────────────────
let _cachedToken = null;
let _refreshPromise = null;
let _available = null;
let _models = [];
let _cwModule = null; // lazy-loaded ESM module
let _sdkClient = null; // cached SDK client
let _sdkClientToken = null; // token the cached client was created with

// ── Helpers: JSON fetch ──────────────────────────────────────────────────

function jsonRequest(url, { method = 'GET', body, headers = {}, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: sanitizeOutgoingHeaders({ 'Content-Type': 'application/json', ...headers }),
      timeout,
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Token reading ────────────────────────────────────────────────────────

function readKiroToken() {
  const tokenPath = path.join(SSO_CACHE_DIR, KIRO_TOKEN_FILE);
  if (!fs.existsSync(tokenPath)) return null;
  try { return JSON.parse(fs.readFileSync(tokenPath, 'utf8')); }
  catch { return null; }
}

function writeKiroToken(tokenData) {
  try {
    const tokenPath = path.join(SSO_CACHE_DIR, KIRO_TOKEN_FILE);
    fs.mkdirSync(SSO_CACHE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));
  } catch { /* ignore write errors */ }
}

function readKiroProfile() {
  for (const p of KIRO_PROFILE_PATHS) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* skip */ }
  }
  return null;
}

function readClientRegistration(clientIdHash) {
  if (!clientIdHash) return null;
  const filePath = path.join(SSO_CACHE_DIR, `${clientIdHash}.json`);
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { /* skip */ }
  return null;
}

function isTokenExpired(tokenData) {
  if (!tokenData?.expiresAt) return true;
  return new Date(tokenData.expiresAt).getTime() < Date.now() + REFRESH_BUFFER_MS;
}

function enrichWithProfile(tokenData) {
  if (!tokenData.profileArn) {
    const profile = readKiroProfile();
    if (profile?.arn) tokenData.profileArn = profile.arn;
  }
  return tokenData;
}

// ── Token refresh ────────────────────────────────────────────────────────

async function refreshSocialToken(tokenData) {
  const res = await jsonRequest(SOCIAL_REFRESH_URL, {
    method: 'POST',
    body: { refreshToken: tokenData.refreshToken },
    timeout: 15000,
  });
  if (res.status !== 200) throw new Error(`Social token refresh failed (${res.status})`);
  const data = res.data;
  const expiresAt = new Date(Date.now() + (data.expiresIn || 3600) * 1000).toISOString();
  return {
    ...tokenData,
    accessToken: data.accessToken,
    ...(data.refreshToken && { refreshToken: data.refreshToken }),
    ...(data.profileArn && { profileArn: data.profileArn }),
    expiresAt,
  };
}

async function refreshIdCToken(tokenData) {
  const clientReg = readClientRegistration(tokenData.clientIdHash);
  if (!clientReg?.clientId || !clientReg?.clientSecret) {
    throw new Error('IdC refresh failed: no valid client registration. Please re-login in Kiro.');
  }
  const region = tokenData.region || 'us-east-1';
  const endpoint = `https://oidc.${region}.amazonaws.com/token`;
  const res = await jsonRequest(endpoint, {
    method: 'POST',
    body: {
      clientId: clientReg.clientId,
      clientSecret: clientReg.clientSecret,
      grantType: 'refresh_token',
      refreshToken: tokenData.refreshToken,
    },
    timeout: 15000,
  });
  if (res.status !== 200) throw new Error(`IdC token refresh failed (${res.status})`);
  const data = res.data;
  const expiresAt = new Date(Date.now() + (data.expiresIn || 3600) * 1000).toISOString();
  return {
    ...tokenData,
    accessToken: data.accessToken,
    ...(data.refreshToken && { refreshToken: data.refreshToken }),
    expiresAt,
  };
}

async function refreshToken(tokenData) {
  const method = tokenData.authMethod;
  if (method === 'social' || method === 'Social') return refreshSocialToken(tokenData);
  if (method === 'IdC' || method === 'idc') return refreshIdCToken(tokenData);
  throw new Error(`Unknown auth method: ${method}`);
}

/**
 * Get a valid access token (memory → disk → refresh).
 */
async function getAccessToken() {
  if (_cachedToken && !isTokenExpired(_cachedToken)) return _cachedToken;

  let tokenData = readKiroToken();
  if (!tokenData?.accessToken) {
    throw new Error('No Kiro token found. Please login in Kiro IDE first.');
  }

  if (!isTokenExpired(tokenData)) {
    _cachedToken = enrichWithProfile(tokenData);
    return _cachedToken;
  }

  if (!tokenData.refreshToken) {
    throw new Error('Kiro token expired, no refreshToken. Please re-login in Kiro.');
  }

  // Deduplicate concurrent refreshes
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    try {
      const newToken = await refreshToken(tokenData);
      const enriched = enrichWithProfile(newToken);
      writeKiroToken(enriched);
      _cachedToken = enriched;
      return enriched;
    } catch (err) {
      // If old token not fully expired (just within buffer), use it
      if (tokenData.expiresAt && new Date(tokenData.expiresAt) > new Date()) {
        _cachedToken = enrichWithProfile(tokenData);
        return _cachedToken;
      }
      throw err;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

// ── Region helpers ───────────────────────────────────────────────────────

function regionFromArn(arn) {
  if (!arn) return null;
  const parts = arn.split(':');
  return parts.length >= 4 ? parts[3] : null;
}

function endpointForRegion(region) {
  return REGION_ENDPOINTS[region] || `https://q.${region}.amazonaws.com`;
}

function buildUserAgent(machineId) {
  return `KiroIDE ${KIRO_VERSION} ${machineId || os.hostname()}`;
}

// ── Model listing (HTTP, no SDK) ─────────────────────────────────────────

async function fetchModels(tokenData) {
  const arnRegion = regionFromArn(tokenData.profileArn);
  const region = arnRegion || DEFAULT_REGION;
  const endpoint = endpointForRegion(region);

  const params = new URLSearchParams({ origin: 'AI_EDITOR' });
  if (tokenData.profileArn) params.set('profileArn', tokenData.profileArn);

  const headers = {
    'Authorization': `Bearer ${tokenData.accessToken}`,
    'User-Agent': buildUserAgent(),
    'x-amzn-codewhisperer-optout': 'true',
  };
  if (tokenData.authMethod === 'external_idp') headers['TokenType'] = 'EXTERNAL_IDP';
  if (tokenData.provider === 'Internal') headers['redirect-for-internal'] = 'true';

  const allModels = [];
  let defaultModel = null;
  let nextToken;

  do {
    if (nextToken) params.set('nextToken', nextToken);
    const url = `${endpoint}/ListAvailableModels?${params}`;
    const res = await jsonRequest(url, { headers, timeout: 15000 });
    if (res.status !== 200) throw new Error(`ListAvailableModels failed (${res.status})`);
    allModels.push(...(res.data.models || []));
    if (res.data.defaultModel && !defaultModel) defaultModel = res.data.defaultModel;
    nextToken = res.data.nextToken;
  } while (nextToken);

  return { models: allModels, defaultModel };
}

// ── SDK-based chat (lazy-load ESM) ───────────────────────────────────────

async function getCWModule() {
  if (_cwModule) return _cwModule;
  // @aws/codewhisperer-streaming-client is ESM-only, use dynamic import
  try {
    _cwModule = await import('@aws/codewhisperer-streaming-client');
  } catch (err) {
    throw new Error(
      'Kiro SDK not installed. Run: cd backend && npm install @aws/codewhisperer-streaming-client'
    );
  }
  return _cwModule;
}

function convertMessagesToConversation(messages, { modelId, system } = {}) {
  const history = [];
  const buildCtx = (extra = {}) => ({ modelId: modelId || undefined, editorState: {}, ...extra });

  // Inject system prompt as first user/assistant pair
  if (system) {
    const sysText = typeof system === 'string' ? system : system;
    if (sysText) {
      history.push({
        userInputMessage: {
          content: sysText,
          origin: 'AI_EDITOR',
          userInputMessageContext: buildCtx(),
        },
      });
      history.push({ assistantResponseMessage: { content: 'OK' } });
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      history.push({
        userInputMessage: {
          content: text,
          origin: 'AI_EDITOR',
          userInputMessageContext: buildCtx(),
        },
      });
    } else if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      history.push({ assistantResponseMessage: { content: text } });
    }
  }

  // Ensure ends with user message
  const last = history.at(-1);
  if (last?.assistantResponseMessage) {
    history.push({
      userInputMessage: {
        content: 'Continue.',
        origin: 'AI_EDITOR',
        userInputMessageContext: buildCtx(),
      },
    });
  }

  return {
    conversationId: crypto.randomUUID(),
    currentMessage: history.at(-1),
    history: history.slice(0, -1),
    chatTriggerType: 'MANUAL',
  };
}

async function createSDKClient(tokenData) {
  // Reuse cached client if token hasn't changed
  if (_sdkClient && _sdkClientToken === tokenData.accessToken) return _sdkClient;

  const { CodeWhispererStreaming } = await getCWModule();
  const arnRegion = regionFromArn(tokenData.profileArn);
  const finalRegion = arnRegion || DEFAULT_REGION;
  const finalEndpoint = endpointForRegion(finalRegion);

  const client = new CodeWhispererStreaming({
    region: finalRegion,
    endpoint: finalEndpoint,
    token: { token: tokenData.accessToken },
    customUserAgent: buildUserAgent(),
  });

  // Add required headers via middleware + strip IP-identifying headers
  // (matches kiro-proxy: separate middleware per header for proper stacking)
  client.middlewareStack.add(
    (next) => async (args) => {
      args.request.headers = sanitizeOutgoingHeaders({
        ...args.request.headers,
        'x-amzn-codewhisperer-optout': 'true',
      });
      return next(args);
    },
    { step: 'build', name: 'optOutHeader' }
  );
  client.middlewareStack.add(
    (next) => async (args) => {
      args.request.headers = {
        ...args.request.headers,
        'x-amzn-kiro-agent-mode': 'vibe',
      };
      return next(args);
    },
    { step: 'build', name: 'agentModeHeader' }
  );
  if (tokenData.authMethod === 'external_idp') {
    client.middlewareStack.add(
      (next) => async (args) => {
        args.request.headers = { ...args.request.headers, TokenType: 'EXTERNAL_IDP' };
        return next(args);
      },
      { step: 'build', name: 'tokenTypeHeader' }
    );
  }
  if (tokenData.provider === 'Internal') {
    client.middlewareStack.add(
      (next) => async (args) => {
        args.request.headers = { ...args.request.headers, 'redirect-for-internal': 'true' };
        return next(args);
      },
      { step: 'build', name: 'redirectForInternal' }
    );
  }

  _sdkClient = client;
  _sdkClientToken = tokenData.accessToken;
  return client;
}

// ── Adapter interface ────────────────────────────────────────────────────

/**
 * Detect if Kiro auth token exists.
 * Also checks for Kiro installation via ideDetector.
 */
function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;

  // Check token first
  const tokenData = readKiroToken();
  if (tokenData?.accessToken) {
    _available = true;
    return true;
  }

  // Fallback: check if Kiro is installed (token may appear after login)
  try {
    const { findInstallation, findDataPath } = require('./ideDetector');
    const installed = findInstallation('kiro') || findDataPath('kiro');
    _available = !!installed;
  } catch {
    _available = false;
  }
  return _available;
}

/**
 * Async detection with token validation.
 */
async function detectAsync() {
  try {
    const tokenData = await getAccessToken();
    _available = !!(tokenData?.accessToken);
    return _available;
  } catch {
    _available = false;
    return false;
  }
}

/**
 * List available Kiro models.
 */
async function listModels() {
  const tokenData = await getAccessToken();
  const { models, defaultModel } = await fetchModels(tokenData);
  _models = models.map(m => ({
    id: m.modelId,
    name: m.modelName || m.modelId,
    provider: 'kiro',
    description: m.description || '',
    isDefault: defaultModel?.modelId === m.modelId,
  }));
  return _models;
}

/**
 * Generate a response using Kiro's Q Developer API.
 * Includes timeout protection and full event handling.
 */
async function generate(prompt, options = {}) {
  try {
    const tokenData = await getAccessToken();
    const client = await createSDKClient(tokenData);
    const { GenerateAssistantResponseCommand } = await getCWModule();

    // Build messages: prefer structured messages from options, fall back to raw prompt
    let messages;
    if (options.messages && options.messages.length > 0) {
      messages = options.messages;
    } else {
      messages = [{ role: 'user', content: prompt }];
    }
    const conversationState = convertMessagesToConversation(messages, {
      modelId: options.model,
      system: options.system,
    });

    const command = new GenerateAssistantResponseCommand({
      conversationState,
      profileArn: tokenData.profileArn,
    });

    // Wrap in timeout to prevent indefinite hangs
    const sendWithTimeout = Promise.race([
      client.send(command),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Kiro request timeout (${TIMEOUT_MS / 1000}s)`)), TIMEOUT_MS)
      ),
    ]);

    const response = await sendWithTimeout;
    if (!response.generateAssistantResponseResponse) {
      throw new Error('Empty response from Q Developer');
    }

    // Collect streaming response — consume ALL event types
    let content = '';
    let usedModelId = null;
    const onChunk = options.onChunk || (() => {});

    try {
      for await (const event of response.generateAssistantResponseResponse) {
        // Text content
        if (event.assistantResponseEvent?.content) {
          const text = event.assistantResponseEvent.content;
          content += text;
          if (event.assistantResponseEvent.modelId) {
            usedModelId = event.assistantResponseEvent.modelId;
          }
          onChunk({ type: 'text', text });
        }

        // Thinking/reasoning content
        if (event.reasoningContentEvent?.text) {
          onChunk({ type: 'thinking', text: event.reasoningContentEvent.text });
        }

        // Metering event (must consume to advance stream)
        if (event.meteringEvent) { /* consumed */ }

        // Code reference event
        if (event.codeReferenceEvent) { /* consumed */ }

        // Context usage event
        if (event.contextUsageEvent) { /* consumed */ }

        // Token usage metadata
        if (event.metadataEvent?.tokenUsage) { /* consumed */ }

        // Invalid state (error from Q Developer)
        if (event.invalidStateEvent) {
          const reason = event.invalidStateEvent.reason || 'unknown';
          const message = event.invalidStateEvent.message || '';
          throw new Error(`Q Developer error: ${reason} — ${message}`);
        }

        // Supplementary links
        if (event.supplementaryWebLinksEvent) { /* consumed */ }

        // Tool use events
        if (event.toolUseEvent) { /* consumed — tool-use not used in CLI mode */ }
      }
    } catch (streamErr) {
      // If stream interrupted but we have partial content, return what we got
      if (content.trim()) {
        const modelDisplay = usedModelId || options.model || 'default';
        return {
          success: true,
          content: content.trim(),
          provider: `Kiro (${modelDisplay})`,
          adapter: 'kiro',
          model: modelDisplay,
          attempts: [{ provider: 'Kiro', success: true, warning: 'stream_interrupted' }],
        };
      }
      throw streamErr;
    }

    const modelDisplay = usedModelId || options.model || 'default';

    return {
      success: true,
      content: content.trim(),
      provider: `Kiro (${modelDisplay})`,
      adapter: 'kiro',
      model: modelDisplay,
      attempts: [{ provider: 'Kiro', success: true }],
    };
  } catch (err) {
    // Invalidate cached client on auth errors
    if (err.message?.includes('401') || err.message?.includes('403') || err.message?.includes('expired')) {
      _sdkClient = null;
      _sdkClientToken = null;
      _cachedToken = null;
    }
    return {
      success: false,
      content: '',
      provider: 'Kiro',
      adapter: 'kiro',
      error: err.message,
      attempts: [{ provider: 'Kiro', success: false, error: err.message }],
    };
  }
}

/**
 * Get adapter status.
 */
function getStatus() {
  detect();
  return {
    name: 'Kiro IDE',
    type: 'kiro',
    available: _available,
    detail: _available
      ? `Token 有效` + (_models.length ? ` (${_models.length} 个模型)` : '')
      : '未检测到 Kiro token — 请先登录 Kiro IDE',
    refreshModels: listModels,
  };
}

function destroy() {
  _cachedToken = null;
  _available = null;
  _models = [];
  _cwModule = null;
  _sdkClient = null;
  _sdkClientToken = null;
}

module.exports = { detect, detectAsync, listModels, generate, getStatus, destroy, getAccessToken, createSDKClient, getCWModule };
