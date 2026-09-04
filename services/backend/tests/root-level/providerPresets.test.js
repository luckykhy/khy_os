/**
 * providerPresets — single source of built-in common providers.
 *
 * Asserts: the seed carries the expected ids with valid, key-less metadata;
 * env KHY_PROVIDER_PRESETS overrides by id (partial merge) and appends new ids;
 * an unsupported apiFormat is dropped; and the returned list is a deep copy that
 * a caller cannot use to corrupt the shared definitions.
 */
'use strict';

const presets = require('../src/services/gateway/providerPresets');

const ORIGINAL_ENV = process.env.KHY_PROVIDER_PRESETS;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.KHY_PROVIDER_PRESETS;
  else process.env.KHY_PROVIDER_PRESETS = ORIGINAL_ENV;
});

describe('getProviderPresets — seed', () => {
  test('contains the expected common providers', () => {
    delete process.env.KHY_PROVIDER_PRESETS;
    const ids = presets.getProviderPresets().map((p) => p.id);
    for (const want of ['openai', 'anthropic', 'gemini', 'deepseek', 'agnes', 'moonshot', 'qwen', 'zhipu']) {
      expect(ids).toContain(want);
    }
  });

  test('every preset is valid + key-less', () => {
    delete process.env.KHY_PROVIDER_PRESETS;
    for (const p of presets.getProviderPresets()) {
      expect(presets.VALID_API_FORMATS).toContain(p.apiFormat);
      expect(p.id).toMatch(/^[a-z0-9._-]+$/);
      // No credential ever rides along in a preset.
      expect(p).not.toHaveProperty('key');
      expect(p).not.toHaveProperty('apiKey');
    }
  });

  test('keyField matches the wire protocol for anthropic / gemini', () => {
    delete process.env.KHY_PROVIDER_PRESETS;
    const byId = Object.fromEntries(presets.getProviderPresets().map((p) => [p.id, p]));
    expect(byId.anthropic.keyField).toBe('x-api-key');
    expect(byId.gemini.keyField).toBe('x-goog-api-key');
    expect(byId.deepseek.keyField).toBe('authorization_bearer');
  });
});

describe('getProviderPresets — provider links', () => {
  test('seed carries http(s) links so the UI can show "where to get a key"', () => {
    delete process.env.KHY_PROVIDER_PRESETS;
    const byId = Object.fromEntries(presets.getProviderPresets().map((p) => [p.id, p]));
    // Every preset exposes a links object; the well-known ones carry a console URL.
    for (const p of presets.getProviderPresets()) {
      expect(p).toHaveProperty('links');
      expect(typeof p.links).toBe('object');
      for (const v of Object.values(p.links)) {
        expect(v).toMatch(/^https?:\/\//);
      }
    }
    expect(byId.openai.links.console).toBe('https://platform.openai.com/api-keys');
    expect(byId.deepseek.links.console).toBe('https://platform.deepseek.com/api_keys');
    expect(byId.anthropic.links.docs).toBe('https://docs.anthropic.com');
  });

  test('only known link keys survive; non-http(s) links are dropped', () => {
    process.env.KHY_PROVIDER_PRESETS = JSON.stringify([
      {
        id: 'acme',
        baseUrl: 'https://acme.example/v1',
        apiFormat: 'openai',
        links: {
          home: 'https://acme.example',
          console: 'javascript:alert(1)', // dropped — unsafe scheme
          evil: 'https://acme.example/evil', // dropped — unknown key
        },
      },
    ]);
    const acme = presets.getProviderPresets().find((p) => p.id === 'acme');
    expect(acme.links.home).toBe('https://acme.example');
    expect(acme.links).not.toHaveProperty('console');
    expect(acme.links).not.toHaveProperty('evil');
  });

  test('an env override can replace a built-in link', () => {
    process.env.KHY_PROVIDER_PRESETS = JSON.stringify([
      { id: 'deepseek', links: { console: 'https://my-portal.local/keys' } },
    ]);
    const ds = presets.getProviderPresets().find((p) => p.id === 'deepseek');
    expect(ds.links.console).toBe('https://my-portal.local/keys');
  });
});

describe('getProviderPresets — env overrides (KHY_PROVIDER_PRESETS)', () => {
  test('partial override by id keeps other built-in fields', () => {
    process.env.KHY_PROVIDER_PRESETS = JSON.stringify([{ id: 'deepseek', baseUrl: 'https://my-relay.local/v1' }]);
    const ds = presets.getProviderPresets().find((p) => p.id === 'deepseek');
    expect(ds.baseUrl).toBe('https://my-relay.local/v1'); // overridden
    expect(ds.defaultModel).toBe('deepseek-chat');          // built-in preserved
    expect(ds.apiFormat).toBe('openai');
  });

  test('a brand-new id is appended', () => {
    process.env.KHY_PROVIDER_PRESETS = JSON.stringify([
      { id: 'acme', label: 'Acme', baseUrl: 'https://acme.example/v1', apiFormat: 'openai' },
    ]);
    const acme = presets.getProviderPresets().find((p) => p.id === 'acme');
    expect(acme).toBeDefined();
    expect(acme.baseUrl).toBe('https://acme.example/v1');
  });

  test('an override carrying a key has it stripped', () => {
    process.env.KHY_PROVIDER_PRESETS = JSON.stringify([
      { id: 'acme', baseUrl: 'https://acme.example/v1', apiFormat: 'openai', key: 'sk-leak', apiKey: 'sk-leak2' },
    ]);
    const acme = presets.getProviderPresets().find((p) => p.id === 'acme');
    expect(acme).not.toHaveProperty('key');
    expect(acme).not.toHaveProperty('apiKey');
  });

  test('an unsupported apiFormat is dropped (防呆)', () => {
    process.env.KHY_PROVIDER_PRESETS = JSON.stringify([
      { id: 'weird', baseUrl: 'https://x/v1', apiFormat: 'grpc-magic' },
    ]);
    expect(presets.getProviderPresets().find((p) => p.id === 'weird')).toBeUndefined();
  });

  test('malformed JSON is ignored (fail-soft)', () => {
    process.env.KHY_PROVIDER_PRESETS = '{not json';
    expect(() => presets.getProviderPresets()).not.toThrow();
    expect(presets.getProviderPresets().length).toBeGreaterThan(0);
  });
});

describe('getProviderPresets — isolation', () => {
  test('mutating the result does not corrupt the next call', () => {
    delete process.env.KHY_PROVIDER_PRESETS;
    const first = presets.getProviderPresets();
    first[0].baseUrl = 'MUTATED';
    first[0].models.push('garbage');
    const second = presets.getProviderPresets();
    expect(second[0].baseUrl).not.toBe('MUTATED');
    expect(second[0].models).not.toContain('garbage');
  });
});
