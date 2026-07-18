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
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../src/services/gateway/aiGatewayModelMethods';
const HOST = '../../src/services/gateway/aiGateway';

const MIXIN_METHODS = [
  'autoSelectModel', 'generateWithSubModel', 'isLocalAdapter', 'getAvailableLocalAdapter',
  'getAdapterOrigin', 'getStatus', 'getKhyProtocolPriorityRisk', 'getFirstAvailableAdapter',
  'getActiveAdapter', 'getRelayAdapter', 'getAdapter', 'getChannelHealthSnapshot', 'resetChannel',
  'getFailoverOrder', 'setFailoverOrder', 'clearFailoverOrder', 'generateWithAdapter', 'listModels',
  'verifyModel', 'verifyToolCalling', '_maybeBackgroundProbeToolCalling', 'destroy', 'testAdapter',
];

test('leaf exports the model/adapter mixin object + DI setter', () => {
  const leaf = require(LEAF);
  assert.strictEqual(typeof leaf.setAiGatewayModelMethodsDeps, 'function');
  assert.ok(leaf.AIGatewayModelMethods && typeof leaf.AIGatewayModelMethods === 'object');
  assert.strictEqual(Object.keys(leaf.AIGatewayModelMethods).length, MIXIN_METHODS.length);
  for (const n of MIXIN_METHODS) {
    assert.strictEqual(typeof leaf.AIGatewayModelMethods[n], 'function', `missing mixin ${n}`);
  }
});

test('host gateway prototype carries every mixed-in method + untouched class / prior mixins', () => {
  const gateway = require(HOST);
  const proto = Object.getPrototypeOf(gateway);
  for (const n of MIXIN_METHODS) {
    assert.strictEqual(typeof proto[n], 'function', `prototype missing ${n}`);
  }
  assert.strictEqual(typeof proto.generate, 'function');
  assert.strictEqual(typeof gateway.classifyError, 'function');
  // Prior mixins still present (all three coexist on the prototype).
  assert.strictEqual(typeof proto._recordAdapterFailure, 'function');       // cooldown mixin
  assert.strictEqual(typeof proto._rankAdaptersForDefaultRoute, 'function'); // routing mixin
});

test('setAiGatewayModelMethodsDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setAiGatewayModelMethodsDeps } = require(LEAF);
  assert.doesNotThrow(() => setAiGatewayModelMethodsDeps());
  assert.doesNotThrow(() => setAiGatewayModelMethodsDeps({}));
  assert.doesNotThrow(() => setAiGatewayModelMethodsDeps({ _parseMs: 1, _ADAPTER_SOURCE_LABELS: null }));
  const fake = {
    safeKillChildProc: () => {}, _shouldUseFastFail: () => false, _parseMs: () => 0,
    _getKhyProtocolPriorityRisk: () => 0, _extractResultErrorMessage: () => '',
    resolvePreferredModelForAdapter: () => null,
    _ADAPTER_SOURCE_LABELS: {}, CODEX_GENERATION_PROBE_PROMPT: 'x',
  };
  assert.doesNotThrow(() => setAiGatewayModelMethodsDeps(fake));
  assert.doesNotThrow(() => setAiGatewayModelMethodsDeps(fake));
});
