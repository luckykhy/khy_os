'use strict';
/**
 * verificationAgent.ensemble.test.js �?multi-skeptic adversarial voting.
 *
 * Pins the Phase-1 self-adversarial increment:
 *   - _tallyVotes is a deterministic, model-free majority vote where only
 *     decisive (PASS|FAIL) voters count; SKIP/PARTIAL/error abstain.
 *   - adversarialVerifyEnsemble / evidenceSufficiencyEnsemble are drop-in
 *     supersets that delegate to the single verifier at n<=1 (zero regression)
 *     and tally diverse-lens probes at n>1.
 */
const {
  _tallyVotes,
  adversarialVerify,
  adversarialVerifyEnsemble,
  evidenceSufficiencyEnsemble,
  ADVERSARIAL_LENSES,
  EVIDENCE_LENSES,
} = require('../../src/services/verificationAgent');
// ── _tallyVotes ────────────────────────────────────────────────────
// ── lens single-source sanity ──────────────────────────────────────
// ── adversarialVerifyEnsemble ──────────────────────────────────────
// ── evidenceSufficiencyEnsemble ────────────────────────────────────

describe('Verification Agent ensemble', () => {
  test('_tallyVotes: all PASS �?PASS', async () => {
      const r = _tallyVotes([{ verdict: 'PASS' }, { verdict: 'PASS' }, { verdict: 'PASS' }], { kind: 'checks' });
      expect(r.verdict).toBe('PASS');
      expect(r.ok).toBe(3);
      expect(r.fail).toBe(0);
  });

  test('_tallyVotes: majority FAIL �?FAIL with de-duplicated check evidence', async () => {
      const dup = { command: 'node -c a.js', output: 'SyntaxError', result: 'FAIL' };
      const r = _tallyVotes([
        { verdict: 'FAIL', checks: [dup] },
        { verdict: 'FAIL', checks: [{ ...dup }, { command: 'grep export', output: 'missing', result: 'FAIL' }] },
        { verdict: 'PASS', checks: [] },
      ], { kind: 'checks' });
      expect(r.verdict).toBe('FAIL');
      expect(r.fail).toBe(2);
      expect(r.ok).toBe(3);
      // dup collapsed to one, plus the unique grep check �?2 total.
      expect(r.checks.length).toBe(2);
  });

  test('_tallyVotes: tie below default majority �?PASS (1 FAIL of 3 decisive)', async () => {
      const r = _tallyVotes([{ verdict: 'FAIL' }, { verdict: 'PASS' }, { verdict: 'PASS' }], { kind: 'checks' });
      // quorum = ceil(3/2) = 2, only 1 FAIL �?PASS.
      expect(r.verdict).toBe('PASS');
  });

  test('_tallyVotes: explicit quorum=1 makes any FAIL decisive', async () => {
      const r = _tallyVotes([{ verdict: 'FAIL' }, { verdict: 'PASS' }, { verdict: 'PASS' }], { kind: 'checks', quorum: 1 });
      expect(r.verdict).toBe('FAIL');
  });

  test('_tallyVotes: all abstain (SKIP/PARTIAL/error) �?SKIP, never FAIL', async () => {
      const r = _tallyVotes([{ verdict: 'SKIP' }, { verdict: 'PARTIAL' }, { verdict: 'error' }], { kind: 'checks' });
      expect(r.verdict).toBe('SKIP');
      expect(r.ok).toBe(0);
      expect(r.fail).toBe(0);
  });

  test('_tallyVotes: abstentions do not lower the quorum denominator', async () => {
      // 2 SKIP + 1 FAIL: decisive ok=1, quorum=ceil(1/2)=1 �?FAIL on the lone decisive vote.
      const r = _tallyVotes([{ verdict: 'SKIP' }, { verdict: 'SKIP' }, { verdict: 'FAIL' }], { kind: 'checks' });
      expect(r.ok).toBe(1);
      expect(r.verdict).toBe('FAIL');
  });

  test('_tallyVotes: gaps kind aggregates and de-dups string gaps', async () => {
      const r = _tallyVotes([
        { verdict: 'FAIL', gaps: ['claim A unverified', 'claim A unverified'] },
        { verdict: 'FAIL', gaps: ['task half done'] },
      ], { kind: 'gaps' });
      expect(r.verdict).toBe('FAIL');
      expect(r.gaps.sort()).toEqual(['claim A unverified', 'task half done']);
  });

  test('lens tables are non-empty distinct perspectives', async () => {
      expect(ADVERSARIAL_LENSES.length >= 3).toBeTruthy();
      expect(EVIDENCE_LENSES.length >= 3).toBeTruthy();
      expect(new Set(ADVERSARIAL_LENSES).size).toBe(ADVERSARIAL_LENSES.length);
      expect(new Set(EVIDENCE_LENSES).size).toBe(EVIDENCE_LENSES.length);
  });

  test('adversarialVerifyEnsemble: n<=1 delegates to single verifier (no executeAI �?static)', async () => {
      const params = { files: [], cwd: process.cwd() }; // no executeAI
      const direct = await adversarialVerify(params);
      const viaEnsemble = await adversarialVerifyEnsemble({ ...params, n: 1 });
      expect(viaEnsemble._source).toBe(direct._source); // 'static'
      expect(viaEnsemble.verdict).toBe(direct.verdict);
  });

  test('adversarialVerifyEnsemble: n=3, 2 FAIL / 1 PASS �?FAIL', async () => {
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
      expect(r._source).toBe('ensemble');
      expect(r.verdict).toBe('FAIL');
      expect(r.fail).toBe(2);
      expect(r.ok).toBe(3);
  });

  test('adversarialVerifyEnsemble: n=3, 1 FAIL / 2 PASS �?PASS', async () => {
      let call = 0;
      const executeAI = async () => {
        call += 1;
        const verdict = call === 1 ? 'FAIL' : 'PASS';
        return '```json\n' + JSON.stringify({ verdict, checks: [] }) + '\n```';
      };
      const r = await adversarialVerifyEnsemble({ files: ['x.js'], cwd: process.cwd(), executeAI, n: 3 });
      expect(r.verdict).toBe('PASS');
  });

  test('adversarialVerifyEnsemble: executeAI throwing never blocks delivery (all abstain �?SKIP)', async () => {
      const executeAI = async () => { throw new Error('gateway down'); };
      const r = await adversarialVerifyEnsemble({ files: ['x.js'], cwd: process.cwd(), executeAI, n: 3 });
      expect(r.verdict).toBe('SKIP');
      expect(r.fail).toBe(0);
  });

  test('evidenceSufficiencyEnsemble: n=3, 2 FAIL / 1 PASS �?FAIL with aggregated gaps', async () => {
      let call = 0;
      const executeAI = async () => {
        call += 1;
        if (call <= 2) return JSON.stringify({ verdict: 'FAIL', gaps: [`gap${call}`] });
        return JSON.stringify({ verdict: 'PASS', gaps: [] });
      };
      const r = await evidenceSufficiencyEnsemble({
        taskDescription: 'research X', toolResults: [], draftConclusion: 'X is true', executeAI, n: 3,
      });
      expect(r._source).toBe('ensemble');
      expect(r.verdict).toBe('FAIL');
      expect(r.gaps.sort()).toEqual(['gap1', 'gap2']);
  });

  test('evidenceSufficiencyEnsemble: n<=1 delegates (no executeAI �?SKIP static)', async () => {
      const r = await evidenceSufficiencyEnsemble({ taskDescription: 't', toolResults: [], n: 1 });
      expect(r.verdict).toBe('SKIP');
      expect(r._source).not.toBe('ensemble');
  });

});

