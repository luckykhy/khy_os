'use strict';

/**
 * Unit tests for customProviderRegistrar — the shared registration logic used
 * by both the CLI and the runtime admin API. The stateful dependencies
 * (apiKeyPool, customProviderRegistry) are mocked with in-memory stubs so the
 * test is hermetic; env persistence is redirected to a temp .env file.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// In-memory stubs captured by the mocks below.
const poolKeys = [];
let savedProvider = null;

jest.mock('../src/services/apiKeyPool', () => ({
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
  getPoolStatus: jest.fn((poolKey) => poolKeys
    .filter((e) => e.poolKey === poolKey)
    .map((e) => ({ keyId: e.id }))),
}));

jest.mock('../src/services/customProviderRegistry', () => {
  const BUILTIN = new Set(['deepseek', 'qwen', 'openai', 'anthropic', 'relay']);
  let store = [];
  return {
    isBuiltinPoolKey: (k) => BUILTIN.has(k),
    saveProvider: jest.fn((cfg) => { savedProvider = cfg; store = store.filter(p => p.poolKey !== cfg.poolKey).concat(cfg); return cfg; }),
    getProvider: (k) => store.find(p => p.poolKey === k) || null,
    removeProvider: jest.fn((k) => { const before = store.length; store = store.filter(p => p.poolKey !== k); return store.length < before; }),
    listProviders: () => store.slice(),
  };
});

let envFile;
let registrar;

const ENV_KEYS = [
  'GATEWAY_API_POOL_SERVICE_MAP',
  'GATEWAY_API_POOL_DEFAULT_MODEL_MAP',
  'PROXY_MODEL_ROUTE_MAP',
  'KHY_MODEL_TIER_MAP',
  'KHY_ENV_FILE',
  'KHY_ENV_SYNC_ROOT',
];

let tmpEnvPath;

beforeEach(() => {
  poolKeys.length = 0;
  savedProvider = null;
  for (const k of ENV_KEYS) delete process.env[k];
  // Redirect .env persistence to a temp file, disable repo-root mirror.
  tmpEnvPath = path.join(os.tmpdir(), `khy-registrar-test-${process.pid}-${Date.now()}.env`);
  process.env.KHY_ENV_FILE = tmpEnvPath;
  process.env.KHY_ENV_SYNC_ROOT = 'false';
  jest.resetModules();
  envFile = require('../src/services/gatewayEnvFile');
  registrar = require('../src/services/customProviderRegistrar');
});

afterEach(() => {
  try { if (tmpEnvPath && fs.existsSync(tmpEnvPath)) fs.unlinkSync(tmpEnvPath); } catch { /* ignore */ }
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('registerCustomProvider', () => {
  test('registers Agnes: pool key + metadata + env routing maps', () => {
    const result = registrar.registerCustomProvider({
      displayName: 'Agnes AI',
      poolKey: 'agnes',
      endpoint: 'https://apihub.agnes-ai.com/v1',
      keyInput: 'sk-test-agnes-123',
      defaultModel: 'agnes-2.0-flash',
      extraModels: '',
      tier: '',
    });

    expect(result.poolKey).toBe('agnes');
    expect(result.models).toEqual(['agnes-2.0-flash']);
    expect(result.keyCount).toBe(1);

    // key added to pool under the normalized key
    expect(poolKeys).toHaveLength(1);
    expect(poolKeys[0].poolKey).toBe('agnes');
    expect(poolKeys[0].entry.key).toBe('sk-test-agnes-123');

    // metadata persisted
    expect(savedProvider).toMatchObject({
      name: 'Agnes AI', poolKey: 'agnes',
      endpoint: 'https://apihub.agnes-ai.com/v1', defaultModel: 'agnes-2.0-flash',
    });
    expect(savedProvider.tier).toBeUndefined();

    // env maps in process.env
    expect(JSON.parse(process.env.GATEWAY_API_POOL_SERVICE_MAP)).toMatchObject({ agnes: 'openai' });
    expect(JSON.parse(process.env.GATEWAY_API_POOL_DEFAULT_MODEL_MAP)).toMatchObject({ agnes: 'agnes-2.0-flash' });
    const route = JSON.parse(process.env.PROXY_MODEL_ROUTE_MAP);
    expect(route['agnes-2.0-flash']).toEqual({ target: 'api:agnes:agnes-2.0-flash', strict: true });

    // no tier map when tier is empty
    expect(process.env.KHY_MODEL_TIER_MAP).toBeUndefined();

    // persisted to the temp .env
    const envContent = fs.readFileSync(tmpEnvPath, 'utf-8');
    expect(envContent).toMatch(/PROXY_MODEL_ROUTE_MAP=/);
  });

  test('explicit tier writes KHY_MODEL_TIER_MAP and persists tier in metadata', () => {
    registrar.registerCustomProvider({
      displayName: 'Agnes AI',
      poolKey: 'agnes',
      endpoint: 'https://apihub.agnes-ai.com/v1',
      keyInput: 'sk-test',
      defaultModel: 'agnes-2.0-flash',
      extraModels: 'agnes-2.0-pro',
      tier: 'T1',
    });

    const tierMap = JSON.parse(process.env.KHY_MODEL_TIER_MAP);
    expect(tierMap['agnes-2.0-flash']).toBe('T1');
    expect(tierMap['agnes-2.0-pro']).toBe('T1');
    expect(savedProvider.tier).toBe('T1');

    // both models routed
    const route = JSON.parse(process.env.PROXY_MODEL_ROUTE_MAP);
    expect(route['agnes-2.0-flash'].target).toBe('api:agnes:agnes-2.0-flash');
    expect(route['agnes-2.0-pro'].target).toBe('api:agnes:agnes-2.0-pro');
  });

  test('rejects built-in pool keys', () => {
    expect(() => registrar.registerCustomProvider({
      displayName: 'X', poolKey: 'openai', endpoint: 'https://x/v1',
      keyInput: 'sk-1', defaultModel: 'm',
    })).toThrow(/内置/);
  });

  test('rejects invalid pool key / endpoint / missing key', () => {
    expect(() => registrar.registerCustomProvider({
      displayName: 'X', poolKey: 'Bad Key!', endpoint: 'https://x/v1',
      keyInput: 'sk-1', defaultModel: 'm',
    })).toThrow();
    expect(() => registrar.registerCustomProvider({
      displayName: 'X', poolKey: 'good', endpoint: 'not-a-url',
      keyInput: 'sk-1', defaultModel: 'm',
    })).toThrow(/URL/);
    expect(() => registrar.registerCustomProvider({
      displayName: 'X', poolKey: 'good', endpoint: 'https://x/v1',
      keyInput: '', defaultModel: 'm',
    })).toThrow(/API Key/);
  });

  test('invalid tier is rejected', () => {
    expect(() => registrar.registerCustomProvider({
      displayName: 'X', poolKey: 'good', endpoint: 'https://x/v1',
      keyInput: 'sk-1', defaultModel: 'm', tier: 'T9',
    })).toThrow(/tier/i);
  });
});

describe('unregisterCustomProvider', () => {
  test('removes metadata and strips env routing entries', () => {
    registrar.registerCustomProvider({
      displayName: 'Agnes AI', poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v1',
      keyInput: 'sk-test', defaultModel: 'agnes-2.0-flash', tier: 'T1',
    });
    expect(process.env.GATEWAY_API_POOL_SERVICE_MAP).toContain('agnes');

    const res = registrar.unregisterCustomProvider('agnes');
    expect(res.removed).toBe(true);
    expect(res.keptKeys).toBe(true);

    // service/default maps emptied → env var unset
    expect(process.env.GATEWAY_API_POOL_SERVICE_MAP).toBeUndefined();
    expect(process.env.GATEWAY_API_POOL_DEFAULT_MODEL_MAP).toBeUndefined();
    // route + tier entries for the model gone
    expect(process.env.PROXY_MODEL_ROUTE_MAP).toBeUndefined();
    expect(process.env.KHY_MODEL_TIER_MAP).toBeUndefined();
  });

  test('refuses to remove a built-in pool key', () => {
    expect(() => registrar.unregisterCustomProvider('openai')).toThrow(/内置/);
  });
});

describe('replaceProviderKeys', () => {
  test('swaps the pool keys of a registered provider, metadata untouched', () => {
    registrar.registerCustomProvider({
      displayName: 'Agnes AI', poolKey: 'agnes',
      endpoint: 'https://apihub.agnes-ai.com/v1',
      keyInput: 'sk-old', defaultModel: 'agnes-2.0-flash',
    });
    expect(poolKeys.map((e) => e.entry.key)).toEqual(['sk-old']);

    const res = registrar.replaceProviderKeys('agnes', 'sk-new');
    expect(res.poolKey).toBe('agnes');
    expect(res.keyCount).toBe(1);
    // old key gone, new key present
    expect(poolKeys.map((e) => e.entry.key)).toEqual(['sk-new']);
  });

  test('throws when the provider is not registered', () => {
    expect(() => registrar.replaceProviderKeys('ghost', 'sk-x')).toThrow(/未注册/);
  });

  test('throws when no valid key is parsed', () => {
    registrar.registerCustomProvider({
      displayName: 'Agnes AI', poolKey: 'agnes',
      endpoint: 'https://apihub.agnes-ai.com/v1',
      keyInput: 'sk-old', defaultModel: 'agnes-2.0-flash',
    });
    expect(() => registrar.replaceProviderKeys('agnes', '')).toThrow(/未解析到有效 API Key/);
  });
});
