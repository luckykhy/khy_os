'use strict';

/**
 * selfRepair/transactionRunner — orchestrator unit tests (node:test).
 *
 * Drives runRepairTransaction with fully stubbed IO primitives (no real git / fs /
 * spawn) to verify orchestration: gate-off passthrough, happy keep (no restore),
 * rollback path (validation fail → restore called once), empty change-set skip,
 * machinery-error fail-soft (primitive throws → fix preserved, no crash), and
 * snapshot-null continues without rollback capability.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runRepairTransaction } = require('../src/services/selfRepair/transactionRunner');

function makeStubs(over = {}) {
  const calls = { snapshot: 0, restore: 0, validate: 0, fix: 0 };
  const stubs = {
    snapshot: async () => { calls.snapshot++; return { kind: 'git', ref: 'HEAD' }; },
    restore: async () => { calls.restore++; return true; },
    validateFiles: async () => { calls.validate++; return { syntax: [], guards: [], tests: { ran: false, ok: true } }; },
    runFix: async () => { calls.fix++; return { text: 'fixed', filesModified: ['src/a.js'], success: true }; },
    env: {},
    ...over,
  };
  return { stubs, calls };
}

test('gate off → passthrough: runFix only, no snapshot/validate/restore', async () => {
  const { stubs, calls } = makeStubs({ env: { KHY_SELF_REPAIR_TRANSACTION: 'off' } });
  const r = await runRepairTransaction(stubs);
  assert.equal(r.text, 'fixed');
  assert.equal(calls.fix, 1);
  assert.equal(calls.snapshot, 0);
  assert.equal(calls.validate, 0);
  assert.equal(calls.restore, 0);
  assert.equal(r.transaction, undefined); // unwrapped fallback
});

test('happy keep: validate green → kept, restore NOT called', async () => {
  const { stubs, calls } = makeStubs();
  const r = await runRepairTransaction(stubs);
  assert.equal(calls.snapshot, 1);
  assert.equal(calls.validate, 1);
  assert.equal(calls.restore, 0);
  assert.equal(r.transaction.decision.keep, true);
  assert.deepEqual(r.filesModified, ['src/a.js']);
});

test('rollback: syntax failure → restore called once, decision.keep false', async () => {
  const { stubs, calls } = makeStubs({
    validateFiles: async () => ({ syntax: [{ file: 'src/a.js', line: 2, message: 'boom' }] }),
  });
  const r = await runRepairTransaction(stubs);
  assert.equal(calls.restore, 1);
  assert.equal(r.transaction.decision.keep, false);
  assert.equal(r.transaction.rolledBack, true);
  assert.ok(r.transaction.annotation.includes('回滚'));
});

test('empty change-set → skip validation, no restore', async () => {
  const { stubs, calls } = makeStubs({
    runFix: async () => ({ text: 'noop', filesModified: [], success: true }),
  });
  const r = await runRepairTransaction(stubs);
  assert.equal(calls.validate, 0);
  assert.equal(calls.restore, 0);
  assert.equal(r.transaction.decision, null);
});

test('non-source change-set (only README) → nothing to validate', async () => {
  const { stubs, calls } = makeStubs({
    runFix: async () => ({ text: 'docs', filesModified: ['README.md'], success: true }),
  });
  const r = await runRepairTransaction(stubs);
  assert.equal(calls.validate, 0);
  assert.equal(r.transaction.decision, null);
});

test('machinery error (validate throws) → fail-soft: fix preserved, no crash', async () => {
  const { stubs } = makeStubs({
    validateFiles: async () => { throw new Error('validator exploded'); },
  });
  const r = await runRepairTransaction(stubs);
  // fail-soft returns the unwrapped fix result (no transaction wrapper)
  assert.equal(r.text, 'fixed');
  assert.deepEqual(r.filesModified, ['src/a.js']);
});

test('snapshot returns null → continues, no rollback even on failure', async () => {
  const { stubs, calls } = makeStubs({
    snapshot: async () => null,
    validateFiles: async () => ({ syntax: [{ file: 'a.js', message: 'boom' }] }),
  });
  const r = await runRepairTransaction(stubs);
  assert.equal(calls.restore, 0); // no snapshot → cannot roll back
  assert.equal(r.transaction.snapshotMissing, true);
  assert.equal(r.transaction.decision.keep, false);
});

test('snapshot throws → treated as missing, still validates', async () => {
  const { stubs, calls } = makeStubs({
    snapshot: async () => { throw new Error('git missing'); },
  });
  const r = await runRepairTransaction(stubs);
  assert.equal(r.transaction.snapshotMissing, true);
  assert.equal(calls.validate, 1);
});

test('no runFix injected → safe error shape, no throw', async () => {
  const r = await runRepairTransaction({ env: {} });
  assert.equal(r.success, false);
  assert.ok(r.error);
});
