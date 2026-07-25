'use strict';

// Workstream F — extended-thinking budget plumbing.
//
// Root cause: effortToParams emitted snake_case `budget_tokens`, but both
// consumers (claudeAdapter, multiFreeService) read camelCase `budgetTokens`, so
// the per-effort budget was silently dropped and every request fell back to a
// flat default. The fix makes effortToParams emit camelCase so the budget
// actually reaches the wire (and the cut-2 thinkingFloor dial works).

const { resolveEffort, effortToParams } = require('../src/services/autoReasoning');

describe('effortToParams — anthropic camelCase budget', () => {
  test('each tier maps to camelCase budgetTokens (not snake_case)', () => {
    expect(effortToParams('low', 'anthropic')).toEqual({ thinking: { budgetTokens: 1024 } });
    expect(effortToParams('high', 'anthropic')).toEqual({ thinking: { budgetTokens: 8192 } });
    expect(effortToParams('max', 'anthropic')).toEqual({ thinking: { budgetTokens: 32768 } });
  });

  test('the dropped-budget regression cannot recur (no snake_case key)', () => {
    const p = effortToParams('max', 'anthropic');
    expect(p.thinking).not.toHaveProperty('budget_tokens');
    expect(p.thinking.budgetTokens).toBe(32768);
  });

  test('claude provider alias behaves identically to anthropic', () => {
    expect(effortToParams('high', 'claude')).toEqual({ thinking: { budgetTokens: 8192 } });
  });

  test('non-anthropic providers are untouched (zero regression)', () => {
    expect(effortToParams('max', 'deepseek')).toEqual({ reasoning_effort: 'max' });
    expect(effortToParams('max', 'openai')).toEqual({ reasoning_effort: 'high' });
    expect(effortToParams('low', 'openai')).toEqual({ reasoning_effort: 'low' });
  });

  test('the emitted key matches what consumers read (options.thinking.budgetTokens)', () => {
    // Mirrors the adapter read site: options.thinking.budgetTokens || budget_tokens
    const opts = {};
    Object.assign(opts, effortToParams('max', 'anthropic'));
    const budget = opts.thinking && (opts.thinking.budgetTokens || opts.thinking.budget_tokens);
    expect(budget).toBe(32768);
  });
});

describe('resolveEffort — floor interplay sanity', () => {
  test('debugging keywords resolve to max (→ 32768 once mapped)', () => {
    expect(resolveEffort('please debug this crash and find the root cause')).toBe('max');
    expect(effortToParams(resolveEffort('debug this error'), 'anthropic'))
      .toEqual({ thinking: { budgetTokens: 32768 } });
  });
});
