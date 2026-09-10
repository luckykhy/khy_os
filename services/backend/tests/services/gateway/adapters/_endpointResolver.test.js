'use strict';

const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');

describe('_endpointResolver', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('resolveAdapterEndpoint', () => {
    test('returns endpoint for api key', () => {
      delete process.env.KHY_API_ENDPOINT;
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      const result = resolveAdapterEndpoint('api');
      expect(typeof result).toBe('string');
    });

    test('returns endpoint for claude key', () => {
      delete process.env.CLAUDE_API_ENDPOINT;
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      const result = resolveAdapterEndpoint('claude');
      expect(result).toBe('https://api.anthropic.com');
    });

    test('returns endpoint for openai key', () => {
      delete process.env.OPENAI_API_ENDPOINT;
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      const result = resolveAdapterEndpoint('openai');
      expect(result).toBe('https://api.openai.com');
    });

    test('returns endpoint for deepseek key', () => {
      delete process.env.DEEPSEEK_API_ENDPOINT;
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      const result = resolveAdapterEndpoint('deepseek');
      expect(result).toBe('https://api.deepseek.com');
    });

    test('returns endpoint for ollama key', () => {
      delete process.env.OLLAMA_ENDPOINT;
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      const result = resolveAdapterEndpoint('ollama');
      expect(result).toBe('http://localhost:11434');
    });

    test('returns empty string for unknown key', () => {
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      expect(resolveAdapterEndpoint('unknown')).toBe('');
    });

    test('returns empty string for empty string key', () => {
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      expect(resolveAdapterEndpoint('')).toBe('');
    });

    test('returns empty string for null key', () => {
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      expect(resolveAdapterEndpoint(null)).toBe('');
    });

    test('returns empty string for undefined key', () => {
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      expect(resolveAdapterEndpoint(undefined)).toBe('');
    });

    test('returns empty string for number key', () => {
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      expect(resolveAdapterEndpoint(123)).toBe('');
    });

    test('returns empty string for object key', () => {
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      expect(resolveAdapterEndpoint({})).toBe('');
    });

    test('env variable overrides default for claude', () => {
      process.env.CLAUDE_API_ENDPOINT = 'https://custom-claude.example.com';
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      const result = resolveAdapterEndpoint('claude');
      expect(result).toBe('https://custom-claude.example.com');
    });

    test('env variable overrides default for openai', () => {
      process.env.OPENAI_API_ENDPOINT = 'https://custom-openai.example.com';
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      const result = resolveAdapterEndpoint('openai');
      expect(result).toBe('https://custom-openai.example.com');
    });

    test('env variable overrides default for deepseek', () => {
      process.env.DEEPSEEK_API_ENDPOINT = 'https://custom-deepseek.example.com';
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      const result = resolveAdapterEndpoint('deepseek');
      expect(result).toBe('https://custom-deepseek.example.com');
    });

    test('env variable overrides default for ollama', () => {
      process.env.OLLAMA_ENDPOINT = 'http://custom-ollama:8080';
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      const result = resolveAdapterEndpoint('ollama');
      expect(result).toBe('http://custom-ollama:8080');
    });

    test('relay and relay_api share same endpoint', () => {
      delete process.env.RELAY_API_ENDPOINT;
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      const relayResult = resolveAdapterEndpoint('relay');
      const relayApiResult = resolveAdapterEndpoint('relay_api');
      expect(relayResult).toBe(relayApiResult);
    });

    test('localllm returns undefined when no env or default', () => {
      delete process.env.LOCAL_LLM_ENDPOINT;
      const { resolveAdapterEndpoint } = require('../../src/services/gateway/adapters/_endpointResolver');
      const result = resolveAdapterEndpoint('localllm');
      expect(result === undefined || result === '').toBe(true);
    });
  });
});

