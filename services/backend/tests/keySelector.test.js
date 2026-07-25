'use strict';

const {
  STRATEGIES,
  normalizeStrategy,
  resolveStrategy,
  selectCandidate,
} = require('../src/services/gateway/keySelector');

describe('keySelector', () => {
  afterEach(() => {
    delete process.env.GATEWAY_KEY_SELECTION_STRATEGY;
    delete process.env.GATEWAY_KEY_SELECTION_STRATEGY_MAP;
  });

  test('normalizes strategy aliases', () => {
    expect(normalizeStrategy('rr')).toBe(STRATEGIES.ROUND_ROBIN);
    expect(normalizeStrategy('least_fail')).toBe(STRATEGIES.LEAST_FAIL);
    expect(normalizeStrategy('usage')).toBe(STRATEGIES.LEAST_USED);
    expect(normalizeStrategy('balanced')).toBe(STRATEGIES.HYBRID);
  });

  test('resolves provider-specific strategy overrides', () => {
    process.env.GATEWAY_KEY_SELECTION_STRATEGY = 'round-robin';
    process.env.GATEWAY_KEY_SELECTION_STRATEGY_MAP = JSON.stringify({
      relay: 'least-used',
    });
    expect(resolveStrategy('relay')).toBe(STRATEGIES.LEAST_USED);
    expect(resolveStrategy('api')).toBe(STRATEGIES.ROUND_ROBIN);
  });

  test('selects least-fail candidate deterministically', () => {
    const selected = selectCandidate([
      { keyId: 'a', key: 'ka', priority: 1, totalFailures: 3, totalRequests: 10 },
      { keyId: 'b', key: 'kb', priority: 1, totalFailures: 0, totalRequests: 5 },
      { keyId: 'c', key: 'kc', priority: 1, totalFailures: 1, totalRequests: 2 },
    ], {
      provider: 'relay',
      strategy: STRATEGIES.LEAST_FAIL,
    });
    expect(selected.keyId).toBe('b');
  });

  test('round-robin stays inside top priority group', () => {
    const candidates = [
      { keyId: 'a', key: 'ka', priority: 2, totalFailures: 0, totalRequests: 0 },
      { keyId: 'b', key: 'kb', priority: 2, totalFailures: 0, totalRequests: 0 },
      { keyId: 'c', key: 'kc', priority: 1, totalFailures: 0, totalRequests: 0 },
    ];
    const first = selectCandidate(candidates, { provider: 'relay', strategy: STRATEGIES.ROUND_ROBIN });
    const second = selectCandidate(candidates, { provider: 'relay', strategy: STRATEGIES.ROUND_ROBIN });
    expect(['a', 'b']).toContain(first.keyId);
    expect(['a', 'b']).toContain(second.keyId);
    expect(first.keyId).not.toBe(second.keyId);
  });
});
