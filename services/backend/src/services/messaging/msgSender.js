'use strict';

/**
 * msgSender.js — 消息发送的薄 IO 层。把纯叶子 msgChannelCore.buildSendRequest 的报文,
 * 过 SSRF 守卫后经 http(s) 发出,并把各平台的应答解读成统一的 { ok, status, error }。
 *
 * 契约:绝不抛(fail-soft,一切失败以 { ok:false, error } 返回);target 在返回里一律脱敏;
 * 不跟随重定向;有超时上限。签名所需时间戳默认取 Date.now()(真实发送需要真实当下),
 * 但可由入参 timestampMs 注入以便测试。post / assertUrl / sleep 可经 deps 注入以便单测。
 *
 * 连接稳定(retry):对瞬时故障(网络错 / 超时 / HTTP 5xx / 429)做指数退避重试,永久错
 * (非法 URL / 4xx / 业务错误码)立即返回不重试。次数 KHY_MSG_MAX_RETRIES(默认 2,夹 [0,5]),
 * 退避基数 KHY_MSG_RETRY_BASE_MS(默认 500ms,封顶 30s)。返回额外带 attempts(总尝试次数)。
 *
 * @module services/messaging/msgSender
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const core = require('./msgChannelCore');

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

// 连接稳定:对**可重试**的瞬时故障做指数退避重试,不重试永久错(见 _isRetryable)。
const DEFAULT_MAX_RETRIES = 2;        // 额外重试次数(总尝试 = 1 + retries)
const MAX_RETRIES_CAP = 5;            // 上限,防误配把 API 打爆
const DEFAULT_RETRY_BASE_MS = 500;    // 退避基数
const MAX_BACKOFF_MS = 30000;         // 单次退避上限

/** 单次请求(不跟随重定向)。resolve 成结果对象,绝不抛。 */
function _post(urlStr, { method, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(urlStr); } catch { resolve({ _err: `非法 URL:${urlStr}` }); return; }
    const lib = target.protocol === 'https:' ? https : http;
    const reqHeaders = Object.assign({}, headers || {});
    let payload = null;
    if (body != null && method !== 'GET' && method !== 'HEAD') {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    let req;
    try {
      req = lib.request(target, { method, headers: reqHeaders, timeout: timeoutMs }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size <= MAX_BODY_BYTES) chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage || '', body: Buffer.concat(chunks).toString('utf-8') }));
      });
    } catch (e) { resolve({ _err: (e && e.message) || String(e) }); return; }
    req.on('error', (err) => resolve({ _err: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ _err: `请求超时(${timeoutMs}ms)` }); });
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** 解读各平台应答:成功→{ok:true};业务错误→{ok:false,error}。HTTP 非 2xx 也算失败。 */
function interpretResponse(platform, resp) {
  if (resp && resp._err) return { ok: false, error: resp._err };
  const status = resp && resp.status;
  const rawBody = (resp && resp.body) || '';
  let json = null;
  try { json = JSON.parse(rawBody); } catch { /* 非 JSON 应答 */ }
  if (typeof status === 'number' && (status < 200 || status >= 300)) {
    return { ok: false, status, error: `HTTP ${status}${json && (json.errmsg || json.msg) ? `:${json.errmsg || json.msg}` : ''}` };
  }
  if (json) {
    // 钉钉/企业微信:errcode===0;飞书:code===0 或旧版 StatusCode===0
    const code = json.errcode != null ? json.errcode
      : json.code != null ? json.code
        : json.StatusCode != null ? json.StatusCode
          : null;
    if (code != null && code !== 0) {
      return { ok: false, status, error: `${platform} 返回错误 ${code}:${json.errmsg || json.msg || 'unknown'}` };
    }
  }
  return { ok: true, status: status == null ? 200 : status };
}

/**
 * 判定一次失败是否**可重试**(瞬时故障)。
 * 可重试:传输层网络错 / 超时、HTTP 429(限流)、HTTP 5xx(服务端瞬时)。
 * 不可重试(永久错,重试只会白打 API):非法 URL、HTTP 4xx(鉴权/请求错)、
 *   业务错误码(2xx 但 errcode≠0,如签名不匹配 / 内容非法 / token 失效)。
 * @param {object} resp - _post 的原始应答(可能含 _err)
 * @param {{ok:boolean, status?:number}} verdict - interpretResponse 结果
 * @returns {boolean}
 */
function _isRetryable(resp, verdict) {
  if (resp && resp._err) {
    // 传输层:网络错 / 超时属瞬时可重试;非法 URL 是永久错。
    return !/非法 URL/.test(String(resp._err));
  }
  const status = verdict && verdict.status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false; // 4xx / 2xx-业务错 → 永久错
  }
  return false;
}

/** 第 attempt 次重试(从 1 起)的退避毫秒:base·2^(attempt-1),封顶 MAX_BACKOFF_MS。 */
function _backoffMs(attempt, baseMs) {
  const b = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : DEFAULT_RETRY_BASE_MS;
  const raw = b * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(raw, MAX_BACKOFF_MS);
}

/** 解析额外重试次数:input.maxRetries > env KHY_MSG_MAX_RETRIES > 默认;夹到 [0, cap]。 */
function _resolveMaxRetries(env, input) {
  let n = DEFAULT_MAX_RETRIES;
  const envRaw = env && env.KHY_MSG_MAX_RETRIES;
  if (envRaw != null && String(envRaw).trim() !== '' && Number.isFinite(Number(envRaw))) n = Number(envRaw);
  if (Number.isFinite(input && input.maxRetries)) n = input.maxRetries;
  n = Math.floor(n);
  if (!Number.isFinite(n) || n < 0) n = 0;
  return Math.min(n, MAX_RETRIES_CAP);
}

/**
 * 发送一条文本消息。
 * @param {{platform, webhook, secret?, text, timestampMs?, timeoutMs?, env?}} input
 * @param {{post?:Function, assertUrl?:Function}} [deps]
 * @returns {Promise<{ok:boolean, platform?:string, status?:number, target?:string, error?:string}>}
 */
async function sendText(input = {}, deps = {}) {
  const env = input.env || process.env;
  if (!core.isEnabled(env)) return { ok: false, error: 'KHY_MSG 已关闭,消息发送被禁用。' };

  const tsMs = Number.isFinite(input.timestampMs) ? input.timestampMs : Date.now();
  const built = core.buildSendRequest({
    platform: input.platform,
    webhook: input.webhook,
    secret: input.secret,
    text: input.text,
    timestampMs: tsMs,
  });
  if (!built.ok) return built;

  const target = core.maskWebhook(input.webhook);
  const assertUrl = deps.assertUrl || (async (u) => {
    const { assertPublicHttpUrlResolved } = require('../urlSafety');
    return assertPublicHttpUrlResolved(u, '消息 webhook');
  });
  try {
    await assertUrl(built.request.url);
  } catch (e) {
    return { ok: false, platform: built.platform, target, error: `目标地址被安全守卫拒绝:${(e && e.message) || String(e)}` };
  }

  const post = deps.post || _post;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
  const baseMs = Number.isFinite(input.retryBaseMs) ? input.retryBaseMs
    : (env && Number.isFinite(Number(env.KHY_MSG_RETRY_BASE_MS)) && String(env.KHY_MSG_RETRY_BASE_MS).trim() !== ''
      ? Number(env.KHY_MSG_RETRY_BASE_MS) : DEFAULT_RETRY_BASE_MS);
  const maxRetries = _resolveMaxRetries(env, input);

  // 连接稳定:瞬时故障指数退避重试;永久错立即返回,不白打 API。全程 fail-soft。
  let attempt = 0;
  let verdict;
  for (;;) {
    const resp = await post(built.request.url, {
      method: built.request.method,
      headers: built.request.headers,
      body: built.request.body,
      timeoutMs,
    });
    verdict = interpretResponse(built.platform, resp);
    if (verdict.ok || attempt >= maxRetries || !_isRetryable(resp, verdict)) break;
    attempt += 1;
    await sleep(_backoffMs(attempt, baseMs));
  }
  return { platform: built.platform, target, attempts: attempt + 1, ...verdict };
}

module.exports = {
  sendText,
  interpretResponse,
  _post,
  _isRetryable,
  _backoffMs,
  _resolveMaxRetries,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_MS,
};
