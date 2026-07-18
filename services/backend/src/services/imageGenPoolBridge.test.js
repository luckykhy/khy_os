'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  bridgeEnabled,
  hostServesImages,
  pickImageProviderFromPool,
  listImageProvidersFromPool,
  IMAGE_CAPABLE_HOSTS,
  OFF_VALUES,
} = require('./imageGenPoolBridge');

const AGNES = 'https://apihub.agnes-ai.com/v1';

test('bridgeEnabled: default-on when unset/empty/random', () => {
  assert.strictEqual(bridgeEnabled({}), true);
  assert.strictEqual(bridgeEnabled({ KHY_IMAGE_GEN_POOL_BRIDGE: '' }), true);
  assert.strictEqual(bridgeEnabled({ KHY_IMAGE_GEN_POOL_BRIDGE: '1' }), true);
  assert.strictEqual(bridgeEnabled({ KHY_IMAGE_GEN_POOL_BRIDGE: 'on' }), true);
});

test('bridgeEnabled: off for every OFF_VALUES token (case-folded)', () => {
  for (const v of OFF_VALUES) {
    assert.strictEqual(bridgeEnabled({ KHY_IMAGE_GEN_POOL_BRIDGE: v }), false, v);
    assert.strictEqual(bridgeEnabled({ KHY_IMAGE_GEN_POOL_BRIDGE: v.toUpperCase() }), false, v);
  }
});

test('hostServesImages: agnes host hits, case-folded, with/without scheme', () => {
  assert.strictEqual(hostServesImages(AGNES), true);
  assert.strictEqual(hostServesImages('https://APIHUB.AGNES-AI.COM/v1'), true);
  assert.strictEqual(hostServesImages('apihub.agnes-ai.com/v1'), true); // bare host
});

test('hostServesImages: unknown / non-image hosts miss', () => {
  assert.strictEqual(hostServesImages('https://api.deepseek.com/v1'), false);
  assert.strictEqual(hostServesImages('https://token.sensenova.cn/v1'), false);
  // sub-domain of a related but non-whitelisted host must NOT match (exact host only)
  assert.strictEqual(hostServesImages('https://evil.agnes-ai.com.attacker.test/v1'), false);
});

test('hostServesImages: empty / malformed → false, never throws', () => {
  assert.strictEqual(hostServesImages(''), false);
  assert.strictEqual(hostServesImages(null), false);
  assert.strictEqual(hostServesImages(undefined), false);
  assert.strictEqual(hostServesImages('not a url ::: %%%'), false);
});

test('IMAGE_CAPABLE_HOSTS: single source of truth includes agnes', () => {
  assert.ok(IMAGE_CAPABLE_HOSTS.includes('apihub.agnes-ai.com'));
});

test('pickImageProviderFromPool: gate-on + whitelist hit → selects agnes', () => {
  const picked = pickImageProviderFromPool({
    env: {},
    providers: [
      { poolKey: 'sensenova', endpoint: 'https://token.sensenova.cn/v1' },
      { poolKey: 'agnes', endpoint: AGNES },
    ],
  });
  assert.deepStrictEqual(picked, { poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v1' });
});

test('pickImageProviderFromPool: gate-off → null', () => {
  const picked = pickImageProviderFromPool({
    env: { KHY_IMAGE_GEN_POOL_BRIDGE: 'false' },
    providers: [{ poolKey: 'agnes', endpoint: AGNES }],
  });
  assert.strictEqual(picked, null);
});

test('pickImageProviderFromPool: no whitelist hit → null', () => {
  const picked = pickImageProviderFromPool({
    env: {},
    providers: [
      { poolKey: 'deepseek', endpoint: 'https://api.deepseek.com/v1' },
      { poolKey: 'sensenova', endpoint: 'https://token.sensenova.cn/v1' },
    ],
  });
  assert.strictEqual(picked, null);
});

test('pickImageProviderFromPool: deterministic lexicographic tie-break among hits', () => {
  const picked = pickImageProviderFromPool({
    env: {},
    providers: [
      { poolKey: 'zeta', endpoint: AGNES },
      { poolKey: 'alpha', endpoint: AGNES },
      { poolKey: 'mid', endpoint: AGNES },
    ],
  });
  assert.strictEqual(picked.poolKey, 'alpha');
});

test('pickImageProviderFromPool: endpointFor callback overrides provider.endpoint', () => {
  const picked = pickImageProviderFromPool({
    env: {},
    providers: [{ poolKey: 'agnes', endpoint: '' }],
    endpointFor: (k) => (k === 'agnes' ? AGNES : ''),
  });
  assert.strictEqual(picked.poolKey, 'agnes');
});

test('pickImageProviderFromPool: endpointFor throwing → falls back to provider.endpoint, no throw', () => {
  const picked = pickImageProviderFromPool({
    env: {},
    providers: [{ poolKey: 'agnes', endpoint: AGNES }],
    endpointFor: () => { throw new Error('boom'); },
  });
  assert.strictEqual(picked.poolKey, 'agnes');
});

test('pickImageProviderFromPool: empty / malformed input → null, never throws', () => {
  assert.strictEqual(pickImageProviderFromPool({}), null);
  assert.strictEqual(pickImageProviderFromPool({ providers: null }), null);
  assert.strictEqual(pickImageProviderFromPool({ providers: [{}, { poolKey: '' }] }), null);
  assert.strictEqual(pickImageProviderFromPool(), null);
});

test('pickImageProviderFromPool: trailing slashes normalised off the endpoint', () => {
  const picked = pickImageProviderFromPool({
    env: {},
    providers: [{ poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v1///' }],
  });
  assert.strictEqual(picked.endpoint, 'https://apihub.agnes-ai.com/v1');
});

test('listImageProvidersFromPool: returns ALL whitelisted hits, deterministic lexicographic order', () => {
  const list = listImageProvidersFromPool({
    env: {},
    providers: [
      { poolKey: 'zeta', endpoint: AGNES },
      { poolKey: 'deepseek', endpoint: 'https://api.deepseek.com/v1' }, // not image-capable
      { poolKey: 'alpha', endpoint: AGNES },
      { poolKey: 'agnes', endpoint: AGNES },
    ],
  });
  assert.deepStrictEqual(list.map((p) => p.poolKey), ['agnes', 'alpha', 'zeta']);
  for (const p of list) assert.strictEqual(p.endpoint, 'https://apihub.agnes-ai.com/v1');
});

test('listImageProvidersFromPool: dedupes repeated poolKeys, keeps first endpoint seen', () => {
  const list = listImageProvidersFromPool({
    env: {},
    providers: [
      { poolKey: 'agnes', endpoint: AGNES },
      { poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v2' },
    ],
  });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].poolKey, 'agnes');
});

test('listImageProvidersFromPool: gate-off → [] (byte-revert)', () => {
  const list = listImageProvidersFromPool({
    env: { KHY_IMAGE_GEN_POOL_BRIDGE: 'off' },
    providers: [{ poolKey: 'agnes', endpoint: AGNES }],
  });
  assert.deepStrictEqual(list, []);
});

test('listImageProvidersFromPool: no whitelist hit / malformed → [], never throws', () => {
  assert.deepStrictEqual(
    listImageProvidersFromPool({ env: {}, providers: [{ poolKey: 'x', endpoint: 'https://api.deepseek.com/v1' }] }),
    [],
  );
  assert.deepStrictEqual(listImageProvidersFromPool({}), []);
  assert.deepStrictEqual(listImageProvidersFromPool({ providers: null }), []);
  assert.deepStrictEqual(listImageProvidersFromPool(), []);
});

test('listImageProvidersFromPool: endpointFor override drives host match', () => {
  const list = listImageProvidersFromPool({
    env: {},
    providers: [{ poolKey: 'agnes', endpoint: '' }],
    endpointFor: (k) => (k === 'agnes' ? AGNES : ''),
  });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].poolKey, 'agnes');
});
