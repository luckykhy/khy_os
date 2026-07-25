'use strict';

function createGatewayMock() {
  return {
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
    generate: jest.fn(async () => {
      throw new Error('AI gateway idle timeout after 45s — stream stalled');
    }),
  };
}

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

describe('ai cli feedback stability', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test.each([
    ['localLLM', '请求 AI 服务...（本地模型首轮可能需要 30-120 秒预热）'],
    ['codex', '请求 AI 服务...'],
  ])('same-task strict preferred timeout keeps feedback for %s', async (preferredAdapter, expectedRequestStatus) => {
    process.env.GATEWAY_PREFERRED_ADAPTER = preferredAdapter;
    process.env.GATEWAY_PREFERRED_STRICT = 'true';

    const gatewayMock = createGatewayMock();
    gatewayMock.getFirstAvailableAdapter.mockReturnValue(preferredAdapter);
    const ai = setupAiModule(gatewayMock);
    ai.clearHistory();

    const statuses = [];
    const result = await ai.chat('分析一下比亚迪最近走势', {
      strictPreferred: true,
      disableNaturalToolLoop: true,
      onStatus: (st) => statuses.push(String(st && st.message ? st.message : '')),
      onChunk: () => {},
    });

    expect(result).toBeDefined();
    expect(result.reply).toContain('AI 网关异常');
    expect(result.reply).toContain('已跳过云端兜底');
    expect(result.reply.toLowerCase()).toContain(preferredAdapter.toLowerCase());
    const requestStatusMatched = preferredAdapter === 'localLLM'
      ? statuses.some(s => (
        s.includes('请求 AI 服务...（本地模型首轮可能需要 30-120 秒预热）')
        || s.includes('请求 AI 服务...（检测到本地模型已热启动，预计更快返回）')
      ))
      : statuses.some(s => s.includes(expectedRequestStatus));
    expect(requestStatusMatched).toBe(true);
    expect(statuses.some(s => s.includes('失败原因:'))).toBe(true);
    expect(statuses.some(s => s.includes('初始化...'))).toBe(true);
    expect(statuses.some(s => s.includes('失败'))).toBe(true);
  });

  test('mirrors adapter status chunks into onStatus', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = 'codex';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';

    const gatewayMock = createGatewayMock();
    gatewayMock.generate.mockImplementation(async (_prompt, options = {}) => {
      options.onChunk?.({ type: 'status', text: 'Codex 启动中...' });
      options.onChunk?.({ type: 'status', text: 'Codex 开始处理请求' });
      return {
        success: true,
        content: 'done',
        provider: 'codex',
        adapter: 'codex',
      };
    });

    const ai = setupAiModule(gatewayMock);
    ai.clearHistory();

    const statuses = [];
    const result = await ai.chat('测试反馈镜像', {
      strictPreferred: true,
      disableNaturalToolLoop: true,
      onStatus: (st) => statuses.push(String(st && st.message ? st.message : '')),
    });

    expect(result.reply).toBe('done');
    expect(statuses.some(s => s.includes('Codex 启动中'))).toBe(true);
    expect(statuses.some(s => s.includes('Codex 开始处理请求'))).toBe(true);
  });

  test('deduplicates repeated adapter status chunks in onStatus', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = 'codex';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';
    process.env.KHY_AI_STATUS_DEDUP_MS = '3000';

    const gatewayMock = createGatewayMock();
    gatewayMock.generate.mockImplementation(async (_prompt, options = {}) => {
      options.onChunk?.({ type: 'status', text: 'Trying adapter: OpenAI Codex' });
      options.onChunk?.({ type: 'status', text: 'Trying adapter: OpenAI Codex' });
      return {
        success: true,
        content: 'done',
        provider: 'codex',
        adapter: 'codex',
      };
    });

    const ai = setupAiModule(gatewayMock);
    ai.clearHistory();

    const statuses = [];
    const result = await ai.chat('测试状态去重', {
      strictPreferred: true,
      disableNaturalToolLoop: true,
      onStatus: (st) => statuses.push(String(st && st.message ? st.message : '')),
    });

    expect(result.reply).toBe('done');
    const duplicateCount = statuses.filter(s => s.includes('Trying adapter: OpenAI Codex')).length;
    expect(duplicateCount).toBe(1);
  });

  test('caps local preferred maxTokens for faster response UX', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = 'localLLM';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';
    process.env.KHY_LOCAL_COLD_MAX_TOKENS = '1024';
    process.env.KHY_LOCAL_WARM_MAX_TOKENS = '1024';

    const gatewayMock = createGatewayMock();
    let seenMaxTokens = null;
    gatewayMock.generate.mockImplementation(async (_prompt, options = {}) => {
      seenMaxTokens = options.maxTokens;
      return {
        success: true,
        content: 'done',
        provider: 'local',
        adapter: 'localLLM',
      };
    });

    const ai = setupAiModule(gatewayMock);
    ai.clearHistory();

    const result = await ai.chat('测试本地 maxTokens 上限', {
      strictPreferred: true,
      disableNaturalToolLoop: true,
    });

    expect(result.reply).toBe('done');
    expect(seenMaxTokens).toBe(1024);
  });

  test('queue-timeout preferred failure triggers one relaxed retry when preferredStrict is disabled', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = 'codex';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';

    const gatewayMock = createGatewayMock();
    gatewayMock.generate
      .mockImplementationOnce(async (_prompt, options = {}) => ({
        success: false,
        content: '已选择模型通道请求失败: adapter codex queue timeout',
        errorType: 'process',
        provider: 'none',
        adapter: 'none',
        attempts: [{
          provider: 'codex',
          adapterKey: 'codex',
          success: false,
          error: 'adapter codex queue timeout',
          statusCode: 0,
          errorType: 'process',
        }],
        strictPreferredEcho: options.strictPreferred,
      }))
      .mockImplementationOnce(async (_prompt, options = {}) => ({
        success: true,
        content: 'fallback ok',
        provider: 'relay_api',
        adapter: 'relay_api',
        strictPreferredEcho: options.strictPreferred,
      }));

    const ai = setupAiModule(gatewayMock);
    ai.clearHistory();

    const statuses = [];
    const result = await ai.chat('请继续执行并自检', {
      preferredStrict: false,
      disableNaturalToolLoop: true,
      onStatus: (st) => statuses.push(String(st && st.message ? st.message : '')),
    });

    expect(result.reply).toBe('fallback ok');
    expect(gatewayMock.generate).toHaveBeenCalledTimes(2);
    expect(gatewayMock.generate.mock.calls[0][1].strictPreferred).toBeUndefined();
    expect(gatewayMock.generate.mock.calls[1][1].strictPreferred).toBe(false);
    expect(statuses.some(s => s.includes('首选通道失败，尝试自动回退'))).toBe(true);
  });
});
