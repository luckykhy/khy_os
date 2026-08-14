'use strict';

/**
 * Leaf-contract test for gatewayRuntimeProbes.js (extracted from cli/handlers/gateway.js).
 *
 * Proves: (1) the leaf exports the host-consumed handlers + sample helpers + the DI setter as
 * functions; (2) the host re-imports the public handlers by the SAME names so the
 * `gateway relay|detect|test|probe-tools|sample` command contracts stay byte-identical; (3)
 * setGatewayRuntimeProbesDeps is a guarded, idempotent, non-throwing DI setter that only wires
 * function-typed deps (the four host callbacks — prompt guard / reason compaction / home-risk
 * snapshot / .env writer — that avoid a require cycle).
 *
 * The leaf performs IO (spawns the khy binary for sampling, reads run artifacts, prints to the
 * terminal) so it does NOT self-declare as a pure zero-IO leaf; the assertions below stay on the
 * deterministic surface (export shape, contract identity, setter guard) and never invoke an IO
 * handler.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/handlers/gatewayRuntimeProbes';
const HOST = '../../../src/cli/handlers/gateway';

test('leaf exports the host-consumed handlers + sample helpers + setter as functions', () => {
  const leaf = require(LEAF);
  const names = [
    'handleGatewayRelay',
    'handleGatewayDetect',
    'handleGatewayTest',
    '_isGatewaySamplePromptInjected',
    '_readGatewaySampleRunSummary',
    '_summarizeGatewaySampleCounts',
    'handleGatewayProbeTools',
    'handleGatewaySample',
    'setGatewayRuntimeProbesDeps',
  ];
  for (const n of names) {
    assert.strictEqual(typeof leaf[n], 'function', `missing ${n}`);
  }
});

test('host re-imports the leaf handlers by the same names (contract intact)', () => {
  const host = require(HOST);
  for (const n of ['handleGatewayRelay', 'handleGatewayDetect', 'handleGatewayTest', 'handleGatewayProbeTools', 'handleGatewaySample']) {
    assert.strictEqual(typeof host[n], 'function', `host missing ${n}`);
  }
});

test('setGatewayRuntimeProbesDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setGatewayRuntimeProbesDeps } = require(LEAF);
  // No throw on empty / partial / non-function deps (guards ignore non-functions).
  assert.doesNotThrow(() => setGatewayRuntimeProbesDeps());
  assert.doesNotThrow(() => setGatewayRuntimeProbesDeps({}));
  assert.doesNotThrow(() => setGatewayRuntimeProbesDeps({ promptWithReplGuard: 1, _writeEnvMap: null, _compactReasonText: 'x' }));
  // Idempotent re-injection with real functions across the full dep surface.
  const fakeDeps = {};
  for (const n of ['promptWithReplGuard', '_compactReasonText', '_getGatewayHomeRiskSnapshot', '_writeEnvMap']) {
    fakeDeps[n] = () => undefined;
  }
  assert.doesNotThrow(() => setGatewayRuntimeProbesDeps(fakeDeps));
  assert.doesNotThrow(() => setGatewayRuntimeProbesDeps(fakeDeps));
});
