'use strict';

describe('toolUseLoop progress preface defaults', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('passes suppressPrefixOnToolCall=false to chat by default', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';

    jest.doMock('../src/services/traceAuditService', () => ({
      ensureDiagnosticsBridge: jest.fn(),
      attachTrace: jest.fn(),
      logEvent: jest.fn(),
      getContext: () => ({ sessionId: 'sess-1', traceId: 'trace-1', requestId: 'req-1' }),
    }));
    jest.doMock('../src/services/toolCalling', () => ({
      executeTool: jest.fn(async () => ({ success: true, output: 'ok' })),
      setPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest.fn()
      .mockResolvedValueOnce({
        reply: '[Plan] Read repl.js\nI will inspect repl.js first.\n<tool_call>{"name":"Read","params":{"file_path":"backend/src/cli/repl.js"}}</tool_call>',
        provider: 'mock',
      })
      .mockResolvedValueOnce({
        reply: 'The file has been inspected.',
        provider: 'mock',
      });

    await toolUseLoop.runToolUseLoop('Inspect repl.js', {
      chat,
      maxIterations: 3,
      sessionId: 'sess-1',
      requestId: 'req-1',
    });

    expect(chat).toHaveBeenCalled();
    expect(chat.mock.calls[0][1].suppressPrefixOnToolCall).toBe(false);
    // Pre-tool prose now flows as normal streaming text (not routed to a
    // one-line preface), so this defaults to false.
    expect(chat.mock.calls[0][1].routeToolPrefaceToNarration).toBe(false);
  });
});
