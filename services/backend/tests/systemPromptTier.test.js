'use strict';

// Workstream A — tier-aware system prompt.
// makeSystemPrompt must drop weak-model scaffolding (Doing tasks / Execution
// discipline / Planning) for T0 (frontier, lean) models, keep it for T1+,
// and honor the KHY_HARNESS_PROMPT_VERBOSITY escape hatch.
//
// 批4: makeSystemPrompt is now async (it routes the modular prompt through the
// single-source async builder constants/prompts.getSystemPrompt). Tests await it;
// withCleanEnv awaits fn() so env restoration happens AFTER the async build, not
// before it (otherwise the env override would be reverted mid-flight).

const { makeSystemPrompt } = require('../src/services/khyUpgradeRuntime');

const SCAFFOLD_MARKERS = ['# Doing tasks', '# Execution discipline'];

const TIER_ENV = [
  'KHY_CAPABILITY_TIER',
  'KHY_HARNESS_PROMPT_VERBOSITY',
  'GATEWAY_PREFERRED_MODEL',
];

async function withCleanEnv(fn) {
  const saved = {};
  for (const k of TIER_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  try { return await fn(); } finally {
    for (const k of TIER_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function hasAnyScaffold(prompt) {
  return SCAFFOLD_MARKERS.some(m => prompt.includes(m));
}

describe('makeSystemPrompt — tier-aware scaffolding', () => {
  test('T0 frontier (opus-4.8) is lean: no weak-model scaffolding', async () => {
    await withCleanEnv(async () => {
      const prompt = await makeSystemPrompt('', { model: 'claude-opus-4-8', adapter: 'api' });
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
      expect(hasAnyScaffold(prompt)).toBe(false);
    });
  });

  test('T1 strong (qwen-max) keeps full scaffolding', async () => {
    await withCleanEnv(async () => {
      const prompt = await makeSystemPrompt('', { model: 'qwen-max', adapter: 'api' });
      expect(hasAnyScaffold(prompt)).toBe(true);
    });
  });

  test('T2 default (unknown model) keeps full scaffolding', async () => {
    await withCleanEnv(async () => {
      const prompt = await makeSystemPrompt('', { model: 'some-unknown-model-x', adapter: 'api' });
      expect(hasAnyScaffold(prompt)).toBe(true);
    });
  });

  test('KHY_HARNESS_PROMPT_VERBOSITY=full forces T0 back to full scaffolding', async () => {
    await withCleanEnv(async () => {
      process.env.KHY_HARNESS_PROMPT_VERBOSITY = 'full';
      const prompt = await makeSystemPrompt('', { model: 'claude-opus-4-8', adapter: 'api' });
      expect(hasAnyScaffold(prompt)).toBe(true);
    });
  });

  test('lean (T0) prompt is shorter than full (T1) prompt', async () => {
    await withCleanEnv(async () => {
      const lean = await makeSystemPrompt('', { model: 'claude-opus-4-8', adapter: 'api' });
      const full = await makeSystemPrompt('', { model: 'qwen-max', adapter: 'api' });
      expect(lean.length).toBeLessThan(full.length);
    });
  });

  test('cache key separates lean and full for the same call shape', async () => {
    await withCleanEnv(async () => {
      // First produce lean (T0), then full via env override — if the cache key
      // did not include verbosity, the second call could return the stale lean
      // prompt. Assert they differ.
      const lean = await makeSystemPrompt('', { model: 'claude-opus-4-8', adapter: 'api' });
      process.env.KHY_HARNESS_PROMPT_VERBOSITY = 'full';
      const full = await makeSystemPrompt('', { model: 'claude-opus-4-8', adapter: 'api' });
      expect(hasAnyScaffold(lean)).toBe(false);
      expect(hasAnyScaffold(full)).toBe(true);
    });
  });
});
