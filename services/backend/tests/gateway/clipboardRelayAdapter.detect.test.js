'use strict';

describe('clipboardRelayAdapter detect on Windows', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('detect succeeds when pwsh is available without reading clipboard', () => {
    const execFileSync = jest.fn(() => 'C:\\Program Files\\PowerShell\\pwsh.exe');
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
      .mockImplementationOnce(() => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
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
    expect(execSync).not.toHaveBeenCalled();
  });
});
