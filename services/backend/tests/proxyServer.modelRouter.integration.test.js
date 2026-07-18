'use strict';

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
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function postJson({ port, token, pathname, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += String(chunk); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* ignore */ }
        resolve({ statusCode: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

describe('proxyServer model router integration', () => {
  const originalEnv = { ...process.env };
  let tempHome = null;
  let proxy = null;
  let gatewayMock = null;

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-model-route-'));
    process.env.HOME = tempHome;
    process.env.PROXY_AUTH_TOKEN = 'khy-test-token';
    delete process.env.GATEWAY_MODEL_ROUTE_MAP;

    gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      generate: jest.fn(async (prompt, options) => ({
        success: true,
        content: 'ok',
        provider: options.preferredAdapter || 'mock',
        adapter: options.preferredAdapter || 'mock',
        model: options.model || null,
      })),
      listModels: jest.fn(async () => []),
    };

    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);
    jest.doMock('../src/services/modelTrainingService', () => ({
      recordConversation: jest.fn(() => ({ accepted: true })),
    }));
    jest.doMock('../src/services/usageHabitService', () => ({
      recordModelUsage: jest.fn(),
      recordInteraction: jest.fn(),
    }));

    proxy = require('../src/services/gateway/proxyServer');
  });

  afterEach(async () => {
    if (proxy && typeof proxy.stop === 'function') {
      try { await proxy.stop(); } catch { /* ignore */ }
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
    tempHome = null;
    gatewayMock = null;
  });

  test('passes explicit adapter model as strict preferred route', async () => {
    const port = await getFreePort();
    const started = await proxy.start({ host: '127.0.0.1', port });

    const resp = await postJson({
      port,
      token: started.authToken,
      pathname: '/v1/chat/completions',
      body: {
        model: 'kiro/claude-sonnet-4',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(resp.statusCode).toBe(200);
    expect(gatewayMock.generate).toHaveBeenCalledTimes(1);
    const [, options] = gatewayMock.generate.mock.calls[0];
    expect(options.model).toBe('claude-sonnet-4');
    expect(options.preferredAdapter).toBe('kiro');
    expect(options.preferredModel).toBe('claude-sonnet-4');
    expect(options.strictPreferred).toBe(true);
  });

  test('applies route-map target as preferred adapter without forcing strict', async () => {
    process.env.GATEWAY_MODEL_ROUTE_MAP = JSON.stringify({
      'gpt-4o-mini': 'api/openai:gpt-4o-mini',
    });

    const port = await getFreePort();
    const started = await proxy.start({ host: '127.0.0.1', port });

    const resp = await postJson({
      port,
      token: started.authToken,
      pathname: '/v1/chat/completions',
      body: {
        model: 'gpt-4o-mini',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(resp.statusCode).toBe(200);
    expect(gatewayMock.generate).toHaveBeenCalledTimes(1);
    const [, options] = gatewayMock.generate.mock.calls[0];
    expect(options.model).toBe('openai:gpt-4o-mini');
    expect(options.preferredAdapter).toBe('api');
    expect(options.preferredModel).toBe('openai:gpt-4o-mini');
    expect(options.strictPreferred).toBe(false);
  });
});
