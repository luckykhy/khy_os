'use strict';

/**
 * Tests for hook fault isolation (safeRunHook), priority ordering,
 * and config-gated hook registration.
 */

const { safeRunHook, runHooks } = require('../../src/cli/hooks/hookRunner');

describe('safeRunHook — fault isolation', () => {
  test('catches hook that throws and returns allow', async () => {
    const hook = {
      type: 'function',
      handler: () => { throw new Error('kaboom'); },
      timeout: 1000,
      source: 'test:crash',
    };
    const result = await safeRunHook(hook, {});
    expect(result.action).toBe('allow');
    expect(result.error).toContain('kaboom');
  });

  test('normalizes malformed result from inner handler to allow', async () => {
    const hook = {
      type: 'function',
      handler: () => ({ weirdField: true }), // no .action — inner handler normalizes to 'allow'
      timeout: 1000,
      source: 'test:malformed',
    };
    const result = await safeRunHook(hook, {});
    expect(result.action).toBe('allow');
    // Inner _runFunctionHook normalizes to { action: 'allow', output: ... }
  });

  test('passes through valid allow result', async () => {
    const hook = {
      type: 'function',
      handler: () => ({ action: 'allow' }),
      timeout: 1000,
      source: 'test:ok',
    };
    const result = await safeRunHook(hook, {});
    expect(result.action).toBe('allow');
    expect(result.error).toBeUndefined();
  });

  test('passes through valid block result', async () => {
    const hook = {
      type: 'function',
      handler: () => ({ action: 'block', reason: 'nope' }),
      timeout: 1000,
      source: 'test:block',
    };
    const result = await safeRunHook(hook, {});
    expect(result.action).toBe('block');
  });

  test('handles null handler gracefully', async () => {
    const hook = {
      type: 'function',
      handler: null,
      timeout: 1000,
      source: 'test:null',
    };
    const result = await safeRunHook(hook, {});
    expect(result.action).toBe('allow');
    expect(result.error).toBeDefined();
  });
});

describe('hookRegistry — priority ordering', () => {
  // Use a fresh registry for each test to avoid pollution
  let HookRegistry;

  beforeEach(() => {
    // Clear module cache for fresh instance
    jest.resetModules();
    HookRegistry = require('../../src/cli/hooks/hookRegistry');
  });

  test('hooks sorted by priority ascending', () => {
    HookRegistry.registerFunction('PreToolUse', () => ({ action: 'allow' }), {
      source: 'test:low-priority', priority: 100,
    });
    HookRegistry.registerFunction('PreToolUse', () => ({ action: 'allow' }), {
      source: 'test:high-priority', priority: 10,
    });

    const hooks = HookRegistry.getHooks('PreToolUse', {});
    expect(hooks.length).toBe(2);
    expect(hooks[0].source).toBe('test:high-priority');
    expect(hooks[1].source).toBe('test:low-priority');
  });

  test('default priority is 100', () => {
    HookRegistry.registerFunction('PostToolUse', () => ({ action: 'allow' }), {
      source: 'test:default',
    });
    const hooks = HookRegistry.getHooks('PostToolUse', {});
    expect(hooks[0].priority).toBe(100);
  });
});

describe('hookRegistry — config gating', () => {
  let HookRegistry;

  beforeEach(() => {
    jest.resetModules();
    HookRegistry = require('../../src/cli/hooks/hookRegistry');
  });

  test('isHookEnabled returns true for non-disabled hooks', () => {
    expect(HookRegistry.isHookEnabled('anything')).toBe(true);
  });

  test('isHookEnabled returns false for disabled hooks', () => {
    // Manually add to disabled set for test
    HookRegistry._disabledHooks.add('builtin:OutputSizeGuard');
    expect(HookRegistry.isHookEnabled('builtin:OutputSizeGuard')).toBe(false);
    expect(HookRegistry.isHookEnabled('builtin:EditBoundaryGuard')).toBe(true);
  });

  test('registerFunction skips disabled hooks', () => {
    HookRegistry._disabledHooks.add('builtin:Disabled');
    HookRegistry.registerFunction('PreToolUse', () => ({ action: 'allow' }), {
      source: 'builtin:Disabled', priority: 10,
    });
    const hooks = HookRegistry.getHooks('PreToolUse', {});
    expect(hooks.length).toBe(0);
  });

  test('registerFunction allows non-disabled hooks', () => {
    HookRegistry.registerFunction('PreToolUse', () => ({ action: 'allow' }), {
      source: 'builtin:Allowed', priority: 10,
    });
    const hooks = HookRegistry.getHooks('PreToolUse', {});
    expect(hooks.length).toBe(1);
    expect(hooks[0].source).toBe('builtin:Allowed');
  });
});

describe('runHooks — fault isolation integration', () => {
  test('continues chain after one hook crashes', async () => {
    const results = [];
    const hooks = [
      {
        type: 'function',
        handler: () => { throw new Error('crash'); },
        timeout: 1000,
        source: 'test:crash',
        priority: 10,
      },
      {
        type: 'function',
        handler: (ctx) => { results.push('ran'); return { action: 'allow' }; },
        timeout: 1000,
        source: 'test:ok',
        priority: 20,
      },
    ];

    const outcome = await runHooks(hooks, { toolName: 'test' });
    expect(outcome.blocked).toBe(false);
    expect(results).toEqual(['ran']); // second hook still ran
  });
});
