'use strict';

/**
 * proxyDispatcherAgent.js — 「据激活代理/环境变量构造 undici ProxyAgent 出站派发器」
 *   共享 helper(非纯·读 process.env·委托 proxyConfigService·依赖 undici)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_proxyDispatcher()`——
 *   services/imageGenService(内部用·:309/:336)·services/videoGenService(内部用·:177/:376)。
 *
 * 语义:优先 proxyConfigService.getActiveProxy()(非 unsupported 时取 url/字符串)·
 *   否则回退 HTTPS_PROXY/HTTP_PROXY(大小写)env·无 url → undefined;有 url →
 *   `new (require('undici').ProxyAgent)(url)`。任何异常 → undefined·**绝不抛**。
 *
 * 契约:非纯(env·委托 proxyConfigService·require undici)·fail-soft。
 *   各消费方保留同名本地 `const _proxyDispatcher = require('../utils/proxyDispatcherAgent')`
 *   → 调用点逐字节不变。
 */

function proxyDispatcherAgent() {
  try {
    const pcs = require('../services/proxyConfigService');
    const active = pcs.getActiveProxy ? pcs.getActiveProxy() : null;
    const url =
      active && !active.unsupported
        ? typeof active === 'string'
          ? active
          : active.url
        : process.env.HTTPS_PROXY ||
          process.env.https_proxy ||
          process.env.HTTP_PROXY ||
          process.env.http_proxy ||
          '';
    if (!url) {
      return undefined;
    }
    const { ProxyAgent } = require('undici');
    return new ProxyAgent(String(url));
  } catch {
    return undefined;
  }
}

// ── Proxy-fail → direct fallback ────────────────────────────────────────────
// 消费方(目前 imageGenService/videoGenService)通过 ProxyAgent 走代理出站;若代理
// 本身挂掉(拒连/超时/DNS 失败),fetch 会直接抛错,导致「代理失败 → 整体失败」。
// 此处提供一个 fail-soft 包装:仅在确有其代理、且失败属于代理连接/传输层问题时,
// 自动去掉 dispatcher 重试一次直连;业务性失败(HTTP 4xx 等由 fetch resolve)原样走。

// 归因于代理连接层问题的错误码(undici ProxyAgent 失败常以 cause.code 呈现)。
const _RETRYABLE_CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'EPROTO',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET_TIMEOUT',
]);

function _firstConnectCode(err) {
  let cur = err;
  const seen = new Set();
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const code = String((cur && cur.code) || '').toUpperCase();
    if (code && _RETRYABLE_CONNECT_CODES.has(code)) {
      return code;
    }
    cur = cur && cur.cause;
  }
  return '';
}

/**
 * fetchWithProxyFallback — 走代理 fetch,代理连接失败时自动回退直连。
 *
 * @param {function} fn - (signal, dispatcher) => Promise<Response>;dispatcher 为
 *   undefined 时表示直连(调用点已按此分支拼接 fetch 参数)。
 * @param {object} [opts] - { timeoutMs, url, operation, logger } 透传给 fetchTimeout。
 * @returns {Promise<Response>}
 */
async function fetchWithProxyFallback(fn, opts = {}) {
  let dispatcher;
  try {
    dispatcher = proxyDispatcherAgent();
  } catch {
    dispatcher = undefined;
  }
  const { fetchWithTimeout } = require('../services/fetchTimeout');
  const attempt = (d) =>
    fetchWithTimeout((signal) => fn(signal, d), {
      timeoutMs: opts.timeoutMs,
      url: opts.url,
      operation: opts.operation,
      logger: opts.logger,
    });

  try {
    return await attempt(dispatcher);
  } catch (err) {
    const code = _firstConnectCode(err);
    if (!dispatcher || !code) {
      throw err;
    }
    if (opts.logger && typeof opts.logger.warn === 'function') {
      try {
        opts.logger.warn(
          `[proxyTunnel] 代理不可用，回退直连 ${opts.url || ''} (${code}): ${err && err.message}`
        );
      } catch {
        /* ignore */
      }
    }
    return attempt(undefined);
  }
}

module.exports = proxyDispatcherAgent;
module.exports.fetchWithProxyFallback = fetchWithProxyFallback;
