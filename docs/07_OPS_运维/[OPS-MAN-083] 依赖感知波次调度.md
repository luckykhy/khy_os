# [OPS-MAN-083] 依赖感知波次调度（拆任务 → 有序并行）

> 送别礼的又一角度：让 khy「不只会跑任务，还会自己拆任务、并行拉起多个智能体、
> 把结果收回来」——而且是**有序**地并行，不是把有依赖的任务链拍平成一锅乱炖。

## 一句话

khy 早已能把一个目标拆成子任务、并行 fan-out、收结果。但「有序」这一半被悄悄丢了：
子任务之间的**依赖信息**（先探索 → 再实现 → 后验证）在从拆解器传到执行层的路上被
结构性丢弃，于是所有子任务被一次性同时并行拉起。本条把依赖信息编译成**有序波次**
（wave 内并行、wave 间串行），让现有并行原语按波执行。

## 为什么需要它（真实缺口 = 死字段 + 断桥）

三层编排本已 wired、default-on：`taskDecomposer.decompose` → `AgentTool._runOrchestrated`
→ `SubAgentOrchestrator` → `mergeResults`。深挖发现一条断裂的数据链：

1. **上游产出了依赖**：`services/backend/src/services/_llmDecomposer.js:103` 明确解析并保留
   每个子任务的 `dependencies: [...]`（LLM system prompt 第 20 行就要求输出子任务间依赖）。
2. **下游能吃依赖**：`services/backend/src/services/orchestrator/orchestrationPlan.js:7,116`
   的 DAG builder 消费 `dependsOn` 边，支持 sequential/parallel/phase。
3. **中间把依赖丢了**：`taskDecomposer` 的四个确定性策略产出的子任务形状恒为
   `{prompt, role, originIndex}`——**没有 dependencies**；而 always-on 主路径
   `agenticHarnessService._tryAutoDecompose` 调 `decompose` 时**不传 deps**，故 LLM 策略
   永不触发。即便触发，`_runOrchestrated` 也把 `subtasks` **一次性全部并行 fork**，
   `mergeResults` 按 index 拼——**无视任何依赖**。

后果：`_llmDecomposer` 花 token 产出的 `dependencies` 字段**没有任何 consumer**，全程被
丢弃。一个本该有序的任务链（explore → implement → verify）被拍平成一次无序并行——
implement/verify 在 explore 还没出结果时就抢跑。「拆任务并行跑」表面成立，**「有序」这一
内核缺失**。

## 单一真源与分层

- 纯叶子 `services/backend/src/services/orchestrator/dependencyWaveScheduler.js`：零 IO、
  确定性、绝不抛。`planWaves(subtasks, opts)` 把（可能带 `dependencies` 的）子任务用
  Kahn 拓扑分层编译成**有序波次**——wave 内互不依赖（可并行）、wave 间严格串行。
- 薄接线 `agenticHarnessService._tryAutoDecompose`：拿到 `plan.subtasks` 后调 `planWaves`；
  单波 → 走今天的单次 `_runOrchestrated`（逐字节等价）；多波 → 按 wave 依次调用同一个
  **既有并行原语**，波间 await，并把每波的 `subtask-N` 结果名重映射回子任务在全量 plan
  中的全局位置，交给既有 `mergeResults` 汇总。**不新增任何执行机器，只补上依赖隐含的顺序。**

## 波次语义与保守降级（绝不因坏依赖卡死）

| 输入情形 | 结果 | reason |
| 门关 `KHY_DEP_WAVE_SCHEDULE=0/false/off/no` | 单波全并行（逐字节回退） | `gate-off` |
| 空 / 单个子任务 / 无任何依赖边 | 单波全并行 | `empty` / `flat` |
| 线性链 A→B→C | 三波 [A][B][C] | `layered` |
| 菱形 A→{B,C}→D | 三波 [A][B,C][D] | `layered` |
| 依赖成环 | 保守塌成单波全并行 | `cycle-detected` |
| 悬空依赖（指向不存在的子任务） | 丢弃该边 + `hadDanglingDeps=true` | `flat-dangling` / `layered` |
| 畸形输入 / 内部异常 | 单波全并行，`ok:false` | `error-fallback` |

依赖引用支持三种写法：数字（1-based index）、`t<n>` 节点 id、匹配另一子任务的
title/name/role/prompt 首行的字符串。自引用自动丢弃。

## 门与安全边界

- 门 `KHY_DEP_WAVE_SCHEDULE` default-on，仅 `0/false/off/no` 关闭；关闭后等价今天的
  扁平 fan-out（逐字节回退，无回归）。sibling 门直读 env，不进 flagRegistry。
- **不碰** `AgentTool/index.js`（72KB god-file 核心）——只新增纯叶 + 门控 additive 接线。
- 诚实边界：本调度器只重排**执行波次**，不改单个 subagent 行为；依赖来源依赖
  `_llmDecomposer`（opt-in `KHY_LLM_DECOMPOSE`）或未来策略产出。确定性策略仍产无依赖
  子任务 → 此时逐字节退化为单波并行。dev 机验证止于纯叶单测 + 接线语法/回归，不实跑
  多智能体端到端（需真 LLM 渠道）。

## 怎么验证

```
npm run test:dep-wave-schedule          # 纯叶波次调度器 11/11
npm run test:maintainer:safety          # 已并入的 must 守卫集
```

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

1. 要教调度器认新的依赖引用写法：扩 `dependencyWaveScheduler.js` 的 `_normalizeDeps`
   （已支持 index / `t<n>` / title-role 字符串）。保持纯函数、保持「未知引用 → 丢边 +
   标 dangling」的保守规则，坏 spec 永不死锁。
2. 加一条 node:test 覆盖新写法 + 一条回归断言 flat/cycle 降级仍成立。
3. 改完跑 `npm run test:dep-wave-schedule`（必须绿）。

## 红线

- 不自动 commit/push；真 key/token 不进包、不落盘。
- 全 additive；不删既有行为；门关逐字节回退。
