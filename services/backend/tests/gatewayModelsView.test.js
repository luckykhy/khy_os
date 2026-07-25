'use strict';

/**
 * Tests for `gateway models --view ... [--search ...]` rendering. The catalog
 * graph is mocked with a fixed edge set; the pivots module is the real (pure)
 * one. We capture console.log and assert each view groups/labels as expected,
 * and that --json returns the grouped structure.
 */

const FIXTURE = {
  edges: [
    { provider: 'agnes', providerLabel: 'Agnes', model: 'agnes-2.0-flash', keyIds: ['k1'], keyCount: 1, capability: 'text', tier: 'T1', status: 'active', connectionMode: 'account-pool', isDefault: true, source: 'chat' },
    { provider: 'agnes', providerLabel: 'Agnes', model: 'agnes-image-2.1-flash', keyIds: [], keyCount: 0, capability: 'image', tier: 'T3', status: 'active', connectionMode: 'direct', isDefault: false, source: 'image' },
    { provider: 'agnes', providerLabel: 'Agnes', model: 'agnes-video-v2.0', keyIds: [], keyCount: 0, capability: 'video', tier: 'T3', status: 'active', connectionMode: 'direct', isDefault: false, source: 'video' },
    { provider: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-chat', keyIds: ['k2'], keyCount: 1, capability: 'text', tier: 'T1', status: 'cooldown', connectionMode: 'account-pool', isDefault: true, source: 'chat' },
  ],
  generatedAt: 123,
  sources: { customProviders: 2, poolOnlyProviders: 0, imageBackends: 1, videoBackends: 1, live: false },
};

jest.mock('../src/services/gateway/modelCatalogGraph', () => ({
  buildCatalogGraph: jest.fn(async () => FIXTURE),
}));

let gateway;
let logs;
let origLog;

beforeEach(() => {
  jest.resetModules();
  gateway = require('../src/cli/handlers/gateway');
  logs = [];
  origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
});

afterEach(() => {
  console.log = origLog;
});

function out() { return logs.join('\n'); }

describe('gateway models --view (text rendering)', () => {
  test('by-capability groups text/image/video with CJK labels', async () => {
    await gateway.handleGatewayModels([], { view: 'by-capability' });
    const text = out();
    expect(text).toMatch(/视角=by-capability/);
    expect(text).toMatch(/文本/);
    expect(text).toMatch(/图片/);
    expect(text).toMatch(/视频/);
    expect(text).toMatch(/agnes-image-2\.1-flash/);
  });

  test('by-key shows each key id; keyless under (no key)', async () => {
    await gateway.handleGatewayModels([], { view: 'by-key' });
    const text = out();
    expect(text).toMatch(/k1/);
    expect(text).toMatch(/k2/);
    expect(text).toMatch(/\(no key\)/);
  });

  test('by-tier groups T1/T3', async () => {
    await gateway.handleGatewayModels([], { view: 'by-tier' });
    const text = out();
    expect(text).toMatch(/T1/);
    expect(text).toMatch(/T3/);
  });

  test('flat + search filters', async () => {
    await gateway.handleGatewayModels([], { view: 'flat', search: 'image' });
    const text = out();
    expect(text).toMatch(/搜索=image/);
    expect(text).toMatch(/agnes-image-2\.1-flash/);
    expect(text).not.toMatch(/deepseek-chat/);
  });

  test('unrecognized view falls back to flat', async () => {
    await gateway.handleGatewayModels([], { view: 'nonsense' });
    expect(out()).toMatch(/视角=flat/);
  });
});

describe('gateway models --view --json', () => {
  test('emits grouped structure with sources', async () => {
    await gateway.handleGatewayModels([], { view: 'by-provider', json: true });
    const parsed = JSON.parse(out());
    expect(parsed.ok).toBe(true);
    expect(parsed.view).toBe('by-provider');
    const keys = parsed.groups.map(g => g.groupKey).sort();
    expect(keys).toEqual(['agnes', 'deepseek']);
    expect(parsed.sources.imageBackends).toBe(1);
  });
});

describe('no --view/--search → legacy path (not catalog)', () => {
  test('does not invoke the catalog graph', async () => {
    const graph = require('../src/services/gateway/modelCatalogGraph');
    graph.buildCatalogGraph.mockClear();
    // legacy path touches aiGateway; swallow any init noise, just assert graph unused
    try { await gateway.handleGatewayModels([], { json: true }); } catch { /* legacy path deps */ }
    expect(graph.buildCatalogGraph).not.toHaveBeenCalled();
  });
});
