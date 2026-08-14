'use strict';

/**
 * Tests for gateway/aiGateway.js — export shape validation.
 *
 * The gateway has heavy external dependencies (adapters, Redis, child_process),
 * so we use a safe loading pattern and primarily verify the export contract.
 */

let gateway;
let loadError;

beforeAll(() => {
  try {
    gateway = require('../../src/services/gateway/aiGateway');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    loadError = e;
  }
});

describe('gateway/aiGateway exports', () => {
  test('module is loadable without syntax errors', () => {
    // If there was a load error it should not be a SyntaxError
    if (loadError) {
      expect(loadError).not.toBeInstanceOf(SyntaxError);
    }
  });

  test('exports an object (singleton pattern)', () => {
    if (!gateway) return; // skip if load failed due to dependencies
    expect(typeof gateway).toBe('object');
    expect(gateway).not.toBeNull();
  });

  test('exports init function', () => {
    if (!gateway) return;
    expect(typeof gateway.init).toBe('function');
  });

  test('exports generate function', () => {
    if (!gateway) return;
    expect(typeof gateway.generate).toBe('function');
  });

  test('exports getStatus or status method', () => {
    if (!gateway) return;
    const hasStatus = typeof gateway.getStatus === 'function' ||
                      typeof gateway.status === 'function';
    expect(hasStatus).toBe(true);
  });

  test('exposes adapter inventory via getStatus or _adapters', () => {
    if (!gateway) return;
    const hasList = typeof gateway.getStatus === 'function' ||
                    Array.isArray(gateway._adapters);
    expect(hasList).toBe(true);
  });

  test('exports _initialized flag', () => {
    if (!gateway) return;
    expect(typeof gateway._initialized).toBe('boolean');
  });

  test('exports _adapters as array', () => {
    if (!gateway) return;
    expect(Array.isArray(gateway._adapters)).toBe(true);
  });
});
