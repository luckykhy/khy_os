'use strict';

/**
 * originGuard — 本地控制面守卫的纯逻辑测试(node:test)。
 *
 * 覆盖 /api/daemon/* 这类「公开但不应对外」的端点所依赖的两道防线:
 *   requireLoopback — 挡局域网与远程调用方
 *   originGuard     — 挡浏览器跨站调用(恶意网页)
 *
 * 背景:loopback 绑定不是安全边界 —— 用户浏览器里的任意网页都能 fetch 到
 * 127.0.0.1。所以这里锁定的是「哪些来源必须被拒」,而不是「服务能不能起来」。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const g = require('../../src/middleware/originGuard.js');

// ── isLoopbackAddress ───────────────────────────────────────────────────────

test('isLoopbackAddress: 回环地址 → true', () => {
  assert.equal(g.isLoopbackAddress('127.0.0.1'), true);
  assert.equal(g.isLoopbackAddress('127.5.5.5'), true);
  assert.equal(g.isLoopbackAddress('::1'), true);
  assert.equal(g.isLoopbackAddress('::ffff:127.0.0.1'), true); // IPv4-mapped
  assert.equal(g.isLoopbackAddress('localhost'), true);
  assert.equal(g.isLoopbackAddress(' 127.0.0.1 '), true);
});

test('isLoopbackAddress: 非回环或空值 → false', () => {
  assert.equal(g.isLoopbackAddress('192.168.1.10'), false);
  assert.equal(g.isLoopbackAddress('10.0.0.1'), false);
  assert.equal(g.isLoopbackAddress('::ffff:192.168.1.10'), false);
  assert.equal(g.isLoopbackAddress(''), false);
  assert.equal(g.isLoopbackAddress(null), false);
  assert.equal(g.isLoopbackAddress(undefined), false);
});

// ── isTrustedBrowserOrigin ──────────────────────────────────────────────────

test('isTrustedBrowserOrigin: 无 Origin → 放行(非浏览器客户端)', () => {
  assert.equal(g.isTrustedBrowserOrigin(undefined, {}), true);
  assert.equal(g.isTrustedBrowserOrigin(null, {}), true);
  assert.equal(g.isTrustedBrowserOrigin('', {}), true);
});

test('isTrustedBrowserOrigin: Electron 的 null / file:// → 放行', () => {
  // Electron 生产构建用 loadFile() 加载渲染进程,其 fetch 的 Origin 即 `null`。
  // 这里若拒绝会直接打断桌面端 —— 该残余风险由 requireLoopback 兜底。
  assert.equal(g.isTrustedBrowserOrigin('null', {}), true);
  assert.equal(g.isTrustedBrowserOrigin('file://', {}), true);
});

test('isTrustedBrowserOrigin: loopback 的 http(s) → 放行', () => {
  assert.equal(g.isTrustedBrowserOrigin('http://localhost:5173', {}), true);
  assert.equal(g.isTrustedBrowserOrigin('http://127.0.0.1:8090', {}), true);
  // IPv6 字面量:URL 解析后 hostname 带方括号,必须剥掉才能命中
  assert.equal(g.isTrustedBrowserOrigin('http://[::1]:3000', {}), true);
  assert.equal(g.isTrustedBrowserOrigin('HTTP://LOCALHOST', {}), true);
});

test('isTrustedBrowserOrigin: 跨站来源 → 拒绝', () => {
  assert.equal(g.isTrustedBrowserOrigin('https://evil.example', {}), false);
  assert.equal(g.isTrustedBrowserOrigin('http://192.168.1.10:8090', {}), false);
  assert.equal(g.isTrustedBrowserOrigin('ftp://localhost', {}), false);
  assert.equal(g.isTrustedBrowserOrigin('garbage', {}), false);
});

test('isTrustedBrowserOrigin: KHY_ALLOWED_ORIGINS 显式白名单', () => {
  const env = { [g.ALLOWED_ORIGINS_ENV]: 'https://ide.example, https://app.example' };
  assert.equal(g.isTrustedBrowserOrigin('https://ide.example', env), true);
  assert.equal(g.isTrustedBrowserOrigin('https://app.example', env), true);
  assert.equal(g.isTrustedBrowserOrigin('https://nope.example', env), false);
});

// ── 中间件行为 ──────────────────────────────────────────────────────────────

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  return res;
}

test('requireLoopback: 本机放行,非本机 403', () => {
  const res = mockRes();
  let called = false;
  g.requireLoopback({ socket: { remoteAddress: '127.0.0.1' } }, res, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(res.statusCode, null);

  const res2 = mockRes();
  let called2 = false;
  g.requireLoopback({ socket: { remoteAddress: '192.168.1.10' } }, res2, () => {
    called2 = true;
  });
  assert.equal(called2, false);
  assert.equal(res2.statusCode, 403);
});

test('requireLoopback: 缺 socket 的请求不得抛,按非本机处理', () => {
  const res = mockRes();
  let called = false;
  g.requireLoopback({}, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('originGuard: 跨站 Origin → 403;无 Origin → 放行', () => {
  const res = mockRes();
  let called = false;
  g.originGuard({ headers: { origin: 'https://evil.example' } }, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);

  const res2 = mockRes();
  let called2 = false;
  g.originGuard({ headers: {} }, res2, () => {
    called2 = true;
  });
  assert.equal(called2, true);
  assert.equal(res2.statusCode, null);
});

test('parseAllowedOrigins: 去空白、转小写、丢弃空项', () => {
  assert.deepEqual(g.parseAllowedOrigins({}), []);
  assert.deepEqual(g.parseAllowedOrigins({ [g.ALLOWED_ORIGINS_ENV]: '' }), []);
  assert.deepEqual(g.parseAllowedOrigins({ [g.ALLOWED_ORIGINS_ENV]: ' A ,, B ' }), ['a', 'b']);
});
