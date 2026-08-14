'use strict';

describe('toolUseLoop structured continuation context', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('passes initialMessages into the first chat call', async () => {
    const toolUseLoop = require('../src/services/toolUseLoop');
    const initialMessages = [
      { role: 'user', content: 'Earlier context' },
      { role: 'assistant', content: 'Earlier answer' },
    ];
    const chat = jest.fn(async () => ({ reply: 'Done.', provider: 'mock' }));

    await toolUseLoop.runToolUseLoop('Current task', {
      chat,
      maxIterations: 1,
      initialMessages,
    });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0]).toBe('Current task');
    expect(chat.mock.calls[0][1]._isFollowUp).toBe(false);
    expect(chat.mock.results[0].value).toBeDefined();
    const result = await chat.mock.results[0].value;
    expect(result.reply).toBe('Done.');
  });

  test('preserves initialMessages in returned conversation history', async () => {
    const toolUseLoop = require('../src/services/toolUseLoop');
    const initialMessages = [
      { role: 'user', content: 'Earlier context' },
      { role: 'assistant', content: 'Earlier answer' },
    ];
    const chat = jest.fn(async () => ({ reply: 'Done.', provider: 'mock' }));

    const result = await toolUseLoop.runToolUseLoop('Current task', {
      chat,
      maxIterations: 1,
      initialMessages,
    });

    expect(result.conversationMessages).toEqual([
      ...initialMessages,
      { role: 'user', content: 'Current task' },
    ]);
  });

  test('passes trace session and request identifiers into chat calls', async () => {
    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest.fn(async () => ({ reply: 'Done.', provider: 'mock' }));

    await toolUseLoop.runToolUseLoop('Current task', {
      chat,
      maxIterations: 1,
      sessionId: 'sess-trace-pass',
      requestId: 'req-trace-pass',
    });

    expect(chat).toHaveBeenCalledTimes(1);
    const firstOpts = chat.mock.calls[0][1];
    expect(firstOpts.sessionId).toBe('sess-trace-pass');
    expect(firstOpts.requestId).toBe('req-trace-pass');
    expect(typeof firstOpts._diagTraceId).toBe('string');
    expect(firstOpts._diagTraceId.length).toBeGreaterThan(8);
  });

  test('injects continuation signal into both plain text and structured tool result blocks exactly once', async () => {
    jest.doMock('../src/services/toolCalling', () => ({
      executeTool: jest.fn(async () => ({ success: true, output: 'ok' })),
      setPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({
        reply: '<tool_call>{"name":"shellCommand","params":{"command":"pwd"}}</tool_call>',
        provider: 'mock',
      })
      .mockResolvedValueOnce({
        reply: 'Finished.',
        provider: 'mock',
      });

    await toolUseLoop.runToolUseLoop('Check cwd', {
      chat,
      maxIterations: 3,
    });

    expect(chat.mock.calls.length).toBeGreaterThanOrEqual(2);
    const followUpCall = chat.mock.calls.find(([, opts]) => opts && opts._isFollowUp === true && Array.isArray(opts._structuredToolResultBlocks));
    expect(followUpCall).toBeDefined();
    const secondPrompt = String((followUpCall && followUpCall[0]) || '');
    const secondOpts = (followUpCall && followUpCall[1]) || {};
    const continuationMatches = secondPrompt.match(/\[SYSTEM: Tool results above\. Continue the task:/g) || [];
    const structuredBlocks = Array.isArray(secondOpts._structuredToolResultBlocks)
      ? secondOpts._structuredToolResultBlocks
      : [];
    const continuationTextBlocks = structuredBlocks.filter(
      (block) => block && block.type === 'text' && /\[SYSTEM: Tool results above\. Continue the task:/.test(String(block.text || ''))
    );

    expect(continuationMatches).toHaveLength(1);
    expect(continuationTextBlocks).toHaveLength(1);
  });
});
