'use strict';

describe('gateway status preferred adapter hints', () => {
  let originalPreferredAdapter;
  let originalHome;
  let logSpy;

  function mockFormatters({ printSuccess, printError, printInfo, printTable }) {
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
  }

  beforeEach(() => {
    originalPreferredAdapter = process.env.GATEWAY_PREFERRED_ADAPTER;
    originalHome = process.env.HOME;
    jest.resetModules();
    jest.restoreAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalPreferredAdapter === undefined) delete process.env.GATEWAY_PREFERRED_ADAPTER;
    else process.env.GATEWAY_PREFERRED_ADAPTER = originalPreferredAdapter;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (logSpy) logSpy.mockRestore();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('prints invalid preferred adapter guidance in gateway status', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = '__missing__';

    const printSuccess = jest.fn();
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printTable = jest.fn();

    const gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'codex', name: 'Codex CLI', enabled: true, available: true, detail: 'ok', priority: 1 },
      ])),
      testAdapter: jest.fn(async () => ({
        connectivity: { success: true, latencyMs: 10 },
        generation: { success: true, latencyMs: 20 },
        models: { success: true, latencyMs: 5, count: 1 },
      })),
      getKhyProtocolPriorityRisk: jest.fn(() => ({
        risky: true,
        level: 'warn',
        summary: 'Codex CLI 可能在 KHY 之后仍追加上游隐藏 system prompt',
        detail: 'Codex CLI 可能在 KHY 之后仍追加上游隐藏 system prompt；如出现语言不一致，建议开启 KHY_GATEWAY_DEBUG_PROMPT=1',
        recommendation: '开启 KHY_GATEWAY_DEBUG_PROMPT=1',
      })),
    };

    mockFormatters({ printSuccess, printError, printInfo, printTable });
    jest.doMock('../src/cli/handlers/proxy', () => ({
      maybeAutoSyncSwitchCenter: jest.fn(async () => null),
    }));
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayStatus();

    expect(printError).toHaveBeenCalledWith('首选通道配置错误: "__missing__" 未注册');
    expect(printInfo).toHaveBeenCalledWith('修复建议: 运行 khy gateway model 重新选择可执行通道');
  });

  test('shows KHY protocol override risk directly in gateway status output', async () => {
    const printSuccess = jest.fn();
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printTable = jest.fn();

    const gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'codex', name: 'Codex CLI', enabled: true, available: true, detail: 'ok', priority: 1 },
        { type: 'api', name: 'API 池', enabled: true, available: true, detail: 'ok', priority: 2 },
      ])),
      testAdapter: jest.fn(async () => ({
        connectivity: { success: true, latencyMs: 12 },
        generation: { success: true, latencyMs: 21 },
        models: { success: true, latencyMs: 6, count: 2 },
      })),
      getKhyProtocolPriorityRisk: jest.fn((adapter) => {
        const key = String(adapter?.type || '').toLowerCase();
        if (key === 'codex') {
          return {
            risky: true,
            level: 'warn',
            summary: 'Codex CLI 可能在 KHY 之后仍追加上游隐藏 system prompt',
            detail: 'Codex CLI 可能在 KHY 之后仍追加上游隐藏 system prompt；如出现语言不一致，建议开启 KHY_GATEWAY_DEBUG_PROMPT=1',
            recommendation: '开启 KHY_GATEWAY_DEBUG_PROMPT=1',
          };
        }
        return {
          risky: false,
          level: 'info',
          summary: 'API 池 已由 KHY 网关注入最高优先级协议',
          detail: 'API 池 已由 KHY 网关注入最高优先级协议，当前未发现上游覆盖风险',
          recommendation: '',
        };
      }),
    };

    mockFormatters({ printSuccess, printError, printInfo, printTable });
    jest.doMock('../src/cli/handlers/proxy', () => ({
      maybeAutoSyncSwitchCenter: jest.fn(async () => null),
    }));
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayStatus();

    const output = logSpy.mock.calls.map((call) => String(call[0] || '')).join('\n');
    expect(output).toContain('协议风险: 上游可覆盖');
    expect(printInfo).toHaveBeenCalledWith('KHY 协议优先级: Codex CLI 可能在 KHY 之后仍追加上游隐藏 system prompt');
    expect(printInfo).toHaveBeenCalledWith('排查建议: 开启 KHY_GATEWAY_DEBUG_PROMPT=1');
  });

  test('shows default route recommendation directly in gateway status output', async () => {
    const printSuccess = jest.fn();
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printTable = jest.fn();

    const gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'codex', name: 'Codex CLI', enabled: true, available: true, detail: 'ok', priority: 1 },
        { type: 'api', name: 'API 池', enabled: true, available: true, detail: 'ok', priority: 2 },
      ])),
      getDefaultRouteRecommendation: jest.fn(() => ({
        adapter: 'api',
        name: 'API 池',
        summary: 'API 池 (api) 当前更稳；Codex CLI 最近 30s 内出现 first_response_timeout，默认降级为次级兜底',
      })),
      testAdapter: jest.fn(async () => ({
        connectivity: { success: true, latencyMs: 12 },
        generation: { success: true, latencyMs: 21 },
        models: { success: true, latencyMs: 6, count: 2 },
      })),
      getKhyProtocolPriorityRisk: jest.fn(() => ({
        risky: false,
        level: 'info',
        summary: 'API 池 已由 KHY 网关注入最高优先级协议',
        detail: 'API 池 已由 KHY 网关注入最高优先级协议',
        recommendation: '',
      })),
    };

    mockFormatters({ printSuccess, printError, printInfo, printTable });
    jest.doMock('../src/cli/handlers/proxy', () => ({
      maybeAutoSyncSwitchCenter: jest.fn(async () => null),
    }));
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayStatus();

    expect(printInfo).toHaveBeenCalledWith(
      '默认推荐通道: API 池 (api) 当前更稳；Codex CLI 最近 30s 内出现 first_response_timeout，默认降级为次级兜底'
    );
  });

  test('prints direct request trace command when latest language consistency is mismatched', async () => {
    const printSuccess = jest.fn();
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printTable = jest.fn();

    const gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'codex', name: 'Codex CLI', enabled: true, available: true, detail: 'ok', priority: 1 },
      ])),
      testAdapter: jest.fn(async () => ({
        connectivity: { success: true, latencyMs: 12 },
        generation: { success: true, latencyMs: 21 },
        models: { success: true, latencyMs: 6, count: 2 },
      })),
      getKhyProtocolPriorityRisk: jest.fn(() => ({
        risky: true,
        level: 'warn',
        summary: 'Codex CLI 可能在 KHY 之后仍追加上游隐藏 system prompt',
        detail: 'Codex CLI 可能在 KHY 之后仍追加上游隐藏 system prompt',
        recommendation: '开启 KHY_GATEWAY_DEBUG_PROMPT=1',
      })),
    };

    mockFormatters({ printSuccess, printError, printInfo, printTable });
    jest.doMock('../src/cli/handlers/proxy', () => ({
      maybeAutoSyncSwitchCenter: jest.fn(async () => null),
    }));
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);
    jest.doMock('../src/services/traceAuditService', () => ({
      getLatestLanguageConsistencySummary: jest.fn(() => ({
        ok: true,
        requestId: 'req-trace-99',
        status: 'mismatch',
        summary: '最近一次语言一致性异常（adapter=Codex CLI，requestId=req-trace-99，检测=en，期望=zh，来源=first_chunk）',
        textSample: 'I will inspect the repository first.',
      })),
    }));

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayStatus();

    expect(printInfo).toHaveBeenCalledWith('快速复盘命令: khy gateway trace req-trace-99');
    expect(printInfo).toHaveBeenCalledWith('最近 requestId 复盘: khy gateway trace req-trace-99');
  });

  test('prints temporary HOME warning when active codex channel is affected', async () => {
    const tempHome = require('path').join(require('os').tmpdir(), 'khy-codex-active-home');
    process.env.HOME = tempHome;

    const printSuccess = jest.fn();
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printTable = jest.fn();

    const gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'codex', name: 'Codex CLI', enabled: true, available: true, detail: 'ok', priority: 1 },
      ])),
      testAdapter: jest.fn(async () => ({
        connectivity: { success: true, latencyMs: 10 },
        generation: { success: true, latencyMs: 20 },
        models: { success: true, latencyMs: 5, count: 1 },
      })),
      getKhyProtocolPriorityRisk: jest.fn(() => ({
        risky: false,
        level: 'info',
        summary: 'Codex CLI 已由 KHY 网关注入最高优先级协议',
        detail: 'Codex CLI 已由 KHY 网关注入最高优先级协议',
        recommendation: '',
      })),
    };

    mockFormatters({ printSuccess, printError, printInfo, printTable });
    jest.doMock('../src/cli/handlers/proxy', () => ({
      maybeAutoSyncSwitchCenter: jest.fn(async () => null),
    }));
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayStatus();

    expect(printInfo).toHaveBeenCalledWith(
      `环境提示: 当前 HOME=${tempHome} 位于临时目录；Codex CLI 在临时 HOME 下可能出现 tls handshake eof / reconnect 假故障。 建议改回真实用户主目录后再采样。`
    );
  });
});
