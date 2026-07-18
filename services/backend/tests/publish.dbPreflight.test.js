'use strict';

describe('publish handler db preflight', () => {
  const originalEnv = { ...process.env };

  function mockChildProcessSuccess() {
    jest.doMock('child_process', () => {
      const actual = jest.requireActual('child_process');
      return {
        ...actual,
        spawnSync: jest.fn(() => ({ status: 0, stdout: '', stderr: '' })),
      };
    });
  }

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    process.exitCode = 0;
  });

  test('runs forced auto-migration preflight for publish check', async () => {
    const runAutoDbMigration = jest.fn().mockResolvedValue({ ran: true });
    jest.doMock('../src/bootstrap/dbAutoMigration', () => ({ runAutoDbMigration }));
    mockChildProcessSuccess();

    const { handlePublish } = require('../src/cli/handlers/publish');
    const ok = await handlePublish('check', [], { force: true });

    expect(ok).toBe(true);
    expect(runAutoDbMigration).toHaveBeenCalledTimes(1);
    expect(runAutoDbMigration).toHaveBeenCalledWith({
      force: true,
      silent: true,
      reason: 'publish-preflight',
    });
  });

  test('skips db preflight when skip flag is enabled', async () => {
    const runAutoDbMigration = jest.fn().mockResolvedValue({ ran: true });
    jest.doMock('../src/bootstrap/dbAutoMigration', () => ({ runAutoDbMigration }));
    mockChildProcessSuccess();

    const { handlePublish } = require('../src/cli/handlers/publish');
    const ok = await handlePublish('check', [], {
      force: true,
      'skip-db-preflight': true,
    });

    expect(ok).toBe(true);
    expect(runAutoDbMigration).not.toHaveBeenCalled();
  });
});
