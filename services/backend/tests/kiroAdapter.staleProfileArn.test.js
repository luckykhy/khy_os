'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Creates a mock HTTP/HTTPS module that routes requests through a handler function.
 * The handler receives the request options and returns { statusCode, body }.
 * Also stubs http.request to reject CONNECT attempts (proxy tunnel), so
 * _proxyTunnel.js falls through to direct HTTPS.
 */
function createHttpsMock(handler) {
  const httpsRequest = jest.fn((options, callback) => {
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
  // http mock: reject all CONNECT (proxy tunnel) attempts immediately
  const httpRequest = jest.fn(() => {
    const req = new EventEmitter();
    req.write = jest.fn();
    req.destroy = jest.fn();
    req.end = jest.fn(() => {
      process.nextTick(() => req.emit('error', new Error('ECONNREFUSED mock')));
    });
    return req;
  });
  return {
    httpsMod: { request: httpsRequest },
    httpMod: { request: httpRequest },
    httpsRequest,
  };
}

describe('kiro adapter stale profileArn → 403 fallback', () => {
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

  /**
   * Helper: write a valid Kiro token to the temp SSO cache.
   * Token has NO profileArn (simulating the real scenario where the token
   * file itself doesn't carry a profileArn — it must be enriched from profile.json).
   */
  function writeTokenFile(cacheDir, overrides = {}) {
    const tokenData = {
      accessToken: 'a'.repeat(232),
      refreshToken: 'r'.repeat(64),
      authMethod: 'IdC',
      provider: 'Internal',
      region: 'us-east-1',
      clientIdHash: 'e909a0580879b06ece1202964fbe9dda95ea4ce3',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), // 1h from now
      ...overrides,
    };
    fs.writeFileSync(
      path.join(cacheDir, 'kiro-auth-token.json'),
      JSON.stringify(tokenData, null, 2),
      'utf8',
    );
    // Write client registration (needed for IdC refresh)
    fs.writeFileSync(
      path.join(cacheDir, `${tokenData.clientIdHash}.json`),
      JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }, null, 2),
      'utf8',
    );
    return tokenData;
  }

  /**
   * Helper: write a stale profile.json that contains an old profileArn.
   */
  function writeStaleProfile(profileDir, arn = 'arn:aws:iam::111111:profile/old-stale') {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'profile.json'),
      JSON.stringify({ arn, version: '1.0' }, null, 2),
      'utf8',
    );
  }

  function getKiroProfileDir() {
    if (process.platform === 'darwin') {
      return path.join(tempHome, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
    }
    if (process.platform === 'win32') {
      return path.join(tempHome, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
    }
    // linux
    return path.join(tempHome, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
  }

  function setupMocks({ httpHandler, poolToken = null }) {
    const { httpsMod, httpMod, httpsRequest } = createHttpsMock(httpHandler);

    // Disable auto proxy probing to avoid ECONNREFUSED noise
    process.env.KIRO_AUTO_PROXY = '0';
    // Override XDG_CONFIG_HOME so _getKiroProfilePaths resolves under tempHome
    if (process.platform === 'linux') {
      process.env.XDG_CONFIG_HOME = path.join(tempHome, '.config');
    }

    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => tempHome };
    });
    jest.doMock('https', () => httpsMod);
    jest.doMock('http', () => httpMod);
    jest.doMock('../src/services/accountPool', () => ({
      init: jest.fn(async () => {}),
      getActiveToken: jest.fn(async () => poolToken),
      saveObservedToken: jest.fn(async () => ({ id: 1 })),
      autoImportObservedCredentials: jest.fn(async () => {}),
    }));

    return { httpsRequest };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Test 1: stale profile_cache profileArn → 403 → omit profileArn → success
  // ─────────────────────────────────────────────────────────────────────
  test('403 with stale profile_cache profileArn triggers omit-profileArn fallback', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kiro-staleArn-'));
    process.env.HOME = tempHome;

    const cacheDir = path.join(tempHome, '.aws', 'sso', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });

    // Token has NO profileArn
    writeTokenFile(cacheDir, { profileArn: undefined });

    // Profile.json has a STALE profileArn
    writeStaleProfile(getKiroProfileDir(), 'arn:aws:iam::111111:profile/stale-arn');

    const requestLog = [];

    setupMocks({
      httpHandler: (options) => {
        const urlPath = String(options.path || '');
        requestLog.push(urlPath);

        // ListAvailableModels with stale profileArn → 403
        if (urlPath.includes('ListAvailableModels') && urlPath.includes('stale-arn')) {
          return { statusCode: 403, body: { message: 'AccessDeniedException' } };
        }
        // ListAvailableModels WITHOUT profileArn → success
        if (urlPath.includes('ListAvailableModels') && !urlPath.includes('profileArn=')) {
          return {
            statusCode: 200,
            body: {
              models: [
                { modelId: 'amazon-nova-pro', modelName: 'Amazon Nova Pro' },
                { modelId: 'claude-sonnet-4.6', modelName: 'Claude Sonnet 4.6' },
              ],
            },
          };
        }
        // OIDC refresh (for forceRefresh path)
        if (String(options.hostname || '').includes('oidc.')) {
          return {
            statusCode: 200,
            body: {
              accessToken: 'b'.repeat(232),
              expiresIn: 3600,
            },
          };
        }
        return { statusCode: 200, body: {} };
      },
    });

    const adapter = require('../src/services/gateway/adapters/kiroAdapter');
    adapter.destroy();

    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const models = await adapter.listModels();

    // Should have fetched models successfully via fallback
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.id === 'amazon-nova-pro')).toBe(true);
    expect(models[0].discoverySource).not.toBe('baseline');

    // Verify the request sequence:
    // 1. First request WITH stale profileArn → 403
    // 2. Second request WITHOUT profileArn → 200
    const listRequests = requestLog.filter(p => p.includes('ListAvailableModels'));
    expect(listRequests.length).toBeGreaterThanOrEqual(2);
    expect(listRequests[0]).toContain('stale-arn');  // first attempt had stale ARN
    expect(listRequests[1]).not.toContain('profileArn='); // fallback omitted ARN
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 2: token already has profileArn (trusted) → 403 → forceRefresh, NOT omit fallback
  // ─────────────────────────────────────────────────────────────────────
  test('403 with token-owned profileArn does NOT trigger omit-profileArn fallback', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kiro-ownedArn-'));
    process.env.HOME = tempHome;

    const cacheDir = path.join(tempHome, '.aws', 'sso', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });

    // Token has its OWN profileArn (trusted source)
    writeTokenFile(cacheDir, { profileArn: 'arn:aws:iam::222222:profile/owned-arn' });

    const requestLog = [];
    let refreshCount = 0;

    setupMocks({
      httpHandler: (options) => {
        const urlPath = String(options.path || '');
        requestLog.push(urlPath);

        if (urlPath.includes('ListAvailableModels')) {
          // All attempts fail → will fall to baseline
          return { statusCode: 403, body: { message: 'AccessDeniedException' } };
        }
        // OIDC refresh
        if (String(options.hostname || '').includes('oidc.')) {
          refreshCount++;
          return {
            statusCode: 200,
            body: {
              accessToken: 'c'.repeat(232),
              expiresIn: 3600,
            },
          };
        }
        return { statusCode: 200, body: {} };
      },
    });

    const adapter = require('../src/services/gateway/adapters/kiroAdapter');
    adapter.destroy();

    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const models = await adapter.listModels();

    // Should fall back to baseline since all API calls failed
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].discoverySource).toBe('baseline');

    // Verify: NO request was made without profileArn (because source was 'token', not 'profile_cache')
    const listRequests = requestLog.filter(p => p.includes('ListAvailableModels'));
    const noArnRequests = listRequests.filter(p => !p.includes('profileArn='));
    expect(noArnRequests.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 3: omit-profileArn fallback also fails → error message is actionable
  // ─────────────────────────────────────────────────────────────────────
  test('when omit-profileArn fallback also 403s, falls back to baseline with useful descriptions', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kiro-allFail-'));
    process.env.HOME = tempHome;

    const cacheDir = path.join(tempHome, '.aws', 'sso', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });

    writeTokenFile(cacheDir, { profileArn: undefined });
    writeStaleProfile(getKiroProfileDir(), 'arn:aws:iam::333333:profile/stale');

    setupMocks({
      httpHandler: (options) => {
        const urlPath = String(options.path || '');
        if (urlPath.includes('ListAvailableModels')) {
          return { statusCode: 403, body: { message: 'AccessDeniedException' } };
        }
        // OIDC refresh succeeds (so forceRefresh works)
        if (String(options.hostname || '').includes('oidc.')) {
          return { statusCode: 200, body: { accessToken: 'd'.repeat(232), expiresIn: 3600 } };
        }
        return { statusCode: 200, body: {} };
      },
    });

    const adapter = require('../src/services/gateway/adapters/kiroAdapter');
    adapter.destroy();

    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const models = await adapter.listModels();

    // Falls back to baseline
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].discoverySource).toBe('baseline');
    // Baseline models should have descriptions
    expect(models[0].description).toContain('Baseline');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 4: persistObservedToken does NOT save profile_cache profileArn to pool
  // ─────────────────────────────────────────────────────────────────────
  test('persistObservedToken omits profile_cache profileArn from pool authData', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kiro-persist-'));
    process.env.HOME = tempHome;
    process.env.KIRO_AUTO_PROXY = '0';
    if (process.platform === 'linux') {
      process.env.XDG_CONFIG_HOME = path.join(tempHome, '.config');
    }

    const cacheDir = path.join(tempHome, '.aws', 'sso', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });

    writeTokenFile(cacheDir, { profileArn: undefined });
    writeStaleProfile(getKiroProfileDir(), 'arn:aws:iam::444444:profile/stale-persist');

    const saveObservedToken = jest.fn(async () => ({ id: 1 }));

    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => tempHome };
    });
    jest.doMock('../src/services/accountPool', () => ({
      init: jest.fn(async () => {}),
      getActiveToken: jest.fn(async () => null),
      saveObservedToken,
      autoImportObservedCredentials: jest.fn(async () => {}),
    }));

    const adapter = require('../src/services/gateway/adapters/kiroAdapter');
    adapter.destroy();

    // getAccessToken triggers assignCachedToken → persistObservedToken
    const tokenData = await adapter.getAccessToken({ autoOpenLogin: false });

    // Token should have profileArn from profile.json cache
    expect(tokenData.profileArn).toBe('arn:aws:iam::444444:profile/stale-persist');
    expect(tokenData._profileArnSource).toBe('profile_cache');

    // Wait for async persistObservedToken to execute
    await new Promise(r => setTimeout(r, 50));

    // The profileArn saved to pool should be null (not the stale one)
    expect(saveObservedToken).toHaveBeenCalled();
    const savedData = saveObservedToken.mock.calls[0][1];
    expect(savedData.authData.profileArn).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 5: local token is preferred over pool token when both are valid
  // ─────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────
  // Test 5: same account → local preferred (fresher disk copy)
  // ─────────────────────────────────────────────────────────────────────
  test('getAccessToken prefers local disk token when pool has same account', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kiro-prefer-'));
    process.env.HOME = tempHome;
    process.env.KIRO_AUTO_PROXY = '0';
    if (process.platform === 'linux') {
      process.env.XDG_CONFIG_HOME = path.join(tempHome, '.config');
    }

    const cacheDir = path.join(tempHome, '.aws', 'sso', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });

    const sharedToken = 'a'.repeat(232);

    // Local token: same accessToken as pool (same account)
    writeTokenFile(cacheDir, {
      accessToken: sharedToken,
      profileArn: undefined,
    });

    // Pool token: same accessToken but with stale profileArn from pool authData
    const poolToken = {
      poolType: 'kiro',
      accountId: 1,
      label: 'pool-kiro',
      accessToken: sharedToken,
      refreshToken: 'r'.repeat(64),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      sourcePath: '',
      authData: {
        profileArn: 'arn:aws:iam::555555:profile/pool-stale',
        authMethod: 'IdC',
      },
    };

    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => tempHome };
    });
    jest.doMock('../src/services/accountPool', () => ({
      init: jest.fn(async () => {}),
      getActiveToken: jest.fn(async () => poolToken),
      saveObservedToken: jest.fn(async () => ({ id: 1 })),
      autoImportObservedCredentials: jest.fn(async () => {}),
    }));

    const adapter = require('../src/services/gateway/adapters/kiroAdapter');
    adapter.destroy();

    const tokenData = await adapter.getAccessToken({ autoOpenLogin: false });

    // Same account → should use local (no stale pool authData profileArn)
    expect(tokenData.accessToken).toBe(sharedToken);
    // Local token has no profileArn (pool's stale one should NOT leak through)
    expect(tokenData.profileArn).toBeFalsy();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 6: different account in pool → pool preferred (account was switched)
  // ─────────────────────────────────────────────────────────────────────
  test('getAccessToken prefers pool token when pool has different account (switched)', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kiro-switched-'));
    process.env.HOME = tempHome;
    process.env.KIRO_AUTO_PROXY = '0';
    if (process.platform === 'linux') {
      process.env.XDG_CONFIG_HOME = path.join(tempHome, '.config');
    }

    const cacheDir = path.join(tempHome, '.aws', 'sso', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });

    // Local token: old/banned account
    writeTokenFile(cacheDir, {
      accessToken: 'old_banned_' + 'a'.repeat(220),
      profileArn: undefined,
    });

    // Pool token: different account (pool was switched after ban)
    const poolToken = {
      poolType: 'kiro',
      accountId: 2,
      label: 'pool-new',
      accessToken: 'new_account_' + 'b'.repeat(220),
      refreshToken: 'r'.repeat(64),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      sourcePath: '',
      authData: {
        profileArn: 'arn:aws:iam::666666:profile/new-account',
        authMethod: 'IdC',
      },
    };

    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => tempHome };
    });
    jest.doMock('../src/services/accountPool', () => ({
      init: jest.fn(async () => {}),
      getActiveToken: jest.fn(async () => poolToken),
      saveObservedToken: jest.fn(async () => ({ id: 1 })),
      autoImportObservedCredentials: jest.fn(async () => {}),
    }));

    const adapter = require('../src/services/gateway/adapters/kiroAdapter');
    adapter.destroy();

    const tokenData = await adapter.getAccessToken({ autoOpenLogin: false });

    // Different account → should prefer pool (account was switched)
    expect(tokenData.accessToken).toContain('new_account_');
    expect(tokenData.accessToken).not.toContain('old_banned_');
  });
});
