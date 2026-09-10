'use strict';
const {
  bridgeEnabled,
  hostServesVideos,
  pickVideoProviderFromPool,
  listVideoProvidersFromPool,
  VIDEO_CAPABLE_HOSTS,
  OFF_VALUES,
} = require('./videoGenPoolBridge');
const AGNES = 'https://apihub.agnes-ai.com/v1';

describe('Video Gen Pool Bridge', () => {
  test('bridgeEnabled: default-on when unset/empty/random', () => {
      expect(bridgeEnabled({})).toBe(true);
      expect(bridgeEnabled({ KHY_VIDEO_GEN_POOL_BRIDGE: '' })).toBe(true);
      expect(bridgeEnabled({ KHY_VIDEO_GEN_POOL_BRIDGE: '1' })).toBe(true);
      expect(bridgeEnabled({ KHY_VIDEO_GEN_POOL_BRIDGE: 'on' })).toBe(true);
  });

  test('bridgeEnabled: off for every OFF_VALUES token (case-folded)', () => {
      for (const v of OFF_VALUES) {
        expect(bridgeEnabled({ KHY_VIDEO_GEN_POOL_BRIDGE: v })).toBe(false, v);
        expect(bridgeEnabled({ KHY_VIDEO_GEN_POOL_BRIDGE: v.toUpperCase() })).toBe(false, v);
      }
  });

  test('hostServesVideos: agnes host hits, case-folded, with/without scheme', () => {
      expect(hostServesVideos(AGNES)).toBe(true);
      expect(hostServesVideos('https://APIHUB.AGNES-AI.COM/v1')).toBe(true);
      expect(hostServesVideos('apihub.agnes-ai.com/v1')).toBe(true); // bare host
  });

  test('hostServesVideos: unknown / non-video hosts miss', () => {
      expect(hostServesVideos('https://api.deepseek.com/v1')).toBe(false);
      expect(hostServesVideos('https://token.sensenova.cn/v1')).toBe(false);
      // sub-domain of a related but non-whitelisted host must NOT match (exact host only)
      expect(hostServesVideos('https://evil.agnes-ai.com.attacker.test/v1')).toBe(false);
  });

  test('hostServesVideos: empty / malformed â†?false, never throws', () => {
      expect(hostServesVideos('')).toBe(false);
      expect(hostServesVideos(null)).toBe(false);
      expect(hostServesVideos(undefined)).toBe(false);
      expect(hostServesVideos('not a url ::: %%%')).toBe(false);
  });

  test('VIDEO_CAPABLE_HOSTS: single source of truth includes agnes', () => {
      expect(VIDEO_CAPABLE_HOSTS).toContain('apihub.agnes-ai.com');
  });

  test('pickVideoProviderFromPool: gate-on + whitelist hit â†?selects agnes', () => {
      const picked = pickVideoProviderFromPool({
        env: {},
        providers: [
          { poolKey: 'sensenova', endpoint: 'https://token.sensenova.cn/v1' },
          { poolKey: 'agnes', endpoint: AGNES },
        ],
      });
      expect(picked).toEqual({ poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v1' });
  });

  test('pickVideoProviderFromPool: gate-off â†?null', () => {
      const picked = pickVideoProviderFromPool({
        env: { KHY_VIDEO_GEN_POOL_BRIDGE: 'false' },
        providers: [{ poolKey: 'agnes', endpoint: AGNES }],
      });
      expect(picked).toBe(null);
  });

  test('pickVideoProviderFromPool: no whitelist hit â†?null', () => {
      const picked = pickVideoProviderFromPool({
        env: {},
        providers: [
          { poolKey: 'deepseek', endpoint: 'https://api.deepseek.com/v1' },
          { poolKey: 'sensenova', endpoint: 'https://token.sensenova.cn/v1' },
        ],
      });
      expect(picked).toBe(null);
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
      expect(picked.poolKey).toBe('alpha');
  });

  test('pickVideoProviderFromPool: endpointFor callback overrides provider.endpoint', () => {
      const picked = pickVideoProviderFromPool({
        env: {},
        providers: [{ poolKey: 'agnes', endpoint: '' }],
        endpointFor: (k) => (k === 'agnes' ? AGNES : ''),
      });
      expect(picked.poolKey).toBe('agnes');
  });

  test('pickVideoProviderFromPool: endpointFor throwing â†?falls back to provider.endpoint, no throw', () => {
      const picked = pickVideoProviderFromPool({
        env: {},
        providers: [{ poolKey: 'agnes', endpoint: AGNES }],
        endpointFor: () => {
          throw new Error('boom');
        },
      });
      expect(picked.poolKey).toBe('agnes');
  });

  test('pickVideoProviderFromPool: empty / malformed input â†?null, never throws', () => {
      expect(pickVideoProviderFromPool({})).toBe(null);
      expect(pickVideoProviderFromPool({ providers: null })).toBe(null);
      expect(pickVideoProviderFromPool({ providers: [{}, { poolKey: '' }] })).toBe(null);
      expect(pickVideoProviderFromPool()).toBe(null);
  });

  test('pickVideoProviderFromPool: trailing slashes normalised off the endpoint', () => {
      const picked = pickVideoProviderFromPool({
        env: {},
        providers: [{ poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v1///' }],
      });
      expect(picked.endpoint).toBe('https://apihub.agnes-ai.com/v1');
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
      assert.deepStrictEqual(
        list.map((p) => p.poolKey),
        ['agnes', 'alpha', 'zeta']
      );
      for (const p of list) {
        expect(p.endpoint).toBe('https://apihub.agnes-ai.com/v1');
      }
  });

  test('listVideoProvidersFromPool: dedupes repeated poolKeys, keeps first endpoint seen', () => {
      const list = listVideoProvidersFromPool({
        env: {},
        providers: [
          { poolKey: 'agnes', endpoint: AGNES },
          { poolKey: 'agnes', endpoint: 'https://apihub.agnes-ai.com/v2' },
        ],
      });
      expect(list.length).toBe(1);
      expect(list[0].poolKey).toBe('agnes');
  });

  test('listVideoProvidersFromPool: gate-off â†?[] (byte-revert)', () => {
      const list = listVideoProvidersFromPool({
        env: { KHY_VIDEO_GEN_POOL_BRIDGE: 'off' },
        providers: [{ poolKey: 'agnes', endpoint: AGNES }],
      });
      expect(list).toEqual([]);
  });

  test('listVideoProvidersFromPool: no whitelist hit / malformed â†?[], never throws', () => {
      assert.deepStrictEqual(
        listVideoProvidersFromPool({
          env: {},
          providers: [{ poolKey: 'x', endpoint: 'https://api.deepseek.com/v1' }],
        }),
        []
      );
      expect(listVideoProvidersFromPool({})).toEqual([]);
      expect(listVideoProvidersFromPool({ providers: null })).toEqual([]);
      expect(listVideoProvidersFromPool()).toEqual([]);
  });

  test('listVideoProvidersFromPool: endpointFor override drives host match', () => {
      const list = listVideoProvidersFromPool({
        env: {},
        providers: [{ poolKey: 'agnes', endpoint: '' }],
        endpointFor: (k) => (k === 'agnes' ? AGNES : ''),
      });
      expect(list.length).toBe(1);
      expect(list[0].poolKey).toBe('agnes');
  });

});

