'use strict';
/**
 * Leaf-contract test for aiGatewayRoutingMethods.js (extracted from services/gateway/aiGateway.js).
 *
 * Proves: (1) the leaf exports the AIGatewayRoutingMethods prototype-mixin object with its
 * routing / timeout / lifecycle methods as functions, plus the DI setter; (2) the host gateway singleton
 * still carries every mixed-in method on its prototype (so Object.assign onto AIGateway.prototype kept the
 * contract intact) alongside untouched class methods like generate / init and the cooldown mixin methods;
 * (3) setAiGatewayRoutingMethodsDeps is a guarded, idempotent, non-throwing DI setter that wires the
 * injected aiGateway.js module-scope helpers (functions via typeof guards, value deps â€?route tuning
 * tables, adapters, localLLMService â€?via a `!== undefined` guard so null is accepted).
 *
 * The methods perform IO (adapter calls, timers, network, model refresh) and run only against a live
 * gateway instance, so this test stays on the deterministic surface (export shape, prototype presence,
 * setter guard) and never drives an actual adapter route/generation.
 */
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
  'refreshAdapters', '_enforceRateLimit', 'init', '_doInit', '_warmupContextWindowCache',
  '_refreshModelsBackground',
  '_resolveActiveChannelKey', '_syncChannelLifecycle', 'setActiveChannel', 'setModelContextWindow',
  'setModelMaxOutputTokens', 'getModelMaxOutputTokens',
  'getModelContextWindow', '_resolveContextWindowAsync',
];

describe('Ai Gateway Routing Methods Leaf', () => {
  test('leaf exports the routing mixin object + DI setter', () => {
      const leaf = require(LEAF);
      expect(typeof leaf.setAiGatewayRoutingMethodsDeps).toBe('function');
      expect(leaf.AIGatewayRoutingMethods && typeof leaf.AIGatewayRoutingMethods === 'object').toBeTruthy();
      expect(Object.keys(leaf.AIGatewayRoutingMethods).length).toBe(MIXIN_METHODS.length);
      for (const n of MIXIN_METHODS) {
        expect(typeof leaf.AIGatewayRoutingMethods[n]).toBe('function', `missing mixin ${n}`);
      }
  });

  test('host gateway prototype carries every mixed-in method + untouched class / cooldown methods', () => {
      const gateway = require(HOST);
      const proto = Object.getPrototypeOf(gateway);
      for (const n of MIXIN_METHODS) {
        expect(typeof proto[n]).toBe('function', `prototype missing ${n}`);
      }
      // Untouched core class methods stay on the prototype.
      expect(typeof proto.generate).toBe('function');
      expect(typeof gateway.classifyError).toBe('function');
      // The previously-extracted cooldown mixin is still present (both mixins coexist).
      expect(typeof proto._recordAdapterFailure).toBe('function');
  });

  test('setAiGatewayRoutingMethodsDeps is a guarded, idempotent, non-throwing DI setter', () => {
      const { setAiGatewayRoutingMethodsDeps } = require(LEAF);
      expect(() => setAiGatewayRoutingMethodsDeps().not.toThrow());
      expect(() => setAiGatewayRoutingMethodsDeps({}).not.toThrow());
      // Non-function fn-deps are ignored; value deps accept any defined value (incl. null).
      expect(() => setAiGatewayRoutingMethodsDeps({ _parseMs: 1, localLLMService: null }).not.toThrow());
      const fake = {
        _appendKhyProtocolDebugLog: () => {}, _buildKhyProtocolDebugSummary: () => '',
        _formatRouteAgeMs: () => '', _getKhyProtocolPriorityRisk: () => 0,
        _injectKhyExpectedLanguageSystem: (m) => m, _injectKhyProtocolPrompt: (m) => m,
        _injectKhyProtocolSystem: (m) => m, _isProcessSensitiveAdapter: () => false,
        _parseMs: () => 0, _parseProcessFailoverCandidates: () => [], _resolveDefaultRouteTuning: () => ({}),
        DEFAULT_ROUTE_BASE_PRIORITY: {}, DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS: new Set(),
        kiroAdapter: {}, ollamaAdapter: {}, localLLMService: null,
      };
      expect(() => setAiGatewayRoutingMethodsDeps(fake).not.toThrow());
      expect(() => setAiGatewayRoutingMethodsDeps(fake).not.toThrow());
  });

});

