'use strict';

const EventEmitter = require('events');

function buildMockResponse(statusCode, body = '{}') {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = {};
  process.nextTick(() => {
    if (body) res.emit('data', body);
    res.emit('end');
  });
  return res;
}

describe('_proxyTunnel route mode', () => {
  const proxyEnvKeys = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'];
  let savedProxyEnv = null;

  beforeEach(() => {
    savedProxyEnv = {};
    for (const key of proxyEnvKeys) {
      savedProxyEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of proxyEnvKeys) {
      if (savedProxyEnv && savedProxyEnv[key] !== undefined) process.env[key] = savedProxyEnv[key];
      else delete process.env[key];
    }
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('auto mode bypasses proxy for .cn domains', async () => {
    const httpRequest = jest.fn(() => {
      throw new Error('CONNECT proxy should not be called for .cn domain in auto mode');
    });
    const httpsRequest = jest.fn((options, cb) => {
      const req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn(() => cb(buildMockResponse(200, '{"ok":true}')));
      req.destroy = jest.fn();
      req.setTimeout = jest.fn();
      req.on = req.addListener.bind(req);
      return req;
    });

    jest.doMock('http', () => ({ request: httpRequest }));
    jest.doMock('https', () => ({ request: httpsRequest }));
    jest.doMock('fs', () => ({
      existsSync: jest.fn(() => false),
      readFileSync: jest.fn(() => ''),
    }));

    const tunnel = require('../src/services/gateway/adapters/_proxyTunnel');
    const res = await tunnel.requestRaw(
      'https://q.cn-north-1.amazonaws.com.cn/ListAvailableModels',
      { timeout: 1000 },
      {
        namespace: 'kiro',
        routeMode: 'auto',
        autoEnabled: false,
        includeSavedProxy: false,
        envKeys: [],
      }
    );

    expect(res.status).toBe(200);
    expect(httpRequest).not.toHaveBeenCalled();
    expect(httpsRequest).toHaveBeenCalledTimes(1);
  });

  test('throws early when proxy is required but no candidate exists', async () => {
    jest.doMock('fs', () => ({
      existsSync: jest.fn(() => false),
      readFileSync: jest.fn(() => ''),
    }));

    const tunnel = require('../src/services/gateway/adapters/_proxyTunnel');
    await expect(tunnel.requestRaw(
      'https://api.openai.com/v1/models',
      { timeout: 1000 },
      {
        namespace: 'api',
        routeMode: 'always',
        requireProxy: true,
        autoEnabled: false,
        includeSavedProxy: false,
        envKeys: [],
      }
    )).rejects.toThrow(/Proxy required/);
  });
});
