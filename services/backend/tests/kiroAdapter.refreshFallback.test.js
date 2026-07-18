'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

function createHttpsMock(handler) {
  const request = jest.fn((options, callback) => {
    const req = new EventEmitter();
    req.write = jest.fn();
    req.destroy = jest.fn();
    req.end = jest.fn(() => {
      const response = handler(options || {});
      const res = new EventEmitter();
      res.statusCode = Number(response.statusCode || 200);
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

describe('kiro adapter refresh fallback', () => {
  const originalEnv = { ...process.env };
  let tempHome = null;

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();

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

  test('keeps Kiro available when refresh fails but the token is still valid', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kiro-regression-'));
    process.env.HOME = tempHome;

    const cacheDir = path.join(tempHome, '.aws', 'sso', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });

    const clientIdHash = 'e909a0580879b06ece1202964fbe9dda95ea4ce3';
    const tokenPath = path.join(cacheDir, 'kiro-auth-token.json');
    const clientRegPath = path.join(cacheDir, `${clientIdHash}.json`);
    const tokenData = {
      accessToken: 'a'.repeat(232),
      refreshToken: 'r'.repeat(64),
      authMethod: 'IdC',
      provider: 'Internal',
      region: 'us-east-1',
      clientIdHash,
      expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
    };

    fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2), 'utf8');
    fs.writeFileSync(clientRegPath, JSON.stringify({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }, null, 2), 'utf8');

    const httpsMock = createHttpsMock((options) => {
      if (String(options.hostname || '') === 'oidc.us-east-1.amazonaws.com') {
        return {
          statusCode: 400,
          body: {
            error: 'invalid_request',
            message: 'refresh denied',
          },
        };
      }
      return { statusCode: 200, body: {} };
    });

    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => tempHome };
    });
    jest.doMock('https', () => httpsMock);
    jest.doMock('../src/services/accountPool', () => ({
      init: jest.fn(async () => {}),
      getActiveToken: jest.fn(async () => null),
      saveObservedToken: jest.fn(async () => ({ id: 1 })),
    }));

    const adapter = require('../src/services/gateway/adapters/kiroAdapter');
    adapter.destroy();

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const available = await adapter.detectAsync();
    const status = adapter.getStatus();

    expect(available).toBe(true);
    expect(status.available).toBe(true);
    expect(status.detail).toContain('Token 有效');
    expect(httpsMock.request).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});
