'use strict';

/**
 * verificationAgent.ensemble.test.js — multi-skeptic adversarial voting.
 *
 * Pins the Phase-1 self-adversarial increment:
 *   - _tallyVotes is a deterministic, model-free majority vote where only
 *     decisive (PASS|FAIL) voters count; SKIP/PARTIAL/error abstain.
 *   - adversarialVerifyEnsemble / evidenceSufficiencyEnsemble are drop-in
 *     supersets that delegate to the single verifier at n<=1 (zero regression)
 *     and tally diverse-lens probes at n>1.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  _tallyVotes,
  adversarialVerify,
  adversarialVerifyEnsemble,
  evidenceSufficiencyEnsemble,
  ADVERSARIAL_LENSES,
  EVIDENCE_LENSES,
} = require('../../src/services/verificationAgent');

// ── _tallyVotes ────────────────────────────────────────────────────

test('_tallyVotes: all PASS → PASS', () => {
  const r = _tallyVotes([{ verdict: 'PASS' }, { verdict: 'PASS' }, { verdict: 'PASS' }], { kind: 'checks' });
  assert.strictEqual(r.verdict, 'PASS');
  assert.strictEqual(r.ok, 3);
  assert.strictEqual(r.fail, 0);
});

test('_tallyVotes: majority FAIL → FAIL with de-duplicated check evidence', () => {
  const dup = { command: 'node -c a.js', output: 'SyntaxError', result: 'FAIL' };
  const r = _tallyVotes([
    { verdict: 'FAIL', checks: [dup] },
    { verdict: 'FAIL', checks: [{ ...dup }, { command: 'grep export', output: 'missing', result: 'FAIL' }] },
    { verdict: 'PASS', checks: [] },
  ], { kind: 'checks' });
  assert.strictEqual(r.verdict, 'FAIL');
  assert.strictEqual(r.fail, 2);
  assert.strictEqual(r.ok, 3);
  // dup collapsed to one, plus the unique grep check → 2 total.
  assert.strictEqual(r.checks.length, 2);
});

test('_tallyVotes: tie below default majority → PASS (1 FAIL of 3 decisive)', () => {
  const r = _tallyVotes([{ verdict: 'FAIL' }, { verdict: 'PASS' }, { verdict: 'PASS' }], { kind: 'checks' });
  // quorum = ceil(3/2) = 2, only 1 FAIL → PASS.
  assert.strictEqual(r.verdict, 'PASS');
});

test('_tallyVotes: explicit quorum=1 makes any FAIL decisive', () => {
  const r = _tallyVotes([{ verdict: 'FAIL' }, { verdict: 'PASS' }, { verdict: 'PASS' }], { kind: 'checks', quorum: 1 });
  assert.strictEqual(r.verdict, 'FAIL');
});

test('_tallyVotes: all abstain (SKIP/PARTIAL/error) → SKIP, never FAIL', () => {
  const r = _tallyVotes([{ verdict: 'SKIP' }, { verdict: 'PARTIAL' }, { verdict: 'error' }], { kind: 'checks' });
  assert.strictEqual(r.verdict, 'SKIP');
  assert.strictEqual(r.ok, 0);
  assert.strictEqual(r.fail, 0);
});

test('_tallyVotes: abstentions do not lower the quorum denominator', () => {
  // 2 SKIP + 1 FAIL: decisive ok=1, quorum=ceil(1/2)=1 → FAIL on the lone decisive vote.
  const r = _tallyVotes([{ verdict: 'SKIP' }, { verdict: 'SKIP' }, { verdict: 'FAIL' }], { kind: 'checks' });
  assert.strictEqual(r.ok, 1);
  assert.strictEqual(r.verdict, 'FAIL');
});

test('_tallyVotes: gaps kind aggregates and de-dups string gaps', () => {
  const r = _tallyVotes([
    { verdict: 'FAIL', gaps: ['claim A unverified', 'claim A unverified'] },
    { verdict: 'FAIL', gaps: ['task half done'] },
  ], { kind: 'gaps' });
  assert.strictEqual(r.verdict, 'FAIL');
  assert.deepStrictEqual(r.gaps.sort(), ['claim A unverified', 'task half done']);
});

// ── lens single-source sanity ──────────────────────────────────────

test('lens tables are non-empty distinct perspectives', () => {
  assert.ok(ADVERSARIAL_LENSES.length >= 3);
  assert.ok(EVIDENCE_LENSES.length >= 3);
  assert.strictEqual(new Set(ADVERSARIAL_LENSES).size, ADVERSARIAL_LENSES.length);
  assert.strictEqual(new Set(EVIDENCE_LENSES).size, EVIDENCE_LENSES.length);
});

// ── adversarialVerifyEnsemble ──────────────────────────────────────

test('adversarialVerifyEnsemble: n<=1 delegates to single verifier (no executeAI → static)', async () => {
  const params = { files: [], cwd: process.cwd() }; // no executeAI
  const direct = await adversarialVerify(params);
  const viaEnsemble = await adversarialVerifyEnsemble({ ...params, n: 1 });
  assert.strictEqual(viaEnsemble._source, direct._source); // 'static'
  assert.strictEqual(viaEnsemble.verdict, direct.verdict);
});

test('adversarialVerifyEnsemble: n=3, 2 FAIL / 1 PASS → FAIL', async () => {
  let call = 0;
  const executeAI = async () => {
    call += 1;
    const verdict = call <= 2 ? 'FAIL' : 'PASS';
    return '```json\n' + JSON.stringify({
      verdict,
      checks: [{ command: `check${call}`, output: 'out', result: verdict === 'FAIL' ? 'FAIL' : 'PASS' }],
    }) + '\n```';
  };
  const r = await adversarialVerifyEnsemble({ files: ['x.js'], cwd: process.cwd(), executeAI, n: 3 });
  assert.strictEqual(r._source, 'ensemble');
  assert.strictEqual(r.verdict, 'FAIL');
  assert.strictEqual(r.fail, 2);
  assert.strictEqual(r.ok, 3);
});

test('adversarialVerifyEnsemble: n=3, 1 FAIL / 2 PASS → PASS', async () => {
  let call = 0;
  const executeAI = async () => {
    call += 1;
    const verdict = call === 1 ? 'FAIL' : 'PASS';
    return '```json\n' + JSON.stringify({ verdict, checks: [] }) + '\n```';
  };
  const r = await adversarialVerifyEnsemble({ files: ['x.js'], cwd: process.cwd(), executeAI, n: 3 });
  assert.strictEqual(r.verdict, 'PASS');
});

test('adversarialVerifyEnsemble: executeAI throwing never blocks delivery (all abstain → SKIP)', async () => {
  const executeAI = async () => { throw new Error('gateway down'); };
  const r = await adversarialVerifyEnsemble({ files: ['x.js'], cwd: process.cwd(), executeAI, n: 3 });
  assert.strictEqual(r.verdict, 'SKIP');
  assert.strictEqual(r.fail, 0);
});

// ── evidenceSufficiencyEnsemble ────────────────────────────────────

test('evidenceSufficiencyEnsemble: n=3, 2 FAIL / 1 PASS → FAIL with aggregated gaps', async () => {
  let call = 0;
  const executeAI = async () => {
    call += 1;
    if (call <= 2) return JSON.stringify({ verdict: 'FAIL', gaps: [`gap${call}`] });
    return JSON.stringify({ verdict: 'PASS', gaps: [] });
  };
  const r = await evidenceSufficiencyEnsemble({
    taskDescription: 'research X', toolResults: [], draftConclusion: 'X is true', executeAI, n: 3,
  });
  assert.strictEqual(r._source, 'ensemble');
  assert.strictEqual(r.verdict, 'FAIL');
  assert.deepStrictEqual(r.gaps.sort(), ['gap1', 'gap2']);
});

test('evidenceSufficiencyEnsemble: n<=1 delegates (no executeAI → SKIP static)', async () => {
  const r = await evidenceSufficiencyEnsemble({ taskDescription: 't', toolResults: [], n: 1 });
  assert.strictEqual(r.verdict, 'SKIP');
  assert.notStrictEqual(r._source, 'ensemble');
});
