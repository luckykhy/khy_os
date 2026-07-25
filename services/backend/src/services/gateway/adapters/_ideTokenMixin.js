/**
 * @pattern Facade
 */
'use strict';
const { resolveMessages } = require('./_messageBuilder');
// Model-name SSOT: the IDE default-fallback model flows from constants/models.js.
const { PRIMARY: MODELS } = require('../../../constants/models');

/**
 * _ideTokenMixin.js — IDE 适配器共享 Token 管理与模型发现逻辑
 *
 * 从 traeAdapter.js 和 windsurfAdapter.js 中提取 15+ 个完全相同的函数，
 * 参数化品牌名/环境变量差异，消除 ~500 行重复代码。
 *
 * 用法:
 *   const mixin = createIdeTokenMixin({
 *     ideName: 'trae',
 *     poolType: 'trae',
 *     envPrefix: 'TRAE',
 *     knownModels: [...],
 *     readTokenFn: () => readTraeToken(),
 *     storagePaths: TRAE_STORAGE_PATHS,
 *   });
 *   // mixin.normalizeToken, mixin.selectToken, mixin.buildModelList, ...
 */

const { attachImagesToOpenAIMessages } = require('./_imageCompat');

// ─── Token 工具函数（完全相同） ──────────────────────

function normalizeToken(raw) {
  return String(raw || '').trim();
}

function isLikelyCredentialToken(raw) {
  const token = normalizeToken(raw);
  if (!token) return false;
  if (token.length < 20 || token.length > 4096) return false;
  if (/\s/.test(token)) return false;
  if (!/^[A-Za-z0-9._\-+/=~:]+$/.test(token)) return false;
  if (/^(null|undefined|token|access[_-]?token|bearer)$/i.test(token)) return false;
  if (/^(eyJ|sk-|rk-|rt_|atk-|khy-)/i.test(token)) return true;
  if (/^[A-Za-z0-9]{20,}$/i.test(token)) return true;
  return /[A-Za-z]/.test(token) || /\d/.test(token);
}

function isTokenExpired(tokenData) {
  if (!tokenData || !tokenData.expiresAt) return false;
  const ts = new Date(tokenData.expiresAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return ts < (Date.now() + 60 * 1000);
}

function dedupeTokens(tokens = []) {
  const out = [];
  const seen = new Set();
  for (const token of tokens) {
    if (!token || !isLikelyCredentialToken(token.accessToken)) continue;
    const key = normalizeToken(token.accessToken);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

// ─── 可用性严格判定（单一真源） ──────────────────────
//
// 设计：网关状态面板的「可用」必须如实反映本地真实安装 + 登录，不能因为
// 导入了 pool/Nirvana 凭证就把未安装的 IDE 标成可用。
//   available = installedLocally && hasGenuineLocalLogin
// 其中 hasGenuineLocalLogin 要求 token 来自 IDE 自身原生存储（classifyTokenSource==='local'）。
// pool/导入凭证仍可驱动实际请求（routing/generate 不受影响），仅不计入「可用性显示」。
//
// 通过 opt-in 环境变量 KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS（默认 OFF）保留旧行为。

/**
 * 是否允许导入/池化凭证计入可用性。默认 OFF（严格）。
 * 这是读取该 env 的唯一位置——适配器禁止直接读 process.env。
 * @returns {boolean}
 */
function allowImportedCredentials() {
  return /^(1|true|on|yes)$/i.test(String(process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS || '').trim());
}

const _NIRVANA_SOURCE_HINTS = ['nirvana-cache', 'nirvana'];
const _NIRVANA_PATH_REGEX = /nirvana/i;

/**
 * 把 token 归类为 'local' | 'pool' | 'nirvana'，复用各 readXToken() 已写入的
 * source / path 字段。
 *   - 'pool'    : source 以 'pool:' 开头（toPoolTokenShape 设置）。
 *   - 'nirvana' : source 命中 Nirvana 换号软件标记，或 path 命中 nirvana 路径。
 *   - 'local'   : 其余（IDE 自身原生存储）。
 * @param {object|null} token
 * @returns {'local'|'pool'|'nirvana'}
 */
function classifyTokenSource(token) {
  if (!token || typeof token !== 'object') return 'local';
  const source = String(token.source || '').trim();
  const lowerSource = source.toLowerCase();
  if (lowerSource.startsWith('pool:')) return 'pool';
  if (_NIRVANA_SOURCE_HINTS.includes(lowerSource)) return 'nirvana';
  const tokenPath = String(token.path || '');
  if (tokenPath && _NIRVANA_PATH_REGEX.test(tokenPath)) return 'nirvana';
  return 'local';
}

/**
 * token 是否为「真实本地登录」：凭证形态有效且来源为 IDE 原生存储。
 * @param {object|null} token
 * @returns {boolean}
 */
function isNativeLoginToken(token) {
  if (!token || typeof token !== 'object') return false;
  if (!isLikelyCredentialToken(token.accessToken)) return false;
  return classifyTokenSource(token) === 'local';
}

/**
 * token 是否计入「可用性」。
 *   - 严格默认：仅原生登录 token 计入。
 *   - allowImportedCredentials() 为真时：任何凭证形态的 token 均计入（恢复旧行为）。
 * @param {object|null} token
 * @returns {boolean}
 */
function countsTowardAvailability(token) {
  if (isNativeLoginToken(token)) return true;
  return allowImportedCredentials() && !!(token && isLikelyCredentialToken(token.accessToken));
}

// ─── Model 工具函数（完全相同） ──────────────────────

const MODEL_TOKEN_REGEX = /\b[a-zA-Z0-9][a-zA-Z0-9._:-]{2,80}\b/g;

function normalizeModelId(id) {
  return String(id || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, '');
}

function canonicalModelKey(id) {
  return normalizeModelId(id).toLowerCase();
}

function extractModelIdsFromString(text, isLikelyModelIdFn) {
  const out = new Set();
  const src = String(text || '');
  if (!src) return out;

  if (isLikelyModelIdFn(src)) out.add(normalizeModelId(src));

  const cleaned = src.replace(/[,"'()[\]{}]/g, ' ');
  const regex = new RegExp(MODEL_TOKEN_REGEX.source, 'g');
  let m;
  while ((m = regex.exec(cleaned)) !== null) {
    const token = normalizeModelId(m[0]);
    if (isLikelyModelIdFn(token)) out.add(token);
  }
  return out;
}

function discoverModelsFromSnapshots(snapshots = [], { isLikelyModelIdFn }) {
  const discoveredByKey = new Map();
  const defaultHints = [];

  const addModel = (raw, options = {}) => {
    const normalized = normalizeModelId(raw);
    if (!isLikelyModelIdFn(normalized)) return;
    const key = canonicalModelKey(normalized);
    if (!discoveredByKey.has(key)) discoveredByKey.set(key, normalized);
    if (options.defaultHint) defaultHints.push(normalized);
  };

  const walk = (value, keyHint = '') => {
    if (value == null) return;
    const key = String(keyHint || '').toLowerCase();

    if (typeof value === 'string') {
      for (const id of extractModelIdsFromString(value, isLikelyModelIdFn)) {
        addModel(id, {
          defaultHint: key.includes('default') || key.includes('selected') || key.includes('current') || key.includes('active'),
        });
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item, keyHint);
      return;
    }

    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        const lk = String(k || '').toLowerCase();
        if (isLikelyModelIdFn(k)) addModel(k, { defaultHint: lk.includes('default') || lk.includes('selected') });
        if (typeof v === 'string' && (lk.includes('model') || lk.includes('assistant') || lk.includes('engine'))) {
          addModel(v, {
            defaultHint: lk.includes('default') || lk.includes('selected') || lk.includes('current') || lk.includes('active'),
          });
        }
        walk(v, lk);
      }
    }
  };

  for (const snapshot of snapshots) walk(snapshot.data);
  return {
    discoveredModelIds: [...discoveredByKey.values()],
    defaultModelId: defaultHints[0] || null,
  };
}

function buildModelList(discoveredModelIds = [], defaultModelId = null, options = {}) {
  const { knownModels = [], modelDisplayNameFn, isLikelyModelIdFn, defaultFallbackModelKey = MODELS.ide } = options;
  const seen = new Set();
  const catalog = [];
  const defaultKey = canonicalModelKey(defaultModelId);
  const apiModelKeys = new Set((options.apiModelIds || []).map(canonicalModelKey));
  const localModelKeys = new Set((options.localModelIds || []).map(canonicalModelKey));
  let hasDefault = false;

  const resolveSource = (id, fallback = 'builtin') => {
    const key = canonicalModelKey(id);
    const inApi = apiModelKeys.has(key);
    const inLocal = localModelKeys.has(key);
    if (inApi && inLocal) return 'remote+local';
    if (inApi) return 'remote';
    if (inLocal) return 'local';
    return fallback;
  };

  const addModel = (id, name, isDefault = false, fallbackSource = 'builtin') => {
    const normalized = normalizeModelId(id);
    if (!isLikelyModelIdFn(normalized)) return;
    const key = canonicalModelKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    catalog.push({
      id: normalized,
      name: name || modelDisplayNameFn(normalized),
      isDefault: !!isDefault,
      discoverySource: resolveSource(normalized, fallbackSource),
    });
    if (isDefault) hasDefault = true;
  };

  for (const model of knownModels) {
    const modelKey = canonicalModelKey(model.id);
    addModel(model.id, model.name, defaultKey ? modelKey === defaultKey : !!model.isDefault, 'builtin');
  }

  for (const discoveredId of discoveredModelIds) {
    const discoveredKey = canonicalModelKey(discoveredId);
    addModel(discoveredId, modelDisplayNameFn(discoveredId), defaultKey ? discoveredKey === defaultKey : false, 'local');
  }

  if (!hasDefault && catalog.length > 0) {
    const fallback = catalog.find(m => canonicalModelKey(m.id) === defaultFallbackModelKey) || catalog[0];
    fallback.isDefault = true;
  }

  return catalog;
}

// ─── SSE 解析（从 _sseParser.js 导入，消除模块间重复） ──────────────────────

const { consumeSseText, consumeSseIncremental, flushSseIncremental } = require('./_sseParser');

// ─── 消息与响应提取（完全相同） ──────────────────────

function extractMessageText(payload = {}) {
  if (typeof payload?.choices?.[0]?.message?.content === 'string') return payload.choices[0].message.content;
  if (typeof payload?.choices?.[0]?.delta?.content === 'string') return payload.choices[0].delta.content;
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (typeof payload?.content === 'string') return payload.content;
  return '';
}

function mergeAttempts(...groups) {
  const out = [];
  for (const group of groups) {
    for (const item of (group || [])) {
      if (!item || typeof item !== 'object') continue;
      out.push(item);
    }
  }
  return out;
}

// buildMessages replaced by shared _messageBuilder (Phase 5A)
function buildMessages(prompt, options = {}) {
  const { messages } = resolveMessages(prompt, options, {
    protocol: 'openai',
    attachImages: attachImagesToOpenAIMessages,
  });
  // Filter out system message — callers handle system separately
  return messages.filter(m => m.role !== 'system');
}

// ─── Stream 读取辅助（完全相同） ──────────────────────

async function readWebReadableAsText(stream) {
  if (!stream) return '';
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  }
  if (typeof stream.on === 'function') {
    return await new Promise((resolve, reject) => {
      let out = '';
      stream.on('data', (chunk) => { out += String(chunk); });
      stream.on('end', () => resolve(out));
      stream.on('error', reject);
    });
  }
  return '';
}

async function readWebReadableAsSse(stream, onChunk = null) {
  if (!stream) return '';

  const sseState = { buffer: '' };
  let out = '';
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out += consumeSseIncremental(sseState, decoder.decode(value, { stream: true }), onChunk);
    }
    out += consumeSseIncremental(sseState, decoder.decode(), onChunk);
    out += flushSseIncremental(sseState, onChunk);
    return out;
  }

  if (typeof stream.on === 'function') {
    return await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => { out += consumeSseIncremental(sseState, String(chunk), onChunk); });
      stream.on('end', () => {
        out += flushSseIncremental(sseState, onChunk);
        resolve(out);
      });
      stream.on('error', reject);
    });
  }

  return '';
}

// ─── 参数化的 Token 管理函数（通过 poolType 区分品牌） ──────────────────────

/**
 * 创建参数化的 IDE token 管理 mixin。
 *
 * @param {object} config
 * @param {string} config.poolType - 账户池类型标识 ('trae'|'windsurf')
 * @param {string} config.envPrefix - 环境变量前缀 ('TRAE'|'WINDSURF')
 * @param {function} config.readTokenFn - 读取本地 token 的函数
 * @param {function} config.normalizeEndpointBaseFn - 标准化 endpoint 的函数
 * @returns {object} { toPoolTokenShape, getPoolActiveToken, persistObservedToken, getTokenCandidates, selectToken, resolveTokenPriority }
 */
function createTokenManager(config) {
  const { poolType, envPrefix, readTokenFn, normalizeEndpointBaseFn } = config;

  // 闭包状态由外部适配器管理，通过 getToken/setToken 访问
  let _tokenRef = { current: null };

  function setTokenRef(ref) { _tokenRef = ref; }

  function toPoolTokenShape(poolToken = null) {
    if (!poolToken || !isLikelyCredentialToken(poolToken.accessToken)) return null;
    const auth = poolToken.authData && typeof poolToken.authData === 'object' ? poolToken.authData : {};
    const endpoint = normalizeEndpointBaseFn(
      auth.endpoint
      || auth.host
      || auth.baseUrl
      || auth.baseURL
      || auth.callback?.host
    );
    return {
      accessToken: normalizeToken(poolToken.accessToken),
      refreshToken: poolToken.refreshToken ? String(poolToken.refreshToken).trim() : null,
      source: `pool:${poolToken.label || poolType}`,
      path: poolToken.sourcePath || '',
      expiresAt: poolToken.expiresAt || auth.expiresAt || null,
      endpoint,
      sdkEndpoint: auth.sdkEndpoint || auth.socketEndpoint || null,
    };
  }

  async function getPoolActiveToken() {
    try {
      const pool = require('../../accountPool');
      await pool.init();
      const token = await pool.getActiveToken(poolType);
      return toPoolTokenShape(token);
    } catch {
      return null;
    }
  }

  function persistObservedToken(token = null) {
    if (!token || !isLikelyCredentialToken(token.accessToken)) return;
    Promise.resolve().then(async () => {
      try {
        const pool = require('../../accountPool');
        await pool.init();
        await pool.saveObservedToken(poolType, {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken || null,
          sourcePath: token.path || '',
          label: token.source ? `${poolType}:${token.source}` : poolType,
          authData: {
            source: token.source || poolType,
            path: token.path || '',
            endpoint: token.endpoint || null,
            sdkEndpoint: token.sdkEndpoint || null,
            expiresAt: token.expiresAt || null,
          },
        }, { activateIfNone: true });
      } catch { /* best effort */ }
    });
  }

  function resolveTokenPriority() {
    const raw = String(process.env[`${envPrefix}_TOKEN_PRIORITY`] || 'pool-first').trim().toLowerCase();
    if (raw === 'local-first' || raw === 'local_first' || raw === 'local') return 'local-first';
    return 'pool-first';
  }

  async function getTokenCandidates() {
    const localToken = readTokenFn();
    const poolToken = await getPoolActiveToken();
    const currentToken = (_tokenRef.current && _tokenRef.current.accessToken) ? _tokenRef.current : null;

    if (localToken && localToken.accessToken) {
      persistObservedToken(localToken);
    }

    const ordered = resolveTokenPriority() === 'local-first'
      ? [localToken, poolToken, currentToken]
      : [poolToken, localToken, currentToken];
    return dedupeTokens(ordered);
  }

  async function selectToken({ allowExpired = false } = {}) {
    const candidates = await getTokenCandidates();
    if (candidates.length === 0) {
      return { token: null, fallback: null, candidates: [] };
    }

    const nonExpired = candidates.filter(t => !isTokenExpired(t));
    const token = nonExpired[0] || (allowExpired ? candidates[0] : null);
    if (!token) {
      return { token: null, fallback: null, candidates };
    }

    const fallback = nonExpired.find(t => t.accessToken !== token.accessToken) || null;
    return { token, fallback, candidates };
  }

  return {
    setTokenRef,
    toPoolTokenShape,
    getPoolActiveToken,
    persistObservedToken,
    resolveTokenPriority,
    getTokenCandidates,
    selectToken,
  };
}

// ─── 导出 ──────────────────────

module.exports = {
  // 纯工具函数（无状态）
  normalizeToken,
  isLikelyCredentialToken,
  isTokenExpired,
  dedupeTokens,
  // 可用性严格判定（单一真源）
  allowImportedCredentials,
  classifyTokenSource,
  isNativeLoginToken,
  countsTowardAvailability,
  normalizeModelId,
  canonicalModelKey,
  extractModelIdsFromString,
  discoverModelsFromSnapshots,
  buildModelList,
  consumeSseText,
  consumeSseIncremental,
  flushSseIncremental,
  extractMessageText,
  mergeAttempts,
  buildMessages,
  readWebReadableAsText,
  readWebReadableAsSse,
  MODEL_TOKEN_REGEX,

  // 工厂函数（有状态）
  createTokenManager,
};
