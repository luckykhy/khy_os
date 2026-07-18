'use strict';

/**
 * sessionSourcePort.js — neutral port that breaks the
 * `sessionPersistence.js ⇄ sessionSearchIndex.js` require cycle
 * (DESIGN-ARCH-020, R3).
 *
 * Direction of the legit dependency is one-way: sessionPersistence (the primary
 * JSON store) write-throughs into sessionSearchIndex. The only reverse edge was
 * sessionSearchIndex.reindexAll() requiring persistence back to enumerate all
 * sessions for a bulk rebuild. That reverse require is replaced by this port:
 *
 *   - sessionPersistence registers itself as the bulk session source on load.
 *   - sessionSearchIndex.reindexAll reads the source through getSessionSource().
 *
 * Zero dependencies — a true leaf, so it can never participate in a cycle.
 * Inversion of control: the consumer depends on an abstraction, not the module.
 */

let _source = null;

/**
 * Register the bulk session source (object exposing listPersistedSessions +
 * restoreSession). Called by sessionPersistence at module load.
 * @param {{ listPersistedSessions: Function, restoreSession: Function }} source
 */
function registerSessionSource(source) {
  _source = source || null;
}

/**
 * @returns {{ listPersistedSessions: Function, restoreSession: Function }|null}
 *   The registered source, or null if persistence has not been loaded yet.
 */
function getSessionSource() {
  return _source;
}

/** @internal Reset registration for testing. */
function _resetForTest() {
  _source = null;
}

module.exports = { registerSessionSource, getSessionSource, _resetForTest };
