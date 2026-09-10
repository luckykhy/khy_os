'use strict';

const { resolveAdapterEndpoint } = require('../../../src/services/gateway/adapters/_endpointResolver');

jest.mock('../../../src/constants/serviceDefaults', () => ({
  API_ENDPOINT: 'https://api.test.com',
  RELAY_API_ENDPOINT: 'https://relay.test.com',
  CLAUDE_API_ENDPOINT: '',
  OPENAI_API_ENDPOINT: '',
  DEEPSEEK_API_ENDPOINT: '',
  OLLAMA_ENDPOINT: '',
  LOCAL_LLM_ENDPOINT: undefined
}));

describe('_endpointResolver', () => {
  test('resolves API endpoint', () => {
    expect(resolveAdapterEndpoint('api')).toBe('https://api.test.com');
  });

  test('resolves relay endpoint', () => {
    expect(resolveAdapterEndpoint('relay_api')).toBe('https://relay.test.com');
    expect(resolveAdapterEndpoint('relay')).toBe('https://relay.test.com');
  });

  test('falls back to defaults for claude', () => {
    expect(resolveAdapterEndpoint('claude')).toBe('https://api.anthropic.com');
  });

  test('returns empty string for unknown key', () => {
    expect(resolveAdapterEndpoint('unknown')).toBe('');
  });
});
