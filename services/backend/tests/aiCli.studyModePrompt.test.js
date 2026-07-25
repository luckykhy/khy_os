'use strict';

function setupAiModule(capture, gatewayOverrides = {}) {
  jest.resetModules();

  jest.doMock('../src/services/khyUpgradeRuntime', () => ({
    inputPurify: (input) => ({ purified: input }),
    isGreeting: () => false,
    makeSystemPrompt: () => 'BASE_SYSTEM_PROMPT',
    buildIntentAssuranceDirective: () => ({ shouldInject: false, directive: '', requestClass: '', primaryObjective: '', constraints: [], detailAnchors: [], tailDetails: [], summary: null, detailCount: 0, constraintCount: 0, tailDetailCount: 0 }),
    buildSlidingWindow: async (messages) => messages,
    buildFlatConversation: (systemPrompt, messages) => [
      `SYSTEM:${systemPrompt}`,
      ...messages.map((m) => `${m.role}:${m.content}`),
    ].join('\n'),
    lockTemperature: () => 0.3,
    lockTopP: () => 1,
    CONTEXT_TOKEN_LIMIT: 120000,
    postProcessOutput: (text) => text,
    extractNaturalToolCall: () => null,
    runNaturalToolCall: async () => ({ success: true, text: 'ok' }),
  }));

  jest.doMock('../src/services/securityGuardService', () => ({
    analyzeInput: () => ({ safe: true }),
    sanitizeOutput: (text) => text,
    getSecurityDirective: () => '',
  }));

  jest.doMock('../src/services/contextRouter', () => ({
    routeContextStrategy: () => ({ route: 'fits', overflow: 0 }),
    truncateToolResults: () => {},
  }));

  const defaultActiveAdapter = gatewayOverrides.activeAdapter || {
    name: 'codex',
    activeModel: 'gpt-4o',
  };
  const defaultGenerate = async (prompt) => {
    capture.prompt = String(prompt || '');
    return {
      success: true,
      content: 'done',
      provider: 'codex',
      adapter: 'codex',
    };
  };

  const gatewayMock = {
    _initialized: true,
    init: jest.fn(async () => {}),
    getStatus: jest.fn(() => [
      { type: 'codex', enabled: true, available: true, name: 'OpenAI Codex' },
    ]),
    testAdapter: jest.fn(async () => ({
      connectivity: { success: true, latencyMs: 5 },
      generation: { success: true, latencyMs: 5 },
      models: { success: true, latencyMs: 5 },
    })),
    getFirstAvailableAdapter: jest.fn(() => String(defaultActiveAdapter.name || 'codex')),
    getActiveAdapter: jest.fn(() => defaultActiveAdapter),
    generate: jest.fn(gatewayOverrides.generate || defaultGenerate),
  };
  if (typeof gatewayOverrides.getStatus === 'function') {
    gatewayMock.getStatus = jest.fn(gatewayOverrides.getStatus);
  }
  jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

  jest.doMock('../src/services/multiFreeService', () => {
    return jest.fn().mockImplementation(() => ({
      getStatus: () => ({ available: false, configuredProviders: [], provider: null }),
      getAvailableProvider: () => null,
      generateResponse: async () => ({ success: false, errorType: 'network', content: 'all providers unavailable' }),
    }));
  });

  jest.doMock('../src/services/tokenUsageService', () => ({
    recordUsage: () => {},
    estimateTokens: () => 1,
  }));

  jest.doMock('../src/services/chatLatencyAutoTuner', () => ({
    recordChatFirstTokenSample: jest.fn(() => ({
      profile: 'default_chat',
      summary: { p50: 0, p95: 0, count: 0, failureCount: 0 },
      tuned: false,
    })),
  }));

  return require('../src/cli/ai');
}

describe('ai cli study mode prompt injection', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('injects study mode learning contract into system prompt when study mode is on', async () => {
    const capture = { prompt: '' };
    const ai = setupAiModule(capture);
    ai.clearHistory();
    ai.enableStudyMode();

    const result = await ai.chat('请讲解均线和金叉', {
      disableNaturalToolLoop: true,
      onStatus: () => {},
      onChunk: () => {},
    });

    expect(result.reply).toBe('done');
    expect(capture.prompt).toContain('KHY_STUDY_MODE_LEARNING_CONTRACT');
  });

  test('does not inject study mode learning contract when study mode is off', async () => {
    const capture = { prompt: '' };
    const ai = setupAiModule(capture);
    ai.clearHistory();
    ai.disableStudyMode();

    const result = await ai.chat('请讲解均线和金叉', {
      disableNaturalToolLoop: true,
      onStatus: () => {},
      onChunk: () => {},
    });

    expect(result.reply).toBe('done');
    expect(capture.prompt).not.toContain('KHY_STUDY_MODE_LEARNING_CONTRACT');
  });

  test('injects task self-awareness guide for non-small task even when study mode is off', async () => {
    const capture = { prompt: '' };
    const ai = setupAiModule(capture);
    ai.clearHistory();
    ai.disableStudyMode();

    const result = await ai.chat(
      '请做一个完整实现：先规划模块，再逐步执行，并给出验证步骤和结果说明，覆盖端到端流程。',
      {
        disableNaturalToolLoop: true,
        onStatus: () => {},
        onChunk: () => {},
      }
    );

    expect(result.reply).toBe('done');
    expect(capture.prompt).toContain('KHY_TASK_SELF_AWARENESS_GUIDE');
  });

  test('hard guard blocks mismatch first, then executes only after explicit confirmation', async () => {
    process.env.KHY_TASK_SELF_AWARENESS_HARD = 'true';
    process.env.GATEWAY_PREFERRED_MODEL = 'gpt-4o-mini';
    const capture = { prompt: '', calls: 0 };
    const ai = setupAiModule(capture, {
      activeAdapter: { name: 'gpt-4o-mini', activeModel: 'gpt-4o-mini' },
      generate: async (prompt) => {
        capture.calls += 1;
        capture.prompt = String(prompt || '');
        return {
          success: true,
          content: 'done',
          provider: 'codex',
          adapter: 'codex',
        };
      },
    });
    ai.clearHistory();
    ai.disableStudyMode();
    const gw = require('../src/services/gateway/aiGateway');
    expect(gw.getActiveAdapter().activeModel).toBe('gpt-4o-mini');

    const capability = ai.checkModelCapability(
      '请实现一个完整的异步任务调度器，并分析失败重试与并发冲突处理策略。'
    );
    expect(capability).toBeTruthy();
    expect(Array.isArray(capability.issues)).toBe(true);
    expect(capability.issues.length).toBeGreaterThan(0);

    const blocked = await ai.chat(
      '请实现一个完整的异步任务调度器，并分析失败重试与并发冲突处理策略。',
      {
        disableNaturalToolLoop: true,
        onStatus: () => {},
        onChunk: () => {},
      }
    );

    expect(blocked.errorType).toBe('capability_guard');
    expect(blocked.reply).toContain('能力硬约束触发');
    expect(capture.calls).toBe(0);

    const guardIdMatch = String(blocked.reply || '').match(/任务ID:\s*(tg-[a-z0-9-]+)/i);
    expect(guardIdMatch).toBeTruthy();
    const guardId = guardIdMatch[1];

    const confirmed = await ai.chat(`确认执行 ${guardId}`, {
      disableNaturalToolLoop: true,
      onStatus: () => {},
      onChunk: () => {},
    });

    expect(confirmed.reply).toBe('done');
    expect(capture.calls).toBe(1);
    expect(capture.prompt).toContain('异步任务调度器');
  });
});
