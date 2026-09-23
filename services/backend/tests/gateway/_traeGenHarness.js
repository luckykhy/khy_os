'use strict';

/**
 * _traeGenHarness.js — shared offline loader for traeAdapter channel tests.
 *
 * Every load gives a fresh adapter instance whose environment seams are pinned:
 *   - os.homedir()      → a throwaway temp dir (hard-coded TRAE_STORAGE_PATHS land inside it)
 *   - ideDetector       → findInstallation/findDataPath (controls the strict install gate)
 *   - traeOfficialArtifacts → resolveTraeOfficialCredential (official-login branch, overridable)
 *   - accountPool       → no pool tokens
 *   - _proxyTunnel      → requestJson replayed from httpSeam.routes (ZERO real network)
 *   - _cwStreamParser   → optionally broken CW SDK (cwBroken: true)
 *
 * Usage: const { adapter, httpSeam, official, cleanup } = loadTraeAdapter(opts);
 */

const fs = require('fs');
const path = require('path');

const JWT_TOKEN = `eyJhbGciOiJIQzI1NiJ9.${'a'.repeat(48)}.${'b'.repeat(48)}`;
const JWT_TOKEN2 = `eyJhbGciOiJSUzI1NiJ9.${'c'.repeat(48)}.${'d'.repeat(48)}`;
// credential-shaped but NOT a JWT → exercises the CodeWhisperer channel path
const PLAIN_TOKEN = `traeAccessToken${'7'.repeat(20)}`;

function loadTraeAdapter(opts = {}) {
  jest.resetModules();

  const {
    token = null,
    refreshToken = null,
    expiresAt = null,
    endpoint = 'https://relay.example.dev/v1',
    installed = false,
    officialCredential = null,
    cwBroken = false,
  } = opts;

  const realOs = jest.requireActual('os');
  const tempHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'khy-trae-gen-'));

  jest.doMock('os', () => ({
    ...jest.requireActual('os'),
    homedir: () => tempHome,
  }));

  jest.doMock('../../src/services/gateway/adapters/ideDetector', () => ({
    findInstallation: jest.fn(() => (installed ? 'C:\\fake\\Trae' : null)),
    findDataPath: jest.fn(() => null),
  }));

  const official = {
    resolveTraeOfficialCredential: jest.fn(
      () =>
        officialCredential || {
          officialArtifactsDetected: false,
          credentialMode: 'none',
          sourcePaths: [],
          token: null,
          refreshToken: null,
          endpoint: '',
          endpointHints: [],
          regionHint: null,
          authBlobAnalysis: null,
          bridgeStale: false,
        }
    ),
    verifyTraeOfficialSession: jest.fn(async () => ({ sessionVerified: false })),
    writeBridgeAuthToken: jest.fn(),
    collectTraeOfficialArtifacts: jest.fn(() => ({ sourcePaths: [] })),
    resolveTraeOfficialStoragePaths: jest.fn(() => []),
    resolveTraeOfficialDbPaths: jest.fn(() => []),
  };
  jest.doMock('../../src/services/gateway/adapters/traeOfficialArtifacts', () => {
    const actual = jest.requireActual('../../src/services/gateway/adapters/traeOfficialArtifacts');
    return { ...actual, ...official };
  });

  jest.doMock('../../src/services/accountPool', () => ({
    init: jest.fn(async () => {}),
    getActiveToken: jest.fn(async () => null),
  }));

  const httpSeam = {
    calls: [],
    routes: [], // [{ match: RegExp, response: object }] — first match wins
    fallback: { status: 200, headers: { 'content-type': 'application/json' }, raw: '{}', data: {} },
  };
  jest.doMock('../../src/services/gateway/adapters/_proxyTunnel', () => ({
    requestJson: jest.fn(async (url) => {
      httpSeam.calls.push(url);
      for (const r of httpSeam.routes) {
        if (r.match.test(url)) {
          return r.response;
        }
      }
      return httpSeam.fallback;
    }),
    collectProxyCandidates: jest.fn(() => []),
  }));

  if (cwBroken) {
    jest.doMock('../../src/services/gateway/adapters/_cwStreamParser', () => ({
      getCWModule: jest.fn(async () => {
        throw new Error('cw-sdk-disabled-in-test');
      }),
      parseCWStreamEvents: jest.fn(async () => ({ content: '', toolUseBlocks: [], tokenUsage: {} })),
      repairToolUsePairing: (m) => m,
      resetCWModuleCache: jest.fn(),
    }));
  }

  if (token) {
    const storageDir = path.join(tempHome, '.config', 'Trae', 'User', 'globalStorage');
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, 'storage.json'),
      JSON.stringify({
        traeAuth: { accessToken: token, refreshToken, expiresAt, endpoint },
      }),
      'utf8'
    );
  }

  // Deterministic env: strip TRAE_* overrides and the imported-credentials opt-in.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TRAE_')) {
      delete process.env[key];
    }
  }
  delete process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS;

  const adapter = require('../../src/services/gateway/adapters/traeAdapter');

  return {
    adapter,
    httpSeam,
    official,
    tempHome,
    cleanup() {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

module.exports = { loadTraeAdapter, JWT_TOKEN, JWT_TOKEN2, PLAIN_TOKEN };
