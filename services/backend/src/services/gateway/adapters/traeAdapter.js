/**
 * Trae IDE Adapter — connect to Trae (ByteDance) models.
 *
 * Strategy (generate):
 * 0) Trae Native Protocol (x-cloudide-token, requires nativeToken + nativeHost)
 * 1) CodeWhisperer protocol (accessToken required; sessionCookies optional)
 * 2) Proprietary Trae Network SDK (if @byted-icube/trae-network-client available)
 * 3) HTTP OpenAI-compatible endpoint
 * 4) Fallback token retry on auth failure
 *
 * Status model (getStatus):
 *   verified  — token valid, API probed OK
 *   pending   — token found, not yet probed
 *   encrypted — official Trae login detected but safeStorage-encrypted (external undecryptable)
 *   installed — Trae dirs exist but no login artifacts
 *   missing   — no Trae installation found
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeOutgoingHeaders } = require('./ipAnonymizer');
const { attachImagesToOpenAIMessages } = require('./_imageCompat');
const { resolveMessages } = require('./_messageBuilder');
const { requestJson, collectProxyCandidates } = require('./_proxyTunnel');
const { parseList, dedupe } = require('./_adapterUtils');
const { consumeSseText } = require('./_sseParser');
const { anthropicToOpenAI, openAIToolCallsToAnthropic, convertMessagesAnthropicToOpenAI } = require('./_toolSchemaConverter');
const {
  normalizeToken, isLikelyCredentialToken, isTokenExpired, dedupeTokens,
  isNativeLoginToken, countsTowardAvailability,
  extractMessageText, mergeAttempts, buildMessages,
  readWebReadableAsText,
  normalizeModelId, canonicalModelKey, extractModelIdsFromString,
  discoverModelsFromSnapshots, buildModelList,
  createTokenManager,
} = require('./_ideTokenMixin');
const {
  collectTraeOfficialArtifacts,
  resolveTraeOfficialCredential,
  verifyTraeOfficialSession,
  resolveTraeOfficialStoragePaths,
  resolveTraeOfficialDbPaths,
  decodeTraeOfficialAuthBlob,
  resolveNativeHostByRegion,
  writeBridgeAuthToken,
  TRAE_REGION_HOST_MAP,
} = require('./traeOfficialArtifacts');
const { createProtocolHandler } = require('./_protocolPipeline');
const { buildSuccess, buildFailure } = require('./_responseBuilder');
const {
  getCWModule,
  parseCWStreamEvents,
} = require('./_cwStreamParser');

const _openaiHandler = createProtocolHandler({ protocol: 'openai', adapterName: 'trae' });
const _cwHandler = createProtocolHandler({ protocol: 'codewhisperer', adapterName: 'trae' });

const TRAE_STORAGE_PATHS = [
  // Nirvana 换号软件 (各种安装位置)
  path.join(os.homedir(), '.config', 'Nirvana', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), '.config', 'nirvana', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Nirvana', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'nirvana', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Nirvana', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'nirvana', 'User', 'globalStorage', 'storage.json'),
  // Windows: Program Files 安装目录
  'C:\\Program Files\\nirvana\\User\\globalStorage\\storage.json',
  'C:\\Program Files\\Nirvana\\User\\globalStorage\\storage.json',
  'C:\\Program Files\\nirvana\\storage.json',
  'C:\\Program Files\\Nirvana\\storage.json',
  // Trae CN (国内版)
  path.join(os.homedir(), '.config', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  // Trae 国际版
  path.join(os.homedir(), '.config', 'Trae', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Trae', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Trae', 'User', 'globalStorage', 'storage.json'),
];

// Nirvana 换号软件的 trae_local_cache.json — 包含完整 session_cookies (60天有效)
const NIRVANA_TRAE_CACHE_PATHS = (() => {
  const envPath = String(process.env.NIRVANA_TRAE_CACHE || '').trim();
  const home = os.homedir();
  const paths = [
    envPath,
    // Windows: %APPDATA%/nirvana (标准用户数据)
    path.join(home, 'AppData', 'Roaming', 'nirvana', 'trae_local_cache.json'),
    path.join(home, 'AppData', 'Roaming', 'Nirvana', 'trae_local_cache.json'),
    // Windows: Program Files 安装目录
    'C:\\Program Files\\nirvana\\trae_local_cache.json',
    'C:\\Program Files\\Nirvana\\trae_local_cache.json',
    'C:\\Program Files (x86)\\nirvana\\trae_local_cache.json',
    // Windows: %LOCALAPPDATA%
    path.join(home, 'AppData', 'Local', 'nirvana', 'trae_local_cache.json'),
    path.join(home, 'AppData', 'Local', 'Nirvana', 'trae_local_cache.json'),
    // Linux
    path.join(home, '.config', 'nirvana', 'trae_local_cache.json'),
    path.join(home, '.config', 'Nirvana', 'trae_local_cache.json'),
    // macOS
    path.join(home, 'Library', 'Application Support', 'nirvana', 'trae_local_cache.json'),
    path.join(home, 'Library', 'Application Support', 'Nirvana', 'trae_local_cache.json'),
  ].filter(Boolean);
  return paths;
})();

const COOKIE_EXPIRE_BUFFER_MS = 5 * 60 * 1000; // 5 分钟提前过期缓冲

const KNOWN_MODELS = [
  { id: 'gpt-5.4-beta', name: 'GPT-5.4 Beta', isDefault: true },
  { id: 'gpt-5.2', name: 'GPT-5.2', isDefault: false },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', isDefault: false },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', isDefault: false },
  { id: 'deepseek-v3.2', name: 'DeepSeek-V3.2', isDefault: false },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini-3.1-Pro-Preview', isDefault: false },
  { id: 'gemini-3-flash-preview', name: 'Gemini-3-Flash-Preview', isDefault: false },
  { id: 'gemini-2.5-flash', name: 'Gemini-2.5-Flash', isDefault: false },
];

// Models that Trae IDE has offered historically or may add soon.
// Injected when the API doesn't list them, same strategy as Kiro.
// Source: Trae CN model picker (2026-05).
const TRAE_INJECTED_MODELS = [
  { id: 'doubao-1.5-pro', name: 'Doubao 1.5 Pro' },
  { id: 'doubao-1.5-thinking', name: 'Doubao 1.5 Thinking' },
  { id: 'deepseek-r1', name: 'DeepSeek R1' },
  { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
  { id: 'gpt-4o', name: 'GPT-4o' },
];
const TRAE_INJECT_MODELS = !/^(0|false|off)$/i.test(
  String(process.env.TRAE_INJECT_MODELS || '1').trim()
);

const ACCOUNT_POOL_TYPE = 'trae';
const { DEFAULT_TIMEOUT_MS } = require('./_protocolPipeline');
const TIMEOUT_MS = parseInt(process.env.TRAE_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
const MODEL_DISCOVERY_CACHE_MS = Math.max(5000, parseInt(process.env.TRAE_MODEL_CACHE_MS || '120000', 10) || 120000);
const MODEL_TOKEN_REGEX = /\b[a-zA-Z0-9][a-zA-Z0-9._:-]{2,80}\b/g;

// 结构化检测状态
let _detectionState = {
  installDetected: false,            // 磁盘上有 Trae/Nirvana 目录
  officialArtifactsDetected: false,  // 找到 iCube 等登录痕迹（即使加密）
  officialArtifactSources: [],       // 发现 artifact 的路径列表
  credentialMode: 'none',            // 'none' | 'encrypted' | 'plaintext' | 'cookie'
  sessionVerified: false,            // token 成功调用过 API
  available: false,                  // 派生：sessionVerified || credentialMode 为 plaintext/cookie
  _checked: false,
  _officialCredential: null,         // resolveTraeOfficialCredential() 缓存
};
const ENDPOINT_PROBE_CACHE_MS = 5 * 60 * 1000;
const ENDPOINT_PROBE_CACHE_MAX = 64; // 上限 64 条，防止长时间运行堆积
const _endpointProbeCache = new Map();

/**
 * 写入探活缓存（带 TTL 淘汰）
 * 超过 ENDPOINT_PROBE_CACHE_MAX 时淘汰最旧的 entry
 */
function _setProbeCache(key, result) {
  _endpointProbeCache.set(key, { at: Date.now(), result: result });
  if (_endpointProbeCache.size > ENDPOINT_PROBE_CACHE_MAX) {
    // Map 保持插入顺序 — 删最早插入的
    const first = _endpointProbeCache.keys().next().value;
    if (first !== undefined) _endpointProbeCache.delete(first);
  }
}
let _token = null;
let _models = [];
let _modelsFetchedAt = 0;
let _lastApiMeta = {
  at: 0,
  endpoint: '',
  officialHit: false,
  officialCount: 0,
  localCount: 0,
  mergedCount: 0,
  error: '',
  mode: 'http',
};

let _sdkLoadTried = false;
let _sdkModule = null;
let _sdkLoadError = null;
let _sdkClient = null;
let _sdkClientEndpoint = '';


function normalizeEndpointBase(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  let base = text;
  if (!/^https?:\/\//i.test(base)) {
    base = `https://${base.replace(/^\/+/, '')}`;
  }

  try {
    const url = new URL(base);
    let pathname = String(url.pathname || '').trim();
    if (pathname.endsWith('/chat/completions')) {
      pathname = pathname.slice(0, -('/chat/completions'.length));
    }
    if (!pathname || pathname === '/') {
      pathname = '/v1';
    }
    pathname = pathname.replace(/\/+$/, '') || '/v1';
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return '';
  }
}

function toRelayEndpointBase(raw) {
  const normalized = normalizeEndpointBase(raw);
  if (!normalized) return '';
  return normalized
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/+$/, '');
}

function buildChatUrl(base) {
  return `${String(base || '').replace(/\/+$/, '')}/chat/completions`;
}

function buildModelsUrl(base) {
  return `${String(base || '').replace(/\/+$/, '')}/models`;
}

function isLikelyModelId(id) {
  const model = canonicalModelKey(id);
  if (!model) return false;
  if (model.length < 3 || model.length > 64) return false;
  if (model.startsWith('http') || model.includes('@') || model.includes('\\')) return false;
  if (/[^a-z0-9._:-]/i.test(model)) return false;
  if (!/\d/.test(model) && !/(sonnet|haiku|opus|cascade|chat|turbo|lightning|lite|large|medium|plus)/i.test(model)) return false;
  // 排除看起来像 base64 token/密钥的随机字符串：
  // 无分隔符 (无 . - : _) + 长度>20 → 高概率是加密 token 而非模型 ID
  if (model.length > 20 && !/[._:-]/.test(model)) return false;
  // yi/swe 太短，需要后跟分隔符防止误匹配 hash (如 "mEXYIzGB..." 碰巧含 "yi")
  return /(gpt|claude|deepseek|qwen|glm|doubao|llama|mistral|moonshot|yi[-._:]|kimi|minimax|gemini|swe[-._:]|sonnet|haiku|opus|cascade)/i.test(model);
}

function modelDisplayName(id) {
  const normalized = normalizeModelId(id);
  const known = KNOWN_MODELS.find(m => canonicalModelKey(m.id) === canonicalModelKey(normalized));
  if (known?.name) return known.name;
  if (/^gpt/i.test(normalized)) return normalized.replace(/^gpt/i, 'GPT');
  if (/^claude/i.test(normalized)) return normalized.replace(/^claude/i, 'Claude');
  if (/^deepseek/i.test(normalized)) return normalized.replace(/^deepseek/i, 'DeepSeek');
  if (/^doubao/i.test(normalized)) return normalized.replace(/^doubao/i, 'Doubao');
  if (/^minimax/i.test(normalized)) return normalized.replace(/^minimax/i, 'MiniMax');
  if (/^gemini/i.test(normalized)) return normalized.replace(/^gemini/i, 'Gemini');
  if (/^kimi/i.test(normalized)) return normalized.replace(/^kimi/i, 'Kimi');
  return normalized;
}

function readTraeStorageSnapshots() {
  const snapshots = [];
  for (const p of TRAE_STORAGE_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      snapshots.push({ path: p, data });
    } catch {
      // ignore malformed storage snapshots
    }
  }
  return snapshots;
}

/**
 * 检测磁盘上是否安装了 Trae IDE（检查官方 + Nirvana 路径）
 */
function detectInstallation() {
  const dirsToCheck = new Set();
  for (const p of TRAE_STORAGE_PATHS) dirsToCheck.add(path.dirname(p));
  for (const p of resolveTraeOfficialStoragePaths()) dirsToCheck.add(path.dirname(p));
  for (const p of resolveTraeOfficialDbPaths()) dirsToCheck.add(path.dirname(p));
  for (const dir of dirsToCheck) {
    try { if (fs.existsSync(dir)) return true; } catch { /* ignore */ }
  }
  return false;
}

/**
 * 端点探活：验证端点是否返回有效的 OpenAI 兼容 JSON 响应。
 * 缓存 5 分钟，超时 8 秒。不会删除端点，只返回状态。
 * @param {string} url - 端点基础 URL (如 https://your-openai-compatible-proxy/v1)
 * @param {string} [token] - Bearer token
 * @returns {Promise<'ok'|'fail'>}
 */
async function probeEndpoint(url, token = '') {
  const cacheKey = url;
  const cached = _endpointProbeCache.get(cacheKey);
  if (cached && (Date.now() - cached.at < ENDPOINT_PROBE_CACHE_MS)) {
    return cached.result;
  }

  const modelsUrl = `${String(url || '').replace(/\/+$/, '')}/models`;
  const headers = { 'Accept': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const result = await requestJson(modelsUrl, {
      method: 'GET',
      headers,
      timeout: 8000,
      maxRetries: 0,
    });
    const body = result?.body || result?.data || result;
    // 有效：JSON 含 data/models 数组；失败：HTML / 404 / 非 JSON
    const contentType = String(result?.headers?.['content-type'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html');
    const isJson = (Array.isArray(body?.data) || Array.isArray(body?.models));
    const status = (isJson && !isHtml) ? 'ok' : 'fail';
    _setProbeCache(cacheKey, status);
    return status;
  } catch {
    _setProbeCache(cacheKey, 'fail');
    return 'fail';
  }
}

/**
 * 读取 Nirvana 的 trae_local_cache.json — 包含完整 session_cookies + access_token。
 * 文件格式: { "email@example.com": { email, access_token, session_cookies, cookies_expire_at, ... } }
 * @returns {Array<{email, accessToken, sessionCookies, cookiesExpireAt, tokenExpireAt, apiBase, userId, region, source, path}>}
 */
function readNirvanaCacheAccounts() {
  const now = Date.now();
  const results = [];
  const seenEmails = new Set();

  for (const cachePath of NIRVANA_TRAE_CACHE_PATHS) {
    try {
      if (!fs.existsSync(cachePath)) continue;
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (!raw || typeof raw !== 'object') continue;

      for (const [email, acc] of Object.entries(raw)) {
        if (!acc || typeof acc !== 'object') continue;
        if (!acc.session_cookies || !acc.cookies_expire_at) continue;

        const cookiesExpireTs = new Date(acc.cookies_expire_at).getTime();
        if (!Number.isFinite(cookiesExpireTs) || cookiesExpireTs < now + COOKIE_EXPIRE_BUFFER_MS) continue;

        const emailKey = String(email || acc.email || '').trim().toLowerCase();
        if (seenEmails.has(emailKey)) continue;
        if (emailKey) seenEmails.add(emailKey);

        const accessToken = normalizeToken(acc.access_token);
        results.push({
          email: acc.email || email,
          accessToken,
          sessionCookies: acc.session_cookies,
          cookiesExpireAt: acc.cookies_expire_at,
          tokenExpireAt: acc.token_expire_at || null,
          apiBase: acc.api_base || null,
          userId: acc.trae_user_id || null,
          region: acc.region || null,
          source: 'nirvana-cache',
          path: cachePath,
        });
      }
    } catch {
      // ignore malformed cache files
    }
  }

  // 按 cookie 过期时间降序 (选最晚过期的)
  results.sort((a, b) => new Date(b.cookiesExpireAt) - new Date(a.cookiesExpireAt));
  return results;
}

function isCookieExpired(cookiesExpireAt) {
  if (!cookiesExpireAt) return true;
  const ts = new Date(cookiesExpireAt).getTime();
  if (!Number.isFinite(ts)) return true;
  return ts < Date.now() + COOKIE_EXPIRE_BUFFER_MS;
}

function readTraeToken() {
  // ── 优先级 1: 官方 Trae 扫描 (storage.json + state.vscdb / state-global.vscdb) ──
  // 不依赖 Nirvana，优先从官方 Trae 安装中发现可用凭据
  const officialCred = resolveTraeOfficialCredential();
  _detectionState._officialCredential = officialCred;
  _detectionState.officialArtifactsDetected = officialCred.officialArtifactsDetected;
  _detectionState.officialArtifactSources = officialCred.sourcePaths || [];

  if (officialCred.credentialMode === 'plaintext' && officialCred.token) {
    _detectionState.credentialMode = 'plaintext';
    return {
      accessToken: normalizeToken(officialCred.token),
      refreshToken: officialCred.refreshToken || null,
      source: 'official-trae',
      path: (officialCred.sourcePaths || [])[0] || null,
      endpoint: normalizeEndpointBase(officialCred.endpoint || ''),
      sdkEndpoint: null,
      expiresAt: officialCred.expiresAt || null,
      sessionCookies: null,
      cookiesExpireAt: null,
    };
  }

  if (officialCred.officialArtifactsDetected && _detectionState.credentialMode === 'none') {
    _detectionState.credentialMode = officialCred.credentialMode; // 'encrypted'
  }

  // ── 优先级 2: Nirvana/旧式 storage.json 中的明文 token (Nirvana + Trae CN/国际) ──
  const snapshots = readTraeStorageSnapshots();
  for (const snap of snapshots) {
    const data = snap.data || {};
    const token = data.traeAuth?.accessToken
      || data['traeAuth/accessToken']
      || data['trae.auth']?.accessToken
      || data['bytedance.auth']?.accessToken
      || data.nirvanaAuth?.accessToken
      || data['nirvanaAuth/accessToken']
      || data.accessToken;

    if (!isLikelyCredentialToken(token)) continue;

    const endpoint = normalizeEndpointBase(
      data.traeAuth?.endpoint
      || data.traeAuth?.host
      || data['trae.auth']?.endpoint
      || data['trae.auth']?.host
      || data.nirvanaAuth?.host
      || data['nirvanaAuth/host']
      || data.endpoint
      || data.baseUrl
      || data.baseURL
    );

    return {
      accessToken: normalizeToken(token),
      refreshToken: data.traeAuth?.refreshToken
        || data['traeAuth/refreshToken']
        || data['trae.auth']?.refreshToken
        || data['bytedance.auth']?.refreshToken
        || data.nirvanaAuth?.refreshToken
        || data['nirvanaAuth/refreshToken']
        || null,
      source: path.basename(path.dirname(path.dirname(path.dirname(snap.path)))),
      path: snap.path,
      endpoint,
      sdkEndpoint: data.traeAuth?.sdkEndpoint || data.nirvanaAuth?.sdkEndpoint || null,
      expiresAt: data.traeAuth?.expiresAt
        || data['traeAuth/expiresAt']
        || data['trae.auth']?.expiresAt
        || data['bytedance.auth']?.expiresAt
        || data.nirvanaAuth?.refreshExpireAt
        || data['nirvanaAuth/refreshExpireAt']
        || null,
      sessionCookies: null,
      cookiesExpireAt: null,
    };
  }

  // ── 优先级 3: Nirvana trae_local_cache.json (60天 session_cookies) ──
  const cacheAccounts = readNirvanaCacheAccounts();
  if (cacheAccounts.length > 0) {
    const best = cacheAccounts[0];
    _detectionState.credentialMode = 'cookie';
    return {
      accessToken: best.accessToken || '',
      refreshToken: null,
      source: 'nirvana-cache',
      path: best.path,
      endpoint: normalizeEndpointBase(best.apiBase),
      sdkEndpoint: null,
      expiresAt: best.tokenExpireAt,
      sessionCookies: best.sessionCookies,
      cookiesExpireAt: best.cookiesExpireAt,
    };
  }

  return null;
}

const _tokenMgr = createTokenManager({
  poolType: ACCOUNT_POOL_TYPE,
  envPrefix: 'TRAE',
  readTokenFn: readTraeToken,
  normalizeEndpointBaseFn: normalizeEndpointBase,
});

async function getTokenCandidates() {
  const localToken = readTraeToken();
  const poolToken = await _tokenMgr.getPoolActiveToken();
  const currentToken = (_token && _token.accessToken) ? _token : null;

  if (localToken && localToken.accessToken) {
    _tokenMgr.persistObservedToken(localToken);
  }

  const ordered = _tokenMgr.resolveTokenPriority() === 'local-first'
    ? [localToken, poolToken, currentToken]
    : [poolToken, localToken, currentToken];

  const deduped = dedupeTokens(ordered);

  // 追加 Nirvana cache 中其他未去重的账号 (有 sessionCookies 的)
  // 如果已有同 token 但缺 cookies，用 Nirvana 版本增强
  const cacheAccounts = readNirvanaCacheAccounts();
  const existingTokens = new Set(deduped.map(t => normalizeToken(t.accessToken)));
  for (const acc of cacheAccounts) {
    if (!acc.accessToken) continue;
    const normalizedAccToken = normalizeToken(acc.accessToken);

    // 已有同 token — 补充 sessionCookies
    if (existingTokens.has(normalizedAccToken)) {
      if (acc.sessionCookies) {
        const existing = deduped.find(t => normalizeToken(t.accessToken) === normalizedAccToken);
        if (existing && !existing.sessionCookies) {
          existing.sessionCookies = acc.sessionCookies;
          existing.cookiesExpireAt = acc.cookiesExpireAt;
          if (acc.apiBase) existing.apiBase = acc.apiBase;
        }
      }
      continue;
    }

    if (!isLikelyCredentialToken(acc.accessToken)) continue;
    existingTokens.add(normalizedAccToken);
    deduped.push({
      accessToken: normalizedAccToken,
      refreshToken: null,
      source: 'nirvana-cache',
      path: acc.path,
      endpoint: normalizeEndpointBase(acc.apiBase),
      sdkEndpoint: null,
      expiresAt: acc.tokenExpireAt,
      sessionCookies: acc.sessionCookies,
      cookiesExpireAt: acc.cookiesExpireAt,
      apiBase: acc.apiBase,
    });
  }

  return deduped;
}

/** 评分: 有效 Cookie +100, 有效 Token +50 */
function _scoreToken(t) {
  let score = 0;
  if (t.sessionCookies && !isCookieExpired(t.cookiesExpireAt)) score += 100;
  if (!isTokenExpired(t)) score += 50;
  if (isLikelyCredentialToken(t.accessToken)) score += 10;
  return score;
}

async function selectToken({ allowExpired = false } = {}) {
  const candidates = await getTokenCandidates();
  if (candidates.length === 0) {
    return { token: null, fallback: null, candidates: [] };
  }

  // 按评分降序排列, 优先选有 Cookie 的账号
  const scored = candidates.map(t => ({ t, s: _scoreToken(t) }));
  scored.sort((a, b) => b.s - a.s);
  const sorted = scored.map(x => x.t);

  const nonExpired = sorted.filter(t => !isTokenExpired(t) || (t.sessionCookies && !isCookieExpired(t.cookiesExpireAt)));
  const token = nonExpired[0] || (allowExpired ? sorted[0] : null);
  if (!token) {
    return { token: null, fallback: null, candidates };
  }

  const fallback = nonExpired.find(t => t.accessToken !== token.accessToken) || null;
  return { token, fallback, candidates };
}

function resolveTraeApiBases(tokenData = null) {
  const envList = [
    ...parseList(process.env.TRAE_API_ENDPOINTS),
    ...parseList(process.env.TRAE_API_ENDPOINT),
    ...parseList(process.env.TRAE_API_BASE_URL),
  ];

  // Trae 原生/CW 协议端点 — 不支持 /v1/chat/completions，仅限 GenerateAssistantResponse/ListAvailableModels
  const TRAE_NATIVE_HOSTS = [
    'api-us-east.trae.ai', 'api-eu-west.trae.ai', 'api-ap.trae.ai',
    'api-cn.trae.ai', 'api.trae.cn', 'api-cn-east.trae.ai',
    'adaptive-api.trae.ai',
    // Windows 运行日志 + product.json 确认的原生协议主机 — 非 OpenAI 兼容
    'grow-normal.trae.ai', 'core-normal.trae.ai',
    'growsg-normal.trae.ai', 'growva-normal.trae.ai',
    'grow-normal.traeapi.us',
  ];
  const isNativeHost = (url) => {
    try { return TRAE_NATIVE_HOSTS.includes(new URL(url).hostname); } catch { return false; }
  };

  // token 字段中的非 CW/原生端点 (可能是真正的 OpenAI 兼容中继)
  const tokenList = [
    tokenData?.endpoint,
    tokenData?.host,
    tokenData?.baseUrl,
    tokenData?.baseURL,
    tokenData?.apiBase,
  ].filter(url => url && !isNativeHost(url));

  // 官方凭据中提取的 endpointHints（过滤掉原生端点）
  const officialHints = (_detectionState._officialCredential?.endpointHints || [])
    .filter(url => url && !isNativeHost(url));

  // Trae 的真实网关是加密原生协议（adaptive-api.trae.ai，CodeWhisperer 风格），不是 OpenAI 兼容接口；
  // api.trae.ai/v1 对 /chat/completions 返回 404。因此即使只拿到 JWT (eyJ 开头) 且无其它候选端点，
  // 也不再回退到 api.trae.ai——无可用端点时让上层优雅降级，而不是发一个必然 404 的请求。
  const collected = [...envList, ...tokenList, ...officialHints].map(normalizeEndpointBase).filter(Boolean);
  const all = dedupe(collected);

  // 按探活缓存排序：已验证 > 未探 > 已失败
  const probeOrder = { ok: 0, unknown: 1, fail: 2 };
  all.sort((a, b) => {
    const ca = _endpointProbeCache.get(a);
    const cb = _endpointProbeCache.get(b);
    const sa = ca && (Date.now() - ca.at < ENDPOINT_PROBE_CACHE_MS) ? ca.result : 'unknown';
    const sb = cb && (Date.now() - cb.at < ENDPOINT_PROBE_CACHE_MS) ? cb.result : 'unknown';
    return (probeOrder[sa] ?? 1) - (probeOrder[sb] ?? 1);
  });

  return all;
}

/**
 * 判断当前 token 是否来自 Trae CN (国内版)
 * 依据: source 路径含 "Trae CN"、region 含 cn、apiBase 含 cn 域名
 */
function _isTraeCN(tokenData) {
  if (!tokenData) return false;
  const source = String(tokenData.source || tokenData.sourcePath || '').toLowerCase();
  if (source.includes('trae cn')) return true;
  if (source.includes('nirvana')) return true;  // Nirvana 是国内换号工具
  const region = String(tokenData.region || '').toLowerCase();
  if (region.includes('cn') || region.includes('china')) return true;
  const apiBase = String(tokenData.apiBase || tokenData.endpoint || '').toLowerCase();
  if (apiBase.includes('api-cn') || apiBase.includes('trae.cn') || apiBase.includes('adaptive-api')) return true;
  return false;
}

/**
 * 获取 CW 原生端点（区分 CN/国际版）
 */
function _resolveTraeCWEndpoint(tokenData) {
  // 优先使用 token 自带的端点
  const raw = normalizeEndpointBase(tokenData?.apiBase || tokenData?.endpoint);
  if (raw) return raw.replace(/\/v1\/?$/, '');
  // 根据区域选择默认端点
  return _isTraeCN(tokenData)
    ? 'https://adaptive-api.trae.ai'
    : 'https://api-us-east.trae.ai';
}

function parseApiModels(payload = {}) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : (Array.isArray(payload?.models) ? payload.models : []);

  const out = [];
  const seen = new Set();
  let defaultModelId = null;

  const push = (id, name, isDefault = false) => {
    const normalized = normalizeModelId(id);
    if (!isLikelyModelId(normalized)) return;
    const key = canonicalModelKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: normalized, name: name || modelDisplayName(normalized), isDefault: !!isDefault });
    if (isDefault && !defaultModelId) defaultModelId = normalized;
  };

  for (const row of rows) {
    const id = row?.id || row?.model || row?.modelId;
    const name = row?.name || row?.display_name || row?.displayName || row?.title || id;
    const isDefault = !!(row?.is_default || row?.isDefault || row?.default || row?.selected);
    push(id, name, isDefault);
  }

  if (!defaultModelId && payload?.default_model) {
    const d = normalizeModelId(payload.default_model);
    if (isLikelyModelId(d)) defaultModelId = d;
  }

  return { models: out, defaultModelId };
}

/**
 * 构建 Trae API 请求头 (含 Cookie 注入)
 * @param {object} tokenData - token 对象 (含 accessToken, sessionCookies)
 * @param {object} [extra] - 额外 headers
 * @returns {object}
 */
function buildTraeHeaders(tokenData, extra = {}) {
  const headers = {
    Authorization: `Bearer ${tokenData.accessToken}`,
    'x-api-key': tokenData.accessToken,
    'x-amzn-codewhisperer-optout': 'true',
    ...extra,
  };
  // 注入 session_cookies (Nirvana cache 提供, ~60天有效)
  if (tokenData.sessionCookies && !isCookieExpired(tokenData.cookiesExpireAt)) {
    headers['Cookie'] = tokenData.sessionCookies;
  }
  return headers;
}

function jsonRequest(url, { method = 'GET', headers = {}, body = null, timeout = 12000 } = {}) {
  return requestJson(
    url,
    {
      method,
      timeout,
      headers: sanitizeOutgoingHeaders(headers),
      body,
    },
    {
      namespace: 'trae',
      envKeys: ['TRAE_HTTP_PROXY', 'TRAE_HTTPS_PROXY', 'TRAE_PROXY', 'TRAE_ALL_PROXY'],
      autoEnvKey: 'TRAE_AUTO_PROXY',
      portsEnvKey: 'TRAE_AUTO_PROXY_PORTS',
    }
  );
}

async function fetchModelsFromApi(tokenData, options = {}) {
  const timeoutMs = Math.max(3000, parseInt(options.timeoutMs || '10000', 10) || 10000);
  const bases = resolveTraeApiBases(tokenData);

  if (bases.length === 0) {
    throw new Error('没有可用的 OpenAI 兼容端点 — 未配置 TRAE_API_ENDPOINT 且 token 无 endpoint 字段');
  }

  let lastErr = null;

  for (const base of bases) {
    // 跳过已知失败的端点（避免重复打到 HTML 页面）
    const cached = _endpointProbeCache.get(base);
    if (cached && (Date.now() - cached.at < ENDPOINT_PROBE_CACHE_MS) && cached.result === 'fail') {
      lastErr = lastErr || new Error(`端点 ${base} 已知不可用（探活缓存）`);
      continue;
    }

    const url = buildModelsUrl(base);
    try {
      const res = await jsonRequest(url, {
        method: 'GET',
        timeout: timeoutMs,
        headers: buildTraeHeaders(tokenData, { Accept: 'application/json' }),
      });

      if (res.status === 401 || res.status === 403) {
        const authErr = new Error(`Trae auth failed (${res.status})`);
        authErr.code = 'AUTH';
        throw authErr;
      }

      // 检测 HTML / 非 JSON 响应 — 标记端点为 fail
      const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
      const rawBody = String(res.raw || '').trim();
      if (contentType.includes('text/html') || rawBody.startsWith('<!') || rawBody.startsWith('<html')) {
        _setProbeCache(base, 'fail');
        lastErr = new Error(`端点 ${url} 返回 HTML 而非 JSON — 不是 OpenAI 兼容端点`);
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        _setProbeCache(base, 'fail');
        lastErr = new Error(`models endpoint ${url} -> HTTP ${res.status}`);
        continue;
      }

      const parsed = parseApiModels(res.data || {});
      if (parsed.models.length > 0) {
        _setProbeCache(base, 'ok');
        return { ...parsed, endpoint: base, mode: 'http' };
      }
      lastErr = new Error(`models endpoint ${url} returned empty model list`);
    } catch (err) {
      if (err && err.code === 'AUTH') throw err;
      lastErr = err instanceof Error ? err : new Error(String(err || 'models endpoint error'));
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('models endpoint unavailable');
}

// buildTraeMessages replaced by shared _messageBuilder (Phase 5B)
function buildTraeMessages(prompt, options = {}) {
  let _flattenContent;
  try { _flattenContent = require('../../../services/contentBlockUtils').flattenContent; } catch { _flattenContent = (c) => String(c || ''); }

  // Flatten content blocks before resolving (Trae doesn't support content arrays)
  const flatOpts = { ...options };
  if (Array.isArray(flatOpts.messages)) {
    flatOpts.messages = flatOpts.messages.map(m => ({
      ...m,
      content: typeof m.content === 'string' ? m.content : _flattenContent(m.content),
    }));
  }
  const { messages } = resolveMessages(prompt, flatOpts, {
    protocol: 'openai',
    attachImages: attachImagesToOpenAIMessages,
  });
  return messages;
}

function resolveTraeSdkMode() {
  const mode = String(process.env.TRAE_SDK_MODE || 'auto').trim().toLowerCase();
  if (mode === 'off' || mode === 'disable' || mode === 'disabled') return 'off';
  if (mode === 'force' || mode === 'only') return 'force';
  return 'auto';
}

function resolveTraeInstallPaths() {
  const out = [];
  const envInstall = String(process.env.TRAE_INSTALL_PATH || '').trim();
  if (envInstall) out.push(envInstall);

  try {
    const { findInstallation } = require('./ideDetector');
    const detected = findInstallation('trae');
    if (detected) out.push(detected);
  } catch {
    // ignore detector failure
  }

  return dedupe(out);
}

function resolveTraeSdkModuleCandidates() {
  const out = [];

  for (const item of parseList(process.env.TRAE_SDK_MODULE_PATHS || process.env.TRAE_SDK_MODULE_PATH || '')) {
    out.push(item);
  }

  out.push('@byted-icube/trae-network-client');

  const installs = resolveTraeInstallPaths();
  for (const root of installs) {
    out.push(path.join(root, 'resources', 'app', 'node_modules', '@byted-icube', 'trae-network-client'));
  }

  return dedupe(out);
}

function loadTraeSdkModule() {
  if (_sdkLoadTried) return _sdkModule;
  _sdkLoadTried = true;

  const errors = [];
  for (const candidate of resolveTraeSdkModuleCandidates()) {
    try {
      const mod = require(candidate);
      if (mod && typeof mod.fetch === 'function' && typeof mod.ZmqClient === 'function') {
        _sdkModule = mod;
        _sdkLoadError = null;
        return _sdkModule;
      }
      errors.push(`invalid exports: ${candidate}`);
    } catch (err) {
      errors.push(`${candidate}: ${err && err.message ? err.message : String(err)}`);
    }
  }

  _sdkModule = null;
  _sdkLoadError = errors.join(' | ');
  return null;
}

function resolveTraeSdkEndpoints(tokenData = null) {
  const endpoints = [
    ...parseList(process.env.TRAE_SDK_ENDPOINTS || process.env.TRAE_SDK_ENDPOINT || ''),
    tokenData?.sdkEndpoint || '',
    tokenData?.socketEndpoint || '',
  ];

  // Windows 上 ZMQ 的 IPC transport 不可用（Rust panic 无法被 JS catch 捕获）
  // 仅在非 Windows 或端点不是 ipc:// 时添加默认 IPC 端点
  if (process.platform !== 'win32') {
    endpoints.push('ipc:///tmp/trae.sock');
  }

  const resolved = dedupe(endpoints.map(s => String(s || '').trim()).filter(Boolean));

  // Windows: 过滤所有 ipc:// 端点，避免 Rust ZMQ panic
  if (process.platform === 'win32') {
    return resolved.filter(ep => !ep.startsWith('ipc://'));
  }

  return resolved;
}

function getTraeSdkClient(tokenData = null) {
  const sdk = loadTraeSdkModule();
  if (!sdk) return null;

  const endpoints = resolveTraeSdkEndpoints(tokenData);
  if (_sdkClient && _sdkClientEndpoint && endpoints.includes(_sdkClientEndpoint)) {
    return { sdk, client: _sdkClient, endpoint: _sdkClientEndpoint };
  }

  for (const endpoint of endpoints) {
    try {
      const client = new sdk.ZmqClient(endpoint);
      _sdkClient = client;
      _sdkClientEndpoint = endpoint;
      return { sdk, client, endpoint };
    } catch {
      // try next endpoint
    }
  }

  return null;
}

// ── Trae 原生协议通道 (x-cloudide-token) ──
// Trae 官方 API 使用 x-cloudide-token 请求头而非 Bearer
// 端点由 iCubeAuthInfo.host 动态拼接 (来源: product.json ugApi + TRAE_REGION_HOST_MAP)
// khy-trae-bridge 扩展从 AuthenticationProvider 提取 token+host

const TRAE_NATIVE_PROTOCOL_TIMEOUT_MS = 120_000;

// ── Token 自动刷新状态 ──
let _refreshPromise = null;
let _refreshBackoffUntil = 0;
let _refreshInterval = null;
const REFRESH_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
const REFRESH_PRE_EXPIRE_MS = 15 * 60 * 1000;     // 提前 15 分钟刷新

/**
 * 调用 Trae 原生刷新端点换取新 Token
 * POST https://{nativeHost}/cloudide/api/v3/trae/RefreshToken
 * Headers: x-cloudide-token + Content-Type
 * Body: { refreshToken }
 */
async function refreshTraeToken(tokenData) {
  const nativeHost = (tokenData.nativeHost || resolveNativeHostByRegion(tokenData.region) || '').replace(/^https?:\/\//, '');
  if (!nativeHost) throw new Error('Trae nativeHost unknown — cannot refresh');
  if (!tokenData.refreshToken) throw new Error('No refreshToken — please re-login in Trae IDE');

  const url = `https://${nativeHost}/cloudide/api/v3/trae/RefreshToken`;
  const authToken = tokenData.nativeToken || tokenData.accessToken;

  const res = await jsonRequest(url, {
    method: 'POST',
    timeout: 15_000,
    headers: sanitizeOutgoingHeaders({
      'Content-Type': 'application/json',
      'x-cloudide-token': authToken,
      'Origin': 'vscode-file://vscode-app',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Trae/1.107.1 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36',
    }),
    body: { refreshToken: tokenData.refreshToken },
  });

  if (res.status !== 200 || !res.data) {
    throw new Error(`Trae RefreshToken failed (${res.status})`);
  }

  const d = res.data;
  return {
    ...tokenData,
    accessToken: normalizeToken(d.token || d.accessToken || tokenData.accessToken),
    nativeToken: d.token || d.accessToken || tokenData.nativeToken,
    refreshToken: d.refreshToken || tokenData.refreshToken,
    expiresAt: d.expiredAt
      ? new Date(d.expiredAt).toISOString()
      : d.expiresAt
        ? new Date(d.expiresAt).toISOString()
        : new Date(Date.now() + 3600 * 1000).toISOString(),
  };
}

/**
 * 带自动刷新的 Token 获取 — 过期时用 refreshToken 换新 Token
 * 并发去重 + backoff + bridge 磁盘持久化
 * @returns {Promise<object|null>} 刷新后的 tokenData 或 null（无法刷新）
 */
async function getAccessTokenWithRefresh(tokenData) {
  if (!isTokenExpired(tokenData)) return tokenData;
  if (!tokenData.refreshToken) return null;

  // buffer 期内（真实过期时间未到）且在 backoff 中 → 继续用旧的
  const isTrulyExpired = !tokenData.expiresAt || new Date(tokenData.expiresAt) < new Date();
  if (!isTrulyExpired && Date.now() < _refreshBackoffUntil) return tokenData;

  // 并发去重
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    try {
      const newToken = await refreshTraeToken(tokenData);
      writeBridgeAuthToken(newToken);
      _token = newToken;
      _tokenMgr.persistObservedToken(newToken);
      return newToken;
    } catch (err) {
      _refreshBackoffUntil = Date.now() + 60_000; // 1 分钟 backoff
      // buffer 期内未真正过期 → 继续用
      if (tokenData.expiresAt && new Date(tokenData.expiresAt) > new Date()) {
        return tokenData;
      }
      return null;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

function startTokenRefresher() {
  if (_refreshInterval) return;
  _refreshInterval = setInterval(async () => {
    if (!_token || !_token.refreshToken || !_token.expiresAt) return;
    const remaining = new Date(_token.expiresAt).getTime() - Date.now();
    if (remaining > REFRESH_PRE_EXPIRE_MS) return;
    try {
      const refreshed = await getAccessTokenWithRefresh(_token);
      if (refreshed) _token = refreshed;
    } catch { /* best effort */ }
  }, REFRESH_CHECK_INTERVAL_MS);
  // Do not keep the event loop alive solely for token refresh.
  _refreshInterval.unref?.();
}

function stopTokenRefresher() {
  if (_refreshInterval) { clearInterval(_refreshInterval); _refreshInterval = null; }
}

/**
 * 构建 Trae 原生协议请求头 (x-cloudide-token 而非 Bearer)
 * @param {string} cloudideToken - iCubeAuthInfo 解密后的 token 字段
 * @param {object} [extra] - 额外 headers
 */
function buildNativeProtocolHeaders(cloudideToken, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'x-cloudide-token': cloudideToken,
    // Trae 原生请求必须的 headers (抓包确认 2026-05-25)
    'Origin': 'vscode-file://vscode-app',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Trae/1.107.1 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36',
    'x-net-sdk-domain-dispatch': '1',
    ...extra,
  };
}

/**
 * 通过 Trae 原生协议调用 AI API (x-cloudide-token 鉴权)
 *
 * 调用链路:
 *   1. iCubeAuthInfo.host + /generateAssistantResponse (或其他 AI 路径)
 *   2. 请求头: x-cloudide-token: <token>
 *   3. 响应格式: 与 CW 协议类似的 SSE 流
 *
 * 前置条件:
 *   - tokenData 中需要有 nativeToken (iCubeAuthInfo 解密后的 token)
 *   - tokenData 中需要有 nativeHost (iCubeAuthInfo 解密后的 host)
 *   或: 未来通过 sandbox IPC 拦截 / 扩展 API 获取
 *
 * @param {object} tokenData - 含 nativeToken + nativeHost 的 token 对象
 * @param {string} prompt
 * @param {string} model
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function callTraeByNativeProtocol(tokenData, prompt, model, options = {}) {
  const nativeToken = tokenData?.nativeToken;
  const nativeHost = tokenData?.nativeHost;

  if (!nativeToken || !nativeHost) {
    return buildFailure('Trae 原生协议需要 nativeToken (iCubeAuthInfo.token) 和 nativeHost (iCubeAuthInfo.host)', {
      adapter: 'trae',
      provider: 'Trae(Native)',
      model,
      errorType: 'config',
      attempts: [{ provider: 'Trae(Native)', success: false, error: 'missing_native_credential' }],
    });
  }

  // JWT token (eyJ 开头) 不兼容 x-cloudide-token 原生协议 — 直接跳过，走 HTTP Bearer 通道
  if (String(nativeToken).startsWith('eyJ')) {
    return buildFailure('Token 是 JWT 格式，不兼容 x-cloudide-token 原生协议，将使用 HTTP Bearer 通道', {
      adapter: 'trae',
      provider: 'Trae(Native)',
      model,
      errorType: 'token_format',
      attempts: [{ provider: 'Trae(Native)', success: false, error: 'jwt_not_compatible_with_native' }],
    });
  }

  // 多主机级联: 根据区域选择候选顺序
  const hostCandidates = [];
  const seenHosts = new Set();
  const addHost = (h) => {
    if (!h) return;
    const norm = h.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (seenHosts.has(norm)) return;
    seenHosts.add(norm);
    hostCandidates.push(`https://${norm}`);
  };
  const isCN = _isTraeCN(tokenData);
  if (isCN) {
    // CN 版: core-normal 是 AI 主机，grow-normal 是 ugApi
    addHost('core-normal.trae.ai');
    addHost(nativeHost);
    addHost('grow-normal.trae.ai');
  } else {
    // 国际版: SG/VA 端点优先，token 自带 host 优先
    addHost(nativeHost);
    addHost('growsg-normal.trae.ai');
    addHost('growva-normal.trae.ai');
    addHost('api-us-east.trae.ai');
    addHost('core-normal.trae.ai');
  }

  // 多路径级联: OpenAI 兼容 → CW 协议 → Trae 内部 agent
  const candidatePaths = [
    '/v1/chat/completions',             // OpenAI 兼容端点
    '/generateAssistantResponse',       // CW 协议 (Kiro/Trae 共用)
    '/api/agent/v3/chat',               // Trae 内部 agent 对话入口
  ];
  const onChunk = options.onChunk || (() => {});

  const messages = buildTraeMessages(prompt, options);
  const payload = {
    model,
    messages,
    stream: true,
  };

  const allAttempts = [];
  // 限制总尝试次数避免超长延迟（3 主机 × 3 路径 = 9 组合太多）
  const MAX_NATIVE_ATTEMPTS = 5;
  let attemptCount = 0;

  for (const hostBase of hostCandidates) {
    if (attemptCount >= MAX_NATIVE_ATTEMPTS) break;
    for (const apiPath of candidatePaths) {
      if (attemptCount >= MAX_NATIVE_ATTEMPTS) break;
      attemptCount++;
      const chatUrl = `${hostBase.replace(/\/+$/, '')}${apiPath}`;
    try {
      const res = await jsonRequest(chatUrl, {
        method: 'POST',
        timeout: 15_000, // 单次尝试 15s (多组合需要快速失败)
        headers: sanitizeOutgoingHeaders(buildNativeProtocolHeaders(nativeToken, {
          Accept: 'text/event-stream',
        })),
        body: payload,
      });

      // HTML / 非 JSON 检测
      const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
      const rawText = String(res.raw || '').trim();
      if (contentType.includes('text/html') || rawText.startsWith('<!') || rawText.startsWith('<html')) {
        allAttempts.push({ provider: `Trae(Native:${chatUrl})`, success: false, error: 'html_response' });
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        allAttempts.push({ provider: `Trae(Native:${chatUrl})`, success: false, error: `auth_${res.status}` });
        continue;
      }

      // SSE 流解析
      const content = consumeSseText(rawText, onChunk).trim();
      if (content) {
        _setProbeCache(hostBase, 'ok');
        return buildSuccess(content, {
          adapter: 'trae',
          provider: `Trae Native (${model}@${chatUrl})`,
          model,
          attempts: mergeAttempts(allAttempts, [{ provider: `Trae(Native:${chatUrl})`, success: true }]),
        });
      }

      // 非流式 JSON 兜底
      const json = res.data || {};
      const text = extractMessageText(json).trim();
      if (text) {
        _setProbeCache(hostBase, 'ok');
        return buildSuccess(text, {
          adapter: 'trae',
          provider: `Trae Native (${model}@${chatUrl})`,
          model,
          attempts: mergeAttempts(allAttempts, [{ provider: `Trae(Native:${chatUrl})`, success: true }]),
        });
      }

      allAttempts.push({ provider: `Trae(Native:${chatUrl})`, success: false, error: 'empty_response' });
      continue;
    } catch (err) {
      allAttempts.push({ provider: `Trae(Native:${chatUrl})`, success: false, error: err?.message || String(err) });
      continue;
    }
  } // end for candidatePaths
  } // end for hostCandidates

  // 所有路径都失败
  return buildFailure(allAttempts[allAttempts.length - 1]?.error || 'All native protocol paths failed', {
    adapter: 'trae',
    provider: 'Trae(Native)',
    model,
    errorType: 'network',
    attempts: allAttempts,
  });
}

// ── CodeWhisperer 协议通道 (复用 Kiro 的 SDK 客户端) ──
// Trae 原生 AI API 使用和 Kiro 相同的 GenerateAssistantResponse 协议
// 端点: api-us-east.trae.ai/generateAssistantResponse
// 需要 Cookie + Bearer Token 双重认证

let _traeCWClient = null;
let _traeCWClientKey = '';

const TRAE_CW_TIMEOUT_MS = 120_000;

/**
 * 创建 Trae 的 CodeWhispererStreaming 客户端
 * 接受显式 endpoint 参数，每个端点创建独立客户端
 */
async function _createTraeCWClient(tokenData, explicitEndpoint = null) {
  const bareEndpoint = explicitEndpoint || _resolveTraeCWEndpoint(tokenData);
  const clientKey = `${tokenData.accessToken}:${bareEndpoint}`;
  if (_traeCWClient && _traeCWClientKey === clientKey) return _traeCWClient;

  const { CodeWhispererStreaming } = await getCWModule();

  const isCN = _isTraeCN(tokenData);
  const clientOpts = {
    region: isCN ? 'cn-north-1' : 'us-east-1',
    endpoint: bareEndpoint,
    token: { token: tokenData.accessToken },
    customUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Trae/1.107.1 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36',
  };

  // 国际版 CW 端点需要走代理 (与 kiroAdapter 相同模式)
  if (!_isTraeCN(tokenData)) {
    const proxyCandidates = collectProxyCandidates({
      namespace: 'trae',
      envKeys: ['TRAE_HTTP_PROXY', 'TRAE_HTTPS_PROXY'],
    });
    const proxyUrl = proxyCandidates[0] || '';
    if (proxyUrl) {
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        const proxyAgent = new HttpsProxyAgent(proxyUrl);
        const { NodeHttpHandler } = await import('@smithy/node-http-handler');
        clientOpts.requestHandler = new NodeHttpHandler({ httpsAgent: proxyAgent });
      } catch {
        // https-proxy-agent 或 @smithy/node-http-handler 不可用，SDK 使用默认 handler
      }
    }
  }

  const client = new CodeWhispererStreaming(clientOpts);

  // Middleware: 注入必须的 headers
  client.middlewareStack.add(
    (next) => async (args) => {
      args.request.headers = sanitizeOutgoingHeaders({
        ...args.request.headers,
        'x-amzn-codewhisperer-optout': 'true',
        'x-amzn-kiro-agent-mode': 'vibe',
        'Origin': 'vscode-file://vscode-app',
        'x-net-sdk-domain-dispatch': '1',
      });
      return next(args);
    },
    { step: 'build', name: 'traeOptOutHeader' }
  );

  // Middleware: 注入 Cookie (Trae 登录态复用核心)
  if (tokenData.sessionCookies && !isCookieExpired(tokenData.cookiesExpireAt)) {
    client.middlewareStack.add(
      (next) => async (args) => {
        args.request.headers = {
          ...args.request.headers,
          'Cookie': tokenData.sessionCookies,
        };
        return next(args);
      },
      { step: 'build', name: 'traeCookieHeader' }
    );
  }

  _traeCWClient = client;
  _traeCWClientKey = clientKey;
  return client;
}

/**
 * 通过 CodeWhisperer 协议调用 Trae 原生 AI API
 * 这是与 Kiro 相同的协议, 支持 Claude/GPT 等模型
 */
async function callTraeByCodeWhisperer(tokenData, prompt, model, options = {}) {
  // accessToken 是必须的; sessionCookies 可选增强
  if (!tokenData.accessToken) {
    return buildFailure('Trae CodeWhisperer 通道需要 accessToken', { adapter: 'trae', errorType: 'auth', attempts: [] });
  }

  // JWT token (eyJ 开头) 不兼容 CW 协议 (CW 端点会返回 HTML) — 跳过直接走 HTTP
  if (String(tokenData.accessToken).startsWith('eyJ')) {
    return buildFailure('JWT token 不兼容 CW 协议', { adapter: 'trae', errorType: 'token_format', attempts: [{ provider: 'Trae(CW)', success: false, error: 'jwt_skip_cw' }] });
  }

  // 多端点级联: 优先 token 自带端点, 然后 CN / 国际版候选
  const cwEndpoints = _resolveTraeCWEndpoints(tokenData);
  const allAttempts = [];

  for (const endpoint of cwEndpoints) {
    let client;
    try {
      client = await _createTraeCWClient(tokenData, endpoint);
    } catch (err) {
      allAttempts.push({ provider: `Trae(CW:${endpoint})`, success: false, error: `sdk_load: ${err.message}` });
      continue;
    }

    try {
      const { GenerateAssistantResponseCommand } = await getCWModule();

      // Build conversationState via shared CW protocol handler
      const { conversationState } = _cwHandler.buildRequestBody(prompt, {
        ...options,
        model,
        system: options.system,
        tools: options.tools,
      });

      const command = new GenerateAssistantResponseCommand({ conversationState });

      const response = await Promise.race([
        client.send(command),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`CW timeout (${TRAE_CW_TIMEOUT_MS / 1000}s)`)), TRAE_CW_TIMEOUT_MS)
        ),
      ]);

      if (!response.generateAssistantResponseResponse) {
        throw new Error('Empty response from Trae CodeWhisperer');
      }

      // Parse streaming response via shared CW stream parser
      const onChunk = options.onChunk || (() => {});
      let streamResult;
      try {
        streamResult = await parseCWStreamEvents(
          response.generateAssistantResponseResponse,
          onChunk,
          {
            // Opt into stale-stream teardown (single-sourced in streamStallPolicy,
            // same wiring kiro + the SSE parsers use). CW serves Claude models →
            // 'claude' threshold. A mid-stream stall now tears the iterator down →
            // partial salvage or endpoint failover, instead of hanging to
            // TRAE_CW_TIMEOUT_MS.
            enableStaleDetection: true,
            staleOptions: {
              provider: 'claude',
              onStale: (elapsed) => {
                try { onChunk({ type: 'status', text: `Stream stale: no data for ${Math.round(elapsed / 1000)}s` }); } catch { /* ignore */ }
              },
            },
          },
        );
      } catch (streamErr) {
        if (streamResult && streamResult.content && streamResult.content.trim()) {
          _setProbeCache(endpoint, 'ok');
          return buildSuccess(streamResult.content.trim(), {
            adapter: 'trae',
            provider: `Trae CW (${streamResult.modelId || model}@${endpoint})`,
            model: streamResult.modelId || model,
            toolUseBlocks: streamResult.toolUseBlocks?.length > 0 ? streamResult.toolUseBlocks : undefined,
            stopReason: streamResult.toolUseBlocks?.length > 0 ? 'tool_use' : 'end_turn',
            tokenUsage: streamResult.tokenUsage || undefined,
            attempts: mergeAttempts(allAttempts, [{ provider: `Trae(CW:${endpoint})`, success: true, warning: 'stream_interrupted' }]),
            _cwEndpointVerified: endpoint,
          });
        }
        throw streamErr;
      }

      _setProbeCache(endpoint, 'ok');
      const hasToolUse = streamResult.toolUseBlocks.length > 0;
      return buildSuccess(streamResult.content.trim(), {
        adapter: 'trae',
        provider: `Trae CW (${streamResult.modelId || model}@${endpoint})`,
        model: streamResult.modelId || model,
        toolUseBlocks: hasToolUse ? streamResult.toolUseBlocks : undefined,
        stopReason: hasToolUse ? 'tool_use' : 'end_turn',
        tokenUsage: streamResult.tokenUsage || undefined,
        attempts: mergeAttempts(allAttempts, [{ provider: `Trae(CW:${endpoint})`, success: true }]),
        _cwEndpointVerified: endpoint,
      });
    } catch (err) {
      // 重置客户端缓存
      _traeCWClient = null;
      _traeCWClientKey = '';
      const errMsg = err.message || String(err);
      allAttempts.push({ provider: `Trae(CW:${endpoint})`, success: false, error: errMsg });
      // 将失败的 CW 端点写入探活缓存，避免后续重复超时
      _setProbeCache(endpoint, 'fail');
      // HTML 响应 / 网络错误 → 继续尝试下一个端点
      continue;
    }
  }

  return buildFailure(allAttempts[allAttempts.length - 1]?.error || 'All CW endpoints failed', {
    adapter: 'trae',
    provider: 'Trae',
    model,
    errorType: 'network',
    attempts: allAttempts,
  });
}

/**
 * 返回多个 CW 候选端点（按优先级排序）
 * CN 用户优先试 CN 端点，国际用户优先试 US 端点
 * 集成 _endpointProbeCache：已验证 > 未知 > 已失败，跳过已知失败的端点
 */
function _resolveTraeCWEndpoints(tokenData) {
  const endpoints = [];
  const seen = new Set();
  const add = (url) => {
    if (!url) return;
    const normalized = url.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    endpoints.push(normalized);
  };

  // 1) token 自带端点（最可靠）
  add(normalizeEndpointBase(tokenData?.apiBase));
  add(normalizeEndpointBase(tokenData?.endpoint));
  add(normalizeEndpointBase(tokenData?.host));

  // 2) 根据 CN/国际版选择候选顺序
  //    注意: grow-*/core-* 主机来自 Windows 端运行日志 + product.json ugApi 确认
  if (_isTraeCN(tokenData)) {
    add('https://core-normal.trae.ai');
    add('https://grow-normal.trae.ai');
    add('https://growsg-normal.trae.ai');
    add('https://adaptive-api.trae.ai');
    add('https://api-ap.trae.ai');
    add('https://api-us-east.trae.ai');
  } else {
    add('https://api-us-east.trae.ai');
    add('https://growva-normal.trae.ai');
    add('https://grow-normal.traeapi.us');
    add('https://adaptive-api.trae.ai');
    add('https://grow-normal.trae.ai');
    add('https://growsg-normal.trae.ai');
    add('https://core-normal.trae.ai');
    add('https://api-eu-west.trae.ai');
    add('https://api-ap.trae.ai');
  }

  // 3) 按探活缓存排序：已验证 > 未知 > 已失败
  const probeOrder = { ok: 0, unknown: 1, fail: 2 };
  endpoints.sort((a, b) => {
    const ca = _endpointProbeCache.get(a);
    const cb = _endpointProbeCache.get(b);
    const sa = ca && (Date.now() - ca.at < ENDPOINT_PROBE_CACHE_MS) ? ca.result : 'unknown';
    const sb = cb && (Date.now() - cb.at < ENDPOINT_PROBE_CACHE_MS) ? cb.result : 'unknown';
    return (probeOrder[sa] ?? 1) - (probeOrder[sb] ?? 1);
  });

  // 4) 过滤掉已知失败的端点（只保留 ok/unknown）
  return endpoints.filter(ep => {
    const cached = _endpointProbeCache.get(ep);
    if (!cached || (Date.now() - cached.at >= ENDPOINT_PROBE_CACHE_MS)) return true; // 未缓存或已过期 → 保留
    return cached.result !== 'fail';
  });
}

/**
 * 通过 Trae 原生 API 获取模型列表 (ListAvailableModels)
 * 端点: GET /ListAvailableModels?origin=AI_EDITOR
 * 多端点级联尝试 — 不再只试一个
 */
async function fetchModelsFromNativeApi(tokenData, options = {}) {
  if (!tokenData.accessToken) return null;

  const timeoutMs = Math.max(3000, parseInt(options.timeoutMs || '12000', 10) || 12000);
  const cwEndpoints = _resolveTraeCWEndpoints(tokenData);
  if (cwEndpoints.length === 0) return null;

  for (const bareBase of cwEndpoints.slice(0, 4)) {
    const url = `${bareBase}/ListAvailableModels?origin=AI_EDITOR`;
    try {
      const res = await jsonRequest(url, {
        method: 'GET',
        timeout: timeoutMs,
        headers: buildTraeHeaders(tokenData, {
          Accept: 'application/json',
          'User-Agent': 'KiroIDE 0.11.107',
        }),
      });

      if (res.status !== 200) continue;

      // 检测 HTML / 非 JSON 响应 → 跳过
      const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
      const rawText = String(res.raw || '').trim();
      if (contentType.includes('text/html') || rawText.startsWith('<!') || rawText.startsWith('<html')) {
        _setProbeCache(bareBase, 'fail');
        continue;
      }

      const data = res.data || {};
      const rawModels = Array.isArray(data.models) ? data.models : [];
      if (rawModels.length === 0) continue;

      const models = rawModels.map(m => ({
        id: m.modelId || m.id || '',
        name: m.modelName || m.name || m.modelId || '',
      })).filter(m => m.id);

      const defaultModelId = data.defaultModel?.modelId || null;
      _setProbeCache(bareBase, 'ok');
      return { models, defaultModelId, endpoint: bareBase, mode: 'native' };
    } catch {
      // 尝试下一个端点
    }
  }

  return null;
}

async function callTraeBySdk(tokenData, prompt, model, options = {}) {
  const sdkCtx = getTraeSdkClient(tokenData);
  if (!sdkCtx) {
    return buildFailure(_sdkLoadError ? `Trae SDK unavailable: ${_sdkLoadError}` : 'Trae SDK unavailable', {
      adapter: 'trae',
      provider: 'Trae',
      model,
      errorType: 'unavailable',
      attempts: [{ provider: 'Trae(SDK)', success: false, error: 'sdk_unavailable' }],
    });
  }

  const { sdk, client, endpoint: sdkEndpoint } = sdkCtx;
  const openaiTools = anthropicToOpenAI(options.tools);
  const useStream = !openaiTools && (options.stream === true || typeof options.onChunk === 'function');
  let messages = buildTraeMessages(prompt, options);
  if (openaiTools) messages = convertMessagesAnthropicToOpenAI(messages, true);
  const payload = {
    model,
    messages,
    stream: useStream,
    max_tokens: options.maxTokens || 2048,
    temperature: options.temperature || 0.4,
  };
  if (openaiTools) payload.tools = openaiTools;

  const attempts = [];
  for (const base of resolveTraeApiBases(tokenData)) {
    const url = buildChatUrl(base);
    try {
      const res = await sdk.fetch(client, url, {
        method: 'POST',
        headers: sanitizeOutgoingHeaders(buildTraeHeaders(tokenData, {
          'Content-Type': 'application/json',
        })),
        body: JSON.stringify(payload),
      });

      const statusCode = Number(res.status || 0);
      if (statusCode === 401 || statusCode === 403) {
        return buildFailure(`Trae SDK auth failed (${statusCode})`, {
          adapter: 'trae',
          provider: 'Trae',
          model,
          errorType: 'auth',
          statusCode,
          attempts: mergeAttempts(attempts, [{ provider: `Trae(SDK:${sdkEndpoint})`, success: false, error: `auth failed (${statusCode})`, statusCode }]),
        });
      }

      const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
      if (useStream || contentType.includes('text/event-stream')) {
        const sseRaw = await readWebReadableAsText(res.body);
        const content = consumeSseText(sseRaw, options.onChunk).trim();
        if (content) {
          return buildSuccess(content, {
            adapter: 'trae',
            provider: `Trae SDK (${model})`,
            model,
            attempts: mergeAttempts(attempts, [{ provider: `Trae(SDK:${sdkEndpoint})`, success: true }]),
          });
        }
        attempts.push({ provider: `Trae(SDK:${sdkEndpoint})`, success: false, error: `empty stream from ${url}` });
        continue;
      }

      const bodyText = await res.text();
      let json = null;
      try { json = JSON.parse(bodyText); } catch {
        json = null;
      }

      const text = extractMessageText(json || {}).trim();
      const sdkChoice = json?.choices?.[0];
      const sdkToolUseBlocks = sdkChoice ? openAIToolCallsToAnthropic(sdkChoice) : [];
      if (text || sdkToolUseBlocks.length > 0) {
        return buildSuccess(text, {
          adapter: 'trae',
          provider: `Trae SDK (${model})`,
          model,
          toolUseBlocks: sdkToolUseBlocks.length > 0 ? sdkToolUseBlocks : undefined,
          stopReason: sdkToolUseBlocks.length > 0 ? 'tool_use' : (sdkChoice?.finish_reason || 'end_turn'),
          attempts: mergeAttempts(attempts, [{ provider: `Trae(SDK:${sdkEndpoint})`, success: true }]),
        });
      }

      attempts.push({
        provider: `Trae(SDK:${sdkEndpoint})`,
        success: false,
        error: json?.error?.message || `invalid response (${statusCode})`,
        statusCode,
      });
    } catch (err) {
      attempts.push({ provider: `Trae(SDK:${sdkEndpoint})`, success: false, error: err?.message || String(err) });
    }
  }

  return buildFailure(attempts[attempts.length - 1]?.error || 'Trae SDK request failed', {
    adapter: 'trae',
    provider: 'Trae',
    model,
    errorType: 'network',
    attempts,
  });
}

function callTraeByHttp(tokenData, prompt, model, options = {}) {
  const hasTools = Array.isArray(options.tools) && options.tools.length > 0;
  const useStream = !hasTools && (options.stream === true || typeof options.onChunk === 'function');

  // Trae-specific: flatten content arrays in simple messages (Trae doesn't support content arrays)
  let _flattenContent;
  try { _flattenContent = require('../../../services/contentBlockUtils').flattenContent; } catch { _flattenContent = (c) => String(c || ''); }
  const pipelineOpts = { ...options, model, stream: useStream, max_tokens: options.maxTokens || 2048, temperature: options.temperature ?? 0.4 };
  if (Array.isArray(pipelineOpts.messages)) {
    pipelineOpts.messages = pipelineOpts.messages.map(m => ({
      ...m,
      content: typeof m.content === 'string' ? m.content : _flattenContent(m.content),
    }));
  }
  const { body: payload } = _openaiHandler.buildRequestBody(prompt, pipelineOpts);

  const bases = resolveTraeApiBases(tokenData);
  const attempts = [];

  const runOne = (baseIndex) => {
    if (baseIndex >= bases.length) {
      return Promise.resolve(buildFailure(attempts[attempts.length - 1]?.error || 'Trae HTTP request failed', {
        adapter: 'trae',
        provider: 'Trae',
        model,
        errorType: 'network',
        attempts,
      }));
    }

    const base = bases[baseIndex];
    const endpoint = buildChatUrl(base);
    return jsonRequest(endpoint, {
      method: 'POST',
      timeout: TIMEOUT_MS,
      headers: buildTraeHeaders(tokenData, { 'Content-Type': 'application/json' }),
      body: payload,
    }).then(async (res) => {
      const statusCode = Number(res.status || 0);
      if (statusCode === 401 || statusCode === 403) {
        return buildFailure(`Trae auth failed (${statusCode})`, {
          adapter: 'trae',
          provider: 'Trae',
          model,
          errorType: 'auth',
          statusCode,
          attempts: mergeAttempts(attempts, [{ provider: 'Trae(HTTP)', success: false, error: `auth failed (${statusCode})`, statusCode }]),
        });
      }
      if (statusCode < 200 || statusCode >= 300) {
        _setProbeCache(base, 'fail');
        attempts.push({ provider: 'Trae(HTTP)', success: false, error: `HTTP ${statusCode}`, statusCode });
        return runOne(baseIndex + 1);
      }

      // 检测 HTML / 非 JSON 响应 → 标记端点失败，尝试下一个
      const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
      const rawText = String(res.raw || '').trim();
      if (contentType.includes('text/html') || rawText.startsWith('<!') || rawText.startsWith('<html')) {
        _setProbeCache(base, 'fail');
        attempts.push({ provider: 'Trae(HTTP)', success: false, error: `${base} 返回 HTML（非 OpenAI 端点）` });
        return runOne(baseIndex + 1);
      }

      const streamLike = useStream || contentType.includes('text/event-stream');
      const dataText = rawText;

      if (streamLike) {
        const streamedText = consumeSseText(dataText, options.onChunk).trim();
        if (streamedText) {
          return buildSuccess(streamedText, {
            adapter: 'trae',
            provider: `Trae (${model})`,
            model,
            attempts: mergeAttempts(attempts, [{ provider: 'Trae(HTTP)', success: true }]),
          });
        }
      }

      const json = res.data || {};
      const parsed = _openaiHandler.parseJsonResponse(json);
      if (parsed.content.trim() || parsed.toolUseBlocks.length > 0) {
        return buildSuccess(parsed.content.trim(), {
          adapter: 'trae',
          provider: `Trae (${model})`,
          model,
          toolUseBlocks: parsed.toolUseBlocks.length > 0 ? parsed.toolUseBlocks : undefined,
          stopReason: parsed.stopReason,
          attempts: mergeAttempts(attempts, [{ provider: 'Trae(HTTP)', success: true }]),
        });
      }

      const errorText = json.error?.message || `invalid response (${statusCode})`;
      attempts.push({ provider: 'Trae(HTTP)', success: false, error: errorText, statusCode });
      return runOne(baseIndex + 1);
    }).catch(async (err) => {
      attempts.push({ provider: 'Trae(HTTP)', success: false, error: err?.message || String(err) });
      return runOne(baseIndex + 1);
    });
  };

  return runOne(0);
}

function detect(forceRefresh = false) {
  if (_detectionState._checked && !forceRefresh) return _detectionState.available;

  // 1) 安装检测
  _detectionState.installDetected = detectInstallation();

  // 2) 读取 token — 内部已更新 _detectionState 的 officialArtifactsDetected / credentialMode / officialArtifactSources
  const localToken = readTraeToken();

  // 3) 如果 readTraeToken 还没做官方扫描（比如直接从旧 storage.json 拿到 token），补扫
  if (!_detectionState.officialArtifactsDetected && !_detectionState._officialCredential) {
    const officialCred = resolveTraeOfficialCredential();
    _detectionState._officialCredential = officialCred;
    _detectionState.officialArtifactsDetected = officialCred.officialArtifactsDetected;
    _detectionState.officialArtifactSources = officialCred.sourcePaths || [];
    if (_detectionState.credentialMode === 'none' && officialCred.credentialMode !== 'none') {
      _detectionState.credentialMode = officialCred.credentialMode;
    }
  }

  // 4) 设置 token
  if (localToken) {
    _token = localToken;
    _tokenMgr.persistObservedToken(localToken);
  } else if (!(_token && _token.accessToken && String(_token.source || '').startsWith('pool:'))) {
    _token = null;
  }

  // 5) available = 真实本地登录（installed + login）。pool/Nirvana 来源的 token 不计入
  //    可用性（除非 KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS 开启且本地已安装 Trae）。
  //    _token 仍保留供 routing/generate 使用。原生明文/官方凭据即证明本地安装+登录。
  _detectionState.available = _traeComputeAvailable(_token);
  if (!_detectionState.available) _models = [];
  _detectionState._checked = true;
  return _detectionState.available;
}

// Strict availability for Trae. A native login token (`official-trae` / `Trae` /
// `Trae CN` storage) proves install+login. Tokens whose source is the Nirvana
// account-switcher cache or the account pool do NOT count unless the IDE is
// locally installed AND the imported-credentials flag is set.
function _traeStrictInstalled() {
  try {
    const { findInstallation, findDataPath } = require('./ideDetector');
    return !!(findInstallation('trae') || findDataPath('trae'));
  } catch { return false; }
}

function _traeComputeAvailable(token) {
  if (!token || !isLikelyCredentialToken(token.accessToken)) return false;
  if (isNativeLoginToken(token)) return true;
  return _traeStrictInstalled() && countsTowardAvailability(token);
}

async function detectAsync(forceRefresh = false) {
  let ok = detect(forceRefresh);
  const selected = await selectToken({ allowExpired: false });
  if (selected.token && selected.token.accessToken) {
    // Keep the (possibly pool) token for routing, but availability stays strict:
    // pool/Nirvana sources do not flip availability unless install + flag allow it.
    _token = selected.token;
    _detectionState.available = _traeComputeAvailable(_token);
    ok = true;
    _tokenMgr.persistObservedToken(_token);
  }

  // 官方凭据验证（仅当有 officialCredential 且有 token 时）
  if (!ok && _detectionState._officialCredential) {
    const cred = _detectionState._officialCredential;
    if (cred.token) {
      // 有明文 token → 构建 tokenData 并验证
      // nativeHost: 优先 cred 自带的 host，否则根据 regionHint 推断
      const nativeHost = cred.nativeHost
        || resolveNativeHostByRegion(cred.regionHint);
      _token = {
        accessToken: normalizeToken(cred.token),
        refreshToken: null,
        source: 'official-trae',
        path: (cred.sourcePaths || [])[0] || null,
        endpoint: normalizeEndpointBase(cred.endpoint || ''),
        sdkEndpoint: null,
        expiresAt: null,
        sessionCookies: null,
        cookiesExpireAt: null,
        // 区域信息 — 供 _isTraeCN 等判断使用
        region: cred.regionHint || null,
        // 原生协议字段 — 供 callTraeByNativeProtocol 使用
        nativeToken: cred.token,
        nativeHost,
      };
      _detectionState.credentialMode = 'plaintext';
      _detectionState.available = true;
      ok = true;
      _tokenMgr.persistObservedToken(_token);
    }
  }

  // 官方凭据精确验证 — 优先用 verifyTraeOfficialSession 替代通用 probeEndpoint
  if (_detectionState._officialCredential) {
    const cred = _detectionState._officialCredential;
    try {
      const verification = await verifyTraeOfficialSession(cred, requestJson);
      if (verification.sessionVerified) {
        _detectionState.sessionVerified = true;
        if (verification.verifiedEndpoint) {
          _setProbeCache(verification.verifiedEndpoint, 'ok');
        }
      }
    } catch { /* 验证失败不阻塞 */ }
  }

  // 端点探活：有 token 但 session 尚未验证时，用通用 probeEndpoint 兜底
  if (ok && _token && _token.accessToken && !_detectionState.sessionVerified) {
    try {
      const bases = resolveTraeApiBases(_token);
      // 只探活已知 OpenAI 兼容的端点（跳过空列表）
      for (const base of bases.slice(0, 3)) {
        const status = await probeEndpoint(base, _token.accessToken);
        if (status === 'ok') {
          _detectionState.sessionVerified = true;
          break;
        }
      }
    } catch { /* 探活失败不影响检测结果 */ }
  }

  // 启动定时刷新巡检
  if (ok) startTokenRefresher();

  return ok;
}

async function listModels() {
  detect(true);
  const selected = await selectToken({ allowExpired: true });
  if (selected.token && selected.token.accessToken) {
    _token = selected.token;
    _detectionState.available = true;
    _tokenMgr.persistObservedToken(_token);
  }

  if (!_token || !_token.accessToken) {
    // No token — still return known + injected models so users can see what's
    // available (generate() will report auth errors at call time).
    const fallback = KNOWN_MODELS.map(m => ({
      id: m.id,
      name: m.name,
      isDefault: !!m.isDefault,
      provider: 'trae',
      description: 'No Trae token — login in Trae IDE to use this model.',
      discoverySource: 'builtin',
    }));
    if (TRAE_INJECT_MODELS) {
      const existingIds = new Set(fallback.map(m => canonicalModelKey(m.id)));
      for (const im of TRAE_INJECTED_MODELS) {
        if (existingIds.has(canonicalModelKey(im.id))) continue;
        fallback.push({
          id: im.id,
          name: im.name,
          isDefault: false,
          provider: 'trae',
          description: 'No Trae token — login in Trae IDE to use this model.',
          discoverySource: 'injected',
        });
      }
    }
    _models = fallback;
    _detectionState.available = false;
    return _models;
  }

  if (_models.length > 0 && (Date.now() - _modelsFetchedAt) < MODEL_DISCOVERY_CACHE_MS) {
    return _models;
  }

  const snapshots = readTraeStorageSnapshots();
  const discovered = discoverModelsFromSnapshots(snapshots, { isLikelyModelIdFn: isLikelyModelId });
  const localModelIds = discovered.discoveredModelIds || [];
  let apiModels = [];
  let apiDefault = null;
  let officialHit = false;
  let officialEndpoint = '';
  let apiError = '';

  if (_token && _token.accessToken && !isTokenExpired(_token)) {
    // 优先尝试 Trae 原生 API (/ListAvailableModels) — 有无 Cookie 都可尝试
    // Cookie 增强成功率，但 accessToken 单独也可能有效
    try {
      const nativeApi = await fetchModelsFromNativeApi(_token);
      if (nativeApi && nativeApi.models && nativeApi.models.length > 0) {
        apiModels = nativeApi.models.map(m => m.id || m.modelId);
        apiDefault = nativeApi.defaultModelId || null;
        officialEndpoint = nativeApi.endpoint || '';
        officialHit = true;
      }
    } catch (_nativeErr) {
      // 原生 API 失败不阻塞，fallback 到 OpenAI 格式
    }

    // OpenAI 格式 API 兜底
    if (!officialHit) {
      try {
        const api = await fetchModelsFromApi(_token);
        apiModels = (api.models || []).map(m => m.id);
        apiDefault = api.defaultModelId || null;
        officialEndpoint = api.endpoint || '';
        officialHit = apiModels.length > 0;
      } catch (err) {
        apiError = err?.message || String(err);
        if (err && err.code === 'AUTH' && selected.fallback && selected.fallback.accessToken && !isTokenExpired(selected.fallback)) {
          _token = selected.fallback;
          _tokenMgr.persistObservedToken(_token);
          try {
            const retry = await fetchModelsFromApi(_token);
            apiModels = (retry.models || []).map(m => m.id);
            apiDefault = retry.defaultModelId || null;
            officialEndpoint = retry.endpoint || '';
            officialHit = apiModels.length > 0;
            apiError = '';
          } catch (retryErr) {
            apiError = retryErr?.message || apiError;
            if (retryErr && retryErr.code === 'AUTH') {
              _detectionState.available = false;
              _models = [];
              _modelsFetchedAt = Date.now();
              _lastApiMeta = {
                at: Date.now(),
                endpoint: '',
                officialHit: false,
                officialCount: 0,
                localCount: localModelIds.length,
                mergedCount: 0,
                error: apiError,
                mode: 'http',
              };
              return [];
            }
          }
        } else if (err && err.code === 'AUTH') {
          _detectionState.available = false;
          _models = [];
          _modelsFetchedAt = Date.now();
          _lastApiMeta = {
            at: Date.now(),
            endpoint: '',
            officialHit: false,
            officialCount: 0,
            localCount: localModelIds.length,
            mergedCount: 0,
            error: apiError,
            mode: 'http',
          };
          return [];
        }
      }
    }
  }

  const merged = buildModelList(
    [...apiModels, ...localModelIds],
    apiDefault || discovered.defaultModelId,
    {
      apiModelIds: apiModels,
      localModelIds,
      knownModels: KNOWN_MODELS,
      modelDisplayNameFn: modelDisplayName,
      isLikelyModelIdFn: isLikelyModelId,
      defaultFallbackModelKey: 'doubao-1.5-pro',
    }
  );

  _models = merged.map(m => ({ ...m, provider: 'trae', description: '' }));

  // Inject models that Trae IDE shows but API omits (same pattern as Kiro).
  if (TRAE_INJECT_MODELS) {
    const existingIds = new Set(_models.map(m => canonicalModelKey(m.id)));
    for (const im of TRAE_INJECTED_MODELS) {
      if (existingIds.has(canonicalModelKey(im.id))) continue;
      _models.push({
        id: im.id,
        name: im.name,
        isDefault: false,
        provider: 'trae',
        description: 'Injected — Trae IDE shows this model but API may not list it.',
        discoverySource: 'injected',
      });
    }
  }

  _detectionState.available = true;
  _modelsFetchedAt = Date.now();
  _lastApiMeta = {
    at: Date.now(),
    endpoint: officialEndpoint,
    officialHit,
    officialCount: apiModels.length,
    localCount: localModelIds.length,
    mergedCount: _models.length,
    error: apiError,
    mode: 'http',
  };

  return _models;
}

function getStatus() {
  detect(true);
  const modelCount = _models.length || KNOWN_MODELS.length;
  const sdk = loadTraeSdkModule();
  const hasCookie = !!(_token?.sessionCookies && !isCookieExpired(_token?.cookiesExpireAt));

  // 五级中文状态描述
  let detail = '';
  let statusLevel = 'unknown'; // 'verified' | 'pending' | 'encrypted' | 'installed' | 'missing'

  if (_detectionState.available && _detectionState.sessionVerified) {
    statusLevel = 'verified';
    const cookieSuffix = hasCookie ? ' + Cookie' : '';
    detail = `Token 有效，已验证${cookieSuffix} (${modelCount} 个模型)`;
  } else if (_detectionState.available) {
    statusLevel = 'pending';
    const cookieSuffix = hasCookie ? ' + Cookie' : '';
    detail = `Token 检测到，待验证${cookieSuffix} (${modelCount} 个模型)`;
  } else if (_detectionState.officialArtifactsDetected && _detectionState.credentialMode === 'encrypted') {
    statusLevel = 'encrypted';
    // 显示加密方案详情
    const blobAnalysis = _detectionState._officialCredential?.authBlobAnalysis;
    const scheme = blobAnalysis?.schemeHint || 'unknown';
    const schemeDesc = scheme === 'trae-custom-encrypted'
      ? 'Electron safeStorage 加密'
      : scheme === 'dpapi' ? 'Windows DPAPI 加密'
      : scheme.startsWith('chromium-safe-storage') ? `Chromium ${scheme.split('-').pop()} 加密`
      : '加密格式未知';
    const bridgeHint = _detectionState._officialCredential?.bridgeStale
      ? '（桥接 token 已过期，请在 Trae 中刷新）'
      : '（安装 khy-trae-bridge 扩展可自动提取 token）';
    detail = `Trae 已登录，检测到加密登录态（${schemeDesc}）${bridgeHint}`;
  } else if (_traeStrictInstalled()) {
    statusLevel = 'installed';
    detail = 'Trae 已安装，未检测到登录态 — 请先登录 Trae IDE';
  } else {
    statusLevel = 'missing';
    detail = '未检测到 Trae 安装';
  }

  // 端点状态统计
  const endpointBases = _token ? resolveTraeApiBases(_token) : [];
  const endpointStatus = endpointBases.map(ep => {
    const cached = _endpointProbeCache.get(ep);
    const probeResult = cached && (Date.now() - cached.at < ENDPOINT_PROBE_CACHE_MS) ? cached.result : 'untested';
    return { endpoint: ep, status: probeResult };
  });

  // 官方 artifact 分析摘要
  const officialCred = _detectionState._officialCredential;
  const officialArtifacts = officialCred ? {
    detected: officialCred.officialArtifactsDetected,
    sources: officialCred.sourcePaths || [],
    authBlobPresent: officialCred.authBlobPresent || false,
    userTagBlobPresent: officialCred.userTagBlobPresent || false,
    serverDataPresent: officialCred.serverDataPresent || false,
    regionHint: officialCred.regionHint || null,
    userIdHint: officialCred.userIdHint || null,
    endpointHints: officialCred.endpointHints || [],
    credentialMode: officialCred.credentialMode || 'none',
    authBlobAnalysis: officialCred.authBlobAnalysis || null,
    nativeHost: officialCred.nativeHost || null,
    bridgePath: officialCred.bridgePath || null,
    bridgeStale: officialCred.bridgeStale || false,
  } : null;

  return {
    name: 'Trae IDE',
    type: 'trae',
    available: _detectionState.available,
    statusLevel,
    detail,
    // 完整结构化检测状态
    installDetected: _detectionState.installDetected,
    officialArtifactsDetected: _detectionState.officialArtifactsDetected,
    officialArtifactSources: _detectionState.officialArtifactSources,
    credentialMode: _detectionState.credentialMode,
    sessionVerified: _detectionState.sessionVerified,
    // token 信息
    tokenPath: _token?.path || '',
    tokenSource: _token?.source || '',
    hasCookie,
    cookiesExpireAt: _token?.cookiesExpireAt || null,
    // 官方 artifact 分析
    officialArtifacts,
    // 端点状态
    endpoints: endpointStatus,
    // SDK 信息
    sdk: {
      available: !!sdk,
      endpoint: _sdkClientEndpoint || '',
      error: sdk ? '' : (_sdkLoadError || ''),
      mode: resolveTraeSdkMode(),
    },
    // 模型发现
    officialModels: {
      hit: !!_lastApiMeta.officialHit,
      endpoint: _lastApiMeta.endpoint || '',
      officialCount: _lastApiMeta.officialCount || 0,
      localCount: _lastApiMeta.localCount || 0,
      mergedCount: _lastApiMeta.mergedCount || modelCount,
      error: _lastApiMeta.error || '',
      at: _lastApiMeta.at || 0,
      mode: _lastApiMeta.mode || 'http',
    },
    refreshModels: listModels,
  };
}

async function generate(prompt, options = {}) {
  const selected = await selectToken({ allowExpired: true });
  if (selected.token && selected.token.accessToken) {
    _token = selected.token;
    _detectionState.available = true;
    _tokenMgr.persistObservedToken(_token);
  }

  if (!_token || !_token.accessToken) {
    return buildFailure('Trae token not found', {
      adapter: 'trae',
      provider: 'Trae',
      attempts: [{ provider: 'Trae', success: false, error: 'No token' }],
    });
  }

  if (!isLikelyCredentialToken(_token.accessToken)) {
    return buildFailure('Trae token invalid — please refresh account pool/import data', {
      adapter: 'trae',
      provider: 'Trae',
      errorType: 'auth',
      attempts: [{ provider: 'Trae', success: false, error: 'invalid token shape' }],
    });
  }

  if (isTokenExpired(_token)) {
    const refreshed = await getAccessTokenWithRefresh(_token);
    if (refreshed) {
      _token = refreshed;
    } else {
      return buildFailure('Trae token expired, refresh failed — please re-login in Trae IDE', {
        adapter: 'trae',
        provider: 'Trae',
        errorType: 'auth',
        attempts: [{ provider: 'Trae', success: false, error: 'token expired, refresh failed' }],
      });
    }
  }

  const defaultModel = (_models.find(m => m.isDefault) || _models[0] || {}).id || 'doubao-1.5-pro';
  const model = options.model || defaultModel;

  // ---- 策略: Native → CW → SDK → HTTP → fallback ----
  const allAttempts = [];

  // 0) Trae 原生协议 (x-cloudide-token, 需要 nativeToken + nativeHost)
  if (_token.nativeToken && _token.nativeHost) {
    try {
      const nativeResult = await callTraeByNativeProtocol(_token, prompt, model, options);
      if (nativeResult.success) return nativeResult;
      if (nativeResult.attempts) allAttempts.push(...nativeResult.attempts);
    } catch (nativeErr) {
      allAttempts.push({ provider: 'Trae-Native', success: false, error: nativeErr?.message || String(nativeErr) });
    }
  }

  // 1) CodeWhisperer 协议通道 (Trae 原生, accessToken 必须; sessionCookies 可选增强)
  {
    try {
      const cwResult = await callTraeByCodeWhisperer(_token, prompt, model, options);
      if (cwResult.success) return cwResult;
      if (cwResult.attempts) allAttempts.push(...cwResult.attempts);
    } catch (cwErr) {
      allAttempts.push({ provider: 'Trae-CW', success: false, error: cwErr?.message || String(cwErr) });
    }
  }

  // 2) SDK 通道 (OpenAI 兼容)
  const sdkMode = resolveTraeSdkMode();
  let sdkResult = null;

  if (sdkMode !== 'off') {
    sdkResult = await callTraeBySdk(_token, prompt, model, options);
    if (sdkResult.success) {
      sdkResult.attempts = mergeAttempts(allAttempts, sdkResult.attempts);
      return sdkResult;
    }
    if (sdkMode === 'force') {
      sdkResult.attempts = mergeAttempts(allAttempts, sdkResult.attempts);
      return sdkResult;
    }
  }

  // 3) HTTP 通道 (OpenAI 兼容)
  let result = await callTraeByHttp(_token, prompt, model, options);
  if (result.success) {
    result.attempts = mergeAttempts(allAttempts, sdkResult?.attempts, result.attempts);
    return result;
  }

  // 4) auth 失败 → 先尝试 refreshToken 刷新，再 fallback token 重试
  if (result.errorType === 'auth') {
    // 4a) 用 refreshToken 刷新当前 token
    if (_token.refreshToken) {
      const refreshed = await getAccessTokenWithRefresh(_token);
      if (refreshed && refreshed.accessToken !== _token.accessToken) {
        _token = refreshed;
        const retryAfterRefresh = await callTraeByHttp(_token, prompt, model, options);
        if (retryAfterRefresh.success) {
          retryAfterRefresh.attempts = mergeAttempts(allAttempts, sdkResult?.attempts, result.attempts, [{ provider: 'Trae(refresh)', success: true }], retryAfterRefresh.attempts);
          return retryAfterRefresh;
        }
      }
    }

    // 4b) fallback token
    if (selected.fallback && selected.fallback.accessToken && !isTokenExpired(selected.fallback)) {
      _token = selected.fallback;
      _tokenMgr.persistObservedToken(_token);

      const retry = await callTraeByHttp(_token, prompt, model, options);
      if (retry.success) {
        retry.attempts = mergeAttempts(allAttempts, sdkResult?.attempts, result.attempts, retry.attempts);
        return retry;
      }

      return {
        ...retry,
        attempts: mergeAttempts(allAttempts, sdkResult?.attempts, result.attempts, retry.attempts),
      };
    }
  }

  result.attempts = mergeAttempts(allAttempts, sdkResult?.attempts, result.attempts);
  return result;
}

function destroy() {
  stopTokenRefresher();
  _refreshPromise = null;
  _refreshBackoffUntil = 0;
  _detectionState = {
    installDetected: false, officialArtifactsDetected: false,
    officialArtifactSources: [],
    credentialMode: 'none', sessionVerified: false, available: false,
    _checked: false, _officialCredential: null,
  };
  _endpointProbeCache.clear();
  _token = null;
  _models = [];
  _modelsFetchedAt = 0;
  _lastApiMeta = {
    at: 0,
    endpoint: '',
    officialHit: false,
    officialCount: 0,
    localCount: 0,
    mergedCount: 0,
    error: '',
    mode: 'http',
  };

  try {
    if (_sdkClient && typeof _sdkClient.close === 'function') {
      _sdkClient.close();
    }
  } catch {
    // ignore sdk client close errors
  }
  _sdkClient = null;
  _sdkClientEndpoint = '';

  // CodeWhisperer 协议客户端
  _traeCWClient = null;
  _traeCWClientKey = '';
}

/**
 * Build an OpenAI-compatible relay profile from current Trae login state.
 * Used by `proxy switch-center sync --provider trae` and auto sync flow.
 */
async function getRelayProfile(options = {}) {
  const selected = await selectToken({ allowExpired: false });
  if (!selected.token || !selected.token.accessToken) {
    throw new Error('Trae token not found. Please login in Trae IDE first.');
  }
  _token = selected.token;
  _detectionState.available = true;
  _tokenMgr.persistObservedToken(_token);

  if (isTokenExpired(_token)) {
    throw new Error('Trae token expired. Please re-login in Trae IDE.');
  }

  const models = await listModels();
  const modelIds = (Array.isArray(models) ? models : [])
    .map(m => normalizeModelId(m?.id || ''))
    .filter(Boolean);
  if (modelIds.length === 0) {
    throw new Error('No Trae models discovered from current account.');
  }

  const defaultModel = normalizeModelId(
    options.defaultModel
    || options.model
    || (models.find(m => m && m.isDefault) || {}).id
    || modelIds[0]
  ) || modelIds[0];

  const endpointOverride = toRelayEndpointBase(options.endpoint || options.baseUrl || options.base || '');
  const endpointFromToken = toRelayEndpointBase(_token.endpoint || '');
  const endpointFromApi = toRelayEndpointBase(resolveTraeApiBases(_token)[0] || '');
  const endpoint = endpointOverride
    || endpointFromToken
    || endpointFromApi
    || '';  // 不再盲加 api.trae.ai/v1 — 真实 Trae API 是原生协议非 OpenAI 兼容

  if (!endpoint) {
    throw new Error('没有可用的 OpenAI 兼容端点 — Trae 原生 API 不支持 /v1/chat/completions 格式');
  }

  const modelMap = {};
  for (const id of modelIds) modelMap[id] = id;

  return {
    id: String(options.id || 'trae-auto').trim() || 'trae-auto',
    name: String(options.name || 'Trae Auto').trim() || 'Trae Auto',
    endpoint,
    key: String(options.key || '').trim() || _token.accessToken,
    models: modelIds,
    modelMap,
    defaultModel,
    source: _token.source || '',
    path: _token.path || '',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { detect, detectAsync, getStatus, listModels, generate, destroy, getRelayProfile };
