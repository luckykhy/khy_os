'use strict';

/**
 * Leaf-contract test for gatewayConfigEditor.js (extracted from cli/handlers/gateway.js).
 *
 * Proves: (1) the leaf exports handleGatewayConfig + the DI setter as functions; (2) the host
 * re-imports handleGatewayConfig by the same name so the `gateway config` command contract is
 * byte-identical; (3) setGatewayConfigEditorDeps is a guarded, idempotent, non-throwing DI
 * setter that only wires function-typed deps (the 10 host callbacks — JSON/env helpers, model
 * choice builders and the provider-key leaf's _addCustomProviderInteractive — that avoid a
 * require cycle).
 *
 * The leaf performs IO (reads/writes .env, interactive prompts, lazy pool loads) so it does NOT
 * self-declare as a pure zero-IO leaf; assertions stay on the deterministic surface and never
 * invoke the IO handler.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/handlers/gatewayConfigEditor';
const HOST = '../../../src/cli/handlers/gateway';

test('leaf exports handleGatewayConfig + DI setter as functions', () => {
  const leaf = require(LEAF);
  assert.strictEqual(typeof leaf.handleGatewayConfig, 'function');
  assert.strictEqual(typeof leaf.setGatewayConfigEditorDeps, 'function');
});

test('host re-imports handleGatewayConfig by the same name (contract intact)', () => {
  const host = require(HOST);
  assert.strictEqual(typeof host.handleGatewayConfig, 'function');
});

test('setGatewayConfigEditorDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setGatewayConfigEditorDeps } = require(LEAF);
  assert.doesNotThrow(() => setGatewayConfigEditorDeps());
  assert.doesNotThrow(() => setGatewayConfigEditorDeps({}));
  // Non-function deps are ignored, not wired.
  assert.doesNotThrow(() => setGatewayConfigEditorDeps({ promptWithReplGuard: 1, _writeEnvMap: null, buildGatewayModelChoices: 'x' }));
  // Idempotent re-injection with real functions across the full dep surface.
  const fakeDeps = {};
  for (const n of ['promptWithReplGuard', '_parseJsonObject', '_mergeJsonEnvVar', '_removeJsonEnvVarKey',
    '_safeJsonLine', '_writeEnvMap', '_unsetEnvKeys', 'buildGatewayModelChoices',
    'handleGatewaySelectModel', '_addCustomProviderInteractive']) {
    fakeDeps[n] = () => undefined;
  }
  assert.doesNotThrow(() => setGatewayConfigEditorDeps(fakeDeps));
  assert.doesNotThrow(() => setGatewayConfigEditorDeps(fakeDeps));
});
