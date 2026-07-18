/**
 * adminService.test.js — 及时同步(admin↔user data)的惰性数据家解析。
 *
 * 病根:adminService 在 server 启动极早被 require,历史上在 require 时冻结
 *   DATA_DIR = getAppHome()。此刻 ~/.khyquant 尚未由任何用户数据生产者建立,
 *   于是 DATA_DIR 冻结到空的 ~/.khy,管理面板整进程读一个平行空库,只有重启
 *   才会收敛到用户数据。
 *
 * 修复:每次读取经 _dataDir() → getAppHome() 惰性解析。
 *   门控 KHY_APP_HOME_LIVE_RESOLVE 默认开:生产者中途建立 ~/.khyquant 后,
 *   下一次读取即收敛(无需重启)。门控关:首次访问冻结=历史行为字节回退。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

describe('adminService — lazy data-home resolution (timely admin↔user sync)', () => {
  const OLD_ENV = { ...process.env };
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-admin-'));
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    jest.resetModules();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('gate ON: reads user data established AFTER require (no restart)', () => {
    delete process.env.KHY_APP_HOME;
    delete process.env.KHY_APP_HOME_LIVE_RESOLVE; // default on
    process.env.KHY_DATA_HOME = path.join(tmpHome, '.khy'); // empty unified fallback
    const spy = jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    jest.resetModules();

    // Require admin FIRST (before any user data exists) — the historical freeze point.
    const admin = require('../../src/services/adminService');
    expect(admin.getAdminStats('khyguanli0203').stats.tokenUsage).toBeUndefined();

    // A user-data producer now writes ~/.khyquant/token_usage.json MID-PROCESS.
    const legacy = path.join(tmpHome, '.khyquant');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(
      path.join(legacy, 'token_usage.json'),
      JSON.stringify({ allTime: { totalTokens: 42, totalCost: 1.5 } })
    );

    // Admin now sees the user data without a restart.
    const stats = admin.getAdminStats('khyguanli0203').stats;
    expect(stats.tokenUsage).toEqual({ totalTokens: 42, totalCost: 1.5 });
    spy.mockRestore();
  });

  test('gate OFF: frozen on first access → user data written later is NOT seen (byte-revert)', () => {
    delete process.env.KHY_APP_HOME;
    process.env.KHY_APP_HOME_LIVE_RESOLVE = 'off';
    process.env.KHY_DATA_HOME = path.join(tmpHome, '.khy');
    const spy = jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    jest.resetModules();

    const admin = require('../../src/services/adminService');
    // First access freezes onto the empty unified fallback.
    expect(admin.getAdminStats('khyguanli0203').stats.tokenUsage).toBeUndefined();

    const legacy = path.join(tmpHome, '.khyquant');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(
      path.join(legacy, 'token_usage.json'),
      JSON.stringify({ allTime: { totalTokens: 42, totalCost: 1.5 } })
    );

    // Historical behavior: still frozen, does not converge.
    expect(admin.getAdminStats('khyguanli0203').stats.tokenUsage).toBeUndefined();
    spy.mockRestore();
  });

  test('wrong password is rejected regardless of gate', () => {
    jest.resetModules();
    const admin = require('../../src/services/adminService');
    expect(admin.verifyAdminPassword('nope')).toBe(false);
    expect(admin.getAdminStats('nope')).toEqual({ success: false, error: '密码错误' });
  });
});
