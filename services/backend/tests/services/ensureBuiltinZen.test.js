'use strict';

/**
 * ensureBuiltinZen — built-in OpenCode Zen free channel seed contract.
 *
 * Mirrors the SenseNova seed tests: pool key + metadata + env routing are
 * registered idempotently via registerCustomProvider (hermetic stubs).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const poolKeys = [];
let savedProvider = null;

jest.mock('../../src/services/apiKeyPool', () => ({
  init: jest.fn(),
  addKey: jest.fn((poolKey, entry) => {
    const id = `k${poolKeys.length + 1}`;
    poolKeys.push({ poolKey, entry, id });
    return id;
  }),
  removeKey: jest.fn((poolKey, keyId) => {
    const idx = poolKeys.findIndex((e) => e.poolKey === poolKey && e.id === keyId);
    if (idx !== -1) poolKeys.splice(idx, 1);
  }),
  getPoolStatus: jest.fn((poolKey) =>
    poolKeys.filter((e) => e.poolKey === poolKey).map((e) => ({ keyId: e.id }))
  ),
}));

jest.mock('../../src/services/customProviderRegistry', () => {
  const BUILTIN = new Set(['deepseek', 'qwen', 'openai', 'anthropic', 'relay']);
  let store = [];
  return {
    isBuiltinPoolKey: (k) => BUILTIN.has(k),
    saveProvider: jest.fn((cfg) => {
      savedProvider = cfg;
      store = store.filter((p) => p.poolKey !== cfg.poolKey).concat(cfg);
      return cfg;
    }),
    getProvider: (k) => store.find((p) => p.poolKey === k) || null,
    removeProvider: jest.fn((k) => {
      const before = store.length;
      store = store.filter((p) => p.poolKey !== k);
      return store.length < before;
    }),
    listProviders: () => store.slice(),
  };
});

let registrar;
let tmpEnvPath;

const ENV_KEYS = [
  'GATEWAY_API_POOL_SERVICE_MAP',
  'GATEWAY_API_POOL_DEFAULT_MODEL_MAP',
  'PROXY_MODEL_ROUTE_MAP',
  'KHY_MODEL_TIER_MAP',
  'KHY_ENV_FILE',
  'KHY_ENV_SYNC_ROOT',
];

beforeEach(() => {
  poolKeys.length = 0;
  savedProvider = null;
  for (const k of ENV_KEYS) delete process.env[k];
  tmpEnvPath = path.join(os.tmpdir(), `khy-zen-seed-${process.pid}-${Date.now()}.env`);
  process.env.KHY_ENV_FILE = tmpEnvPath;
  process.env.KHY_ENV_SYNC_ROOT = 'false';
  jest.resetModules();
  registrar = require('../../src/services/customProviderRegistrar');
});

afterEach(() => {
  try {
    if (tmpEnvPath && fs.existsSync(tmpEnvPath)) fs.unlinkSync(tmpEnvPath);
  } catch {
    /* ignore */
  }
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('ensureBuiltinZen', () => {
  test('seeds opencode-zen: pool key public + metadata + openai service route', () => {
    const res = registrar.ensureBuiltinZen({ force: true });
    expect(res.seeded).toBe(true);
    expect(res.poolKey).toBe('opencode-zen');

    expect(poolKeys.some((e) => e.poolKey === 'opencode-zen' && e.entry.key === 'public')).toBe(
      true
    );
    expect(savedProvider.poolKey).toBe('opencode-zen');
    expect(savedProvider.defaultModel).toBeTruthy();
    expect(Array.isArray(savedProvider.models) && savedProvider.models.length > 0).toBe(true);
    expect(process.env.GATEWAY_API_POOL_SERVICE_MAP).toContain('opencode-zen');
    expect(process.env.GATEWAY_API_POOL_SERVICE_MAP).toContain('openai');
  });

  test('idempotent: second call without force is a no-op when already seeded', () => {
    registrar.ensureBuiltinZen({ force: true });
    const firstCount = poolKeys.filter((e) => e.poolKey === 'opencode-zen').length;
    const res = registrar.ensureBuiltinZen();
    expect(res.seeded).toBe(false);
    expect(poolKeys.filter((e) => e.poolKey === 'opencode-zen').length).toBe(firstCount);
  });

  test('BUILTIN_ZEN endpoint comes from serviceDefaults.ZEN_BASE_URL (SSOT)', () => {
    const { ZEN_BASE_URL } = require('../../src/constants/serviceDefaults');
    expect(registrar.BUILTIN_ZEN.endpoint.replace(/\/+$/, '')).toBe(
      ZEN_BASE_URL.replace(/\/+$/, '')
    );
    expect(registrar.BUILTIN_ZEN.key).toBe('public');
  });
});
