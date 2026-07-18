'use strict';

/**
 * Leaf-contract test for routerDispatchTail.js (extracted from cli/router.js).
 *
 * Proves: (1) the leaf exports dispatchTailCommand + the DI setter + the ROUTER_NOT_HANDLED sentinel;
 * (2) the host (router.js) still exposes its public surface (parseInput / route / getCompletions) so
 * the extraction kept the module contract intact; (3) dispatchTailCommand returns the
 * ROUTER_NOT_HANDLED sentinel for any command outside the tail cluster (so route() falls through to
 * its main switch), without touching any host callback; (4) setRouterDispatchTailDeps is a guarded,
 * idempotent, non-throwing DI setter that only wires the injected `chk` (lazy chalk loader) callback.
 *
 * The leaf runs command handlers that perform IO, so it does NOT self-declare as a pure zero-IO leaf;
 * the assertions below stay on the deterministic surface (export shape, sentinel fall-through, setter
 * guard) and never dispatch an actual tail command.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/routerDispatchTail';
const HOST = '../../../src/cli/router';

test('leaf exports dispatchTailCommand + setter + sentinel', () => {
  const leaf = require(LEAF);
  assert.strictEqual(typeof leaf.dispatchTailCommand, 'function');
  assert.strictEqual(typeof leaf.setRouterDispatchTailDeps, 'function');
  assert.strictEqual(typeof leaf.ROUTER_NOT_HANDLED, 'symbol');
});

test('host router keeps its public contract after extraction', () => {
  const host = require(HOST);
  assert.strictEqual(typeof host.parseInput, 'function');
  assert.strictEqual(typeof host.route, 'function');
  assert.strictEqual(typeof host.getCompletions, 'function');
});

test('dispatchTailCommand returns the sentinel for non-tail commands (fall-through)', async () => {
  const { dispatchTailCommand, ROUTER_NOT_HANDLED } = require(LEAF);
  const r = await dispatchTailCommand('definitely-not-a-tail-command', {
    subCommand: undefined, args: [], options: {}, rawCommandToken: '', parsed: {}, context: {},
    printError() {}, printHelp() {}, printInfo() {}, printTable() {}, printSuccess() {},
    printWarn() {}, withSpinner() {}, chalk: {},
  });
  assert.strictEqual(r, ROUTER_NOT_HANDLED);
});

test('setRouterDispatchTailDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setRouterDispatchTailDeps } = require(LEAF);
  assert.doesNotThrow(() => setRouterDispatchTailDeps());
  assert.doesNotThrow(() => setRouterDispatchTailDeps({}));
  assert.doesNotThrow(() => setRouterDispatchTailDeps({ chk: 1 }));
  const fake = { chk: () => ({}) };
  assert.doesNotThrow(() => setRouterDispatchTailDeps(fake));
  assert.doesNotThrow(() => setRouterDispatchTailDeps(fake));
});
