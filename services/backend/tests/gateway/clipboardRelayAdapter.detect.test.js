'use strict';

/**
 * detect() 的 Windows 分支：只做「可执行文件在不在」的探测，绝不读剪贴板内容。
 *
 * 模拟 Windows 必须同时改两处，只改一处会在 Linux/macOS 上红：
 *   - `os.platform()` —— adapter 自己的平台分支读它（选择走 POWERSHELL_BINS 循环）；
 *   - `process.platform` —— platformUtils.searchExecutable 读它来决定查找命令是
 *     `where` 还是 `which`（platformUtils.js:31）。它不经过 os 模块，所以 doMock('os')
 *     管不到；漏掉它的话，被 mock 的 execFileSync 在非 Windows 上会收到 `which`，
 *     断言 `where` 就落空 —— 而这跟 adapter 的行为毫无关系，纯属模拟不完整。
 */

const REAL_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform');

/** 把整个进程视角伪装成 Windows（os 模块 + process.platform）。 */
function mockWindows() {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  jest.doMock('os', () => ({
    ...jest.requireActual('os'),
    platform: () => 'win32',
  }));
}

describe('clipboardRelayAdapter detect on Windows', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', REAL_PLATFORM_DESC);
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('detect succeeds when pwsh is available without reading clipboard', () => {
    const execFileSync = jest.fn(() => 'C:\Program Files\PowerShell\pwsh.exe');
    const execSync = jest.fn();
    const exec = jest.fn();

    mockWindows();
    jest.doMock('child_process', () => ({
      execFileSync,
      execSync,
      exec,
    }));

    const adapter = require('../../src/services/gateway/adapters/clipboardRelayAdapter');
    expect(adapter.detect()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'where',
      ['pwsh'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 3000 })
    );
    expect(execFileSync).not.toHaveBeenCalledWith(
      'pwsh',
      expect.arrayContaining(['Get-Clipboard -Raw']),
      expect.anything()
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  test('detect falls back to powershell when pwsh is unavailable', () => {
    const execFileSync = jest
      .fn()
      .mockImplementationOnce(() => { throw new Error('pwsh not found'); })
      .mockImplementationOnce(() => 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe');
    const execSync = jest.fn();
    const exec = jest.fn();

    mockWindows();
    jest.doMock('child_process', () => ({
      execFileSync,
      execSync,
      exec,
    }));

    const adapter = require('../../src/services/gateway/adapters/clipboardRelayAdapter');
    expect(adapter.detect()).toBe(true);
    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      'where',
      ['pwsh'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 3000 })
    );
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      'where',
      ['powershell'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 3000 })
    );
    expect(execFileSync.mock.calls.some(([, args]) => args.includes('Get-Clipboard -Raw'))).toBe(false);
    expect(execSync).not.toHaveBeenCalled();
  });

  test('detect returns false when no Windows PowerShell binary is present', () => {
    const execFileSync = jest.fn(() => { throw new Error('unavailable'); });
    const execSync = jest.fn();
    const exec = jest.fn();

    mockWindows();
    jest.doMock('child_process', () => ({
      execFileSync,
      execSync,
      exec,
    }));

    const adapter = require('../../src/services/gateway/adapters/clipboardRelayAdapter');
    expect(adapter.detect()).toBe(false);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(execSync).not.toHaveBeenCalled();
  });
});
