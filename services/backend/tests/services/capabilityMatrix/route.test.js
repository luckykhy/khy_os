'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { serializeRoute, formatRouteHuman } = require('../../../src/services/capabilityMatrix/route');
const { selectPreset } = require('../../../src/services/capabilityMatrix/routePresets');

const SAMPLE = {
  preset: { id: 'delivery', label: 'd' },
  signals: { modes: ['coding'] },
  active: ['structuredFurnace', 'verifyGate'],
  gatedOff: [{ id: 'selfKickoff', reason: 'gated-off' }],
  suppressed: [{ id: 'proactiveCollab', reason: 'subagent' }],
  budgetDropped: [],
  budgetUsed: 3,
  steps: [
    { id: 'structuredFurnace', seam: 'PRE_DISPATCH', phase: 20, enabled: true, eligible: true, reason: null, inPreset: true },
    { id: 'verifyGate', seam: 'EMPTY_TOOLCALLS', phase: 30, enabled: true, eligible: true, reason: null, inPreset: true },
  ],
};

test('serializeRoute produces a compact deterministic payload', () => {
  const s = serializeRoute(SAMPLE);
  assert.strictEqual(s.preset, 'delivery');
  assert.deepStrictEqual(s.signals.modes, ['coding']);
  assert.deepStrictEqual(s.active, ['structuredFurnace', 'verifyGate']);
  assert.deepStrictEqual(s.gatedOff, [{ id: 'selfKickoff', reason: 'gated-off' }]);
  assert.deepStrictEqual(s.suppressed, [{ id: 'proactiveCollab', reason: 'subagent' }]);
  assert.strictEqual(s.budgetUsed, 3);
  assert.strictEqual(s.steps.length, 2);
  assert.ok(!('requires' in s.steps[0]), 'requires is dropped from the compact step');
});

test('serializeRoute tolerates a null/garbage route', () => {
  const s = serializeRoute(null);
  assert.deepStrictEqual(s.active, []);
  assert.strictEqual(s.preset, null);
});

test('formatRouteHuman renders a pipeline with skip reasons', () => {
  const line = formatRouteHuman(SAMPLE);
  assert.match(line, /route\[delivery\]: structuredFurnace→verifyGate/);
  assert.match(line, /gated-off: selfKickoff/);
  assert.match(line, /suppressed: proactiveCollab\(subagent\)/);
});

test('formatRouteHuman handles an empty active route', () => {
  const line = formatRouteHuman({ active: [], gatedOff: [], suppressed: [], budgetDropped: [] });
  assert.match(line, /\(none active\)/);
});

test('formatRouteHuman handles null', () => {
  assert.strictEqual(formatRouteHuman(null), 'route: (empty)');
});

test('preset selection wiring sanity (research/delivery/audit)', () => {
  assert.strictEqual(selectPreset(['learn']).id, 'research');
  assert.strictEqual(selectPreset(['ultrawork']).id, 'delivery');
  assert.strictEqual(selectPreset(['goal']).id, 'delivery');
  assert.strictEqual(selectPreset(['nonexistent']), null);
});
