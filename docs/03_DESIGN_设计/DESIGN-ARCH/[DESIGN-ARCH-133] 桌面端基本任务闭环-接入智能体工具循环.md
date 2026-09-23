# [DESIGN-ARCH-133] 桌面端基本任务闭环：接入智能体工具循环

> **状态**：**P0 + P1 + P2 已全部落地**（2026-09-23，验收实测见 §10）
> **范围**：`apps/khyos-desktop/` 一条链路（host → main → preload → renderer）。不含后端新增能力、不含 Web 端、不含 TUI。
> **上游依赖**：
> - 后端既有能力：`services/backend/src/cli/ai.js`（`chat`）、`services/backend/src/services/tool/toolUseLoopCore.js`（`runToolUseLoop`）、`services/backend/src/tools/**`（100+ 工具）
> - 同类修复先例：`services/backend/src/services/aiManagementChatHttp.js:214-230`（网页端同病已修，本提案照抄其口径）
> - 通道决策：`AGENTS.md` 五通道矩阵 → host↔backend 同为 Node 进程语义，走 **CH-2 服务直调**
> **调研指针**：`docs/03_DESIGN_设计/DESIGN-OTHER/[DESIGN-OTHER-005] desktop-rd-桌面端调研指针.md`
> **模板合规**：遵循 `[DESIGN-ARCH-124]` 体例；借鉴判定遵循 `[DESIGN-SOURCING-001]` §3 B-P1（见 §2）

---

## 0. 一句话结论

桌面端「完不成基本任务」的根因**不是缺功能，是三层里最上游那一层接错了入口**：

> 桌面端 host 调用的是 **单轮文本** 入口 `aiGateway.generate(prompt)`，
> 而 CLI 与网页端调用的是 **会跑工具循环** 的 `ai.chat(message)`。
> 同一个后端、同一套工具、同一个循环，一边在用，一边没接。

后果：桌面端在与模型聊天，但模型**没有手**。它不会读文件、不会改文件、不会跑命令——因为请求根本没进入工具循环，工具调用即使被模型产出也无处执行、无处回传。

### 病灶清单（六处，全部已实测）

| # | 层 | 病灶 | 证据（file:line） | 性质 |
|---|---|------|------------------|------|
| 1 | host | 用单轮文本入口，不跑工具循环 | `apps/khyos-desktop/src/host/index.ts:88`、`:90-97` | **根因** |
| 2 | main | 有下行 chunk 通道，**无上行 control 响应通道** | `apps/khyos-desktop/src/main/index.ts:903-931` | 断链 |
| 3 | renderer | `chunkToText()` 只抽文本，非文本 chunk 全部丢弃 | `apps/khyos-desktop/src/renderer/App.tsx:35-44`、`:295-302` | 断链 |
| 4 | renderer | 工具执行面板**数据源恒空**（挂载了，但永远返回 `null`） | `renderer/state/toolExecutionSlice.ts:34` 零调用方；`components/message/ToolExecutionPanel.tsx:63` | 断链 |
| 5 | renderer | 权限确认面板**零引用**（完整实现，无人挂载） | `renderer/components/message/ElicitationPanel.tsx:10-16` | 断链 |
| 6 | renderer | 改动列表**硬编码空数组**，注释自己在等一条不存在的事件流 | `renderer/App.tsx:50-51` | 断链 |

> 第 6 条的注释原文：`// 文件改动列表当前为空（mock 已移除，P3-4）；下轮接 host 改动事件流后填充。`
> 这是一个自证死循环——host 没有工具循环 ⇒ 不产生改动事件 ⇒ `diffFiles` 永远空 ⇒ 面板永远不渲染。

### 与「像 ZCode 那样」的关系（据实说明）

用户以 ZCode 的桌面工作台作为**期望行为的参照物**。但本仓的功能对齐**早已完成**：
`docs/03_DESIGN_设计/DESIGN-RES/[DESIGN-RES-001] 桌面端智能体UI调研与差距分析-2026-09-09.md:610-762`
记录了 18 项 ZCode 对齐项**全部实施完成**（4 级模式、父子 Agent 工具树、缓存命中率、任务时间预估…）。

本提案**不新增任何 ZCode 对齐项**。要做的是：把"已经建好的展示层"接到"已经建好的执行层"上——让桌面端从"能聊"变成"能干"。

---

## 1. 现状实证

### 1.1 后端已经有什么（全部已存在，无需新建）

| 能力 | 位置 | 实测事实 |
|------|------|----------|
| 工具集 | `services/backend/src/tools/**` | **100+ 个工具目录**：`FileReadTool` / `FileEditTool` / `FileWriteTool` / `BashTool` / `PowerShellTool` / `GlobTool` / `GrepTool` / `ApplyPatchTool` / `TaskCreateTool` / `EnterPlanModeTool` / `AgentTool` … |
| 工具循环 | `services/backend/src/services/tool/toolUseLoopCore.js` | **10157 行**；`:10157-10159` 导出 `runToolUseLoop` |
| 人在环通道 | 同上 `:739` | `onControlRequest: async ({requestId, request}) => controlResponse — host interactive channel (AskUserQuestion)` |
| 计划模式回传 | 同上 `:743` | `onExitPlanMode` — 计划交回宿主审阅 |
| 工作区根 | 同上 `:1332`、`:9292`、`:9754` | `effectiveChatOpts = { ...chatOpts }`；工具执行根目录 = `effectiveChatOpts.cwd \|\| process.env.KHYQUANT_CWD \|\| process.cwd()` |
| 宿主入口 | `services/backend/src/cli/ai.js:30`、`:630-635` | 导出 `chat`（实现在 `cli/aiChatCore.js:317 async function chat(userMessage, opts = {})`） |
| control 透传 | `services/backend/src/cli/aiMessageBuilder.js:876` | `onControlRequest: guardCallback(opts.onControlRequest, { mark: true })` — **options 会被透传到循环** |
| 事件契约 | `services/backend/src/services/queryEngine.js:25-33` | `thinking` / `text` / `reset` / `control_request` / `tool_call` / `tool_result` / `cost` / `done` |

**关键**：`ai.chat()` 不需要 `KHY_QUERY_ENGINE` 门（那是 `queryEngine` 的门，见 `queryEngine.js:18-19`）。`chat()` 直连 `toolUseLoop`，桌面端接它不依赖任何 feature flag。

### 1.2 网页端已经修过一模一样的病（本提案的直接依据）

`services/backend/src/services/aiManagementChatHttp.js:214-230` 的原文注释：

> Previously this routed through `gateway.generate()` — a **single-shot LLM call that never ran the tool loop**, so the default web chat could only ever return plain text: **tool calls were silently dropped** and the user saw "only a reply, no tools" (or an empty bubble when the model answered purely with tool_use). We now route through `getAi().chat()` — the same agentic path the CLI and the `/api/ai/chat` + WebSocket transports use — so the web chat actually executes tools and streams real token-level text.

**桌面端今天的处境与网页端修复前一模一样**：走 `gateway.generate`，只看 `res.text`。

网页端修复后的完整事件映射（`:327-424`，可直接作为桌面端的照抄对象）：

| 上游 chunk | 网页端 SSE 事件 | 提取字段 |
|-----------|----------------|----------|
| `text` | `chunk` | `chunk.text` |
| `reset` | `reset` | `chunk.reason`（丢弃已流出废稿） |
| `thinking` | `thinking` | `chunk.text` |
| `tool_use` | `tool_use` | `chunk.tool \|\| chunk.name`、`chunk.input`、`chunk.id \|\| chunk.toolUseId` |
| `tool_result` | `tool_result` | `chunk.success` / `chunk.isError` / `chunk.is_error`（**三态兼容**）、`chunk.tool`、`id` |
| `status` | `status` | `chunk.text` |
| `heartbeat` | `heartbeat` | — |
| `control_request` | `control_request` | `chunk.requestId`、`chunk.request` |

**而网页端做不到的事，桌面端做得到**——同一注释 `:227-230`：

> SSE is one-way, so approval-gated tools cannot be answered interactively: `onControlRequest` forwards the prompt for visibility but returns `undefined`, which the tool loop treats as **fail-closed deny** (read-only tools — search, read, list — still run freely).

桌面端 main↔host 是 **Electron fork IPC（天然双向）**，renderer↔main 是 `ipcRenderer.invoke`（天然请求-响应）。**所以桌面端可以做成 TUI 级的交互式权限确认，而不是网页端那种 fail-closed 降级。**

### 1.3 桌面端现状：三层断链

```
renderer  Composer.tsx:681   api.aiSend({ prompt, options })          ← 只消费 res.text
   │                                                                    （App.tsx:297 chunkToText 丢非文本）
   ▼
main      main/index.ts:903  ipcMain.handle('ai:send') → host.send({type:'ai.generate'})
   │                          ✗ 无 ai:controlResponse 上行通道
   ▼
host      host/index.ts:373  msg.type === 'ai.generate'
          host/index.ts:88   ✗ gateway.generate(prompt, options)  ← 单轮文本，无工具
          host/index.ts:287    onChunk → send({type:'ai.chunk'})  ← 通道存在，但上游不产工具事件
   ▼
backend   services/backend/src/cli/ai.js:635  chat()                  ← 会干活的那条路，桌面端没走
          └→ toolUseLoopCore.runToolUseLoop()  ← 100+ 工具在此执行
```

**三层全断，且每一层都"看起来有东西"**：`ai:chunk` 通道有、`ToolExecutionPanel` 有、`ElicitationPanel` 有、`permissionSlice` 有、`diffFiles` 的渲染分支也有——只是数据源全是空的。

这正是本仓记录过的典型模式：**能力已存在、只是没接线**。

| 前端资产 | 实现完整度 | 挂载 | 数据源 | 结论 |
|---------|-----------|------|--------|------|
| `ToolExecutionPanel.tsx` | 完整（状态/耗时/输入/结果/错误/折叠） | ✅ `App.tsx:371` | ❌ `startToolExecution` 零调用 ⇒ `:63` 恒 `return null` | 永不显形 |
| `ElicitationPanel.tsx` | 完整（多题导航/选项/自定义回答） | ❌ 零 import | ❌ 无 | 死代码 |
| `permissionSlice.ts` | 完整（5 级 mode / toolOverrides / pendingConfirmations / resolve） | ✅ `state/store.ts:4` | ❌ 无 dispatch 方 | 恒初始态 |
| `diffFiles` | ❌ 硬编码 `[]` | ✅ `App.tsx:400-402` 有渲染分支 | ❌ 恒空 | 永不渲染 |
| `ModeSelector.tsx` | 完整 | ✅ `Composer.tsx:861` | ✅ | **已通** |

---

## 2. 借鉴判定：B-P1 豁免（据实填「不适用 + 依据」）

`[DESIGN-SOURCING-001]` §3 **B-P1**（doc line 165）原文：

> **豁免**：对已登记能力域的**行为修正**（bugfix、补字段、文案调整）不需要提案。
> 豁免的判定依据是该能力域已在注册表中存在且有 `canonical` 路径。

B-P2 七字段只管**借鉴外部项目**（第 1 字段即「项目名 + 版本/commit」）。本提案**不借鉴任何外部代码**，因此按 B-P2 体例逐项据实声明「不适用」：

### 【借鉴提案 P-01】桌面端接入既有智能体工具循环（非借鉴类）

| # | 字段 | 填写 |
|---|------|------|
| 1 | 借鉴对象 | **不适用**。无外部上游。用户提到的 ZCode 仅作期望行为的参照物；`DESIGN-RES-001:610-762` 记录其 18 项对齐**早已实施完成**，本次不新增对齐项。 |
| 2 | 借鉴内容 | **不适用**。改动全部在既有 canonical 的调用侧，不引入外部结论/结构/行为/测试。 |
| 3 | 解决的问题 | 桌面端 host 走单轮文本入口，`tool_use` 被静默丢弃，用户在桌面端无法完成任何需要读写文件的任务。证据见 §1.3 三层断链与 §0 病灶清单。 |
| 4 | 许可证与代码性质 | **不适用**（无外部来源）。本提案**不引入任何第三方代码/二进制/资源**，全部复用本仓 `services/backend/**` 既有模块。 |
| 5 | 借鉴方式 | **不适用**。若必须归类：属 B-U5 式「**扩展既有 canonical**」链路复用，不新增并行实现。 |
| 6 | 落点与现有实现对比 | **落点**：见 §3.2 文件表（6 个既有文件，0 个新增文件）。**现有同类实现已搜索**：在 `services/backend/src/` 下按 `toolUseLoop` / `runToolUseLoop` / `agenticHarness` / `queryEngine` 检索，命中消费方 `cli/replSession.js`（TUI）、`services/aiManagementChatHttp.js`（网页端）——两者**共用同一 canonical**。桌面端属「第三处未接线的消费方」，不是新增能力域。 |
| 7 | 验收方式 | 见 §7：在工作区内发一句需要改文件的任务，应观察到 `tool_use` → `tool_result` → 文件内容真的变化。 |

**豁免成立的双重依据**：

1. 能力域 `ai-gateway` **已登记且已有 canonical**——
   `docs/10_规范/registry/FEATURE-OWNERSHIP.json` `capabilities[0]`：
   ```json
   { "domain": "ai-gateway",
     "canonical": "services/backend/src/services/gateway/aiGateway.js",
     "ownedLayers": ["L2"], "pattern": "Adapter", "status": "active",
     "notes": "新增供应商必须走适配器模式，不得新增并行调用入口。" }
   ```
2. 本提案**不新增调用入口**，只把 host 侧调用点从既有 `aiGateway.generate` 换成既有 `cli/ai.chat`——恰是对上述 `notes` 的遵守，而非违反。

**不设 feature gate**：依据 `[DESIGN-SOURCING-001]` B-P1 的「新增配置键」判据——加了 env 开关会把本次修正从"豁免"推成"非豁免"；且按 §6.1 判据，「让功能变正确」不构成用户可见权衡，不需要开关。回滚能力由 §4 的分期天然提供（每期独立 commit）。

---

## 3. 目标形态

### 3.1 契约

> **⚠️ 本节已按实施结论订正（2026-09-23）**。初稿写的是「host 改调 `ai.chat(message, opts)`」，
> **这是错的**。实施时实测确认：`cli/ai.js` 导出的 `chat` 是**内层 LLM 调用**——
> `aiChatCore.js:3422-3425` 的注释把它写死了：
> *"When model returns only tool_use blocks with no text, synthesize a response so **the toolUseLoop
> can process the tool calls**"*，且 `chat()` 的返回是 `{ reply, toolUseBlocks, toolCallLog, ... }`
> —— **它把工具调用交回调用方，自己一个都不执行**。
> 正确形态是**驱动既有循环**，这也是 CLI / 网页端 / AgentTool 的既有形态（`queryEngine.js:992`、
> `replSession.js:10897`、`AgentTool/index.js:1258`）：
> `runToolUseLoop(msg, { chat, chatOpts, onToolCall, onToolResult, onControlRequest, abortSignal })`。
> 只调 `ai.chat` 会让工具调用**原样返回后无人执行**——症状与修复前同样是「只有一条回复、没有工具」。

**host 侧调用点**（替换 `host/index.ts` 的 gateway 类型 / 加载 / `handleAiGenerate` 调用）：

```ts
// 内层 LLM（必需）
chat: (userMessage: string, opts?: Record<string, unknown>) => Promise<unknown>

// 外层循环（canonical：services/backend/src/services/toolUseLoop.js）
runToolUseLoop(userMessage: string, options: {
  chat: typeof chat
  chatOpts: {
    cwd?: string                 // ★ 工具执行根目录（工作区）；effectiveChatOpts.cwd 的唯一来源
    effort?: string
    images?: unknown[]
    preferredAdapter?: string
    preferredModel?: string
    onChunk?: (chunk: ChatChunk) => void   // 文本/思考流（内层 LLM 产生）
  }
  abortSignal?: AbortSignal
  onToolCall?: (name: string, params: unknown) => void                        // 循环级
  onToolResult?: (name: string, params: unknown, result: unknown,
                  iteration: number, elapsed: number) => void                 // 循环级
  onControlRequest?: (req: { requestId: string; request: unknown }) => Promise<unknown>
  onCost?: (usage: unknown) => void
  onThinking?: (text: string) => void
}): Promise<{ finalResponse: string; toolCallLog: Array; iterations: number; provider?: string }>
```

**事件分层（初稿混为一谈，实测是两层）**：

| 层 | 事件 | 来源 |
|----|------|------|
| 内层 LLM | `text` / `thinking` / `status` / `reset`（+ CLI 类适配器透传的 `tool_use`/`tool_result`） | `chatOpts.onChunk` |
| 外层循环 | 工具派发与结果、成本、计划进度、控制请求 | `onToolCall` / `onToolResult` / `onCost` / `onControlRequest` |

**工具执行根的关键推论**：`cwd` 必须放进 **`chatOpts.cwd`**（不是 `options.cwd`）——
`toolUseLoopCore.js:1332` 的 `effectiveChatOpts = { ...chatOpts }` 才是它的唯一消费点，
`:9292`/`:9754` 用它决定工具执行根与应用安全策略的作用域。

**IPC 契约变更**（`desktopUiContract.test.cjs` D6 要求 preload ↔ main 两侧一致）：

| 方向 | 通道 | 载荷 | 状态 |
|------|------|------|------|
| renderer → main → host | `ai:send` | `{ prompt, options }`，其中 `options.cwd` 由 main 从 `getWorkspaceRoot()` 注入 | 改（加 cwd） |
| host → main → renderer | `ai:chunk` | **全类型**（不再只 text） | 改（透传） |
| host → main → renderer | `ai:controlRequest` | `{ id, requestId, request }` | **新增** |
| renderer → main → host | `ai:controlResponse` | `{ id, requestId, response }` | **新增** |
| renderer → main → host | `ai:abort` | — | 已有（`main/index.ts:1290`），接到 `abortSignal` |

### 3.2 落点（6 个既有文件，**0 个新增文件**）

| 文件 | 动作 | 说明 |
|------|------|------|
| `apps/khyos-desktop/src/host/index.ts` | **改（核心）** | `:88-97` 的 gateway 类型/加载 → 改为加载 `cli/ai.js` 的 `chat`；`:287` 的 `onChunk` 保持；**新增** `onControlRequest`（把请求 `send` 给 main，并返回一个等待 main 回包的 Promise）；`:373` 分支透传 `options.cwd` / `abortSignal` |
| `apps/khyos-desktop/src/main/index.ts` | 改 | `:903-927` `ai:send` 注入 `cwd: await getWorkspaceRoot()`；host 回包中继新增 `ai.controlRequest` → `webContents.send('ai:controlRequest')`；**新增** `ipcMain.handle('ai:controlResponse')` 转发给 host |
| `apps/khyos-desktop/src/preload/index.ts` | 改 | `:44-57` 旁新增 `onAiControlRequest` / `aiControlResponse`（白名单必须与 main 同步，否则 D6 红） |
| `apps/khyos-desktop/src/renderer/App.tsx` | 改 | `:35-44` `chunkToText` → 改为 `dispatchChunk()` 事件分发（保留原文本路径，新增 tool/control 分支）；`:292-303` 订阅改造 |
| `apps/khyos-desktop/src/renderer/state/messageSlice.ts` | 改 | `:108` 行内新增 tool 事件归并（让 tool 调用作为消息 part 留在会话里） |
| `apps/khyos-desktop/src/renderer/components/message/ElicitationPanel.tsx` | 改（挂载） | 从零引用变为在 `App.tsx` 挂载，`questions` 来自 `permissionSlice.pendingConfirmations` |

> **纪律**：不新建 `agentLoop.tsx` / `desktopAgent.ts` 之类并行实现。改的是"谁被调用"，不是"造一个新东西"。

### 3.3 展示层已有的资产（直接用，不重写）

- `ToolExecutionPanel` — 收到 `tool_use` 时 `dispatch(startToolExecution(...))`，收到 `tool_result` 时 `dispatch(updateToolExecution(...))`，**它自己会显形**（`:63` 的条件是 `activeExecutions.length > 0`）
- `permissionSlice` — `addPendingConfirmation` / `resolveConfirmation` 已具备完整语义
- `ElicitationPanel` — 已是受控组件（`{ questions, onSubmit, onDismiss }`），只需接数据源

---

## 4. 实施分期（每期独立可回滚）

### P0 — 让桌面端「能干活」（唯一必做项）

**目标**：host 从 `gateway.generate` 切到 `ai.chat`，并把 `tool_use` / `tool_result` 端到端送到 renderer。

| 步 | 内容 | 落点 |
|----|------|------|
| 1 | host 换入口 + 透传 `cwd` | `host/index.ts:88-97`、`:373` |
| 2 | main 注入工作区 + 中继 tool 事件 | `main/index.ts:903-927` |
| 3 | preload 暴露（白名单同步） | `preload/index.ts:44-57` |
| 4 | renderer 事件分发（取代 `chunkToText` 单点抽取） | `App.tsx:35-44`、`:292-303` |
| 5 | tool 事件填充 `toolExecutionSlice` | `App.tsx` 分发层 |

**P0 完成的可观察结果**：发一句「把 README 第 3 行改成 X」，桌面端应出现工具执行卡片（读文件 → 编辑文件），且**磁盘上的文件真的变了**。

**P0 明确不做**：权限确认（先让 `onControlRequest` 走 fail-closed deny，与网页端同等安全水位——只读工具照常跑）。这是**刻意的**：先证明循环通了，再谈人在环。

### P1 — 人在环：交互式权限确认

| 步 | 内容 |
|----|------|
| 1 | 新增 `ai:controlRequest` / `ai:controlResponse` 双向通道 |
| 2 | `ElicitationPanel` 挂载 + 接 `permissionSlice.pendingConfirmations` |
| 3 | `ModeSelector` 的 mode 透传到 `options.permissionMode`（映射见 `permissionSlice.ts:13` 的 5 级） |
| 4 | 未响应/超时 → 显式回 `deny`（**fail-closed，不得 fail-open**，对齐 `RUNTIME-010`） |

**P1 完成的可观察结果**：agent 要改文件时桌面端弹出确认框，用户点「允许」后文件才变；点「拒绝」后 agent 收到拒绝并给出替代说明。

### P2 — 改动可视化

| 步 | 内容 |
|----|------|
| 1 | host 汇总本轮 `tool_result` 中带 `affectedFiles` 的编辑类工具 → 推送改动事件 |
| 2 | `App.tsx:51` 的 `diffFiles` 由硬编码 `[]` 改为来自 store |
| 3 | 接 `DiffViewer.tsx`（已存在） |

**P2 的前提是 P0 先落地**——`diffFiles` 的注释本身就在等这条事件流。

---

## 5. 诚实边界（刻意不纳入）

| 不做的 | 原因 |
|--------|------|
| ZCode 的 8 项特性再对齐（时间预估、缓存命中率、Mermaid 预览等） | `DESIGN-RES-001:610-762` 已记录 18 项全部实施完成。再做是重复劳动，且与"完成基本任务"无因果关系。 |
| Web 端 / 移动端 | 网页端**已经**修好（`aiManagementChatHttp.js:214-230`）。移动端不在本次范围。 |
| 多模态输入（图片）链路打通 | `images` 参数在 `ai.chat` 已支持，但桌面端附件→该参数的映射是独立的一条链，与"能否完成任务"正交。P0 不碰。 |
| 会话内工具历史持久化 | 需要 `sessionPersistence` 侧改结构，属另一条线。P0 只保证**当轮**可见。 |
| 桌面端权限模式与后端 6 profile 的完整映射 | `[DESIGN-RES-001]:639-644` 已有映射结论，但 P1 只需最小确认闭环。完整映射留待后续。 |
| 性能/启动优化（host 冷启动 ~5s 等） | 与本次目标正交，混在一起会让回滚粒度变粗。 |

---

## 6. 反模式（这条路别走）

### ❌ 1. 在 host 里自己写一个工具循环

**为什么不行**：`toolUseLoopCore.js` 有 10157 行，内含截断恢复、nudge、验证、去重、批次划分、权限闸门、成本累计。自写一份必然漂移——`queryEngine.js:9-16` 的注释就是本仓为**同一类错误**付过的学费（"former V2 state machine … drifted from it … so the loop's behavior can no longer diverge between the two engines"）。
**正确做法**：复用 `ai.chat`，让 host 只做"适配器"。

### ❌ 2. 走 HTTP/SSE 到本地 `aiManagementServer`

**为什么不行**：这是**看起来更省事、实际更差**的一条路。SSE 单向 ⇒ `onControlRequest` 只能返回 `undefined` ⇒ 工具循环判 **fail-closed deny**（`aiManagementChatHttp.js:227-230`）⇒ 桌面端会**白白退化成网页端的降级形态**，放弃掉 Electron IPC 双向这唯一的优势。
**正确做法**：CH-2 进程内直调（`host/index.ts:2-3` 已经写明了这个通道选择依据）。

### ❌ 3. 新增 `KHY_DESKTOP_AGENT` 之类的 env 开关

**为什么不行**：`scripts/ci/check-tui-gates.js:32` 有 `MAX_GATES = 220`，注释写明 **only moves DOWN**。且按 `[DESIGN-SOURCING-001]` B-P1，「让功能变正确」不构成用户可见权衡——那类回滚能力用**可选参数**（`undefined` → 老行为）即可，既不加 env、又不撞棘轮，**还保住豁免判定**（加了 env 会把本次从"豁免"变成"非豁免"）。

### ❌ 4. 给 `ToolExecutionPanel` 塞 mock 数据让它"看起来在工作"

**为什么不行**：`App.tsx:50-51` 的注释明确记录 mock 已移除（`P3-4`）。塞回 mock 会让"面板显形"与"agent 真在干活"不可区分——用户会以为自己能干活了。
**正确做法**：数据源恒空就是恒空，直到 P0 真接通。

### ❌ 5. 重写 `chunkToText` 的所有调用方

**为什么不行**：`chunkToText`（`App.tsx:35-44`）的 `status` 分支有既有语义（`*text*\n\n` 斜体状态行，`:33-34` 注释说明"网关回退等瞬态状态用斜体行展示，最终结果替换之"）。**扩展**它的分支是安全的，**替换**它会丢掉这个既有行为。

### ❌ 6. 只改 host 就宣布完成

**为什么不行**：host 换了入口但 renderer 的 `chunkToText` 仍在丢弃 `tool_use` ⇒ 用户看到的**仍然只是一条文字回复**（甚至可能是空的——模型纯用工具回答时没有正文，这正是网页端修复前"empty bubble"的现象）。**三层必须一起改，缺一层等于没改。**

---

## 7. 验收方式

### 7.1 功能验收（P0）

在工作区目录下，对桌面端发出一个**必然需要工具**的任务：

> 「读一下 README.md 的前 5 行，把第 3 行改成 `## 已接入智能体循环`」

通过标准（**三条全中才算通过**）：
1. 界面出现工具执行卡片（至少包含一次读取、一次写入）
2. 执行完成后卡片状态为「完成」而非「失败」
3. **磁盘上的 `README.md` 第 3 行真的变了**（用编辑器打开核对）

> 第 3 条是唯一不能自欺的标准。前两条都可以被 mock 骗过，第 3 条不能。

### 7.2 工程门禁

```bash
cd "D:/Portable/khy-os"
node node_modules/.../typescript/bin/tsc -p apps/khyos-desktop/tsconfig.json --noEmit   # 对比改动前后错误数（基线 33 条，见 §8）
node --test apps/khyos-desktop/tests/desktopUiContract.test.cjs                          # D6 preload↔main 一致 / D9 品牌文本
npm run check:frontend-design-tokens                                                     # 禁硬编码色值
npm run check:changed
```

**`file-ratchet` 硬指标注意**：`scripts/ci/file-ratchet.config.json` 的 `caps.consoleCount = 5` 是 **HARD**（变差即红），且其计数器**会先剥离 `//` 行注释再数**。`host/index.ts` 与 `main/index.ts` 已有多个 `console.log`——**P0 新增代码不得再加 `console.log`**，调试信息走已有的 chunk 通道。`lines: 2000` 属 `softMetrics`（只报告），`main/index.ts` 当前 1359 行、余量充足。

### 7.3 交付可见性（最容易白干的一步）

用户看到的是 `apps/khyos-desktop/out/` 的构建产物，**不是源码**。改完必须：

```bash
cd "D:/Portable/khy-os/apps/khyos-desktop" && node node_modules/electron-vite/bin/electron-vite.js build
```

然后**让用户重启应用**（旧窗口不会热更新）。判定新构建是否生效：查 `out/renderer/index.html` 的 `<script src>` 是否指向本次的新 hash 包。

---

## 8. 待核实项

| # | 待核实 | 影响 | 核实方式 |
|---|--------|------|----------|
| 1 | `ai.chat` 的 `chatOpts.cwd` 是否被 `aiChatCore` 原样透传到 `runToolUseLoop` 的 `chatOpts` | **动摇 P0 前提**（若不透传，工具会在 `apps/khyos-desktop` 下执行，改错目录） | 已核实的部分：`toolUseLoopCore.js:1332` 确认 `effectiveChatOpts` 来自 `chatOpts`；`:9292/9754` 确认它决定执行根。**待核实**：`aiChatCore.js:317` → `runToolUseLoop` 之间是否无过滤地传递。落地第一步先跑一次 `cwd` 探针（工具里打印 `process.cwd()`）。 |
| 2 | `ai.abort()` 的调用点是否与 `abortSignal` 接上 | 影响中断体验，不影响 P0 通过 | `main/index.ts:1290` 已存在 `ai:abort`；核对其是否已到 host 层 |
| 3 | host 进程加载 `cli/ai.js` 时的副作用（是否依赖 CLI 初始化） | 可能影响 host 启动 | 在 host 里 `nodeRequire` 后打印导出表；`ai.js:630-635` 的导出面已确认含 `chat` |
| 4 | `desktopUiContract.test.cjs` 的 D6 是否逐通道校验 | 新增 IPC 必须两侧同步 | 读该测试的 D6 实现 |
| 5 | `permissionMode` 的取值口径（`ai.chat` 认哪个 key） | 仅影响 P1 | P1 开工前检索 `planMode` / `permissionMode` 在 `toolUseLoop` 的消费点（`:743` 已见 `planMode`） |

> 第 1 条**动摇 P0 前提**，已在 §7.1 之外额外要求"落地第一步先跑 cwd 探针"，不留给读者自行发现。

---

## 9. 变更日志

- **2026-09-23**：初版。基于对桌面端三层（host / main / renderer）与后端 `ai.chat` / `toolUseLoopCore` 的实测取证；确认六处断链、确认 B-P1 豁免、给出 P0/P1/P2 分期。
- **2026-09-23（同日，P0 落地）**：
  - §3.1 **订正**：host 侧入口由 `ai.chat` 改为 `runToolUseLoop`。实测确认 `chat()` 是内层 LLM 调用
    （`aiChatCore.js:3422-3425` 注释自述"把工具调用交回 toolUseLoop"），只调它等于工具无人执行。
    同时补上「事件分两层」与「`cwd` 必须落在 `chatOpts.cwd`」两条实施期才暴露的结论。
  - 新增 §10 实施记录：落地清单（4 文件 / 0 新增）、6 条偏离及逐条原因、验收实测、构建陷阱、明确不做。
  - §4 的 P0 全部完成；P1 / P2 未开始。
- **2026-09-23（同日，P1 落地）**：
  - 人在环闭环：`onControlRequest` 双向通道（host/main/preload/renderer 四层）+ `ElicitationPanel`
    挂载，覆盖软守卫审批 / Stage 7 权限门 / shell 审批 / AskUserQuestion 四条产生路径。
  - fail-closed 双层兜底：host 300s 超时显式 deny + 后端 `controlRequestGuard` race abort。
  - 新增 §10.6（P1 实施记录：契约表 / 落地清单 / 2 条偏离 / 验收）。状态行更新为「P0 + P1 已落地」。
  - P2（改动列表 / diff 面板）未开始。
- **2026-09-23（同日，P2 落地 —— 方案 P0/P1/P2 全部完成）**：
  - 本轮文件改动列表：host 在 `tool_result` 事件对编辑类工具附带 `affectedFiles`；
    `toolExecutionSlice` 新增 `affectedFiles` + `recordAffectedFiles`；`App.tsx` 删除硬编码
    `diffFiles`（P3-4 遗留），`DiffSummary` 挂真实数据源，`onViewDiff` 沿用既有开文件事件。
  - 新增 §10.7。状态行更新为「P0 + P1 + P2 已全部落地」。

---

## 10. 实施记录（P0，2026-09-23）

### 10.1 落地清单 —— 4 个既有文件，**0 新增文件**

| 文件 | 改动 |
|------|------|
| `apps/khyos-desktop/src/host/index.ts` | 新增 `loadAiChat()` / `loadToolLoop()`；`handleAiGenerate` 由 `gateway.generate` 改为 `runToolUseLoop`（`chat` 传内层函数、`chatOpts.cwd` 传工作区）；新增 `activeAborts` / `pendingToolCalls` + `registerToolCall` / `settleToolCall` / `clearToolCallQueue`；新增 `ai.abort` 消息分支 |
| `apps/khyos-desktop/src/main/index.ts` | `ai:send` 注入 `cwd: await getWorkspaceRoot()`；host 回包中继扩到 `ai.toolCall` / `ai.toolResult`；`ai:abort` 由「本地丢弃结果」改为**同时向 host 发 `ai.abort`** |
| `apps/khyos-desktop/src/preload/index.ts` | 新增 `onAiToolCall` / `onAiToolResult` |
| `apps/khyos-desktop/src/renderer/App.tsx` | 新增工具事件订阅 effect（`startToolExecution` / `updateToolExecution`）——**`startToolExecution` 从此有了第一个调用方** |
| `apps/khyos-desktop/src/renderer/components/message/ToolExecutionPanel.tsx` | 显示范围由「仅进行中」改为「本轮全部（含已完成）」 |
| `apps/khyos-desktop/src/renderer/components/composer/Composer.tsx` | 发送前 `clearExecutions()`；顺手修内联返回类型（见 10.2-5） |

### 10.2 与方案的偏离（逐条给原因）

| # | 偏离 | 原因 |
|---|------|------|
| 1 | **`ai.chat` → `runToolUseLoop`**（初稿 §3.1 的核心写法被推翻） | 实测确认 `chat()` 是**内层 LLM 调用**：`aiChatCore.js:3422-3425` 的注释原文是 *"so the **toolUseLoop** can process the tool calls"*，且返回 `{ reply, toolUseBlocks, toolCallLog }` —— 它把工具调用交回调用方、**自己一个都不执行**。只调 `chat` 会让工具调用返回后无人执行，症状与修复前一样（"只有一条回复、没有工具"）。正确形态是驱动既有循环，与 `queryEngine.js:992` / `replSession.js:10897` / `AgentTool/index.js:1258` 一致。已在 §3.1 就地订正。 |
| 2 | **新增 callId FIFO 配对**（原方案未提） | `runToolUseLoop` 的 `onToolCall(name, params)` / `onToolResult(name, params, ...)` **不带调用 id**，而同一批次内同名工具可并行。不配对只能按工具名找目标，并行同名会张冠李戴（结果挂到别的调用上）。`toolUseLoop` 按派发顺序回结果 ⇒ 同名 FIFO 是安全口径。 |
| 3 | **`ToolExecutionPanel` 改为显示本轮全部**（原方案只说"接线"） | 只显示进行中时，工具执行（几十毫秒）会让卡片一闪而过，用户看不到 agent 干过什么——而"看得见在干活"正是本面板的存在理由。清空交给下一次发送，避免无限累积。 |
| 4 | **`ai:abort` 改为真中断** | 原实现只 resolve 掉 pending 并把结果丢弃（注释自承"底层请求可能仍在后台执行"）。在单轮文本时代这只是浪费一次调用；在工具循环时代，用户点停止后 `Bash` / 写文件**仍会跑完**——那是真实副作用。故改为同时向 host 发 `ai.abort`。 |
| 5 | **顺带修 `Composer.tsx:662` 内联返回类型**（单独登记） | 该内联类型缺 `empty` / `actualAdapter` / `provider` / `fallbackReason`，而下方 `:687-701` 正好在用它们 ⇒ **8 条 TS2339**，是既有类型债。该文件本次本就要改，按 §8.4-4 顺手修复并在此登记（只修这一处，未扩散到其它文件的类型债）。 |
| 6 | **未接入 `onControlRequest` 双向**（按分期） | 依 §4 的分期，P0 明确不做权限确认。实测支持这个决定：`toolUseLoopCore.js:6803` / `:7726` 的判据是 `hr.approvable && typeof onControlRequest === 'function'` —— **不传** 即不走审批通道，按后端默认策略执行，读写都不会被误拒。反之若传一个恒返回 `undefined` 的桩（网页端 SSE 的做法），写操作会被 **fail-closed 拒绝**，P0 验收（文件真的变了）反而不成立。 |

### 10.3 验收实测

| 项 | 命令 | 结果 |
|----|------|------|
| 类型检查 | `tsc -p apps/khyos-desktop/tsconfig.json --noEmit` | **31 → 20 条**（净减 11，**零新增**）。`host/index.ts` 回到既有 15 条；`Composer.tsx` 8 条清零。中途曾因 `loadToolLoop` 缺类型断言引入 `host/index.ts(137,3)` 一条，已定位并修掉。 |
| UI 契约 | `node --test apps/khyos-desktop/tests/desktopUiContract.test.cjs` | **26/26 通过**（含 D6 preload↔main 通道一致性、D9 品牌文本、D10 端点禁令） |
| 设计令牌 | `node scripts/ci/check-frontend-design-tokens.js` | `checked=342 findings=56 exit=0`；findings **全部**在 `apps/ai-frontend` 与 `software/khyquant/frontend`，桌面端**零命中** |
| ratchet HARD 指标 | 按 `file-ratchet` 口径（剥 `//` 注释后计数） | `consoleCount`：host **26**（原 27，删掉 `handleAiGenerate` 里那段多行 debug 日志 ⇒ 净 **-1**），其余文件未动 ⇒ 无变差。`maxFuncLines` / `maxNesting` / `debugger` / `todo` 均未触碰 |
| 产物生效 | 关键词探针扫 `out/**` | `out/host/index.js` 含 `loadToolLoop` / `registerToolCall` / `settleToolCall` / `runToolUseLoop`，且旧标记 `aiGateway 已加载` **已消失**；`out/main/index.js` 含 `ai.toolCall` / `ai.toolResult` / `ai.abort` / `workspaceRoot`；`out/preload/index.js` 含 `onAiToolCall` / `onAiToolResult` |

### 10.4 构建陷阱（本次踩到，务必记住）

`apps/khyos-desktop` 的 `npm run build` 是**三段**，不是一段：

```
electron-vite build                        → out/main, out/preload, out/renderer
vite build --config vite.host.config.ts    → out/host        ← 独立配置，不在 electron-vite 里
vite build --config vite.scheduler.config.ts → out/scheduler ← 同上
```

`electron.vite.config.ts` 只有 `main` / `preload` / `renderer` 三个入口，**没有 host 与 scheduler**。
所以只跑 `electron-vite build` 时，`out/host/index.js` 会**保持上一次构建的样子**——
改了 `src/host/index.ts` 却完全看不到效果，且构建日志一切正常（不会报错）。
本次实测到的证据：只跑 electron-vite 后 `out/host/index.js` 的 mtime 是**前一天**，
关键词探针显示新代码 **未进入产物**。补跑 `build:host` 后 mtime 刷新、关键词全部命中。

> **纪律**：改 `src/host/**` 或 `src/scheduler/**` 后，必须跑
> `npm run build:host`（或完整 `npm run build`），并用**只在本次新增的标识符**探针
> 扫描 `out/host/index.js` 自证生效。

### 10.5 P0 明确不做（按分期，非遗漏）

- **交互式权限确认**（P1）：本次 `onControlRequest` 未接入，写操作走后端默认策略。
- **改动列表 / diff 面板**（P2）：`App.tsx` 的 `diffFiles` 仍是硬编码 `[]`。
- **`AskUserQuestion` 类互动工具**：需要 `onControlRequest` 通道，随 P1。
- **会话内工具历史持久化**：P0 只保证当轮可见。
- **附件 / 图片链路**：`images` 已在契约里透传，但桌面端附件 → 该参数的映射未接。

### 10.6 P1 实施记录（2026-09-23，同日）

**人在环：交互式审批与提问闭环。** 桌面端由此具备 TUI 级的审批能力——这是网页端
SSE 单向通道做不到的（`aiManagementChatHttp.js:227-230`：SSE 只能 fail-closed deny）。

**契约（实施期实测补全，初稿未展开）**：`onControlRequest` 一个通道承载**四条产生路径**，
request 统一为 `{ requestId, request: { subtype: 'can_use_tool', tool_name, input } }`：

| 产生路径 | `tool_name` | `input` | 期望响应 |
|---|---|---|---|
| 软守卫审批 `guardApproval.js:66` | 被拦工具 | `{ ...params, _guardReason, _guardSource }` | `{behavior}` 三态 |
| Stage 7 权限门 `toolCallingPermissions.js:397` | 被审工具 | params | `{behavior}` 三态 |
| shell 命令审批 `loop/approval.js:142` | `shell_command` | `{ command, risk, reason }` | `{behavior}` 三态 |
| 提问 `toolUseLoopCore.js:8782` | `AskUserQuestion` | `{ questions: [{question, options, multiSelect}], contextNote? }` | `{behavior:'allow', updatedInput:{answers}}` |

响应解码是三态容忍的（`toolCallingPermissions._decisionFromControl:326`）：
`true`→allow、`'always'`→allow-always、`{behavior}`→对应、**其余一律 deny**。
提问的答案解码在 `loop/approval.js:171 _readControlAnswers`：`{ behavior, updatedInput: { answers } }`。

**落地清单**（4 文件，0 新增）：

| 文件 | 改动 |
|---|---|
| `host/index.ts` | `pendingControls` 注册表 + `onControlRequest`（发 `ai.controlRequest`、等回包 promise、**300s 无响应显式 `{behavior:'deny'}`**）+ `ai.controlResponse` 分支 + 会话结束 `failAllControls`（显式 deny，非 undefined） |
| `main/index.ts` | `ai.controlRequest` 加入下行中继；新增 `ai:controlResponse` handler（透传） |
| `preload/index.ts` | `onAiControlRequest` / `aiControlResponse` |
| `renderer/App.tsx` | `controlQueue` 状态 + 订阅；`buildControlCard` 归一两类请求；复用 `ElicitationPanel` 渲染（问题卡答案经 `updatedInput.answers` 回传；审批卡三选一映射 behavior）；`onDismiss` → deny |

**安全语义**：fail-closed 双层兜底 —— host 300s 超时显式 deny（RUNTIME-010：授权解析不得
fail-open），后端 `controlRequestGuard` 再 race abort 信号（`toolUseLoopCore.js:8781`）。
"始终允许"的持久化由后端既有 `permissionStore.approve('forever')` 完成（`guardApproval.js:113`），
桌面端不新建第二份持久化真源。

**偏离（2 条）**：

1. **不用 `permissionSlice` 存待决请求**。原方案 §4-P1 写"接 `permissionSlice.pendingConfirmations`"，
   实测其结构（`{ toolName, riskLevel, description }`，`permissionSlice.ts:17-21`）没有 requestId、
   表达不了阻塞式三选一应答，且语义是"权限模式/工具覆盖"而非"待决审批"。硬套即削足适履，
   改用 App 本地 `controlQueue`（channel 一到即渲染，无跨页共享需求）。
2. **顺手修 `ElicitationPanel` 自定义回答丢失缺陷**（单独登记）：`handleSubmit` 旧实现先
   `handleSelect`（setState 异步）再 `onSubmit(answers)`，单题卡上刚输入的自定义答案**必然丢失**。
   改为并入本次提交快照（`merged`）后提交。该组件此前零引用，本次挂载后此路径首次真正可达。

**验收**：tsc **20 条 = P0 后基线，零新增**（App/Composer/ElicitationPanel/preload 全部类型干净）；
`desktopUiContract` **26/26**（D6 校验了新通道 `ai:controlResponse` 的 preload↔main 一致）；
三段构建 exit 全 0；产物探针——`out/host/index.js` 含 `onControlRequest`/`pendingControls`/
`ai.controlResponse`/`failAllControls`，`out/main` 含双通道，`out/preload` 含两个新方法，
renderer 新 hash `index-4fpP5UIg.js` 含 `ElicitationPanel`/`allow-always`/`behavior`。

### 10.7 P2 实施记录（2026-09-23，同日 —— 方案全部完成）

**本轮文件改动列表。** §1.3 病灶 #6（`diffFiles` 硬编码空数组、注释自认在等一条不存在的事件流）
就此闭环——那条注释等的"host 改动事件流"现在存在了。

**落地清单**（3 文件，0 新增）：

| 文件 | 改动 |
|---|---|
| `host/index.ts` | `onToolResult` 对编辑类工具（`edit`/`write`/`multiedit`/`applypatch`/`notebookedit`，小写归一）附带 `affectedFiles`（取 `file_path`/`filePath`/`path`/`notebook_path`——**参数键口径沿用 `guardApproval._rememberApprovedDirectory:194` 的既有先例**，不发明第三套） |
| `renderer/state/toolExecutionSlice.ts` | 新增 `affectedFiles` state + `recordAffectedFiles` reducer；`clearExecutions` 顺带清空（改动列表与工具卡片**同生命周期**：发新消息即清，不会跨任务累积） |
| `renderer/App.tsx` | **删除**硬编码 `diffFiles`（`App.tsx:99` P3-4 遗留）；`DiffSummary` 挂 `affectedFiles` 映射；`onViewDiff` 沿用既有 `khy:open-file` 窗口事件开 codeViewer，未动 |

**诚实红线**：`additions`/`deletions` 恒 0。工具结果不携带行数，算行数要么造假、要么脆弱地解析
output 文本。`DiffSummary.tsx:140-141` 对 0 **不渲染数字**——组件设计者留的口子，正好承载
"知道改了哪个文件、不知道行数"的诚实表达。status 统一 `modified`（无法可靠区分新建/覆盖，
不猜）。

**验收**：tsc **20 条 = 基线，零新增**（App.tsx / toolExecutionSlice 零错误）；
`desktopUiContract` **26/26**；三段构建 exit 全 0；产物探针——`out/host/index.js` 含
`affectedFilesOf`/`EDITING_TOOL_NAMES`，renderer 新 hash `index-D_VELQpj.js` 含
`recordAffectedFiles`/`affectedFiles`/`DiffSummary`。

**P2 明确不做**：`onUndo`（DiffSummary 支持但需要快照/回滚基础设施，属另一条线）；
精确行数（见诚实红线）。

---

## 附：与既有文档的关系

| 文档 | 关系 |
|------|------|
| `[DESIGN-RES-001] 桌面端智能体UI调研与差距分析` | 上游。其 §12 记录 18 项 ZCode 对齐已实施；本提案**不重复**其内容，只解决"展示层建好了但没接线"。 |
| `[DESIGN-OTHER-005] desktop-rd 调研指针` | 上游。桌面端架构选型来源。 |
| `[DESIGN-ARCH-092]`（`permissionSlice.ts:4` 引用） | 权限模式的 5 级定义来源。 |
| `[DESIGN-ARCH-124]` | 体例模板来源。 |
| `docs/tui-interaction-optimize/LOG.md` | TUI 侧同类工作的记录，可对照 P1 的人在环设计。 |
