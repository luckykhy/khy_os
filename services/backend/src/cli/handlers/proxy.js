/**
 * CLI Handlers for the Reverse Proxy server.
 * Commands:
 *   proxy start/stop/status
 *   proxy cert ...
 *   proxy tls ...
 *   proxy cursor2api ...
 */
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const { printSuccess, printError, printInfo } = require('../formatters');

const KHY_DIR = path.join(os.homedir(), '.khyquant');
const PROXY_RUNTIME_FILE = path.join(KHY_DIR, 'proxy_server_runtime.json');
const PROXY_DAEMON_SCRIPT = path.resolve(__dirname, '../../../scripts/proxy-daemon.js');
const PROXY_CERT_DIR = path.join(KHY_DIR, 'proxy_certs');
const TRAE_SWITCH_STORE_FILE = path.join(KHY_DIR, 'trae_switch_profiles.json');
const WINDSURF_SWITCH_STORE_FILE = path.join(KHY_DIR, 'windsurf_switch_profiles.json');

function getProxy() {
  return require('../../services/gateway/proxyServer');
}

function parsePortMaybe(raw, fallback = undefined) {
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

const parseBooleanMaybe = require('../../utils/parseBoolean');

function buildProxyStartOptions(options = {}, proxy = null) {
  const basePort = parsePortMaybe(options.port, proxy ? proxy.getPort() : 9100) || 9100;
  const httpsOnly = parseBooleanMaybe(options['https-only'] ?? options.httpsOnly, false);
  const httpsEnabled = parseBooleanMaybe(options.https, false) || httpsOnly;
  const httpsPort = parsePortMaybe(options['https-port'] ?? options.httpsPort, httpsOnly ? basePort : (basePort + 1));
  const host = String(options.host || process.env.PROXY_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const tlsCertFile = String(options['tls-cert'] || options.tlsCertFile || '').trim();
  const tlsKeyFile = String(options['tls-key'] || options.tlsKeyFile || '').trim();

  return {
    host,
    port: basePort,
    https: httpsEnabled,
    httpsOnly,
    httpsPort,
    tlsCertFile,
    tlsKeyFile,
    httpEnabled: !httpsOnly,
    httpsEnabled,
  };
}

function buildProxyDaemonArgs(startOptions = {}) {
  const args = [PROXY_DAEMON_SCRIPT];
  if (Number.isFinite(startOptions.port)) {
    args.push('--port', String(startOptions.port));
  }
  if (startOptions.host) {
    args.push('--host', String(startOptions.host));
  }
  if (startOptions.https) {
    args.push('--https');
  }
  if (startOptions.httpsOnly) {
    args.push('--https-only');
  }
  if (Number.isFinite(startOptions.httpsPort)) {
    args.push('--https-port', String(startOptions.httpsPort));
  }
  if (startOptions.tlsCertFile) {
    args.push('--tls-cert', String(startOptions.tlsCertFile));
  }
  if (startOptions.tlsKeyFile) {
    args.push('--tls-key', String(startOptions.tlsKeyFile));
  }
  return args;
}

function parsePositiveInt(raw, fallback) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseJsonObject(raw, fallback = {}) {
  const text = String(raw || '').trim();
  if (!text) return { ...fallback };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return { ...fallback };
  }
  return { ...fallback };
}

function parseCsvList(raw) {
  return String(raw || '')
    .split(/[\n,]/g)
    .map(s => s.trim())
    .filter(Boolean);
}

function dedupeList(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const value = String(item || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeModelId(raw) {
  return String(raw || '').trim().replace(/^['"]|['"]$/g, '');
}

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
    pathname = pathname.replace(/\/+$/, '');
    if (!pathname || pathname === '/') pathname = '/v1';
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return '';
  }
}

function normalizeTraeProfileId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function createTraeProfileId(name, used = new Set()) {
  const base = normalizeTraeProfileId(name) || `relay-${Date.now().toString(36)}`;
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base}-${i}`;
    if (!used.has(next)) return next;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function parseModelMap(raw) {
  const source = String(raw || '').trim();
  if (!source) return {};
  const out = {};
  for (const row of source.split(/[\n,]/g)) {
    const line = String(row || '').trim();
    if (!line) continue;
    const sep = line.includes('=>') ? '=>' : '=';
    const idx = line.indexOf(sep);
    if (idx <= 0) continue;
    const from = normalizeModelId(line.slice(0, idx).trim());
    const to = normalizeModelId(line.slice(idx + sep.length).trim());
    if (!from || !to) continue;
    out[from] = to;
  }
  return out;
}

function normalizeTraeProfile(row = {}, usedIds = new Set()) {
  const endpoint = normalizeEndpointBase(
    row.endpoint
    || row.openaiBase
    || row.baseUrl
    || row.base
  );
  if (!endpoint) return null;

  const modelMapInput = row.modelMap && typeof row.modelMap === 'object' ? row.modelMap : {};
  const parsedModels = Array.isArray(row.models) ? row.models : parseCsvList(row.models);
  const models = dedupeList([
    ...parsedModels.map(normalizeModelId),
    ...Object.keys(modelMapInput).map(normalizeModelId),
  ]);
  if (models.length === 0) return null;

  const modelMap = {};
  for (const modelId of models) {
    const mapped = normalizeModelId(modelMapInput[modelId] || modelId);
    modelMap[modelId] = mapped || modelId;
  }

  const idSeed = String(row.id || row.name || '').trim();
  const id = (normalizeTraeProfileId(idSeed) || createTraeProfileId(idSeed, usedIds));
  if (usedIds.has(id)) {
    return null;
  }
  usedIds.add(id);

  const now = new Date().toISOString();
  return {
    id,
    name: String(row.name || id).trim() || id,
    endpoint,
    key: String(row.key || row.apiKey || row.token || '').trim(),
    models,
    modelMap,
    createdAt: row.createdAt || now,
    updatedAt: row.updatedAt || row.createdAt || now,
  };
}

function loadTraeSwitchStore() {
  const fallback = { activeId: '', profiles: [] };
  try {
    if (!fs.existsSync(TRAE_SWITCH_STORE_FILE)) return fallback;
    const data = JSON.parse(fs.readFileSync(TRAE_SWITCH_STORE_FILE, 'utf-8'));
    const rows = Array.isArray(data?.profiles) ? data.profiles : [];
    const used = new Set();
    const profiles = rows
      .map(row => normalizeTraeProfile(row, used))
      .filter(Boolean);
    const activeId = String(data?.activeId || '').trim();
    return {
      activeId: profiles.some(p => p.id === activeId) ? activeId : '',
      profiles,
    };
  } catch {
    return fallback;
  }
}

function saveTraeSwitchStore(store = {}) {
  const used = new Set();
  const profiles = (Array.isArray(store.profiles) ? store.profiles : [])
    .map(row => normalizeTraeProfile(row, used))
    .filter(Boolean);
  const activeIdInput = String(store.activeId || '').trim();
  const activeId = profiles.some(p => p.id === activeIdInput) ? activeIdInput : '';
  const next = { activeId, profiles, updatedAt: new Date().toISOString() };
  fs.mkdirSync(KHY_DIR, { recursive: true });
  fs.writeFileSync(TRAE_SWITCH_STORE_FILE, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

function resolveTraeProfile(store, query = '') {
  const profiles = Array.isArray(store?.profiles) ? store.profiles : [];
  if (profiles.length === 0) return null;
  const q = String(query || '').trim().toLowerCase();
  if (!q) {
    if (store?.activeId) {
      const active = profiles.find(p => p.id === store.activeId);
      if (active) return active;
    }
    return profiles[0];
  }

  const exactById = profiles.find(p => p.id.toLowerCase() === q);
  if (exactById) return exactById;
  const exactByName = profiles.find(p => String(p.name || '').trim().toLowerCase() === q);
  if (exactByName) return exactByName;
  return profiles.find(p => p.id.toLowerCase().includes(q) || String(p.name || '').toLowerCase().includes(q)) || null;
}

function loadWindsurfSwitchStore() {
  const fallback = { activeId: '', profiles: [] };
  try {
    if (!fs.existsSync(WINDSURF_SWITCH_STORE_FILE)) return fallback;
    const data = JSON.parse(fs.readFileSync(WINDSURF_SWITCH_STORE_FILE, 'utf-8'));
    const rows = Array.isArray(data?.profiles) ? data.profiles : [];
    const used = new Set();
    const profiles = rows
      .map(row => normalizeTraeProfile(row, used))
      .filter(Boolean);
    const activeId = String(data?.activeId || '').trim();
    return {
      activeId: profiles.some(p => p.id === activeId) ? activeId : '',
      profiles,
    };
  } catch {
    return fallback;
  }
}

function saveWindsurfSwitchStore(store = {}) {
  const used = new Set();
  const profiles = (Array.isArray(store.profiles) ? store.profiles : [])
    .map(row => normalizeTraeProfile(row, used))
    .filter(Boolean);
  const activeIdInput = String(store.activeId || '').trim();
  const activeId = profiles.some(p => p.id === activeIdInput) ? activeIdInput : '';
  const next = { activeId, profiles, updatedAt: new Date().toISOString() };
  fs.mkdirSync(KHY_DIR, { recursive: true });
  fs.writeFileSync(WINDSURF_SWITCH_STORE_FILE, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

function resolveWindsurfProfile(store, query = '') {
  return resolveTraeProfile(store, query);
}

function buildSwitchProfileSignature(profile = {}) {
  const models = dedupeList([...(Array.isArray(profile.models) ? profile.models : [])].map(normalizeModelId))
    .sort();
  const mapSource = profile.modelMap && typeof profile.modelMap === 'object' ? profile.modelMap : {};
  const mapEntries = Object.keys(mapSource)
    .map((key) => [normalizeModelId(key), normalizeModelId(mapSource[key])])
    .filter(([from, to]) => !!from && !!to)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify({
    endpoint: normalizeEndpointBase(profile.endpoint || ''),
    key: String(profile.key || '').trim(),
    models,
    modelMap: mapEntries,
  });
}

function resolveEnvPathsForProxy() {
  const canonicalPath = process.env.KHY_ENV_FILE
    ? path.resolve(process.env.KHY_ENV_FILE)
    : path.resolve(__dirname, '../../../.env');
  const mirrorPath = path.resolve(__dirname, '../../../../.env');
  const syncMirror = String(process.env.KHY_ENV_SYNC_ROOT || 'true').toLowerCase() !== 'false';
  const targets = [canonicalPath];
  if (syncMirror && mirrorPath !== canonicalPath && (fs.existsSync(mirrorPath) || fs.existsSync(canonicalPath))) {
    targets.push(mirrorPath);
  }
  return { canonicalPath, targets };
}

const patchEnvContent = require('../../utils/patchEnvContent');

function writeEnvPatch(envMap = {}, unsetKeys = []) {
  const { canonicalPath, targets } = resolveEnvPathsForProxy();
  for (const targetPath of targets) {
    let content = '';
    try { content = fs.readFileSync(targetPath, 'utf-8'); } catch { /* no .env yet */ }
    const patched = patchEnvContent(content, envMap, unsetKeys);
    fs.writeFileSync(targetPath, patched);
  }
  for (const [key, value] of Object.entries(envMap)) {
    process.env[key] = String(value);
  }
  for (const key of unsetKeys) {
    delete process.env[key];
  }
  return canonicalPath;
}

function buildTraeRouteMap(profile) {
  const routeMap = {};
  const map = profile?.modelMap || {};
  for (const customModel of (profile?.models || [])) {
    const source = normalizeModelId(customModel);
    if (!source) continue;
    const targetModel = normalizeModelId(map[source] || source) || source;
    routeMap[source] = {
      target: `relay_api:${targetModel}`,
      strict: true,
    };
  }
  return routeMap;
}

function applyTraeSwitchProfile(profile) {
  const baseModel = (profile.models && profile.models[0]) || '';
  const defaultTarget = normalizeModelId((profile.modelMap || {})[baseModel] || baseModel);
  const existingRouteMap = parseJsonObject(process.env.PROXY_MODEL_ROUTE_MAP || process.env.GATEWAY_MODEL_ROUTE_MAP, {});
  const routeMap = {
    ...existingRouteMap,
    ...buildTraeRouteMap(profile),
  };

  const envMap = {
    RELAY_API_ENDPOINT: profile.endpoint,
    RELAY_API_MODELS: (profile.models || []).join(','),
    RELAY_API_MODEL: defaultTarget || baseModel,
    PROXY_PRIMARY_ADAPTER: 'relay_api',
    PROXY_PRIMARY_STRICT: 'true',
    PROXY_EXPOSE_RAW_RELAY_MODELS: 'true',
    GATEWAY_API_POOL_PROVIDER: 'relay',
    PROXY_MODEL_ROUTE_MAP: JSON.stringify(routeMap),
  };

  if (profile.key) envMap.RELAY_API_KEY = profile.key;
  const envPath = writeEnvPatch(envMap, []);
  return {
    envPath,
    routeMapCount: Object.keys(routeMap).length,
    defaultModel: envMap.RELAY_API_MODEL,
  };
}

function requestJson(url, {
  method = 'GET',
  headers = {},
  body = null,
  timeoutMs = 15000,
  rejectUnauthorized = true,
} = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const isHttps = parsed.protocol === 'https:';
    const bodyText = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      timeout: timeoutMs,
      headers: {
        ...headers,
        ...(body != null
          ? {
            'Content-Type': headers['Content-Type'] || headers['content-type'] || 'application/json',
            'Content-Length': Buffer.byteLength(bodyText),
          }
          : {}),
      },
      ...(isHttps ? { rejectUnauthorized } : {}),
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += String(chunk); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* keep raw */ }
        resolve({
          statusCode: Number(res.statusCode || 0),
          headers: res.headers || {},
          raw,
          json,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (body != null) req.write(bodyText);
    req.end();
  });
}

function extractOpenAiText(payload = {}) {
  if (typeof payload?.choices?.[0]?.message?.content === 'string') {
    return payload.choices[0].message.content;
  }
  if (typeof payload?.choices?.[0]?.delta?.content === 'string') {
    return payload.choices[0].delta.content;
  }
  if (typeof payload?.output_text === 'string') return payload.output_text;
  return '';
}

async function testTraeUpstream(profile, {
  timeoutMs = 15000,
  upstreamKey = '',
  targetModel = '',
} = {}) {
  const headers = { Accept: 'application/json' };
  if (upstreamKey) {
    headers.Authorization = `Bearer ${upstreamKey}`;
    headers['x-api-key'] = upstreamKey;
  }

  const modelsUrl = `${profile.endpoint.replace(/\/+$/, '')}/models`;
  const modelsRes = await requestJson(modelsUrl, {
    method: 'GET',
    headers,
    timeoutMs,
  });
  let modelCount = 0;
  if (Array.isArray(modelsRes?.json?.data)) modelCount = modelsRes.json.data.length;
  else if (Array.isArray(modelsRes?.json?.models)) modelCount = modelsRes.json.models.length;

  const chatUrl = `${profile.endpoint.replace(/\/+$/, '')}/chat/completions`;
  const chatRes = await requestJson(chatUrl, {
    method: 'POST',
    headers,
    timeoutMs,
    body: {
      model: targetModel,
      stream: false,
      temperature: 0,
      max_tokens: 24,
      messages: [{ role: 'user', content: 'Reply with: OK' }],
    },
  });
  const text = extractOpenAiText(chatRes.json || {}).trim();
  return {
    models: {
      ok: modelsRes.statusCode >= 200 && modelsRes.statusCode < 300,
      statusCode: modelsRes.statusCode,
      modelCount,
      error: modelsRes?.json?.error?.message || '',
    },
    chat: {
      ok: chatRes.statusCode >= 200 && chatRes.statusCode < 300 && !!text,
      statusCode: chatRes.statusCode,
      text,
      error: chatRes?.json?.error?.message || '',
    },
  };
}

async function testTraeLocalProxy(profile, {
  timeoutMs = 20000,
  customModel = '',
} = {}) {
  const proxy = getProxy();
  const run = await ensureProxyDaemonRunning(proxy, {});
  const runtimeStatus = run.runtimeStatus || (proxy.getRuntimeStatus ? proxy.getRuntimeStatus() : null);
  const preferred = getPreferredBase(runtimeStatus, proxy.getPort ? proxy.getPort() : 9100);
  const base = preferred.base;
  const authToken = run?.auth?.authToken || '';
  if (!authToken) {
    throw new Error('proxy auth token unavailable');
  }

  const headers = {
    Authorization: `Bearer ${authToken}`,
    Accept: 'application/json',
  };
  const rejectUnauthorized = preferred.protocol !== 'https';
  const modelsRes = await requestJson(`${base}/v1/models`, {
    method: 'GET',
    headers,
    timeoutMs,
    rejectUnauthorized,
  });
  const modelIds = Array.isArray(modelsRes?.json?.data)
    ? modelsRes.json.data.map(x => String(x?.id || '').trim()).filter(Boolean)
    : [];
  const hasRaw = modelIds.includes(customModel);
  const hasPrefixed = modelIds.includes(`relay_api/${customModel}`);

  const chatRes = await requestJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers,
    timeoutMs,
    rejectUnauthorized,
    body: {
      model: customModel,
      stream: false,
      temperature: 0,
      max_tokens: 24,
      messages: [{ role: 'user', content: 'Reply with: proxy-ok' }],
    },
  });
  const text = extractOpenAiText(chatRes.json || {}).trim();

  return {
    base,
    protocol: preferred.protocol,
    modelList: {
      ok: modelsRes.statusCode >= 200 && modelsRes.statusCode < 300 && (hasRaw || hasPrefixed),
      statusCode: modelsRes.statusCode,
      hasRaw,
      hasPrefixed,
      total: modelIds.length,
      error: modelsRes?.json?.error?.message || '',
    },
    chat: {
      ok: chatRes.statusCode >= 200 && chatRes.statusCode < 300 && !!text,
      statusCode: chatRes.statusCode,
      text,
      error: chatRes?.json?.error?.message || '',
    },
  };
}

function sanitizeCommonName(raw) {
  const value = String(raw || 'localhost').trim();
  if (!value) return 'localhost';
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || 'localhost';
}

function resolveTlsFiles(options = {}) {
  const tlsDirRaw = String(options['tls-dir'] || options.tlsDir || process.env.PROXY_TLS_DIR || PROXY_CERT_DIR).trim();
  const tlsDir = tlsDirRaw || PROXY_CERT_DIR;
  const certFile = String(
    options['tls-cert']
      || options.tlsCertFile
      || process.env.PROXY_TLS_CERT_FILE
      || path.join(tlsDir, 'localhost.crt')
  ).trim();
  const keyFile = String(
    options['tls-key']
      || options.tlsKeyFile
      || process.env.PROXY_TLS_KEY_FILE
      || path.join(tlsDir, 'localhost.key')
  ).trim();
  return { tlsDir, certFile, keyFile };
}

function isOpenSslAvailable() {
  const result = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  return result && result.status === 0;
}

function generateSelfSignedCert({
  certFile,
  keyFile,
  cn = 'localhost',
  days = 825,
  force = false,
} = {}) {
  const certPath = String(certFile || '').trim();
  const keyPath = String(keyFile || '').trim();
  if (!certPath || !keyPath) {
    throw new Error('证书生成失败: cert/key 路径不能为空');
  }

  const certExists = fs.existsSync(certPath);
  const keyExists = fs.existsSync(keyPath);
  if (certExists && keyExists && !force) {
    return { certFile: certPath, keyFile: keyPath, generated: false };
  }
  if ((certExists || keyExists) && !force) {
    throw new Error('检测到证书文件不完整，请使用 --force 重新生成');
  }
  if (!isOpenSslAvailable()) {
    throw new Error('系统未检测到 openssl，请安装后重试');
  }

  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  try {
    if (force && fs.existsSync(certPath)) fs.unlinkSync(certPath);
    if (force && fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
  } catch {
    // Best effort before regeneration.
  }

  const safeCn = sanitizeCommonName(cn);
  const validDays = parsePositiveInt(days, 825);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-cert-'));
  const opensslConfPath = path.join(tmpDir, 'openssl.cnf');
  const opensslConf = [
    '[req]',
    'default_bits = 2048',
    'prompt = no',
    'default_md = sha256',
    'distinguished_name = dn',
    'x509_extensions = v3_req',
    '',
    '[dn]',
    `CN = ${safeCn}`,
    '',
    '[v3_req]',
    'subjectAltName = @alt_names',
    'basicConstraints = CA:FALSE',
    'keyUsage = digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    '',
    '[alt_names]',
    'DNS.1 = localhost',
    `DNS.2 = ${safeCn}`,
    'IP.1 = 127.0.0.1',
  ].join('\n');

  fs.writeFileSync(opensslConfPath, `${opensslConf}\n`, 'utf8');
  const result = spawnSync('openssl', [
    'req',
    '-x509',
    '-nodes',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    String(validDays),
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-config',
    opensslConfPath,
    '-extensions',
    'v3_req',
  ], { encoding: 'utf8' });

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore temp cleanup error
  }

  if (!result || result.status !== 0) {
    const details = String(result?.stderr || result?.stdout || '').trim();
    throw new Error(`openssl 生成证书失败${details ? `: ${details}` : ''}`);
  }
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error('openssl 执行完成但证书文件未生成');
  }

  const { safeChmod } = require('../../tools/platformUtils');
  safeChmod(keyPath, 0o600);

  return {
    certFile: certPath,
    keyFile: keyPath,
    generated: true,
    cn: safeCn,
    days: validDays,
  };
}

function ensureHttpsTlsOptions(options = {}, { quiet = false } = {}) {
  const startOptions = buildProxyStartOptions(options);
  if (!startOptions.httpsEnabled) {
    return { options: { ...options }, certInfo: null };
  }

  const explicitCert = String(options['tls-cert'] || options.tlsCertFile || '').trim();
  const explicitKey = String(options['tls-key'] || options.tlsKeyFile || '').trim();
  if ((explicitCert && !explicitKey) || (!explicitCert && explicitKey)) {
    throw new Error('HTTPS 参数不完整：请同时提供 --tls-cert 与 --tls-key');
  }
  if (explicitCert && explicitKey) {
    return { options: { ...options }, certInfo: { certFile: explicitCert, keyFile: explicitKey, generated: false } };
  }

  const envCert = String(process.env.PROXY_TLS_CERT_FILE || '').trim();
  const envKey = String(process.env.PROXY_TLS_KEY_FILE || '').trim();
  if ((envCert && !envKey) || (!envCert && envKey)) {
    throw new Error('环境变量 HTTPS 参数不完整：PROXY_TLS_CERT_FILE 与 PROXY_TLS_KEY_FILE 需要同时设置');
  }
  if (envCert && envKey) {
    return { options: { ...options }, certInfo: { certFile: envCert, keyFile: envKey, generated: false, fromEnv: true } };
  }

  const { certFile, keyFile } = resolveTlsFiles(options);
  const certExists = fs.existsSync(certFile);
  const keyExists = fs.existsSync(keyFile);
  const certInfo = generateSelfSignedCert({
    certFile,
    keyFile,
    cn: options.cn || options['tls-cn'] || 'localhost',
    days: options['tls-days'] || options.days || 825,
    force: certExists !== keyExists,
  });
  const nextOptions = {
    ...options,
    'tls-cert': certInfo.certFile,
    'tls-key': certInfo.keyFile,
    tlsCertFile: certInfo.certFile,
    tlsKeyFile: certInfo.keyFile,
  };
  if (!quiet) {
    if (certInfo.generated) printSuccess(`已生成 HTTPS 证书: ${certInfo.certFile}`);
    else printInfo(`复用现有 HTTPS 证书: ${certInfo.certFile}`);
  }
  return { options: nextOptions, certInfo };
}

function loadProxyRuntime() {
  try {
    if (!fs.existsSync(PROXY_RUNTIME_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(PROXY_RUNTIME_FILE, 'utf-8'));
    if (!data) return null;
    const legacyPort = Number(data.port);
    const httpPort = Number(data.httpPort);
    const httpsPort = Number(data.httpsPort);
    const resolvedHttpPort = Number.isFinite(httpPort)
      ? httpPort
      : ((data.httpsOnly === true || (data.httpsEnabled === true && Number.isFinite(httpsPort)))
          ? null
          : (Number.isFinite(legacyPort) ? legacyPort : null));
    const resolvedHttpsPort = Number.isFinite(httpsPort) ? httpsPort : null;
    if (!resolvedHttpPort && !resolvedHttpsPort) return null;
    return {
      pid: Number(data.pid) || null,
      port: resolvedHttpPort || resolvedHttpsPort,
      httpPort: resolvedHttpPort,
      httpsPort: resolvedHttpsPort,
      httpsEnabled: data.httpsEnabled === true || Number.isFinite(resolvedHttpsPort),
      httpsOnly: data.httpsOnly === true || (!resolvedHttpPort && Number.isFinite(resolvedHttpsPort)),
      host: data.host || '127.0.0.1',
      startedAt: data.startedAt || null,
    };
  } catch {
    return null;
  }
}

function saveProxyRuntime(runtime) {
  try {
    fs.mkdirSync(KHY_DIR, { recursive: true });
    fs.writeFileSync(PROXY_RUNTIME_FILE, JSON.stringify(runtime, null, 2), 'utf-8');
  } catch { /* best effort */ }
}

function clearProxyRuntime() {
  try {
    if (fs.existsSync(PROXY_RUNTIME_FILE)) fs.unlinkSync(PROXY_RUNTIME_FILE);
  } catch { /* best effort */ }
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkProxyHealthEndpoint(endpoint, token, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!endpoint || !Number.isFinite(endpoint.port) || !token) {
      resolve({ ok: false, endpoint });
      return;
    }
    const protocol = endpoint.protocol === 'https' ? 'https' : 'http';
    const client = protocol === 'https' ? https : http;
    const req = client.get({
      hostname: '127.0.0.1',
      port: endpoint.port,
      path: '/health',
      timeout: timeoutMs,
      headers: { Authorization: `Bearer ${token}` },
      ...(protocol === 'https' ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += String(chunk); });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        resolve({
          ok: res.statusCode === 200,
          statusCode: res.statusCode,
          endpoint: { ...endpoint, protocol },
          runtime: parsed && typeof parsed === 'object' ? parsed.runtime || null : null,
        });
      });
    });
    req.on('error', () => resolve({ ok: false, endpoint: { ...endpoint, protocol } }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, endpoint: { ...endpoint, protocol }, timeout: true });
    });
  });
}

function collectHealthCandidates(startOptions = {}, runtime = null, runtimeStatus = null) {
  const out = [];
  const seen = new Set();
  const pushEndpoint = (protocol, port) => {
    if (!Number.isFinite(port) || port <= 0) return;
    const key = `${protocol}:${port}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ protocol, port });
  };

  if (startOptions.httpsEnabled && Number.isFinite(startOptions.httpsPort)) pushEndpoint('https', startOptions.httpsPort);
  if (startOptions.httpEnabled && Number.isFinite(startOptions.port)) pushEndpoint('http', startOptions.port);

  if (runtime) {
    if (Number.isFinite(runtime.httpsPort)) pushEndpoint('https', runtime.httpsPort);
    if (Number.isFinite(runtime.httpPort)) pushEndpoint('http', runtime.httpPort);
    if (!Number.isFinite(runtime.httpPort) && Number.isFinite(runtime.port)) pushEndpoint('http', runtime.port);
  }

  if (runtimeStatus && typeof runtimeStatus === 'object') {
    if (runtimeStatus.https?.enabled && Number.isFinite(runtimeStatus.https.port)) pushEndpoint('https', runtimeStatus.https.port);
    if (runtimeStatus.http?.enabled && Number.isFinite(runtimeStatus.http.port)) pushEndpoint('http', runtimeStatus.http.port);
  }

  return out;
}

async function getProxyRuntimeStatus(proxy, options = {}) {
  const runtime = loadProxyRuntime();
  const auth = proxy.getAuthStatus();
  const startOptions = buildProxyStartOptions(options, proxy);
  const runtimeStatus = proxy.getRuntimeStatus ? proxy.getRuntimeStatus() : null;
  const candidates = collectHealthCandidates(startOptions, runtime, runtimeStatus);
  let healthyCheck = null;
  for (const endpoint of candidates) {
    const result = await checkProxyHealthEndpoint(endpoint, auth.authToken);
    if (result.ok) {
      healthyCheck = result;
      break;
    }
  }

  const healthy = !!healthyCheck;
  const activeRuntime = healthyCheck?.runtime || runtimeStatus || null;
  const pidAlive = runtime?.pid ? isProcessAlive(runtime.pid) : false;
  return {
    runtime,
    auth,
    healthy,
    pidAlive,
    endpoint: healthyCheck?.endpoint || null,
    runtimeStatus: activeRuntime,
    candidates,
  };
}

async function ensureProxyDaemonRunning(proxy, options = {}) {
  const startOptions = buildProxyStartOptions(options, proxy);
  const current = await getProxyRuntimeStatus(proxy, startOptions);
  if (current.healthy) {
    return {
      started: false,
      auth: current.auth,
      runtime: current.runtime,
      runtimeStatus: current.runtimeStatus,
      endpoint: current.endpoint,
    };
  }

  const child = spawn(process.execPath, buildProxyDaemonArgs(startOptions), {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  saveProxyRuntime({
    pid: child.pid,
    port: startOptions.port,
    httpPort: startOptions.httpEnabled ? startOptions.port : null,
    httpsPort: startOptions.httpsEnabled ? startOptions.httpsPort : null,
    httpsEnabled: !!startOptions.httpsEnabled,
    httpsOnly: !!startOptions.httpsOnly,
    host: startOptions.host || '127.0.0.1',
    startedAt: new Date().toISOString(),
  });

  const maxAttempts = 35;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 200));
    const latest = await getProxyRuntimeStatus(proxy, startOptions);
    if (latest.healthy) {
      return {
        started: true,
        auth: latest.auth,
        runtime: latest.runtime,
        runtimeStatus: latest.runtimeStatus,
        endpoint: latest.endpoint,
      };
    }
    if (!isProcessAlive(child.pid)) {
      clearProxyRuntime();
      throw new Error('代理进程启动后异常退出');
    }
  }

  clearProxyRuntime();
  throw new Error('代理启动超时，请检查端口占用或查看日志');
}

function getRuntimeForDisplay(runtimeStatus = null, fallbackPort = 9100) {
  if (runtimeStatus && typeof runtimeStatus === 'object') return runtimeStatus;
  return {
    mode: 'http-only',
    host: '127.0.0.1',
    http: { enabled: true, port: fallbackPort, host: '127.0.0.1', url: `http://127.0.0.1:${fallbackPort}` },
    https: { enabled: false, port: null, host: '127.0.0.1', url: '', certSource: '', certFile: '', keyFile: '' },
  };
}

function getPreferredBase(runtimeStatus = null, fallbackPort = 9100) {
  const runtime = getRuntimeForDisplay(runtimeStatus, fallbackPort);
  if (runtime.https?.enabled && runtime.https?.url) {
    return { protocol: 'https', base: runtime.https.url, runtime };
  }
  if (runtime.http?.enabled && runtime.http?.url) {
    return { protocol: 'http', base: runtime.http.url, runtime };
  }
  return { protocol: 'http', base: `http://127.0.0.1:${fallbackPort}`, runtime };
}

function printClientConnectGuide(token, runtimeStatus = null, label = '') {
  const cleanLabel = String(label || '').trim();
  const preferred = getPreferredBase(runtimeStatus, 9100);
  const runtime = preferred.runtime;
  const baseAnthropic = preferred.base;
  const baseOpenAI = `${preferred.base}/v1`;
  const httpBase = runtime.http?.enabled ? runtime.http.url : '';
  const httpsBase = runtime.https?.enabled ? runtime.https.url : '';
  console.log('');
  console.log(`  ${chalk.cyan.bold('客户接入参数')}${cleanLabel ? chalk.dim(` (${cleanLabel})`) : ''}`);
  console.log('');
  if (httpsBase) console.log(`  ${chalk.gray('HTTPS BaseURL:')}    ${chalk.cyan(httpsBase)}`);
  if (httpBase) console.log(`  ${chalk.gray('HTTP BaseURL:')}     ${chalk.cyan(httpBase)}`);
  console.log(`  ${chalk.gray('OpenAI BaseURL:')}   ${chalk.cyan(baseOpenAI)}`);
  console.log(`  ${chalk.gray('Anthropic BaseURL:')} ${chalk.cyan(baseAnthropic)}`);
  console.log(`  ${chalk.gray('Token:')}            ${chalk.yellow(token)}`);
  console.log('');
  console.log(chalk.dim('  Claude Code 示例:'));
  console.log(chalk.dim(`    ANTHROPIC_BASE_URL=${baseAnthropic}`));
  console.log(chalk.dim(`    ANTHROPIC_API_KEY=${token}`));
  console.log(chalk.dim('  Trae / OpenAI SDK 示例:'));
  console.log(chalk.dim(`    OPENAI_BASE_URL=${baseOpenAI}`));
  console.log(chalk.dim(`    OPENAI_API_KEY=${token}`));
  if (httpsBase) {
    console.log(chalk.dim('  HTTPS 自签名证书提示:'));
    console.log(chalk.dim('    生产环境建议导入系统信任链；临时调试可设置 NODE_TLS_REJECT_UNAUTHORIZED=0'));
  }
  console.log('');
}

function printProxyHelp() {
  console.log('');
  console.log(`  ${chalk.cyan.bold('Proxy 常用命令 (精简)')}`);
  console.log('');
  console.log(chalk.white('  proxy quickstart') + chalk.dim('               一键启动并显示接入参数'));
  console.log(chalk.white('  proxy client add <客户名> [token]') + chalk.dim('  创建客户 token (自动 khy- 前缀)'));
  console.log(chalk.white('  proxy client list') + chalk.dim('                查看客户 token 列表'));
  console.log(chalk.white('  proxy client rotate <token_id>') + chalk.dim('   轮换某客户 token'));
  console.log(chalk.white('  proxy status') + chalk.dim('                     查看运行与鉴权状态'));
  console.log(chalk.white('  proxy core install') + chalk.dim('               下载安装代理内核 mihomo (proxy core status 查看去哪下)'));
  console.log(chalk.white('  proxy cert generate') + chalk.dim('              一键生成本地 HTTPS 自签名证书'));
  console.log(chalk.white('  proxy switch-center ...') + chalk.dim('          统一管理 Trae/Windsurf 模型代理切换'));
  console.log(chalk.white('  proxy subscription ...') + chalk.dim('           VPN/Clash 订阅管理与应用'));
  console.log('');
  console.log(chalk.dim('  高级命令:'));
  console.log(chalk.dim('    proxy trae-switch ... / proxy windsurf-switch ...  兼容旧命令（建议迁移到 switch-center）'));
  console.log(chalk.dim('    proxy token ...      兼容旧 token 管理命令'));
  console.log(chalk.dim('    proxy tls ...        TLS 指纹代理'));
  console.log(chalk.dim('    proxy cursor2api ... cursor2api 集成'));
  console.log(chalk.dim('  HTTPS 启动参数:'));
  console.log(chalk.dim('    --https --https-port 9443 --tls-cert /path/server.crt --tls-key /path/server.key'));
  console.log(chalk.dim('    若只传 --https，系统会自动在 ~/.khyquant/proxy_certs 生成并复用证书'));
  console.log(chalk.dim('  智能代理路由(环境变量):'));
  console.log(chalk.dim('    GATEWAY_PROXY_ROUTE_MODE=auto|always|direct'));
  console.log(chalk.dim('    KIRO_DISCOVERY_REQUIRE_PROXY=true  # Kiro 模型发现阶段强制走代理'));
  console.log('');
}

function printRuntimeEndpoints(runtimeStatus = null) {
  const runtime = getRuntimeForDisplay(runtimeStatus, 9100);
  if (runtime.http?.enabled) {
    const host = runtime.http.url || `http://${runtime.http.host || '127.0.0.1'}:${runtime.http.port}`;
    console.log(`  ${chalk.gray('HTTP Chat:')}   ${chalk.cyan(`${host}/v1/chat/completions`)}`);
    console.log(`  ${chalk.gray('HTTP Models:')} ${chalk.cyan(`${host}/v1/models`)}`);
    console.log(`  ${chalk.gray('HTTP Health:')} ${chalk.cyan(`${host}/health`)}`);
  }
  if (runtime.https?.enabled) {
    const host = runtime.https.url || `https://${runtime.https.host || '127.0.0.1'}:${runtime.https.port}`;
    console.log(`  ${chalk.gray('HTTPS Chat:')}   ${chalk.cyan(`${host}/v1/chat/completions`)}`);
    console.log(`  ${chalk.gray('HTTPS Models:')} ${chalk.cyan(`${host}/v1/models`)}`);
    console.log(`  ${chalk.gray('HTTPS Health:')} ${chalk.cyan(`${host}/health`)}`);
    if (runtime.https.certSource) {
      console.log(`  ${chalk.gray('HTTPS Cert:')} ${chalk.cyan(runtime.https.certSource)}`);
    }
  }
}

async function handleProxyCert(action = 'generate', args = [], options = {}) {
  const sub = String(action || 'generate').toLowerCase();
  if (sub === 'help') {
    console.log('');
    console.log(chalk.cyan.bold('  proxy cert 命令'));
    console.log('');
    console.log(chalk.dim('  proxy cert generate [--force] [--tls-dir <dir>] [--tls-cert <cert>] [--tls-key <key>]'));
    console.log(chalk.dim('  proxy cert status'));
    console.log('');
    return;
  }

  if (sub === 'status' || sub === 'show' || sub === 'path') {
    const { certFile, keyFile } = resolveTlsFiles(options);
    const certExists = fs.existsSync(certFile);
    const keyExists = fs.existsSync(keyFile);
    console.log('');
    console.log(chalk.cyan.bold('  HTTPS 证书状态'));
    console.log('');
    console.log(`  ${chalk.gray('Cert:')} ${chalk.cyan(certFile)} ${certExists ? chalk.green('(exists)') : chalk.yellow('(missing)')}`);
    console.log(`  ${chalk.gray('Key:')}  ${chalk.cyan(keyFile)} ${keyExists ? chalk.green('(exists)') : chalk.yellow('(missing)')}`);
    console.log('');
    return;
  }

  if (!['generate', 'gen', 'create', 'new'].includes(sub)) {
    printError(`未知 cert 子命令: ${action}`);
    printInfo('用法: proxy cert generate | proxy cert status');
    return;
  }

  try {
    const days = parsePositiveInt(options['tls-days'] || options.days || args[0], 825);
    const force = parseBooleanMaybe(options.force, false);
    const cn = String(options.cn || options['tls-cn'] || 'localhost').trim() || 'localhost';
    const { certFile, keyFile } = resolveTlsFiles(options);
    const generated = generateSelfSignedCert({
      certFile,
      keyFile,
      cn,
      days,
      force,
    });

    if (generated.generated) printSuccess('HTTPS 自签名证书已生成');
    else printInfo('已复用现有 HTTPS 证书');
    console.log(`  ${chalk.gray('Cert:')} ${chalk.cyan(generated.certFile)}`);
    console.log(`  ${chalk.gray('Key:')}  ${chalk.cyan(generated.keyFile)}`);
    console.log(`  ${chalk.gray('CN:')}   ${chalk.cyan(generated.cn || sanitizeCommonName(cn))}`);
    console.log(`  ${chalk.gray('Days:')} ${chalk.cyan(String(generated.days || days))}`);
    console.log('');
    console.log(chalk.dim(`  启动示例: proxy start --https --tls-cert "${generated.certFile}" --tls-key "${generated.keyFile}"`));
    console.log('');
  } catch (err) {
    printError(`证书生成失败: ${err.message}`);
  }
}

async function handleProxyStart(options = {}) {
  const proxy = getProxy();
  try {
    if (proxy.isRunning()) {
      const runtimeStatus = proxy.getRuntimeStatus ? proxy.getRuntimeStatus() : null;
      const preferred = getPreferredBase(runtimeStatus, proxy.getPort());
      printInfo(`代理服务已在运行: ${preferred.base}`);
      return;
    }
    const before = await getProxyRuntimeStatus(proxy, options);
    if (before.healthy) {
      const preferred = getPreferredBase(before.runtimeStatus, proxy.getPort());
      printInfo(`代理服务已在运行: ${preferred.base}`);
      return;
    }
    const prepared = ensureHttpsTlsOptions(options);
    const runtime = await ensureProxyDaemonRunning(proxy, prepared.options);
    const runtimeStatus = runtime.runtimeStatus || (proxy.getRuntimeStatus ? proxy.getRuntimeStatus() : null);
    const preferred = getPreferredBase(runtimeStatus, proxy.getPort());
    console.log('');
    printSuccess(runtime.started ? '反向代理已启动' : '反向代理已在运行');
    console.log('');
    console.log(`  ${chalk.gray('推荐入口:')} ${chalk.cyan(preferred.base)}`);
    printRuntimeEndpoints(runtimeStatus);
    console.log(`  ${chalk.gray('Store:')}  ${chalk.cyan(`${preferred.base}/reservoir/stats`)}`);
    console.log(`  ${chalk.gray('Auth:')}   ${chalk.cyan(runtime.auth.authTokenMasked)} ${chalk.dim(`(${runtime.auth.source || 'unknown'})`)}`);
    if (runtime.started && runtime.auth.generated && runtime.auth.authToken) {
      console.log(`  ${chalk.gray('Token:')}  ${chalk.yellow(runtime.auth.authToken)}`);
    }
    console.log('');
    console.log(chalk.dim('  鉴权: Authorization: Bearer <khy-...>'));
    console.log(chalk.dim('  常用管理: proxy quickstart | proxy client add <客户名> | proxy client list'));
    console.log(chalk.dim('  更多命令: proxy help'));
    if (runtime.auth.authToken) {
      printClientConnectGuide(runtime.auth.authToken, runtimeStatus, '主 Token');
    }
    console.log('');
  } catch (err) {
    printError(`启动失败: ${err.message}`);
  }
}

async function handleProxyStop() {
  const proxy = getProxy();
  if (proxy.isRunning()) {
    await proxy.stop();
    clearProxyRuntime();
    printSuccess('反向代理已停止');
    return;
  }

  const runtime = loadProxyRuntime();
  if (!runtime?.pid || !isProcessAlive(runtime.pid)) {
    clearProxyRuntime();
    printInfo('代理服务未运行');
    return;
  }

  const { safeSignal } = require('../../tools/platformUtils');
  try {
    safeSignal(runtime.pid, 'SIGTERM');
  } catch {
    clearProxyRuntime();
    printInfo('代理服务未运行');
    return;
  }

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (!isProcessAlive(runtime.pid)) break;
    const status = await getProxyRuntimeStatus(proxy);
    if (!status.healthy) break;
  }
  clearProxyRuntime();
  printSuccess('反向代理已停止');
}

async function handleProxyStatus() {
  const proxy = getProxy();
  const status = await getProxyRuntimeStatus(proxy);
  const runtimeStatus = status.runtimeStatus || (proxy.getRuntimeStatus ? proxy.getRuntimeStatus() : null);
  const preferred = getPreferredBase(runtimeStatus, proxy.getPort());
  const proxyConfigFile = path.join(os.homedir(), '.khyquant', 'proxy.json');
  const routeMode = String(process.env.GATEWAY_PROXY_ROUTE_MODE || 'auto').trim().toLowerCase() || 'auto';
  const kiroRequireProxy = parseBooleanMaybe(
    process.env.KIRO_DISCOVERY_REQUIRE_PROXY ?? process.env.KIRO_REQUIRE_PROXY_FOR_DISCOVERY,
    false
  );

  if (proxy.isRunning() || status.healthy) {
    printSuccess(`反向代理运行中: ${preferred.base}`);
  } else if (status.pidAlive) {
    printInfo(`反向代理进程存在但未就绪 (PID: ${status.runtime?.pid})`);
  } else {
    printInfo('反向代理未运行 — 使用 proxy start 启动');
  }
  printRuntimeEndpoints(runtimeStatus);
  console.log(`  ${chalk.gray('鉴权:')} ${chalk.cyan(status.auth.authTokenMasked)} ${chalk.dim(`(${status.auth.source})`)}`);
  console.log(`  ${chalk.gray('Token数:')} ${status.auth.tokenCount}`);
  console.log(`  ${chalk.gray('客户Token:')} ${status.auth.managedTokenEnabledCount}/${status.auth.managedTokenCount} (启用/总数)`);
  if (runtimeStatus?.mode) {
    console.log(`  ${chalk.gray('模式:')} ${runtimeStatus.mode}`);
  }
  if (status.runtime?.pid) {
    console.log(`  ${chalk.gray('PID:')} ${status.runtime.pid}`);
  }
  if (status.auth.source === 'env') {
    printInfo('当前 token 来源于环境变量 PROXY_AUTH_TOKEN，set/rotate 仅修改本地持久化 token。');
  }
  console.log(`  ${chalk.gray('代理配置:')} ${chalk.cyan(proxyConfigFile)}`);
  console.log(`  ${chalk.gray('智能路由:')} ${chalk.cyan(`GATEWAY_PROXY_ROUTE_MODE=${routeMode}`)} ${chalk.dim('(auto=国外优先代理, 国内直连)')}`);
  if (kiroRequireProxy) {
    console.log(`  ${chalk.gray('Kiro发现:')} ${chalk.cyan('KIRO_DISCOVERY_REQUIRE_PROXY=true')} ${chalk.dim('(模型发现阶段强制代理)')}`);
  }
  console.log(chalk.dim('  常用: proxy client add <客户名> | proxy client list | proxy client rotate <token_id>'));
}

async function handleProxyQuickstart(args = [], options = {}) {
  const proxy = getProxy();
  const customerName = String(args[0] || options.client || options.label || '').trim();
  try {
    const startOptions = buildProxyStartOptions(options, proxy);
    const before = await getProxyRuntimeStatus(proxy, startOptions);
    const prepared = before.healthy ? { options: startOptions } : ensureHttpsTlsOptions(startOptions);
    const run = proxy.isRunning()
      ? {
        started: false,
        auth: proxy.getAuthStatus(),
        runtime: loadProxyRuntime(),
        runtimeStatus: proxy.getRuntimeStatus ? proxy.getRuntimeStatus() : null,
      }
      : await ensureProxyDaemonRunning(proxy, prepared.options);
    const auth = run.auth;
    const runtimeStatus = run.runtimeStatus || (proxy.getRuntimeStatus ? proxy.getRuntimeStatus() : null);
    const preferred = getPreferredBase(runtimeStatus, proxy.getPort());

    if (run.started) printSuccess(`反向代理已启动: ${preferred.base}`);
    else printInfo(`反向代理已在运行: ${preferred.base}`);
    printRuntimeEndpoints(runtimeStatus);

    console.log(`  ${chalk.gray('主Token:')} ${chalk.cyan(auth.authTokenMasked)} ${chalk.dim(`(${auth.source})`)}`);
    console.log(`  ${chalk.gray('客户Token:')} ${auth.managedTokenEnabledCount}/${auth.managedTokenCount} (启用/总数)`);

    if (customerName) {
      const customToken = String(options.token || options.value || '').trim();
      const created = proxy.createManagedToken({
        label: customerName,
        token: customToken,
        enabled: true,
      });
      printSuccess(`已为客户创建 token: ${created.id}`);
      printClientConnectGuide(created.token, runtimeStatus, created.label || customerName);
      return;
    }

    if (auth.authToken) {
      printClientConnectGuide(auth.authToken, runtimeStatus, '主 Token');
    }

    console.log('');
    console.log(chalk.dim('  下一步 (总负责人常用):'));
    console.log(chalk.dim('    proxy client add <客户名>      # 发放客户 token'));
    console.log(chalk.dim('    proxy client list              # 查看/管理 token'));
    console.log(chalk.dim('    proxy client rotate <token_id> # 泄露时一键轮换'));
    console.log('');
  } catch (err) {
    printError(`quickstart 失败: ${err.message}`);
  }
}

async function handleProxyClient(action = 'list', args = [], options = {}) {
  const proxy = getProxy();
  const sub = String(action || 'list').toLowerCase();

  if (sub === 'help') {
    console.log('');
    console.log(chalk.cyan.bold('  客户 token 管理'));
    console.log('');
    console.log(chalk.dim('  proxy client add <客户名> [token]'));
    console.log(chalk.dim('  proxy client list'));
    console.log(chalk.dim('  proxy client rotate <token_id> [new_token]'));
    console.log(chalk.dim('  proxy client on|off <token_id>'));
    console.log(chalk.dim('  proxy client del <token_id>'));
    console.log('');
    return;
  }

  if (sub === 'add' || sub === 'create' || sub === 'new' || sub === 'issue') {
    const label = String(args[0] || options.label || '').trim();
    const rawToken = String(args[1] || options.token || options.value || '').trim();
    if (!label) {
      printError('用法: proxy client add <客户名> [token]');
      return;
    }
    try {
      const created = proxy.createManagedToken({ label, token: rawToken, enabled: true });
      const runtimeStatus = proxy.getRuntimeStatus ? proxy.getRuntimeStatus() : null;
      printSuccess(`客户 token 已创建: ${created.id}`);
      printClientConnectGuide(created.token, runtimeStatus, created.label || label);
    } catch (err) {
      printError(`创建客户 token 失败: ${err.message}`);
    }
    return;
  }

  if (sub === 'rotate' || sub === 'refresh') {
    const tokenId = String(args[0] || options.id || '').trim();
    const nextToken = String(args[1] || options.token || options.value || '').trim();
    if (!tokenId) {
      printError('用法: proxy client rotate <token_id> [new_token]');
      return;
    }
    try {
      const rotated = proxy.rotateManagedToken(tokenId, nextToken);
      const runtimeStatus = proxy.getRuntimeStatus ? proxy.getRuntimeStatus() : null;
      printSuccess(`客户 token 已轮换: ${rotated.id}`);
      printClientConnectGuide(rotated.token, runtimeStatus, rotated.label || '');
    } catch (err) {
      printError(`轮换客户 token 失败: ${err.message}`);
    }
    return;
  }

  if (sub === 'on' || sub === 'enable' || sub === 'off' || sub === 'disable') {
    const tokenId = String(args[0] || options.id || '').trim();
    if (!tokenId) {
      printError(`用法: proxy client ${sub === 'on' || sub === 'enable' ? 'on' : 'off'} <token_id>`);
      return;
    }
    try {
      const enabled = sub === 'on' || sub === 'enable';
      const updated = proxy.setManagedTokenEnabled(tokenId, enabled);
      printSuccess(`客户 token 已${updated.enabled ? '启用' : '禁用'}: ${updated.id}`);
      console.log(`  ${chalk.gray('客户:')} ${chalk.cyan(updated.label || '-')}`);
      console.log(`  ${chalk.gray('掩码:')} ${chalk.cyan(updated.tokenMasked)}`);
    } catch (err) {
      printError(`更新客户 token 状态失败: ${err.message}`);
    }
    return;
  }

  if (sub === 'del' || sub === 'delete' || sub === 'remove' || sub === 'revoke') {
    const tokenId = String(args[0] || options.id || '').trim();
    if (!tokenId) {
      printError('用法: proxy client del <token_id>');
      return;
    }
    try {
      const removed = proxy.deleteManagedToken(tokenId);
      printSuccess(`客户 token 已删除: ${removed.id}`);
      console.log(`  ${chalk.gray('客户:')} ${chalk.cyan(removed.label || '-')}`);
      console.log(`  ${chalk.gray('掩码:')} ${chalk.cyan(removed.tokenMasked)}`);
    } catch (err) {
      printError(`删除客户 token 失败: ${err.message}`);
    }
    return;
  }

  // default list
  const list = proxy.listManagedTokens();
  console.log('');
  console.log(`  ${chalk.cyan.bold('客户 Token 列表')}`);
  console.log('');
  if (!list.length) {
    printInfo('暂无客户 token，可用 proxy client add <客户名> 创建');
    console.log('');
    return;
  }
  for (const row of list) {
    const state = row.enabled ? chalk.green('启用') : chalk.yellow('禁用');
    console.log(`  ${chalk.white(row.id)}  ${state}  ${chalk.cyan(row.label || '-')}`);
    console.log(`    ${chalk.dim(row.tokenMasked)}  ${chalk.dim(`updated ${row.updatedAt || '-'}`)}`);
  }
  console.log('');
  console.log(chalk.dim('  常用: proxy client rotate <token_id> | proxy client off <token_id>'));
  console.log('');
}

async function handleProxyToken(action = 'status', args = [], options = {}) {
  const proxy = getProxy();
  const sub = String(action || 'status').toLowerCase();

  if (sub === 'set') {
    const rawToken = String(args[0] || options.value || options.token || '').trim();
    if (!rawToken) {
      printError('用法: proxy token set <token>');
      return;
    }
    try {
      const result = proxy.setAuthToken(rawToken);
      printSuccess('主代理 token 已设置');
      console.log(`  ${chalk.gray('Token:')} ${chalk.yellow(result.authToken)}`);
      console.log(`  ${chalk.gray('掩码:')}  ${chalk.cyan(result.authTokenMasked)}`);
      printInfo('已自动使用 khy- 前缀；若代理正在运行，请重启生效。');
    } catch (err) {
      printError(`设置 token 失败: ${err.message}`);
    }
    return;
  }

  if (sub === 'rotate') {
    const result = proxy.rotateAuthToken();
    printSuccess('主代理 token 已轮换');
    console.log(`  ${chalk.gray('新 Token:')} ${chalk.yellow(result.authToken)}`);
    console.log(`  ${chalk.gray('掩码:')}     ${chalk.cyan(result.authTokenMasked)}`);
    printInfo('若代理正在运行，请重启生效。');
    return;
  }

  if (sub === 'create' || sub === 'add') {
    const label = String(args[0] || options.label || '').trim();
    const rawToken = String(args[1] || options.value || options.token || '').trim();
    if (!label) {
      printError('用法: proxy token create <客户标识> [token]');
      return;
    }
    try {
      const created = proxy.createManagedToken({ label, token: rawToken, enabled: true });
      printSuccess(`客户 token 已创建: ${created.id}`);
      console.log(`  ${chalk.gray('客户:')}   ${chalk.cyan(created.label || '-')}`);
      console.log(`  ${chalk.gray('Token:')} ${chalk.yellow(created.token)}`);
      console.log(`  ${chalk.gray('掩码:')}  ${chalk.cyan(created.tokenMasked)}`);
      printInfo('已自动使用 khy- 前缀。');
      printInfo('当前运行中的代理可立即识别新 token。');
    } catch (err) {
      printError(`创建客户 token 失败: ${err.message}`);
    }
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const tokenId = String(args[0] || options.id || '').trim();
    if (!tokenId) {
      printError(`用法: proxy token ${sub} <token_id>`);
      return;
    }
    try {
      const updated = proxy.setManagedTokenEnabled(tokenId, sub === 'enable');
      printSuccess(`客户 token 已${updated.enabled ? '启用' : '禁用'}: ${updated.id}`);
      console.log(`  ${chalk.gray('客户:')} ${chalk.cyan(updated.label || '-')}`);
      console.log(`  ${chalk.gray('掩码:')} ${chalk.cyan(updated.tokenMasked)}`);
    } catch (err) {
      printError(`更新 token 状态失败: ${err.message}`);
    }
    return;
  }

  if (sub === 'delete' || sub === 'remove' || sub === 'revoke') {
    const tokenId = String(args[0] || options.id || '').trim();
    if (!tokenId) {
      printError('用法: proxy token delete <token_id>');
      return;
    }
    try {
      const removed = proxy.deleteManagedToken(tokenId);
      printSuccess(`客户 token 已删除: ${removed.id}`);
      console.log(`  ${chalk.gray('客户:')} ${chalk.cyan(removed.label || '-')}`);
      console.log(`  ${chalk.gray('掩码:')} ${chalk.cyan(removed.tokenMasked)}`);
    } catch (err) {
      printError(`删除 token 失败: ${err.message}`);
    }
    return;
  }

  if (sub === 'rotate-client' || sub === 'rotate-customer') {
    const tokenId = String(args[0] || options.id || '').trim();
    const customToken = String(args[1] || options.value || options.token || '').trim();
    if (!tokenId) {
      printError('用法: proxy token rotate-client <token_id> [new_token]');
      return;
    }
    try {
      const rotated = proxy.rotateManagedToken(tokenId, customToken);
      printSuccess(`客户 token 已轮换: ${rotated.id}`);
      console.log(`  ${chalk.gray('客户:')}    ${chalk.cyan(rotated.label || '-')}`);
      console.log(`  ${chalk.gray('新 Token:')} ${chalk.yellow(rotated.token)}`);
      console.log(`  ${chalk.gray('掩码:')}    ${chalk.cyan(rotated.tokenMasked)}`);
    } catch (err) {
      printError(`轮换客户 token 失败: ${err.message}`);
    }
    return;
  }

  if (sub === 'list') {
    const list = proxy.listManagedTokens();
    console.log('');
    console.log(`  ${chalk.cyan.bold('客户 Token 列表')}`);
    console.log('');
    if (!list.length) {
      printInfo('暂无客户 token，可用 proxy token create <客户标识> 创建');
      console.log('');
      return;
    }
    for (const row of list) {
      const state = row.enabled ? chalk.green('启用') : chalk.yellow('禁用');
      console.log(`  ${chalk.white(row.id)}  ${state}  ${chalk.cyan(row.label || '-')}`);
      console.log(`    ${chalk.dim(row.tokenMasked)}  ${chalk.dim(`updated ${row.updatedAt || '-'}`)}`);
    }
    console.log('');
    return;
  }

  const status = proxy.getAuthStatus();
  console.log('');
  console.log(`  ${chalk.cyan.bold('主代理 Token 状态')}`);
  console.log('');
  console.log(`  ${chalk.gray('来源:')}   ${status.source}${status.generated ? chalk.yellow(' (首次自动生成)') : ''}`);
  console.log(`  ${chalk.gray('掩码:')}   ${chalk.cyan(status.authTokenMasked)}`);
  console.log(`  ${chalk.gray('Token:')}  ${chalk.yellow(status.authToken)}`);
  console.log(`  ${chalk.gray('Token数:')} ${status.tokenCount}`);
  console.log(`  ${chalk.gray('客户Token:')} ${status.managedTokenEnabledCount}/${status.managedTokenCount} (启用/总数)`);
  console.log('');
  console.log(chalk.dim('  推荐使用简化命令:'));
  console.log(chalk.dim('    proxy client add <客户名> [token]'));
  console.log(chalk.dim('    proxy client list'));
  console.log(chalk.dim('    proxy client rotate <token_id> [new_token]'));
  console.log(chalk.dim('    proxy client on|off <token_id>'));
  console.log(chalk.dim('  兼容旧命令: proxy token set|rotate|create|list|enable|disable|rotate-client|delete'));
  console.log(chalk.dim('  备注: token 会自动补全 khy- 前缀'));
  console.log('');
}

async function handleProxySubscription(action = 'list', args = [], options = {}) {
  const proxyConfig = require('../../services/proxyConfigService');
  const sub = String(action || 'list').trim().toLowerCase();

  if (sub === 'help') {
    console.log('');
    console.log(chalk.cyan.bold('  proxy subscription 命令'));
    console.log('');
    console.log(chalk.dim('  proxy subscription list'));
    console.log(chalk.dim('  proxy subscription add <url> [name]'));
    console.log(chalk.dim('  proxy subscription import <url> [name]'));
    console.log(chalk.dim('  proxy subscription remove <id|name|url>'));
    console.log(chalk.dim('  proxy subscription use <id|name|url>'));
    console.log(chalk.dim('  proxy subscription refresh [id|name|url] [--timeout 12000]'));
    console.log(chalk.dim('  proxy subscription apply [id|name|url] [--timeout 12000]'));
    console.log('');
    return;
  }

  if (sub === 'add' || sub === 'new' || sub === 'create' || sub === 'import') {
    const url = String(args[0] || options.url || '').trim();
    const name = String(args[1] || options.name || '').trim();
    if (!url) {
      printError('用法: proxy subscription add|import <url> [name]');
      return;
    }
    const result = proxyConfig.addSubscription(url, name);
    if (!result.success) {
      printError(result.error || '添加订阅失败');
      return;
    }
    printSuccess(`${result.created ? '已添加' : '已更新'}订阅: ${result.subscription.name}`);
    console.log(`  ${chalk.gray('ID:')} ${chalk.cyan(result.subscription.id)}`);
    console.log(`  ${chalk.gray('URL:')} ${chalk.cyan(result.subscription.url)}`);
    if (result.subscription.sourceUrl && result.subscription.sourceUrl !== result.subscription.url) {
      console.log(`  ${chalk.gray('原始链接:')} ${chalk.dim(result.subscription.sourceUrl)}`);
    }
    return;
  }

  if (sub === 'remove' || sub === 'delete' || sub === 'del') {
    const query = String(args[0] || options.id || options.name || options.url || '').trim();
    if (!query) {
      printError('用法: proxy subscription remove <id|name|url>');
      return;
    }
    const result = proxyConfig.removeSubscription(query);
    if (!result.success) {
      printError(result.error || '删除订阅失败');
      return;
    }
    printSuccess(`已删除订阅: ${result.removed.name} (${result.removed.id})`);
    return;
  }

  if (sub === 'use' || sub === 'activate' || sub === 'active') {
    const query = String(args[0] || options.id || options.name || options.url || '').trim();
    if (!query) {
      printError('用法: proxy subscription use <id|name|url>');
      return;
    }
    const result = proxyConfig.setActiveSubscription(query);
    if (!result.success) {
      printError(result.error || '设置激活订阅失败');
      return;
    }
    printSuccess(`已激活订阅: ${result.active.name} (${result.active.id})`);
    return;
  }

  if (sub === 'refresh' || sub === 'check' || sub === 'test') {
    const query = String(args[0] || options.id || options.name || options.url || '').trim();
    const timeout = parsePositiveInt(options.timeout || options['timeout-ms'], 12000);
    const result = await proxyConfig.refreshSubscription(query, { timeout, apply: false });
    if (!result.success) {
      printError(`订阅刷新失败: ${result.error}`);
      return;
    }
    const hints = result.hints || {};
    printSuccess(`订阅刷新成功: ${result.subscription.name}`);
    if (hints.format) {
      console.log(`  ${chalk.gray('订阅格式:')} ${chalk.cyan(hints.format)}`);
    }
    if (Number.isFinite(hints.nodeCount) && hints.nodeCount > 0) {
      console.log(`  ${chalk.gray('节点数量:')} ${chalk.cyan(String(hints.nodeCount))}`);
    }
    if (hints.proxy) {
      console.log(`  ${chalk.gray('检测到代理:')} ${chalk.cyan(`${hints.proxy.type}://${hints.proxy.host}:${hints.proxy.port}`)}`);
    } else {
      printInfo('订阅已解析，但未包含本地端口（常见于 vmess/vless 节点订阅）');
    }
    return;
  }

  if (sub === 'apply' || sub === 'sync') {
    const query = String(args[0] || options.id || options.name || options.url || '').trim();
    const timeout = parsePositiveInt(options.timeout || options['timeout-ms'], 12000);
    const result = await proxyConfig.applySubscription(query, { timeout });
    if (!result.success) {
      printError(`订阅应用失败: ${result.error}`);
      return;
    }
    printSuccess(`订阅已应用: ${result.subscription.name}`);
    const hints = result.hints || {};
    if (hints.format) console.log(`  ${chalk.gray('订阅格式:')} ${chalk.cyan(hints.format)}`);
    if (Number.isFinite(hints.nodeCount) && hints.nodeCount > 0) {
      console.log(`  ${chalk.gray('节点数量:')} ${chalk.cyan(String(hints.nodeCount))}`);
    }
    if (result.proxy?.url) {
      printInfo(`当前代理: ${result.proxy.url}`);
      if (!hints.proxy) {
        printInfo('未在订阅中找到端口，已自动回退为本机 Clash 端口检测');
      }
    } else {
      printInfo('订阅刷新成功，但未检测到可应用端口（请先启动 Clash/VPN 客户端）');
    }
    return;
  }

  const items = proxyConfig.listSubscriptions();
  const status = proxyConfig.getStatus();
  console.log('');
  console.log(chalk.cyan.bold('  VPN/Clash 订阅列表'));
  console.log('');
  if (!items.length) {
    printInfo('暂无订阅。先执行: proxy subscription add <url> [name]');
    console.log('');
    return;
  }
  for (const item of items) {
    const active = item.id === status.activeSubscriptionId;
    const icon = active ? chalk.green('●') : chalk.dim('○');
    const state = item.lastStatus === 'ok'
      ? chalk.green('ok')
      : (item.lastStatus === 'error' ? chalk.red('error') : chalk.dim('unknown'));
    console.log(`  ${icon} ${chalk.white(item.id)}  ${chalk.cyan(item.name)} ${active ? chalk.green('(active)') : ''}`);
    console.log(`    ${chalk.dim(item.url)}`);
    console.log(`    ${chalk.dim(`status=${state} checked=${item.lastCheckedAt || '-'}`)}`);
    if (item.lastError) console.log(`    ${chalk.dim(`error=${item.lastError}`)}`);
    const detectedProxy = item.detected?.proxy;
    if (detectedProxy?.port) {
      console.log(`    ${chalk.dim(`detected=${detectedProxy.type}://${detectedProxy.host}:${detectedProxy.port}`)}`);
    }
    if (item.detected?.format) {
      const count = Number(item.detected?.nodeCount || 0);
      const countText = count > 0 ? ` nodes=${count}` : '';
      console.log(`    ${chalk.dim(`format=${item.detected.format}${countText}`)}`);
    }
  }
  console.log('');
  printInfo('常用: proxy subscription refresh | proxy subscription apply');
  console.log('');
}

/**
 * TLS Sidecar commands: proxy tls start/stop/status/fingerprint
 */
async function handleProxyTls(action, arg) {
  const sidecar = require('../../services/gateway/tlsSidecar');

  if (action === 'start') {
    if (sidecar.isRunning()) {
      printInfo(`TLS Sidecar 已在运行: ${sidecar.getProxyUrl()}`);
      return;
    }
    try {
      const result = await sidecar.start();
      printSuccess(`TLS Sidecar 已启动 (PID: ${result.pid})`);
      console.log(`  ${chalk.gray('代理地址:')} ${chalk.cyan(sidecar.getProxyUrl())}`);
      console.log(`  ${chalk.gray('指纹:')}     ${chalk.cyan(result.fingerprint)}`);
      console.log('');
      const config = sidecar.loadConfig();
      console.log(chalk.dim(`  目标域名: ${config.targets.join(', ')}`));
      console.log('');
    } catch (err) {
      printError(`TLS Sidecar 启动失败: ${err.message}`);
      if (err.message.includes('binary not available')) {
        printInfo('需要 Go 1.21+ 工具链来编译 sidecar');
        printInfo('安装 Go: https://go.dev/dl/');
      }
    }
  } else if (action === 'stop') {
    if (!sidecar.isRunning()) {
      printInfo('TLS Sidecar 未运行');
      return;
    }
    await sidecar.stop();
    printSuccess('TLS Sidecar 已停止');
  } else if (action === 'fingerprint' && arg) {
    await sidecar.setFingerprint(arg);
    printSuccess(`TLS 指纹已切换为: ${arg}`);
    printInfo('支持: chrome_auto, chrome_120, firefox_auto, firefox_120, safari, random');
  } else {
    // status
    const status = sidecar.getStatus();
    console.log('');
    console.log(`  ${chalk.cyan.bold('TLS Sidecar 状态')}`);
    console.log('');
    console.log(`  ${chalk.gray('运行:')}       ${status.running ? chalk.green('● 是') : chalk.red('● 否')}`);
    console.log(`  ${chalk.gray('已启用:')}     ${status.enabled ? '是' : '否'}`);
    console.log(`  ${chalk.gray('端口:')}       ${status.port}`);
    console.log(`  ${chalk.gray('指纹:')}       ${status.fingerprint}`);
    console.log(`  ${chalk.gray('二进制:')}     ${status.binaryInstalled ? chalk.green('已安装') : chalk.yellow('未安装')}`);
    console.log(`  ${chalk.gray('Go 工具链:')} ${status.goAvailable ? chalk.green('可用') : chalk.yellow('不可用')}`);
    console.log(`  ${chalk.gray('目标域名:')}   ${status.targets.join(', ')}`);
    if (status.pid) console.log(`  ${chalk.gray('PID:')}        ${status.pid}`);
    console.log('');
  }
}

async function handleProxyCursor2Api(action = 'status', args = [], options = {}) {
  const svc = require('../../services/cursor2apiIntegrationService');
  const current = svc.loadConfig();

  if (action && /\.zip$/i.test(action) && args.length === 0) {
    args = [action];
    action = 'setup';
  }

  const zipPath = options.zip || options.file || args[0] || current.zipPath || svc.DEFAULT_ZIP_PATH;
  const port = parsePortMaybe(options.port, current.port);
  const authToken = options.token || options['auth-token'] || current.authToken || '';
  const requireToken = options.open === true
    ? false
    : (options['no-auth'] === true ? false : true);

  if (action === 'setup' || action === 'extract' || action === 'install' || action === 'import') {
    try {
      printInfo('正在提取并准备 cursor2api（可能需要几分钟）...');
      const result = await svc.setupFromZip({
        zipPath,
        port,
        authToken,
        requireToken,
        skipInstall: options['skip-install'] === true,
        skipBuild: options['skip-build'] === true,
      });
      printSuccess(`cursor2api 已准备完成 (${result.version || 'unknown'})`);
      console.log(`  ${chalk.gray('安装目录:')} ${chalk.cyan(result.installDir)}`);
      console.log(`  ${chalk.gray('监听端口:')} ${chalk.cyan(String(result.port))}`);
      console.log(`  ${chalk.gray('入口文件:')} ${chalk.cyan(result.entry)}`);
      console.log(`  ${chalk.gray('鉴权状态:')} ${result.authEnabled ? chalk.green('已启用') : chalk.yellow('未启用')}`);
      console.log(`  ${chalk.gray('鉴权模式:')} ${result.requireToken ? chalk.green('强制鉴权') : chalk.yellow('开放模式')}`);
      if (result.generatedToken) {
        console.log(`  ${chalk.gray('新 Token:')} ${chalk.yellow(result.authToken)}`);
      }
      console.log('');
      printInfo('下一步: proxy cursor2api start');
    } catch (err) {
      printError(`cursor2api 准备失败: ${err.message}`);
    }
    return;
  }

  if (action === 'prepare' || action === 'build') {
    try {
      printInfo('正在检查并安装/构建 cursor2api...');
      const result = await svc.prepareProject({
        port,
        authToken,
        requireToken,
        forceInstall: options['force-install'] === true,
        forceBuild: options['force-build'] === true,
      });
      printSuccess(`cursor2api 依赖与构建完成 (${result.version || 'unknown'})`);
      console.log(`  ${chalk.gray('安装目录:')} ${chalk.cyan(result.installDir)}`);
      console.log(`  ${chalk.gray('构建状态:')} ${result.built ? chalk.green('就绪') : chalk.red('未就绪')}`);
      if (result.generatedToken) {
        console.log(`  ${chalk.gray('新 Token:')} ${chalk.yellow(result.authToken)}`);
      }
    } catch (err) {
      printError(`cursor2api prepare 失败: ${err.message}`);
    }
    return;
  }

  if (action === 'token') {
    const tokenAction = String(args[0] || 'status').toLowerCase();
    if (tokenAction === 'set') {
      const newToken = String(args[1] || options.value || options.token || '').trim();
      if (!newToken) {
        printError('用法: proxy cursor2api token set <token>');
        return;
      }
      try {
        const result = svc.setAuthToken(newToken, { requireToken: true });
        printSuccess('cursor2api token 已设置');
        console.log(`  ${chalk.gray('Token:')} ${chalk.cyan(result.authTokenMasked)}`);
        console.log(`  ${chalk.gray('鉴权模式:')} ${chalk.green('强制鉴权')}`);
        printInfo('重启服务生效: proxy cursor2api stop && proxy cursor2api start');
      } catch (err) {
        printError(`设置 token 失败: ${err.message}`);
      }
      return;
    }
    if (tokenAction === 'rotate') {
      const result = svc.rotateAuthToken();
      printSuccess('cursor2api token 已轮换');
      console.log(`  ${chalk.gray('新 Token:')} ${chalk.yellow(result.authToken)}`);
      printInfo('请保存好 token，重启服务生效');
      return;
    }
    if (tokenAction === 'clear') {
      try {
        svc.setAuthToken('', { requireToken: false });
        printSuccess('已清空 token，并切换为开放模式');
        printInfo('重启服务生效: proxy cursor2api stop && proxy cursor2api start');
      } catch (err) {
        printError(`清空 token 失败: ${err.message}`);
      }
      return;
    }
    const status = svc.loadConfig();
    console.log('');
    console.log(`  ${chalk.cyan.bold('Cursor2API Token 状态')}`);
    console.log('');
    console.log(`  ${chalk.gray('鉴权模式:')} ${status.requireToken ? chalk.green('强制鉴权') : chalk.yellow('开放模式')}`);
    console.log(`  ${chalk.gray('Token:')}   ${chalk.cyan(svc.maskToken(status.authToken))}`);
    console.log('');
    console.log(chalk.dim('  用法: proxy cursor2api token set <token>'));
    console.log(chalk.dim('        proxy cursor2api token rotate'));
    console.log(chalk.dim('        proxy cursor2api token clear'));
    console.log('');
    return;
  }

  if (action === 'start') {
    try {
      const result = await svc.start({ port, authToken, requireToken });
      if (result.alreadyRunning) {
        printInfo(`cursor2api 已在运行: http://localhost:${result.port}`);
      } else {
        printSuccess(`cursor2api 已启动: http://localhost:${result.port}`);
      }

      console.log('');
      console.log(`  ${chalk.gray('Claude Code:')} ${chalk.cyan(`ANTHROPIC_BASE_URL=http://localhost:${result.port}`)}`);
      if (result.authEnabled) {
        console.log(`  ${chalk.gray('Claude Code Key:')} ${chalk.cyan('ANTHROPIC_API_KEY=<你的token>')}`);
      }
      console.log(`  ${chalk.gray('OpenAI/IDE:')} ${chalk.cyan(`OPENAI_BASE_URL=http://localhost:${result.port}/v1`)}`);
      console.log(`  ${chalk.gray('鉴权模式:')} ${result.requireToken ? chalk.green('强制鉴权') : chalk.yellow('开放模式')}`);
      if (result.generatedToken) {
        console.log(`  ${chalk.gray('新 Token:')} ${chalk.yellow(result.authToken)}`);
      }
      console.log(`  ${chalk.gray('日志文件:')} ${chalk.cyan(result.logPath)}`);
      console.log('');
    } catch (err) {
      printError(`cursor2api 启动失败: ${err.message}`);
      printInfo('可尝试先运行: proxy cursor2api prepare');
    }
    return;
  }

  if (action === 'stop') {
    try {
      const result = await svc.stop();
      if (result.alreadyStopped) printInfo('cursor2api 未运行');
      else printSuccess('cursor2api 已停止');
    } catch (err) {
      printError(`cursor2api 停止失败: ${err.message}`);
    }
    return;
  }

  if (action === 'help') {
    console.log('');
    console.log(chalk.cyan.bold('  cursor2api 命令'));
    console.log('');
    console.log(chalk.dim('  proxy cursor2api setup <zip路径> [--port 3010] [--token khy-xxx]'));
    console.log(chalk.dim('  proxy cursor2api prepare [--force-install] [--force-build]'));
    console.log(chalk.dim('  proxy cursor2api start [--port 3010] [--token khy-xxx]'));
    console.log(chalk.dim('  proxy cursor2api token status|set <token>|rotate|clear'));
    console.log(chalk.dim('  (默认强制鉴权，若需开放模式可加 --no-auth)'));
    console.log(chalk.dim('  proxy cursor2api stop'));
    console.log(chalk.dim('  proxy cursor2api status'));
    console.log('');
    return;
  }

  try {
    const status = await svc.getStatus();
    console.log('');
    console.log(`  ${chalk.cyan.bold('Cursor2API 状态')}`);
    console.log('');
    console.log(`  ${chalk.gray('已安装:')}     ${status.configured ? chalk.green('是') : chalk.yellow('否')}`);
    console.log(`  ${chalk.gray('已构建:')}     ${status.built ? chalk.green('是') : chalk.yellow('否')}`);
    console.log(`  ${chalk.gray('运行中:')}     ${status.running ? chalk.green('● 是') : chalk.red('● 否')}`);
    console.log(`  ${chalk.gray('端口:')}       ${status.port}${status.portOpen ? chalk.green(' (open)') : chalk.dim(' (closed)')}`);
    console.log(`  ${chalk.gray('PID:')}        ${status.pid || '-'}`);
    console.log(`  ${chalk.gray('版本:')}       ${status.version || '-'}`);
    console.log(`  ${chalk.gray('鉴权:')}       ${status.authEnabled ? chalk.green('已启用') : chalk.yellow('未启用')}`);
    console.log(`  ${chalk.gray('鉴权模式:')}   ${status.requireToken ? chalk.green('强制鉴权') : chalk.yellow('开放模式')}`);
    console.log(`  ${chalk.gray('Token:')}      ${status.authTokenMasked || '-'}`);
    console.log(`  ${chalk.gray('安装目录:')}   ${status.installDir}`);
    console.log(`  ${chalk.gray('ZIP 路径:')}   ${status.zipPath}`);
    console.log(`  ${chalk.gray('日志:')}       ${status.logPath}`);
    console.log('');

    if (!status.configured) {
      printInfo(`首次使用请执行: proxy cursor2api setup ${svc.DEFAULT_ZIP_PATH}`);
    } else if (!status.built) {
      printInfo('构建未完成，请执行: proxy cursor2api prepare');
    } else if (!status.running) {
      printInfo('服务未启动，请执行: proxy cursor2api start');
    }
  } catch (err) {
    printError(`读取 cursor2api 状态失败: ${err.message}`);
  }
}

function printTraeSwitchHelp() {
  console.log('');
  console.log(chalk.cyan.bold('  proxy trae-switch 命令'));
  console.log('');
  console.log(chalk.dim('  proxy trae-switch list'));
  console.log(chalk.dim('  proxy trae-switch sync [--name 名称] [--endpoint https://.../v1] [--id trae-auto]'));
  console.log(chalk.dim('  proxy trae-switch add <名称> --endpoint <openai_base> --models <m1,m2> [--key sk-xxx]'));
  console.log(chalk.dim('  proxy trae-switch add <名称> --endpoint <openai_base> --map "customA=targetA,customB=targetB" [--key sk-xxx]'));
  console.log(chalk.dim('  proxy trae-switch use <id|名称>'));
  console.log(chalk.dim('  proxy trae-switch remove <id|名称>'));
  console.log(chalk.dim('  proxy trae-switch test [id|名称] [--model <custom_model>]'));
  console.log(chalk.dim('  proxy trae-switch status'));
  console.log('');
  console.log(chalk.dim('  说明:'));
  console.log(chalk.dim('    1) sync 会从 Trae 登录态自动发现 token + 模型 + endpoint'));
  console.log(chalk.dim('    2) 自动写入 RELAY_API_* 与 PROXY_MODEL_ROUTE_MAP'));
  console.log(chalk.dim('    3) 自动暴露 /v1/models 原始模型名，方便 Trae 直接选择'));
  console.log(chalk.dim('    4) 若 Trae 支持 Base URL，填: http(s)://127.0.0.1:<port>/v1'));
  console.log(chalk.dim('       若 Trae 不支持 Base URL，可选 hosts+证书方式（高风险，谨慎）'));
  console.log('');
}

function printTraeSwitchApplySummary(profile, applied) {
  console.log('');
  printSuccess(`已激活 Trae 供应商: ${profile.name} (${profile.id})`);
  console.log(`  ${chalk.gray('Endpoint:')} ${chalk.cyan(profile.endpoint)}`);
  console.log(`  ${chalk.gray('模型数:')}    ${profile.models.length}`);
  console.log(`  ${chalk.gray('默认模型:')}  ${chalk.cyan(applied.defaultModel || profile.models[0] || '-')}`);
  console.log(`  ${chalk.gray('路由规则:')}  ${applied.routeMapCount}`);
  console.log(`  ${chalk.gray('写入 .env:')} ${chalk.cyan(applied.envPath)}`);
  if (profile.key) {
    const masked = profile.key.length > 10
      ? `${profile.key.slice(0, 6)}***${profile.key.slice(-4)}`
      : `${profile.key.slice(0, 3)}***`;
    console.log(`  ${chalk.gray('上游 Key:')} ${chalk.cyan(masked)}`);
  } else {
    console.log(`  ${chalk.gray('上游 Key:')} ${chalk.yellow('未保存（请在环境变量或上游客户端中提供）')}`);
  }
  console.log('');
  printInfo('建议下一步:');
  console.log(chalk.dim('  1) khy proxy start'));
  console.log(chalk.dim('  2) khy proxy status'));
  console.log(chalk.dim('  3) 在 Trae 里使用 OpenAI 兼容入口（模型名直接选你配置的 custom_model）'));
  console.log('');
}

async function syncTraeSwitchProfileFromAdapter(options = {}) {
  const store = loadTraeSwitchStore();
  const traeAdapter = require('../../services/gateway/adapters/traeAdapter');
  const autoProfile = await traeAdapter.getRelayProfile({
    id: options.id || '',
    name: options.name || '',
    endpoint: options.endpoint || options.base || options.url || '',
    key: options.key || options['api-key'] || options.token || '',
    model: options.model || '',
  });

  const mappingRaw = String(options.map || '').trim();
  const parsedMap = parseModelMap(mappingRaw);
  let models = dedupeList([
    ...(Array.isArray(autoProfile.models) ? autoProfile.models : []).map(normalizeModelId),
    ...Object.keys(parsedMap).map(normalizeModelId),
  ]);
  if (models.length === 0) {
    throw new Error('未发现可用模型，无法生成代理配置');
  }

  const modelMap = {};
  for (const modelId of models) {
    const mapped = normalizeModelId(parsedMap[modelId] || autoProfile.modelMap?.[modelId] || modelId);
    modelMap[modelId] = mapped || modelId;
  }
  models = dedupeList(models);

  const activate = parseBooleanMaybe(options.activate, true);
  const idInput = String(options.id || autoProfile.id || 'trae-auto').trim();
  const name = String(options.name || autoProfile.name || 'Trae Auto').trim() || 'Trae Auto';
  const endpoint = normalizeEndpointBase(options.endpoint || autoProfile.endpoint || '');
  const key = String(options.key || options['api-key'] || options.token || autoProfile.key || '').trim();
  const used = new Set(store.profiles.map(p => p.id));
  const profileId = normalizeTraeProfileId(idInput) || createTraeProfileId(name, used);
  const existing = store.profiles.find(p => p.id === profileId)
    || store.profiles.find(p => String(p.name || '').trim().toLowerCase() === name.toLowerCase());
  const now = new Date().toISOString();
  const nextProfile = {
    id: existing ? existing.id : profileId,
    name,
    endpoint,
    key: key || (existing ? existing.key : ''),
    models,
    modelMap,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const nextProfiles = existing
    ? store.profiles.map(p => (p.id === existing.id ? nextProfile : p))
    : [...store.profiles, nextProfile];
  const nextStore = saveTraeSwitchStore({
    activeId: activate ? nextProfile.id : store.activeId,
    profiles: nextProfiles,
  });

  let applied = null;
  if (activate) {
    const profile = resolveTraeProfile(nextStore, nextProfile.id);
    applied = applyTraeSwitchProfile(profile || nextProfile);
  }

  return {
    store,
    nextStore,
    autoProfile,
    profile: nextProfile,
    applied,
    activate,
    existing: !!existing,
    changed: buildSwitchProfileSignature(existing || {}) !== buildSwitchProfileSignature(nextProfile),
    activeChanged: !!activate && String(store.activeId || '') !== String(nextProfile.id || ''),
  };
}

async function handleProxyTraeSwitch(action = 'status', args = [], options = {}) {
  const sub = String(action || 'status').toLowerCase();
  const store = loadTraeSwitchStore();

  if (sub === 'help') {
    printTraeSwitchHelp();
    return;
  }

  if (sub === 'list' || sub === 'status' || sub === 'show') {
    console.log('');
    console.log(chalk.cyan.bold('  Trae 第三方供应商列表'));
    console.log('');
    if (!store.profiles.length) {
      printInfo('暂无配置。先执行: proxy switch-center add --provider trae <名称> --endpoint <openai_base> --models <m1,m2>');
      console.log('');
      return;
    }
    for (const profile of store.profiles) {
      const active = profile.id === store.activeId;
      const icon = active ? chalk.green('●') : chalk.dim('○');
      const firstModels = profile.models.slice(0, 3).join(', ');
      const suffix = profile.models.length > 3 ? ` +${profile.models.length - 3}` : '';
      console.log(`  ${icon} ${chalk.white(profile.id)}  ${chalk.cyan(profile.name)} ${active ? chalk.green('(active)') : ''}`);
      console.log(`    ${chalk.dim(profile.endpoint)}`);
      console.log(`    ${chalk.dim(`models: ${firstModels}${suffix}`)}`);
    }
    if (store.activeId) {
      const activeProfile = store.profiles.find(p => p.id === store.activeId);
      if (activeProfile) {
        console.log('');
        printInfo(`当前激活: ${activeProfile.name} (${activeProfile.id})`);
      }
    }
    console.log('');
    return;
  }

  if (sub === 'test' || sub === 'check') {
    const query = String(args[0] || options.id || options.name || '').trim();
    const profile = resolveTraeProfile(store, query);
    if (!profile) {
      printError(`未找到配置: ${query || '(active)'}`);
      printInfo('可先执行: proxy switch-center list --provider trae');
      return;
    }

    const customModel = normalizeModelId(options.model || args[1] || profile.models?.[0] || '');
    if (!customModel) {
      printError('未找到可测试模型，请先为该配置添加 models');
      return;
    }
    const targetModel = normalizeModelId(
      options['target-model']
      || options.targetModel
      || profile.modelMap?.[customModel]
      || customModel
    ) || customModel;
    const timeoutMs = parsePositiveInt(options.timeout || options['timeout-ms'], 15000);
    const applyBeforeTest = parseBooleanMaybe(options.apply, true);
    const upstreamKey = String(options.key || options['api-key'] || profile.key || process.env.RELAY_API_KEY || '').trim();

    console.log('');
    printInfo(`测试配置: ${profile.name} (${profile.id})`);
    console.log(`  ${chalk.gray('上游:')} ${chalk.cyan(profile.endpoint)}`);
    console.log(`  ${chalk.gray('模型映射:')} ${chalk.cyan(`${customModel} -> ${targetModel}`)}`);
    console.log(`  ${chalk.gray('超时:')} ${timeoutMs}ms`);
    if (!upstreamKey) {
      printInfo('上游 Key 为空，将尝试无鉴权测试（多数服务会返回 401）');
    }

    if (applyBeforeTest) {
      saveTraeSwitchStore({
        activeId: profile.id,
        profiles: store.profiles,
      });
      applyTraeSwitchProfile(profile);
      printInfo('已自动应用该配置到当前网关环境');
    }

    const rows = [];
    let allPassed = true;

    try {
      const upstream = await testTraeUpstream(profile, {
        timeoutMs,
        upstreamKey,
        targetModel,
      });
      rows.push([
        '上游 /models',
        upstream.models.ok ? chalk.green('PASS') : chalk.red('FAIL'),
        `HTTP ${upstream.models.statusCode}; models=${upstream.models.modelCount}${upstream.models.error ? `; ${upstream.models.error}` : ''}`,
      ]);
      rows.push([
        '上游 /chat/completions',
        upstream.chat.ok ? chalk.green('PASS') : chalk.red('FAIL'),
        `HTTP ${upstream.chat.statusCode}; text=${upstream.chat.text ? upstream.chat.text.slice(0, 60) : '(empty)'}${upstream.chat.error ? `; ${upstream.chat.error}` : ''}`,
      ]);
      allPassed = allPassed && upstream.models.ok && upstream.chat.ok;
    } catch (err) {
      const message = err?.message || String(err);
      rows.push(['上游连通测试', chalk.red('FAIL'), message]);
      allPassed = false;
    }

    try {
      const local = await testTraeLocalProxy(profile, {
        timeoutMs: Math.max(timeoutMs, 18000),
        customModel,
      });
      rows.push([
        '本地代理 /v1/models',
        local.modelList.ok ? chalk.green('PASS') : chalk.red('FAIL'),
        `HTTP ${local.modelList.statusCode}; raw=${local.modelList.hasRaw ? 'yes' : 'no'}; prefixed=${local.modelList.hasPrefixed ? 'yes' : 'no'}; total=${local.modelList.total}${local.modelList.error ? `; ${local.modelList.error}` : ''}`,
      ]);
      rows.push([
        '本地代理 /v1/chat/completions',
        local.chat.ok ? chalk.green('PASS') : chalk.red('FAIL'),
        `HTTP ${local.chat.statusCode}; text=${local.chat.text ? local.chat.text.slice(0, 60) : '(empty)'}${local.chat.error ? `; ${local.chat.error}` : ''}`,
      ]);
      console.log(`  ${chalk.gray('代理入口:')} ${chalk.cyan(local.base)}`);
      allPassed = allPassed && local.modelList.ok && local.chat.ok;
    } catch (err) {
      const message = err?.message || String(err);
      rows.push(['本地代理测试', chalk.red('FAIL'), message]);
      allPassed = false;
    }

    console.log('');
    for (const row of rows) {
      console.log(`  ${chalk.white(row[0])}  ${row[1]}  ${chalk.dim(row[2])}`);
    }
    console.log('');

    if (allPassed) {
      printSuccess('Trae Switch 测试通过');
      printInfo(`可在 Trae 中使用模型: ${customModel}`);
    } else {
      printError('Trae Switch 测试未通过，请根据失败项修复后重试');
    }
    console.log('');
    return;
  }

  if (sub === 'remove' || sub === 'delete' || sub === 'del') {
    const query = String(args[0] || options.id || options.name || '').trim();
    if (!query) {
      printError('用法: proxy switch-center remove <id|名称> --provider trae');
      return;
    }
    const profile = resolveTraeProfile(store, query);
    if (!profile) {
      printError(`未找到配置: ${query}`);
      return;
    }
    const nextProfiles = store.profiles.filter(p => p.id !== profile.id);
    const nextStore = saveTraeSwitchStore({
      activeId: store.activeId === profile.id ? '' : store.activeId,
      profiles: nextProfiles,
    });
    printSuccess(`已删除: ${profile.name} (${profile.id})`);
    if (!nextStore.activeId && nextStore.profiles.length > 0) {
      printInfo('当前无激活配置，可执行: proxy switch-center use <id> --provider trae');
    }
    return;
  }

  if (sub === 'use' || sub === 'activate') {
    const query = String(args[0] || options.id || options.name || '').trim();
    if (!query) {
      printError('用法: proxy switch-center use <id|名称> --provider trae');
      return;
    }
    const profile = resolveTraeProfile(store, query);
    if (!profile) {
      printError(`未找到配置: ${query}`);
      return;
    }
    const nextStore = saveTraeSwitchStore({
      activeId: profile.id,
      profiles: store.profiles,
    });
    const applied = applyTraeSwitchProfile(profile);
    printTraeSwitchApplySummary(profile, applied);
    if (!nextStore.activeId) {
      printInfo('警告: 激活状态写入失败，但环境变量已应用到当前会话');
    }
    return;
  }

  if (sub === 'sync' || sub === 'refresh' || sub === 'import') {
    try {
      const result = await syncTraeSwitchProfileFromAdapter({
        ...options,
        name: options.name || args[0] || '',
      });
      const nextProfile = result.profile;
      printSuccess(`${result.existing ? '已更新' : '已新增'} Trae 供应商: ${nextProfile.name} (${nextProfile.id})`);
      printInfo(`来源 token: ${result.autoProfile.source || '-'} ${result.autoProfile.path ? `(${result.autoProfile.path})` : ''}`);

      if (result.activate) {
        printTraeSwitchApplySummary(nextProfile, result.applied || { routeMapCount: 0, envPath: '-', defaultModel: nextProfile.models?.[0] || '' });
      } else {
        printInfo('未激活该配置，可执行: proxy switch-center use ' + nextProfile.id + ' --provider trae');
      }
      return;
    } catch (err) {
      printError(`自动同步 Trae 配置失败: ${err?.message || err}`);
      printInfo('请先确保 Trae 已登录，再执行: proxy switch-center sync --provider trae');
      return;
    }
  }

  if (sub === 'add' || sub === 'create' || sub === 'set' || sub === 'update') {
    const name = String(args[0] || options.name || '').trim();
    const endpoint = normalizeEndpointBase(options.endpoint || options.base || options.url || args[1] || '');
    const modelsRaw = String(options.models || args[2] || '').trim();
    const mappingRaw = String(options.map || '').trim();
    const key = String(options.key || options['api-key'] || options.token || args[3] || '').trim();
    const activate = parseBooleanMaybe(options.activate, true);
    const idInput = String(options.id || '').trim();
    const explicitTargetModel = normalizeModelId(options['target-model'] || options.targetModel || '');

    if (!name) {
      printError('用法: proxy switch-center add --provider trae <名称> --endpoint <openai_base> --models <m1,m2>');
      return;
    }
    if (!endpoint) {
      printError('缺少 endpoint，请使用 --endpoint https://.../v1');
      return;
    }

    const parsedMap = parseModelMap(mappingRaw);
    let models = dedupeList([
      ...Object.keys(parsedMap).map(normalizeModelId),
      ...parseCsvList(modelsRaw).map(normalizeModelId),
    ]);
    if (models.length === 0) {
      printError('缺少模型，请使用 --models <m1,m2> 或 --map "custom=target"');
      return;
    }

    const modelMap = {};
    for (const modelId of models) {
      const mapped = normalizeModelId(parsedMap[modelId] || explicitTargetModel || modelId);
      modelMap[modelId] = mapped || modelId;
    }
    models = dedupeList(models);

    const used = new Set(store.profiles.map(p => p.id));
    const profileId = normalizeTraeProfileId(idInput) || createTraeProfileId(name, used);
    const existing = store.profiles.find(p => p.id === profileId)
      || store.profiles.find(p => String(p.name || '').trim().toLowerCase() === name.toLowerCase());
    const now = new Date().toISOString();
    const nextProfile = {
      id: existing ? existing.id : profileId,
      name,
      endpoint,
      key: key || (existing ? existing.key : ''),
      models,
      modelMap,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const nextProfiles = existing
      ? store.profiles.map(p => (p.id === existing.id ? nextProfile : p))
      : [...store.profiles, nextProfile];
    const nextStore = saveTraeSwitchStore({
      activeId: activate ? nextProfile.id : store.activeId,
      profiles: nextProfiles,
    });
    printSuccess(`${existing ? '已更新' : '已新增'} Trae 供应商: ${nextProfile.name} (${nextProfile.id})`);

    if (activate) {
      const profile = resolveTraeProfile(nextStore, nextProfile.id);
      const applied = applyTraeSwitchProfile(profile || nextProfile);
      printTraeSwitchApplySummary(profile || nextProfile, applied);
    } else {
      printInfo('未激活该配置，可执行: proxy switch-center use ' + nextProfile.id + ' --provider trae');
    }
    return;
  }

  printError(`未知 trae-switch 子命令: ${action}`);
  printTraeSwitchHelp();
}

// windsurf 切换 + switch-center 元分派子系统已抽为同目录叶子；按同名 re-import 保命令契约不变。
// 叶子对宿主 17 处函数级回依赖经 DI 注入（均为已提升函数声明）；parseBooleanMaybe 叶子自 require；
// _switchCenterAutoSyncState 仅本簇用已随迁入叶子。
const {
  handleProxyWindsurfSwitch,
  handleProxySwitchCenter,
  maybeAutoSyncSwitchCenter,
  setProxySwitchProfilesDeps,
} = require('./proxySwitchProfiles');
setProxySwitchProfilesDeps({
  parsePositiveInt,
  dedupeList,
  normalizeModelId,
  normalizeEndpointBase,
  normalizeTraeProfileId,
  createTraeProfileId,
  parseModelMap,
  loadTraeSwitchStore,
  loadWindsurfSwitchStore,
  saveWindsurfSwitchStore,
  resolveWindsurfProfile,
  buildSwitchProfileSignature,
  applyTraeSwitchProfile,
  testTraeUpstream,
  testTraeLocalProxy,
  syncTraeSwitchProfileFromAdapter,
  handleProxyTraeSwitch,
});

async function handleProxyHelp() {
  printProxyHelp();
}

/**
 * `khy proxy core <install|status>` — explicit face for the mihomo proxy-core
 * install capability (previously only auto-fired from proxyCoreManager.start).
 * Gated by KHY_PROXY_CORE_INSTALL_CLI (default-on); gate off → byte-revert to
 * proxy help (the prior behavior for the unknown `core` subcommand). The real
 * logic lives in the testable leaf cli/handlers/proxyCoreInstallHandler.
 */
async function handleProxyCore(action = 'status', args = [], options = {}) {
  const { isFlagEnabled } = require('../../services/flagRegistry');
  if (!isFlagEnabled('KHY_PROXY_CORE_INSTALL_CLI', process.env)) {
    return handleProxyHelp();
  }
  return require('./proxyCoreInstallHandler').runCore({
    action: String(action || 'status').toLowerCase(),
    env: process.env,
  });
}

module.exports = {
  handleProxyStart,
  handleProxyStop,
  handleProxyStatus,
  handleProxyQuickstart,
  handleProxyCert,
  handleProxyClient,
  handleProxyToken,
  handleProxyCore,
  handleProxySubscription,
  handleProxyHelp,
  handleProxyTls,
  handleProxyCursor2Api,
  handleProxySwitchCenter,
  handleProxyTraeSwitch,
  handleProxyWindsurfSwitch,
  maybeAutoSyncSwitchCenter,
  __test__: {
    buildProxyStartOptions,
    resolveTlsFiles,
    sanitizeCommonName,
    parsePositiveInt,
    generateSelfSignedCert,
    ensureHttpsTlsOptions,
  },
};
