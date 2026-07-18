'use strict';

describe('doctor coding agent smoke test', () => {
  let originalHome;

  function mockDoctorDependencies({
    activeAdapter = { name: 'Codex CLI', type: 'codex', activeModel: 'gpt-5-codex' },
    toolNames = ['readFile', 'grep', 'editFile', 'shellCommand'],
    tempWriteBlocked = false,
    deliverySummaryOverride = null,
    languageSummaryOverride = null,
    codexRuntimeDiagnostics = { at: 0 },
    codexFirstResponseDiagnostics = null,
    defaultRouteRecommendation,
  } = {}) {
    const runtimeDiagCalls = [];

    jest.doMock('child_process', () => {
      const actual = jest.requireActual('child_process');
      return {
        ...actual,
        execFileSync: jest.fn((cmd, args = []) => {
          const argv = Array.isArray(args) ? args : [];

          if (cmd === 'python3' && argv[0] === '--version') return 'Python 3.11.9';
          if (cmd === 'git' && argv[0] === '--version') return 'git version 2.45.2';
          if (cmd === 'python3' && argv[0] === '-m' && argv[1] === 'pip' && argv[2] === 'show' && argv[3] === 'akshare') {
            return 'Name: akshare';
          }
          if (cmd === 'redis-cli' && argv[0] === 'ping') {
            const err = new Error('redis-cli missing');
            err.code = 'ENOENT';
            throw err;
          }
          if (cmd === process.execPath && argv[0] === '-e') {
            const script = String(argv[1] || '');
            if (script.includes('require.resolve("node-llama-cpp"')) {
              const err = new Error('Cannot find module');
              err.code = 'ENOENT';
              throw err;
            }
            return 'OK';
          }
          if (cmd === 'ollama' || cmd === 'ollama.exe') {
            const err = new Error('missing ollama');
            err.code = 'ENOENT';
            throw err;
          }

          const err = new Error(`unexpected exec: ${cmd} ${argv.join(' ')}`);
          err.code = 'ENOENT';
          throw err;
        }),
      };
    });

    jest.doMock('fs', () => {
      const actual = jest.requireActual('fs');
      return {
        ...actual,
        writeFileSync: jest.fn((targetPath, data, ...rest) => {
          if (tempWriteBlocked && String(targetPath || '').includes('coding-agent-smoke.txt')) {
            const err = new Error('permission denied');
            err.code = 'EACCES';
            throw err;
          }
          return actual.writeFileSync(targetPath, data, ...rest);
        }),
      };
    });

    jest.doMock('../src/cli/formatters', () => ({
      printSuccess: jest.fn(),
      printError: jest.fn(),
      printWarn: jest.fn(),
      printInfo: jest.fn(),
      printTable: jest.fn(),
      withSpinner: jest.fn(),
      MASCOT_MINI: '*',
      ICON_HEART: '+',
      ICON_GEAR: '*',
    }));

    jest.doMock('../src/services/gateway/aiGateway', () => ({
      getActiveAdapter: () => activeAdapter,
      getDefaultRouteRecommendation: () => {
        if (defaultRouteRecommendation !== undefined) return defaultRouteRecommendation;
        if (!activeAdapter) return null;
        const adapterKey = String(activeAdapter?.key || activeAdapter?.type || '').trim() || 'unknown';
        return {
          adapter: adapterKey,
          name: activeAdapter.name || adapterKey,
          summary: `${activeAdapter.name || adapterKey} (${adapterKey}) 当前为默认稳定通道`,
        };
      },
      getAdapter: (key) => {
        if (!key) return null;
        const normalized = String(key).trim().toLowerCase();
        const activeType = String(activeAdapter?.key || activeAdapter?.type || '').trim().toLowerCase();
        if (normalized !== activeType) return null;
        return {
          getRuntimeDiagnostics: (options = {}) => {
            runtimeDiagCalls.push(options);
            if (options && options.includePersisted && options.preferCategory === 'stall') {
              return codexFirstResponseDiagnostics || { at: 0, healed: false, diagnosis: '', lastError: '', trigger: '', category: '' };
            }
            if (options && options.includePersisted) return codexRuntimeDiagnostics;
            return { at: 0, healed: false, diagnosis: '', lastError: '', trigger: '', category: '' };
          },
        };
      },
      getKhyProtocolPriorityRisk: () => ({
        risky: false,
        level: 'info',
        detail: '当前激活通道由 KHY 网关统一注入最高优先级协议',
      }),
    }));

    jest.doMock('../src/services/toolCalling', () => ({
      listTools: () => toolNames,
      isDangerousMode: () => false,
    }));

    jest.doMock('../src/services/mcp', () => ({
      loadConfig: () => ({ mcpServers: {} }),
    }));

    jest.doMock('../src/services/skillRegistry', () => ({
      getInstalledSkills: () => [],
    }));

    jest.doMock('../src/services/cloudSync', () => ({
      isLoggedIn: () => false,
      getUsername: () => 'tester',
    }));

    jest.doMock('../src/services/traceAuditService', () => ({
      getLatestDeliveryRequestSummary: () => (
        deliverySummaryOverride || {
          ok: true,
          sessionId: 'sess-1',
          requestId: tempWriteBlocked ? 'req-broken' : 'req-ok',
          status: tempWriteBlocked ? 'incomplete' : 'completed',
          brokenStage: tempWriteBlocked ? 'tool_execution' : null,
          summary: tempWriteBlocked
            ? '最近一次交付链路可能断裂（requestId=req-broken，阶段=tool_execution）'
            : '最近一次交付链路已完成（requestId=req-ok）',
          eventCount: tempWriteBlocked ? 2 : 4,
          lastEvent: {
            type: tempWriteBlocked ? 'agent.tool.call' : 'llm.response',
            timestamp: '2026-05-30T04:00:00.000Z',
            source: 'jest',
          },
        }
      ),
      getLatestLanguageConsistencySummary: () => (
        languageSummaryOverride || {
          ok: true,
          sessionId: 'sess-1',
          requestId: tempWriteBlocked ? 'req-lang-bad' : 'req-lang-ok',
          status: tempWriteBlocked ? 'mismatch' : 'aligned',
          adapter: activeAdapter?.name || 'unknown',
          source: 'first_chunk',
          detectedLanguage: tempWriteBlocked ? 'en' : 'zh',
          expectedLanguage: 'zh',
          matchesExpectation: !tempWriteBlocked,
          riskyAdapter: true,
          textSample: tempWriteBlocked ? 'I will inspect the files first.' : '我先检查当前配置。',
          summary: tempWriteBlocked
            ? '最近一次语言一致性异常（adapter=unknown，requestId=req-lang-bad，检测=en，期望=zh，来源=first_chunk）'
            : '最近一次语言一致性正常（adapter=Codex CLI，requestId=req-lang-ok，来源=first_chunk）',
          event: {
            type: 'agent.language.first_chunk',
            timestamp: '2026-05-30T04:00:01.000Z',
            source: 'jest',
          },
        }
      ),
    }));

    jest.doMock('../src/services/userProfile', () => ({
      getProfile: () => ({ skillLevel: 'beginner', commandCount: 0 }),
    }));

    return { runtimeDiagCalls };
  }

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('passes when active adapter, coding tools, and temp workspace are ready', () => {
    mockDoctorDependencies();
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const smokeCheck = checks.find((item) => item.label === '编程智能体烟雾测试');
    expect(smokeCheck).toBeTruthy();
    expect(smokeCheck.ok).toBe(true);
    expect(smokeCheck.level).toBe('info');
    expect(smokeCheck.detail).toContain('通道=Codex CLI');
    expect(smokeCheck.detail).toContain('工具组=4/4 就绪');
    expect(smokeCheck.detail).toContain('临时工作区=可写');

    const deliveryCheck = checks.find((item) => item.label === '最近交付链路');
    expect(deliveryCheck).toBeTruthy();
    expect(deliveryCheck.ok).toBe(true);
    expect(deliveryCheck.level).toBe('info');
    expect(deliveryCheck.detail).toContain('requestId=req-ok');

    const languageCheck = checks.find((item) => item.label === '首段语言一致性');
    expect(languageCheck).toBeTruthy();
    expect(languageCheck.ok).toBe(true);
    expect(languageCheck.level).toBe('info');
    expect(languageCheck.detail).toContain('requestId=req-lang-ok');

    const routeCheck = checks.find((item) => item.label === '默认推荐通道');
    expect(routeCheck).toBeTruthy();
    expect(routeCheck.ok).toBe(true);
    expect(routeCheck.level).toBe('info');
    expect(routeCheck.detail).toContain('Codex CLI (codex) 当前为默认稳定通道');
  });

  test('warns when essential coding tool groups are missing or temp workspace is blocked', () => {
    mockDoctorDependencies({
      activeAdapter: null,
      toolNames: ['readFile'],
      tempWriteBlocked: true,
    });
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const smokeCheck = checks.find((item) => item.label === '编程智能体烟雾测试');
    expect(smokeCheck).toBeTruthy();
    expect(smokeCheck.ok).toBe(false);
    expect(smokeCheck.level).toBe('warn');
    expect(smokeCheck.detail).toContain('通道=无活跃通道');
    expect(smokeCheck.detail).toContain('缺少=search/edit/execute');
    expect(smokeCheck.detail).toContain('临时工作区=受限');

    const deliveryCheck = checks.find((item) => item.label === '最近交付链路');
    expect(deliveryCheck).toBeTruthy();
    expect(deliveryCheck.ok).toBe(false);
    expect(deliveryCheck.level).toBe('warn');
    expect(deliveryCheck.detail).toContain('requestId=req-broken');
    expect(deliveryCheck.detail).toContain('最后事件=agent.tool.call');

    const languageCheck = checks.find((item) => item.label === '首段语言一致性');
    expect(languageCheck).toBeTruthy();
    expect(languageCheck.ok).toBe(false);
    expect(languageCheck.level).toBe('warn');
    expect(languageCheck.detail).toContain('requestId=req-lang-bad');
    expect(languageCheck.detail).toContain('sample=I will inspect the files first.');

    const routeCheck = checks.find((item) => item.label === '默认推荐通道');
    expect(routeCheck).toBeTruthy();
    expect(routeCheck.ok).toBe(false);
    expect(routeCheck.level).toBe('warn');
    expect(routeCheck.detail).toBe('当前无可用默认路由建议');
  });

  test('warns when codex uses a temporary HOME directory', () => {
    process.env.HOME = '/tmp/khy-doctor-codex-home';
    mockDoctorDependencies();
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const homeCheck = checks.find((item) => item.label === 'Codex HOME 环境');
    expect(homeCheck).toBeTruthy();
    expect(homeCheck.ok).toBe(false);
    expect(homeCheck.level).toBe('warn');
    expect(homeCheck.detail).toContain('HOME=/tmp/khy-doctor-codex-home 位于临时目录');
    expect(homeCheck.detail).toContain('建议改回真实用户主目录后重试');
  });

  test('treats missing language audit evidence as informational instead of failing doctor', () => {
    mockDoctorDependencies({
      languageSummaryOverride: {
        ok: false,
        reason: 'no_language_event',
        sessionId: 'sess-1',
        summary: '当前尚无语言一致性审计事件',
      },
    });
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const languageCheck = checks.find((item) => item.label === '首段语言一致性');
    expect(languageCheck).toBeTruthy();
    expect(languageCheck.ok).toBe(true);
    expect(languageCheck.level).toBe('info');
    expect(languageCheck.detail).toBe('当前尚无语言一致性审计事件');
  });

  test('treats delivery-only summary evidence as informational instead of warning about a broken chain', () => {
    mockDoctorDependencies({
      deliverySummaryOverride: {
        ok: true,
        sessionId: 'sess-1',
        requestId: 'req-summary-only',
        status: 'summary_only',
        brokenStage: null,
        summary: '最近一次仅记录到最终交付事件（requestId=req-summary-only）；暂缺请求/响应明细，无法判定链路是否断裂',
        eventCount: 1,
        lastEvent: {
          type: 'agent.delivery.final',
          timestamp: '2026-05-30T04:00:00.000Z',
          source: 'jest',
        },
      },
    });
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const deliveryCheck = checks.find((item) => item.label === '最近交付链路');
    expect(deliveryCheck).toBeTruthy();
    expect(deliveryCheck.ok).toBe(true);
    expect(deliveryCheck.level).toBe('info');
    expect(deliveryCheck.detail).toContain('requestId=req-summary-only');
    expect(deliveryCheck.detail).toContain('最后事件=agent.delivery.final');
  });

  test('treats standalone response-only delivery evidence as informational', () => {
    mockDoctorDependencies({
      deliverySummaryOverride: {
        ok: true,
        sessionId: 'sess-1',
        requestId: 'req-response-only',
        status: 'response_only',
        brokenStage: null,
        summary: '最近一次请求已收到模型答复（requestId=req-response-only；独立 chat 路径未记录 agent.delivery.final）',
        eventCount: 2,
        lastEvent: {
          type: 'llm.response',
          timestamp: '2026-05-30T04:00:00.000Z',
          source: 'ai-chat',
        },
      },
    });
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const deliveryCheck = checks.find((item) => item.label === '最近交付链路');
    expect(deliveryCheck).toBeTruthy();
    expect(deliveryCheck.ok).toBe(true);
    expect(deliveryCheck.level).toBe('info');
    expect(deliveryCheck.detail).toContain('requestId=req-response-only');
    expect(deliveryCheck.detail).toContain('最后事件=llm.response');
  });

  test('doctor surfaces recent codex first-response stall diagnostics', () => {
    const { runtimeDiagCalls } = mockDoctorDependencies({
      codexRuntimeDiagnostics: {
        at: Date.parse('2026-05-31T08:15:46.291Z'),
        healed: false,
        trigger: 'first_response_timeout',
        diagnosis: 'stall=turn_started_reconnect_loop | stage=turn_started | last_event=stdout_json:error:Reconnecting... 3/10',
        lastError: 'codex first response timeout after 12000ms without meaningful model progress | stall=turn_started_reconnect_loop',
      },
    });

    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const codexDiagCheck = checks.find((item) => item.label === 'Codex 自愈状态');
    expect(codexDiagCheck).toBeTruthy();
    expect(codexDiagCheck.ok).toBe(false);
    expect(codexDiagCheck.level).toBe('warn');
    expect(codexDiagCheck.detail).toContain('检测到首响阻塞');
    expect(codexDiagCheck.detail).toContain('stall=turn_started_reconnect_loop');
    expect(runtimeDiagCalls).toContainEqual({ includePersisted: true });
    expect(runtimeDiagCalls).toContainEqual({ includePersisted: true, preferCategory: 'stall' });
  });

  test('doctor keeps recent first-response stall visible even when latest codex diag is healed', () => {
    mockDoctorDependencies({
      codexRuntimeDiagnostics: {
        at: Date.parse('2026-05-31T08:20:46.291Z'),
        healed: true,
        trigger: 'provider_fallback_recovered',
        diagnosis: 'provider_fallback=openai',
        lastError: 'ERROR: Reconnecting... channel closed',
      },
      codexFirstResponseDiagnostics: {
        at: Date.parse('2026-05-31T08:15:46.291Z'),
        healed: false,
        trigger: 'first_response_timeout',
        diagnosis: 'stall=turn_started_reconnect_loop | stage=turn_started',
        lastError: 'codex first response timeout after 20000ms without meaningful model progress',
      },
    });

    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const codexDiagCheck = checks.find((item) => item.label === 'Codex 自愈状态');
    expect(codexDiagCheck).toBeTruthy();
    expect(codexDiagCheck.ok).toBe(true);
    expect(codexDiagCheck.level).toBe('info');
    expect(codexDiagCheck.detail).toContain('已执行自愈');
    expect(codexDiagCheck.detail).toContain('最近首响阻塞');
    expect(codexDiagCheck.detail).toContain('stall=turn_started_reconnect_loop');
  });

  test('doctor shows generic runtime diagnostics for non-codex active adapter', () => {
    mockDoctorDependencies({
      activeAdapter: { name: 'Claude Code', key: 'claude', type: 'claude', activeModel: 'claude-sonnet-4-6' },
      codexRuntimeDiagnostics: {
        at: Date.parse('2026-05-31T08:25:46.291Z'),
        healed: false,
        trigger: 'bridge_handshake_timeout',
        category: 'stall',
        diagnosis: 'trigger=bridge_handshake_timeout | launch=direct | events=0',
        lastError: 'Claude stream-json handshake timeout — subprocess produced no events',
      },
    });

    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const runtimeCheck = checks.find((item) => item.label === 'Claude Code 运行时诊断');
    expect(runtimeCheck).toBeTruthy();
    expect(runtimeCheck.ok).toBe(false);
    expect(runtimeCheck.level).toBe('warn');
    expect(runtimeCheck.detail).toContain('检测到通道阻塞');
    expect(runtimeCheck.detail).toContain('bridge_handshake_timeout');
  });

  test('handleDoctor prints direct request trace commands for broken delivery and language mismatch', async () => {
    mockDoctorDependencies({
      activeAdapter: null,
      toolNames: ['readFile'],
      tempWriteBlocked: true,
    });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { printInfo } = require('../src/cli/formatters');
      const { handleDoctor } = require('../src/cli/handlers/init');
      await handleDoctor({}, []);

      expect(printInfo).toHaveBeenCalledWith('快速复盘命令: khy gateway trace req-broken');
      expect(printInfo).toHaveBeenCalledWith('快速复盘命令: khy gateway trace req-lang-bad');
    } finally {
      logSpy.mockRestore();
    }
  });

  test('handleDoctor emits machine-readable JSON when options.json is true', async () => {
    mockDoctorDependencies();

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleDoctor } = require('../src/cli/handlers/init');
      await handleDoctor({ json: true }, []);

      const payload = JSON.parse(logSpy.mock.calls.map((call) => String(call[0] || '')).join(''));
      expect(payload.status).toBe('warn');
      expect(payload.counts).toMatchObject({
        ok: expect.any(Number),
        warn: expect.any(Number),
        fail: expect.any(Number),
        total: expect.any(Number),
      });
      expect(Array.isArray(payload.checks)).toBe(true);
      expect(Array.isArray(payload.categories)).toBe(true);
      expect(payload.categories.some((entry) => entry.category === 'AI 能力')).toBe(true);
      expect(payload.maintenance).toContain('khy docs maintainer');
    } finally {
      logSpy.mockRestore();
    }
  });
});
