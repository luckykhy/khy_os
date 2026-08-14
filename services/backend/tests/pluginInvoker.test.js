'use strict';

/**
 * pluginInvoker.test.js — runtime invocation of a Coze-compatible plugin
 * operation as an HTTP call. Asserts:
 *   1. Argument binding — path/query/header params + JSON body land in the
 *      right place; the final URL is built from servers[0].url + the path.
 *   2. Auth families — none / apiKey(header|query) / bearer / oauth
 *      (client_credentials cached; authorization_code via access/refresh token).
 *   3. SSRF — a private/loopback-resolving target (API URL or OAuth token URL)
 *      is rejected before any request goes out.
 *   4. Status pass-through — HTTP >= 400 returns ok:false WITHOUT throwing.
 *
 * All network + clock are injected (`_http`, `_now`, `_tokenCache`); DNS is
 * stubbed via urlSafety.__setDnsLookupForTests so the SSRF guard runs offline.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const invoker = require('../src/services/plugins/pluginInvoker');
const urlSafety = require('../src/services/urlSafety');

const OPENAPI = {
  openapi: '3.0.0',
  info: { title: 'Demo', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/cities/{id}/weather': {
      get: {
        operationId: 'getWeather',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'units', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'X-Trace', in: 'header', required: false, schema: { type: 'string' } },
        ],
      },
    },
    '/echo': {
      post: {
        operationId: 'echo',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      },
    },
  },
};

// Record the last request the injected http client saw.
function recorder(response = { status: 200, headers: { 'content-type': 'application/json' }, data: { ok: true } }) {
  const calls = [];
  const http = async (req) => { calls.push(req); return response; };
  return { http, calls };
}

beforeEach(() => {
  // Resolve every hostname to a public IP so the SSRF guard passes offline.
  urlSafety.__setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
});

afterEach(() => {
  urlSafety.__setDnsLookupForTests(null);
});

test('binds path/query/header params and builds the final URL', async () => {
  const { http, calls } = recorder();
  const res = await invoker.invoke({
    openapi: OPENAPI,
    operationId: 'getWeather',
    args: { id: 'beijing', units: 'metric', 'X-Trace': 'abc' },
    authConfig: { type: 'none' },
    _http: http,
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, 'GET');
  assert.match(calls[0].url, /^https:\/\/api\.example\.com\/v1\/cities\/beijing\/weather\?/);
  assert.match(calls[0].url, /units=metric/);
  assert.strictEqual(calls[0].headers['X-Trace'], 'abc');
});

test('sends a JSON body for POST operations', async () => {
  const { http, calls } = recorder();
  await invoker.invoke({
    openapi: OPENAPI,
    operationId: 'echo',
    args: { body: { hello: 'world' } },
    authConfig: { type: 'none' },
    _http: http,
  });
  assert.deepStrictEqual(calls[0].data, { hello: 'world' });
  assert.match(calls[0].headers['Content-Type'], /json/);
});

test('apiKey auth in header and in query', async () => {
  const h = recorder();
  await invoker.invoke({
    openapi: OPENAPI, operationId: 'getWeather', args: { id: 'x' },
    authConfig: { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: 'secret' },
    _http: h.http,
  });
  assert.strictEqual(h.calls[0].headers['X-Api-Key'], 'secret');

  const q = recorder();
  await invoker.invoke({
    openapi: OPENAPI, operationId: 'getWeather', args: { id: 'x' },
    authConfig: { type: 'apiKey', in: 'query', name: 'token', value: 'qsecret' },
    _http: q.http,
  });
  assert.match(q.calls[0].url, /token=qsecret/);
});

test('bearer auth sets the Authorization header', async () => {
  const { http, calls } = recorder();
  await invoker.invoke({
    openapi: OPENAPI, operationId: 'getWeather', args: { id: 'x' },
    authConfig: { type: 'bearer', token: 'tok123' },
    _http: http,
  });
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer tok123');
});

test('oauth client_credentials fetches a token, caches it, and reuses it', async () => {
  let tokenFetches = 0;
  const http = async (req) => {
    if (req.url === 'https://auth.example.com/token') {
      tokenFetches += 1;
      return { status: 200, headers: { 'content-type': 'application/json' }, data: { access_token: 'AT', expires_in: 3600 } };
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, data: { ok: true } };
  };
  const cache = new Map();
  const now = () => 1_000_000;
  const auth = { type: 'oauth', grant: 'client_credentials', tokenUrl: 'https://auth.example.com/token', clientId: 'id', clientSecret: 'sec', scope: 'read' };

  const r1 = await invoker.invoke({ openapi: OPENAPI, operationId: 'getWeather', args: { id: 'x' }, authConfig: auth, _http: http, _now: now, _tokenCache: cache });
  const r2 = await invoker.invoke({ openapi: OPENAPI, operationId: 'getWeather', args: { id: 'y' }, authConfig: auth, _http: http, _now: now, _tokenCache: cache });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(tokenFetches, 1, 'token should be fetched once and reused from cache');
});

test('oauth authorization_code uses the stored access token without a token call', async () => {
  let tokenFetches = 0;
  const http = async (req) => {
    if (/token/.test(req.url)) { tokenFetches += 1; return { status: 200, headers: {}, data: { access_token: 'NEW' } }; }
    return { status: 200, headers: { 'content-type': 'application/json' }, data: { ok: true }, _auth: req.headers.Authorization };
  };
  const res = await invoker.invoke({
    openapi: OPENAPI, operationId: 'getWeather', args: { id: 'x' },
    authConfig: { type: 'oauth', grant: 'authorization_code', accessToken: 'STORED', tokenUrl: 'https://auth.example.com/token' },
    _http: http, _now: () => 0,
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(tokenFetches, 0, 'a valid stored access token needs no token request');
});

test('SSRF: rejects an API URL resolving to a private address', async () => {
  urlSafety.__setDnsLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
  const { http } = recorder();
  await assert.rejects(
    () => invoker.invoke({ openapi: OPENAPI, operationId: 'getWeather', args: { id: 'x' }, authConfig: { type: 'none' }, _http: http }),
    /private or local/i,
  );
});

test('SSRF: rejects an OAuth token URL resolving to loopback', async () => {
  urlSafety.__setDnsLookupForTests(async (host) => (
    host === 'auth.internal' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]
  ));
  const { http } = recorder();
  await assert.rejects(
    () => invoker.invoke({
      openapi: OPENAPI, operationId: 'getWeather', args: { id: 'x' },
      authConfig: { type: 'oauth', grant: 'client_credentials', tokenUrl: 'http://auth.internal/token', clientId: 'i', clientSecret: 's' },
      _http: http, _now: () => 0, _tokenCache: new Map(),
    }),
    /private or local/i,
  );
});

test('HTTP >= 400 returns ok:false without throwing', async () => {
  const { http } = recorder({ status: 404, headers: { 'content-type': 'application/json' }, data: { error: 'nope' } });
  const res = await invoker.invoke({ openapi: OPENAPI, operationId: 'getWeather', args: { id: 'x' }, authConfig: { type: 'none' }, _http: http });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 404);
});
