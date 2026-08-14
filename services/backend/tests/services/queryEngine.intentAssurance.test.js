'use strict';

async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('QueryEngine intent assurance forwarding', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('legacy path forwards external intent assurance into ai.chat', async () => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      KHY_QUERY_ENGINE_V2: 'false',
      KHY_QUERY_ENGINE_HARNESS: 'false',
    };

    jest.doMock('../../src/services/khyUpgradeRuntime', () => {
      const actual = jest.requireActual('../../src/services/khyUpgradeRuntime');
      return {
        ...actual,
        buildIntentAssuranceDirective: jest.fn(() => ({
          shouldInject: true,
          directive: 'INTENT ASSURANCE DIRECTIVE',
          summary: '检查 backend/src/cli/ai.js',
          detailCount: 4,
          constraintCount: 2,
          tailDetailCount: 1,
        })),
      };
    });

    jest.doMock('../../src/cli/ai', () => ({
      chat: jest.fn(async () => ({ reply: 'done', provider: 'mock-ai' })),
      getEffort: jest.fn(() => 'medium'),
      clearHistory: jest.fn(),
    }));

    jest.doMock('../../src/services/toolUseLoop', () => ({
      _parseToolCalls: jest.fn(() => []),
      // Legacy delegates to runToolUseLoop via the adapter; invoke the wrapped
      // chat once so intent-assurance chatOptsPatch reaches the mocked ai.chat.
      runToolUseLoop: jest.fn(async (message, opts) => {
        const result = await opts.chat(message, {});
        return { finalResponse: result?.reply || '', toolCallLog: [], iterations: 1 };
      }),
    }));

    jest.doMock('../../src/services/inputPreprocessor', () => ({
      preprocess: jest.fn((text) => ({ processed: text })),
    }));

    jest.doMock('../../src/services/securityGuardService', () => ({
      analyzeInput: jest.fn(() => ({ safe: true })),
    }));

    const QueryEngine = require('../../src/services/queryEngine').QueryEngine;
    const ai = require('../../src/cli/ai');
    require('../../src/services/aiChatPort').registerAiChat(ai.chat);
    require('../../src/services/aiConversationPort').registerAiConversation({ getEffort: ai.getEffort });
    const engine = new QueryEngine();

    const events = await collectEvents(engine.submitMessage(
      '你好，麻烦你帮我看看 backend/src/cli/ai.js，不要改接口，另外保留 Claude 兼容。',
      { useHarness: false }
    ));

    expect(ai.chat).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        _intentAssuranceDirective: 'INTENT ASSURANCE DIRECTIVE',
        _intentAssuranceMeta: expect.objectContaining({
          summary: '检查 backend/src/cli/ai.js',
          detailCount: 4,
          constraintCount: 2,
          tailDetailCount: 1,
        }),
      })
    );
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'thinking',
        data: expect.stringContaining('Intent assurance'),
      }),
      expect.objectContaining({
        type: 'done',
        data: expect.objectContaining({ reply: 'done' }),
      }),
    ]));
  });

  test('unified adapter path forwards external intent assurance into ai.chat', async () => {
    // Phase 3: the former V2 state machine was removed. Intent assurance is now
    // projected on the single unified path (legacy → adapter → toolUseLoop), so
    // this test mirrors the legacy case rather than asserting deps.callModel.
    jest.resetModules();
    process.env = {
      ...originalEnv,
      KHY_QUERY_ENGINE_V2: 'false',
      KHY_QUERY_ENGINE_HARNESS: 'false',
    };

    jest.doMock('../../src/services/khyUpgradeRuntime', () => {
      const actual = jest.requireActual('../../src/services/khyUpgradeRuntime');
      return {
        ...actual,
        buildIntentAssuranceDirective: jest.fn(() => ({
          shouldInject: true,
          directive: 'INTENT ASSURANCE V2',
          summary: '查询 noisy 输入中的核心目标',
          detailCount: 3,
          constraintCount: 1,
          tailDetailCount: 1,
        })),
      };
    });

    jest.doMock('../../src/cli/ai', () => ({
      chat: jest.fn(async () => ({ reply: 'done', provider: 'mock-ai' })),
      getEffort: jest.fn(() => 'medium'),
      clearHistory: jest.fn(),
    }));

    jest.doMock('../../src/services/toolUseLoop', () => ({
      _parseToolCalls: jest.fn(() => []),
      runToolUseLoop: jest.fn(async (message, opts) => {
        const result = await opts.chat(message, {});
        return { finalResponse: result?.reply || '', toolCallLog: [], iterations: 1 };
      }),
    }));

    jest.doMock('../../src/services/inputPreprocessor', () => ({
      preprocess: jest.fn((text) => ({ processed: text })),
    }));

    jest.doMock('../../src/services/securityGuardService', () => ({
      analyzeInput: jest.fn(() => ({ safe: true })),
    }));

    const QueryEngine = require('../../src/services/queryEngine').QueryEngine;
    const ai = require('../../src/cli/ai');
    require('../../src/services/aiChatPort').registerAiChat(ai.chat);
    require('../../src/services/aiConversationPort').registerAiConversation({ getEffort: ai.getEffort });
    const engine = new QueryEngine();

    const events = await collectEvents(engine.submitMessage(
      '你好，帮我查一下今天的接口变化，但不要漏掉最后补充的限制条件，另外只总结现状。',
      { useHarness: false }
    ));

    expect(ai.chat).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        _intentAssuranceDirective: 'INTENT ASSURANCE V2',
        _intentAssuranceMeta: expect.objectContaining({
          summary: '查询 noisy 输入中的核心目标',
          detailCount: 3,
          constraintCount: 1,
          tailDetailCount: 1,
        }),
      })
    );
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'thinking',
        data: expect.stringContaining('Intent assurance'),
      }),
      expect.objectContaining({
        type: 'done',
        data: expect.objectContaining({ reply: 'done' }),
      }),
    ]));
  });
});
