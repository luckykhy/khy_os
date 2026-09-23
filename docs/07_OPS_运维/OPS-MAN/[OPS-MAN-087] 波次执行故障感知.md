# [OPS-MAN-087] 波次执行故障感知（依赖失败 → 跳过下游，如实汇报）

> 送别礼第二发（收结果的诚实闭环）。承 [OPS-MAN-083] 依赖感知波次调度：
> 那一刀补上了「有序」（把带依赖的子任务编译成有序波次）。本条补上「收结果」
> 这一半的诚实性——依赖已失败的下游子任务**不再盲跑在坏前提上**。

## 一句话

khy 已能把目标拆成有序波次并行执行、收结果。但当上游某波子任务**失败**时，
下一波仍会照常拉起那些依赖指向已失败上游的子智能体——`verify` 跑在一个建立于
失败 `explore` 之上的 `implement` 上，并被当成正常结果汇报。本条让波次执行
**感知故障**：依赖已失败（或已被跳过）的下游子任务被短路成 `skipped（依赖失败，
已跳过）` 并**如实计入失败**，绝不盲跑、绝不假报成功。

## 为什么需要它（真实缺口 = 有序但不感知故障 + 一段印证设计意图的死代码）

**深挖缺陷（铁证 file:line）：**

1. `agenticHarnessService._tryAutoDecompose` 的多波循环**无条件按序跑每一波**。
   上游波失败后，下一波照常 fork 依赖已失败上游的子智能体。
2. 波次调度器 `planWaves` 内部算出了每子任务的解析依赖边（`deps[i]`），却在
   分层后**即丢弃**——执行层拿不到边，无从判断「我的依赖真的成功了吗」。
3. 后果：结果被「收回来」了，但**不诚实**——一个立在坍塌地基上的子任务被当成
   正常 run 汇报，而非「因依赖失败而跳过」。

**印证设计意图的死代码：** `services/backend/src/services/subAgentOrchestrator.js:296`
的 `executeDependencyAware(tasks)` **早已完整实现**本条要补的语义——拓扑分层 +
**故障传播**（依赖失败 → `{status:'skipped', reason:'dependency X failed'}`）+
前驱结果注入下游上下文。但它**零调用者**（src / bundled / tests 全无）= 纯死代码；
活路径 `AgentTool._runOrchestrated` 走的是扁平 `_mapSettledLimited`，无任何依赖感知。
本条**不唤醒那段死代码**（会碰 72KB god-file / orchestrator），而是在**已拥有的
波次执行层**补上同一语义的最小诚实闭环。

## 单一真源与分层

- 纯叶子 `services/backend/src/services/orchestrator/dependencyWaveScheduler.js`：
  - `planWaves` 追加两个 additive 返回键：
    - `edges: Set<number>[]`——按 0-based 全局位置的**已解析**依赖边集（悬空引用早被
      `_normalizeDeps` 丢弃，故 edges 只含真实边）。
    - `waveGlobalIndex: number[][]`——与 `waves` 同形，每项是该子任务在源数组的位置
      （分层时 `ready` 数组本就持有索引，顺手记下；**无 `indexOf`**，结构性消除
      重复对象命中风险）。
  - 新纯函数 `partitionWaveBySurvivors(waveGlobalIdx, edges, failedGlobalIdxSet)`
    → `{toRun, toSkip}`：某波成员全局索引 `g` 被跳过 iff `edges[g]` 与
    `failedGlobalIdxSet` 有交集。纯函数、绝不抛、畸形入参保守全 `toRun`。
- 薄接线 `agenticHarnessService._tryAutoDecompose` 多波 `else` 分支
  （门 `KHY_DEP_WAVE_FAULT_STOP` default-on）：跨波累积 `failedGlobalIdx`
  （真失败 + 被跳过都计入 → **传递闭包**），每波只把 `toRun` 交既有并行原语
  `_runOneWave`，为每个 `toSkip` 合成 `{success:false, skipped:true,
  error:'依赖失败，已跳过'}` 项并 `failCount++`。合成项经既有 `mergeResults`
  正确渲染成「失败: 依赖失败，已跳过」——**不碰 mergeResults / taskDecomposer**。

## 语义与保守降级（绝不因坏依赖卡死）

| 情形 | 行为 |
| 门关 `KHY_DEP_WAVE_FAULT_STOP=0/false/off/no` | 无条件跑每波（逐字节回退今日行为） |
| 单波 / 无解析边 / 缺 `waveGlobalIndex` | fault-stop 恒为 no-op，跑所有 |
| 某波成员依赖已失败/已跳过 | 短路为 skip 失败项，`failCount++`，其索引并入 failed 集 |
| 被跳过节点的下游 | 传递跳过（skip 索引进 failed 集 → 下游 partition 命中） |
| 悬空依赖 | edges 只含已解析边，悬空永不触发跳过 |
| `partitionWaveBySurvivors` 畸形入参 | 保守全 `toRun`、绝不抛 |

## 门与安全边界

- 门 `KHY_DEP_WAVE_FAULT_STOP` default-on，仅 `0/false/off/no` 关闭；关闭后
  多波循环逐字节退化为今日的无条件按序执行（无回归）。sibling 门直读 env，
  **不进 flagRegistry**（同 `KHY_DEP_WAVE_SCHEDULE` 先例）。
- **不碰** `AgentTool/index.js`（72KB god-file 核心）、`subAgentOrchestrator.js`
  （含那段死代码 `executeDependencyAware`，本条不唤醒）。
- 诚实边界：故障感知只做「依赖失败 → 跳过下游 + 如实汇报」；**不**做前驱结果
  注入下游上下文（那是死代码 `executeDependencyAware` 的更进一步能力，唤醒它需碰
  orchestrator，超本条外科范围——标注为未来工作）。只在**多波**（真有已解析边）时
  生效；确定性策略产无依赖子任务 → 单波 → 逐字节退化今日行为。dev 机验证止于纯叶
  单测（edges + partition 全覆盖）+ 接线语法/回归，不实跑多智能体端到端故障传播
  （需真 LLM 渠道 + 真失败子任务）。决策逻辑全下沉进纯 `partitionWaveBySurvivors`
  以求可测，wiring 是薄胶水。

## 怎么验证

```
npm run test:dep-wave-schedule          # 纯叶：11 既有 + 10 新（edges + partition）= 21/21
npm run test:maintainer:safety          # 已并入的 must 守卫集（含本测文件）
```

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

1. 要改「哪些下游算被依赖失败连累」的判定：改纯函数 `partitionWaveBySurvivors`
   （成员 `g` 跳过 iff `edges[g]` ∩ `failed ≠ ∅`）。保持纯函数、保持畸形入参
   保守全 `toRun`、绝不抛。
2. 若 `planWaves` 暴露的边形状变了，同步更新 `edges` 的构造（`t<n>` id ↔ 全局
   索引 `n-1`）与相应 node:test。
3. 改完跑 `npm run test:dep-wave-schedule`（必须绿）。

## 红线

- 不自动 commit/push；真 key/token 不进包、不落盘。
- 全 additive；不删既有行为；门关逐字节回退（`KHY_DEP_WAVE_FAULT_STOP=off`
  → 无条件跑每波 = 今日行为）。
