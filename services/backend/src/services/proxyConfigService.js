/**
 * Proxy Configuration Service — configure HTTP/SOCKS5 proxies for
 * overseas AI APIs and manage VPN/Clash subscription links.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const EventEmitter = require('events');

const proxyEvents = new EventEmitter();

const KHY_DIR = path.join(os.homedir(), '.khyquant');
const PROXY_CONFIG_PATH = path.join(KHY_DIR, 'proxy.json');

// Single source of truth for well-known Clash/proxy default ports.
// `CLASH_PORTS.http` is reused by gateway/_proxyTunnel.js for auto-probing —
// keep the port list defined here only.
const CLASH_PORTS = {
  http: [7890, 7891, 7892, 8080, 8888],
  socks: [7891, 7893, 1080],
  mixed: [7890],
};
const NODE_URI_PREFIXES = [
  'vmess://',
  'vless://',
  'trojan://',
  'ss://',
  'ssr://',
  'hysteria://',
  'hysteria2://',
  'tuic://',
  'wireguard://',
  'socks://',
];

let _activeProxy = null;

function tryDecodeURIComponentSafe(raw = '') {
  const text = String(raw || '');
  try { return decodeURIComponent(text); } catch { return text; }
}

function toBase64Standard(raw = '') {
  let text = String(raw || '').trim().replace(/\s+/g, '');
  if (!text) return '';
  text = text.replace(/-/g, '+').replace(/_/g, '/');
  const mod = text.length % 4;
  if (mod !== 0) text += '='.repeat(4 - mod);
  return text;
}

function tryDecodeBase64Text(raw = '') {
  const text = toBase64Standard(raw);
  if (!text) return '';
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (!decoded || !decoded.trim()) return '';
    return decoded;
  } catch {
    return '';
  }
}

function looksLikeBase64Blob(raw = '') {
  const text = String(raw || '').trim().replace(/\s+/g, '');
  if (!text || text.length < 24) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(text)) return false;
  const hasKnownPrefix = NODE_URI_PREFIXES.some(p => text.toLowerCase().startsWith(p));
  return !hasKnownPrefix;
}

function normalizeSubscriptionUrl(raw = '') {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: '订阅链接不能为空' };

  if (/^https?:\/\//i.test(input)) {
    return { ok: true, url: input, sourceUrl: input, transformed: false };
  }

  if (/^clash:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      const wrapped = String(parsed.searchParams.get('url') || '').trim();
      const decodedWrapped = tryDecodeURIComponentSafe(wrapped);
      if (/^https?:\/\//i.test(decodedWrapped)) {
        return { ok: true, url: decodedWrapped, sourceUrl: input, transformed: true };
      }
    } catch {
      // continue and return unified error
    }
    return { ok: false, error: 'clash:// 链接中未找到可用的 http(s) 订阅地址' };
  }

  if (/^sub:\/\//i.test(input)) {
    const payload = input.replace(/^sub:\/\//i, '');
    const decoded = tryDecodeBase64Text(payload);
    const decodedTrimmed = String(decoded || '').trim();
    if (/^https?:\/\//i.test(decodedTrimmed)) {
      return { ok: true, url: decodedTrimmed, sourceUrl: input, transformed: true };
    }
    return { ok: false, error: 'sub:// 链接解码后不是有效的 http(s) 地址' };
  }

  const maybeDecoded = tryDecodeURIComponentSafe(input);
  if (/^https?:\/\//i.test(maybeDecoded)) {
    return { ok: true, url: maybeDecoded, sourceUrl: input, transformed: maybeDecoded !== input };
  }

  return { ok: false, error: '订阅链接格式不支持，请提供 http(s) 链接或 clash:// / sub:// 链接' };
}

function createDefaultConfig() {
  return {
    enabled: false,
    type: 'http',
    host: '127.0.0.1',
    port: 7890,
    subscriptions: [],
    activeSubscriptionId: '',
    activeNode: null,
  };
}

// 激活节点的**展示元信息**(name/protocol/egressMode)——刻意不落任何凭据
// (uuid/password/cipher)到 proxy.json;真实出站端点仍走 config.host/port。
function normalizeActiveNode(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  const protocol = String(raw.protocol || raw.type || '').trim().toLowerCase();
  const egressMode = String(raw.egressMode || '').trim();
  if (!name && !protocol) return null;
  const out = { name, protocol, egressMode };
  if (Number.parseInt(raw.mixedPort, 10) > 0) out.mixedPort = Number.parseInt(raw.mixedPort, 10);
  return out;
}

function normalizeSubscription(entry = {}, index = 0) {
  const url = String(entry.url || '').trim();
  if (!url) return null;
  const id = String(entry.id || `sub_${index + 1}`).trim();
  return {
    id,
    name: String(entry.name || '').trim() || `subscription-${index + 1}`,
    url,
    sourceUrl: String(entry.sourceUrl || entry.url || '').trim(),
    addedAt: String(entry.addedAt || new Date().toISOString()),
    updatedAt: String(entry.updatedAt || entry.addedAt || new Date().toISOString()),
    lastCheckedAt: entry.lastCheckedAt || null,
    lastStatus: entry.lastStatus || 'unknown', // unknown|ok|error
    lastError: entry.lastError || '',
    detected: entry.detected && typeof entry.detected === 'object' ? entry.detected : null,
  };
}

function sanitizeConfig(raw = null) {
  const base = createDefaultConfig();
  const src = raw && typeof raw === 'object' ? raw : {};
  const subscriptions = Array.isArray(src.subscriptions)
    ? src.subscriptions.map((s, i) => normalizeSubscription(s, i)).filter(Boolean)
    : [];
  const activeSubscriptionId = String(src.activeSubscriptionId || '').trim();
  return {
    enabled: src.enabled === true,
    type: String(src.type || base.type).toLowerCase() === 'socks5' ? 'socks5' : 'http',
    host: String(src.host || base.host).trim() || base.host,
    port: parseInt(String(src.port || base.port), 10) || base.port,
    subscriptions,
    activeSubscriptionId: subscriptions.some(s => s.id === activeSubscriptionId) ? activeSubscriptionId : '',
    activeNode: normalizeActiveNode(src.activeNode),
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(PROXY_CONFIG_PATH)) {
      return sanitizeConfig(JSON.parse(fs.readFileSync(PROXY_CONFIG_PATH, 'utf8')));
    }
  } catch { /* ignore corrupted file */ }
  return createDefaultConfig();
}

function saveConfig(config) {
  try {
    fs.mkdirSync(KHY_DIR, { recursive: true });
    fs.writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(sanitizeConfig(config), null, 2));
  } catch { /* ignore write failures */ }
}

function testProxy(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(timeout, () => { socket.destroy(); resolve(false); });
  });
}

async function detectClash() {
  for (const port of CLASH_PORTS.http) {
    if (await testProxy('127.0.0.1', port)) {
      return { type: 'http', host: '127.0.0.1', port, detected: true };
    }
  }
  return null;
}

function applyProxy(config) {
  if (!config || !config.enabled) {
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.all_proxy;
    delete process.env.ALL_PROXY;
    _activeProxy = null;
    proxyEvents.emit('proxy-changed', { url: null, mode: 'disabled' });
    return;
  }

  if (config.type === 'socks5') {
    // SOCKS5 not supported by gateway adapters — clear env and warn.
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.all_proxy;
    delete process.env.ALL_PROXY;
    _activeProxy = {
      ...config,
      url: `socks5://${config.host}:${config.port}`,
      unsupported: true,
      warning: 'SOCKS5 not supported. Use HTTP/HTTPS proxy or convert via Privoxy/Polipo.',
    };
    proxyEvents.emit('proxy-changed', { url: null, mode: 'socks5-unsupported' });
    return;
  }

  const proxyUrl = `http://${config.host}:${config.port}`;

  process.env.http_proxy = proxyUrl;
  process.env.https_proxy = proxyUrl;
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.all_proxy = proxyUrl;
  process.env.ALL_PROXY = proxyUrl;

  const noProxy = '127.0.0.1,localhost,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';
  process.env.no_proxy = noProxy;
  process.env.NO_PROXY = noProxy;

  _activeProxy = { ...config, url: proxyUrl };
  proxyEvents.emit('proxy-changed', { url: proxyUrl, mode: config.type });
}

function getActiveProxy() {
  return _activeProxy;
}

async function enableProxy(opts = {}) {
  const config = loadConfig();
  if (opts.type) config.type = String(opts.type).toLowerCase() === 'socks5' ? 'socks5' : 'http';
  if (opts.host) config.host = String(opts.host).trim();
  if (opts.port) config.port = parseInt(String(opts.port), 10);

  if (config.type === 'socks5') {
    return {
      success: false,
      error: '当前网关仅支持 HTTP/HTTPS CONNECT 代理。请使用 Clash mixed-port/http-port（例如 127.0.0.1:7890）。',
    };
  }

  config.enabled = true;

  const reachable = await testProxy(config.host, config.port);
  if (!reachable) {
    return { success: false, error: `代理不可达: ${config.host}:${config.port}` };
  }

  applyProxy(config);
  saveConfig(config);
  return { success: true, proxy: _activeProxy };
}

function disableProxy() {
  const config = loadConfig();
  config.enabled = false;
  applyProxy(null);
  saveConfig(config);
  return { success: true };
}

async function autoDetectAndEnable() {
  const clash = await detectClash();
  if (!clash) {
    return { success: false, error: '未检测到 Clash 代理。请确保 Clash 已启动并开启系统代理。' };
  }
  const config = loadConfig();
  config.enabled = true;
  config.type = clash.type;
  config.host = clash.host;
  config.port = clash.port;
  applyProxy(config);
  saveConfig(config);
  return { success: true, proxy: _activeProxy, detected: true };
}

// 惰性加载内核管理器 + 配置生成器(避免模块加载期循环依赖;二者才是 IO/纯叶子边界)。
function _coreManager() {
  return require('./proxy/proxyCoreManager');
}
function _configGen() {
  return require('./proxy/proxyCoreConfigGen');
}

/**
 * 用一个**已解析的订阅节点对象**激活真实出站。据节点协议分三条路(诚实边界):
 *   - direct-connect(http/https)→ 节点自身即 CONNECT 代理 → applyProxy(node.server:port),无需内核。
 *   - core-required(vmess/vless/trojan/ss/ssr)→ 门开且内核在则 spawn 内核 → applyProxy(127.0.0.1:mixedPort);
 *     门关/内核缺失 → 原样透传结构化 guidance(**绝不谎报生效**)。
 *   - unsupported → 明确 reason。
 * 纯增,不改 enableProxy/disableProxy 行为。
 * @param {object} node 已解析节点对象(proxyNodeParse / proxyUriParsers 产出)。
 * @param {object} [options] { mixedPort?, env? }
 */
async function activateNode(node, options = {}) {
  const gen = _configGen();
  const kind = gen.classifyNodeEgress(node);

  if (kind === 'direct-connect') {
    const host = String(node.server || '').trim();
    const port = Number.parseInt(node.port, 10);
    if (!host || !(port > 0)) {
      return { success: false, reason: 'node-invalid', error: '直连节点缺少可用的 server/port。' };
    }
    const reachable = await testProxy(host, port);
    if (!reachable) {
      return { success: false, reason: 'unreachable', error: `节点不可达: ${host}:${port}` };
    }
    const config = loadConfig();
    config.enabled = true;
    config.type = 'http';
    config.host = host;
    config.port = port;
    config.activeNode = normalizeActiveNode({
      name: node.name, protocol: node.type || node.protocol,
      egressMode: 'direct-connect',
    });
    applyProxy(config);
    saveConfig(config);
    return { success: true, egressMode: 'direct-connect', proxy: _activeProxy };
  }

  if (kind === 'core-required') {
    const core = _coreManager();
    const started = await core.start(node, options);
    if (!started.success) {
      // 门关/内核缺失/配置非法:原样透传结构化 guidance,不动 env、不谎报生效。
      return { ...started, egressMode: 'core-required' };
    }
    const config = loadConfig();
    config.enabled = true;
    config.type = 'http';
    config.host = '127.0.0.1';
    config.port = started.mixedPort;
    config.activeNode = normalizeActiveNode({
      name: node.name, protocol: node.type || node.protocol,
      egressMode: 'core-required', mixedPort: started.mixedPort,
    });
    applyProxy(config);
    saveConfig(config);
    return {
      success: true, egressMode: 'core-required', mixedPort: started.mixedPort,
      pid: started.pid, proxy: _activeProxy,
    };
  }

  return {
    success: false,
    reason: 'unsupported',
    egressMode: 'unsupported',
    error: gen.describeUnsupported(node),
  };
}

/**
 * 停用出站:清 env + 停内核(若在跑)+ 清 activeNode。纯增。
 */
async function deactivate() {
  const core = _coreManager();
  try {
    if (core.isRunning && core.isRunning()) await core.stop();
  } catch { /* fail-soft:内核停不掉不阻塞清 env */ }
  const config = loadConfig();
  config.enabled = false;
  config.activeNode = null;
  applyProxy(null);
  saveConfig(config);
  return { success: true };
}

function genSubscriptionId() {
  return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function listSubscriptions() {
  return [...loadConfig().subscriptions];
}

function safeDecodeURIComponent(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  try { return decodeURIComponent(text); } catch { return text; }
}

function buildSubscriptionLookupSet(query = '') {
  const raw = String(query || '').trim();
  const out = new Set();
  const push = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized) out.add(normalized);
  };
  push(raw);
  push(safeDecodeURIComponent(raw));

  const normalized = normalizeSubscriptionUrl(raw);
  if (normalized.ok) {
    push(normalized.url);
    push(normalized.sourceUrl || normalized.url);
  }
  return out;
}

function normalizeLookupUrl(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  const normalized = normalizeSubscriptionUrl(text);
  if (normalized.ok) return String(normalized.url || '').trim().toLowerCase();
  return text.toLowerCase();
}

function resolveSubscription(config, query = '') {
  const subscriptions = Array.isArray(config?.subscriptions) ? config.subscriptions : [];
  const q = String(query || '').trim().toLowerCase();
  const qSet = buildSubscriptionLookupSet(query);
  const normalizedQUrl = normalizeLookupUrl(query);
  if (!q) {
    if (config?.activeSubscriptionId) {
      const active = subscriptions.find(s => s.id === config.activeSubscriptionId);
      if (active) return active;
    }
    return null;
  }
  return subscriptions.find((s) => {
    const id = String(s.id || '').toLowerCase();
    const name = String(s.name || '').toLowerCase();
    const url = String(s.url || '').toLowerCase();
    const sourceUrl = String(s.sourceUrl || '').toLowerCase();
    const normalizedUrl = normalizeLookupUrl(s.url);
    const normalizedSourceUrl = normalizeLookupUrl(s.sourceUrl);
    return qSet.has(id)
      || qSet.has(name)
      || qSet.has(url)
      || qSet.has(sourceUrl)
      || (normalizedQUrl && normalizedQUrl === normalizedUrl)
      || (normalizedQUrl && normalizedQUrl === normalizedSourceUrl)
      || id.includes(q)
      || name.includes(q);
  }) || null;
}

function addSubscription(url, name = '') {
  const normalized = normalizeSubscriptionUrl(url);
  if (!normalized.ok) {
    return { success: false, error: normalized.error || '订阅链接格式不正确' };
  }
  const targetUrl = normalized.url;
  const sourceUrl = normalized.sourceUrl || targetUrl;

  const config = loadConfig();
  const existing = config.subscriptions.find(s => String(s.url || '').trim() === targetUrl);
  if (existing) {
    if (name) existing.name = String(name).trim();
    if (!existing.sourceUrl) existing.sourceUrl = sourceUrl;
    existing.updatedAt = new Date().toISOString();
    saveConfig(config);
    return { success: true, created: false, subscription: existing };
  }

  const sub = normalizeSubscription({
    id: genSubscriptionId(),
    name: String(name || '').trim() || `subscription-${config.subscriptions.length + 1}`,
    url: targetUrl,
    sourceUrl,
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastStatus: 'unknown',
  }, config.subscriptions.length);
  config.subscriptions.push(sub);
  if (!config.activeSubscriptionId) config.activeSubscriptionId = sub.id;
  saveConfig(config);
  return { success: true, created: true, subscription: sub };
}

function removeSubscription(query) {
  const config = loadConfig();
  const target = resolveSubscription(config, query);
  if (!target) return { success: false, error: `未找到订阅: ${query}` };
  config.subscriptions = config.subscriptions.filter(s => s.id !== target.id);
  if (config.activeSubscriptionId === target.id) {
    config.activeSubscriptionId = config.subscriptions[0]?.id || '';
  }
  saveConfig(config);
  return { success: true, removed: target };
}

function setActiveSubscription(query) {
  const config = loadConfig();
  const target = resolveSubscription(config, query);
  if (!target) return { success: false, error: `未找到订阅: ${query}` };
  config.activeSubscriptionId = target.id;
  saveConfig(config);
  return { success: true, active: target };
}

function parseClashConfigHints(text = '') {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);
  let mixedPort = null;
  let httpPort = null;
  let socksPort = null;
  let externalController = '';
  let hasClashKeys = false;

  for (const line of lines) {
    const clean = String(line || '').trim();
    if (!clean) continue;
    if (/^(proxies|proxy-groups|rules|dns|tun|sniffer)\s*:/i.test(clean)) hasClashKeys = true;
    if (/^(allow-lan|bind-address|external-controller|mode|log-level)\s*:/i.test(clean)) hasClashKeys = true;

    let m = clean.match(/^mixed[-_]port\s*:\s*['"]?(\d{2,5})['"]?\s*$/i);
    if (m) mixedPort = parseInt(m[1], 10);
    m = clean.match(/^port\s*:\s*['"]?(\d{2,5})['"]?\s*$/i);
    if (m) httpPort = parseInt(m[1], 10);
    m = clean.match(/^socks[-_]port\s*:\s*['"]?(\d{2,5})['"]?\s*$/i);
    if (m) socksPort = parseInt(m[1], 10);
    m = clean.match(/^external[-_]controller\s*:\s*['"]?([^'"]+)['"]?\s*$/i);
    if (m) externalController = String(m[1] || '').trim();
  }

  const socksOnly = !!(socksPort && !mixedPort && !httpPort);
  const port = mixedPort || httpPort || null;
  const type = mixedPort || httpPort ? 'http' : null;
  const host = '127.0.0.1';
  return {
    mixedPort,
    httpPort,
    socksPort,
    socksOnly,
    externalController,
    hasClashKeys,
    proxy: port ? { type: type || 'http', host, port } : null,
  };
}

function parseNodeUriStats(text = '') {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(v => String(v || '').trim())
    .filter(Boolean);
  const protocolCount = {};
  let nodeCount = 0;
  for (const line of lines) {
    const lower = line.toLowerCase();
    const prefix = NODE_URI_PREFIXES.find(p => lower.startsWith(p));
    if (!prefix) continue;
    nodeCount += 1;
    const key = prefix.replace('://', '');
    protocolCount[key] = (protocolCount[key] || 0) + 1;
  }
  return { nodeCount, protocolCount };
}

function parseSubscriptionContent(text = '') {
  const rawText = String(text || '').replace(/^\uFEFF/, '').trim();
  const rawHints = parseClashConfigHints(rawText);
  const rawNodeStats = parseNodeUriStats(rawText);
  let selectedText = rawText;
  let decodedFromBase64 = false;

  if (!rawHints.proxy && !rawHints.hasClashKeys && rawNodeStats.nodeCount === 0 && looksLikeBase64Blob(rawText)) {
    const decoded = tryDecodeBase64Text(rawText).trim();
    if (decoded) {
      const decodedHints = parseClashConfigHints(decoded);
      const decodedNodeStats = parseNodeUriStats(decoded);
      const decodedUseful = !!decodedHints.proxy || decodedHints.hasClashKeys || decodedNodeStats.nodeCount > 0;
      if (decodedUseful) {
        selectedText = decoded;
        decodedFromBase64 = true;
      }
    }
  }

  const hints = parseClashConfigHints(selectedText);
  const nodeStats = parseNodeUriStats(selectedText);
  const format = hints.proxy || hints.hasClashKeys
    ? 'clash-config'
    : (nodeStats.nodeCount > 0 ? (decodedFromBase64 ? 'node-links-base64' : 'node-links') : 'unknown');

  return {
    format,
    decodedFromBase64,
    contentBytes: Buffer.byteLength(selectedText || '', 'utf8'),
    nodeCount: nodeStats.nodeCount,
    protocolCount: nodeStats.protocolCount,
    proxy: hints.proxy,
    mixedPort: hints.mixedPort,
    httpPort: hints.httpPort,
    socksPort: hints.socksPort,
    socksOnly: hints.socksOnly,
    externalController: hints.externalController,
    hasClashKeys: hints.hasClashKeys,
  };
}

function decodeResponseBody(buffer, headers = {}) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const encoding = String(headers['content-encoding'] || '').toLowerCase();
  if (!encoding) return raw;
  try {
    if (encoding.includes('gzip') || encoding.includes('x-gzip')) return zlib.gunzipSync(raw);
    if (encoding.includes('deflate')) return zlib.inflateSync(raw);
    if (encoding.includes('br') && typeof zlib.brotliDecompressSync === 'function') {
      return zlib.brotliDecompressSync(raw);
    }
  } catch {
    return raw;
  }
  return raw;
}

function requestDocument(url, timeout = 12000, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'khy-os/1.0',
        Accept: 'text/plain,application/yaml,text/yaml,*/*',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      const status = Number(res.statusCode || 0);
      const location = res.headers?.location ? String(res.headers.location) : '';
      if (status >= 300 && status < 400 && location && redirects < 3) {
        req.destroy();
        const nextUrl = /^https?:\/\//i.test(location)
          ? location
          : new URL(location, parsed).toString();
        requestDocument(nextUrl, timeout, redirects + 1).then(resolve).catch(reject);
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
      res.on('end', () => {
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const rawBuffer = Buffer.concat(chunks);
        const decoded = decodeResponseBody(rawBuffer, res.headers || {});
        const text = decoded.toString('utf8');
        resolve({
          text,
          status,
          finalUrl: parsed.toString(),
          headers: res.headers || {},
          contentBytes: Buffer.byteLength(text, 'utf8'),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

function requestText(url, timeout = 12000, redirects = 0) {
  return requestDocument(url, timeout, redirects).then(r => r.text);
}

// 抓订阅正文 + 响应头(供路由取 `subscription-userinfo` 流量/到期元信息)。纯增,不改上面两函数。
function requestTextWithMeta(url, timeout = 12000, redirects = 0) {
  return requestDocument(url, timeout, redirects).then(r => ({ text: r.text, headers: r.headers || {} }));
}

async function refreshSubscription(query = '', options = {}) {
  const config = loadConfig();
  const target = resolveSubscription(config, query);
  if (!target) {
    return { success: false, error: query ? `未找到订阅: ${query}` : '未设置激活订阅' };
  }

  const timeout = Math.max(3000, parseInt(String(options.timeout || 12000), 10) || 12000);
  const apply = options.apply === true;
  const nowIso = new Date().toISOString();

  try {
    const doc = await requestDocument(target.url, timeout);
    const hints = parseSubscriptionContent(doc.text);
    target.lastCheckedAt = nowIso;
    target.lastStatus = 'ok';
    target.lastError = '';
    target.detected = {
      ...hints,
      finalUrl: doc.finalUrl || target.url,
      fetchedAt: nowIso,
      sourceUrl: target.sourceUrl || target.url,
    };
    target.updatedAt = nowIso;

    let appliedProxy = null;
    if (apply) {
      let proxyToApply = hints.proxy || null;
      if (!proxyToApply) {
        // Non-clash subscription formats (e.g. base64 vmess/vless links)
        // may not include local proxy ports. Fallback to local Clash detection.
        const detected = await detectClash();
        if (detected) proxyToApply = detected;
      }
      if (!proxyToApply && hints.socksOnly) {
        saveConfig(config);
        return {
          success: false,
          error: '订阅仅检测到 SOCKS5 端口。当前网关请求隧道仅支持 HTTP CONNECT，请在 Clash 开启 mixed-port/http-port（如 7890）后重试。',
          subscription: target,
          hints,
        };
      }
      if (proxyToApply) {
        config.enabled = true;
        config.type = proxyToApply.type;
        config.host = proxyToApply.host;
        config.port = proxyToApply.port;
        applyProxy(config);
        appliedProxy = _activeProxy;
      }
    }

    saveConfig(config);
    return {
      success: true,
      subscription: target,
      hints,
      applied: apply && !!appliedProxy,
      proxy: appliedProxy,
    };
  } catch (err) {
    target.lastCheckedAt = nowIso;
    target.lastStatus = 'error';
    target.lastError = err && err.message ? err.message : String(err || 'refresh failed');
    target.updatedAt = nowIso;
    saveConfig(config);
    return {
      success: false,
      error: target.lastError,
      subscription: target,
    };
  }
}

async function applySubscription(query = '', options = {}) {
  return refreshSubscription(query, { ...options, apply: true });
}

function initFromConfig() {
  const config = loadConfig();
  if (config.enabled) {
    applyProxy(config);
    return;
  }
  // Auto mode: if system proxy is already set via environment, reuse it.
  const systemProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    || process.env.https_proxy || process.env.http_proxy;
  if (systemProxy) {
    _activeProxy = { type: 'http', url: systemProxy, host: '', port: 0, systemProxy: true };
  }
}

function getStatus() {
  const config = loadConfig();
  const activeSubscription = resolveSubscription(config, config.activeSubscriptionId);
  const unsupportedSocks = config.enabled && config.type === 'socks5';
  // 附内核状态(fail-soft:内核管理器异常不拖垮 status)。
  let coreStatus = null;
  try {
    coreStatus = _coreManager().getStatus();
  } catch { coreStatus = null; }
  return {
    enabled: config.enabled,
    type: config.type,
    host: config.host,
    port: config.port,
    active: !!_activeProxy && !_activeProxy.unsupported,
    url: _activeProxy?.url || null,
    compatibilityWarning: unsupportedSocks
      ? 'SOCKS5 proxy is configured. Gateway adapters currently require HTTP CONNECT proxy (e.g. Clash mixed-port 7890).'
      : '',
    subscriptions: (config.subscriptions || []).length,
    activeSubscriptionId: config.activeSubscriptionId || '',
    activeSubscriptionName: activeSubscription?.name || '',
    activeNode: config.activeNode || null,
    coreStatus,
  };
}

module.exports = {
  CLASH_PORTS,
  loadConfig,
  saveConfig,
  detectClash,
  testProxy,
  applyProxy,
  getActiveProxy,
  enableProxy,
  disableProxy,
  autoDetectAndEnable,
  activateNode,
  deactivate,
  addSubscription,
  listSubscriptions,
  removeSubscription,
  setActiveSubscription,
  refreshSubscription,
  applySubscription,
  initFromConfig,
  getStatus,
  parseClashConfigHints,
  requestText,
  requestTextWithMeta,
  proxyEvents,
};
