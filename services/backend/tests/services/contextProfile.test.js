'use strict';

/**
 * Tests for contextProfile.js — the single source of truth for
 * window-proportional context engineering knobs (short-context / small-model
 * support). The governing invariant is "large windows are byte-identical to the
 * legacy absolute floors; only small windows get scaled down".
 */

let mod;
try {
  mod = require('../../src/services/contextProfile');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('contextProfile', () => {
  const {
    classifyWindow,
    isShortContext,
    deriveGuardThresholds,
    deriveReserveTokens,
    deriveToolResultCap,
  } = mod || {};

  // Keep env clean so default thresholds (32k / 16k) apply.
  const SAVED = {};
  beforeEach(() => {
    for (const k of ['KHY_SHORT_CONTEXT_TOKENS', 'KHY_VERY_SHORT_CONTEXT_TOKENS']) {
      SAVED[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('classifyWindow', () => {
    test('0 / negative / absent → unknown', () => {
      expect(classifyWindow(0)).toBe('unknown');
      expect(classifyWindow(-1)).toBe('unknown');
      expect(classifyWindow(undefined)).toBe('unknown');
      expect(classifyWindow(null)).toBe('unknown');
    });
    test('boundaries: ≤16k very_short, ≤32k short, larger normal', () => {
      expect(classifyWindow(8000)).toBe('very_short');
      expect(classifyWindow(16384)).toBe('very_short');
      expect(classifyWindow(16385)).toBe('short');
      expect(classifyWindow(32768)).toBe('short');
      expect(classifyWindow(32769)).toBe('normal');
      expect(classifyWindow(128000)).toBe('normal');
      expect(classifyWindow(200000)).toBe('normal');
    });
    test('env overrides move the thresholds', () => {
      process.env.KHY_SHORT_CONTEXT_TOKENS = '64000';
      process.env.KHY_VERY_SHORT_CONTEXT_TOKENS = '8000';
      expect(classifyWindow(8000)).toBe('very_short');
      expect(classifyWindow(9000)).toBe('short');
      expect(classifyWindow(64000)).toBe('short');
      expect(classifyWindow(64001)).toBe('normal');
    });
  });

  describe('isShortContext', () => {
    test('true only for resolved small windows, never for unknown', () => {
      expect(isShortContext(0)).toBe(false); // unknown is NOT short
      expect(isShortContext(8000)).toBe(true);
      expect(isShortContext(32768)).toBe(true);
      expect(isShortContext(128000)).toBe(false);
    });
  });

  describe('deriveGuardThresholds', () => {
    test('unknown window falls back to the absolute floors', () => {
      expect(deriveGuardThresholds(0)).toEqual({ hardMinTokens: 4000, warnBelowTokens: 8000 });
    });
    test('8k window is capped, not floored (the small-model bug)', () => {
      // hardMin = min(max(4000, 800), 2000) = 2000 ; warn = min(max(8000,1600), 3200) = 3200
      expect(deriveGuardThresholds(8000)).toEqual({ hardMinTokens: 2000, warnBelowTokens: 3200 });
    });
    test('10k window', () => {
      // hardMin = min(4000, 2500)=2500 ; warn = min(8000, 4000)=4000
      expect(deriveGuardThresholds(10000)).toEqual({ hardMinTokens: 2500, warnBelowTokens: 4000 });
    });
    test('200k window is identical to legacy floor math', () => {
      expect(deriveGuardThresholds(200000)).toEqual({ hardMinTokens: 20000, warnBelowTokens: 40000 });
    });
    test('warn is always ≥ hardMin', () => {
      for (const w of [1000, 4000, 8000, 16000, 32768, 128000]) {
        const t = deriveGuardThresholds(w);
        expect(t.warnBelowTokens).toBeGreaterThanOrEqual(t.hardMinTokens);
      }
    });
  });

  describe('deriveReserveTokens', () => {
    test('large window passes the requested reserve through unchanged', () => {
      expect(deriveReserveTokens(200000, 4096)).toBe(4096);
      expect(deriveReserveTokens(128000, 8192)).toBe(8192);
    });
    test('small window clamps the reserve to ≤30% of the window', () => {
      expect(deriveReserveTokens(8000, 4096)).toBe(2400); // min(4096, 8000*0.3)
      expect(deriveReserveTokens(10000, 4096)).toBe(3000);
    });
    test('unknown window returns the requested reserve', () => {
      expect(deriveReserveTokens(0, 4096)).toBe(4096);
    });
    test('never returns below the 512 hard floor', () => {
      expect(deriveReserveTokens(1000, 4096)).toBe(512);
    });
  });

  describe('deriveToolResultCap', () => {
    test('normal / unknown window returns the caller default unchanged', () => {
      expect(deriveToolResultCap(128000, 5000)).toBe(5000);
      expect(deriveToolResultCap(0, 5000)).toBe(5000);
    });
    test('short window caps a single result to ~10% of the window in chars', () => {
      // 8000 tokens × 4 chars × 0.1 = 3200, below the 5000 default → 3200
      expect(deriveToolResultCap(8000, 5000)).toBe(3200);
    });
    test('never returns below the 800-char floor', () => {
      expect(deriveToolResultCap(1000, 5000)).toBe(800);
    });
    test('cap never exceeds the caller default', () => {
      // 32768 × 4 × 0.1 = 13107 > 5000 default → stays at 5000
      expect(deriveToolResultCap(32768, 5000)).toBe(5000);
    });
  });
});
