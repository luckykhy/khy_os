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
    const { printInfo, printTable } = mockFormatters();
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

    // Production renders the trace as three tables via printTable (the old
    // printInfo('Request Trace: ...') line output was replaced by the table
    // layout); printInfo now only emits the blank-line separators around each
    // table. Assert on the tables plus their row payloads instead.
    expect(printTable).toHaveBeenCalledWith(
      ['属性', '值'],
      expect.arrayContaining([
        ['Request ID', 'req-1'],
        ['Session ID', 'sess-1'],
        ['链路摘要', expect.stringContaining('final_conclusion')],
        ['交付断点', 'final_conclusion'],
      ])
    );
    expect(printTable).toHaveBeenCalledWith(
      ['语言', '值'],
      expect.arrayContaining([
        ['检测', 'en'],
        ['期望', 'zh'],
        ['样本', 'I will inspect the repository first.'],
      ])
    );
    expect(printTable).toHaveBeenCalledWith(
      ['时间', '阶段', '类型', '来源'],
      expect.arrayContaining([
        ['2026-05-30T10:00:00.000Z', 'model_request', 'llm.request', 'ai-gateway'],
        ['2026-05-30T10:00:01.000Z', 'language_first_chunk', 'agent.language.first_chunk', 'ai-gateway'],
        ['2026-05-30T10:00:03.000Z', 'delivery_final', 'agent.delivery.final', 'tool-use-loop'],
      ])
    );
    // Blank-line separators: 4 printInfo('') calls around the three tables.
    expect(printInfo.mock.calls.filter(([s]) => s === '').length).toBe(4);
    // Header lines still go through console.log (chalk.bold 'Request Trace',
    // timeline title) — keep asserting on the captured console output.
    const output = logSpy.mock.calls.map((call) => String(call[0] || '')).join('\n');
    expect(output).toContain('Request Trace');
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
