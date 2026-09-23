# [DESIGN-ARCH-130] 前台与后台任务编排方案

<!-- RULES-REGISTRY: PROCESS-012 -->

> **定位**：本文件回答三个问题——**哪些工作必须在 khy 的前台执行、哪些可以丢给后台、
> 什么时候丢、什么时候取回结果**。它是「编排落位」的语义真源。
>
> **边界**（与相邻规范谁管什么，见 §4 完整表）：
> - `[DESIGN-PROCESS-001]`（`PROCESS-004`）管 **CH-6 外部智能体**的准入（G1/G2/G3）；
>   本文件管 **前台 vs 后台** 的落位，是**正交的另一轴**：一件活可以「khy 自做 + 后台跑」，
>   也可以「委派外部 agent + 前台等」。两条轴可组合。
> - `[DESIGN-AGENT-001]`（`AGENT-001`）管交接的**载荷**（带什么过去、带什么回来）；
>   本文件管这次交接**跑在哪条道**（前台阻塞 / 后台并发）。
> - `RUNTIME-003`（活动式超时）管**超时怎么算**；本文件复用它的判据，不另立超时口径。
>
> **上游依据**：`[DESIGN-ARCH-121]`（CC Harness 借鉴）、`[DESIGN-ARCH-127]`（可维护性减负，
> 本方案是其「并发编排」子项）、`code 现状`（下方全部行号均实测）。
>
> ⚠️ **状态：提案（S1 观察期）**。本文件落 S1；`PROCESS-012` 的执行器 `gate:commit` +
> `severity:advisory`（**不是** `gate:"advisory"` —— 那会让规则永不执行，见 §7.3）。

---

## 1. 现状证据（全部实测，非引用文档）

### 1.1 khy 今天**已经有**两套后台执行面

| 面 | 启动入口 | 结果落点 | 取回入口 |
|---|---|---|---|
| **后台 shell** | `shellCommand` 的 `run_in_background:true`（`tools/shellCommandEngine.js:355`） | `backgroundShellRegistry.backgroundShells`（`tools/backgroundShellRegistry.js:29`） | ✅ `BashOutputTool`（按需读）+ 自动 `<task_notification>` |
| **后台 agent** | `AgentTool` 的 `run_in_background:true`（`tools/AgentTool/index.js:699`） | `_backgroundAgents` Map（`AgentTool/index.js:122`） | ⚠️ **仅自动通知，无按需读取入口**（§1.3） |
| **后台 durable 任务** | `khy tasks run` → `backgroundTaskLauncher` → 分离进程 `task-runner.js` | durable store `largeTaskRuntimeStore` | ✅ `TaskOutputTool`（按需读 + block 等待） |

### 1.2 取回机制的真源（这是本方案的基石）

**自动取回 —— 一次性 drain，在下一轮注入：**

| 环节 | 真源 | 事实 |
|---|---|---|
| drain 函数 | `services/domain/query/query/taskNotification.js:63` | `drainCompletedBackgroundAgents(registry)` |
| 一次性语义 | 同文件 `entry.notified = true` | 终态且未通知才返回；**标记后不再重发** |
| 注入时机 | `services/tool/toolUseLoopCore.js:2442-2452` | 每轮 LLM 调用前 drain 并**前置**拼进 `currentMessage` |
| 注入形态 | `taskNotification.js` 文件头注释 | 新 task id 的独立文本块（不复用 `tool_use_id`） |

**按需取回 —— 两个工具，一个真缺口：**

| 工具 | 真源 | 能力 |
|---|---|---|
| `TaskOutputTool` | `tools/TaskOutputTool/index.js:55-72` | `block=true` 时**活动式**等待：仅在 `running` 时轮询，输出变化即重置计时器（**正确实现了 `RUNTIME-003`**） |
| `BashOutputTool` | `tools/BashOutputTool/index.js` | 按需读后台 shell；诚实声明「**不增量流式**，只在终态一次性填充」 |
| 后台 agent 读取 | ❌ **不存在** | 见 §1.3 |

### 1.3 实测发现：一个真实的「空头支票」

`AgentTool/index.js:456` 的工具描述明确告诉模型：

```text
'Run agent in background. Returns immediately with agent ID; result available via getBackgroundAgent().'
```

而实测（探针 `bg-lane-probe.js` 断言 2b，全仓扫描 `services/` + `tools/`，排除测试）：

| 环节 | 事实 |
|---|---|
| 函数定义 | ✅ `AgentTool/index.js:124` `function getBackgroundAgent(id)` |
| 模块导出 | ✅ `AgentTool/index.js:2173` `module.exports.getBackgroundAgent = ...` |
| **被注册为工具** | ❌ 无 —— `AgentTool` 只有一个 `static toolName = 'Agent'`（`:227`） |
| **生产调用点** | ❌ **0 处** —— 全部调用方（`toolUseLoopCore.js:4770`、`teammateBus.js:91`、`orchestrationService.js:102` 等）都只用 `agentTool.execute(...)` |
| 旁证 | `TaskOutputTool` 走 `_taskStore`，而 `_taskStore._assertToolTask` 要求 `payload_json.source === 'tool_task_store'`（`_taskStore.js:72`）⇒ **读不到** `_backgroundAgents` 里的 `bg-*` 条目 |

**结论**：模型被指示去调一个**没有工具可调**的函数。后台 agent 的产出只有「一次性通知」这一条路，
一旦错过那一轮注入（上下文压缩、长对话、用户中途插话），结果**不可找回**——这正是本方案 §5 F3 要堵的洞。
（形成机制属 §5.8「字段存在但没人写」的同构变体：**描述存在、函数存在、注册缺失**。）

### 1.4 落位判定的现状：**没有规则，全凭临场感觉**

| 判定面 | 真源 | 现状 |
|---|---|---|
| 前台还是后台 | — | ❌ **无任何规则**。`run_in_background` 是否传，由模型临场决定 |
| 工具能否并发 | `isConcurrencySafe()`（181 个文件有声明） | ✅ 有声明，但**只服务同轮并行**，不回答「要不要跨轮后台」 |
| 同一时刻能跑几个 | `concurrencyLimiter.js` / `concurrencySlots.js` | ✅ 有池子，但**无「后台任务总数上限」** |
| 超时怎么算 | `RUNTIME-003` + `check-agent-rules.js` 的 `no-hard-timeout-kill` | ✅ 有规则，但**扫描面有结构性边界**（§1.5） |

### 1.5 实测发现：现有超时守卫的**结构性盲区**

`check-agent-rules.js:596` 的触发正则是：

```js
const timeoutRegex = /setTimeout\s*\([\s\S]{0,220}?,\s*(\d{3,})\s*\)/g;
```

⇒ **只有出现在 `setTimeout(..., ms)` 调用里的 ms 字面量才会被扫描。** 由此两个盲区（探针场景 C 实测）：

| 形态 | 现有守卫判决 | 问题 |
|---|---|---|
| 裸轮询 `while (Date.now() - t0 < 600000) {...}` | **out-of-scope** | 不含 `setTimeout` ⇒ **根本不在扫描面内** |
| `setTimeout` 轮询 | **skip** | 源码注释明写「a timer with no termination effect ... is a scheduler (… **poll**) and has nothing to renew against」⇒ 轮询被**显式豁免** |

⇒ 「用 `while` 死等后台结果」和「轮询等后台结果」**都能穿过现有守卫**。
这不是守卫的 bug（它的靶子是「固定时长后 kill」），而是**本方案必须补的另一条规则**（§5 F4）。

---

## 2. 设计公理（不可让渡）

| # | 公理 | 理由 |
|---|---|---|
| **A1** | **默认前台。** 后台是例外，需要主动举证 | 与 `[DESIGN-PROCESS-001]` §2「默认档是自做，不是委派」**同构**。前台失败立刻可见；后台失败静默 |
| **A2** | **异步化的唯一合法理由是「独立」**，不是「慢」 | 慢但串行在关键路径上的活，丢后台只是把「串行」换成「串行 + 调度开销 + 一次取回」 |
| **A3** | **无取回入口者，禁止长跑后台** | 结果是黑洞。要么先补入口，要么留前台。这是 §1.3 缺口的规则化 |
| **A4** | **取回是「事件驱动的一次性通知」+「按需查询」两条腿**，缺一不可 | 只有通知 ⇒ 错过就丢（§1.3）；只有查询 ⇒ 模型不知道何时该查（会退化成轮询，违 A5） |
| **A5** | **禁止轮询等待。** 等待只能由「事件」或「活动式超时」驱动 | `RUNTIME-003` 的约束；且 §1.5 证明轮询能穿过现有守卫，必须显式禁 |
| **A6** | **后台任务也必须可停止、可观测、有上限** | 否则「丢后台」= 泄漏。复用既有 `TaskStopTool` / `progress_pct` / `concurrencySlots`，不另造 |

---

## 3. 落位判定：六问（自上而下，首个命中即停）

> 与 `[DESIGN-PROCESS-001]` §2 的「第 0 问」同构：**它在前台/后台轴上的对应物**。
> 前置：若该活已判定要委派外部 agent（`PROCESS-004` G1/G2/G3），本判定仍然适用——
> 决定的是「这次委派在前台等还是后台跑」。

| 序 | 问 | 命中 → 落位 | 判据 id |
|---|---|---|---|
| **Q0** | 这件活**会写工作区**（或产生需要立刻裁决的副作用）？ | → **严禁后台**（前台独占） | `B0-write-forbidden` |
| **Q1** | 需要**用户即时回答**（`AskUserQuestion` 类）？ | → **必须前台** | `F1-needs-user` |
| **Q2** | 它是**下一步的前置**（`blocksNextStep`，串行依赖）？ | → **必须前台** | `F2-on-critical-path` |
| **Q3** | 是否**长任务** 且 **无按需取回入口**？ | → **严禁后台**（先补入口，见 F3） | `B3-no-retrieval` |
| **Q4** | 与当前主线**真正独立**（无数据依赖）且**有取回入口**？ | → **可后台** | `G4-independent` |
| **Q5** | 其余一切 | → **默认前台** | `F5-default` |

**「真正独立」的可核验定义**（不接受模型自称）：满足全部三条才叫独立——
① 不消费主线尚未产生的数据；② 不产出主线下一步要用的数据；③ 不与主线写同一批文件。
任何一条说不清 ⇒ **不独立** ⇒ 前台。

> ⚠️ **Q0 为什么是第 0 问**：写工作区的活丢后台，等于把改动移出主线视野，并发写冲突无人仲裁。
> 这与 `AGENT-001` 的 AG-3（派发必须显式声明所有权）配套：**后台只做只读或不冲突的活**。
> 若确实要后台写，必须走 §6 的 worktree 隔离（`bindWorktree`），不能裸写。

---

## 4. 与既有机制的边界表

| 既有件 | 它管什么 | 本方案做什么 | **边界** |
|---|---|---|---|
| `[DESIGN-PROCESS-001]` / `PROCESS-004` | **CH-6 外部智能体**准入（G1 点名 / G2 能力缺失 / G3 隔离） | 前台 vs 后台**落位** | **正交轴**。本文件**不改** G1/G2/G3，也不新增委派闸门。组合示例：G2 成立 + Q4 成立 ⇒ 「委派给外部 agent **并丢后台**」 |
| `[DESIGN-AGENT-001]` / `AGENT-001` | 交接**载荷**（`prompt` / 所有权 / 回报信封） | 交接**跑哪条道** | 本文件引用 AG-8（子产出对用户不可见 ⇒ 主必须转述），**不重复定义**信封字段 |
| `RUNTIME-003` | **超时怎么算**（活动式；禁固定时长无条件 kill） | 等待**怎么发生**（禁轮询，只允许事件/活动式超时） | 本文件**复用** RUNTIME-003 的判据与豁免，**不另立**超时口径。§5 F4 是它在「后台等待」语境下的补盲 |
| `isConcurrencySafe()` | **同轮**工具能否并行 | **跨轮**是否转后台 | 两者不重叠：声明 `isConcurrencySafe` 不等于可后台；反之亦然。Q0/Q1/Q2 命中时**即便** `isConcurrencySafe` 为真也**不得**后台 |
| `concurrencyLimiter` / `concurrencySlots` | 并发**池容量** | 后台**在跑的活**必须有上限 | 本文件**复用**池子作为 A6 的落点，不新建调度器 |
| `TaskOutputTool` / `BashOutputTool` | 按需读取**已有**入口 | 补**缺失**入口（后台 agent，§5 F3） | 补的是**同构**入口（同 `block`/`timeout` 语义），不是新范式 |

---

## 5. 铁律（写死，不可绕过；每条都有可自动判的判据）

### F1 —— 默认前台，后台须举证

**约束**：`run_in_background:true` 必须能映射到 §3 的 `G4-independent`。

**判据**：派发点的 `run_in_background` 传参在**同轮工具调用**里必须伴随独立性证据
（在 `prompt`/参数里声明：不消费主线数据、不产出主线数据、不写同批文件）。
**不可自动判时，降级为 advisory，不阻断**（避免逼 AI 谎报）。

### F2 —— 写工作区者不得后台

**约束**：后台任务不得写工作区（除非经 §6 worktree 隔离）。

**判据**：`payload_json.kind === 'agent'` 的任务，其 `cwd` 必须为 worktree 路径，或
`payload_json.writes_workspace === false`（新增字段）时必须与 `prompt` 中的写意图一致。
反例场景：`--scenario=bg-write`。

### F3 —— 无取回入口者不得长跑后台 ⭐（本方案的核心修补）

**约束**：任何可后台的产物类型，**必须同时具备**：
① 一次性完成通知（已具备，`drainCompletedBackgroundAgents`）；
② **按需查询入口**（工具形态，可被模型调用）。

**判据**：对每个「后台产物类型」登记条目，检查是否存在**被注册为工具**的查询入口，
且该入口函数的**生产调用点 > 0**（防空转，§5.8 纪律）。

**当前实测违反**：后台 agent（§1.3）。修法二选一，**不得**伪造：

| 处置 | 动作 | 代价 | 裁决 |
|---|---|---|---|
| **方案甲（**采纳**）** | 新增 `BackgroundAgentOutputTool`（同构 `BashOutputTool`），读 `_backgroundAgents`，`block`/`timeout` 语义对齐 `TaskOutputTool` | 一个工具 + 单测（**注册表零改动**，目录自动扫描） | ✅ **已落地**，见 §10.2 |
| **方案乙** | 把 `AgentTool` 后台条目**写进 `_taskStore`**（`source:'tool_task_store'`），复用现成 `TaskOutputTool` | 改派发路径 + 状态机映射，动存量 | ❌ 否决（造第二套真源） |

⇒ 甲是**补空白**（既有范式照搬），乙是**改真源**（碰状态机）。按 `[MGMT-STD-008]`「补空白 > 另起炉灶」，**采纳甲**。
**落地证据**：`services/backend/src/tools/BackgroundAgentOutputTool/index.js`，
测试 `services/backend/tests/tools/BackgroundAgentOutputTool.test.js`（9/9 绿），详见 §10.2。

### F4 —— 禁止轮询等待，且补现有守卫的盲区 ⭐

**约束**：等待后台结果**只能**由「一次性通知事件」或「活动式超时（`RUNTIME-003`）」驱动。
禁止 `while` / 固定间隔轮询等结果。

**判据（重要：与现有守卫的分工）**：
- 现有 `no-hard-timeout-kill` 只扫 `setTimeout(..., ms)` **面内**（§1.5 实测）；
- 本规则补**面外**两类：① 裸 `while/for` + 时间条件的等待循环；② `setTimeout` 递归轮询且**无活动重置**。

反例场景（必须双向）：
| 场景 | 预期 |
|---|---|
| `--scenario=poll-bare-loop`（裸 `while` 死等） | **error** |
| `--scenario=poll-setTimeout`（无活动重置的 `setTimeout` 轮询） | **error** |
| `--scenario=await-notification`（依赖 drain 通知） | 放行 |
| `--scenario=idle-timeout`（活动式超时，`RUNTIME-003` 合规） | 放行 |

> ⚠️ **必须补「应放行」场景**：只测「会拦」不测「会放行」，等于给了一个恒真断言（本仓技能 §5.7）。

### F5 —— 后台任务必须有上限、可停止、可观测

**约束**：同一时刻在跑的后台任务数 ≤ 池容量；每个后台任务必须有 `TaskStopTool` 可达的 id；
进度必须写 `progress_pct`。

**判据**：启动点必须 ① 走 `concurrencySlots` 取槽；② 返回可被 `TaskStopTool` 消费的 id；
③ 至少一次 `progress_pct` 更新（长任务）。反例：`--scenario=unbounded-bg`。

### F6 —— 取回必须「显式回报」，不得依赖静默

**约束**：后台产出即使未在通知窗口内被消费，也**必须**能通过 F3 的入口取回；
且取回后主智能体**必须**转述给用户（`AGENT-001` AG-8）。

**判据**：F3 入口的 `notified` 标记**不得**阻止按需读取（现有 `BashOutputTool` 已正确做到
「只标记不删除」——`backgroundShellRegistry` 的 drain 注释明写"never deletes"）。这是**正面先例**，照抄。

---

## 6. 什么时候丢 / 什么时候取回（时间轴）

```text
轮次 N（前台主线）
  ├─ 决定落位（§3 六问）
  ├─ 命中 G4 ⇒ 丢后台
  │    ├─ 必须：登记可停止 id + 声明 ownership（不写工作区）
  │    ├─ 必须：确认该产物类型有 F3 的按需入口
  │    └─ 立即返回占位结果（tool_result 已消耗，通知走独立文本块）
  ├─ 命中 F1/F2/Q0/Q3 ⇒ 留前台，阻塞执行
  └─ 主线继续做 Q2 判定为「前置」的活

轮次 N+1…M（注入点 = 每次 LLM 调用前）
  ├─ drainCompletedBackgroundAgents()  → 一次性 <task_notification>
  ├─ 若已终态且未被通知 ⇒ 注入并标记 notified
  └─ 若用户/主线主动需要 ⇒ 调 F3 按需入口（不受 notified 影响）

任一轮（停止/超时）
  ├─ 用户要停 ⇒ TaskStopTool → 杀 runner_pid（优先）→ 回退 child_pid
  └─ 等待超时 ⇒ 只能活动式（RUNTIME-003）；超时必须诚实报「完成了什么/还剩什么」
```

**取回时机的三条硬判据**：
1. **不等预告**：不要为「等后台跑完」插入任何阻塞等待 —— 让它跑，主线继续，通知会自己来（A5）。
2. **通知只来一次**：错过注入窗口就靠 F3 按需查（A4、F6）。
3. **取回即转述**：子产出对用户不可见（`AGENT-001` AG-8），主必须转述。

---

## 7. 接线清单（B-L2 三步，一次提交只做一步）

### 步 1：标记（本文件 + 规则登记，零执行器改动）

1. **文档落盘**：本文件 → `docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-130] 前台与后台任务编排方案.md`
2. **就近索引回写**：`docs/03_DESIGN_设计/DESIGN-ARCH/00_INDEX_DESIGN-ARCH-总目录.md`
   - 追加一行；**「收录 121 篇」→ 123 篇**（⚠️ 该行含全角标点，**必须用脚本改，不能用 Edit**）
   - ⚠️ 二级目录索引**不在** `docs-index-complete` 扫描面内（`check-repo-layout.js:327` 的
     `STAGE_DIR_RE = /^0[1-9]_/` 只扫直接子文件）⇒ 回写是 CP-3 要求，不写**不会**变红
   - 主索引 `docs/00_INDEX_文档索引.md` **不必**回写（同上：二级目录不经它逐条点名）
3. **生成 `.html` 孪生件**：`node scripts/docs/build_docs_site.js`（**不要**用 `npm run docs:build`）
   - ⚠️ 它会重写全站陈旧孪生件（实测历史 232 个），属**预期且有益**（修断链）

### 步 2：规则执行器 + 登记（四件必须同批）

引用 §5 的 F1–F6 判据。**若本步只做观察，不带执行器**，则登记表 `gate:"commit"` + `severity:"advisory"`
且 **`exec.script` 指向步 2b 才创建的脚本** ⇒ 违反 `check-wiring`（执行器不存在）。
⇒ **步 2 必须把「登记」与「迁移脚本 + 加 `package.json` 别名」成对做完。**

1. 新增 `scripts/lib/bgLaneGuard.js`（**纯叶子**：零 IO、确定性、绝不抛、可单测）
   - 判定逻辑（§3 六问 + §5 F1–F6 判据）单点收在此处
   - `scripts/ci/` 只负责走盘/读表/打印
2. 新增 `scripts/ci/check-bg-lane.js`（走盘 + `--changed` + `--scenario=`）
3. `package.json` 加别名（**否则 `check-wiring` 判 error「零接线」**）
4. `docs/10_规范/registry/RULES-REGISTRY.json` 补规则条目
   - `domain` **必须是十域封闭枚举**之一（`check-gov-rules.js:40`）：本方案用 **`PROCESS`**
   - `formerly: "无"`（**不能写 `null`**，会拒生成规则卡）
   - `gate:"commit"` + `severity:"advisory"`（**S1 观察期的正确表达**，见 7.3）
   - 同步 `meta.ruleCount`
5. 本文件第 3 行的 `<!-- RULES-REGISTRY: PROCESS-012 -->` 标记行（已就位）
   ⇒ 满足 `TOOLING-007` 双向可达（登记表 ↔ 真源文档各自声明）
6. `npm run docs:rules-cards` 生成规则卡（**禁止手改** `docs/10_规范/规则卡/`）
7. **棘轮基线**：取值看 `node scripts/ruleguard/index.js run --mode pr --json` 的 `ratchet` 字段，
   **不要**数人类可读摘要（P2 规则按 error+warn 全量计数）

### 步 3：收口（升 S2/S3，需前置条件成立）

升 error 的**前置条件**（缺一不可，否则逼 AI 谎报）：
1. F3 的入口已落地（甲或乙），后台 agent 有按需读取路径
2. F4 的双向场景全绿（含「应放行」）
3. **改守卫而不是改仓库**的原则已执行：任何误报先核验真伪，收窄判据并补对照场景

### 7.3 ⚠️ S1 观察期的正确表达（本仓已实测的坑）

| 写法 | 后果 |
|---|---|
| ❌ `gate: "advisory"` | **规则永不执行**（`GATE_ORDER.advisory = 4 > max = 2`），且 `check:wiring`/`check:gov-rules` **全绿** —— 空接线最难发现 |
| ✅ `gate: "commit"` + `severity: "advisory"` | 执行器**真被调用**（须支持 `--changed`），finding **只记录不阻断** |

必做实证（否则就是空接线）：
```bash
npm run rules:gate:commit 2>&1 | grep "check-bg-lane"
# 必须看到 action=start ... mode=commit rules=<你的 finding ids>
```

---

## 8. 验证与反例清单

| # | 反例场景 | 预期 finding | 强度 |
|---|---|---|---|
| 1 | `--scenario=bg-write`（后台写工作区） | `F2-bg-write` | error |
| 2 | `--scenario=poll-bare-loop`（裸 `while` 等） | `F4-poll` | error |
| 3 | `--scenario=poll-setTimeout`（无重置轮询） | `F4-poll` | error |
| 4 | `--scenario=no-retrieval`（无入口却长跑） | `F3-no-retrieval` | error |
| 5 | `--scenario=unbounded-bg`（无上限后台） | `F5-unbounded` | warning |
| 6 | **`--scenario=await-notification`（依赖通知）** | **放行** | — |
| 7 | **`--scenario=idle-timeout`（活动式超时）** | **放行** | — |
| 8 | **`--scenario=true-independent`（真独立 + 有入口）** | **放行** | — |

⚠️ 6/7/8 是**必须的「应放行」对照**：只测 1–5 会让断言恒真（本仓技能 §5.7）。

---

## 9. 复现方式（可直接粘贴）

```bash
# 探针（原型在 _产物/，属 gitignore 暂存区 —— 步 1 才迁入 scripts/lib/）
node _产物/bg-orchestration/bg-lane-probe.js
# 期望：场景 A/B/C 全 ok；场景 B 中 2 条 FAIL 即 §1.3 的缺口（真实存在，非误报）

# 单场景
node _产物/bg-orchestration/bg-lane-probe.js --scenario=lane
node _产物/bg-orchestration/bg-lane-probe.js --scenario=claims
node _产物/bg-orchestration/bg-lane-probe.js --scenario=gap

# 独立复核缺口（不依赖探针自证）
grep -rn "getBackgroundAgent" services/backend/src/ --include="*.js"
#   ⇒ 仅 AgentTool 定义 + 导出，无工具注册、无外部调用点
```

---

## 10. 未决问题 → **裁决记录（2026-09-22 已决）**

### Q-1 【已决】F3 缺口补法：**采用方案甲**（新增 `BackgroundAgentOutputTool`）

**裁决依据（全部实测，不是偏好）**：

| 事实 | 实测来源 | 对裁决的作用 |
|---|---|---|
| 后台条目字段与 shell 条目**同构** | `AgentTool/index.js:729-750`：`{promise, status, startedAt, subagentType, role}` → 终态写 `result` / `error` | 甲的模板（`BashOutputTool`）**逐字可用**，无需适配 |
| **`getBackgroundAgent(id)` 已是模块导出** | `AgentTool/index.js:2173` `module.exports.getBackgroundAgent = getBackgroundAgent` | ⇒ **甲对 `AgentTool` 零改动**，新工具只需 `require` 并调用既有导出 |
| shell 侧已有同构先例且「只标记不删除」 | `backgroundShellRegistry` drain 注释 「never deletes」 | ⇒ 甲的按需读取**不会被 `notified` 标记干扰**（F6 正面先例） |
| 乙要走 `_taskStore`，而它**只认** `source==='tool_task_store'` | `_taskStore.js:72` `_assertToolTask` | ⇒ 乙必须**改派发路径 + 状态机映射**（`bg-*` → durable id），动存量 |
| 本仓元规则 | `[MGMT-STD-008]` §2.2「重叠即违规」+ 「补空白 > 另起炉灶」 | ⇒ 甲是补空白，乙是造第二套真源 |

**结论**：甲。**理由是「零改真源」不是「更简单」** —— 乙会把同一件事的真相拆到两处
（`_backgroundAgents` 与 durable store），违反「一处真源」。

**甲的接线四件套**（一次提交做完，否则 `check-wiring` 红）：

| # | 项 | 状态 | 实证 |
|---|---|---|---|
| 1 | `services/backend/src/tools/BackgroundAgentOutputTool/index.js`（新工具） | ✅ **已落地** | §10.2 |
| 2 | 工具注册表登记 | ✅ **无需改动** | 注册表按**目录扫描**自动发现（`tools/index.js:140-170`，Case 4「BaseTool 子类 → 实例化」）；实测新工具与 `BashOutput` 同批入池（共 72 个） |
| 3 | 门控 `KHY_BG_AGENT_OUTPUT_TOOL`（默认 ON，关闭即字节回退） | ✅ **已落地** | 测试用例「门控默认开 …{0,false,off,no} 关」 |
| 4 | 单测 + `--scenario=no-retrieval` 反例转为「应放行」 | ✅ **已落地** | `tests/tools/BackgroundAgentOutputTool.test.js` 9/9 绿 |

> ⚠️ 第 2 项**推翻**了 §10 Q-1 表里的预估：本仓工具注册是**目录自动扫描**，
> 不存在需要手改的「注册表文件」。**这是「先读真源再估工作量」的又一次胜利** ——
> 若按预估去改某个不存在的注册表，会白改或改错地方。

### 10.2 方案甲落地实证（2026-09-22）

| 验证项 | 命令 | 结果 |
|---|---|---|
| 语法 | `node --check …/BackgroundAgentOutputTool/index.js` | ✅ |
| 被注册表发现 | 复现 `tools/index.js` 扫描逻辑 | ✅ 与 `BashOutput` 同批，72 个工具，0 error |
| 契约测试 | `node --test tests/tools/BackgroundAgentOutputTool.test.js` | ✅ **9/9 pass** |
| 同构回归 | `node --test tests/tools/BashOutputTool.test.js` | ✅ 10/10 pass（无回归） |
| 契约扫描 | `node --test tests/tools/toolContract.sweep.test.js` | ✅ 6/6 pass |
| 注册表去重 | `node --test tests/toolRegistryDedup.test.js tests/services/toolCatalog.test.js` | ✅ 20/20 pass |
| **超时守卫** | `node scripts/ci/check-agent-rules.js …/BackgroundAgentOutputTool/index.js` | ✅ **no violations**（活动式等待不触发 `no-hard-timeout-kill`） |
| 改动后 `AgentTool` | `node scripts/ci/check-agent-rules.js …/AgentTool/index.js` | ✅ no violations |
| 结构守卫 | `node scripts/ci/check-repo-layout.js` | ✅ 计数**与改动前逐项相同** |

**测试覆盖的关键断言（双向，非空转）**：
- **应拦**：缺 `agent_id` → error；未知 id → `not found`（**黑洞必须可见**，不得静默成功）；gate off → `disabled`
- **应放行**：完成态 → 返回 `result` + `subagent_type`；失败态 → 暴露 `error`
- **活动式等待**：`block=true` 时在终态到达后**立即**返回（实测 202ms，远早于 5000ms timeout）
  ⇒ 证明不是死等（若照抄 `BashOutputTool` 的 `deadline` 循环，此断言会失败）
- **不消耗**：读后条目仍在注册表，且**不得**替 drain 标 `notified`（F6 的正面先例）

> ⚠️ **并发写冲突留痕（2026-09-22 实测）**：本仓有**并行智能体实时改写同一文件**。
> 本次 `AgentTool/index.js` 在我编辑期间被另一路改动（`normalizeAgentRole` 的 require 目标
> 由 `roleToolScope` 换为 `claudeCompat`；新增 `_EXPLORE_PROFILE_ROLES` 常量，约 22 行）。
> **判归属的正确手法**（勿用 `git stash`——本仓已因此丢过数据）：
> `git show :<path>`（索引版）与工作区逐段比对。实测索引版**已含**对方的改动但**不含**我的导出，
> 而工作区两者都有 ⇒ 我的改动是在对方工作之上的**叠加**，未覆盖他人。
> 复检：改动后 `backgroundAgentOutput` 9/9、`check-agent-rules` 无违规、结构守卫计数逐项不变。
> **教训**：编辑热点文件（`AgentTool`、`toolUseLoopCore` 等）后**必须用 `git diff` 逐 hunk 认领**，
> 不能凭「我只改了一行」就假设 diff 里全是自己的。


### Q-2 【已决】后台任务**不追求跨会话持久**（维持进程内），但登记为显式边界

**裁决依据**：

| 事实 | 实测来源 | 含义 |
|---|---|---|
| durable 路径靠**分离进程**存活 | `backgroundTaskLauncher.js:6-8`「spawn the detached scripts/task-runner.js process (**which survives REPL/CLI exit**)」 | 跨会话的**真成本在进程模型**，不在存储 |
| 后台 agent 持有**进程内 promise** | `AgentTool/index.js:701,730` `promise: bgPromise` | REPL 退出 ⇒ promise 随进程消失，**存盘也救不回** |
| durable store 已是磁盘 JSON | `largeTaskRuntimeStore.js:483` `getDataDir('tasks')/large_task_runtime.json` | 存储层本就能跨会话；缺的是「重放未完成工作」的机制 |

⇒ **跨会话持久 ≠ 多写一个文件**，而是要把后台 agent 从「进程内 promise」改成
「分离进程 + 可重放」，即**重走一遍 `task-runner` 那条路**。这是**独立的大工程**，
不该塞进本方案。

**处置**：① 本方案**显式声明**该边界（不改现状）；② 在 §5 F5 的判据里**要求**
后台任务在 REPL 退出时**留下可读的终态记录**，避免「静默消失」；
③ 真正的跨会话需求**另立提案**（候选落点 `DESIGN-ARCH-131`），
前置依赖是把 `AgentTool` 的后台执行也走 `backgroundTaskLauncher` 的分离进程范式。

> ⚠️ **不得**用「写进 durable store」当作 Q-2 的实现 —— 那只搬了**记录**，没搬**执行**，
> 会产生「任务显示 running 但进程早没了」的僵尸态（比现状更糟）。

### Q-3 【已决】`writes_workspace` **新增字段**，但 F2 仍先走 advisory

沿用 §5.8 的四问纪律：字段新增的同时**必须确认写入方存在**，否则就是「字段存在但没人写」。
落地顺序：先加字段 + 在 `backgroundTaskSpec.buildTaskSpec` 的 `payload_json` 里写入 →
再让 F2 读它。**两步之间的窗口期 F2 保持 advisory**。

### Q-4 【已决】后台任务上限：**复用 `concurrencySlots`，不另立上限**

理由：另立上限会造出第二套容量真源（违 `[MGMT-STD-008]` §2.2）。
落地前需先量现有池子在真实负载下的表现（属步 3 的前置数据）。

### Q-5 【已决】域码用 **`PROCESS-012`**（非 `RUNTIME-011`）

理由：本方案的主观面是「**编排决策**」（什么时候丢、什么时候取），
与 `PROCESS-004`（委派边界）、`PROCESS-008/009`（落地阶段、提交时机）同族；
`RUNTIME` 域现有 10 条全是「运行时行为约束」（零硬编码、活动式超时、终端无滚动区），
本方案不是那一类。**域码与文档前缀（`DESIGN-ARCH-130`）可以不同**，有既有先例
（规则 `DOCS-001` 的 ssot 是 `[MGMT-STD-007]`）。

### 10.1 方案甲的接口契约（已按 §5.5 逐字段核对真源）

| 契约字段 | 真源实况 | 处置 |
|---|---|---|
| 输入 `agent_id` | `getBackgroundAgent(id)` 的 id 即派发返回的 `agentId`（`bg-<ts>-<rand>`，`AgentTool/index.js:700`） | ✅ 存在，直接用 |
| 输入 `block` / `timeout` | 与 `BashOutputTool` / `TaskOutputTool` **同参数名同语义** | ✅ 照搬，不发明 |
| 输出 `status` | `entry.status` ∈ `running`/`completed`/`failed` | ✅ 存在 |
| 输出 `result` | 终态写 `entry.result`（`:741`） | ✅ 存在 |
| 输出 `error` | 失败写 `entry.error`（`:749`） | ✅ 存在 |
| 输出 `subagentType` | `entry.subagentType`（`:733`） | ✅ 存在（shell 侧无此字段，属增量） |
| 阻塞等待的实现 | ⚠️ `RUNTIME-003`：**不得**固定时长 kill。`BashOutputTool` 用的是 `deadline` 轮询（无活动重置，因其无增量输出） | ⚠️ **不得照抄这段**。agent 侧有 `status` 变化，应实现为**活动式**等待（同 `TaskOutputTool` 的 `lastOutput` 重置范式） |

> ⚠️ **最后一行是本契约唯一不能照搬的地方**：照抄 `BashOutputTool` 的 `deadline` 轮询
> 会引进一个**不过 `RUNTIME-003`** 的等待（虽然它是工具内部等待、不 kill 进程，属规则豁免区，
> 但既然 agent 侧有活动信号，就没有理由退化成死等）。

---

## 11. 变更记录

| 版本 | 日期 | 内容 |
|---|---|---|
| 0.1.0 | 2026-09-22 | 初稿。基于实测真源（§1 全部行号）+ 探针 `bg-lane-probe.js` 反例矩阵；发现两处真实缺口（§1.3 空头支票、§1.5 守卫盲区），均**独立复核**过，非探针自证 |
| 0.2.0 | 2026-09-22 | §10 未决问题**全部裁决**：Q-1 采用方案甲（依据：`getBackgroundAgent` 已导出 ⇒ 零改真源）；Q-2 不追求跨会话持久（真成本在进程模型非存储，另立提案）；Q-3–Q-5 见 §10。新增 §10.1 方案甲接口契约（逐字段核对真源，标出**唯一不可照搬处**：阻塞等待须活动式而非 `deadline` 轮询） |
| 0.3.0 | 2026-09-22 | **方案甲落地实现**：新增 `tools/BackgroundAgentOutputTool/index.js` + `tests/tools/BackgroundAgentOutputTool.test.js`（9/9 绿）；`AgentTool` 加一个测试缝（`module.exports._backgroundAgents`，与既有 `_maxSubagentFanout` 同范式）。新增 §10.2 落地实证表。**F3 缺口已闭**：探针 `bg-lane-probe.js` 从 2 error → **0 error**。两处对预估的修正：① 工具注册是**目录自动扫描**，不存在需手改的注册表文件（推翻 §10 Q-1 预估）；② 阻塞等待**未照抄** `BashOutputTool` 的 `deadline` 循环，改用活动式等待（测试断言「不烧满 timeout」实测 202ms 通过） |
