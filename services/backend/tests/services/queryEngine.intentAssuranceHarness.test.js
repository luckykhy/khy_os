'use strict';

async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('QueryEngine intent assurance forwarding through harness', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('harness path keeps intent assurance when request.chat forwards into ai.chat', async () => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      KHY_QUERY_ENGINE_V2: 'false',
      KHY_QUERY_ENGINE_HARNESS: 'true',
    };

    const harnessRun = jest.fn(async (request) => {
      await request.chat('请继续处理', { _isFollowUp: true });
      return {
        finalResponse: 'harness done',
        provider: 'mock-harness',
        tokenUsage: null,
        iterations: 1,
        toolCallLog: [],
      };
    });

    jest.doMock('../../src/services/khyUpgradeRuntime', () => {
      const actual = jest.requireActual('../../src/services/khyUpgradeRuntime');
      return {
        ...actual,
        buildIntentAssuranceDirective: jest.fn(() => ({
          shouldInject: true,
          directive: 'INTENT ASSURANCE HARNESS',
          requestClass: '代码/文件任务',
          primaryObjective: '检查 backend/src/cli/ai.js 的继续执行逻辑',
          summary: '检查 backend/src/cli/ai.js 的继续执行逻辑',
          constraints: ['不要改接口', '保留 Claude 兼容'],
          detailAnchors: ['backend/src/cli/ai.js', 'Claude'],
          tailDetails: ['另外保留 Claude 兼容'],
          detailCount: 2,
          constraintCount: 2,
          tailDetailCount: 1,
        })),
      };
    });

    jest.doMock('../../src/cli/ai', () => ({
      chat: jest.fn(async () => ({ reply: 'unused', provider: 'mock-ai', tokenUsage: null })),
      getEffort: jest.fn(() => 'medium'),
      clearHistory: jest.fn(),
    }));

    jest.doMock('../../src/services/agenticHarnessService', () => ({
      createAgenticHarness: jest.fn(() => ({
        run: harnessRun,
      })),
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
      { useHarness: true }
    ));

    expect(harnessRun).toHaveBeenCalledTimes(1);
    expect(ai.chat).toHaveBeenCalledWith(
      '请继续处理',
      expect.objectContaining({
        _intentAssuranceDirective: 'INTENT ASSURANCE HARNESS',
        _intentAssuranceMeta: expect.objectContaining({
          requestClass: '代码/文件任务',
          primaryObjective: '检查 backend/src/cli/ai.js 的继续执行逻辑',
          summary: '检查 backend/src/cli/ai.js 的继续执行逻辑',
          constraints: ['不要改接口', '保留 Claude 兼容'],
          detailAnchors: ['backend/src/cli/ai.js', 'Claude'],
          tailDetails: ['另外保留 Claude 兼容'],
          detailCount: 2,
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
        type: 'thinking',
        data: expect.stringContaining('Harness prepare'),
      }),
      expect.objectContaining({
        type: 'done',
        data: expect.objectContaining({
          reply: 'harness done',
          provider: 'mock-harness',
        }),
      }),
    ]));
  });
});
