'use strict';

/**
 * Leaf-contract test for proxySwitchProfiles.js (extracted from cli/handlers/proxy.js).
 *
 * Proves: (1) the leaf exports the Windsurf-switch + Switch-Center handlers + the DI setter as
 * functions; (2) the host re-imports handleProxyWindsurfSwitch / handleProxySwitchCenter /
 * maybeAutoSyncSwitchCenter by the SAME names so the `proxy windsurf-switch` / `proxy switch-center`
 * command contracts stay byte-identical; (3) setProxySwitchProfilesDeps is a guarded, idempotent,
 * non-throwing DI setter that only wires the 17 function-typed host callbacks.
 *
 * The leaf performs IO (adapter sync, upstream/local proxy probes, .env-driven apply, terminal output)
 * so it does NOT self-declare as a pure zero-IO leaf; the assertions below stay on the deterministic
 * surface (export shape, contract identity, setter guard) and never invoke an IO handler.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/handlers/proxySwitchProfiles';
const HOST = '../../../src/cli/handlers/proxy';

const HANDLERS = ['handleProxyWindsurfSwitch', 'handleProxySwitchCenter', 'maybeAutoSyncSwitchCenter'];

test('leaf exports the switch-profile handlers + DI setter as functions', () => {
  const leaf = require(LEAF);
  for (const n of [...HANDLERS, 'setProxySwitchProfilesDeps']) {
    assert.strictEqual(typeof leaf[n], 'function', `missing ${n}`);
  }
});

test('host re-imports the handlers by the same names (command contract intact)', () => {
  const host = require(HOST);
  for (const n of HANDLERS) {
    assert.strictEqual(typeof host[n], 'function', `host missing ${n}`);
  }
});

test('setProxySwitchProfilesDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setProxySwitchProfilesDeps } = require(LEAF);
  assert.doesNotThrow(() => setProxySwitchProfilesDeps());
  assert.doesNotThrow(() => setProxySwitchProfilesDeps({}));
  // Non-function deps are ignored by the typeof guard.
  assert.doesNotThrow(() => setProxySwitchProfilesDeps({ parsePositiveInt: 1, handleProxyTraeSwitch: null }));
  const fakeDeps = {};
  for (const n of ['parsePositiveInt', 'dedupeList', 'normalizeModelId', 'normalizeEndpointBase',
    'normalizeTraeProfileId', 'createTraeProfileId', 'parseModelMap', 'loadTraeSwitchStore',
    'loadWindsurfSwitchStore', 'saveWindsurfSwitchStore', 'resolveWindsurfProfile',
    'buildSwitchProfileSignature', 'applyTraeSwitchProfile', 'testTraeUpstream', 'testTraeLocalProxy',
    'syncTraeSwitchProfileFromAdapter', 'handleProxyTraeSwitch']) {
    fakeDeps[n] = () => undefined;
  }
  assert.doesNotThrow(() => setProxySwitchProfilesDeps(fakeDeps));
  assert.doesNotThrow(() => setProxySwitchProfilesDeps(fakeDeps));
});
