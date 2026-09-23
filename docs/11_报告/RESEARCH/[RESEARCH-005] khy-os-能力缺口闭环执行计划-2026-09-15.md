# khy-os 能力缺口闭环执行计划（2026-09-15）

<!-- naming-guard: exempt 执行计划 §5.1 引用守卫命中的历史错误命名作为待清理项证据 -->

> 针对四项尚未闭环的能力缺口与待办事项，给出完整解决方案与执行安排。每项均明确 **范围 / 交付标准 / 依赖关系**。
> 编制日期：2026-09-15。门禁基线：conformance **79/79** ✓、debt-ledger **0 error/0 warning** ✓、S3+S4 冒烟 **12/12** ✓。

---

## 0. 总览

| 缺口 | 状态 | 范围 | 交付标准（可验证） | 关键依赖 |
|---|---|---|---|---|
| **S3** A2A 服务端任务面 | ✅ 已实现并验证 | 标准 A2A REST 绑定：`message/send`、`tasks/get`、`tasks/cancel` | `check-protocol-conformance` 新增 3 项 S3 探针全绿；冒烟覆盖 store/methods/routes | 既有 `a2a/index.js` 客户端、`wellKnown` 发现端点；`taskStateSpec` 状态机 |
| **S4** MCP 升级至 2025-03-26 | ✅ 已实现并验证 | 两个 required 特性：SSE 流响应、`Last-Event-ID` 断线续传 | `SUPPORTED_PROTOCOL_VERSIONS` 含 `2025-03-26` 且 required 全绿；纯函数单测通过 | `mcpServerProtocol.js` 声明机制；`mcpHttpServer.js` 传输层 |
| **债务台账清偿** | 🟡 排期已定，待执行 | 9 条 open 债务的逐条清偿（按阶段 A→D） | 每条 `measured → target` 且 `target<measured`；逾期必须 `slipped` 留痕 | `check-debt-ledger.js` 棘轮守卫；各门禁脚本源码（覆盖完整性） |
| **官方套件 release 接入** | 🟡 编排器+脚本已存在，本次补 workflow | `@modelcontextprotocol/conformance` + `a2a-tck` 在发版流水线中**实际安装**并以 `--required` 强制 | 发版即产出 `.khy/conformance-report.json` 并上传产物；缺失即门禁红 | `conformance-runner.mjs`（已存在）+ `conform:*` npm 脚本（已存在）+ 本计划新增 `conformance.yml` |

---

## 1. S3 — A2A 服务端任务面（能力补齐）

### 1.1 范围（已交付）
补齐 khy 原先缺失的 **A2A 服务端** 一侧：原先只有出站客户端（`a2a/index.js`）+ 发现端点（`routes/wellKnown.js`），无任何任务面。本次落地标准 A2A REST 绑定：

- `POST /v1/message:send`（别名 `POST /v1/message/send`）→ 创建/继续任务，dispatch 到 executor，落终态。
- `GET /v1/tasks/:id` → 取任务；缺失抛 `A2aNotFoundError`。
- `POST /v1/tasks/:id:cancel`（别名 `.../cancel`）→ 取消；终态任务取消保持原状（不可从 completed 撤回）。
- 可选 `KHY_A2A_API_KEY` Bearer 鉴权；是否启用由 `agentCardSpec.isPublishEnabled` 决定。
- 响应直接返回原始 JSON（`{success,data}` 信封不乱套），契合 A2A 规范。

### 1.2 交付标准
| 维度 | 标准 |
|---|---|
| 存储内核 | `TaskStore`：内存 `Map`；`createTask→submitted`；`appendStatus` 经 `taskStateSpec.canTransition` 校验，非法迁移返回 `null`；终态不变式成立 |
| 语义层 | `serverMethods`：`messageSend` 等待注入的 `executor`；抛错落 `failed`，否则落执行结果态；`tasksCancel` 对终态任务返回原任务 |
| 探针 | `check-protocol-conformance.js` 第 5.5 节新增 `a2a-server-methods-exist` / `a2a-server-routes-exist` / `a2a-server-mounted` 三项，**全绿** |
| 冒烟 | `test-a2a-mcp-server-smoke.js` 覆盖 TaskStore 生命周期、终态不变式、`serverMethods` 三方法、**12/12 通过** |

### 1.3 依赖关系
- 入：既有 `a2a/index.js`（客户端）、`routes/wellKnown.js`（Agent Card 发现）、`taskStateSpec`（`toA2aState` / `canTransition`）。
- 出：`server.js` 在 `/v1` 挂载 `routes/a2a`；与 `wellKnown` 并列，无冲突。
- **显式未做（诚实留白）**：`executor` 当前为 `defaultExecutor`（如实回声 message，不做假 LLM）。将 14 个 builtin agent 运行时接入 `serverMethods` 的 `executor` 是一独立大任务，**超出 S3 范围**，作为后续项单列（见 §5.2）。

### 1.4 落地文件
- `services/backend/src/services/a2a/taskStore.js`（新）
- `services/backend/src/services/a2a/serverMethods.js`（新）
- `services/backend/src/routes/a2a.js`（新）
- `services/backend/server.js`（改：新增 `app.use('/v1', require('./src/routes/a2a'))`）
- `scripts/ci/check-protocol-conformance.js`（改：3 个 S3 探针）
- `scripts/ci/test-a2a-mcp-server-smoke.js`（新）

---

## 2. S4 — MCP 升级至 2025-03-26

### 2.1 范围（已交付）
声明支持 `2025-03-26` 并落地其两个 **required** 特性（此前 `implemented:false`）：

1. `transport-streamable-http-sse-response`：按 `Accept` 协商 SSE（`text/event-stream`）或 `application/json` 回包。
2. `transport-streamable-http-last-event-id`：客户端断线后以 `GET /mcp` + `Last-Event-ID` 重订阅，服务端重放断点之后事件（断线续传）。

### 2.2 交付标准
| 维度 | 标准 |
|---|---|
| 声明一致 | `SUPPORTED_PROTOCOL_VERSIONS` = 所有「required 全绿」的修订集合；现含 `2024-11-05` 与 `2025-03-26` |
| 纯函数 | `resolveStreamableContentType(accept)` 协商响应类型；`replayEventIdsAfter(lastEventId, ids)` 切片续传（空/`undefined`/非法 ID 返回 `[]`，不误触重放） |
| 传输层 | `mcpHttpServer.js`：会话对象增 `eventSeq`/`events`；POST 协商为 SSE 时递增序号、写 `id: N\nevent: message\ndata: ...`；GET `/mcp` 读 `Last-Event-ID` 重放后 `res.end()` |
| 合规门 | 翻转两个 required 标志为 `implemented:true` 且各带匹配探针（QUAL 要求每个 `implemented:true` 必须有探针，否则门红）；现为 **79/79** |

### 2.3 依赖关系
- 入：`mcpServerProtocol.js` 的修订/特性声明机制（含 `isRevisionFullyImplemented`）。
- 出：`mcpHttpServer.js` 的 Streamable HTTP 传输；`conformance-runner.mjs` 后续以 `--spec-version 2025-03-26` 对接官方套件（见 §4）。
- 关键约束：合规门是**行为/源码/文件**三重探针，单纯翻 flag 不补探针会立刻变红——本次两处均先写纯函数与探针再翻 flag。

### 2.4 落地文件
- `services/backend/src/services/domain/messaging/mcp/mcpServerProtocol.js`（改：版本声明 + 两个纯函数 + 两个 required 标志）
- `services/backend/src/services/domain/messaging/mcp/mcpHttpServer.js`（改：SSE 流 + `Last-Event-ID` 重放）
- `scripts/ci/check-protocol-conformance.js`（改：S4 两个探针）
- `scripts/ci/test-a2a-mcp-server-smoke.js`（新：S4 纯函数单测）

---

## 3. 债务台账清偿排期

台账真源：`scripts/ci/debt-ledger.json`；守卫：`scripts/ci/check-debt-ledger.js`（`npm run check:debt-ledger`）。
当前 **9 条 open / 3 条 closed**，`plan` 字段已标注阶段标签（阶段A–D）。棘轮铁律：**target 必须严格小于 measured**，逾期必须 `slipped` 留痕（禁止静默滑动）。

### 3.1 分阶段排期

| 阶段 | 截止 | 条目 | 风险 | 清偿策略要点 |
|---|---|---|---|---|
| **A** | 2026-09-30（~2 周） | `layout.unresolved-require`(P1,21)、`layout.extension-id-hardcode`(P2,1)、`standards.namingViolations`(P3,4) | P1 优先 | G2→G1→G3→G4→G5 分组修路径；1 处 id 改用 manifest 定位；4 处改 PascalCase/非 class |
| **B** | 2026-10-31 | `layout.cross-layer-require`(P2,37)、`layout.dangling-task`(P2,88) | P2 | workspace 包名引用按 ai-backend→khyquant→其余；三分脚本做模糊匹配/删引用/人工裁决 |
| **C** | 2026-11-30 | `standards.nestingDepth`(P2,8703) | P2 | **先修计量**（真实块嵌套，4 空格缩进误报）→ 重测 → 重设 target（当前 `targetPending`） |
| **D** | 2026-12-31 | `standards.functionLines`(2144→1600)、`standards.fileLines`(352→300)、`standards.consoleLog`(4584→3000) | P2 | 基线先改实测值（收紧 5.6× 而非放宽）；存量冻结 + 增量零容忍（照搬 pr-gate 新增文件零容忍模式） |

### 3.2 逐条范围 / 交付 / 依赖

- **layout.unresolved-require**（P1）：范围=21 处深层相对 require 指向不存在路径（潜伏崩溃）。交付=全部改为正确相对/包名路径，`measured 21→0`。依赖=各调用点目录结构确认。
- **layout.extension-id-hardcode**（P2）：范围=`markdownWorkbench.js:41` 硬编码 `"khy-markdown"`。交付=改用 `manifest.provides` + `extensionRoots.findProvider`，`1→0`。依赖=`[DESIGN-TOOL-002] §1.3` 契约。
- **standards.namingViolations**（P3）：范围=4 处 NAM-001（多为把解构/字面量误判为 class）。交付=逐处修正或修正检测，`4→0`。
- **layout.cross-layer-require**（P2）：范围=37 处跨 workspace 深层 require，违反 `[DESIGN-LAY-005]` 禁止边。交付=改为 `@khy/shared` 等包名引用，`37→0`。依赖=workspace 包发布就绪。
- **layout.dangling-task**（P2）：范围=88 个文档引用的 `npm run` 目标无定义（文档漂移）。交付=三分脚本对齐/删引用/人工裁决，`88→0`。依赖=文档与脚本名一致性纪律。
- **standards.nestingDepth**（P2）：范围=当前用行缩进估算嵌套（**计量不可信**）。交付=先改真实块嵌套计量，再定 target（当前持 `targetPending`，`by=2026-11-30`）。依赖=计量口径修复优先于清偿。
- **standards.functionLines / fileLines / consoleLog**（P2）：范围=函数行数、文件行数、console.* 三类存量。交付=基线先对齐实测（functionLines 由虚估 10800 改为实测 2145，是**收紧**），存量冻结 + 增量零容忍，`measured→target`。依赖=pr-gate 的「新增文件零容忍」模式可直接复用。

> 注：仅 3 条（docs-index-complete / extension-contract / extension-path-drift）已归零 `closed`，保持零容忍，不进入排期。

---

## 4. 官方套件在 release 流水线中的接入

### 4.1 现状盘点（重要：避免重复造轮子）
经核，编排器与 npm 脚本**早已就位**（工作树内，待提交），本次**只需补 workflow 文件**：

- `scripts/ci/conformance-runner.mjs`：官方套件编排器。仅在校验「套件确实已安装」后执行，绝不自动 npx/uv 下载；缺失降级 `SKIPPED`（本地不阻塞）；`--required` 时缺失即门禁失败；产出 `.khy/conformance-report.json`。
- `package.json` 根脚本：`conform:mcp` / `conform:a2a` / `conform:all` 均已指向该 runner。
- 本次**新增** `.github/workflows/conformance.yml`（见下）。

### 4.2 范围
在 **release 发布 / 打 `v*` tag / 手动 dispatch** 时：
1. **实际安装**官方套件——MCP 侧 `pnpm add -w --save-false @modelcontextprotocol/conformance`；A2A 侧克隆 `a2a-tck` 并 `uv sync`（建 `.venv`）。`--save-false` 不污染 `package.json`，开发机因此仍可被 SKIPPED 保护。
2. 启动后端（后台，轮询 `/health` 就绪）。
3. **接入 `--required`**：以 `conform:all -- --required` 执行，缺失/失败即门禁红。
4. 上传 `.khy/conformance-report.json` + `results/**` + `.ci/a2a-tck/reports/**` 为产物，无论成败均留证。

### 4.3 交付标准
| 维度 | 标准 |
|---|---|
| 安装真实发生 | 工作流内显式安装两步套件，非依赖本地残留 |
| `--required` 接入 | 调用带 `--required`；经实测：套件缺失时 `gate.pass=false` 且 exit 1（ blockers 列出） |
| 可审计产物 | 每次运行产出 `conformance-report.json` 并 upload-artifact |
| 规范对齐 | `KHY_MCP_SPEC_VERSION` 默认 `2025-03-26`，与 S4 声明一致 |

### 4.4 验证证据（本地可复现）
- 干跑（套件未装，无 `--required`）：`gate.pass=true`、`available:false`、exit 0（SKIPPED）。
- `--required`（套件未装）：`gate.pass=false`、`blockers=["mcp: 套件未安装且 --required 已设","a2a: ..."]`、exit 1。
→ 证明「安装 + --required」二者到位后，门禁才会真正评判官方套件结果。

### 4.5 依赖关系
- 入：`conformance-runner.mjs`、`conform:*` 脚本（已存在）。
- 出：release 门禁真产出官方一致性报告；与 S4 的 `2025-03-26` 声明形成闭环。
- **已知前置（风险）**：后端须在 CI 可启动并监听 3000（`BACKEND_PORT`）。若需数据库等前置，工作流「启动后端」步会以清晰日志失败——属上游依赖，需在 CI 环境预置（详见 §5.3）。

---

## 5. 风险与未闭环项

### 5.1 `check-protocol-naming` 当前 2 处错误（预先存在，非本次引入）
`R1-forbidden-method` 命中 `a2a.discovery.register`，出现在 `docs/10_规范/registry/RULES-REGISTRY.json:1686` 与 `scripts/ruleguard/register-external-rules.js:53`——均为文档/登记引用，非代码实现，且**非 S3/S4 改动引入**。建议另立清理项：或在 registry 中改用真实方法集 `acpTransport.ACP_METHODS` 的命名，或登记豁免。本计划四项缺口不依赖其修复。

### 5.2 S3 executor 接入（后续独立项，超出本次范围）
`serverMethods` 的 `executor` 现为 `defaultExecutor`（如实回声）。将 14 个 builtin agent 运行时接入，使 `message/send` 真正派发到 agent，是独立大任务：需定义 agent 入参/产物映射、鉴权透传、超时与失败语义。建议单列里程碑，不阻塞 S3 验收（S3 验收标准是「标准 REST 绑定 + 状态机正确」，已达）。

### 5.3 后端 CI 启动前置（release 流水线依赖）
`conformance.yml` 启动 `node services/backend/server.js` 并等待 `/health`。若生产启动依赖数据库/外部服务而 CI 未预置，该步失败。建议：在 CI 用最小配置（本地 sqlite / 跳过非必需 connector）或于 workflow 前置 `services/backend` 的 DB 准备步骤；此细节需与运维确认，本计划已在工作流中以「清晰失败日志」兜底。

### 5.4 待提交项
以下为本计划周期内的新增/改动，尚在工作树、**未提交**（含 `conformance-runner.mjs`、`conform:*` 脚本、`conformance.yml`、S3/S4 全部文件、债务台账 `plan` 更新）。建议随本次能力缺口闭环 PR 一并提交，并附 `conformance-report.json` 本地 SKIPPED 证据。

---

## 6. 执行清单（Checklist）

- [x] **S3** A2A 服务端任务面：store/methods/routes + 3 探针 + 冒烟 ✅
- [x] **S4** MCP 2025-03-26：版本声明 + SSE + 断线续传 + 2 探针 ✅
- [x] **债务台账排期**：9 条 open 标注阶段 A–D，guard 0 error ✅
- [x] **官方套件 workflow**：`.github/workflows/conformance.yml` 创建（安装 + `--required` + 产物上传）✅
- [ ] 提交上述工作树改动（含 `conformance.yml` 与 `conformance-runner.mjs`/`conform:*`）
- [ ] §5.1 naming 2 错误清理（独立项）
- [ ] §5.2 S3 executor 接入（独立里程碑）
- [ ] §5.3 CI 后端启动前置确认
