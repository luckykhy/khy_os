'use strict';

/**
 * mcpHttpServer — pure security-helper tests (node:test).
 *
 * The transport itself (http.createServer / sockets) is deliberately NOT
 * exercised end-to-end here — per house convention, resident-process + network
 * tests are brittle in unit tests; the request→response contract is already
 * covered by mcpServer.test.js (handleMessage). This file locks the pure
 * security decisions that MUST NOT regress: loopback detection, the "no bare
 * network exposure without a token" start guard, and bearer-only token auth.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const h = require('../../../src/services/domain/messaging/mcp/mcpHttpServer.js');

test('isLoopbackHost: 127.x / localhost / ::1 / empty → true; public → false', () => {
  assert.equal(h.isLoopbackHost('127.0.0.1'), true);
  assert.equal(h.isLoopbackHost('localhost'), true);
  assert.equal(h.isLoopbackHost('::1'), true);
  assert.equal(h.isLoopbackHost(''), true);
  assert.equal(h.isLoopbackHost('127.5.5.5'), true);
  assert.equal(h.isLoopbackHost('0.0.0.0'), false);
  assert.equal(h.isLoopbackHost('192.168.1.10'), false);
  assert.equal(h.isLoopbackHost('example.com'), false);
});

test('canStartOnHost: loopback always ok; non-loopback needs token', () => {
  assert.equal(h.canStartOnHost('127.0.0.1').ok, true);
  assert.equal(h.canStartOnHost('localhost', '').ok, true);
  // non-loopback, no token → refuse with a reason
  const refused = h.canStartOnHost('0.0.0.0', '');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /token|loopback|127\.0\.0\.1/);
  // non-loopback WITH token → ok
  assert.equal(h.canStartOnHost('0.0.0.0', 'secret').ok, true);
});

test('isAuthorized: no token configured → always allowed (loopback)', () => {
  assert.equal(h.isAuthorized({}, ''), true);
  assert.equal(h.isAuthorized({ authorization: 'Bearer whatever' }, ''), true);
});

test('isAuthorized: token configured → bearer must match', () => {
  const tok = 's3cr3t';
  assert.equal(h.isAuthorized({ authorization: 'Bearer s3cr3t' }, tok), true);
  assert.equal(h.isAuthorized({ authorization: 'Bearer wrong' }, tok), false);
  assert.equal(h.isAuthorized({}, tok), false);
  // 非 Bearer scheme 不认
  assert.equal(h.isAuthorized({ authorization: 'Basic s3cr3t' }, tok), false);
  // 前后空白的令牌不值得宽容
  assert.equal(h.isAuthorized({ authorization: 'Bearer  ' }, tok), false);
});

test('isAuthorized: 查询串令牌已移除,传了也不认(OWASP 反模式)', () => {
  const tok = 's3cr3t';
  // 回归锁:曾支持 `?token=`,2026-09-15 起移除。任何"顺手加回来"都会打破此例。
  assert.equal(h.isAuthorized({ queryToken: 's3cr3t' }, tok), false);
  assert.equal(h.isAuthorized({ queryToken: 'wrong' }, tok), false);
  // 同时带合法 header 与查询串 → header 说了算
  assert.equal(h.isAuthorized({ authorization: 'Bearer s3cr3t', queryToken: 'x' }, tok), true);
});

test('timingSafeEqualStr: 相等/不等/长度差异/非字符串 一律安全返回', () => {
  assert.equal(h.timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(h.timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(h.timingSafeEqualStr('abc', 'abcd'), false);
  assert.equal(h.timingSafeEqualStr('', ''), true);
  // 绝不抛:非字符串经 String() 归一
  assert.equal(h.timingSafeEqualStr(null, 'null'), true);
  assert.equal(h.timingSafeEqualStr(undefined, 'undefined'), true);
});

test('RESOURCE_METADATA_ENV / DEFAULT_RESOURCE_METADATA 已导出(M8 的 401 头依赖)', () => {
  assert.equal(h.RESOURCE_METADATA_ENV, 'KHY_MCP_RESOURCE_METADATA');
  assert.match(h.DEFAULT_RESOURCE_METADATA, /^\/\.well-known\//);
});

test('DEFAULT_HOST is loopback (safe default)', () => {
  assert.equal(h.DEFAULT_HOST, '127.0.0.1');
  assert.equal(h.isLoopbackHost(h.DEFAULT_HOST), true);
});

// ── Origin 校验(防 DNS rebinding)────────────────────────────────────────────
// 该 server 暴露全量工具(含 shell/文件写),loopback 绑定不构成安全边界:
// 用户浏览器里的任意网页都能 fetch 到 127.0.0.1。以下锁定拦截口径。

test('isAllowedOrigin: 无 Origin 头 → 放行(非浏览器客户端)', () => {
  assert.equal(h.isAllowedOrigin(undefined, {}), true);
  assert.equal(h.isAllowedOrigin(null, {}), true);
  assert.equal(h.isAllowedOrigin('', {}), true);
  assert.equal(h.isAllowedOrigin('   ', {}), true);
});

test('isAllowedOrigin: loopback 的 http(s) 来源 → 放行', () => {
  assert.equal(h.isAllowedOrigin('http://127.0.0.1:3737', {}), true);
  assert.equal(h.isAllowedOrigin('http://localhost:8090', {}), true);
  assert.equal(h.isAllowedOrigin('https://localhost', {}), true);
  // IPv6 字面量:URL 解析后 hostname 带方括号,必须剥掉才能命中 loopback
  assert.equal(h.isAllowedOrigin('http://[::1]:3000', {}), true);
  // 大小写不敏感
  assert.equal(h.isAllowedOrigin('HTTP://LOCALHOST:5173', {}), true);
});

test('isAllowedOrigin: 跨站来源 → 拒绝', () => {
  assert.equal(h.isAllowedOrigin('https://evil.example', {}), false);
  assert.equal(h.isAllowedOrigin('http://192.168.1.10:3737', {}), false);
  assert.equal(h.isAllowedOrigin('http://0.0.0.0:3737', {}), false);
  // `null`(沙箱 iframe / data: URL)与 file:// 是已知攻击载体,默认拒绝
  assert.equal(h.isAllowedOrigin('null', {}), false);
  assert.equal(h.isAllowedOrigin('file://', {}), false);
  // 非 http(s) scheme
  assert.equal(h.isAllowedOrigin('ftp://localhost', {}), false);
  // 畸形值不得抛,一律 false
  assert.equal(h.isAllowedOrigin('not a url', {}), false);
});

test('isAllowedOrigin: KHY_MCP_ALLOWED_ORIGINS 显式白名单', () => {
  const env = { [h.ALLOWED_ORIGINS_ENV]: 'https://ide.example, https://other.example' };
  assert.equal(h.isAllowedOrigin('https://ide.example', env), true);
  assert.equal(h.isAllowedOrigin('https://other.example', env), true);
  assert.equal(h.isAllowedOrigin('https://nope.example', env), false);
  // 白名单可显式放行默认被拒的 null
  assert.equal(h.isAllowedOrigin('null', { [h.ALLOWED_ORIGINS_ENV]: 'null' }), true);
});

test('parseAllowedOrigins: 去空白、转小写、丢弃空项', () => {
  assert.deepEqual(h.parseAllowedOrigins({}), []);
  assert.deepEqual(h.parseAllowedOrigins({ [h.ALLOWED_ORIGINS_ENV]: '' }), []);
  assert.deepEqual(h.parseAllowedOrigins({ [h.ALLOWED_ORIGINS_ENV]: ' A ,, B ' }), ['a', 'b']);
});

// ── M6:MCP-Protocol-Version 头(2025-03-26 Streamable HTTP 要求)──────────────
// initialize 之后的每个 HTTP 请求都须带该头;服务端收到不认识的版本**必须**拒绝。
const proto = require('../../../src/services/domain/messaging/mcp/mcpServerProtocol.js');

test('checkProtocolVersionHeader: 带支持版本 → 放行,非假定', () => {
  // 支持集由 mcpServerProtocol 单一真源给出,测试跟着它走而非写死版本列表,
  // 这样新增支持版本时不会误判为"应被拒"。
  for (const v of proto.SUPPORTED_PROTOCOL_VERSIONS) {
    const r = proto.checkProtocolVersionHeader(v);
    assert.equal(r.ok, true, `${v} 应被接受`);
    assert.equal(r.version, v);
    assert.equal(r.assumed, false);
  }
});

test('checkProtocolVersionHeader: 不支持的版本 → ok:false 且列出支持集', () => {
  // 取一个确定不在支持集里的版本(支持集扩展后本用例仍成立)。
  const bad = ['2025-06-18', '2099-01-01', 'garbage', '2024-11-04'].filter(
    (v) => !proto.SUPPORTED_PROTOCOL_VERSIONS.includes(v)
  );
  assert.ok(bad.length > 0, '至少要有 1 个不受支持的版本用于断言');
  for (const b of bad) {
    const v = proto.checkProtocolVersionHeader(b);
    assert.equal(v.ok, false, `${b} 应被拒`);
    assert.deepEqual(v.supported, [...proto.SUPPORTED_PROTOCOL_VERSIONS]);
    assert.match(v.reason, /unsupported protocol version/);
  }
});

test('checkProtocolVersionHeader: 缺头 → 放行但标注 assumed(兼容老客户端)', () => {
  for (const missing of [undefined, null, '', '   ']) {
    const v = proto.checkProtocolVersionHeader(missing);
    assert.equal(v.ok, true);
    assert.equal(v.assumed, true);
    assert.equal(v.version, proto.DEFAULT_ASSUMED_VERSION);
  }
});

test('PROTOCOL_VERSION_HEADER 是小写(HTTP 头名大小写不敏感,取值统一走小写键)', () => {
  assert.equal(proto.PROTOCOL_VERSION_HEADER, 'mcp-protocol-version');
  // Node 的 req.headers 键一律小写,此处必须一致,否则永远取不到值
  assert.equal(proto.PROTOCOL_VERSION_HEADER, proto.PROTOCOL_VERSION_HEADER.toLowerCase());
});

test('SUPPORTED_PROTOCOL_VERSIONS 与 PROTOCOL_VERSION 一致(不移除"只列真支持"的不变式)', () => {
  assert.ok(proto.SUPPORTED_PROTOCOL_VERSIONS.includes(proto.PROTOCOL_VERSION));
  assert.ok(Object.isFrozen(proto.SUPPORTED_PROTOCOL_VERSIONS));
});
