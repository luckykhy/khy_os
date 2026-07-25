/**
 * upstreamModelProbe — probe an upstream's /models endpoint.
 *
 * Covers: OpenAI format (Bearer + {base}/models), Anthropic format (x-api-key +
 * anthropic-version + /v1/models), endpoint-vs-baseUrl precedence, the never-
 * throw contract (timeout / non-2xx / network error / malformed body → null),
 * and the no-double-/v1 URL builder.
 */
'use strict';

const probe = require('../src/services/gateway/upstreamModelProbe');

const realFetch = global.fetch;

function mockFetchOnce(impl) {
  global.fetch = jest.fn(impl);
}

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe('buildModelsUrl', () => {
  test('openai: appends /models to the base', () => {
    expect(probe.buildModelsUrl('https://api.x.com/v1', 'openai')).toBe('https://api.x.com/v1/models');
  });
  test('openai: strips trailing slashes', () => {
    expect(probe.buildModelsUrl('https://api.x.com/v1///', 'openai')).toBe('https://api.x.com/v1/models');
  });
  test('anthropic: adds /v1/models when base has no version segment', () => {
    expect(probe.buildModelsUrl('https://api.anthropic.com', 'anthropic')).toBe('https://api.anthropic.com/v1/models');
  });
  test('anthropic: no double /v1 when base already versioned', () => {
    expect(probe.buildModelsUrl('https://api.anthropic.com/v1', 'anthropic')).toBe('https://api.anthropic.com/v1/models');
  });
  test('empty base → empty', () => {
    expect(probe.buildModelsUrl('', 'openai')).toBe('');
  });
});

describe('fetchUpstreamModels', () => {
  test('returns null without base or apiKey (no fetch attempted)', async () => {
    mockFetchOnce(() => { throw new Error('should not be called'); });
    expect(await probe.fetchUpstreamModels({})).toBeNull();
    expect(await probe.fetchUpstreamModels({ baseUrl: 'https://x', apiKey: '' })).toBeNull();
    expect(await probe.fetchUpstreamModels({ apiKey: 'k' })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('openai: GETs {base}/models with a Bearer header and maps ids', async () => {
    let seenUrl;
    let seenHeaders;
    mockFetchOnce((url, opts) => {
      seenUrl = url;
      seenHeaders = opts.headers;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'gpt-4o', context_length: 128000 }, { id: 'gpt-4o-mini' }, { foo: 1 }] }),
      });
    });

    const out = await probe.fetchUpstreamModels({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk-abc', apiFormat: 'openai' });
    expect(seenUrl).toBe('https://api.x.com/v1/models');
    expect(seenHeaders.Authorization).toBe('Bearer sk-abc');
    expect(out).toEqual([
      { id: 'gpt-4o', contextWindow: 128000 },
      { id: 'gpt-4o-mini', contextWindow: 0 },
    ]);
  });

  test('anthropic: uses x-api-key + anthropic-version header and /v1/models', async () => {
    let seenUrl;
    let seenHeaders;
    mockFetchOnce((url, opts) => {
      seenUrl = url;
      seenHeaders = opts.headers;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ id: 'claude-3-5' }] }) });
    });

    const out = await probe.fetchUpstreamModels({ baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant', apiFormat: 'anthropic' });
    expect(seenUrl).toBe('https://api.anthropic.com/v1/models');
    expect(seenHeaders['x-api-key']).toBe('sk-ant');
    expect(seenHeaders['anthropic-version']).toBe(probe.ANTHROPIC_VERSION);
    expect(out).toEqual([{ id: 'claude-3-5', contextWindow: 0 }]);
  });

  test('endpoint takes precedence over baseUrl', async () => {
    let seenUrl;
    mockFetchOnce((url) => { seenUrl = url; return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) }); });
    await probe.fetchUpstreamModels({ baseUrl: 'https://base/v1', endpoint: 'https://endpoint/v1', apiKey: 'k' });
    expect(seenUrl).toBe('https://endpoint/v1/models');
  });

  test('non-2xx → null (degrade, never throw)', async () => {
    mockFetchOnce(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }));
    expect(await probe.fetchUpstreamModels({ baseUrl: 'https://x/v1', apiKey: 'k' })).toBeNull();
  });

  test('network error → null (never throws)', async () => {
    mockFetchOnce(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(probe.fetchUpstreamModels({ baseUrl: 'https://x/v1', apiKey: 'k' })).resolves.toBeNull();
  });

  test('malformed body (no data array) → empty list', async () => {
    mockFetchOnce(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ nope: true }) }));
    expect(await probe.fetchUpstreamModels({ baseUrl: 'https://x/v1', apiKey: 'k' })).toEqual([]);
  });
});
