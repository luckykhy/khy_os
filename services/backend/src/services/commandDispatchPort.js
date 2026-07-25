'use strict';

/**
 * commandDispatchPort.js — neutral port that breaks the keystone reverse edge
 * `services/toolCalling.js → cli/router.js` (DESIGN-ARCH-021, Batch 1).
 *
 * The legit dependency direction is `cli/router → services` (the router already
 * requires toolCalling, mcp, taskControlService, … one-way). The only reverse
 * edge was the `SlashCommand` tool handler in toolCalling requiring cli/router
 * back to parse + route a slash command line. That single edge anchored 42
 * nodes of the ~129-node giant SCC (measured via `archDebtScan --scc`).
 *
 * Inversion of control replaces it:
 *   - cli/router registers its { parseInput, route } dispatcher on module load.
 *   - toolCalling's SlashCommand handler reads it through getDispatcher().
 *   - If the CLI layer was never loaded (e.g. headless service / test), the
 *     handler degrades gracefully on a null dispatcher — no crash, no require.
 *
 * Zero dependencies — a true leaf, so it can never participate in a cycle.
 * Same範式 as sessionSourcePort.js (DESIGN-ARCH-020, P1).
 */

let _dispatcher = null;

/**
 * Register the command dispatcher. Called by cli/router at module load.
 * @param {{ parseInput: Function, route: Function }} dispatcher
 *   Object exposing parseInput(line) and route(parsed) — the router's public API.
 */
function registerDispatcher(dispatcher) {
  _dispatcher = dispatcher || null;
}

/**
 * @returns {{ parseInput: Function, route: Function }|null}
 *   The registered dispatcher, or null if the CLI router has not been loaded.
 */
function getDispatcher() {
  return _dispatcher;
}

/** @internal Reset registration for testing. */
function _resetForTest() {
  _dispatcher = null;
}

module.exports = { registerDispatcher, getDispatcher, _resetForTest };
