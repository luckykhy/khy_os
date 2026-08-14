'use strict';

/**
 * Leaf-contract test for routerDispatchOps.js (extracted from cli/router.js).
 *
 * Proves: (1) the leaf exports dispatchOpsCommand + the DI setter + the ROUTER_NOT_HANDLED sentinel;
 * (2) the host (router.js) still exposes its public surface (parseInput / route / getCompletions) so the
 * extraction kept the module contract intact; (3) dispatchOpsCommand returns the ROUTER_NOT_HANDLED
 * sentinel for any command outside the ops cluster (so route() falls through to its main switch),
 * without touching any host callback; (4) setRouterDispatchOpsDeps is a guarded, idempotent,
 * non-throwing DI setter.
 *
 * The leaf runs command handlers that perform IO, so it does NOT self-declare as a pure zero-IO leaf;
 * the assertions below stay on the deterministic surface (export shape, sentinel fall-through, setter
 * guard) and never dispatch an actual ops command.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/routerDispatchOps';
const HOST = '../../../src/cli/router';

test('leaf exports dispatchOpsCommand + setter + sentinel', () => {
  const leaf = require(LEAF);
  assert.strictEqual(typeof leaf.dispatchOpsCommand, 'function');
  assert.strictEqual(typeof leaf.setRouterDispatchOpsDeps, 'function');
  assert.strictEqual(typeof leaf.ROUTER_NOT_HANDLED, 'symbol');
});

test('host router keeps its public contract after extraction', () => {
  const host = require(HOST);
  assert.strictEqual(typeof host.parseInput, 'function');
  assert.strictEqual(typeof host.route, 'function');
  assert.strictEqual(typeof host.getCompletions, 'function');
});

test('dispatchOpsCommand returns the sentinel for non-ops commands (fall-through)', async () => {
  const { dispatchOpsCommand, ROUTER_NOT_HANDLED } = require(LEAF);
  // A command that is NOT in the ops cluster must fall through untouched.
  const r = await dispatchOpsCommand('definitely-not-an-ops-command', {
    subCommand: undefined, args: [], options: {}, rawCommandToken: '', parsed: {}, context: {},
    printError() {}, printHelp() {}, printInfo() {}, printTable() {}, printSuccess() {},
    printWarn() {}, withSpinner() {}, chalk: {},
  });
  assert.strictEqual(r, ROUTER_NOT_HANDLED);
});

test('setRouterDispatchOpsDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setRouterDispatchOpsDeps } = require(LEAF);
  assert.doesNotThrow(() => setRouterDispatchOpsDeps());
  assert.doesNotThrow(() => setRouterDispatchOpsDeps({}));
  assert.doesNotThrow(() => setRouterDispatchOpsDeps({ handleLogCommand: 1, _ccFileSize: null }));
  const fake = { handleLogCommand: () => {}, _handleResumeFlow: () => {}, _ccFileSize: () => {} };
  assert.doesNotThrow(() => setRouterDispatchOpsDeps(fake));
  assert.doesNotThrow(() => setRouterDispatchOpsDeps(fake));
});
