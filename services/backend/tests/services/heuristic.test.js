'use strict';

/**
 * Phase B (§4.B) — cost-to-goal heuristic h(s) over the acceptance pack.
 *
 * These suites assert the MATHEMATICAL PROPERTIES the design relies on:
 *   - Admissibility: hAdmissible never over-estimates true remaining cost.
 *   - Monotonicity: satisfying a required criterion strictly decreases h.
 *   - Goal: atGoal / h===0 exactly when no required criterion is unsatisfied.
 *   - Stagnation: shouldCalibrate fires iff h made no progress while work remains.
 */

const {
  computeHeuristic,
  shouldCalibrate,
  costPerCriterion,
  optionalWeight,
} = require('../../src/services/heuristic');

// Build a delivery-gate-shaped report from a compact spec.
// spec entries: { required: bool, pass: bool }
function makeReport(spec) {
  const results = spec.map((s, i) => ({
    id: `c${i}`,
    label: `criterion ${i}`,
    phase: 1,
    required: !!s.required,
    status: s.pass ? 'pass' : 'fail',
  }));
  return { results };
}

// The minimal *true* remaining cost to reach a PASS verdict is the number of
// unsatisfied REQUIRED criteria (each needs at least one action).
function trueMinRemainingCost(spec) {
  return spec.filter((s) => s.required && !s.pass).length;
}

describe('heuristic env defaults', () => {
  it('costPerCriterion defaults to 1 and is admissible (<= 1)', () => {
    expect(costPerCriterion()).toBeLessThanOrEqual(1);
    expect(costPerCriterion()).toBe(1);
  });
  it('optionalWeight defaults within [0, 1]', () => {
    expect(optionalWeight()).toBeGreaterThanOrEqual(0);
    expect(optionalWeight()).toBeLessThanOrEqual(1);
  });
});

describe('admissibility: hAdmissible <= true remaining cost', () => {
  const specs = [
    [],
    [{ required: true, pass: false }],
    [{ required: true, pass: false }, { required: true, pass: false }, { required: true, pass: true }],
    [{ required: true, pass: false }, { required: false, pass: false }, { required: false, pass: false }],
    [{ required: false, pass: false }, { required: false, pass: false }],
    Array.from({ length: 20 }, (_, i) => ({ required: true, pass: i % 2 === 0 })),
  ];

  it('holds for the default unit cost on every spec', () => {
    for (const spec of specs) {
      const m = computeHeuristic(makeReport(spec));
      // Admissibility w.r.t. reaching a PASS verdict.
      expect(m.hAdmissible).toBeLessThanOrEqual(trueMinRemainingCost(spec));
    }
  });

  it('holds for any per-criterion cost in [0, 1] (admissible regime)', () => {
    const spec = specs[2];
    for (const cpc of [0, 0.1, 0.5, 0.99, 1]) {
      const m = computeHeuristic(makeReport(spec), { costPerCriterion: cpc });
      expect(m.hAdmissible).toBeLessThanOrEqual(trueMinRemainingCost(spec));
    }
  });

  it('clamps an out-of-range cost back into the admissible regime', () => {
    const spec = [{ required: true, pass: false }, { required: true, pass: false }];
    // A cost > 1 would break admissibility; the module must clamp to 1.
    const m = computeHeuristic(makeReport(spec), { costPerCriterion: 5 });
    expect(m.costPerCriterion).toBe(1);
    expect(m.hAdmissible).toBeLessThanOrEqual(trueMinRemainingCost(spec));
  });

  it('hAdmissible never exceeds h (optional term is non-negative)', () => {
    for (const spec of specs) {
      const m = computeHeuristic(makeReport(spec));
      expect(m.hAdmissible).toBeLessThanOrEqual(m.h);
    }
  });
});

describe('monotonicity: satisfying a required criterion strictly decreases h', () => {
  it('decreases h and hAdmissible when one more required criterion passes', () => {
    const before = computeHeuristic(makeReport([
      { required: true, pass: false },
      { required: true, pass: false },
      { required: true, pass: false },
    ]));
    const after = computeHeuristic(makeReport([
      { required: true, pass: true }, // newly satisfied
      { required: true, pass: false },
      { required: true, pass: false },
    ]));
    expect(after.hAdmissible).toBeLessThan(before.hAdmissible);
    expect(after.h).toBeLessThan(before.h);
    expect(before.hAdmissible - after.hAdmissible).toBeCloseTo(before.costPerCriterion, 10);
  });

  it('satisfying an optional criterion decreases h but not hAdmissible', () => {
    const before = computeHeuristic(makeReport([
      { required: true, pass: false },
      { required: false, pass: false },
    ]));
    const after = computeHeuristic(makeReport([
      { required: true, pass: false },
      { required: false, pass: true },
    ]));
    expect(after.hAdmissible).toBe(before.hAdmissible); // required path unchanged
    expect(after.h).toBeLessThan(before.h);             // optional progress still visible
  });
});

describe('goal condition: atGoal / h===0', () => {
  it('atGoal true and hAdmissible 0 when no required criterion is unsatisfied', () => {
    const m = computeHeuristic(makeReport([
      { required: true, pass: true },
      { required: false, pass: false }, // optional unmet does not block goal
    ]));
    expect(m.atGoal).toBe(true);
    expect(m.hAdmissible).toBe(0);
  });

  it('h === 0 exactly when everything (required + optional) is satisfied', () => {
    const allPass = computeHeuristic(makeReport([
      { required: true, pass: true },
      { required: false, pass: true },
    ]));
    expect(allPass.h).toBe(0);
    expect(allPass.atGoal).toBe(true);

    const optionalLeft = computeHeuristic(makeReport([
      { required: true, pass: true },
      { required: false, pass: false },
    ]));
    expect(optionalLeft.atGoal).toBe(true);
    expect(optionalLeft.h).toBeGreaterThan(0); // optional residue keeps h > 0
  });

  it('empty pack is trivially at goal', () => {
    const m = computeHeuristic(makeReport([]));
    expect(m.atGoal).toBe(true);
    expect(m.h).toBe(0);
  });

  it('tolerates malformed input without throwing', () => {
    expect(() => computeHeuristic(null)).not.toThrow();
    expect(computeHeuristic(undefined).atGoal).toBe(true);
    expect(computeHeuristic({ results: 'not-an-array' }).h).toBe(0);
  });
});

describe('shouldCalibrate: stagnation detection', () => {
  it('fires when h does not strictly decrease and work remains', () => {
    expect(shouldCalibrate(2, 2)).toBe(true);   // flat -> stagnant
    expect(shouldCalibrate(2, 2.5)).toBe(true); // increased -> stagnant
  });

  it('does not fire when h made progress', () => {
    expect(shouldCalibrate(2, 1)).toBe(false);
    expect(shouldCalibrate(2, 1.999)).toBe(false); // strict decrease beyond epsilon
  });

  it('does not fire at the goal (currH <= 0)', () => {
    expect(shouldCalibrate(1, 0)).toBe(false);
    expect(shouldCalibrate(0, 0)).toBe(false);
  });

  it('is safe on non-finite inputs', () => {
    expect(shouldCalibrate(NaN, 1)).toBe(false);
    expect(shouldCalibrate(1, NaN)).toBe(false);
    expect(shouldCalibrate(undefined, 1)).toBe(false);
  });
});
