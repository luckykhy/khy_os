'use strict';

const handleVersion = require('../../src/cli/commands/system/version');

describe('system/version command', () => {
  const originalEnv = process.env;
  const originalLog = console.log;
  let mockPrintSuccess;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    console.log = jest.fn();
    mockPrintSuccess = jest.fn();
  });

  afterEach(() => {
    console.log = originalLog;
    process.env = originalEnv;
  });

  test('returns true on success', async () => {
    const result = await handleVersion({}, {});
    expect(result).toBe(true);
  });

  test('returns true even when package.json cannot be read', async () => {
    delete process.env.KHYQUANT_PKG_VERSION;
    jest.mock('../../package.json', () => {
      throw new Error('not found');
    });
    const result = await handleVersion({}, {});
    expect(result).toBe(true);
  });

  test('uses KHYQUANT_PKG_VERSION env when set', async () => {
    process.env.KHYQUANT_PKG_VERSION = '2.0.0';
    await handleVersion({}, { printSuccess: mockPrintSuccess });
    expect(mockPrintSuccess).toHaveBeenCalledWith('Khy-OS v2.0.0');
  });

  test('falls back to package.json version when env not set', async () => {
    delete process.env.KHYQUANT_PKG_VERSION;
    await handleVersion({}, { printSuccess: mockPrintSuccess });
    expect(mockPrintSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Khy-OS v/));
  });

  test('uses console.log when printSuccess not provided', async () => {
    process.env.KHYQUANT_PKG_VERSION = '1.5.0';
    await handleVersion({}, {});
    expect(console.log).toHaveBeenCalledWith('Khy-OS v1.5.0');
  });

  test('uses console.log when ctx is undefined', async () => {
    process.env.KHYQUANT_PKG_VERSION = '1.5.0';
    await handleVersion({}, undefined);
    expect(console.log).toHaveBeenCalledWith('Khy-OS v1.5.0');
  });

  test('uses console.log when ctx is null', async () => {
    process.env.KHYQUANT_PKG_VERSION = '1.5.0';
    await handleVersion({}, null);
    expect(console.log).toHaveBeenCalledWith('Khy-OS v1.5.0');
  });

  test('handles empty parsed argument', async () => {
    const result = await handleVersion({}, {});
    expect(result).toBe(true);
  });

  test('handles parsed with arguments', async () => {
    const result = await handleVersion({ _: ['extra'] }, {});
    expect(result).toBe(true);
  });

  test('handles missing package.json gracefully', async () => {
    delete process.env.KHYQUANT_PKG_VERSION;
    const originalRequire = require;
    jest.mock('../../package.json', () => {
      throw new Error('Cannot find module');
    });
    const result = await handleVersion({}, {});
    expect(result).toBe(true);
  });

  test('outputs version unknown when both env and package.json fail', async () => {
    delete process.env.KHYQUANT_PKG_VERSION;
    jest.mock('../../package.json', () => {
      throw new Error('not found');
    });
    await handleVersion({}, {});
    expect(console.log).toHaveBeenCalledWith('Khy-OS version unknown');
  });

  test('handles printSuccess being a non-function', async () => {
    process.env.KHYQUANT_PKG_VERSION = '1.0.0';
    const result = await handleVersion({}, { printSuccess: 'not a function' });
    expect(result).toBe(true);
  });
});

