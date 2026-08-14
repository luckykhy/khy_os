'use strict';

// Fifth cut — honest 1M context window.
//
// The 1M context-1m beta is offered for BOTH Opus 4 (T0) and Sonnet 4 (T1
// default). A model may DECLARE a 1M window, but the API only honours it while
// the context-1m beta is actually live. effectiveContextWindow must clamp the
// declared window back to 200k whenever the beta is NOT being sent (disabled via
// env, stuck off by a 400 fallback, or an unsupported family), so the compaction
// budget never over-claims 1M and overflows the real ceiling.

const claudeAdapter = require('../src/services/gateway/adapters/claudeAdapter');
const T = claudeAdapter.__test__;

const ENV = ['KHY_BETA_1M_CONTEXT', 'KHY_BETA_INTERLEAVED', 'KHY_ANTHROPIC_BETA', 'KHY_CAPABILITY_TIER'];

function withCleanEnv(fn) {
  const saved = {};
  for (const k of ENV) saved[k] = process.env[k];
  const savedOptOut = T.getBetaOptOut();
  try {
    for (const k of ENV) delete process.env[k];
    T.setBetaOptOut(false);
    return fn();
  } finally {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    T.setBetaOptOut(savedOptOut);
  }
}

describe('_is1MCapableModel — family gating', () => {
  test('Opus 4.x and Sonnet 4.x are 1M-capable; others are not', () => {
    expect(T.is1MCapableModel('claude-opus-4-8')).toBe(true);
    expect(T.is1MCapableModel('claude-sonnet-4-6')).toBe(true);
    expect(T.is1MCapableModel('claude-haiku-4-5-latest')).toBe(false);
    expect(T.is1MCapableModel('claude-3-5-sonnet')).toBe(false); // sonnet-3.5, not -4
    expect(T.is1MCapableModel('qwen-max')).toBe(false);
  });
});

describe('_buildBetaHeader — Sonnet-4 now gets context-1m (fifth cut)', () => {
  test('Sonnet-4 carries context-1m but NOT interleaved (T1)', () => {
    withCleanEnv(() => {
      const h = T.buildBetaHeader('claude-sonnet-4-6');
      expect(h).toContain('tool-search-tool-2025-10-19');
      expect(h).toContain('context-1m-2025-08-07');
      expect(h).not.toContain('interleaved-thinking-2025-05-14');
    });
  });

  test('Opus-4 still carries both 1M + interleaved (T0)', () => {
    withCleanEnv(() => {
      const h = T.buildBetaHeader('claude-opus-4-8');
      expect(h).toContain('context-1m-2025-08-07');
      expect(h).toContain('interleaved-thinking-2025-05-14');
    });
  });

  test('KHY_BETA_1M_CONTEXT=0 strips 1M from Sonnet-4 too', () => {
    withCleanEnv(() => {
      process.env.KHY_BETA_1M_CONTEXT = '0';
      const h = T.buildBetaHeader('claude-sonnet-4-6');
      expect(h).toBe('tool-search-tool-2025-10-19');
    });
  });
});

describe('is1MContextActive', () => {
  test('true for capable families with beta on, false once disabled/opted-out', () => {
    withCleanEnv(() => {
      expect(claudeAdapter.is1MContextActive('claude-opus-4-8')).toBe(true);
      expect(claudeAdapter.is1MContextActive('claude-sonnet-4-6')).toBe(true);
      expect(claudeAdapter.is1MContextActive('claude-haiku-4-5-latest')).toBe(false);

      process.env.KHY_BETA_1M_CONTEXT = '0';
      expect(claudeAdapter.is1MContextActive('claude-opus-4-8')).toBe(false);
      delete process.env.KHY_BETA_1M_CONTEXT;

      T.setBetaOptOut(true);
      expect(claudeAdapter.is1MContextActive('claude-sonnet-4-6')).toBe(false);
    });
  });
});

describe('effectiveContextWindow — honest clamp', () => {
  test('1M stays 1M while the beta is live (Opus + Sonnet-4)', () => {
    withCleanEnv(() => {
      expect(claudeAdapter.effectiveContextWindow('claude-opus-4-8', 1000000)).toBe(1000000);
      expect(claudeAdapter.effectiveContextWindow('claude-sonnet-4-6', 1000000)).toBe(1000000);
    });
  });

  test('1M clamps to 200k once the beta is opted-out (400 fallback)', () => {
    withCleanEnv(() => {
      T.setBetaOptOut(true);
      expect(claudeAdapter.effectiveContextWindow('claude-opus-4-8', 1000000)).toBe(200000);
      expect(claudeAdapter.effectiveContextWindow('claude-sonnet-4-6', 1000000)).toBe(200000);
    });
  });

  test('1M clamps to 200k when disabled via env', () => {
    withCleanEnv(() => {
      process.env.KHY_BETA_1M_CONTEXT = '0';
      expect(claudeAdapter.effectiveContextWindow('claude-opus-4-8', 1000000)).toBe(200000);
    });
  });

  test('a declared-1M but non-1M-capable Claude (haiku) clamps to 200k', () => {
    withCleanEnv(() => {
      // Hypothetical over-declaration: haiku never sends the beta → honest 200k.
      expect(claudeAdapter.effectiveContextWindow('claude-haiku-4-5-latest', 1000000)).toBe(200000);
    });
  });

  test('sub-200k declarations pass through unchanged', () => {
    withCleanEnv(() => {
      expect(claudeAdapter.effectiveContextWindow('claude-haiku-4-5-latest', 200000)).toBe(200000);
      expect(claudeAdapter.effectiveContextWindow('claude-opus-4-8', 128000)).toBe(128000);
    });
  });

  test('non-Claude models pass through unchanged (zero regression)', () => {
    withCleanEnv(() => {
      expect(claudeAdapter.effectiveContextWindow('qwen-max', 1000000)).toBe(1000000);
      expect(claudeAdapter.effectiveContextWindow('gpt-5', 400000)).toBe(400000);
      expect(claudeAdapter.effectiveContextWindow('deepseek-chat', 65536)).toBe(65536);
    });
  });

  test('garbage declared values coerce to 0 without throwing', () => {
    withCleanEnv(() => {
      expect(claudeAdapter.effectiveContextWindow('claude-opus-4-8', undefined)).toBe(0);
      expect(claudeAdapter.effectiveContextWindow('claude-opus-4-8', 'nonsense')).toBe(0);
    });
  });
});
