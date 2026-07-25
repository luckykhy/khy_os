'use strict';

/**
 * Unit tests for agnesProvisioner — one API key → up to three subsystems
 * (chat provider pool, image backend env, video backend env). The stateful
 * deps the chat path touches (apiKeyPool, customProviderRegistry) are mocked
 * with in-memory stubs; env persistence is redirected to a temp .env so the
 * test is hermetic and never writes the repo .env.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const poolKeys = [];
let savedProvider = null;

jest.mock('../src/services/apiKeyPool', () => ({
  init: jest.fn(),
  addKey: jest.fn((poolKey, entry) => { poolKeys.push({ poolKey, entry }); }),
}));

jest.mock('../src/services/customProviderRegistry', () => {
  const BUILTIN = new Set(['deepseek', 'qwen', 'openai', 'anthropic', 'relay']);
  let store = [];
  return {
    isBuiltinPoolKey: (k) => BUILTIN.has(k),
    saveProvider: jest.fn((cfg) => { savedProvider = cfg; store = store.filter(p => p.poolKey !== cfg.poolKey).concat(cfg); return cfg; }),
    getProvider: (k) => store.find(p => p.poolKey === k) || null,
    removeProvider: jest.fn(),
    listProviders: () => store.slice(),
  };
});

const ENV_KEYS = [
  'GATEWAY_API_POOL_SERVICE_MAP',
  'GATEWAY_API_POOL_DEFAULT_MODEL_MAP',
  'PROXY_MODEL_ROUTE_MAP',
  'KHY_MODEL_TIER_MAP',
  'KHY_IMAGE_GEN_AGNES_API_KEY',
  'KHY_IMAGE_GEN_BACKEND',
  'KHY_IMAGE_GEN_OPENAI_API_KEY',
  'KHY_IMAGE_GEN_OPENAI_BASE_URL',
  'KHY_VIDEO_GEN_AGNES_API_KEY',
  'KHY_ENV_FILE',
  'KHY_ENV_SYNC_ROOT',
];

let tmpEnvPath;
let provisioner;

beforeEach(() => {
  poolKeys.length = 0;
  savedProvider = null;
  for (const k of ENV_KEYS) delete process.env[k];
  tmpEnvPath = path.join(os.tmpdir(), `khy-agnes-prov-${process.pid}-${Date.now()}.env`);
  process.env.KHY_ENV_FILE = tmpEnvPath;
  process.env.KHY_ENV_SYNC_ROOT = 'false';
  jest.resetModules();
  provisioner = require('../src/services/agnesProvisioner');
});

afterEach(() => {
  try { if (tmpEnvPath && fs.existsSync(tmpEnvPath)) fs.unlinkSync(tmpEnvPath); } catch { /* ignore */ }
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('provisionAgnes — full lineup from one key', () => {
  test('wires chat + image + video; image/video never touch the proxy route map', () => {
    const out = provisioner.provisionAgnes({ apiKey: 'sk-agnes-fullkey-1234' });

    // chat
    expect(out.chat.wired).toBe(true);
    expect(out.chat.poolKey).toBe('agnes');
    expect(out.chat.models).toContain('agnes-2.0-flash');
    expect(poolKeys[0].entry.key).toBe('sk-agnes-fullkey-1234');
    expect(savedProvider.poolKey).toBe('agnes');

    // image env written; backend resolves to agnes (no openai configured)
    expect(out.image.wired).toBe(true);
    expect(process.env.KHY_IMAGE_GEN_AGNES_API_KEY).toBe('sk-agnes-fullkey-1234');
    expect(out.image.backendActive).toBe('agnes');
    expect(out.image.supportsEdit).toBe(true);
    expect(process.env.KHY_IMAGE_GEN_BACKEND).toBeUndefined(); // not forced by default

    // video env written
    expect(out.video.wired).toBe(true);
    expect(process.env.KHY_VIDEO_GEN_AGNES_API_KEY).toBe('sk-agnes-fullkey-1234');

    // CRITICAL: only the chat model is in the proxy route map — image/video are NOT
    const route = JSON.parse(process.env.PROXY_MODEL_ROUTE_MAP);
    expect(route['agnes-2.0-flash']).toBeDefined();
    expect(route['agnes-image-2.1-flash']).toBeUndefined();
    expect(route['agnes-image-2.0-flash']).toBeUndefined();
    expect(route['agnes-video-v2.0']).toBeUndefined();

    // persisted to temp .env
    const env = fs.readFileSync(tmpEnvPath, 'utf-8');
    expect(env).toMatch(/KHY_IMAGE_GEN_AGNES_API_KEY=/);
    expect(env).toMatch(/KHY_VIDEO_GEN_AGNES_API_KEY=/);
  });

  test('apiKeyMasked never exposes the raw key', () => {
    const out = provisioner.provisionAgnes({ apiKey: 'sk-secretvalue-9999', video: false, image: false, chat: false });
    expect(out.apiKeyMasked).toBe('sk-s…9999');
    expect(out.apiKeyMasked).not.toContain('secretvalue');
  });

  test('empty key throws', () => {
    expect(() => provisioner.provisionAgnes({ apiKey: '' })).toThrow(/Key/);
  });
});

describe('selective provisioning', () => {
  test('chat:false wires only image + video (no pool registration)', () => {
    const out = provisioner.provisionAgnes({ apiKey: 'sk-k', chat: false });
    expect(out.chat.wired).toBe(false);
    expect(poolKeys).toHaveLength(0);
    expect(savedProvider).toBeNull();
    expect(out.image.wired).toBe(true);
    expect(out.video.wired).toBe(true);
    expect(process.env.PROXY_MODEL_ROUTE_MAP).toBeUndefined();
  });

  test('image:false, video:false → chat only', () => {
    const out = provisioner.provisionAgnes({ apiKey: 'sk-k', image: false, video: false });
    expect(out.chat.wired).toBe(true);
    expect(out.image.wired).toBe(false);
    expect(out.video.wired).toBe(false);
    expect(process.env.KHY_IMAGE_GEN_AGNES_API_KEY).toBeUndefined();
    expect(process.env.KHY_VIDEO_GEN_AGNES_API_KEY).toBeUndefined();
  });

  test('forceImageBackend sets KHY_IMAGE_GEN_BACKEND=agnes (steals from openai)', () => {
    // Pre-existing OpenAI image backend would otherwise win precedence.
    process.env.KHY_IMAGE_GEN_OPENAI_API_KEY = 'k';
    process.env.KHY_IMAGE_GEN_OPENAI_BASE_URL = 'https://o.example/v1';
    const out = provisioner.provisionAgnes({ apiKey: 'sk-k', chat: false, video: false, forceImageBackend: true });
    expect(process.env.KHY_IMAGE_GEN_BACKEND).toBe('agnes');
    expect(out.image.backendActive).toBe('agnes');
    expect(out.image.envKeys).toContain('KHY_IMAGE_GEN_BACKEND');
  });

  test('without forceImageBackend, an existing openai backend keeps precedence', () => {
    process.env.KHY_IMAGE_GEN_OPENAI_API_KEY = 'k';
    process.env.KHY_IMAGE_GEN_OPENAI_BASE_URL = 'https://o.example/v1';
    const out = provisioner.provisionAgnes({ apiKey: 'sk-k', chat: false, video: false });
    expect(process.env.KHY_IMAGE_GEN_BACKEND).toBeUndefined();
    expect(out.image.backendActive).toBe('openai');
  });
});

describe('formatProvisionSummary', () => {
  test('renders a per-capability summary with a masked key', () => {
    const out = provisioner.provisionAgnes({ apiKey: 'sk-agnes-abcd-efgh' });
    const text = provisioner.formatProvisionSummary(out);
    expect(text).toMatch(/sk-a…efgh/);
    expect(text).toMatch(/对话\/代码\/Agent/);
    expect(text).toMatch(/文生图 \+ 图改图/);
    expect(text).toMatch(/文生视频\/图生视频\/关键帧/);
  });
});
