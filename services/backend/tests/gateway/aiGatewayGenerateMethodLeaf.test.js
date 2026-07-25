'use strict';

/**
 * Leaf-contract test for aiGatewayGenerateMethod.js (extracted from services/gateway/aiGateway.js).
 *
 * Proves: (1) the leaf exports the AIGatewayGenerateMethod prototype-mixin object carrying the single
 * generate method plus the DI setter; (2) the host gateway singleton still exposes generate on its
 * prototype (Object.assign kept the contract intact) alongside the three earlier mixins (cooldown /
 * routing / model) and the untouched class surface; (3) setAiGatewayGenerateMethodDeps is a guarded,
 * idempotent, non-throwing DI setter (32 host helpers via typeof guards, 3 nullable module lets via a
 * `!== undefined` guard).
 *
 * generate performs heavy IO (adapter network calls, timers, spawns) and runs only against a live gateway
 * with real adapters, so this test stays on the deterministic surface (export shape, prototype presence,
 * setter guard) and never drives an actual generation. Behavioural coverage of generate lives in the
 * aiGateway.stability / languageConsistency / retryBudget / apiPoolStrategy suites, which exercise it
 * end-to-end after the mixin wiring.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../src/services/gateway/aiGatewayGenerateMethod';
const HOST = '../../src/services/gateway/aiGateway';

test('leaf exports the generate mixin object (single method) + DI setter', () => {
  const leaf = require(LEAF);
  assert.strictEqual(typeof leaf.setAiGatewayGenerateMethodDeps, 'function');
  assert.ok(leaf.AIGatewayGenerateMethod && typeof leaf.AIGatewayGenerateMethod === 'object');
  assert.deepStrictEqual(Object.keys(leaf.AIGatewayGenerateMethod), ['generate']);
  assert.strictEqual(typeof leaf.AIGatewayGenerateMethod.generate, 'function');
  // generate is async: its constructor name is AsyncFunction.
  assert.strictEqual(leaf.AIGatewayGenerateMethod.generate.constructor.name, 'AsyncFunction');
});

test('host gateway prototype carries generate + all four mixins + untouched surface', () => {
  const gateway = require(HOST);
  const proto = Object.getPrototypeOf(gateway);
  assert.strictEqual(typeof proto.generate, 'function');
  // All four extracted mixins coexist on the prototype.
  assert.strictEqual(typeof proto._recordAdapterFailure, 'function');        // cooldown
  assert.strictEqual(typeof proto._rankAdaptersForDefaultRoute, 'function');  // routing
  assert.strictEqual(typeof proto.autoSelectModel, 'function');              // model
  // Untouched instance surface.
  assert.strictEqual(typeof gateway.classifyError, 'function');
  assert.strictEqual(typeof gateway.getStatus, 'function');
});

test('setAiGatewayGenerateMethodDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setAiGatewayGenerateMethodDeps } = require(LEAF);
  assert.doesNotThrow(() => setAiGatewayGenerateMethodDeps());
  assert.doesNotThrow(() => setAiGatewayGenerateMethodDeps({}));
  // Non-function fn-deps are ignored; nullable module lets accept null.
  assert.doesNotThrow(() => setAiGatewayGenerateMethodDeps({ classifyError: 1, _advDiag: null }));
  const fn = () => {};
  const fake = {
    _advDiag: null, _modelSwitch: null, _traceAudit: null,
    _appendVisionKeyOffer: fn, _buildLanguageMismatchFailureMessage: fn, _createCodexChineseChunkGate: fn,
    _createKhyLanguageConsistencyTracker: fn, _defaultModelForApiPoolProvider: fn, _extractResultErrorMessage: fn,
    _injectKhyChineseRecoveryPrompt: fn, _injectKhyChineseRecoverySystem: fn, _isDeadEndpointErrorType: fn,
    _isHttpRelayAdapter: fn, _isProcessSensitiveAdapter: fn, _isRetryableResultErrorType: fn,
    _isTransientGatewayTransportMessage: fn, _mapApiPoolProviderToServiceProvider: fn, _normalizeApiPoolProvider: fn,
    _parseMs: fn, _parsePositiveInt: fn, _prependFailureReason: fn, _resolveApiPoolProviderForRequest: fn,
    _resolveCodexChineseRecoveryRetryBudget: fn, _resolveResultErrorType: fn, _shouldAutoRecoverCodexChineseMismatch: fn,
    buildPreferredAdapterRecoveryHint: fn, classifyError: fn, collectProviderSiblingModels: fn,
    createLinkedAbortController: fn, extractImageOcrTexts: fn, normalizeAbortReason: fn, normalizeModelForAdapter: fn,
    resolvePreferredModelForAdapter: fn, throwIfAborted: fn, tryRateLimitOcrRescue: fn,
  };
  assert.doesNotThrow(() => setAiGatewayGenerateMethodDeps(fake));
  assert.doesNotThrow(() => setAiGatewayGenerateMethodDeps(fake));
});
