'use strict';

function setPlatform(value) {
  Object.defineProperty(process, 'platform', {
    value,
    writable: false,
    enumerable: true,
    configurable: true,
  });
}

describe('platformUtils.openDefault', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    process.env = { ...originalEnv };
  });

  test('quotes windows URL for cmd start to avoid metachar parsing', () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    const child = { unref: jest.fn() };
    const spawn = jest.fn(() => child);
    jest.doMock('child_process', () => ({
      spawn,
      execFileSync: jest.fn(),
      execSync: jest.fn(),
    }));

    const { openDefault } = require('../src/tools/platformUtils');
    const target = 'http://127.0.0.1:8090?khy_manage_ctl=a&khy_manage_token=b';
    openDefault(target);

    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'start "" "http://127.0.0.1:8090?khy_manage_ctl=a&khy_manage_token=b"'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    );
    expect(child.unref).toHaveBeenCalled();
  });

  test('uses macOS open command', () => {
    setPlatform('darwin');
    const child = { unref: jest.fn() };
    const spawn = jest.fn(() => child);
    jest.doMock('child_process', () => ({
      spawn,
      execFileSync: jest.fn(),
      execSync: jest.fn(),
    }));

    const { openDefault } = require('../src/tools/platformUtils');
    openDefault('http://127.0.0.1:8090');

    expect(spawn).toHaveBeenCalledWith(
      'open',
      ['http://127.0.0.1:8090'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
      })
    );
    expect(child.unref).toHaveBeenCalled();
  });
});
