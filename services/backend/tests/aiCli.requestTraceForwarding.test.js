'use strict';

function setupAiModule(gatewayGenerate, options = {}) {
  jest.resetModules();
  const traceAudit = options.traceAudit || {
    ensureDiagnosticsBridge: jest.fn(),
    attachTrace: jest.fn(),
    logEvent: jest.fn(),
  };

  jest.doMock('../src/services/khyUpgradeRuntime', () => ({
    inputPurify: (input) => ({ purified: input, intent: 'general' }),
    isGreeting: () => false,
    makeSystemPrompt: () => 'system prompt',
    buildIntentAssuranceDirective: () => ({ shouldInject: false, directive: '', requestClass: '', primaryObjective: '', constraints: [], detailAnchors: [], tailDetails: [], summary: null, detailCount: 0, constraintCount: 0, tailDetailCount: 0 }),
    buildSlidingWindow: async (messages) => messages,
    buildFlatConversation: (_system, messages) => messages.map((m) => `${m.role}:${m.content}`).join('\n'),
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

  jest.doMock('../src/services/gateway/aiGateway', () => ({
    _initialized: true,
    init: jest.fn(async () => {}),
    getStatus: jest.fn(() => [
      { type: 'codex', enabled: true, available: true, name: 'OpenAI Codex' },
    ]),
    getFirstAvailableAdapter: jest.fn(() => 'codex'),
    getActiveAdapter: jest.fn(() => null),
    generate: gatewayGenerate,
  }));

  jest.doMock('../src/services/multiFreeService', () => {
    return jest.fn().mockImplementation(() => ({
      getStatus: () => (options.serviceStatus || { available: false, configuredProviders: [], provider: null }),
      getAvailableProvider: () => null,
      generateResponse: options.generateResponse || (async () => ({ success: false, errorType: 'network', content: '所有 AI 通道不可用。' })),
    }));
  });

  jest.doMock('../src/services/traceAuditService', () => traceAudit);

  jest.doMock('../src/services/tokenUsageService', () => ({
    recordUsage: () => {},
    estimateTokens: () => 1,
    estimateCost: () => 0,
  }));

  return { ai: require('../src/cli/ai'), traceAudit };
}

describe('ai cli request trace forwarding', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('forwards sessionId requestId and traceId into gateway.generate', async () => {
    const gatewayGenerate = jest.fn(async (_prompt, options = {}) => ({
      success: true,
      content: 'ok',
      provider: 'codex',
      adapter: 'codex',
      observed: {
        sessionId: options.sessionId,
        requestId: options.requestId,
        traceId: options._diagTraceId,
      },
    }));

    const { ai } = setupAiModule(gatewayGenerate);
    ai.clearHistory();

    const result = await ai.chat('请检查请求链路', {
      sessionId: 'sess-ai-trace',
      requestId: 'req-ai-trace',
      disableNaturalToolLoop: true,
      onStatus: () => {},
      onChunk: () => {},
    });

    expect(result.reply).toBe('ok');
    expect(gatewayGenerate).toHaveBeenCalledTimes(1);
    const forwarded = gatewayGenerate.mock.calls[0][1];
    expect(forwarded.sessionId).toBe('sess-ai-trace');
    expect(forwarded.requestId).toBe('req-ai-trace');
    expect(typeof forwarded._diagTraceId).toBe('string');
    expect(forwarded._diagTraceId.length).toBeGreaterThan(8);
  });

  test('logs llm request/response when directGenerate fallback bypasses aiGateway', async () => {
    const gatewayGenerate = jest.fn(async () => {
      throw new Error('gateway offline');
    });
    const generateResponse = jest.fn(async () => ({
      success: true,
      content: 'direct fallback ok',
      provider: 'mock-direct',
      model: 'mock-model',
      attempts: [{ provider: 'Mock Direct', success: true }],
    }));

    const { ai, traceAudit } = setupAiModule(gatewayGenerate, {
      serviceStatus: { available: true, configuredProviders: ['mock-direct'], provider: 'mock-direct' },
      generateResponse,
    });
    ai.clearHistory();

    const result = await ai.chat('请继续处理', {
      sessionId: 'sess-direct-trace',
      requestId: 'req-direct-trace',
      disableNaturalToolLoop: true,
      onStatus: () => {},
      onChunk: () => {},
    });

    expect(result.reply).toBe('direct fallback ok');
    expect(generateResponse).toHaveBeenCalledTimes(1);

    const llmRequest = traceAudit.logEvent.mock.calls.find(([type, , ctx]) => type === 'llm.request' && ctx?.source === 'ai-direct');
    const llmResponse = traceAudit.logEvent.mock.calls.find(([type, , ctx]) => type === 'llm.response' && ctx?.source === 'ai-direct');
    expect(llmRequest).toBeTruthy();
    expect(llmResponse).toBeTruthy();
    expect(llmRequest[2]).toEqual(expect.objectContaining({
      sessionId: 'sess-direct-trace',
      requestId: 'req-direct-trace',
      source: 'ai-direct',
    }));
    expect(llmResponse[1]).toEqual(expect.objectContaining({
      success: true,
      provider: 'mock-direct',
      contentPreview: 'direct fallback ok',
    }));
  });
});
