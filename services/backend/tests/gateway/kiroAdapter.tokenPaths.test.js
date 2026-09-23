'use strict';

/**
 * kiroAdapter.tokenPaths.test.js — locks getKiroTokenCandidatePaths() of
 * src/services/gateway/adapters/kiroAdapter.js: the multi-root scan that finds
 * the Kiro SSO token regardless of os.homedir() vs %USERPROFILE% mismatches.
 *
 * Locked contract:
 *   1. KIRO_TOKEN_PATH is always first (explicit override wins);
 *   2. SSO cache roots: <home>/.aws/sso/cache (+ win32 %USERPROFILE% and
 *      %HOMEDRIVE%%HOMEPATH% extras), each yielding kiro-auth-token.json;
 *   3. win32 adds %APPDATA%/aws/sso/cache, %LOCALAPPDATA%/aws/sso/cache and
 *      the Kiro IDE auth.json under both AppData roots;
 *   4. darwin adds the Application Support Kiro auth.json;
 *      linux adds the $XDG_CONFIG_HOME Kiro auth.json;
 *   5. every path is normalized and deduped (no repeats, first-wins order).
 *
 * Zero real user data: os.homedir() is pinned to a throwaway temp dir and all
 * Windows roots are faked. Platform-specific blocks no-op on other platforms
 * so the file stays portable. Who changes the scan order or dedup goes red
 * first — this list decides which token file the adapter trusts.
 */
const path = require('path');
const { loadKiroAdapter } = require('./_kiroGenHarness');

const TOKEN_FILE = 'kiro-auth-token.json';
const KIRO_AUTH_SEGMENTS = ['Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'auth.json'];

describe('kiroAdapter.getKiroTokenCandidatePaths (offline, pinned home)', () => {
  function fakeWindowsRoots(tempHome) {
    return {
      APPDATA: path.join(tempHome, 'Roaming'),
      LOCALAPPDATA: path.join(tempHome, 'Local'),
      USERPROFILE: path.join(tempHome, 'user'),
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\fakehome',
    };
  }

  test('win32: 全根扫描 = KIRO_TOKEN_PATH → SSO 缓存 ×3 → AppData token ×2 → Kiro auth.json ×2，去重有序', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const h = loadKiroAdapter({});
    const roots = fakeWindowsRoots(h.tempHome);
    process.env.KIRO_TOKEN_PATH = path.join(h.tempHome, 'explicit', TOKEN_FILE);
    Object.assign(process.env, roots);
    try {
      const got = h.adapter.getKiroTokenCandidatePaths();
      const expected = [
        process.env.KIRO_TOKEN_PATH,
        path.join(h.tempHome, '.aws', 'sso', 'cache', TOKEN_FILE),
        path.join(roots.USERPROFILE, '.aws', 'sso', 'cache', TOKEN_FILE),
        path.join(roots.HOMEDRIVE, roots.HOMEPATH, '.aws', 'sso', 'cache', TOKEN_FILE),
        path.join(roots.APPDATA, 'aws', 'sso', 'cache', TOKEN_FILE),
        path.join(roots.LOCALAPPDATA, 'aws', 'sso', 'cache', TOKEN_FILE),
        path.join(roots.APPDATA, ...KIRO_AUTH_SEGMENTS),
        path.join(roots.LOCALAPPDATA, ...KIRO_AUTH_SEGMENTS),
      ].map((p) => path.normalize(p));
      expect(got).toEqual(expected);
      // dedup invariant: no repeated entry
      expect(new Set(got).size).toBe(got.length);
    } finally {
      h.cleanup();
    }
  });

  test('win32: 无 env 覆盖时只剩 <home>/.aws/sso/cache 一条候选', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const h = loadKiroAdapter({});
    // clear the fake roots for this variant
    for (const key of ['KIRO_TOKEN_PATH', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
      delete process.env[key];
    }
    try {
      const got = h.adapter.getKiroTokenCandidatePaths();
      expect(got).toEqual([path.join(h.tempHome, '.aws', 'sso', 'cache', TOKEN_FILE)]);
    } finally {
      h.cleanup();
    }
  });

  test('darwin: SSO 缓存 + Application Support 下 Kiro auth.json', () => {
    if (process.platform !== 'darwin') {
      return;
    }
    const h = loadKiroAdapter({});
    try {
      const got = h.adapter.getKiroTokenCandidatePaths();
      expect(got).toEqual([
        path.join(h.tempHome, '.aws', 'sso', 'cache', TOKEN_FILE),
        path.join(h.tempHome, 'Library', 'Application Support', ...KIRO_AUTH_SEGMENTS),
      ]);
    } finally {
      h.cleanup();
    }
  });

  test('linux: XDG_CONFIG_HOME 覆盖优先，缺省时落 <home>/.config', () => {
    if (process.platform !== 'linux') {
      return;
    }
    const h = loadKiroAdapter({});
    try {
      const defaultGot = h.adapter.getKiroTokenCandidatePaths();
      expect(defaultGot).toEqual([
        path.join(h.tempHome, '.aws', 'sso', 'cache', TOKEN_FILE),
        path.join(h.tempHome, '.config', ...KIRO_AUTH_SEGMENTS),
      ]);
      process.env.XDG_CONFIG_HOME = path.join(h.tempHome, 'xdg');
      const xdgGot = h.adapter.getKiroTokenCandidatePaths();
      expect(xdgGot[1]).toBe(path.join(h.tempHome, 'xdg', ...KIRO_AUTH_SEGMENTS));
    } finally {
      h.cleanup();
    }
  });
});
