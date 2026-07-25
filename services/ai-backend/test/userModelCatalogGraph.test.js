/**
 * Per-user catalog graph: derives the flat edge list for the multi-pivot views
 * from a user's relay config + provider key pool. Uses a throwaway on-disk
 * SQLite DB (same pattern as userGateway.routes.test.js) so the real
 * userGatewayConfigService + @khy/shared models exercise the real join.
 *
 * Assertions:
 *   - the relay's single model surfaces as one edge with the right capability;
 *   - each UserProvider key surfaces as one provider-level edge (model empty,
 *     never invented), with key id and status;
 *   - capability classification is borrowed from the shared backend classifier;
 *   - everything is scoped to the user (B never sees A's edges).
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-usergw-catalog-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-user-catalog';
process.env.NODE_ENV = 'test';

// Live-merge sources are mocked so the join stays deterministic and offline:
// the local Ollama probe + the global/system catalog graph are exercised
// separately by their own suites. Default: nothing local, nothing system.
jest.mock('../../backend/src/services/gateway/localOllamaProbe', () => ({
  fetchLocalModels: jest.fn(async () => ({ running: false, models: [], error: null })),
}));
jest.mock('../../backend/src/services/gateway/modelCatalogGraph', () => ({
  buildCatalogGraph: jest.fn(async () => ({ edges: [], generatedAt: 0, sources: {} })),
}));

const { fetchLocalModels } = require('../../backend/src/services/gateway/localOllamaProbe');
const globalCatalogGraph = require('../../backend/src/services/gateway/modelCatalogGraph');

const { sequelize, User } = require('@khy/shared/models');
const svc = require('../src/services/userGatewayConfigService');
const graph = require('../src/services/gateway/userModelCatalogGraph');

let userA;
let userB;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = await User.create({ username: 'cat-a', email: 'cat-a@test.local', password: 'pw-a-123456', status: 'active' });
  userB = await User.create({ username: 'cat-b', email: 'cat-b@test.local', password: 'pw-b-123456', status: 'active' });

  // A: relay upstream with an image-capable model id + two provider keys.
  await svc.saveRelayConfig(userA.id, {
    baseUrl: 'https://relay.a.example.com',
    modelId: 'some-image-gen-model',
    compatibility: 'openai',
    apiKey: 'sk-a-secret-xyz',
  });
  await svc.addProviderEntry(userA.id, { provider: 'deepseek', displayName: 'DeepSeek', key: 'sk-ds-1', baseUrl: 'https://api.deepseek.com' });
  await svc.addProviderEntry(userA.id, { provider: 'moonshot', key: 'sk-ms-1' });

  // B: nothing configured.
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

describe('userModelCatalogGraph.buildCatalogGraph', () => {
  test('relay model surfaces as one edge with classified capability', async () => {
    const { edges, sources } = await graph.buildCatalogGraph(userA.id);
    const relay = edges.find(e => e.source === 'relay');
    expect(relay).toBeDefined();
    expect(relay.model).toBe('some-image-gen-model');
    expect(relay.capability).toBe('image'); // shared classifier saw "image-gen"
    expect(relay.connectionMode).toBe('proxy');
    expect(relay.isDefault).toBe(true);
    expect(relay.keyCount).toBe(1);
    expect(relay.providerLabel).toBe('relay.a.example.com');
    expect(sources.relay).toBe(1);
  });

  test('each provider key surfaces as a provider-level edge; model not invented', async () => {
    const { edges, sources } = await graph.buildCatalogGraph(userA.id);
    const providerEdges = edges.filter(e => e.source === 'provider');
    expect(providerEdges.map(e => e.provider).sort()).toEqual(['deepseek', 'moonshot']);
    for (const e of providerEdges) {
      expect(e.model).toBe('');          // never fabricated
      expect(e.keyCount).toBe(1);
      expect(e.keyIds).toHaveLength(1);
      expect(e.status).toBe('active');
      expect(e.connectionMode).toBe('direct');
    }
    expect(sources.providers).toBe(2);
  });

  test('displayName drives the provider label when present', async () => {
    const { edges } = await graph.buildCatalogGraph(userA.id);
    const ds = edges.find(e => e.provider === 'deepseek');
    expect(ds.providerLabel).toBe('DeepSeek');
    const ms = edges.find(e => e.provider === 'moonshot');
    expect(ms.providerLabel).toBe('moonshot'); // falls back to provider id
  });

  test('scoped per user: B with nothing configured yields no edges', async () => {
    const { edges, sources } = await graph.buildCatalogGraph(userB.id);
    expect(edges).toHaveLength(0);
    expect(sources.relay).toBe(0);
    expect(sources.providers).toBe(0);
  });

  test('result carries generatedAt + sources for state transparency', async () => {
    const out = await graph.buildCatalogGraph(userA.id);
    expect(typeof out.generatedAt).toBe('number');
    expect(out.sources.live).toBe(false);
  });
});

describe('userModelCatalogGraph — detected/local/system merge', () => {
  afterEach(() => {
    fetchLocalModels.mockResolvedValue({ running: false, models: [], error: null });
    globalCatalogGraph.buildCatalogGraph.mockResolvedValue({ edges: [], generatedAt: 0, sources: {} });
  });

  test('persisted own models fill provider edges (one edge per detected model)', async () => {
    // Persist two detected models for deepseek; the placeholder collapses into
    // real per-model edges. Manual additions co-exist.
    await svc.upsertModels(userA.id, 'deepseek', [
      { model: 'deepseek-chat', capability: 'text' },
      { model: 'deepseek-reasoner', capability: 'text' },
    ], { source: 'detected' });

    const { edges, sources } = await graph.buildCatalogGraph(userA.id);
    const ds = edges.filter(e => e.provider === 'deepseek');
    expect(ds.map(e => e.model).sort()).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    for (const e of ds) {
      expect(e.source).toBe('provider');
      expect(e.keyCount).toBe(1); // key ids aggregated onto each model edge
    }
    // moonshot still has no detected models → keeps its placeholder edge.
    const ms = edges.filter(e => e.provider === 'moonshot');
    expect(ms).toHaveLength(1);
    expect(ms[0].model).toBe('');
    expect(sources.ownModels).toBeGreaterThanOrEqual(2);
  });

  test('local Ollama models merge as source:local edges (never persisted)', async () => {
    fetchLocalModels.mockResolvedValue({
      running: true,
      models: [{ id: 'qwen2.5:7b', source: 'local' }, { id: 'llama3.1:8b', source: 'local' }],
      error: null,
    });
    const { edges, sources } = await graph.buildCatalogGraph(userB.id); // B owns nothing
    const local = edges.filter(e => e.source === 'local');
    expect(local.map(e => e.model).sort()).toEqual(['llama3.1:8b', 'qwen2.5:7b']);
    expect(local.every(e => e.provider === 'local' && e.connectionMode === 'direct' && e.keyCount === 0)).toBe(true);
    expect(sources.local).toEqual({ running: true, count: 2 });
  });

  test('system/global models merge as metadata-only edges with no keys', async () => {
    globalCatalogGraph.buildCatalogGraph.mockResolvedValue({
      edges: [
        { provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-4o', keyIds: ['secret-key-id'], keyCount: 1, capability: 'text', tier: 'T0', status: 'active', connectionMode: 'account-pool', isDefault: true, source: 'chat' },
        { provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-cold', keyIds: [], keyCount: 0, capability: 'text', tier: 'T1', status: 'disabled', connectionMode: 'direct', isDefault: false, source: 'chat' },
      ],
      generatedAt: 0,
      sources: {},
    });
    const { edges, sources } = await graph.buildCatalogGraph(userB.id);
    const sys = edges.filter(e => e.source === 'system');
    expect(sys).toHaveLength(2);
    // Tenant isolation: NO global key ids leak into the user plane.
    for (const e of sys) {
      expect(e.keyIds).toEqual([]);
      expect(e.keyCount).toBe(0);
      expect(e.connectionMode).toBe('system');
    }
    expect(sys.find(e => e.model === 'gpt-4o').status).toBe('system-ready');
    expect(sys.find(e => e.model === 'gpt-cold').status).toBe('needs-key');
    expect(sources.system).toEqual({ count: 2 });
  });

  test('system key that EXISTS but is failing/cooling is not mislabelled "needs-key"', async () => {
    // Regression: a SenseNova-style builtin/env key is configured (keyCount>0)
    // but the upstream is rate-limited or the key was disabled. The catalog must
    // tell the truth ("system key cooling/failing"), never claim "待配 Key"
    // (no key) — which is what made a user who DID configure a key think it was
    // missing. Tenant isolation still holds: keyCount/keyIds stay zeroed.
    globalCatalogGraph.buildCatalogGraph.mockResolvedValue({
      edges: [
        { provider: 'sensenova', providerLabel: 'SenseNova', model: 'sensenova-6.7-flash-lite', keyIds: ['k1', 'k2'], keyCount: 2, capability: 'text', tier: '', status: 'disabled', connectionMode: 'account-pool', isDefault: true, source: 'chat' },
        { provider: 'sensenova', providerLabel: 'SenseNova', model: 'sensenova-6.7-flash-image', keyIds: ['k1'], keyCount: 1, capability: 'image', tier: '', status: 'cooldown', connectionMode: 'account-pool', isDefault: false, source: 'chat' },
        { provider: 'ghost', providerLabel: 'Ghost', model: 'ghost-1', keyIds: [], keyCount: 0, capability: 'text', tier: '', status: 'disabled', connectionMode: 'direct', isDefault: false, source: 'chat' },
      ],
      generatedAt: 0,
      sources: {},
    });
    const { edges } = await graph.buildCatalogGraph(userB.id);
    const byModel = (m) => edges.find(e => e.source === 'system' && e.model === m);
    expect(byModel('sensenova-6.7-flash-lite').status).toBe('system-error');   // key exists, disabled
    expect(byModel('sensenova-6.7-flash-image').status).toBe('system-cooldown'); // key exists, cooling
    expect(byModel('ghost-1').status).toBe('needs-key');                        // genuinely no key
    // Isolation invariant: no key material leaks regardless of status.
    for (const e of edges.filter(e => e.source === 'system')) {
      expect(e.keyIds).toEqual([]);
      expect(e.keyCount).toBe(0);
    }
  });

  test('detect:true runs the upstream sweep and reports it under sources', async () => {
    const out = await graph.buildCatalogGraph(userB.id, { detect: true });
    expect(out.sources.live).toBe(true);
    expect(typeof out.sources.detectedAt).toBe('number');
    expect(out.sources.upstream).toBeDefined();
    expect(Array.isArray(out.sources.errors)).toBe(true);
  });
});
