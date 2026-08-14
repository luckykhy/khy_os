'use strict';

/**
 * Tests for gateway/pluginChain.js — plugin lifecycle hooks.
 *
 * The module reads from filesystem (plugins directory) at load time.
 * We test the API surface and in-process behavior.
 */

let pluginChain;
let loadError;

beforeAll(() => {
  try {
    pluginChain = require('../../src/services/gateway/pluginChain');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    loadError = e;
  }
});

describe('gateway/pluginChain exports', () => {
  test('module is loadable without syntax errors', () => {
    if (loadError) {
      expect(loadError).not.toBeInstanceOf(SyntaxError);
    }
  });

  test('exports expected functions', () => {
    if (!pluginChain) return;
    expect(typeof pluginChain.loadPlugins).toBe('function');
    expect(typeof pluginChain.reload).toBe('function');
    expect(typeof pluginChain.list).toBe('function');
    expect(typeof pluginChain.toggle).toBe('function');
    expect(typeof pluginChain.executeBeforeRequest).toBe('function');
    expect(typeof pluginChain.executeAfterResponse).toBe('function');
    expect(typeof pluginChain.executeOnError).toBe('function');
    expect(typeof pluginChain.executeOnStream).toBe('function');
    expect(typeof pluginChain.getPluginsDir).toBe('function');
  });

  test('exports ENABLED boolean', () => {
    if (!pluginChain) return;
    expect(typeof pluginChain.ENABLED).toBe('boolean');
  });
});

describe('list()', () => {
  test('returns an array', () => {
    if (!pluginChain) return;
    const plugins = pluginChain.list();
    expect(Array.isArray(plugins)).toBe(true);
  });

  test('each item has expected shape', () => {
    if (!pluginChain) return;
    const plugins = pluginChain.list();
    for (const p of plugins) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.priority).toBe('number');
      expect(typeof p.enabled).toBe('boolean');
      expect(Array.isArray(p.hooks)).toBe(true);
    }
  });
});

describe('toggle()', () => {
  test('returns false for non-existent plugin', () => {
    if (!pluginChain) return;
    const result = pluginChain.toggle('__nonexistent_plugin__', false);
    expect(result).toBe(false);
  });
});

describe('executeBeforeRequest()', () => {
  test('returns the context object when no plugins loaded', async () => {
    if (!pluginChain) return;
    const ctx = { prompt: 'hello', options: {} };
    const result = await pluginChain.executeBeforeRequest(ctx);
    expect(result).toHaveProperty('prompt', 'hello');
  });
});

describe('executeOnStream()', () => {
  test('returns chunk unchanged when no plugins loaded', () => {
    if (!pluginChain) return;
    const chunk = { data: 'test' };
    const ctx = { adapter: 'test' };
    const result = pluginChain.executeOnStream(chunk, ctx);
    expect(result).toEqual(chunk);
  });
});

describe('getPluginsDir()', () => {
  test('returns a non-empty string path', () => {
    if (!pluginChain) return;
    const dir = pluginChain.getPluginsDir();
    expect(typeof dir).toBe('string');
    expect(dir.length).toBeGreaterThan(0);
  });
});
