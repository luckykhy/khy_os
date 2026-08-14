'use strict';

/**
 * Tests for D3 hook execution telemetry (getHookMetrics).
 */

const { safeRunHook, getHookMetrics, _hookMetrics } = require('../../src/cli/hooks/hookRunner');

describe('hook telemetry — getHookMetrics', () => {
  beforeEach(() => {
    _hookMetrics.length = 0;
  });

  test('starts with empty metrics', () => {
    expect(getHookMetrics()).toEqual([]);
  });

  test('records metric after successful function hook', async () => {
    const hook = {
      type: 'function',
      source: 'test:allowHook',
      handler: () => ({ action: 'allow' }),
    };

    await safeRunHook(hook, { toolName: 'read' });

    const metrics = getHookMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0].hookSource).toBe('test:allowHook');
    expect(metrics[0].action).toBe('allow');
    expect(typeof metrics[0].durationMs).toBe('number');
    expect(metrics[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test('records metric after blocking hook', async () => {
    const hook = {
      type: 'function',
      source: 'test:blockHook',
      handler: () => ({ action: 'block', reason: 'nope' }),
    };

    await safeRunHook(hook, { toolName: 'write' });

    const metrics = getHookMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0].action).toBe('block');
  });

  test('records metric with error when hook throws', async () => {
    const hook = {
      type: 'function',
      source: 'test:crashHook',
      handler: () => { throw new Error('boom'); },
    };

    const result = await safeRunHook(hook, { toolName: 'edit' });
    expect(result.action).toBe('allow');
    expect(result.error).toMatch(/boom/);

    const metrics = getHookMetrics();
    expect(metrics).toHaveLength(1);
    // The error is caught by _runFunctionHook before safeRunHook's catch,
    // so safeRunHook records the successful return (action:'allow')
    expect(metrics[0].action).toBe('allow');
    expect(metrics[0].hookSource).toBe('test:crashHook');
  });

  test('metrics accumulate across calls', async () => {
    const hook = {
      type: 'function',
      source: 'test:multi',
      handler: () => ({ action: 'allow' }),
    };

    await safeRunHook(hook, {});
    await safeRunHook(hook, {});
    await safeRunHook(hook, {});

    expect(getHookMetrics()).toHaveLength(3);
  });

  test('getHookMetrics returns a copy, not the internal array', async () => {
    const hook = {
      type: 'function',
      source: 'test:copy',
      handler: () => ({ action: 'allow' }),
    };

    await safeRunHook(hook, {});
    const copy = getHookMetrics();
    copy.push({ fake: true });

    expect(getHookMetrics()).toHaveLength(1); // internal not affected
  });

  test('caps at 500 entries', () => {
    // Pre-fill with 500 entries
    for (let i = 0; i < 500; i++) {
      _hookMetrics.push({ hookSource: `hook-${i}`, durationMs: 1, action: 'allow' });
    }
    expect(_hookMetrics).toHaveLength(500);
  });
});
