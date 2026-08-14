'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function setPlatform(value) {
  Object.defineProperty(process, 'platform', {
    value,
    writable: false,
    enumerable: true,
    configurable: true,
  });
}

describe('windows shell executor compatibility', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    process.env = { ...originalEnv };
  });

  test('shellCommand uses COMSPEC and cmd safe flags', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.ComSpec = 'C:\\Legacy\\cmd.exe';
    process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED = 'true';

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const shellCommandTool = require('../src/tools/shellCommand');
    const result = await shellCommandTool.execute({ command: 'echo hello' }, {});

    expect(result.success).toBe(true);
    // cmd output is now always forced to UTF-8 (chcp 65001) so localized output
    // (e.g. `dir` on Chinese Windows) decodes deterministically. `&` keeps the
    // original command's exit code.
    expect(spawnWithIdleTimeout).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'chcp 65001>nul & echo hello'],
      expect.any(Object)
    );
  });

  test('run_tests uses COMSPEC and cmd safe flags', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.ComSpec = 'C:\\Legacy\\cmd.exe';

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const runTestsTool = require('../src/tools/runTests');
    const result = await runTestsTool.execute({ command: 'echo tests-ok' }, {});

    expect(result.success).toBe(true);
    expect(spawnWithIdleTimeout).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'echo tests-ok'],
      expect.any(Object)
    );
  });

  test('build_project uses COMSPEC and cmd safe flags', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.ComSpec = 'C:\\Legacy\\cmd.exe';

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const buildProjectTool = require('../src/tools/buildProject');
    const result = await buildProjectTool.execute({ command: 'echo build-ok' }, {});

    expect(result.success).toBe(true);
    expect(spawnWithIdleTimeout).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'echo build-ok'],
      expect.any(Object)
    );
  });

  test('lint_code uses COMSPEC and cmd safe flags', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.ComSpec = 'C:\\Legacy\\cmd.exe';

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const lintCodeTool = require('../src/tools/lintCode');
    const result = await lintCodeTool.execute({ command: 'echo lint-ok' }, {});

    expect(result.success).toBe(true);
    expect(spawnWithIdleTimeout).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'echo lint-ok'],
      expect.any(Object)
    );
  });

  test('grep uses COMSPEC and cmd safe flags on windows rg path', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.ComSpec = 'C:\\Legacy\\cmd.exe';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-grep-win-'));
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello windows\n', 'utf8');

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 1, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));
    jest.doMock('../src/tools/platformUtils', () => ({
      isRgAvailable: () => true,
      isGrepAvailable: () => false,
      shellEscape: (arg) => `"${String(arg).replace(/"/g, '""')}"`,
      pureJsGrep: jest.fn(),
      // grep.js iterates DEFAULT_EXCLUDE_DIRS; the mock must provide it.
      DEFAULT_EXCLUDE_DIRS: ['node_modules', '.git', 'dist', 'build', '.cache', 'coverage', '__pycache__'],
      getShellConfiguration: () => ({
        executable: process.env.COMSPEC || 'cmd.exe',
        argsPrefix: ['/d', '/s', '/c'],
        shell: 'cmd',
      }),
    }));

    const grepTool = require('../src/tools/grep');
    const result = await grepTool.execute({
      pattern: 'not_found_12345',
      path: tmpDir,
      output_mode: 'content',
      idleTimeout: 200,
    }, {});

    expect(result.success).toBe(true);
    expect(spawnWithIdleTimeout).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      expect.arrayContaining(['/d', '/s', '/c']),
      expect.any(Object)
    );
    expect(spawnWithIdleTimeout.mock.calls[0][1][3]).toContain('rg ');
  });

  // ── UTF-8 forcing for non-ASCII commands (CJK paths on GBK Windows) ──

  test('cmd: non-ASCII command forces chcp 65001 + utf-8 output decoding', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED = 'true';

    // An earlier test in this suite leaves a partial platformUtils doMock
    // registered (jest.doMock survives resetModules); cancel it so the real
    // helper (isGuiApp, getShellConfiguration, …) is loaded here.
    jest.resetModules();
    jest.unmock('../src/tools/platformUtils');

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const shellCommandTool = require('../src/tools/shellCommand');
    const result = await shellCommandTool.execute(
      { command: 'mkdir "D:\\Desktop\\测试"' },
      {}
    );

    expect(result.success).toBe(true);
    const [, args, opts] = spawnWithIdleTimeout.mock.calls[0];
    // chcp prefix is prepended; `&` keeps the original command's exit code.
    expect(args[3]).toBe('chcp 65001>nul & mkdir "D:\\Desktop\\测试"');
    // Decoder is pinned to utf-8 since the child console was forced to UTF-8.
    expect(opts.outputEncoding).toBe('utf-8');
  });

  test('cmd: ASCII-only command WITH Chinese output also forces chcp 65001 (dir 乱码 fix)', async () => {
    // 用户实测破口：`dir "D:\..."` 命令本身纯 ASCII，但输出含中文（本地化表头 +
    // 中文文件名）。旧实现仅当命令含非 ASCII 才强制 chcp，故此命令漏强制 → 子进程
    // 吐 GBK 字节被按 UTF-8 解码成 `������ D �еľ��� Data` 乱码。修复后强制条件取决于
    // shell 类型而非命令字节，故纯 ASCII 命令同样获得 chcp 65001 + utf-8 解码。
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED = 'true';
    delete process.env.KHY_WIN_FORCE_UTF8;

    jest.resetModules();
    jest.unmock('../src/tools/platformUtils');

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const shellCommandTool = require('../src/tools/shellCommand');
    await shellCommandTool.execute({ command: 'dir "D:\\HuaweiMoveData\\Users\\25789\\Desktop"' }, {});

    const [, args, opts] = spawnWithIdleTimeout.mock.calls[0];
    expect(args[3]).toBe('chcp 65001>nul & dir "D:\\HuaweiMoveData\\Users\\25789\\Desktop"');
    expect(opts.outputEncoding).toBe('utf-8');
  });

  test('cmd: KHY_WIN_FORCE_UTF8=0 disables forcing (escape valve → spawn-side auto-detect)', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED = 'true';
    process.env.KHY_WIN_FORCE_UTF8 = '0';

    jest.resetModules();
    jest.unmock('../src/tools/platformUtils');

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const shellCommandTool = require('../src/tools/shellCommand');
    await shellCommandTool.execute({ command: 'dir test' }, {});

    const [, args, opts] = spawnWithIdleTimeout.mock.calls[0];
    // 关闭强制后命令逐字不变，解码回落 spawn 侧代码页自动探测（outputEncoding=null）。
    expect(args[3]).toBe('dir test');
    expect(opts.outputEncoding).toBeNull();
    delete process.env.KHY_WIN_FORCE_UTF8;
  });

  test('powershell: non-ASCII command forces OutputEncoding + utf-8 decoding', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED = 'true';

    jest.resetModules();
    jest.unmock('../src/tools/platformUtils');

    const spawnWithIdleTimeout = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    jest.doMock('../src/utils/spawnWithIdleTimeout', () => ({ spawnWithIdleTimeout }));

    const shellCommandTool = require('../src/tools/shellCommand');
    const result = await shellCommandTool.execute(
      { command: "New-Item -ItemType Directory -Path 'D:\\Desktop\\测试'" },
      {}
    );

    expect(result.success).toBe(true);
    const [, args, opts] = spawnWithIdleTimeout.mock.calls[0];
    const psCommand = args[args.length - 1];
    expect(psCommand).toContain('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;');
    expect(psCommand).toContain('测试');
    expect(opts.outputEncoding).toBe('utf-8');
  });
});
