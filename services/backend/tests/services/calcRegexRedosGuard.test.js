'use strict';

/**
 * calcRegexRedosGuard — Chinese-math ReDoS guard for localBrainCalc.
 *
 * The `_isCalcIntent` line `\d+\s*的\s*\d+\s*次方` and the five `_cnMathMap`
 * `(\d+)\s*的…` rewrite entries backtracked a greedy digit run at every `/g`
 * start position when the trailing anchor failed, giving O(n^2). A crafted
 * offline message `计算 9…9的` reaches this via `localReasoning.reason` →
 * `isCalcIntent`/`detectCalc` (no 500-char cap on that path), freezing the turn
 * (~4.9 s at N=20000, ~22 s at N=100000). The guard bounds the digit quantifier
 * to `\d{1,64}` (KHY_CALC_REGEX_LINEAR, default on), making it linear while
 * staying byte-identical on every realistic input.
 */

const PATH = require.resolve('../../src/services/localBrainCalc');

function fresh() {
  delete require.cache[PATH];
  return require(PATH);
}

function elapsedMs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

describe('calcRegexRedosGuard — Chinese-math ReDoS', () => {
  afterEach(() => {
    delete process.env.KHY_CALC_REGEX_LINEAR;
    delete require.cache[PATH];
  });

  it('default: gate is enabled', () => {
    const calc = fresh();
    expect(calc._calcRegexLinearEnabled()).toBe(true);
  });

  it('ON: isCalcIntent stays linear on a huge digit run + 的', () => {
    const calc = fresh();
    const q = '计算 ' + '9'.repeat(100000) + '的';
    const ms = elapsedMs(() => calc.isCalcIntent(q));
    expect(ms).toBeLessThan(1000); // was ~22000ms unbounded
  });

  it('ON: detectCalc stays linear on a huge digit run + 的', () => {
    const calc = fresh();
    const q = '计算 ' + '9'.repeat(80000) + '的';
    const ms = elapsedMs(() => calc.detectCalc(q));
    expect(ms).toBeLessThan(1000); // was multi-second unbounded
  });

  it('OFF: legacy path reproduces the quadratic freeze (load-bearing)', () => {
    process.env.KHY_CALC_REGEX_LINEAR = '0';
    const calc = fresh();
    expect(calc._calcRegexLinearEnabled()).toBe(false);
    const q = '计算 ' + '9'.repeat(20000) + '的';
    const ms = elapsedMs(() => { calc.isCalcIntent(q); calc.detectCalc(q); });
    expect(ms).toBeGreaterThan(500); // quadratic is genuinely present when off
  });

  it('byte-identical rewrite ON vs OFF on realistic Chinese-math inputs', () => {
    const on = fresh();
    process.env.KHY_CALC_REGEX_LINEAR = '0';
    const off = fresh();
    delete process.env.KHY_CALC_REGEX_LINEAR;
    const cases = [
      '计算 2的10次方', '算一下 100的平方', '8开方等于几', '计算 3.14*2+1',
      '1000的3次方', '2的64次方', 'compute 2**10', '计算 (1+2)*3',
      '5的立方', '16的平方根',
    ];
    for (const q of cases) {
      const a = on.detectCalc(q);
      const b = off.detectCalc(q);
      expect(a.expr).toBe(b.expr);
      expect(JSON.stringify(on.executeCalc(a))).toBe(JSON.stringify(off.executeCalc(b)));
    }
  });

  it('numbers up to 64 digits still participate in the Chinese-sugar rewrite', () => {
    const calc = fresh();
    const base = '9'.repeat(64);
    const plan = calc.detectCalc(`${base}的2次方`);
    expect(plan.expr).toBe(`Math.pow(${base},2)`);
  });

  it('a >64-digit run no longer forms a single sugar number (pathological cap)', () => {
    const calc = fresh();
    const base = '9'.repeat(80);
    const plan = calc.detectCalc(`${base}的2次方`);
    // The full 80-digit run is not captured as one Math.pow base (would be
    // Infinity anyway); the rewrite no longer treats it as a computation.
    expect(plan.expr).not.toBe(`Math.pow(${base},2)`);
  });

  it('ordinary arithmetic and safeEval remain intact', () => {
    const calc = fresh();
    expect(calc.executeCalc(calc.detectCalc('2的10次方')).result).toBe(1024);
    expect(calc.executeCalc(calc.detectCalc('计算 3.14*2+1')).result).toBeCloseTo(7.28, 5);
    expect(calc.safeEvalArithmetic('1 + 2 * 3')).toBe(7);
    expect(calc.safeEvalArithmetic('(1+2)*3')).toBe(9);
  });

  it('_buildCnMathMap preserves the 10-entry rewrite table order', () => {
    const calc = fresh();
    const map = calc._buildCnMathMap();
    expect(map).toHaveLength(10);
    // first five are the number-anchored rewrites, remainder are symbol swaps
    expect(map[0][1]).toBe('Math.pow($1,$2)');
    expect(map[4][1]).toBe('Math.sqrt($1)');
    expect(map[9][1]).toBe(')');
  });
});
