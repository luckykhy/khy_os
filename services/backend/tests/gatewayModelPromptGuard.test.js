'use strict';

// Regression test for the `/model` "exits KHY to the shell" bug.
//
// Root cause: handleGatewaySelectModel drives its model picker through
// promptWithReplGuard, which signals inquirer activity to the REPL via the
// cross-module flag `global.__KHY_INQUIRER_ACTIVE__`. When inquirer tears down
// its readline it can emit a stray 'close' event on the REPL's readline
// slightly AFTER prompt() resolves. The REPL close-guard treats an unguarded
// close as a real Ctrl+D (EOF) and calls process.exit(0) — killing the whole
// session. The guard must therefore (a) be set while inquirer runs and
// (b) remain set across the macrotask boundary so the late close still sees it.

describe('promptWithReplGuard inquirer flag (/model exit guard)', () => {
  const FLAG = '__KHY_INQUIRER_ACTIVE__';
  let promptWithReplGuard;
  let resolvePrompt;

  beforeEach(() => {
    jest.resetModules();
    delete global[FLAG];

    // Mock inquirer with a manually-controllable prompt so we can observe the
    // flag state at the exact moment prompt() resolves.
    jest.doMock('inquirer', () => ({
      prompt: jest.fn(() => new Promise((resolve) => { resolvePrompt = resolve; })),
    }));

    ({ promptWithReplGuard } = require('../src/cli/handlers/gateway').__test__);
  });

  afterEach(() => {
    delete global[FLAG];
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('sets the guard flag while the prompt is pending', async () => {
    const pending = promptWithReplGuard([{ type: 'list', name: 'x', choices: ['a'] }]);
    // While inquirer is awaiting input, the REPL must see inquirer as active.
    expect(global[FLAG]).toBe(true);
    resolvePrompt({ x: 'a' });
    await pending;
  });

  test('keeps the flag set across the macrotask boundary after resolve', async () => {
    const pending = promptWithReplGuard([{ type: 'list', name: 'x', choices: ['a'] }]);
    resolvePrompt({ x: 'a' });
    await pending;
    // Critical: a stray readline 'close' fired during inquirer teardown (same
    // microtask / synchronous after resolve) must still see the guard as active.
    expect(global[FLAG]).toBe(true);
    // It is cleared on the next macrotask, once teardown has settled.
    await new Promise((r) => setImmediate(r));
    expect(global[FLAG]).toBe(false);
  });

  test('restores a previously-active outer guard instead of clobbering it', async () => {
    // Nested prompts (an outer inquirer flow opening an inner one) must not let
    // the inner finally turn the flag off for the still-running outer prompt.
    global[FLAG] = true;
    const pending = promptWithReplGuard([{ type: 'input', name: 'y' }]);
    resolvePrompt({ y: 'z' });
    await pending;
    await new Promise((r) => setImmediate(r));
    expect(global[FLAG]).toBe(true);
  });
});
