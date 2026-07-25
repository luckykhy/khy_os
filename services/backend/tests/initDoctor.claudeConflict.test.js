'use strict';

describe('doctor claude settings conflict detection', () => {
  function mockDoctorDependencies({
    settingsExists = true,
    settingsRaw = '{}',
    activeAdapterName = 'Claude Code',
  } = {}) {
    let currentSettingsRaw = String(settingsRaw);
    let tmpSettingsRaw = '';
    jest.doMock('fs', () => {
      const actual = jest.requireActual('fs');
      const path = jest.requireActual('path');
      const os = jest.requireActual('os');
      const settingsPath = path.resolve(path.join(os.homedir(), '.claude', 'settings.json'));
      const tmpPath = `${settingsPath}.tmp`;
      const normalize = (p) => path.resolve(String(p || ''));
      return {
        ...actual,
        existsSync: jest.fn((p) => {
          if (normalize(p) === settingsPath) return settingsExists;
          return actual.existsSync(p);
        }),
        readFileSync: jest.fn((p, ...rest) => {
          if (normalize(p) === settingsPath) return currentSettingsRaw;
          return actual.readFileSync(p, ...rest);
        }),
        writeFileSync: jest.fn((p, data, ...rest) => {
          if (normalize(p) === tmpPath) {
            tmpSettingsRaw = String(data || '');
            return;
          }
          return actual.writeFileSync(p, data, ...rest);
        }),
        renameSync: jest.fn((from, to) => {
          if (normalize(from) === tmpPath && normalize(to) === settingsPath) {
            currentSettingsRaw = String(tmpSettingsRaw || currentSettingsRaw);
            return;
          }
          return actual.renameSync(from, to);
        }),
      };
    });

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
      getActiveAdapter: () => ({ name: activeAdapterName, activeModel: 'mock-model', type: String(activeAdapterName || '').toLowerCase().includes('claude') ? 'claude' : 'api' }),
      getDefaultRouteRecommendation: () => ({
        adapter: String(activeAdapterName || '').toLowerCase().includes('claude') ? 'claude' : 'api',
        name: activeAdapterName,
        summary: `${activeAdapterName} 当前为默认稳定通道`,
      }),
      getKhyProtocolPriorityRisk: (adapter) => {
        const key = String(adapter?.type || '').toLowerCase();
        if (['claude', 'codex', 'cursor', 'trae', 'windsurf', 'vscode', 'warp', 'cursor2api', 'relay', 'clipboard', 'cli'].includes(key)) {
          return {
            risky: true,
            level: 'warn',
            detail: `当前激活通道 ${adapter?.name || key || 'unknown'} 可能在 KHY 之后仍追加上游隐藏 system prompt；如出现语言不一致，建议开启 KHY_GATEWAY_DEBUG_PROMPT=1，必要时设置 KHY_GATEWAY_DEBUG_PROMPT_FILE，并优先切换到 api / relay_api / ollama / localLLM 复核`,
          };
        }
        return {
          risky: false,
          level: 'info',
          detail: `${adapter?.name || key || 'unknown'} 已由 KHY 网关注入最高优先级协议，当前未发现上游覆盖风险`,
        };
      },
    }));

    jest.doMock('../src/cli/handlers/gateway', () => ({
      getGatewayDebugPromptSnapshot: () => ({
        ok: true,
        debugEnabled: true,
        fileConfigured: true,
        file: '/tmp/khy_prompt_debug.log',
        exists: true,
        entriesCount: 1,
        showing: 1,
        latest: {
          timestamp: '2026-05-30T03:04:05.000Z',
          adapter: 'claude',
          provider: 'Claude Code',
          hasSystem: true,
          systemLength: 128,
          promptLength: 512,
          systemPreview: '# KHY Protocol Priority',
          promptPreview: '[KHY PRIORITY DIRECTIVE] USER: 请用中文汇报',
        },
        entries: [],
        recommendedCommand: 'KHY_GATEWAY_DEBUG_PROMPT=1 KHY_GATEWAY_DEBUG_PROMPT_FILE=/tmp/khy_prompt_debug.log khy gateway status',
      }),
    }));

    jest.doMock('../src/services/gateway/adapters/codexAdapter', () => ({
      getRuntimeDiagnostics: () => ({ at: 0 }),
    }));

    jest.doMock('../src/services/toolCalling', () => ({
      listTools: () => ['readFile', 'grep', 'editFile', 'shellCommand'],
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

    jest.doMock('../src/services/userProfile', () => ({
      getProfile: () => ({ skillLevel: 'beginner', commandCount: 0 }),
    }));

    return {
      getSettingsRaw: () => currentSettingsRaw,
    };
  }

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.KHY_ALLOW_WRITE_CLAUDE_SETTINGS;
    delete process.env.KHY_MANAGE_CLAUDE_SETTINGS;
  });

  test('warns when AUTH_TOKEN and khy API_KEY coexist with external base url', () => {
    mockDoctorDependencies({
      settingsRaw: JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-ext-token',
          ANTHROPIC_API_KEY: 'khy-old-token',
          ANTHROPIC_BASE_URL: 'https://ai.example.com',
        },
      }),
    });

    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();
    const claudeCheck = checks.find((item) => item.label === 'Claude 配置隔离');

    expect(claudeCheck).toBeTruthy();
    expect(claudeCheck.ok).toBe(false);
    expect(claudeCheck.level).toBe('warn');
    expect(claudeCheck.detail).toContain('高风险冲突');
  });

  test('passes when only AUTH_TOKEN is configured', () => {
    mockDoctorDependencies({
      settingsRaw: JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-ext-token',
          ANTHROPIC_BASE_URL: 'https://ai.example.com',
        },
      }),
    });

    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();
    const claudeCheck = checks.find((item) => item.label === 'Claude 配置隔离');

    expect(claudeCheck).toBeTruthy();
    expect(claudeCheck.ok).toBe(true);
    expect(claudeCheck.level).toBe('info');
    expect(claudeCheck.detail).toContain('未发现');
  });

  test('warns when settings file is invalid json', () => {
    mockDoctorDependencies({
      settingsRaw: '{invalid json',
    });

    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();
    const claudeCheck = checks.find((item) => item.label === 'Claude 配置隔离');

    expect(claudeCheck).toBeTruthy();
    expect(claudeCheck.ok).toBe(false);
    expect(claudeCheck.level).toBe('warn');
    expect(claudeCheck.detail).toContain('解析失败');
  });

  test('doctor reports upstream override risk for claude-like adapters', () => {
    mockDoctorDependencies({
      activeAdapterName: 'Claude Code',
      settingsRaw: JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-ext-token',
        },
      }),
    });

    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();
    const riskCheck = checks.find((item) => item.label === 'KHY 协议优先级风险');

    expect(riskCheck).toBeTruthy();
    expect(riskCheck.ok).toBe(false);
    expect(riskCheck.level).toBe('warn');
    expect(riskCheck.detail).toContain('可能在 KHY 之后仍追加上游隐藏 system prompt');
    expect(riskCheck.detail).toContain('最近记录来自 Claude Code');
    expect(riskCheck.detail).toContain('preview=[KHY PRIORITY DIRECTIVE] USER: 请用中文汇报');
  });

  test('handleDoctor prints KHY debug follow-up commands for risky adapters', async () => {
    mockDoctorDependencies({
      activeAdapterName: 'Claude Code',
      settingsRaw: JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-ext-token',
        },
      }),
    });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { printInfo } = require('../src/cli/formatters');
      const { handleDoctor } = require('../src/cli/handlers/init');
      await handleDoctor({}, []);

      expect(printInfo).toHaveBeenCalledWith('KHY 协议排查命令: KHY_GATEWAY_DEBUG_PROMPT=1 KHY_GATEWAY_DEBUG_PROMPT_FILE=/tmp/khy_prompt_debug.log khy gateway status');
      expect(printInfo).toHaveBeenCalledWith('KHY 注入摘要命令: khy gateway debug-prompt --file /tmp/khy_prompt_debug.log --tail 1');
    } finally {
      logSpy.mockRestore();
    }
  });

  test('fix command removes khy API key conflict and persists settings', () => {
    const harness = mockDoctorDependencies({
      settingsRaw: JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-ext-token',
          ANTHROPIC_API_KEY: 'khy-old-token',
          ANTHROPIC_BASE_URL: 'https://ai.example.com',
        },
      }),
    });

    const { fixClaudeSettingsConflict } = require('../src/cli/handlers/init');
    const result = fixClaudeSettingsConflict();

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.detail).toContain('移除冲突的 ANTHROPIC_API_KEY');

    const parsed = JSON.parse(harness.getSettingsRaw());
    const env = parsed.env || {};
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ext-token');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://ai.example.com');
  });

  test('fix command does not auto-modify non-khy dual auth', () => {
    mockDoctorDependencies({
      settingsRaw: JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-ext-token',
          ANTHROPIC_API_KEY: 'sk-ant-real',
          ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        },
      }),
    });

    const { fixClaudeSettingsConflict } = require('../src/cli/handlers/init');
    const result = fixClaudeSettingsConflict();

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.detail).toContain('请手动决定');
  });
});
