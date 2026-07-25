'use strict';

/**
 * Trae adapter strict-availability tests.
 *
 * Trae has the most divergent wiring of the IDE-adapter family: a dedicated
 * `_traeStrictInstalled()` (via ideDetector) gates the install side, and
 * `getStatus()` was rewritten to branch on it instead of the looser
 * `_detectionState.installDetected` (which flips true merely because a
 * Nirvana/Trae storage *directory* exists on disk). These tests pin that the
 * status panel reports availability ONLY for a genuine local install + login,
 * and that imported (pool/Nirvana) credentials do not fake availability unless
 * the opt-in flag is set AND Trae is locally installed.
 *
 * Seams (no real machine state is read):
 *   - ideDetector.findInstallation/findDataPath  → controls _traeStrictInstalled()
 *   - traeOfficialArtifacts.resolveTraeOfficialCredential → no encrypted artifacts
 *   - os.homedir → a temp dir, so the module's hard-coded TRAE_STORAGE_PATHS point
 *     under our fixture. A storage.json under ".../Trae/..." is a NATIVE login;
 *     under ".../Nirvana/..." it classifies as an imported credential.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const VALID_ACCESS_TOKEN = `eyJhbGciOiJ${'a'.repeat(48)}.${'b'.repeat(48)}.${'c'.repeat(24)}`;

describe('trae adapter strict availability', () => {
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

  // dir: 'Trae' → native login; 'Nirvana' → imported credential; null → no token file.
  function loadTrae({ installed, tokenDir = null, allowImported = false }) {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-trae-strict-'));

    // os.homedir steers the module's hard-coded TRAE_STORAGE_PATHS into the fixture.
    const realOs = jest.requireActual('os');
    jest.doMock('os', () => ({ ...realOs, homedir: () => tempHome }));

    // Deterministic local-install detection (the strict gate).
    jest.doMock('../../src/services/gateway/adapters/ideDetector', () => ({
      findInstallation: jest.fn((name) => (name === 'trae' && installed ? '/fake/Trae' : null)),
      findDataPath: jest.fn(() => null),
    }));

    // No encrypted official artifacts in any of these scenarios — keep the
    // official scan inert so token source is decided purely by storage.json.
    jest.doMock('../../src/services/gateway/adapters/traeOfficialArtifacts', () => {
      const actual = jest.requireActual('../../src/services/gateway/adapters/traeOfficialArtifacts');
      return {
        ...actual,
        resolveTraeOfficialCredential: jest.fn(() => ({
          officialArtifactsDetected: false,
          credentialMode: 'none',
          sourcePaths: [],
          token: null,
          refreshToken: null,
          endpoint: '',
        })),
        collectTraeOfficialArtifacts: jest.fn(() => ({ sourcePaths: [] })),
      };
    });

    // No pool/Nirvana-cache reads from the real machine.
    jest.doMock('../../src/services/accountPool', () => ({
      getActiveToken: jest.fn(async () => null),
      getPoolActiveToken: jest.fn(async () => null),
    }));

    if (tokenDir) {
      // .config/<dir>/User/globalStorage/storage.json — matches a TRAE_STORAGE_PATHS entry.
      const storageDir = path.join(tempHome, '.config', tokenDir, 'User', 'globalStorage');
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(
        path.join(storageDir, 'storage.json'),
        JSON.stringify({ traeAuth: { accessToken: VALID_ACCESS_TOKEN } }),
        'utf8',
      );
    }

    if (allowImported) process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS = '1';
    else delete process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS;

    return require('../../src/services/gateway/adapters/traeAdapter');
  }

  test('clean machine (not installed, no token) -> not available, 未检测到 Trae 安装', () => {
    const trae = loadTrae({ installed: false, tokenDir: null });
    expect(trae.detect(true)).toBe(false);
    const status = trae.getStatus();
    expect(status.available).toBe(false);
    expect(status.detail).toContain('未检测到 Trae 安装');
  });

  test('installed but not logged in -> not available, login gate message', () => {
    const trae = loadTrae({ installed: true, tokenDir: null });
    expect(trae.detect(true)).toBe(false);
    const status = trae.getStatus();
    expect(status.available).toBe(false);
    expect(status.detail).toContain('未检测到登录态');
  });

  test('native login token (Trae own storage) -> available', () => {
    const trae = loadTrae({ installed: true, tokenDir: 'Trae' });
    expect(trae.detect(true)).toBe(true);
    expect(trae.getStatus().available).toBe(true);
  });

  test('imported (Nirvana) credential alone does NOT count toward availability (strict default)', () => {
    // Nirvana source + Trae NOT installed + flag OFF => must stay unavailable,
    // even though a credential-shaped token is present.
    const trae = loadTrae({ installed: false, tokenDir: 'Nirvana', allowImported: false });
    expect(trae.detect(true)).toBe(false);
    expect(trae.getStatus().available).toBe(false);
  });

  test('imported credential counts only when installed AND opt-in flag is set', () => {
    const trae = loadTrae({ installed: true, tokenDir: 'Nirvana', allowImported: true });
    expect(trae.detect(true)).toBe(true);
    expect(trae.getStatus().available).toBe(true);
  });
});
