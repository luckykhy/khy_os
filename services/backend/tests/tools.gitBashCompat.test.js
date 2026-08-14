'use strict';

// Regression coverage for the Windows / Git Bash (MSYS) failure surfaced in the
// field transcript: on a machine where MSYSTEM is set, KHY runs commands through
// Git Bash, but the model generated cmd-style commands —
//   mkdir "D:\HuaweiMoveData\Users\25789\Desktop\测试文件夹"
//   dir   "D:\HuaweiMoveData\Users\25789\Desktop\测试文件夹"
// MSYS coreutils cannot resolve backslash drive paths and has no `dir`, so both
// exited with code 1, and the empty `error` field meant "失败原因" was
// unanswerable. These tests pin the two deterministic fixes:
//   1. _patchGitBashCommand: D:\foo → /d/foo, `dir` → `ls -la`
//   2. _composeShellError: real stderr is surfaced in the `error` field

const path = require('path');

function setPlatform(value) {
  Object.defineProperty(process, 'platform', {
    value,
    writable: false,
    enumerable: true,
    configurable: true,
  });
}

describe('Git Bash (MSYS) shell compatibility on Windows', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    process.env = { ...originalEnv };
  });

  function enterGitBash() {
    setPlatform('win32');
    // MSYSTEM drives getShellConfiguration → Git Bash (shell: 'bash').
    process.env.MSYSTEM = 'MINGW64';
    // Pin the bash binary so findGitBashPath does not scan PATH on the host.
    process.env.KHY_GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';
    process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED = 'true';
    jest.resetModules();
    jest.unmock('../src/tools/platformUtils');
  }

  test('drive-absolute Windows path is translated to MSYS form for mkdir', async () => {
    enterGitBash();

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const shellCommandTool = require('../src/tools/shellCommand');
    const result = await shellCommandTool.execute(
      { command: 'mkdir "D:\\HuaweiMoveData\\Users\\25789\\Desktop\\测试文件夹"' },
      {}
    );

    expect(result.success).toBe(true);
    const [, args] = spawnWithIdleTimeout.mock.calls[0];
    // argsPrefix for Git Bash is ['-c'], so the command is args[1].
    expect(args[0]).toBe('-c');
    expect(args[1]).toBe('mkdir "/d/HuaweiMoveData/Users/25789/Desktop/测试文件夹"');
  });

  test('cmd-only `dir` is translated to `ls -la` and its drive path normalized', async () => {
    enterGitBash();

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const shellCommandTool = require('../src/tools/shellCommand');
    await shellCommandTool.execute(
      { command: 'dir "D:\\HuaweiMoveData\\Users\\25789\\Desktop\\测试文件夹"' },
      {}
    );

    const [, args] = spawnWithIdleTimeout.mock.calls[0];
    expect(args[1]).toBe('ls -la "/d/HuaweiMoveData/Users/25789/Desktop/测试文件夹"');
  });

  test('POSIX command in Git Bash is left byte-for-byte unchanged (zero regression)', async () => {
    enterGitBash();

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const shellCommandTool = require('../src/tools/shellCommand');
    await shellCommandTool.execute({ command: 'ls -la /tmp && echo done' }, {});

    const [, args] = spawnWithIdleTimeout.mock.calls[0];
    expect(args[1]).toBe('ls -la /tmp && echo done');
  });

  test('non-zero exit surfaces the real stderr in the error field ("失败原因" is answerable)', async () => {
    enterGitBash();

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: "mkdir: cannot create directory '/d/locked': Permission denied",
    });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const shellCommandTool = require('../src/tools/shellCommand');
    const result = await shellCommandTool.execute(
      { command: 'mkdir "D:\\locked"' },
      {}
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    // error must carry both the exit code and the actual failure cause.
    expect(result.error).toContain('Command exited with code 1');
    expect(result.error).toContain('Permission denied');
  });

  test('non-zero exit with no output still yields a non-empty error', async () => {
    enterGitBash();

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 1, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const shellCommandTool = require('../src/tools/shellCommand');
    const result = await shellCommandTool.execute({ command: 'false' }, {});

    expect(result.success).toBe(false);
    // 错误映射:既带退出码,又**永不**塌缩成裸 exit-1 —— 空输出时附一条形态诊断行
    // (Fix A / shellDiagnostics.composeShellError)。这正是用户硬性要求「不能只输出 exit-1」。
    expect(result.error).toContain('Command exited with code 1');
    expect(result.error.split('\n').length).toBeGreaterThanOrEqual(2);
    expect(result.error).toMatch(/唯一信号|退出码/);
  });
});
