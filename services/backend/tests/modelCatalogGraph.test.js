'use strict';

/**
 * Unit tests for modelCatalogGraph — the unified join over the three global
 * stores plus the image/video env namespaces. The stateful deps are mocked with
 * in-memory stubs (mirrors agnesProvisioner.test.js), so the test is hermetic
 * and never reads the real ~/.khy config or makes a network call.
 *
 * Key assertions:
 *   - edges carry correct keyIds / capability / tier / connectionMode / status
 *   - image and video backends surface even though they are NOT in the provider
 *     registry (the by-capability view depends on this)
 *   - by-key derivation: a provider's keys map onto all its models
 */

// ── mocks ───────────────────────────────────────────────────────────────────
jest.mock('../src/services/customProviderRegistry', () => ({
  listProviders: jest.fn(() => ([
    { poolKey: 'agnes', name: 'Agnes', models: ['agnes-2.0-flash'], defaultModel: 'agnes-2.0-flash' },
    { poolKey: 'mytier', name: 'MyTier', models: ['custom-strong-model'], defaultModel: 'custom-strong-model', tier: 'T0' },
  ])),
}));

jest.mock('../src/services/apiKeyPool', () => ({
  init: jest.fn(),
  getProviders: jest.fn(() => ['agnes', 'mytier', 'poolonly']),
  getPoolStatus: jest.fn((provider) => {
    if (provider === 'agnes') return [{ keyId: 'ka1', status: 'active' }];
    if (provider === 'mytier') return [{ keyId: 'kt1', status: 'cooldown' }, { keyId: 'kt2', status: 'active' }];
    if (provider === 'poolonly') return [{ keyId: 'kp1', status: 'cooldown' }];
    return [];
  }),
}));

jest.mock('../src/services/gateway/adapters/apiAdapter', () => ({
  getPoolDefaultModelMap: jest.fn(() => ({ poolonly: 'poolonly-default-model' })),
  listModels: jest.fn(async () => []),
}));

jest.mock('../src/services/imageGenService', () => ({
  catalogModels: jest.fn(() => ([
    { backend: 'agnes', model: 'agnes-image-2.1-flash', capability: 'image', supportsEdit: true },
    { backend: 'agnes', model: 'agnes-image-2.0-flash', capability: 'image', supportsEdit: true },
  ])),
}));

jest.mock('../src/services/videoGenService', () => ({
  catalogModels: jest.fn(() => ([
    { backend: 'agnes', model: 'agnes-video-v2.0', capability: 'video' },
  ])),
}));

const graph = require('../src/services/gateway/modelCatalogGraph');

beforeEach(() => {
  delete process.env.PROXY_MODEL_ROUTE_MAP;
  delete process.env.KHY_MODEL_TIER_MAP;
  delete process.env.KHY_MODEL_CAPABILITY_MAP;
});

describe('buildCatalogGraph — unified join', () => {
  test('emits chat + image + video edges from all stores', async () => {
    const { edges, sources } = await graph.buildCatalogGraph();
    const ids = edges.map(e => `${e.provider}:${e.model}`);

    // chat: registry providers + pool-only
    expect(ids).toContain('agnes:agnes-2.0-flash');
    expect(ids).toContain('mytier:custom-strong-model');
    expect(ids).toContain('poolonly:poolonly-default-model');

    // image (NOT in the registry — only from imageGenService)
    expect(ids).toContain('agnes:agnes-image-2.1-flash');
    expect(ids).toContain('agnes:agnes-image-2.0-flash');

    // video (NOT in the registry — only from videoGenService)
    expect(ids).toContain('agnes:agnes-video-v2.0');

    expect(sources.customProviders).toBe(2);
    expect(sources.poolOnlyProviders).toBe(1);
    expect(sources.imageBackends).toBe(2);
    expect(sources.videoBackends).toBe(1);
  });

  test('keyIds map onto a provider\'s models (by-key derivation)', async () => {
    const { edges } = await graph.buildCatalogGraph();
    const chat = edges.find(e => e.provider === 'agnes' && e.model === 'agnes-2.0-flash');
    expect(chat.keyIds).toEqual(['ka1']);
    expect(chat.keyCount).toBe(1);

    const mytier = edges.find(e => e.provider === 'mytier');
    expect(mytier.keyIds.sort()).toEqual(['kt1', 'kt2']);
  });

  test('capability classification by origin', async () => {
    const { edges } = await graph.buildCatalogGraph();
    const byId = (id) => edges.find(e => `${e.provider}:${e.model}` === id);
    expect(byId('agnes:agnes-2.0-flash').capability).toBe('text');
    expect(byId('agnes:agnes-image-2.1-flash').capability).toBe('image');
    expect(byId('agnes:agnes-video-v2.0').capability).toBe('video');
  });

  test('provider-declared tier wins over auto classification', async () => {
    const { edges } = await graph.buildCatalogGraph();
    const mytier = edges.find(e => e.provider === 'mytier');
    expect(mytier.tier).toBe('T0');
  });

  test('status aggregates keys: active if any active, else cooldown', async () => {
    const { edges } = await graph.buildCatalogGraph();
    expect(edges.find(e => e.provider === 'agnes' && e.source === 'chat').status).toBe('active');
    // mytier has one active + one cooldown → active
    expect(edges.find(e => e.provider === 'mytier').status).toBe('active');
    // poolonly only cooldown → cooldown
    expect(edges.find(e => e.provider === 'poolonly').status).toBe('cooldown');
  });

  test('connectionMode: pooled → account-pool; image/video → direct', async () => {
    const { edges } = await graph.buildCatalogGraph();
    expect(edges.find(e => e.provider === 'agnes' && e.source === 'chat').connectionMode).toBe('account-pool');
    expect(edges.find(e => e.source === 'image').connectionMode).toBe('direct');
    expect(edges.find(e => e.source === 'video').connectionMode).toBe('direct');
  });

  test('isDefault marks the provider default model', async () => {
    const { edges } = await graph.buildCatalogGraph();
    expect(edges.find(e => e.provider === 'agnes' && e.model === 'agnes-2.0-flash').isDefault).toBe(true);
  });

  test('result carries generatedAt + sources for state transparency', async () => {
    const out = await graph.buildCatalogGraph();
    expect(typeof out.generatedAt).toBe('number');
    expect(out.sources).toBeDefined();
    expect(out.sources.live).toBe(false);
  });
});
