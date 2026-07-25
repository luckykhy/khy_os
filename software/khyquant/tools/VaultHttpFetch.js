'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const { defineTool } = require('./_baseTool');

/**
 * VaultHttpFetch — 用保险库里的密钥发 HTTP 请求,**密钥值绝不进入模型上下文**。
 * 对齐 Claude Code 的密钥保险库工作流:模型用占位符 `{{vault:NAME}}` 引用密钥(出现在 url /
 * headers / body 任意处),工具在**服务端**把占位符换成真值再发请求;返回给模型前再把任何
 * 意外回显的密钥值 redact 成 [REDACTED]。模型从头到尾只见占位符,看不到明文。
 *
 * 与通用 httpRequest 的关键差异(为何不复用其网络栈):本工具携带密钥,安全策略不同 ——
 *   1) 每一跳都过 SSRF 守卫(assertPublicHttpUrlResolved,含 DNS 解析防 rebinding);
 *   2) **绝不自动跟随**带密钥的重定向(把 3xx Location 交回模型决策,避免把 token 发去别处);
 *   3) 响应/错误文本一律 redact 掉密钥值。
 * 占位符替换 / 抽取 / 脱敏全部委派纯叶子 vaultCore(单一真源);密钥读盘委派 vaultStore。
 */

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];

/** 单次请求(不跟随重定向);resolve 成结果对象。 */
function _once(urlStr, { method, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(urlStr);
    } catch {
      resolve({ _err: { code: 'BAD_PARAM', message: `非法 URL：${urlStr}` } });
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const reqHeaders = Object.assign({}, headers || {});
    let payload = null;
    if (body != null && method !== 'GET' && method !== 'HEAD') {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!Object.keys(reqHeaders).some((h) => h.toLowerCase() === 'content-type')) {
        reqHeaders['Content-Type'] = typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    let req;
    try {
      req = lib.request(target, { method, headers: reqHeaders, timeout: timeoutMs }, (res) => {
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c) => {
          size += c.length;
          if (size <= MAX_BODY_BYTES) chunks.push(c);
          else if (!truncated) {
            truncated = true;
            const room = MAX_BODY_BYTES - (size - c.length);
            if (room > 0) chunks.push(c.slice(0, room));
          }
        });
        res.on('end', () => resolve({
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
          truncated,
          location: res.headers && res.headers.location,
        }));
      });
    } catch (e) {
      resolve({ _err: { code: 'SERVICE_UNAVAILABLE', message: (e && e.message) || String(e) } });
      return;
    }
    req.on('error', (err) => resolve({ _err: { code: 'SERVICE_UNAVAILABLE', message: err.message } }));
    req.on('timeout', () => { req.destroy(); resolve({ _err: { code: 'TIMEOUT', message: `请求超时（${timeoutMs}ms）` } }); });
    if (payload != null) req.write(payload);
    req.end();
  });
}

module.exports = defineTool({
  name: 'VaultHttpFetch',
  description:
    'Make an HTTP/HTTPS request that uses secrets from the local vault WITHOUT the secret values ever '
    + 'entering your context. Reference a secret anywhere in url/headers/body with the placeholder '
    + '{{vault:NAME}}; the value is injected server-side and any echo is redacted from the response. '
    + 'Manage secrets with `khy vault set/list/rm`. Does NOT auto-follow redirects (returns 3xx for you to decide).',
  category: 'data',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: true,
  aliases: ['vault_fetch', 'vaultHttpFetch', 'vault_http_fetch'],
  searchHint: 'vault secret token api http request authorization bearer credential fetch {{vault:NAME}}',
  inputSchema: {
    url: { type: 'string', required: true, description: 'Absolute http(s) URL. May contain {{vault:NAME}} placeholders.' },
    method: { type: 'string', required: false, enum: ALLOWED_METHODS, default: 'GET', description: 'HTTP method (default GET).' },
    headers: { type: 'object', required: false, description: 'Headers as {name:value}. Values may contain {{vault:NAME}} (e.g. Authorization: "Bearer {{vault:GITHUB_PAT}}").' },
    body: { type: 'string', required: false, description: 'Optional request body; may contain {{vault:NAME}} placeholders.' },
    timeout: { type: 'number', required: false, min: 1, max: 120000, description: `Per-attempt timeout in ms (default ${DEFAULT_TIMEOUT_MS}).` },
  },

  async validateInput(input) {
    if (!input || !input.url || !String(input.url).trim()) return { valid: false, message: 'url is required.' };
    return { valid: true };
  },

  getActivityDescription(input) {
    const m = (input && input.method) || 'GET';
    const u = input && input.url ? String(input.url) : '';
    return `Vault HTTP ${m} ${u.length > 60 ? `${u.slice(0, 60)}…` : u}`;
  },

  async execute(params, _context) {
    const core = require('../services/vaultCore');
    if (!core.isEnabled()) {
      return { success: false, error: 'Vault is disabled (KHY_VAULT=off).' };
    }
    const store = require('../services/vaultStore');
    const { assertPublicHttpUrlResolved } = require('../services/urlSafety');

    const method = String((params && params.method) || 'GET').toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) {
      return { success: false, error: `不支持的方法：${method}（允许:${ALLOWED_METHODS.join('/')}）` };
    }
    const timeoutMs = Number.isFinite(params && params.timeout) ? params.timeout : DEFAULT_TIMEOUT_MS;
    const rawUrl = String((params && params.url) || '');
    const rawHeaders = (params && params.headers && typeof params.headers === 'object') ? params.headers : {};
    const rawBody = params && typeof params.body === 'string' ? params.body : undefined;

    // 1) 收集被引用的密钥名 → 从保险库取明文(仅服务端用)。
    const refs = core.collectSecretRefs({ url: rawUrl, headers: rawHeaders, body: rawBody });
    const { found, missing } = store.getSecrets(refs);
    if (missing.length > 0) {
      return { success: false, error: core.buildMissingSecretError(missing) };
    }
    const secretValues = Object.values(found);

    // 2) 服务端注入(替换占位符)。这些值绝不回灌给模型。
    const url = core.substituteSecrets(rawUrl, found);
    const headers = core.substituteHeaders(rawHeaders, found);
    const body = rawBody === undefined ? undefined : core.substituteSecrets(rawBody, found);

    // 3) SSRF 守卫(协议 + 私网 + DNS 解析防 rebinding)。失败即拒发(密钥不外泄)。
    try {
      await assertPublicHttpUrlResolved(url, '目标 URL');
    } catch (e) {
      return { success: false, error: `目标 URL 未通过安全校验:${core.redactSecrets((e && e.message) || String(e), secretValues)}` };
    }

    // 4) 发请求(不自动跟随重定向 —— 带密钥不该静默转发到别处)。
    const res = await _once(url, { method, headers, body, timeoutMs });

    // 5) 一律对返回内容 redact 掉任何密钥值(防服务端回显)。模型只见占位符,绝不见明文。
    const redact = (t) => core.redactSecrets(t, secretValues);
    const safeMeta = { method, redirectFollowed: false };

    if (res._err) {
      return { success: false, code: res._err.code, error: redact(res._err.message), content: redact(res._err.message), meta: safeMeta };
    }

    const isRedirect = res.status >= 300 && res.status < 400 && res.location;
    if (isRedirect) {
      const loc = redact(String(res.location || ''));
      return {
        success: true,
        status: res.status,
        statusText: res.statusText,
        redirect: true,
        location: loc,
        content: `HTTP ${res.status} 重定向到:${loc}\n(出于安全,携带密钥的请求不会自动跟随重定向。如确需跟随,请用新 URL 再次调用。)`,
        meta: safeMeta,
      };
    }

    const ok = res.status >= 200 && res.status < 400;
    const bodyText = redact(res.body || '');
    if (!ok) {
      const transient = res.status >= 500 || res.status === 408 || res.status === 429;
      const error = `HTTP ${res.status} ${res.statusText}`.trim();
      return {
        success: false,
        code: transient ? 'SERVICE_UNAVAILABLE' : 'UPSTREAM_ERROR',
        error,
        content: bodyText || error,
        status: res.status,
        body: bodyText,
        meta: Object.assign({ truncated: res.truncated }, safeMeta),
      };
    }

    return {
      success: true,
      status: res.status,
      statusText: res.statusText,
      body: bodyText,
      content: bodyText || `HTTP ${res.status} ${res.statusText}`.trim(),
      meta: Object.assign({ truncated: res.truncated, secretsUsed: refs.length }, safeMeta),
    };
  },
});
