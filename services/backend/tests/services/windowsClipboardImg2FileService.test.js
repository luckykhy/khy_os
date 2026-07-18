'use strict';

function setPlatform(value) {
  Object.defineProperty(process, 'platform', {
    value,
    writable: false,
    enumerable: true,
    configurable: true,
  });
}

describe('windowsClipboardImg2FileService', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    process.env = { ...originalEnv };
  });

  test('returns unsupported on non-windows platform', () => {
    setPlatform('linux');
    const svc = require('../../src/services/windowsClipboardImg2FileService');
    const result = svc.startClipboardImg2FileBridge();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported_platform');
  });

  test('respects disabled env flag on windows', () => {
    setPlatform('win32');
    process.env.KHY_CLIPBOARD_IMG2FILE_ENABLED = 'false';

    const svc = require('../../src/services/windowsClipboardImg2FileService');
    const result = svc.startClipboardImg2FileBridge();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('disabled_by_env');
  });

  test('defaults to ENABLED on windows when env flag is unset (paste path works out of the box)', () => {
    setPlatform('win32');
    delete process.env.KHY_CLIPBOARD_IMG2FILE_ENABLED;

    const svc = require('../../src/services/windowsClipboardImg2FileService');
    expect(svc.isEnabledByEnv()).toBe(true);
  });

  test('isClipboardImageFresh: only fresh (within window) images count; stale ignored', () => {
    const svc = require('../../src/services/windowsClipboardImg2FileService');
    const now = 1_000_000_000;
    // 默认新鲜窗口 8s。
    expect(svc.isClipboardImageFresh(now - 1000, now)).toBe(true); // 1s ago → fresh
    expect(svc.isClipboardImageFresh(now - 7999, now)).toBe(true); // just inside
    expect(svc.isClipboardImageFresh(now - 8001, now)).toBe(false); // just outside → stale
    expect(svc.isClipboardImageFresh(now - 60000, now)).toBe(false); // 1min ago → stale
    // 未来时间戳 / 非法输入 → false(宁可漏抓不误抓)。
    expect(svc.isClipboardImageFresh(now + 5000, now)).toBe(false);
    expect(svc.isClipboardImageFresh(0, now)).toBe(false);
    expect(svc.isClipboardImageFresh(NaN, now)).toBe(false);
    expect(svc.isClipboardImageFresh('x', now)).toBe(false);
  });

  test('fresh window is configurable via KHY_CLIPBOARD_IMG2FILE_FRESH_MS (clamped)', () => {
    process.env.KHY_CLIPBOARD_IMG2FILE_FRESH_MS = '2000';
    const svc = require('../../src/services/windowsClipboardImg2FileService');
    expect(svc.getFreshWindowMs()).toBe(2000);
    const now = 1_000_000_000;
    expect(svc.isClipboardImageFresh(now - 1500, now)).toBe(true);
    expect(svc.isClipboardImageFresh(now - 2500, now)).toBe(false);
  });

  test('starts powershell bridge with STA mode on windows', () => {
    setPlatform('win32');
    process.env.KHY_CLIPBOARD_IMG2FILE_ENABLED = 'true'; // opt-in required now

    const child = {
      pid: 43210,
      killed: false,
      once: jest.fn(),
      kill: jest.fn(() => {
        child.killed = true;
        return true;
      }),
    };
    const spawn = jest.fn(() => child);

    jest.doMock('child_process', () => ({ spawn }));
    jest.doMock('fs', () => ({
      ...jest.requireActual('fs'),
      existsSync: jest.fn(() => true),
      mkdirSync: jest.fn(),
    }));
    jest.doMock('../../src/utils/dataHome', () => ({
      getDataDir: jest.fn(() => 'C:\\khy-data'),
    }));

    const svc = require('../../src/services/windowsClipboardImg2FileService');
    const result = svc.startClipboardImg2FileBridge();

    expect(result.ok).toBe(true);
    expect(result.started).toBe(true);
    expect(result.pid).toBe(43210);
    expect(spawn).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-Sta', '-File']),
      expect.objectContaining({
        windowsHide: true,
        detached: false,
      })
    );

    const status = svc.getClipboardImg2FileBridgeStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(43210);

    const stopped = svc.stopClipboardImg2FileBridge();
    expect(stopped).toBe(true);
    expect(child.kill).toHaveBeenCalled();
  });
});
