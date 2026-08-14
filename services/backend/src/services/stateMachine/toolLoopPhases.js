'use strict';

/**
 * toolLoopPhases.js — tool-use loop phase state machine definition + factory.
 *
 * Shadow-observation FSM for the AI tool-calling loop. The transition table
 * is deliberately permissive: the real loop bounces send_to_ai ↔
 * execute_tools many times per turn, and recovery/error/verify paths all
 * feed back into send_to_ai. All loop back-edges are declared explicitly so
 * shadow observation does not spam illegal records.
 *
 * Phases:
 *   init → send_to_ai → parse_ai_output → execute_tools → process_results
 *        → transient_recovery | error_handling | verify_gate
 *        → final_response | interrupted (terminal)
 *
 * @module services/stateMachine/toolLoopPhases
 */

const { createFsm } = require('./fsm');

/** Tool loop phase names. */
const TOOL_LOOP_PHASES = Object.freeze({
  INIT: 'init',
  SEND_TO_AI: 'send_to_ai',
  PARSE_AI_OUTPUT: 'parse_ai_output',
  EXECUTE_TOOLS: 'execute_tools',
  PROCESS_RESULTS: 'process_results',
  TRANSIENT_RECOVERY: 'transient_recovery',
  ERROR_HANDLING: 'error_handling',
  VERIFY_GATE: 'verify_gate',
  FINAL_RESPONSE: 'final_response',
  INTERRUPTED: 'interrupted',
});

/** Tool loop event names. */
const TOOL_LOOP_EVENTS = Object.freeze({
  SEND: 'send', // → send_to_ai (initial send and every loop re-send)
  AI_REPLIED: 'ai_replied', // send_to_ai → parse_ai_output
  TOOLS_FOUND: 'tools_found', // parse_ai_output → execute_tools
  NO_TOOLS: 'no_tools', // parse_ai_output → verify_gate (text-only reply)
  TOOLS_DONE: 'tools_done', // execute_tools → process_results
  RETRY: 'retry', // → transient_recovery (transient failure)
  ERROR: 'error', // → error_handling
  VERIFY: 'verify', // process_results → verify_gate
  FINISH: 'finish', // → final_response (terminal)
  INTERRUPT: 'interrupt', // → interrupted (terminal, any active phase)
});

const P = TOOL_LOOP_PHASES;
const E = TOOL_LOOP_EVENTS;

/** Declarative transition table: { [from]: { [event]: to } } */
const TOOL_LOOP_TRANSITIONS = Object.freeze({
  [P.INIT]: {
    [E.SEND]: P.SEND_TO_AI,
    [E.FINISH]: P.FINAL_RESPONSE, // fast path: nothing to do
    [E.ERROR]: P.ERROR_HANDLING,
    [E.INTERRUPT]: P.INTERRUPTED,
  },
  [P.SEND_TO_AI]: {
    [E.AI_REPLIED]: P.PARSE_AI_OUTPUT,
    [E.RETRY]: P.TRANSIENT_RECOVERY, // transport hiccup, empty response...
    [E.ERROR]: P.ERROR_HANDLING,
    [E.FINISH]: P.FINAL_RESPONSE,
    [E.INTERRUPT]: P.INTERRUPTED,
  },
  [P.PARSE_AI_OUTPUT]: {
    [E.TOOLS_FOUND]: P.EXECUTE_TOOLS,
    [E.NO_TOOLS]: P.VERIFY_GATE, // text-only reply heads to the gate
    [E.RETRY]: P.TRANSIENT_RECOVERY, // malformed output → re-ask
    [E.ERROR]: P.ERROR_HANDLING,
    [E.FINISH]: P.FINAL_RESPONSE,
    [E.INTERRUPT]: P.INTERRUPTED,
  },
  [P.EXECUTE_TOOLS]: {
    [E.TOOLS_DONE]: P.PROCESS_RESULTS,
    [E.RETRY]: P.TRANSIENT_RECOVERY,
    [E.ERROR]: P.ERROR_HANDLING,
    [E.INTERRUPT]: P.INTERRUPTED,
  },
  [P.PROCESS_RESULTS]: {
    [E.SEND]: P.SEND_TO_AI, // main loop back-edge
    [E.VERIFY]: P.VERIFY_GATE,
    [E.RETRY]: P.TRANSIENT_RECOVERY,
    [E.ERROR]: P.ERROR_HANDLING,
    [E.FINISH]: P.FINAL_RESPONSE,
    [E.INTERRUPT]: P.INTERRUPTED,
  },
  [P.TRANSIENT_RECOVERY]: {
    [E.SEND]: P.SEND_TO_AI, // recovery back-edge
    [E.ERROR]: P.ERROR_HANDLING, // recovery exhausted
    [E.FINISH]: P.FINAL_RESPONSE,
    [E.INTERRUPT]: P.INTERRUPTED,
  },
  [P.ERROR_HANDLING]: {
    [E.SEND]: P.SEND_TO_AI, // handled error → keep looping
    [E.FINISH]: P.FINAL_RESPONSE, // unrecoverable → wrap up honestly
    [E.INTERRUPT]: P.INTERRUPTED,
  },
  [P.VERIFY_GATE]: {
    [E.SEND]: P.SEND_TO_AI, // gate redrive back-edge
    [E.FINISH]: P.FINAL_RESPONSE, // gate passed
    [E.ERROR]: P.ERROR_HANDLING,
    [E.INTERRUPT]: P.INTERRUPTED,
  },
  // final_response / interrupted are terminal: no outgoing edges.
});

/**
 * Create a tool-loop phase FSM instance.
 * @param {object} [opts]
 * @param {string} [opts.name='toolLoopPhases']
 * @param {number} [opts.historyLimit]
 * @returns {import('./fsm').FiniteStateMachine}
 */
function createToolLoopFsm(opts = {}) {
  return createFsm({
    name: opts.name || 'toolLoopPhases',
    states: Object.values(TOOL_LOOP_PHASES),
    transitions: TOOL_LOOP_TRANSITIONS,
    initial: P.INIT,
    historyLimit: opts.historyLimit,
  });
}

module.exports = {
  TOOL_LOOP_PHASES,
  TOOL_LOOP_EVENTS,
  TOOL_LOOP_TRANSITIONS,
  createToolLoopFsm,
};
