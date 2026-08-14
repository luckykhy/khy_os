'use strict';

describe('toolUseLoop intent gate integration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('injects ultrawork directive into loop prompt when keyword is present', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    const { ULTRAWORK_DIRECTIVE } = require('../src/services/intentGate');
    const toolUseLoop = require('../src/services/toolUseLoop');

    const chat = jest.fn(async () => ({ reply: 'Done.' }));
    await toolUseLoop.runToolUseLoop('Please ultrawork this fix.', { chat, maxIterations: 1 });

    expect(chat).toHaveBeenCalledTimes(1);
    const firstPrompt = String(chat.mock.calls[0][0] || '');
    expect(firstPrompt).toContain('Please ultrawork this fix.');
    expect(chat.mock.calls[0][1]._intentDirective).toBe(ULTRAWORK_DIRECTIVE);
  });

  test('does not inject ultrawork directive when keyword is only inside code block', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    const toolUseLoop = require('../src/services/toolUseLoop');

    const chat = jest.fn(async () => ({ reply: 'Done.' }));
    const userPrompt = ['Use the following command:', '```bash', 'echo ultrawork', '```'].join('\n');
    await toolUseLoop.runToolUseLoop(userPrompt, { chat, maxIterations: 1 });

    expect(chat).toHaveBeenCalledTimes(1);
    const firstPrompt = String(chat.mock.calls[0][0] || '');
    expect(firstPrompt).not.toContain('[SYSTEM: ULTRAWORK mode activated by user keyword.]');
  });

  test('applies ultrawork model override when chat option is empty', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_ULTRAWORK_PREFERRED_MODEL = 'claude-4-sonnet';
    const toolUseLoop = require('../src/services/toolUseLoop');

    const chat = jest.fn(async () => ({ reply: 'Done.' }));
    await toolUseLoop.runToolUseLoop('ulw run this task', { chat, maxIterations: 1, chatOpts: {} });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1].preferredModel).toBe('claude-4-sonnet');
  });

  test('keeps explicit chat preferredModel unless force override is enabled', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_ULTRAWORK_PREFERRED_MODEL = 'claude-4-sonnet';
    const toolUseLoop = require('../src/services/toolUseLoop');

    const chat = jest.fn(async () => ({ reply: 'Done.' }));
    await toolUseLoop.runToolUseLoop('ultrawork execute', {
      chat,
      maxIterations: 1,
      chatOpts: { preferredModel: 'user-selected-model' },
    });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1].preferredModel).toBe('user-selected-model');
  });

  test('force override replaces explicit chat preferredModel', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_ULTRAWORK_PREFERRED_MODEL = 'claude-4-sonnet';
    process.env.KHY_ULTRAWORK_FORCE_OVERRIDE = 'true';
    const toolUseLoop = require('../src/services/toolUseLoop');

    const chat = jest.fn(async () => ({ reply: 'Done.' }));
    await toolUseLoop.runToolUseLoop('ultrawork execute', {
      chat,
      maxIterations: 1,
      chatOpts: { preferredModel: 'user-selected-model' },
    });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1].preferredModel).toBe('claude-4-sonnet');
  });
});
