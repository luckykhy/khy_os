<!-- 文档分类: DESIGN-ARCH-021 | 阶段: 设计 | 原路径: docs/03_DESIGN_设计/[DESIGN-ARCH-021] 巨型环反转设计.md（新建） -->
# khyos 巨型环反转设计（Giant-SCC Inversion Design）

> 版本 v1.0（2026-06-12）。承接 [DESIGN-ARCH-020] 架构债治理报告路线图第 3 步（P2「R1 反转」）。
> 本文是**只读设计稿**：给出瓦解 ~130 节点巨型循环依赖簇（R3）的**反转方案、批量破环
> 顺序、每批回归边界与回滚点**。**不含任何实现**，亦不修改业务代码 / 提示词 / 模型调用。
>
> 数据来源：本轮新增的两个**只读分析子命令**（`archDebtScan --scc` / `--drift`，确定性、
> 零依赖、可离线），实测当前代码库得出。**先量化、再设计**，不靠直觉拍脑袋。

---

## 0. 本轮交付的工具增强（只读分析，零业务改动）

为支撑本设计，给自研分析器 `scripts/archDebtScan.js` 增了两条**纯只读**能力，
默认 `npm run arch:debt` 的行为与退码语义**完全不变**，新能力走独立子命令：

| 子命令 | 能力 | 性质 |
|---|---|---|
| `node scripts/archDebtScan.js --scc` | **巨型环切点杠杆**：逐条 `services→cli` 反向边「移除→重算 SCC→量化巨型分量缩小量」，再贪心给出批量破环顺序 | 纯内存图算法，增删边即时还原，零写盘 |
| `node scripts/archDebtScan.js --drift` | **R4 抽取漂移**：检出「re-export 助手模块符号、却仍内部调本地同名旧副本」的半截抽取（三证据齐备才报，零误报） | 纯文本词法分析（`_blankNonCode` 剥注释/字符串），零依赖 |

- 两者均加 `--json`；退码恒 0（只读，不参与 CI 门禁）。
- 合成 fixture 测试 +10 用例（R4 正例 2 / 反例 4 + `_blankNonCode` + SCC 杠杆/无环/findCycles 零回归），
  连同既有 13 用例共 **23/23 绿**；`findCycles` 经 `_sccComponents` 重构后行为字节级不变。
- 防呆：`analyzeGiantScc` / `scanDriftR4` **绝不 import 或执行**任何业务模块，纯静态分析。

---

## 1. 实测现状（2026-06-12，真实代码库）

### 1.1 巨型环规模
- **最大强连通分量 = 129 节点**（cli 全层 + 多数 services + gateway 适配器纠缠成一团）。
- 环内 `services→cli` **候选反向边 = 13 条**（这些就是 R1 分层倒置在巨型环里的“焊点”）。

### 1.2 单边切点杠杆（移除单条边后巨型分量缩小的节点数，降序）

| 杠杆 | 反向边 | 巨型环 | 性质 |
|---:|---|---|---|
| **42** | `services/toolCalling.js → cli/router.js` | 129→87 | **关键割边**：SlashCommand 工具回调命令路由器 |
| 2 | `services/contextCompressor.js → cli/aiRenderer.js` | 129→127 | 压缩结果渲染（`printCompactionResult`） |
| 2 | `services/remote/index.js → cli/handlers/publish.js` | 129→127 | 远端发布编排 |
| 0 | `services/aiManagementServer.js → cli/ai.js` | 129→129 | →cli/ai 互缠核（×5，见下） |
| 0 | `services/capabilityAssessment.js → cli/ai.js` | 129→129 | →cli/ai 互缠核 |
| 0 | `services/toolCalling.js → cli/ai.js` | 129→129 | →cli/ai 互缠核（fallback /status /config /new） |
| 0 | `services/toolUseLoop.js → cli/ai.js` | 129→129 | →cli/ai 互缠核 |
| 0 | `services/ultraplanService.js → cli/ai.js` | 129→129 | →cli/ai 互缠核 |
| 0 | `services/toolCalling.js → cli/hudRenderer.js` | 129→129 | 有状态 HUD |
| 0 | `services/query/compactPipeline.js → cli/hudRenderer.js` | 129→129 | 有状态 HUD |
| 0 | `services/toolCalling.js → cli/ui/permissionDialog.js` | 129→129 | 交互审批 I/O |
| 0 | `services/preflightPermission.js → cli/ui/permissionDialog.js` | 129→129 | 交互审批 I/O |
| 0 | `services/baseSelfCheckService.js → cli/handlers/plugin-dev.js` | 129→129 | 插件开发命令 |

**读法**：单边杠杆 0 ≠ 无用，而是该边与其它边**并联**支撑同一环（尤其 `→cli/ai` 的 5 条边
互为冗余路径，单独移除任一条，其余仍维系环）。要瓦解必须**联合移除**——这正是批量设计的意义。

### 1.3 R4 抽取漂移现状
`--drift` 实测：**`services/toolUseLoop.js` 有 26 处半截抽取**——Phase-1A…1I 的助手模块
（`toolCallParser`/`deliveryFormatter`/`intentHeuristics`/`taskComplexity`/`platformRewrite` 等）
**全部已 re-export，但 `runToolUseLoop` 内部仍调本地旧副本**。典型：
- `_parseToolCalls`：导出走 `toolCallParser.parseToolCalls`，内部仍调本地 @1803/1809；
- `_buildToolResultMessage`：导出走 `deliveryFormatter.buildToolResultMessage`，内部仍调本地 ×5；
- `_stripToolCalls`：内部本地副本被调 **16 次**。

**测试跑助手副本、生产跑本地副本**——一旦漂移即「测试绿而行为变」。属 [DESIGN-ARCH-020] §R4
标注的**高风险业务热区**，本文**只量化不改**，纳入下方 §4 路线图（专项 + 全回归）。

---

## 2. 反转模式选型（Inversion patterns）

巨型环的根因是**服务层为复用 CLI 能力而反向 require cli**（R1）。反转 = 把「谁依赖谁」
掉头，让 cli 在启动时把能力**注入/注册**给 services，services 只依赖**抽象**而非 cli 模块。
三种候选模式，按边的性质择一：

| 模式 | 机制 | 适用 | 代价 / 风险 |
|---|---|---|---|
| **A. 端口注册 / IoC（回调注入）** | 中立零依赖端口模块；cli 启动时 `registerXxx(impl)`，services 经 `getXxx()` 取用，未注册时优雅降级 | 单一、明确的能力调用（命令派发、渲染回调、审批提示） | **最低**。已在 P1 用于 `sessionSourcePort` 验证可行；导出签名不变 |
| **B. 事件总线（单向 push）** | services `emit('event', data)`，cli 订阅渲染；services 不知 cli 存在 | **单向通知**类（HUD 状态、压缩进度、生命周期事件） | 低-中。需统一事件命名；调试需追订阅者 |
| **C. 依赖注入（构造期传参）** | 调用方在构造/调用时把依赖作为参数显式传入 | 调用点集中、可改签名的少量函数 | 中。**触及函数签名 → 违反「导出签名不变」防呆，仅限非热区** |

**总原则**（承接 P1 的「只下沉纯叶子、业务热区不动」）：
- 优先 **A（端口）**——与 P1 已落地的 `sessionSourcePort` 同范式，零签名变更、可降级、可回滚；
- **单向通知**用 **B（事件）**——HUD / 压缩进度天然是 push；
- **C（DI）** 仅在调用点极少且非热区时用；触 `cli/ai` 热区的边一律**不在本轮设计实施范围**，只给方向。

### 2.1 关键割边的反转草案（`toolCalling → cli/router`，杠杆 42）
现状：`toolCalling.js` 的 `SlashCommand` 工具处理器内 `require('../cli/router')` 调 `router.parseInput/route`
来派发斜杠命令（@1849），并 fallback `require('../cli/ai')` 处理 `/status` `/config` `/new`。
**这是服务层工具反向触达 CLI 命令路由器**——单边即占巨型环 42 节点，是**第一优先**。

> **反转草案（模式 A，端口）**：新增零依赖端口 `services/commandDispatchPort.js`
> （`registerDispatcher({ parseInput, route })` / `getDispatcher()`）。`cli/router` 启动时自注册；
> `SlashCommand` 处理器改 `getDispatcher()`，未注册时返回结构化 `{ success:false, reason:'no_dispatcher' }`
> 优雅降级。`/status` `/config` `/new` 的 `cli/ai` fallback 同理走 `commandDispatchPort` 的扩展动作或
> 独立 `aiSessionPort`。**导出签名不变，纯新增端口 + 改 require 指向**，与 P1 二元环消解同形。

---

## 3. 批量破环顺序（实测贪心 + 回归边界）

`--scc` 贪心实测：**移除 4 条边即把巨型环从 129 压到 74**，之后单边收益耗尽（剩 74 节点为
`cli/ai` 互缠核，须联合移除）。据此分 3 批，每批独立可测、可回滚：

### 批次 1 — 关键割边（独立高杠杆，最先做）
| # | 边 | 实测效果 | 反转模式 | 回滚点 |
|---|---|---|---|---|
| 1 | `toolCalling.js → cli/router.js` | 129→**87**（−42） | A 端口 `commandDispatchPort` | 单 commit；端口未注册即降级，`git revert` 即恢复旧 require |

- **回归边界**：SlashCommand 工具全用例 + 斜杠命令派发 e2e（`/status` `/config` `/new` /未知命令 fallback）
  + `archDebtScan --scc` 复测（断言巨型环 ≤87）+ `npm run arch:debt` 退码 0。
- **独立性**：此边是**割边**（单边杠杆 42），可单独成 PR、单独验证、单独回滚，**不依赖批次 2/3**。

### 批次 2 — 单向通知边（事件/端口，互不依赖）
| # | 边 | 贪心增量效果 | 反转模式 |
|---|---|---|---|
| 2 | `contextCompressor.js → cli/aiRenderer.js`（`printCompactionResult`） | 87→**76**（−11） | B 事件 `compaction:result` 或 A 渲染端口 |
| 3 | `compactPipeline.js → cli/hudRenderer.js`（`setCompacting/clearCompacting`） | 75→**74**（−1） | B 事件 `hud:compacting` 单向 push |
| 4 | `baseSelfCheckService.js → cli/handlers/plugin-dev.js` | 76→**75**（−1） | A 端口或改为 cli 侧编排（方向反转） |

- **回归边界**：压缩结果渲染快照一致（文案/token 数）+ HUD compacting 态切换 + 自检命令链路；
  每条边一个 commit，`--scc` 复测巨型环单调下降。
- **次序**：批次 2 内部三条边互不依赖，可并行评审；贪心顺序仅供「先摘大头」参考。

### 批次 3 — `cli/ai` 互缠核（联合移除，最难，专项）
剩余 **74 节点核**由 5 条 `services→cli/ai` 反向边（`aiManagementServer` / `capabilityAssessment` /
`toolCalling` / `toolUseLoop` / `ultraplanService`）+ 审批/HUD 残边并联支撑，**单边杠杆全 0 → 必须联合移除**。

- **反转模式**：A 端口为主——抽 `aiSessionPort`（会话/状态/配置入口）+ `aiRenderPort`（渲染）+
  `permissionPromptPort`（交互审批），`cli/ai` 与 `cli/ui/permissionDialog` 启动自注册，五个服务改经端口取用。
- **风险**：**直接触 `cli/ai` 业务热区（5285 行、含 1700 行 `chat()`）**——按防呆**本文只给方向，不在
  本轮实施**。须独立专项：先补 `cli/ai` 入口契约测试做安全网，再逐边端口化，每边全回归。
- **回归边界**：全 `toolUseLoop.*` + 会话持久化 + 审批弹窗 + 网关级联回归；`--scc` 断言核瓦解至个位数。

### 破环进度可度量
```
129 ──批次1(割边)──► 87 ──批次2(通知边×3)──► 74 ──批次3(cli/ai核,专项)──► 个位数
         −42                 −13                      联合移除
```
每批后 `npm run arch:debt:baseline` 刷新基线**单调收紧**，CI 拦截任何新增反向边。

---

## 4. 与 R4 抽取漂移的关系（路线图衔接）

`toolUseLoop.js` 同时是**巨型环成员**（→cli/ai，批次 3）**和** 26 处 R4 漂移宿主。两者**解耦次序**：
1. **先批次 1/2**（割边 + 通知边）——不触 toolUseLoop，安全摘掉环的大头；
2. **R4 收尾与批次 3 合并专项**：删 toolUseLoop 本地旧副本、统一走助手模块（[DESIGN-ARCH-020] §R4 P2）
   时，顺带把 `→cli/ai` 反向边端口化。**同一文件、同一全回归窗口**，避免两次扰动业务热区。

> 防呆红线：R4 删本地副本属「改核心业务行为」，**必须**专项 + 全 `toolUseLoop.*` 回归 + 灰度，
> 本文与 [DESIGN-ARCH-020] 均**只标注不实施**。

---

## 5. 下一步（可执行的最小一步）

**批次 1 单边**：实现 `commandDispatchPort`，反转 `toolCalling → cli/router`。这是**唯一的独立割边**
（单边即 −42），范式与 P1 已验证的 `sessionSourcePort` 完全一致，**零签名变更、可降级、可单独回滚**，
是瓦解巨型环性价比最高的第一刀。完成后 `--scc` 应实测巨型环 ≤87，基线随之收紧。

**纪律**：每刀一 commit、改后必测、`--scc`/`arch:debt` 双复测；触 `cli/ai` 的批次 3 留专项，不与本轮混做。

---

## 6. 批次 3 实施纪要与经验修正（2026-06-12）

批次 2 落地后（割边 + 通知边×3，巨型环 129→87→**74**，R1 27→23），本轮按 §3 方向尝试批次 3，
**实测推翻了 §3「联合移除 → 个位数」的前提**。如实记录，避免后人重复误判。

### 6.1 经验修正：74 核是 services↔services 互缠，不是 cli 反向边撑起来的
`--scc` 离线复测：对核内每条 `services→cli` 反向边做「移除后重算 SCC」单边杠杆测量，
**三条 cli 残边（`aiManagementServer→cli/ai`、`toolCalling`/`preflightPermission→cli/ui/permissionDialog`）
单边杠杆全为 0（74→74）**。进一步模拟「一次性移除全部 9 条非 cli→cli 反向边」，巨型环只降到 **56**
（纯 services 节点）。

**结论**：74 核的强连通性由 **services 内部 56 节点的互相依赖**支撑，cli 反向边只是「挂在核外的尾巴」，
不是环的承重墙。§3「把 cli/ai 反向边联合移除核就瓦解到个位数」的因果链不成立。瓦解 74 核须另立
设计，正面拆 services↔services 互缠（与 [DESIGN-ARCH-020] §R4 的 `toolUseLoop` 收尾合并专项），
**不是再加几个 cli 端口能解决的**。

### 6.2 本轮实际落地：4 条「可靠预加载」的 cli 反向边（R1 23→17）
既然 cli 反向边对巨型环零杠杆，本轮把目标收敛为**纯 R1 分层收益**——只反转那些目标 cli 模块
**在交互路径中可靠被预加载**的安全边（注册端口范式要求：调用点原 `require()` 是强制加载语义，
端口化后退化为「已加载才用」，故只适用于别处必然先加载的模块）：

| 端口 | 反转边 | 目标 cli 模块预加载来源 |
|---|---|---|
| `modelCapabilityPort` | `capabilityAssessment`、`toolUseLoop` → `cli/ai.checkModelCapability` | `cli/ai` 经 repl/router/bin 入口必然加载；未注册则预检跳过（best-effort） |
| `aiSessionPort` | `toolCalling` → `cli/ai`（`/status` `/config` `/new`） | 同上；未注册返回结构化 `no_ai_session` |
| `compactionUiPort` #3 | `toolCalling` → `cli/hudRenderer.updateTodos` | `cli/hudRenderer` 经 cli/ai、router、repl 必然加载；未注册 emit no-op |

`cli/ai`、`cli/hudRenderer` 启动时自注册（合法 cli→services 方向，**导出签名零变更**），
3 个端口均为零依赖叶子、未注册时优雅降级。契约测试 `tests/services/batch3Ports.test.js`
（13 例 node:test，离线确定性）钉住各端口期望 cli 注册的精确形状。

### 6.3 主动放弃：`permissionPromptPort`（审批弹窗端口）
按 §3 曾抽 `permissionPromptPort` 反转 `toolCalling`/`preflightPermission → cli/ui/permissionDialog`。
**前向依赖审计发现 `cli/ui/permissionDialog` 在生产路径中无任何预加载者**（仅被这两个服务 require）。
端口化后它**永不自注册** → 增强审批弹窗永远走 legacy 兜底，**是真实行为回归**，违反「默认行为不变」防呆。
故**回退这两条边**，保留原 `require('../cli/ui/permissionDialog')`，删除该端口。
教训：注册端口范式**只适用于目标模块别处必然预加载的反向边**；对「仅在该调用点懒加载」的边，
端口化会丢失加载触发，使能力变死。

### 6.4 仍然延后：触 `chat()` 热区的 3 条边
`aiManagementServer→cli/ai`、`toolCalling`/`ultraplanService` 指向 `cli/ai` 的 `chat()` 核心链路的边，
按防呆**继续延后**——它们触 5285 行 `cli/ai`（含 ~1700 行 `chat()`）业务热区，须与 R4 `toolUseLoop`
收尾合并成独立专项 + 全网关级联回归，不在本轮架构债治理窗口内。

### 6.5 本轮可度量结果
```
巨型环 R3：74 ──(批次3 cli 反向边对环零杠杆)──► 74   （不变，符合 6.1 修正）
分层倒置 R1：23 ──(removed 4 条可靠预加载反向边)──► 17  （−6，纯分层收益）
```
`npm run arch:debt` 退码 0；基线 `--update-baseline` 单调收紧至 layering=17，CI 继续拦截新增反向边。
**修正后的破环路线**：74 核须正面拆 services↔services（56 节点互缠）+ R4 收尾，另立设计专项；
cli 反向边治理在 R1 维度收尾，对 R3 巨型环已无更多杠杆。
