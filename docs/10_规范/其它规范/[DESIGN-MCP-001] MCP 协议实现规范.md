# [DESIGN-MCP-001] MCP 协议实现规范

> **状态**：生效中
> **适用范围**：`services/backend/src/services/domain/messaging/mcp/**`（khy 作为 MCP
> server 与 MCP client 的全部实现）
> **对照标准**：Model Context Protocol（Linux Foundation）修订
> `2024-11-05` / `2025-03-26` / `2025-06-18` / `2025-11-25`
> **机器可读真源**：`mcpServerProtocol.PROTOCOL_CONFORMANCE`、`SUPPORTED_PROTOCOL_VERSIONS`
> **强制手段**：`npm run check:protocol-conformance`（已接入 `check:structure`）
> **相关文档**：`[DESIGN-COMM-001] 通信协议规范`、`[OPS-MAN-173] MCP 工具接入快速上手`

---

## 1. 为什么需要这份规范

khy-os 的 MCP 实现本身质量不低 —— 工具注册、权限门控、名称归一化、注解驱动权限
映射都做得比多数实现规范。真正的问题不在「有没有做」，而在**声明与实现之间没有
任何机器校验**，于是反复出现三类故障：

| 类型 | 历史实例 | 后果 |
|------|----------|------|
| **能力虚报** | client 上报 `capabilities: { tools, resources, prompts }` —— 那是 **ServerCapabilities** 字段，出现在客户端能力里属无效声明 | 服务端据此判定本客户端不支持 `roots`，主动关闭服务端发起的能力 |
| **自相矛盾** | server 端诚实只声明 `tools`，自家 client 连上去却发 `resources/list` | 必收 `-32601`，且 `Promise.allSettled` 吞掉原因，无法区分「不支持」与「真失败」 |
| **静默降级** | 协议版本硬编码 `2024-11-05` 且在两个文件里各自维护一份；`initialize` 完全不读客户端的 `protocolVersion` | 新版客户端按规范应当断开；且两份常量必然漂移 |

这三类的共同点是：**没有一处能在 CI 里被抓住**。本规范的首要任务不是新增功能，
而是把「声明」变成被实测的数据。

---

## 2. 分层契约（不得打破）

```
mcpServerProtocol.js   纯叶子：零 IO、确定性、绝不抛 —— 协议构形/解析/派发/一致性矩阵
        ▲                                                         ▲
        │ require                                          require │
mcpStdioServer.js   mcpHttpServer.js   传输层：薄 IO（读写 stdin/stdout/socket）
        ▲                    ▲
        └────────┬───────────┘
         mcpServer.js   引擎：注入 handlers + try/catch 兜底（不含业务逻辑）
                 ▲
          cli/handlers/tools.js  工具源（loadTools / getEnabled / execute）
```

**强制条款**

- **MCP-1** 所有协议构形（`initialize` 回包、`Tool` 形状转换、`CallToolResult` 转换）
  **必须**放在 `mcpServerProtocol.js`，且该文件必须保持零 IO。传输层不得自行拼装
  协议对象。
- **MCP-2** `tools/call` **必须**与本地模型调工具走**同一条**权限门控
  （`cli/handlers/tools.execute`）。禁止为 MCP 客户端开后门。
- **MCP-3** 不在暴露集内的工具 **必须**视为「不存在」并回 `-32602`，不得泄露隐藏
  工具的存在。

---

## 3. 协议修订：声明多少，做多少

`SUPPORTED_PROTOCOL_VERSIONS` 是**唯一**的修订声明来源。它的取值不是任意的，而是
由一致性矩阵推导出来的：

```
SUPPORTED_PROTOCOL_VERSIONS ≡ { 修订 R | R 的全部 required 特性都 implemented:true }
```

守卫会断言这个恒等式双向成立：声明集合里多一个 → 红灯；少一个 → 红灯。

### 3.1 当前状态

| 修订 | 是否声明 | 原因 |
|------|----------|------|
| `2024-11-05` | ✅ 声明 | 全部 required 特性已实现 |
| `2025-03-26` | ❌ 不声明 | `required` 的 **SSE 流式响应体** 与 **`Last-Event-ID` 断线续传**未实现 |
| `2025-06-18` | ❌ 不声明 | 依赖 2025-03-26 的传输能力；另缺 OAuth 资源服务器接入 |
| `2025-11-25` | ❌ 不声明 | 同上 |

**这不影响互操作**：`initialize` 会做版本协商 —— 客户端报支持的版本，若在
`SUPPORTED_PROTOCOL_VERSIONS` 内则**回显**，否则回本端支持的版本。新版客户端拿到
`2024-11-05` 后自行决定是否继续，而不是被静默欺骗。

### 3.2 能力声明的诚实原则

`buildInitializeResult()` 的 `capabilities` **只能**声明真的实现了的服务端能力。
当前为：

```json
{ "capabilities": { "tools": {} } }
```

`resources` / `prompts` **不得**出现在这里 —— 写上去就等于告诉客户端「可以调
`resources/list`」，而实际会回 `-32601`。

客户端侧同理：`ClientCapabilities` 的合法字段是 `experimental` / `roots` /
`sampling` / `elicitation`。khy 当前只声明 `roots`（已实现 `roots/list` 响应）；
`sampling` 与 `elicitation` **刻意不声明**，因为前者需把服务端推理请求路由到本地
AI 网关（涉及额度与审计），后者需交互式 UI。

---

## 4. 传输层要求

### 4.1 Streamable HTTP（`POST /mcp`）

| 要求 | 条款 | 实现落点 |
|------|------|----------|
| **`Origin` 校验，非法来源回 `403`** | MCP-4（2025-11-25 明确） | `mcpHttpServer.isAllowedOrigin` |
| 入站 `MCP-Protocol-Version` 头：不认识的版本回 `400` + `supported` | MCP-5 | `checkProtocolVersionHeader` + `rejectBadProtocolVersion` |
| 未知 / 已失效 `Mcp-Session-Id` 回 `404` | MCP-6 | `streamSessions` 校验 → `SESSION_NOT_FOUND` |
| 会话表**必须**与 SSE 连接表分离 | MCP-7 | `streamSessions` vs `sseSessions` |

**MCP-4 的威胁模型必须写清楚**：绑定 `127.0.0.1` **不构成安全边界** —— 用户浏览器
里的任意网页都能 `fetch` 到本机端口。真正的防线是 `Origin` 校验（页面脚本无法伪造
`Origin`）。而 khy 的 MCP server 默认暴露全量工具（含 shell 执行与文件写入），
所以这条是 **P0 级**要求。

### 4.2 传统 HTTP+SSE（`GET /sse`）

`2024-11-05` 传输，保留以兼容旧客户端。**已知偏离**：`GET /` 既是传统 SSE 入口、
`POST /` 又是 Streamable HTTP，而规范将两者定义为互斥传输。拆分端点属破坏性变更，
需单独决策；当前由 `config.type` 在客户端侧区分。

### 4.3 stdio

启动外部 server **必须**用 `spawn(command, args, { stdio })`，**禁止**经过 shell。
（对比反面案例：`extensions/extensionManager.js` 用 `execSync` 拼串。）

### 4.4 授权

- `401` **必须**携带 `WWW-Authenticate`，并指向 RFC 9728 Protected Resource Metadata
  端点，客户端据此发现授权服务器。
- **禁止**支持 `?token=` 查询串传令牌 —— 查询串会进入访问日志、浏览器历史、
  `Referer` 头、代理日志。令牌比较**必须**用 `crypto.timingSafeEqual`。
- 未配置令牌时**不得**绑定非 loopback 地址（启动即拒绝）。

---

## 5. 工具与结果的形状

### 5.1 `tools/list`：khy `toFunctionDef()` → MCP `Tool`

| khy 字段 | MCP 字段 | 说明 |
|----------|----------|------|
| `name` / `description` | 同名 | — |
| `parameters` | **`inputSchema`** | 必须改名 |
| `title` | `title` | 可选，存在才透传 |
| `annotations` | `annotations` | **必须透传**：`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` 是客户端做权限决策的唯一依据 |
| `outputSchema` | `outputSchema` | 声明结构化返回的 schema |
| `aliases` | **丢弃** | MCP 客户端不认 |

**MCP-8**：字段透传遵循「存在才出现」原则，**不得**为凑格式而编造默认值。

### 5.2 `tools/call`：khy 归一结果 → MCP `CallToolResult`

```json
{
  "content": [{ "type": "text", "text": "..." }],
  "structuredContent": { "...": "..." },
  "isError": false
}
```

**MCP-9（结构化保真）**：当结果体是**普通对象**时，除 `content` 外**必须**同时回
`structuredContent`。禁止用 `String(obj)` 折叠 —— 那会产出 `"[object Object]"`，
是静默的数据损坏。数组**不得**写入 `structuredContent`（规范要求该字段是对象），
只做 `JSON.stringify` 进 `content[0].text`。

**MCP-10（错误分类）**：输入**校验**失败必须作为 **Tool Execution Error**
（`isError: true`）返回而非协议错误，以便模型自我纠正。

---

## 6. JSON-RPC 2.0 信封

**MCP-11**：入站消息若带 `jsonrpc` 字段，**必须**精确等于字符串 `"2.0"`，否则回
`-32600 Invalid Request`。缺该字段按 2.0 处理（部分旧客户端省略，服务端宽容不构成
攻击面）。

错误码**必须**取自 `ERROR_CODES`，不得自造：

| 码 | 含义 |
|----|------|
| `-32700` | Parse Error（不是 JSON） |
| `-32600` | Invalid Request（是 JSON 但信封非法） |
| `-32601` | Method Not Found |
| `-32602` | Invalid Params |
| `-32603` | Internal Error |

---

## 7. 如何扩展（SOP）

### 7.1 要支持一个新协议修订

1. 在 `PROTOCOL_CONFORMANCE` 中为该修订补**全部**必需特性行，`required: true`。
2. 实现它们，逐条把 `implemented` 改成 `true`，并在 `evidence` 里写清代码落点。
3. 把该修订加入 `SUPPORTED_PROTOCOL_VERSIONS`。
4. 在 `scripts/ci/check-protocol-conformance.js` 的 `mcpProbes()` 里为**每个**
   `implemented: true` 的特性补一条探针（`behavior` 优先，其次 `source` / `file`）。
5. 跑 `npm run check:protocol-conformance`，必须全绿。

**没有探针的 `implemented: true` 会被守卫判为红灯** —— 这是刻意的：不可验证的声明
等于空声明。

### 7.2 要新增一个 MCP 方法

1. 在 `mcpServerProtocol` 里加纯构形函数（如需要）。
2. 在 `mcpServer.handlers` 里加 handler。
3. 若该方法使某个能力从「未实现」变为「已实现」，同步更新
   `buildInitializeResult` 的 `capabilities` 与矩阵，然后走 7.1 的第 4 步。

---

## 8. 验证

```bash
npm run check:protocol-conformance          # MCP + A2A 全量
node scripts/ci/check-protocol-conformance.js --mcp --json
npm run check:leaf-contract -- services/backend/src/services/domain/messaging/mcp/mcpServerProtocol.js
```

端到端互操作验证（需真实起 server，不在 CI 内）：

```bash
npx @modelcontextprotocol/inspector node services/backend/src/services/domain/messaging/mcp/mcpStdioServer.js
```

---

## 9. 反模式清单（出现即视为回归）

| # | 反模式 | 为什么 |
|---|--------|--------|
| 1 | 在 `capabilities` 里声明未实现的能力 | 客户端会据此走进必然失败的分支 |
| 2 | 在**客户端**能力里写 `tools` / `resources` / `prompts` | 那是服务端字段，属无效声明 |
| 3 | 无条件请求服务端未声明支持的能力接口 | 规范 **MUST NOT**；且污染对端日志 |
| 4 | 把多个协议修订支持的版本写死在多个文件里 | 必然漂移，且无单一真源 |
| 5 | 用 `String(obj)` 折叠结构化结果 | 静默数据损坏 |
| 6 | `?token=` 传令牌 | OWASP 明确反模式 |
| 7 | 缺 `Origin` 校验就暴露全量工具 | DNS rebinding → 任意 shell 执行 |
| 8 | 为 MCP 客户端绕过 `--allowedTools` 权限门控 | 破坏唯一的安全闸 |

---

## 10. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-15 | 首版：分层契约、修订声明恒等式、一致性矩阵与守卫、传输/工具/信封要求、扩展 SOP |
