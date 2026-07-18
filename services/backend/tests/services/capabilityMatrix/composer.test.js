'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { composeRoute, defaultRequirementsMatcher } = require('../../../src/services/capabilityMatrix/composer');
const { SEAM_ORDER } = require('../../../src/services/capabilityMatrix/seams');

// Minimal hand-built descriptor catalog so composer behavior is asserted in
// isolation from the real DESCRIPTORS (those are exercised by index/contract
// tests). flagResolver is injected, so this stays env-free and deterministic.
const CATALOG = [
  {
    id: 'furnace', label: 'furnace', seam: 'PRE_DISPATCH', phase: 20, owner: 'x',
    wired: true, requires: {}, cost: 1, isReversible: true, subagentSuppressed: false,
    preconditions: () => true,
  },
  {
    id: 'collab', label: 'collab', seam: 'PRE_DISPATCH', phase: 10, owner: 'x',
    wired: true, requires: { tool_use: 3 }, cost: 3, isReversible: true, subagentSuppressed: true,
    preconditions: (ctx) => ctx.iteration === 1 && ctx.toolCallsLen === 0 && !ctx.isSubagent,
  },
  {
    id: 'verify', label: 'verify', seam: 'EMPTY_TOOLCALLS', phase: 30, owner: 'x',
    wired: true, requires: {}, cost: 2, isReversible: true, subagentSuppressed: false,
    preconditions: (ctx) => ctx.toolCallsLen === 0,
  },
  {
    id: 'depHeal', label: 'depHeal', seam: 'POST_TOOL_GOVERNANCE', phase: 50, owner: 'x',
    wired: true, requires: {}, cost: 9, isReversible: false, subagentSuppressed: false,
    preconditions: () => true,
  },
];

const ALL_ON = () => true;

test('default-path: every flag on, all preconditions met → active in seam/phase order', () => {
  const route = composeRoute({
    signals: { modes: [] },
    ctx: { iteration: 1, toolCallsLen: 0, isSubagent: false },
    descriptors: CATALOG,
    flagResolver: ALL_ON,
  });
  // PRE_DISPATCH (0) collab(10) < furnace(20); EMPTY_TOOLCALLS(100) verify(30→130);
  // POST_TOOL_GOVERNANCE(200) depHeal(50→250).
  assert.deepStrictEqual(route.active, ['collab', 'furnace', 'verify', 'depHeal']);
  assert.deepStrictEqual(route.gatedOff, []);
  assert.deepStrictEqual(route.suppressed, []);
});

test('gated-off flag is recorded and excluded from active', () => {
  const route = composeRoute({
    ctx: { iteration: 1, toolCallsLen: 0, isSubagent: false },
    descriptors: CATALOG,
    flagResolver: (d) => d.id !== 'verify', // verify disabled
  });
  assert.ok(!route.active.includes('verify'));
  assert.deepStrictEqual(route.gatedOff.map((g) => g.id), ['verify']);
});

test('subagent ctx suppresses collab (recursion guard preserved)', () => {
  const route = composeRoute({
    ctx: { iteration: 1, toolCallsLen: 0, isSubagent: true },
    descriptors: CATALOG,
    flagResolver: ALL_ON,
  });
  assert.ok(!route.active.includes('collab'));
  const s = route.suppressed.find((x) => x.id === 'collab');
  assert.ok(s, 'collab suppressed');
  assert.strictEqual(s.reason, 'subagent');
});

test('non-first-iteration / has-toolcalls precondition reasons', () => {
  const r2 = composeRoute({
    ctx: { iteration: 3, toolCallsLen: 0, isSubagent: false },
    descriptors: CATALOG, flagResolver: ALL_ON,
  });
  assert.strictEqual(r2.suppressed.find((x) => x.id === 'collab').reason, 'not-iter-1');

  const r3 = composeRoute({
    ctx: { iteration: 1, toolCallsLen: 2, isSubagent: false },
    descriptors: CATALOG, flagResolver: ALL_ON,
  });
  const collabReason = r3.suppressed.find((x) => x.id === 'collab').reason;
  // collab needs iter1 & empty & !sub; toolCallsLen=2 fails → has-toolcalls.
  assert.strictEqual(collabReason, 'has-toolcalls');
  // verify also requires empty tool calls → suppressed too
  assert.ok(r3.suppressed.find((x) => x.id === 'verify'));
});

test('capability vector gap excludes a step (cut2 path, opt-in vector)', () => {
  const route = composeRoute({
    ctx: { iteration: 1, toolCallsLen: 0, isSubagent: false },
    capabilityVector: { tool_use: 1 }, // collab needs tool_use:3
    descriptors: CATALOG,
    flagResolver: ALL_ON,
  });
  assert.ok(!route.active.includes('collab'));
  const step = route.steps.find((s) => s.id === 'collab');
  assert.match(step.reason, /capability-gap:tool_use 1\/3/);
});

test('default all-max vector is inert (requires never blocks)', () => {
  const route = composeRoute({
    ctx: { iteration: 1, toolCallsLen: 0, isSubagent: false },
    descriptors: CATALOG, flagResolver: ALL_ON, // no capabilityVector → all-max
  });
  assert.ok(route.active.includes('collab')); // tool_use:3 satisfied by all-max
});

test('budget knapsack drops highest-cost reversible step, never irreversible', () => {
  // eligible cost sum = collab3 + furnace1 + verify2 + depHeal9 = 15. budget=7.
  // Must drop reversible highest-cost first (collab3, verify2) but NEVER depHeal (irreversible, cost9).
  const route = composeRoute({
    ctx: { iteration: 1, toolCallsLen: 0, isSubagent: false },
    budget: 7,
    descriptors: CATALOG,
    flagResolver: ALL_ON,
  });
  assert.ok(route.active.includes('depHeal'), 'irreversible step is never budget-dropped');
  assert.ok(route.budgetDropped.length > 0);
  // depHeal alone is 9 > 7 but it is irreversible, so budget cannot be honored;
  // the knapsack drops all reversible steps and stops.
  assert.ok(!route.budgetDropped.some((d) => d.id === 'depHeal'));
});

test('budget=Infinity is a no-op', () => {
  const route = composeRoute({
    ctx: { iteration: 1, toolCallsLen: 0, isSubagent: false },
    budget: Infinity, descriptors: CATALOG, flagResolver: ALL_ON,
  });
  assert.deepStrictEqual(route.budgetDropped, []);
  assert.strictEqual(route.active.length, 4);
});

test('preset overlay tags in-preset steps and reorders within seam band', () => {
  const preset = { id: 'p', label: 'p', capabilities: ['furnace', 'verify'] };
  const route = composeRoute({
    signals: { modes: ['coding'] },
    ctx: { iteration: 1, toolCallsLen: 0, isSubagent: false },
    descriptors: CATALOG, preset, flagResolver: ALL_ON,
  });
  assert.strictEqual(route.preset.id, 'p');
  const furnace = route.steps.find((s) => s.id === 'furnace');
  assert.strictEqual(furnace.inPreset, true);
  const collab = route.steps.find((s) => s.id === 'collab');
  assert.strictEqual(collab.inPreset, false);
  // phase ordering still dominates: collab(phase10) precedes furnace(phase20)
  // even though furnace is in-preset — the preset nudge is only a tiebreak.
  const order = route.steps.map((s) => s.id);
  assert.ok(order.indexOf('collab') < order.indexOf('furnace'));
});

test('preset membership breaks ties only when base rank is equal', () => {
  // Two PRE_DISPATCH steps with the SAME phase → preset member ranks first.
  const tie = [
    { id: 'aOut', label: 'a', seam: 'PRE_DISPATCH', phase: 10, owner: 'x', wired: true, requires: {}, cost: 1, isReversible: true, subagentSuppressed: false, preconditions: () => true },
    { id: 'bIn', label: 'b', seam: 'PRE_DISPATCH', phase: 10, owner: 'x', wired: true, requires: {}, cost: 1, isReversible: true, subagentSuppressed: false, preconditions: () => true },
  ];
  const route = composeRoute({
    ctx: {}, descriptors: tie, flagResolver: ALL_ON,
    preset: { id: 'p', label: 'p', capabilities: ['bIn'] },
  });
  const order = route.steps.map((s) => s.id);
  assert.ok(order.indexOf('bIn') < order.indexOf('aOut'), 'in-preset wins the tie');
});

test('defaultRequirementsMatcher: empty requires always matches', () => {
  assert.strictEqual(defaultRequirementsMatcher({}, {}), true);
  assert.strictEqual(defaultRequirementsMatcher({ tool_use: 3 }, { tool_use: 3 }), true);
  assert.strictEqual(defaultRequirementsMatcher({ tool_use: 3 }, { tool_use: 2 }), false);
});

test('SEAM_ORDER drives cross-seam ordering monotonically', () => {
  assert.ok(SEAM_ORDER.PRE_DISPATCH < SEAM_ORDER.EMPTY_TOOLCALLS);
  assert.ok(SEAM_ORDER.EMPTY_TOOLCALLS < SEAM_ORDER.POST_TOOL_GOVERNANCE);
});
