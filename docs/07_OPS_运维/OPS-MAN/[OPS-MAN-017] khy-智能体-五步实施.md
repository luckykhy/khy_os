<!-- 文档分类: OPS-MAN-017 | 阶段: 运维 | 原路径: docs/指南/khy-智能体-五步实施.md -->
# KHY Agent 五步实施

本文档将五步方法映射到当前的 KHY 代码库，并定义一条可落地的推进路径。

## 0. 范围

目标：基于现有组件构建一个具备生产能力的智能体运行时，而非从零重写。

仓库中已有的基础组件：
- 上下文（Context）：`backend/src/services/contextRouter.js`、`contextCompressor.js`、`contextWindowGuard.js`、`agentContext.js`
- 循环（Loop）：`backend/src/services/toolUseLoop.js`、`retryWithBackoff.js`、`backgroundTaskManager.js`、`flowsEngine.js`
- 技能（Skills）：`backend/src/skills/index.js`、`backend/src/skills/skillLoader.js`、`backend/src/services/skillRegistry.js`
- 记忆（Memory）：`backend/src/memdir/`、`backend/src/services/projectMemoryService.js`、`sessionRecapService.js`
- 可观测性 / Harness 支撑：`backend/src/services/diagnosticEvents.js`、`traceAuditService.js`、`serviceRegistry.js`

新的聚合入口：
- `backend/src/services/agenticHarnessService.js`

已集成的调用路径（当前）：
- `backend/src/services/queryEngine.js` 的旧版循环现已支持 harness 优先执行，并带自动回退。
- 环境变量开关：`KHY_QUERY_ENGINE_HARNESS=true|false`（默认：`true`）。
- `backend/src/cli/repl.js` 的工具循环路径现已支持 harness 优先执行，并带自动回退。
- 共享 REPL 开关：`KHY_REPL_HARNESS=true|false`（默认：`true`）。

---

## 1. 上下文工程 -> 信息组织

### 目标
保持上下文完整、结构化，并足够精简以适配模型窗口上限。

### 设计
- 采用三层上下文模型：
  - 热层（会话）：当前轮次 + 短生命周期缓存
  - 温层（项目）：项目记忆与近期会话轨迹
  - 冷层（长期）：持久化记忆文件 / 外部向量检索器
- 在调用模型前应用前置路由：
  - `fits`
  - `compact_only`
  - `truncate_tool_results_only`
  - `compact_then_truncate`
- 构建上下文包（context packet），包含：
  - 路由决策
  - token 估算
  - 记忆提示
  - 活跃技能提示

### 代码映射
- 路由：`routeContextStrategy()` 与 `truncateToolResults()`
- 压缩：`compress()`（尽力而为）
- 包组装：`createAgenticHarness().buildContextPacket()`

### 验收标准
- 上下文溢出不再导致常规任务突然失败。
- 每次运行都记录路由 + token 估算以便追溯。

---

## 2. 智能体循环工程 -> 持续任务执行

### 目标
确保长任务持续推进，并能自动从瞬态错误中恢复。

### 设计
- 保留 `toolUseLoop` 作为执行核心。
- 在循环调用外层增加针对瞬态结果的重试封装：
  - `timeout`、`network`、`process`、`unknown`、`cancelled`（在无进展时）
- 将运行生命周期绑定到 `backgroundTaskManager`：
  - prepare -> loop -> completed/failed

### 代码映射
- 循环核心：`runToolUseLoop()`
- 重试：`retryWithBackoff()`
- 生命周期状态：`backgroundTaskManager.register/complete/fail`

### 验收标准
- 单次瞬态通道抖动不应立即终止任务。
- 任务状态始终可见，呈现为 running/completed/failed。

---

## 3. 技能工程 -> 可扩展性与性能

### 目标
为当前任务激活恰当的能力，而无需全量加载。

### 设计
- 按上下文发现并排序技能：
  - 项目 cwd
  - 近期文件
  - 用户意图 token
- 将排名前 N 的活跃技能提示返回到循环提示词中。
- 保持插件/技能执行路径不变；仅优化选择过程。

### 代码映射
- 发现：`skills.discoverAllSkills(cwd)`
- 激活：`skills.getActiveSkills({ cwd, recentFiles })`
- 排序与提示输出：`agenticHarnessService.js` 中的 `_collectSkillHints()`

### 验收标准
- 对于非平凡任务，提示词中包含相关技能。
- 技能选择成本通过缓存保持有界。

---

## 4. 记忆工程 -> 上下文窗口突破

### 目标
支持超越当前上下文窗口的长程连续性。

### 设计
- 从以下来源检索记忆提示：
  - 文本搜索（`memdir.searchMemories`）
  - 可选的向量检索器回调（`vectorRetriever`）
- 将记忆切分为短片段以便注入提示词。
- 持久化运行轨迹以供未来检索：
  - 会话元数据
  - 路由决策
  - 工具调用进展

### 代码映射
- 检索与排序：`_collectMemoryHints()`
- 持久化：`projectMemoryService.saveSessionTrace()`

### 验收标准
- 长期运行的项目可以带着相关的历史提示恢复。
- 记忆提示有界且经过排序，而非整体倾倒。

---

## 5. Harness 工程 -> 生产落地

### 目标
将上述能力整合为一个可复用的生产运行时。

### 设计
- 提供统一的运行 API：
  - `createAgenticHarness(options).run(request)`
- 要求最少的输入：
  - `userMessage`
  - `chat` 函数
- 暴露结构化的运行报告：
  - 时长
  - 上下文路由
  - token 估算
  - 记忆/技能提示
  - 迭代次数与工具调用次数

### 代码映射
- 运行时入口：`backend/src/services/agenticHarnessService.js`

### 验收标准
- CLI/REPL/子智能体流程可以共享同一个 harness 接口。
- 每次运行都产出确定性的报告，用于调试与治理。

---

## 推进计划（推荐）

1. 先将 harness 集成到一个入口流程中（REPL 或 queryEngine 路径）。
2. 每次变更集后运行 `node scripts/check-agent-rules.js --changed`。
3. 为以下场景添加冒烟测试：
   - 上下文路由选择
   - 瞬态重试路径
   - 记忆 + 技能提示生成
4. 在初步稳定后，将集成扩展到子智能体与 Web 路由。

---

## 流程总览

上下文工程 -> 打包上下文 + 路由  
智能体循环工程 -> 弹性执行 + 重试  
技能工程 -> 动态能力激活  
记忆工程 -> 长期回忆 + 分段提示  
Harness 工程 -> 单一运行时 API + 可观测性
