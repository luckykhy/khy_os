'use strict';

/**
 * agentLifecycle.js — agent lifecycle state machine definition + factory.
 *
 * States and transitions mirror the ProcessAgentState JSDoc in
 * coordinator/processAgent.js (L26-36):
 *   created → initializing → ready → running → completed | error | killed
 *
 * Observed real-world transitions in processAgent.js:
 *   - depth-guard fails directly from 'created' (run() throws before spawn)
 *   - child 'exit'/'error' handlers fail from 'initializing'/'running'
 *   - kill() can land from any non-terminal state
 * Therefore `fail` and `kill` are legal from every non-terminal state.
 *
 * @module services/stateMachine/agentLifecycle
 */

const { createFsm } = require('./fsm');

/** Agent lifecycle state names (mirrors ProcessAgentState.status). */
const AGENT_STATES = Object.freeze({
  CREATED: 'created',
  INITIALIZING: 'initializing',
  READY: 'ready',
  RUNNING: 'running',
  COMPLETED: 'completed',
  ERROR: 'error',
  KILLED: 'killed',
});

/** Agent lifecycle event names. */
const AGENT_EVENTS = Object.freeze({
  SPAWN_START: 'spawn_start', // created → initializing
  INIT_OK: 'init_ok', // initializing → ready
  TASK_START: 'task_start', // ready → running
  TASK_DONE: 'task_done', // running → completed
  FAIL: 'fail', // any non-terminal → error
  KILL: 'kill', // any non-terminal → killed
});

const S = AGENT_STATES;
const E = AGENT_EVENTS;

/** Declarative transition table: { [from]: { [event]: to } } */
const AGENT_TRANSITIONS = Object.freeze({
  [S.CREATED]: {
    [E.SPAWN_START]: S.INITIALIZING,
    [E.FAIL]: S.ERROR, // depth-guard rejects before spawn
    [E.KILL]: S.KILLED,
  },
  [S.INITIALIZING]: {
    [E.INIT_OK]: S.READY,
    [E.FAIL]: S.ERROR, // child exit/error during init
    [E.KILL]: S.KILLED,
  },
  [S.READY]: {
    [E.TASK_START]: S.RUNNING,
    [E.FAIL]: S.ERROR,
    [E.KILL]: S.KILLED,
  },
  [S.RUNNING]: {
    [E.TASK_DONE]: S.COMPLETED,
    [E.FAIL]: S.ERROR, // RESULT-path ERROR / unexpected child exit
    [E.KILL]: S.KILLED,
  },
  // completed / error / killed are terminal: no outgoing edges.
});

/**
 * Create an agent-lifecycle FSM instance.
 * @param {object} [opts]
 * @param {string} [opts.name='agentLifecycle'] - instance name (e.g. per agent id)
 * @param {number} [opts.historyLimit]
 * @returns {import('./fsm').FiniteStateMachine}
 */
function createAgentLifecycleFsm(opts = {}) {
  return createFsm({
    name: opts.name || 'agentLifecycle',
    states: Object.values(AGENT_STATES),
    transitions: AGENT_TRANSITIONS,
    initial: S.CREATED,
    historyLimit: opts.historyLimit,
  });
}

module.exports = {
  AGENT_STATES,
  AGENT_EVENTS,
  AGENT_TRANSITIONS,
  createAgentLifecycleFsm,
};
