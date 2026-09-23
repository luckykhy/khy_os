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
    const reg = require('../../../flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_MCP_SERVE', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_MCP_SERVE;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 常量(单一真源:client 侧 index.js 直接 require 本模块取用)─────────────────
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'khy-os';

// khy 实际实现过其行为的协议版本。**只列真的支持**的版本,不做乐观声明 ——
// 服务端回的版本是客户端决定"能不能继续聊"的依据。
// 2024-11-05(stdio + 传统 SSE,以及 Streamable HTTP 的 JSON 回包形态);
// 2025-03-26(Streamable HTTP 的 SSE 流式响应 + Last-Event-ID 断线续传)已实现,
// 见 `transport-streamable-http-sse-response` / `transport-streamable-http-last-event-id`
// 两条 required 特性与其纯函数 `resolveStreamableContentType` / `replayEventIdsAfter`。
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([PROTOCOL_VERSION, '2025-03-26']);

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
 * `jsonrpc` 字段存在但 ≠ "2.0" → {ok:false, error, errorCode:-32600}(Invalid Request)。
 * JSON-RPC 通知(无 id)标记 isNotification=true(无回包)。
 *
 * `jsonrpc` 校验口径(JSON-RPC 2.0 §4):规范要求该成员**必须**精确为字符串 `"2.0"`。
 * 缺字段与写错字段的语义不同 —— 前者按 2.0 处理(部分旧客户端省略,服务端宽容不构成
 * 攻击面),后者明确回 -32600,不再当作合法请求默默处理。
 *
 * @param {string} line
 * @returns {{ ok: boolean, id?: any, method?: string, params?: object, isNotification?: boolean, error?: string, errorCode?: number }}
 */
function parseMessage(line) {
  let obj;
  try {
    obj = JSON.parse(String(line == null ? '' : line));
  } catch (err) {
    return {
      ok: false,
      error: `parse error: ${err && err.message ? err.message : 'invalid JSON'}`,
      errorCode: ERROR_CODES.PARSE_ERROR,
    };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {
      ok: false,
      error: 'invalid request: message must be a JSON object',
      errorCode: ERROR_CODES.INVALID_REQUEST,
    };
  }
  if (obj.jsonrpc !== undefined && obj.jsonrpc !== '2.0') {
    return {
      ok: false,
      error: `invalid request: jsonrpc must be "2.0" (got ${JSON.stringify(obj.jsonrpc)})`,
      errorCode: ERROR_CODES.INVALID_REQUEST,
    };
  }
  const method = typeof obj.method === 'string' ? obj.method : undefined;
  // 通知 = 有 method、无 id(spec §4.1)。请求 = 有 method + id。
  const hasId =
    Object.prototype.hasOwnProperty.call(obj, 'id') && obj.id !== undefined && obj.id !== null;
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
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

/**
 * 协议版本协商(MCP Lifecycle §Version Negotiation)。
 *
 * 客户端在 initialize 里报它支持的最新版本;服务端若支持则**回同一版本**,
 * 否则回自己支持的最高版本,由客户端决定是否继续。此前这里无条件回固定的
 * 2024-11-05 且完全不读 `params.protocolVersion` —— 等于没有协商,新版客户端
 * 拿到不认识的版本后按规范应当断开。
 *
 * @param {string} [requested] 客户端请求的协议版本
 * @returns {string} 协商结果
 */
function negotiateProtocolVersion(requested) {
  const r = String(requested ?? '').trim();
  if (r && SUPPORTED_PROTOCOL_VERSIONS.includes(r)) {
    return r;
  }
  return PROTOCOL_VERSION;
}

// ── Streamable HTTP:MCP-Protocol-Version 头(2025-03-26 §Protocol Version Header)──
// 规范原文要点:initialize 之后客户端发起的**每个** HTTP 请求都必须带
// `MCP-Protocol-Version: <协商结果>`。服务端收到不认识的版本**必须**回 400
// (而非默默按自己的版本处理);**缺失该头时**应假定为 2025-03-26(为兼容
// 该头引入之前的老客户端)。
//
// 本项目当前 SUPPORTED_PROTOCOL_VERSIONS 只有 2024-11-05,即:任何客户端带
// `2025-06-18` / `2025-03-26` 之类的头过来,都应当被明确拒绝而不是"照单全收"。
// 这正是"声明与实现一致"的另一个面 —— 不认识的版本要当场说清楚。
const PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';
// 缺头时的假定值。
//
// 规范说缺头应假定为 2025-03-26。早期 2025-03-26 的流式语义尚未实现,照抄会变成
// "假兼容"(客户端以为能拿 SSE 流,实际拿到 JSON),故曾回落到 2024-11-05。
// 现 2025-03-26 已实装(见 SUPPORTED_PROTOCOL_VERSIONS 处的说明),但缺头仍回落
// 到**本服务端基准版本**而非最新的那个 —— 老客户端默认按 2024-11-05 的语义说话,
// 直接假定成新版等于单方面升级它的协议预期。判定结果里标注 `assumed`,让调用方
// 与日志看得见这是一次假定而非协商结果。
const DEFAULT_ASSUMED_VERSION = PROTOCOL_VERSION;

/**
 * 判定入站 HTTP 请求的 `MCP-Protocol-Version` 头是否可接受。纯函数,绝不抛。
 *
 * @param {string|undefined|null} headerValue 头值(HTTP 头名大小写不敏感,取值方负责取小写)
 * @returns {{ ok: boolean, version: string, assumed: boolean, supported: string[], reason?: string }}
 *   - `ok:false` → 调用方应回 400,并在 body 里带 `supported`
 *   - `assumed:true` → 客户端没带该头,`version` 是回落值而非协商结果
 */
function checkProtocolVersionHeader(headerValue) {
  const raw = String(headerValue ?? '').trim();
  if (!raw) {
    return {
      ok: true,
      version: DEFAULT_ASSUMED_VERSION,
      assumed: true,
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
    };
  }
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(raw)) {
    return {
      ok: true,
      version: raw,
      assumed: false,
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
    };
  }
  return {
    ok: false,
    version: raw,
    assumed: false,
    supported: [...SUPPORTED_PROTOCOL_VERSIONS],
    reason: `unsupported protocol version: ${raw}`,
  };
}

// ── Streamable HTTP:SSE 响应协商 + 断线续传(2025-03-26)────────────────────────
// 这两个纯函数把「SSE 流响应」与「Last-Event-ID 重放」里**可确定性验证**的部分抽出来,
// 让 `check-protocol-conformance.js` 能用 behavior 探针直接断言(无需起 socket),
// 也供 `mcpHttpServer.js` 复用同一份真源逻辑。

/**
 * 根据客户端 `Accept` 头决定 Streamable HTTP 的响应 Content-Type(2025-03-26 §Streamable HTTP)。
 * 客户端在 Accept 里带 `text/event-stream` → 服务端以 SSE 流回包;否则回 `application/json`。
 * 纯函数,绝不抛。
 * @param {string} [accept]
 * @returns {'text/event-stream'|'application/json'}
 */
function resolveStreamableContentType(accept) {
  const a = String(accept == null ? '' : accept).toLowerCase();
  if (a.includes('text/event-stream')) return 'text/event-stream';
  return 'application/json';
}

/**
 * 给定断线前的 `Last-Event-ID` 与本次会话已记录的事件 id 列表,返回需要重放的切片
 * (id 严格大于 lastEventId 的那些)。纯函数,绝不抛。
 * lastEventId 非法 / 空 / 负数 → 返回空数组(无重放,客户端从头订阅)。
 * @param {string|undefined|null} lastEventId
 * @param {string[]} eventIds
 * @returns {string[]}
 */
function replayEventIdsAfter(lastEventId, eventIds) {
  const n = Number(lastEventId);
  // 缺失(undefined→NaN)、空串(''→0)、负数 → 视为「无续传锚点」,不重放。
  // 事件 id 从 1 起,故 n<=0 不可能对应任何已发事件的"之后"。
  if (!Number.isFinite(n) || n <= 0) return [];
  return (eventIds || []).filter((id) => {
    const m = Number(id);
    return Number.isFinite(m) && m > n;
  });
}

/**
 * initialize 回包:只声明 tools 能力(resources/prompts 本轮不做,诚实不虚报)。
 * @param {object} [opts]
 * @param {string} [opts.version] 本服务端版本号
 * @param {string} [opts.requestedVersion] 客户端请求的协议版本(参与协商)
 * @returns {{ protocolVersion: string, capabilities: object, serverInfo: object }}
 */
function buildInitializeResult(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return {
    protocolVersion: negotiateProtocolVersion(o.requestedVersion),
    capabilities: { tools: {} },
    serverInfo: serverInfo(o.version),
  };
}

// ── 转换:khy 工具定义 / 结果 → MCP 形 ───────────────────────────────────────
/**
 * khy 的 `toFunctionDef()` 形 → MCP `Tool` 形。
 * 关键 rename:khy 的 `parameters` → MCP 的 `inputSchema`;丢弃 `aliases`(MCP 客户端不认)。
 *
 * 透传可选字段(仅在真实存在时出现,绝不臆造):
 * - `title`(MCP 2025-06-18 `BaseMetadata.title`)—— 人类可读标题
 * - `annotations`(MCP `ToolAnnotations`)—— `title` / `readOnlyHint` / `destructiveHint` /
 *   `idempotentHint` / `openWorldHint`。这是客户端做**权限决策**的依据,缺了它
 *   Claude Desktop / Cursor 只能把每个工具都当成可写不可逆。
 * - `outputSchema`(MCP 2025-06-18)—— 声明结构化返回的 JSON Schema;声明后才允许
 *   在 `tools/call` 结果里回 `structuredContent`(规范要求二者成对出现)。
 *
 * @param {{ name: string, description?: string, parameters?: object, title?: string, annotations?: object, outputSchema?: object }} funcDef
 * @returns {{ name: string, description: string, inputSchema: object, title?: string, annotations?: object, outputSchema?: object }}
 */
function toolDefToMcp(funcDef) {
  const def = funcDef && typeof funcDef === 'object' ? funcDef : {};
  const inputSchema =
    def.parameters && typeof def.parameters === 'object'
      ? def.parameters
      : { type: 'object', properties: {} };
  const out = {
    name: String(def.name == null ? '' : def.name),
    description: String(def.description == null ? '' : def.description),
    inputSchema,
  };
  if (typeof def.title === 'string' && def.title) {
    out.title = def.title;
  }
  if (def.annotations && typeof def.annotations === 'object') {
    out.annotations = def.annotations;
  }
  if (def.outputSchema && typeof def.outputSchema === 'object') {
    out.outputSchema = def.outputSchema;
  }
  return out;
}

/**
 * khy 归一后的工具结果 → MCP `CallToolResult`(`{content:[...], structuredContent?, isError?}`)。
 * 已是 MCP content 形(content 是数组)→ 透传(补 isError / structuredContent 若缺);
 * 否则从 {success, content, error} 折成 content 数组。
 *
 * 结构化保真(MCP 2025-06-18 Structured Content):当结果体是**普通对象**时,
 * 除 `content:[{type:'text',text:JSON}]` 外**同时**回 `structuredContent`,
 * 让客户端拿到可校验的结构而不是一句 JSON 字符串。数组不是合法 `structuredContent`
 * (规范要求是对象),故仅字符串化进 text,不进 structuredContent。
 *
 * 绝不抛。
 * @param {any} result
 * @returns {{ content: Array<{type:string, text:string}>, structuredContent?: object, isError?: boolean }}
 */
function toolResultToMcp(result) {
  const r = result && typeof result === 'object' ? result : {};
  // 已是 MCP 原生形(content 数组)→ 透传,仅补 isError / structuredContent 语义。
  if (Array.isArray(r.content)) {
    const out = { content: r.content };
    if (r.structuredContent !== undefined) {
      out.structuredContent = r.structuredContent;
    }
    if (r.isError !== undefined) {
      out.isError = !!r.isError;
    } else if (r.success === false) {
      out.isError = true;
    }
    return out;
  }
  // khy 归一形 {success, content?, error?} → content 数组 (+ 可选 structuredContent)。
  const isError = r.success === false;
  const raw = r.content != null ? r.content : r.error != null ? r.error : '';
  // 对象 / 数组:不再用 String() 折叠(那会把结构毁成 "[object Object]")。
  if (raw !== null && typeof raw === 'object') {
    let text;
    try {
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
    const out = { content: [{ type: 'text', text: String(text) }], isError };
    // structuredContent 必须是对象(非数组、非 null)。
    if (!Array.isArray(raw)) {
      out.structuredContent = raw;
    }
    return out;
  }
  return {
    content: [{ type: 'text', text: String(raw) }],
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

// ── 一致性自述矩阵(khy 作为 MCP server / client 的「声明 vs 实现」单一真源)────
/**
 * 每个协议特性和它的实现状态。守卫 `scripts/ci/check-protocol-conformance.js`
 * 会逐条**实测**这些特性,任何 `implemented:true` 却测不过 → 守卫红灯。
 *
 * 存在的理由:本项目多处审计的共同教训是「声明与实现不一致」(server 端诚实声明
 * 只支持 tools,client 端却虚报 capabilities;A2A 卡片声明 streaming 却零实现)。
 * 把声明做成**机器可读且被实测**的数据,不一致就没人能悄悄带过去。
 *
 * 字段:
 * - `id`          特性标识(守卫按 id 分派到各自的实测断言)
 * - `revision`    该特性属于哪个协议修订
 * - `role`        `server` / `client` / `shared` —— 谁需要实现它
 * - `required`    该修订的**必需**特性。`SUPPORTED_PROTOCOL_VERSIONS` 里的修订,
 *                 其全部 required 特性都必须 `implemented:true`,否则守卫失败。
 * - `implemented` 是否真的做了(守卫会验证)
 * - `evidence`    代码/测试落点,便于人工复核
 */
const PROTOCOL_CONFORMANCE = Object.freeze([
  // ── 2024-11-05:khy 完整声明的修订(全部 required)──────────────────────
  { id: 'jsonrpc-2.0-envelope', revision: '2024-11-05', role: 'shared', required: true, implemented: true, evidence: 'buildResult/buildError 恒写 jsonrpc:"2.0";parseMessage 校验入站' },
  { id: 'jsonrpc-error-codes', revision: '2024-11-05', role: 'shared', required: true, implemented: true, evidence: 'ERROR_CODES -32700/-32600/-32601/-32602/-32603' },
  { id: 'lifecycle-initialize', revision: '2024-11-05', role: 'server', required: true, implemented: true, evidence: 'buildInitializeResult' },
  { id: 'lifecycle-version-negotiation', revision: '2024-11-05', role: 'shared', required: true, implemented: true, evidence: 'negotiateProtocolVersion' },
  { id: 'tools-list', revision: '2024-11-05', role: 'server', required: true, implemented: true, evidence: 'mcpServer.handlers["tools/list"]' },
  { id: 'tools-call', revision: '2024-11-05', role: 'server', required: true, implemented: true, evidence: 'mcpServer.handlers["tools/call"]' },
  { id: 'ping', revision: '2024-11-05', role: 'shared', required: true, implemented: true, evidence: 'mcpServer.handlers.ping' },
  { id: 'transport-stdio', revision: '2024-11-05', role: 'shared', required: true, implemented: true, evidence: 'mcpStdioServer.js' },
  { id: 'transport-http-sse-legacy', revision: '2024-11-05', role: 'server', required: true, implemented: true, evidence: 'mcpHttpServer.js GET /sse' },
  { id: 'server-capability-declaration-honesty', revision: '2024-11-05', role: 'server', required: true, implemented: true, evidence: 'buildInitializeResult 只声明 tools,不虚报 resources/prompts' },

  // ── 2024-11-05 的**未实现**项(诚实登记;守卫断言它们不是 required)──────
  { id: 'server-capability-resources', revision: '2024-11-05', role: 'server', required: false, implemented: false, evidence: 'initialize 只声明 tools —— 属于能力缺口,不是规范违反' },
  { id: 'server-capability-prompts', revision: '2024-11-05', role: 'server', required: false, implemented: false, evidence: 'initialize 只声明 tools' },

  // ── 2025-03-26:部分实现(仅 JSON 回包形态的 Streamable HTTP)────────────
  { id: 'transport-streamable-http-json-response', revision: '2025-03-26', role: 'server', required: false, implemented: true, evidence: 'mcpHttpServer.js POST /mcp 回 application/json' },
  { id: 'transport-streamable-http-protocol-version-header', revision: '2025-03-26', role: 'shared', required: false, implemented: true, evidence: 'checkProtocolVersionHeader + rejectBadProtocolVersion' },
  { id: 'transport-streamable-http-session-404', revision: '2025-03-26', role: 'server', required: false, implemented: true, evidence: 'mcpHttpServer.js streamSessions 校验 -> SESSION_NOT_FOUND' },
  { id: 'transport-streamable-http-sse-response', revision: '2025-03-26', role: 'server', required: true, implemented: true, evidence: 'mcpHttpServer.js POST /mcp 在 Accept 含 text/event-stream 时以 text/event-stream 回包;resolveStreamableContentType 纯函数协商' },
  { id: 'transport-streamable-http-last-event-id', revision: '2025-03-26', role: 'server', required: true, implemented: true, evidence: 'mcpHttpServer.js 维护每会话事件日志;GET /mcp 带 Last-Event-ID 时重放;replayEventIdsAfter 纯函数' },

  // ── 2025-06-18 / 2025-11-25:按特性渐进落地 ──────────────────────────────
  { id: 'tool-output-schema-structured-content', revision: '2025-06-18', role: 'shared', required: false, implemented: true, evidence: 'toolDefToMcp 透传 outputSchema;toolResultToMcp 回 structuredContent' },
  { id: 'tool-annotations-passthrough', revision: '2025-06-18', role: 'server', required: false, implemented: true, evidence: 'toolDefToMcp 透传 annotations(readOnlyHint/destructiveHint)' },
  { id: 'authorization-www-authenticate', revision: '2025-06-18', role: 'server', required: false, implemented: true, evidence: 'mcpHttpServer.js 401 + WWW-Authenticate (RFC 9728)' },
  { id: 'client-capability-sampling', revision: '2025-06-18', role: 'client', required: false, implemented: false, evidence: '需把服务端推理请求路由到本地 AI 网关(额度/审计)' },
  { id: 'client-capability-elicitation', revision: '2025-06-18', role: 'client', required: false, implemented: false, evidence: '需交互式 UI,MCP client 常运行在非交互上下文' },
  { id: 'transport-streamable-http-origin-403', revision: '2025-11-25', role: 'server', required: false, implemented: true, evidence: 'mcpHttpServer.js isAllowedOrigin -> 403' },
  { id: 'schema-dialect-json-schema-2020-12', revision: '2025-11-25', role: 'shared', required: false, implemented: false, evidence: '透传 khy 工具自带的 draft-07 风格 schema,未强制 2020-12' },
  { id: 'authorization-oauth-resource-server', revision: '2025-06-18', role: 'server', required: false, implemented: false, evidence: '仅静态 bearer token,未接 OAuth 授权服务器发现' },
]);

/**
 * 声明支持、且**必需特性全部落地**的协议修订(稳定排序)。
 * 服务端 initialize 只在 `SUPPORTED_PROTOCOL_VERSIONS` 内协商;本函数是那份清单的
 * 可验证来源 —— 守卫断言二者一致,且每个声明修订的 required 特性都 implemented。
 * @returns {string[]}
 */
function declaredRevisions() {
  return [...SUPPORTED_PROTOCOL_VERSIONS];
}

/**
 * 某个修订是否**全部必需特性**都已实现。
 * @param {string} revision
 * @returns {boolean}
 */
function isRevisionFullyImplemented(revision) {
  const rows = PROTOCOL_CONFORMANCE.filter((f) => f.revision === revision && f.required);
  return rows.length > 0 && rows.every((f) => f.implemented);
}

module.exports = {
  isServeEnabled,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION_HEADER,
  DEFAULT_ASSUMED_VERSION,
  SERVER_NAME,
  ERROR_CODES,
  PROTOCOL_CONFORMANCE,
  declaredRevisions,
  isRevisionFullyImplemented,
  serverInfo,
  negotiateProtocolVersion,
  checkProtocolVersionHeader,
  resolveStreamableContentType,
  replayEventIdsAfter,
  parseMessage,
  buildResult,
  buildError,
  buildInitializeResult,
  toolDefToMcp,
  toolResultToMcp,
  dispatch,
};
