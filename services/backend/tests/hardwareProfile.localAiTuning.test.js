'use strict';

describe('hardwareProfileService local AI tuning', () => {
  let hw;

  beforeEach(() => {
    jest.resetModules();
    hw = require('../src/services/hardwareProfileService');
  });

  test('explicit fast mode returns expected core caps', () => {
    const rec = hw.recommendLocalAiTuning('fast');
    expect(rec).toBeDefined();
    expect(rec.values.coldMaxTokens).toBe(768);
    expect(rec.values.warmMaxTokens).toBe(1536);
    expect(rec.values.ollamaMaxTokens).toBe(1536);
    expect(rec.env.KHY_LOCAL_WARMUP_ONCE).toBe('true');
    expect(rec.env.KHY_LOCAL_HOT_ATTACH_TIMEOUT_MS).toBe('700');
  });

  test('explicit quality mode returns larger token budgets', () => {
    const rec = hw.recommendLocalAiTuning('quality');
    expect(rec.values.coldMaxTokens).toBeGreaterThanOrEqual(1536);
    expect(rec.values.warmMaxTokens).toBeGreaterThanOrEqual(3072);
    expect(rec.env.KHY_LOCAL_RUNNER_LOAD_TIMEOUT_MS).toBe(String(rec.values.runnerLoadTimeoutMs));
  });

  test('auto mode always returns env-ready map', () => {
    const rec = hw.recommendLocalAiTuning('auto');
    expect(rec).toBeDefined();
    expect(rec.profile).toBeTruthy();
    expect(rec.env).toBeDefined();
    expect(rec.env.KHY_LOCAL_COLD_MAX_TOKENS).toBeTruthy();
    expect(rec.env.KHY_LOCAL_WARM_MAX_TOKENS).toBeTruthy();
    expect(rec.env.KHY_OLLAMA_MAX_TOKENS).toBeTruthy();
    expect(rec.env.KHY_LOCAL_RUNNER_HEALTH_TIMEOUT_MS).toBeTruthy();
  });
});
