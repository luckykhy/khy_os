'use strict';

describe('gateway status endpoint visibility options', () => {
  let originalEnv;
  let logSpy;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.resetModules();
    jest.restoreAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    if (logSpy) logSpy.mockRestore();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  function mockBaseDeps({ apiKeysJson, promptDebugFile = '/tmp/khy_gateway_prompt_debug.log', promptDebugContent = null }) {
    const realFs = jest.requireActual('fs');
    jest.doMock('os', () => ({
      ...jest.requireActual('os'),
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp',
    }));
    jest.doMock('fs', () => ({
      ...realFs,
      existsSync: jest.fn((targetPath) => {
        const normalized = String(targetPath || '');
        if (normalized === '/home/tester/.khyquant/api_keys.json') return true;
        if (normalized === promptDebugFile) return promptDebugContent !== null;
        return false;
      }),
      readFileSync: jest.fn((targetPath, encoding) => {
        if (String(targetPath || '') === '/home/tester/.khyquant/api_keys.json') {
          return apiKeysJson;
        }
        if (String(targetPath || '') === promptDebugFile && promptDebugContent !== null) {
          return promptDebugContent;
        }
        return realFs.readFileSync(targetPath, encoding);
      }),
    }));
    jest.doMock('../src/services/gateway/aiGateway', () => ({
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => []),
      testAdapter: jest.fn(async () => null),
      getKhyProtocolPriorityRisk: jest.fn(() => ({
        risky: false,
        level: 'info',
        summary: '当前无激活通道，待请求时仍会由 KHY 网关注入最高优先级协议',
        detail: '当前无激活通道，待请求时仍会由 KHY 网关注入最高优先级协议',
        recommendation: '',
      })),
    }));
    jest.doMock('../src/cli/handlers/proxy', () => ({
      maybeAutoSyncSwitchCenter: jest.fn(async () => null),
    }));
    jest.doMock('../src/services/traceAuditService', () => ({
      getLatestDeliveryRequestSummary: jest.fn(() => ({
        ok: true,
        sessionId: 'sess-1',
        requestId: 'req-1',
        status: 'completed',
        brokenStage: null,
        summary: '最近一次交付链路已完成（requestId=req-1）',
        eventCount: 4,
        checks: {
          modelRequest: true,
          toolCall: true,
          toolResult: true,
          modelResponse: true,
        },
        lastEvent: {
          type: 'llm.response',
          timestamp: '2026-05-30T03:04:06.000Z',
          source: 'ai-gateway',
        },
      })),
      getLatestLanguageConsistencySummary: jest.fn(() => ({
        ok: true,
        sessionId: 'sess-1',
        requestId: 'req-1',
        status: 'aligned',
        adapter: 'API 中转',
        source: 'first_chunk',
        detectedLanguage: 'zh',
        expectedLanguage: 'zh',
        matchesExpectation: true,
        riskyAdapter: true,
        textSample: '我先检查当前配置。',
        summary: '最近一次语言一致性正常（adapter=API 中转，requestId=req-1，来源=first_chunk）',
        event: {
          type: 'agent.language.first_chunk',
          timestamp: '2026-05-30T03:04:05.500Z',
          source: 'ai-gateway',
        },
      })),
    }));
    jest.doMock('../src/cli/formatters', () => ({
      printSuccess: jest.fn(),
      printError: jest.fn(),
      printInfo: jest.fn(),
      printTable: jest.fn(),
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
  }

  test('returns endpoint-only JSON payload with provider filter', async () => {
    process.env.RELAY_API_KEY = 'relay-key';
    process.env.RELAY_API_ENDPOINT = 'https://relay.example.com/v1';
    process.env.RELAY_API_MODEL = 'relay-model';
    process.env.GATEWAY_PREFERRED_ADAPTER = 'relay_api';
    process.env.GATEWAY_PREFERRED_MODEL = 'sensenova-6.7-flash-lite';
    process.env.GATEWAY_API_POOL_DEFAULT_MODEL_MAP = JSON.stringify({
      sensenova: 'sensenova-6.7-flash-lite',
    });

    mockBaseDeps({
      apiKeysJson: JSON.stringify({
        sensenova: [
          {
            key: 'sns-key',
            endpoint: 'https://token.sensenova.cn/v1',
            label: 'sns',
          },
        ],
      }),
    });

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayStatus({
      json: true,
      'endpoints-only': true,
      provider: 'sensenova',
    });

    const payload = JSON.parse(logSpy.mock.calls.map((call) => String(call[0] || '')).join(''));
    expect(payload.preferredRoute).toEqual({
      adapter: 'relay_api',
      model: 'sensenova-6.7-flash-lite',
      provider: 'custom',
      routeLabel: 'custom/sensenova-6.7-flash-lite',
    });
    expect(payload.filters.provider).toEqual(['sensenova']);
    expect(payload.endpoints).toHaveLength(1);
    expect(payload.endpoints[0].provider).toBe('sensenova');
    expect(payload.endpoints[0].endpoint).toBe('https://token.sensenova.cn/v1');
  });

  test('filters endpoint list by provider aliases in full JSON mode', async () => {
    process.env.HOME = '/tmp/khy-gateway-status-home';
    process.env.RELAY_API_KEY = 'relay-key';
    process.env.RELAY_API_ENDPOINT = 'https://relay.example.com/v1';
    process.env.RELAY_API_MODEL = 'relay-model';
    process.env.GATEWAY_API_POOL_DEFAULT_MODEL_MAP = JSON.stringify({
      sensenova: 'sensenova-6.7-flash-lite',
      relay: 'relay-model',
    });
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy_gateway_prompt_debug.log';

    mockBaseDeps({
      apiKeysJson: JSON.stringify({
        sensenova: [
          {
            key: 'sns-key',
            endpoint: 'https://token.sensenova.cn/v1',
          },
        ],
      }),
      promptDebugContent: [
        '[2026-05-30T03:04:05.000Z] adapter=relay_api provider="API 中转"',
        'has_system=1 system_length=156 prompt_length=704',
        'system_preview=# KHY Protocol Priority',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: relay summary',
        '',
      ].join('\n'),
    });

    const gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'relay_api', name: 'API 中转', enabled: true, available: true, detail: 'ok', priority: 12 },
      ])),
      testAdapter: jest.fn(async () => ({
        connectivity: { success: true, latencyMs: 8 },
        models: { success: true, count: 1 },
        generation: { success: true, latencyMs: 11 },
      })),
      getKhyProtocolPriorityRisk: jest.fn(() => ({
        risky: false,
        level: 'info',
        summary: 'API 中转 已由 KHY 网关注入最高优先级协议',
        detail: 'API 中转 已由 KHY 网关注入最高优先级协议，当前未发现上游覆盖风险',
        recommendation: '',
      })),
    };
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayStatus({
      json: true,
      provider: '中转,sensenova',
    });

    const payload = JSON.parse(logSpy.mock.calls.map((call) => String(call[0] || '')).join(''));
    expect(payload.activeChannel).toEqual({ name: 'API 中转', type: 'relay_api' });
    expect(payload.activeKhyProtocolRisk).toEqual({
      risky: false,
      level: 'info',
      summary: 'API 中转 已由 KHY 网关注入最高优先级协议',
      detail: 'API 中转 已由 KHY 网关注入最高优先级协议，当前未发现上游覆盖风险',
      recommendation: '',
    });
    expect(payload.environment).toEqual({
      homeRisk: {
        homeDir: '/tmp/khy-gateway-status-home',
        tmpDir: '/tmp',
        isTempHome: true,
        hint: '当前 HOME=/tmp/khy-gateway-status-home 位于临时目录；Codex CLI 在临时 HOME 下可能出现 tls handshake eof / reconnect 假故障。',
        recommendation: '建议改回真实用户主目录后再采样。',
        activeAdapterAffected: false,
      },
    });
    expect(payload.latestKhyPromptDebug).toEqual({
      file: '/tmp/khy_gateway_prompt_debug.log',
      exists: true,
      entriesCount: 1,
      totalEntriesCount: 1,
      latest: {
        timestamp: '2026-05-30T03:04:05.000Z',
        adapter: 'relay_api',
        provider: 'API 中转',
        hasSystem: true,
        systemLength: 156,
        promptLength: 704,
        systemPreview: '# KHY Protocol Priority',
        promptPreview: '[KHY PRIORITY DIRECTIVE] USER: relay summary',
        capsuleMode: '',
        capsuleReasons: [],
        promptCapsules: [],
      },
    });
    expect(payload.latestDeliveryRequest).toEqual({
      ok: true,
      sessionId: 'sess-1',
      requestId: 'req-1',
      status: 'completed',
      brokenStage: null,
      summary: '最近一次交付链路已完成（requestId=req-1）',
      eventCount: 4,
      checks: {
        modelRequest: true,
        toolCall: true,
        toolResult: true,
        modelResponse: true,
      },
      lastEvent: {
        type: 'llm.response',
        timestamp: '2026-05-30T03:04:06.000Z',
        source: 'ai-gateway',
      },
    });
    expect(payload.latestLanguageConsistency).toEqual({
      ok: true,
      sessionId: 'sess-1',
      requestId: 'req-1',
      status: 'aligned',
      adapter: 'API 中转',
      source: 'first_chunk',
      detectedLanguage: 'zh',
      expectedLanguage: 'zh',
      matchesExpectation: true,
      riskyAdapter: true,
      textSample: '我先检查当前配置。',
      summary: '最近一次语言一致性正常（adapter=API 中转，requestId=req-1，来源=first_chunk）',
      event: {
        type: 'agent.language.first_chunk',
        timestamp: '2026-05-30T03:04:05.500Z',
        source: 'ai-gateway',
      },
    });
    expect(payload.endpoints).toHaveLength(2);
    expect(payload.endpoints.map((e) => e.provider).sort()).toEqual(['relay', 'sensenova']);
    expect(payload.filters.provider).toEqual(['中转', 'sensenova']);
    expect(payload.adapters[0].khyProtocolRisk).toEqual({
      risky: false,
      level: 'info',
      summary: 'API 中转 已由 KHY 网关注入最高优先级协议',
      detail: 'API 中转 已由 KHY 网关注入最高优先级协议，当前未发现上游覆盖风险',
      recommendation: '',
    });
    expect(gatewayMock.testAdapter).toHaveBeenCalledTimes(1);
  });

  test('preserves completed codex probe diagnostics even when another adapter hits status timeout', async () => {
    process.env.GATEWAY_STATUS_TIMEOUT_MS = '30';

    mockBaseDeps({
      apiKeysJson: JSON.stringify({}),
    });

    const never = new Promise(() => {});
    const gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'relay_api', name: 'API 中转', enabled: true, available: true, detail: 'relay ok', priority: 10 },
        { type: 'codex', name: 'Codex CLI (mindflow)', enabled: true, available: true, detail: 'codex ok', priority: 11 },
      ])),
      testAdapter: jest.fn(async (adapterType) => {
        if (adapterType === 'relay_api') return never;
        return {
          connectivity: { success: true, latencyMs: 7 },
          models: { success: true, count: 1 },
          generation: {
            success: false,
            latencyMs: 12,
            error: 'codex first response timeout after 12000ms without meaningful model progress | stall=turn_started_reconnect_loop',
            diagnostics: {
              stallFingerprint: 'turn_started_reconnect_loop',
              stallSummary: 'turn.started reached, then repeated reconnect transport warnings arrived before any reasoning/tool/assistant output',
              progressEvidence: {
                stallFingerprint: 'turn_started_reconnect_loop',
                turnStartedCount: 1,
                assistantMessageEvents: 0,
              },
            },
          },
        };
      }),
      getKhyProtocolPriorityRisk: jest.fn((status) => ({
        risky: String(status?.type || '') === 'codex',
        level: String(status?.type || '') === 'codex' ? 'warn' : 'info',
        summary: `${status?.name || status?.type} risk`,
        detail: `${status?.name || status?.type} detail`,
        recommendation: '',
      })),
    };
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayStatus({ json: true });

    const payload = JSON.parse(logSpy.mock.calls.map((call) => String(call[0] || '')).join(''));
    const codex = payload.adapters.find((item) => item.type === 'codex');
    const relay = payload.adapters.find((item) => item.type === 'relay_api');

    expect(codex).toBeTruthy();
    expect(codex.connectivity.test.generation.success).toBe(false);
    expect(codex.connectivity.test.generation.diagnostics).toMatchObject({
      stallFingerprint: 'turn_started_reconnect_loop',
    });
    expect(codex.connectivity.summary).toContain('stall=turn_started_reconnect_loop');

    expect(relay).toBeTruthy();
    expect(relay.connectivity.test).toEqual({
      connectivity: { success: false, latencyMs: 0, error: 'global timeout' },
    });
  });
});
