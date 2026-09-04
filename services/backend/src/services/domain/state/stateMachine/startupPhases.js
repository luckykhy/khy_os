'use strict';

/**
 * startupPhases.js — startup phase state machine definition + factory.
 *
 * Phases (linear progression):
 *   parse_args → env_check → modules_load → service_discover
 *              → repl_init → running → shutdown
 *
 * Notes:
 *   - forward jumps are legal: different launch paths (one-shot command,
 *     `khy chat`, server mode...) may skip intermediate phases, so the
 *     `advance` event from each phase targets its natural successor while
 *     dedicated skip events jump further ahead;
 *   - any state can go to shutdown (fatal error, Ctrl-C, normal exit).
 *
 * @module services/stateMachine/startupPhases
 */

const { createFsm } = require('./fsm');

/** Startup phase names. */
const STARTUP_PHASES = Object.freeze({
  PARSE_ARGS: 'parse_args',
  ENV_CHECK: 'env_check',
  MODULES_LOAD: 'modules_load',
  SERVICE_DISCOVER: 'service_discover',
  REPL_INIT: 'repl_init',
  RUNNING: 'running',
  SHUTDOWN: 'shutdown',
});

/** Startup event names. */
const STARTUP_EVENTS = Object.freeze({
  ADVANCE: 'advance', // step to the next linear phase
  SKIP_TO_MODULES: 'skip_to_modules', // jump forward to modules_load
  SKIP_TO_DISCOVER: 'skip_to_discover', // jump forward to service_discover
  SKIP_TO_REPL: 'skip_to_repl', // jump forward to repl_init
  SKIP_TO_RUNNING: 'skip_to_running', // jump forward to running
  SHUTDOWN: 'shutdown', // any state → shutdown
});

const P = STARTUP_PHASES;
const E = STARTUP_EVENTS;

/** Declarative transition table: { [from]: { [event]: to } } */
const STARTUP_TRANSITIONS = Object.freeze({
  [P.PARSE_ARGS]: {
    [E.ADVANCE]: P.ENV_CHECK,
    [E.SKIP_TO_MODULES]: P.MODULES_LOAD,
    [E.SKIP_TO_DISCOVER]: P.SERVICE_DISCOVER,
    [E.SKIP_TO_REPL]: P.REPL_INIT,
    [E.SKIP_TO_RUNNING]: P.RUNNING,
    [E.SHUTDOWN]: P.SHUTDOWN,
  },
  [P.ENV_CHECK]: {
    [E.ADVANCE]: P.MODULES_LOAD,
    [E.SKIP_TO_DISCOVER]: P.SERVICE_DISCOVER,
    [E.SKIP_TO_REPL]: P.REPL_INIT,
    [E.SKIP_TO_RUNNING]: P.RUNNING,
    [E.SHUTDOWN]: P.SHUTDOWN,
  },
  [P.MODULES_LOAD]: {
    [E.ADVANCE]: P.SERVICE_DISCOVER,
    [E.SKIP_TO_REPL]: P.REPL_INIT,
    [E.SKIP_TO_RUNNING]: P.RUNNING,
    [E.SHUTDOWN]: P.SHUTDOWN,
  },
  [P.SERVICE_DISCOVER]: {
    [E.ADVANCE]: P.REPL_INIT,
    [E.SKIP_TO_RUNNING]: P.RUNNING,
    [E.SHUTDOWN]: P.SHUTDOWN,
  },
  [P.REPL_INIT]: {
    [E.ADVANCE]: P.RUNNING,
    [E.SHUTDOWN]: P.SHUTDOWN,
  },
  [P.RUNNING]: {
    [E.SHUTDOWN]: P.SHUTDOWN,
  },
  // shutdown is terminal: no outgoing edges.
});

/**
 * Create a startup phase FSM instance.
 * @param {object} [opts]
 * @param {string} [opts.name='startupPhases']
 * @param {number} [opts.historyLimit]
 * @returns {import('./fsm').FiniteStateMachine}
 */
function createStartupFsm(opts = {}) {
  return createFsm({
    name: opts.name || 'startupPhases',
    states: Object.values(STARTUP_PHASES),
    transitions: STARTUP_TRANSITIONS,
    initial: P.PARSE_ARGS,
    historyLimit: opts.historyLimit,
  });
}

module.exports = {
  STARTUP_PHASES,
  STARTUP_EVENTS,
  STARTUP_TRANSITIONS,
  createStartupFsm,
};
