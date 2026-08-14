'use strict';

/**
 * aiGateway.localAdapterSelection.test.js (node:test)
 *
 * Goal "优化khy的本地模式": forced local mode prefers a locally-running model
 * over the deterministic brain. getAvailableLocalAdapter() must return the
 * highest-priority enabled+available LOCAL adapter, or null when none runs.
 *
 * Hermetic: drives the pure selection logic over a stubbed _adapters array;
 * no init(), no real adapter detection.
 */
const test = require('node:test');
const assert = require('node:assert');

const gateway = require('../../../src/services/gateway/aiGateway');

function withAdapters(adapters, fn) {
  const saved = gateway._adapters;
  gateway._adapters = adapters;
  try { return fn(); } finally { gateway._adapters = saved; }
}

test('returns null when no local adapter is available', () => {
  withAdapters([
    { key: 'claude', priority: 3, enabled: true, available: true },
    { key: 'ollama', priority: 11, enabled: true, available: false },
    { key: 'localLLM', priority: 12, enabled: true, available: false },
  ], () => {
    assert.strictEqual(gateway.getAvailableLocalAdapter(), null);
  });
});

test('prefers the lower-priority local adapter (ollama before localLLM)', () => {
  withAdapters([
    { key: 'claude', priority: 3, enabled: true, available: true },
    { key: 'ollama', priority: 11, enabled: true, available: true },
    { key: 'localLLM', priority: 12, enabled: true, available: true },
  ], () => {
    assert.strictEqual(gateway.getAvailableLocalAdapter(), 'ollama');
  });
});

test('falls through to localLLM when ollama is down', () => {
  withAdapters([
    { key: 'claude', priority: 3, enabled: true, available: true },
    { key: 'ollama', priority: 11, enabled: true, available: false },
    { key: 'localLLM', priority: 12, enabled: true, available: true },
  ], () => {
    assert.strictEqual(gateway.getAvailableLocalAdapter(), 'localLLM');
  });
});

test('never selects a cloud adapter even when it is the only one available', () => {
  withAdapters([
    { key: 'claude', priority: 3, enabled: true, available: true },
    { key: 'kiro', priority: 0, enabled: true, available: true },
  ], () => {
    assert.strictEqual(gateway.getAvailableLocalAdapter(), null);
  });
});

test('ignores disabled local adapters', () => {
  withAdapters([
    { key: 'ollama', priority: 11, enabled: false, available: true },
    { key: 'localLLM', priority: 12, enabled: true, available: true },
  ], () => {
    assert.strictEqual(gateway.getAvailableLocalAdapter(), 'localLLM');
  });
});

test('isLocalAdapter classifies known keys', () => {
  assert.strictEqual(gateway.isLocalAdapter('ollama'), true);
  assert.strictEqual(gateway.isLocalAdapter('localLLM'), true);
  assert.strictEqual(gateway.isLocalAdapter('claude'), false);
  assert.strictEqual(gateway.isLocalAdapter(''), false);
});
