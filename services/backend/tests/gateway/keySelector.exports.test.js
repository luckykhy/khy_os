'use strict';

/**
 * Tests for gateway/keySelector.js — key selection strategies.
 */

const keySelector = require('../../src/services/gateway/keySelector');

describe('gateway/keySelector exports', () => {
  test('exports STRATEGIES frozen object', () => {
    expect(keySelector.STRATEGIES).toBeDefined();
    expect(keySelector.STRATEGIES.ROUND_ROBIN).toBe('round-robin');
    expect(keySelector.STRATEGIES.LEAST_FAIL).toBe('least-fail');
    expect(keySelector.STRATEGIES.LEAST_USED).toBe('least-used');
    expect(keySelector.STRATEGIES.HYBRID).toBe('hybrid');
  });

  test('exports expected functions', () => {
    expect(typeof keySelector.normalizeStrategy).toBe('function');
    expect(typeof keySelector.parseStrategyMap).toBe('function');
    expect(typeof keySelector.resolveStrategy).toBe('function');
    expect(typeof keySelector.selectCandidate).toBe('function');
  });
});

describe('normalizeStrategy', () => {
  test('defaults to round-robin for empty input', () => {
    expect(keySelector.normalizeStrategy('')).toBe('round-robin');
    expect(keySelector.normalizeStrategy(null)).toBe('round-robin');
  });

  test('normalizes various round-robin aliases', () => {
    expect(keySelector.normalizeStrategy('round-robin')).toBe('round-robin');
    expect(keySelector.normalizeStrategy('roundrobin')).toBe('round-robin');
    expect(keySelector.normalizeStrategy('rr')).toBe('round-robin');
  });

  test('normalizes least-fail aliases', () => {
    expect(keySelector.normalizeStrategy('least-fail')).toBe('least-fail');
    expect(keySelector.normalizeStrategy('least_fail')).toBe('least-fail');
    expect(keySelector.normalizeStrategy('fail')).toBe('least-fail');
  });

  test('normalizes hybrid aliases', () => {
    expect(keySelector.normalizeStrategy('hybrid')).toBe('hybrid');
    expect(keySelector.normalizeStrategy('balanced')).toBe('hybrid');
  });
});

describe('selectCandidate', () => {
  const candidates = [
    { keyId: 'k1', key: 'sk-aaa', priority: 10, totalRequests: 5, totalFailures: 0 },
    { keyId: 'k2', key: 'sk-bbb', priority: 10, totalRequests: 10, totalFailures: 2 },
    { keyId: 'k3', key: 'sk-ccc', priority: 5, totalRequests: 1, totalFailures: 0 },
  ];

  test('returns null for empty candidates', () => {
    expect(keySelector.selectCandidate([])).toBeNull();
    expect(keySelector.selectCandidate(null)).toBeNull();
  });

  test('selects from highest priority group (round-robin default)', () => {
    const selected = keySelector.selectCandidate(candidates, { strategy: 'round-robin' });
    expect(selected).not.toBeNull();
    // Should be from priority 10 group (k1 or k2)
    expect(['k1', 'k2']).toContain(selected.keyId);
  });

  test('least-fail strategy prefers lower failure rate', () => {
    const selected = keySelector.selectCandidate(candidates, { strategy: 'least-fail' });
    expect(selected).not.toBeNull();
    // k1 has 0/5 = 0% failure, k2 has 2/10 = 20%
    expect(selected.keyId).toBe('k1');
  });

  test('least-used strategy prefers fewer total requests', () => {
    const selected = keySelector.selectCandidate(candidates, { strategy: 'least-used' });
    expect(selected).not.toBeNull();
    // Among priority 10: k1 has 5 requests, k2 has 10
    expect(selected.keyId).toBe('k1');
  });

  test('filters out candidates without key', () => {
    const noKey = [{ keyId: 'k1', key: '', priority: 10 }];
    expect(keySelector.selectCandidate(noKey)).toBeNull();
  });
});

describe('parseStrategyMap', () => {
  test('returns empty object for falsy input', () => {
    expect(keySelector.parseStrategyMap(null)).toEqual({});
    expect(keySelector.parseStrategyMap('')).toEqual({});
  });

  test('returns object input directly', () => {
    const map = { cursor: 'least-fail' };
    expect(keySelector.parseStrategyMap(map)).toEqual(map);
  });

  test('parses JSON string', () => {
    const json = '{"cursor":"least-fail"}';
    const result = keySelector.parseStrategyMap(json);
    expect(result.cursor).toBe('least-fail');
  });
});
