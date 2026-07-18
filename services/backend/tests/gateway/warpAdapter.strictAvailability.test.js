'use strict';

/**
 * Warp adapter strict-availability tests.
 *
 * Warp is the adapter the user explicitly called out: it previously reported
 * "可用" whenever a clipboard tool (xclip/pbcopy) was present, even with no Warp
 * install and no login. The rewrite makes availability require a genuine local
 * Warp install + login; the clipboard relay is transport only.
 */

describe('warp adapter strict availability', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  function loadWarp({ login, clipboardReady = true }) {
    jest.resetModules();

    jest.doMock('../../src/services/accountPool', () => ({
      detectWarpLocalLogin: jest.fn(() => login),
    }));

    jest.doMock('../../src/services/gateway/adapters/clipboardRelayAdapter', () => ({
      detect: jest.fn(() => clipboardReady),
      generate: jest.fn(async () => ({ success: true, content: 'ok' })),
    }));

    return require('../../src/services/gateway/adapters/warpAdapter');
  }

  test('not available when Warp is not installed, even if a clipboard tool exists', () => {
    const warp = loadWarp({
      login: { installed: false, hasLogin: false, email: null },
      clipboardReady: true,
    });
    const status = warp.getStatus();
    expect(status.available).toBe(false);
    expect(status.detail).toContain('未检测到 Warp 安装');
  });

  test('not available when Warp is installed but not logged in', () => {
    const warp = loadWarp({
      login: { installed: true, hasLogin: false, email: null },
      clipboardReady: true,
    });
    const status = warp.getStatus();
    expect(status.available).toBe(false);
    expect(status.detail).toContain('未检测到登录态');
  });

  test('available only when Warp is installed AND logged in', () => {
    const warp = loadWarp({
      login: { installed: true, hasLogin: true, email: 'user@example.com' },
      clipboardReady: true,
    });
    const status = warp.getStatus();
    expect(status.available).toBe(true);
    expect(status.detail).toContain('已登录');
    expect(status.transport).toBe('clipboard-relay');
  });

  test('logged in but clipboard relay unavailable reports the transport gap, still available', () => {
    const warp = loadWarp({
      login: { installed: true, hasLogin: true, email: 'user@example.com' },
      clipboardReady: false,
    });
    const status = warp.getStatus();
    expect(status.available).toBe(true);
    expect(status.clipboardReady).toBe(false);
    expect(status.detail).toContain('剪贴板中继不可用');
  });

  test('getStatus recomputes fresh — a stale "available" cannot survive a logout', () => {
    // First load: installed + logged in -> available true (warms the cache).
    jest.resetModules();
    const login = { installed: true, hasLogin: true, email: 'user@example.com' };
    const poolMock = { detectWarpLocalLogin: jest.fn(() => login) };
    jest.doMock('../../src/services/accountPool', () => poolMock);
    jest.doMock('../../src/services/gateway/adapters/clipboardRelayAdapter', () => ({
      detect: jest.fn(() => true),
      generate: jest.fn(async () => ({ success: true, content: 'ok' })),
    }));
    const warp = require('../../src/services/gateway/adapters/warpAdapter');

    expect(warp.getStatus().available).toBe(true);

    // Simulate a logout: subsequent probes report no login.
    poolMock.detectWarpLocalLogin.mockReturnValue({ installed: true, hasLogin: false, email: null });

    // getStatus must recompute (detect(true)) and demote, not return the stale cache.
    expect(warp.getStatus().available).toBe(false);
  });
});
