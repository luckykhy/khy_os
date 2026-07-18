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
 * 否则拒绝启动并在 stderr 明示。有 token → 校验 `Authorization: Bearer <token>` 或 `?token=`。
 * 会话表内存持有(重启清零,诚实)。横幅打 stderr。
 *
 * 纯安全判定(canStartOnHost / isAuthorized / isLoopbackHost)导出为纯函数,便于单测而无需起 socket。
 */

const http = require('http');
const { URL } = require('url');
const { createServerCore } = require('./mcpServer');
const policy = require('./mcpServeToolPolicy');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3737;

// ── 纯安全判定(零 IO,可单测)────────────────────────────────────────────────
/**
 * host 是否 loopback(仅这些无需 token 即可绑定)。
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  const h = String(host == null ? '' : host).trim().toLowerCase();
  return h === '' || h === '127.0.0.1' || h === 'localhost' || h === '::1'
    || h === '0:0:0:0:0:0:0:1' || h.startsWith('127.');
}

/**
 * 是否允许在该 host 上启动。非 loopback 且无 token → 拒绝(返回带原因的对象)。
 * @param {string} host
 * @param {string} [token]
 * @returns {{ ok: boolean, reason?: string }}
 */
function canStartOnHost(host, token) {
  if (isLoopbackHost(host)) return { ok: true };
  if (token && String(token).length > 0) return { ok: true };
  return {
    ok: false,
    reason: `拒绝在非 loopback 地址 ${host} 上无 token 启动:khy 暴露全量工具(含 shell/文件写),`
      + `绝不裸奔上网。请加 --token <令牌> 或绑定到 127.0.0.1。`,
  };
}

/**
 * 校验一个请求是否授权。无 token 配置(仅 loopback)→ 一律放行;有 token → 需匹配
 * `Authorization: Bearer <token>` 或查询串 `?token=`。绝不抛。
 * @param {{ authorization?: string, queryToken?: string }} req
 * @param {string} [token]
 * @returns {boolean}
 */
function isAuthorized(req, token) {
  if (!token || String(token).length === 0) return true; // 仅 loopback,无 token 门
  const r = req && typeof req === 'object' ? req : {};
  const auth = String(r.authorization == null ? '' : r.authorization);
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer && bearer === token) return true;
  if (r.queryToken && String(r.queryToken) === token) return true;
  return false;
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
function startHttpServer(opts = {}) {
  const env = opts.env || process.env;
  const host = opts.host || DEFAULT_HOST;
  const port = Number(opts.port) || DEFAULT_PORT;
  const token = opts.token || '';
  const errOutput = opts.errOutput || process.stderr;

  const guard = canStartOnHost(host, token);
  if (!guard.ok) {
    try { errOutput.write(`khy MCP server (http): ${guard.reason}\n`); } catch { /* ignore */ }
    return { ok: false, reason: guard.reason };
  }

  const core = createServerCore({ version: opts.version, env, context: opts.context });

  // 内存会话表:sessionId → SSE response stream(用于传统 SSE 回信)。
  const sseSessions = new Map();
  let sessionSeq = 0;

  function authFromReq(req, urlObj) {
    return isAuthorized(
      { authorization: req.headers['authorization'], queryToken: urlObj.searchParams.get('token') },
      token,
    );
  }

  function writeJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    let urlObj;
    try {
      urlObj = new URL(req.url, `http://${host}:${port}`);
    } catch {
      writeJson(res, 400, { error: 'bad request url' });
      return;
    }

    if (!authFromReq(req, urlObj)) {
      writeJson(res, 401, { error: 'unauthorized: missing or invalid token' });
      return;
    }

    const pathname = urlObj.pathname;

    // ── 传统 SSE:GET /sse → 开流,先发 endpoint 事件 ──────────────────────────
    if (req.method === 'GET' && (pathname === '/sse' || pathname === '/')) {
      const sessionId = `khy-${++sessionSeq}`;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      sseSessions.set(sessionId, res);
      // 告知客户端往哪 POST 回信(spec:endpoint 事件)。
      res.write(`event: endpoint\ndata: /messages?sessionId=${encodeURIComponent(sessionId)}\n\n`);
      req.on('close', () => { sseSessions.delete(sessionId); });
      return;
    }

    // ── 传统 SSE 回信:POST /messages?sessionId=… ────────────────────────────
    if (req.method === 'POST' && pathname === '/messages') {
      const sessionId = urlObj.searchParams.get('sessionId') || '';
      readBody(req).then(async (body) => {
        const resp = await core.handleMessage(body);
        // 通知无回包 → 202;否则经该会话 SSE 流推。
        const sink = sseSessions.get(sessionId);
        if (resp && sink) {
          try { sink.write(`event: message\ndata: ${JSON.stringify(resp)}\n\n`); } catch { /* stream 关 */ }
        }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }).catch((err) => {
        writeJson(res, 500, { error: err && err.message ? err.message : 'internal error' });
      });
      return;
    }

    // ── Streamable HTTP:POST / 或 /mcp → JSON 回包 ──────────────────────────
    if (req.method === 'POST' && (pathname === '/' || pathname === '/mcp')) {
      readBody(req).then(async (body) => {
        const resp = await core.handleMessage(body);
        const headers = { 'Content-Type': 'application/json' };
        // 回显/签发会话 id(Streamable HTTP)。
        const sid = req.headers['mcp-session-id'] || `khy-${++sessionSeq}`;
        headers['Mcp-Session-Id'] = sid;
        // 通知无回包 → 202 空体。
        if (!resp) { res.writeHead(202, headers); res.end(); return; }
        res.writeHead(200, headers);
        res.end(JSON.stringify(resp));
      }).catch((err) => {
        writeJson(res, 500, { error: err && err.message ? err.message : 'internal error' });
      });
      return;
    }

    writeJson(res, 404, { error: 'not found' });
  });

  server.listen(port, host, () => {
    try {
      const summary = policy.summarizeExposure(core.exposedTools());
      errOutput.write(
        `khy MCP server (http) ready — 绑定 ${host}:${port} · token: ${token ? '已启用' : '未启用(仅 loopback)'} · `
        + `暴露 ${summary.total} 个工具(含破坏性: ${summary.hasDestructive ? 'yes' : 'no'})\n`,
      );
    } catch { /* 横幅 best-effort */ }
  });

  const close = () => {
    try { server.close(); } catch { /* ignore */ }
    for (const sink of sseSessions.values()) { try { sink.end(); } catch { /* ignore */ } }
    sseSessions.clear();
  };

  return { ok: true, server, core, close };
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
      if (tooBig) return;
      data += chunk;
      if (data.length > 4 * 1024 * 1024) { tooBig = true; data = ''; }
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  isLoopbackHost,
  canStartOnHost,
  isAuthorized,
  startHttpServer,
};
