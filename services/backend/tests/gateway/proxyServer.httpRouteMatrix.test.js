'use strict';

/**
 * proxyServer.httpRouteMatrix.test.js — locks the request-handling matrix of
 * proxyServer.start() over REAL HTTP on a dynamically probed port (listen(0)
 * net probe, zero hardcoded ports):
 *   - CORS preflight (OPTIONS → 204 + allow-headers, before auth)
 *   - auth gating: missing/bad token → 401; primary (env), x-api-key header
 *     and ?key= query all accepted; managed tokens accepted
 *   - PROXY_AUTH_TOKENS comma list extended to the accepted set
 *   - gateway-free routes: GET /health (status ok + adapters/protocols),
 *     GET /reservoir/stats defaults, unknown path → 404 JSON
 *   - lifecycle guards: second start() throws, isRunning()/getPort() reflect
 *     the running instance, stop() releases state
 *
 * The heavy gateway is doMoked (same pattern as
 * tests/proxyServer.modelRouter.integration.test.js) so the matrix stays
 * hermetic; the auth file lives under the jest-pinned KHY_DATA_HOME.
 * Whoever changes the route table / auth precedence / CORS headers red first.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function httpGet({ port, pathname, token, extraHeaders }) {
  return new Promise((resolve) => {
    const headers = extraHeaders || {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        headers,
        timeout: 3000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += String(chunk);
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* non-JSON */
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, json });
        });
      }
    );
    req.on('error', (err) => resolve({ error: err }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: new Error('request timeout') });
    });
    req.end();
  });
}

describe('proxyServer HTTP route matrix', () => {
  const originalEnv = { ...process.env };
  let tempHome = null;
  let homedirSpy = null;
  let proxy = null;
  let started = null;

  async function request(pathname, { token, extraHeaders } = {}) {
    return httpGet({
      port: started.port,
      pathname,
      token,
      extraHeaders,
    });
  }

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-matrix-'));
    // Point BOTH the unified data home and the legacy (~/.khyquant) home at a
    // throwaway dir so the server never reads/writes real user auth/runtime
    // files (proxyServer resolves getLegacyDataHome() from os.homedir()).
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    process.env.HOME = tempHome;
    process.env.KHY_DATA_HOME = path.join(tempHome, '.khy');
    delete process.env.PROXY_AUTH_TOKEN;
    delete process.env.PROXY_AUTH_TOKENS;
    delete process.env.PROXY_RESERVOIR_ENABLED;
    delete process.env.PROXY_RESERVOIR_TTL_MS;
    delete process.env.PROXY_RESERVOIR_MAX_ENTRIES;

    const gatewayMock = {
      _initialized: true,
      isInitialized() {
        return this._initialized;
      },
      init: jest.fn(async () => {}),
      generate: jest.fn(async () => ({ success: true, content: 'ok' })),
      listModels: jest.fn(async () => []),
    };
    jest.doMock('../../src/services/gateway/aiGateway', () => gatewayMock);
    jest.doMock('../../src/services/modelTrainingService', () => ({
      recordConversation: jest.fn(() => ({ accepted: true })),
    }));
    jest.doMock('../../src/services/usageHabitService', () => ({
      recordModelUsage: jest.fn(),
      recordInteraction: jest.fn(),
    }));

    proxy = require('../../src/services/gateway/proxyServer');
  });

  afterEach(async () => {
    if (proxy && typeof proxy.stop === 'function') {
      try {
        await proxy.stop();
      } catch {
        /* ignore */
      }
    }
    if (homedirSpy) {
      homedirSpy.mockRestore();
      homedirSpy = null;
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    proxy = null;
    started = null;
  });

  test('CORS 预检 OPTIONS → 204 + 放行头（先于鉴权）', async () => {
    const port = await getFreePort();
    started = await proxy.start({ host: '127.0.0.1', port });
    const res = await request('/v1/chat/completions', {
      extraHeaders: { Origin: 'http://localhost' },
    });

    const optsReq = await new Promise((resolve) => {
      const r = http.request(
        {
          hostname: '127.0.0.1',
          port: started.port,
          path: '/v1/chat/completions',
          method: 'OPTIONS',
          headers: { Origin: '*', 'Access-Control-Request-Method': 'POST' },
          timeout: 3000,
        },
        (response) => {
          let data = '';
          response.on('data', (c) => (data += String(c)));
          response.on('end', () =>
            resolve({ statusCode: response.statusCode, headers: response.headers, body: data })
          );
        }
      );
      r.on('error', () => resolve({ error: true }));
      r.on('timeout', () => r.destroy());
      r.end();
    });

    expect(optsReq.statusCode).toBe(204);
    expect(String(optsReq.headers['access-control-allow-methods'])).toContain('POST');
    expect(String(optsReq.headers['access-control-allow-headers'])).toContain('Authorization');
    // ...and an unauthenticated GET on the same path is still rejected
    expect(res.statusCode).toBe(401);
  });

  test('鉴权矩阵：缺 token/错 token → 401；env 主 token / x-api-key / ?key= 均放行', async () => {
    process.env.PROXY_AUTH_TOKEN = 'khy-primary';
    const port = await getFreePort();
    started = await proxy.start({ host: '127.0.0.1', port });

    const missing = await request('/health');
    expect(missing.statusCode).toBe(401);
    expect(missing.json.error.message).toMatch(/Unauthorized/);

    const bad = await request('/health', { token: 'khy-wrong' });
    expect(bad.statusCode).toBe(401);

    const bearer = await request('/health', { token: 'khy-primary' });
    expect(bearer.statusCode).toBe(200);
    expect(bearer.json.status).toBe('ok');
    expect(bearer.json.adapters).toContain('claude');
    expect(Array.isArray(bearer.json.protocols)).toBe(true);

    const apikey = await httpGet({
      port: started.port,
      pathname: '/health',
      extraHeaders: { 'x-api-key': 'khy-primary' },
    });
    expect(apikey.statusCode).toBe(200);

    const query = await httpGet({
      port: started.port,
      pathname: '/health?key=khy-primary',
    });
    expect(query.statusCode).toBe(200);
  });

  test('PROXY_AUTH_TOKENS 列表令牌与 managed token 均可通行，404 路由返回 JSON', async () => {
    process.env.PROXY_AUTH_TOKENS = 'khy-secondary, khy-tertiary';
    const port = await getFreePort();
    started = await proxy.start({ host: '127.0.0.1', port });
    const managed = proxy.createManagedToken({ label: 'ide' });

    const secondary = await request('/health', { token: 'khy-secondary' });
    expect(secondary.statusCode).toBe(200);

    const managedOk = await request('/health', { token: managed.token });
    expect(managedOk.statusCode).toBe(200);

    const notFound = await request('/no-such-route', { token: 'khy-tertiary' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json.error.message).toBe('Not found');
  });

  test('GET /reservoir/stats 返回默认档（enabled=true, ttl 300000, max 500）', async () => {
    const port = await getFreePort();
    started = await proxy.start({ host: '127.0.0.1', port });
    const token = started.authToken;
    const res = await request('/reservoir/stats', { token });
    expect(res.statusCode).toBe(200);
    expect(res.json).toEqual({
      enabled: true,
      size: 0,
      ttlMs: 300000,
      maxEntries: 500,
    });

    // env knobs change the served view
    process.env.PROXY_RESERVOIR_ENABLED = 'false';
    process.env.PROXY_RESERVOIR_TTL_MS = '42000';
    process.env.PROXY_RESERVOIR_MAX_ENTRIES = '77';
    const res2 = await request('/reservoir/stats', { token });
    expect(res2.json).toEqual({ enabled: false, size: 0, ttlMs: 42000, maxEntries: 77 });
  });

  test('生命周期守卫：重复 start 抛错；isRunning/getPort 反映运行态；stop 后复位', async () => {
    const port = await getFreePort();
    started = await proxy.start({ host: '127.0.0.1', port });
    expect(proxy.isRunning()).toBe(true);
    expect(proxy.getPort()).toBe(port);
    await expect(proxy.start({ host: '127.0.0.1', port })).rejects.toThrow(
      'Proxy server already running'
    );
    await proxy.stop();
    expect(proxy.isRunning()).toBe(false);
  });
});
