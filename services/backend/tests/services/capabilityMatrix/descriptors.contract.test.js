'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { DESCRIPTORS } = require('../../../src/services/capabilityMatrix/descriptors');
const { isSeam } = require('../../../src/services/capabilityMatrix/seams');
const { resolveFlag } = require('../../../src/services/capabilityMatrix/predicates');

const VALID_KINDS = new Set(['always', 'envFlagDefault', 'offDisables', 'zeroDisables', 'onEnables', 'module']);

test('every descriptor has a unique id', () => {
  const ids = DESCRIPTORS.map((d) => d.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate descriptor id');
});

test('every descriptor.seam is a known seam', () => {
  for (const d of DESCRIPTORS) {
    assert.ok(isSeam(d.seam), `${d.id}: unknown seam ${d.seam}`);
  }
});

test('every descriptor.flag.kind is resolvable', () => {
  for (const d of DESCRIPTORS) {
    assert.ok(d.flag && typeof d.flag === 'object', `${d.id}: missing flag`);
    assert.ok(VALID_KINDS.has(d.flag.kind), `${d.id}: bad kind ${d.flag.kind}`);
    // resolving against an empty env must not throw and must yield a boolean
    const v = resolveFlag(d.flag, { env: {}, isEnabledFn: d.isEnabledFn });
    assert.strictEqual(typeof v, 'boolean', `${d.id}: flag did not resolve to boolean`);
  }
});

test('preconditions is a pure function of ctx (no throw on empty ctx)', () => {
  for (const d of DESCRIPTORS) {
    assert.strictEqual(typeof d.preconditions, 'function', `${d.id}: missing preconditions`);
    assert.doesNotThrow(() => d.preconditions({}), `${d.id}: preconditions threw on {}`);
  }
});

test('cost/risk are numbers and isReversible is boolean', () => {
  for (const d of DESCRIPTORS) {
    assert.strictEqual(typeof d.cost, 'number', `${d.id}: cost`);
    assert.strictEqual(typeof d.risk, 'number', `${d.id}: risk`);
    assert.strictEqual(typeof d.isReversible, 'boolean', `${d.id}: isReversible`);
  }
});

test('wired descriptors reference a resolvable invoke.module', () => {
  // A wired capability fires at a real seam; its invoke.module must resolve so
  // the catalog cannot drift from a renamed/deleted facade. (export may be null
  // for inline seams that have no external facade.) invoke.module paths follow
  // the owner-file convention — they are written relative to services/ (where
  // the facades live), e.g. './verificationAgent'.
  const base = path.join(__dirname, '../../../src/services');
  for (const d of DESCRIPTORS) {
    if (!d.wired) continue;
    assert.ok(d.invoke && typeof d.invoke.module === 'string', `${d.id}: missing invoke.module`);
    if (d.invoke.export === null) continue; // inline seam, no external facade
    let resolved;
    assert.doesNotThrow(() => {
      resolved = require.resolve(path.resolve(base, d.invoke.module));
    }, `${d.id}: invoke.module '${d.invoke.module}' does not resolve`);
    assert.ok(resolved);
  }
});

test('module-kind descriptors provide an isEnabledFn', () => {
  for (const d of DESCRIPTORS) {
    if (d.flag.kind === 'module') {
      assert.strictEqual(typeof d.isEnabledFn, 'function', `${d.id}: module kind needs isEnabledFn`);
    }
  }
});

test('subagentSuppressed descriptors encode it as a precondition on isSubagent', () => {
  // The recursion guard must be structurally present: with isSubagent:true the
  // precondition must be false for every subagentSuppressed capability.
  for (const d of DESCRIPTORS) {
    if (!d.subagentSuppressed) continue;
    const asSub = d.preconditions({ iteration: 1, toolCallsLen: 0, isSubagent: true });
    assert.strictEqual(asSub, false, `${d.id}: subagentSuppressed but precondition allows subagent`);
  }
});
