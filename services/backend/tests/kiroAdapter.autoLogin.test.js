'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('kiro adapter auto-login trigger', () => {
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

  function setupBaseMocks({ installPath = null } = {}) {
    const spawnGuiApp = jest.fn(() => ({ unref: jest.fn() }));
    const openDefault = jest.fn(() => ({ unref: jest.fn() }));

    jest.doMock('../src/services/accountPool', () => ({
      init: jest.fn(async () => {}),
      getActiveToken: jest.fn(async () => null),
      saveObservedToken: jest.fn(async () => ({ id: 1 })),
    }));
    jest.doMock('../src/tools/platformUtils', () => ({
      spawnGuiApp,
      openDefault,
    }));
    jest.doMock('../src/services/gateway/adapters/ideDetector', () => ({
      findInstallation: jest.fn(() => installPath),
      findDataPath: jest.fn(() => null),
    }));

    return { spawnGuiApp, openDefault };
  }

  test('opens Kiro login entry when no token is found and interactive login is requested', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kiro-autologin-'));
    process.env.HOME = tempHome;
    process.env.KIRO_AUTO_OPEN_LOGIN = '1';

    const fakeInstall = path.join(tempHome, 'Kiro', 'Kiro.exe');
    fs.mkdirSync(path.dirname(fakeInstall), { recursive: true });
    fs.writeFileSync(fakeInstall, 'stub', 'utf8');

    const { spawnGuiApp, openDefault } = setupBaseMocks({ installPath: fakeInstall });
    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => tempHome };
    });

    const adapter = require('../src/services/gateway/adapters/kiroAdapter');
    adapter.destroy();

    await expect(adapter.getAccessToken({ autoOpenLogin: true }))
      .rejects
      .toThrow('No Kiro token found');

    expect(spawnGuiApp).toHaveBeenCalledTimes(1);
    expect(openDefault).not.toHaveBeenCalled();
  });

  test('opens Kiro login entry when token is expired and refresh token is missing', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kiro-autologin-'));
    process.env.HOME = tempHome;
    process.env.KIRO_AUTO_OPEN_LOGIN = '1';

    const fakeInstall = path.join(tempHome, 'Kiro', 'Kiro.exe');
    fs.mkdirSync(path.dirname(fakeInstall), { recursive: true });
    fs.writeFileSync(fakeInstall, 'stub', 'utf8');

    const cacheDir = path.join(tempHome, '.aws', 'sso', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'kiro-auth-token.json'), JSON.stringify({
      accessToken: `expired-${'a'.repeat(40)}`,
      expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      authMethod: 'IdC',
    }, null, 2), 'utf8');

    const { spawnGuiApp, openDefault } = setupBaseMocks({ installPath: fakeInstall });
    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => tempHome };
    });

    const adapter = require('../src/services/gateway/adapters/kiroAdapter');
    adapter.destroy();

    await expect(adapter.getAccessToken({ autoOpenLogin: true }))
      .rejects
      .toThrow('token expired, no refreshToken');

    expect(spawnGuiApp).toHaveBeenCalledTimes(1);
    expect(openDefault).not.toHaveBeenCalled();
  });

  test('detectAsync does not open login flow when token is unavailable', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kiro-autologin-'));
    process.env.HOME = tempHome;
    process.env.KIRO_AUTO_OPEN_LOGIN = '1';

    const { spawnGuiApp, openDefault } = setupBaseMocks({ installPath: null });
    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => tempHome };
    });

    const adapter = require('../src/services/gateway/adapters/kiroAdapter');
    adapter.destroy();

    const available = await adapter.detectAsync();
    expect(available).toBe(false);
    expect(spawnGuiApp).not.toHaveBeenCalled();
    expect(openDefault).not.toHaveBeenCalled();
  });
});
