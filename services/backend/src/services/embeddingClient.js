'use strict';

/**
 * embeddingClient.js — embedding 能力的单一真源（SSOT）。
 *
 * 立法背景（记忆 RAG 铁律 F2）：**禁止任何业务模块直连供应商 embedding API**。
 * 在此之前 `memoryEngine/vectorRecall.js` 自己 `http.request` 打端点，且比
 * `learningRetrieval.js` 的端点解析更弱（没有 Ollama 默认回退、没有网关回退）；
 * 两处各写一份 embedding 客户端本身就是双真源。本模块把这件事收成一处：
 *
 *   端点优先级（与 learningRetrieval._embedEndpoints() 同序，本模块为其上位真源）：
 *     1. env 显式端点  KHY_LEARN_EMBED_URL  —— 用户/云端可配（含 openai 兼容形态）
 *     2. 本地 Ollama    ${OLLAMA_HOST}/api/embeddings —— **本地优先**（F2 明文要求）
 *     3. aiGateway      ${gatewayBase}/v1/embeddings + Bearer —— 走既有网关适配器体系
 *
 * 与旧实现的三处实质差异：
 *   - **模型级可用性检测**：旧的 `learningRetrieval.isEmbeddingReachable()` 只 GET 探
 *     主机根路径、任何 status > 0 都算可达。于是「Ollama 在跑但没 pull 过 embedding
 *     模型」会被误报为可用，随后每一次 embed 都 404。本模块对 ollama 端点改查
 *     `/api/tags` 里**模型名是否真的存在**（容忍 `:latest` 等 tag 后缀）。
 *   - **端点逐个回退**：某端点返回不可用形状时继续试下一个，而不是只认第一个。
 *   - **可用性带 TTL 缓存**：避免每回合对话都去探活（对齐 cli/handlers/learn.js 的 60s 缓存纪律）。
 *
 * 纪律：全部超时/上限/开关走 env（零硬编码，主机与模型名均取 constants SSOT）；
 * 任何失败一律返回 null / {available:false}，绝不抛出——记忆功能永不因 embedding
 * 故障而中断（铁律 F4）。
 *
 * @module services/embeddingClient
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const { PRIMARY: MODELS } = require('../constants/models');

// ── env 读取（带边界） ───────────────────────────────────────────────

function _envStr(name, def) {
  const v = process.env[name];
  return v == null || String(v).trim() === '' ? def : String(v).trim();
}

function _envInt(name, def, min, max) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) {
    return def;
  }
  let r = n;
  if (typeof min === 'number') {
    r = Math.max(min, r);
  }
  if (typeof max === 'number') {
    r = Math.min(max, r);
  }
  return r;
}

/**
 * embedding 模型名。KHY_MEMORY_EMBED_MODEL 优先（记忆专用覆盖），
 * 其次 KHY_LEARN_EMBED_MODEL（与 /learn 共用一个模型时不必配两遍），
 * 兜底取 constants/models 的 PRIMARY.embedding —— 模型名的唯一真源。
 */
function embedModel() {
  return _envStr('KHY_MEMORY_EMBED_MODEL', '') || _envStr('KHY_LEARN_EMBED_MODEL', '') || String(MODELS.embedding || '');
}

/** 单次 embedding 请求超时。 */
function _timeoutMs() {
  return _envInt('KHY_LEARN_EMBED_TIMEOUT_MS', 4000, 500, 60000);
}

/** 一次调用最多嵌入多少条文本（超出的由调用方分批）。 */
function maxTexts() {
  return _envInt('KHY_LEARN_EMBED_MAX_TEXTS', 16, 2, 256);
}

/** 可用性探测超时（比 embed 本身短，探活不该拖慢对话）。 */
function _probeTimeoutMs() {
  return _envInt('KHY_LEARN_PROBE_TIMEOUT_MS', 1200, 200, 30000);
}

/** 可用性缓存有效期。 */
function _availabilityTtlMs() {
  return _envInt('KHY_EMBED_AVAILABILITY_TTL_MS', 60000, 0, 3600000);
}

// ── 端点解析（与 learningRetrieval 同序，本模块为上位真源） ──────────

function _gatewayBase() {
  const url = _envStr('KHY_GATEWAY_URL', '');
  if (url) {
    return url.replace(/\/+$/, '');
  }
  const host = _envStr('PROXY_HOST', '127.0.0.1');
  const port = _envStr('PROXY_PORT', '9100');
  return `http://${host}:${port}`;
}

function _gatewayToken() {
  const t = _envStr('PROXY_AUTH_TOKEN', '');
  if (t) {
    return t;
  }
  try {
    let p;
    try {
      p = path.join(require('../utils/dataHome').getDataHome(), 'proxy_server_auth.json');
    } catch {
      p = path.join(os.homedir(), '.khy', 'proxy_server_auth.json');
    }
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return j && j.authToken ? String(j.authToken) : '';
  } catch {
    return '';
  }
}

function _ollamaHost() {
  // 先读活 env（运行期改 OLLAMA_HOST 立即生效），再回落 constants/serviceDefaults
  // —— 主机字面量的唯一真源，本模块绝不硬编码 host:port。
  let h = _envStr('OLLAMA_HOST', '');
  if (!h) {
    try {
      h = require('../constants/serviceDefaults').OLLAMA_HOST || '';
    } catch {
      /* ignore */
    }
  }
  return String(h || '').replace(/\/+$/, '');
}

/**
 * 有序的 embedding 端点候选。
 * style 'ollama' → /api/embeddings（单条 prompt）；style 'openai' → /v1/embeddings（input 数组）。
 *
 * @param {object} [opts]
 * @param {string} [opts.envUrl] - 覆盖 KHY_LEARN_EMBED_URL 的活读。给那些在模块加载期
 *   就把端点快照下来的调用方（`learningRetrieval` 的 env 语义由它自己的测试钉住）留的口子；
 *   记忆侧不传，走活读。
 * @returns {Array<{kind:string,url:string,style:string,headers:object}>}
 */
function embedEndpoints(opts = {}) {
  const list = [];
  const envUrl = opts.envUrl == null ? _envStr('KHY_LEARN_EMBED_URL', '') : String(opts.envUrl).trim();
  if (envUrl) {
    const style = /\/api\/embed/.test(envUrl) ? 'ollama' : 'openai';
    list.push({ kind: 'env', url: envUrl, style, headers: {} });
  }
  const ollama = _ollamaHost();
  if (ollama) {
    list.push({ kind: 'ollama', url: `${ollama}/api/embeddings`, style: 'ollama', headers: {} });
  }
  const token = _gatewayToken();
  list.push({
    kind: 'gateway',
    url: `${_gatewayBase()}/v1/embeddings`,
    style: 'openai',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return list;
}

// ── HTTP（最小实现，全部 fail-soft，绝不抛出） ────────────────────────

function _mod(urlStr) {
  return String(urlStr).startsWith('https:') ? https : http;
}

function _httpGet(urlStr, timeoutMs, headers) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let req;
    try {
      req = _mod(urlStr).request(urlStr, { method: 'GET', headers: headers || {} }, (res) => {
        const bufs = [];
        res.on('data', (d) => bufs.push(d));
        res.on('end', () => finish({ status: res.statusCode || 0, body: Buffer.concat(bufs) }));
      });
    } catch {
      return finish(null);
    }
    req.on('error', () => finish(null));
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy();
      } catch {
        /* already gone */
      }
      finish(null);
    });
    req.end();
  });
}

function _httpPostJson(urlStr, obj, timeoutMs, headers) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let req;
    let payload;
    try {
      payload = Buffer.from(JSON.stringify(obj), 'utf-8');
      const h = Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        headers || {}
      );
      req = _mod(urlStr).request(urlStr, { method: 'POST', headers: h }, (res) => {
        const bufs = [];
        res.on('data', (d) => bufs.push(d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(bufs).toString('utf-8'));
          } catch {
            json = null;
          }
          finish({ status: res.statusCode || 0, json });
        });
      });
    } catch {
      return finish(null);
    }
    req.on('error', () => finish(null));
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy();
      } catch {
        /* already gone */
      }
      finish(null);
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// ── 模型级可用性检测 ────────────────────────────────────────────────

/**
 * Ollama 的模型名比对：`nomic-embed-text` 应当匹配已装的 `nomic-embed-text:latest`。
 * 双向前缀容忍 tag 后缀，不做模糊匹配（避免把 `x-embed` 当成 `x`）。
 */
function _modelNameMatches(installed, wanted) {
  const a = String(installed || '')
    .trim()
    .toLowerCase();
  const b = String(wanted || '')
    .trim()
    .toLowerCase();
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const stripTag = (s) => s.replace(/:[^:]*$/, '');
  return stripTag(a) === stripTag(b) || stripTag(a) === b || a === stripTag(b);
}

/**
 * 探一个端点是否真的能用。
 *
 * ollama 端点：查 `/api/tags`，要求目标模型**确实已安装**（这正是旧
 * `isEmbeddingReachable()` 漏掉的一步：主机可达 ≠ 模型可用）。
 * openai 端点（env/gateway）：没有标准的模型清单接口，只能探主机根路径可达性；
 * 真正的可用性由后续 embed 调用的形状校验兜底 —— 失败即回退下一个端点。
 *
 * @returns {Promise<boolean>}
 */
async function _probeEndpoint(ep, model) {
  const timeout = _probeTimeoutMs();
  try {
    if (ep.style === 'ollama') {
      const base = ep.url.replace(/\/api\/embed(dings)?\/?$/, '');
      const r = await _httpGet(`${base}/api/tags`, timeout, ep.headers);
      if (!r || r.status !== 200) {
        return false;
      }
      let json = null;
      try {
        json = JSON.parse(r.body.toString('utf-8'));
      } catch {
        return false;
      }
      const models = json && Array.isArray(json.models) ? json.models : [];
      return models.some((m) => _modelNameMatches(m && m.name, model));
    }
    // openai 兼容形态：只能探主机可达（任何应答都说明有服务在听）。
    const u = new URL(ep.url);
    const r = await _httpGet(`${u.protocol}//${u.host}/`, timeout, ep.headers);
    return !!(r && r.status > 0);
  } catch {
    return false;
  }
}

// 可用性缓存。按「模型 + 端点 URL 序列」分桶 —— /learn 与记忆侧可能解析出不同的
// 端点列表（前者允许注入 envUrl 快照），一个全局单值会让两边互相污染判定。
const _availCache = new Map();
const _AVAIL_CACHE_MAX = 8;

/**
 * embedding 是否可用（带 TTL 缓存）。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]  - 忽略缓存重新探测
 * @param {string} [opts.envUrl]  - 覆盖 KHY_LEARN_EMBED_URL（见 embedEndpoints）
 * @returns {Promise<{available:boolean, endpoint:string|null, model:string, reason:string}>}
 */
async function isAvailable(opts = {}) {
  const model = embedModel();
  const ttl = _availabilityTtlMs();
  const now = Date.now();
  const eps = model ? embedEndpoints(opts) : [];
  const key = `${model}|${eps.map((e) => e.url).join(',')}`;

  if (!opts.force && ttl > 0) {
    const hit = _availCache.get(key);
    if (hit && now - hit.at < ttl) {
      return hit.value;
    }
  }

  let out = { available: false, endpoint: null, model, reason: 'no-endpoint' };
  if (!model) {
    out = { available: false, endpoint: null, model: '', reason: 'no-model-configured' };
  } else {
    for (const ep of eps) {
      if (await _probeEndpoint(ep, model)) {
        out = { available: true, endpoint: ep.kind, model, reason: 'ok' };
        break;
      }
    }
    if (!out.available && eps.length > 0) {
      out = { available: false, endpoint: null, model, reason: 'unreachable-or-model-missing' };
    }
  }

  if (_availCache.size >= _AVAIL_CACHE_MAX) {
    _availCache.clear(); // 有界：桶数极少，满了整体作废比 LRU 记账划算
  }
  _availCache.set(key, { at: now, value: out });
  return out;
}

// ── 嵌入 ────────────────────────────────────────────────────────────

/** 从一个 openai 兼容应答里取出对齐的向量数组，形状不符返回 null。 */
function _parseOpenAiVectors(json, expected) {
  const data = json && Array.isArray(json.data) ? json.data : null;
  if (!data || data.length !== expected) {
    return null;
  }
  if (!data.every((d) => d && Array.isArray(d.embedding) && d.embedding.length > 0)) {
    return null;
  }
  // 有些实现不保证顺序，但会带 index —— 带了就按它排，没带就按原序。
  if (data.every((d) => Number.isInteger(d.index))) {
    const sorted = [...data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
  return data.map((d) => d.embedding);
}

async function _embedViaEndpoint(ep, texts) {
  const model = embedModel();
  const timeout = _timeoutMs();

  if (ep.style === 'openai') {
    const r = await _httpPostJson(ep.url, { model, input: texts }, timeout, ep.headers);
    return _parseOpenAiVectors(r && r.json, texts.length);
  }

  // ollama：一次一条 prompt。任一条失败即整批作废（宁可回退下一个端点，
  // 也不返回部分向量——部分向量会让余弦比较悄悄失真）。
  const vecs = [];
  for (const t of texts) {
    const r = await _httpPostJson(ep.url, { model, prompt: t }, timeout, ep.headers);
    const emb = r && r.json && Array.isArray(r.json.embedding) ? r.json.embedding : null;
    if (!emb || emb.length === 0) {
      return null;
    }
    vecs.push(emb);
  }
  return vecs.length === texts.length ? vecs : null;
}

/**
 * 嵌入一批文本。按端点优先级逐个尝试，第一个返回**形状正确**结果的端点胜出。
 *
 * @param {string[]} texts
 * @param {object} [opts]
 * @param {string} [opts.envUrl] - 覆盖 KHY_LEARN_EMBED_URL（见 embedEndpoints）
 * @returns {Promise<number[][]|null>} 与 texts 对齐的向量数组；全部端点失败返回 null
 */
async function embedTexts(texts, opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return null;
  }
  if (!embedModel()) {
    return null;
  }
  const slice = texts.slice(0, maxTexts()).map((t) => String(t == null ? '' : t));
  if (slice.some((t) => t.trim() === '')) {
    // 空文本在多数后端会报错或返回零向量，零向量的余弦恒为 0 —— 直接判无效，
    // 让调用方走降级，而不是拿一批含零向量的结果去排序。
    return null;
  }

  for (const ep of embedEndpoints(opts)) {
    try {
      const vecs = await _embedViaEndpoint(ep, slice);
      if (vecs && vecs.length === slice.length) {
        return vecs;
      }
    } catch {
      /* 试下一个端点 */
    }
  }
  return null;
}

/**
 * 嵌入单条文本。
 *
 * @param {string} text
 * @param {object} [opts] - 同 embedTexts
 * @returns {Promise<number[]|null>}
 */
async function embedText(text, opts = {}) {
  if (!text || !String(text).trim()) {
    return null;
  }
  const r = await embedTexts([String(text)], opts);
  return r && r.length > 0 ? r[0] : null;
}

/** 余弦相似度。长度不等/零向量一律返回 0（不抛）。 */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 清空可用性缓存（测试与「刚 pull 完模型」场景用）。 */
function _resetCache() {
  _availCache.clear();
}

module.exports = {
  embedModel,
  maxTexts,
  embedEndpoints,
  isAvailable,
  embedTexts,
  embedText,
  cosine,
  _resetCache,
  _internals: { _modelNameMatches, _probeEndpoint, _parseOpenAiVectors, _ollamaHost, _gatewayBase },
  // Extended providers
  listExtendedProviders: () => [
    { id: 'openai', name: 'OpenAI Embedding' },
    { id: 'voyage', name: 'Voyage AI' },
    { id: 'jina', name: 'Jina AI' },
    { id: 'cohere', name: 'Cohere' },
  ],
};
