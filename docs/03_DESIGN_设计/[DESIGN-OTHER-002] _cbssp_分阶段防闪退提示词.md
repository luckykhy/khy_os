<!-- 文档分类: DESIGN-OTHER-002 | 阶段: 设计 | 原路径: docs/指南/_cbssp_分阶段防闪退提示词.md -->
# Khyos CB-SSP 重塑 · 分阶段防闪退提示词

> 配套设计文档：[`docs/03_DESIGN_设计/[DESIGN-ARCH-003] Khyos-数学重塑-受约束随机最短路径.md`](%5BDESIGN-ARCH-003%5D%20Khyos-数学重塑-受约束随机最短路径.md)
> 原始提示词链：[`docs/03_DESIGN_设计/[DESIGN-OTHER-001] Khyos-数学重塑-实施提示词链.md`](%5BDESIGN-OTHER-001%5D%20Khyos-数学重塑-实施提示词链.md)
> 日期：2026-06-11

## 为什么要这份文档

原 `/goal` 一键指令把 B→A→C→D 四阶段塞进**一次自主会话**，每阶段还反复跑全量回归套件。
单轮上下文只增不减，几百次工具调用 + 成千行测试输出灌入 → 上下文/内存峰值爆掉，Claude 闪退。

**修法**：拆成**四次独立会话**，每阶段一进一出、各自落盘提交；读重活外包子 agent，测试只看摘要。

> ⚠️ 单靠提示词"劝模型自律"修不住闪退：`Read 全文` 和 `Bash stdout` 是**无条件**进上下文的——
> 等模型读到"请克制"那句，几千行测试输出/上万行源码早已灌进上下文。所以防线必须**下沉到命令层物理拦截**：
> 用 `npm run test:summary`（全量 stdout 落盘 `.cbssp-test.log`，只回吐摘要）替代直接 `npm test`，
> 用 `grep -n` 锚点 + Read 切片替代整文件 Read。下面【公共引导块】已把这两条写成硬约束。

## 用法

- **每个阶段开一个全新的 Claude 会话**（防闪退的根本）。
- 每次先贴【公共引导块】，再贴对应阶段提示词。
- 阶段做完会写 `docs/03_DESIGN_设计/[DESIGN-ARCH-004] _cbssp_progress.md` 进度文件并 git 提交，下个会话靠它续接。
- 顺序锁死 **B→A→C→D**（设计文档 §6 已论证第一刀必须是零回归的 §4.B）。

---

## 【公共引导块】（每个阶段都先贴这段）

```text
项目：Khyos CB-SSP 数学架构重塑。
设计文档：docs/03_DESIGN_设计/[DESIGN-ARCH-003] Khyos-数学重塑-受约束随机最短路径.md
验收/提示词链：docs/03_DESIGN_设计/[DESIGN-OTHER-001] Khyos-数学重塑-实施提示词链.md

防闪退硬约束（必须遵守，按字面执行）：
- 本会话只做"当前这一个阶段"，做完即停，不要顺手往下个阶段做。
- 测试只准走摘要命令：在 services/backend 下一律用
    npm run test:summary              # 全量回归（jest + node:test）
    npm run test:summary -- <路径>     # 迭代期只跑相关套件，例：-- tests/toolUseLoop
  它把完整 stdout 落盘到 .cbssp-test.log，只回吐"通过/失败数 + 失败用例名"。
  严禁直接跑 `npm test` / `npm run test:all` / `jest` / `node --test`——它们会把
  上千行 stdout 灌进上下文，这正是闪退根因。要看某个失败细节，去 `grep` 那一行
  .cbssp-test.log 或单独重跑那一个失败文件，别把全量日志读回来。
  迭代期只跑相关套件，全量回归只在本阶段收尾跑一次。
- 大文件只读切片，禁止整文件 Read：toolUseLoop.js(6324 行)/aiGateway.js(5839 行)/
  agenticHarnessService.js 等，先 `grep -n <锚点>` 定位，再用 Read 的 offset/limit
  只读命中行 ±40 行；需要大范围理解时才用 Explore 子 agent 去读并只回结论，
  绝不把整文件拉进主上下文。
- 改大文件用 Edit 精确替换，不要整文件 Write 重贴。
- 先读后改：动文件前先读切片，核对文档行号锚点是否漂移，漂移就用真实位置。

工程铁律（违反即停并报告，不准粉饰）：
1. 不推倒重来：每步接在现有零件上（设计文档 §6 映射表），禁止重写
   toolUseLoop.js / aiGateway.js / workflowExecutor.js 或新建平行子系统。
2. 零硬编码：所有阈值/权重/quantum 走 env + 默认常量；状态透明，新决策点可日志。

放行闸：本阶段单元测试断言其数学性质 + 既有回归套件（用 `npm run test:summary`），
全绿才算完成。红了就停下修；修不好就报告卡点，不要绕过。

续接：开工前先读 docs/03_DESIGN_设计/[DESIGN-ARCH-004] _cbssp_progress.md（若存在）确认上一阶段状态。
收尾：本阶段全绿后，把"阶段名 + diff 摘要 + 测试结果 + 一句话数学意义"
追加写入 docs/03_DESIGN_设计/[DESIGN-ARCH-004] _cbssp_progress.md，并 git 提交本阶段改动，然后停下等我。
```

---

## 阶段 B（第 1 个会话）— §4.B 验收包做启发 h(s)

> 第一刀，纯增量、零回归。让验收标准从"终点裁判"变成"全程指南"，消灭三子系统不共享目标的一致性病灶。

```text
【阶段 B】= 设计文档 §4.B「用验收包做启发 h(s)」。第一刀，纯增量、零回归。

§6 映射（复用→补黏合剂）：
- 复用 buildAcceptancePack / acceptanceCriteria.js 已枚举的验收谓词 {φ_i}。
- 补：把"未满足验收项数→代价估计"，定义 h(s)=Σ_{未满足 φ_i} ĉ(φ_i)，
  ĉ 取极保守下估（每项≥1 个动作），暴露给规划层。

本阶段目标：
- 把 h(s) 暴露给规划层与外层 harness：不再只在终点跑 delivery gate，全程可读 h(s)；
  当 h(s) 停滞或上升时，触发一次只读 verify（廉价 A_safe 测量）校准信念。
- 纯增量，不改变现有决策默认路径，feature 走灰度开关（env）。

必须断言的数学性质（写成单元测试，不靠"看起来对"）：
- 可采纳性：对任意状态 h(s) ≤ 真实到目标剩余代价（构造测试验证下估）。
- 单调性：满足一项验收后 h 严格下降；h(s)=0 当且仅当 gate PASS。
- 零回归：现有 toolUseLoop / agenticHarnessService 测试套件全绿。

先核对锚点：buildAcceptancePack 与 acceptanceCriteria.js 现位置、delivery gate
调用点是否漂移；漂移就报告真实位置再动手。
按【公共引导块】的放行闸与收尾流程执行。
```

---

## 阶段 A（第 2 个会话）— §4.A 可逆性分层 LRTA*

> 核心洞察：Ralph 续轮环已是 LRTA* 外层试验环，只差价值回填。前置：阶段 B 的 h(s) 已合入。

```text
【阶段 A】= 设计文档 §4.A「可逆性分层 LRTA*」。前置：阶段 B 的 h(s) 已合入（见进度文件）。
核心洞察：Ralph 续轮环已是 LRTA* 外层试验环，只差价值回填。

§6 映射（复用→补黏合剂）：
- 复用 agenticHarnessService.js:365 的 Ralph 续轮环 + boulderState SQLite。
  补：每轮结束回填 h(s) ← min_a [ g(s,a) + h(T(s,a)) ]，持久化到 boulder.db。
  把"不学习的 restart"升级为"收敛的 learning restart"。绝不新建循环。
- 复用工具元数据 isReadOnly/isDestructive。
  补：在 executeTool 入口（toolCalling.js:2299）按可逆性分层路由：
  · A_safe（只读/可逆）：允许有界前瞻/beam（宽度 k≤3，env 可调）锐化信念 b；
  · A_commit（不可逆）：禁止投机分支，一步最优承诺 a*=argmin_a[g+h(s')]，
    高 Irrev 强制 plan-then-confirm（复用现有 requestPermission，不新建审批通道）。

必须断言的数学性质：
- 收敛/单调：跨 trial 价值回填使 h 单调不增（同实例第 k+1 轮 ≤ 第 k 轮）。
- 分层正确：只读动作才进入前瞻分支；任何不可逆动作绝不被投机执行（写反例测试）。
- 预算守恒：前瞻只产生只读代价，IterationBudget(toolUseLoop.js:96) 的不可逆步数
  不被前瞻消耗。

先核对锚点：agenticHarnessService.js:365、toolCalling.js:2299 的 executeTool 入口、
boulderState.js:32/:125 持久化接口是否漂移。
按【公共引导块】的放行闸与收尾流程执行。
```

---

## 阶段 C（第 3 个会话）— §4.C 调度统一

> C-3 抢占工作流改动最大，放最后。**每个子项做完单独跑测试、单独写进度文件再进下一子项**（也防上下文堆积闪退）。

```text
【阶段 C】= 设计文档 §4.C「调度统一」。前置：B、A 已绿。按子项顺序，逐项独立验收：

C-1 适配器路由（aiGateway.js:2115）：把 score=basePriority×10+Σpenalty 换成 UCB1：
    select argmax_a [ μ̂_a(成功率×速度) + sqrt(2·lnN/n_a) ]，cooldown 并入探索项；
    保留 failoverOrderStore 作为先验初值注入 μ̂_a。
C-4 统一断路器：废弃 aiGateway 内联指数退避，全栈改用 circuitBreaker.js 三态机
    (CLOSED/OPEN/HALF_OPEN)，消除双实现并存。
C-2 账号池（accountPool.js:3121）：把粘性 MRU(ORDER BY last_used_at DESC) 改成
    真负载均衡（true LRU 或 power-of-two-choices），兑现 'Balance' 名称。
C-3 工作流抢占（workflowRunWorker.js:116）：给 worker 一个 quantum（每 N 步经
    boulderState 落盘检查点即让出），引入 ready-queue + 抢占，避免长 run 饿死短 run。

必须断言的数学性质：
- C-1：UCB1 选择公式正确；长期 regret 随 N 次调用次线性增长（统计测试）。
- C-2：负载在账号间收敛均衡（非粘性热点）。
- C-3：run 到达 quantum 必让出；让出后可跨进程从检查点精确恢复。
- 全程零魔数：所有权重/阈值/quantum 走 env + 默认常量。

先核对锚点：aiGateway.js:2115、accountPool.js:3121、workflowRunWorker.js:116、
circuitBreaker.js 三态机现有接口是否漂移。
按【公共引导块】的放行闸与收尾流程执行（每子项独立贴测试摘要 + 独立提交）。
```

---

## 阶段 D（第 4 个会话）— §4.D 约束格

> 触各 guard，回归风险较高。

```text
【阶段 D】= 设计文档 §4.D「约束格」。前置：B、A、C 已绿。触各 guard，回归风险较高。

§6 映射（复用→补黏合剂）：
- 复用六维 guards + guardApproval。补：给每个 guard 标注它在格中的位置。
- 把"硬拒/可审批/放行"形式化为偏序格：
  ⊥(红线: pathTraversal/SSRF/critical-destructive，恒不可行，审批不可松弛)
  ⊏ soft(editBoundary/priorRead/fileStale，guardApproval 是向上松弛算子，代价 λ_human)
  ⊏ ⊤(恒可行)。
- 约束投影 Π_C 据格位统一裁剪 A(s)；保证 A(s) 永不为空：格顶恒含
  ask_user / abort_with_reason（补 §3.1 活性缺口）。

必须断言的数学性质：
- 活性：任意状态下 A(s) 非空（构造权限全拒场景，验证仍有 ask/abort 可选）。
- 红线不可松弛：⊥ 元经 guardApproval 仍被拒（写反例测试）。
- 等价性：重构后对既有用例的拦截/放行结果与重构前完全一致（黄金回归）。

先核对锚点：六维 guards 与 guardApproval 在 executeTool(toolCalling.js:2299) 路径上的
施加点是否漂移。
按【公共引导块】的放行闸与收尾流程执行。
全部四阶段绿后输出总览：四阶段 diff 摘要 + 测试结果 + 一句话说明本次改动如何让
规划/调度/反思服从同一个目标 J（π*=argmin J）。
```

---

## 阶段验收速查表

| 阶段 | 对应 §4.X | 一句话目标 | 核心断言 | 回归风险 |
|---|---|---|---|---|
| B | §4.B | 验收包做启发 h(s)，统一目标 | 可采纳 + 单调 + 零回归 | 极低（纯增量） |
| A | §4.A | Ralph 环价值回填 + 可逆性分层 | 跨 trial 单调收敛；不可逆不投机 | 中（触 executeTool） |
| C | §4.C | UCB 路由/真均衡账号/抢占/单断路器 | regret 次线性；让出可恢复；零魔数 | 中（gateway 隔离可灰度） |
| D | §4.D | 约束格形式化 | 活性 A(s)≠∅；红线不可松弛；黄金回归 | 较高（触各 guard） |
