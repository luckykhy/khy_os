# [DESIGN-A2A-002] A2A 标准协议适配规范

<!-- naming-guard: exempt 本文对照列出私有方言的历史错误命名，作为「不要这样写」的反例 -->

> **状态**：生效中
> **适用范围**：`services/backend/src/services/a2a/**`、`src/routes/wellKnown.js`、
> `src/contracts/a2a/**`、`src/tools/A2ATool/**`，以及所有 `a2a*` / `acp*` 模块的
> **命名与协议边界**
> **对照标准**：Agent2Agent (A2A) Protocol **v0.3.0**（Linux Foundation，Google 捐赠；
> v1.0 RC 已发布）
> **机器可读真源**：`agentCardSpec.js`、`taskStateSpec.js`、`builtinAgentManifest.js`
> **契约**：`services/backend/src/contracts/a2a/*.schema.json`
> **强制手段**：`npm run check:protocol-conformance`
> **前置阅读**：`[DESIGN-A2A-001] A2A 协议规范`（那是**另一套东西**，见 §1）

---

## 1. 问题陈述：仓库里有两个「A2A」

这是理解本规范所有条款的前提，也是审计中最容易误判的一点。

| 实现 | 位置 | 实质 |
|------|------|------|
| **标准 A2A 出站客户端** | `services/backend/src/services/a2a/index.js` | 使用 A2A 的 REST 绑定路径（`/.well-known/agent-card.json`、`/v1/message:send`），`role` + `parts[]`，Bearer 认证 |
| **私有 ACP 方言** | `acpTransport.js` / `a2aRegistry.js` / `a2aMessageRouter.js` / `a2aFacade.js` / `a2aAgentLifecycle.js` | **纯进程内私有 JSON-RPC 方言**，方法名 `agent.spawn` / `task.submit` / `message.send`，协议版本号 `1.0`，传输为自建 ipc/ws/http |

两者的方法集**无一重合**：A2A 标准方法是 `message/send`、`message/stream`、
`tasks/get`、`tasks/cancel`、`tasks/pushNotificationConfig/*`；私有方言是
`a2a.discovery.register`、`a2a.task.create`、`a2a.capability.invoke` …

**命名撞车带来的真实危害**：内部代码（含 14 个内置 agent 的注册）大量以 `a2a` 为
前缀，造成「已实现 A2A」的错觉；`docs/10_规范/[DESIGN-A2A-001]` 更是把私有方言
逐字写成「A2A 协议规范」，把传输层写成 WebSocket/gRPC（与标准 A2A 的
HTTP + SSE 完全不同），状态集写成一套无人认识的私有集合。任何外部读者据此对接
都会失败。

### 处置决策（2026-09-15）

**两条线各自独立演进，通过本规范划清边界：**

1. **私有 ACP 方言保留原样**（它有真实用途：进程内多 agent 编排、子代理生命周期、
   死信队列），但**改名事宜暂缓** —— 改名会牵动 14 处内置 agent 注册、router、
   facade、生命周期与既有测试，属独立的破坏性变更批次。本规范先解决「文档与协议
   边界被混淆」这一层。
2. **标准 A2A 建设为对外互操作面**：发布 Agent Card、统一状态语义、补齐
   `tasks/cancel`、修正对象形状。

**条款 A2A-0（命名纪律，立即生效）**：任何文档、注释、工具描述中，
**禁止**把私有 ACP 方言称作「A2A 协议」。引用它时必须写明「私有 ACP 方言」并链接
`[DESIGN-A2A-001]`。`[DESIGN-A2A-001]` 自身已加定位横幅。

---

## 2. 发布面：Agent Card

### 2.1 端点

| 路径 | 状态 | 说明 |
|------|------|------|
| `GET /.well-known/agent-card.json` | ✅ 发布 | 标准 A2A v0.3.0 发现端点（RFC 8615） |
| `GET /.well-known/agent.json` | ⚪ 默认 404 | v0.2.x 历史路径。需 `KHY_A2A_LEGACY_AGENT_JSON=1` 显式开启 |
| `GET /.well-known/*` | 404 | 其余一律 JSON 404 |

实现：`src/routes/wellKnown.js`，挂载于 `server.js` 的 `app.use('/.well-known', …)`。

### 2.2 三条硬约束

**A2A-1（公开）** Agent Card 端点**必须**无需鉴权即可读取 —— 它正是外部 orchestrator
用来判断「要不要给我令牌」的依据，挂上鉴权会让发现流程死锁。卡片只含能力元数据，
`securitySchemes` 描述的是**如何**鉴权，不是密钥本身。

**A2A-2（不进信封）** 响应体**必须**逐字段符合 `agent-card.schema.json`，
**不得**套 khy 的 `{success, data}` 信封。（`envelopeMiddleware` 只包装带布尔
`success` 字段的对象，故本路由天然不受影响 —— 但这条必须写下来，否则将来有人
「顺手统一格式」就会把协议打穿。）

**A2A-3（零硬编码）** `url` 优先取 `KHY_A2A_PUBLIC_URL`；缺省则**从请求头推导**
`protocol://host`。**禁止**写死域名或端口（`AGENTS.md` 工程规则 1）。
唯一例外是畸形输入时的兜底 `http://127.0.0.1:0`。

### 2.3 能力诚实性（A2A-4）

`capabilities` 的每个 `true` 都**必须**在代码里确有其事。当前：

```json
{ "streaming": false, "pushNotifications": false, "stateTransitionHistory": false }
```

三项全 false 是**诚实**结果，不是没做完的占位：
- `streaming` → 全仓 `message/stream`、`TaskStatusUpdateEvent`、
  `TaskArtifactUpdateEvent` 零命中；
- `pushNotifications` → 无 `tasks/pushNotificationConfig/*`；
- `stateTransitionHistory` → `tasks/get` 不回迁移历史。

**要打开某一项，先在代码里把它做出来，再改布尔** —— 不允许反过来先改卡片。
守卫 `capability-honesty:*` 会对此做实测断言。

### 2.4 技能来源（A2A-5）

`skills` **必须**来自 `builtinAgentManifest.js` 这一单一真源（每个能力标签一条
AgentSkill）。**禁止**为卡片手写营销式描述 —— 卡片上写的应当是真实存在的 agent 能力。

---

## 3. 数据对象

契约目录：`services/backend/src/contracts/a2a/`（与 `../acp/`、`../mobile/` 同约定）。

| 文件 | 对象 |
|------|------|
| `agent-card.schema.json` | `AgentCard` |
| `message.schema.json` | `Message` + `Part`（TextPart / FilePart / DataPart） |
| `task.schema.json` | `Task` / `TaskStatus` / `TaskState` / `Artifact` |

**A2A-6** `Part` 是 **`kind` 判别联合**。`{ "text": "…" }` 而缺 `kind` **不是**合法
Part，标准客户端会拒收。这是 `services/a2a/index.js` 的历史真实缺陷，守卫用反面
断言（`message-schema:rejects-part-without-kind`）把它锁死。

**A2A-7** Agent Card 必填字段（schema 强制）：
`protocolVersion`、`name`、`description`、`url`、`version`、`capabilities`、
`defaultInputModes`、`defaultOutputModes`、`skills`。

**A2A-8** 旧字段 `authentication: { schemes: [...] }` **不是** A2A 字段。正确写法是
`securitySchemes`（OpenAPI 风格） + `security`（引用列表）。声明 `security` 却无
`securitySchemes` 属悬空引用，schema 与 `validateCardShape()` 都会拒。

---

## 4. 任务状态：映射而非透出

### 4.1 规范状态集（封闭）

```
submitted | working | input-required | completed | canceled |
failed | rejected | auth-required | unknown
```

终态（**不得**再有出边）：`completed` / `canceled` / `failed` / `rejected`。

### 4.2 内部状态 → 规范状态

khy 内部有**至少三套**互不相同的生命周期状态机，与规范的词面重合只有 2 个。
**A2A-9**：禁止把内部状态直接透出到协议边界，**必须**经
`taskStateSpec.toA2aState()` 映射。

| 内部（来源） | 规范目标 | 理由 |
|--------------|----------|------|
| `pending` / `spawning`（a2aAgentLifecycle） | `submitted` | 已登记、尚未起进程 / 起进程属准备阶段 |
| `created` / `initializing` / `ready`（stateMachine） | `submitted` | 就绪但未开工 |
| `running` | `working` | 正在干活 |
| `completing` | `working` | 规范无「完成中」态 |
| `killing` | `working` | 取消尚未生效；成功取消后转 `canceled` |
| `waiting` | `input-required` | 等待外部输入/子代理，规范里最接近的中断态 |
| `completed` / `success` / `ok` | `completed` | — |
| `failed` / `error` / `timed_out` / `timeout` | `failed` | 超时是失败的一种 |
| `killed` / `cancelled` | `canceled` | 被主动终止 ≡ 规范 `canceled` |
| 未知 / 畸形输入 | `unknown` | 规范定义的合法值，代表「无法判定」 |

**A2A-10**：新增内部状态时**必须**同步映射表。`unmappedKnownStates()` 与守卫
`task-state-mapping-complete` 会立刻报出未映射的状态名。
严格模式 `KHY_A2A_STRICT_TASK_STATE=1` 下，未映射状态还会触发告警回调。

**A2A-11**：状态集是封闭的。守卫用反面断言
（`task-schema:rejects-private-state:spawning`）确保私有状态无法通过 schema。

---

## 5. 客户端操作（出站）

`services/a2a/index.js` 导出与规范方法的对应：

| 函数 | 规范方法 | REST 绑定路径 | 备注 |
|------|----------|---------------|------|
| `getAgentCard(url)` | — | `GET /.well-known/agent-card.json` | 发现 |
| `sendMessage(url, text, opts)` | `message/send` | `POST /v1/message:send` | 任务由服务端隐式创建 |
| `createTask(url, text, opts)` | `message/send` | 同上 | **别名**，见下 |
| `getTask(url, id)` | `tasks/get` | `GET /v1/tasks/{id}` | id 做 URL 编码 |
| `cancelTask(url, id)` | `tasks/cancel` | `POST /v1/tasks/{id}:cancel` | 2026-09-15 新增 |

**A2A-12（无独立的创建任务 RPC）** A2A 中任务由服务端在 `message/send` 时隐式创建，
`taskId` 由**服务端**生成。旧实现 `POST /v1/tasks` 并自带顶层 `id` 与 `messages[]`
数组，既不是 JSON-RPC 方法也不是任何 REST 绑定路径，属私有扩展，无法与标准 agent
互通。`createTask` 现**委托** `sendMessage`（函数名保留以兼容调用方）。
守卫 `no-nonstandard-tasks-post` 禁止该私有端点复活。

**A2A-13（header 卫生）** 出站 header **必须**在 `_request` 入口统一过滤
`undefined` / `null` / `''`。Node 的 `http.request` 对 `undefined` 值的 header
**同步抛** `ERR_HTTP_INVALID_HEADER_VALUE`，异常若被 catch 吞掉就表现为「出站
A2A 100% 静默失败」。失败结果**必须**带 `phase`（`build` / `network` / `timeout`）
以便区分「参数问题」与「对端不可达」。

---

## 6. 私有 ACP 方言的边界

**A2A-14** 私有方言**不得**：
- 出现在 Agent Card 的 `skills` / `capabilities` 中；
- 被任何文档描述为 A2A 标准实现；
- 新增以 `a2a.` 为前缀的方法名（该前缀已被标准方法的语义占据，会持续加剧混淆）。
  新增内部方法一律用 `acp.` 前缀。

**A2A-15** 其错误码应迁回 JSON-RPC 惯例区间 `-32000 ~ -32099`
（现状 `-40001` 等虽不违反 JSON-RPC 硬性禁止，但与生态工具的错误码解析逻辑冲突）。
属独立批次，登记为技术债。

---

## 7. 与 MCP 的分工

| 面 | 协议 | 用途 |
|----|------|------|
| 工具访问 | **MCP** | khy 连接外部工具/数据源；同时把自身工具暴露为 MCP server |
| Agent 互操作 | **A2A** | khy 与其它 agent 互相发现、委派任务 |

两者互补，**不得**互相替代。Agent Card 的 `description` 中应明确写清「工具面走
MCP」，避免外部 orchestrator 误以为 A2A 是工具通道。

---

## 8. 迁移路线

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P1 划清边界** | Agent Card 端点、契约 schema、状态映射、`tasks/cancel`、Part `kind`、能力诚实化、命名纪律条款 | ✅ 本规范落地 |
| **P2 让私有方言名副其实** | 评估把 `a2a*` 模块改名为 `acp*`（含 14 处内置 agent 注册、router、facade、测试） | ⬜ 待决策 |
| **P3 服务端任务面** | 实现 `message/send` / `tasks/get` / `tasks/cancel` 的服务端 handler + 任务存储（当前只有出站客户端） | ⬜ 未开始 |
| **P4 流式** | SSE `message/stream`、`TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`，然后把 `capabilities.streaming` 改为 `true` | ⬜ 未开始 |
| **P5 推送** | `tasks/pushNotificationConfig/*` | ⬜ 未开始 |
| **P6 一致性验证** | 接入官方 `a2a-tck` / `a2a-inspector` 做端到端合规测试 | ⬜ 未开始 |

**P3 是真正的能力缺口**：khy 目前能被外部**发现**（P1 已做到），但被**调用**时
没有服务端任务处理面。这是与「真做 A2A」之间最大的一步。

---

## 9. 验证

```bash
npm run check:protocol-conformance                  # MCP + A2A 全量
node scripts/ci/check-protocol-conformance.js --a2a
npm test --workspace services/backend -- tests/services/a2a
```

---

## 10. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-15 | 首版：双 A2A 边界划定、Agent Card 发布面、契约 schema、TaskState 映射表、客户端操作对照、迁移路线 |
