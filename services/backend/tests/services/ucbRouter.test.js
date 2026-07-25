'use strict';

/**
 * ucbRouter.test.js — Phase C-1 of the CB-SSP redesign (design doc §4.C).
 *
 * Asserts the mathematical properties the design doc requires of the bandit
 * router:
 *   1. Reward shape: r = success ? speed(latency) : 0, monotone in speed.
 *   2. UCB1 selection formula correctness: value = μ̂ + c·√(2 ln N / n).
 *   3. Forced exploration: an unpulled arm is selected before any pulled arm.
 *   4. Sublinear regret: over T pulls against fixed arm means, cumulative regret
 *      grows sublinearly (regret-per-round shrinks as T grows) and the best arm
 *      dominates the pull distribution — the O(ln T) guarantee, statistically.
 *   5. Cooldown folded into exploration: a cooling arm is damped vs. an identical
 *      non-cooling arm.
 *   6. Failover-order prior: with zero evidence the ranking follows the user order.
 *   7. Zero magic numbers: c / refLatency / priorWeight are all env-tunable.
 */

const ucb = require('../../src/services/gateway/ucbRouter');

// A tiny deterministic LCG so the statistical test is reproducible without
// Math.random (no seed flakiness across runs / machines).
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

beforeEach(() => {
  ucb._reset();
  delete process.env.KHY_UCB_EXPLORATION;
  delete process.env.KHY_UCB_REF_LATENCY_MS;
  delete process.env.KHY_UCB_NEUTRAL_SPEED;
  delete process.env.KHY_UCB_PRIOR_WEIGHT;
});

describe('reward shape: success rate × speed', () => {
  test('failure earns zero reward regardless of latency', () => {
    expect(ucb.outcomeReward({ success: false, latencyMs: 10 })).toBe(0);
    expect(ucb.outcomeReward({ success: false })).toBe(0);
    expect(ucb.outcomeReward({})).toBe(0);
  });

  test('speed reward is 1 at/under the reference and decays monotonically', () => {
    process.env.KHY_UCB_REF_LATENCY_MS = '1000';
    expect(ucb.speedReward(500)).toBe(1); // under reference → full credit
    expect(ucb.speedReward(1000)).toBe(1); // at reference → full credit
    expect(ucb.speedReward(2000)).toBeCloseTo(0.5, 10); // 1000/2000
    expect(ucb.speedReward(4000)).toBeCloseTo(0.25, 10);
    // strictly decreasing past the reference
    expect(ucb.speedReward(2000)).toBeGreaterThan(ucb.speedReward(4000));
  });

  test('successful outcome with no latency earns the neutral mid credit', () => {
    process.env.KHY_UCB_NEUTRAL_SPEED = '0.5';
    expect(ucb.outcomeReward({ success: true })).toBe(0.5);
  });
});

describe('UCB1 selection formula correctness', () => {
  test('value = mean + c·sqrt(2 ln N / n) for a pulled arm', () => {
    process.env.KHY_UCB_EXPLORATION = '1';
    process.env.KHY_UCB_REF_LATENCY_MS = '1000';
    // arm A: 3 successes at the reference latency → mean reward = 1, n=3
    for (let i = 0; i < 3; i++) ucb.recordOutcome('A', { success: true, latencyMs: 1000 });
    // arm B: 1 success → mean 1, n=1
    ucb.recordOutcome('B', { success: true, latencyMs: 1000 });
    const N = 4;
    const ranked = ucb.rank(['A', 'B'], { priorOrder: null });
    const a = ranked.find((r) => r.adapter === 'a');
    const b = ranked.find((r) => r.adapter === 'b');
    const expA = 1 + Math.sqrt((2 * Math.log(N)) / 3);
    const expB = 1 + Math.sqrt((2 * Math.log(N)) / 1);
    expect(a.value).toBeCloseTo(expA, 10);
    expect(b.value).toBeCloseTo(expB, 10);
    // equal means → the LESS-sampled arm (B) has the larger exploration bonus
    expect(b.value).toBeGreaterThan(a.value);
    expect(ranked[0].adapter).toBe('b');
  });

  test('exploration constant scales the bonus (env-tunable, no magic number)', () => {
    process.env.KHY_UCB_REF_LATENCY_MS = '1000';
    for (let i = 0; i < 2; i++) ucb.recordOutcome('A', { success: true, latencyMs: 1000 });
    ucb.recordOutcome('B', { success: true, latencyMs: 1000 });
    process.env.KHY_UCB_EXPLORATION = '0'; // greedy: bonus vanishes → equal means tie
    const greedy = ucb.rank(['A', 'B'], { priorOrder: null });
    expect(greedy.find((r) => r.adapter === 'a').value)
      .toBeCloseTo(greedy.find((r) => r.adapter === 'b').value, 10);
    process.env.KHY_UCB_EXPLORATION = '2'; // explore hard: under-sampled B wins big
    const eager = ucb.rank(['A', 'B'], { priorOrder: null });
    expect(eager[0].adapter).toBe('b');
  });
});

describe('forced exploration of unpulled arms', () => {
  test('an unpulled arm outranks any pulled arm', () => {
    ucb.recordOutcome('seen', { success: true, latencyMs: 1 }); // great history
    const ranked = ucb.rank(['seen', 'fresh'], { priorOrder: null });
    expect(ranked[0].adapter).toBe('fresh');
    expect(ranked[0].value).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('cooldown folded into the exploration term', () => {
  test('a cooling arm is damped below an identical non-cooling arm', () => {
    process.env.KHY_UCB_REF_LATENCY_MS = '1000';
    // two arms with identical history
    for (let i = 0; i < 2; i++) {
      ucb.recordOutcome('hot', { success: true, latencyMs: 1000 });
      ucb.recordOutcome('cool', { success: true, latencyMs: 1000 });
    }
    const ranked = ucb.rank(['hot', 'cool'], {
      priorOrder: null,
      cooldownByKey: { cool: { remainingMs: 30000, maxMs: 30000 } }, // fully cooling
    });
    const hot = ranked.find((r) => r.adapter === 'hot');
    const cool = ranked.find((r) => r.adapter === 'cool');
    expect(hot.value).toBeGreaterThan(cool.value);
    // full damp removes the entire exploration bonus → cool collapses to its mean
    expect(cool.value).toBeCloseTo(cool.mean, 10);
  });

  test('cooldownDamp is 0 when idle and →1 as remaining approaches the max', () => {
    expect(ucb.cooldownDamp(0, 1000)).toBe(0);
    expect(ucb.cooldownDamp(500, 1000)).toBeCloseTo(0.5, 10);
    expect(ucb.cooldownDamp(2000, 1000)).toBe(1); // clamped
  });
});

describe('failover-order prior seeds the cold-start ranking', () => {
  test('with zero evidence the ranking follows the pinned order', () => {
    process.env.KHY_UCB_PRIOR_WEIGHT = '1';
    const ranked = ucb.rank(['x', 'y', 'z'], { priorOrder: ['z', 'y', 'x'] });
    // unpulled arms all share +Inf, but the prior gives them real pulls so the
    // pinned head ('z') ranks first by mean.
    expect(ranked.map((r) => r.adapter)).toEqual(['z', 'y', 'x']);
  });

  test('prior never overwrites a well-sampled arm', () => {
    process.env.KHY_UCB_PRIOR_WEIGHT = '1';
    process.env.KHY_UCB_REF_LATENCY_MS = '1000';
    for (let i = 0; i < 5; i++) ucb.recordOutcome('learned', { success: true, latencyMs: 1000 });
    const before = ucb._getArmStats('learned');
    ucb.seedPrior(['learned', 'other']);
    const after = ucb._getArmStats('learned');
    expect(after.pulls).toBe(before.pulls); // untouched: 5 ≥ prior weight 1
    expect(after.rewardSum).toBeCloseTo(before.rewardSum, 10);
  });
});

describe('sublinear regret (the O(ln T) guarantee, statistically)', () => {
  // Three Bernoulli arms; best mean = 0.9. We run the real UCB loop and measure
  // cumulative regret R(T) = Σ (μ* − μ_chosen). UCB1 ⇒ R(T) = O(ln T), so the
  // per-round regret R(T)/T must shrink as T grows, and the best arm must take
  // the lion's share of pulls.
  function runBandit(T, seed) {
    ucb._reset();
    process.env.KHY_UCB_EXPLORATION = '1';
    process.env.KHY_UCB_REF_LATENCY_MS = '1';
    const means = { a: 0.9, b: 0.5, c: 0.2 };
    const best = 0.9;
    const rand = lcg(seed);
    const pulls = { a: 0, b: 0, c: 0 };
    let regret = 0;
    for (let t = 0; t < T; t++) {
      const choice = ucb.select(['a', 'b', 'c'], { priorOrder: null });
      const success = rand() < means[choice];
      // latency 1ms == reference ⇒ speed credit 1, so reward = success(0/1):
      ucb.recordOutcome(choice, { success, latencyMs: 1 });
      pulls[choice] += 1;
      regret += best - means[choice];
    }
    return { regret, pulls };
  }

  test('regret-per-round shrinks as T grows and the best arm dominates', () => {
    const short = runBandit(300, 12345);
    const long = runBandit(6000, 12345);

    const perRoundShort = short.regret / 300;
    const perRoundLong = long.regret / 6000;

    // Sublinearity: average regret per round strictly decreases with horizon.
    expect(perRoundLong).toBeLessThan(perRoundShort);

    // The best arm 'a' should hold a clear majority of the long-run pulls.
    const fracBest = long.pulls.a / 6000;
    expect(fracBest).toBeGreaterThan(0.7);

    // Absolute sanity: total regret must stay far below the linear (always-worst)
    // bound. Worst case per round = 0.9 − 0.2 = 0.7 ⇒ linear bound 0.7·T.
    expect(long.regret).toBeLessThan(0.1 * 0.7 * 6000);
  });
});
