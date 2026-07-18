'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  bridgeEnabled,
  hostServesVideos,
  pickVideoProviderFromPool,
  listVideoProvidersFromPool,
  VIDEO_CAPABLE_HOSTS,
  OFF_VALUES,
} = require('./videoGenPoolBridge');

const AGNES = 'https://apihub.agnes-ai.com/v1';

test('bridgeEnabled: default-on when unset/empty/random', () => {
  assert.strictEqual(bridgeEnabled({}), true);
  assert.strictEqual(bridgeEnabled({ KHY_VIDEO_GEN_POOL_BRIDGE: '' }), true);
  assert.strictEqual(bridgeEnabled({ KHY_VIDEO_GEN_POOL_BRIDGE: '1' }), true);
  assert.strictEqual(bridgeEnabled({ KHY_VIDEO_GEN_POOL_BRIDGE: 'on' }), true);
});

test('bridgeEnabled: off for every OFF_VALUES token (case-folded)', () => {
  for (const v of OFF_VALUES) {
    assert.strictEqual(bridgeEnabled({ KHY_VIDEO_GEN_POOL_BRIDGE: v }), false, v);
    assert.strictEqual(bridgeEnabled({ KHY_VIDEO_GEN_POOL_BRIDGE: v.toUpperCase() }), false, v);
  }
});

test('hostServesVideos: agnes host hits, case-folded, with/without scheme', () => {
  assert.strictEqual(hostServesVideos(AGNES), true);
  assert.strictEqual(hostServesVideos('https://APIHUB.AGNES-AI.COM/v1'), true);
  assert.strictEqual(hostServesVideos('apihub.agnes-ai.com/v1'), true); // bare host
});

test('hostServesVideos: unknown / non-video hosts miss', () => {
  assert.strictEqual(hostServesVideos('https://api.deepseek.com/v1'), false);
  assert.strictEqual(hostServesVideos('https://token.sensenova.cn/v1'), false);
  // sub-domain of a related but non-whitelisted host must NOT match (exact host only)
  assert.strictEqual(hostServesVideos('https://evil.agnes-ai.com.attacker.test/v1'), false);
});

test('hostServesVideos: empty / malformed → false, never throws', () => {
  assert.strictEqual(hostServesVideos(''), false);
  assert.strictEqual(hostServesVideos(null), false);
  assert.strictEqual(hostServesVideos(undefined), false);
  assert.strictEqual(hostServesVideos('not a url ::: %%%'), false);
});

test('VIDEO_CAPABLE_HOSTS: single source of truth includes agnes', () => {
  assert.ok(VIDEO_CAPABLE_HOSTS.includes('apihub.agnes-ai.com'));
});

test('pickVideoProviderFromPool: gate-on + whitelist hit → selects agnes', () => {
  const picked = pickVideoProviderFromPool({
    env: {},
    providers: [
      { poolKey: 'sensenova', endpoint: 'https://token.sensenova.cn/v1' },
      { poolKey: 'agnes', endpoint: AGNES },
    ],
  });
  assert.deepStrictEqual(picked, { poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v1' });
});

test('pickVideoProviderFromPool: gate-off → null', () => {
  const picked = pickVideoProviderFromPool({
    env: { KHY_VIDEO_GEN_POOL_BRIDGE: 'false' },
    providers: [{ poolKey: 'agnes', endpoint: AGNES }],
  });
  assert.strictEqual(picked, null);
});

test('pickVideoProviderFromPool: no whitelist hit → null', () => {
  const picked = pickVideoProviderFromPool({
    env: {},
    providers: [
      { poolKey: 'deepseek', endpoint: 'https://api.deepseek.com/v1' },
      { poolKey: 'sensenova', endpoint: 'https://token.sensenova.cn/v1' },
    ],
  });
  assert.strictEqual(picked, null);
});

test('pickVideoProviderFromPool: deterministic lexicographic tie-break among hits', () => {
  const picked = pickVideoProviderFromPool({
    env: {},
    providers: [
      { poolKey: 'zeta', endpoint: AGNES },
      { poolKey: 'alpha', endpoint: AGNES },
      { poolKey: 'mid', endpoint: AGNES },
    ],
  });
  assert.strictEqual(picked.poolKey, 'alpha');
});

test('pickVideoProviderFromPool: endpointFor callback overrides provider.endpoint', () => {
  const picked = pickVideoProviderFromPool({
    env: {},
    providers: [{ poolKey: 'agnes', endpoint: '' }],
    endpointFor: (k) => (k === 'agnes' ? AGNES : ''),
  });
  assert.strictEqual(picked.poolKey, 'agnes');
});

test('pickVideoProviderFromPool: endpointFor throwing → falls back to provider.endpoint, no throw', () => {
  const picked = pickVideoProviderFromPool({
    env: {},
    providers: [{ poolKey: 'agnes', endpoint: AGNES }],
    endpointFor: () => { throw new Error('boom'); },
  });
  assert.strictEqual(picked.poolKey, 'agnes');
});

test('pickVideoProviderFromPool: empty / malformed input → null, never throws', () => {
  assert.strictEqual(pickVideoProviderFromPool({}), null);
  assert.strictEqual(pickVideoProviderFromPool({ providers: null }), null);
  assert.strictEqual(pickVideoProviderFromPool({ providers: [{}, { poolKey: '' }] }), null);
  assert.strictEqual(pickVideoProviderFromPool(), null);
});

test('pickVideoProviderFromPool: trailing slashes normalised off the endpoint', () => {
  const picked = pickVideoProviderFromPool({
    env: {},
    providers: [{ poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v1///' }],
  });
  assert.strictEqual(picked.endpoint, 'https://apihub.agnes-ai.com/v1');
});

test('listVideoProvidersFromPool: returns ALL whitelisted hits, deterministic lexicographic order', () => {
  const list = listVideoProvidersFromPool({
    env: {},
    providers: [
      { poolKey: 'zeta', endpoint: AGNES },
      { poolKey: 'deepseek', endpoint: 'https://api.deepseek.com/v1' }, // not video-capable
      { poolKey: 'alpha', endpoint: AGNES },
      { poolKey: 'agnes', endpoint: AGNES },
    ],
  });
  assert.deepStrictEqual(list.map((p) => p.poolKey), ['agnes', 'alpha', 'zeta']);
  for (const p of list) assert.strictEqual(p.endpoint, 'https://apihub.agnes-ai.com/v1');
});

test('listVideoProvidersFromPool: dedupes repeated poolKeys, keeps first endpoint seen', () => {
  const list = listVideoProvidersFromPool({
    env: {},
    providers: [
      { poolKey: 'agnes', endpoint: AGNES },
      { poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v2' },
    ],
  });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].poolKey, 'agnes');
});

test('listVideoProvidersFromPool: gate-off → [] (byte-revert)', () => {
  const list = listVideoProvidersFromPool({
    env: { KHY_VIDEO_GEN_POOL_BRIDGE: 'off' },
    providers: [{ poolKey: 'agnes', endpoint: AGNES }],
  });
  assert.deepStrictEqual(list, []);
});

test('listVideoProvidersFromPool: no whitelist hit / malformed → [], never throws', () => {
  assert.deepStrictEqual(
    listVideoProvidersFromPool({ env: {}, providers: [{ poolKey: 'x', endpoint: 'https://api.deepseek.com/v1' }] }),
    [],
  );
  assert.deepStrictEqual(listVideoProvidersFromPool({}), []);
  assert.deepStrictEqual(listVideoProvidersFromPool({ providers: null }), []);
  assert.deepStrictEqual(listVideoProvidersFromPool(), []);
});

test('listVideoProvidersFromPool: endpointFor override drives host match', () => {
  const list = listVideoProvidersFromPool({
    env: {},
    providers: [{ poolKey: 'agnes', endpoint: '' }],
    endpointFor: (k) => (k === 'agnes' ? AGNES : ''),
  });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].poolKey, 'agnes');
});
