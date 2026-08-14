/**
 * customProviderRegistrar.getPresets() now derives from the shared
 * providerPresets single source. This guards the admin contract:
 *   - the returned shape is the admin form shape {id,name,endpoint,defaultModel,models,tier};
 *   - the Agnes preset still surfaces (back-compat with the old literal);
 *   - only OpenAI-compatible presets appear (registerCustomProvider is
 *     OpenAI-only — anthropic/gemini would be mislabelled if registered here).
 */
'use strict';

const registrar = require('../src/services/customProviderRegistrar');

afterEach(() => { delete process.env.KHY_PROVIDER_PRESETS; });

describe('customProviderRegistrar.getPresets', () => {
  test('returns the admin form shape', () => {
    const presets = registrar.getPresets();
    expect(Array.isArray(presets)).toBe(true);
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) {
      expect(Object.keys(p).sort()).toEqual(['defaultModel', 'endpoint', 'id', 'keyExample', 'models', 'name', 'tier']);
      expect(typeof p.endpoint).toBe('string');
      expect(Array.isArray(p.models)).toBe(true);
    }
  });

  test('Agnes preset survives the consolidation', () => {
    const agnes = registrar.getPresets().find((p) => p.id === 'agnes');
    expect(agnes).toMatchObject({
      id: 'agnes',
      name: 'Agnes AI',
      endpoint: 'https://apihub.agnes-ai.com/v1',
      defaultModel: 'agnes-2.0-flash',
    });
    expect(agnes.keyExample).toBe('sk-agnes-xxxxxxxxxxxxxxxx');
  });

  test('only OpenAI-compatible presets are surfaced (no anthropic/gemini)', () => {
    const ids = registrar.getPresets().map((p) => p.id);
    expect(ids).toContain('deepseek'); // openai
    expect(ids).not.toContain('anthropic');
    expect(ids).not.toContain('gemini');
  });

  test('env overrides flow through to the admin presets too', () => {
    process.env.KHY_PROVIDER_PRESETS = JSON.stringify([
      { id: 'acme', label: 'Acme', baseUrl: 'https://acme.example/v1', apiFormat: 'openai', defaultModel: 'acme-1' },
    ]);
    const acme = registrar.getPresets().find((p) => p.id === 'acme');
    expect(acme).toMatchObject({ id: 'acme', name: 'Acme', endpoint: 'https://acme.example/v1', defaultModel: 'acme-1' });
  });
});
