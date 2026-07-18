'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

function writeWindsurfStorage(homeDir, payload) {
  const storagePath = path.join(homeDir, '.config', 'Windsurf', 'User', 'globalStorage', 'storage.json');
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.writeFileSync(storagePath, JSON.stringify(payload, null, 2), 'utf8');
}

function createHttpsMock(handler) {
  const request = jest.fn((options, callback) => {
    const req = new EventEmitter();
    req.write = jest.fn();
    req.destroy = jest.fn();
    req.end = jest.fn(() => {
      const response = handler(options || {});
      const res = new EventEmitter();
      res.statusCode = Number(response.statusCode || 200);
      res.headers = response.headers || { 'content-type': 'application/json' };
      process.nextTick(() => {
        callback(res);
        if (response.body !== undefined) {
          const body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
          res.emit('data', body);
        }
        res.emit('end');
      });
    });
    return req;
  });
  return { request };
}

describe('windsurf adapter token priority and fallback', () => {
  const originalEnv = { ...process.env };
  let tempHome = null;

  afterEach(() => {
    jest.resetModules();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = null;
  });

  test('falls back to local token when pool token is expired', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-windsurf-test-'));
    process.env.HOME = tempHome;
    process.env.WINDSURF_TOKEN_PRIORITY = 'pool-first';

    const localToken = `local-valid-token-${'a'.repeat(24)}`;
    writeWindsurfStorage(tempHome, {
      windsurfAuth: {
        accessToken: localToken,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });

    const httpsMock = createHttpsMock(() => ({
      statusCode: 200,
      body: { choices: [{ message: { content: 'ok-local' } }] },
    }));

    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => tempHome };
    });
    jest.doMock('https', () => httpsMock);
    jest.doMock('../src/services/accountPool', () => ({
      init: jest.fn(async () => {}),
      getActiveToken: jest.fn(async () => ({
        accessToken: 'pool-expired-token',
        label: 'pool-main',
        expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      })),
      saveObservedToken: jest.fn(async () => ({ id: 1 })),
    }));

    const adapter = require('../src/services/gateway/adapters/windsurfAdapter');
    adapter.destroy();

    const result = await adapter.generate('hello');
    expect(result.success).toBe(true);
    expect(httpsMock.request).toHaveBeenCalledTimes(1);
    expect(httpsMock.request.mock.calls[0][0].headers.Authorization).toBe(`Bearer ${localToken}`);
  });

  test('retries with local token when pool token gets auth error', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-windsurf-test-'));
    process.env.HOME = tempHome;
    process.env.WINDSURF_TOKEN_PRIORITY = 'pool-first';

    const poolToken = `pool-valid-token-${'b'.repeat(24)}`;
    const localToken = `local-valid-token-${'c'.repeat(24)}`;
    writeWindsurfStorage(tempHome, {
      windsurfAuth: {
        accessToken: localToken,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });

    const httpsMock = createHttpsMock((options) => {
      const auth = String(options?.headers?.Authorization || '');
      if (auth === `Bearer ${poolToken}`) {
        return {
          statusCode: 401,
          body: { error: { message: 'unauthorized', code: 401 } },
        };
      }
      return {
        statusCode: 200,
        body: { choices: [{ message: { content: 'ok-fallback' } }] },
      };
    });

    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => tempHome };
    });
    jest.doMock('https', () => httpsMock);
    jest.doMock('../src/services/accountPool', () => ({
      init: jest.fn(async () => {}),
      getActiveToken: jest.fn(async () => ({
        accessToken: poolToken,
        label: 'pool-main',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })),
      saveObservedToken: jest.fn(async () => ({ id: 1 })),
    }));

    const adapter = require('../src/services/gateway/adapters/windsurfAdapter');
    adapter.destroy();

    const result = await adapter.generate('hello');
    expect(result.success).toBe(true);
    expect(httpsMock.request).toHaveBeenCalledTimes(2);
    expect(httpsMock.request.mock.calls[0][0].headers.Authorization).toBe(`Bearer ${poolToken}`);
    expect(httpsMock.request.mock.calls[1][0].headers.Authorization).toBe(`Bearer ${localToken}`);
  });
});
