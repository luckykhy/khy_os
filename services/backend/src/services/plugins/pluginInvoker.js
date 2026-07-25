/**
 * Plugin runtime invoker — execute one OpenAPI operation as an HTTP call.
 *
 * Given a plugin's OpenAPI doc, an operationId, the caller's args, and the user's
 * auth config, this builds and sends the HTTP request, then maps the response to
 * JSON. It is the single execution path shared by the workflow `toolCall` node
 * and the chat Agent (both reach it through pluginToolBridge).
 *
 * Auth families (from UserInstalledPlugin.authConfigJson):
 *   - none
 *   - apiKey   { type:'apiKey', in:'header'|'query', name, value }
 *   - bearer   { type:'bearer', token }
 *   - oauth    { type:'oauth', grant:'client_credentials'|'authorization_code',
 *                tokenUrl, clientId, clientSecret, scope,
 *                accessToken?, refreshToken?, expiresAt? }
 *
 * Hardening: every outbound URL (the API call AND the OAuth token URL) passes the
 * SSRF guard; requests carry a timeout and never throw on HTTP status (the status
 * is reported back so the agent can react).
 *
 * Dependencies are injectable (`_http`, `_now`, `_tokenCache`) for offline tests.
 *
 * @module services/plugins/pluginInvoker
 * @pattern Strategy
 */
'use strict';

const {
  findOperation,
  operationParamSchema,
} = require('@khy/shared/plugins/openapiTools');
const urlSafety = require('../urlSafety');

const REQUEST_TIMEOUT_MS = Number(process.env.KHY_PLUGIN_REQUEST_TIMEOUT_MS || 30000);
const MAX_RESPONSE_BYTES = Number(process.env.KHY_PLUGIN_MAX_RESPONSE_BYTES || 4 * 1024 * 1024);

// Module-level OAuth access-token cache (client_credentials). Keyed by a stable
// signature of the token endpoint + client + scope. In-memory: tokens are short-
// lived and re-fetched on restart.
const _defaultTokenCache = new Map();

function _err(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}

// ── Base URL resolution ─────────────────────────────────────────────────────

function _baseUrl(openapi, manifest) {
  const servers = Array.isArray(openapi && openapi.servers) ? openapi.servers : [];
  const first = servers.find((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url));
  if (first) return first.url.replace(/\/+$/, '');
  // Fallback: a manifest-declared base (some Coze exports carry it on api).
  const apiUrl = manifest && manifest.api && manifest.api.base_url;
  if (typeof apiUrl === 'string' && /^https?:\/\//i.test(apiUrl)) return apiUrl.replace(/\/+$/, '');
  throw _err(400, 'Plugin OpenAPI has no absolute server URL');
}

// ── Argument binding ────────────────────────────────────────────────────────

function _bindRequest(openapi, operationId, args) {
  const op = findOperation(openapi, operationId);
  if (!op) throw _err(404, `Unknown operation "${operationId}"`);
  const { params } = operationParamSchema(openapi, operationId);
  const a = args && typeof args === 'object' ? args : {};

  let pathTemplate = op.path;
  const query = {};
  const headers = {};

  for (const p of params) {
    const val = a[p.name];
    if (val === undefined || val === null) {
      if (p.required && p.in === 'path') {
        throw _err(400, `Missing required path parameter "${p.name}"`);
      }
      continue;
    }
    if (p.in === 'path') {
      pathTemplate = pathTemplate.replace(
        new RegExp(`\\{${_escapeRe(p.name)}\\}`, 'g'),
        encodeURIComponent(String(val)),
      );
    } else if (p.in === 'query') {
      query[p.name] = val;
    } else if (p.in === 'header') {
      headers[p.name] = String(val);
    }
    // 'cookie' params are intentionally unsupported.
  }

  const body = a.body !== undefined ? a.body : undefined;
  return { method: op.method, pathTemplate, query, headers, body };
}

// 收敛到 utils/escapeRegExp 单一真源(逐字节委托,调用点不变)
const _escapeRe = require('../../utils/escapeRegExp');

function _appendQuery(urlObj, query) {
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) v.forEach((item) => urlObj.searchParams.append(k, String(item)));
    else urlObj.searchParams.append(k, String(v));
  }
}

// ── Auth application ────────────────────────────────────────────────────────

async function _applyAuth(authConfig, ctx) {
  // ctx = { urlObj, headers, query, http, now, tokenCache }
  const auth = authConfig && typeof authConfig === 'object' ? authConfig : { type: 'none' };
  const type = String(auth.type || 'none').toLowerCase();

  if (type === 'none') return;

  if (type === 'apikey') {
    if (!auth.value) throw _err(400, 'apiKey auth is missing "value"');
    const name = auth.name || 'Authorization';
    if ((auth.in || 'header') === 'query') ctx.query[name] = auth.value;
    else ctx.headers[name] = auth.value;
    return;
  }

  if (type === 'bearer') {
    if (!auth.token) throw _err(400, 'bearer auth is missing "token"');
    ctx.headers.Authorization = `Bearer ${auth.token}`;
    return;
  }

  if (type === 'oauth') {
    const token = await _resolveOAuthToken(auth, ctx);
    ctx.headers.Authorization = `Bearer ${token}`;
    return;
  }

  throw _err(400, `Unsupported auth type "${auth.type}"`);
}

function _oauthCacheKey(auth) {
  return [auth.tokenUrl, auth.clientId, auth.scope || ''].join('|');
}

async function _resolveOAuthToken(auth, ctx) {
  const grant = String(auth.grant || 'client_credentials').toLowerCase();

  // authorization_code: rely on a pre-obtained access token (the redirect dance
  // happens in the REST/UI layer). Refresh via refresh_token when expired.
  if (grant === 'authorization_code') {
    if (auth.accessToken && !_expired(auth.expiresAt, ctx.now)) return auth.accessToken;
    if (auth.refreshToken) {
      const fresh = await _fetchToken(auth, ctx, {
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken,
      });
      return fresh.access_token;
    }
    if (auth.accessToken) return auth.accessToken; // no expiry info; use as-is
    throw _err(401, 'OAuth authorization_code plugin has no access token; (re)authorize it first');
  }

  // client_credentials: fully server-side; cache by endpoint+client+scope.
  const key = _oauthCacheKey(auth);
  const cached = ctx.tokenCache.get(key);
  if (cached && !_expired(cached.expiresAt, ctx.now)) return cached.accessToken;

  const tok = await _fetchToken(auth, ctx, {
    grant_type: 'client_credentials',
    ...(auth.scope ? { scope: auth.scope } : {}),
  });
  const expiresAt = tok.expires_in ? ctx.now() + (Number(tok.expires_in) * 1000) : null;
  ctx.tokenCache.set(key, { accessToken: tok.access_token, expiresAt });
  return tok.access_token;
}

function _expired(expiresAt, now) {
  if (!expiresAt) return false;
  // 30s safety margin.
  return now() >= (Number(expiresAt) - 30000);
}

async function _fetchToken(auth, ctx, form) {
  if (!auth.tokenUrl) throw _err(400, 'OAuth config is missing "tokenUrl"');
  await urlSafety.assertPublicHttpUrlResolved(new URL(auth.tokenUrl), 'OAuth token URL');

  const body = new URLSearchParams(form);
  if (auth.clientId) body.set('client_id', auth.clientId);
  if (auth.clientSecret) body.set('client_secret', auth.clientSecret);

  const res = await ctx.http({
    method: 'POST',
    url: auth.tokenUrl,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    data: body.toString(),
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw _err(502, `OAuth token request failed (${res.status})`);
  }
  const data = typeof res.data === 'string' ? _tryJson(res.data) : res.data;
  if (!data || !data.access_token) {
    throw _err(502, 'OAuth token response had no access_token');
  }
  return data;
}

function _tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Invoke one plugin operation.
 *
 * @param {object} opts
 * @param {object} opts.openapi        the plugin's OpenAPI doc
 * @param {object} [opts.manifest]     the plugin's normalized manifest
 * @param {string} opts.operationId
 * @param {object} [opts.args]         caller args keyed by param name (+ optional `body`)
 * @param {object} [opts.authConfig]   per-user auth config
 * @param {function} [opts._http]      injected axios-like fn (tests)
 * @param {function} [opts._now]       injected clock returning ms (tests)
 * @param {Map} [opts._tokenCache]     injected OAuth cache (tests)
 * @returns {Promise<{ok,status,data,contentType}>}
 */
async function invoke(opts = {}) {
  const { openapi, manifest, operationId, args, authConfig } = opts;
  if (!openapi || typeof openapi !== 'object') throw _err(400, 'invoke requires an openapi document');
  if (!operationId) throw _err(400, 'invoke requires an operationId');

  const http = opts._http || require('axios');
  const now = opts._now || Date.now;
  const tokenCache = opts._tokenCache || _defaultTokenCache;

  const base = _baseUrl(openapi, manifest);
  const bound = _bindRequest(openapi, operationId, args);

  const urlObj = new URL(base + bound.pathTemplate);
  _appendQuery(urlObj, bound.query);

  const headers = { Accept: 'application/json', ...bound.headers };
  const authCtx = { urlObj, headers, query: {}, http, now, tokenCache };
  await _applyAuth(authConfig, authCtx);
  // Auth may have added query params (apiKey in query).
  _appendQuery(urlObj, authCtx.query);

  // SSRF guard on the FINAL resolved API URL (after path/query binding).
  await urlSafety.assertPublicHttpUrlResolved(urlObj, 'Plugin request URL');

  const hasBody = bound.body !== undefined && !['GET', 'HEAD'].includes(bound.method);
  const res = await http({
    method: bound.method,
    url: urlObj.toString(),
    headers: hasBody ? { ...headers, 'Content-Type': 'application/json' } : headers,
    ...(hasBody ? { data: bound.body } : {}),
    timeout: REQUEST_TIMEOUT_MS,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    validateStatus: () => true,
  });

  const contentType = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '';
  let data = res.data;
  if (typeof data === 'string' && /json/i.test(contentType)) {
    const parsed = _tryJson(data);
    if (parsed !== null) data = parsed;
  }

  return {
    ok: res.status < 400,
    status: res.status,
    contentType,
    data,
  };
}

module.exports = {
  invoke,
  // exported for tests
  _bindRequest,
  _baseUrl,
  _resolveOAuthToken,
  _defaultTokenCache,
};
