'use strict';

/**
 * Leaf-contract test for aiRequestAnalysis.js (extracted from cli/ai.js).
 *
 * Proves: (1) the leaf exports its context-budget + vision-routing entry points and the DI setter as
 * functions; (2) the host (cli/ai.js) still exposes its public surface (chat / getConversationStats /
 * checkModelCapability) so the extraction kept the module contract intact; (3) setAiRequestAnalysisDeps
 * is a guarded, idempotent, non-throwing DI setter that only wires the injected read-only tables +
 * host accessors; (4) a deterministic no-dep path (_resolveModelContextLimit('') → 128000 default)
 * stays byte-behaviour-identical after relocation.
 *
 * The leaf reads capability tables + gateway accessors that touch IO indirectly, so it does NOT
 * self-declare as a pure zero-IO leaf; the assertions stay on the deterministic surface (export shape,
 * contract identity, setter guard, the empty-hint default) and never drive a live gateway request.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/aiRequestAnalysis';
const HOST = '../../../src/cli/ai';

const ENTRY_POINTS = [
  '_resolveModelContextLimit', '_guessModelHint', '_estimateContextTokens', '_resolveContextBudget',
  '_supportsImageOnAdapter', '_resolveMultimodalAdapterCaps', '_supportsMediaKindsOnAdapter',
  '_isImageActionTask', '_pickMultimodalAdapter', '_pickVisionAdapter', '_applyVisionRouting',
];

test('leaf exports the request-analysis entry points + DI setter as functions', () => {
  const leaf = require(LEAF);
  for (const n of [...ENTRY_POINTS, 'setAiRequestAnalysisDeps']) {
    assert.strictEqual(typeof leaf[n], 'function', `missing ${n}`);
  }
});

test('host cli/ai keeps its public contract after extraction', () => {
  const host = require(HOST);
  assert.strictEqual(typeof host.chat, 'function');
  assert.strictEqual(typeof host.getConversationStats, 'function');
  assert.strictEqual(typeof host.checkModelCapability, 'function');
});

test('_resolveModelContextLimit returns the 128000 default for an empty model hint (no deps needed)', () => {
  const { _resolveModelContextLimit } = require(LEAF);
  assert.strictEqual(_resolveModelContextLimit(''), 128000);
  assert.strictEqual(_resolveModelContextLimit(null), 128000);
  assert.strictEqual(_resolveModelContextLimit(undefined), 128000);
});

test('setAiRequestAnalysisDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setAiRequestAnalysisDeps } = require(LEAF);
  assert.doesNotThrow(() => setAiRequestAnalysisDeps());
  assert.doesNotThrow(() => setAiRequestAnalysisDeps({}));
  // Non-function / falsy deps are ignored by the typeof / truthy guards.
  assert.doesNotThrow(() => setAiRequestAnalysisDeps({ _resolveTaskScale: 1, getGateway: null, EFFORT_PRESETS: 0 }));
  const fake = {
    EFFORT_PRESETS: {}, MODEL_CAPABILITIES: {},
    _resolveTaskScale: () => ({}), getGateway: () => ({}),
  };
  assert.doesNotThrow(() => setAiRequestAnalysisDeps(fake));
  assert.doesNotThrow(() => setAiRequestAnalysisDeps(fake));
});
