# [OPS-MAN-093] 确定性顺序链拆解（让整条波次 arc 在默认离机路径活起来）

> 送别礼第五发（收结果的第一公里 — producer 端）。承 [OPS-MAN-083] 依赖感知波次
> 调度、[OPS-MAN-087] 波次执行故障感知、[OPS-MAN-091] 波次前驱结果注入、
> [OPS-MAN-092] 跳过与失败在最终报告分列。前四发都在 arc 的**执行/渲染层**，
> 都假设子任务**已经带** `dependencies`。本条补上唯一缺的一环：一个**确定性**的
> `dependencies` producer，让整条 arc 在 **pip/npm 默认离机安装、无 LLM key** 的
> 机器上真正生效。

## 一句话

khy 已能有序拆波、并行执行、依赖失败则跳过下游、下游波携带前驱产出、报告分列。
但 `taskDecomposer` 的四个确定性策略（编号列表 / 括号编号 / 并行标记 / 多文件）产出的
子任务**只有** `{prompt, role, originIndex}`、**没有** `dependencies`。唯一发
`dependencies` 的是 opt-in 的 LLM 策略（strategy 5，需 `KHY_LLM_DECOMPOSE` + 活模型），
而 arc 入口 `agenticHarnessService.decompose(...)` 调用时**不传** `deps.callModel`——
所以在**默认离机路径**（装完没有任何 key）strategy 5 从不触发，每个子任务到达
`planWaves` 时都零依赖边 → 恒单波 → **整条 083/087/091/092 arc 全程 no-op**，khy 仍是
「拍平抢跑」。本条新增**确定性顺序链拆解策略** `_splitSequentialChain`——识别显式顺序
标记（先…再…、然后、接着、之后、最后、首先、其次、基于上一步、then、after that、next、
finally）把消息拆成**有序步骤**，每步发 `dependencies: [<前一步 1-based 索引>]`，构成线性
链。这正是 `planWaves` 的 `_normalizeDeps` 一直在等的确定性 producer。

## 为什么需要它（真实缺口 = arc 的 producer 端总断桥）

**深挖缺陷（铁证 file:line，producer/consumer 断桥）：**

- **Consumer**：`services/backend/src/services/orchestrator/dependencyWaveScheduler.js`
  的 `planWaves`——它的头部注释（第 6-18 行）**亲口写明**这个缺口：
  "taskDecomposer's deterministic strategies emit only {prompt, role, originIndex}
  — no deps ... So the field `_llmDecomposer` spends tokens to produce has NO
  consumer"。`_normalizeDeps`（第 95 行）已接受 1-based 数字索引引用，只等一个
  producer 供给 `dependencies`。
- **缺失的 Producer**：`services/backend/src/services/taskDecomposer.js` 的四个确定性
  策略（`_splitNumberedList` / `_splitParenNumbering` / `_splitParallelMarkers` /
  `_splitMultiFileTargets`）**从不**发 `dependencies`。唯一发它的 `_llmDecomposer`
  在离机路径不触发（`agenticHarnessService.decompose` 无 `callModel`）。

**后果：** 在用户最关心的「pip/npm 装到别的电脑后完整地简单地还原」场景——**没有任何
LLM key** 的默认安装——`planWaves` 永远拿到零边 → 单波 → 前四发全部空转。用户说的「让
khy 自己拆任务、有序并行、最后把结果收回来」在默认路径上**从未真正发生过**。

**与前四发的区别（透镜一的 producer 端）：** 083/087/091 都收割同一段零调用者死代码
`subAgentOrchestrator.executeDependencyAware`（透镜二）；092 换透镜一，追一条字段到
**渲染层**的断桥。本条仍是透镜一，但追到**最上游**——一个 consumer（`planWaves`）等待的
字段若**没有任何确定性 producer 供给**，则该 consumer 及其整条下游 arc 在默认路径全程
no-op（比「有 producer 但中间某层丢弃」更隐蔽：happy-path 测全绿，因为 LLM 路径能触发；
但默认离机路径从不触发）。

## 单一真源与分层

- `_splitSequentialChain`（`taskDecomposer.js`）是唯一的**确定性** `dependencies`
  producer。它插入 `decompose` 的策略数组，位置**在 `_splitParenNumbering` 之后**
  （显式编号列表优先）、**在 `_splitParallelMarkers` 之前**（「先…再…」的顺序意图不能
  被误当成无序并行拆掉）。**既有四策略函数体、`decompose` 其余逻辑一字不改**，只在数组
  里加一项。
- 切分算法：以一个绝不会出现在用户消息里的 sentinel（` SEQ `）在每个 leading 连接词
  前插入边界，再 `split`——因此**英文消息不会被逐词打散**（若用裸空格 split，英文早有
  空格会碎成单词）。`先…再…` 对在两者都存在时被别名成 `首先/然后` 边界。
- 每步 `dependencies: i === 0 ? [] : [i]`（`[i]` = 前一步的 1-based 索引，被
  `_normalizeDeps` 认作 `t<i>`）——线性链，不构造 DAG（DAG 仍是 LLM strategy 5 的活）。
- 门 `KHY_SEQ_CHAIN_DECOMPOSE`（default-on）由 `_seqChainEnabled()` 函数式**每调用读
  一次**（便于测试注入 env、纯、绝不抛），**不进 flagRegistry**（同
  `KHY_DEP_WAVE_SCHEDULE` / `_FAULT_STOP` / `_CONTEXT_INJECT` / `KHY_MERGE_SKIP_DISTINCT`
  五门先例，各自独立）。

## 语义与保守降级（绝不误伤无顺序标记的消息）

| 情形 | 行为 |
| 门关 `KHY_SEQ_CHAIN_DECOMPOSE=0/false/off/no` | `_splitSequentialChain` 返回 null → 策略被跳过 → decompose 逐字节回退今日「四策略 / no_pattern」 |
| 门开 + 消息含顺序标记且切出 ≥2 步 | 产 `reason:'sequential_chain'`，每步带线性 `dependencies` |
| 门开 + 无顺序标记（如「修改登录逻辑」） | 返回 null（不误伤，落回其它策略） |
| 门开 + 并行标记（如「同时分析 A 和 B」） | 返回 null（`_splitParallelMarkers` 处理，不被顺序链抢） |
| 门开 + 仅单个 先/再（不成对、切不出 ≥2 步） | 返回 null（信号太弱） |
| 非字符串 / 空串 / 畸形输入 | 返回 null（纯、绝不抛） |

## 门与安全边界

- 门 `KHY_SEQ_CHAIN_DECOMPOSE` default-on，仅 `0/false/off/no` 关闭；关闭后
  `_splitSequentialChain` 返回 null，`decompose` 逐字节退化为今日行为（无回归）。
  sibling 门直读 env，**不进 flagRegistry**。六门（五个既有 + 本门）各自独立。
- **不碰** god-file / orchestrator / `AgentTool/index.js`；只编辑 `taskDecomposer.js`
  （加一个策略函数 + 策略数组插一项 + `ROLE_PATTERNS.explore` 补 `探索` 一词）+ 新测
  + 登记。`planWaves` / `_normalizeDeps` **本条不改**——只做它的确定性 producer。
- 触发仍受 `decompose` 上游 `_isComplexTask` 门槛约束（`agenticHarnessService` 的
  score/isComplex），本条不改该门槛，只在通过门槛后多一条确定性顺序策略。
- 诚实边界：只把「先…再…然后…」这类**显式顺序标记**的消息拆成链；无标记消息不误伤。
  不做语义级顺序推断（那是 LLM strategy 5 的活）。dev 机验证止于 node:test 门开/门关
  双路径 + 边界 + **与 `planWaves` 的端到端联通断言**（`waveCount===3`），不实跑多智能体
  端到端（需真子任务执行）。

## 怎么验证

```
npm run test:seq-chain-decompose        # 本条 node:test（门开链 + 门关回退 + 无误伤 + 端到端 planWaves 12/12）
npm run test:maintainer:safety          # 已并入的 must 守卫集（含本测文件）
```

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

1. 要教一类**新的顺序连接词**（如「紧接着」「其后」）：把它加进 `_SEQ_LEADING`、
   `_SEQ_PRESENCE`、`_SEQ_STRIP` 三个常量（若该词应从段首剥离则也加进 `_SEQ_STRIP`；
   若它自身携带语义应保留则**只**加进 `_SEQ_LEADING`/`_SEQ_PRESENCE`，仿 `基于上一步`）。
   保持纯、绝不抛、门关返回 null。加一条 node:test 覆盖新词。
2. 要改**链的依赖形状**（如让每步依赖**全部**前驱而非仅直接前一步）：改
   `_splitSequentialChain` 里 `dependencies: i === 0 ? [] : [i]` 一处。注意
   `_normalizeDeps` 接受数组，`[1,2,...,i]` 也合法；但线性链已足够让波次串行，且与
   `planWaves` 的 Kahn 分层精确匹配——除非有真实需求，别改成 DAG。
3. 要改**策略优先级**（本策略在数组中的位置）：改 `decompose` 的 `strategies` 数组
   顺序。铁律：顺序链必须在 `_splitParallelMarkers` **之前**（否则「先…再…」被误当并行
   拆掉、丢掉顺序），在显式编号策略**之后**（编号列表更具体）。
4. 改完跑 `npm run test:seq-chain-decompose`（必须绿）。

## 红线

- 不自动 commit/push；真 key/token 不进包、不落盘。
- 全 additive；既有四策略函数体逐字节不变；门关（`KHY_SEQ_CHAIN_DECOMPOSE=off`）→
  `_splitSequentialChain` 返回 null → 策略被跳过 = 逐字节回退今日行为。
