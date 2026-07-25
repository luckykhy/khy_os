'use strict';

/**
 * lrtaBackfill.test.js — Phase A of the CB-SSP redesign (design doc §4.A).
 *
 * Asserts the mathematical properties the design doc requires of the value
 * backfill:
 *   1. Monotone non-increasing across trials (H_{k+1} <= H_k) — the doc's
 *      "跨 trial 价值回填使 h 单调不增" property.
 *   2. Correct backfill rule  H <- min(prevStoredH, g + h_k).
 *   3. Non-negative step cost g_k (resource delta) so monotonicity cannot break.
 *   4. Persistence round-trips and never poisons a future warm start.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Point the data home at an isolated temp dir BEFORE requiring the module so
// the sidecar persistence never touches a real ~/.khy directory.
const TMP_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-lrta-'));
process.env.KHY_DATA_HOME = TMP_DATA_HOME;

const {
  backfill,
  roundCost,
  stepCostWeight,
  loadLearnedHeuristic,
  saveLearnedHeuristic,
  clearLearnedHeuristic,
} = require('../../src/services/lrtaBackfill');

afterAll(() => {
  try { fs.rmSync(TMP_DATA_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('backfill: H <- min(prevStoredH, g + h_k)', () => {
  test('first trial (no prior) adopts g + h_k', () => {
    expect(backfill(Infinity, 2, 5)).toBe(7);
    expect(backfill(null, 0, 4)).toBe(4);
    expect(backfill(undefined, 1, 3)).toBe(4);
  });

  test('keeps the prior estimate when the new trial is worse', () => {
    expect(backfill(5, 3, 4)).toBe(5); // 3+4=7 > 5 -> keep 5
  });

  test('adopts the new estimate when the trial improves', () => {
    expect(backfill(10, 1, 4)).toBe(5); // 1+4=5 < 10 -> adopt 5
  });

  test('treats negative / non-finite inputs as their safe floor', () => {
    expect(backfill(8, -3, 4)).toBe(4);   // negative g clamped to 0
    expect(backfill(8, 2, -1)).toBe(2);   // negative h clamped to 0
    expect(backfill(8, NaN, 4)).toBe(4);  // NaN g -> 0
    expect(backfill(Infinity, NaN, NaN)).toBe(0);
  });
});

describe('monotonicity: running backfill is non-increasing across trials', () => {
  test('H_{k+1} <= H_k for an arbitrary sequence of trials', () => {
    // (stepCost, h_k) per trial — deliberately noisy, including a worse trial.
    const trials = [
      [1, 9], [0, 6], [2, 6], [1, 3], [0, 3], [5, 1], [0, 0],
    ];
    let H = Infinity;
    const series = [];
    for (const [g, h] of trials) {
      H = backfill(H, g, h);
      series.push(H);
    }
    for (let i = 1; i < series.length; i++) {
      expect(series[i]).toBeLessThanOrEqual(series[i - 1]);
    }
    // Reaches 0 once a trial observes the goal (h_k = 0, g = 0).
    expect(series[series.length - 1]).toBe(0);
  });

  test('a worse trial never raises the learned estimate', () => {
    let H = backfill(Infinity, 0, 4); // 4
    H = backfill(H, 100, 100);        // 200 > 4 -> still 4
    expect(H).toBe(4);
  });
});

describe('roundCost: non-negative resource delta', () => {
  test('scales iterations by the env weight', () => {
    const w = stepCostWeight();
    expect(roundCost({ iterations: 3 })).toBeCloseTo(3 * w);
  });

  test('never negative and tolerant of bad input', () => {
    expect(roundCost({ iterations: -5 })).toBe(0);
    expect(roundCost({ iterations: NaN })).toBe(0);
    expect(roundCost({})).toBe(0);
    expect(roundCost()).toBe(0);
  });

  test('env weight override is honoured and clamped >= 0', () => {
    const prev = process.env.KHY_LRTA_STEP_COST_WEIGHT;
    process.env.KHY_LRTA_STEP_COST_WEIGHT = '0';
    expect(roundCost({ iterations: 7 })).toBe(0);
    process.env.KHY_LRTA_STEP_COST_WEIGHT = '-4';
    expect(stepCostWeight()).toBe(0); // clamped
    if (prev === undefined) delete process.env.KHY_LRTA_STEP_COST_WEIGHT;
    else process.env.KHY_LRTA_STEP_COST_WEIGHT = prev;
  });
});

describe('persistence: warm start round-trip', () => {
  const cwd = '/tmp/khy-lrta-project-A';

  afterEach(() => clearLearnedHeuristic(cwd));

  test('save then load returns the persisted estimate', () => {
    expect(loadLearnedHeuristic(cwd)).toBeNull();
    saveLearnedHeuristic(cwd, 4.5, { taskId: 't1', round: 2, now: 123 });
    const rec = loadLearnedHeuristic(cwd);
    expect(rec).not.toBeNull();
    expect(rec.h).toBe(4.5);
    expect(rec.taskId).toBe('t1');
  });

  test('refuses to persist a non-finite value (never poisons warm start)', () => {
    saveLearnedHeuristic(cwd, Infinity, {});
    expect(loadLearnedHeuristic(cwd)).toBeNull();
    saveLearnedHeuristic(cwd, NaN, {});
    expect(loadLearnedHeuristic(cwd)).toBeNull();
  });

  test('different cwds are isolated', () => {
    const other = '/tmp/khy-lrta-project-B';
    saveLearnedHeuristic(cwd, 3, {});
    expect(loadLearnedHeuristic(other)).toBeNull();
    clearLearnedHeuristic(other);
  });

  test('a full trial sequence persists a monotone non-increasing warm start', () => {
    let H = loadLearnedHeuristic(cwd)?.h ?? Infinity;
    const observed = [];
    for (const [g, h] of [[1, 8], [0, 5], [2, 5], [0, 2]]) {
      H = backfill(H, g, h);
      saveLearnedHeuristic(cwd, H, {});
      observed.push(loadLearnedHeuristic(cwd).h);
    }
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i]).toBeLessThanOrEqual(observed[i - 1]);
    }
  });
});
