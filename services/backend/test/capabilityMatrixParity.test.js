'use strict';

/**
 * capabilityMatrixParity.test.js — the byte-identity proof for cut 1.
 *
 * For every WIRED seam, assert that isEnabledAt() — evaluated at the point in the
 * loop where the old inline flag check lived (i.e. with preconditions already
 * guaranteed true by the surrounding guards) — yields EXACTLY the boolean the
 * original inline expression produced, for every plausible env value.
 *
 * This is what guarantees the seam swap changed no default-path behavior.
 */

const path = require('path');

const MATRIX_PATH = path.resolve(__dirname, '../src/services/capabilityMatrix');
const { makeCapabilityMatrix } = require(MATRIX_PATH);
const { SEAMS } = require(path.resolve(__dirname, '../src/services/capabilityMatrix/seams'));

// The canonical _envFlagEnabled from the loop, replicated here ONLY to compute
// the "expected" side of the parity assertion independently of the matrix.
function envFlagEnabled(rawValue, defaultValue = true) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return defaultValue;
  const n = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'y'].includes(n)) return true;
  if (['0', 'false', 'off', 'no', 'n'].includes(n)) return false;
  return defaultValue;
}

const ENV_VALUES = [undefined, '', '0', '1', 'off', 'on', 'true', 'false', 'no', 'yes', ' off ', 'OFF', 'garbage'];

// Each wired seam: how its ORIGINAL inline expression computed the flag boolean,
// plus the ctx that holds at that seam (preconditions guaranteed true there).
const WIRED = [
  // toolUseLoop.js
  {
    seam: SEAMS.PRE_DISPATCH, id: 'proactiveCollab', envName: 'KHY_PROACTIVE_COLLAB',
    ctx: { iteration: 1, toolCallsLen: 0, isSubagent: false },
    expected: (raw) => envFlagEnabled(raw, true),
  },
  {
    seam: SEAMS.EMPTY_TOOLCALLS, id: 'verifyGate', envName: 'KHY_VERIFY_GATE',
    ctx: { toolCallsLen: 0 },
    expected: (raw) => envFlagEnabled(raw, true),
  },
  {
    seam: SEAMS.EMPTY_TOOLCALLS, id: 'verifyNonEdit', envName: 'KHY_VERIFY_NONEDIT',
    ctx: { toolCallsLen: 0 },
    expected: (raw) => envFlagEnabled(raw, true),
  },
  {
    seam: SEAMS.EMPTY_TOOLCALLS, id: 'projectCoherence', envName: 'KHY_PROJECT_COHERENCE',
    ctx: { toolCallsLen: 0 },
    expected: (raw) => envFlagEnabled(raw, true),
  },
  {
    seam: SEAMS.EMPTY_TOOLCALLS, id: 'deliverableClosure', envName: 'KHY_DELIVERABLE_CLOSURE',
    ctx: {},
    expected: (raw) => envFlagEnabled(raw, true),
  },
  {
    seam: SEAMS.EMPTY_TOOLCALLS, id: 'selfKickoff', envName: 'KHY_SELF_KICKOFF',
    ctx: {},
    expected: (raw) => envFlagEnabled(raw, true),
  },
  {
    seam: SEAMS.PRE_DISPATCH, id: 'structuredFurnace', envName: 'KHY_STRUCTURED_FURNACE',
    ctx: {},
    expected: (raw) => String(raw || '').trim() !== '0',
  },
  // toolCalling.js — offDisables (strict !== 'off')
  {
    seam: SEAMS.POST_TOOL_GOVERNANCE, id: 'selfHeal', envName: 'KHY_SELF_HEAL',
    ctx: {},
    expected: (raw) => raw !== 'off',
  },
  {
    seam: SEAMS.POST_TOOL_GOVERNANCE, id: 'syscallGateway', envName: 'KHY_SYSCALL_GATEWAY',
    ctx: {},
    expected: (raw) => raw !== 'off',
  },
  {
    seam: SEAMS.POST_TOOL_GOVERNANCE, id: 'metaConstraint', envName: 'KHY_METACONSTRAINT',
    ctx: {},
    expected: (raw) => raw !== 'off',
  },
  {
    seam: SEAMS.POST_TOOL_GOVERNANCE, id: 'evoEngine', envName: 'KHY_EVO_ENGINE',
    ctx: {},
    expected: (raw) => raw !== 'off',
  },
  {
    seam: SEAMS.POST_TOOL_GOVERNANCE, id: 'depHealing', envName: 'KHY_DEP_HEALING',
    ctx: {},
    expected: (raw) => raw !== 'off',
  },
];

describe('capability matrix — byte-identity parity with inline seam checks', () => {
  for (const w of WIRED) {
    describe(`${w.id} (${w.envName})`, () => {
      for (const raw of ENV_VALUES) {
        test(`raw=${JSON.stringify(raw)}`, () => {
          const env = raw === undefined ? {} : { [w.envName]: raw };
          const matrix = makeCapabilityMatrix({ env, overrides: {} });
          const got = matrix.isEnabledAt(w.seam, w.id, w.ctx);
          expect(got).toBe(w.expected(raw));
        });
      }
    });
  }
});

describe('subagent recursion guard preserved for proactiveCollab', () => {
  test('proactiveCollab is suppressed in a subagent regardless of flag', () => {
    const matrix = makeCapabilityMatrix({ env: { KHY_PROACTIVE_COLLAB: '1' }, overrides: {} });
    expect(matrix.isEnabledAt(SEAMS.PRE_DISPATCH, 'proactiveCollab', { iteration: 1, toolCallsLen: 0, isSubagent: true })).toBe(false);
  });
  test('selfKickoff is NOT subagent-suppressed (matches inline behavior — no _isSubagent guard)', () => {
    const matrix = makeCapabilityMatrix({ env: {}, overrides: {} });
    expect(matrix.isEnabledAt(SEAMS.EMPTY_TOOLCALLS, 'selfKickoff', { isSubagent: true })).toBe(true);
  });
});
