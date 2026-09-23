'use strict';

/**
 * kiroAdapter.proxyModels.test.js — locks the kiro-proxy branch of
 * listModels() in src/services/gateway/adapters/kiroAdapter.js, fully offline
 * via _kiroGenHarness.js (_proxyTunnel.requestJson replayed from canned
 * responses — zero real network, zero pool access, os.homedir pinned):
 *
 *   1. no-token + KIRO_PROXY_URL → getAccessToken failure is swallowed, the
 *      proxy /v1/models endpoint drives the listing (discoverySource 'proxy');
 *   2. response mapping: id/name/description pass through, isDefault comes
 *      from the first is_default entry, the proxy base URL is trailing-slash
 *      normalized before /v1/models is appended;
 *   3. Claude injection: KIRO_BASELINE_MODELS claude entries missing from the
 *      proxy response are appended with discoverySource 'injected', using the
 *      normalized dot/dash-agnostic dedup key;
 *   4. KIRO_INJECT_CLAUDE_MODELS=0 → injection off, only proxy models;
 *   5. dot/dash variants from the provider (claude-sonnet-4.6 vs
 *      claude-sonnet-4-6) collapse to a single entry in the final dedup pass.
 *
 * Who reorders the proxy-first cascade, the injection list, or the dedup
 * normalization goes red first.
 */
const { loadKiroAdapter } = require('./_kiroGenHarness');

const PROXY_URL = 'https://kiro-proxy.example/'; // trailing slash on purpose

const RAW_MODELS = [
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', is_default: true, description: 'sonnet6' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (dash)', description: 'dash-variant' },
  { id: 'gpt-5', name: 'GPT-5' },
];

describe('kiroAdapter.listModels() via kiro-proxy (offline harness)', () => {
  function proxyResponse() {
    return {
      status: 200,
      data: { data: JSON.parse(JSON.stringify(RAW_MODELS)) },
    };
  }

  test('无本地 token + 代理已配置 → 走 /v1/models，条目映射 + isDefault 定位', async () => {
    const h = loadKiroAdapter({
      env: { KIRO_PROXY_URL: PROXY_URL, KIRO_AUTO_OPEN_LOGIN: '0', KIRO_AUTO_PROXY: '0' },
      defaultRequest: proxyResponse(),
    });
    try {
      const models = await h.adapter.listModels();
      // 3 proxy entries → final dot/dash dedup collapses the two
      // claude-sonnet-4.6 variants to one (2 kept) + 7 injected claude baselines
      expect(models).toHaveLength(9);
      expect(models).toEqual(
        expect.arrayContaining([
          {
            id: 'claude-sonnet-4.6',
            name: 'Claude Sonnet 4.6',
            provider: 'kiro',
            description: 'sonnet6',
            isDefault: true,
            discoverySource: 'proxy',
          },
          {
            id: 'gpt-5',
            name: 'GPT-5',
            provider: 'kiro',
            description: '',
            isDefault: false,
            discoverySource: 'proxy',
          },
        ])
      );
      // trailing slash of KIRO_PROXY_URL is stripped before /v1/models is appended
      expect(h.requestJson).toHaveBeenCalledTimes(1);
      expect(h.requestJson.mock.calls[0][0]).toBe(
        'https://kiro-proxy.example/v1/models'
      );
      // zero real network / pool traffic
      const urls = h.requestJson.mock.calls.map((c) => c[0]);
      expect(urls.every((u) => u.startsWith('https://kiro-proxy.example/'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('Claude 注入: 代理缺失的基线 claude 条目以 injected 追加', async () => {
    const h = loadKiroAdapter({
      env: { KIRO_PROXY_URL: PROXY_URL, KIRO_AUTO_OPEN_LOGIN: '0', KIRO_AUTO_PROXY: '0' },
      defaultRequest: proxyResponse(),
    });
    try {
      const models = await h.adapter.listModels();
      const injected = models.filter((m) => m.discoverySource === 'injected');
      // 9 claude baselines − 2 already listed (both claude-sonnet-4.6 dot/dash
      // variants normalize to the same key) = 7 injected
      expect(injected).toHaveLength(7);
      const opus48 = models.find((m) => m.id === 'claude-opus-4-8');
      expect(opus48).toEqual({
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8 (1.3x)',
        provider: 'kiro',
        description: 'Injected — ultra tier. Kiro IDE shows this model but API may not list it.',
        isDefault: false,
        discoverySource: 'injected',
      });
      // the proxy's claude-sonnet-4-6 (dash) variant is dropped by the final
      // dedup and is never re-added as an injected entry
      expect(models.find((m) => m.id === 'claude-sonnet-4-6')).toBeUndefined();
      expect(models.find((m) => m.id === 'claude-sonnet-4.6')).toBeDefined();
      // normalized keys are unique across the whole listing
      const keys = models.map((m) => m.id.toLowerCase().replace(/[.-]/g, ''));
      expect(new Set(keys).size).toBe(keys.length);
    } finally {
      h.cleanup();
    }
  });

  test('KIRO_INJECT_CLAUDE_MODELS=0 → 关闭注入，仅保留代理返回', async () => {
    const h = loadKiroAdapter({
      env: {
        KIRO_PROXY_URL: PROXY_URL,
        KIRO_AUTO_OPEN_LOGIN: '0',
        KIRO_AUTO_PROXY: '0',
        KIRO_INJECT_CLAUDE_MODELS: '0',
      },
      defaultRequest: proxyResponse(),
    });
    try {
      const models = await h.adapter.listModels();
      // injection off; the final dedup still collapses the two
      // claude-sonnet-4.6 dot/dash variants to the first (dot) entry
      expect(models.map((m) => m.id)).toEqual(['claude-sonnet-4.6', 'gpt-5']);
      expect(models.every((m) => m.discoverySource === 'proxy')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('代理 404/空响应 → 落回基线模型（discoverySource baseline）', async () => {
    const h = loadKiroAdapter({
      env: { KIRO_PROXY_URL: PROXY_URL, KIRO_AUTO_OPEN_LOGIN: '0', KIRO_AUTO_PROXY: '0' },
      defaultRequest: { status: 404, data: null },
    });
    try {
      const models = await h.adapter.listModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.discoverySource === 'baseline')).toBe(true);
      expect(models.every((m) => m.provider === 'kiro')).toBe(true);
      // baseline entries carry the credit suffix in their display name
      const haiku = models.find((m) => m.id === 'claude-haiku-4.5');
      expect(haiku.name).toBe('Claude Haiku 4.5 (0.4x)');
      // claude injection still applies on top of the baseline fallback? No —
      // the fallback branch returns the baseline list directly (no injection pass).
      expect(models.find((m) => m.discoverySource === 'injected')).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});
