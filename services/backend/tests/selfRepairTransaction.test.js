'use strict';

/**
 * selfRepairTransaction — pure-leaf unit tests (node:test).
 *
 * Covers the self-repair transaction decision leaf: gate behaviour, plan
 * clamping + env knobs, change-set normalization (dedupe / extension filter /
 * maxFiles cap), keep-vs-rollback decision (syntax error → rollback, guard error
 * → rollback, warnings don't block, tests-failed → rollback, missing validation
 * → conservative keep), and the human annotation. Deterministic: no IO, no clock.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../src/services/selfRepairTransaction');

test('isEnabled: default-on; {0,false,off,no} turn it off', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_SELF_REPAIR_TRANSACTION: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(leaf.isEnabled({ KHY_SELF_REPAIR_TRANSACTION: v }), false, `expected off for ${JSON.stringify(v)}`);
  }
});

test('planTransaction: gate off → disabled plan', () => {
  const p = leaf.planTransaction({}, { KHY_SELF_REPAIR_TRANSACTION: 'off' });
  assert.equal(p.enabled, false);
  assert.equal(p.snapshot, false);
  assert.equal(p.maxFiles, 0);
});

test('planTransaction: defaults when on', () => {
  const p = leaf.planTransaction({}, {});
  assert.equal(p.enabled, true);
  assert.equal(p.snapshot, true);
  assert.equal(p.runSyntax, true);
  assert.equal(p.runGuards, true);
  assert.equal(p.runTests, false); // tests opt-in (slow/flaky)
  assert.equal(p.maxFiles, leaf.DEFAULTS.maxFiles);
});

test('planTransaction: env maxFiles is clamped to [1,1000]', () => {
  assert.equal(leaf.planTransaction({}, { KHY_SELF_REPAIR_MAX_FILES: '5' }).maxFiles, 5);
  assert.equal(leaf.planTransaction({}, { KHY_SELF_REPAIR_MAX_FILES: '99999' }).maxFiles, 1000);
  assert.equal(leaf.planTransaction({}, { KHY_SELF_REPAIR_MAX_FILES: '0' }).maxFiles, 1);
  assert.equal(leaf.planTransaction({}, { KHY_SELF_REPAIR_MAX_FILES: 'junk' }).maxFiles, leaf.DEFAULTS.maxFiles);
});

test('planTransaction: env can opt into tests and disable guards/syntax', () => {
  const p = leaf.planTransaction({}, { KHY_SELF_REPAIR_RUN_TESTS: '1', KHY_SELF_REPAIR_RUN_GUARDS: 'off' });
  assert.equal(p.runTests, true);
  assert.equal(p.runGuards, false);
});

test('planTransaction: explicit opts override env', () => {
  const p = leaf.planTransaction({ maxFiles: 3, runTests: true }, { KHY_SELF_REPAIR_MAX_FILES: '9' });
  assert.equal(p.maxFiles, 3);
  assert.equal(p.runTests, true);
});

test('classifyChangeSet: dedupes, filters to source extensions', () => {
  const cs = leaf.classifyChangeSet(
    ['src/a.js', 'src/a.js', 'README.md', 'pkg/b.ts', 'data.json', 'image.png', '', null],
    { maxFiles: 50 },
  );
  assert.deepEqual(cs.validatable.sort(), ['data.json', 'pkg/b.ts', 'src/a.js']);
  assert.ok(cs.skipped.includes('README.md'));
  assert.ok(cs.skipped.includes('image.png'));
  assert.equal(cs.tooMany, false);
});

test('classifyChangeSet: caps at maxFiles, overflow → skipped + tooMany', () => {
  const files = ['a.js', 'b.js', 'c.js', 'd.js'];
  const cs = leaf.classifyChangeSet(files, { maxFiles: 2 });
  assert.equal(cs.validatable.length, 2);
  assert.equal(cs.tooMany, true);
  assert.equal(cs.skipped.length, 2);
});

test('classifyChangeSet: non-array input → empty, no throw', () => {
  const cs = leaf.classifyChangeSet(null, {});
  assert.deepEqual(cs.validatable, []);
  assert.equal(cs.tooMany, false);
});

test('isJsonFile', () => {
  assert.equal(leaf.isJsonFile('x/y.json'), true);
  assert.equal(leaf.isJsonFile('x/y.js'), false);
});

test('decideOutcome: all green → keep clean', () => {
  const d = leaf.decideOutcome({ syntax: [], guards: [], tests: { ran: true, ok: true } }, {});
  assert.equal(d.keep, true);
  assert.equal(d.reason, 'clean');
  assert.equal(d.failures.length, 0);
});

test('decideOutcome: syntax error → rollback', () => {
  const d = leaf.decideOutcome({ syntax: [{ file: 'a.js', line: 5, message: 'Unexpected token' }] }, {});
  assert.equal(d.keep, false);
  assert.equal(d.reason, 'validation-failed');
  assert.ok(d.failures[0].includes('a.js:5'));
});

test('decideOutcome: guard error → rollback; warning does NOT block', () => {
  const d = leaf.decideOutcome({
    guards: [
      { severity: 'error', rule: 'leaf-io', relPath: 'x.js', line: 3, message: 'IO in leaf' },
      { severity: 'warning', rule: 'leaf-gate-orphan', relPath: 'x.js', message: 'orphan gate' },
    ],
  }, {});
  assert.equal(d.keep, false);
  assert.equal(d.failures.length, 1);
  assert.equal(d.warnings.length, 1);
});

test('decideOutcome: only warnings → keep-with-warnings', () => {
  const d = leaf.decideOutcome({ guards: [{ severity: 'warning', rule: 'x', message: 'w' }] }, {});
  assert.equal(d.keep, true);
  assert.equal(d.reason, 'kept-with-warnings');
});

test('decideOutcome: tests failed → rollback; tests not-run → no block', () => {
  assert.equal(leaf.decideOutcome({ tests: { ran: true, ok: false, summary: '3 failing' } }, {}).keep, false);
  assert.equal(leaf.decideOutcome({ tests: { ran: false, ok: true } }, {}).keep, true);
});

test('decideOutcome: missing validation → conservative keep (no误回滚)', () => {
  const d = leaf.decideOutcome(null, {});
  assert.equal(d.keep, true);
  assert.equal(d.reason, 'no-validation');
});

test('summarizeTransaction: no decision → empty', () => {
  assert.equal(leaf.summarizeTransaction({}), '');
  assert.equal(leaf.summarizeTransaction({ decision: null }), '');
});

test('summarizeTransaction: kept clean with files → mentions 保留', () => {
  const out = leaf.summarizeTransaction({
    decision: { keep: true, warnings: [] },
    changeSet: { validatable: ['a.js', 'b.js'] },
  });
  assert.ok(out.includes('保留'));
  assert.ok(out.includes('2 个文件'));
});

test('summarizeTransaction: kept with zero files and no warnings → empty (no noise)', () => {
  const out = leaf.summarizeTransaction({
    decision: { keep: true, warnings: [] },
    changeSet: { validatable: [] },
  });
  assert.equal(out, '');
});

test('summarizeTransaction: rollback lists reasons and notes snapshot-missing keep', () => {
  const out = leaf.summarizeTransaction({
    decision: { keep: false, failures: ['语法错误 a.js:1: boom'] },
    changeSet: { validatable: ['a.js'] },
    rolledBack: true,
  });
  assert.ok(out.includes('回滚'));
  assert.ok(out.includes('语法错误 a.js:1'));
});

test('summarizeTransaction: kept but snapshot missing → warns no rollback protection', () => {
  const out = leaf.summarizeTransaction({
    decision: { keep: true, warnings: [] },
    changeSet: { validatable: ['a.js'] },
    snapshotMissing: true,
  });
  assert.ok(out.includes('未能创建快照'));
});
