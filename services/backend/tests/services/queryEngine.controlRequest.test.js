'use strict';

jest.mock('../../src/cli/ai', () => ({
  chat: jest.fn(),
  getEffort: jest.fn(() => 'medium'),
}));

jest.mock('../../src/services/toolUseLoop', () => ({
  _parseToolCalls: jest.fn(() => []),
  // Legacy now routes through _submitMessageViaToolLoop → runToolUseLoop. The
  // adapter wraps the host chat; invoking it once drives the scripted ai.chat
  // (which fires onControlRequest/onChunk), then we return a final response.
  runToolUseLoop: jest.fn(async (message, opts) => {
    const result = await opts.chat(message, {});
    return {
      finalResponse: result?.reply || '',
      toolCallLog: [],
      iterations: 1,
    };
  }),
}));

jest.mock('../../src/services/inputPreprocessor', () => ({
  preprocess: jest.fn((text) => ({ processed: text })),
}));

jest.mock('../../src/services/securityGuardService', () => ({
  analyzeInput: jest.fn(() => ({ safe: true })),
}));

async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('QueryEngine control_request consumption', () => {
  const originalEnv = process.env;
  let QueryEngine;
  let ai;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      KHY_QUERY_ENGINE_V2: 'false',
      KHY_QUERY_ENGINE_HARNESS: 'false',
    };
    ai = require('../../src/cli/ai');
    QueryEngine = require('../../src/services/queryEngine').QueryEngine;
    ai.chat.mockReset();
    ai.getEffort.mockReturnValue('medium');
    // queryEngine consumes chat/effort via the inversion ports (DESIGN-ARCH-021),
    // not a direct cli/ai require. Wire the same mock fns into the ports so the
    // streaming path resolves them and the `ai.chat` assertions still hold.
    require('../../src/services/aiChatPort').registerAiChat(ai.chat);
    require('../../src/services/aiConversationPort').registerAiConversation({ getEffort: ai.getEffort });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test('yields control_request events to the caller event stream', async () => {
    const controlCallback = jest.fn(() => ({ decision: 'allow' }));

    ai.chat.mockImplementation(async (_message, options = {}) => {
      const payload = {
        requestId: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
        },
      };

      if (typeof options.onControlRequest === 'function') {
        options.onControlRequest(payload);
      }
      if (typeof options.onChunk === 'function') {
        options.onChunk({
          type: 'control_request',
          ...payload,
        });
        options.onChunk({
          type: 'text',
          text: 'Final answer.',
        });
      }

      return { reply: 'Final answer.' };
    });

    const engine = new QueryEngine();
    const events = await collectEvents(engine.submitMessage('hello', {
      useHarness: false,
      onControlRequest: controlCallback,
    }));

    expect(ai.chat).toHaveBeenCalledWith('hello', expect.objectContaining({
      onChunk: expect.any(Function),
      onControlRequest: expect.any(Function),
    }));
    expect(controlCallback).toHaveBeenCalledWith({
      requestId: 'req-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
      },
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'control_request',
        data: {
          requestId: 'req-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
          },
        },
      }),
      expect.objectContaining({
        type: 'text',
        data: 'Final answer.',
      }),
      expect.objectContaining({
        type: 'done',
        data: expect.objectContaining({
          reply: 'Final answer.',
        }),
      }),
    ]));
  });
});
