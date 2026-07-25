'use strict';

function setupAiModule() {
  jest.resetModules();

  const runtimeMock = {
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
    extractNaturalToolCall: jest
      .fn()
      .mockReturnValueOnce({ action: 'shellCommand', arg: { command: 'sleep 35' } })
      .mockReturnValueOnce(null),
    runNaturalToolCall: jest.fn(async (_call, context = {}) => {
      const pulses = ['phase-1', 'phase-2', 'phase-3'];
      for (const pulse of pulses) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        context.onActivity?.(pulse);
        context.onProgress?.(pulse);
      }
      return { success: true, text: 'long-running small task finished' };
    }),
  };

  jest.doMock('../src/services/khyUpgradeRuntime', () => runtimeMock);
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
    generate: jest
      .fn()
      .mockResolvedValueOnce({
        success: true,
        content: '<tool_call>{"name":"shellCommand","params":{"command":"sleep 35"}}</tool_call>',
        provider: 'codex',
        adapter: 'codex',
      })
      .mockResolvedValueOnce({
        success: true,
        content: 'completed after tool',
        provider: 'codex',
        adapter: 'codex',
      }),
  }));
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

  const ai = require('../src/cli/ai');
  return { ai, runtimeMock };
}

describe('ai cli small-task idle timeout behavior', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('small task tool loop survives past 30s-equivalent when activity keeps flowing', async () => {
    process.env.KHY_TOOL_LOOP_TIMEOUT_MS = '40';
    process.env.KHY_TOOL_LOOP_MAX_SMALL = '4';

    const { ai, runtimeMock } = setupAiModule();
    ai.clearHistory();

    const statuses = [];
    const result = await ai.chat('hi', {
      disableNaturalToolLoop: false,
      onStatus: (st) => statuses.push(String(st && st.message ? st.message : '')),
      onChunk: () => {},
    });

    expect(result.reply).toContain('completed after tool');
    expect(runtimeMock.runNaturalToolCall).toHaveBeenCalledTimes(1);
    expect(statuses.some(s => s.includes('phase-1'))).toBe(true);
    expect(statuses.some(s => s.includes('Tool execution timed out after'))).toBe(false);
    expect(statuses.some(s => s.includes('idle timeout'))).toBe(false);
  });
});
