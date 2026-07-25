'use strict';

const planModeService = require('../../src/services/planModeService');

async function advanceBy(ms) {
  if (typeof jest.advanceTimersByTimeAsync === 'function') {
    await jest.advanceTimersByTimeAsync(ms);
    return;
  }
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
}

describe('planModeService idle timeout behavior', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    planModeService.reset();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('times out when plan generation has no activity', async () => {
    jest.useFakeTimers();
    process.env.KHY_PLAN_MODE_TIMEOUT_MS = '10000';

    const aiModule = {
      chat: jest.fn(() => new Promise(() => {})),
    };

    const planPromise = planModeService.enterPlanMode('diagnose plan failure', aiModule, {});
    await advanceBy(11000);
    const result = await planPromise;

    expect(result.plan).toBeNull();
    expect(result.errorType).toBe('timeout');
    expect(String(result.rawResponse || '')).toContain('Plan generation timeout after 10s');
  });

  test('keeps plan generation alive when status heartbeat continues', async () => {
    jest.useFakeTimers();
    process.env.KHY_PLAN_MODE_TIMEOUT_MS = '10000';

    const aiModule = {
      chat: jest.fn((_prompt, options = {}) => new Promise((resolve) => {
        const heartbeat = setInterval(() => {
          if (typeof options.onStatus === 'function') {
            options.onStatus({ message: 'still generating plan' });
          }
        }, 3000);

        setTimeout(() => {
          clearInterval(heartbeat);
          resolve({
            reply: '## 执行计划\n1. 收集日志\n2. 修复配置',
            provider: 'mock',
            elapsed: 15000,
          });
        }, 15000);
      })),
    };

    const planPromise = planModeService.enterPlanMode('prepare structured plan', aiModule, {});
    await advanceBy(16000);
    const result = await planPromise;

    expect(result.plan).toBeTruthy();
    expect(result.plan.steps).toHaveLength(2);
    expect(result.errorType).toBeUndefined();
  });

  test('treats localLLM adapter as local-like for default timeout selection', async () => {
    jest.useFakeTimers();
    delete process.env.KHY_PLAN_MODE_TIMEOUT_MS;
    process.env.GATEWAY_PREFERRED_ADAPTER = 'localLLM';

    const aiModule = {
      chat: jest.fn(() => new Promise(() => {})),
    };

    let settled = false;
    let resolvedResult = null;
    const planPromise = planModeService.enterPlanMode('verify adapter timeout path', aiModule, {});
    planPromise.then((value) => {
      settled = true;
      resolvedResult = value;
    });

    await advanceBy(90000);
    expect(settled).toBe(false);

    await advanceBy(32000);
    expect(settled).toBe(true);
    expect(resolvedResult).toBeTruthy();
    expect(resolvedResult.errorType).toBe('timeout');
    expect(String(resolvedResult.rawResponse || '')).toContain('Plan generation timeout after 120s');
  });
});
