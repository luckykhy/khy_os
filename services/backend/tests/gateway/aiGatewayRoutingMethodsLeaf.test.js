'use strict';

/**
 * Leaf-contract test for aiGatewayRoutingMethods.js (extracted from services/gateway/aiGateway.js).
 *
 * Proves: (1) the leaf exports the AIGatewayRoutingMethods prototype-mixin object with its
 * routing / timeout / lifecycle methods as functions, plus the DI setter; (2) the host gateway singleton
 * still carries every mixed-in method on its prototype (so Object.assign onto AIGateway.prototype kept the
 * contract intact) alongside untouched class methods like generate / init and the cooldown mixin methods;
 * (3) setAiGatewayRoutingMethodsDeps is a guarded, idempotent, non-throwing DI setter that wires the
 * injected aiGateway.js module-scope helpers (functions via typeof guards, value deps — route tuning
 * tables, adapters, localLLMService — via a `!== undefined` guard so null is accepted).
 *
 * The methods perform IO (adapter calls, timers, network, model refresh) and run only against a live
 * gateway instance, so this test stays on the deterministic surface (export shape, prototype presence,
 * setter guard) and never drives an actual adapter route/generation.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../src/services/gateway/aiGatewayRoutingMethods';
const HOST = '../../src/services/gateway/aiGateway';

const MIXIN_METHODS = [
  '_resolveAdapterTimeoutMs', '_shouldSerializeAdapter', '_getDefaultRouteBasePriority',
  '_isManualFallbackOnlyKey',
  '_collectAdapterRuntimeDiagnostics', '_assessDefaultRouteCandidate', '_rankAdaptersForDefaultRoute',
  '_ucbRoutingEnabled', '_applyUcbRouting', '_recordAdapterOutcome', '_getFailoverOrderMap',
  '_invalidateFailoverOrderCache', '_orderAdaptersByDefaultRoutePreference',
  '_reorderAdaptersByModelProtocolHint', 'getCacheEconomyReport', 'getDefaultRouteRecommendation',
  '_maybePromoteProcessFailoverAdapters', '_generateWithAdapterIsolation', 'forceReconnect',
  'refreshAdapters', '_enforceRateLimit', 'init', '_doInit', '_refreshModelsBackground',
  '_resolveActiveChannelKey', '_syncChannelLifecycle', 'setActiveChannel', 'setModelContextWindow',
  'getModelContextWindow', '_resolveContextWindowAsync',
];

test('leaf exports the routing mixin object + DI setter', () => {
  const leaf = require(LEAF);
  assert.strictEqual(typeof leaf.setAiGatewayRoutingMethodsDeps, 'function');
  assert.ok(leaf.AIGatewayRoutingMethods && typeof leaf.AIGatewayRoutingMethods === 'object');
  assert.strictEqual(Object.keys(leaf.AIGatewayRoutingMethods).length, MIXIN_METHODS.length);
  for (const n of MIXIN_METHODS) {
    assert.strictEqual(typeof leaf.AIGatewayRoutingMethods[n], 'function', `missing mixin ${n}`);
  }
});

test('host gateway prototype carries every mixed-in method + untouched class / cooldown methods', () => {
  const gateway = require(HOST);
  const proto = Object.getPrototypeOf(gateway);
  for (const n of MIXIN_METHODS) {
    assert.strictEqual(typeof proto[n], 'function', `prototype missing ${n}`);
  }
  // Untouched core class methods stay on the prototype.
  assert.strictEqual(typeof proto.generate, 'function');
  assert.strictEqual(typeof gateway.classifyError, 'function');
  // The previously-extracted cooldown mixin is still present (both mixins coexist).
  assert.strictEqual(typeof proto._recordAdapterFailure, 'function');
});

test('setAiGatewayRoutingMethodsDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setAiGatewayRoutingMethodsDeps } = require(LEAF);
  assert.doesNotThrow(() => setAiGatewayRoutingMethodsDeps());
  assert.doesNotThrow(() => setAiGatewayRoutingMethodsDeps({}));
  // Non-function fn-deps are ignored; value deps accept any defined value (incl. null).
  assert.doesNotThrow(() => setAiGatewayRoutingMethodsDeps({ _parseMs: 1, localLLMService: null }));
  const fake = {
    _appendKhyProtocolDebugLog: () => {}, _buildKhyProtocolDebugSummary: () => '',
    _formatRouteAgeMs: () => '', _getKhyProtocolPriorityRisk: () => 0,
    _injectKhyExpectedLanguageSystem: (m) => m, _injectKhyProtocolPrompt: (m) => m,
    _injectKhyProtocolSystem: (m) => m, _isProcessSensitiveAdapter: () => false,
    _parseMs: () => 0, _parseProcessFailoverCandidates: () => [], _resolveDefaultRouteTuning: () => ({}),
    DEFAULT_ROUTE_BASE_PRIORITY: {}, DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS: new Set(),
    kiroAdapter: {}, ollamaAdapter: {}, localLLMService: null,
  };
  assert.doesNotThrow(() => setAiGatewayRoutingMethodsDeps(fake));
  assert.doesNotThrow(() => setAiGatewayRoutingMethodsDeps(fake));
});
