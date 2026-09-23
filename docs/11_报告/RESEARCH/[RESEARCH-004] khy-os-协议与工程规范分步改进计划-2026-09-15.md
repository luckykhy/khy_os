# khy-os 协议与工程规范分步改进计划

<!-- naming-guard: exempt 改进计划引用历史错误命名与候选环境变量名作为行动项 -->

- **制定日期**：2026-09-15
- **依据**：`khy-os-协议与工程规范深度调研报告-2026-09-15.md`
- **范围**：MCP 协议、A2A 协议、软件文档、代码标准，及补充维度
- **执行状态**：**第 0~1 阶段已完成并验证**（见 §5）；三大核心问题（A2A/ACP 命名错位、基线失效与门禁恒红、官方一致性套件缺失）的**规范化整改机制已落地**（见 §5.5）；第 2~4 阶段（清偿存量债、A2A 服务端、协议版本推进）待排期

---

## 1. 现状分析

### 1.1 已有资产（应保留、不复建）

| 资产 | 规模 | 价值 |
|------|------|------|
| 仓库分层架构 | L0 `kernel/` → L6 `tools/`，7 层 | 有 `[DESIGN-LAY-005]` 单一真源，`check:layout` 强制 |
| CI 守卫 | **55 个**脚本（`scripts/ci/`） | 治理密度远超同体量项目 |
| 规范文档 | **70 份**（`docs/_规范/`） | 覆盖 40+ 主题 |
| 治理总纲 | `[DESIGN-GOV-001]` MOD/MEM/TOOL/ACP/API 五板块 | 规则可检索、可定位 |
| 文档站 | `docs:build` / `docs:verify` / `docs:lint` | 每个 `.md` 强制有同名 `.html`，构建期死链降级 |
| MCP 实现 | 21 个文件，协议层与传输层干净解耦 | 纯叶子可确定性单测 |
| 契约目录 | `src/contracts/{acp,mobile}/` | 已有「契约即代码」先例 |
| 版本同步 | 双轨道 6 个真源 + `check-version-sync.js` | 防漂移 |
| 私有 agent 编排 | registry / router / lifecycle / facade | 进程内多 agent 协作能力完整 |

### 1.2 核心问题（一句话）

> **规范写了但基线被抬到失效、守卫装了但整片恒红、修复做了但没有回归锁、
> 能力声明写了但没人验。**

三类具体故障反复出现在协议面上：

1. **能力虚报** —— MCP client 声明服务端字段；A2A 卡片声明 `streaming: true` 而零实现。
2. **声明与实现不一致** —— 协议版本在两处各维护一份；server 诚实只声明 `tools`，
   自家 client 却发 `resources/list`。
3. **文档与协议实体错位** —— 私有 ACP 方言被逐字写成「A2A 协议规范」，
   传输层写成 WebSocket（标准 A2A 用 SSE）。

---

## 2. 差距评估

### 2.1 四维评分与关键差距

| 维度 | 评级 | 最关键差距 | 根因 |
|------|------|-----------|------|
| 工具 MCP 化 | 🟡 B | 协议版本停在 `2024-11-05`（缺 SSE 流式与断线续传）；无 OAuth 授权服务器发现 | 缺「声明→实测」闭环，故修复慢、无法声明新修订 |
| A2A 适配 | 🔴 D | **无服务端任务处理面**（能被发现、不能被调用）；两套「A2A」混淆 | 从未明确过「私有方言 vs 标准协议」的边界 |
| 文档完整性 | 🟡 B− | 无 MCP 协议规范、无 A2A 标准规范、无 OpenAPI、无 ADR | 文档「数量驱动」而非「协议驱动」 |
| 代码标准 | 🟡 C+ | **基线失效**（允许 12000 个超长函数 / 5000 处 console）；`check:layout` 整片红且 baseline=0 | 「只降不升」策略在无清偿计划时退化为「永不修」 |

### 2.2 补齐维度（用户未提及）

| 维度 | 差距 | 严重度 |
|------|------|--------|
| **一致性验证** | 未接入任何官方 TCK / Inspector，所有合规结论均为自审 | ★★★ |
| 安全横切面 | CORS / 错误输出 / 命令执行 / 凭据存储「对错并存」 | ★★★ |
| 可观测性 | 有 `agent.loop.start` 无 `loop.end`；breadcrumb 默认关 | ★★ |
| 发布与版本化 | HTTP API 无 `/v1`；无 SBOM / 许可证清单 | ★★ |
| 可恢复性 | 无逐轮 journal；检查点按 `cwd` 单槽覆盖 | ★★ |
| 生态位取舍 | 自建协议层的取舍无 ADR 留痕，无复审触发条件 | ★★ |

### 2.3 差距到行动的映射

```
能力虚报 ────────────► 一致性矩阵 + 诚实常量 + 守卫实测   [已完成 §5]
声明与实现不一致 ─────► 单一真源抽取 + 恒等式断言         [已完成 §5]
文档错位 ────────────► 边界划定规范 + 定位更正横幅        [已完成 §5]
协议版本落后 ─────────► 补 SSE 流式（P4）                 [待排期]
A2A 不可被调用 ───────► 服务端任务面 + TaskStore（P3）    [待排期]
基线失效 / 守卫恒红 ──► 债务清偿计划（P2 阶段 A）          [待排期]
自审无背书 ──────────► 接入官方 TCK / Inspector（P1）      [待排期]
```

---

## 3. 实施路线总览

| 阶段 | 目标 | 内容 | 状态 |
|------|------|------|------|
| **S0 建立可验证基线** | 让「合规」可被机器判定 | 一致性矩阵、诚实常量、协议契约 schema、单测 | ✅ **完成** |
| **S1 划清协议边界** | 消除两个「A2A」带来的认知与对接风险 | A2A 发布端点、状态映射、`tasks/cancel`、两份规范文档 | ✅ **完成** |
| **S2 清偿治理债** | 让已有的门真的能挡住东西 | 基线清偿、恒红守卫、静默降级扫描器 | 🟡 **机制已建**（债务台账 + 基线重置为实测值 + `check:debt-ledger` 接入 `check:structure`），存量清偿待排期 |
| **S3 补 A2A 服务端** | 从「可被发现」到「可被调用」 | `message/send` / `tasks/get` / `tasks/cancel` handler + TaskStore | ⬜ 待排期 |
| **S4 协议版本推进** | 支持 `2025-03-26` 与 A2A 流式 | MCP SSE 响应体 + `Last-Event-ID`；A2A `message/stream` | ⬜ 待排期 |
| **S5 外部验证** | 把「自证」升级为「他证」 | 接入 `mcp inspector`/`conformance`、`a2a-tck`/`a2a-inspector` | 🟡 **接入规范与编排器已建**（`[DESIGN-QUAL-002]` + `conformance-runner.mjs`），工具安装与 release 门禁待排期 |

---

## 4. S2~S5 详细步骤

### S2 —— 清偿治理债（建议最先做，因为它让后续所有工作可信）

**S2.1 修复 `check-repo-layout` 的整片红（P1）**

现状：`dangling-task 88`、`cross-layer-require 37`、`unresolved-require 22`、
`extension-id-hardcode 1`、`docs-index-complete 2`，baseline 全 `0`。

步骤：
1. `node scripts/ci/check-repo-layout.js --list=unresolved-require` —— **先修这 22 处**
   （它们指向磁盘上不存在的路径，是**潜在崩溃**，收益最高）。
2. `--list=cross-layer-require` —— 37 处跨 workspace 深相对 require，改为 workspace
   包名（如 `@khy/shared`）。
3. `--list=dangling-task` —— 88 个被引用但未定义的 `npm run` 目标：删除死引用或补齐脚本。
4. `--list=docs-index-complete` —— 2 份阶段文档补进 `docs/00_INDEX_文档索引.md`。
5. 全部清零后 `--update-baseline` 重新落基线为 `0`。

**验收**：`npm run check:layout` exit 0 且 baseline 全 0。

**S2.2 让 `check-code-standards` 重新有约束力（P1）**

现状基线允许：12000 个 >50 行函数、12000 处嵌套 >4、5000 处 `console.*`。

步骤：
1. 先**确认口径**：核对 `functionLines / nestingDepth` 的统计是否含生成代码或
   非 `services/backend/src` 目录（数字异常大，可能高估）。
2. 按模块分批清偿：优先 `services/backend/src/services/domain/messaging/mcp/`、
   `services/backend/src/services/a2a*`（本次改动区）作为示范。
3. 把基线按季度下调（如每次 -10%），并把 `max` 与 `current` 的差距写进
   `[DESIGN-COMP-001]` 的分期目标。
4. `consoleLog` 单独处理：用既有 `scripts/frontend/cleanup-console.js` 的模式，
   把非测试文件的 `console.*` 改为统一 logger。

**验收**：基线 `max` 逐季单调下降；`check:code-standards` 保持 exit 0。

**S2.3 新增「静默降级」扫描器（P2）**

新增 `scripts/ci/check-silent-degradation.js`，静态检测：
- 未挂鉴权中间件的路由（对照路由注册表与 auth 表）
- `execSync` / `exec` 中出现模板字符串拼接
- `catch` 块里 `resolve({ status: 0 })` / `return null` 式静默降级
- CORS `origin` 字面量 `'*'`
- `sendError(res, 5xx, err.message)`

**验收**：新脚本接入 `check:changed`；对现有代码产出**存量清单**（先警告，
分批清偿后再升为 error）。

**S2.4 可观测性默认开启（P2）**

1. 补 `traceAudit.logEvent('agent.loop.end')`，与既有 `agent.loop.start` 配对。
2. 把 breadcrumb 从 `KHY_LOOP_DEBUG` 门控改为**默认开**（保留关闭开关）。
3. 检查点按**会话 id** 分槽（当前按 `cwd` 单槽覆盖）。

**验收**：默认配置下一次完整循环可在 trace 里配对；同目录两个并发会话互不覆盖。

### S3 —— A2A 服务端任务面（P3，最大能力缺口）

**目标**：khy 不仅能被外部 orchestrate **发现**，还能被**调用**。

**S3.1 契约先行**
- 新增 `src/contracts/a2a/rpc-request.schema.json`（`message/send` / `tasks/get` /
  `tasks/cancel` 的请求与响应信封）。
- 复用已落地的 `message.schema.json` / `task.schema.json`。

**S3.2 任务存储**
- 新增 `src/services/a2a/taskStore.js`：接口 `create / get / updateStatus / list / cancel`。
- 开发实现 `InMemoryTaskStore`（对齐官方 SDK 的命名与语义）；生产实现可复用既有
  `better-sqlite3`（`sessions.db` 同源）。
- **门控** `KHY_A2A_TASK_STORE`（`memory` | `sqlite`），默认 `memory`。

**S3.3 JSON-RPC 服务端面**
- 新增 `src/services/a2a/serverMethods.js`（纯叶子派发）+ 薄 IO 适配。
- 方法：`message/send`、`tasks/get`、`tasks/cancel`；未实现的方法回
  `-32004 UnsupportedOperation`（**不得**回 `-32601`，因为能力已声明）。
- `tasks/get` 的 `status.state` **必须**经 `taskStateSpec.toA2aState()`。
- 会话隔离用 `contextId`；`taskId` 由服务端生成（`crypto.randomUUID()`）。

**S3.4 接线**
- 挂到既有的 JSON-RPC 端点（A2A 的 REST 绑定：`POST /v1/message:send`、
  `GET /v1/tasks/{id}`、`POST /v1/tasks/{id}:cancel`）。
- 出站与入站共用同一份契约 schema（对称性）。

**验收（可执行）**
1. 起本地 server，`POST /v1/message:send` 返回含 `taskId` 的 `Task`，`status.state` 为 `submitted`。
2. `GET /v1/tasks/{id}` 对已存在 id 回 `200` + 合法 `TaskStatus`；对不存在 id 回
   `-32001 TASK_NOT_FOUND`。
3. `POST /v1/tasks/{id}:cancel` 使状态转 `canceled`；对终态任务回 `-32002 TASK_NOT_CANCELABLE`。
4. 守卫新增断言：`tasks/get` 返回值通过 `task.schema.json`。

### S4 —— 协议版本推进

**S4.1 MCP：支持 `2025-03-26`（P1）**
1. 实现 `POST /mcp` 的 `Accept: text/event-stream` 分支：回 `text/event-stream`，
   事件体为 JSON-RPC 响应。
2. 实现 `GET /mcp` 的 SSE 流与 `Last-Event-ID` 断线续传（事件 id 需编码流身份）。
3. 把 `PROTOCOL_CONFORMANCE` 中 `transport-streamable-http-sse-response` 与
   `transport-streamable-http-last-event-id` 改为 `implemented: true`。
4. 把 `2025-03-26` 加入 `SUPPORTED_PROTOCOL_VERSIONS`。
5. 在守卫里补两条探针。

**验收**：`SUPPORTED_PROTOCOL_VERSIONS` 含 `2025-03-26` 且守卫 exit 0；
用官方 `inspector` 以 Streamable HTTP 模式连接成功。

**S4.2 拆分互斥传输（M9，P2）**
- 传统 SSE 移到独立路径（如 `/sse` 仅传统、`/mcp` 仅 Streamable），
  属破坏性变更 → 需版本化公告 + 保留一个过渡期的兼容开关。

**S4.3 A2A：SSE 流式（P1）**
1. 实现 `message/stream`，推送 `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`。
2. 把 `agentCardSpec.IMPLEMENTED_CAPABILITIES.streaming` 改为 `true`
   （守卫 `capability-honesty:streaming` 会自动校验代码里确有实现）。
3. 把 `taskStateSpec.buildTaskStatus` 接入事件构造。

**验收**：`curl -N` 能看到事件流；守卫全绿。

### S5 —— 外部验证（把「自证」升级为「他证」）

1. **MCP**：接入 `modelcontextprotocol/inspector`（10.6k⭐）做交互式验证；
   评估 `modelcontextprotocol/conformance` 套件纳入 CI 的可行性。
2. **A2A**：接入 `a2aproject/a2a-tck` 与 `a2a-inspector`。
3. 把 TCK 报告作为发布门的一部分（`gate:release`）。
4. **生态位复审**：补一份 ADR 记录「自建协议层 vs 复用 `@modelcontextprotocol/sdk`
   / `a2a-js`」的判据与**复审触发条件**（建议：实现 S4.3 流式前复审一次）。

**验收**：CI 里能产出 TCK 报告；ADR 落档。

---

## 5. S0~S1 已完成内容（本次落地）

### 5.1 代码改动清单

| # | 文件 | 类型 | 说明 |
|---|------|------|------|
| 1 | `services/backend/src/services/domain/messaging/mcp/mcpServerProtocol.js` | 改 | 新增 `PROTOCOL_CONFORMANCE` 一致性矩阵（32 行）、`declaredRevisions()`、`isRevisionFullyImplemented()`；`parseMessage` 加 `jsonrpc` 校验（带错码分级）；`toolDefToMcp` 透传 `title`/`annotations`/`outputSchema`；`toolResultToMcp` 回 `structuredContent` 并禁用 `String()` 折叠 |
| 2 | `services/backend/src/services/domain/messaging/mcp/mcpServer.js` | 改 | 解析失败按 `parsed.errorCode` 回 `-32700` 或 `-32600` |
| 3 | `services/backend/src/contracts/a2a/agent-card.schema.json` | **新** | A2A v0.3.0 AgentCard 契约（draft-07） |
| 4 | `services/backend/src/contracts/a2a/message.schema.json` | **新** | `Message` + `Part`（text/file/data 判别联合） |
| 5 | `services/backend/src/contracts/a2a/task.schema.json` | **新** | `Task` / `TaskStatus` / `TaskState`（9 值封闭枚举）/ `Artifact` |
| 6 | `services/backend/src/contracts/a2a/README.md` | **新** | 契约目录说明 + 4 条历史踩坑约束 |
| 7 | `services/backend/src/services/a2a/agentCardSpec.js` | **新** | 纯叶子：符合规范的 Agent Card 构造 + `IMPLEMENTED_CAPABILITIES` 诚实常量 + `validateCardShape` + 发布门控 |
| 8 | `services/backend/src/services/a2a/taskStateSpec.js` | **新** | 纯叶子：三套内部状态机 → 规范 `TaskState` 映射表 + 迁移合法性 + 严格模式 |
| 9 | `services/backend/src/services/a2a/builtinAgentManifest.js` | **新** | 纯叶子：内置 agent 清单单一真源（原先内联在 facade 私有方法里） |
| 10 | `services/backend/src/routes/wellKnown.js` | **新** | `GET /.well-known/agent-card.json` 发布端点；公开、不进信封、零硬编码 |
| 11 | `services/backend/server.js` | 改 | 挂载 `/.well-known` |
| 12 | `services/backend/src/services/a2a/index.js` | 改 | `Part` 补 `kind`；`createTask` 委托 `sendMessage`；新增 `cancelTask`；`getTask` URL 编码；`createLocalAgentCard` 改为规范卡片 |
| 13 | `services/backend/src/services/a2aFacade.js` | 改 | 内置 agent 清单改为 require 单一真源 |
| 14 | `services/backend/src/tools/A2ATool/index.js` | 改 | 新增 `cancel_task` 操作；更新操作描述 |
| 15 | `scripts/ci/check-protocol-conformance.js` | **新** | 协议一致性守卫：**75 项**断言（MCP 27 + A2A 48），三类探针（behavior / source / file） |
| 16 | `package.json` | 改 | 新增 `check:protocol-conformance`；接入 `check:structure` 与 `check:all-standards` |
| 17 | `services/backend/tests/services/a2a/agentCardSpec.test.js` | **新** | 33 项单测 |
| 18 | `services/backend/tests/services/a2a/taskStateSpec.test.js` | **新** | 14 项单测 |
| 19 | `services/backend/tests/services/a2aSendHeaders.test.js` | 改 | `createTask` 断言从非标准的 `/v1/tasks` 改为规范的 `/v1/message:send`；新增 `Part.kind`、`cancelTask`、URL 编码 3 项 |
| 20 | `docs/_规范/[DESIGN-MCP-001] MCP 协议实现规范.md` | **新** | MCP 协议实现规范（首份） |
| 21 | `docs/_规范/[DESIGN-A2A-002] A2A 标准协议适配规范.md` | **新** | A2A 标准适配规范（首份） |
| 22 | `docs/_规范/[DESIGN-A2A-001] A2A 协议规范.md` | 改 | 加定位更正横幅（私有方言 vs 标准协议对照表 + 命名纪律） |
| 23 | `docs/_规范/[DESIGN-NAM-002] A2A 与 ACP 命名及术语规范.md` | **新** | A2A（标准协议）vs ACP（私有方言）的命名与术语单一真源；方法集对照、env 前缀纪律、改名决策 |
| 24 | `scripts/ci/protocol-naming.json` | **新** | 命名守卫配置：私有 ACP 方法名禁用清单、`KHY_A2A_*` env 白名单（13 个 legacy-env） |
| 25 | `scripts/ci/check-protocol-naming.js` | **新** | 协议命名守卫（A2A vs ACP）：扫描 7876 文件，R1 禁止私有方法名、R2 env 前缀纪律、豁免需写理由；实测 0 违规 |
| 26 | `docs/_规范/[DESIGN-QUAL-001] 门禁基线与债务台账规范.md` | **新** | 基线必须是实测值（QUAL-1）、基线只降不升（QUAL-2）、每类指标必有台账条目（QUAL-3） |
| 27 | `scripts/ci/debt-ledger.json` | **新** | 门禁债务台账（12 条）：layout 4 类 + standards 5 类 + 已归零 3 类；每条带 owner/dueBy/target/plan |
| 28 | `scripts/ci/check-debt-ledger.js` | **新** | 债务台账守卫：覆盖完整性（从守卫源码解析）、只降不升棘轮、逾期留痕、台账化石检测；实测 0 error |
| 29 | `scripts/ci/code-standards.baseline.json` | 改 | 基线重置为实测值（functionLines 10800→2144、nestingDepth 10800→8703、fileLines 512→352、consoleLog 4592→4584），冻结存量 |
| 30 | `docs/_规范/[DESIGN-QUAL-002] 官方一致性套件接入规范.md` | **新** | 官方套件（MCP conformance / inspector、A2A a2a-tck / a2a-inspector）的接入方式、所需产出物、版本钉扎与 CI 接线 |
| 31 | `scripts/ci/conformance-runner.mjs` | **新** | 官方套件编排器：仅工具已安装时执行（不触发下载），缺失降级 SKIPPED，`--required` 在 CI 强制；产出 `conformance-report.json` |
| 32 | `package.json` | 改 | 新增 `check:protocol-naming` / `check:debt-ledger`（接入 `check:structure` 与 `check:all-standards`）、`conform:mcp` / `conform:a2a` / `conform:all` |
| 33 | `docs/03_DESIGN_设计/[DESIGN-ARCH-073] 规范快速参考卡.md` | 改 | 删除被当成真 API 的「A2A 速查」（私有方法名 + WebSocket 传输），改为指向 [DESIGN-A2A-002] / [DESIGN-NAM-002] |
| 34 | `docs/00_INDEX_文档索引.md` | 改 | 补登记 [DESIGN-ARCH-098/099/100/101]（消除 `docs-index-complete` 存量 2） |

### 5.2 关键设计决策（为什么这么做）

| 决策 | 理由 |
|------|------|
| **把「声明」做成机器可读数据** | 三类历史故障的共同点是「声明没有校验点」。矩阵让声明可被 `implemented + 探针` 双向验证 |
| **`required` 语义 = 「声明该修订则必须实现」** | 让「不声明 `2025-03-26`」成为**合法且有理由**的结果，而不是含糊的 TODO。守卫输出会写明「未实现 → 该修订因此不被声明（诚实降级）」 |
| **保留 `SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05']`** | 规范要求客户端拿到不认识的版本后自行断开。khy 没有 SSE 流式实现，声明 `2025-03-26` 就是「假兼容」 |
| **A2A `capabilities` 三项全 `false`** | `streaming` / `pushNotifications` / `stateTransitionHistory` 确实零实现。守卫 `capability-honesty:*` 会实测，防止有人先改卡片 |
| **A2A 契约放在 `src/contracts/a2a/`** | 与既有 `contracts/acp/`、`contracts/mobile/` 同约定，避免污染 `scripts/ci/json-schemas/`（那是给 `.khy/` 数据文件用的） |
| **私有 ACP 方言保留原名、暂缓改名** | 改名牵动 14 处内置 agent 注册、router、facade、测试，属独立破坏性批次。先用文档 + 规范条款划清边界（S1 目标），改名列入 S2 决策项 |
| **守卫探针分三类（behavior / source / file）** | 纯函数可驱动的用 `behavior`（最强）；传输层这类无法纯函数化的用 `source`；存在性用 `file`。**没有探针的 `implemented: true` 直接判红灯** —— 不可验证的声明等于空声明 |
| **反面断言** | `agent-card-schema-rejects-missing-protocolVersion`、`message-schema:rejects-part-without-kind`、`task-schema:rejects-private-state:spawning` —— 不只验证「对的能过」，还验证「错的会被拒」，防止 schema 被逐步放宽成空壳 |
| **测试发现 3 个真实缺陷并已修** | `normalizeBaseUrl('ftp://a.example')` 曾静默产出 `http://ftp//a.example`（不返回 null）；另两处为测试期望本身不严谨 |

### 5.3 验证证据（全部实测）

| 验证项 | 命令 | 结果 |
|--------|------|------|
| **协议一致性守卫** | `node scripts/ci/check-protocol-conformance.js --json` | **75 / 75 pass，exit 0** |
| **合并回归（最终一次）** | `jest tests/services/a2a tests/services/mcp tests/mcp --runInBand` | **11 suites / 115 tests 全绿，exit 0** |
| 新增 A2A 单测 | `jest tests/services/a2a --runInBand` | **2 suites / 47 tests 全绿** |
| MCP 既有 jest 套件 | `jest tests/services/mcp tests/mcp` | **9 suites / 68 tests 全绿** |
| 其它相关 jest 套件 | `jest tests/a2a.test.js tests/mcp*.test.js tests/toolCalling.mcpResultShape.test.js` | **8 suites / 80 tests 全绿** |
| A2A header 行为测试 | `node --test tests/services/a2aSendHeaders.test.js` | **8 / 8 pass** |
| 文档站校验 | `node scripts/docs/verify_docs_site.js` | **exit 0**（881 md → 882 html，10563 本地链接全可达） |
| 纯叶子契约 | `check-leaf-contract.js <5 个新文件>` | **通过，0 违规** |
| 节点语法 | `check-node-syntax.js <11 个改动文件>` | **11 文件通过** |
| 治理规则 | `check-gov-rules.js` | 新文件未引入新违规 |
| 仓库层级 | `check-repo-layout.js` | **未引入新违规**；存量 `dangling-task 88 / cross-layer-require 37 / unresolved-require 22 / extension-id-hardcode 1 / docs-index-complete 2` 均为既有欠债（见 S2.1） |
| **协议命名守卫** | `node scripts/ci/check-protocol-naming.js` | **0 违规，exit 0**（扫描 7876 文件；5 豁免 + 13 legacy-env 已登记） |
| **债务台账守卫** | `node scripts/ci/check-debt-ledger.js` | **12 条全覆盖、0 error、0 warning，exit 0**；`nestingDepth` 因计量口径问题声明 `targetPending` |
| **代码标准门禁（基线重置后）** | `node scripts/ci/check-code-standards.js` | **exit 0**；基线已对齐实测（functionLines 2144 / nestingDepth 8703 / fileLines 352 / consoleLog 4584 / namingViolations 4） |
| **官方套件编排器（降级）** | `node scripts/ci/conformance-runner.mjs` | **exit 0**；MCP/A2A 工具未安装 → 均 `available:false`，门禁 `pass:true`，产出 `conformance-report.json` |
| **结构总门禁（含新守卫）** | `npm run check:structure` | 已接入 `check:protocol-naming` 与 `check:debt-ledger`（与既有 `check:protocol-conformance` 并列） |

> **关于 `check-repo-layout` 恒红**：这些计数在本轮改动**之前**就已存在（baseline 全 0，
> 即门长期为红）。本次新增文件按既有约定放置（`docs/_规范/` 不参与阶段索引检查），
> 未使任何计数上升。清偿计划见 §4 S2.1。

### 5.4 已知未解决的问题（诚实登记）

> 下列 1/2/7 为**能力缺口**（需写代码），仍未解决；3/4/5/6 为**机制缺口**，
> 本次已建立规范化整改机制（见 §5.5），但存量清偿仍待排期。

1. **A2A 服务端任务处理面仍未实现** —— 只做「能被发现」，未做「能被调用」。见 S3。
2. **MCP 协议版本仍停在 `2024-11-05`** —— 只让「诚实拒绝」成立，未支持新版本。见 S4.1。
3. **守卫是自建的，不是官方 TCK** —— `check-protocol-conformance.js` 覆盖纯函数/源码级，
   不含跨实现互操作与传输层端到端。**本次已补 `[DESIGN-QUAL-002]` + `conformance-runner.mjs`**：
   规范了如何接入官方 `@modelcontextprotocol/conformance` 与 `a2a-tck`、所需产出物与 CI 接线；
   编排器已就位（工具未安装时降级为 SKIPPED）。工具安装与 release 门禁待排期。
4. **`check-repo-layout` 仍恒红** —— 存量债（unresolved-require 21 / cross-layer-require 37 /
   dangling-task 88 / extension-id-hardcode 1）已**全部登记进 `debt-ledger.json`**，
   每条带 owner/dueBy/plan，`check:debt-ledger` 已接入 `check:structure`。清偿动作待排期（S2.1）。
5. **`code-standards` 基线已重置为实测值** —— `code-standards.baseline.json` 的
   `functionLines 10800→2144`、`nestingDepth 10800→8703` 等已改为实测，门不再「只拦翻倍级恶化」；
   5 类指标的下降目标已写入 `debt-ledger.json`（仅 `nestingDepth` 因计量口径问题声明 `targetPending`）。
   存量下降待排期（S2.2）。
6. **私有 ACP 方言未改名** —— 边界已划清：新增 `check-protocol-naming.js` 守卫强制
   A2A/ACP 命名纪律（私有的 `a2a.*` 方法名已确认在代码里零存在、仅为历史草案遗留），
   改名仍待决策（S2/§2.1）。
7. **`console.log` 存量 ~4584 处** —— 已登记为 `standards.consoleLog` 债务项（目标 3000），属 S2.2 第 4 步。

### 5.5 三大核心问题的规范化整改（本次新增 · §5.4 之 3/4/5/6 的机制层）

针对用户明确提出的三类问题，本次除 S0/S1 外额外落地了「机制层」整改：

| # | 问题 | 规范（真源） | 守卫 / 脚本 | 实测结果 |
|---|------|--------------|-------------|----------|
| **P1** | 两个「A2A」混淆、文档把私有方言写成 A2A 规范、传输层错写成 WebSocket | `[DESIGN-NAM-002] A2A 与 ACP 命名及术语规范`、[DESIGN-A2A-001] 定位更正横幅、[DESIGN-A2A-002] | `scripts/ci/check-protocol-naming.js` + `scripts/ci/protocol-naming.json` | **0 违规，exit 0** |
| **P2** | 基线失效（允许 12000 超长函数 / 5000 console）、守卫整片红 | `[DESIGN-QUAL-001] 门禁基线与债务台账规范` | `scripts/ci/debt-ledger.json` + `scripts/ci/check-debt-ledger.js`；`code-standards.baseline.json` 重置为实测值 | 台账 12 条全覆盖、门禁 `0 error`；基线已与实测对齐 |
| **P3** | 未接入任何官方一致性套件，合规结论均为自审 | `[DESIGN-QUAL-002] 官方一致性套件接入规范` | `scripts/ci/conformance-runner.mjs`（`conform:mcp` / `conform:a2a` / `conform:all`） | 编排器就位；套件未安装时降级 SKIPPED，门禁判 pass |

**P1 关键动作**：
- 确认仓库内「标准 A2A 出站客户端」（127 行）与「私有 ACP 方言」（`a2aRegistry`/`acpTransport` 等）方法集**无一重合**；
- 守卫扫描全仓，确认 `[DESIGN-A2A-001]` 里写的 `a2a.discovery.register` / `a2a.task.create` 等私有方法名**在代码里零存在**，仅为历史草案遗留 → 已从代码注释与契约 README 中去除这些错误命名；
- `[DESIGN-A2A-001]` 加定位更正横幅（私有方言 vs 标准协议对照表），`docs/03_DESIGN_设计/[DESIGN-ARCH-073] 规范快速参考卡.md` 中那份被当成真 API 的「A2A 速查」已改为指向正确规范；
- 13 个仍用 `KHY_A2A_*` 前缀的私有 ACP 环境变量被登记为 `legacy-env`，待 P2 批次改名为 `KHY_ACP_*`。

**P2 关键动作**：
- `code-standards.baseline.json` 四个数字（functionLines/nestingDepth 同值 10800/12000、fileLines 512、consoleLog 4592）改为实测（2144 / 8703 / 352 / 4584）—— 容忍度从实际的 5.6 倍收紧到 1 倍（冻结存量）；
- `debt-ledger.json` 12 条：layout 4 类（unresolved-require 21 / cross-layer-require 37 / dangling-task 88 / extension-id-hardcode 1）+ standards 5 类 + 已归零 3 类；`check-debt-ledger.js` 从守卫源码**解析覆盖完整性**，强制每类门禁指标都有责任人/期限/目标（QUAL-3）；
- 两守卫均接入 `check:structure`（PR 快门）与 `check:all-standards`。

**P3 关键动作**：
- 锁定权威工具：`@modelcontextprotocol/conformance`（`server --url <端点> --spec-version 2025-11-25`）、`@modelcontextprotocol/inspector`（CLI 冒烟）、`a2a-tck`（`./run_tck.py --sut-host <url> --level must`）、`a2a-inspector`；
- 明确**所需产出**：MCP `results/server-*/checks.json`（含 `wire-schema-valid`）、A2A `reports/compatibility.json|html|junit`，全部作为 CI artifact 留存 ≥14 天；
- `conformance-runner.mjs` 只在工具**已安装**时执行（不触发自动下载），缺失时降级 SKIPPED，`--required` 在 CI 强制产出真实报告；
- khy 现状登记：MCP 仅 `2024-11-05`、A2A 仅 Agent Card 无任务面 → 首轮 conformance/TCK 必现已知失败，须登记进 expected-failures 且只缩不扩。

---

## 6. 验收标准总表

| 阶段 | 验收标准 | 状态 |
|------|----------|------|
| S0 | `check:protocol-conformance` 全绿并接入 `check:structure`；MCP 与 A2A 契约 schema 存在且有反面断言 | ✅ |
| S1 | `/.well-known/agent-card.json` 可访问且通过 schema；TaskState 映射完备；`tasks/cancel` 可用；两份规范文档落档 | ✅ |
| S2 | `check:layout` exit 0 且 baseline 全 0；`code-standards` 基线季度下调；静默降级扫描器接入 `check:changed` | 🟡 债务台账 + 基线重置 + `check:debt-ledger` 已建并接入 `check:structure`；存量清偿待排期 |
| S3 | 端到端：`message/send` → `tasks/get` → `tasks/cancel` 三方法互通且通过契约 schema | ⬜ |
| S4 | `SUPPORTED_PROTOCOL_VERSIONS` 含 `2025-03-26` 且官方 inspector 可连；A2A 流式事件可被 `curl -N` 观测 | ⬜ |
| S5 | CI 产出 MCP / A2A 官方 TCK 报告；自建 vs 复用 SDK 的 ADR 落档 | 🟡 `[DESIGN-QUAL-002]` + `conformance-runner.mjs` 已建；工具安装与 release 门禁待排期 |

---

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| S2.1 清偿 `unresolved-require` 22 处时改动面外溢 | 逐条独立提交，每条跑一次相关测试；先修「指向不存在路径」这类确定性问题 |
| S2.2 基线下调过猛导致新代码无处可写 | 按模块分批 + 每季 -10%；新代码一律直接满足目标标准，不进基线豁免 |
| S3 服务端任务面引入新的失控面 | 复用既有 `KHY_A2A_ENABLED` 总闸；任务存储设 TTL 与上限；`tasks/cancel` 复用既有生命周期 `kill()` 而非新造通道 |
| S4.1 实现 SSE 后打开 `2025-03-26` 但流式语义不完整 | 只有「SSE 响应体 + `Last-Event-ID`」两条 `required` 探针都绿才加入声明集合（守卫强制） |
| S4.2 拆分互斥传输破坏现有客户端 | 保留过渡期兼容开关 + 在 `CHANGELOG` 明确标注破坏性变更 |
| 私有方言改名牵动面过大 | 用 `grep` 先产出全量引用清单与影响面评估，再决定是否做；不做也可以，规范条款已覆盖命名纪律 |

---

## 8. 附：本次新增可复用命令

```bash
# 协议一致性（MCP + A2A）
npm run check:protocol-conformance
node scripts/ci/check-protocol-conformance.js --mcp --json
node scripts/ci/check-protocol-conformance.js --a2a

# 新增单测
npm test --workspace services/backend -- tests/services/a2a
node --test services/backend/tests/services/a2aSendHeaders.test.js

# 端到端互操作（需真实起 server，不在 CI 内）
npx @modelcontextprotocol/inspector node services/backend/src/services/domain/messaging/mcp/mcpStdioServer.js

# 三大核心问题整改（本次新增）
npm run check:protocol-naming        # A2A vs ACP 命名纪律（P1）
npm run check:debt-ledger            # 门禁债务台账（P2）
node scripts/ci/check-debt-ledger.js --json
npm run conform:all                 # 官方套件编排（工具未装→SKIPPED；CI 用 --required 强制）
node scripts/ci/conformance-runner.mjs --required --spec-version 2024-11-05 --mcp-url http://127.0.0.1:3000/mcp
```

> **降级说明**：`conform:all` 在套件未安装时不会失败（写 `conformance-report.json` 标注
> `available:false`）。真正接入时先按 `[DESIGN-QUAL-002]` §4 安装 `@modelcontextprotocol/conformance`
> 与 `a2a-tck`，再于 release 流水线以 `--required` 运行。

---

*本计划与调研报告配套；S0/S1 的代码改动已落地并通过实测验证，S2~S5 待排期。*
