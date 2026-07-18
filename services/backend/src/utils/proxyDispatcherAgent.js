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
    const url = active && !active.unsupported
      ? (typeof active === 'string' ? active : active.url)
      : (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '');
    if (!url) return undefined;
    const { ProxyAgent } = require('undici');
    return new ProxyAgent(String(url));
  } catch {
    return undefined;
  }
}

module.exports = proxyDispatcherAgent;
