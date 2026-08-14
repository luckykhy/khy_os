'use strict';

describe('clipboardRelayAdapter detect on Windows', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('detect succeeds when pwsh clipboard command is available', () => {
    const execFileSync = jest.fn(() => 'ok');
    const execSync = jest.fn();
    const exec = jest.fn();

    jest.doMock('os', () => ({
      ...jest.requireActual('os'),
      platform: () => 'win32',
    }));
    jest.doMock('child_process', () => ({
      execFileSync,
      execSync,
      exec,
    }));

    const adapter = require('../../src/services/gateway/adapters/clipboardRelayAdapter');
    expect(adapter.detect()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      expect.objectContaining({ encoding: 'utf-8', windowsHide: true })
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  test('detect falls back to powershell when pwsh is unavailable', () => {
    const execFileSync = jest
      .fn()
      .mockImplementationOnce(() => { throw new Error('pwsh not found'); })
      .mockImplementationOnce(() => 'ok');
    const execSync = jest.fn();
    const exec = jest.fn();

    jest.doMock('os', () => ({
      ...jest.requireActual('os'),
      platform: () => 'win32',
    }));
    jest.doMock('child_process', () => ({
      execFileSync,
      execSync,
      exec,
    }));

    const adapter = require('../../src/services/gateway/adapters/clipboardRelayAdapter');
    expect(adapter.detect()).toBe(true);
    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      expect.objectContaining({ encoding: 'utf-8', windowsHide: true })
    );
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      expect.objectContaining({ encoding: 'utf-8', windowsHide: true })
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  test('detect returns false when all Windows clipboard commands fail', () => {
    const execFileSync = jest.fn(() => { throw new Error('unavailable'); });
    const execSync = jest.fn(() => { throw new Error('fallback failed'); });
    const exec = jest.fn();

    jest.doMock('os', () => ({
      ...jest.requireActual('os'),
      platform: () => 'win32',
    }));
    jest.doMock('child_process', () => ({
      execFileSync,
      execSync,
      exec,
    }));

    const adapter = require('../../src/services/gateway/adapters/clipboardRelayAdapter');
    expect(adapter.detect()).toBe(false);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(execSync).toHaveBeenCalledTimes(1);
  });
});
