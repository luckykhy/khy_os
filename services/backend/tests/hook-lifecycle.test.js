'use strict';

/**
 * Tests for Gap #8: Hook Event Lifecycle.
 */

const assert = require('assert');

// Bridge the original standalone-script helpers onto Jest's globals so the
// suite is collected by Jest (assertions still run via node 'assert').
function test(name, fn) {
  global.test(name, fn);
}

function testAsync(name, fn) {
  global.test(name, fn);
}

function group(name, fn) {
  global.describe(name, fn);
}

// ── Setup: fresh registry for each test group ────────────────────

function freshRegistry() {
  // Reset Jest's module registry to get a fresh singleton. Note that
  // `delete require.cache[...]` is a no-op under Jest (it maintains its own
  // module registry), so jest.resetModules() is required for true isolation.
  jest.resetModules();
  return require('../src/cli/hooks/hookRegistry');
}

// ── Tests ────────────────────────────────────────────────────────

group('1. HookRegistry — new events defined', () => {
  const registry = freshRegistry();
  test('PreCompact event exists', () => {
    assert.ok(registry.events.includes('PreCompact'));
  });
  test('PostCompact event exists', () => {
    assert.ok(registry.events.includes('PostCompact'));
  });
  test('all 9 events present', () => {
    assert.strictEqual(registry.events.length, 9);
  });
});

group('2. HookRegistry — registerFunction basic', () => {
  // Build the registry at execution time (beforeEach) rather than at collection
  // time, so registrations don't leak across describe bodies during collection.
  let registry;
  beforeEach(() => { registry = freshRegistry(); });

  test('registers a function hook', () => {
    let called = false;
    registry.registerFunction('PreToolUse', () => { called = true; });
    assert.strictEqual(registry.count, 1);
    const hooks = registry.getHooks('PreToolUse', {});
    assert.strictEqual(hooks.length, 1);
    assert.strictEqual(hooks[0].type, 'function');
    assert.strictEqual(typeof hooks[0].handler, 'function');
  });

  test('throws on unknown event', () => {
    assert.throws(() => {
      registry.registerFunction('UnknownEvent', () => {});
    }, /Unknown hook event/);
  });

  test('throws on non-function handler', () => {
    assert.throws(() => {
      registry.registerFunction('PreToolUse', 'not a function');
    }, /must be a function/);
  });
});

group('3. HookRegistry — registerFunction with pattern', () => {
  let registry;
  beforeEach(() => {
    registry = freshRegistry();
    registry.registerFunction('PreToolUse', () => ({ action: 'block', reason: 'test' }), {
      pattern: 'shell_command',
    });
  });

  test('matches toolName against pattern', () => {
    const hooks = registry.getHooks('PreToolUse', { toolName: 'shell_command' });
    assert.strictEqual(hooks.length, 1);
  });

  test('does not match non-matching toolName', () => {
    const hooks = registry.getHooks('PreToolUse', { toolName: 'read_file' });
    assert.strictEqual(hooks.length, 0);
  });
});

group('4. hookRunner — function hook allow', () => {
  const { runHook, runHooks } = require('../src/cli/hooks/hookRunner');

  testAsync('function hook returning undefined = allow', async () => {
    const hook = { type: 'function', handler: () => {}, event: 'PreToolUse', timeout: 5000 };
    const result = await runHook(hook, { toolName: 'test' });
    assert.strictEqual(result.action, 'allow');
  });

  testAsync('function hook returning null = allow', async () => {
    const hook = { type: 'function', handler: () => null, event: 'PreToolUse', timeout: 5000 };
    const result = await runHook(hook, { toolName: 'test' });
    assert.strictEqual(result.action, 'allow');
  });

  testAsync('function hook returning {action: "allow"} = allow', async () => {
    const hook = { type: 'function', handler: () => ({ action: 'allow' }), event: 'PreToolUse', timeout: 5000 };
    const result = await runHook(hook, { toolName: 'test' });
    assert.strictEqual(result.action, 'allow');
  });
});

group('5. hookRunner — function hook block', () => {
  const { runHook, runHooks } = require('../src/cli/hooks/hookRunner');

  testAsync('function hook block stops execution', async () => {
    const hook = {
      type: 'function',
      handler: () => ({ action: 'block', reason: 'test blocked' }),
      event: 'PreToolUse',
      timeout: 5000,
    };
    const result = await runHook(hook, { toolName: 'test' });
    assert.strictEqual(result.action, 'block');
    assert.ok(result.error.includes('test blocked'));
  });
});

group('6. hookRunner — function hook modify', () => {
  const { runHook } = require('../src/cli/hooks/hookRunner');

  testAsync('function hook modify returns overrides', async () => {
    const hook = {
      type: 'function',
      handler: (ctx) => ({ action: 'modify', params: { ...ctx.params, extra: true } }),
      event: 'PostToolUse',
      timeout: 5000,
    };
    const result = await runHook(hook, { toolName: 'test', params: { foo: 'bar' } });
    assert.strictEqual(result.action, 'modify');
    assert.ok(result.output);
    assert.strictEqual(result.output.params.extra, true);
  });
});

group('7. hookRunner — runHooks sequential with block', () => {
  const { runHooks } = require('../src/cli/hooks/hookRunner');

  testAsync('second hook blocks, first modifies', async () => {
    const hooks = [
      {
        type: 'function',
        handler: (ctx) => ({ action: 'modify', modified: true }),
        event: 'PreToolUse',
        timeout: 5000,
      },
      {
        type: 'function',
        handler: () => ({ action: 'block', reason: 'blocked by second' }),
        event: 'PreToolUse',
        timeout: 5000,
      },
    ];

    const result = await runHooks(hooks, { toolName: 'test' });
    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.includes('blocked by second'));
  });

  testAsync('both hooks allow, context accumulates modifications', async () => {
    const hooks = [
      {
        type: 'function',
        handler: () => ({ action: 'modify', step1: true }),
        event: 'PreToolUse',
        timeout: 5000,
      },
      {
        type: 'function',
        handler: () => ({ action: 'modify', step2: true }),
        event: 'PreToolUse',
        timeout: 5000,
      },
    ];

    const result = await runHooks(hooks, { toolName: 'test' });
    assert.strictEqual(result.blocked, false);
    assert.strictEqual(result.context.step1, true);
    assert.strictEqual(result.context.step2, true);
  });
});

group('8. hookRunner — function hook error handling', () => {
  const { runHook } = require('../src/cli/hooks/hookRunner');

  testAsync('throwing hook defaults to allow', async () => {
    const hook = {
      type: 'function',
      handler: () => { throw new Error('oops'); },
      event: 'PreToolUse',
      timeout: 5000,
    };
    const result = await runHook(hook, {});
    assert.strictEqual(result.action, 'allow');
    assert.ok(result.error.includes('oops'));
  });
});

group('9. hookSystem — trigger with no hooks = fast path', () => {
  const sysPath = require.resolve('../src/cli/hooks/hookSystem');
  delete require.cache[sysPath];
  const regPath = require.resolve('../src/cli/hooks/hookRegistry');
  delete require.cache[regPath];

  const hookSystem = require(sysPath);
  // Do not call init — _initialized stays false

  testAsync('trigger before init returns unblocked', async () => {
    const result = await hookSystem.trigger('PreToolUse', { toolName: 'test' });
    assert.strictEqual(result.blocked, false);
  });
});

group('10. hookSystem — registerFunction + trigger integration', () => {
  const sysPath = require.resolve('../src/cli/hooks/hookSystem');
  delete require.cache[sysPath];
  const regPath = require.resolve('../src/cli/hooks/hookRegistry');
  delete require.cache[regPath];

  const hookSystem = require(sysPath);

  // Initialize and register a function hook
  hookSystem.init(null); // no project dir
  hookSystem.registerFunction('PreCompact', (ctx) => {
    return { action: 'modify', intercepted: true, messageCount: ctx.messageCount };
  });

  testAsync('PreCompact hook fires and modifies context', async () => {
    const result = await hookSystem.trigger('PreCompact', { messageCount: 42, totalTokens: 1000 });
    assert.strictEqual(result.blocked, false);
    assert.strictEqual(result.context.intercepted, true);
    assert.strictEqual(result.context.messageCount, 42);
  });

  hookSystem.registerFunction('PostCompact', () => ({ action: 'allow' }));

  testAsync('PostCompact hook fires', async () => {
    const result = await hookSystem.trigger('PostCompact', { freedTokens: 500 });
    assert.strictEqual(result.blocked, false);
  });
});

console.log('\n--- All Gap #8 tests complete ---\n');

// ── Command-hook output whitelist (untrusted JSON containment) ─────

group('11. hookRunner — command output field whitelist', () => {
  const { filterCommandOutput, CMD_HOOK_ALLOWED_FIELDS } = require('../src/cli/hooks/hookRunner');

  test('PreToolUse keeps params, drops control fields', () => {
    const { filtered, dropped } = filterCommandOutput('PreToolUse', {
      params: { timeout: 5000 },
      iteration: 999,
      toolName: 'evil',
    });
    assert.deepStrictEqual(filtered, { params: { timeout: 5000 } });
    assert.ok(dropped.includes('iteration'));
    assert.ok(dropped.includes('toolName'));
  });

  test('PostToolUse keeps result + preventContinuation, drops rest', () => {
    const { filtered, dropped } = filterCommandOutput('PostToolUse', {
      result: { output: 'x' },
      preventContinuation: true,
      stopReason: 'done',
      _secret: 1,
    });
    assert.strictEqual(filtered.result.output, 'x');
    assert.strictEqual(filtered.preventContinuation, true);
    assert.strictEqual(filtered.stopReason, 'done');
    assert.ok(dropped.includes('_secret'));
  });

  test('PrePrompt allows prompt + additionalContext', () => {
    const { filtered, dropped } = filterCommandOutput('PrePrompt', {
      prompt: 'hi',
      additionalContext: 'extra',
      iteration: 5,
    });
    assert.strictEqual(filtered.prompt, 'hi');
    assert.strictEqual(filtered.additionalContext, 'extra');
    assert.deepStrictEqual(dropped, ['iteration']);
  });

  test('whitelist defined for every registered event', () => {
    const registry = freshRegistry();
    for (const ev of registry.events) {
      assert.ok(Array.isArray(CMD_HOOK_ALLOWED_FIELDS[ev]), `missing whitelist for ${ev}`);
    }
  });

  test('non-object output passes through untouched', () => {
    const { filtered, dropped } = filterCommandOutput('PreToolUse', null);
    assert.strictEqual(filtered, null);
    assert.deepStrictEqual(dropped, []);
  });
});

console.log('\n--- Command-hook whitelist tests complete ---\n');
