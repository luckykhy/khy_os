'use strict';
const {
  bridgeEnabled,
  hostServesImages,
  pickImageProviderFromPool,
  listImageProvidersFromPool,
  IMAGE_CAPABLE_HOSTS,
  OFF_VALUES,
} = require('./imageGenPoolBridge');
const AGNES = 'https://apihub.agnes-ai.com/v1';

describe('Image Gen Pool Bridge', () => {
  test('bridgeEnabled: default-on when unset/empty/random', () => {
      expect(bridgeEnabled({})).toBe(true);
      expect(bridgeEnabled({ KHY_IMAGE_GEN_POOL_BRIDGE: '' })).toBe(true);
      expect(bridgeEnabled({ KHY_IMAGE_GEN_POOL_BRIDGE: '1' })).toBe(true);
      expect(bridgeEnabled({ KHY_IMAGE_GEN_POOL_BRIDGE: 'on' })).toBe(true);
  });

  test('bridgeEnabled: off for every OFF_VALUES token (case-folded)', () => {
      for (const v of OFF_VALUES) {
        expect(bridgeEnabled({ KHY_IMAGE_GEN_POOL_BRIDGE: v })).toBe(false, v);
        expect(bridgeEnabled({ KHY_IMAGE_GEN_POOL_BRIDGE: v.toUpperCase() })).toBe(false, v);
      }
  });

  test('hostServesImages: agnes host hits, case-folded, with/without scheme', () => {
      expect(hostServesImages(AGNES)).toBe(true);
      expect(hostServesImages('https://APIHUB.AGNES-AI.COM/v1')).toBe(true);
      expect(hostServesImages('apihub.agnes-ai.com/v1')).toBe(true); // bare host
  });

  test('hostServesImages: unknown / non-image hosts miss', () => {
      expect(hostServesImages('https://api.deepseek.com/v1')).toBe(false);
      expect(hostServesImages('https://token.sensenova.cn/v1')).toBe(false);
      // sub-domain of a related but non-whitelisted host must NOT match (exact host only)
      expect(hostServesImages('https://evil.agnes-ai.com.attacker.test/v1')).toBe(false);
  });

  test('hostServesImages: empty / malformed â†?false, never throws', () => {
      expect(hostServesImages('')).toBe(false);
      expect(hostServesImages(null)).toBe(false);
      expect(hostServesImages(undefined)).toBe(false);
      expect(hostServesImages('not a url ::: %%%')).toBe(false);
  });

  test('IMAGE_CAPABLE_HOSTS: single source of truth includes agnes', () => {
      expect(IMAGE_CAPABLE_HOSTS).toContain('apihub.agnes-ai.com');
  });

  test('pickImageProviderFromPool: gate-on + whitelist hit â†?selects agnes', () => {
      const picked = pickImageProviderFromPool({
        env: {},
        providers: [
          { poolKey: 'sensenova', endpoint: 'https://token.sensenova.cn/v1' },
          { poolKey: 'agnes', endpoint: AGNES },
        ],
      });
      expect(picked).toEqual({ poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v1' });
  });

  test('pickImageProviderFromPool: gate-off â†?null', () => {
      const picked = pickImageProviderFromPool({
        env: { KHY_IMAGE_GEN_POOL_BRIDGE: 'false' },
        providers: [{ poolKey: 'agnes', endpoint: AGNES }],
      });
      expect(picked).toBe(null);
  });

  test('pickImageProviderFromPool: no whitelist hit â†?null', () => {
      const picked = pickImageProviderFromPool({
        env: {},
        providers: [
          { poolKey: 'deepseek', endpoint: 'https://api.deepseek.com/v1' },
          { poolKey: 'sensenova', endpoint: 'https://token.sensenova.cn/v1' },
        ],
      });
      expect(picked).toBe(null);
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
      expect(picked.poolKey).toBe('alpha');
  });

  test('pickImageProviderFromPool: endpointFor callback overrides provider.endpoint', () => {
      const picked = pickImageProviderFromPool({
        env: {},
        providers: [{ poolKey: 'agnes', endpoint: '' }],
        endpointFor: (k) => (k === 'agnes' ? AGNES : ''),
      });
      expect(picked.poolKey).toBe('agnes');
  });

  test('pickImageProviderFromPool: endpointFor throwing â†?falls back to provider.endpoint, no throw', () => {
      const picked = pickImageProviderFromPool({
        env: {},
        providers: [{ poolKey: 'agnes', endpoint: AGNES }],
        endpointFor: () => {
          throw new Error('boom');
        },
      });
      expect(picked.poolKey).toBe('agnes');
  });

  test('pickImageProviderFromPool: empty / malformed input â†?null, never throws', () => {
      expect(pickImageProviderFromPool({})).toBe(null);
      expect(pickImageProviderFromPool({ providers: null })).toBe(null);
      expect(pickImageProviderFromPool({ providers: [{}, { poolKey: '' }] })).toBe(null);
      expect(pickImageProviderFromPool()).toBe(null);
  });

  test('pickImageProviderFromPool: trailing slashes normalised off the endpoint', () => {
      const picked = pickImageProviderFromPool({
        env: {},
        providers: [{ poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v1///' }],
      });
      expect(picked.endpoint).toBe('https://apihub.agnes-ai.com/v1');
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
      assert.deepStrictEqual(
        list.map((p) => p.poolKey),
        ['agnes', 'alpha', 'zeta']
      );
      for (const p of list) {
        expect(p.endpoint).toBe('https://apihub.agnes-ai.com/v1');
      }
  });

  test('listImageProvidersFromPool: dedupes repeated poolKeys, keeps first endpoint seen', () => {
      const list = listImageProvidersFromPool({
        env: {},
        providers: [
          { poolKey: 'agnes', endpoint: AGNES },
          { poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v2' },
        ],
      });
      expect(list.length).toBe(1);
      expect(list[0].poolKey).toBe('agnes');
  });

  test('listImageProvidersFromPool: gate-off â†?[] (byte-revert)', () => {
      const list = listImageProvidersFromPool({
        env: { KHY_IMAGE_GEN_POOL_BRIDGE: 'off' },
        providers: [{ poolKey: 'agnes', endpoint: AGNES }],
      });
      expect(list).toEqual([]);
  });

  test('listImageProvidersFromPool: no whitelist hit / malformed â†?[], never throws', () => {
      assert.deepStrictEqual(
        listImageProvidersFromPool({
          env: {},
          providers: [{ poolKey: 'x', endpoint: 'https://api.deepseek.com/v1' }],
        }),
        []
      );
      expect(listImageProvidersFromPool({})).toEqual([]);
      expect(listImageProvidersFromPool({ providers: null })).toEqual([]);
      expect(listImageProvidersFromPool()).toEqual([]);
  });

  test('listImageProvidersFromPool: endpointFor override drives host match', () => {
      const list = listImageProvidersFromPool({
        env: {},
        providers: [{ poolKey: 'agnes', endpoint: '' }],
        endpointFor: (k) => (k === 'agnes' ? AGNES : ''),
      });
      expect(list.length).toBe(1);
      expect(list[0].poolKey).toBe('agnes');
  });

});

