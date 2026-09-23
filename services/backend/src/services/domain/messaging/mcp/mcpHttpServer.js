'use strict';

/**
 * mcpHttpServer.js — 薄 IO:HTTP(Streamable HTTP)+ 传统 SSE 传输的 khy MCP server。
 *
 * 对齐 client 侧消费的两种远程形态(services/mcp/index.js `_connectHttp` Streamable HTTP 2025 +
 * `_connectSse` 传统 SSE 2024-11-05),方向反过来做 server:
 *   - Streamable HTTP:`POST /`(或 `/mcp`)body=JSON-RPC → 引擎 → JSON 回包。
 *   - 传统 SSE:`GET /sse` 开 text/event-stream,先发 `endpoint` 事件告知 POST 回信地址;
 *     `POST /messages?sessionId=…` → 引擎 → 经该会话 SSE 流推回包。
 *
 * 安全默认(全量工具含 shell,绝不裸奔上网):host 缺省 127.0.0.1;非 loopback 绑定**强制**要 token,
 * 否则拒绝启动并在 stderr 明示。有 token → **只认** `Authorization: Bearer <token>`。
 * 会话表内存持有(重启清零,诚实)。横幅打 stderr。
 *
 * 纯安全判定(canStartOnHost / isAuthorized / isLoopbackHost)导出为纯函数,便于单测而无需起 socket。
 *
 * 令牌传递:仅 header。`?token=` 查询串方式已于 2026-09-15 **移除** —— 查询串会进入服务器访问
 * 日志、浏览器历史、Referer 头与中间代理日志,OWASP 明确列为凭据传递反模式。移除理由与迁移
 * 影响见 `_产物/规范合规审计报告-2026-09-15.md` 的 M8 条目。
 */

const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

const { createServerCore } = require('./mcpServer');
const protocol = require('./mcpServerProtocol');
const policy = require('./mcpServeToolPolicy');

const PROTOCOL_VERSION_HEADER = protocol.PROTOCOL_VERSION_HEADER;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3737;

// ── 纯安全判定(零 IO,可单测)────────────────────────────────────────────────
/**
 * host 是否 loopback(仅这些无需 token 即可绑定)。
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  const h = String(host == null ? '' : host)
    .trim()
    .toLowerCase();
  return (
    h === '' ||
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '::1' ||
    h === '0:0:0:0:0:0:0:1' ||
    h.startsWith('127.')
  );
}

/**
 * 是否允许在该 host 上启动。非 loopback 且无 token → 拒绝(返回带原因的对象)。
 * @param {string} host
 * @param {string} [token]
 * @returns {{ ok: boolean, reason?: string }}
 */
function canStartOnHost(host, token) {
  if (isLoopbackHost(host)) {
    return { ok: true };
  }
  if (token && String(token).length > 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `拒绝在非 loopback 地址 ${host} 上无 token 启动:khy 暴露全量工具(含 shell/文件写),` +
      `绝不裸奔上网。请加 --token <令牌> 或绑定到 127.0.0.1。`,
  };
}

/**
 * 校验一个请求是否授权。无 token 配置(仅 loopback)→ 一律放行;有 token → 需匹配
 * `Authorization: Bearer <token>`。绝不抛。
 *
 * **只认 header**:查询串传令牌是 OWASP 反模式(见文件头注释),不接受 `req.queryToken`。
 * 保留该字段仅为向后兼容的调用点签名,其值一律被忽略。
 * @param {{ authorization?: string }} req
 * @param {string} [token]
 * @returns {boolean}
 */
function isAuthorized(req, token) {
  if (!token || String(token).length === 0) {
    return true;
  } // 仅 loopback,无 token 门
  const r = req && typeof req === 'object' ? req : {};
  const auth = String(r.authorization == null ? '' : r.authorization);
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return Boolean(bearer) && timingSafeEqualStr(bearer, String(token));
}

/**
 * 定长比较,避免 `===` 的短路泄露令牌前缀长度信息。绝不抛。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualStr(a, b) {
  try {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) {
      return false;
    }
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

// ── 纯安全判定:Origin 校验(防 DNS rebinding)────────────────────────────────
// MCP Streamable HTTP 规范要求服务端校验 Origin 头,以防浏览器被诱导跨站访问本机
// server。这对本 server 尤其关键:它暴露全量工具(含 shell/文件写),而**loopback 绑定
// 并不构成安全边界** —— 用户访问的任意网页都能 fetch 到 127.0.0.1。
//
// 判定口径(纯函数,零 IO,可单测):
//   - 无 Origin 头 → 放行。MCP SDK / CLI / curl 等非浏览器客户端不带该头,
//     不构成 CSRF 载体。
//   - 显式白名单命中(KHY_MCP_ALLOWED_ORIGINS,逗号分隔)→ 放行。
//   - http(s):// 且 host 为 loopback → 放行(本机前端页面)。
//   - 其余(含任意公网来源、非 http(s) scheme)→ 拒绝。
//
// 注意 `null` 与 `file://` 默认**拒绝**:它们是沙箱 iframe / data: URL 的已知
// 攻击载体。需要放行时走显式白名单,不做隐式宽容。

const ALLOWED_ORIGINS_ENV = 'KHY_MCP_ALLOWED_ORIGINS';

// 401 的 `resource_metadata` 指向。RFC 9728 Protected Resource Metadata 端点,
// 客户端从它发现授权服务器。可经 env 覆盖以适配自托管部署(仓库纪律:零硬编码端点)。
const RESOURCE_METADATA_ENV = 'KHY_MCP_RESOURCE_METADATA';
const DEFAULT_RESOURCE_METADATA = '/.well-known/oauth-protected-resource';

/**
 * 解析显式 Origin 白名单(逗号分隔,大小写不敏感)。绝不抛。
 * @param {object} [env]
 * @returns {string[]}
 */
function parseAllowedOrigins(env = process.env) {
  const raw = String((env && env[ALLOWED_ORIGINS_ENV]) || '');
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 该 Origin 是否允许访问。绝不抛(畸形值 → false)。
 * @param {string|undefined|null} origin
 * @param {object} [env]
 * @returns {boolean}
 */
function isAllowedOrigin(origin, env = process.env) {
  // 无 Origin:非浏览器客户端(SDK/CLI/curl)不带该头 → 不是跨站载体。
  if (origin === undefined || origin === null || String(origin).trim() === '') {
    return true;
  }
  const o = String(origin).trim().toLowerCase();
  if (parseAllowedOrigins(env).includes(o)) {
    return true;
  }
  if (o === 'null' || o === 'file://') {
    return false;
  }
  try {
    const u = new URL(o);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return false;
    }
    // IPv6 字面量经 URL 解析后带方括号(`[::1]`),剥掉再交给 isLoopbackHost,
    // 否则 `http://[::1]:3000` 会被误判为非 loopback。
    const hostname = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
    return isLoopbackHost(hostname);
  } catch {
    return false;
  }
}

// ── HTTP server(薄 IO)───────────────────────────────────────────────────────
/**
 * 启动 HTTP + SSE server。
 * @param {object} [opts]
 * @param {string} [opts.version]
 * @param {object} [opts.env]
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.token]
 * @param {NodeJS.WritableStream} [opts.errOutput]
 * @returns {{ ok: boolean, reason?: string, server?: http.Server, close?: Function }}
 */
let _mcpServerInstance = null;

function startHttpServer(opts = {}) {
  const env = opts.env || process.env;
  const host = opts.host || DEFAULT_HOST;
  const port = Number(opts.port) || DEFAULT_PORT;
  const token = opts.token || '';
  const errOutput = opts.errOutput || process.stderr;

  const guard = canStartOnHost(host, token);
  if (!guard.ok) {
    try {
      errOutput.write(`khy MCP server (http): ${guard.reason}\n`);
    } catch {
      /* ignore */
    }
    return { ok: false, reason: guard.reason };
  }

  const core = createServerCore({ version: opts.version, env, context: opts.context });

  // 内存会话表:sessionId → SSE response stream(用于传统 SSE 回信)。
  const sseSessions = new Map();
  // Streamable HTTP 的会话记账:`khy-N` → { createdAt }。与 sseSessions 分开 ——
  // 前者是"可写回流",后者只是"这个 id 是我签发的"。两者生命周期不同(SSE 随连接走,
  // Streamable 靠 DELETE 或进程退出),混在一张表里会让 DELETE 误关别人的流。
  const streamSessions = new Map();
  let sessionSeq = 0;

  function authFromReq(req) {
    return isAuthorized({ authorization: req.headers['authorization'] }, token);
  }

  function writeJson(res, status, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    res.writeHead(
      status,
      Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {})
    );
    res.end(body);
  }

  /**
   * 401 响应头。RFC 6750 §3 / MCP 授权规范要求携带 `WWW-Authenticate`,
   * 客户端据此**发现授权服务器**并知道该用哪种 scheme 重试。缺了它,客户端只能盲猜。
   * `resource_metadata` 指向 RFC 9728 的 Protected Resource Metadata 端点。
   */
  function unauthorizedHeaders() {
    const meta = String((env && env[RESOURCE_METADATA_ENV]) || DEFAULT_RESOURCE_METADATA);
    return { 'WWW-Authenticate': `Bearer realm="khy-mcp", resource_metadata="${meta}"` };
  }

  /**
   * 判定该请求携带的 `MCP-Protocol-Version` 是否可接受。不合规 → 回 400 并附支持列表
   * (规范:服务端收到不认识的版本**必须**拒绝,而不是按自己的版本照常处理)。
   * @returns {boolean} true=已回包,调用方应 return
   */
  function rejectBadProtocolVersion(req, res) {
    const verdict = protocol.checkProtocolVersionHeader(req.headers[PROTOCOL_VERSION_HEADER]);
    if (verdict.ok) {
      return false;
    }
    writeJson(res, 400, {
      error: verdict.reason,
      supported: verdict.supported,
    });
    return true;
  }

  const server = http.createServer((req, res) => {
    let urlObj;
    try {
      urlObj = new URL(req.url, `http://${host}:${port}`);
    } catch {
      writeJson(res, 400, { error: 'bad request url' });
      return;
    }

    // Origin 校验排在鉴权**之前**:不合规来源不应有机会借响应差异探测令牌是否有效。
    if (!isAllowedOrigin(req.headers.origin, env)) {
      writeJson(res, 403, { error: 'forbidden: origin not allowed' });
      return;
    }

    if (!authFromReq(req)) {
      writeJson(
        res,
        401,
        { error: 'unauthorized: missing or invalid token' },
        unauthorizedHeaders()
      );
      return;
    }

    const pathname = urlObj.pathname;

    // ── Streamable HTTP:断线续传 GET /mcp(带 Last-Event-ID)─────────────────────
    // 规范(2025-03-26):客户端断线后用 GET /mcp + `Last-Event-ID` 重新订阅,服务端
    // 重放该 id 之后丢失的事件。事件日志由 POST 分支写入 streamSessions[sid].events。
    if (req.method === 'GET' && pathname === '/mcp') {
      if (rejectBadProtocolVersion(req, res)) {
        return;
      }
      const sid = String(req.headers['mcp-session-id'] || '');
      const last = req.headers['last-event-id'];
      const sess = streamSessions.get(sid);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (sess && Array.isArray(sess.events) && sess.events.length) {
        const replayIds = protocol.replayEventIdsAfter(last, sess.events.map((e) => e.id));
        const replaySet = new Set(replayIds);
        for (const ev of sess.events) {
          if (replaySet.has(ev.id)) {
            res.write(`id: ${ev.id}\nevent: message\ndata: ${ev.data}\n\n`);
          }
        }
      }
      res.end();
      return;
    }

    // ── 传统 SSE:GET /sse → 开流,先发 endpoint 事件 ──────────────────────────
    if (req.method === 'GET' && (pathname === '/sse' || pathname === '/')) {
      if (rejectBadProtocolVersion(req, res)) {
        return;
      }
      const sessionId = `khy-${++sessionSeq}`;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      sseSessions.set(sessionId, res);
      // 告知客户端往哪 POST 回信(spec:endpoint 事件)。
      res.write(`event: endpoint\ndata: /messages?sessionId=${encodeURIComponent(sessionId)}\n\n`);
      req.on('close', () => {
        sseSessions.delete(sessionId);
      });
      return;
    }

    // ── 传统 SSE 回信:POST /messages?sessionId=… ────────────────────────────
    if (req.method === 'POST' && pathname === '/messages') {
      if (rejectBadProtocolVersion(req, res)) {
        return;
      }
      const sessionId = urlObj.searchParams.get('sessionId') || '';
      readBody(req)
        .then(async (body) => {
          const resp = await core.handleMessage(body);
          // 通知无回包 → 202;否则经该会话 SSE 流推。
          const sink = sseSessions.get(sessionId);
          if (resp && sink) {
            try {
              sink.write(`event: message\ndata: ${JSON.stringify(resp)}\n\n`);
            } catch {
              /* stream 关 */
            }
          }
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        })
        .catch((err) => {
          writeJson(res, 500, { error: err && err.message ? err.message : 'internal error' });
        });
      return;
    }

    // ── Streamable HTTP:会话终止 DELETE /mcp ────────────────────────────────
    // 规范:服务端可让客户端用 DELETE 主动结束会话。我们只销掉本地记账。
    if (req.method === 'DELETE' && (pathname === '/' || pathname === '/mcp')) {
      const sid = String(req.headers['mcp-session-id'] || '');
      if (sid) {
        streamSessions.delete(sid);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Streamable HTTP:POST / 或 /mcp → JSON 回包 ──────────────────────────
    if (req.method === 'POST' && (pathname === '/' || pathname === '/mcp')) {
      if (rejectBadProtocolVersion(req, res)) {
        return;
      }
      readBody(req)
        .then(async (body) => {
          // 会话校验:initialize 免检(它正是来建立会话的);其余请求必须带已知 id,
          // 否则 404 —— 规范如此规定,客户端据此重新 initialize。此前这里是"回显或现签",
          // 等于把会话 id 当装饰品:任何 id 都被接受,永远无从发现会话已失效。
          //
          // 注意判定条件是 `sessionSeq > 0`(这个进程**签发过**会话)而非
          // `streamSessions.size > 0`:后者会在最后一个会话被 DELETE / 或过期清空后
          // 让校验整体失效,于是"删掉会话再拿旧 id 用"反而畅通无阻 —— 正是要防的事。
          //
          // `sessionSeq > 0` 同时承担第二个作用:本进程还没签发过任何会话时**一律放行**,
          // 这样"不 initialize 直接 POST tools/list"的探活/curl 用法不会被 404 拦死。
          // 一旦有过会话,未知 id 就必须被拒 —— 宽严切换点是"本进程是否已进入会话模式"。
          const isInitialize = _looksLikeInitialize(body);
          const presented = String(req.headers['mcp-session-id'] || '');
          if (!isInitialize && sessionSeq > 0 && !streamSessions.has(presented)) {
            writeJson(res, 404, {
              error: 'session not found: re-initialize',
              code: 'SESSION_NOT_FOUND',
            });
            return;
          }
          const resp = await core.handleMessage(body);
          const headers = { 'Content-Type': 'application/json' };
          // initialize → 签发新 id;其余 → 沿用客户端带来的 id。
          let sid = presented;
          if (isInitialize && resp && resp.result && resp.result.protocolVersion) {
            sid = sid && streamSessions.has(sid) ? sid : `khy-${++sessionSeq}`;
            // 事件日志：用于 2025-03-26 的断线续传(Last-Event-ID)。
            streamSessions.set(sid, { createdAt: Date.now(), eventSeq: 0, events: [] });
          }
          if (sid) {
            headers['Mcp-Session-Id'] = sid;
          }
          // 通知无回包 → 202 空体。
          if (!resp) {
            res.writeHead(202, headers);
            res.end();
            return;
          }
          // Streamable HTTP(2025-03-26):客户端 Accept 含 text/event-stream → 以 SSE 流回包。
          // 同一份 JSON-RPC 响应,按规范头协商为 text/event-stream,带事件 id 便于断线续传。
          const accept = req.headers['accept'] || req.headers['Accept'] || '';
          if (protocol.resolveStreamableContentType(accept) === 'text/event-stream') {
            const sess = streamSessions.get(sid);
            let evId = 1;
            if (sess) {
              sess.eventSeq = (sess.eventSeq || 0) + 1;
              evId = sess.eventSeq;
              if (!Array.isArray(sess.events)) sess.events = [];
              sess.events.push({ id: String(evId), data: JSON.stringify(resp) });
            }
            res.writeHead(
              200,
              Object.assign(
                { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
                headers
              )
            );
            res.end(`id: ${evId}\nevent: message\ndata: ${JSON.stringify(resp)}\n\n`);
            return;
          }
          res.writeHead(200, headers);
          res.end(JSON.stringify(resp));
        })
        .catch((err) => {
          writeJson(res, 500, { error: err && err.message ? err.message : 'internal error' });
        });
      return;
    }

    writeJson(res, 404, { error: 'not found' });
  });

  server.listen(port, host, () => {
    try {
      const summary = policy.summarizeExposure(core.exposedTools());
      const extraOrigins = parseAllowedOrigins(env);
      errOutput.write(
        `khy MCP server (http) ready — 绑定 ${host}:${port} · token: ${token ? '已启用' : '未启用(仅 loopback)'} · ` +
          `Origin 策略: ${extraOrigins.length ? extraOrigins.join(',') : 'loopback + 无 Origin'} · ` +
          `暴露 ${summary.total} 个工具(含破坏性: ${summary.hasDestructive ? 'yes' : 'no'})\n`
      );
    } catch {
      /* 横幅 best-effort */
    }
    _mcpServerInstance = server;
  });

  const close = () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    for (const sink of sseSessions.values()) {
      try {
        sink.end();
      } catch {
        /* ignore */
      }
    }
    sseSessions.clear();
    streamSessions.clear();
  };

  return { ok: true, server, core, close };
}

/**
 * 该请求体是不是 initialize(JSON-RPC 单条或批量的任一)。用于会话校验豁免。
 * 解析失败 → false(让后续 500/parse error 正常走)。绝不抛。
 * @param {string} body
 * @returns {boolean}
 */
function _looksLikeInitialize(body) {
  try {
    const parsed = JSON.parse(String(body ?? ''));
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.some((m) => m && typeof m === 'object' && m.method === 'initialize');
  } catch {
    return false;
  }
}

/**
 * 读完整请求体(绝不抛,超限保护 4MB)。
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) {
        return;
      }
      data += chunk;
      if (data.length > 4 * 1024 * 1024) {
        tooBig = true;
        data = '';
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

// SIGTERM handler for graceful shutdown
process.on('SIGTERM', async () => {
  // drain: server.close() waits for existing connections to drain
  // db: close database connections managed by aiManagementServer, no direct db access
  if (_mcpServerInstance) {
    console.log('[mcpHttpServer] SIGTERM received, shutting down');
    _mcpServerInstance.close(() => {
      process.exit(0);
    });
  }
});

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  ALLOWED_ORIGINS_ENV,
  RESOURCE_METADATA_ENV,
  DEFAULT_RESOURCE_METADATA,
  isLoopbackHost,
  canStartOnHost,
  isAuthorized,
  timingSafeEqualStr,
  parseAllowedOrigins,
  isAllowedOrigin,
  startHttpServer,
};
