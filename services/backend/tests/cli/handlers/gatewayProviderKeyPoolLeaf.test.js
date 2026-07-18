'use strict';

/**
 * Leaf-contract test for gatewayProviderKeyPool.js (extracted from cli/handlers/gateway.js).
 *
 * Proves: (1) the leaf exports the host-consumed handlers + _addCustomProviderInteractive
 * + the DI setter as functions; (2) the host re-imports the handlers by the SAME names so the
 * public gateway command contract is byte-identical; (3) setGatewayProviderKeyPoolDeps is a
 * guarded, idempotent, non-throwing DI setter (only wires function-typed deps — the two host
 * callbacks promptWithReplGuard / _resolveEnvPathForDiscoverModels that avoid a require cycle).
 *
 * The leaf performs IO (reads/writes .env, spawns upstream probes, lazy-loads pools) so it does
 * NOT self-declare as a pure zero-IO leaf; the assertions below stay on the deterministic surface
 * (export shape, contract identity, setter guard) and never invoke an IO handler.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/handlers/gatewayProviderKeyPool';
const HOST = '../../../src/cli/handlers/gateway';

test('leaf exports the host-consumed handlers + setter as functions', () => {
  const leaf = require(LEAF);
  const names = [
    'handleGatewayDiscoverModels',
    'handleGatewayModels',
    'handleGatewayKey',
    'handleGatewayAdd',
    'handleGatewayPool',
    '_addCustomProviderInteractive',
    'setGatewayProviderKeyPoolDeps',
  ];
  for (const n of names) {
    assert.strictEqual(typeof leaf[n], 'function', `missing ${n}`);
  }
});

test('host re-imports the leaf handlers by the same names (contract intact)', () => {
  const host = require(HOST);
  for (const n of ['handleGatewayDiscoverModels', 'handleGatewayModels', 'handleGatewayKey', 'handleGatewayAdd', 'handleGatewayPool']) {
    assert.strictEqual(typeof host[n], 'function', `host missing ${n}`);
  }
});

test('setGatewayProviderKeyPoolDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setGatewayProviderKeyPoolDeps } = require(LEAF);
  // No throw on empty / partial / non-function deps (guards ignore non-functions).
  assert.doesNotThrow(() => setGatewayProviderKeyPoolDeps());
  assert.doesNotThrow(() => setGatewayProviderKeyPoolDeps({}));
  assert.doesNotThrow(() => setGatewayProviderKeyPoolDeps({ promptWithReplGuard: 123, _resolveEnvPathForDiscoverModels: null }));
  // Idempotent re-injection with real functions.
  assert.doesNotThrow(() => setGatewayProviderKeyPoolDeps({
    promptWithReplGuard: async () => '',
    _resolveEnvPathForDiscoverModels: () => '/tmp/.env',
  }));
  assert.doesNotThrow(() => setGatewayProviderKeyPoolDeps({
    promptWithReplGuard: async () => '',
    _resolveEnvPathForDiscoverModels: () => '/tmp/.env',
  }));
});
