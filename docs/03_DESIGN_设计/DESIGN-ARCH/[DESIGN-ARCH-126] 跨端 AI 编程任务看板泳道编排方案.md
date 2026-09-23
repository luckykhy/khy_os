<!-- 文档分类: DESIGN-ARCH-126 | 阶段: 设计 | 新建 -->
# [DESIGN-ARCH-126] 跨端 AI 编程任务看板泳道编排方案

> **状态**：方案（未施工） · **日期**：2026-09-20 · **参考**：Cline Kanban（research preview）
> **定位**：本文是「把多执行体（Codex / Claude Code / khy）的 AI 编程任务做成跨端看板」的**设计方案**。
> 它**不**定义任务执行语义（那是 `largeTaskRuntimeStore` 的真源），**不**定义端入口（那是 `entries/entries.json` 的真源）。
> **一句话**：本方案补的是**呈现层与编排映射**，不是编排引擎。

---

## 零、结论先行：khy-os 缺的不是引擎，是「前 27 行之后的全部」

Cline Kanban 表面是一个看板 UI，实质是**三个机制的组合**：

| # | 机制 | Cline 的实现 |
|---|---|---|
| 1 | **一卡一隔离区** | 每张卡启动时分配一个独立 git worktree + 终端 |
| 2 | **二维组织** | 列 = 状态；执行体（Cline CLI / Claude Code / Codex / OpenCode）在设置里选 |
| 3 | **人在环上** | SSE 推送进度；diff 内联评论回灌给 agent；依赖链自动接续 |

对照 khy-os 实测现状，**第 1 和第 3 条的后端已经做完，前端几乎为零**：

```
后端：largeTaskRuntimeStore.js  = 2608 行（11 态状态机 + 租约 + 重试 + 死信 + 检查点 + 幂等 + 事件流）
       routes/largeTasks.js     = 1668 行（29 个端点，含 4 条 SSE 流）
       largeTaskOrchestrator.js / largeTaskWorkerService.js
前端：api/largeTasks.js         =   27 行（2 个函数）
       看板视图                  =    0 个
```

`git grep -il "largeTask\|大任务"` 在 `apps/ai-frontend/src/**` 与 `software/khyquant/frontend/src/views/**`
上**零命中**；唯一消费方是 `composables/useDashboardHandover.js`，它渲染的是 **6 个计数字段**
（`active_large_task_count` / `pending_todo_count` / `pending_remote_approval_count` …），挂在 `views/Dashboard.vue` 上。

⇒ **本方案的增量 = 跨端呈现层 + 执行体泳道 + 与计划层的单向映射**。
新建编排引擎、新建 worktree 机制、新建状态机**都是重复真源，一律禁止**。

**但「后端已有」不等于「契约现成」**——本方案对三处关键断言做了可行性实证，共查出 **7 处缺口**：

| # | 缺口 | 要害程度 | 落点 |
|---|---|---|---|
| 1 | `swimlane`（执行体）在真源任务对象上**不存在** | ★★★ **需求支点** | §4.4 用 `payload_json.source` 补 |
| 2 | 计划层与执行层之间**零连接代码**，ID 格式还不兼容 | ★★★ **映射支点** | §3.4 用 `<hq_id>.<attempt>` 补 |
| 3 | 终态回写只定义了 4 个终态中的 2 个（漏 `cancelled`） | ★★ 会导致任务「卡住」 | §3.4 回写表补全 |
| 4 | `title` 字段不存在 | ★ | §4.3 降级策略 |
| 5 | `checkpointAt` 不在任务对象上 | ★ | §4.3 移出首屏契约 |
| 6 | 命名未对齐真源 `snake_case` | ★ | §4.3 改命名 |
| 7 | **F4 依赖的 worktree 绑定在生产代码里零调用点**（`bindWorktree` 存在，但两个调用方都不传 `taskId`） | ★★ **铁律空转** | §4.5 改为「步 1 新增接线」，否则 F4 降级 advisory |

⇒ **「真源里到底有没有这个字段/这条连接」必须在方案阶段查证，不能假设。**

⚠ 第 7 条属于**另一类**，比前 6 条更隐蔽：不是「字段不存在」，而是**字段存在、机制存在，
却没有任何生产代码会去写它** —— 判据永远只走豁免分支，**看似有守卫，实则空转**。
所以「字段在不在真源里」之外，还要问一句：**谁写它？有没有调用点？**
详细证据见 §3.4（连接键）与 §4.3 / §4.4 / §4.5（契约字段）。

---

## 一、现状证据（全部本机实测，可复现）

| 能力 | 落点 | 实测读数 |
|---|---|---|
| 运行时状态机 | `services/backend/src/tasks/largeTaskRuntimeStore.js` | `TASK_STATUSES` **11 态**；`TERMINAL_STATUSES` **4 态**；`STATUS_TRANSITIONS` 显式转移表；`DEFAULT_LEASE_MS=60000` |
| 编排器 / worker | `services/backend/src/tasks/largeTaskOrchestrator.js`、`largeTaskWorkerService.js` | 均有 `create*` 工厂 + 默认单例导出 |
| HTTP 契约 | `services/backend/src/routes/largeTasks.js` | **1668 行 / 29 端点**，含 `/events/stream`、`/retry-policy/approvals/stream`、`/retry-policy/approvals/retention/stream`、`/handover/snapshot` |
| worktree 机制 | `services/backend/src/services/worktreeManager.js` + `tools/_taskStore.js` | **411 行**：`createWorktree` / `removeWorktree` / `keepWorktree` / `listWorktrees` / `logEvent` / `readEvents`。⚠ **与任务对象的绑定（`bindWorktree`）存在，但生产代码零调用点** —— 见 §4.5 |
| 执行体注册表 | `services/backend/src/services/agentLauncherRegistry.js` | `AGENT_LAUNCHERS` **9 项**（`kiro` / `cursor` / `claude` / `codex` / `trae` / `opencode` / `warp` / `vscode` / `windsurf`），开关 `KHY_AGENT_LAUNCHERS`；**纯叶子**（零 require），可安全被守卫消费 |
| 计划层真源 | `.ai/hq/PROGRESS.json` | **23 个任务**；`TASK_STATES = ['todo','doing','review','done']`（4 态）；租约 `LEASE_MINUTES=120` |
| 计划层数据层 | `services/backend/src/cli/hqStore.js` | **1002 行**；`TASK_TRANSITIONS` / `BUG_TRANSITIONS` / 机器 ID / 租约 |
| 多端真源 | `entries/entries.json` | **8 端**：`desktop`(ready) / `web`(ready) / `web-quant`(ready) / `mobile`(ready) + 4 个 cli 端 |
| 移动端导航 | `apps/khy-os-client-app/lib/ui/screens/home_shell.dart` | 5 个 `NavigationDestination`（聊天 / Agent / 技能 / 独立 / 设置），**无任务入口** |
| Web 路由 | `apps/ai-frontend/src/router/index.js` | 无 `/tasks`、无 `/board` |
| TUI 内联面板 | `services/backend/src/services/taskPanelState.js` | 单进程内存态，**与看板无关，不复用实现** |

**三条由此推出的硬结论**：

1. **看板的数据源已经存在且足够**——29 个端点 + 4 条 SSE，不需要后端新增执行语义。
2. **三端的载体已经存在**——`desktop` / `web` / `web-quant` / `mobile` 四个端条目状态均为 `ready`，**不需要新增端**。
3. **最省力的第一落点是 `web-quant`**——它已经同时具备 `api/largeTasks.js` 与 `useDashboardHandover.js`（含三通道 SSE + 防抖 + 退避重连），改造成本最低。

---

## 二、与既有机制的边界表（**本方案最重要的一张表**）

`[MGMT-STD-008]` §2.2：重叠即违规。逐件划界：

| 既有件 | 它管什么 | 本方案做什么 | **边界（不得越线）** |
|---|---|---|---|
| `largeTaskRuntimeStore` | 单任务的**执行语义**：状态、转移、租约、重试、死信、检查点、幂等 | 只**读**状态与事件 | ❌ 不得新增第 12 个状态；❌ 不得在前端复制 `STATUS_TRANSITIONS` |
| `routes/largeTasks.js`（29 端点） | 运行时 HTTP 契约 | 复用；**仅新增 1 个只读聚合端点** `/large-tasks/board` | ❌ 不新增任何**写**语义端点 |
| `entries/entries.json`（8 端） | 端的入口 / 构建 / 产物真源 | 看板作为**能力**落在既有 4 个端上 | ❌ 不新增端条目，不改 `entries.json` |
| `.ai/hq/PROGRESS.json`（4 态） | **计划层**：给人看的开发任务、Bug、跨机租约 | 作为卡片来源之一，经**单向映射**投影 | ❌ 不合并两套状态机；❌ 不把 11 态写进 `status` 字段 |
| `agentLauncherRegistry.js`（7 执行体） | `khy <agent>` 可启动集 SSOT | 泳道枚举**直接引用它** | ❌ 不另立一份执行体清单 |
| `worktreeManager.js` | worktree 生命周期 + 事件日志 | 卡片「一卡一 worktree」直接调它 | ❌ 不新建 worktree 机制 |
| `taskPanelState.js` | **TUI** 内联任务面板（单进程内存） | 不触碰 | ❌ TUI 面板 ≠ 看板；可共享**状态名**，不共享实现 |
| `[DESIGN-ARCH-117]` / `[DESIGN-ARCH-120]` | 多端入口矩阵 / 移动端能力对等 | 本方案是其**下游消费者** | ❌ 不重定义端矩阵与移动端契约 |
| `[DESIGN-ARCH-111]` | 规则遵守保障（门档从登记表派生） | 步 1 新增的守卫按它接线 | ❌ 不改 `qualityGateStages.js` / `package.json` 的 `&&` 链 |

---

## 三、泳道模型（本方案的核心设计）

### 3.1 为什么必须二维，而 Cline 只需一维

Cline 的执行体是「设置里选一个」，所以列 = 状态就够。
khy-os 要**同时管理 Codex、Claude Code、khy 等多种执行体**（用户原话：「用泳道管理 Codex、Claude Code、khy」），
⇒ 必须是**二维矩阵**：

> ⚠ **用户的提法是举例，不是枚举**：`AGENT_LAUNCHERS` 实际有 **9 个**执行体
> （`kiro` / `cursor` / `claude` / `codex` / `trae` / `opencode` / `warp` / `vscode` / `windsurf`）。
> 泳道**必须从真源派生**，不能把「三种」写死进 UI —— 真源加一个执行体，泳道要自动多一条。

```
                待办/排队   执行中   已暂停   已完成   失败/死信   已取消
  Claude Code  │  ▢ ▢ ▢   │  ▣    │        │  ✓ ✓    │           │
  Codex        │  ▢ ▢     │  ▣ ▣  │        │         │  ✗        │
  … 另 7 条（kiro/cursor/trae/opencode/warp/vscode/windsurf）  │
  ─ 系统（background_task_manager 等） ────────────────────  │
  未归属        │  ← source 为空/未登记的任务落这里，不丢弃
                └─ 列 = 状态（6 列，由 11 态折叠）
                  泳道 = payload_json.source（取值域来自 AGENT_LAUNCHERS）
```

**列 = 状态**（横向：任务走到哪了）
**泳道 = 执行体**（纵向：谁在跑）

### 3.2 折叠表：11 态 → 6 列（**已实证，非散文断言**）

| 看板列 | 承接的运行时状态 | 列终态性 |
|---|---|---|
| 待办/排队 | `queued`, `claimed`, `retry_wait` | `none` |
| 执行中 | `running` | `none` |
| 已暂停 | `pausing`, `paused` | `none` |
| 已完成 | `succeeded` | `all` |
| 失败/死信 | `failed`, `dead_letter` | `all` |
| 已取消 | `cancelling`, `cancelled` | **`mixed`** |

**折叠规则**：11 态里 `claimed` / `pausing` / `cancelling` 是**瞬态**——它们在真实运行中停留时间通常
短于一个 SSE 推送周期（`useDashboardHandover` 的防抖基线是 `HANDOVER_SSE_REFRESH_DEBOUNCE_MS = 800`）。
做成独立列会导致卡片**闪烁跳列**。⇒ **瞬态并入其稳定邻居**。

**为什么 `已取消` 是 `mixed` 而不是 `all`**：
`cancelling`（取消中）**不是**终态——它还能流转到 `cancelled`；而 `cancelled` 是终态。
两态同列 ⇒ 该列混合。这条是**探针跑出来的**，不是先验设计：

```
$ node _产物/board-lane-map.js
[ERROR] L3-terminal services\backend\src\tasks\largeTaskRuntimeStore.js
  列 'closed' 标为终态，但其中 'cancelling' 在真源里不是终态 —— 列语义与状态机冲突
Summary: 1 error(s), 0 warning(s).
```

⚠ **由此推出一条防呆铁律**：卡片级「能否流转」必须由**卡片自身 `status`** 派生，
**不得读列级 `terminal`**。列级只用于列头着色与计数。

### 3.3 与计划层的关系：**单向映射，绝不合并**

这是本方案最容易做错的地方，必须先说清。

`.ai/hq/PROGRESS.json` 的 4 态与运行时的 11 态**不是重复真源**——它们位于**不同抽象层级**：

| | 计划层（人） | 执行层（机） |
|---|---|---|
| 载体 | `.ai/hq/PROGRESS.json` | `largeTaskRuntimeStore` |
| 状态数 | 4（todo/doing/review/done） | 11 |
| 一个条目代表 | 「**要达成什么**」，跨会话存活 | 「**怎么跑完这一趟**」，可重试可死信 |
| 谁写 | 人 + AI 会话 | worker 进程 |
| 生命周期 | 天～周 | 秒～小时 |

⇒ 关系是 **1 : N**（一个计划任务可产生多次运行时尝试）。

**映射方向单向**：

```
计划层 ──(展开)────────────────> 执行层        ✅ 允许
执行层 ──(仅终态回写)──────────> 计划层        ✅ 允许，且只回写终态（4 个全覆盖，见 §3.4）
运行时 11 态 ──> PROGRESS.json 的 status ──>   ❌ 禁止（会造成两套状态机互相污染）
```

### 3.4 连接键：`<hq_id>.<attempt>`（**实测缺口：两边零连接**）

⚠ **可行性实证发现：这两套任务体系之间目前没有任何连接代码。**
`git grep -nE "hq_task|hqTaskId|largeTask.*hq|hq.*largeTask" -- 'services/**' 'scripts/**'` **返回空**；
且 ID 格式不兼容：

| | 格式 | 生成方 |
|---|---|---|
| 计划层 | `T-001`（人工分配，定长 5 字符，当前 23 条） | `hqStore.js` |
| 执行层 | `<scope>-<hex4>-<seq>`（如 `large-task-a1b2-7`，自动生成） | `_newTaskId()`（`largeTaskRuntimeStore.js:870-879`） |

所以 §3.3 的「单向映射」缺一根轴。**落法（复用既有能力，零改真源）**：

| 环节 | 做法 | 依据 |
|---|---|---|
| 展开：计划 → 执行 | `createTask({ id: '<hq_id>.<attempt>', payload_json: { source, hq_task_id } })` | `createTask` **接受外部传入 `id`**（`const id = input.id \|\| _newTaskId(...)`，`:1299`） |
| 反查：执行 → 计划 | `listTasks({ id_prefix: '<hq_id>.' })` | `id_prefix` 过滤**已存在**（`:1359-1361`） |
| 看板聚合 | 服务端一次 `listTasks({})` + 内存分组，**不新增 store 过滤维度** | 避免改执行语义（§二 边界表） |

**为什么 attempt 后缀不可省**：`createTask` 对重复 id **直接抛错**
（`if (state.tasks[id]) throw new Error('Task already exists: ' + id)`，`:1300-1302`）。
而计划层→执行层是 **1:N**，第二次尝试若复用同一个 id 会撞错。
⇒ `.<attempt>`（从 1 开始）既满足 1:N，又让 `id_prefix` 能一次圈定全部尝试。

**为什么前缀要带尾部分隔符**：若用裸 `id_prefix='T-001'`，会把 `T-0011` 的尝试也并进来。
带尾点（`'T-001.'`）后语义无歧义 —— 探针 J2/J5 守这条。

**终态回写必须覆盖全部 4 个终态**（`TERMINAL_STATUSES`）：

| 运行时终态 | 回写 `PROGRESS.json.status` | 是否追加 note |
|---|---|---|
| `succeeded` | `done` | 否 |
| `failed` | `doing`（任务本身未完成） | 是 |
| `dead_letter` | `doing` | 是 |
| `cancelled` | `todo`（这一趟放弃，任务退回待办） | 是 |

⚠ **本方案初稿只定义了前两行**（`succeeded` / `failed`+`dead_letter`），**漏了 `cancelled`**。
后果是：一个被取消的运行时任务，其计划任务会**永远停在 `doing`**，看板上表现为「卡住」。
探针 J4 现在做**完备性**检查（每个终态都必须有回写目标）+ **可靠性**检查（非终态不得配回写）。

---

## 四、三端呈现策略（桌面 / 手机 / 网页）

复用 `entries/entries.json` 的既有 4 个端条目，**不新增端**：

| 端 | entry id | 载体 | 看板形态 | 复用情况 |
|---|---|---|---|---|
| 桌面 | `desktop` | `apps/khyos-desktop`（Electron） | 全二维矩阵（列 × 泳道） | 需新建视图 |
| 网页 | `web` | `apps/ai-frontend`（Vue） | 全二维矩阵 | 需新建视图；与桌面共用组件 |
| 网页(量化) | `web-quant` | `software/khyquant/frontend`（Vue + Capacitor） | 全二维矩阵 | **✅ 已有 `api/largeTasks.js` + `useDashboardHandover.js`** |
| 手机 | `mobile` | `apps/khy-os-client-app`（Flutter） | **单泳道纵向流** | 需新建 screen；挂在 `home_shell` 第 6 个导航项 |

### 4.1 响应式降级规则（不可让渡）

| 断点 | 形态 |
|---|---|
| ≥ 1024px | 二维网格；卡片可拖拽跨列（拖拽 = 调 `/pause` `/resume` `/cancel`，**不直接改状态**） |
| 640–1023px | 泳道保持为行，列**横向滚动**；拖拽降级为长按菜单 |
| < 640px（手机） | **泳道切换器 + 单列纵向流**；不做横向滚动矩阵 |

**跨端一致性的唯一判据**：三端渲染**同一个** `GET /large-tasks/board` 响应体。
差异只允许出现在**布局**，不允许出现在**数据**。

### 4.2 共享契约先行：`GET /large-tasks/board`（只读聚合）

**先做契约可行性实证**——本方案初稿的契约有 4 处与真源对不上，已订正（见 §4.3）。

```jsonc
{
  "lanes":     [ { "id": "backlog", "title": "待办/排队", "terminal": "none" } ],
  "swimlanes": [ { "id": "claude", "title": "Claude Code", "kind": "agent", "source": "claude" },
                 { "id": "_system", "title": "系统", "kind": "system", "source": "__unassigned__" } ],
  "cards":     [ { "id": "…", "status": "running", "lane": "active", "swimlane": "claude",
                   "type": "large_task", "source": "claude", "title": "…",
                   "progress_pct": 40, "attempt_count": 2,
                   "updated_at": "…", "created_at": "…" } ],
  "counts":    { "byLane": {}, "bySwimlane": {} }
}
```

**契约纪律（三条，逐条有真源依据）**：

1. **字段名一律沿用真源的 `snake_case`，不做驼峰转换。**
   真源任务对象用 `attempt_count` / `updated_at` / `progress_pct`（`largeTaskRuntimeStore.js:1310,1316,1320`）。
   在契约层做一层命名转换会制造第二套字段名，违反「一处真源」。

2. **`cards[]` 只放真源任务对象上真实存在的字段。** 逐字段出处见 §4.3 的对照表。
   首屏**不**返回 checkpoint 时间——它不在任务对象上（在 `task_checkpoints[id]`），
   需要时点开卡片详情再拉 `/large-tasks/:taskId`。**不为了契约好看而伪造字段。**

3. **`swimlanes[]` 由 `payload_json.source` 的**实际取值**反推，不预设清单。**
   见 §4.4。

字段名与 `LANE_MAP` 逐字对齐，由步 1 的守卫锁死（F1/F2/F8）。

### 4.3 契约可行性实证（本方案初稿的 4 处错误）

真源任务对象（`largeTaskRuntimeStore.js:1304-1324`，`createTask()` 内的字面量）**只有这 19 个字段**
（探针 `extractTaskFields()` 实测 19，含 `id` 这一条**简写**写法 —— 按行 grep `^\s+(\w+):` 会漏掉它，数出 18）：

```
id  type  status  payload_json  priority
attempt_count  max_attempts  next_run_at
lease_owner  lease_until  heartbeat_at
progress_pct  idempotency_key  trace_id
created_at  updated_at  completed_at
last_error  last_result
```

对照本方案初稿的契约：

| 初稿写的 | 真源实况 | 处置 |
|---|---|---|
| `taskId` | 字段名是 `id` | 改名 |
| `status` | ✅ `status` | 保留 |
| `lane` | 派生（`LANE_MAP` 折叠），非真源字段 | 保留（明确标注为派生） |
| **`swimlane`** | ❌ **任务对象上没有执行体字段** | **改为派生自 `payload_json.source`**，见 §4.4 |
| **`title`** | ❌ 无 `title` 字段 | 降级为 `payload_json.title`，缺失时回退 `type + id` 短哈希 |
| `updatedAt` | 真源是 `updated_at` | 改 snake_case |
| `attemptCount` | 真源是 `attempt_count` | 改 snake_case |
| **`checkpointAt`** | ❌ 不在任务对象上（在 `task_checkpoints[id]`） | **从首屏契约移除**，详情页再拉 |

**第 4 处错误（不在契约里，在 §一 的现状读数里）**：初稿把 `AGENT_LAUNCHERS` 记成 **7 项**，
真源实为 **9 项**（漏了 `vscode` 与 `windsurf`）。

⚠ **这个错误本身就是一条判据**：漏项的原因是 `windsurf` 的条目是**多行写法**
（`command:` 独占一行），而**按行**的匹配（`grep -c "Object\.freeze({ command:"`）会**静默漏掉它**。
用 `require` 复核才发现（`AGENT_LAUNCHERS.length === 9`）。
⇒ 任何消费这份注册表的守卫，**必须带一条「文本抽取条数 == require 条数」的自校验**，
否则漏抽的执行体永远不会进入反向检查，形成**静默假绿**。详见 §八 末尾。

⚠ **其中 `swimlane` 是要害**：用户的原话是「用泳道管理 Codex、Claude Code、khy」，
而**真源里没有任何字段记录「这个任务归哪个执行体」**。若不解决，整个泳道维度是空中楼阁。

### 4.4 泳道维度的落法：`payload_json.source`（**零改真源**）

`payload_json.source` **已经是既有的约定维度**，不是本方案发明的：

| 证据 | 位置 |
|---|---|
| `listTasks()` 已按 `task.payload_json.source` 过滤 | `largeTaskRuntimeStore.js:1354-1358` |
| HTTP 层已暴露该过滤维度：`GET /large-tasks/?source=` | `routes/largeTasks.js:663, 668` |
| 既有先例：模块用 `const SOURCE = 'background_task_manager'` 隔离自己的任务 | `backgroundTaskManager.js:16, 73` |
| `payload_json` 是**自由对象**，`normalizePayload` 原样透传（不白名单、不裁剪） | `routes/largeTasks/routeHelpers.js:131-136` |

⇒ **泳道 = `payload_json.source` 的取值**，**不需要给真源加字段、不需要改状态机**。

**但泳道必须分两类**（这是 `source` 取值域混杂的必然结果）：

| kind | 含义 | `source` 取值 | 卡片归属 |
|---|---|---|---|
| `agent` | 由某个外部编码 agent 执行 | `claude` / `codex` / `opencode` / … （取值域 = `AGENT_LAUNCHERS` 的 `command`） | 对应泳道 |
| `system` | 平台自身派发的任务 | `background_task_manager`、`cli-learning-curriculum`、… | 「系统」泳道 |

⚠ **`source` 为空 / 未登记的任务必须落「未归属」泳道，不得静默丢弃**——
这正是 F8 要守的东西（对应 §八 的反例 R6）。

> **为什么不给真源加 `agent` 字段**：那要改 `createTask` 的字面量 + 迁移既有任务 + 动状态机附近的代码，
> 而 `payload_json.source` 已经能表达同一件事且**已被 2 处代码消费**。
> 按 §二 的边界表，本方案**不得**动执行语义。

### 4.5 契约字段可解析性（**第四类空头支票：字段存在但没人写**）

§4.3 修的是「字段根本不存在」。还有一种更隐蔽的：**字段存在、写入函数也存在，
却没有任何生产代码会去调它** —— 判据于是永远只走豁免分支，**看似有守卫，实则空转**。

**实证对象 = F4 的 `worktree`**：

| 环节 | 事实 | 证据 |
|---|---|---|
| 字段存在 | ✅ `payload_json.worktree` | `tools/_taskStore.js:64`（`worktree: payload.worktree \|\| null`） |
| 写入函数存在 | ✅ `bindWorktree(taskId, name)` | `tools/_taskStore.js:546` |
| 由谁触发 | `worktreeManager.createWorktree({taskId})` 内部调它 | `services/worktreeManager.js:206` |
| **有调用点吗** | ❌ **零调用点** | `EnterWorktreeTool/index.js:54` 与 `cli/repl/worktreeCommand.js:126` 调 `createWorktree` 时**都不传 `taskId`** |
| 额外约束 | `bindWorktree` 只接受 `payload_json.source === 'tool_task_store'` 的任务 | `tools/_taskStore.js:13, 70-76` |

⇒ `payload_json.worktree` **今天恒为 `null`**。F4 若按「非空 或 带豁免理由」判，**永远走豁免分支**。

**处置（三选一，本方案取第 1 条）**：

1. **步 1 新增接线**：让启动器在创建隔离区时把自己的 task id 传下去
   （`createWorktree({ name, taskId })`），F4 才有东西可判。
   这是本方案**唯一需要新增的执行侧接线**，其余全部复用。
2. 若步 1 不接线 ⇒ **F4 必须降级为 advisory**，并在文档里写明「当前不可判」。
   留一条永远为真的铁律**比没有更坏**：它会让人以为这里有守卫。
3. ❌ 不要为了「让 F4 能过」而在卡片层伪造一个 worktree 字段 —— 那是第二套真源。

⚠ **这条判据已固化为探针的 `K2-unwired`**：它读 `bindWorktree` 是否存在、
扫两个调用方是否传 `taskId`，只要调用点为 0 就报警（默认 warning）。
反例 `--scenario=worktree-wired` 把调用点置 1、报警消失 —— **双向都测，防空转**。

### 4.6 契约字段的四种出处（**K1 守卫**）

把 §4.2 的 `cards[]` 逐字段归类，**每类都有可自动复核的判据**：

| 出处 | 判据 | 本契约里的字段 |
|---|---|---|
| `task` | 必须出现在 `createTask()` 字面量里 | `id` `status` `type` `progress_pct` `attempt_count` `updated_at` `created_at` |
| `payload` | 必须有代码真读它（`payload_json.x` / `payload.x`） | `source`、`worktree` |
| `derived` | 派生源本身可解析 | `lane`（← `LANE_MAP`）、`swimlane`（← `payload_json.source`） |
| `convention` | **必须写明写入方**，否则卡片上永远是 `undefined` | `title`、`no_worktree_reason` |

⚠ **`convention` 是最容易漏的一类**：本方案新约定的 payload 键，若没写清「谁写它」，
上线后就是一片 `undefined`，而且**不会报错**。所以 K1 把「写入方非空」也做成了硬判据。

反例 `--scenario=ghost-field`：抽掉 payload 里的 `source` 键，模拟「初稿把 `swimlane` 当成凭空字段」，
K1 立刻报 2 个 error（`swimlane` 与 `source`）。

---

## 五、强度梯度：事前 advisory / 事中 warning / 事末 error

**这是本方案的第一原则。** 过早阻断会逼 AI 谎报「已复现 / 已确认」，反而更危险。

| 阶段 | 场景 | 强度 | 理由 |
|---|---|---|---|
| **事前** | 建卡时验收标准为空、执行体未指定 | `advisory` | 只提示，不阻断。人可以在信息不全时先建卡 |
| **事中** | 状态停留超阈值、worktree 缺失 | `warning` | 标记异常，**绝不杀任务**（与 `RUNTIME-003` 活动式超时同源：不许硬超时） |
| **事末** | 终态未回写计划层；列语义与状态机冲突 | `error` | 只在这里阻断——此时结论已确定，不依赖 AI 自称 |

⚠ 与 `RUNTIME-003`（活动式超时）一致：**卡片的「卡住了」判定必须基于活动信号（`updatedAt` / 心跳），
不得基于墙钟时长**。

---

## 六、防呆铁律（写死、不可绕过、每条都有可自动判的判据）

| # | 铁律 | 自动判据 | 现状 |
|---|---|---|---|
| **F1** | 卡片状态只能来自真源 11 态，且每态恰好落一列 | 探针 `L1-partition`（划分完备 + 互斥） | ✅ 已实证 0 error |
| **F2** | 列级 `terminal` 声明必须与承接状态的实际终态性吻合（三态双向） | 探针 `L3-terminal` | ✅ 已实证（并因此把 `closed` 改为 `mixed`） |
| **F3** | 前端**不得**复制状态转移表 | `git grep STATUS_TRANSITIONS -- '**/frontend/**'` 必须为空 | ✅ 已落地（前端零 `STATUS_TRANSITIONS`，实测空；⚠ 校验须用 ripgrep，`git grep` **不搜未跟踪文件**，用它会得出假绿） |
| **F4** | 每张执行卡必须有 worktree，或显式豁免理由 | 卡片 `worktree` 非空 **或** `no_worktree_reason` 非空。⚠ 字段出处是 **`payload_json.worktree`**（由 `tools/_taskStore.bindWorktree(taskId, name)` 写入），**不是** `worktreeManager` 事件日志的 join。⚠⚠ **但该绑定在生产代码里零调用点**（`EnterWorktreeTool` 与 `worktreeCommand` 调 `createWorktree` 时都不传 `taskId`）⇒ **今天跑这条判据只会走豁免分支 = 空转**。**步 1 必须新增接线**（让启动器把自己的 task id 传给 `createWorktree`），否则 F4 降级为 advisory。探针 `K2-unwired` 盯着这一点 | ⏳ 步 1（**含新增接线**） |
| **F5** | 终态卡片不可再流转；按钮态由**卡片 status** 派生 | 前端不得读列级 `terminal` 做动作门控 | ✅ 已落地（动作只从卡片 `actions` 派生；`board.test.js` 断言 CSS 只认 `data-tone`、且 `model.js` 除 `STATUS_TONE` 外无状态字面量） |
| **F6** | 手机端不做横向滚动矩阵 | 组件层断点断言（<640px 不渲染网格） | ✅ 已落地（矩阵仅在 `mode==='desktop'`（≥1024px）渲染；<640px = 列切换器 + 扁平单列） |
| **F7** | 运行时状态不得写进 `PROGRESS.json` 的 `status` | 该字段只允许 4 值；由 `check-memory-schema.js` 体系兜底 | ⏳ 步 1 扩判据 |
| **F8** | 泳道取值只能来自 `payload_json.source`；**未登记 / 为空的 source 必须落「未归属」泳道，不得静默丢弃** | 探针 R6：`cards[].swimlane` 必非空，且每个 `swimlane.source` 能在卡片 `source` 集合里找到来源 | ✅ 已落地（`largeTaskBoard.test.js`：兜底泳道恰好一个、未登记/空/非字符串 source 一律落兜底、不返回 null） |
| **F9** | `kind='agent'` 的泳道，其 `source` 必须在 `AGENT_LAUNCHERS` 的 `command` 集合内 | 探针 S3（**双向**：真源每个执行体也必须都有泳道） | ✅ 已实证 |
| **F10** | 运行时任务 id 必须是 `<hq_id>.<attempt>`，attempt 为 ≥1 的整数；反查必须带尾部分隔符 | 探针 J1/J2/J3/J5 | ✅ 已实证（含非法 attempt 拒绝 + 合法值放行的双向对照） |
| **F11** | **每个运行时终态都必须有回写目标**，非终态不得配回写 | 探针 J4（完备性 + 可靠性双向） | ✅ 已实证（并据此补上漏掉的 `cancelled`） |
| **F12** | 消费文本抽取型清单的守卫，必须带「抽取条数 == `require` 条数」自校验 | 步 1 守卫内置断言 | ✅ 已落地（且**结构性消除**：运行时模块不消费文本抽取，执行体清单由路由层调 `getLauncherCommands()` 传入；`board.test.js` 与真源双向比对，条数不等即红） |
| **F13** | 契约里**每个卡片字段**都必须能追溯到「真源字段 / 被消费的 payload 键 / 可解析的派生源 / 写明写入方的新增约定」四类之一 | 探针 `K1-ghost-field`（逐字段复核；`convention` 类必须写入方非空） | ✅ 已实证 0 error（13 字段全部归类；反例 `ghost-field` 触发 2 error） |
| **F14** | **任何铁律的判据都必须能被真实数据触发**；若其依赖的写入路径在生产代码里零调用点，该铁律必须降级或补接线 | 探针 `K2-unwired`（数 `bindWorktree` 的真实调用点） | ⚠ 已实证：F4 当前**零调用点 ⇒ 空转**；步 1 接线后转 ✅ |

---

## 七、B-L2 三步接线清单

**一次提交只做一步**（`SOURCING-006`：禁止一次做完标记+迁移+收口）。

### 步 1｜标记（只加只读契约与守卫，**不碰任何 UI**）

1. 新增只读端点 `GET /large-tasks/board`（聚合 `lanes` / `swimlanes` / `cards` / `counts`）。
2. 把 `_产物/board-lane-map.js` 的判定逻辑抽成纯叶子 `scripts/lib/boardLaneGuard.js`
   （零 IO、确定性、绝不抛、可单测）；薄 IO 壳进 `scripts/ci/check-board-lanes.js`。
3. `package.json` 加别名 `check:board-lanes` —— 否则 `check-wiring` 判「检查器零接线」**error**。
4. `docs/10_规范/registry/RULES-REGISTRY.json` 补条目 **`API-005`**（`API-001`～`API-004` 已占用）：
   - `domain: "API"`（十域封闭枚举之一，**不得自创**）
   - `gate: "commit"` + `severity: "advisory"`
   - ⚠⚠ **绝不可写 `gate: "advisory"`** —— `GATE_ORDER.advisory = 4 > max = 2`，
     该规则**永远不会被任何门档选中**，且所有守卫全绿（空接线最难发现）。
     正确表达「只记录不拦截」= `gate:"commit"` + `severity:"advisory"`。
   - `formerly` 必须是字符串（无前身写 `"无"`，写 `null` 会被规则卡生成器拒收）
   - 同步 `meta.ruleCount` 与 `rules.length`（87 → 88）
   - ⚠ 写登记表**不要**用 `node -e "…"` 内联中文 + 反引号（bash 会当命令替换吃掉字段）
5. 在本文件第 3 行加标记 `<!-- RULES-REGISTRY: API-005 -->`（`ssot` 指向的文档必须自带该标记，
   否则 `check-rules-registry` 报「登记表与真源断链」）。
6. 跑 `docs:rules-cards` 生成规则卡（**禁止手改卡片**）。

**步 1 的验收（缺一不可）**：

```bash
node scripts/ci/check-board-lanes.js          # 期望 0 error
npm run check:wiring                          # 期望无本规则相关 error
npm run check:gov-rules                       # 期望 domain 合法
npm run rules:coverage                        # 期望 P0/P1 无「无执行器」
npm run rules:gate:commit 2>&1 | grep check-board-lanes
# ⚠ 必须看到 action=start ... mode=commit —— 只看 check:wiring 绿是不够的，
#   它只校验「有没有声明」，不校验「会不会跑」。
```

### 步 2｜迁移（先落 `web-quant`，成本最低）

在 `software/khyquant/frontend` 落看板视图，复用既有 `useDashboardHandover.js` 的
**三通道 SSE + 防抖 + 退避重连**骨架，只把「6 个计数」换成「二维矩阵」。
不改后端，不改 `entries.json`。

### 步 3｜收口（抽公共组件 → 桌面 → 手机）

1. 把矩阵组件抽到共享位置，`web` 与 `desktop` 接入。
2. 移动端落**单泳道纵向流**，挂 `home_shell.dart` 第 6 个导航项。
3. **收紧** `check:board-lanes` 的强度。

**收紧的验收判据（硬性）**：**同一改动集在收紧前后 `Summary` 的 error 数必须不同**，
并**写成测试**。若两者相同，说明强度被写死，`STAGE` 常量变成了装饰——
升级后仍不拦截，而所有守卫全绿。参照 `scripts/tests/check-commit-timing.test.js` 的实现。

### 实际落地状态（2026-09-21）

上表是**施工前的计划**。实际落地如下，**与计划的每一处差异都显式记录** ——
计划与实现的偏差不写下来，下一个人会把计划当成现状。

| 计划项 | 实际 | 差异与原因 |
|---|---|---|
| 步 1 · `GET /large-tasks/board` | ✅ 已落地 | `services/backend/src/routes/largeTasks.js`，声明在 `/metrics` 之后、`/:taskId` **之前**（顺序由测试锁死，否则被通配遮蔽） |
| 步 1 · 聚合逻辑抽成纯叶子 | ✅ 已落地，但落**运行时目录** | `services/backend/src/tasks/largeTaskBoard.js`（零 require / 零 IO / 绝不抛）。放这里而非 `scripts/lib/`：它是**运行时**真源、被路由直接 require；`scripts/lib/` 会被 `cross-layer-require` 判跨层 |
| 步 1 · 表漂移守卫 | ⚠ **改为 jest 测试，未做 `$g` 检查器** | `services/backend/tests/tasks/largeTaskBoard.test.js`（28 条）从 `TASK_STATUSES` / `TERMINAL_STATUSES` / `STATUS_TRANSITIONS` / `AGENT_LAUNCHERS` **反推**并复核三张表；路由契约 `tests/routes/largeTasks.board.route.test.js`（11 条，含路由顺序断言） |
| 步 1 · `API-005` 登记 + 规则卡 + 阶段表 | ❌ **未做** | 属独立接线的四处触点（登记表 / 标记行 / `docs:rules-cards` / 阶段表），未与本次 UI 混做 |
| 步 2 · `web-quant` 落看板 | ✅ 已落地 | `views/TaskBoard.vue` + `api/largeTasks.js` + 路由 `/tasks` + `HOST_MENU_ITEMS` 一项 |
| 步 2 · 复用 `useDashboardHandover` 的 SSE 骨架 | ❌ **未复用** | 该骨架面向「交接快照」，与看板聚合端点语义不同；本次用「取数 + 手动刷新」。实时刷新留待后续 |
| 步 3 · 抽公共组件 | ✅ 已落地 | `platform/packages/ui-shared/src/board/`（`model.js` + `TaskBoard.vue` + `TaskCard.vue`），**两端共用同一份** |
| 步 3 · 桌面端接入 | ✅ `apps/ai-frontend` 接入 `/admin/tasks` | 放 **admin 组**：数据源 `largeTaskRuntimeStore` 是全局的（含平台后台任务），不含用户隔离，暴露给普通用户等于泄露他人任务信息 |
| 步 3 · 移动端单泳道纵向流 | ✅ 组件内置三档断点 | `<640px` = 列切换器 + 扁平单列（泳道以 chip 标在卡上）；`640–1023px` = 列切换器 + 泳道分组；`≥1024px` = 二维矩阵 |
| 步 3 · 收紧守卫强度 | ❌ 未做（依赖尚未登记的规则） | — |

**五条落地时才发现、必须回写计划的判据**：

1. **`@khy/ui-shared` 里可以放 `.vue`，但必须走子路径导出。**
   包的 `board/index.js` **不能** import `.vue` —— 否则任何 Node 消费者（`node --test`）
   一 import 就因无法解析 SFC 而崩。故 `.vue` 走 `"./board/TaskBoard.vue"` 独立导出，
   `"./board"` 只出纯 JS。两端 `vite build` 均**实测通过**（各产出 `TaskBoard-*.js` 13–14 kB），
   **无需** `optimizeDeps.exclude` —— pnpm 链接包被 Vite 视为源码，`plugin-vue` 会正常处理。

2. **共享组件刻意不用 `<el-*>` 标签。**
   两端的 Element Plus 注册方式不同：`web-quant` 是全局 `app.use(ElementPlus)`；
   `ai-frontend` 用 `unplugin-vue-components` **按需自动导入**，而其默认 `exclude` 含
   `node_modules`。包外 `.vue` 里的 `<el-*>` 在 `ai-frontend` 是否被解析器扫到属于
   **未验证的边界**，一旦扫不到就是**静默渲染为空**。故组件只用语义化 HTML +
   消费 Element Plus 的 CSS 变量（带兜底）—— 主题自动继承、两端行为一致、零依赖风险。

3. **⚠ 同一 app 内行尾不一致。**
   `apps/ai-frontend` 与 `software/khyquant/frontend` 内部**同时存在 LF 与 CRLF 文件**
   （实测：`router/index.js` 与 `useRoutePrefetch.js` 是 CRLF，`nav/index.js` 是 LF；
   `pluginManager.js` 是 CRLF，`router/index.js` 是 LF）。
   按 LF 打补丁会「锚点 0 命中」；强行写入则**整个文件每行都变**（假 diff 淹没真实改动）。
   补丁必须按**各文件实际 EOL** 归一化锚点与替换文本。

4. **前端的状态知识必须单表化。**
   首版把状态知识散落在三处：`summarize()` 的桶、`TaskCard.vue` 的 CSS 选择器、
   以及各处 `status === 'xxx'` 判断。后端新增第 12 个状态时会**静默降级**
   （卡片变灰、不计入任何摘要桶），不崩但骗人。现收敛为 `model.js` 的 **`STATUS_TONE` 单表**：
   `summarize()` 从色调派生、CSS 由 11 态选择器收敛为 4 类 `data-tone`。
   这是**有界耦合**（呈现层决策，无法从后端派生 —— 后端只给列级 `terminal`，
   不足以区分「排队」与「暂停」），由 `tests/board.test.js` 锁住。
   ⚠ 附带发现：**列 id 与状态名同形**（`LANE_ORDER` 里有 `'paused'`/`'failed'`），
   任何按状态名扫源码的断言都必须先剔除列 id 声明，否则误报。

5. **`git grep` 不搜未跟踪文件。**
   本次新增的守卫/组件文件全部**未跟踪**，用 `git grep` 校验 F3/F5 会得到**假绿**（空结果）。
   校验工作区必须用 ripgrep 系（本仓的 `Grep` 工具）。


---

## 八、验证与反例清单

探针 `_产物/board-lane-map.js` 已实测（**真实仓库上 0 error；注入缺陷各自命中正确规则**）：

| 场景 | 命令 | 预期 finding | 实测 |
|---|---|---|---|
| 默认（真实真源） | `node _产物/board-lane-map.js` | 仅 `K2-unwired`（F4 已知空转） | ✅ `0 error(s), 1 warning(s)` / exit 0（11 状态 / 6 列 / **9 执行体** / 23 计划任务 / **19 任务字段**） |
| 漏映射一个状态 | `--scenario=drop` | `L1-partition` 静默丢单 | ✅ 2 error / exit 1（`L1` `L3`） |
| 一个状态落两列 | `--scenario=dup` | `L1-partition` 卡片重复 | ✅ 1 error / exit 1（`L1`） |
| 列终态声明与实际不符 | （初版设计即命中） | `L3-terminal` | ✅ 已据此把 `closed` 改为 `mixed` |
| 泳道表塞入幽灵执行体 | `--scenario=orphan-source` | `S3-launcher` | ✅ 1 error / exit 1（`S3`） |
| 移除兜底泳道 | `--scenario=no-fallback` | `S1-fallback` **+** `S4-fallback` | ✅ 6 error / exit 1（`S1` `S4`） |
| 终态缺回写目标 | `--scenario=no-writeback` | `J4-writeback` 完备性 | ✅ 1 error / exit 1（`J4`） |
| 计划任务 id 形成连接前缀歧义 | `--scenario=collide` | `J2-ambiguous` **+** `J5-prefix` | ✅ 2 error / exit 1（`J2` `J5`） |
| 契约里塞一个**取不到值**的字段 | `--scenario=ghost-field` | `K1-ghost-field`（抽掉 payload 的 `source` 键，模拟初稿的 `swimlane`） | ✅ 2 error / exit 1（`K1`×2） |
| F4 接线补齐之后 | `--scenario=worktree-wired` | 无 | ✅ `0 error(s), 0 warning(s)` / exit 0（证明 `K2` **不是恒真断言**） |

⚠ **第四类空头支票（本次新增的判据）**：前三类反例测的都是「字段/连接**不存在**」，
而 `K1`/`K2` 测的是「**存在但没人写**」：

- `K1-ghost-field` —— 契约字段必须有四类可复核的出处（§4.6）。
  它在初稿上会一次抓出 `swimlane` 这种「凭空的字段」。
- `K2-unwired` —— 铁律依赖的写入路径必须有**真实调用点**（§4.5）。
  它在 F4 上抓出「`bindWorktree` 存在但零调用点 ⇒ 判据永远走豁免分支」。
  **一条永远为真的铁律比没有更坏**，因为它会让人以为这里有守卫。

**另外三条守卫级反例**（步 1 施工后须补测）：

| 反例 | 预期 finding |
|---|---|
| 上游新增第 12 个状态而不更新折叠表 | `L1-partition`（无列承接）**+** `L2-drift`（11 ≠ 12） |
| 终态被赋予出边 | `L4-terminal-out` |
| 新增一个从 `queued` 不可达的孤儿态 | `L5-reachable` |

> ⚠ **一条必须写进守卫的精度判据（本次实测踩到）**：泳道清单若用**源码文本抽取**得到，
> 必须用 **`require` 交叉验证条数** —— `agentLauncherRegistry.js` 的 `windsurf` 条目是**多行写法**
> （`command:` 独占一行），任何**按行**匹配的抽取（例如 `grep -c "Object\.freeze({ command:"`）
> 都会**静默漏掉它**，实测得到 8 而非 9。
> 本探针用的是**非行锚定**正则（`/command:\s*'([^']+)'/g`，`\s` 可跨行）故未失真，
> 但这条不能靠运气 ⇒ 步 1 的守卫**必须**带一条「文本抽取条数 == require 条数」的自校验，
> 否则漏抽的执行体永远不会进入反向检查（`S3` 只遍历已抽出的集合），形成**静默假绿**。

---

## 九、复现方式

> ⚠ **探针的落点说明**：`_产物/` 是 `.gitignore:214 /_产物/` 覆盖的**本机工作产物暂存区，不入仓**。
> 步 1 会把判定逻辑迁入 `scripts/lib/boardLaneGuard.js`（纯叶子）并纳入版本控制。
> 在那之前，**新克隆的检出里没有这个文件，这是预期行为，不是漏提交**。

```bash
# ① 泳道映射 + 泳道划分实证（默认应 0 error）
node _产物/board-lane-map.js

# ② 反例矩阵（列维度）
node _产物/board-lane-map.js --scenario=drop
node _产物/board-lane-map.js --scenario=dup

# ③ 反例矩阵（泳道维度）
node _产物/board-lane-map.js --scenario=orphan-source
node _产物/board-lane-map.js --scenario=no-fallback

# ④ 反例矩阵（连接键 / 回写维度）
node _产物/board-lane-map.js --scenario=no-writeback
node _产物/board-lane-map.js --scenario=collide

# ⑤ 反例矩阵（契约字段出处维度）
node _产物/board-lane-map.js --scenario=ghost-field       # 应 2 error：K1 抓出取不到值的字段
node _产物/board-lane-map.js --scenario=worktree-wired     # 应 0 error 0 warning：K2 消失

# ⑥ 机器可读
node _产物/board-lane-map.js --json

# ⑦ 现状证据复核（看板视图为零命中）
git grep -il "largeTask" -- 'apps/ai-frontend/src/**' 'software/khyquant/frontend/src/views/**'

# ⑧ 连接键缺口复核（应返回空 = 两边零连接代码）
git grep -nE "hq_task|hqTaskId|largeTask.*hq" -- 'services/**' 'scripts/**'

# ⑨ F4 缺口复核（应返回空 = 没有任何调用点传 taskId）
git grep -nE "createWorktree\(\{[^}]*taskId" -- 'services/**'

# ⑩ 真源常量复核（状态机）
node -e "console.log(require('./services/backend/src/tasks/largeTaskRuntimeStore').TASK_STATUSES)"

# ⑪ 真源常量复核（执行体注册表）——必须与探针的文本抽取条数一致，否则是静默假绿
node -e "console.log(require('./services/backend/src/services/agentLauncherRegistry').AGENT_LAUNCHERS.map(function(x){return x.command}))"

# ⑫ 真源字段数复核（必须与 §4.3 写的数字一致；注意 `id` 是简写，按行 grep 会数少 1）
node -e "const p=require('./_产物/board-lane-map');const s=require('fs').readFileSync('./services/backend/src/tasks/largeTaskRuntimeStore.js','utf8');console.log(p.extractTaskFields(s).length)"
```

---

## 十、未决问题（留给施工前裁决，本文不代为决定）

1. **泳道是否包含「人」**？§4.4 已把泳道定为 `kind ∈ {agent, system}` 两类。
   若要加「人工任务」，它是**第三类** `kind='human'`，其 `source` 取什么、F4 的 worktree 豁免路径怎么走，
   需先裁决。（**不建议**把它塞进 `kind='system'` —— 那会让「未归属」兜底泳道同时承载两种语义。）
2. **卡片依赖链**（Cline 的 task linking）要不要做？`largeTaskRuntimeStore` 目前**无**依赖字段，
   若要做需先扩真源状态机——属于本文边界之外。
3. **手机端是「只看」还是「可操作」**？若可操作，需先确认
   `POST /large-tasks/:taskId/pause` 与 `POST /large-tasks/:taskId/resume`
   （**真实路径**，见 `routes/largeTasks.js:795, 816`；本文前文用 `/pause` `/resume` 是简写）在弱网下的幂等性。
   ⚠ 它们走的是状态机（`pausing → paused`、`paused → running`），
   弱网重试会撞 `STATUS_TRANSITIONS` —— 需先确认重复投递是否被幂等键挡住。
4. **`web` 与 `web-quant` 是否共用组件包**？两者 `entry` 独立、技术栈同为 Vue，
   但 `web-quant` 有 Capacitor 约束；共用会引入跨端构建耦合，需权衡。
5. **`API-005` 的 `ssot` 是否就是本文**？若步 1 另立规范文档，需同步改 `ssot` 与标记行位置。
6. **F4 走哪条路**（§4.5 的三选一）？本方案建议第 1 条：**步 1 给 `createWorktree` 补 `taskId` 接线**，
   让 `payload_json.worktree` 真的被写进去。若不接线，则 F4 **必须**降级 advisory 并写明「当前不可判」。
   ⚠ 这一条直接决定步 1 的工作量 —— 它是本方案**唯一需要新增的执行侧接线**。

---

## 附：与 Cline Kanban 的取舍对照

| Cline 的做法 | 本方案 | 理由 |
|---|---|---|
| 每卡一个 worktree | ✅ 采纳，调既有 `worktreeManager.js`；**但需补 `taskId` 接线**（§4.5） | 机制已存在，**绑定路径却从未被调用过** |
| 列 = 状态 | ✅ 采纳，但 11 态折叠为 6 列 | 瞬态会造成跳列闪烁 |
| 泳道 | ✅ **扩展**：Cline 无泳道，本方案加执行体泳道 | 用户明确要求管三种执行体 |
| diff 内联评论回灌 | ⏸ 暂不做 | 需 agent 侧支持结构化反馈，属后续 |
| 依赖链自动接续 | ⏸ 暂不做 | 真源无依赖字段，扩状态机风险高 |
| `npx kanban` 本地服务 + 浏览器 | ❌ 不采纳 | khy-os 已有 4 个端条目，**不新增端**，复用既有载体 |
| Auto-commit / Auto-PR | ⏸ 暂不做 | 与 `SECURITY-001` 的改动面约束需先对齐 |
