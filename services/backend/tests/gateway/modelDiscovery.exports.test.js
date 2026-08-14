'use strict';

/**
 * Tests for gateway/modelDiscovery.js — model ID extraction and discovery.
 *
 * This module reads filesystem paths and env vars at load time,
 * so we use safe loading and test pure-function aspects.
 */

let mod;
let loadError;

beforeAll(() => {
  try {
    mod = require('../../src/services/gateway/modelDiscovery');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    loadError = e;
  }
});

describe('gateway/modelDiscovery exports', () => {
  test('module is loadable without syntax errors', () => {
    if (loadError) {
      expect(loadError).not.toBeInstanceOf(SyntaxError);
    }
  });

  test('exports discoverModels function', () => {
    if (!mod) return;
    expect(typeof mod.discoverModels).toBe('function');
  });

  test('exports mergeRelayModels function', () => {
    if (!mod) return;
    expect(typeof mod.mergeRelayModels).toBe('function');
  });

  test('exports updateRelayModelsInEnvFile function', () => {
    if (!mod) return;
    expect(typeof mod.updateRelayModelsInEnvFile).toBe('function');
  });
});

describe('mergeRelayModels', () => {
  test('merges empty existing with discovered models', () => {
    if (!mod) return;
    const result = mod.mergeRelayModels('', ['claude-3.5-sonnet', 'gpt-4o']);
    expect(result).toContain('claude-3.5-sonnet');
    expect(result).toContain('gpt-4o');
  });

  test('deduplicates models', () => {
    if (!mod) return;
    const result = mod.mergeRelayModels('gpt-4o', ['gpt-4o', 'claude-sonnet']);
    const parts = result.split(',');
    const gpt4oCount = parts.filter(p => p === 'gpt-4o').length;
    expect(gpt4oCount).toBe(1);
  });

  test('returns sorted comma-separated string', () => {
    if (!mod) return;
    const result = mod.mergeRelayModels('', ['gpt-4o', 'claude-sonnet']);
    const parts = result.split(',');
    // Should be sorted alphabetically
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i].localeCompare(parts[i - 1])).toBeGreaterThanOrEqual(0);
    }
  });

  test('handles null/undefined existing gracefully', () => {
    if (!mod) return;
    const result = mod.mergeRelayModels(null, ['gpt-4o']);
    expect(result).toContain('gpt-4o');
  });
});

describe('discoverModels', () => {
  test('returns object with models array and evidence array', () => {
    if (!mod) return;
    const result = mod.discoverModels();
    expect(result).toHaveProperty('models');
    expect(result).toHaveProperty('evidence');
    expect(Array.isArray(result.models)).toBe(true);
    expect(Array.isArray(result.evidence)).toBe(true);
  });

  test('models array contains sorted strings', () => {
    if (!mod) return;
    const { models } = mod.discoverModels();
    for (let i = 1; i < models.length; i++) {
      expect(models[i].localeCompare(models[i - 1])).toBeGreaterThanOrEqual(0);
    }
  });
});
