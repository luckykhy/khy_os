'use strict';

/**
 * A2A (Agent-to-Agent) Protocol service — inter-agent communication.
 * Supports Google A2A protocol for agent interoperability.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function _env(name) {
  return String(process.env[`KHY_A2A_${name}`] || '').trim();
}

/**
 * 过滤掉值为 undefined / null / '' 的 header。
 *
 * Node 的 `http.request` 对 `undefined` 值的 header 会**同步抛**
 * `ERR_HTTP_INVALID_HEADER_VALUE`（Node 22 实测）。历史上 `sendMessage`/`createTask`
 * 在未配置 `KHY_A2A_API_KEY` 时传 `Authorization: undefined`、未传 userId 时传
 * `X-User-Id: undefined`，该异常被外层 catch 吞成 `{ status: 0 }` —— 出站 A2A 通信
 * **100% 静默失败**。统一在入口过滤，避免每个调用点各自记得"没值时别塞 key"。
 *
 * @param {object} [headers]
 * @returns {object}
 */
function _cleanHeaders(headers) {
  const out = {};
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined && v !== null && v !== '') {
        out[k] = v;
      }
    }
  }
  return out;
}

function _request(urlStr, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const lib = url.protocol === 'https:' ? https : http;
      const data = body ? JSON.stringify(body) : '';
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: _cleanHeaders({
          'Content-Type': 'application/json',
          'Content-Length': data ? Buffer.byteLength(data) : 0,
          ...headers,
        }),
      }, (res) => {
        let responseData = '';
        res.on('data', (c) => { responseData += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(responseData) }); }
          catch { resolve({ status: res.statusCode, data: responseData }); }
        });
      });
      // phase 区分失败发生在哪一层:构造 / 网络 / 超时。调用方拿到 status:0 时
      // 至少能判断是"参数有问题"还是"对端不可达",不必再靠猜。
      req.on('error', (e) => resolve({ status: 0, error: e.message, phase: 'network' }));
      req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, error: 'timeout', phase: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message, phase: 'build' });
    }
  });
}

// ── A2A Agent Card ──
/**
 * 拉取远端 agent 的 Agent Card（A2A v0.3.0 标准 well-known 路径）。
 * @param {string} agentUrl
 */
async function getAgentCard(agentUrl) {
  return _request(`${agentUrl}/.well-known/agent-card.json`);
}

// ── A2A Message Send ──
/**
 * `message/send`（REST 绑定：`POST /v1/message:send`）。
 *
 * `parts` 采用规范的 `kind` 判别联合 —— `{ kind: 'text', text }`。历史上这里漏了
 * `kind`，只写 `{ text }`，那不是合法的 TextPart，规范客户端会拒收。
 *
 * @param {string} agentUrl
 * @param {string} message
 * @param {object} [options]
 */
async function sendMessage(agentUrl, message, options = {}) {
  const apiKey = _env('API_KEY');
  return _request(`${agentUrl}/v1/message:send`, 'POST', {
    message: {
      messageId: options.messageId || `msg_${Date.now()}`,
      parts: [{ kind: 'text', text: message }],
      role: 'user',
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.contextId ? { contextId: options.contextId } : {}),
    },
    ...(options.configuration ? { configuration: options.configuration } : {}),
    metadata: options.metadata || {},
  }, {
    'Authorization': apiKey ? `Bearer ${apiKey}` : undefined,
    'X-User-Id': options.userId,
  });
}

// ── A2A Task Create（已废弃：在 A2A 里创建任务就是发消息）──
/**
 * @deprecated 改用 {@link sendMessage}。
 *
 * A2A 规范中**没有**独立的「创建任务」RPC —— 任务由服务端在 `message/send` 时
 * 隐式创建，`taskId` 由**服务端**生成。此处旧实现 POST `/v1/tasks` 并自带顶层 `id`
 * 与 `messages[]` 数组，那既不是 JSON-RPC 方法也不是 REST 绑定路径，属于私有扩展，
 * 与任何标准 A2A agent 都无法互通（审计 A7）。
 *
 * 现改为委托给 `sendMessage`，保持函数名可用（调用方不必立刻改），但行为对齐规范。
 */
async function createTask(agentUrl, task, options = {}) {
  return sendMessage(agentUrl, task, options);
}

// ── A2A Task Get ──
/**
 * `tasks/get`（REST 绑定：`GET /v1/tasks/{id}`）。
 * @param {string} agentUrl
 * @param {string} taskId
 */
async function getTask(agentUrl, taskId) {
  return _request(`${agentUrl}/v1/tasks/${encodeURIComponent(taskId)}`);
}

// ── A2A Task Cancel ──
/**
 * `tasks/cancel`（REST 绑定：`POST /v1/tasks/{id}:cancel`）。
 *
 * 补上审计 A5 指出的缺口：此前全仓没有任何协议级的任务取消入口，长任务只能强杀进程。
 * @param {string} agentUrl
 * @param {string} taskId
 * @param {object} [options]
 */
async function cancelTask(agentUrl, taskId, options = {}) {
  const apiKey = _env('API_KEY');
  return _request(`${agentUrl}/v1/tasks/${encodeURIComponent(taskId)}:cancel`, 'POST', {
    ...(options.metadata ? { metadata: options.metadata } : {}),
  }, {
    'Authorization': apiKey ? `Bearer ${apiKey}` : undefined,
  });
}

// ── Local A2A Server ──
/**
 * 构造本机 Agent Card（符合 A2A v0.3.0 `agent-card.schema.json`）。
 *
 * 契约与单一真源都在纯叶子 `services/a2a/agentCardSpec.js`；本函数只是给老调用方
 * （`A2ATool.create_local_card`）留的**薄适配层**。
 *
 * 相比旧实现修正了三处规范违反（审计 A3）：
 *   1. `authentication.schemes` 不是 A2A 字段 → 改为 `securitySchemes` + `security`；
 *   2. 缺 `protocolVersion` / `preferredTransport` / `provider` → 补齐；
 *   3. `capabilities.streaming: true` 是**空声明**（全仓零 SSE 实现）→ 改为诚实值 false。
 *
 * @param {object} [options]
 * @returns {object} AgentCard
 */
function createLocalAgentCard(options = {}) {
  const serviceDefaults = require('../../constants/serviceDefaults');
  const spec = require('./agentCardSpec');
  const manifest = require('./builtinAgentManifest');
  const { card } = spec.buildAgentCard({
    baseUrl: options.url || `http://127.0.0.1:${serviceDefaults.BACKEND_PORT}`,
    version: options.version || '1.0.0',
    name: options.name || 'khy-os',
    description: options.description || 'Khy OS Agent',
    skills: options.skills || manifest.toSkillSeeds(),
    provider: options.provider || { organization: 'khy-os' },
    securitySchemes: options.securitySchemes || {
      bearer: { type: 'http', scheme: 'bearer', description: 'KHY_A2A_API_KEY' },
    },
    security: options.security || [{ bearer: [] }],
  });
  return card;
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'google', name: 'Google A2A' },
  { id: 'local', name: 'Local A2A' },
];

function listProviders() {
  return PROVIDERS;
}

module.exports = {
  getAgentCard,
  sendMessage,
  createTask,
  getTask,
  cancelTask,
  createLocalAgentCard,
  listProviders,
  PROVIDERS,
};
