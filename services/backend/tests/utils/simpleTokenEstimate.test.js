'use strict';

/**
 * simpleTokenEstimate.test.js — byte-for-byte sampling assertions for the
 * batch-3 token-estimate convergence (utils/simpleTokenEstimate.js).
 *
 * Every expected value below is HAND-COMPUTED from the ORIGINAL inline
 * expression each converged call site used before delegation:
 *   A) Math.ceil(str.length / 4)            — standard atom (17 sites)
 *   B) Math.ceil((str.length + 3) / 4)      — webSearchInterceptor variant (3 sites)
 *   C) Math.round(str.length / 4)           — appHostHelpers CC-parity branch
 *   D) Math.ceil(charCount / 4)             — pre-counted char sites (5 sites)
 */

const simpleTokenEstimate = require('../../src/utils/simpleTokenEstimate');

function strOfLen(n) { return 'a'.repeat(n); }

describe('simpleTokenEstimate — standard atom Math.ceil(len / 4)', () => {
  // Hand-computed: ceil(0/4)=0, ceil(1/4)=1, ceil(3/4)=1, ceil(4/4)=1,
  // ceil(5/4)=2, ceil(100/4)=25, ceil(10001/4)=2501.
  const cases = [[0, 0], [1, 1], [3, 1], [4, 1], [5, 2], [100, 25], [10001, 2501]];
  test.each(cases)('len %i → %i', (len, expected) => {
    expect(simpleTokenEstimate(strOfLen(len))).toBe(expected);
  });

  test('multibyte text uses UTF-16 .length exactly like the originals', () => {
    // '中文测试字' .length === 5 → ceil(5/4) = 2 (same as inline expression).
    expect(simpleTokenEstimate('中文测试字')).toBe(2);
    expect(simpleTokenEstimate(String('中文测试字'))).toBe(2);
  });

  test('call-site guard `(text || "")` maps falsy → 0 tokens', () => {
    // Original: Math.ceil((null || '').length / 4) === 0.
    expect(simpleTokenEstimate(null || '')).toBe(0);
    expect(simpleTokenEstimate(undefined || '')).toBe(0);
  });

  test('call-site guard `String(s || "")` maps falsy → 0 tokens', () => {
    // Original: Math.ceil(String(null || '').length / 4) === 0.
    expect(simpleTokenEstimate(String(null || ''))).toBe(0);
  });

  test('unguarded null/undefined throws TypeError exactly like inline `.length`', () => {
    // Original: Math.ceil(null.length / 4) throws TypeError.
    expect(() => simpleTokenEstimate(null)).toThrow(TypeError);
    expect(() => simpleTokenEstimate(undefined)).toThrow(TypeError);
  });
});

describe('bias 3 variant — Math.ceil((len + 3) / 4) (webSearchInterceptor ×3)', () => {
  // Hand-computed from the original expression:
  // len 0 → ceil(3/4)=1; 1 → ceil(4/4)=1; 2 → ceil(5/4)=2; 3 → ceil(6/4)=2;
  // 4 → ceil(7/4)=2; 5 → ceil(8/4)=2; 8 → ceil(11/4)=3; 100 → ceil(103/4)=26.
  const cases = [[0, 1], [1, 1], [2, 2], [3, 2], [4, 2], [5, 2], [8, 3], [100, 26]];
  test.each(cases)('len %i → %i', (len, expected) => {
    expect(simpleTokenEstimate(strOfLen(len), { bias: 3 })).toBe(expected);
  });

  test('bias 3 is NOT the standard atom (differs at len 0, 2, 3, 4)', () => {
    expect(simpleTokenEstimate('', { bias: 3 })).toBe(1);
    expect(simpleTokenEstimate('')).toBe(0);
  });
});

describe('rounding "round" — Math.round(len / 4) (appHostHelpers CC-parity branch)', () => {
  // Hand-computed: round(0/4)=0, round(1/4)=0, round(2/4)=1 (Math.round half-up),
  // round(3/4)=1, round(4/4)=1, round(5/4)=1, round(6/4)=2, round(100/4)=25.
  const cases = [[0, 0], [1, 0], [2, 1], [3, 1], [4, 1], [5, 1], [6, 2], [100, 25]];
  test.each(cases)('len %i → %i', (len, expected) => {
    expect(simpleTokenEstimate(strOfLen(len), { rounding: 'round' })).toBe(expected);
  });

  test('round vs ceil diverge exactly where the original branches diverged', () => {
    // len 5: legacy ceil → 2, CC-parity round → 1 (original gate behaviour).
    expect(simpleTokenEstimate(strOfLen(5))).toBe(2);
    expect(simpleTokenEstimate(strOfLen(5), { rounding: 'round' })).toBe(1);
  });
});

describe('fromCharCount — Math.ceil(charCount / 4) (pre-counted sites ×5)', () => {
  // Hand-computed: ceil(0/4)=0, ceil(1/4)=1, ceil(3/4)=1, ceil(4/4)=1,
  // ceil(5/4)=2, ceil(100/4)=25, ceil(999999/4)=ceil(249999.75)=250000.
  const cases = [[0, 0], [1, 1], [3, 1], [4, 1], [5, 2], [100, 25], [999999, 250000]];
  test.each(cases)('count %i → %i', (count, expected) => {
    expect(simpleTokenEstimate.fromCharCount(count)).toBe(expected);
  });

  test('NaN propagates exactly like the inline expression', () => {
    // Original: Math.ceil(NaN / 4) === NaN.
    expect(simpleTokenEstimate.fromCharCount(NaN)).toBeNaN();
  });
});

describe('per-site delegate equivalence sweep (0..64 chars, exhaustive)', () => {
  test('standard atom matches Math.ceil(len / 4) for every len in 0..64', () => {
    for (let len = 0; len <= 64; len++) {
      expect(simpleTokenEstimate(strOfLen(len))).toBe(Math.ceil(len / 4));
    }
  });

  test('bias 3 matches Math.ceil((len + 3) / 4) for every len in 0..64', () => {
    for (let len = 0; len <= 64; len++) {
      expect(simpleTokenEstimate(strOfLen(len), { bias: 3 })).toBe(Math.ceil((len + 3) / 4));
    }
  });

  test('rounding "round" matches Math.round(len / 4) for every len in 0..64', () => {
    for (let len = 0; len <= 64; len++) {
      expect(simpleTokenEstimate(strOfLen(len), { rounding: 'round' })).toBe(Math.round(len / 4));
    }
  });

  test('fromCharCount matches Math.ceil(n / 4) for every n in 0..64', () => {
    for (let n = 0; n <= 64; n++) {
      expect(simpleTokenEstimate.fromCharCount(n)).toBe(Math.ceil(n / 4));
    }
  });
});
