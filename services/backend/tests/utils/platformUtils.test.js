'use strict';

function setPlatform(value) {
  Object.defineProperty(process, 'platform', {
    value,
    writable: false,
    enumerable: true,
    configurable: true,
  });
}

describe('platformUtils windows compatibility', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalComSpec = process.env.COMSPEC;

  afterEach(() => {
    jest.resetModules();
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    if (originalComSpec === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = originalComSpec;
  });

  test('shellEscape uses cmd-safe quote escaping', () => {
    const { shellEscape } = require('../../src/tools/platformUtils');
    expect(shellEscape('a "b" c', 'cmd')).toBe('"a ""b"" c"');
  });

  test('openDefault uses cmd start on Windows for URL targets', () => {
    setPlatform('win32');
    const unref = jest.fn();
    const spawn = jest.fn(() => ({ unref, on: jest.fn() }));
    jest.doMock('child_process', () => ({
      ...jest.requireActual('child_process'),
      spawn,
    }));

    const { openDefault } = require('../../src/tools/platformUtils');
    openDefault('http://127.0.0.1:8090/?a=1&b=2');

    expect(spawn).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '""', '"http://127.0.0.1:8090/?a=1&b=2"'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });

  test('openDefault throws on empty target', () => {
    const { openDefault } = require('../../src/tools/platformUtils');
    expect(() => openDefault('')).toThrow('openDefault target is required');
  });

  test('spawnGuiApp uses COMSPEC and cmd safe flags on Windows', () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    const unref = jest.fn();
    const spawn = jest.fn(() => ({ unref, on: jest.fn() }));
    jest.doMock('child_process', () => ({
      ...jest.requireActual('child_process'),
      spawn,
    }));

    const { spawnGuiApp } = require('../../src/tools/platformUtils');
    spawnGuiApp('notepad', ['README.md'], { cwd: 'C:\\work' });

    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'start', '', 'notepad', 'README.md'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });

  test('platformShell uses COMSPEC and /d /s /c on Windows', () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    const { platformShell } = require('../../src/tools/platformUtils');
    expect(platformShell('echo hello')).toEqual({
      cmd: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'echo hello'],
    });
  });
});

/**
 * getShellConfiguration — single source of truth for shell selection across the
 * tool-execution path (shellCommand, grep, lintCode, runTests, buildProject,
 * claudeAdapter seeded_shell). `isWin` is captured at module require-time from
 * process.platform, so each case fakes process.platform BEFORE require (with
 * jest.resetModules) and restores it afterward. Windows env vars
 * (MSYSTEM/TERM/COMSPEC) are stubbed only for the duration of the call.
 */
describe('getShellConfiguration', () => {
  function computeShellConfig({ platform, env = {}, options } = {}) {
    jest.resetModules();
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });

    const savedEnv = {};
    for (const key of Object.keys(env)) {
      savedEnv[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }

    try {
      const { getShellConfiguration } = require('../../src/tools/platformUtils');
      return getShellConfiguration(options);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      for (const key of Object.keys(savedEnv)) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      jest.resetModules();
    }
  }

  test('Unix default → non-login bash (/bin/bash -c)', () => {
    expect(computeShellConfig({ platform: 'linux' }))
      .toEqual({ executable: '/bin/bash', argsPrefix: ['-c'], shell: 'bash' });
  });

  test('Unix login:true → login bash (/bin/bash -lc) for profile PATH', () => {
    expect(computeShellConfig({ platform: 'linux', options: { login: true } }))
      .toEqual({ executable: '/bin/bash', argsPrefix: ['-lc'], shell: 'bash' });
  });

  test('Windows Git Bash (MSYSTEM=MINGW64) → bash with -c', () => {
    const cfg = computeShellConfig({
      platform: 'win32',
      // KHY_GIT_BASH_PATH points at an existing file so findGitBashPath resolves
      // deterministically on the (non-Windows) test host.
      env: { MSYSTEM: 'MINGW64', TERM: 'dumb', KHY_GIT_BASH_PATH: '/bin/bash' },
    });
    expect(cfg.shell).toBe('bash');
    expect(cfg.argsPrefix).toEqual(['-c']);
    expect(cfg.executable).toBe('/bin/bash');
  });

  test('Windows PowerShell (COMSPEC=powershell.exe) → -NoProfile -NonInteractive -Command', () => {
    const cfg = computeShellConfig({
      platform: 'win32',
      env: {
        MSYSTEM: undefined,
        TERM: 'dumb',
        COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      },
    });
    expect(cfg.shell).toBe('powershell');
    expect(cfg.argsPrefix).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(cfg.executable.toLowerCase()).toContain('powershell.exe');
  });

  test('Windows default (COMSPEC=cmd.exe) → cmd with /d /s /c', () => {
    const cfg = computeShellConfig({
      platform: 'win32',
      env: { MSYSTEM: undefined, TERM: 'dumb', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
    });
    expect(cfg.shell).toBe('cmd');
    expect(cfg.argsPrefix).toEqual(['/d', '/s', '/c']);
    expect(cfg.executable.toLowerCase()).toContain('cmd.exe');
  });

  test('login flag is ignored on Windows cmd', () => {
    const cfg = computeShellConfig({
      platform: 'win32',
      env: { MSYSTEM: undefined, TERM: 'dumb', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
      options: { login: true },
    });
    expect(cfg.argsPrefix).toEqual(['/d', '/s', '/c']);
  });

  // ── Minimal Linux (no /bin/bash): Alpine/busybox/NixOS/distroless ──────
  // getShellConfiguration must degrade gracefully instead of returning a
  // non-existent /bin/bash that would fail with ENOENT at spawn time.
  function computeShellConfigWithFs({ platform, env = {}, options, existsSync } = {}) {
    jest.resetModules();
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });

    const savedEnv = {};
    for (const key of Object.keys(env)) {
      savedEnv[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }

    jest.doMock('fs', () => {
      const realFs = jest.requireActual('fs');
      return { ...realFs, existsSync };
    });

    try {
      const { getShellConfiguration } = require('../../src/tools/platformUtils');
      return getShellConfiguration(options);
    } finally {
      jest.dontMock('fs');
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      for (const key of Object.keys(savedEnv)) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      jest.resetModules();
    }
  }

  test('Alpine (no /bin/bash, SHELL=/bin/ash) → falls back to ash with -c', () => {
    const cfg = computeShellConfigWithFs({
      platform: 'linux',
      env: { SHELL: '/bin/ash' },
      existsSync: (p) => p === '/bin/ash', // bash absent, ash present
    });
    expect(cfg).toEqual({ executable: '/bin/ash', argsPrefix: ['-c'], shell: 'sh' });
  });

  test('no /bin/bash and no usable $SHELL → last-resort /bin/sh -c', () => {
    const cfg = computeShellConfigWithFs({
      platform: 'linux',
      env: { SHELL: undefined },
      existsSync: () => false, // nothing resolves
    });
    expect(cfg).toEqual({ executable: '/bin/sh', argsPrefix: ['-c'], shell: 'sh' });
  });

  test('login flag does not produce -lc on non-bash fallback shell', () => {
    const cfg = computeShellConfigWithFs({
      platform: 'linux',
      env: { SHELL: '/bin/ash' },
      options: { login: true },
      existsSync: (p) => p === '/bin/ash',
    });
    // dash/busybox login semantics are unreliable → must stay -c, never -lc
    expect(cfg.argsPrefix).toEqual(['-c']);
  });

  test('bash present → still preferred even when $SHELL points elsewhere', () => {
    const cfg = computeShellConfigWithFs({
      platform: 'linux',
      env: { SHELL: '/bin/zsh' },
      options: { login: true },
      existsSync: () => true, // bash exists
    });
    expect(cfg).toEqual({ executable: '/bin/bash', argsPrefix: ['-lc'], shell: 'bash' });
  });
});
