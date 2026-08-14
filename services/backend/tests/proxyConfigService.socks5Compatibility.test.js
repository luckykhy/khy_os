'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('proxyConfigService socks5 compatibility', () => {
  const originalEnv = { ...process.env };
  let tempHome = null;

  function mockOsHome(homeDir) {
    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => homeDir };
    });
  }

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

  test('rejects manual socks5 enable with clear guidance', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-socks5-compat-'));
    process.env.HOME = tempHome;
    mockOsHome(tempHome);

    const svc = require('../src/services/proxyConfigService');
    const result = await svc.enableProxy({ type: 'socks5', host: '127.0.0.1', port: 1080 });
    expect(result.success).toBe(false);
    expect(String(result.error || '')).toMatch(/HTTP\/HTTPS CONNECT/i);
  });

  test('marks clash config as socksOnly when only socks-port is present', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-socks5-compat-'));
    process.env.HOME = tempHome;
    mockOsHome(tempHome);

    const svc = require('../src/services/proxyConfigService');
    const parsed = svc.parseClashConfigHints([
      'allow-lan: true',
      'mode: rule',
      'socks-port: 7891',
    ].join('\n'));

    expect(parsed.socksOnly).toBe(true);
    expect(parsed.proxy).toBeNull();
    expect(parsed.socksPort).toBe(7891);
  });
});

