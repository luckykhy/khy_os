'use strict';

/**
 * toolLoopPhases shadow-FSM contract test.
 *
 * The tool loop (toolUseLoopCore) drives a shadow FSM whose fire() NEVER
 * throws on an illegal transition — it keeps state and records
 * `{ illegal: true }`, visible only via /state or KHY_STATE_DEBUG. That
 * fail-soft design is deliberate, but it means an under-declared transition
 * table silently swamps the observation with false illegals and the loop's
 * phase invariant is never checked at the moment it breaks.
 *
 * This test is the machine-checked half of that contract: it replays the
 * canonical event sequences the real loop emits and asserts ZERO illegal
 * records. If a future gate introduces a new event, or the #7 phase-split
 * changes fire ordering, this fails at the site rather than in post-hoc
 * /state diagnosis.
 *
 * Event sequences below mirror the actual fire() call sites in
 * toolUseLoopCore.js (send → ai_replied → [tools_found → tools_done] →
 * no_tools → finish, plus the verification-gate re-drive that fires
 * `verify` while still in parse_ai_output and `continue`s before no_tools).
 */

const {
  createToolLoopFsm,
  TOOL_LOOP_EVENTS,
} = require('../../../../../../src/services/domain/state/stateMachine/toolLoopPhases');

// Fire a scripted event sequence through a fresh FSM and return the illegal records.
function illegalFor(events) {
  const fsm = createToolLoopFsm({ name: 'contract' });
  for (const e of events) fsm.fire(e);
  return fsm.getHistory().filter((h) => h.illegal);
}

const E = TOOL_LOOP_EVENTS;

describe('toolLoopPhases shadow FSM — canonical loop paths record no illegal transitions', () => {
  test('text-only turn: send → ai_replied → no_tools → finish', () => {
    expect(illegalFor([E.SEND, E.AI_REPLIED, E.NO_TOOLS, E.FINISH])).toHaveLength(0);
  });

  test('one tool round then conclude', () => {
    expect(
      illegalFor([
        E.SEND, E.AI_REPLIED, E.TOOLS_FOUND, E.TOOLS_DONE,
        E.SEND, E.AI_REPLIED, E.NO_TOOLS, E.FINISH,
      ])
    ).toHaveLength(0);
  });

  test('hard verification-gate re-drive after edits (fires verify from parse_ai_output)', () => {
    expect(
      illegalFor([
        E.SEND, E.AI_REPLIED, E.VERIFY, // gate FAIL → re-drive
        E.SEND, E.AI_REPLIED, E.NO_TOOLS, E.FINISH,
      ])
    ).toHaveLength(0);
  });

  test('project-coherence gate re-drives verify across two rounds', () => {
    expect(
      illegalFor([
        E.SEND, E.AI_REPLIED, E.VERIFY,
        E.SEND, E.AI_REPLIED, E.VERIFY,
        E.SEND, E.AI_REPLIED, E.NO_TOOLS, E.FINISH,
      ])
    ).toHaveLength(0);
  });

  test('interrupt mid-gate is legal from every active phase', () => {
    expect(illegalFor([E.SEND, E.AI_REPLIED, E.VERIFY, E.INTERRUPT])).toHaveLength(0);
  });

  test('transient recovery after a failed gate re-drive', () => {
    expect(
      illegalFor([
        E.SEND, E.AI_REPLIED, E.VERIFY,
        E.SEND, E.RETRY, E.SEND, E.AI_REPLIED, E.NO_TOOLS, E.FINISH,
      ])
    ).toHaveLength(0);
  });
});

describe('toolLoopPhases shadow FSM — genuinely illegal attempts still record', () => {
  test('an undeclared event from a terminal state is caught', () => {
    // finish → (terminal); a follow-up send must be flagged illegal.
    const rec = illegalFor([E.SEND, E.AI_REPLIED, E.NO_TOOLS, E.FINISH, E.SEND]);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ illegal: true, from: 'final_response', event: E.SEND });
  });
});
