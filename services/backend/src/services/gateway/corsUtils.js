'use strict';

/**
 * corsUtils.js — 共享 CORS origin 解析逻辑，供 proxyServer / webSearchInterceptor 等模块使用。
 *
 * 优先级:
 *   1. PROXY_CORS_ORIGINS 环境变量(逗号分隔) → 精确匹配则放行
 *   2. 空值 → 仅放行 loopback(localhost / 127.0.0.1 / ::1)
 *   3. 其余一律返 'null'(浏览器拒绝跨域,服务端仍可正常响应)
 */

const _proxyCorsOrigins = String(process.env.PROXY_CORS_ORIGINS || '').trim()
  .split(',').map(s => s.trim()).filter(Boolean);

function _isLoopbackOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function resolveProxyCorsOrigin(reqOrigin) {
  if (!reqOrigin) return 'null';
  if (_proxyCorsOrigins.length > 0) return _proxyCorsOrigins.includes(reqOrigin) ? reqOrigin : 'null';
  if (_isLoopbackOrigin(reqOrigin)) return reqOrigin;
  return 'null';
}

module.exports = { resolveProxyCorsOrigin };
