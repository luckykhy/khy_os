# khy-os 协议与工程规范深度调研报告

<!-- naming-guard: exempt 调研报告引用历史错误命名作为审计证据 -->

- **调研日期**：2026-09-15
- **调研对象**：`D:\Portable\khy-os`（Khy OS — 通过 PyPI/npm 分发的 AI 平台操作系统）
- **调研范围**：工具 MCP 化改造、A2A 协议适配、软件文档完整性、代码标准合规性，
  以及调研过程中主动识别的补充维度
- **对标基准**：MCP 官方规范（`2024-11-05` → `2025-11-25` 四修订）、Agent2Agent
  Protocol v0.3.0（Linux Foundation）、GitHub 明星开源实现
- **方法**：静态源码精读 + 结构度量 + **运行时实测**（Node v22.22.2 / ajv 6.15.0）
  + 官方规范逐条对照
- **产出**：本报告 + `khy-os-协议与工程规范分步改进计划-2026-09-15.md`
  + 已落地的代码改动与配套规范文档（见改进计划 §5）

---

## 0. 执行摘要

**一句话结论**：khy-os 是一个**工程量惊人、治理框架成熟、但协议声明与实现之间缺少
机器校验**的系统。它的 CI 里有 55 个守卫脚本、`docs/_规范/` 里有 70 份规范文档，
标准制定能力远超同体量项目；但恰恰因为「规则靠人写、没人验」，能力虚报、声明与实现
不一致、文档描述与协议实体错位这三类问题反复出现在最关键的协议面上。

### 四维评分

| 维度 | 评级 | 一句话判断 |
|------|------|-----------|
| **工具 MCP 化改造** | 🟡 **B** — 工具面优秀，协议面有硬缺口 | 工具注册/权限门控/名称归一化达到或超过主流实现；但协议版本停在 `2024-11-05`，且能力声明长期错误 |
| **A2A 协议适配** | 🔴 **D** — 「名义适配」 | 存在两套互不相通的「A2A」，其中被大量引用的那套与标准协议**毫无关系**；标准侧的出站客户端曾 100% 静默失败 |
| **文档完整性** | 🟡 **B−** — 覆盖面极广，但存在真伪混装 | 70 份规范文档覆盖 40+ 主题；但没有 MCP 协议规范、没有 A2A 标准规范、没有 OpenAPI、没有 ADR，且 `[DESIGN-A2A-001]` 把私有方言写成了标准协议 |
| **代码标准合规** | 🟡 **C+** — 体系齐全，基线已失效 | NAM/COM/COMP 三类规则都有守卫；但基线被抬到「允许 12000 个超长函数、5000 处 console」，实际已失去约束力 |

### 主动识别的补充维度（用户未提及）

调研过程中发现 6 个**未被提及但同等关键**的维度，均已纳入改进计划：

1. **一致性验证能力缺失**（最重要）—— MCP 官方有 `inspector`(10.6k⭐) 与
   `conformance`，A2A 官方有 `a2a-inspector` 与 `a2a-tck`。khy-os **没有接入任何
   一个**，意味着「合规」这一判断从未被外部工具验证过。本次新增的
   `check-protocol-conformance.js` 是**自建**的内部替代，仍需外部 TCK 交叉验证。
2. **安全横切面不统一** —— 同一仓库内 CORS、错误输出、命令执行、凭据存储
   各自「有做对的和做错的版本」（详见 §5.1）。
3. **可观测性默认关闭** —— 工具循环有 `agent.loop.start` 却无 `agent.loop.end`；
   breadcrumb 需 `KHY_LOOP_DEBUG` 才写。
4. **发布/版本轨道割裂** —— 主轨道 4 个真源 + ai-backend 轨道 2 个真源，由脚本校验
   一致性；但 HTTP API **无 `/v1` 前缀**，缺少 API 版本化政策。
5. **可恢复性** —— 无逐轮 journal；检查点按 `cwd` 单槽覆盖，同目录并发会话互相覆盖。
6. **许可证与生态位** —— 未见 ADR 记录「为什么自建而不复用 SDK」，也未评估
   `@modelcontextprotocol/sdk` 与 `a2a-js` 的复用可能，存在长期重造轮子风险。

---

## 1. 调研方法与可复现性

### 1.1 做了什么

| 步骤 | 内容 |
|------|------|
| 结构度量 | 目录层级（L0 `kernel/` → L6 `tools/`）、`scripts/ci/` 全部 55 个守卫清点、`docs/` 两轴命名体系清点 |
| 协议精读 | `services/backend/src/services/domain/messaging/mcp/` 全部 21 个文件；`services/backend/src/services/a2a*` / `acp*` / `a2a/**` 全部实现 |
| 规范对照 | MCP 四修订的 changelog 逐条；A2A v0.3.0 的 AgentCard / Task / Message / Part / TaskState / 方法集 |
| **运行时实测** | 直接 `require` 协议叶子并驱动其纯函数；以 ajv 6.15.0 校验契约 schema；新增 47 个单测并跑通 68（MCP jest）+ 80（其它 jest）+ 8（A2A header node:test） |
| 守卫复核 | `check:leaf-contract` / `check-node-syntax` / `check-repo-layout` / `check-gov-rules` / `check-protocol-conformance` |
| 对标研究 | GitHub 官方与社区明星项目（星数为 2026-07/08 API 快照） |

### 1.2 范围排除

`.research-tmp/`（第三方仓库克隆）、`node_modules/`、`dist-ts/`、`docs/**/*.html`
（markdown 生成副本）、`.khy/tmp/`。

### 1.3 未覆盖

前端 `apps/` 的 UI 层规范、`software/khyquant/` 业务逻辑、跨主机端到端互通实测、
性能基准。

---

## 2. 对标基准

### 2.1 MCP：四个修订，能力阶梯

| 修订 | 引入的关键能力 | khy-os 状态 |
|------|----------------|-------------|
| `2024-11-05` | stdio + HTTP+SSE 双通道；JSON-RPC 2.0 信封 | ✅ 完整实现 |
| `2025-03-26` | **Streamable HTTP** 单端点；`Mcp-Session-Id`；`MCP-Protocol-Version` 头 | 🟡 部分（JSON 回包路径 + 头校验 + 会话校验已做；**SSE 流式响应体与 `Last-Event-ID` 断线续传未做**） |
| `2025-06-18` | **OAuth 资源服务器**语义 + RFC 9728 受保护资源元数据；`outputSchema` / `structuredContent`；`elicitation`；**移除 JSON-RPC 批处理**；工具注解 | 🟡 部分（`outputSchema`/`structuredContent`/注解/`WWW-Authenticate` 已做；OAuth 授权服务器发现、`elicitation` 未做） |
| `2025-11-25` | **无效 `Origin` 必须回 `403`**（PR #1439）；OIDC Discovery；工具图标；增量 scope 授权；**JSON Schema 2020-12** 为默认方言；`tasks`（实验性持久请求） | 🟡 仅 `Origin → 403` 已做 |

> **关键判据**：khy-os **只声明** `2024-11-05`，且这一声明由一致性矩阵推导、被守卫
> 实测。这是**正确的工程选择** —— 规范要求客户端拿到不认识的版本后自行断开，
> 而「诚实拒绝」远好于「假装支持」。真正的缺口是把 `2025-03-26` 的流式语义补齐。

### 2.2 A2A：v0.3.0 的硬性要求

| 要求 | 内容 | khy-os 状态（本次整改前 → 后） |
|------|------|-------------------------------|
| 发现 | `GET /.well-known/agent-card.json`，**无需鉴权** | ❌ 无服务端端点 → ✅ 已发布 |
| AgentCard 必填 | `protocolVersion` / `name` / `description` / `url` / `version` / `capabilities` / `defaultInputModes` / `defaultOutputModes` / `skills` | ❌ 缺 4 项、含非法字段 → ✅ 契约强制 |
| 鉴权声明 | `securitySchemes` + `security`（OpenAPI 风格） | ❌ 用了不存在的 `authentication.schemes` → ✅ 已修 |
| 方法集 | `message/send`、`message/stream`、`tasks/get`、`tasks/cancel`、`tasks/resubscribe`、`tasks/pushNotificationConfig/*` | ❌ 仅 3 个出站方法，且 `createTask` 打私有端点 → ✅ 补齐 `tasks/cancel`，`createTask` 委托 `message/send` |
| TaskState | 9 值封闭枚举，4 个终态 | ❌ 三套私有状态机直接透出 → ✅ 显式映射 + 守卫锁死 |
| `Part` | `kind` 判别联合（text / file / data） | ❌ 缺 `kind`，非合法 Part → ✅ 已修 + 反面断言 |
| 传输 | JSON-RPC 2.0 over HTTP + **SSE**（**非** WebSocket） | ❌ 私有方言文档写的是 WebSocket/gRPC → ✅ 边界已划清 |
| 能力诚实 | `streaming: true` ⇒ 必须真有 `message/stream` | ❌ 空声明 → ✅ 改为 `false` + 守卫实测 |

### 2.3 明星开源项目对标

**MCP 生态（官方）**

| 项目 | 星数 | 对本项目的意义 |
|------|------|----------------|
| `modelcontextprotocol/servers` | 89.4k | 参考 server 实现（filesystem/GitHub/Git/memory/PostgreSQL）——可作 `khy mcp serve` 的行为基准 |
| `modelcontextprotocol/python-sdk` | 24.0k | 参考实现 |
| `modelcontextprotocol/typescript-sdk` | 13.1k | **Node 生态的对照实现**；khy 自建协议层的取舍应与此对照 |
| `modelcontextprotocol/inspector` | 10.6k | **可视化测试工具 —— khy 应接入** |
| `modelcontextprotocol/conformance` | 97 | **一致性测试套件 —— khy 应接入** |
| `modelcontextprotocol/specification` | 8.9k | 规范真源 |

**MCP 生态（社区，可作为「工具面」的能力上限参考）**

`punkpeye/awesome-mcp-servers` 91.7k、`upstash/context7` 54.9k、
`microsoft/playwright-mcp` 32.3k、`github/github-mcp-server` 29.7k、
`jlowin/fastmcp` 25.1k、`oraios/serena` 24.0k。

> **可复用的教训**：`fastmcp`（25.1k⭐）证明「用装饰器声明工具 + 自动生成 schema」
> 是主流 DX；khy-os 用 `BaseTool` 类 + `toFunctionDef()` 是等价设计，方向一致。

**A2A 生态（官方）**

| 项目 | 星数 | 对本项目的意义 |
|------|------|----------------|
| `a2aproject/A2A` | 24.6k | 规范与文档真源（Apache-2.0） |
| `a2aproject/a2a-python` | 2.0k | 参考实现（`A2AStarletteApplication` + `DefaultRequestHandler` 模式） |
| `a2aproject/a2a-js` | 564 | **Node 生态官方 SDK** ——khy 评估复用 |
| `a2aproject/a2a-samples` | 1.67k | 端到端示例 |
| `a2aproject/a2a-tck` | 38 | **技术一致性套件 —— khy 应接入** |
| `a2aproject/a2a-inspector` | — | 验证工具 —— khy 应接入 |
| `a2a-java` / `a2a-go` / `a2a-dotnet` / `a2a-rs` | 449 / 412 / 242 / 42 | 多语言生态 |

> **A2A 官方 SDK 的核心模式**：实现 `AgentExecutor` → 接 `DefaultRequestHandler`
> → 挂到 HTTP server。`TaskStore` 开发用 `InMemoryTaskStore`、生产用 SQL。
> khy-os 的 `A2A Registry/Router/Lifecycle` 解决的是**进程内编排**问题，
> 与官方模型不是同一层 —— 这正是「两套 A2A」的根源。

---

## 3. 维度一：工具 MCP 化改造

### 3.1 现状：工具面扎实

| 亮点 | 证据 |
|------|------|
| **分层干净** | `mcpServerProtocol.js`（纯协议，零 IO、可确定性单测）与 `mcpStdioServer` / `mcpHttpServer`（薄 IO）分离，两个传输共用同一协议核心 |
| **工具名归一化防注入** | `types.js:121-123`：非 `[A-Za-z0-9_-]` 全替换为 `_`，确保 `mcp__server__tool` 分隔符不被破坏、不跨 server 碰撞 |
| **注解驱动权限映射** | `types.js:150-154`：`readOnlyHint` / `destructiveHint` 显式映射，缺失时**不猜测** |
| **`tools/call` 不开后门** | 与本地模型调工具走**同一条**权限门控（`--allowedTools` / 风险闸） |
| **非 loopback 无令牌拒绝启动** | `mcpHttpServer.js:54-67`，安全默认正确 |
| **请求体上限** | 4 MB 保护 |
| **请求级超时 + Map 清理** | 无泄漏 |

### 3.2 本次整改前的问题

| # | 问题 | 级别 | 影响 |
|---|------|------|------|
| M1 | 协议版本硬编码 `2024-11-05`，且在 client/server 两处**各自维护一份**；`initialize` 完全不读 `params.protocolVersion` | P1 | 无协商 = 新版客户端按规范应断开；两份常量必然漂移 |
| M2 | 客户端上报 `capabilities: { tools, resources, prompts }` —— 全是 **ServerCapabilities** 字段 | P1 | 服务端据此判定本客户端不支持 `roots`，主动关闭服务端发起的能力 |
| M3 | 客户端不响应服务端发起的请求（`sampling` / `roots/list` / `elicitation`） | P1 | MCP 是**双向**协议，服务端请求永远等不到响应 |
| M4 | 无条件请求 `resources/list` 与 `prompts/list`，不检查服务端能力 | P2 | 自家 client 违反自家 server 的诚实声明，必收 `-32601`，且 `Promise.allSettled` 吞掉原因 |
| M5 | Streamable HTTP 服务端**缺 `Origin` 校验** | **P0** | 默认暴露全量工具（含 shell / 文件写）；恶意网页可经 `fetch('http://127.0.0.1:…/mcp')` 执行任意命令。**loopback 绑定不构成安全边界** |
| M6 | 未处理 `MCP-Protocol-Version` 头 | P1 | 无法感知客户端版本 |
| M7 | 会话机制「签发但不校验」 | P1 | 任意伪造 `Mcp-Session-Id` 都被接受；服务端重启后客户端无法察觉会话失效 |
| M8 | `401` 缺 `WWW-Authenticate`；支持 `?token=` 查询串传令牌 | P1 | 标准客户端无法完成 OAuth 发现；令牌泄露面扩大数倍 |
| M9 | 传统 SSE 与 Streamable HTTP 混用同一端点 | P2 | 规范定义为互斥传输 |
| M10 | 入站不校验 `jsonrpc` 字段 | P3 | 接受 `{jsonrpc:'1.0'}` 畸形请求 |
| M11 | 结构化结果被 `String()` 折叠成 `[object Object]` | P2 | **静默数据损坏** |
| M12 | `_unwrapRpc` 无匹配时静默返回 `undefined` | P3 | 故障被掩盖 |

### 3.3 本次整改内容

| 改动 | 文件 | 说明 |
|------|------|------|
| **新增一致性矩阵** | `mcpServerProtocol.js` | `PROTOCOL_CONFORMANCE`（32 行声明）+ `declaredRevisions()` + `isRevisionFullyImplemented()`。**声明成为机器可读数据** |
| `jsonrpc` 字段校验（M10） | `mcpServerProtocol.js` | 带 `jsonrpc` 字段但 ≠ `"2.0"` → `-32600`；缺字段按 2.0 处理 |
| 结构化保真（M11） | `mcpServerProtocol.js` | 对象 → 同时回 `structuredContent`；数组只进 `text`；禁用 `String()` 折叠 |
| 工具定义透传 | `mcpServerProtocol.js` | 新增 `title` / `annotations` / `outputSchema` 透传（原先被丢弃） |
| 错误码分级 | `mcpServer.js` | 解析层区分 `-32700`（不是 JSON）与 `-32600`（信封非法） |
| **自建一致性守卫** | `scripts/ci/check-protocol-conformance.js` | 27 项 MCP 断言全绿 |

> 注：`Origin` 校验（M5）、`MCP-Protocol-Version`（M6）、会话校验（M7）、
> `WWW-Authenticate` + 移除 `?token=`（M8）、版本协商（M1）、客户端能力（M2/M3/M4）
> 已由本轮之前的补丁批次修复，本次新增的守卫**为它们补上了实测断言** ——
> 此前这些修复没有回归锁。

### 3.4 剩余缺口

| 缺口 | 影响 | 建议 |
|------|------|------|
| 未实现 SSE 流式响应体与 `Last-Event-ID` | 无法声明 `2025-03-26` | 补齐后可一次性把修订声明推进到 `2025-03-26` |
| 未接 OAuth 授权服务器发现（RFC 9728 完整流程） | `2025-06-18` 的授权语义不完整 | 与 `oauthTokenStore.js` 现状对齐后评估 |
| `sampling` / `elicitation` 未实现 | 能力缺口（已诚实不声明） | 优先级低；`sampling` 涉及额度与审计，需产品决策 |
| `resources` / `prompts` 服务端能力未实现 | 同上 | 按需 |
| JSON Schema 方言仍是 draft-07 风格 | `2025-11-25` 默认 2020-12 | 与工具 schema 生成链路一起评估 |

---

## 4. 维度二：A2A 协议适配

### 4.0 核心发现：两个「A2A」

> 这是本次调研**最关键的发现**，也是理解全部 A2A 问题的前提。

| 实现 | 位置 | 实质 | 被引用情况 |
|------|------|------|-----------|
| **标准 A2A 出站客户端** | `services/backend/src/services/a2a/index.js` | REST 绑定（`/.well-known/agent-card.json`、`/v1/message:send`）、`role` + `parts[]`、Bearer | 仅 `A2ATool` |
| **私有 ACP 方言** | `acpTransport.js` / `a2aRegistry.js` / `a2aMessageRouter.js` / `a2aFacade.js` / `a2aAgentLifecycle.js` | 进程内私有 JSON-RPC，方法名 `a2a.discovery.register` / `a2a.task.create`，协议版本 `1.0`，自建 ipc/ws/http | **14 个内置 agent 注册、router、facade、生命周期、多个服务** |

**两者方法集无一重合。** 而 `docs/_规范/[DESIGN-A2A-001] A2A 协议规范.md`
把后者逐字写成「A2A 协议规范」，还把传输层写成 WebSocket / HTTP-2 / gRPC
（标准 A2A 用的是 **SSE**，明确**不是** WebSocket）—— 外部读者据此对接必然失败。

### 4.1 本次整改前的问题

| # | 问题 | 级别 |
|---|------|------|
| A2 | 无 Agent Card 服务端托管端点 —— khy 能调别人，别人永远发现不了 khy | P1 |
| A3 | Agent Card 字段不符规范：`authentication.schemes` 不是 A2A 字段；缺 `protocolVersion` / `provider`；`streaming: true` 是**空声明** | P1 |
| A4 | Task 生命周期状态集私有（三套各不相同，与规范仅 2 词重合）；状态赋值无迁移校验 | P1 |
| A5 | 无 `tasks/cancel` —— 长任务无法经协议取消，只能强杀进程 | P1 |
| A6 | 无流式（`message/stream` / `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent` 全仓零命中） | P1 |
| A7 | `createTask` 请求体字段错误（POST 私有端点 `/v1/tasks`，自带顶层 `id` 与 `messages[]`） | P2 |
| A8 | `sendMessage` / `createTask` 在未配置 API key 时**必然失败**（`undefined` header 同步抛 `ERR_HTTP_INVALID_HEADER_VALUE`，被 catch 吞成 `{status:0}`） | P1 |
| A9 | `initializeA2A` 是死代码，14 个内置 agent 的注册**从不执行** | P2 |
| A10 | 无任务持久化 / 跨进程能力（注册表、路由队列、生命周期全在内存） | P2 |
| A11 | 私有方言错误码 `-40001` 落在 JSON-RPC 惯例区间之外 | P3 |

其中 **A8 是运行时实测确认的**：出站 A2A 通信在默认配置下 100% 不可用。

### 4.2 本次整改内容

| 改动 | 文件 | 说明 |
|------|------|------|
| **A2A 契约 schema（全新）** | `src/contracts/a2a/*.schema.json` | `agent-card` / `message` / `task` 三份 draft-07 schema，含 `Part` 判别联合与 `TaskState` 封闭枚举 |
| **Agent Card 构造纯叶子** | `src/services/a2a/agentCardSpec.js` | 符合 v0.3.0 的卡片构造 + 能力诚实常量 + 结构自检 + 发布门控 |
| **TaskState 映射纯叶子** | `src/services/a2a/taskStateSpec.js` | 三套内部状态机的合并映射表 + 迁移合法性 + 终态无出边 + 严格模式告警 |
| **内置 agent 清单单一真源** | `src/services/a2a/builtinAgentManifest.js` | 原先内联在 `a2aFacade` 私有方法里，无法被发布路径复用 |
| **Agent Card 发布端点（全新）** | `src/routes/wellKnown.js` + `server.js` 挂载 | `GET /.well-known/agent-card.json` 公开、不进信封、零硬编码 |
| 消除内联清单漂移 | `a2aFacade.js` | 改为 `require('./a2a/builtinAgentManifest')` |
| `Part` 补 `kind`（A6/A7） | `services/a2a/index.js` | `{ kind:'text', text }` |
| `createTask` 委托 `sendMessage`（A7） | `services/a2a/index.js` | 保留函数名，去除私有端点 |
| **新增 `cancelTask`（A5）** | `services/a2a/index.js` + `A2ATool` | `POST /v1/tasks/{id}:cancel`；工具操作枚举新增 `cancel_task` |
| Agent Card 修正（A3） | `services/a2a/index.js` | `securitySchemes` + `security` + `protocolVersion` + `provider` + 能力诚实 |
| **绑定 `taskId` URL 编码** | `services/a2a/index.js` | 防路径注入 |
| 发布规范文档 | `docs/_规范/[DESIGN-A2A-002]` | 划清边界、映射表、迁移路线 |
| 定位更正横幅 | `docs/_规范/[DESIGN-A2A-001]` | 明确它是私有方言，不是标准协议 |
| **命名与术语规范** | `docs/_规范/[DESIGN-NAM-002]` | A2A（标准协议）vs ACP（私有方言）的命名单一真源；方法集对照、env 前缀纪律、改名决策 |
| **协议命名守卫** | `scripts/ci/check-protocol-naming.js` + `protocol-naming.json` | 扫描全仓禁止私有方法名（`a2a.*` 等）、env 前缀纪律；**实测 0 违规，已接入 `check:structure`** |
| 参考卡纠错 | `docs/03_DESIGN_设计/[DESIGN-ARCH-073]` | 删除被当成真 API 的「A2A 速查」（私有方法名 + WebSocket 传输），改指正确规范 |

### 4.3 剩余缺口与路线

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P1 划清边界 + 命名纪律** | 发布面、契约、映射、`cancel`、`Part.kind`、命名守卫 | ✅ 本次完成（含 `check-protocol-naming` 守卫与 `[DESIGN-NAM-002]`） |
| **P2 私有方言改名** | `a2a*` → `acp*`（牵动 14 处注册、router、facade、测试） | ⬜ **需决策**（命名纪律已由守卫兜底，改名非紧急） |
| **P3 服务端任务面** | `message/send` / `tasks/get` / `tasks/cancel` 的服务端 handler + TaskStore | ⬜ **最大缺口** |
| P4 SSE 流式 | `message/stream` + 事件类型，然后打开 `capabilities.streaming` | ⬜ |
| **P5 官方一致性套件** | 接入 `a2a-tck` / `a2a-inspector` / MCP `conformance` / `inspector` | 🟡 接入规范 `[DESIGN-QUAL-002]` + 编排器 `conformance-runner.mjs` 已建（工具未装则降级 SKIPPED），release 门禁待排期 |
| P5 推送 | `tasks/pushNotificationConfig/*` | ⬜ |
| P6 外部验证 | 接入 `a2a-tck` / `a2a-inspector` | ⬜ |

> **P3 是真正的能力缺口**：khy 现在能被外部**发现**，但被**调用**时没有服务端任务
> 处理面。这是「真做 A2A」与「名义适配」之间最大的一步。

---

## 5. 维度三：软件文档完整性

### 5.1 现状盘点

| 指标 | 数值 | 评价 |
|------|------|------|
| `docs/` 文件总数 | 1,299（其中 `.md` 633） | 规模充分 |
| 两轴命名体系 | `01_INIT_立项` → `09_STORY_修仙学AI` + `_规范` / `_设计模式` / `_传承` … | 结构清晰，有 `[DESIGN-LAY-005]` 作为单一真源并由 `check:layout` 强制 |
| `docs/_规范/` 规范文档 | **70 份** | 覆盖 40+ 主题：架构 / API / 安全 / 可观测性 / 缓存 / 备份 / 灾备 / i18n / a11y / 复杂度 / 注释 / 语义化版本 … |
| 文档站 | `docs:build` / `docs:verify` / `docs:lint`，每个 `.md` 必须有同名 `.html` | **强于多数开源项目** |
| 图表入文档 | `<img src="assets/x.svg">` + 构建期死链降级 + `dead-links.json` | 有前置先例与约定 |

**结论：文档的「量」与「工程化」都很好。** 问题在**真伪混装**与**协议面空白**。

### 5.2 关键问题

| # | 问题 | 级别 | 说明 |
|---|------|------|------|
| D1 | **无 MCP 协议实现规范** | P1 | `docs/_规范/` 有 70 份文档，却没有一份讲 MCP。只有 `[CONCEPT-04]`（概念科普）与 `[OPS-MAN-173]`（接入速查），**协议层无规范** → 已新增 `[DESIGN-MCP-001]` |
| D2 | **无 A2A 标准适配规范** | P1 | `[DESIGN-A2A-001]` 描述的是私有方言而非标准协议，且未做任何区分 → 已新增 `[DESIGN-A2A-002]` + 在 001 上加定位更正横幅 |
| D3 | **无 OpenAPI / 机器可读 API 契约** | P2 | 全仓唯一的 `openapiTools.js` 是**消费**第三方 OpenAPI 的插件，不是 khy 自身 API 的描述。57 个路由文件、无一 OpenAPI |
| D4 | **无 ADR** | P2 | 无 `decisions/` 或 ADR 目录。像「为什么自建协议层而不复用 `@modelcontextprotocol/sdk` / `a2a-js`」「为什么私有方言不改名」这类**关键决策没有留痕** |
| D5 | **契约 schema 覆盖不均** | P2 | 有 `contracts/acp/`（1 份）与 `contracts/mobile/`（3 份）；**MCP 与 A2A 均无** → A2A 已补 3 份；MCP 仍缺 |
| D6 | **错误码体系存在但不强制** | P3 | `errorEnvelope.js` 有 30+ 码的统一枚举，但代码里仍大量直接 `throw new Error('中文消息')`，无 lint/守卫强制 |

### 5.3 本次整改内容

1. `docs/_规范/[DESIGN-MCP-001] MCP 协议实现规范.md` —— 分层契约、修订声明恒等式、
   传输要求（含 `Origin` 威胁模型）、工具与结果形状、JSON-RPC 信封、扩展 SOP、
   反模式清单。
2. `docs/_规范/[DESIGN-A2A-002] A2A 标准协议适配规范.md` —— 双 A2A 边界划定、
   Agent Card 三条硬约束、能力诚实性、数据对象契约、TaskState 映射表、
   客户端操作对照、命名纪律条款、六阶段迁移路线。
3. `docs/_规范/[DESIGN-A2A-001]` 定位更正横幅（含私有方言 vs 标准协议的对照表）。
4. `services/backend/src/contracts/a2a/README.md` —— 契约目录说明 + 四条历史踩坑约束。
5. 已同步生成对应 `.html`（`docs:verify` 要求）。

---

## 6. 维度四：代码标准合规性

### 6.1 体系：齐全

| 规则 | 内容 | 守卫 |
|------|------|------|
| **NAM-001** | JS camelCase / Python snake_case / CSS BEM | `check-code-standards.js` |
| **COM-001** | 公开函数需 JSDoc；禁止裸 TODO/FIXME | 同上 |
| **COMP-001** | 函数 ≤ 50 行、参数 ≤ 5、嵌套 ≤ 4、文件 ≤ 500 行 | 同上 |
| 其它 | 层级/结构、依赖方向、零硬编码、flag 治理、重复代码、前端体积、依赖体积、构建产物、运行时落位、prompt 分类、JSON schema、协议契约、可靠性、安全头、鉴权会话、API 契约、上传安全、设计 token … | **`scripts/ci/` 共 55 个脚本** |

这已是**远超市面上绝大多数开源项目**的治理密度。项目自身的 `[DESIGN-GOV-001] 治理总纲`
把规则收拢为 MOD / MEM / TOOL / ACP / API 五个板块，`check:gov-rules` 校验入口连通性 ——
设计思路是对的。

### 6.2 关键问题

| # | 问题 | 级别 | 说明 |
|---|------|------|------|
| C1 | **基线已失效（最重要的发现）** | P1 | `code-standards.baseline.json` 的规则是「超过基线 max 才失败」，而基线被设为：`functionLines.max = 12000`、`nestingDepth.max = 12000`、`consoleLog.max = 5000`、`fileLines.max = 600`。**允许 12000 个超长函数、5000 处 console.log** 的「标准」实际上不再约束任何东西 —— 它只能防止「变得更差」 |
| C2 | **仓库层级守卫整片红且基线为 0** | P1 | `dangling-task 88`、`cross-layer-require 37`、`unresolved-require 22`、`extension-id-hardcode 1`、`docs-index-complete 2`，而 baseline 全为 `0` → 守卫恒红，等同于**长期失效的门** |
| C3 | 同类问题在仓库内「对错并存」 | P2 | 见下表 |
| C4 | 无 API 版本化政策 | P2 | HTTP API 无 `/v1` 前缀，而数据文件侧有完整的 `SCHEMA_VERSION` + 迁移链（`boulderState.js`）—— 落差明显 |
| C5 | `unresolved-require` 22 处 | P2 | 指向磁盘上不存在的路径，**潜在崩溃**，只在跑到那条命令时才触发 |

### 6.3 「做对了 / 做错了」对照表（C3 的证据）

本次调研最有价值的发现之一：**同类问题在仓库内同时存在正确与错误两个版本。**
这说明问题不在能力，而在**治理执行**。

| 维度 | ✅ 做对了 | ❌ 做错了 |
|------|-----------|-----------|
| MCP 能力声明 | server 端诚实只声明 `tools` | client 端虚报 `tools/resources/prompts`（服务端字段） |
| A2A 能力声明 | — | 卡片声明 `streaming: true` 但零实现 |
| CORS | monolith 白名单（仅 localhost 固定端口 + `credentials:true`） | gateway 默认 `origin = '*'`，且注释自称「never used」 |
| 错误输出 | 全局中间件只在 development 回 stack | 管理服务直接回 `err.message`（十余处） |
| 命令执行 | MCP stdio 用 `spawn(command,args,{stdio})` 无 shell | 扩展管理用 `execSync(\`git clone … ${url} ${dest}\`)` |
| 契约校验 | ACP 有 JSON Schema + 运行时校验 | 工具**结果**层无 schema 校验 |
| flag 治理 | `isServeEnabled` 走 `flagRegistry` | `KHY_TOOL_LOOP_MAX_ITERATIONS` 直读 `process.env` |
| 数据版本化 | `boulderState.js` 有完整迁移链 | HTTP API 无版本前缀 |
| 文件权限 | `credentialGenerator.js` 做了 `chmod 0o600` | `secretManagers/index.js` 的 `writeFileSync` 未传 mode |

### 6.4 本次整改内容

1. **新增 `check-protocol-conformance.js`** —— 把「协议声明 vs 实现」变成 75 项
   可执行断言（MCP 27 + A2A 48），已接入 `check:structure` 与 `check:all-standards`。
2. 新代码全部遵守既有标准：纯叶子契约（`check-leaf-contract` 通过）、两空格 / 单引号 /
   分号、JSDoc、无硬编码。
3. `check-node-syntax` 对全部 11 个改动文件通过。
4. **基线重置为实测值**（`code-standards.baseline.json`：functionLines 10800→2144、
   nestingDepth 10800→8703、fileLines 512→352、consoleLog 4592→4584），门不再「只拦翻倍级恶化」。
5. **新增债务台账机制**：`debt-ledger.json`（12 条，layout 4 类 + standards 5 类 + 已归零 3 类）
   + `check-debt-ledger.js`（覆盖完整性 / 只降不升棘轮 / 逾期留痕），已接入 `check:structure`；
   `check-repo-layout` 的存量债（unresolved-require 21 / cross-layer-require 37 / dangling-task 88 /
   extension-id-hardcode 1）全部登记入账，每条带 owner/dueBy/plan。

---

## 7. 主动补充维度（用户未提及）

### 7.1 一致性验证能力缺失 ★ 最重要

| 协议 | 官方验证工具 | khy-os 是否接入 |
|------|--------------|-----------------|
| MCP | `inspector`（10.6k⭐）、`conformance` | ❌ 否 |
| A2A | `a2a-inspector`、`a2a-tck`（技术一致性套件） | ❌ 否 |

此前项目从未用**外部**工具验证过任何合规结论 —— 所有「合规」判断都来自自审。
本次新增的守卫是**自建内部替代**（纯函数级实测），覆盖面远不及官方 TCK
（后者含跨实现互操作、传输层端到端、边界用例）。

**本次已补机制层**：`[DESIGN-QUAL-002] 官方一致性套件接入规范` 锁定了权威工具
（`@modelcontextprotocol/conformance`、`@modelcontextprotocol/inspector`、`a2a-tck`、`a2a-inspector`）、
所需产出物（MCP `results/server-*/checks.json`、A2A `reports/compatibility.json|html|junit`）、
版本钉扎与 CI 接线；`scripts/ci/conformance-runner.mjs` 已就位（工具未安装时降级 SKIPPED，
`--required` 在 CI 强制产出真实报告）。**待排期**：在 release 流水线安装工具并以 `--required` 运行。

**建议**：把「接入官方 TCK」列为一等验收标准，而不是可选项。

### 7.2 安全横切面不统一

见 §6.3 对照表。**可静态检测**，建议扩展既有 `archDebtScan.js` 或新增扫描器覆盖：
未挂鉴权的路由、模板字符串拼入 `exec*`、`catch` 里 `resolve({status:0})` 式静默降级、
CORS `origin` 字面量 `'*'`、`sendError(res, 5xx, err.message)`。

### 7.3 可观测性默认关闭

- 工具循环有 `traceAudit.logEvent('agent.loop.start')`，**无对应的 `agent.loop.end`**
  → trace 无法自动配对计算循环时长；
- breadcrumb 需 `KHY_LOOP_DEBUG` 才写（**默认关**）；
- 结果：默认配置下一次完整循环**不可观测**。

### 7.4 发布与版本轨道

- 主轨道 4 个真源（`pyproject.toml` / npm package.json / backend package.json /
  modules.json）+ ai-backend 轨道 2 个真源，由 `check-version-sync.js` 强制 —— 设计良好。
- 缺 **HTTP API 版本化政策**（无 `/v1`），与数据文件侧的成熟迁移链形成落差。
- 缺失：**发布物 SBOM / 依赖许可证清单**。

### 7.5 可恢复性

- 主循环无逐轮 journal；
- 检查点每 3 轮 / 45 s 一次，且**按 `cwd` 单槽覆盖** → 同目录并发会话互相覆盖；
- 恢复是「快照拼回 prompt」而非精确重放。

### 7.6 许可证、生态位与重造轮子风险

- A2A 官方 SDK（`a2a-js`，Apache-2.0，564⭐）与 MCP 官方 `typescript-sdk`
  （13.1k⭐）均为 Node 生态成熟实现。khy-os 选择自建协议层（`mcpServerProtocol.js`
  自带 `SUPPORTED_PROTOCOL_VERSIONS`、自建 `A2AClient`）—— 这在**可控性**与
  **零依赖纪律**上说得通，但代价是：每次协议修订都要自己跟，且没有官方一致性
  测试背书。
- **无 ADR 记录该取舍**（见 D4）。
- **建议**：补一份 ADR，明确「自建 vs 复用 SDK」的判据与**复审触发条件**
  （例如「下一个协议修订需实现流式语义时复审」）。

---

## 8. 差距汇总

### 8.1 按严重度

| 级别 | 数量 | 分布 |
|------|------|------|
| **P0** | 1 | 安全：MCP HTTP server 缺 `Origin` 校验（已修，本次补回归锁） |
| **P1** | 14 | MCP×7、A2A×6、代码标准×1（基线失效） |
| **P2** | 16 | MCP×3、A2A×4、文档×4、代码标准×3、补充维度×2 |
| **P3** | 6 | 信封校验、错误码、文档×2、错误处理×1、命名 |

### 8.2 本次已关闭（含回归锁）

| # | 问题 | 关闭方式 |
|---|------|----------|
| M5 | `Origin` 校验 | 前置补丁已修；**本次补实测断言**（`transport-streamable-http-origin-403`） |
| M1/M2/M3/M4 | 版本协商、客户端能力、服务端请求响应、按能力调用 | 前置补丁已修；本次补 4 条探针 |
| M6/M7/M8 | 协议版本头、会话校验、`WWW-Authenticate` | 同上 |
| M10 | `jsonrpc` 信封校验 | 本次实现 + 探针 |
| M11 | 结构化数据损坏 | 本次实现（`structuredContent`）+ 探针 |
| A2 | 无 Agent Card 端点 | 本次实现（`/.well-known/agent-card.json`）+ 48 项 A2A 断言 |
| A3 | Agent Card 字段不符规范 | 本次实现 + schema |
| A4 | 私有 TaskState 透出 | 本次实现（映射表 + 封闭枚举 + 反面断言） |
| A5 | 无 `tasks/cancel` | 本次实现 |
| A7 | `createTask` 私有端点 | 本次改为委托 `message/send` |
| A8 | 出站 header `undefined` | 前置补丁已修；本次补 4 条行为测试 |
| A9 | 内置 agent 清单不可复用 | 本次抽为单一真源 |
| D1/D2/D5 | 缺 MCP/A2A 规范与契约 | 本次新增 2 份规范 + 3 份 schema + 1 份 README |

### 8.3 未关闭（按优先级）

| 优先级 | 项 |
|--------|----|
| **P1** | A6/P4 SSE 流式；**P3 服务端任务面**；C1 基线失效；C2 层级守卫整片红 |
| **P2** | P2 私有方言改名（需决策）；M9 传输端点混用；A10 任务持久化；D3 OpenAPI；D4 ADR；C4 API 版本化；C5 22 处 unresolved-require；补充维度 7.2–7.6 |
| **P3** | M12；A11；D6 错误码强制；T4/T5 文档与 flag 漂移；命名违规 4 处 |

---

## 9. 结论

**khy-os 不是「做得差」，而是「做得太多、验得太少」。**

它有 55 个 CI 守卫、70 份规范文档、清晰的六层仓库架构、`[DESIGN-GOV-001]` 治理总纲 ——
这套框架的**设计水平**超过绝大多数开源项目。问题出在**执行闭环**：规范写了但基线
被抬到失效、守卫装了但整片恒红、修复做了但没有回归锁、能力声明写了但没人验。
结果是同一类故障（声明与实现不一致）在最关键的协议面上反复出现。

**本次调研的处置策略是「把声明变成被实测的数据」**：

- MCP 侧 → `PROTOCOL_CONFORMANCE` 一致性矩阵（32 行声明 + 27 条实测探针）；
- A2A 侧 → `IMPLEMENTED_CAPABILITIES` 诚实常量 + 48 条实测断言（含 9 条**反面断言**，
  确保缺陷无法复活）；
- 两边统一由 `check-protocol-conformance.js` 强制，接入 `check:structure`。

**下一步最该做的三件事**（按投入产出比排序；前两项机制已建，剩能力落地）：

1. **把官方一致性套件接入 release 流水线**（MCP `conformance` + A2A `a2a-tck`）——
   机制层（`[DESIGN-QUAL-002]` + `conformance-runner.mjs`）已就位，下一步是安装工具并以
   `--required` 纳入发布门、把 known-failure 固化进 expected-failures 且只缩不扩。这是唯一能证明
   合规结论可信的动作。
2. **补齐 A2A 服务端任务面（P3）** —— khy 现在能被发现、不能被调用（最大能力缺口）。
3. **清偿 `debt-ledger.json` 登记的存量债** —— `unresolved-require 21` / `cross-layer-require 37` /
   `dangling-task 88` / `consoleLog 4584` 等已入账且有 owner/dueBy，按季度下降即可让「恒红的门」逐一转绿；
   红着的门等于没有门，这比新增任何功能都更影响长期质量。

---

*本报告由协议与工程规范调研产出；配套的分步改进计划见
`khy-os-协议与工程规范分步改进计划-2026-09-15.md`。*
