'use strict';
/**
 * Leaf-contract test for routerDispatchSlash.js (extracted from cli/router.js).
 *
 * Proves: (1) the leaf exports dispatchSlashCommand + the DI setter + the ROUTER_NOT_HANDLED sentinel;
 * (2) the host (router.js) still exposes its public surface (parseInput / route / getCompletions) so
 * the extraction kept the module contract intact; (3) dispatchSlashCommand returns the
 * ROUTER_NOT_HANDLED sentinel for any command outside the slash cluster (so route() falls through to
 * its main switch), without touching any host callback; (4) setRouterDispatchSlashDeps is a guarded,
 * idempotent, non-throwing DI setter that only wires the injected `route` callback.
 *
 * The leaf runs command handlers that perform IO, so it does NOT self-declare as a pure zero-IO leaf;
 * the assertions below stay on the deterministic surface (export shape, sentinel fall-through, setter
 * guard) and never dispatch an actual slash command.
 */
const LEAF = '../../../src/cli/routerDispatchSlash';
const HOST = '../../../src/cli/router';

describe('Router Dispatch Slash Leaf', () => {
  test('leaf exports dispatchSlashCommand + setter + sentinel', async () => {
      const leaf = require(LEAF);
      expect(typeof leaf.dispatchSlashCommand).toBe('function');
      expect(typeof leaf.setRouterDispatchSlashDeps).toBe('function');
      expect(typeof leaf.ROUTER_NOT_HANDLED).toBe('symbol');
  });

  test('host router keeps its public contract after extraction', async () => {
      const host = require(HOST);
      expect(typeof host.parseInput).toBe('function');
      expect(typeof host.route).toBe('function');
      expect(typeof host.getCompletions).toBe('function');
  });

  test('dispatchSlashCommand returns the sentinel for non-slash commands (fall-through)', async () => {
      const { dispatchSlashCommand, ROUTER_NOT_HANDLED } = require(LEAF);
      const r = await dispatchSlashCommand('definitely-not-a-slash-command', {
        subCommand: undefined, args: [], options: {}, rawCommandToken: '', parsed: {}, context: {},
        printError() {}, printHelp() {}, printInfo() {}, printTable() {}, printSuccess() {},
        printWarn() {}, withSpinner() {}, chalk: {},
      });
      expect(r).toBe(ROUTER_NOT_HANDLED);
  });

  test('setRouterDispatchSlashDeps is a guarded, idempotent, non-throwing DI setter', async () => {
      const { setRouterDispatchSlashDeps } = require(LEAF);
      expect(() => setRouterDispatchSlashDeps().not.toThrow());
      expect(() => setRouterDispatchSlashDeps({}).not.toThrow());
      expect(() => setRouterDispatchSlashDeps({ route: 1 }).not.toThrow());
      const fake = { route: () => {} };
      expect(() => setRouterDispatchSlashDeps(fake).not.toThrow());
      expect(() => setRouterDispatchSlashDeps(fake).not.toThrow());
  });

});

