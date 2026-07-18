'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  CapabilityMatrix,
  makeCapabilityMatrix,
  getCapabilityMatrix,
} = require('../../../src/services/capabilityMatrix/index');

test('getCapabilityMatrix returns a populated singleton', () => {
  const m = getCapabilityMatrix();
  assert.ok(m instanceof CapabilityMatrix);
  assert.ok(m.getAll().length > 0);
  assert.ok(m.getDescriptor('verifyGate'));
});

test('isEnabledAt: default env → wired seam enabled (default-ON capability)', () => {
  const m = makeCapabilityMatrix({ env: {}, overrides: {} });
  // verifyGate: envFlagDefault default true; precondition emptyToolCalls.
  assert.strictEqual(m.isEnabledAt('EMPTY_TOOLCALLS', 'verifyGate', { toolCallsLen: 0 }), true);
  assert.strictEqual(m.isEnabledAt('EMPTY_TOOLCALLS', 'verifyGate', { toolCallsLen: 1 }), false);
});

test('isEnabledAt: env flag off disables the seam', () => {
  const m = makeCapabilityMatrix({ env: { KHY_VERIFY_GATE: 'off' }, overrides: {} });
  assert.strictEqual(m.isEnabledAt('EMPTY_TOOLCALLS', 'verifyGate', { toolCallsLen: 0 }), false);
});

test('isEnabledAt: offDisables capability (selfHeal) — only literal "off" disables', () => {
  assert.strictEqual(
    makeCapabilityMatrix({ env: {}, overrides: {} }).isEnabledAt('POST_TOOL_GOVERNANCE', 'selfHeal', {}),
    true,
  );
  assert.strictEqual(
    makeCapabilityMatrix({ env: { KHY_SELF_HEAL: 'off' }, overrides: {} }).isEnabledAt('POST_TOOL_GOVERNANCE', 'selfHeal', {}),
    false,
  );
  // ' off ' is NOT 'off' (strict) → still enabled
  assert.strictEqual(
    makeCapabilityMatrix({ env: { KHY_SELF_HEAL: ' off ' }, overrides: {} }).isEnabledAt('POST_TOOL_GOVERNANCE', 'selfHeal', {}),
    true,
  );
});

test('isEnabledAt: wrong seam id returns false (typo guard)', () => {
  const m = makeCapabilityMatrix({ env: {}, overrides: {} });
  assert.strictEqual(m.isEnabledAt('PRE_DISPATCH', 'verifyGate', { toolCallsLen: 0 }), false);
});

test('isEnabledAt: unknown capability returns false', () => {
  const m = makeCapabilityMatrix({ env: {}, overrides: {} });
  assert.strictEqual(m.isEnabledAt('EMPTY_TOOLCALLS', 'nope', {}), false);
});

test('isEnabledAt: proactiveCollab firstTurnEmptyNoSub precondition', () => {
  const m = makeCapabilityMatrix({ env: {}, overrides: {} });
  assert.strictEqual(m.isEnabledAt('PRE_DISPATCH', 'proactiveCollab', { iteration: 1, toolCallsLen: 0, isSubagent: false }), true);
  assert.strictEqual(m.isEnabledAt('PRE_DISPATCH', 'proactiveCollab', { iteration: 1, toolCallsLen: 0, isSubagent: true }), false);
  assert.strictEqual(m.isEnabledAt('PRE_DISPATCH', 'proactiveCollab', { iteration: 2, toolCallsLen: 0, isSubagent: false }), false);
});

test('module-kind capability (unknownProblem) honors isEnabledFn', () => {
  const m = makeCapabilityMatrix({ env: {}, overrides: {} });
  // The descriptor's isEnabledFn requires the real unknownProblemHandler module;
  // whatever it returns, isEnabledAt must be a boolean and must not throw.
  const v = m.isEnabledAt('EMPTY_TOOLCALLS', 'unknownProblem', {});
  assert.strictEqual(typeof v, 'boolean');
});

test('_loadOverrides: inline JSON disables a capability', () => {
  const m = makeCapabilityMatrix({
    env: { KHY_CAPABILITY_MATRIX_JSON: JSON.stringify({ verifyGate: { flag: { env: 'KHY_VERIFY_GATE', kind: 'always' } } }) },
  });
  // override replaced the flag spec with always-true; precondition still applies.
  assert.strictEqual(m.isEnabledAt('EMPTY_TOOLCALLS', 'verifyGate', { toolCallsLen: 0 }), true);
});

test('_loadOverrides: malformed inline JSON is ignored (never throws)', () => {
  assert.doesNotThrow(() => {
    makeCapabilityMatrix({ env: { KHY_CAPABILITY_MATRIX_JSON: '{not json' } });
  });
});

test('composeRoute: auto-selects delivery preset for coding mode', () => {
  const m = makeCapabilityMatrix({ env: {}, overrides: {} });
  const route = m.composeRoute({
    signals: { modes: ['coding'] },
    ctx: { iteration: 1, toolCallsLen: 0, isSubagent: false },
  });
  assert.strictEqual(route.preset.id, 'delivery');
  assert.ok(Array.isArray(route.active));
});

test('composeRoute: no modes → no preset (auto-inference fallback)', () => {
  const m = makeCapabilityMatrix({ env: {}, overrides: {} });
  const route = m.composeRoute({ signals: { modes: [] }, ctx: { iteration: 1, toolCallsLen: 0, isSubagent: false } });
  assert.strictEqual(route.preset, null);
});

test('selectPreset maps modes to presets', () => {
  const m = makeCapabilityMatrix({ env: {}, overrides: {} });
  assert.strictEqual(m.selectPreset(['analyze']).id, 'research');
  assert.strictEqual(m.selectPreset(['coding']).id, 'delivery');
  assert.strictEqual(m.selectPreset([]), null);
});
