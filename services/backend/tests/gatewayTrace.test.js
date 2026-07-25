'use strict';

describe('gateway trace command', () => {
  let logSpy;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (logSpy) logSpy.mockRestore();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  function mockFormatters() {
    const printSuccess = jest.fn();
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printTable = jest.fn();
    jest.doMock('../src/cli/formatters', () => ({
      printSuccess,
      printError,
      printInfo,
      printTable,
      ICON_GATEWAY: 'G',
      stripAnsi: (s) => String(s || ''),
      displayWidth: (s) => String(s || '').length,
      padToWidth: (s, width) => {
        const text = String(s || '');
        const safeWidth = Math.max(0, Number(width) || 0);
        return text.length >= safeWidth ? text : `${text}${' '.repeat(safeWidth - text.length)}`;
      },
      truncateToWidth: (s, width) => {
        const text = String(s || '');
        const safeWidth = Math.max(0, Number(width) || 0);
        return text.length > safeWidth ? text.slice(0, safeWidth) : text;
      },
      safeTerminalString: (s) => String(s || ''),
    }));
    return { printSuccess, printError, printInfo, printTable };
  }

  test('prints request-level trace summary in text mode', async () => {
    const { printInfo } = mockFormatters();
    jest.doMock('../src/services/traceAuditService', () => ({
      getRequestTraceSummary: jest.fn(() => ({
        ok: true,
        sessionId: 'sess-1',
        requestId: 'req-1',
        summary: '最近一次交付链路可能断裂（requestId=req-1，阶段=final_conclusion）；最近一次语言一致性异常（adapter=Codex CLI，requestId=req-1，检测=en，期望=zh，来源=first_chunk）；最后事件=agent.delivery.final',
        totalEvents: 5,
        firstEvent: {
          type: 'llm.request',
          timestamp: '2026-05-30T10:00:00.000Z',
          source: 'ai-gateway',
        },
        lastEvent: {
          type: 'agent.delivery.final',
          timestamp: '2026-05-30T10:00:03.000Z',
          source: 'tool-use-loop',
        },
        delivery: {
          brokenStage: 'final_conclusion',
        },
        language: {
          status: 'mismatch',
          detectedLanguage: 'en',
          expectedLanguage: 'zh',
          textSample: 'I will inspect the repository first.',
        },
        timeline: [
          { stage: 'model_request', type: 'llm.request', timestamp: '2026-05-30T10:00:00.000Z', source: 'ai-gateway' },
          { stage: 'language_first_chunk', type: 'agent.language.first_chunk', timestamp: '2026-05-30T10:00:01.000Z', source: 'ai-gateway' },
          { stage: 'delivery_final', type: 'agent.delivery.final', timestamp: '2026-05-30T10:00:03.000Z', source: 'tool-use-loop' },
        ],
      })),
    }));

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayTrace(['req-1'], {});

    expect(printInfo).toHaveBeenCalledWith('Request Trace: requestId=req-1 · session=sess-1');
    expect(printInfo).toHaveBeenCalledWith('交付断点: final_conclusion');
    expect(printInfo).toHaveBeenCalledWith('语言偏航: 检测=en，期望=zh，sample=I will inspect the repository first.');

    const output = logSpy.mock.calls.map((call) => String(call[0] || '')).join('\n');
    expect(output).toContain('model_request');
    expect(output).toContain('language_first_chunk');
    expect(output).toContain('delivery_final');
    expect(output).toContain('agent.language.first_chunk');
    expect(output).toContain('agent.delivery.final');
  });

  test('returns JSON payload in json mode', async () => {
    mockFormatters();
    jest.doMock('../src/services/traceAuditService', () => ({
      getRequestTraceSummary: jest.fn(() => ({
        ok: true,
        requestId: 'req-json-1',
        sessionId: 'sess-json-1',
        summary: 'trace ok',
        totalEvents: 2,
        timeline: [],
      })),
    }));

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayTrace(['req-json-1'], { json: true });

    const payload = JSON.parse(logSpy.mock.calls.map((call) => String(call[0] || '')).join(''));
    expect(payload).toEqual({
      ok: true,
      requestId: 'req-json-1',
      sessionId: 'sess-json-1',
      summary: 'trace ok',
      totalEvents: 2,
      timeline: [],
    });
  });
});
