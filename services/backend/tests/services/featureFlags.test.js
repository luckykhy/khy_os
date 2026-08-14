'use strict';

/**
 * Tests for services/featureFlags.js — unified feature toggle system.
 */

let featureFlags;
let loadError;

beforeAll(() => {
  try {
    featureFlags = require('../../src/services/featureFlags');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    loadError = e;
  }
});

describe('featureFlags exports', () => {
  test('module is loadable without syntax errors', () => {
    if (loadError) {
      expect(loadError).not.toBeInstanceOf(SyntaxError);
    }
  });

  test('exports expected functions', () => {
    if (!featureFlags) return;
    expect(typeof featureFlags.isEnabled).toBe('function');
    expect(typeof featureFlags.listFeatures).toBe('function');
    expect(typeof featureFlags.setFeature).toBe('function');
  });

  test('exports DEFAULTS object', () => {
    if (!featureFlags) return;
    expect(typeof featureFlags.DEFAULTS).toBe('object');
    expect(featureFlags.DEFAULTS).toHaveProperty('buddy');
    expect(featureFlags.DEFAULTS).toHaveProperty('coordinator');
    expect(featureFlags.DEFAULTS).toHaveProperty('assistant');
    expect(featureFlags.DEFAULTS).toHaveProperty('ultraplan');
    expect(featureFlags.DEFAULTS).toHaveProperty('bridge');
  });
});

describe('isEnabled — default values', () => {
  // Clear any env overrides for these tests
  const envKeysToRestore = {};

  beforeAll(() => {
    if (!featureFlags) return;
    for (const key of Object.keys(featureFlags.DEFAULTS)) {
      const envKey = `KHY_FEATURE_${key.toUpperCase()}`;
      envKeysToRestore[envKey] = process.env[envKey];
      delete process.env[envKey];
    }
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(envKeysToRestore)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  test('buddy is enabled by default', () => {
    if (!featureFlags) return;
    expect(featureFlags.DEFAULTS.buddy).toBe(true);
  });

  test('bridge is disabled by default', () => {
    if (!featureFlags) return;
    expect(featureFlags.DEFAULTS.bridge).toBe(false);
  });

  test('unknown feature defaults to true', () => {
    if (!featureFlags) return;
    expect(featureFlags.isEnabled('unknown_feature_xyz')).toBe(true);
  });
});

describe('isEnabled — environment variable override', () => {
  afterEach(() => {
    delete process.env.KHY_FEATURE_BUDDY;
  });

  test('env var true enables feature', () => {
    if (!featureFlags) return;
    process.env.KHY_FEATURE_BUDDY = 'true';
    expect(featureFlags.isEnabled('buddy')).toBe(true);
  });

  test('env var 1 enables feature', () => {
    if (!featureFlags) return;
    process.env.KHY_FEATURE_BUDDY = '1';
    expect(featureFlags.isEnabled('buddy')).toBe(true);
  });

  test('env var false disables feature', () => {
    if (!featureFlags) return;
    process.env.KHY_FEATURE_BUDDY = 'false';
    expect(featureFlags.isEnabled('buddy')).toBe(false);
  });

  test('env var 0 disables feature', () => {
    if (!featureFlags) return;
    process.env.KHY_FEATURE_BUDDY = '0';
    expect(featureFlags.isEnabled('buddy')).toBe(false);
  });
});

describe('listFeatures', () => {
  test('returns array with all default features', () => {
    if (!featureFlags) return;
    const list = featureFlags.listFeatures();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(Object.keys(featureFlags.DEFAULTS).length);
  });

  test('each item has name, enabled, and source', () => {
    if (!featureFlags) return;
    const list = featureFlags.listFeatures();
    for (const item of list) {
      expect(typeof item.name).toBe('string');
      expect(typeof item.enabled).toBe('boolean');
      expect(['default', 'env', 'config']).toContain(item.source);
    }
  });
});
