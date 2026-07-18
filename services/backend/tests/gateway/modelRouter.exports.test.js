'use strict';

/**
 * Tests for gateway/modelRouter.js — pure-function model routing logic.
 */

const modelRouter = require('../../src/services/gateway/modelRouter');

describe('gateway/modelRouter exports', () => {
  test('module exports expected functions', () => {
    expect(typeof modelRouter.normalizeAdapterKey).toBe('function');
    expect(typeof modelRouter.parseAdapterScopedModel).toBe('function');
    expect(typeof modelRouter.parseRouteMap).toBe('function');
    expect(typeof modelRouter.resolveModelRoute).toBe('function');
  });

  test('exports DEFAULT_PREFIX_TO_ADAPTER as frozen object', () => {
    expect(modelRouter.DEFAULT_PREFIX_TO_ADAPTER).toBeDefined();
    expect(Object.isFrozen(modelRouter.DEFAULT_PREFIX_TO_ADAPTER)).toBe(true);
    expect(modelRouter.DEFAULT_PREFIX_TO_ADAPTER.kiro).toBe('kiro');
    expect(modelRouter.DEFAULT_PREFIX_TO_ADAPTER.cursor).toBe('cursor');
  });

  test('exports DEFAULT_ADAPTER_TO_PREFIX as frozen object', () => {
    expect(modelRouter.DEFAULT_ADAPTER_TO_PREFIX).toBeDefined();
    expect(Object.isFrozen(modelRouter.DEFAULT_ADAPTER_TO_PREFIX)).toBe(true);
  });
});

describe('normalizeAdapterKey', () => {
  test('normalizes known prefixes to adapter keys', () => {
    expect(modelRouter.normalizeAdapterKey('kiro')).toBe('kiro');
    expect(modelRouter.normalizeAdapterKey('cursor')).toBe('cursor');
    expect(modelRouter.normalizeAdapterKey('ollama')).toBe('ollama');
  });

  test('normalizes trae aliases', () => {
    expect(modelRouter.normalizeAdapterKey('antigravity')).toBe('trae');
    expect(modelRouter.normalizeAdapterKey('anti_gravity')).toBe('trae');
    expect(modelRouter.normalizeAdapterKey('nirvana')).toBe('trae');
  });

  test('normalizes localllm to camelCase localLLM', () => {
    expect(modelRouter.normalizeAdapterKey('localllm')).toBe('localLLM');
    expect(modelRouter.normalizeAdapterKey('local')).toBe('localLLM');
    expect(modelRouter.normalizeAdapterKey('local_llm')).toBe('localLLM');
  });

  test('returns null for empty input', () => {
    expect(modelRouter.normalizeAdapterKey('')).toBeNull();
    expect(modelRouter.normalizeAdapterKey(null)).toBeNull();
    expect(modelRouter.normalizeAdapterKey(undefined)).toBeNull();
  });

  test('returns original string for unknown prefix', () => {
    expect(modelRouter.normalizeAdapterKey('customAdapter')).toBe('customAdapter');
  });
});

describe('parseAdapterScopedModel', () => {
  test('parses slash-separated adapter/model', () => {
    const result = modelRouter.parseAdapterScopedModel('cursor/gpt-4o');
    expect(result.adapterKey).toBe('cursor');
    expect(result.modelId).toBe('gpt-4o');
    expect(result.explicitAdapter).toBe(true);
    expect(result.syntax).toBe('slash');
  });

  test('parses colon-separated adapter:model', () => {
    const result = modelRouter.parseAdapterScopedModel('ollama:llama3');
    expect(result.adapterKey).toBe('ollama');
    expect(result.modelId).toBe('llama3');
    expect(result.explicitAdapter).toBe(true);
    expect(result.syntax).toBe('colon');
  });

  test('returns plain model when no adapter prefix', () => {
    const result = modelRouter.parseAdapterScopedModel('gpt-4o-mini');
    expect(result.adapterKey).toBeNull();
    expect(result.modelId).toBe('gpt-4o-mini');
    expect(result.explicitAdapter).toBe(false);
    expect(result.syntax).toBe('plain');
  });

  test('returns none syntax for empty input', () => {
    const result = modelRouter.parseAdapterScopedModel('');
    expect(result.adapterKey).toBeNull();
    expect(result.modelId).toBeNull();
    expect(result.syntax).toBe('none');
  });
});

describe('parseRouteMap', () => {
  test('returns empty object for falsy input', () => {
    expect(modelRouter.parseRouteMap(null)).toEqual({});
    expect(modelRouter.parseRouteMap('')).toEqual({});
    expect(modelRouter.parseRouteMap(undefined)).toEqual({});
  });

  test('returns object input directly', () => {
    const map = { 'gpt-4': 'ollama/llama3' };
    expect(modelRouter.parseRouteMap(map)).toEqual(map);
  });

  test('parses JSON string route map', () => {
    const json = JSON.stringify({ 'gpt-4': 'cursor/gpt-4' });
    const result = modelRouter.parseRouteMap(json);
    expect(result['gpt-4']).toBe('cursor/gpt-4');
  });

  test('parses comma-separated key=value pairs', () => {
    const result = modelRouter.parseRouteMap('gpt-4=cursor/gpt-4,claude=kiro/claude-sonnet');
    expect(result['gpt-4']).toBe('cursor/gpt-4');
    expect(result.claude).toBe('kiro/claude-sonnet');
  });

  test('parses arrow syntax key=>value', () => {
    const result = modelRouter.parseRouteMap('gpt-4=>ollama/llama3');
    expect(result['gpt-4']).toBe('ollama/llama3');
  });
});
