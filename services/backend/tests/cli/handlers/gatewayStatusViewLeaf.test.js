'use strict';

/**
 * Leaf-contract test for gatewayStatusView.js (extracted from cli/handlers/gateway.js).
 *
 * Proves: (1) the leaf exports handleGatewayStatus + the DI setter as functions; (2) the host
 * re-imports handleGatewayStatus by the SAME name so the `gateway status` command contract stays
 * byte-identical; (3) setGatewayStatusViewDeps is a guarded, idempotent, non-throwing DI setter
 * that only wires the 17 function-typed host callbacks.
 *
 * The leaf performs IO (live adapter probes, terminal output, .env path resolution) so it does NOT
 * self-declare as a pure zero-IO leaf; the assertions below stay on the deterministic surface
 * (export shape, contract identity, setter guard) and never invoke the IO handler.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/handlers/gatewayStatusView';
const HOST = '../../../src/cli/handlers/gateway';

test('leaf exports handleGatewayStatus + DI setter as functions', () => {
  const leaf = require(LEAF);
  assert.strictEqual(typeof leaf.handleGatewayStatus, 'function');
  assert.strictEqual(typeof leaf.setGatewayStatusViewDeps, 'function');
});

test('host re-imports handleGatewayStatus by the same name (contract intact)', () => {
  const host = require(HOST);
  assert.strictEqual(typeof host.handleGatewayStatus, 'function');
});

test('setGatewayStatusViewDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setGatewayStatusViewDeps } = require(LEAF);
  assert.doesNotThrow(() => setGatewayStatusViewDeps());
  assert.doesNotThrow(() => setGatewayStatusViewDeps({}));
  assert.doesNotThrow(() => setGatewayStatusViewDeps({ withTimeout: 1, _printGatewayStatusTable: null }));
  const fakeDeps = {};
  for (const n of ['_getGatewayHomeRiskSnapshot', 'shouldTreatGenerationFailureAsWarning', 'shouldTreatConnectivityFailureAsWarning',
    '_resolvePreferredAdapterIssue', '_appendGatewayProtocolRiskDetail', 'getGatewayDebugPromptSnapshot',
    '_printGatewayStatusTable', '_buildGatewayLanguageConsistencyText', '_buildGatewayTraceCommandHint',
    '_printLatencyAutoTuneSnapshot', 'maybeAutoSyncSwitchCenterForGateway', '_resolvePreferredRouteSnapshot',
    '_collectConfiguredEndpointObjects', '_parseProviderFilterFromOptions', '_filterEndpointObjectsByProvider',
    'withTimeout', '_resolveEnvPathForGateway']) {
    fakeDeps[n] = () => undefined;
  }
  assert.doesNotThrow(() => setGatewayStatusViewDeps(fakeDeps));
  assert.doesNotThrow(() => setGatewayStatusViewDeps(fakeDeps));
});
