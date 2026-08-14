'use strict';

/**
 * Unit tests for modelCatalogPivots — pure group-by over a flat edge list.
 * Defines a small fixture graph and asserts each of the eight views groups it
 * the way the CLI/Web layers expect.
 */

const { pivot, VIEWS } = require('../src/services/gateway/modelCatalogPivots');

const EDGES = [
  { provider: 'agnes', providerLabel: 'Agnes', model: 'agnes-2.0-flash', keyIds: ['k1'], keyCount: 1, capability: 'text', tier: 'T1', status: 'active', connectionMode: 'account-pool', isDefault: true, source: 'chat' },
  { provider: 'agnes', providerLabel: 'Agnes', model: 'agnes-image-2.1-flash', keyIds: [], keyCount: 0, capability: 'image', tier: 'T3', status: 'active', connectionMode: 'direct', isDefault: false, source: 'image' },
  { provider: 'agnes', providerLabel: 'Agnes', model: 'agnes-video-v2.0', keyIds: [], keyCount: 0, capability: 'video', tier: 'T3', status: 'active', connectionMode: 'direct', isDefault: false, source: 'video' },
  { provider: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-chat', keyIds: ['k2', 'k3'], keyCount: 2, capability: 'text', tier: 'T1', status: 'cooldown', connectionMode: 'account-pool', isDefault: true, source: 'chat' },
  { provider: 'openai', providerLabel: 'OpenAI', model: 'agnes-2.0-flash', keyIds: ['k4'], keyCount: 1, capability: 'text', tier: 'T1', status: 'active', connectionMode: 'proxy', isDefault: false, source: 'chat' },
];

function groupKeys(groups) { return groups.map(g => g.groupKey).sort(); }
function findGroup(groups, key) { return groups.find(g => g.groupKey === key); }

describe('VIEWS list', () => {
  test('exposes all eight views', () => {
    expect(VIEWS).toEqual(expect.arrayContaining([
      'by-model', 'by-provider', 'by-key', 'by-capability',
      'by-tier', 'by-status', 'by-connection', 'flat',
    ]));
  });
});

describe('by-model', () => {
  test('groups by model id; shared model lists both providers', () => {
    const g = pivot(EDGES, 'by-model');
    const shared = findGroup(g, 'agnes-2.0-flash');
    expect(shared.edges.map(e => e.provider).sort()).toEqual(['agnes', 'openai']);
  });
});

describe('by-provider', () => {
  test('groups by provider with label, default behavior', () => {
    const g = pivot(EDGES, 'by-provider');
    expect(groupKeys(g)).toEqual(['agnes', 'deepseek', 'openai']);
    expect(findGroup(g, 'agnes').groupLabel).toBe('Agnes');
    expect(findGroup(g, 'agnes').edges).toHaveLength(3);
  });
  test('unknown view falls back to by-provider', () => {
    expect(pivot(EDGES, 'nonsense').map(x => x.groupKey).sort())
      .toEqual(['agnes', 'deepseek', 'openai']);
  });
});

describe('by-key', () => {
  test('each key id is its own group; keyless edges under (no key)', () => {
    const g = pivot(EDGES, 'by-key');
    expect(groupKeys(g)).toEqual(['(no key)', 'k1', 'k2', 'k3', 'k4']);
    // deepseek-chat has two keys → appears under both k2 and k3
    expect(findGroup(g, 'k2').edges[0].model).toBe('deepseek-chat');
    expect(findGroup(g, 'k3').edges[0].model).toBe('deepseek-chat');
    // image+video are keyless
    expect(findGroup(g, '(no key)').edges.map(e => e.model).sort())
      .toEqual(['agnes-image-2.1-flash', 'agnes-video-v2.0']);
  });

  test('a system edge (key hidden for isolation) groups under (system key), not (no key)', () => {
    // System/global edges carry keyIds:[]/keyCount:0 for tenant isolation; the
    // existence of a key shows only in the status (system-*). Such an edge must
    // not be mislabelled as "(no key)".
    const sys = [
      { provider: 'sensenova', providerLabel: 'SenseNova', model: 'sensenova-6.7-flash', keyIds: [], keyCount: 0, capability: 'text', tier: 'T3', status: 'system-ready', connectionMode: 'system', isDefault: false, source: 'system' },
      { provider: 'foo', providerLabel: 'Foo', model: 'foo-needs-key', keyIds: [], keyCount: 0, capability: 'text', tier: 'T3', status: 'needs-key', connectionMode: 'system', isDefault: false, source: 'system' },
    ];
    const g = pivot(sys, 'by-key');
    expect(findGroup(g, '(system key)').edges.map(e => e.model)).toEqual(['sensenova-6.7-flash']);
    expect(findGroup(g, '(no key)').edges.map(e => e.model)).toEqual(['foo-needs-key']);
  });
});

describe('by-capability', () => {
  test('groups text/image/video with CJK labels', () => {
    const g = pivot(EDGES, 'by-capability');
    expect(groupKeys(g)).toEqual(['image', 'text', 'video']);
    expect(findGroup(g, 'image').groupLabel).toBe('图片');
    expect(findGroup(g, 'video').groupLabel).toBe('视频');
    expect(findGroup(g, 'text').edges).toHaveLength(3);
  });
});

describe('by-tier', () => {
  test('groups by tier', () => {
    const g = pivot(EDGES, 'by-tier');
    expect(groupKeys(g)).toEqual(['T1', 'T3']);
    expect(findGroup(g, 'T3').edges).toHaveLength(2);
  });
});

describe('by-status', () => {
  test('groups by aggregate status with labels', () => {
    const g = pivot(EDGES, 'by-status');
    expect(groupKeys(g)).toEqual(['active', 'cooldown']);
    expect(findGroup(g, 'cooldown').groupLabel).toBe('冷却中');
  });
});

describe('by-connection', () => {
  test('groups by connection mode with labels', () => {
    const g = pivot(EDGES, 'by-connection');
    expect(groupKeys(g)).toEqual(['account-pool', 'direct', 'proxy']);
    expect(findGroup(g, 'account-pool').groupLabel).toBe('账号池');
  });
});

describe('flat + search', () => {
  test('flat is a single group of all edges', () => {
    const g = pivot(EDGES, 'flat');
    expect(g).toHaveLength(1);
    expect(g[0].edges).toHaveLength(EDGES.length);
  });
  test('search filters across model/provider/label, all views', () => {
    const g = pivot(EDGES, 'flat', { search: 'image' });
    expect(g[0].edges).toHaveLength(1);
    expect(g[0].edges[0].model).toBe('agnes-image-2.1-flash');

    // search also applies to grouped views
    const byProv = pivot(EDGES, 'by-provider', { search: 'deepseek' });
    expect(byProv).toHaveLength(1);
    expect(byProv[0].groupKey).toBe('deepseek');
  });
});
