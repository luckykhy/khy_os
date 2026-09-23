'use strict';

/**
 * proxyServer.authTokens.test.js — locks the proxy auth-token API surface of
 * src/services/gateway/proxyServer.js:
 *   - resolvePrimaryAuthToken source precedence (env > persisted > generated)
 *   - normalizeAuthToken canonical form (khy- prefix) + maskToken 3-state masking
 *   - managed-token CRUD lifecycle (create/enable/rotate/delete) and
 *     normalizeManagedTokens invariants (drop empty tokens, enabled gating
 *     on tokenCount, list view never leaks the plaintext token)
 *   - getAuthStatus token bookkeeping (primary + PROXY_AUTH_TOKENS + managed)
 *
 * No server is started. Each test re-requires proxyServer after pointing BOTH
 * the unified data home (KHY_DATA_HOME) and the legacy home (os.homedir
 * spied → tempHome, so the ~/.khyquant fallback auth file stays hermetic) at
 * throwaway dirs, then wipes both auth files for a known initial state.
 * If the token-normalization/masking/CRUD contract drifts, this suite goes red.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('proxyServer auth token API', () => {
  const originalEnv = { ...process.env };
  let tempHome = null;
  let homedirSpy = null;
  let proxy = null;
  let authFile = null;
  let legacyAuthFile = null;

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-auth-'));
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    process.env.HOME = tempHome;
    process.env.KHY_DATA_HOME = path.join(tempHome, '.khy');
    delete process.env.PROXY_AUTH_TOKEN;
    delete process.env.PROXY_AUTH_TOKENS;

    authFile = path.join(process.env.KHY_DATA_HOME, 'proxy_server_auth.json');
    legacyAuthFile = path.join(tempHome, '.khyquant', 'proxy_server_auth.json');
    for (const p of [authFile, legacyAuthFile]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }

    proxy = require('../../src/services/gateway/proxyServer');
  });

  afterEach(() => {
    if (homedirSpy) {
      homedirSpy.mockRestore();
      homedirSpy = null;
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    proxy = null;
    tempHome = null;
  });

  test('env PROXY_AUTH_TOKEN 优先于持久化/生成（source=env, 非生成）', () => {
    process.env.PROXY_AUTH_TOKEN = 'khy-from-env';
    const status = proxy.getAuthStatus();
    expect(status.source).toBe('env');
    expect(status.generated).toBe(false);
    expect(status.authToken).toBe('khy-from-env');
  });

  test('无 env 时生成 khy- 令牌并落盘（source=generated → 二次读取为 persisted）', () => {
    const status = proxy.getAuthStatus();
    expect(status.generated).toBe(true);
    expect(status.source).toBe('generated');
    expect(status.authToken).toMatch(/^khy-/);
    // 生成即持久化：同一进程内第二次解析不再走 generated
    const second = proxy.getAuthStatus();
    expect(second.source).toBe('persisted');
    expect(second.authToken).toBe(status.authToken);
  });

  test('setAuthToken 归一化为 khy- 前缀且脱敏展示（len>10 → 前6***后4）', () => {
    const out = proxy.setAuthToken('test-token');
    expect(out.authToken).toBe('khy-test-token');
    expect(out.authTokenMasked).toBe('khy-te***oken');
  });

  test('setAuthToken 空串 → 抛「token 不能为空」', () => {
    expect(() => proxy.setAuthToken('')).toThrow('token 不能为空');
  });

  test('rotateAuthToken 生成新令牌且与旧值不同', () => {
    const a = proxy.rotateAuthToken();
    const b = proxy.rotateAuthToken();
    expect(a.authToken).toMatch(/^khy-/);
    expect(b.authToken).toMatch(/^khy-/);
    expect(b.authToken).not.toBe(a.authToken);
  });

  test('managed token 生命周期：create → 列表 → disable → rotate → delete', () => {
    const created = proxy.createManagedToken({ label: 'cli-1' });
    expect(created.id).toMatch(/^tk_/);
    expect(created.label).toBe('cli-1');
    expect(created.token).toMatch(/^khy-/);

    // 列表视图只给脱敏 token（绝不回显明文）
    expect(proxy.listManagedTokens()).toHaveLength(1);
    const view = proxy.listManagedTokens()[0];
    expect(view.tokenMasked).toContain('***');
    expect(view.tokenMasked).not.toBe(created.token);
    expect(view).not.toHaveProperty('token');

    const off = proxy.setManagedTokenEnabled(created.id, false);
    expect(off.enabled).toBe(false);

    const rotated = proxy.rotateManagedToken(created.id);
    expect(rotated.token).not.toBe(created.token);
    expect(rotated.token).toMatch(/^khy-/);

    const removed = proxy.deleteManagedToken(created.id);
    expect(removed.id).toBe(created.id);
    expect(proxy.listManagedTokens()).toHaveLength(0);

    expect(() => proxy.deleteManagedToken(created.id)).toThrow('未找到 token');
    expect(() => proxy.setManagedTokenEnabled('', true)).toThrow('token id 不能为空');
  });

  test('createManagedToken 指定 token 时归一化，缺省时自动生成', () => {
    const withToken = proxy.createManagedToken({ token: 'raw-1', label: 'a' });
    expect(withToken.token).toBe('khy-raw-1');
    const auto = proxy.createManagedToken({ label: 'b' });
    expect(auto.token).toMatch(/^khy-/);
  });

  test('getAuthStatus 计数：主 + managed，禁用条目同时减 enabled 与总数', () => {
    const c1 = proxy.createManagedToken({ label: 'one' });
    proxy.createManagedToken({ label: 'two' });
    // 计数口径 = 主令牌 1 + 生效 managed 2
    const status = proxy.getAuthStatus();
    expect(status.managedTokenCount).toBe(2);
    expect(status.managedTokenEnabledCount).toBe(2);
    expect(status.tokenCount).toBe(3);

    proxy.setManagedTokenEnabled(c1.id, false);
    const status2 = proxy.getAuthStatus();
    expect(status2.managedTokenEnabledCount).toBe(1);
    expect(status2.tokenCount).toBe(2);
  });

  test('PROXY_AUTH_TOKENS 逗号列表并入鉴权集合（归一化 + 空项过滤）', () => {
    process.env.PROXY_AUTH_TOKENS = ' khy-a , khy-b ,, ';
    const status = proxy.getAuthStatus();
    // 主（生成）1 + env 列表 2（空项被 parseList 过滤）
    expect(status.tokenCount).toBe(3);
  });
});
