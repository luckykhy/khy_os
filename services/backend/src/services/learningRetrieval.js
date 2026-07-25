'use strict';

/**
 * learningRetrieval.js — KHY-OS 学习知识检索层（/learn 三种学习方式共用的「闭环」核心）。
 *
 * 用户要求 `/learn` 三种方式都能学到 KHY-OS 自有知识、形成闭环：
 *   模式1 本地无网络无模型 / 模式2 有网络无模型 / 模式3 有网络有模型（提高 RAG 召回）。
 *
 * 本模块把「KHY-OS 知识库」抽成统一检索层：
 *   - 语料 = curriculum 知识点(title/desc/files) + 本地文档(kernel/docs、docs/指南、README、AGENTS)
 *     + topic 源码头部，全部切成有界 chunk。
 *   - 词法检索：始终可用、离线可跑（复用 knowledgeTeachingService 的中性 CJK/ASCII 分词，
 *     叠加 OS/内核领域同义词扩展 + 知识点标题/文件名扩展 → 提高召回）。
 *   - 向量重排（混合）：embedding 端点可达时对词法候选 + 查询求 embedding 按余弦重排，
 *     不可达则纯词法兜底。这是模式3「提高召回率」的增量。
 *   - 网络补取（模式2）：本地缺失的 topic 源码可从配置的远端 raw base 拉取缓存后并入语料。
 *
 * 全部超时/上限/开关走环境变量，bounded、失败 try/catch 静默降级，绝不破坏学习流（与内核
 * 「外设永不 wedge」同纪律）。零业务 host 硬编码：所有 url/超时/topK 走 env，localhost
 * 默认端点（ollama 11434 / 网关 9100）均可被 env 覆盖。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

const curriculum = require('./learningCurriculum');
// Model-name SSOT: embedding model default flows from constants/models.js
// (env KHY_LEARN_EMBED_MODEL still overrides first).
const { PRIMARY: MODELS } = require('../constants/models');

// ── env 配置（带边界） ───────────────────────────────────────────────
function _envStr(name, def) {
  const v = process.env[name];
  return v == null || String(v).trim() === '' ? def : String(v).trim();
}
function _envInt(name, def, min, max) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return def;
  let r = n;
  if (typeof min === 'number') r = Math.max(min, r);
  if (typeof max === 'number') r = Math.min(max, r);
  return r;
}
function _envBool(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

const RAG_ENABLED = _envBool('KHY_LEARN_RAG', true);
const TOPK = _envInt('KHY_LEARN_TOPK', 6, 1, 30);
const MAX_CHUNK_CHARS = _envInt('KHY_LEARN_MAX_CHUNK_CHARS', 600, 120, 4000);
const MAX_CONTEXT_CHARS = _envInt('KHY_LEARN_MAX_CONTEXT_CHARS', 2400, 400, 20000);
const LEXICAL_CANDIDATES = _envInt('KHY_LEARN_LEXICAL_CANDIDATES', 24, TOPK, 120);
const MAX_DOC_FILES = _envInt('KHY_LEARN_MAX_DOC_FILES', 80, 4, 600);
const MAX_CHUNKS_PER_DOC = _envInt('KHY_LEARN_MAX_CHUNKS_PER_DOC', 24, 1, 200);
const MAX_TOTAL_CHUNKS = _envInt('KHY_LEARN_MAX_TOTAL_CHUNKS', 4000, 50, 50000);

const PROBE_TIMEOUT_MS = _envInt('KHY_LEARN_PROBE_TIMEOUT_MS', 1200, 200, 15000);
const FETCH_TIMEOUT_MS = _envInt('KHY_LEARN_FETCH_TIMEOUT_MS', 4000, 500, 60000);
const EMBED_TIMEOUT_MS = _envInt('KHY_LEARN_EMBED_TIMEOUT_MS', 4000, 500, 60000);
const EMBED_MAX_TEXTS = _envInt('KHY_LEARN_EMBED_MAX_TEXTS', 16, 2, 64);

const DOCS_BASE_URL = _envStr('KHY_LEARN_DOCS_BASE_URL', '');
const EMBED_URL = _envStr('KHY_LEARN_EMBED_URL', '');
const EMBED_MODEL = _envStr('KHY_LEARN_EMBED_MODEL', MODELS.embedding);

const CACHE_DIR = path.join(os.homedir(), '.khyquant', 'learn-cache');

// ── 分词（复用领域中性的 CJK/ASCII 分词叶子模块） ──────────────────────
// 历史上本模块借用 knowledge 教学服务导出的 tokenizeForSearch，那条「低层课程检索
// → 高层量化教学服务」的依赖边把本模块（连同 guideRetriever / guideInjector）拽进了
// 巨型 SCC。分词器现已下沉为零依赖叶子 searchTokenizer，两侧共同依赖叶子（依赖倒置），
// SCC 因此 82→79（[DESIGN-ARCH-051] §六.2）。
let _tokenize;
try {
  const st = require('./searchTokenizer');
  if (typeof st.tokenizeForSearch === 'function') _tokenize = st.tokenizeForSearch;
} catch { /* tokenizer leaf unavailable — use local fallback below */ }
if (!_tokenize) {
  // Same technique as knowledgeTeachingService._searchTokenize: CJK runs → single
  // chars + bigrams, ASCII runs → whole token. Kept as a fallback only.
  _tokenize = function (text) {
    if (!text) return [];
    const lower = String(text).toLowerCase();
    const parts = lower.match(/[一-鿿]+|[a-z0-9_]+/g) || [];
    const out = [];
    for (const p of parts) {
      if (/[一-鿿]/.test(p)) {
        for (let i = 0; i < p.length; i++) {
          out.push(p[i]);
          if (i + 1 < p.length) out.push(p.slice(i, i + 2));
        }
      } else {
        out.push(p);
      }
    }
    return Array.from(new Set(out));
  };
}

// OS/内核领域同义词（量化版同义词表不适用，这里维护本课程自己的一份）。键和值都用
// 分词后的形态参与扩展，桥接「中文概念 ⇄ 英文标识符 ⇄ 代码符号」以提高召回。
const _OS_SYNONYMS = {
  '内核': ['kernel'], 'kernel': ['内核', 'os'],
  '决策': ['decision', '裁决', 'allow', 'deny', 'ask', 'agentask'],
  '裁决': ['decision', '决策'],
  '调度': ['sched', 'scheduler', 'schedule', '抢占', 'preempt'],
  '抢占': ['preempt', 'sched', '调度'],
  '中断': ['interrupt', 'idt', 'isr', 'irq'],
  '内存': ['memory', 'pmm', 'vmm', 'heap', 'kheap', 'paging', '分页'],
  '分页': ['paging', 'vmm', '内存'],
  '进程': ['process', 'task', 'fork', 'pid'],
  '系统调用': ['syscall'], 'syscall': ['系统调用', 'sys'],
  '串口': ['serial', 'com2', 'com1', 'uart'],
  '帧': ['frame', 'cobs', 'crc16', 'agentframe'],
  '事件': ['event', 'spawn', 'exit', 'fault', 'agentevent'],
  '配置': ['config', 'agentconf', 'conf'],
  '桥': ['bridge', 'host', 'khybridge'],
  '控制': ['control', 'agentctl', 'ctl'],
  '文件系统': ['vfs', 'diskfs', 'ramfs', 'fs', '持久化', 'persist'],
  '持久化': ['persist', 'diskfs', '文件系统'],
  '引导': ['boot', 'bootloader', 'grub'],
  '协同': ['agent', 'collaborate', 'pivot'],
  'agent': ['智能体', '代理', 'mcp'],
  'mcp': ['agent', 'jsonrpc'],
  '网关': ['gateway', 'brain'],
};

function _expandTokens(tokens) {
  const set = new Set(tokens);
  for (const t of tokens) {
    const syn = _OS_SYNONYMS[t];
    if (syn) for (const s of syn) for (const st of _tokenize(s)) set.add(st);
  }
  return Array.from(set);
}

// ── 语料构建 ─────────────────────────────────────────────────────────
// 收敛到 utils/collapseWhitespace 单一真源(逐字节委托,调用点不变)
const _norm = require('../utils/collapseWhitespace');
function _clip(s, n) { const t = String(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

function _makeChunk(source, title, text) {
  const body = _clip(_norm(text), MAX_CHUNK_CHARS);
  if (!body) return null;
  const tokenSrc = `${title || ''} ${body}`;
  const tokenSet = new Set(_tokenize(tokenSrc));
  const titleTokens = new Set(_tokenize(title || ''));
  return { source, title: _norm(title), text: body, tokenSet, titleTokens };
}

function _curriculumChunks() {
  const chunks = [];
  let layers = [];
  try { layers = curriculum.getAllLayers() || []; } catch { layers = []; }
  for (const layer of layers) {
    const c = _makeChunk(`curriculum:${layer.id}`, `第${layer.id}层 ${layer.title}`, layer.summary || '');
    if (c) chunks.push(c);
    for (const topic of (layer.topics || [])) {
      const fileNames = (topic.files || []).map(f => path.basename(String(f))).join(' ');
      const text = `${layer.title} / ${topic.title}。${topic.desc || ''}${fileNames ? `。相关源码: ${fileNames}` : ''}`;
      const c2 = _makeChunk(`curriculum:${layer.id}.${topic.id}`, topic.title, text);
      if (c2) chunks.push(c2);
    }
  }
  return chunks;
}

// Split a markdown document into heading-bounded, length-bounded chunks.
function _chunkMarkdown(sourceLabel, content) {
  const lines = String(content).split('\n');
  const out = [];
  let heading = '';
  let buf = [];
  const flush = () => {
    const text = buf.join('\n');
    if (_norm(text)) {
      // Further split overly long sections so a single chunk stays bounded.
      const norm = _norm(text);
      for (let i = 0; i < norm.length && out.length < MAX_CHUNKS_PER_DOC; i += MAX_CHUNK_CHARS) {
        const slice = norm.slice(i, i + MAX_CHUNK_CHARS);
        const c = _makeChunk(`doc:${sourceLabel}${heading ? '#' + heading : ''}`, heading, slice);
        if (c) out.push(c);
      }
    }
    buf = [];
  };
  for (const line of lines) {
    const m = /^#{1,4}\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = _norm(m[1]).slice(0, 80);
      if (out.length >= MAX_CHUNKS_PER_DOC) break;
    } else {
      buf.push(line);
    }
  }
  if (out.length < MAX_CHUNKS_PER_DOC) flush();
  return out;
}

function _listMarkdownDocs() {
  // Repo-relative directories + root files worth indexing. resolveSourceAbs
  // applies the curriculum's PROJECT_ROOT walk + old→new remaps (single source).
  const docRoots = ['kernel/docs', 'docs/指南', 'docs'];
  const rootFiles = ['README.md', 'README-EN.md', 'AGENTS.md', 'CLAUDE.md'];
  const found = []; // { label, abs }
  const seen = new Set();
  const push = (label, abs) => {
    if (!abs || seen.has(abs) || found.length >= MAX_DOC_FILES) return;
    seen.add(abs);
    found.push({ label, abs });
  };
  for (const rel of docRoots) {
    const absDir = curriculum.resolveSourceAbs(rel);
    if (!absDir) continue;
    let entries = [];
    try {
      const st = fs.statSync(absDir);
      if (!st.isDirectory()) continue;
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (found.length >= MAX_DOC_FILES) break;
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
      push(`${rel}/${e.name}`, path.join(absDir, e.name));
    }
  }
  for (const rf of rootFiles) {
    const abs = curriculum.resolveSourceAbs(rf);
    if (abs) push(rf, abs);
  }
  return found;
}

function _docChunks() {
  const chunks = [];
  for (const { label, abs } of _listMarkdownDocs()) {
    if (chunks.length >= MAX_TOTAL_CHUNKS) break;
    let content = '';
    try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
    for (const c of _chunkMarkdown(label, content)) {
      chunks.push(c);
      if (chunks.length >= MAX_TOTAL_CHUNKS) break;
    }
  }
  return chunks;
}

function _sourceHeadChunks() {
  // Topic source-file heads — gives lexical anchors on real identifiers.
  const chunks = [];
  const seen = new Set();
  let layers = [];
  try { layers = curriculum.getAllLayers() || []; } catch { layers = []; }
  for (const layer of layers) {
    for (const topic of (layer.topics || [])) {
      for (const f of (topic.files || [])) {
        if (seen.has(f) || chunks.length >= MAX_TOTAL_CHUNKS) continue;
        seen.add(f);
        let preview = null;
        try { preview = curriculum.readFilePreview(f, 24); } catch { preview = null; }
        if (!preview || !preview.lines || preview.lines.length === 0) continue;
        const text = preview.lines.join('\n');
        const c = _makeChunk(`src:${f}`, path.basename(f), text);
        if (c) chunks.push(c);
      }
    }
  }
  return chunks;
}

let _corpusCache = null;
function _buildCorpus() {
  const chunks = [];
  for (const part of [_curriculumChunks(), _docChunks(), _sourceHeadChunks()]) {
    for (const c of part) {
      if (chunks.length >= MAX_TOTAL_CHUNKS) break;
      chunks.push(c);
    }
  }
  return chunks;
}
function _getCorpus() {
  if (!_corpusCache) _corpusCache = _buildCorpus();
  return _corpusCache;
}
function resetCorpusCache() { _corpusCache = null; }

function _chunkFromAbs(absPath, label) {
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    const lower = absPath.toLowerCase();
    if (lower.endsWith('.md')) return _chunkMarkdown(label || path.basename(absPath), content);
    const head = content.split('\n').slice(0, 40).join('\n');
    const c = _makeChunk(`fetched:${label || path.basename(absPath)}`, path.basename(absPath), head);
    return c ? [c] : [];
  } catch { return []; }
}

// ── 词法检索 ─────────────────────────────────────────────────────────
function _scoreChunk(chunk, qtokens, rawQuery) {
  if (qtokens.length === 0) return 0;
  let hit = 0;
  for (const qt of qtokens) {
    if (chunk.tokenSet.has(qt)) {
      hit += 1;
      if (chunk.titleTokens.has(qt)) hit += 0.5;
    }
  }
  let score = hit / qtokens.length;
  // Substring bonus on the raw (normalized) query — rewards exact phrase hits.
  const rq = _norm(rawQuery).toLowerCase();
  if (rq.length >= 3 && chunk.text.toLowerCase().includes(rq)) score += 0.4;
  return score;
}

function lexicalSearch(query, corpus, limit) {
  const base = _tokenize(query);
  const qtokens = _expandTokens(base);
  const scored = [];
  for (const chunk of corpus) {
    const s = _scoreChunk(chunk, qtokens, query);
    if (s > 0) scored.push({ chunk, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── 向量（混合 RAG，可选） ───────────────────────────────────────────
function _gatewayBase() {
  const url = _envStr('KHY_GATEWAY_URL', '');
  if (url) return url.replace(/\/+$/, '');
  const host = _envStr('PROXY_HOST', '127.0.0.1');
  const port = _envStr('PROXY_PORT', '9100');
  return `http://${host}:${port}`;
}
function _gatewayToken() {
  const t = _envStr('PROXY_AUTH_TOKEN', '');
  if (t) return t;
  try {
    const p = path.join(os.homedir(), '.khy', 'proxy_server_auth.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return j && j.authToken ? String(j.authToken) : '';
  } catch { return ''; }
}
function _ollamaHost() {
  // Read the live env first so a runtime OLLAMA_HOST change takes effect, then
  // fall back to the canonical default in constants/serviceDefaults (the single
  // source of truth — never hardcode the host:port literal here).
  let h = _envStr('OLLAMA_HOST', '');
  if (!h) {
    try { h = require('../constants/serviceDefaults').OLLAMA_HOST || ''; } catch { /* ignore */ }
  }
  return String(h || '').replace(/\/+$/, '');
}

// Ordered embedding endpoint candidates. style 'ollama' uses /api/embeddings
// (single prompt); style 'openai' uses /v1/embeddings (input array).
function _embedEndpoints() {
  const list = [];
  if (EMBED_URL) {
    const style = /\/api\/embed/.test(EMBED_URL) ? 'ollama' : 'openai';
    list.push({ kind: 'env', url: EMBED_URL, style, headers: {} });
  }
  list.push({ kind: 'ollama', url: `${_ollamaHost()}/api/embeddings`, style: 'ollama', headers: {} });
  const token = _gatewayToken();
  list.push({
    kind: 'gateway',
    url: `${_gatewayBase()}/v1/embeddings`,
    style: 'openai',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return list;
}

function _requestModule(urlStr) { return urlStr.startsWith('https:') ? https : http; }

function _httpGet(urlStr, timeoutMs, headers) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = _requestModule(urlStr).request(urlStr, { method: 'GET', headers: headers || {} }, (res) => {
        const bufs = [];
        res.on('data', (d) => bufs.push(d));
        res.on('end', () => finish({ status: res.statusCode || 0, body: Buffer.concat(bufs) }));
      });
    } catch { return finish(null); }
    req.on('error', () => finish(null));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} finish(null); });
    req.end();
  });
}

function _httpPostJson(urlStr, obj, timeoutMs, headers) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    const payload = Buffer.from(JSON.stringify(obj), 'utf-8');
    const h = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }, headers || {});
    try {
      req = _requestModule(urlStr).request(urlStr, { method: 'POST', headers: h }, (res) => {
        const bufs = [];
        res.on('data', (d) => bufs.push(d));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(bufs).toString('utf-8')); } catch { json = null; }
          finish({ status: res.statusCode || 0, json });
        });
      });
    } catch { return finish(null); }
    req.on('error', () => finish(null));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} finish(null); });
    req.write(payload);
    req.end();
  });
}

async function _probeUrl(urlStr, timeoutMs) {
  // Any HTTP response (even 404) means the host is up → reachable.
  const r = await _httpGet(urlStr, timeoutMs, {});
  return !!(r && r.status > 0);
}

async function isEmbeddingReachable() {
  if (!RAG_ENABLED) return false;
  for (const ep of _embedEndpoints()) {
    try {
      const u = new URL(ep.url);
      const probe = `${u.protocol}//${u.host}/`;
      if (await _probeUrl(probe, PROBE_TIMEOUT_MS)) return true;
    } catch { /* try next */ }
  }
  return false;
}

// Embed an array of texts via the first working endpoint. Returns array of
// vectors aligned to `texts`, or null if no endpoint produced usable vectors.
async function _embedTexts(texts) {
  const slice = texts.slice(0, EMBED_MAX_TEXTS);
  for (const ep of _embedEndpoints()) {
    try {
      if (ep.style === 'openai') {
        const r = await _httpPostJson(ep.url, { model: EMBED_MODEL, input: slice }, EMBED_TIMEOUT_MS, ep.headers);
        const data = r && r.json && Array.isArray(r.json.data) ? r.json.data : null;
        if (data && data.length === slice.length && data.every(d => Array.isArray(d.embedding))) {
          return data.map(d => d.embedding);
        }
      } else {
        // ollama: one prompt per call
        const vecs = [];
        let ok = true;
        for (const t of slice) {
          const r = await _httpPostJson(ep.url, { model: EMBED_MODEL, prompt: t }, EMBED_TIMEOUT_MS, ep.headers);
          const emb = r && r.json && Array.isArray(r.json.embedding) ? r.json.embedding : null;
          if (!emb) { ok = false; break; }
          vecs.push(emb);
        }
        if (ok && vecs.length === slice.length) return vecs;
      }
    } catch { /* try next endpoint */ }
  }
  return null;
}

function _cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── 网络补取（模式2） ────────────────────────────────────────────────
function _resolveDocsBase() {
  if (DOCS_BASE_URL) return DOCS_BASE_URL.replace(/\/+$/, '') + '/';
  // Best-effort derive a raw base from the `github` remote, but only when the
  // user opts in (KHY_LEARN_DOCS_DERIVE) — the repo's default `github` remote is
  // a placeholder, so deriving from it by default would mislabel mode 2 and
  // point fetches at a nonexistent repo. Explicit KHY_LEARN_DOCS_BASE_URL is the
  // honest default path ("待用户设远端"). Degrades to null on any failure.
  if (!_envBool('KHY_LEARN_DOCS_DERIVE', false)) return null;
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.github.url'], {
      timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    const m = /github\.com[:/]+([^/]+)\/([^/.]+)(?:\.git)?/.exec(url);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/main/`;
  } catch { /* no git / no remote */ }
  return null;
}

async function isDocsRemoteReachable() {
  if (!RAG_ENABLED) return false;
  const base = _resolveDocsBase();
  if (!base) return false;
  try {
    const u = new URL(base);
    return await _probeUrl(`${u.protocol}//${u.host}/`, PROBE_TIMEOUT_MS);
  } catch { return false; }
}

// Fetch a topic's locally-missing source/doc files from the configured remote
// into the learn cache. Returns [{ file, abs }] for files actually fetched.
async function fetchMissingForTopic(topic) {
  if (!RAG_ENABLED || !topic || !Array.isArray(topic.files)) return [];
  const base = _resolveDocsBase();
  if (!base) return [];
  const fetched = [];
  for (const file of topic.files) {
    let localAbs = null;
    try { localAbs = curriculum.resolveSourceAbs(file); } catch { localAbs = null; }
    if (localAbs) continue; // present locally — nothing to fetch
    const url = base + String(file).replace(/^\/+/, '');
    let res = null;
    try { res = await _httpGet(url, FETCH_TIMEOUT_MS, {}); } catch { res = null; }
    if (!res || res.status < 200 || res.status >= 300 || !res.body || res.body.length === 0) continue;
    const dest = path.join(CACHE_DIR, String(file));
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, res.body);
      fetched.push({ file, abs: dest });
    } catch { /* cache write failed — skip */ }
  }
  return fetched;
}

// ── 公开 API ─────────────────────────────────────────────────────────
/**
 * Build a grounded retrieval context for a learning query.
 * @param {string} query
 * @param {object} [opts] { topK, allowVector, extraPaths:[absPath], topic }
 * @returns {Promise<{chunks, text, usedVector, fetched}>}
 *   - chunks: [{ source, title, text, score }]
 *   - text:   plain (no-ANSI) joined top-K block, capped at MAX_CONTEXT_CHARS
 *   - usedVector: whether vector rerank actually ran
 */
async function buildContext(query, opts = {}) {
  const empty = { chunks: [], text: '', usedVector: false, fetched: [] };
  if (!RAG_ENABLED || !_norm(query)) return empty;
  const topK = typeof opts.topK === 'number' ? Math.max(1, Math.min(30, opts.topK)) : TOPK;

  let corpus;
  try { corpus = _getCorpus().slice(); } catch { return empty; }

  // Merge any caller-provided extra files (e.g. mode-2 fetched cache paths).
  if (Array.isArray(opts.extraPaths)) {
    for (const ab of opts.extraPaths) {
      for (const c of _chunkFromAbs(ab)) corpus.push(c);
    }
  }
  if (corpus.length === 0) return empty;

  // Stage 1: lexical (always). This is the recall floor — works fully offline.
  const lexical = lexicalSearch(query, corpus, LEXICAL_CANDIDATES);
  if (lexical.length === 0) return Object.assign({}, empty);

  let ranked = lexical;
  let usedVector = false;

  // Stage 2: optional vector rerank over the lexical candidates (hybrid). Recall
  // stays lexical (no candidate is dropped here); vector only reorders for
  // precision. Any failure → keep lexical order.
  if (opts.allowVector) {
    try {
      const texts = [query, ...lexical.map(x => x.chunk.text)];
      const vecs = await _embedTexts(texts);
      if (vecs && vecs.length === Math.min(texts.length, EMBED_MAX_TEXTS) && vecs.length >= 2) {
        const qv = vecs[0];
        const maxLex = Math.max(...lexical.map(x => x.score)) || 1;
        const blended = lexical.slice(0, vecs.length - 1).map((x, i) => {
          const cos = _cosine(qv, vecs[i + 1]);
          const lexNorm = x.score / maxLex;
          return { chunk: x.chunk, score: 0.4 * lexNorm + 0.6 * cos };
        });
        // Candidates beyond the embedding cap keep their lexical score (scaled
        // below the blended band) so nothing silently disappears.
        const tail = lexical.slice(vecs.length - 1).map(x => ({ chunk: x.chunk, score: (x.score / maxLex) * 0.4 }));
        blended.push(...tail);
        blended.sort((a, b) => b.score - a.score);
        ranked = blended;
        usedVector = true;
      }
    } catch { /* keep lexical ranking */ }
  }

  const top = ranked.slice(0, topK);
  const chunks = top.map(x => ({ source: x.chunk.source, title: x.chunk.title, text: x.chunk.text, score: Number(x.score.toFixed(4)) }));

  // Plain text block for prompt injection, capped overall.
  const parts = [];
  let used = 0;
  for (const c of chunks) {
    const piece = `[${c.source}] ${c.text}`;
    if (used + piece.length > MAX_CONTEXT_CHARS && parts.length > 0) break;
    parts.push(piece);
    used += piece.length;
  }
  return { chunks, text: parts.join('\n\n'), usedVector, fetched: [] };
}

// Terminal-colored rendering of a buildContext result, for the offline modes
// (1 & 2). Lazy-require chalk so headless callers (tests) don't depend on TTY.
function formatSection(ctx) {
  if (!ctx || !Array.isArray(ctx.chunks) || ctx.chunks.length === 0) return '';
  let chalk;
  try { chalk = require('chalk'); } catch { chalk = null; }
  const dim = chalk ? (s) => chalk.gray(s) : (s) => s;
  const cyan = chalk ? (s) => chalk.cyan(s) : (s) => s;
  const lines = [];
  lines.push('');
  lines.push(`  ${cyan('📚 相关代码与文档')} ${dim(ctx.usedVector ? '(混合检索·词法+向量)' : '(词法检索)')}`);
  for (const c of ctx.chunks) {
    lines.push(`    ${dim('•')} ${cyan(c.source)}`);
    const text = _clip(c.text, 220);
    lines.push(`      ${dim(text)}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  buildContext,
  formatSection,
  fetchMissingForTopic,
  isEmbeddingReachable,
  isDocsRemoteReachable,
  resetCorpusCache,
  RAG_ENABLED,
  CACHE_DIR,
  // exposed for hermetic tests
  _internals: {
    buildCorpus: _buildCorpus,
    getCorpus: _getCorpus,
    tokenize: _tokenize,
    expandTokens: _expandTokens,
    lexicalSearch,
    cosine: _cosine,
    resolveDocsBase: _resolveDocsBase,
    embedEndpoints: _embedEndpoints,
    chunkMarkdown: _chunkMarkdown,
  },
};
