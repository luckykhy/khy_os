'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('proxyConfigService subscription lookup', () => {
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

  test('matches a clash:// imported subscription via normalized https url', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-sub-lookup-'));
    process.env.HOME = tempHome;
    mockOsHome(tempHome);

    const svc = require('../src/services/proxyConfigService');
    const base = 'https://foo.bar/sub?a=1';
    const clash = `clash://install-config?url=${encodeURIComponent(base)}`;

    const added = svc.addSubscription(clash, 'from-clash');
    expect(added.success).toBe(true);
    expect(added.subscription.url).toBe(base);
    expect(added.subscription.sourceUrl).toBe(clash);

    const useByHttp = svc.setActiveSubscription(base);
    expect(useByHttp.success).toBe(true);
    expect(useByHttp.active.id).toBe(added.subscription.id);
  });

  test('matches a plain https subscription via sub:// and clash:// aliases', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-sub-lookup-'));
    process.env.HOME = tempHome;
    mockOsHome(tempHome);

    const svc = require('../src/services/proxyConfigService');
    const base = 'https://example.com/sub?token=abc';
    const sub = `sub://${Buffer.from(base).toString('base64')}`;
    const clash = `clash://install-config?url=${encodeURIComponent(base)}`;

    const added = svc.addSubscription(base, 'from-http');
    expect(added.success).toBe(true);

    const useBySub = svc.setActiveSubscription(sub);
    expect(useBySub.success).toBe(true);
    expect(useBySub.active.id).toBe(added.subscription.id);

    const useByClash = svc.setActiveSubscription(clash);
    expect(useByClash.success).toBe(true);
    expect(useByClash.active.id).toBe(added.subscription.id);
  });
});
