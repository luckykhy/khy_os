'use strict';

/**
 * mcpServerProtocol.js — 纯叶子:khy **作为 MCP server** 时的 JSON-RPC 2.0 协议层(单一真源)。
 *
 * 定位(GOAL「khy 可以支持 MCP server」):khy 长期只作 MCP **client**(services/mcp/index.js:
 * spawn 外部 server、收发换行分隔的 JSON-RPC 2.0、autoConnect、tool pool)。本轮把方向**镜像**过来
 * ——让 khy 把自己 `getEnabled()` 的整套原生工具作为一台 MCP server 暴露给任意 MCP 客户端
 * (Claude Desktop / Cursor / CC / 另一台 khy)。MCP server 本质就是「stdio/HTTP 上的 JSON-RPC 2.0」,
 * 而 client 侧的每块拼图(帧构形 index.js:594、读行 :349、写行 :749)本叶子只需反向实现。
 *
 * 分层:**协议是纯函数**(本叶子,零 IO、可确定性单测、过 leaf-contract 守卫);**传输是薄 IO**
 * (mcpStdioServer / mcpHttpServer,读写 stdin/stdout/socket)。两个传输共用同一个协议核心。
 *
 * 契约:零 IO(只读 process.env 做门控)、确定性、绝不抛(非法输入 → 标记但不抛)。
 * 门控 KHY_MCP_SERVE(default-on、CANON);关 → isServeEnabled 恒 false,上游 CLI/引擎逐字节回退
 * (`khy mcp serve` 报「未启用」、不起任何 server)。协议构形函数本身与门控无关(纯数据变换),
 * 门控只决定「要不要起这台 server」,由调用方(handler)判定。
 */

// ── 门控(KHY_MCP_SERVE,default-on,CANON off)────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * khy MCP server 是否启用。flagRegistry 优先,注册表不可用 → 本地 CANON(4 词)回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isServeEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_MCP_SERVE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_MCP_SERVE;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 常量(与 client 侧 index.js:42 对齐)──────────────────────────────────────
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'khy-os';

// JSON-RPC 2.0 标准错误码(见 spec §5.1)。
const ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/**
 * server 身份声明。version 由调用方传入(叶子不读盘),缺省 '0.0.0' 兜底。
 * @param {string} [version]
 * @returns {{ name: string, version: string }}
 */
function serverInfo(version) {
  return { name: SERVER_NAME, version: String(version == null ? '0.0.0' : version) };
}

// ── 解析:一行文本 → JSON-RPC 消息(绝不抛)──────────────────────────────────
/**
 * 解析一条入站 JSON-RPC 文本。合法对象 → {ok:true, id, method, params, isNotification}。
 * 非法 JSON / 非对象 → {ok:false, error}(标记但不抛,由引擎回 -32700)。
 * JSON-RPC 通知(无 id)标记 isNotification=true(无回包)。
 * @param {string} line
 * @returns {{ ok: boolean, id?: any, method?: string, params?: object, isNotification?: boolean, error?: string }}
 */
function parseMessage(line) {
  let obj;
  try {
    obj = JSON.parse(String(line == null ? '' : line));
  } catch (err) {
    return { ok: false, error: `parse error: ${err && err.message ? err.message : 'invalid JSON'}` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'invalid request: message must be a JSON object' };
  }
  const method = typeof obj.method === 'string' ? obj.method : undefined;
  // 通知 = 有 method、无 id(spec §4.1)。请求 = 有 method + id。
  const hasId = Object.prototype.hasOwnProperty.call(obj, 'id') && obj.id !== undefined && obj.id !== null;
  return {
    ok: true,
    id: hasId ? obj.id : null,
    method,
    params: obj.params && typeof obj.params === 'object' ? obj.params : {},
    isNotification: !!method && !hasId,
  };
}

// ── 构形:result / error 回包 ────────────────────────────────────────────────
/**
 * @param {any} id
 * @param {any} result
 * @returns {{ jsonrpc: '2.0', id: any, result: any }}
 */
function buildResult(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

/**
 * @param {any} id
 * @param {number} code
 * @param {string} message
 * @param {any} [data]
 * @returns {{ jsonrpc: '2.0', id: any, error: { code: number, message: string, data?: any } }}
 */
function buildError(id, code, message, data) {
  const error = { code, message: String(message == null ? '' : message) };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

/**
 * initialize 回包:只声明 tools 能力(resources/prompts 本轮不做,诚实不虚报)。
 * @param {object} [opts]
 * @param {string} [opts.version]
 * @returns {{ protocolVersion: string, capabilities: object, serverInfo: object }}
 */
function buildInitializeResult(opts = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: serverInfo(opts && opts.version),
  };
}

// ── 转换:khy 工具定义 / 结果 → MCP 形 ───────────────────────────────────────
/**
 * khy 的 `toFunctionDef()` 形 → MCP `Tool` 形。
 * 关键 rename:khy 的 `parameters` → MCP 的 `inputSchema`;丢弃 `aliases`(MCP 客户端不认)。
 * @param {{ name: string, description?: string, parameters?: object }} funcDef
 * @returns {{ name: string, description: string, inputSchema: object }}
 */
function toolDefToMcp(funcDef) {
  const def = funcDef && typeof funcDef === 'object' ? funcDef : {};
  const inputSchema = def.parameters && typeof def.parameters === 'object'
    ? def.parameters
    : { type: 'object', properties: {} };
  return {
    name: String(def.name == null ? '' : def.name),
    description: String(def.description == null ? '' : def.description),
    inputSchema,
  };
}

/**
 * khy 归一后的工具结果 → MCP `CallToolResult`(`{content:[...], isError?}`)。
 * 已是 MCP content 形(content 是数组)→ 透传(补 isError 若缺);否则从 {success, content, error}
 * 折成单条 text content,`success:false` → `isError:true`。绝不抛。
 * @param {any} result
 * @returns {{ content: Array<{type:string, text:string}>, isError?: boolean }}
 */
function toolResultToMcp(result) {
  const r = result && typeof result === 'object' ? result : {};
  // 已是 MCP 原生形(content 数组)→ 透传,仅补 isError 语义。
  if (Array.isArray(r.content)) {
    const out = { content: r.content };
    if (r.isError !== undefined) out.isError = !!r.isError;
    else if (r.success === false) out.isError = true;
    return out;
  }
  // khy 归一形 {success, content?, error?} → 单条 text。
  const isError = r.success === false;
  const text = r.content != null ? r.content
    : (r.error != null ? r.error : '');
  return {
    content: [{ type: 'text', text: String(text) }],
    isError,
  };
}

// ── 派发:message → 调 handlers 表 → 回包(纯,handlers 由调用方注入)──────────
/**
 * 纯派发器。已解析的消息 + 一张 handlers 表(method → async fn(params) → result)。
 * 命中 → await 后包 buildResult;未知 method → buildError(-32601);
 * 通知(notifications/*、无 id)→ 返回 null(无回包)。
 * handler 抛出的错误由**调用方**(引擎)catch 成 -32603——本函数只负责查表与包正常回包,
 * 但为「绝不抛」契约仍对 handler 缺失/非函数做安全兜底。
 * @param {{ id?: any, method?: string, params?: object, isNotification?: boolean }} msg
 * @param {Record<string, Function>} handlers
 * @returns {Promise<object|null>}
 */
async function dispatch(msg, handlers) {
  const m = msg && typeof msg === 'object' ? msg : {};
  const table = handlers && typeof handlers === 'object' ? handlers : {};
  // 通知无回包(含 notifications/initialized)。
  if (m.isNotification || (typeof m.method === 'string' && m.method.startsWith('notifications/'))) {
    return null;
  }
  const fn = table[m.method];
  if (typeof fn !== 'function') {
    return buildError(m.id, ERROR_CODES.METHOD_NOT_FOUND, `method not found: ${m.method}`);
  }
  const result = await fn(m.params || {});
  return buildResult(m.id, result);
}

module.exports = {
  isServeEnabled,
  PROTOCOL_VERSION,
  SERVER_NAME,
  ERROR_CODES,
  serverInfo,
  parseMessage,
  buildResult,
  buildError,
  buildInitializeResult,
  toolDefToMcp,
  toolResultToMcp,
  dispatch,
};
