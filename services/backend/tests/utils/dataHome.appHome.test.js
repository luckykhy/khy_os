/**
 * Unit tests for getAppHome() — the single application-data-home resolver.
 *
 * Contract (legacy-safe convergence, zero migration):
 *   1. KHY_APP_HOME explicit override wins.
 *   2. established-wins: if legacy ~/.khyquant already holds real data, keep it
 *      in place (existing installs behave EXACTLY as before — no data moved).
 *   3. fresh install (no legacy data): converge on getDataHome() (~/.khy).
 *
 * This is P0-1's "stop new write sites from forking" step: every service that
 * used to hardcode os.homedir()+'.khyquant' funnels through this resolver.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

describe('dataHome — getAppHome() legacy-safe convergence', () => {
  const OLD_ENV = { ...process.env };
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-apphome-'));
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    jest.resetModules();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('KHY_APP_HOME override wins over everything', () => {
    const override = path.join(tmpHome, 'custom-app');
    process.env.KHY_APP_HOME = override;
    jest.resetModules();
    const d = require('../../src/utils/dataHome');
    expect(d.getAppHome()).toBe(path.resolve(override));
  });

  test('established legacy ~/.khyquant is kept in place (zero data loss)', () => {
    // Simulate an existing install: legacy home holds real content.
    const legacy = path.join(tmpHome, '.khyquant');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'cloud.json'), '{}');

    delete process.env.KHY_APP_HOME;
    delete process.env.KHY_DATA_HOME;
    const spy = jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    jest.resetModules();
    const d = require('../../src/utils/dataHome');
    expect(d.getAppHome()).toBe(legacy);
    spy.mockRestore();
  });

  test('fresh install (no legacy data) converges on getDataHome()', () => {
    delete process.env.KHY_APP_HOME;
    // Point the unified resolver at a clean fresh home; no ~/.khyquant exists.
    const fresh = path.join(tmpHome, '.khy');
    process.env.KHY_DATA_HOME = fresh;
    const spy = jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    jest.resetModules();
    const d = require('../../src/utils/dataHome');
    expect(d.getAppHome()).toBe(d.getDataHome());
    expect(d.getAppHome()).toBe(fresh);
    spy.mockRestore();
  });

  test('getAppDataDir() nests under the resolved app home', () => {
    const override = path.join(tmpHome, 'custom-app');
    process.env.KHY_APP_HOME = override;
    jest.resetModules();
    const d = require('../../src/utils/dataHome');
    expect(d.getAppDataDir('skills')).toBe(path.join(path.resolve(override), 'skills'));
  });

  // ── 及时同步:convergence WITHOUT restart (KHY_APP_HOME_LIVE_RESOLVE) ─────────
  describe('timely admin↔user sync (live resolve of the non-established fallback)', () => {
    test('_appHomeLiveResolveEnabled: default ON, only {0,false,off,no} disable', () => {
      const d = require('../../src/utils/dataHome');
      const set = (v) => { if (v === undefined) delete process.env.KHY_APP_HOME_LIVE_RESOLVE; else process.env.KHY_APP_HOME_LIVE_RESOLVE = v; return d._appHomeLiveResolveEnabled(); };
      expect(set(undefined)).toBe(true);
      expect(set('1')).toBe(true);
      expect(set('on')).toBe(true);
      expect(set('0')).toBe(false);
      expect(set('false')).toBe(false);
      expect(set('off')).toBe(false);
      expect(set('no')).toBe(false);
    });

    test('gate ON: fallback is NOT cached → converges onto legacy once established (no restart)', () => {
      delete process.env.KHY_APP_HOME;
      delete process.env.KHY_APP_HOME_LIVE_RESOLVE; // default on
      const fresh = path.join(tmpHome, '.khy');
      process.env.KHY_DATA_HOME = fresh;
      const spy = jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
      jest.resetModules();
      const d = require('../../src/utils/dataHome');

      // First read: legacy ~/.khyquant not established → unified fallback.
      expect(d.getAppHome()).toBe(fresh);

      // A user-data producer now establishes the legacy home MID-PROCESS.
      const legacy = path.join(tmpHome, '.khyquant');
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'token_usage.json'), '{}');

      // Next read converges onto legacy WITHOUT any cache reset / restart.
      expect(d.getAppHome()).toBe(legacy);
      spy.mockRestore();
    });

    test('gate OFF: fallback is frozen on first access (historical behavior, byte-revert)', () => {
      delete process.env.KHY_APP_HOME;
      process.env.KHY_APP_HOME_LIVE_RESOLVE = 'off';
      const fresh = path.join(tmpHome, '.khy');
      process.env.KHY_DATA_HOME = fresh;
      const spy = jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
      jest.resetModules();
      const d = require('../../src/utils/dataHome');

      expect(d.getAppHome()).toBe(fresh); // frozen here

      // Even after legacy is established, the frozen fallback persists (no sync).
      const legacy = path.join(tmpHome, '.khyquant');
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'token_usage.json'), '{}');

      expect(d.getAppHome()).toBe(fresh); // still frozen, unchanged
      spy.mockRestore();
    });

    test('established-legacy branch is still cached (monotonic, unaffected by gate)', () => {
      delete process.env.KHY_APP_HOME;
      delete process.env.KHY_APP_HOME_LIVE_RESOLVE;
      const legacy = path.join(tmpHome, '.khyquant');
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'cloud.json'), '{}');
      const spy = jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
      jest.resetModules();
      const d = require('../../src/utils/dataHome');
      expect(d.getAppHome()).toBe(legacy);
      expect(d.getAppHome()).toBe(legacy); // second call identical
      spy.mockRestore();
    });
  });
});
