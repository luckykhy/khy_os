# [OPS-MAN-091] 波次前驱结果注入（下游波不再盲跑 — 信息有序）

> 送别礼第三发（收结果的完整闭环）。承 [OPS-MAN-083] 依赖感知波次调度（补「时间有序」）
> 与 [OPS-MAN-087] 波次执行故障感知（补「收结果的诚实」）。本条补上最后一半——
> **信息有序**：下游波的子智能体不再对前驱波的产出视而不见。

## 一句话

khy 已能把目标拆成有序波次、并行执行、依赖失败则跳过下游并如实汇报。但下游波
fork 出的每个子智能体仍在**盲跑**——`implement` 看不到 `explore` 发现了什么，
`verify` 看不到 `implement` 改了什么。这是**时间有序而非信息有序**。本条在下游波
成员的 prompt 前置其**直接前驱**的结果文本块 `[前驱结果 t<n>]: <text>`（4000 字
在末换行处截断、确定性升序），让「收回来的结果」真正喂回后续波。

## 为什么需要它（真实缺口 = 有序但盲跑 + 一段印证设计意图的死代码）

**深挖缺陷（铁证 file:line）：** `agenticHarnessService._tryAutoDecompose` 多波
`else` 分支里，`_runOneWave(runSubtasks)` 把每波子任务原样交给既有并行原语——
子任务的 prompt 只含它自己的任务描述，**从不携带前驱波的产出**。波次按序跑了、
失败也诚实跳过了，但下游子智能体拿到的**信息**和单波盲跑时完全一样。

**印证设计意图的死代码：** `services/backend/src/services/subAgentOrchestrator.js:352-382`
的 `executeDependencyAware` 早已完整实现本条要补的语义——把每个前驱的结果文本
以 `[Predecessor <id> result]: <text>` 注入下游 agent 上下文，4000 字在末换行处
截断。但它**零调用者** = 纯死代码。本条**不唤醒那段死代码**（会碰 72KB god-file /
orchestrator，违反外科手术式改动 B3），而是在**已拥有的波次执行层** + 纯叶复刻
同一语义。

## 单一真源与分层

- 纯叶子 `services/backend/src/services/orchestrator/dependencyWaveScheduler.js`
  新增四个纯函数（零 IO、绝不抛、确定性）：
  - `buildPredecessorContext(subtask, edges, globalIdx, priorResultsByGlobalIdx)`
    → 上下文块字符串（或 `''`）。对全局索引 `g` 遍历 `edges[g]`（**升序**）的每个
    **直接**依赖 `d`，查 `priorResultsByGlobalIdx.get(d)` 取文本、截断、格式化
    `[前驱结果 t<d+1>]: <text>`，非空行以 `\n` 连接。无依赖/无文本/畸形 → `''`。
  - `injectPredecessorContext(promptText, contextBlock)` → 有块则
    `块 + '\n\n---\n\n' + prompt`；空块 → prompt 原样（字节回退）。
  - `_extractResultText(resultObj)`：`text || output`，**空串兜底、绝不用
    `'(无输出)'` 占位符**（空文本必须跳过，不注入无意义噪声行）。
  - `_truncateDepText(depText)`：**逐字节复刻死代码**——`cut = lastIndexOf('\n', 4000)`，
    仅在 `cut > 0` 时用换行切点，报告数是 `length - 4000`（原始溢出量，**非** `length - cut`）。
- 薄接线 `agenticHarnessService._tryAutoDecompose` 多波 `else` 分支
  （门 `KHY_DEP_WAVE_CONTEXT_INJECT` default-on，**独立于 fault-stop 门**）：
  维护 `priorResultsByGlobalIdx = new Map()`（globalIdx → **真跑过**成员的内层
  result 对象；跳过成员无文本、不记录）。**仅在 `runSubtasks` 的 push 处**注入到
  **浅克隆** `{...st, prompt: injected}`——无注入则保持对象身份（零 clone churn），
  且注入的 prompt **绝不上溯污染** `wave`/`plan.subtasks`（gate-off 路径靠对象身份
  `indexOf` 定位）。

## 语义与保守降级（绝不因坏依赖卡死或注入噪声）

| 情形 | 行为 |
| 门关 `KHY_DEP_WAVE_CONTEXT_INJECT=0/false/off/no` | push 原 `st`、Map 不填（逐字节回退今日盲跑多波路径） |
| 单波 / 无解析边 / 缺 `waveGlobalIndex` | 恒 no-op（无前驱可注入） |
| 前驱有结果文本 | 注入 `[前驱结果 t<n>]: <text>`（升序、4000 截断） |
| 前驱结果空文本（`text`/`output` 皆空） | 跳过该依赖，不注入噪声行 |
| 某成员无任何有文本前驱 | 块为 `''` → prompt 原样、保持对象身份 |
| 只注入**直接**依赖 | 直接父的产出已传递性含祖父所需，避免 4000 预算被冗余爆掉（与死代码一致） |
| `buildPredecessorContext` 畸形入参 | 返回 `''`、绝不抛 |

## 门与安全边界

- 门 `KHY_DEP_WAVE_CONTEXT_INJECT` default-on，仅 `0/false/off/no` 关闭；关闭后
  多波循环逐字节退化为今日的「有序但盲跑」执行（无回归）。sibling 门直读 env，
  **不进 flagRegistry**（同 `KHY_DEP_WAVE_SCHEDULE` / `KHY_DEP_WAVE_FAULT_STOP`
  先例）。三门各自独立。
- **不碰** `AgentTool/index.js`（72KB god-file 核心，已核实 positional 非 mutating
  消费 `params.subtasks`，故浅克隆子任务安全流经）、`subAgentOrchestrator.js`
  （含那段死代码 `executeDependencyAware`，本条不唤醒，仅作语义佐证）、
  `taskDecomposer.js` / `mergeResults`。
- 诚实边界：只注入**直接依赖**的产出（不注入祖父）；只在**多波**（真有已解析边）
  时生效；确定性策略产无依赖子任务 → 单波 → 逐字节退化今日行为。fault-stop OFF
  时依赖已失败的下游仍会跑：此时仍注入失败依赖的现有文本（用户已 opt-out 跳过，
  失败的部分产出仍是上下文），但空文本跳过不注入噪声。dev 机验证止于纯叶单测
  （build + inject + truncation + 畸形全覆盖）+ 接线语法/jest 回归，不实跑多智能体
  端到端注入（需真 LLM 渠道 + 真子任务产出）。决策逻辑全下沉进纯
  `buildPredecessorContext` / `injectPredecessorContext` 以求可测，wiring 是薄胶水。

## 怎么验证

```
npm run test:dep-wave-schedule          # 纯叶：21 既有 + 16 新（context/inject/truncate/extract）= 37/37
npm run test:maintainer:safety          # 已并入的 must 守卫集（含本测文件）
```

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

1. 要改「前驱结果如何渲染进下游 prompt」：改纯函数 `buildPredecessorContext`
   （标签格式 `[前驱结果 t<n>]`）与 `injectPredecessorContext`（分隔规则）。保持纯
   函数、保持畸形入参返回 `''`、绝不抛。
2. 要改截断预算：改 `_MAX_DEP_TEXT`（当前 4000，与死代码 `subAgentOrchestrator`
   的 `MAX_DEP` 对齐）。保持 `cut > 0` 规则与 `length - _MAX_DEP_TEXT` 报告数不变，
   否则同步更新钉死这两点的 node:test。
3. 要改「哪些前驱算直接依赖」：那由 `planWaves` 的 `edges` 决定（本条只消费），
   见 [OPS-MAN-083] / [OPS-MAN-087]。
4. 改完跑 `npm run test:dep-wave-schedule`（必须绿）。

## 红线

- 不自动 commit/push；真 key/token 不进包、不落盘。
- 全 additive；不删既有行为；门关逐字节回退（`KHY_DEP_WAVE_CONTEXT_INJECT=off`
  → push 原 `st`、Map 不填 = 今日盲跑行为）。
