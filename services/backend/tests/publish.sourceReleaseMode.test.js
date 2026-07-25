'use strict';

describe('publish source release mode', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.exitCode = 0;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  function mockGitSpawnSync() {
    jest.doMock('child_process', () => {
      const actual = jest.requireActual('child_process');
      return {
        ...actual,
        spawnSync: jest.fn((command, args = []) => {
          if (command !== 'git') return { status: 0, stdout: '', stderr: '' };
          const key = Array.isArray(args) ? args.join(' ') : '';
          if (key.includes('rev-parse --is-inside-work-tree')) return { status: 0, stdout: 'true\n', stderr: '' };
          if (key.includes('rev-parse --abbrev-ref HEAD')) return { status: 0, stdout: 'main\n', stderr: '' };
          if (key.includes('status --porcelain')) return { status: 0, stdout: '', stderr: '' };
          if (key.includes('remote get-url')) return { status: 0, stdout: 'https://github.com/acme/khy-os.git\n', stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }),
      };
    });
  }

  function mockFormatters() {
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printSuccess = jest.fn();
    const printWarn = jest.fn();
    jest.doMock('../src/cli/formatters', () => ({
      printError,
      printInfo,
      printSuccess,
      printWarn,
    }));
    return {
      printError, printInfo, printSuccess, printWarn,
    };
  }

  test('git-push is no longer password-gated — full real release without any secret', async () => {
    mockGitSpawnSync();
    const fmt = mockFormatters();
    const verifyOwnerSecret = jest.fn(() => ({ ok: false, error: 'bad' }));
    jest.doMock('../src/services/ownerControlService', () => ({
      verifyOwnerSecret,
    }));

    const { handlePublish } = require('../src/cli/handlers/publish');
    const ok = await handlePublish('git-push', [], {
      repo: 'acme/khy-os',
      platform: 'github',
      'dry-run': true,
      root: '/home/kodehu03/Khy-OS',
    });

    expect(ok).toBe(true);
    // The owner-secret gate is gone: no verification, and no forced "disturbed"
    // downgrade. The dry-run plan is shown only because --dry-run was passed.
    expect(verifyOwnerSecret).not.toHaveBeenCalled();
    expect(fmt.printWarn).not.toHaveBeenCalledWith(expect.stringContaining('扰乱'));
    expect(fmt.printInfo).toHaveBeenCalledWith(expect.stringContaining('Dry run: git push'));
  });

  test('git-push ignores any provided secret and never consults owner verification', async () => {
    mockGitSpawnSync();
    const fmt = mockFormatters();
    const verifyOwnerSecret = jest.fn(() => ({ ok: true }));
    jest.doMock('../src/services/ownerControlService', () => ({
      verifyOwnerSecret,
    }));

    const { handlePublish } = require('../src/cli/handlers/publish');
    const ok = await handlePublish('git-push', [], {
      repo: 'acme/khy-os',
      platform: 'github',
      secret: 'khy2026',
      'dry-run': true,
      root: '/home/kodehu03/Khy-OS',
    });

    expect(ok).toBe(true);
    expect(verifyOwnerSecret).not.toHaveBeenCalled();
    expect(fmt.printWarn).not.toHaveBeenCalledWith(expect.stringContaining('扰乱'));
    expect(fmt.printInfo).toHaveBeenCalledWith(expect.stringContaining('Dry run: git push'));
  });
});
