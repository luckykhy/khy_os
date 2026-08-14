'use strict';

/**
 * replPhases.js — REPL phase state machine definition + factory.
 *
 * Phases:
 *   startup → ready → input_active → ai_responding → streaming
 *           → tool_execution → interrupted → ready
 *
 * Notes:
 *   - streaming ↔ tool_execution can bounce both ways within one turn
 *   - any busy phase can be interrupted; interrupted returns to ready
 *   - ai_responding / streaming / tool_execution each have a completion
 *     back-edge to ready
 *   - a `reset` event returns to ready from ANY state — the
 *     unhandledRejection safety net uses it to recover the prompt.
 *
 * @module services/stateMachine/replPhases
 */

const { createFsm } = require('./fsm');

/** REPL phase names. */
const REPL_PHASES = Object.freeze({
  STARTUP: 'startup',
  READY: 'ready',
  INPUT_ACTIVE: 'input_active',
  AI_RESPONDING: 'ai_responding',
  STREAMING: 'streaming',
  TOOL_EXECUTION: 'tool_execution',
  INTERRUPTED: 'interrupted',
});

/** REPL event names. */
const REPL_EVENTS = Object.freeze({
  BOOT_DONE: 'boot_done', // startup → ready
  INPUT_START: 'input_start', // ready → input_active
  SUBMIT: 'submit', // input_active → ai_responding
  CANCEL_INPUT: 'cancel_input', // input_active → ready (empty line / Esc)
  STREAM_START: 'stream_start', // ai_responding → streaming
  TOOL_START: 'tool_start', // ai_responding|streaming → tool_execution
  STREAM_RESUME: 'stream_resume', // tool_execution → streaming
  DONE: 'done', // ai_responding|streaming|tool_execution → ready
  INTERRUPT: 'interrupt', // any busy phase → interrupted
  RESUME: 'resume', // interrupted → ready
  RESET: 'reset', // ANY state → ready (unhandledRejection net)
});

const P = REPL_PHASES;
const E = REPL_EVENTS;

/** Declarative transition table: { [from]: { [event]: to } } */
const REPL_TRANSITIONS = Object.freeze({
  [P.STARTUP]: {
    [E.BOOT_DONE]: P.READY,
    [E.RESET]: P.READY,
  },
  [P.READY]: {
    [E.INPUT_START]: P.INPUT_ACTIVE,
    [E.RESET]: P.READY,
  },
  [P.INPUT_ACTIVE]: {
    [E.SUBMIT]: P.AI_RESPONDING,
    [E.CANCEL_INPUT]: P.READY,
    [E.INTERRUPT]: P.INTERRUPTED,
    [E.RESET]: P.READY,
  },
  [P.AI_RESPONDING]: {
    [E.STREAM_START]: P.STREAMING,
    [E.TOOL_START]: P.TOOL_EXECUTION,
    [E.DONE]: P.READY, // completion back-edge
    [E.INTERRUPT]: P.INTERRUPTED,
    [E.RESET]: P.READY,
  },
  [P.STREAMING]: {
    [E.TOOL_START]: P.TOOL_EXECUTION, // streaming → tool_execution
    [E.DONE]: P.READY, // completion back-edge
    [E.INTERRUPT]: P.INTERRUPTED,
    [E.RESET]: P.READY,
  },
  [P.TOOL_EXECUTION]: {
    [E.STREAM_RESUME]: P.STREAMING, // tool_execution → streaming
    [E.DONE]: P.READY, // completion back-edge
    [E.INTERRUPT]: P.INTERRUPTED,
    [E.RESET]: P.READY,
  },
  [P.INTERRUPTED]: {
    [E.RESUME]: P.READY, // interrupted returns to ready
    [E.RESET]: P.READY,
  },
});

/**
 * Create a REPL phase FSM instance.
 * @param {object} [opts]
 * @param {string} [opts.name='replPhases']
 * @param {number} [opts.historyLimit]
 * @returns {import('./fsm').FiniteStateMachine}
 */
function createReplFsm(opts = {}) {
  return createFsm({
    name: opts.name || 'replPhases',
    states: Object.values(REPL_PHASES),
    transitions: REPL_TRANSITIONS,
    initial: P.STARTUP,
    historyLimit: opts.historyLimit,
  });
}

module.exports = {
  REPL_PHASES,
  REPL_EVENTS,
  REPL_TRANSITIONS,
  createReplFsm,
};
