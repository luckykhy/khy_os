'use strict';

// Workstream E — tier-aware anthropic-beta header + 400 auto-fallback.
//
// _buildBetaHeader(model):
//   - always sends tool-search-tool (proven working)
//   - adds context-1m + interleaved-thinking ONLY for T0 (frontier) models,
//     each behind an env kill-switch
//   - omits the two T0 betas once the sticky _betaOptOut flag is set (after a
//     400 caused by an unsupported beta)
//
// We exercise the helpers via the adapter's __test__ surface so no live network
// call is made.

const claudeAdapter = require('../src/services/gateway/adapters/claudeAdapter');
const T = claudeAdapter.__test__;

const BETA_ENV = ['KHY_BETA_1M_CONTEXT', 'KHY_BETA_INTERLEAVED', 'KHY_ANTHROPIC_BETA', 'KHY_CAPABILITY_TIER'];

function withCleanEnv(fn) {
  const saved = {};
  for (const k of BETA_ENV) saved[k] = process.env[k];
  const savedOptOut = T.getBetaOptOut();
  try {
    for (const k of BETA_ENV) delete process.env[k];
    T.setBetaOptOut(false);
    return fn();
  } finally {
    for (const k of BETA_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    T.setBetaOptOut(savedOptOut);
  }
}

describe('_buildBetaHeader — tier gating', () => {
  test('T0 (opus) includes context-1m + interleaved + tool-search', () => {
    withCleanEnv(() => {
      const h = T.buildBetaHeader('claude-opus-4-8');
      expect(h).toContain('tool-search-tool-2025-10-19');
      expect(h).toContain('context-1m-2025-08-07');
      expect(h).toContain('interleaved-thinking-2025-05-14');
    });
  });

  test('T1 (qwen-max) gets ONLY tool-search — zero regression', () => {
    withCleanEnv(() => {
      const h = T.buildBetaHeader('qwen-max');
      expect(h).toBe('tool-search-tool-2025-10-19');
    });
  });

  test('unknown/default model gets only tool-search', () => {
    withCleanEnv(() => {
      expect(T.buildBetaHeader('some-random-model')).toBe('tool-search-tool-2025-10-19');
    });
  });

  test('KHY_BETA_1M_CONTEXT=0 strips only the 1M beta for T0', () => {
    withCleanEnv(() => {
      process.env.KHY_BETA_1M_CONTEXT = '0';
      const h = T.buildBetaHeader('claude-opus-4-8');
      expect(h).not.toContain('context-1m-2025-08-07');
      expect(h).toContain('interleaved-thinking-2025-05-14');
    });
  });

  test('KHY_BETA_INTERLEAVED=0 strips only the interleaved beta for T0', () => {
    withCleanEnv(() => {
      process.env.KHY_BETA_INTERLEAVED = '0';
      const h = T.buildBetaHeader('claude-opus-4-8');
      expect(h).toContain('context-1m-2025-08-07');
      expect(h).not.toContain('interleaved-thinking-2025-05-14');
    });
  });

  test('KHY_ANTHROPIC_BETA extras are appended', () => {
    withCleanEnv(() => {
      process.env.KHY_ANTHROPIC_BETA = 'foo-2025,bar-2026';
      const h = T.buildBetaHeader('qwen-max');
      expect(h).toContain('foo-2025');
      expect(h).toContain('bar-2026');
    });
  });

  test('sticky opt-out suppresses T0 betas (keeps tool-search)', () => {
    withCleanEnv(() => {
      T.setBetaOptOut(true);
      const h = T.buildBetaHeader('claude-opus-4-8');
      expect(h).toBe('tool-search-tool-2025-10-19');
    });
  });
});

describe('_defaultThinkingBudget — tier-aware', () => {
  test('T0 frontier → 16000, others → 10000', () => {
    withCleanEnv(() => {
      expect(T.defaultThinkingBudget('claude-opus-4-8')).toBe(16000);
      expect(T.defaultThinkingBudget('qwen-max')).toBe(10000);
      expect(T.defaultThinkingBudget('claude-haiku-4-5-latest')).toBe(10000);
    });
  });
});
