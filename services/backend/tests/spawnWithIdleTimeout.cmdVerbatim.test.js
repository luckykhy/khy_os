'use strict';

/**
 * Regression: Windows cmd.exe argument quoting.
 *
 * Field failure — creating a folder on a Chinese Windows desktop:
 *   mkdir "D:\HuaweiMoveData\Users\25789\Desktop\test-files"
 * exited code 1 with "文件名、目录名或卷标语法不正确" (ERROR_INVALID_NAME). Cause:
 * callers hand cmd.exe one pre-quoted command string as the last argv element, but
 * libuv re-escapes the embedded double-quotes MSVCRT-style (`\"`). cmd.exe does not
 * understand `\"`, so the path arrives as `\"D:\...\"` whose literal `"` is an
 * illegal filename char. The fix sets windowsVerbatimArguments for cmd.exe spawns so
 * cmd parses its own quotes. PowerShell / MSYS bash decode `\"` fine and must stay
 * untouched.
 *
 * The flag decision depends on `process.platform` and the executable basename, so
 * each case loads a fresh module with child_process.spawn mocked to capture opts.
 */

const { EventEmitter } = require('events');

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  child.pid = 4242;
  // Resolve the run on the next tick with a clean exit.
  setImmediate(() => child.emit('close', 0));
  return child;
}

function load({ platform }) {
  jest.resetModules();
  const calls = [];
  jest.doMock('child_process', () => ({
    spawn: (command, args, opts) => {
      calls.push({ command, args, opts });
      return makeFakeChild();
    },
  }));
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  // eslint-disable-next-line global-require
  const { spawnWithIdleTimeout } = require('../src/utils/spawnWithIdleTimeout');
  return {
    spawnWithIdleTimeout,
    calls,
    restore() {
      Object.defineProperty(process, 'platform', platformDesc);
      jest.dontMock('child_process');
    },
  };
}

describe('spawnWithIdleTimeout cmd.exe verbatim arguments', () => {
  test('win32 + cmd.exe: windowsVerbatimArguments is forced true', async () => {
    const { spawnWithIdleTimeout, calls, restore } = load({ platform: 'win32' });
    try {
      await spawnWithIdleTimeout(
        'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/s', '/c', 'mkdir "D:\\HuaweiMoveData\\Users\\25789\\Desktop\\test-files"'],
        { idleMs: 5000, spawnOpts: { cwd: 'C:\\', windowsHide: true } }
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.windowsVerbatimArguments).toBe(true);
      // Pre-existing spawnOpts are preserved.
      expect(calls[0].opts.windowsHide).toBe(true);
      expect(calls[0].opts.cwd).toBe('C:\\');
    } finally {
      restore();
    }
  });

  test('win32 + bare "cmd" basename also matches', async () => {
    const { spawnWithIdleTimeout, calls, restore } = load({ platform: 'win32' });
    try {
      await spawnWithIdleTimeout('cmd', ['/d', '/s', '/c', 'echo hi'], { idleMs: 5000 });
      expect(calls[0].opts.windowsVerbatimArguments).toBe(true);
    } finally {
      restore();
    }
  });

  test('win32 + bash.exe (Git Bash): flag is NOT set (libuv \\" decodes fine)', async () => {
    const { spawnWithIdleTimeout, calls, restore } = load({ platform: 'win32' });
    try {
      await spawnWithIdleTimeout(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        ['-c', 'mkdir "/d/test"'],
        { idleMs: 5000 }
      );
      expect(calls[0].opts.windowsVerbatimArguments).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('win32 + powershell.exe: flag is NOT set', async () => {
    const { spawnWithIdleTimeout, calls, restore } = load({ platform: 'win32' });
    try {
      await spawnWithIdleTimeout(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoProfile', '-Command', 'New-Item -ItemType Directory -Path "D:\\x"'],
        { idleMs: 5000 }
      );
      expect(calls[0].opts.windowsVerbatimArguments).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('explicit caller windowsVerbatimArguments:false is respected for cmd.exe', async () => {
    const { spawnWithIdleTimeout, calls, restore } = load({ platform: 'win32' });
    try {
      await spawnWithIdleTimeout(
        'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/s', '/c', 'echo hi'],
        { idleMs: 5000, spawnOpts: { windowsVerbatimArguments: false } }
      );
      expect(calls[0].opts.windowsVerbatimArguments).toBe(false);
    } finally {
      restore();
    }
  });

  test('non-win32: cmd.exe basename never triggers the flag', async () => {
    const { spawnWithIdleTimeout, calls, restore } = load({ platform: 'linux' });
    try {
      await spawnWithIdleTimeout('cmd.exe', ['/c', 'echo hi'], { idleMs: 5000 });
      expect(calls[0].opts.windowsVerbatimArguments).toBeUndefined();
    } finally {
      restore();
    }
  });
});
