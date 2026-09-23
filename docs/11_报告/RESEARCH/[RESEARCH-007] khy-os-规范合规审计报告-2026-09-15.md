# khy-os 规范合规审计报告

- **审计日期**：2026-09-15
- **审计对象**：`D:\Portable\khy-os` 第一方源码
- **审计范围界定**：排除 `.research-tmp/`（opencode 等第三方参考代码）、`node_modules/`、`dist-ts/`、`docs/**/*.html`（markdown 副本）。所有结论均基于第一方源码。
- **方法**：静态代码审计 + 关键行为实测（Node 22.22.2 运行时验证）

## 严重度定义

| 级别 | 含义 |
|------|------|
| **P0** | 可被利用的安全缺陷，或造成不可逆数据/系统风险 |
| **P1** | 明确的规范违反，导致互操作失败、静默失败或功能不可用 |
| **P2** | 规范偏离，影响健壮性 / 可维护性 / 可观测性 |
| **P3** | 文档不一致、命名与行业惯例偏差 |

## 总体结论

**khy-os 的规范合规呈现明显的"三档分化"：**

1. **MCP —— 工具面扎实，协议面有硬缺口。** 工具注册、权限门控、名称归一化防注入、注解驱动权限映射都做得很规范，甚至优于多数实现；但**协议生命周期（版本协商、能力声明）与 Streamable HTTP 传输层存在明确违反规范之处**，其中 HTTP 服务端缺 `Origin` 校验是 P0 安全缺陷。

2. **A2A —— "名义合规"。** 存在两套互不相通的东西：一个真正的 A2A 出站客户端（约 127 行，很薄），和一套**借 A2A 之名的私有 ACP JSON-RPC 方言**（被 14 个内置 agent、registry、router、facade 大量引用）。后者与 A2A 规范毫无关系。真正的 A2A 客户端本身也有字段错误与一个**实测确认的必然失败缺陷**。

3. **工具调用循环 —— 全仓工程实现最强项。** 11 个死循环检测器、多路径终止条件、超时分层、AbortController 贯穿，完备度超过多数开源 agent 框架。缺口集中在**崩溃恢复（无 journal）与结果层校验**。

4. **安全横切面 —— 存在 2 个 P0。** 无鉴权的宿主控制端点 + 明文凭据落盘。

### 问题统计

| 严重度 | 数量 | 分布 |
|--------|------|------|
| P0 | **3** | MCP×1、安全×2 |
| P1 | **15** | MCP×4、A2A×7、工具循环×1、安全×3 |
| P2 | **16** | MCP×5、A2A×3、工具循环×4、数据格式×3、安全×1 |
| P3 | **7** | MCP×2、A2A×1、工具循环×3、错误处理×1 |
| **合计** | **41** | |

### 补丁状态总览

| 编号 | 问题 | 级别 | 状态 |
|------|------|------|------|
| M5 | MCP HTTP server 缺 Origin 校验 | P0 | ✅ 已修（附录 C.1） |
| S1 | 无鉴权宿主控制端点 | P0 | ✅ 已修（附录 C.2） |
| S2 | 凭据明文落盘 | P0 | ✅ 已修（附录 C.3） |
| A8 | A2A 客户端 undefined header 必然失败 | P1 | ✅ 已修（附录 D.1） |
| M2 | 客户端能力声明错误 | P1 | ✅ 已修（附录 D.2） |
| M3 | 不响应服务端请求 | P1 | ✅ 已修（附录 D.2） |
| M1 | 协议版本无协商 | P1 | ✅ 已修（附录 D.3） |
| M4 | 无条件调用未声明能力 | P2 | ✅ 已修（附录 D.4） |
| M8 | 401 缺 `WWW-Authenticate` + `?token=` 传令牌 | P1 | ✅ 已修（附录 E.1） |
| M6 | 未处理 `MCP-Protocol-Version` 头 | P1 | ✅ 已修（附录 E.2） |
| M7 | Streamable HTTP 会话不校验 | P1 | ✅ 已修（附录 E.2） |
| T1 | 主循环无 journal，崩溃无法精确恢复 | P1 | ✅ 已修（附录 F） |
| 其余 29 项 | — | P1×7 / P2×15 / P3×7 | ⬜ 待处理 |

> 修复口径：只改「不合规」的部分，不动业务语义；每项都补测试并跑回归。
> 具体改动、实测数据与残余风险见附录 C（P0）与附录 D（P1/P2）。

---

# 第一部分：MCP（Model Context Protocol）合规审计

**对照规范版本**：MCP 2025-06-18（当前）、2025-03-26（Streamable HTTP 引入）、2024-11-05（历史 HTTP+SSE）

## 1.1 违规项清单

### M1 — 协议版本硬编码 2024-11-05，全链路无版本协商 【P1】

**证据**：
- `services/backend/src/services/domain/messaging/mcp/mcpServerProtocol.js:49` — `const PROTOCOL_VERSION = '2024-11-05';`
- `services/backend/src/services/domain/messaging/mcp/index.js:43` — 同名常量**在客户端侧独立重复定义**
- `mcpServerProtocol.js:135-141` — `buildInitializeResult(opts)` **完全不读取** `params.protocolVersion`，无条件返回固定版本
- `index.js:578-580`、`:644-646` — 客户端握手后只取 `capabilities` / `serverInfo` / `instructions`，**从不读取服务端返回的 `protocolVersion`**

**违反规范**：
- MCP Lifecycle §*Version Negotiation*：客户端在 `initialize` 中发送其支持的最新版本；服务端若支持则回同版本，否则回自己支持的版本；**客户端若无法支持服务端返回的版本，必须断开连接**。
- 服务端**必须**基于客户端请求的版本做协商，而非无条件回固定值。

**影响**：
- 任何符合 2025-03-26 / 2025-06-18 的客户端连接 `khy mcp serve`，收到 `2024-11-05` 应答后按规范应断开 → **khy 作为 MCP server 事实上只对旧客户端可用**。
- 客户端侧同样不检测版本不匹配，属于"静默降级"，掩盖真实的不兼容。
- 两处常量独立维护，无单一真源 → 已构成漂移风险（AGENTS.md 工程规则 1「零硬编码」的同类问题）。

**整改**：抽出单一真源常量；`buildInitializeResult` 接收并回显客户端版本（若不支持则回自己最高版本）；客户端在 `_handleMessage`/握手返回处比对版本，不匹配时发出明确警告或断开。

---

### M2 — 客户端能力声明错误：把服务端能力当客户端能力上报 【P1】

**证据**（三处重复，无共享常量）：
- `index.js:523-527`（stdio）、`:574`（Streamable HTTP）、`:641`（传统 SSE）

```js
capabilities: {
  tools: {},
  resources: {},
  prompts: {},
},
```

**违反规范**：
MCP `ClientCapabilities` 的合法字段为 `experimental` / `roots` / `sampling` / `elicitation`。`tools`、`resources`、`prompts` 是 **ServerCapabilities** 字段，出现在客户端能力中属于**无效字段**。

**影响**：
- 服务端据此判断客户端**不支持** `roots` / `sampling`，会主动关闭服务端发起的 `sampling/createMessage`、`roots/list` 交互 → 功能被静默降级。
- 三处重复声明，修改时极易漏改。

**整改**：改为声明真实客户端能力（如 `roots: {}`、`sampling: {}`），并抽成单一常量。

---

### M3 — 客户端不响应服务端发起的请求（sampling / roots / elicitation）【P1】

**证据**：
- `index.js:950-973` — `_handleMessage(msg)` 仅处理三类：匹配 `_pendingRequests` 的响应、`notifications/tools/list_changed`、`notifications/resources/list_changed`
- 无任何对**入站 request**（有 `method` + `id`）的响应逻辑

**违反规范**：
MCP 是**双向**协议。服务端可向客户端发起 `sampling/createMessage`、`roots/list`、`elicitation/create` 等请求，**客户端必须返回响应**。

**影响**：
服务端发出请求后永远等不到响应（只会在自身超时后失败），相关能力形同虚设。同时 `_readSseResponse`（`index.js:851-852`）会把这类请求交给 `_handleMessage` 后**静默丢弃**。

**整改**：在 `_handleMessage` 中增加 request 分支，按 method 分派到 handler 并回写响应。

---

### M4 — 无条件调用 `resources/list` 与 `prompts/list`，不检查服务端能力 【P2】

**证据**：
- `index.js:705-715` — `_loadServerInventory()` 用 `Promise.allSettled` **并行无条件**发起三个请求：

```js
this._sendRequest('tools/list', {}),
this._sendRequest('resources/list', {}),
this._sendRequest('prompts/list', {}),
```

**违反规范**：
MCP 明确要求客户端 **MUST NOT** 调用服务端未声明支持的能力接口。

**讽刺的自证**：khy 自己的 server 端**诚实地只声明了 tools**（`mcpServerProtocol.js:138` — `capabilities: { tools: {} }`），而 khy 自己的 client 连上去就会发 `resources/list` 与 `prompts/list`，必然收到 `-32601 Method not found`。**自家 client 违反自家 server 的诚实声明**，这是最直接的证据。

**影响**：
- 向不支持的服务端发无效请求（浪费往返、污染服务端日志）。
- `Promise.allSettled` 吞掉失败原因，**无法区分"服务端不支持该能力"与"请求真的失败了"**，掩盖真实故障。

**整改**：先读 `this.capabilities`，仅对已声明能力发起对应 list 请求。

---

### M5 — Streamable HTTP 服务端缺 `Origin` 校验（DNS rebinding 防护缺失）【P0】

**证据**：
- `services/backend/src/services/domain/messaging/mcp/mcpHttpServer.js:142-224` — 完整请求处理流程中**无任何 `Origin` 头读取或校验**
- `:151-154` 仅有 token 校验

**违反规范**：
MCP Streamable HTTP 传输规范明确要求：服务端 **MUST** 校验 `Origin` 头，以防止 DNS rebinding 攻击（规范原文要求 validate Origin header to prevent DNS rebinding attacks）。

**影响（这是本次审计最严重的安全发现之一）**：
- khy 的 MCP server 默认暴露**全量工具，含 shell 执行与文件写入**（`mcpHttpServer.js:12-13` 自述："khy 暴露全量工具（含 shell/文件写），绝不裸奔上网"）。
- 当绑定在 `127.0.0.1`（默认）时，**任何用户访问的恶意网页**都可以通过 `fetch('http://127.0.0.1:3737/mcp', ...)` 向本机 MCP server 发送 `tools/call`，执行任意 shell 命令。
- 缺 `Origin` 校验使浏览器成为攻击跳板，loopback 绑定**并不构成安全边界**。

**整改**：校验 `Origin` 头，仅允许白名单来源（或对无 Origin 的非浏览器客户端放行）；对不合规来源返回 403。

---

### M6 — 未处理 `MCP-Protocol-Version` 请求头 【P2】

**证据**：
- `mcpHttpServer.js` 全文无 `MCP-Protocol-Version` 头读取（仅 `:206` 读 `mcp-session-id`）

**违反规范**：
MCP 2025-06-18 要求 Streamable HTTP 客户端在**所有**请求中携带 `MCP-Protocol-Version` 头；服务端在收到无该头的请求时，应假定为 `2025-03-26`，或对不支持的版本返回 `400 Bad Request`。

**影响**：无法感知客户端的协议版本，与 M1 叠加后造成版本协商彻底失效。

---

### M7 — 会话机制为"伪会话"：签发但不校验 【P2】

**证据**：
- `mcpHttpServer.js:206-207`

```js
const sid = req.headers['mcp-session-id'] || `khy-${++sessionSeq}`;
headers['Mcp-Session-Id'] = sid;
```

**问题**：
1. 服务端**不保存**任何会话状态（注释 `:125` 明确说会话表仅用于传统 SSE 回信）。
2. 客户端传来的任意 `Mcp-Session-Id` 都被原样回显，**从不校验有效性**。
3. 未知/已失效的 session id 应返回 `404 Not Found`（规范要求），当前一律 `200`。

**影响**：会话语义不可信；客户端无法判断会话是否已失效（例如服务端重启后）。

---

### M8 — 401 响应缺 `WWW-Authenticate` 头；支持查询串传令牌 【P1】

**证据**：
- `mcpHttpServer.js:151-154` — 401 响应体为 `{ error: 'unauthorized: ...' }`，**无 `WWW-Authenticate` 头**
- `mcpHttpServer.js:86-88` — 显式接受 `?token=` 查询串传令牌

```js
if (r.queryToken && String(r.queryToken) === token) {
  return true;
}
```

**违反规范/最佳实践**：
- MCP 授权规范要求 `401 Unauthorized` 响应携带 `WWW-Authenticate` 头，客户端据此发现授权服务器。
- 令牌置于 URL 查询串会进入**服务器访问日志、浏览器历史、Referer 头、代理日志**，是 OWASP 明确列为反模式的凭据传递方式。

**影响**：令牌泄露面扩大；标准 MCP 客户端无法完成 OAuth 发现流程。

---

### M9 — 两种传输混用同一端点，客户端无法按规范区分 【P2】

**证据**：
- `mcpHttpServer.js:159` — `GET /` 或 `GET /sse` → 开 `text/event-stream`，发 `endpoint` 事件（这是 **2024-11-05 传统 HTTP+SSE** 传输）
- `mcpHttpServer.js:200` — `POST /` 或 `POST /mcp` → JSON 回包（这是 **2025 Streamable HTTP** 传输）

**问题**：
`GET /` 同时承担传统 SSE 的入口角色，而 `POST /` 是 Streamable HTTP。规范将两者定义为**互斥的传输方式**，客户端通过配置（`type: "sse"` vs `type: "http"`）选择，**不通过同端点的 HTTP 方法区分**。

**影响**：一个 Streamable HTTP 客户端对 `GET /` 发探测请求时，会意外挂上一条 SSE 流；反之传统 SSE 客户端可能误判端点。`index.js:568-584`（`_connectHttp`）与 `:595-650`（`_connectSse`）正是靠 `config.type` 区分，而非靠端点语义。

---

### M10 — JSON-RPC 2.0 入站不校验 `jsonrpc` 字段 【P3】

**证据**：
- `mcpServerProtocol.js:78-102` — `parseMessage` 校验了 JSON 合法性、对象类型、`method`、`id`，但**未校验 `obj.jsonrpc === '2.0'`**

**违反规范**：JSON-RPC 2.0 要求成员 `jsonrpc` **必须**精确为字符串 `"2.0"`。回包侧（`:111`、`:126`）始终写入 `'2.0'`，入站却不校验。

**影响**：接受畸形请求（如 `{jsonrpc:'1.0',...}`），协议一致性不完整。

---

### M11 — 工具结果折叠为文本时丢失结构（`[object Object]`）【P2】

**证据**：
- `mcpServerProtocol.js:184-188`

```js
const text = r.content != null ? r.content : r.error != null ? r.error : '';
return { content: [{ type: 'text', text: String(text) }], isError };
```

**问题**：当 `result.content` 是**对象或数组**（非 MCP 原生 `content` 数组形）时，`String(obj)` 产出 `"[object Object]"`，**数据静默损坏**。

**影响**：khy 工具返回结构化结果经 MCP server 暴露给外部客户端时，接收方拿到无意义的 `[object Object]`。属于数据保真缺陷。

**整改**：对非字符串内容做 `JSON.stringify` 而非 `String`。

---

### M12 — `_unwrapRpc` 无匹配时静默返回 `undefined` 【P3】

**证据**：
- `index.js:866-874` — 若响应既无 `error` 也不匹配 `id`，落到 `return msg && msg.result`（即 `undefined`），不抛错、不告警

**影响**：协议错乱（如服务端回错 id）时，调用方拿到 `undefined` 而非明确错误，故障被掩盖。

---

## 1.2 MCP 合规亮点（应保留）

| 亮点 | 证据 |
|------|------|
| 工具名归一化防注入/防碰撞 | `types.js:121-123` — 非 `[A-Za-z0-9_-]` 字符全替换为 `_`，确保 `mcp__server__tool` 分隔符不被破坏 |
| 注解驱动权限映射 | `types.js:150-154` — `readOnlyHint` / `destructiveHint` 显式映射到 `isReadOnly` / `isDestructive`，缺失时**不猜测**，交由权限层决策 |
| `tools/call` 不开后门 | `mcpServer.js:14-15`、`:78-80` — 与本地模型调工具走**同一条**权限门控（`--allowedTools` / 风险闸） |
| 非 loopback 无 token 拒绝启动 | `mcpHttpServer.js:54-67` — 安全默认设计正确 |
| 请求体大小上限 | `mcpHttpServer.js:272` — 4MB 保护 |
| JSON-RPC 标准错误码使用正确 | `mcpServerProtocol.js:53-59` — -32700/-32600/-32601/-32602/-32603 全部正确 |
| capabilities 诚实不虚报 | `mcpServerProtocol.js:130` 注释与 `:138` 实现一致，只声明已实现的 tools |
| 请求级超时 | `index.js:744-754` — 每个 pending 请求独立超时并清理 Map，无泄漏 |
| 传输解耦 | `mcpServerProtocol.js`（纯函数）与 `mcpServer.js` / `mcpHttpServer.js` / `mcpStdioServer.js`（薄 IO）分层清晰，可确定性单测 |

---

# 第二部分：A2A（Agent-to-Agent）合规审计

**对照规范版本**：A2A Protocol v0.2.x / v0.3.x（Linux Foundation）

## 2.0 前置发现：两套" A2A "并存且互不相通 【P1】

这是理解 A2A 部分所有问题的关键前提。

| 实现 | 位置 | 性质 |
|------|------|------|
| **真 A2A 出站客户端** | `services/backend/src/services/a2a/index.js`（127 行） | 使用 A2A 风格 REST 路径（`/.well-known/agent-card.json`、`/v1/message:send`）、`role` + `parts[]`、Bearer 认证 |
| **私有 ACP 方言** | `acpTransport.js` / `a2aRegistry.js` / `a2aMessageRouter.js` / `a2aFacade.js` / `a2aAgentLifecycle.js` | **纯进程内私有 JSON-RPC 方言**，方法名 `agent.spawn` / `task.submit` / `message.send`，与 A2A 规范无关，仅**命名撞车** |

**证据**：
- `acpTransport.js:50-63` — `ACP_METHODS` 枚举为 `agent.spawn` / `agent.kill` / `agent.status` / `task.submit` / `task.result` / `task.progress` / `context.share` / `tool.invoke` / `tool.result` / `message.send` / `message.broadcast` / `heartbeat`
- `acpTransport.js:80` — `ACP_PROTOCOL_VERSION = '1.0'`（私有版本号）
- `acpTransport.js:6-14` — 自述支持 ipc / ws / http 三种通道，**全为进程内或自建**

**违反规范**：A2A 定义的方法集为 `message/send`、`message/stream`、`tasks/get`、`tasks/cancel`、`tasks/pushNotificationConfig/set` 等。上表方法名**无一匹配**。

**影响**：内部代码（含 14 个内置 agent 注册）大量引用 `a2a*` 命名，造成"已实现 A2A"的错觉；实际与 A2A 互操作无关。

---

## 2.1 违规项清单

### A2 — 无 Agent Card 服务端托管端点 【P1】

**证据**：
- 全仓 `.well-known` 仅出现在 `a2a/index.js:48`（**出站拉取**）
- `services/backend/src/routes/` 下搜索 `a2a` 零命中 → **无服务端路由**
- `a2a/index.js:85-106` 的 `createLocalAgentCard()` 只返回一个**本地对象**，从未被任何 HTTP 端点托管

**违反规范**：A2A 要求 agent 在 `/.well-known/agent-card.json`（v0.3）或 `/.well-known/agent.json`（v0.2.x）**发布** Agent Card，供外部发现。

**影响**：khy **无法被任何外部 A2A agent 发现或调用**，互操作仅为单向出站。

---

### A3 — Agent Card 字段不符规范 【P1】

**证据**：`a2a/index.js:94-104`

```js
capabilities: {
  streaming: true,           // ← 空声明：全仓无 SSE 实现
  pushNotifications: false,
  stateTransitionHistory: true,  // ← 无对应实现
},
authentication: {
  schemes: ['bearer'],       // ← 字段名非标准
},
skills: options.skills || [],  // ← 默认空数组
```

**违反规范**：
1. `authentication.schemes` **不是** A2A 字段。A2A 使用 `securitySchemes`（OpenAPI 风格的安全方案定义）+ `security`（引用列表）。
2. 缺 `protocolVersion`、`provider`、`documentationUrl` 等规范字段。
3. **`streaming: true` 是能力虚报**——全仓搜索 `message/stream`、`TaskStatusUpdateEvent`、`TaskArtifactUpdateEvent` **零命中**。这与 MCP 部分"诚实不虚报"的做法形成鲜明对比，属同一仓库内的标准不一致。

**影响**：外部 agent 依此卡片能力协商时会选择流式交互，随后必然失败。

---

### A4 — 任务生命周期状态集私有，无标准 TaskState 【P1】

**证据**（三套互不相同的私有状态机）：

| 位置 | 状态集 |
|------|--------|
| `a2aAgentLifecycle.js:21-32` | `pending` / `spawning` / `running` / `waiting` / `completing` / `completed` / `failed` / `killing` / `killed` / `timed_out` |
| `subAgentOrchestrator.js:26-34` | `created` / `running` / `waiting` / `completed` / `failed` / `killed` / `timed_out` |
| `domain/state/stateMachine/agentLifecycle.js:22-30` | `created` / `initializing` / `ready` / `running` / `completed` / `error` / `killed` |

**违反规范**：A2A `TaskState` 为 `submitted` / `working` / `input-required` / `completed` / `canceled` / `failed` / `unknown` / `rejected` / `auth-required`。**上述三套状态集中，仅 `completed` / `failed` 两个词与规范重合**，且语义不等价（如 A2A 的 `input-required` 表示需要补充输入，khy 无对应态）。

**附加缺陷**：`a2aAgentLifecycle.js` 的状态赋值（`:157`、`:161`、`:192`、`:195`、`:218`、`:223`、`:251`）**直接赋值，无迁移合法性校验**。仅 `agentLifecycle.js:46-68` 有迁移表，且 `fsm.js:118-146` 对非法迁移**只记录不抛错**。

**影响**：无法与任何标准 A2A 实现交换任务状态；状态机可能进入非法态且无人察觉。

---

### A5 — 无 `tasks/cancel` 操作 【P1】

**证据**：
- `A2ATool/index.js:36` — 操作枚举**不含** `cancel`
- `a2a/index.js` 导出仅 `getAgentCard` / `sendMessage` / `createTask` / `getTask` / `createLocalAgentCard` / `listProviders`，**无 `cancelTask`**
- 内部仅 `a2aAgentLifecycle.js:177` 的 `kill()`，属进程管理操作，**非协议操作**

**违反规范**：A2A 要求实现 `tasks/cancel`，使调用方可取消已提交任务。

**影响**：长任务无法通过协议取消，只能强杀进程。

---

### A6 — 无流式传输（`message/stream` 及状态/产物更新事件）【P1】

**证据**：全仓 `message/stream`、`TaskStatusUpdateEvent`、`TaskArtifactUpdateEvent` **零命中**。
`subAgentTextStream.js:3-22` 是**进程内 TUI 事件**（`agent_text`），非协议流。

**违反规范**：A2A 定义 SSE 流式接口，通过 `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent` 推送增量。

**影响**：与 A3 的 `streaming: true` 声明直接矛盾。

---

### A7 — `createTask` 请求体字段错误 【P2】

**证据**：`a2a/index.js:70-73`

```js
return _request(`${agentUrl}/v1/tasks`, 'POST', {
  id: options.taskId || `task_${Date.now()}`,
  messages: [{ parts: [{ text: task }], role: 'user' }],
  metadata: options.metadata || {},
}, ...);
```

**违反规范**：
- A2A 的任务创建经由 `message/send`，请求体为 `{ message: {...}, configuration?: {...}, metadata?: {...} }`。
- **无顶层 `id`**（任务 id 由服务端生成）。
- **无 `messages` 数组**（单数 `message`）。
- 对比：同文件的 `sendMessage`（`:54-60`）字段是**正确**的（`message: { messageId, parts, role }`）。**同一文件内两种风格并存**，说明 `createTask` 是未经校验的私有扩展。

**影响**：`createTask` 无法与任何标准 A2A agent 互通。

---

### A8 — 【实测确认】`sendMessage` / `createTask` 在未配置 API key 时必然失败 【P1】

**证据**：`a2a/index.js:52-65`

```js
async function sendMessage(agentUrl, message, options = {}) {
  const apiKey = _env('API_KEY');
  return _request(`${agentUrl}/v1/message:send`, 'POST', {...}, {
    'Authorization': apiKey ? `Bearer ${apiKey}` : undefined,   // ← undefined
    'X-User-Id': options.userId,                                 // ← 未传则 undefined
  });
}
```

配合 `:16-43` 的 `_request`，`try` 块包裹了 `lib.request(...)`，而 `catch` 将其降级为：

```js
} catch (e) {
  resolve({ status: 0, error: e.message });   // :40-42
}
```

**实测验证**（Node v22.22.2）：

```
Authorization=undefined: THROWS -> ERR_HTTP_INVALID_HEADER_VALUE
X-User-Id=undefined: THROWS -> ERR_HTTP_INVALID_HEADER_VALUE
no undefined: NO THROW (request object created)
```

**结论**：Node 的 `http.request` 对 `undefined` 值的 header **同步抛 `ERR_HTTP_INVALID_HEADER_VALUE`**。因此：
- 未配置 `KHY_A2A_API_KEY` 时，`sendMessage` 与 `createTask` **100% 失败**；
- 未传 `options.userId` 时，`sendMessage` **同样 100% 失败**；
- 失败被静默吞成 `{ status: 0, error: 'Invalid value "undefined" for header "..."' }`，调用方拿到 `status: 0`，**难以定位是网络问题还是本地参数问题**。

**严重度说明**：这是本次审计中**唯一经运行时实测确认的功能性缺陷**。出站 A2A 通信在默认配置下完全不可用。

**整改**：构造 headers 时过滤 `undefined` / `null` 值（`Object.entries().filter(([,v]) => v != null)`）。

---

### A9 — `initializeA2A` 为死代码，14 个内置 agent 注册从不执行 【P2】

**证据**：
- `a2aInit.js:19` 定义、`:171` 导出
- 全仓 Grep `initializeA2A` 仅命中这两处（**无任何调用方**）
- 其 `_registerBuiltinAgents`（`:76-101`）注册的 14 个 agent（基本面/技术面/情绪面分析师、多空研究员、交易决策师、风控经理、协调者、探索者、规划者、审计者、修复者、研究员）

**影响**：这些内置 agent 的注册逻辑**在真实运行中从不生效**；子系统改由 `getA2A()` 懒加载（`agentCommunicationService.js:84-113`、`teammateBus.js:39-50`、`externalAgentDirective.js:277,306`）。启动初始化与懒加载两套路径并存，且启动路径是死的。

---

### A10 — 无任务持久化 / 跨进程能力 【P2】

**证据**：
- `a2aRegistry.js:49`（内存 Map）、`a2aMessageRouter.js:53`、`a2aAgentLifecycle.js:71`

**影响**：agent 注册表、消息路由队列、生命周期状态**全部驻留内存**，进程重启即清零，且**无法跨进程/跨主机**。与 A2A"跨厂商、跨网络"的设计目标相去甚远。

---

### A11 — ACP 错误码落在 JSON-RPC 惯例区间之外 【P3】

**证据**：`acpTransport.js:67-77`

```js
AGENT_NOT_FOUND: -40001,
AGENT_BUSY: -40002,
TIMEOUT: -40003,
CHANNEL_CLOSED: -40004,
```

**说明**：JSON-RPC 2.0 保留 `-32768` 至 `-32000` 区间给预定义错误。`-40001` 等值**不违反规范的硬性禁止**（规范未禁止其他数字），但**偏离行业惯例**——生态（含 MCP 的 `-32002 ResourceNotFound`）普遍在 `-32000` ~ `-32099` 内定义实现级错误码。使用 `-400xx` 会与生态工具的错误码解析逻辑产生冲突风险。

---

## 2.2 A2A 合规亮点（应保留）

| 亮点 | 证据 |
|------|------|
| **有 JSON Schema 契约 + 运行时校验** | `contracts/acp/acp-message.schema.json`，`acpTransport.js:20-46` 加载并按 `METHOD_PARAM_DEF` 做参数校验——这是全仓**唯一**做到"契约即代码"的协议层 |
| 防失控资源限制 | `a2aAgentLifecycle.js:36-42` — `maxDepth: 3`、`maxChildren: 10`、`agentTimeoutMs: 300_000`、`maxTotalAgents: 50` |
| 注册表健康检查 | `a2aRegistry.js` 心跳 + `agent:unhealthy` / `agent:recovered` 事件 |
| 路由具备死信机制 | `a2aInit.js:46-52` — `maxRetries` / `retryDelayMs` / `maxQueueSize` / `deadLetterEnabled` |
| 出站 `sendMessage` 消息体合规 | `a2a/index.js:54-60` — `message: { messageId, parts: [{text}], role: 'user' }` 结构正确 |
| 凭据不硬编码 | `a2a/index.js:12-14` 从 `KHY_A2A_*` 环境变量读取；`:92` 端口取自 `serviceDefaults.BACKEND_PORT`（符合 AGENTS.md 零硬编码规则） |

---

# 第三部分：工具调用循环的完整性校验与终止条件

用户问题包含两个层面：**（a）现状如何**；**（b）如何通过规范确认循环的完整性与终止条件**。以下分别回答。

## 3.1 现状：机制完备度（全仓最强项）

### 主循环

**证据**：`services/backend/src/services/toolUseLoopCore.js:3280`

```js
while (!budget.depleted || _gracePending) {
```

入口 `runToolUseLoop` 在 `:1866`。循环条件**不依赖模型输出**，由 `IterationBudget`（`:519-546`）控制，属静态可判定的有界循环。

### 已实现的终止条件（多路径且均有记录）

| 终止原因 | 证据 |
|----------|------|
| 无 `tool_use` → 正常收尾 | `:6160` / `:7713`（breadcrumb `conclude`） |
| 达最大轮次 | `:11251-11286`（`maxIterationsReached` / `truncated`） |
| 绝对超时 | `:3466-3492`（`KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS`，默认 1,200,000ms，`0`=禁用） |
| 空闲超时 | `:3497-3536`（活动感知宽限 30,000ms，`:3125-3128`） |
| 用户中断 | `:3383-3457`（`interrupted` / `cancelled`） |
| Token 预算硬停 | `:3340-3379`（`budgetStopped`） |
| 连续失败阈值 | `MAX_CONSECUTIVE_FAILURES = 3/5`（`:3016`、`:11125`、`:11215-11224`） |
| PostToolUse hook 停机 | `:3310-3332` |
| 全量去重卡死（连续 2 轮） | `:10939-10967` |

### 轮次上限

**证据**：`:346` `const MAX_ITERATIONS = 100;`，`_resolveMaxIterations`（`:850-869`）优先级为
`options.maxIterations` → `KHY_TOOL_LOOP_MAX_ITERATIONS` → 默认 100，并 clamp 到 `[minSafe, 100]`（`minSafe` 动态 5-15，`:828-836`）。boost 叠加后封顶 200（`:2418-2429`）。

### 死循环检测：11 个检测器

**证据**：`services/backend/src/services/toolLoopDetector.js:4-25`

| # | 检测器 | 作用 |
|---|--------|------|
| 1 | `genericRepeat` | 同工具+同参数哈希反复出现 |
| 2 | `unknownToolRepeat` | 反复调用不存在的工具 |
| 3 | `noProgressStreak` | 同工具+参数+结果哈希（输出无变化） |
| 4 | `pingPong` | 两个工具交替无进展 |
| 5 | `circuitBreaker` | 全局调用数硬上限（默认 50，`:42-43`） |
| 6 | `contentChanting` | AI 输出文本循环重复 |
| 7 | `readFileLoop` | 过度读取类调用（含冷启动门控） |
| 8 | `actionStagnation` | 同名工具反复，含**参数多样性抑制**（高区分度参数比不阻断） |
| 9 | `shellIntentRepeat` | 同 shell 意图、不同语法 |
| 10 | `pathIntentRepeat` | 同路径跨工具/跨语法访问 |
| 11 | `webRetrievalFailureStreak` | 连续失败的网页抓取（"死亡之握"） |

严重度分级：`ok` → `warning` → `critical` → `circuit_breaker`。调用点 `:8193`、`:9120`。

### 超时与取消

- 单工具超时：`toolCalling.js:2516-2568`（`Promise.race`，默认 120,000ms，`KHY_TOOL_EXEC_TIMEOUT_MS` 可覆盖，支持 per-call `timeoutMs`）
- 取消链路：`parentAbort` / 外部 signal（`:2274-2293`）→ sibling（`:2331-2359`）→ `traceContext.abortSignal` → `toolCalling.js:1661-1672` + `attachAbortRace`（`:2536`）

### 入参校验

- registry `.validate()`（`toolCalling.js:2694-2760`）
- builtin `validateParams`（`:2768-2817`，基类 `_baseTool.js:293`）
- 校验失败返回 `{success:false, error, canRetry, hint}` **回灌模型**（自愈设计，很好）
- 未知参数按 schema 过滤（`:2660-2671`）
- 工具名纠正：`toolCallCorrection.js:66-117`

## 3.2 缺口清单

### T1 — 主循环无 journal / 逐轮持久化，崩溃后无法精确恢复 【P1】

**证据**：
- `orchestrationJournal.js` **仅**被 `orchestrationService.js:28/144` 引用（子代理编排），`toolUseLoopCore.js` **零引用**
- 主循环仅暴露 `onCheckpoint` 回调（每 3 轮 / 45s，`:10919-10935`；中断时 `:3387-3402`）
- 落盘实现：`agenticHarnessService.js:388-416` → `boulderState.js`（`<dataHome>/boulder/<md5(cwd)>.json`，24h TTL）
- 恢复为"快照拼回 prompt"，**非精确重放**；且**按 cwd 单槽覆盖**——同一目录下并发会话会互相覆盖

**影响**：长任务（接近 100 轮）中途崩溃，只能靠粗粒度快照恢复；同目录并发任务存在**检查点互相覆盖**风险。

---

### T2 — 工具返回结果无 schema 校验 【P2】

**证据**：全仓无 `outputSchema` / `validateResult` 用于**结果**层校验（入参有，结果没有）。

**影响**：工具返回畸形/超预期结果时，在结果层无拦截，直接回灌模型，可能污染后续推理。

---

### T3 — 畸形工具调用被静默丢弃 【P2】

**证据**：`toolCallParser.js:561-562` — JSON 解析失败时注释为 `skip malformed JSON`，**无告警、无重试、无状态记录**。

**影响**：模型产出的坏调用凭空消失，排查时无痕迹。与 T7（可观测性默认关闭）叠加后问题更隐蔽。

---

### T4 — 轮次上限文档与实现不符 【P3】

**证据**：
- JSDoc `:1837` — `@param {number} [options.maxIterations] - Safety limit on loop iterations (fallback: KHY_TOOL_LOOP_MAX_ITERATIONS or 10)`
- 实现 `:346` — `MAX_ITERATIONS = 100`

**影响**：文档说 10，实际 100（10 倍差异）。维护者据此估算成本会严重偏差。

---

### T5 — `KHY_TOOL_LOOP_MAX_ITERATIONS` 未登记 flagRegistry 【P3】

**证据**：`:850-869` 直接读 `process.env`，未走 `flagRegistry`（对比 `mcpServerProtocol.js:29-46` 的 `isServeEnabled` 正确走了注册表）。

**影响**：该 env 无集中登记、无类型校验、无上限声明，与仓库自身的 flag 治理约定不一致。

---

### T6 — 取消覆盖受门控，关闭即无工具级取消 【P2】

**证据**：abort 竞赛受 `KHY_TOOL_ABORT_SIGNAL` 门控（`toolCalling.js:2536` 附近）。

**影响**：门控关闭时，只剩单工具 120s 硬超时，用户中断无法及时传导到工具执行层。

---

### T7 — 可观测性默认关闭，且缺循环结束事件 【P2】

**证据**：
- breadcrumb 需 `KHY_LOOP_DEBUG` 才写（`:264-278`，**默认关**）
- 有 `traceAudit.logEvent('agent.loop.start')`（`:2080`），但**无对应的 `agent.loop.end`**

**影响**：默认配置下循环相位不可观测；有 start 无 end 使 trace 无法自动配对计算循环时长。

---

### T8 — 检测器文件头注释与实现不符 【P3】

**证据**：`toolLoopDetector.js:4` 标题为 `9-detector tool loop detection system`，但 `:9-22` 列出 **11** 个检测器。

---

## 3.3 【核心回答】如何通过规范确认循环执行的完整性与终止条件

现状是"有机制但无判定标准"。以下提出一套**可执行的循环完整性判定规范（LC-1 ~ LC-7）**，每条给出：判定问题 → 可观测信号 → 通过标准 → khy-os 当前判定结果。

### LC-1 有界性（Boundedness）

- **判定问题**：循环是否具备**不依赖模型输出**的静态上界？
- **可观测信号**：循环条件表达式中是否出现模型返回值；是否存在迭代计数器常量。
- **通过标准**：循环条件仅依赖本地计数器/预算对象；上限为命名常量且可配置、有 clamp。
- **khy-os 判定**：**通过** — `while (!budget.depleted || _gracePending)`，`MAX_ITERATIONS = 100` 且 clamp 到 `[minSafe, 100]`。

### LC-2 终止完备性（Termination Completeness）

- **判定问题**：每条退出路径是否都显式设置**终止原因**并落审计事件？
- **可观测信号**：退出点是否统一经由"设置 reason → 记录事件 → 返回"的收口函数。
- **通过标准**：终止原因取值来自**封闭枚举**；无裸 `break` / 裸 `return`；每个 reason 都能在 trace 中检索到。
- **khy-os 判定**：**部分通过** — 九类终止路径均有命名标记（`conclude` / `maxIterationsReached` / `interrupted` / `budgetStopped` 等），但**无 `agent.loop.end` 事件**（T7），无法在 trace 层闭环校验"每次 start 必有 end"。

### LC-3 进度性（Progress Guarantee）

- **判定问题**：如何证明循环在"前进"而非空转？
- **可观测信号**：是否存在"调用签名哈希 + 结果哈希"的进展度量；无进展的连续轮次是否被计数并触发终止。
- **通过标准**：定义"进展"为**新调用签名**或**结果哈希变化**；连续无进展 N 轮（N ≤ 8）必须触发告警并终止。
- **khy-os 判定**：**通过** — 检测器 1/3/4/8/9/10 覆盖，阈值 3-8，且检测器 8 有参数多样性抑制（避免误杀合法的批量操作）。

### LC-4 可恢复性（Recoverability）

- **判定问题**：崩溃后能否从确定的状态点续跑？
- **可观测信号**：是否每轮写 checkpoint；checkpoint 是否含"轮次 + 已完成调用 + 待办"；是否支持多会话隔离。
- **通过标准**：每轮结束必写；checkpoint 可重放（幂等）；**按会话而非按目录**分槽存储；TTL 与清理策略明确。
- **khy-os 判定**：**不通过** — 无逐轮 journal（T1）；checkpoint 每 3 轮 / 45s 一次；**按 cwd 单槽覆盖**，并发会话会互相覆盖。

### LC-5 可观测性（Observability by Default）

- **判定问题**：不设任何环境变量时，能否观测一次完整循环？
- **可观测信号**：`loop.start` / 每轮摘要 / `loop.end` 三事件是否**默认开启**。
- **通过标准**：三事件默认开启且可配对；token 累计与每轮耗时默认暴露。
- **khy-os 判定**：**不通过** — breadcrumb 需 `KHY_LOOP_DEBUG`（默认关）；缺 `loop.end`。

### LC-6 取消传播（Cancellation Propagation）

- **判定问题**：中断信号能否**无条件**抵达最内层工具执行？
- **可观测信号**：AbortSignal 的传递链路上是否存在 feature flag 门控。
- **通过标准**：取消是**安全属性**，不应受开关控制；无门控的取消链路 + 兜底硬超时。
- **khy-os 判定**：**部分通过** — 链路完整，但受 `KHY_TOOL_ABORT_SIGNAL` 门控（T6）。

### LC-7 结果保真（Result Integrity）

- **判定问题**：工具返回的数据在进入模型上下文前是否被校验与保真？
- **可观测信号**：是否存在结果层 schema 校验；结构化数据是否被无损传递。
- **通过标准**：结果经 schema 校验后才回灌；结构化内容不被字符串化损坏。
- **khy-os 判定**：**不通过** — 无结果层校验（T2）；MCP 暴露路径还会把对象折叠成 `[object Object]`（M11）。

### 判定结果汇总

| 规则 | 判定 | 关键缺口 |
|------|------|----------|
| LC-1 有界性 | ✅ 通过 | — |
| LC-2 终止完备性 | ⚠️ 部分 | 缺 `agent.loop.end` |
| LC-3 进度性 | ✅ 通过 | — |
| LC-4 可恢复性 | ❌ 不通过 | 无逐轮 journal、按 cwd 单槽覆盖 |
| LC-5 可观测性 | ❌ 不通过 | 默认关闭、缺结束事件 |
| LC-6 取消传播 | ⚠️ 部分 | 受 flag 门控 |
| LC-7 结果保真 | ❌ 不通过 | 无结果校验 |

**一句话**：khy-os 的工具循环在"**防止失控**"上做得很好（LC-1/LC-3），在"**证明它正确地跑完了**"上做得不够（LC-4/LC-5/LC-7）。前者是安全，后者是可信。

---

# 第四部分：其他规范漏洞（数据格式 / 安全认证 / 错误处理）

## 4.1 安全与认证

### S1 — 【P0】无鉴权的宿主控制端点

| 端点 | 证据 | 危害 |
|------|------|------|
| `POST /api/system/trigger-voice-input` | `server.js:593`（`/api/system` 无 auth 中间件）+ `routes/system.js:170` | 触发宿主机语音输入 |
| `POST /api/daemon/shutdown` | `aiManagementServer.js:246` + `routes/daemon.js:61` | 关闭守护进程 |
| `GET /api/system/network-info` | `routes/system.js:11` | 泄露局域网 IP |

**违反**：OWASP ASVS V4（访问控制）、行业通用的"默认拒绝"原则。

### S2 — 【P0，已修】凭据明文落盘

> **审计后修正（同日）**：初次判定时本项措辞过重，实测复核后收紧如下。原文称
> `channelApiCrypto` 的密钥回退"等同无加密"是不准确的 —— 该文件**已有**告警与诚实的
> 边界注释（`channelApiCrypto.js:7-10`、`:76-86`），且 `credentialGenerator.js:22-23`
> **已经**做了 `chmod 0o600`。真实缺口比初判窄。

| 位置 | 证据 | 实测结论 |
|------|------|----------|
| API key 池 | `apiKeyPool.js`（原 `:492` 传 `mode: 0o666`） | 明文存储属实；`0o666` 是**刻意的**兼容决定 —— `atomicWriteJson.js:79-82` 注释说明"换写入原语和改权限必须分批做"（多用户共享目录下收紧会让另一用户读不到） |
| 管理员凭据 | `credentialGenerator.js:9-12` | 明文属实，但**已** best-effort `chmod 0o600` |
| 本地 secret | `secretManagers/index.js:45` | **真实遗漏**：`writeFileSync` 未传 mode，且目录 `mkdirSync` 未设 0700 |
| 渠道密钥加密 | `channelApiCrypto.js:58-63` 主机名派生回退 | 有告警、有诚实注释；缺的是"拒绝降级"的强制手段 |

**违反**：OWASP ASVS V6（密码学存储）—— 明文凭据应由 OS 级凭据库（DPAPI / Keychain /
libsecret）或用户口令保护。本仓库**未发现 keytar / DPAPI / safeStorage 的使用**。

**威胁模型澄清**：这是本地桌面应用，`.khy/` 位于用户数据目录。真实威胁是「文件被复制
出本机」（备份、同步盘、恶意软件），而非"同机用户读取" —— 后者在 Windows 用户目录
ACL 下已部分缓解。因此**权限收紧只是缓解，真正的解法是加密存储**，那是独立工作量。

**已实施的补丁**（见附录 C）：默认权限收紧至 0600 且保留 env 退路；新增严格模式开关
让生产部署可拒绝弱密钥降级。

### S3 — 【P1】无鉴权的写文件与模型代理端点

- `/api/cache`（`server.js:584` → `routes/cache.js:10,13`）：可写文件
- `/api/llm`（`server.js:620`，freeLLM 8 个端点含 `/generate`）：免费模型代理，可被滥用

### S4 — 【P1】命令注入面（变量直接拼入 shell）

| 位置 | 代码 |
|------|------|
| `extensions/extensionManager.js:101` | `` execSync(`git clone --depth 1 ${url} ${dest}`) `` |
| `cliAnythingService.js:531/536/584` | `npm install -g ${pkg}` / `pip uninstall -y ...` |
| `containers/index.js:96` | `docker stop ${containerName}` |
| `commitMessageService.js:212` | `git add ${fileList}` |
| `cli/routerDispatchOps.js:526` | `` execSync(`${cmd} 2>&1`) `` |
| `cli/handlers/crossPlatform.js:323,330` | `findstr :${port}` / `taskkill /PID ${pid}` |

**对比亮点**：MCP stdio 启动用 `spawn(command, args, {stdio})` **无 shell**（`mcp/index.js:450`），做法正确。说明仓库内安全实践不统一。

### S5 — 【P1】CORS 默认 `'*'` 且与自述矛盾

- `aiManagementServer.js:749` 注释声称 `Wildcard '*' is never used`
- `aiManagementServer.js:752` 实际 `let origin = '*'` 为默认值
- `gateway/proxyServer.js:1055` 同样 `'*'` 兜底

**对比亮点**：monolith 侧 `server.js:325-342` 白名单正确（仅 localhost:START_PORT/8080/8090，`credentials: true`）。**同一仓库两套 CORS 策略**。

### S6 — 【P2】内部错误消息直出客户端

- `aiManagementServer.js:3373` — `` sendError(res, 500, `Internal error: ${err.message}`) ``
- 另 `:3299`、`:3307`、`:3351`、`:2401`、`:463`
- `aiManagementGatewayAdmin.js` 十余处 `sendError(res, 500, err.message)`
- `routes/daemon.js:33` 回 `e.message`

**对比亮点**：`platform/packages/shared/src/middleware/errorHandler.js:30-32` 正确（仅 development 回 stack）。**又是仓库内不一致**。

## 4.2 数据格式

### S7 — 【P2】无统一运行时 schema 校验

- 零依赖自实现 `services/domain/structured/output/jsonSchemaValidate.js`（`:10-12` 明确注释"刻意不用 ajv"）
- `express-validator` 仅 `routes/auth.js:5`、`routes/external.js:3` 两处
- 无 ajv / zod / joi 全局校验

**评价**：自实现校验器本身是**合理选择**（零依赖、确定性、可离线——符合本仓"零外部依赖"纪律）。问题在于**覆盖面**：MCP 的 `tools/list` 返回的 `inputSchema` 直接透传不校验（`types.js:148`），工具**结果**层无校验（T2）。

### S8 — 【P2】协议版本化不一致

- **有**：MCP（`mcp/index.js:522` 等 `protocolVersion`）、数据文件（`boulderState.js:291,397-472` 有 SCHEMA_VERSION + 逐版本迁移；`backupManifest.js:119,154`；`manifestLoader.js:68` 不符即抛）、渠道密文（`channelApiCrypto.js:18-20` 的 `v2:` 前缀 + 兼容读取）
- **无**：HTTP API 无 `/v1` 版本前缀

**评价**：数据文件的版本化做得**很好**（`boulderState.js` 有完整迁移链），HTTP API 层缺失，形成落差。

## 4.3 错误处理

### S9 — 【P3】错误码体系存在但不强制

- **有**：`platform/packages/shared/src/errorEnvelope.js:38-72` 统一 `CODES` 枚举（30+ 码）；`services/domain/security/failsafe/errorCodes.js:27-116` E01-E08；`utils/apiResponse.js:22,132` 委托 CODES
- **并存**：直接 `throw new Error('中文消息')`（如 `apiKeyPool.js:515`、`extensionManager.js:89,98`）

**评价**：有体系但无 lint / 守卫强制，属治理缺口。

### S10 — 【P2】读路径默认无边界

- `tools/inputValidators.js:282-284` — `validateReadAccess` **默认全局放行**，仅 `KHY_STRICT_READ_BOUNDARY=1` 才限制
- 对比亮点：写路径校验完备 — `validateNoPathTraversal`（`:190-256`，`path.resolve` + 分隔符锚定 + 敏感 home 写保护）、`FileWriteTool/index.js:76-90` 调 `validateNotUNCPath` + `validateNoPathTraversal`

**评价**：写保护严格、读保护默认关闭，不对称。

### 错误处理亮点

| 亮点 | 证据 |
|------|------|
| 全局错误中间件正确 | `errorHandler.js:30-32` 仅 development 回 stack |
| 未捕获异常兜底完整 | `daemonEntry.js:310,315`、`crashRecovery.js:436,492`、`agentWorkerEntry.js:213,218`、`streamInjector.js:188,191`、`replSession.js:1244` |
| 写路径校验完备 | `inputValidators.js:190-256` |
| 工具参数校验失败回灌模型自愈 | `toolCalling.js:2694-2817` |

---

# 第五部分：整改优先级路线图

## 立即处理（P0，建议当轮修）

| # | 问题 | 动作 |
|---|------|------|
| 1 | **M5** MCP HTTP 服务端缺 `Origin` 校验 | 增加 Origin 白名单校验；对不合规来源返回 403。这是本机 shell 暴露面的直接入口 |
| 2 | **S1** 无鉴权宿主控制端点 | 给 `/api/system`、`/api/daemon` 挂 `authMiddleware` |
| 3 | **S2** 凭据明文落盘 | 接入 OS 凭据库（Windows DPAPI / macOS Keychain / libsecret）；至少移除"主机名派生密钥"回退 |

## 高优先级（P1，建议本周）

| # | 问题 | 动作 |
|---|------|------|
| 4 | **A8** A2A 客户端 undefined header 必然失败 | 构造 headers 时过滤 `null`/`undefined`。**改动量极小、收益极大** |
| 5 | **M2** 客户端能力声明错误 | 改为 `roots` / `sampling` / `elicitation`，并抽成单一常量 |
| 6 | **M3** 不响应服务端请求 | `_handleMessage` 增加 request 分支 |
| 7 | **M1** 协议版本协商 | 抽单一真源；服务端回显/协商；客户端比对并告警 |
| 8 | **M8** 401 缺 `WWW-Authenticate` + `?token=` | 补响应头；移除查询串令牌（保留 header 方式） |
| 9 | **T1** 主循环无 journal | 接入逐轮 checkpoint；按**会话**而非 cwd 分槽 |
| 10 | **A2/A3/A4/A5/A6** A2A 规范字段与状态机 | 建议**先决定战略**：是"真做 A2A"还是"承认这是私有 ACP 并改名" |
| 11 | **S3/S4/S5** 端点鉴权、命令注入、CORS | 按表逐项修 |

## 中优先级（P2）

M4、M6、M7、M9、M11、T2、T3、T6、T7、A7、A9、A10、S6、S7、S8、S10

## 低优先级（P3）

M10、M12、A11、T4、T5、T8、S9

---

# 附录 A：仓库内标准不一致清单

本次审计最有价值的发现之一：**多处同类问题在仓库内存在"做对了"和"做错了"两个版本**。这说明问题不在能力，而在**治理与强制**。

| 维度 | 做对了 | 做错了 |
|------|--------|--------|
| MCP 能力声明 | server 端诚实只声明 tools（`mcpServerProtocol.js:138`） | client 端虚报 + 声明错字段（`index.js:523-527`） |
| A2A 能力声明 | — | 声明 `streaming: true` 但零实现（`a2a/index.js:95`） |
| CORS | monolith 白名单（`server.js:325-342`） | gateway 默认 `*`（`proxyServer.js:1055`） |
| 错误输出 | 全局中间件只回 stack in dev（`errorHandler.js:30-32`） | 管理服务直出 `err.message`（`aiManagementServer.js:3373`） |
| 命令执行 | MCP stdio 用 `spawn` 无 shell（`mcp/index.js:450`） | 扩展管理用 `execSync` 拼串（`extensionManager.js:101`） |
| 契约校验 | ACP 有 JSON Schema + 运行时校验（`acpTransport.js:20-46`） | MCP 结果层无校验；工具结果无校验 |
| flag 治理 | `isServeEnabled` 走 flagRegistry（`mcpServerProtocol.js:29-46`） | `KHY_TOOL_LOOP_MAX_ITERATIONS` 直读 env |
| 数据版本化 | `boulderState.js` 有完整迁移链 | HTTP API 无版本前缀 |

**建议**：仓库已有 `services/backend/scripts/archDebtScan.js` 做分层/巨石/循环依赖守卫。上述不一致**大多可静态检测**，建议扩展该守卫（或新增同类扫描器）覆盖：
1. 未挂鉴权的路由（对比路由注册表与 auth 中间件表）
2. `execSync` / `exec` 中出现模板字符串拼接
3. `catch` 块中 `resolve({status:0})` 类静默降级
4. CORS `origin` 字面量 `'*'`
5. `sendError(res, 5xx, err.message)` 模式

---

# 附录 B：审计方法与可复现性

- **静态审计**：逐文件精读 MCP 全部实现（`domain/messaging/mcp/` 共 2,602 行）、A2A 全部实现（`a2a*` / `acp*` / `a2a/index.js`）、工具循环核心（`toolUseLoopCore.js` 关键路径、`toolLoopDetector.js`）、安全横切面（路由注册、凭据、CORS、命令执行、校验器）
- **实测验证**：Node v22.22.2 验证 `undefined` header 行为（A8）
- **范围排除**：`.research-tmp/`（第三方参考）、`node_modules/`、`dist-ts/`、`docs/**/*.html`
- **未覆盖**：运行时动态行为（未起服务做端到端 MCP/A2A 互通测试）、前端 `apps/` 的 UI 层规范、`software/khyquant/` 业务逻辑

## 建议的后续动作

1. **补端到端互通测试**：用官方 MCP Inspector 连接 `khy mcp serve`，实测 M1/M5/M6/M7 的实际表现。
2. **A2A 战略决策**：明确"做真 A2A"或"承认私有 ACP 并改名"，避免继续维护两套命名撞车的实现。
3. **把本次判定规则沉淀为守卫**：LC-1 ~ LC-7 可部分静态化（LC-1 查循环条件、LC-5 查默认开启的 trace 事件、LC-7 查结果校验），纳入 CI。

---

# 附录 C：P0 补丁记录（2026-09-15）

三个 P0 已修复并验证。改动遵循仓库既有纪律：零硬编码、纯逻辑抽叶子、留回退退路。

## C.1 M5 — MCP HTTP server 补 Origin 校验

**改动**：`services/backend/src/services/domain/messaging/mcp/mcpHttpServer.js`
- 新增纯函数 `parseAllowedOrigins(env)` / `isAllowedOrigin(origin, env)`
- Origin 校验置于**鉴权之前**（不合规来源不应借响应差异探测令牌是否有效）
- 新 env `KHY_MCP_ALLOWED_ORIGINS`（逗号分隔）用于显式扩展白名单
- 启动横幅新增 Origin 策略显示

**判定口径**：无 Origin → 放行（MCP SDK / CLI / curl 不带该头）；http(s) 且 host 为
loopback → 放行；`null` / `file://` / 任意公网来源 → **拒绝**。

**端到端实测**（真实起 server，POST `/mcp`）：

| 请求 Origin | 结果 |
|-------------|------|
| `https://evil.example` | **403** `forbidden: origin not allowed` |
| `http://192.168.1.10:8090` | **403** |
| `http://localhost:5173` | 200 |
| （无 Origin） | 200 |
| `null` | **403** |

**测试**：`tests/services/mcp/mcpHttpServer.test.js` 新增 5 个用例（10/10 通过）。

## C.2 S1 — 宿主控制端点补鉴权

**改动**：
- `server.js` — `/api/system` 挂 `authMiddleware`（原为裸挂载）
- `src/middleware/originGuard.js`（**新增**，零依赖叶子）— `requireLoopback` + `originGuard`
- `src/middleware/auth.js` — re-export 上述守卫，保持既有引用路径可用
- `src/routes/daemon.js` — 挂 `requireLoopback, originGuard`

**为什么 daemon 路由不加 JWT**：其文件头注释说明该路由**必须**在用户拿到凭据前可用
（登录页要在"khychat 起不来"时拉起/停掉守护进程）。因此改为「保持公开，但仅本机 +
可信来源」——这是**有意的设计决策**，不是疏忽。

**为什么抽独立叶子模块**：`middleware/auth.js` 顶部 `require('../models')` 会拉入整条
ORM 初始化链。守卫寄生在那里会让 `tests/routes/daemon.test.js` 的单项加载从 0.34s
膨胀到 17s（实测）。抽叶子后该套件总耗时 **25.9s → 2.0s**。

**端到端实测**（真实挂载 `routes/daemon.js`）：

| 请求 | Origin | 结果 |
|------|--------|------|
| `POST /api/daemon/shutdown` | `https://evil.example` | **403** |
| `GET /api/daemon/status` | `https://evil.example` | **403** |
| `GET /api/daemon/status` | （无） | 200（正常路径未被破坏） |

**测试**：`tests/middleware/originGuard.test.js`（**新增**，11/11 通过）。

## C.3 S2 — 凭据存储加固

**改动**：
- `src/services/apiKeyPool.js` — 凭据文件 mode 由 `0o666` 改为经 `resolveCredentialsFileMode()`
  解析，**默认 0600**；新 env `KHY_CREDENTIALS_FILE_MODE` 可显式回退（留退路）
- `src/services/secretManagers/index.js` — 目录 `mkdirSync` 加 `mode: 0o700`；
  secret 文件写入加 `{ mode: 0o600 }` + `chmodSync` 修正已存在文件
- `src/services/channelApiCrypto.js` — 新增 `KHY_REQUIRE_CHANNEL_KEY_SECRET` 严格模式：
  开启后未配置主 KEK 即**抛错**，不再静默回退到主机名派生密钥

**刻意没做**：不改动明文存储本身。真正的解法是接入 OS 凭据库或用户口令加密，属独立
工作量；本轮只做「默认收紧 + 拒绝静默降级 + 保留退路」。

**测试**：`tests/security/credentialsHardening.test.js`（**新增**，8/8 通过）。

## C.4 回归结果

| 套件 | 结果 |
|------|------|
| `tests/services/mcp` + `tests/routes/daemon` + `tests/routeAuth.regression` + `tests/security`（jest） | **13 suites / 187 tests 全通过** |
| `tests/atomicWriteMigration.test.js`（node:test，最可能断言 mode 的用例） | **34 pass / 0 fail** |
| `mcpHttpServer.test.js`（node:test） | 10/10 |
| `originGuard.test.js`（node:test，新增） | 11/11 |
| `credentialsHardening.test.js`（node:test，新增） | 8/8 |
| eslint（改动文件） | **0 errors**（未新增既有 warnings） |

## C.5 遗留与残余风险

1. **`originGuard` 对 `null` / `file://` 放行**（为保 Electron 生产构建——其渲染进程
   `loadFile()` 的 Origin 即 `null`）。残余风险由 `requireLoopback` 兜底：攻击者需在
   目标机器上运行浏览器。**彻底关闭需引入登录前 token**，是独立工作量。
2. **凭据仍是明文**：权限收紧只缓解"被复制出本机"以外的场景。
3. **MCP 侧 `null` Origin 被拒**：若将来出现基于 `file://` 的 MCP 客户端，需将其加入
   `KHY_MCP_ALLOWED_ORIGINS`。
4. **Windows 上 `mode` 被忽略**：`0600` 仅在 POSIX 生效；Windows 依赖用户目录 ACL。

---

# 附录 D：P1 补丁记录（2026-09-15 第二批）

承接 P0 之后，按"性价比优先"处理三条 P1 与一条强相关的 P2。
其中 A2A 出站通信在默认配置下此前**完全不可用**，本次修复后恢复。

## D.1 A8 — A2A 客户端 undefined header（修好一条完整失效的链路）

**问题**：`a2a/index.js` 未配置 `KHY_A2A_API_KEY` 时传 `Authorization: undefined`，
未传 `userId` 时传 `X-User-Id: undefined`。Node 对 undefined 值的 header **同步抛**
`ERR_HTTP_INVALID_HEADER_VALUE`，被 `_request` 的 catch 吞成 `{ status: 0 }`。

**改动**：`src/services/a2a/index.js`
- 新增 `_cleanHeaders()`，在 `_request` **入口**统一过滤 `undefined` / `null` / `''`
  （入口级修复 —— 未来新增调用点不会再犯）
- 失败结果新增 `phase` 字段区分 `build` / `network` / `timeout`，不再让"参数问题"
  与"对端不可达"混在同一个 `status: 0` 里

**端到端实测**（真实本地 echo server）：

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| 无 API key + `sendMessage` | `status:0`（静默失败） | **200** |
| 无 API key + `createTask` | `status:0` | **200** |
| 有 API key | `status:0`（同样失败） | **200**，`Bearer` 正确透传 |
| 对端不可达 | `status:0`（原因不明） | `status:0` + `phase:'network'` |

**测试**：`tests/services/a2aSendHeaders.test.js`（**新增**，5/5）。

## D.2 M2 + M3 — MCP 客户端能力声明与服务端请求响应

二者必须一起修：**声明了能力却不响应，比不声明更糟**。

**M2 改动**（`mcp/index.js`）：
- 三处内联的 `{ tools: {}, resources: {}, prompts: {} }` → 单一常量 `CLIENT_CAPABILITIES`
- 内容改为 `{ roots: {} }` —— 只声明**真正实现了**的能力。原字段（tools/resources/prompts）
  是 **ServerCapabilities**，出现在客户端能力里属无效字段，且会让服务端误判本客户端不支持
  roots/sampling，从而主动关闭服务端发起的交互。
- 刻意**不声明** `sampling` / `elicitation`（前者需把推理请求转给本地 AI 网关、涉及额度与审计；
  后者需交互式 UI，而 MCP client 常运行在非交互上下文）。**不做能力虚报。**

**M3 改动**（`mcp/index.js`）：
- `_handleMessage` 新增"服务端请求"分支（有 `method` + `id`），排在通知分支**之前**
- 新增 `_handleServerRequest` / `_dispatchServerRequest` / `_serverRoots` / `_respondToServer`
- 已实现：`ping`、`roots/list`（返回当前工作目录）；未支持的方法回标准 **-32601**
- 回写复用既有 `_writeRaw`，因此 stdio / 传统 SSE / Streamable HTTP 三种传输都能正确回信

**测试**：`tests/services/mcp/mcpClientCapabilities.test.js`（**新增**，8/8）。

## D.3 M1 — 协议版本协商

**改动**：
- `mcpServerProtocol.js` — 新增 `SUPPORTED_PROTOCOL_VERSIONS` 与 `negotiateProtocolVersion()`；
  `buildInitializeResult` 改为读取 `requestedVersion` 参与协商
- `mcpServer.js` — `initialize` handler 透传 `params.protocolVersion`
- `mcp/index.js` — **删除本地重复的 `PROTOCOL_VERSION`**，改为从 `mcpServerProtocol` require
  （消除双份硬编码）；新增 `_checkProtocolVersion`，三处握手点接入

**协商语义**：请求的版本受支持 → **回显**；不受支持 → 回自己支持的版本（规范行为）。
`SUPPORTED_PROTOCOL_VERSIONS` 目前只含 `2024-11-05` —— 2025-03-26 起的 Streamable HTTP
要求（`MCP-Protocol-Version` 头、SSE 流式响应、会话校验）尚未实现，**不列入**。

**客户端行为**：版本不匹配时**不自动断开**（khy 对旧版本仍能工作），但记入 `_lastError`
并 emit `protocolVersionMismatch` 事件，由调用方决定去留。此前是完全静默的。

**测试**：`tests/services/mcp/mcpProtocolNegotiation.test.js`（**新增**，10/10）。

## D.4 M4 — 按能力调用（顺带修复）

**为什么顺带做**：M4（无条件请求 `resources/list` / `prompts/list`）与 M2 是同一条逻辑链
——「声明了能力就该按能力调用」。分开修会让 M2 只改声明、调用侧仍违反规范。

**改动**：`_loadServerInventory` 改为检查 `this.capabilities`，未声明的能力不再请求。

**取舍**：`capabilities` 里没有 `resources` / `prompts` 键 → 不请求。规范要求服务端在
initialize 回包给出 capabilities，故"未声明即不支持"是合规读法。代价是若某服务端省略了
capabilities，其资源/提示在 khy 侧不可见 —— 但 `tools/list` **始终请求**，核心能力不受影响。

## D.5 回归结果

| 套件 | 结果 |
|------|------|
| jest（`tests/services/mcp` + `tests/mcp` + daemon + security + routeAuth） | **19 suites / 241 tests 全绿** |
| node:test（本次 6 个文件合计） | **50 / 50** |
| eslint（改动文件） | **0 errors**，未新增既有 warnings |

## D.6 遗留

1. **`sampling` / `elicitation` 未实现**：这是能力缺口，不是规范违反（已诚实不声明）。
   实现 sampling 需把服务端的推理请求路由到本地 AI 网关并处理额度与审计。
2. **协议版本仍停在 2024-11-05**：协商逻辑已合规，但要真正支持新客户端，需实现
   2025-03-26 的 Streamable HTTP 要求（见 M6 / M7 / M9）。本轮只修"无协商"与"静默"。
3. **客户端不自动断开版本不匹配**：属规范中的 SHOULD 而非 MUST，选择暴露事件由调用方决策。

---

# 附录 E：P1 补丁记录（第二批：M8 / M6 / M7）

> 本批处理建议清单第一、二项。三项都落在同一个文件
> `services/backend/src/services/domain/messaging/mcp/mcpHttpServer.js`
> 及其协议叶子 `mcpServerProtocol.js` —— 它们是"让 khy 作为 MCP server 时，
> 真能被标准客户端当 MCP server 用"的最后一截。

## E.1 M8 — 401 响应头 + 移除查询串传令牌

**改动**：`mcpHttpServer.js`

### E.1.1 补 `WWW-Authenticate`（RFC 6750 §3 / MCP 授权规范）

401 响应现在携带：

```
WWW-Authenticate: Bearer realm="khy-mcp", resource_metadata="/.well-known/oauth-protected-resource"
```

`resource_metadata` 指向 RFC 9728 Protected Resource Metadata 端点，客户端据此
**发现授权服务器**。端点可经 `KHY_MCP_RESOURCE_METADATA` 覆盖 —— 遵循仓库
「零硬编码」纪律，不自造域名。

新增导出：`RESOURCE_METADATA_ENV`、`DEFAULT_RESOURCE_METADATA`。

### E.1.2 移除 `?token=` 查询串传令牌

`isAuthorized` 现在**只认** `Authorization: Bearer <token>`。`req.queryToken`
的字段签名保留（调用点不必改），但值**一律被忽略**。

**为什么必须删而不是"加个告警"**：查询串会进入服务器访问日志、浏览器历史、
Referer 头、中间代理日志 —— 令牌泄露面是 header 方式的数倍，且用户无感。
这是 OWASP 明确列为反模式的凭据传递方式，没有"温和弃用"的中间态。

**顺带加固**：令牌比较从 `===` 改为 `crypto.timingSafeEqual`（新导出
`timingSafeEqualStr`）。`===` 短路比较会泄露令牌前缀匹配长度。

### E.1.3 迁移影响（已核实）

全仓检索 `queryToken` / `?token=` 后确认：**MCP server 侧无任何调用方依赖该方式**。

| 命中位置 | 是否受影响 |
|----------|-----------|
| `mcpHttpServer.js` 自身（`isAuthorized` + 请求处理） | 是，已改 |
| `tests/services/mcp/mcpHttpServer.test.js` 5 个用例 | 是，已改为断言"传了也不认" |
| `extensions/tools/khy-markdown/khyos-md-bridge.js` | **否** —— 另一台 server，独立实现 |
| `bridgeServer.js` / `routes/auth.js` / 前端 `?token=` | **否** —— 与本 server 无关 |

> 注意 `khyos-md-bridge.js` 有一处历史教训（见 `[IMPL-RPT-048]`）：那里删掉
> `?token=` 曾导致三个 POST 全部 401 → `failureCount` 打满 → 桥静默死亡，后已回退。
> **本处不适用**：那个 server 是给浏览器页面直接 POST 的，无法带自定义 header；
> 而本 MCP server 的客户端是 SDK/CLI，带 header 毫无障碍。两者约束不同，不要类推。

### E.1.4 实测

真起 server 发请求（`_产物/_m8_e2e.js`）：

| 场景 | 结果 |
|------|------|
| 无凭据 | `401` + `WWW-Authenticate` ✅ |
| **`?token=<合法令牌>`** | **`401`** ✅（改造生效，此前会 `200`） |
| `Authorization: Bearer <合法令牌>` | `200` ✅ |
| `Authorization: Bearer <错误令牌>` | `401` + `WWW-Authenticate` ✅ |

## E.2 M6 + M7 — 协议版本头与会话校验

两项都属 2025-03-26 Streamable HTTP 的要求，且都改在同一段请求处理逻辑里，
故合并实施。

### E.2.1 M6 — `MCP-Protocol-Version` 头

**新增纯函数** `mcpServerProtocol.checkProtocolVersionHeader(headerValue)`
（零 IO、绝不抛、可单测）：

| 入参 | 结果 |
|------|------|
| 支持的版本（`2024-11-05`） | `ok:true`，`assumed:false` |
| 不支持的版本（`2025-06-18` 等） | `ok:false` + `supported:[...]` + `reason` |
| 缺失 / 空白 | `ok:true`，`assumed:true`（回落 `DEFAULT_ASSUMED_VERSION`） |

**接线**：`rejectBadProtocolVersion(req, res)` 挂在三个请求分支入口
（`GET /sse`、`POST /messages`、`POST /mcp`）。不支持的版本 → `400`
并回 `{ error, supported }`。

**一处刻意的取舍**：规范说缺头时**应假定为 2025-03-26**。本项目**没有**实现
2025-03-26 的流式语义，照抄会变成"假兼容"——客户端以为能拿 SSE 流，实际拿到
JSON。故缺头时回落到**本服务端支持的最高版本**，并在判定结果里标注
`assumed:true`，让调用方与日志看得见"这是一次假定，不是协商结果"。
这正是本报告反复强调的口径：**声明必须与实现一致**。

**回归锁**：新增测试断言 `PROTOCOL_VERSION_HEADER === 'mcp-protocol-version'`
（全小写）—— Node 的 `req.headers` 键一律小写，写成驼峰会导致**永远取不到值**
而静默走"缺头"分支。

### E.2.2 M7 — 会话校验

改造前是"**回显或现签**"：客户端带什么 id 就回什么 id，不带就现签一个。
等于把 `Mcp-Session-Id` 当装饰品 —— 任何伪造 id 都被接受，服务端重启后
客户端也永远发现不了会话已失效。

改造后：

| 场景 | 行为 |
|------|------|
| `initialize`（建立会话） | 免检；签发新 id 并记入 `streamSessions` |
| 其余请求 + 已知 id | 正常处理 |
| 其余请求 + 伪造 / 缺失 id | **`404`** + `{ code: 'SESSION_NOT_FOUND' }`（规范要求） |
| `DELETE /mcp` | 销掉会话，回 `204` |

**会话表拆成两张**：`sseSessions`（sessionId → SSE response stream）与
`streamSessions`（sessionId → 记账）。二者生命周期不同 —— 前者随 SSE 连接走，
后者靠 DELETE 或进程退出。混在一张表里会让 `DELETE` 误关别人的 SSE 流。

**实测踩到并修掉的一个真缺陷**：首版判定条件写成 `streamSessions.size > 0`，
导致**删掉唯一会话后表变空 → 校验整体失效 → 拿旧 id 反而畅通无阻**，正是要防的事。
实测第 8 项（DELETE 后再用）暴露了它，改为 `sessionSeq > 0`（"这个进程签发过会话"）
后修正。

### E.2.3 实测

`_产物/_m67_e2e.js`，真起 server：

| # | 场景 | 期望 | 实测 |
|---|------|------|------|
| 1 | `initialize` 无版本头 | 200 + 签发 id | `200` + `khy-1` ✅ |
| 2 | 不支持的版本头 | 400 + supported | `400` + `["2024-11-05"]` ✅ |
| 3 | 支持的版本头 | 200 | `200` ✅ |
| 4 | **小写头名** + 坏版本 | 400 | `400` ✅ |
| 5 | 伪造会话 id | 404 | `404` ✅ |
| 6 | 正确会话 id | 200 | `200` ✅ |
| 7 | 缺会话 id（已建会话后） | 404 | `404` ✅ |
| 8 | `DELETE` 会话 | 204 | `204` ✅ |
| 9 | **DELETE 后再用** | 404 | `404` ✅ |

## E.3 测试与回归

| 套件 | 结果 |
|------|------|
| `tests/services/mcp/mcpHttpServer.test.js`（node:test） | **18 / 18**（原 10 → 新增 8） |
| node:test（`mcpHttpServer` + `mcpClientCapabilities` + `mcpProtocolNegotiation` + `a2aSendHeaders` + `originGuard` + `credentialsHardening`） | **58 / 58** |
| jest（`mcpServer` / `mcpServerProtocol` / `mcpServeToolPolicy`） | **14 / 14** |
| eslint（改动文件） | **0 errors**，未新增 warning |

> **踩到的 runner 陷阱**（已在项目记忆中）：
> `tests/services/mcp/` 下 9 个文件**混用两种 runner** —— `mcpHttpServer` /
> `mcpClientCapabilities` / `mcpProtocolNegotiation` 是 node:test，
> `mcpServer` / `mcpServerProtocol` / `mcpServeToolPolicy` 是 jest（`describe`）。
> 用 `node --test` 跑 jest 风格文件会以 `describe is not defined` 失败 ——
> 那是 **runner 用错**，不是测试挂了。另：本 Node 版本下 `node --test <目录>`
> 会把目录当模块加载，须显式列文件。

## E.4 遗留（本批未做）

1. **M9 — 两种传输混用同一端点**：`GET /` 既是传统 SSE 入口，`POST /` 又是
   Streamable HTTP。规范将两者定义为互斥传输，客户端靠配置区分而非 HTTP 方法。
   本批未动，因为拆分端点会**破坏现有客户端兼容**，需要一次明确的破坏性变更决策。
2. **协议版本仍停在 2024-11-05**：M6 让服务端**诚实拒绝**不支持的版本，但没让
   它**支持**新版本。要真支持 2025-03-26，还需实现 SSE 流式响应体与
   `Last-Event-ID` 断线续传 —— 那是一个独立的、更大的改动。
3. **会话无 TTL / 无上限**：`streamSessions` 只增不减（除非客户端 DELETE），
   长跑进程会缓慢泄漏。当前无鉴权暴露面已由 Origin + token 收口，故不紧急，
   但应列入后续批次。

---

# 附录 F：P1 补丁记录（第三批：T1 — 工具循环 journal）

> 建议清单第三项，也是全仓最值得投入的健壮性缺口。

## F.1 问题回顾

主循环 `toolUseLoopCore.js`（12000+ 行）此前**没有**任何逐轮持久记录：

- 唯一的落盘是 `onCheckpoint` → `boulderState`，**按 `md5(cwd)` 单槽**存储 →
  同一目录下并发会话**互相覆盖**检查点；
- 恢复方式是"把快照拼回 prompt"，属**粗粒度近似**，不是精确重放；
- `orchestrationJournal.js` 虽已存在，但**仅**服务于子代理编排，主循环零引用；
- 既有的 `_loopBreadcrumb()` 是**默认关闭**的调试设施，且写全局单文件
  （`os.tmpdir()/khy-loop-debug.log`），并发会话会交错。

## F.2 改动

### F.2.1 新增 `services/backend/src/services/toolLoopJournal.js`

薄 IO 层，模板沿用 `domain/state/orchestrator/orchestrationJournal.js`：

| 能力 | 说明 |
|------|------|
| `generateRunId()` | **不按 cwd 派生** —— 直接针对 T1 根因。500 次连续生成零重复（已锁测试） |
| `appendJournal(runId, rec)` | append-only JSONL，**每 run 一个文件** |
| `buildStartRecord` / `buildIterationRecord` / `buildEndRecord` | 纯函数记录构造，可单测 |
| `readJournal` / `listRunIds` | 读回；坏行（写到一半崩了）跳过而非整条作废 |
| `findIncompleteRuns()` | 有 `start` 无 `end` 的 run → 崩溃候选 |
| `isPidAlive(pid)` | 把"未完成"细分为"崩了"与"还在跑" |
| `summarizeForResume(runId)` | 恢复摘要：第几轮、跑过哪些工具、哪些失败 |

**落盘位置**：`getDataDir('toolLoop')/loop-<runId>.jsonl`。
**门控**：`KHY_LOOP_JOURNAL`（默认 ON，`0`/`false`/`off`/`no` 关闭）。

### F.2.2 三条刻意的设计取舍

1. **用户原文不落盘**。`start` 只记 `userMessageLength` + `userMessageSha1` 前 12 位。
   仍足以分辨"这次跑的是什么"，但敏感内容不写进磁盘。
2. **记录有上限**。每轮工具最多 50 条、错误文案截断 120 字符、结果不整体 dump。
   100 轮循环不会产出 MB 级 journal。
3. **对象型错误取 `message`**。工具结果的 `error` 常是 `{message, code}`，
   直接 `String(v)` 会得到 `[object Object]` —— journal 里等于没记。

### F.2.3 接线（`toolUseLoopCore.js`，共 3 处）

| 位置 | 动作 |
|------|------|
| `_turnId` 创建之后 | `beginRun`：生成 runId、写 `start` |
| 每轮循环**开头** | 写 `iteration` 记录（含上一轮的工具切片） |
| 5 个出口 | 写 `end`：`posttool-hook-stop`、`token-budget-stop`、`interrupt-cancelled`、`interrupt-stop`、`absolute-timeout` |

**为什么挂在轮首而不是轮尾**：轮尾有 **19 条** `return` 分支，逐个挂既易漏又易错；
轮首只有一处，且此时 `toolCallLog` 已含上一轮全部结果，按游标切片即可。

## F.3 实测

`_产物/_t1_e2e.js` 真跑一次循环（假 chat，3 轮）：

```
落盘 run 数: 1
文件 = <KHY_DATA_HOME>\toolLoop\loop-r20260916014757-8627ba54.jsonl
记录数 = 4
  - {"type":"start",...,"sessionId":"e2e-session","turnId":"turn-...","maxIterations":...}
  - {"type":"iteration","seq":1,"iteration":1,"tools":[],"toolCount":0,...}
  - {"type":"iteration","seq":2,"iteration":2,"tools":[{"name":"echo","ok":false,
     "durationMs":98,"error":"Unknown tool: echo"}],...}
  - {"type":"iteration","seq":3,...}
恢复摘要: {"lastIteration":3,"completedIterations":3,"toolsRun":2,
           "failedTools":2,"endsWithoutEnd":true}
未完成 run 数: 1
```

工具名、耗时、错误文案都正确落盘，恢复摘要可精确回答"死在第 3 轮、跑过 2 个工具、2 个失败"。

## F.4 测试与回归

| 套件 | 结果 |
|------|------|
| `tests/services/toolLoopJournal.test.js`（node:test，**新建**） | **19 / 19** |
| eslint（新模块） | **0 problems**（error + warning 全清） |
| eslint（`toolUseLoopCore.js`） | 5 个 error **经 HEAD 对照确认既有**（`_responseDebounce`/`sanitizedUser`/`context` 未定义，行号正好偏移本次新增的 ~70 行） |

> **踩到的测试隔离坑**：`utils/dataHome.js` 有模块级 `_cached`，只清 journal 模块的
> `require.cache` 不够 —— 后续用例会复用**第一个**临时目录（而它已被上一个用例删掉），
> 表现为 `listRunIds()` 里冒出别的用例留下的 run id。
> **必须同时清 `dataHome` 的缓存。**

## F.5 遗留（本批未做）

1. **`end` 覆盖不完整**：19 个出口只挂了 5 个。因此 `findIncompleteRuns()` 是**保守**的 ——
   它可能把"从其他出口正常结束"的 run 也列为未完成。
   崩溃**取证**（`summarizeForResume` 的"跑到第几轮、做过什么"）不受影响，
   但"崩溃 vs 正常结束"的判定要靠 `isPidAlive()` 交叉验证。
   要彻底解决需给所有出口加 `end`，或引入统一的收尾漏斗 —— 那是更大的重构。
2. **journal 无 TTL / 无清理**：`toolLoop/` 目录只增不减。长跑机器上会累积，
   应配套一个按时间的清理任务（可参照既有 cleanupService）。
3. **尚未接入真正的"恢复"**：本批只提供了**取证数据**。真正用它做自动续跑
   （读最后一次未完成 run → 从第 N 轮继续）属产品决策，未在本批实现。
