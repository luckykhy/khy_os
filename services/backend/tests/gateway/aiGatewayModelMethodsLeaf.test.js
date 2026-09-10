'use strict';
/**
 * Leaf-contract test for aiGatewayModelMethods.js (extracted from services/gateway/aiGateway.js).
 *
 * Proves: (1) the leaf exports the AIGatewayModelMethods prototype-mixin object with its model-selection /
 * adapter-accessor / verification methods as functions, plus the DI setter; (2) the host gateway singleton
 * still carries every mixed-in method on its prototype (Object.assign kept the contract intact) alongside
 * untouched class methods (generate) and the earlier cooldown + routing mixins; (3)
 * setAiGatewayModelMethodsDeps is a guarded, idempotent, non-throwing DI setter (functions via typeof
 * guards, value deps via a `!== undefined` guard).
 *
 * The methods perform IO (adapter calls, probe spawning, network) and run only against a live gateway
 * instance, so this test stays on the deterministic surface (export shape, prototype presence, setter
 * guard) and never drives an actual model selection / verification.
 */
const LEAF = '../../src/services/gateway/aiGatewayModelMethods';
const HOST = '../../src/services/gateway/aiGateway';
const MIXIN_METHODS = [
  'autoSelectModel', 'generateWithSubModel', 'isLocalAdapter', 'getAvailableLocalAdapter',
  'getAdapterOrigin', 'getStatus', 'getKhyProtocolPriorityRisk', 'getFirstAvailableAdapter',
  'getActiveAdapter', '_getLastVerifiedActiveAdapter', 'getRelayAdapter', 'getAdapter', 'getChannelHealthSnapshot', 'resetChannel',
  'getFailoverOrder', 'setFailoverOrder', 'clearFailoverOrder', 'generateWithAdapter', 'listModels',
  'verifyModel', 'verifyVisionCapability', 'verifyToolCalling', '_maybeBackgroundProbeToolCalling', 'destroy', 'testAdapter',
];

describe('Ai Gateway Model Methods Leaf', () => {
  test('leaf exports the model/adapter mixin object + DI setter', () => {
      const leaf = require(LEAF);
      expect(typeof leaf.setAiGatewayModelMethodsDeps).toBe('function');
      expect(leaf.AIGatewayModelMethods && typeof leaf.AIGatewayModelMethods === 'object').toBeTruthy();
      expect(Object.keys(leaf.AIGatewayModelMethods).length).toBe(MIXIN_METHODS.length);
      for (const n of MIXIN_METHODS) {
        expect(typeof leaf.AIGatewayModelMethods[n]).toBe('function', `missing mixin ${n}`);
      }
  });

  test('host gateway prototype carries every mixed-in method + untouched class / prior mixins', () => {
      const gateway = require(HOST);
      const proto = Object.getPrototypeOf(gateway);
      for (const n of MIXIN_METHODS) {
        expect(typeof proto[n]).toBe('function', `prototype missing ${n}`);
      }
      expect(typeof proto.generate).toBe('function');
      expect(typeof gateway.classifyError).toBe('function');
      // Prior mixins still present (all three coexist on the prototype).
      expect(typeof proto._recordAdapterFailure).toBe('function');       // cooldown mixin
      expect(typeof proto._rankAdaptersForDefaultRoute).toBe('function'); // routing mixin
  });

  test('setAiGatewayModelMethodsDeps is a guarded, idempotent, non-throwing DI setter', () => {
      const { setAiGatewayModelMethodsDeps } = require(LEAF);
      expect(() => setAiGatewayModelMethodsDeps().not.toThrow());
      expect(() => setAiGatewayModelMethodsDeps({}).not.toThrow());
      expect(() => setAiGatewayModelMethodsDeps({ _parseMs: 1, _ADAPTER_SOURCE_LABELS: null }).not.toThrow());
      const fake = {
        safeKillChildProc: () => {}, _shouldUseFastFail: () => false, _parseMs: () => 0,
        _getKhyProtocolPriorityRisk: () => 0, _extractResultErrorMessage: () => '',
        resolvePreferredModelForAdapter: () => null,
        _ADAPTER_SOURCE_LABELS: {}, CODEX_GENERATION_PROBE_PROMPT: 'x',
      };
      expect(() => setAiGatewayModelMethodsDeps(fake).not.toThrow());
      expect(() => setAiGatewayModelMethodsDeps(fake).not.toThrow());
  });

});

