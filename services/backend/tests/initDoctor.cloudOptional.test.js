'use strict';

describe('doctor cloud connectivity compatibility', () => {
  function mockBaseDependencies({ loggedIn }) {
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
            const err = new Error('redis not running');
            err.code = 'ECONNREFUSED';
            throw err;
          }
          if (cmd === process.execPath && argv[0] === '-e') return 'OK';
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
      getActiveAdapter: () => ({ name: 'Mock Adapter', activeModel: 'mock-model' }),
      getDefaultRouteRecommendation: () => ({
        adapter: 'mock',
        name: 'Mock Adapter',
        summary: 'Mock Adapter (mock) 当前为默认稳定通道',
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
      isLoggedIn: () => loggedIn,
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

  test('treats cloud login as optional warning when not logged in', () => {
    mockBaseDependencies({ loggedIn: false });
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const cloudCheck = checks.find((item) => item.label === '云端连接');
    expect(cloudCheck).toBeTruthy();
    expect(cloudCheck.ok).toBe(false);
    expect(cloudCheck.level).toBe('warn');
    expect(cloudCheck.detail).toContain('可选: khy cloud login');
  });

  test('marks cloud check as info when logged in', () => {
    mockBaseDependencies({ loggedIn: true });
    const { runDoctorChecks } = require('../src/cli/handlers/init');
    const checks = runDoctorChecks();

    const cloudCheck = checks.find((item) => item.label === '云端连接');
    expect(cloudCheck).toBeTruthy();
    expect(cloudCheck.ok).toBe(true);
    expect(cloudCheck.level).toBe('info');
    expect(cloudCheck.detail).toContain('已登录 (tester)');
  });
});
