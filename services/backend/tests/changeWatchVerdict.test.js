'use strict';

/**
 * changeWatchVerdict — pure-leaf unit tests (node:test).
 *
 * Covers the "speak up when khy is modified" brain leaf: gate behaviour,
 * change-file classification (delegated to selfRepairTransaction), verdict
 * mapping (incorrect on syntax/guard error, uncertain when nothing checked or
 * validation missing, correct on clean / with-warnings), the de-dup signature +
 * shouldSpeak, and the first-person feedback wording. Deterministic: no IO, no
 * clock, no random.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../src/services/changeWatchVerdict');

test('isEnabled: default-on; only {0,false,off,no} disable', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_CHANGE_WATCH_VERDICT: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(leaf.isEnabled({ KHY_CHANGE_WATCH_VERDICT: off }), false);
  }
});

test('classifyChangedFiles: keeps source, skips non-source, dedupes', () => {
  const r = leaf.classifyChangedFiles(['a.js', 'a.js', 'README.md', 'k.json', 'x.bin']);
  assert.deepEqual(r.validatable.sort(), ['a.js', 'k.json'].sort());
  assert.ok(r.skipped.includes('README.md'));
  assert.ok(r.skipped.includes('x.bin'));
});

test('classifyVerdict: missing validation → uncertain (never falsely "incorrect")', () => {
  for (const bad of [null, undefined, 42, 'nope']) {
    const v = leaf.classifyVerdict(bad);
    assert.equal(v.verdict, 'uncertain');
    assert.equal(v.reason, 'no-validation');
    assert.deepEqual(v.failures, []);
  }
});

test('classifyVerdict: syntax error → incorrect with failure listed', () => {
  const v = leaf.classifyVerdict(
    { syntax: [{ file: 'a.js', line: 3, message: 'Unexpected token' }], guards: [] },
    { checkedCount: 1 },
  );
  assert.equal(v.verdict, 'incorrect');
  assert.equal(v.failures.length, 1);
  assert.match(v.failures[0], /a\.js:3/);
});

test('classifyVerdict: guard error → incorrect; guard warning → correct-with-warnings', () => {
  const err = leaf.classifyVerdict(
    { syntax: [], guards: [{ severity: 'error', rule: 'leaf-io', relPath: 'l.js', message: 'IO in leaf' }] },
    { checkedCount: 1 },
  );
  assert.equal(err.verdict, 'incorrect');

  const warn = leaf.classifyVerdict(
    { syntax: [], guards: [{ severity: 'warning', rule: 'leaf-gate-orphan', relPath: 'l.js', message: 'gate orphan' }] },
    { checkedCount: 1 },
  );
  assert.equal(warn.verdict, 'correct');
  assert.equal(warn.reason, 'correct-with-warnings');
  assert.equal(warn.warnings.length, 1);
});

test('classifyVerdict: clean + files actually checked → correct', () => {
  const v = leaf.classifyVerdict({ syntax: [], guards: [] }, { checkedCount: 2 });
  assert.equal(v.verdict, 'correct');
  assert.equal(v.checkedCount, 2);
});

test('classifyVerdict: clean but nothing checked → uncertain (not falsely "correct")', () => {
  const v = leaf.classifyVerdict({ syntax: [], guards: [] }, { checkedCount: 0 });
  assert.equal(v.verdict, 'uncertain');
  assert.equal(v.reason, 'nothing-checked');
});

test('classifyVerdict: failing tests → incorrect', () => {
  const v = leaf.classifyVerdict(
    { syntax: [], guards: [], tests: { ran: true, ok: false, summary: '2 failed' } },
    { checkedCount: 1 },
  );
  assert.equal(v.verdict, 'incorrect');
  assert.match(v.failures.join(' '), /测试失败/);
});

test('verdictSignature + shouldSpeak: speak first time and on change, silent on repeat', () => {
  const a = leaf.classifyVerdict({ syntax: [], guards: [] }, { checkedCount: 1 });
  const sigA = leaf.verdictSignature(a);
  assert.equal(leaf.shouldSpeak(null, a), true); // never spoken → speak
  assert.equal(leaf.shouldSpeak(sigA, a), false); // same → silent
  const b = leaf.classifyVerdict(
    { syntax: [{ file: 'x.js', message: 'boom' }], guards: [] },
    { checkedCount: 1 },
  );
  assert.equal(leaf.shouldSpeak(sigA, b), true); // changed → speak again
});

test('buildVerdictFeedback: incorrect → first-person directive + display naming files & reasons', () => {
  const v = leaf.classifyVerdict(
    { syntax: [{ file: 'a.js', line: 1, message: 'bad' }], guards: [] },
    { checkedCount: 1 },
  );
  const fb = leaf.buildVerdictFeedback(v, { files: ['a.js'] });
  assert.match(fb.directive, /\[SYSTEM:/);
  assert.match(fb.directive, /不对/);
  assert.match(fb.directive, /a\.js/);
  assert.match(fb.display, /❌/);
  assert.match(fb.display, /a\.js/);
});

test('buildVerdictFeedback: correct → non-blocking confirmation, includes file count', () => {
  const v = leaf.classifyVerdict({ syntax: [], guards: [] }, { checkedCount: 3 });
  const fb = leaf.buildVerdictFeedback(v, { files: ['a.js', 'b.js', 'c.js'] });
  assert.match(fb.directive, /没有发现阻断性问题/);
  assert.match(fb.display, /✅/);
  assert.match(fb.display, /3/);
});

test('buildVerdictFeedback: uncertain → explicitly refuses to claim correctness', () => {
  const v = leaf.classifyVerdict({ syntax: [], guards: [] }, { checkedCount: 0 });
  const fb = leaf.buildVerdictFeedback(v, { files: ['notes.md'] });
  assert.match(fb.directive, /无法判断对错/);
  assert.match(fb.display, /❓/);
});

test('fail-soft: buildVerdictFeedback tolerates junk verdict', () => {
  const fb = leaf.buildVerdictFeedback(null, {});
  assert.ok(fb.directive && fb.display);
  assert.match(fb.directive, /无法判断/);
});
