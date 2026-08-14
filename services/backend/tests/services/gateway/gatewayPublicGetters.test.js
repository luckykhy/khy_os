'use strict';

// Batch-4 getter guardrail: the public getters must be identity-returning
// views over the private fields (no boolean coercion, no copy, no freeze),
// so consumer migration from direct `_initialized` / `_adapters` reads is a
// byte-for-byte equivalent substitution.

describe('aiGateway public getters (identity-return contract)', () => {
  const gateway = require('../../../src/services/gateway/aiGateway');

  test('isInitialized() returns the raw private value with === identity (including falsy)', () => {
    const saved = gateway._initialized;
    try {
      // Whatever the current raw value is, the getter must mirror it exactly.
      expect(gateway.isInitialized()).toBe(gateway._initialized);

      gateway._initialized = false;
      expect(gateway.isInitialized()).toBe(false);

      gateway._initialized = true;
      expect(gateway.isInitialized()).toBe(true);

      // Raw falsy passthrough: no !! coercion, no defaulting.
      gateway._initialized = null;
      expect(gateway.isInitialized()).toBe(null);

      gateway._initialized = undefined;
      expect(gateway.isInitialized()).toBe(undefined);
    } finally {
      gateway._initialized = saved;
    }
  });

  test('getAdapters() returns the SAME array reference (no copy, no freeze)', () => {
    expect(gateway.getAdapters()).toBe(gateway._adapters);
    expect(Object.isFrozen(gateway.getAdapters())).toBe(false);

    const stub = [];
    const saved = gateway._adapters;
    try {
      gateway._adapters = stub;
      // Reference identity must track the private field, not a snapshot.
      expect(gateway.getAdapters()).toBe(stub);
    } finally {
      gateway._adapters = saved;
    }
  });
});
