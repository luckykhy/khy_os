'use strict';

/**
 * Unit tests for restoreCompletenessCheck.js — the bundled runtime leaf that
 * reconciles the snapshot header `fileCount` against the number of files that
 * actually landed on disk after `tar` extraction (run via `node --test`).
 *
 * Covers:
 *   - verifyRestoreCompleteness tiers: complete(ok) / incomplete / over-extracted /
 *     unverifiable, and the derived missing/extra/ok fields.
 *   - conservative unverifiable: missing facts, non-object/array facts, absent or
 *     non-positive expected, absent/negative actual, non-finite inputs — never
 *     claims incomplete on "not measured", never over-claims complete.
 *   - float truncation of inputs; ok === (status === complete) invariant.
 *   - never throws on adversarial input.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const CHK = require('../../src/services/restoreCompletenessCheck');
const { verifyRestoreCompleteness: v } = CHK;

test('complete: actual === expected ⇒ ok, missing/extra 0', () => {
  const r = v({ expectedFileCount: 5, actualFileCount: 5 });
  assert.strictEqual(r.status, CHK.STATUS_COMPLETE);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.expected, 5);
  assert.strictEqual(r.actual, 5);
  assert.strictEqual(r.missing, 0);
  assert.strictEqual(r.extra, 0);
});

test('incomplete: actual < expected ⇒ not ok, missing = delta', () => {
  const r = v({ expectedFileCount: 5, actualFileCount: 3 });
  assert.strictEqual(r.status, CHK.STATUS_INCOMPLETE);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.missing, 2);
  assert.strictEqual(r.extra, 0);
});

test('over-extracted: actual > expected ⇒ not ok, extra = delta', () => {
  const r = v({ expectedFileCount: 5, actualFileCount: 7 });
  assert.strictEqual(r.status, CHK.STATUS_OVER_EXTRACTED);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.extra, 2);
  assert.strictEqual(r.missing, 0);
});

test('unverifiable: missing / non-object / array facts', () => {
  for (const bad of [null, undefined, 42, 'x', [], [1, 2]]) {
    const r = v(bad);
    assert.strictEqual(r.status, CHK.STATUS_UNVERIFIABLE, `bad=${JSON.stringify(bad)}`);
    assert.strictEqual(r.ok, false);
  }
});

test('unverifiable: expected absent / non-positive (never guess complete)', () => {
  for (const exp of [undefined, null, 0, -1, NaN, Infinity]) {
    const r = v({ expectedFileCount: exp, actualFileCount: 5 });
    assert.strictEqual(r.status, CHK.STATUS_UNVERIFIABLE, `exp=${exp}`);
    assert.strictEqual(r.ok, false);
  }
});

test('unverifiable: actual absent / negative / non-finite (never call it incomplete)', () => {
  for (const act of [undefined, null, -1, NaN, Infinity]) {
    const r = v({ expectedFileCount: 5, actualFileCount: act });
    assert.strictEqual(r.status, CHK.STATUS_UNVERIFIABLE, `act=${act}`);
    assert.strictEqual(r.ok, false);
    // Critically: an unknown actual must NOT masquerade as incomplete (false alarm).
    assert.notStrictEqual(r.status, CHK.STATUS_INCOMPLETE);
  }
});

test('actual === 0 with expected > 0 ⇒ incomplete (real total loss, not unverifiable)', () => {
  const r = v({ expectedFileCount: 4, actualFileCount: 0 });
  assert.strictEqual(r.status, CHK.STATUS_INCOMPLETE);
  assert.strictEqual(r.missing, 4);
});

test('float inputs are truncated to integers', () => {
  const r = v({ expectedFileCount: 5.9, actualFileCount: 5.1 });
  assert.strictEqual(r.expected, 5);
  assert.strictEqual(r.actual, 5);
  assert.strictEqual(r.status, CHK.STATUS_COMPLETE);
});

test('ok === (status === complete) invariant across many inputs', () => {
  const cases = [
    [3, 3], [3, 2], [3, 4], [1, 0], [10, 10],
    [undefined, 3], [3, undefined], [0, 0], [-1, 5],
  ];
  for (const [e, a] of cases) {
    const r = v({ expectedFileCount: e, actualFileCount: a });
    assert.strictEqual(r.ok, r.status === CHK.STATUS_COMPLETE, `e=${e} a=${a}`);
  }
});

test('never throws on adversarial input', () => {
  const evil = [
    Symbol('x'),
    { get expectedFileCount() { throw new Error('boom'); } },
    { expectedFileCount: {}, actualFileCount: [] },
    { expectedFileCount: 5, actualFileCount: { valueOf() { throw new Error('nope'); } } },
    () => {},
  ];
  for (const e of evil) {
    assert.doesNotThrow(() => {
      const r = v(e);
      assert.strictEqual(typeof r.status, 'string');
      assert.strictEqual(typeof r.ok, 'boolean');
    });
  }
});

test('reason is always a string; verdict shape is stable', () => {
  for (const bad of [null, { expectedFileCount: 5, actualFileCount: 3 }, {}]) {
    const r = v(bad);
    assert.strictEqual(typeof r.reason, 'string');
    for (const k of ['status', 'ok', 'expected', 'actual', 'missing', 'extra', 'reason']) {
      assert.ok(Object.prototype.hasOwnProperty.call(r, k), `missing key ${k}`);
    }
  }
});
