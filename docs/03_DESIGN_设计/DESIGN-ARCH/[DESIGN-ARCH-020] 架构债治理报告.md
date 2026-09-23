<!-- 文档分类: DESIGN-ARCH-020 | 阶段: 设计 | 原路径: docs/03_DESIGN_设计/[DESIGN-ARCH-020] 架构债治理报告.md（新建） -->
# khyos 架构债治理报告（Architecture Debt Governance）

> 版本 v1.1（2026-06-12）。本报告从**系统全局视角**识别 khyos 后端（`services/backend`，
> 812 个源文件 / 410 个测试）的架构债，做关联性分析、优先级排序，给出**可执行**修复
> 步骤与代码示例，并交付一个**自定义静态分析器**作为持续治理的 CI 门禁。
>
> 治理纪律（防呆，硬约束）：**只动架构相关代码，不碰核心业务算法**；修复**保留功能
> 兼容**；修复后**必测验证**；存量历史债以**基线**承认、增量治理，不一刀切误杀。

---

## 0. 调查方法与覆盖面

| 维度 | 手段 | 覆盖 |
|---|---|---|
| 代码 | 自研 `scripts/archDebtScan.js`：require 图 + 行数 + 分层规则 | 全量 812 文件 |
| 耦合 | require 扇入/扇出统计、Tarjan 强连通分量（循环依赖） | 全量 |
| 历史 | `git log`、仓库根 `*_log.md`、`[*-Unresolved]` 约定标记 | 近 200 提交 + 4 日志 |
| 文档 | `.ai/` 种子文档路径抽检、文档漂移核对 | MAP/CONTEXT/GUARDS |

---

## 1. 识别到的架构债（按规则归类）

### R1 分层倒置（Layering inversion）— 系统级，最高优先
约定依赖方向是 `cli/router → cli/handlers → services`（见 `.ai/MAP.md`）。但**修复前
30 处** `src/services/**` 反向 `require('../cli/**')`，服务层回指 CLI 层 = 依赖倒置。

- **真实双向环（最严重）**：`services/toolCalling.js` ⇄ `cli/ai.js`
  （`cli/ai.js:1763` require `toolCalling`，而 `toolCalling.js:1858/1863/1868` require `cli/ai`）。
  仅靠**惰性 require** 才没在加载期崩溃——这是脆弱的隐性约束。
- **层环**：`services/contextCompressor.js` ↔ `cli`（回指 `cli/hooks/hookSystem`、`cli/aiRenderer`）。
- 最常见的反向符号是 `cli/ai`（被 `queryEngine`、`toolUseLoop`、`ultraplanService`、
  `workflowExecutor`、`capabilityAssessment`、`aiManagementServer` 等消费）。
- 唯一**加载期**（非惰性）倒置：`extensionMarketplace.js:27` → `cli/extensions/extensionManager`。

### R2 巨石文件（God-file）— 可维护性，高优先
单文件 > 2500 行、职责混杂的有 **11 个**：

| 行数 | 文件 | 混杂职责（节选） |
|---|---|---|
| 8115 | `cli/repl.js` | 启动渲染 + ANSI 布局 + 粘贴状态机 + 斜杠/@ 选择器 + 流式事件消费，**全部塞在单个 `startRepl()` 闭包**（93 个嵌套函数共享可变闭包态） |
| 6784 | `cli/handlers/gateway.js` | 网关命令分发 |
| 6404 | `services/toolUseLoop.js` | Agent 工具循环 + 解析 + 能力门控 + 审批 + 意图启发 + 恢复 |
| 6075 | `services/gateway/aiGateway.js` | 级联路由 + 熔断 |
| 5285 | `cli/ai.js` | 会话持久化 + 模型能力 + 上下文预算 + 提示构造 + 多模态 + **1700 行的 `chat()` 单函数** |
| 4211 | `cli/router.js` | 大 switch 命令路由 |
| 其余 | `accountPool` 3256 / `codexAdapter` 3127 / `aiManagementServer` 3101 / `proxy` 3070 / `toolCalling` 2937 | — |

### R3 循环依赖（Circular require）— 系统级
Tarjan SCC 初检出 **3 个强连通分量**（P1 轮已消解 2 个，**现存 1 个**）：
- **1 个巨型 SCC（~130 节点）**：cli 全层 + 多数 services + 全部 gateway 适配器纠缠成一团。
  根因是 R1 的惰性反向 require 把 cli↔services 焊死成一个环。**这是 R1 的系统级显影**，
  须先解 R1 才能瓦解，本轮不动。
- ~~**2 个干净二元环**~~ → **✅ P1 轮已消解（2026-06-12）**：
  - `services/sessionPersistence.js` ⇄ `services/sessionSearchIndex.js`
    → 引入零依赖端口 `services/sessionSourcePort.js`（IoC）：持久化层自注册为会话源，
    搜索索引 `reindexAll` 经端口取源,不再反向 require 持久化。
  - `services/worktreeManager.js` ⇄ `tools/_taskStore.js`
    → 纯函数 `validateName` 抽到零依赖叶子 `utils/worktreeName.js`，双方同向依赖它。

### R4 重复实现 / 抽取漂移（Duplication drift）— 隐患
- **`toolUseLoop.js` 半截抽取**：Phase-1A…1I 助手模块（`toolCallParser`/`deliveryFormatter`/
  `platformRewrite` 等）已抽出并 re-export，**但 `runToolUseLoop` 内部仍调本地旧副本**
  （如 `_parseToolCalls`@3911、`_buildToolResultMessage`@4514）。**测试跑的是助手副本，
  生产跑的是本地副本**——一旦漂移，测试绿而行为变。属**高风险业务热区**，本轮只报告不动。
- 散点重复：`_formatDuration` 4 处、`_resolveTaskScale` 包装 3 处、`_normToolName` 2 处。

### R5 历史/文档债 — 小而局部，多为有意延迟
后端源码**内联债极少**：真实 `TODO/FIXME` 个位数（多数是提示词字面量误报）。
`[*-Unresolved]` 4 处均为**有意延迟**的契约缺口：
- `utils/dataHome.js:38` `[Eco-Arch-Unresolved]`：`~/.khy` 与硬编码 `~/.khyquant` 双数据家未收敛，
  底座表物理拆分到 `~/.khyos` 待**人工撰写带回滚的迁移脚本**（活体数据，故意不自动跑）。
- `metaToolEngine.js:477` `[MetaTool-Trigger-Unresolved]`、`agentDevLog.js:316`
  `[Agent-Display-Unresolved]`：待 host 侧绑定，优雅降级中。
- `claudeAdapter.js:1390` `@deprecated dispatchDirectTool()`：回滚保险留存的死 shim，可择机删。
- 标准红线基线：27 套件 / 39 用例因**沙箱无网络 + 计时抖动**而红（既有债，非本轮引入）。
文档侧无实质漂移（`.ai/` 由 `khy metadata refresh` 确定性自刷新）。

---

## 2. 整体（全局关联）分析

**根因链**：`R1（分层倒置）` 是核心。服务层为复用 CLI 的渲染/AI 入口而反向 require，
惰性 require 规避了加载崩溃，**代价是把 cli↔services 焊成一个 ~130 节点的巨型环（R3）**。
环内任一模块改动都可能产生跨层涟漪，于是开发者倾向「就地加代码」而非拆分，
**助长了 R2 巨石文件**膨胀；巨石文件难测，又催生 `R4` 的「抽一半、留旧副本」折中。

```
R1 服务层反向依赖 cli ──(惰性 require 规避崩溃)──► R3 巨型循环依赖簇
        │                                                │
        ▼                                                ▼
  跨层涟漪→不敢拆分 ───────────────► R2 巨石文件膨胀 ───► R4 半截抽取/重复
```

**结论**：必须从 R1 入手做**方向修复**（把被双方共享的叶子模块下沉到中立层），
逐步瓦解巨型环，而非在巨石文件内做局部最优。局部重构巨石文件若不先解耦，
只会在环内搬运复杂度、引入新隐患。

---

## 3. 修复优先级（影响范围 × 修复成本 × 业务价值）

| 优先级 | 项 | 影响范围 | 修复成本 | 风险 | 决策 |
|---|---|---|---|---|---|
| **P0** | 工具集成：静态分析门禁 | 全局（防新增债） | 低（新增工具） | 无（只读） | **本轮已做** |
| **P0** | R1 叶子下沉示范（`commandSchema`） | 5 文件 | 低（纯数据叶子） | 极低 | **本轮已做** |
| P1 | R3 二元环消解（sessionPersistence/worktreeManager） | 2×2 文件 | 中 | 中 | **✅ 已做（2026-06-12，R3 3→1）** |
| ~~P1~~ | ~~R1 共享 UI/渲染叶子下沉（hudRenderer/permissionDialog）~~ | — | — | — | **重判：经审视非纯叶子，改为 P2 反转**（见 §5.2 发现） |
| P2 | R4 `toolUseLoop` 完成抽取（删本地副本，统一走助手模块） | 业务热区 | 高 | **高** | 路线图（需专项＋全回归） |
| P2 | R2 巨石文件分解（`repl.js`/`ai.js` 按职责拆 helper） | 高扇入 | 高 | **高** | 路线图（先解 R1/R3 再拆） |
| P3 | R5 删 `@deprecated` shim、收敛 dataHome、补 `routes/ai.js` SSE 断连 | 局部 | 低-中 | 低 | 单独 PR |

**防呆遵循**：P2/P3 涉及业务热区（`runToolUseLoop`、`chat()`）的项**本轮不动**，
只列入路线图并要求「专项 + 全回归」，严守「不碰核心业务算法」。

---

## 4. 工具集成（已交付）：自研架构债静态分析器

`services/backend/scripts/archDebtScan.js`（零外部依赖，纯 Node 内置）。
**为何不用 SonarQube/ESLint**：本仓奉行「零依赖、确定性、CI 离线可跑」纪律
（同 `khy metadata check`）。自研规则更贴合本仓**分层契约**这一架构语义。

能力：
- **R1** 扫 `services/**` 反向 require `cli/**`；
- **R2** 行数超阈值（`KHY_ARCH_GOD_FILE_LOC`，默认 2500）；
- **R3** require 有向图 + Tarjan SCC 检出循环依赖簇；
- **基线机制**：`arch-debt-baseline.json` 承认存量债，CI **只拦新增**（增量治理）。

用法（已加 npm 脚本）：
```bash
npm run arch:debt            # 人类报告；有超基线新增 → 退出码 1（CI 门禁）
npm run arch:debt -- --json  # 机器可读
npm run arch:debt:baseline   # 重铸基线（承认现状，确定性无时间戳）
```
测试：`tests/scripts/archDebtScan.test.js`（13 用例，合成 fixture，确定性）。

---

## 5. 已执行的示范修复（含代码示例）

**修复：把被 cli 与 services **双方共享**的纯数据叶子 `commandSchema.js` 从 `cli/`
下沉到中立的 `constants/` 层**——这是 R1 的方向修复范式：共享叶子应位于依赖方之下，
而非某一依赖方内部。

- **选型理由**：`commandSchema.js` 零出站 require、纯静态命令元数据 + 纯 getter、
  无状态无 I/O、是真正的**叶子**——下沉**不可能**制造新环，且一次性消除 2 条服务层反向边。
- **兼容性**：导出签名不变，仅路径变更；5 个引用方同步改路径，零逻辑改动。

```diff
# 文件迁移（保留 git 历史）
- src/cli/commandSchema.js
+ src/constants/commandSchema.js

# 服务层（恢复正确方向：services → constants，不再 → cli）
# src/services/selfProfile.js:28
-   if (!_commandSchema) _commandSchema = require('../cli/commandSchema');
+   if (!_commandSchema) _commandSchema = require('../constants/commandSchema');
# src/services/knowledgeTeachingService.js:1111
-   const commandSchema = require('../cli/commandSchema');
+   const commandSchema = require('../constants/commandSchema');

# CLI 层（cli → constants，合法方向）
# src/cli/router.js / featureCapabilityMap.js / commandRegistry.js
-   require('./commandSchema')
+   require('../constants/commandSchema')
```

**效果验证**：
- 分层倒置 **30 → 28**（`archDebtScan` 实测；`commandSchema` 不再出现在 R1 列表）；
- 全部 5 引用方加载通过；命令解析功能不变（124 路由命令 / 84 斜杠命令 / 55 子命令组）；
- 无任何测试引用旧路径；分析器自身 13 用例 + 真基线门禁绿。

## 5.2 P1 轮已执行修复（2026-06-12，R3 3→1）

**消环一 · `worktreeManager` ⇄ `tools/_taskStore`（纯函数下沉范式）**
反向边仅因 `_taskStore.bindWorktree` 回头 require `worktreeManager.validateName`（一个
纯校验函数）。把 `validateName` 抽到零依赖叶子 `utils/worktreeName.js`，双方同向依赖它：
```
   A ⇄ B            A → C ← B
（互相 require）  （纯函数 validateName 下沉到 C，环消解）
```
- `worktreeManager` 改为从叶子导入并**再导出**（保 `wt.validateName` 兼容，测试不破）。
- `_taskStore` 改 require 叶子，反向边消失。导出签名零变更。

**消环二 · `sessionPersistence` ⇄ `sessionSearchIndex`（端口注册 / IoC 范式）**
此环不是「共用纯函数」，而是**功能性反向边**：搜索索引 `reindexAll()` 回头 require 持久化
以枚举全部会话做批量重建。共用纯函数无从抽取，故用**控制反转**：
```
  index ──require──► persistence            index ──get()──► [port] ◄──register── persistence
   （反向边，成环）                          （索引经端口取源，持久化自注册，环消解）
```
- 新增零依赖端口 `services/sessionSourcePort.js`：`register/getSessionSource`。
- 持久化层加载时 `registerSessionSource(module.exports)` 自注册（端口是叶子，无环）。
- `reindexAll` 改 `opts.source || port.getSessionSource()`；持久化未加载时优雅返回空结果
  （与既有 best-effort 同形）。导出签名不变，并新增 `opts.source` 显式注入通道。

**R1 发现（诚实记录，本轮未动 R1）**：原计划「下沉 `hudRenderer`/`permissionDialog`
纯格式化叶子」经逐一审视**不成立**——`formatPermissionDialog`/`formatBatchPermissionDialog`
名为 format 实为**交互 I/O 编排**（直接 `console.log` + `promptChoiceMenu` readline 阻塞
+ 读 fs）；`hudRenderer` 的 `setCompacting/updateTodos` 是**有状态 HUD 控制**。复核全部
28 条 R1 边,**无一是纯零副作用叶子**:它们都是「服务层调用住在 cli 的*行为*」(AI 入口
`cli/ai`×13 / 交互提示 / 有状态 HUD·hooks·taskPanelState)。唯一纯叶子 `commandSchema`
已在 P0 抽走。消解这些边需**反转调用语义**(事件总线 / 回调注入 / DI),属较重重构且多数
触及 `cli/ai` 业务热区——按防呆「只下沉纯叶子、业务热区不动」,改列入 §7 路线图 P2。

---

## 6. 修复验证（防呆：修复后必测）

### P0 轮（commandSchema 下沉）
| 验证 | 结果 |
|---|---|
| 5 个引用方 + 迁移模块加载 | ✅ 全通过 |
| 命令元数据解析（路由/斜杠/子命令） | ✅ 124 / 84 / 55，与修复前一致 |
| 无残留旧路径引用 | ✅ grep 清零 |
| `archDebtScan` R1 计数 | ✅ 30 → 28 |
| 分析器测试套件 | ✅ 13/13 |
| 真实基线 CI 门禁 | ✅ 退出码 0（无超基线新增） |

### P1 轮（二元环消解，2026-06-12）
| 验证 | 结果 |
|---|---|
| `archDebtScan` R3 环数 | ✅ 3 → 1（仅余巨型 SCC） |
| `archDebtScan` R1 计数 | ✅ 保持 28（未增，无安全叶子可降） |
| worktree:`bindWorktree` 经 relocated `validateName` 合法/穿越/空名三路 | ✅ 行为一致 |
| worktree jest 套件 | ✅ exit 0 |
| session 端到端 reindexAll（端口 + `opts.source` 注入两路） | ✅ 重建+搜索命中 |
| session 相关 jest 套件（searchIndex/handler/rag） | ✅ 3/3 exit 0 |
| 持久化自注册链路（加载后端口拿到源 === 导出） | ✅ |
| 分析器自测 + 基线门禁（刷新后） | ✅ 13/13，gate exit 0 |

---

## 7. 治理路线图（增量、可持续）

1. **第一轮 P0（已完成）**：静态分析门禁 + 基线 + `commandSchema` 示范下沉（R1 30→28）。
2. **第二轮 P1（已完成，2026-06-12）**：消解 2 个二元环（R3 3→1，端口注册 + 纯函数下沉），
   基线单调收紧至 cycles=1。R1 渲染叶子下沉经审视**非纯叶子，撤回**，转入下条。
3. **专项（P2）**：
   - **R1 反转**：用事件总线 / 回调注入 / DI 反转 `services → cli/ai`（×13）等行为调用，
     瓦解 ~130 节点巨型 SCC。**触及业务热区，须专项 + 全回归**。
   - **R4**：`toolUseLoop` 完成抽取（删本地副本、统一助手模块）+ 全量 `toolUseLoop.*` 回归。
   - **R2**：`repl.js`/`ai.js` 按职责拆 helper，**先解环再拆**。
4. **清理（P3）**：删 `@deprecated dispatchDirectTool`；按 `[Eco-Arch-Unresolved]` 计划
   收敛 dataHome（需人工迁移脚本 + 回滚）；补 `routes/ai.js` SSE 断连处理。

**门禁纪律**：每次降债后 `npm run arch:debt:baseline` 刷新基线并提交，使基线**单调收紧**，
新增债被 CI 拦截，存量债逐轮削减——架构健康度持续可度量。
