'use strict';

function setupAiModule() {
  jest.resetModules();
  const traceAudit = {
    ensureDiagnosticsBridge: jest.fn(),
    attachTrace: jest.fn(),
    logEvent: jest.fn(),
  };

  const gatewayGenerate = jest.fn(async () => ({
    success: true,
    content: 'gateway should not be used for simple greeting',
    provider: 'mock',
    adapter: 'mock',
  }));

  jest.doMock('../src/services/gateway/aiGateway', () => ({
    _initialized: true,
    init: jest.fn(async () => {}),
    getStatus: jest.fn(() => []),
    getFirstAvailableAdapter: jest.fn(() => 'codex'),
    getActiveAdapter: jest.fn(() => null),
    generate: gatewayGenerate,
  }));

  jest.doMock('../src/services/traceAuditService', () => traceAudit);

  const ai = require('../src/cli/ai');
  return { ai, gatewayGenerate, traceAudit };
}

describe('ai cli greeting fastpath', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('simple greeting returns immediately via local fastpath and skips gateway', async () => {
    process.env.KHY_GREETING_FASTPATH = 'true';
    const { ai, gatewayGenerate, traceAudit } = setupAiModule();
    ai.clearHistory();

    const statuses = [];
    const result = await ai.chat('你好', {
      sessionId: 'sess-fastpath',
      requestId: 'req-fastpath',
      onStatus: (st) => statuses.push(`${st && st.phase ? st.phase : ''}:${st && st.message ? st.message : ''}`),
    });

    expect(result.provider).toBe('khy-fastpath');
    expect(result.adapter).toBe('khy-fastpath');
    expect(result.reply).toContain('khy OS');
    expect(statuses.some(s => s.includes('极速回复'))).toBe(true);
    expect(gatewayGenerate).not.toHaveBeenCalled();
    expect(traceAudit.logEvent).toHaveBeenCalledWith(
      'llm.request',
      expect.objectContaining({
        requestId: 'req-fastpath',
        requestedModel: 'khy-fastpath',
      }),
      expect.objectContaining({
        sessionId: 'sess-fastpath',
        requestId: 'req-fastpath',
        source: 'ai-fastpath',
      })
    );
    expect(traceAudit.logEvent).toHaveBeenCalledWith(
      'llm.response',
      expect.objectContaining({
        requestId: 'req-fastpath',
        success: true,
        provider: 'khy-fastpath',
      }),
      expect.objectContaining({
        sessionId: 'sess-fastpath',
        requestId: 'req-fastpath',
        source: 'ai-fastpath',
      })
    );
  });

  test('simple greeting uses real model path by default (fastpath disabled)', async () => {
    delete process.env.KHY_GREETING_FASTPATH;
    const { ai, gatewayGenerate } = setupAiModule();
    ai.clearHistory();

    const statuses = [];
    const result = await ai.chat('你好', {
      onStatus: (st) => statuses.push(`${st && st.phase ? st.phase : ''}:${st && st.message ? st.message : ''}`),
    });

    expect(result.provider).not.toBe('khy-fastpath');
    expect(result.adapter).not.toBe('khy-fastpath');
    expect(gatewayGenerate).toHaveBeenCalled();
    expect(statuses.some(s => s.includes('任务规模识别: small'))).toBe(true);
  });
});
