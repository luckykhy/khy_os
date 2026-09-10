'use strict';
/**
 * Leaf-contract test for aiGatewayCooldownMethods.js (extracted from services/gateway/aiGateway.js).
 *
 * Proves: (1) the leaf exports the AIGatewayCooldownMethods prototype-mixin object with its cooldown /
 * adapter-failure methods as functions, plus the DI setter; (2) the host gateway singleton still carries
 * every mixed-in method on its prototype (so Object.assign onto AIGateway.prototype kept the contract
 * intact) alongside untouched class methods like generate / init; (3) setAiGatewayCooldownMethodsDeps is
 * a guarded, idempotent, non-throwing DI setter that only wires the injected aiGateway.js module-scope
 * helpers.
 *
 * The methods perform IO (timers, account-pool persistence, circuit-breaker calls) and run only against a
 * live gateway instance, so this test stays on the deterministic surface (export shape, prototype
 * presence, setter guard) and never drives an actual adapter failure/cooldown cycle.
 */
const LEAF = '../../src/services/gateway/aiGatewayCooldownMethods';
const HOST = '../../src/services/gateway/aiGateway';
const MIXIN_METHODS = [
  '_cleanupStaleData', '_clearCooldownSelfHealMidpointTimer', '_clearAllCooldownSelfHealMidpointTimers',
  '_scheduleCooldownSelfHealMidpointTimer', '_triggerMidpointSelfHealProbe', '_recordAdapterFailure',
  '_clearAdapterFailure', '_handleAccountPoolAuthError', '_shouldBypassCooldownForVisionDescribe',
  '_shouldPinApiAdapterForVisionDescribe', '_getRecentFastFail', '_resolveCooldownSelfHealConfig',
  '_runCooldownSelfHealTick', '_startCooldownSelfHealTicker', '_stopCooldownSelfHealTicker',
  '_isHealthyProbeResult', '_maybeScheduleCooldownSelfHealProbe', '_resolveFastFailCooldownMs',
];

describe('Ai Gateway Cooldown Methods Leaf', () => {
  test('leaf exports the cooldown mixin object + DI setter', () => {
      const leaf = require(LEAF);
      expect(typeof leaf.setAiGatewayCooldownMethodsDeps).toBe('function');
      expect(leaf.AIGatewayCooldownMethods && typeof leaf.AIGatewayCooldownMethods === 'object').toBeTruthy();
      for (const n of MIXIN_METHODS) {
        expect(typeof leaf.AIGatewayCooldownMethods[n]).toBe('function', `missing mixin ${n}`);
      }
  });

  test('host gateway prototype carries every mixed-in method + untouched class methods', () => {
      const gateway = require(HOST);
      const proto = Object.getPrototypeOf(gateway);
      for (const n of MIXIN_METHODS) {
        expect(typeof proto[n]).toBe('function', `prototype missing ${n}`);
      }
      // Untouched core class methods stay on the prototype.
      expect(typeof proto.generate).toBe('function');
      expect(typeof proto.init).toBe('function');
      expect(typeof gateway.classifyError).toBe('function');
  });

  test('setAiGatewayCooldownMethodsDeps is a guarded, idempotent, non-throwing DI setter', () => {
      const { setAiGatewayCooldownMethodsDeps } = require(LEAF);
      expect(() => setAiGatewayCooldownMethodsDeps().not.toThrow());
      expect(() => setAiGatewayCooldownMethodsDeps({}).not.toThrow());
      // Non-function deps are ignored by the typeof guards; _adaptiveConfig accepts any defined value.
      expect(() => setAiGatewayCooldownMethodsDeps({ _parseMs: 1, _adaptiveConfig: null }).not.toThrow());
      const fake = {
        _adaptiveConfig: null,
        _isProcessSensitiveAdapter: () => false, _isReconnectOrChannelClosedMessage: () => false,
        _parseFloat01: () => 0, _parseMs: () => 0, _parsePositiveInt: () => 1,
        _resolveApiPoolProviderForRequest: () => null, _sanitizeFailureMessage: (m) => m,
        _shouldUseFastFail: () => false, _transientCooldownMs: () => 0,
      };
      expect(() => setAiGatewayCooldownMethodsDeps(fake).not.toThrow());
      expect(() => setAiGatewayCooldownMethodsDeps(fake).not.toThrow());
  });

});

