'use strict';

function setupAiModule(gatewayMock) {
  jest.resetModules();

  jest.doMock('../src/services/khyUpgradeRuntime', () => ({
    inputPurify: (input) => ({ purified: input }),
    isGreeting: () => false,
    makeSystemPrompt: () => 'system prompt',
    buildIntentAssuranceDirective: () => ({ shouldInject: false, directive: '', requestClass: '', primaryObjective: '', constraints: [], detailAnchors: [], tailDetails: [], summary: null, detailCount: 0, constraintCount: 0, tailDetailCount: 0 }),
    buildSlidingWindow: async (messages) => messages,
    buildFlatConversation: (_system, messages) => messages.map(m => `${m.role}:${m.content}`).join('\n'),
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

  jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);
  jest.doMock('../src/services/multiFreeService', () => {
    return jest.fn().mockImplementation(() => ({
      getStatus: () => ({ available: false, configuredProviders: [], provider: null }),
      getAvailableProvider: () => null,
      generateResponse: async () => ({ success: false, errorType: 'network', content: '所有 AI 通道不可用。' }),
    }));
  });
  jest.doMock('../src/services/tokenUsageService', () => ({
    recordUsage: () => {},
    estimateTokens: () => 1,
  }));

  return require('../src/cli/ai');
}

describe('ai cli concurrent preferred adapter isolation', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('concurrent chats keep per-request preferred adapter without env cross-talk', async () => {
    const callLog = [];
    const gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => [
        { type: 'localLLM', enabled: true, available: true, name: '本地模型' },
        { type: 'codex', enabled: true, available: true, name: 'OpenAI Codex' },
      ]),
      testAdapter: jest.fn(async () => ({
        connectivity: { success: false, latencyMs: 5, error: 'probe fail' },
        generation: { success: false, latencyMs: 5, error: 'probe fail' },
        models: { success: false, latencyMs: 5, error: 'probe fail' },
      })),
      getFirstAvailableAdapter: jest.fn(() => 'localLLM'),
      getActiveAdapter: jest.fn(() => null),
      generateWithAdapter: jest.fn(async (_adapterKey, _prompt) => ({
        success: true,
        content: 'OK',
        provider: 'Local warmup',
        adapter: 'localLLM',
      })),
      generate: jest.fn(async (_prompt, options = {}) => {
        callLog.push({
          preferredAdapter: String(options.preferredAdapter || ''),
          preferredModel: String(options.preferredModel || ''),
          preferredStrict: options.preferredStrict,
          strictPreferred: options.strictPreferred,
        });
        await new Promise(resolve => setTimeout(resolve, options.preferredAdapter === 'localLLM' ? 35 : 5));
        return {
          success: true,
          content: `ok:${String(options.preferredAdapter || '')}`,
          provider: String(options.preferredAdapter || 'unknown'),
          adapter: String(options.preferredAdapter || 'unknown'),
        };
      }),
    };

    const ai = setupAiModule(gatewayMock);
    ai.clearHistory();

    process.env.GATEWAY_PREFERRED_ADAPTER = 'codex';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';

    const localPromise = ai.chat('读取 README 并总结', {
      preferredAdapter: 'localLLM',
      preferredStrict: true,
      strictPreferred: true,
      disableNaturalToolLoop: true,
      onStatus: () => {},
      onChunk: () => {},
    });
    const codexPromise = ai.chat('回答一个量化问题', {
      preferredAdapter: 'codex',
      preferredStrict: true,
      strictPreferred: true,
      disableNaturalToolLoop: true,
      onStatus: () => {},
      onChunk: () => {},
    });

    const [localResult, codexResult] = await Promise.all([localPromise, codexPromise]);

    expect(localResult.reply).toBe('ok:localLLM');
    expect(codexResult.reply).toBe('ok:codex');

    const adaptersSeen = callLog.map(x => x.preferredAdapter);
    expect(adaptersSeen).toContain('localLLM');
    expect(adaptersSeen).toContain('codex');
    expect(gatewayMock.generate).toHaveBeenCalledTimes(2);
  });
});
