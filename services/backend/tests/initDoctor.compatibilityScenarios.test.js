'use strict';

describe('doctor compatibility scenarios', () => {
  function mockDoctorDependencies({
    activeAdapterName = 'Claude Code',
    redisMode = 'missing',
    loopbackMode = 'blocked',
    nodeLlamaMode = 'missing',
  } = {}) {
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
            if (redisMode === 'running') return 'PONG';
            const err = new Error(redisMode === 'unavailable' ? 'Redis connection refused' : 'redis-cli missing');
            err.code = redisMode === 'unavailable' ? 'ECONNREFUSED' : 'ENOENT';
            throw err;
          }

          if (cmd === process.execPath && argv[0] === '-e') {
            const script = String(argv[1] || '');

            if (script.includes('const n=require("net")')) {
              if (loopbackMode === 'ok') return 'OK';
              const err = new Error(loopbackMode === 'unavailable' ? 'connection refused' : 'operation not permitted');
              err.code = loopbackMode === 'unavailable' ? 'ECONNREFUSED' : 'EACCES';
              throw err;
            }

            if (script.includes('require.resolve("node-llama-cpp"')) {
              if (nodeLlamaMode === 'available') return 'OK';
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
      getActiveAdapter: () => ({ name: activeAdapterName, activeModel: 'mock-model' }),
      getDefaultRouteRecommendation: () => ({
        adapter: String(activeAdapterName || '').toLowerCase().includes('ollama') ? 'ollama' : 'claude',
        name: activeAdapterName,
        summary: `${activeAdapterName} 当前为默认稳定通道`,
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
  }

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('treats redis-cli missing as optional info', () => {
    mockDoctorDependencies({ redisMode: 'missing', loopbackMode: 'blocked', activeAdapterName: 'Claude Code' });
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const redisCheck = checks.find((item) => item.label === 'Redis');
    expect(redisCheck).toBeTruthy();
    expect(redisCheck.ok).toBe(true);
    expect(redisCheck.level).toBe('info');
    expect(redisCheck.detail).toContain('未安装 redis-cli');
  });

  test('treats Redis connection refusal as a warning', () => {
    mockDoctorDependencies({ redisMode: 'unavailable', loopbackMode: 'blocked', activeAdapterName: 'Claude Code' });
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const redisCheck = checks.find((item) => item.label === 'Redis');
    expect(redisCheck).toBeTruthy();
    expect(redisCheck.ok).toBe(false);
    expect(redisCheck.level).toBe('warn');
    expect(redisCheck.detail).toContain('Redis 未响应');
  });

  test('downgrades local-model probe failures when the active adapter is remote', () => {
    mockDoctorDependencies({ redisMode: 'missing', loopbackMode: 'blocked', activeAdapterName: 'Claude Code' });
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const loopbackCheck = checks.find((item) => item.label === '本地监听能力');
    const runnerCheck = checks.find((item) => item.label === 'ollama-runner');
    const llamaCheck = checks.find((item) => item.label === 'llama-cpp binary');
    const nodeLlamaCheck = checks.find((item) => item.label === 'node-llama-cpp');
    const availabilityCheck = checks.find((item) => item.label === '本地模型可用性');

    expect(loopbackCheck.ok).toBe(true);
    expect(loopbackCheck.level).toBe('info');
    expect(loopbackCheck.detail).toContain('当前未启用本地模型，可忽略');
    expect(runnerCheck.ok).toBe(true);
    expect(runnerCheck.level).toBe('info');
    expect(llamaCheck.ok).toBe(true);
    expect(llamaCheck.level).toBe('info');
    expect(nodeLlamaCheck.ok).toBe(true);
    expect(nodeLlamaCheck.level).toBe('info');
    expect(availabilityCheck).toBeUndefined();
  });

  test('keeps local-model probe failures as warnings when a local adapter is expected', () => {
    mockDoctorDependencies({ redisMode: 'missing', loopbackMode: 'blocked', activeAdapterName: 'Ollama Local' });
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const loopbackCheck = checks.find((item) => item.label === '本地监听能力');
    const runnerCheck = checks.find((item) => item.label === 'ollama-runner');
    const llamaCheck = checks.find((item) => item.label === 'llama-cpp binary');
    const nodeLlamaCheck = checks.find((item) => item.label === 'node-llama-cpp');
    const availabilityCheck = checks.find((item) => item.label === '本地模型可用性');

    expect(loopbackCheck.ok).toBe(false);
    expect(loopbackCheck.level).toBe('warn');
    expect(loopbackCheck.detail).toContain('检测受限');
    expect(runnerCheck.ok).toBe(false);
    expect(runnerCheck.level).toBe('warn');
    expect(llamaCheck.ok).toBe(false);
    expect(llamaCheck.level).toBe('warn');
    expect(nodeLlamaCheck.ok).toBe(false);
    expect(nodeLlamaCheck.level).toBe('warn');
    expect(availabilityCheck).toBeTruthy();
    expect(availabilityCheck.ok).toBe(false);
    expect(availabilityCheck.level).toBe('warn');
  });
});
