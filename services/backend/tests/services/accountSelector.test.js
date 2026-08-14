'use strict';

/**
 * accountSelector.test.js — Phase C-2 of the CB-SSP redesign (design doc §4.C).
 *
 * Asserts the load-balancing properties the design doc requires when replacing
 * sticky MRU account selection:
 *   1. loadKey orders by recency; never-used accounts are least loaded.
 *   2. LRU picks the least-loaded account exactly.
 *   3. LRU under repeated selection is round-robin → perfect balance (max−min ≤ 1).
 *   4. P2C drives the maximum load far below uniform-random selection (the
 *      "power of two choices" guarantee), measured statistically.
 *   5. policyForMode: only 'Balance' balances; other modes keep MRU (legacy).
 *   6. Zero magic numbers: the default policy is env-tunable.
 */

const selector = require('../../src/services/accountSelector');

// Deterministic LCG so the statistical tests are reproducible (no Math.random).
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

beforeEach(() => {
  delete process.env.KHY_ACCOUNT_BALANCE_POLICY;
});

describe('loadKey ordering', () => {
  test('never-used (null last_used_at) is least loaded', () => {
    expect(selector.loadKey({ id: 1, last_used_at: null })).toBe(0);
  });

  test('more recent last_used_at means higher load', () => {
    const older = { id: 1, last_used_at: '2020-01-01T00:00:00Z' };
    const newer = { id: 2, last_used_at: '2024-01-01T00:00:00Z' };
    expect(selector.loadKey(newer)).toBeGreaterThan(selector.loadKey(older));
  });

  test('falls back to created_at when never used', () => {
    const a = { id: 1, last_used_at: null, created_at: '2021-06-01T00:00:00Z' };
    expect(selector.loadKey(a)).toBe(Date.parse('2021-06-01T00:00:00Z'));
  });
});

describe('LRU selection', () => {
  test('selects the least-loaded (oldest) account', () => {
    const accounts = [
      { id: 1, last_used_at: '2024-03-01T00:00:00Z' },
      { id: 2, last_used_at: '2024-01-01T00:00:00Z' }, // oldest
      { id: 3, last_used_at: '2024-02-01T00:00:00Z' },
    ];
    expect(selector.selectLru(accounts).id).toBe(2);
  });

  test('deterministic id tie-break when load is equal', () => {
    const accounts = [
      { id: 5, last_used_at: null },
      { id: 2, last_used_at: null },
      { id: 9, last_used_at: null },
    ];
    expect(selector.selectLru(accounts).id).toBe(2);
  });

  test('repeated LRU selection is round-robin → perfect balance (max−min ≤ 1)', () => {
    // 4 accounts, all never used. Each round: pick via LRU, stamp it as just-used.
    const N = 4;
    let clock = 1;
    const accounts = Array.from({ length: N }, (_, i) => ({ id: i + 1, last_used_at: null }));
    const picks = {};
    for (let round = 0; round < 4 * N; round++) {
      const chosen = selector.selectLru(accounts);
      picks[chosen.id] = (picks[chosen.id] || 0) + 1;
      chosen.last_used_at = new Date(clock++).toISOString(); // mark used "now"
    }
    const counts = Object.values(picks);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(counts).toHaveLength(N); // every account got used
  });
});

describe('P2C beats uniform-random on maximum load', () => {
  // Simulate T selections over N accounts; each chosen account's load grows.
  // Measure the spread (max − min pick count). P2C should be markedly tighter
  // than uniform random — the power-of-two-choices guarantee.
  function simulate(pick, N, T, seed) {
    const rand = lcg(seed);
    const accounts = Array.from({ length: N }, (_, i) => ({ id: i + 1, last_used_at: null }));
    const counts = new Array(N).fill(0);
    let clock = 1;
    for (let t = 0; t < T; t++) {
      const chosen = pick(accounts, rand);
      const idx = chosen.id - 1;
      counts[idx] += 1;
      chosen.last_used_at = new Date(clock++).toISOString();
    }
    return { max: Math.max(...counts), min: Math.min(...counts) };
  }

  test('P2C spread is smaller than uniform-random spread', () => {
    const N = 8;
    const T = 4000;
    const p2c = simulate((accts, rand) => selector.selectPowerOfTwo(accts, rand), N, T, 777);
    const uniform = simulate((accts, rand) => {
      const i = Math.min(accts.length - 1, Math.floor(rand() * accts.length));
      return accts[i];
    }, N, T, 777);

    const p2cSpread = p2c.max - p2c.min;
    const uniformSpread = uniform.max - uniform.min;
    expect(p2cSpread).toBeLessThan(uniformSpread);
    // P2C keeps the max within a tight band of the mean (T/N = 500).
    expect(p2c.max).toBeLessThan(1.25 * (T / N));
  });

  test('selectPowerOfTwo always returns two-distinct comparison (degenerate sizes)', () => {
    expect(selector.selectPowerOfTwo([], lcg(1))).toBeNull();
    expect(selector.selectPowerOfTwo([{ id: 1, last_used_at: null }], lcg(1)).id).toBe(1);
    // With exactly two, it must compare both and return the less loaded one.
    const two = [
      { id: 1, last_used_at: '2024-05-01T00:00:00Z' },
      { id: 2, last_used_at: '2024-01-01T00:00:00Z' },
    ];
    expect(selector.selectPowerOfTwo(two, lcg(42)).id).toBe(2);
  });
});

describe('policyForMode: only Balance balances', () => {
  test("'Balance' maps to the balancing default policy", () => {
    expect(selector.policyForMode('Balance')).toBe('p2c');
  });

  test('other modes keep legacy MRU', () => {
    expect(selector.policyForMode('Failover')).toBe('mru');
    expect(selector.policyForMode('Sticky')).toBe('mru');
    expect(selector.policyForMode(undefined)).toBe('mru');
  });

  test('default balancing policy is env-tunable (no magic number)', () => {
    process.env.KHY_ACCOUNT_BALANCE_POLICY = 'lru';
    expect(selector.policyForMode('Balance')).toBe('lru');
    process.env.KHY_ACCOUNT_BALANCE_POLICY = 'garbage';
    expect(selector.policyForMode('Balance')).toBe('p2c'); // invalid → safe default
  });
});

describe('pickBalanced dispatch', () => {
  const accounts = [
    { id: 1, last_used_at: '2024-03-01T00:00:00Z' },
    { id: 2, last_used_at: '2024-01-01T00:00:00Z' }, // least loaded
    { id: 3, last_used_at: '2024-05-01T00:00:00Z' }, // most loaded
  ];

  test('lru → least loaded, mru → most loaded (legacy sticky)', () => {
    expect(selector.pickBalanced(accounts, { policy: 'lru' }).id).toBe(2);
    expect(selector.pickBalanced(accounts, { policy: 'mru' }).id).toBe(3);
  });

  test('empty pool → null', () => {
    expect(selector.pickBalanced([], { policy: 'p2c' })).toBeNull();
  });
});
