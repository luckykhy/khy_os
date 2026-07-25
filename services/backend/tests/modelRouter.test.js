'use strict';

const {
  resolveModelRoute,
  parseAdapterScopedModel,
  parseRouteMap,
} = require('../src/services/gateway/modelRouter');

describe('modelRouter', () => {
  afterEach(() => {
    delete process.env.GATEWAY_MODEL_ROUTE_MAP;
    delete process.env.PROXY_MODEL_ROUTE_MAP;
    delete process.env.GATEWAY_MODEL_ROUTE_STRICT;
    delete process.env.PROXY_PRIMARY_ADAPTER;
    delete process.env.PROXY_PRIMARY_STRICT;
  });

  test('parses explicit adapter/model with slash syntax', () => {
    const route = resolveModelRoute({ model: 'kiro/claude-sonnet-4' });
    expect(route.adapterKey).toBe('kiro');
    expect(route.modelId).toBe('claude-sonnet-4');
    expect(route.preferredAdapter).toBe('kiro');
    expect(route.preferredModel).toBe('claude-sonnet-4');
    expect(route.strictPreferred).toBe(true);
    expect(route.metadata.source).toBe('explicit');
  });

  test('parses explicit adapter:model with alias prefix', () => {
    const parsed = parseAdapterScopedModel('antigravity:claude-opus-4');
    expect(parsed.adapterKey).toBe('trae');
    expect(parsed.modelId).toBe('claude-opus-4');
    expect(parsed.explicitAdapter).toBe(true);
  });

  test('applies exact route-map override', () => {
    const route = resolveModelRoute({
      model: 'gpt-4o-mini',
      routeMap: {
        'gpt-4o-mini': 'api/openai:gpt-4o-mini',
      },
      defaultPreferredAdapter: 'localLLM',
    });
    expect(route.adapterKey).toBe('api');
    expect(route.modelId).toBe('openai:gpt-4o-mini');
    expect(route.preferredAdapter).toBe('api');
    expect(route.strictPreferred).toBe(false);
    expect(route.metadata.source).toBe('route-map');
    expect(route.metadata.matchedRule).toBe('gpt-4o-mini');
  });

  test('applies prefix route-map override with strict config', () => {
    const route = resolveModelRoute({
      model: 'claude-opus-4',
      routeMap: {
        'claude-*': { target: 'kiro/claude-sonnet-4', strict: true },
      },
    });
    expect(route.adapterKey).toBe('kiro');
    expect(route.modelId).toBe('claude-sonnet-4');
    expect(route.preferredAdapter).toBe('kiro');
    expect(route.strictPreferred).toBe(true);
    expect(route.metadata.source).toBe('route-map');
  });

  test('uses default preferred adapter for plain model', () => {
    const route = resolveModelRoute({
      model: 'gpt-4o',
      defaultPreferredAdapter: 'localLLM',
    });
    expect(route.adapterKey).toBe('api');
    expect(route.modelId).toBe('openai:gpt-4o');
    expect(route.preferredAdapter).toBe('api');
    expect(route.preferredModel).toBe('openai:gpt-4o');
    expect(route.strictPreferred).toBe(false);
    expect(route.metadata.source).toBe('builtin-family');
    expect(route.metadata.matchedRule).toBe('__openai_gpt_family__');
  });

  test('does not force codex-family GPT models into the generic OpenAI fallback', () => {
    const route = resolveModelRoute({
      model: 'gpt-5.3-codex-review',
      defaultPreferredAdapter: 'localLLM',
    });
    expect(route.adapterKey).toBeNull();
    expect(route.modelId).toBe('gpt-5.3-codex-review');
    expect(route.preferredAdapter).toBe('localLLM');
    expect(route.preferredModel).toBe('gpt-5.3-codex-review');
    expect(route.metadata.source).toBe('direct');
  });

  test('supports string route-map parsing from env-like text', () => {
    const mapped = parseRouteMap('gpt-4o-mini=api/openai:gpt-4o-mini,claude-*=kiro/claude-sonnet-4');
    expect(mapped['gpt-4o-mini']).toBe('api/openai:gpt-4o-mini');
    expect(mapped['claude-*']).toBe('kiro/claude-sonnet-4');
  });
});
