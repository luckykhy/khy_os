/**
 * Shared HTTP/HTTPS request helper with proxy-first fallback.
 *
 * Goals:
 * - Prefer configured proxy routes (Clash/system env) for overseas endpoints.
 * - Degrade to direct connection if proxy path is unavailable.
 * - Keep adapter code minimal and consistent across IDE integrations.
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const {
  CLASH_PORTS,
  getStatus: _proxyGetStatus,
  refreshSubscription: _proxyRefreshSubscription,
  autoDetectAndEnable,
} = require('../../proxyConfigService');

const { parseList, dedupe } = require('./_adapterUtils');

// Default auto-probe ports derive from the single source in proxyConfigService.
// Copied so callers can't mutate the shared list; the literal lives there only.
const DEFAULT_AUTO_PROXY_PORTS = [...CLASH_PORTS.http];
const DEFAULT_PROXY_RETRY_MS = 15_000;
// Cap for the escalated (exponential) backoff window; override via PROXY_BACKOFF_MAX_MS.
const DEFAULT_PROXY_BACKOFF_MAX_MS = 300_000;
const DEFAULT_PROXY_ROUTE_MODE = 'auto';
const DEFAULT_PROXY_BYPASS_SUFFIXES = ['.cn', '.local', '.lan', '.home', '.internal'];
const _proxyBackoffUntil = new Map();
// In-memory per-node success/failure counters, keyed by makeBackoffKey().
// Intentionally not persisted: stats reset on restart so nodes get a fresh chance.
const _proxyStats = new Map();
let _savedProxyUnsupportedSocks5 = false;

// Auto-reconnect: refresh + re-activate proxy when all candidates fail.
// Prevents silent fallback to direct when subscriptions have expired or nodes are stale.
const PROXY_AUTO_RECONNECT_ENABLED = (() => {
  const raw = String(process.env.KHY_PROXY_AUTO_RECONNECT || '1')
    .trim()
    .toLowerCase();
  return !['0', 'off', 'false', 'no', 'n'].includes(raw);
})();

const PROXY_AUTO_RECONNECT_INTERVAL_MS = (() => {
  const raw = Number(process.env.KHY_PROXY_RECONNECT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 60_000;
})();

const _reconnectCooldowns = new Map();

function isReconnectOnCooldown(ns) {
  const until = _reconnectCooldowns.get(ns) || 0;
  return until > Date.now();
}

function setReconnectCooldown(ns) {
  _reconnectCooldowns.set(ns, Date.now() + PROXY_AUTO_RECONNECT_INTERVAL_MS);
}

async function tryAutoReconnect(namespace) {
  if (!PROXY_AUTO_RECONNECT_ENABLED) {
    return false;
  }
  const ns = String(namespace || 'default').toLowerCase();
  if (isReconnectOnCooldown(ns)) {
    return false;
  }

  let refreshed = false;
  try {
    // 1) Refresh the active subscription to pull fresh nodes
    const status = _proxyGetStatus();
    if (status && status.activeSubscriptionId) {
      const result = await _proxyRefreshSubscription(status.activeSubscriptionId, {
        timeout: 10_000,
        apply: true,
      });
      if (result && result.success && result.applied) {
        refreshed = true;
      }
    }
  } catch {
    // fail-soft
  }

  // 2) If no active subscription or refresh failed, try auto-detect (local Clash)
  if (!refreshed) {
    try {
      const detected = await autoDetectAndEnable();
      if (detected && detected.success) {
        refreshed = true;
      }
    } catch {
      // fail-soft
    }
  }

  if (refreshed) {
    setReconnectCooldown(ns);
  }
  return refreshed;
}

function parseBoolean(raw, fallback = true) {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'n'].includes(normalized)) {
    return false;
  }
  return fallback;
}

// Verbose proxy diagnostics. Fallback-to-direct and reconnect notices are normal
// degradation, so keep them silent by default; surface them only when the
// operator opts in via KHY_PROXY_DEBUG, or DEBUG/KHY_DEBUG scopes 'proxyTunnel'.
const PROXY_TUNNEL_VERBOSE = (() => {
  if (parseBoolean(process.env.KHY_PROXY_DEBUG, false)) {
    return true;
  }
  const debugScopes = `${process.env.KHY_DEBUG || ''},${process.env.DEBUG || ''}`.toLowerCase();
  return debugScopes.includes('proxytunnel');
})();

function parsePortList(raw, fallback = DEFAULT_AUTO_PROXY_PORTS) {
  const rows = String(raw || '')
    .split(',')
    .map((v) => parseInt(String(v || '').trim(), 10))
    .filter((v) => Number.isFinite(v) && v > 0 && v <= 65535);
  return rows.length > 0 ? rows : [...fallback];
}

function parseRouteMode(raw, fallback = DEFAULT_PROXY_ROUTE_MODE) {
  const normalized = String(raw || fallback)
    .trim()
    .toLowerCase();
  if (['always', 'proxy', 'proxy-first'].includes(normalized)) {
    return 'always';
  }
  if (['never', 'direct', 'direct-only', 'off'].includes(normalized)) {
    return 'never';
  }
  return 'auto';
}

function isIpv4Host(host) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(host || '').trim());
}

function isPrivateIpv4Host(host) {
  if (!isIpv4Host(host)) {
    return false;
  }
  const parts = String(host)
    .split('.')
    .map((v) => Number.parseInt(v, 10));
  if (parts.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) {
    return false;
  }
  if (parts[0] === 10) {
    return true;
  }
  if (parts[0] === 127) {
    return true;
  }
  if (parts[0] === 192 && parts[1] === 168) {
    return true;
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  if (parts[0] === 169 && parts[1] === 254) {
    return true;
  }
  return false;
}

function normalizeHostRule(raw = '') {
  let value = String(raw || '')
    .trim()
    .toLowerCase();
  if (!value) {
    return '';
  }
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  if (value.startsWith('*.')) {
    value = `.${value.slice(2)}`;
  }
  return value;
}

function hostMatchesRule(host, rule) {
  const normalizedHost = String(host || '')
    .trim()
    .toLowerCase();
  const normalizedRule = normalizeHostRule(rule);
  if (!normalizedHost || !normalizedRule) {
    return false;
  }
  if (normalizedHost === normalizedRule) {
    return true;
  }
  if (normalizedRule.startsWith('.')) {
    return normalizedHost.endsWith(normalizedRule);
  }
  return normalizedHost.endsWith(`.${normalizedRule}`);
}

function parseHostRules(raw) {
  const out = [];
  const seen = new Set();
  for (const item of parseList(raw)) {
    const normalized = normalizeHostRule(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function toEnvPrefix(namespace = 'default') {
  const normalized = String(namespace || 'default')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized || 'DEFAULT';
}

function resolveRouteConfig(namespace = 'default', proxyOptions = {}) {
  const envPrefix = toEnvPrefix(namespace);
  const mode = parseRouteMode(
    proxyOptions.routeMode ??
      process.env[`${envPrefix}_PROXY_ROUTE_MODE`] ??
      process.env.GATEWAY_PROXY_ROUTE_MODE ??
      process.env.KHY_PROXY_ROUTE_MODE ??
      DEFAULT_PROXY_ROUTE_MODE
  );
  const requireProxy = parseBoolean(
    proxyOptions.requireProxy ??
      process.env[`${envPrefix}_PROXY_REQUIRED`] ??
      process.env.GATEWAY_PROXY_REQUIRED ??
      process.env.KHY_PROXY_REQUIRED,
    false
  );
  const forceHosts = parseHostRules([
    ...parseList(proxyOptions.forceHosts),
    ...parseList(process.env[`${envPrefix}_PROXY_FORCE_HOSTS`]),
    ...parseList(process.env[`${envPrefix}_PROXY_FORCE_DOMAINS`]),
    ...parseList(process.env.GATEWAY_PROXY_FORCE_HOSTS),
    ...parseList(process.env.GATEWAY_PROXY_FORCE_DOMAINS),
  ]);
  const bypassHosts = parseHostRules([
    ...parseList(proxyOptions.bypassHosts),
    ...parseList(process.env[`${envPrefix}_PROXY_BYPASS_HOSTS`]),
    ...parseList(process.env[`${envPrefix}_PROXY_BYPASS_DOMAINS`]),
    ...parseList(process.env.GATEWAY_PROXY_BYPASS_HOSTS),
    ...parseList(process.env.GATEWAY_PROXY_BYPASS_DOMAINS),
  ]);
  return { mode, requireProxy, forceHosts, bypassHosts };
}

function shouldUseProxyForHost(hostname, routeConfig = {}) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase();
  const mode = routeConfig.mode || DEFAULT_PROXY_ROUTE_MODE;

  if (mode === 'always') {
    return true;
  }
  if (mode === 'never') {
    return false;
  }
  if (!host) {
    return true;
  }

  if (routeConfig.forceHosts.some((rule) => hostMatchesRule(host, rule))) {
    return true;
  }
  if (routeConfig.bypassHosts.some((rule) => hostMatchesRule(host, rule))) {
    return false;
  }
  if (host === 'localhost' || host === '::1' || isPrivateIpv4Host(host)) {
    return false;
  }
  if (DEFAULT_PROXY_BYPASS_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return false;
  }
  return true;
}

function normalizeProxyCandidate(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) {
    return '';
  }

  // Allow "127.0.0.1:7890" shorthand.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && /^[^/\s:]+:\d+$/.test(value)) {
    value = `http://${value}`;
  }

  try {
    const parsed = new URL(value);
    const protocol = String(parsed.protocol || '').toLowerCase();
    // This helper currently supports HTTP CONNECT proxy only.
    if (protocol !== 'http:' && protocol !== 'https:') {
      return '';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function readSavedProxyConfigUrl() {
  _savedProxyUnsupportedSocks5 = false;
  try {
    // Portable-aware app home; fallback to the legacy location.
    let cfgPath;
    try {
      cfgPath = path.join(require('../../../utils/dataHome').getAppHome(), 'proxy.json');
    } catch {
      cfgPath = path.join(os.homedir(), '.khyquant', 'proxy.json');
    }
    if (!fs.existsSync(cfgPath)) {
      return '';
    }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!cfg || cfg.enabled !== true) {
      return '';
    }

    const host = String(cfg.host || '').trim();
    const port = parseInt(String(cfg.port || '').trim(), 10);
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
      return '';
    }

    const type = String(cfg.type || 'http')
      .trim()
      .toLowerCase();
    if (type === 'socks5') {
      _savedProxyUnsupportedSocks5 = true;
      return '';
    }
    return `http://${host}:${port}`;
  } catch {
    return '';
  }
}

function makeBackoffKey(namespace, proxyUrl) {
  // Security: proxy URLs may carry credentials (http://user:pass@host:port)
  // from HTTPS_PROXY/HTTP_PROXY/ALL_PROXY or proxy.json. Keys built here feed
  // both _proxyBackoffUntil and _proxyStats, and stats keys are exposed via
  // GET /api/ai-gateway/proxy-stats — so keep only protocol + hostname + port
  // (no userinfo, no path). Same host:port with different credentials merges
  // into one bucket, which is acceptable for backoff/health accounting.
  let node = String(proxyUrl || '');
  try {
    const parsed = new URL(node);
    node = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    // Fallback for unparseable values: strip any leading userinfo segment.
    node = node.replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^@/]*@/i, '$1');
  }
  return `${String(namespace || 'default').toLowerCase()}::${node}`;
}

function isProxyInBackoff(namespace, proxyUrl) {
  const until = _proxyBackoffUntil.get(makeBackoffKey(namespace, proxyUrl)) || 0;
  return until > Date.now();
}

function markProxyFailed(namespace, proxyUrl, retryMs = DEFAULT_PROXY_RETRY_MS) {
  if (!proxyUrl) {
    return;
  }
  _proxyBackoffUntil.set(
    makeBackoffKey(namespace, proxyUrl),
    Date.now() + Math.max(1000, Number(retryMs) || DEFAULT_PROXY_RETRY_MS)
  );
}

function markProxyHealthy(namespace, proxyUrl) {
  if (!proxyUrl) {
    return;
  }
  _proxyBackoffUntil.delete(makeBackoffKey(namespace, proxyUrl));
}

function resolveBackoffMaxMs() {
  const raw = Number(process.env.PROXY_BACKOFF_MAX_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_PROXY_BACKOFF_MAX_MS;
}

function getOrCreateStats(key) {
  let entry = _proxyStats.get(key);
  if (!entry) {
    entry = {
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
    };
    _proxyStats.set(key, entry);
  }
  return entry;
}

function recordProxySuccess(namespace, proxyUrl) {
  if (!proxyUrl) {
    return;
  }
  const entry = getOrCreateStats(makeBackoffKey(namespace, proxyUrl));
  entry.successes += 1;
  entry.consecutiveFailures = 0;
  entry.lastSuccessAt = Date.now();
  markProxyHealthy(namespace, proxyUrl);
}

function recordProxyFailure(namespace, proxyUrl, retryMs = DEFAULT_PROXY_RETRY_MS) {
  if (!proxyUrl) {
    return;
  }
  const entry = getOrCreateStats(makeBackoffKey(namespace, proxyUrl));
  entry.failures += 1;
  entry.consecutiveFailures += 1;
  entry.lastFailureAt = Date.now();
  // Escalate backoff with consecutive failures: base × 2^(n-1), capped.
  const base = Math.max(1000, Number(retryMs) || DEFAULT_PROXY_RETRY_MS);
  const escalated = Math.min(
    base * Math.pow(2, Math.max(0, entry.consecutiveFailures - 1)),
    resolveBackoffMaxMs()
  );
  markProxyFailed(namespace, proxyUrl, escalated);
}

function proxySuccessRate(entry) {
  if (!entry) {
    return 0.5;
  }
  const total = entry.successes + entry.failures;
  return total > 0 ? entry.successes / total : 0.5;
}

// Defense-in-depth for the stats output: keys are already credential-free via
// makeBackoffKey(), but strip any residual userinfo (user:pass@) before the
// snapshot leaves this module. Values are numeric counters, no strings.
function sanitizeStatsKey(key) {
  return String(key || '').replace(/\/\/[^@/]*@/g, '//');
}

/**
 * Diagnostic snapshot of per-node stats, including remaining backoff window.
 * @param {string} [namespace] - Optional namespace filter.
 * @returns {object} Map of backoff-key -> stats snapshot.
 */
function getProxyStats(namespace) {
  const prefix = namespace ? `${String(namespace).toLowerCase()}::` : '';
  const now = Date.now();
  const out = {};
  for (const [key, entry] of _proxyStats.entries()) {
    if (prefix && !key.startsWith(prefix)) {
      continue;
    }
    const until = _proxyBackoffUntil.get(key) || 0;
    out[sanitizeStatsKey(key)] = { ...entry, backoffRemainingMs: Math.max(0, until - now) };
  }
  // Include backoff-only entries (marked failed outside the stats path).
  for (const [key, until] of _proxyBackoffUntil.entries()) {
    if (prefix && !key.startsWith(prefix)) {
      continue;
    }
    const safeKey = sanitizeStatsKey(key);
    if (out[safeKey] || until <= now) {
      continue;
    }
    out[safeKey] = {
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      backoffRemainingMs: until - now,
    };
  }
  return out;
}

function collectProxyCandidates(options = {}) {
  _savedProxyUnsupportedSocks5 = false;
  const {
    namespace = 'default',
    envKeys = [],
    autoEnabled = true,
    autoPorts = DEFAULT_AUTO_PROXY_PORTS,
    includeSavedProxy = true,
  } = options;

  const values = [];
  const push = (raw) => {
    const normalized = normalizeProxyCandidate(raw);
    if (normalized) {
      values.push(normalized);
    }
  };

  const keys = dedupe([
    ...envKeys,
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy',
  ]);

  for (const key of keys) {
    push(process.env[key]);
  }
  if (includeSavedProxy) {
    push(readSavedProxyConfigUrl());
  }
  if (autoEnabled) {
    for (const port of autoPorts) {
      push(`http://127.0.0.1:${port}`);
    }
  }

  const filtered = dedupe(values).filter((url) => !isProxyInBackoff(namespace, url));
  // Dynamic demotion: fewer consecutive failures first, then higher success
  // rate (no samples counts as neutral 0.5). Sort is stable, so untouched
  // nodes keep their original discovery order.
  return filtered.sort((a, b) => {
    const sa = _proxyStats.get(makeBackoffKey(namespace, a));
    const sb = _proxyStats.get(makeBackoffKey(namespace, b));
    const cfA = sa ? sa.consecutiveFailures : 0;
    const cfB = sb ? sb.consecutiveFailures : 0;
    if (cfA !== cfB) {
      return cfA - cfB;
    }
    return proxySuccessRate(sb) - proxySuccessRate(sa);
  });
}

function connectThroughProxy(proxyUrl, targetHost, targetPort, timeout) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const connectReq = http.request({
      hostname: proxy.hostname,
      port: proxy.port || 7890,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      timeout,
      headers: { Host: `${targetHost}:${targetPort}` },
    });

    connectReq.on('connect', (res, socket) => {
      if (Number(res.statusCode || 0) !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed (${res.statusCode || 0})`));
        return;
      }
      resolve(socket);
    });
    connectReq.on('error', reject);
    connectReq.on('timeout', () => {
      connectReq.destroy();
      reject(new Error('proxy connect timeout'));
    });
    connectReq.end();
  });
}

function sendRawRequest(parsed, options = {}, extra = {}) {
  const { method = 'GET', headers = {}, body = null, timeout = 12000 } = options;

  return new Promise((resolve, reject) => {
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        timeout,
        headers,
        ...extra,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += String(chunk);
        });
        res.on('end', () => {
          resolve({
            status: Number(res.statusCode || 0),
            headers: res.headers || {},
            raw,
          });
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (body != null) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function requestRaw(url, requestOptions = {}, proxyOptions = {}) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const namespace = String(proxyOptions.namespace || 'default').toLowerCase();
  const retryMs = Math.max(1000, Number(proxyOptions.retryMs) || DEFAULT_PROXY_RETRY_MS);
  const routeConfig = resolveRouteConfig(namespace, proxyOptions);
  const shouldTryProxy =
    isHttps && (routeConfig.requireProxy || shouldUseProxyForHost(parsed.hostname, routeConfig));

  const autoEnabled = parseBoolean(
    proxyOptions.autoEnabled !== undefined
      ? proxyOptions.autoEnabled
      : proxyOptions.autoEnvKey
        ? process.env[proxyOptions.autoEnvKey]
        : '1',
    true
  );
  const autoPorts = parsePortList(
    proxyOptions.portsEnvKey ? process.env[proxyOptions.portsEnvKey] : '',
    proxyOptions.defaultAutoPorts || DEFAULT_AUTO_PROXY_PORTS
  );

  const proxyCandidates = shouldTryProxy
    ? collectProxyCandidates({
        namespace,
        envKeys: proxyOptions.envKeys || [],
        autoEnabled,
        autoPorts,
        includeSavedProxy: proxyOptions.includeSavedProxy !== false,
      })
    : [];

  if (shouldTryProxy && proxyCandidates.length === 0 && routeConfig.requireProxy) {
    const hint = _savedProxyUnsupportedSocks5
      ? ' Saved proxy is SOCKS5, but adapters currently require HTTP CONNECT proxy (e.g. Clash mixed-port 7890).'
      : '';
    throw new Error(
      `Proxy required for ${parsed.hostname}, but no proxy endpoint is configured.${hint}`
    );
  }

  if (proxyCandidates.length > 0) {
    const targetPort = parsed.port || 443;
    let lastProxyError = null;
    let attempted = 0;
    for (const proxyUrl of proxyCandidates) {
      attempted += 1;
      try {
        const socket = await connectThroughProxy(
          proxyUrl,
          parsed.hostname,
          targetPort,
          requestOptions.timeout || 12000
        );
        const response = await sendRawRequest(parsed, requestOptions, { socket, agent: false });
        recordProxySuccess(namespace, proxyUrl);
        return response;
      } catch (err) {
        recordProxyFailure(namespace, proxyUrl, retryMs);
        lastProxyError = err instanceof Error ? err : new Error(String(err || 'proxy failed'));
      }
    }
    if (routeConfig.requireProxy) {
      throw lastProxyError || new Error(`Proxy connection failed for ${parsed.hostname}`);
    }
    if (PROXY_TUNNEL_VERBOSE) {
      console.warn(
        `[proxyTunnel] 代理全部不可用（已尝试 ${attempted}/${proxyCandidates.length} 个节点），回退直连 ${parsed.hostname}...`
      );
    }

    // Auto-reconnect: refresh subscription and retry with fresh candidates
    const didReconnect = await tryAutoReconnect(namespace);
    if (didReconnect) {
      const newCandidates = collectProxyCandidates({
        namespace,
        envKeys: proxyOptions.envKeys || [],
        autoEnabled,
        autoPorts,
        includeSavedProxy: proxyOptions.includeSavedProxy !== false,
      });
      if (newCandidates.length > 0) {
        if (PROXY_TUNNEL_VERBOSE) {
          console.log(
            `[proxyTunnel] 代理重连成功，已发现 ${newCandidates.length} 个新节点，重试 ${parsed.hostname}...`
          );
        }
        for (const proxyUrl of newCandidates) {
          try {
            const socket = await connectThroughProxy(
              proxyUrl,
              parsed.hostname,
              targetPort,
              requestOptions.timeout || 12000
            );
            const response = await sendRawRequest(parsed, requestOptions, { socket, agent: false });
            recordProxySuccess(namespace, proxyUrl);
            return response;
          } catch (err) {
            recordProxyFailure(namespace, proxyUrl, retryMs);
          }
        }
        if (PROXY_TUNNEL_VERBOSE) {
          console.warn(`[proxyTunnel] 重连后节点仍不可用，回退直连 ${parsed.hostname}...`);
        }
      }
    }
  }

  return sendRawRequest(parsed, requestOptions);
}

async function requestJson(url, requestOptions = {}, proxyOptions = {}) {
  const response = await requestRaw(url, requestOptions, proxyOptions);
  let data = null;
  try {
    data = JSON.parse(response.raw);
  } catch {
    data = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    raw: response.raw,
    data,
  };
}

/**
 * Request with TLS Sidecar priority.
 *
 * Resolution order:
 *   1. TLS Sidecar (if available and configured for target host)
 *   2. Proxy tunnel (Clash / env proxy candidates)
 *   3. Direct connection
 *
 * Learned from relayApiAdapter.makeRequest() and codexAdapter.makeDirectRequest()
 * which both inline this exact pattern. Phase 2A unifies it here.
 *
 * @param {string} url - Target URL
 * @param {object} [requestOptions] - { method, headers, body, timeout }
 * @param {object} [proxyOptions] - Same as requestRaw() proxyOptions
 * @returns {Promise<{ status, headers, raw }>}
 */
async function requestRawWithSidecar(url, requestOptions = {}, proxyOptions = {}) {
  const parsed = new URL(url);

  // Try TLS Sidecar first (if available and target matches)
  if (proxyOptions.useSidecar !== false && parsed.protocol === 'https:') {
    try {
      const sidecar = require('../tlsSidecar');
      if (sidecar.shouldProxy && sidecar.shouldProxy(parsed.hostname)) {
        const sidecarProxyUrl = sidecar.getProxyUrl();
        if (sidecarProxyUrl) {
          const socket = await connectThroughProxy(
            sidecarProxyUrl,
            parsed.hostname,
            parsed.port || 443,
            requestOptions.timeout || 12000
          );
          return sendRawRequest(parsed, requestOptions, { socket, agent: false });
        }
      }
    } catch {
      /* sidecar not available, fall through */
    }
  }

  // Standard proxy-aware request
  return requestRaw(url, requestOptions, proxyOptions);
}

/**
 * JSON variant of requestRawWithSidecar.
 */
async function requestJsonWithSidecar(url, requestOptions = {}, proxyOptions = {}) {
  const response = await requestRawWithSidecar(url, requestOptions, proxyOptions);
  let data = null;
  try {
    data = JSON.parse(response.raw);
  } catch {
    data = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    raw: response.raw,
    data,
  };
}

module.exports = {
  requestRaw,
  requestJson,
  requestRawWithSidecar,
  requestJsonWithSidecar,
  collectProxyCandidates,
  connectThroughProxy,
  sendRawRequest,
  recordProxySuccess,
  recordProxyFailure,
  getProxyStats,
  makeBackoffKey,
};
