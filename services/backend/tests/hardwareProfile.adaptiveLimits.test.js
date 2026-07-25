'use strict';

/**
 * Adaptive runtime limits — verify that the hardware profile is actually wired
 * into the process environment (applyLimits), respects user overrides, honors a
 * pinned tier (KHY_HW_PROFILE), and reports provenance (getAppliedLimits). Also
 * covers the AgentTool fan-out helpers that consume the derived env.
 */

const HW_KEYS = [
  'KHY_MAX_HEAP_MB',
  'KHY_LIGHTWEIGHT',
  'KHY_USER_MAX_CONCURRENT',
  'KHY_MAX_SUBAGENTS',
  'KHY_SHELL_TIMEOUT_MS',
  'KHY_AI_TIMEOUT_MS',
  'KHY_CLEANUP_INTERVAL_MS',
  'KHY_ENABLE_PERIODIC_SCAN',
  'KHY_ENABLE_MULTI_AGENT',
  'KHY_ENABLE_BACKTEST',
  'KHY_ENABLE_LOCAL_MODEL',
];

function clearHwEnv() {
  for (const k of [...HW_KEYS, 'KHY_HW_PROFILE', 'KHY_ENABLE_MULTI_AGENT']) {
    delete process.env[k];
  }
}

describe('hardwareProfileService — adaptive limit export', () => {
  let savedEnv;
  let hw;

  beforeEach(() => {
    savedEnv = { ...process.env };
    clearHwEnv();
    jest.resetModules();
    hw = require('../src/services/hardwareProfileService');
    hw.resetCache();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  test('applyLimits exports the full hardware-derived env map', () => {
    hw.applyLimits();
    for (const key of HW_KEYS) {
      expect(process.env[key]).toBeDefined();
      expect(process.env[key]).not.toBe('');
    }
  });

  test('applyLimits does NOT overwrite a user-set knob (explicit wins)', () => {
    process.env.KHY_USER_MAX_CONCURRENT = '8';
    hw.applyLimits();
    expect(process.env.KHY_USER_MAX_CONCURRENT).toBe('8');
  });

  test('applyLimits honors an explicit falsy override ("0"/"false")', () => {
    process.env.KHY_MAX_SUBAGENTS = '0';
    process.env.KHY_ENABLE_MULTI_AGENT = 'false';
    hw.applyLimits();
    expect(process.env.KHY_MAX_SUBAGENTS).toBe('0');
    expect(process.env.KHY_ENABLE_MULTI_AGENT).toBe('false');
  });

  test('KHY_HW_PROFILE pins the tier regardless of real hardware', () => {
    process.env.KHY_HW_PROFILE = 'server-minimal';
    hw.resetCache();
    const p = hw.detectProfile();
    expect(p.profile).toBe('server-minimal');
    expect(p.limits.maxConcurrency).toBe(1);
    expect(p.limits.enableMultiAgent).toBe(false);
    expect(p.isLightweight).toBe(true);
  });

  test('KHY_HW_PROFILE=workstation opens up concurrency/agents', () => {
    process.env.KHY_HW_PROFILE = 'workstation';
    hw.resetCache();
    const p = hw.detectProfile();
    expect(p.profile).toBe('workstation');
    expect(p.limits.maxConcurrency).toBeGreaterThanOrEqual(1);
    expect(p.limits.enableMultiAgent).toBe(true);
  });

  test('invalid KHY_HW_PROFILE falls back to auto-classification', () => {
    process.env.KHY_HW_PROFILE = 'not-a-tier';
    hw.resetCache();
    const p = hw.detectProfile();
    // Any of the valid auto tiers, never the bogus string.
    expect(p.profile).not.toBe('not-a-tier');
    expect([
      'server-minimal', 'server-standard', 'desktop-cpu', 'desktop-gpu', 'workstation',
    ]).toContain(p.profile);
  });

  test('getAppliedLimits marks hardware vs user-override source', () => {
    process.env.KHY_USER_MAX_CONCURRENT = '8';
    hw.resetCache();
    const applied = hw.getAppliedLimits();
    expect(applied.env.KHY_USER_MAX_CONCURRENT).toBe('8');
    expect(applied.source.KHY_USER_MAX_CONCURRENT).toBe('user-override');
    // A knob the user did not set is reported as hardware-derived.
    expect(applied.source.KHY_SHELL_TIMEOUT_MS).toBe('hardware');
    expect(applied.profile).toBeTruthy();
  });

  test('getAppliedLimits flags a pinned tier', () => {
    process.env.KHY_HW_PROFILE = 'desktop-cpu';
    hw.resetCache();
    const applied = hw.getAppliedLimits();
    expect(applied.pinned).toBe(true);
    expect(applied.profile).toBe('desktop-cpu');
  });
});

describe('AgentTool — hardware-derived fan-out', () => {
  let savedEnv;
  let agent;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.KHY_ENABLE_MULTI_AGENT;
    delete process.env.KHY_MAX_SUBAGENTS;
    jest.resetModules();
    agent = require('../src/tools/AgentTool');
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  test('_maxSubagentFanout = 1 (serial) when multi-agent disabled', () => {
    process.env.KHY_ENABLE_MULTI_AGENT = 'false';
    expect(agent._maxSubagentFanout()).toBe(1);
  });

  test('_maxSubagentFanout reads KHY_MAX_SUBAGENTS', () => {
    process.env.KHY_MAX_SUBAGENTS = '3';
    expect(agent._maxSubagentFanout()).toBe(3);
  });

  test('_maxSubagentFanout defaults to Infinity (unbounded) when unset', () => {
    delete process.env.KHY_MAX_SUBAGENTS;
    expect(agent._maxSubagentFanout()).toBe(Infinity);
  });

  test('_mapSettledLimited preserves order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const worker = async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    };
    const items = [1, 2, 3, 4, 5, 6];
    const out = await agent._mapSettledLimited(items, 2, worker);
    expect(out.map((r) => r.value)).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test('_mapSettledLimited captures rejections in allSettled shape', async () => {
    const worker = async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    };
    const out = await agent._mapSettledLimited([1, 2, 3], 1, worker);
    expect(out[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(out[1].status).toBe('rejected');
    expect(out[2]).toEqual({ status: 'fulfilled', value: 3 });
  });
});
