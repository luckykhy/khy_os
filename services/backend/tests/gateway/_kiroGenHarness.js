'use strict';

/**
 * _kiroGenHarness.js — shared offline loader for kiroAdapter channel tests.
 *
 * Every load gives a fresh adapter instance whose environment seams are pinned:
 *   - os.homedir()      → a throwaway temp dir (token/profile scans stay inside it)
 *   - ipAnonymizer      → identity header sanitizer (no outbound shape changes)
 *   - proxyConfigService→ no live proxy event listener
 *   - _proxyTunnel      → requestJson replayed from canned responses (ZERO real network)
 *   - accountPool       → no pool tokens, no disk pool (hermetic getAccessToken)
 *
 * The module reads KIRO_* env at LOAD time, so per-test env overrides must be
 * passed to loadKiroAdapter() — they are applied BEFORE the require.
 *
 * Usage:
 *   const h = loadKiroAdapter({ env: { KIRO_PROXY_URL: 'https://kiro-proxy.example' } });
 *   try { ... } finally { h.adapter.destroy(); h.cleanup(); }
 */

const fs = require('fs');
const path = require('path');

// Env keys the adapter reads at load or call time — scrubbed so tests are
// deterministic, restored verbatim on cleanup().
const KIRO_ENV_KEYS = [
  'KIRO_PROXY_URL',
  'KIRO_DEBUG',
  'KIRO_AUTO_OPEN_LOGIN',
  'KIRO_AUTO_PROXY',
  'KIRO_TOKEN_PATH',
  'KIRO_INJECT_CLAUDE_MODELS',
  'KIRO_MODEL_CACHE_MS',
  'KIRO_WARM_CHECK_INTERVAL_MS',
  'KIRO_VERSION',
  'KIRO_LOGIN_URL',
  'KIRO_LOGIN_COOLDOWN_MS',
  'KIRO_ACTIVE_WINDOW_MS',
  'KIRO_DISCOVERY_REQUIRE_PROXY',
  'KIRO_PROXY_RETRY_MS',
  'KIRO_PROXY_ROUTE_MODE',
  'KIRO_HTTP_PROXY',
  'kiro_http_proxy',
  'GATEWAY_PREFERRED_ADAPTER',
  'KHY_KIRO_ABORT',
  // Windows SSO/IDE roots — pinned to fake values so no real user tree is read
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
];

function loadKiroAdapter(opts = {}) {
  jest.resetModules();

  const { env = {}, defaultRequest = null } = opts;

  const realOs = jest.requireActual('os');
  const tempHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'khy-kiro-gen-'));

  jest.doMock('os', () => ({
    ...realOs,
    homedir: () => tempHome,
  }));

  jest.doMock('../../src/services/gateway/adapters/ipAnonymizer', () => ({
    sanitizeOutgoingHeaders: (h) => h,
  }));

  jest.doMock('../../src/services/proxyConfigService', () => ({
    proxyEvents: { on: jest.fn() },
    getActiveProxy: () => null,
  }));

  const requestJson = jest.fn(async () => {
    if (defaultRequest) {
      return defaultRequest;
    }
    return { status: 200, data: {} };
  });
  jest.doMock('../../src/services/gateway/adapters/_proxyTunnel', () => ({
    requestJson,
    collectProxyCandidates: jest.fn(() => []),
  }));

  jest.doMock('../../src/services/accountPool', () => ({
    init: jest.fn(async () => {}),
    getActiveToken: jest.fn(async () => null),
    saveObservedToken: jest.fn(async () => null),
    autoImportObservedCredentials: jest.fn(async () => {}),
    banActiveAccount: jest.fn(async () => null),
    cooldownAccount: jest.fn(async () => null),
    setActiveAccount: jest.fn(async () => {}),
  }));

  // Scrub real env, then apply the deterministic per-test overrides.
  const saved = {};
  for (const key of KIRO_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  const adapter = require('../../src/services/gateway/adapters/kiroAdapter');

  return {
    adapter,
    requestJson,
    tempHome,
    cleanup() {
      adapter.destroy();
      for (const key of KIRO_ENV_KEYS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

module.exports = { loadKiroAdapter, KIRO_ENV_KEYS };
