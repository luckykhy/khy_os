<!-- 文档分类: DESIGN-ARCH-002 | 阶段: 设计 | 原路径: docs/架构/Khyos-CB-SSP-数学建模与实现映射.md -->
# Khyos CB-SSP 数学建模与实现映射（落地规格）

> 配套文档：
> - 设计意图 → [`Khyos-数学重塑-受约束随机最短路径.md`](%5BDESIGN-ARCH-003%5D%20Khyos-数学重塑-受约束随机最短路径.md)（"为什么这样设计"）
> - 实施进度 → [`_cbssp_progress.md`](%5BDESIGN-ARCH-004%5D%20_cbssp_progress.md)（B→A→C→D 落地记录）
>
> 本文档是**落地后的形式化规格**："系统现在是什么数学对象、每个构件满足什么性质、
> 哪条测试证明了哪条性质、性质对应哪段代码"。设计文档讲动机，本文档讲**契约与证明**。
> 所有符号沿用设计文档 §1。代码锚点以 `services/backend/src/services/` 为根。

---

## 0. 一页纸总览

Khyos agent 被建模为 belief-POMDP 上的**受约束·有预算·随机最短路径（CB-SSP）**问题：

$$
\boxed{\;\pi^\* = \arg\min_{\pi}\; \mathbb{E}\!\left[\sum_{t=0}^{T} g(s_t,a_t,s_{t+1}) + \Phi(s_T)\right]\;}
\quad\text{s.t.}\quad a_t\in A(s_t),\; r_T\preceq R_\text{max},\; \mathrm{Verify}(s_T)=\text{PASS}
$$

四项落地把"散落的正确零件"装进同一台求解器，全部为**加性黏合剂**（不推倒核心文件）：

| 阶段 | 数学对象 | 核心性质 | 模块 | 测试 |
|---|---|---|---|---|
| **B** | 启发式 $h(s)$ | 可采纳性（admissibility）| `heuristic.js` | `heuristic.test.js` (16) |
| **A** | LRTA\* 价值回填 + 可逆性分层 | 跨试验单调不增；不可逆绝不投机 | `lrtaBackfill.js` / `reversibility.js` | (13)+(15) |
| **C** | 统一资源-代价调度 | UCB1 次线性 regret；P2C Θ(ln ln N)；抢占透明性；退避等价 | `ucbRouter.js` / `accountSelector.js` / `workflowExecutor.js` / `circuitBreaker.js` | (11)+(13)+(15)+(全绿) |
| **D** | 约束格 $\langle\{\bot,\text{SOFT},\top\},\sqsubseteq\rangle$ + $\Pi_{\mathcal C}$ | 红线不可约束；活性 $A(s)\neq\varnothing$ | `constraintLattice.js` | `constraintLattice.test.js` (30) + glue (8) |

**统一性论断**：四阶段都把各自的局部度量折进同一个标量 $J$——规划用 $h$ 下估 $J$ 的剩余、
调度用 $g$ 的资源分量选臂、约束格用 $\lambda_\text{human}$ 把人审代价计入 $g$、验收用 $\Phi$ 封顶。
三子系统第一次对着同一个 $J$ 优化（消除设计文档 §3.3 的"最深病灶"）。

---

## 1. 状态空间与符号总表

| 符号 | 含义 | 落地载体 |
|---|---|---|
| $s=(h,b,r,c)$ | 状态 = (历史, 信念, 资源向量, 约束) | boulderState（SQLite + 快照）外化 $s$ |
| $A(s)=A_\text{full}\cap \mathrm{Feasible}(s)$ | 可行动作集；分层 $A_\text{safe}\cup A_\text{commit}$ | toolProfile 白名单 + executeTool 漏斗 |
| $g(s,a,s')$ | 单步代价 = $\lambda_\text{time}\Delta t+\lambda_\text{tok}\Delta\text{tok}+\lambda_\$\Delta\$+\lambda_\text{risk}\mathrm{Risk}+\lambda_\text{irrev}\mathrm{Irrev}$ | 各 $\lambda$ 为 env 旋钮 |
| $\Phi(s_T)$ | 终端势：已验证则 $0$，否则未满足验收项数 × 大常数 | buildAcceptancePack |
| $h(s)$ | 到目标的代价-去估计（启发式，可采纳下估）| `heuristic.js`（阶段 B） |
| $H_k(s)$ | 第 $k$ 次试验学到的回填启发值 | `lrtaBackfill.js`（阶段 A） |
| $\Pi_{\mathcal C}$ | 约束投影算子：裁剪 $A_\text{full}\to A(s)$ | `constraintLattice.js`（阶段 D） |

零硬编码原则：所有阈值/权重/时间片/格位经 **env + 命名常量默认值**，默认值与旧行为逐点等价。

---

## 2. 阶段 B —— 启发式 $h(s)$（§4.B）

**定义.** 给定验收包谓词集 $\mathcal P=\mathcal P_\text{req}\cup\mathcal P_\text{opt}$，未满足必需项数 $u_\text{req}$、
未满足可选项数 $u_\text{opt}$，单项代价 $\kappa$（`KHY_HEURISTIC_COST_PER_CRITERION`）：

$$
h(s) = \kappa\, u_\text{req}, \qquad
h_\text{stall}(s) = \kappa\,(u_\text{req} + w_\text{opt}\, u_\text{opt})
$$

**命题 B.1（可采纳性）.** $h(s)\le h^\*(s)$，其中 $h^\*$ 为到目标的真实最小剩余代价。
*证明要点*：每个未满足必需谓词至少需要一个使其为真的动作，单动作代价 $\ge\kappa$ 的保守下界 ⇒ $h$ 不高估。
**测试**：`heuristic.test.js` 断言 $h\le$ 真实剩余、$h=0\iff$ 全部满足、满足一项 $h$ 严格下降。

**命题 B.2（停滞检测）.** 若 $h_\text{stall}$ 在一轮内未严格下降且仍有剩余，`shouldCalibrate` 触发只读校准。
*意义*：把"走偏要到终点才发现"（设计文档 §3.1 belief–goal 鸿沟）提前到中途。

**接入**：`agenticHarnessService._attachHeuristic()` 仅作**附加遥测**，零控制流改动，
env 门 `KHY_HEURISTIC_ENABLED` 默认开。

---

## 3. 阶段 A —— 可逆性分层 LRTA\*（§4.A）

### 3.1 价值回填

**定义.** 第 $k$ 次试验后，对访问状态回填运行最小值：

$$
H_k(s) = \min\big(H_{k-1}(s),\; g_k(s) + h_k(s)\big), \qquad
g_k = w_\text{step}\cdot(\text{本轮迭代数})\ \ge 0
$$

**命题 A.1（跨试验单调不增）.** $\forall k:\; H_k(s)\le H_{k-1}(s)$。
*证明*：取运行最小值 ⇒ 逐点不增；$g_k\ge0$ 不破坏下估方向。这把 Ralph 的**盲目重启**变成
**学习重启**（learning restart）：第 $k$ 轮失败的教训经 $H$ 传给第 $k{+}1$ 轮。
**测试**：`lrtaBackfill.test.js` 断言 min 公式、跨 trial 单调、sidecar 持久化往返。

**持久化**：隔离 sidecar `<dataHome>/boulder/lrta/<cwdHash>.json`，**不动 checkpoint schema**，
下一 trial/会话热启动（`_seedLearnedHeuristic`）。env 门 `KHY_LRTA_ENABLED` 默认开，best-effort。

> **锚点修正**（已核实）：设计文档写"在 Ralph 环（:365）回填"，实测 $h(s)$ 只在有 delivery
> gate 信号的 **remediation 试验环**（~:487）可观测，故回填落此环——它正是 §2.2 两 trial 环之一。

### 3.2 可逆性分层执行

**定义.** $\mathrm{classify}(a)=\text{safe}$（只读且非破坏）$\mid \text{commit}$（其余，含未知，保守）。
投机前瞻 $\mathrm{Lookahead}_k$ 只在 $A_\text{safe}$ 上展开，束宽 $k\le 3$（`KHY_LOOKAHEAD_WIDTH` clamp $[0,3]$）。

**命题 A.2（不可逆绝不投机）.** 若 `traceContext.speculative=true` 则任何 commit 动作在权限/执行**之前**
被硬拒。*意义*：信念不足时绝不 commit（堵住设计文档 §3.1"最危险的缺口"）；前瞻只产生只读代价 ⇒
**预算守恒**。fail-closed：守卫不可用则拒绝投机。默认（非投机）路径零回归。
**测试**：`reversibility.test.js` 断言投机 commit 在 handler 前被拒（handler 未调用）、真只读工具放行。

---

## 4. 阶段 C —— 统一资源-代价调度（§4.C）

一个资源-代价模型治三层；内核 RR（`sched.c`，全系统最干净的数学）作为纪律范本上提。

### 4.1 C-1 适配器路由 UCB1

$$
a^\* = \arg\max_a\Big[\hat\mu_a + c\sqrt{\tfrac{2\ln N}{n_a}} - \mathrm{cooldownDamp}_a\Big],
\qquad r = \text{success}\,?\,\mathrm{speed}(\text{latency}) : 0 \in[0,1]
$$

**命题 C.1（次线性 regret）.** UCB1 的累计 regret $R(T)=O(\ln T)$ ⇒ $R(T)/T\to 0$。
**测试**：`ucbRouter.test.js` 用 3 臂 Bernoulli + LCG 确定性，断言 $R(T)/T$ 随 $T$ 严格下降、
最优臂占比 >70%、远低于线性界。**默认关**（`KHY_UCB_ROUTING`），开启时只**重排** eligible 不动可选集 ⇒ 零回归。

### 4.2 C-2 账号池真均衡（P2C）

**定义.** $\mathrm{loadKey}(a)=$ 使用近度（`last_used_at`）；`selectPowerOfTwo` 抽 2 取较闲。

**命题 C.2（最大负载界）.** Power-of-two-choices 把最大负载从随机分配的 $\Theta(\tfrac{\ln N}{\ln\ln N})$
降到 $\Theta(\ln\ln N)$。**测试**：`accountSelector.test.js` 断言 LRU 重复选择=完美轮转（$\max-\min\le1$）、
P2C 最大负载 $<1.25\cdot(T/N)$ 且显著低于均匀随机。纠正了 `'Balance'` 名实不符（旧实为粘性 MRU）。

### 4.3 C-3 工作流 quantum 抢占

**定义.** 单游标解释器每执行 $Q$ 个节点让出耐久检查点 $\{\text{paused},\text{pause}:\{\text{kind:quantum},\text{nodeId},\text{loopState}\}\}$，
让出点指向**下一待执行节点**。

**命题 C.3（抢占透明性）.** 对任意 $Q$，跨任意让出/恢复序列，最终 vars、节点执行序列、log 与
不间断运行**逐一相同**。*证明要点*：让出只持久化游标与 loopState，不改变转移函数；`isQuantumResume`
区分 answer-resume（注入并跳过）与 quantum-resume（仅定位游标、正常执行），避免幻影答案。
**测试**：`workflowExecutor.quantum.test.js`（$Q\in\{1,2,3,5,7,100\}$ 逐一等价）+ 跨进程恢复。
**ready-queue 公平**：让出的 run `updatedAt` 刷新沉队尾（quantum 开启时 `ORDER BY updatedAt ASC`），
关闭时保持 `id ASC` FIFO ⇒ 默认零行为变更。

### 4.4 C-4 统一断路器

**定义.** 唯一真源纯函数 $\mathrm{backoff}(\text{base},\text{attempt},m,\text{cap},N)=\min(\text{cap},\,\text{base}\cdot m^{\mathrm{clamp}(\text{attempt},0,N)})$。

**命题 C.4（零回归等价）.** 该式对 aiGateway 三处旧内联指数退避公式在**全输入域逐点等价**。
**测试**：`circuitBreakerBackoff.test.js` 对三条旧公式全输入域逐点等价 + cap/步数饱和。消双实现。

---

## 5. 阶段 D —— 约束格形式化（§4.D）

把设计文档 §2.3 已实现但**散落为 if 分支**的 $\Pi_{\mathcal C}$ 提升为命名的代数结构。

### 5.1 格定义

三元有限全序格 $\mathcal L=\langle\{\bot,\text{SOFT},\top\},\sqsubseteq\rangle$，秩 $\mathrm{rank}(\bot)=0<\mathrm{rank}(\text{SOFT})=1<\mathrm{rank}(\top)=2$：

$$
\bot\ \text{（红线，不可行且不可约束）}\ \sqsubseteq\ \text{SOFT（可审批）}\ \sqsubseteq\ \top\ \text{（可行）}
$$

$a\sqsubseteq b \iff \mathrm{rank}(a)\le\mathrm{rank}(b)$；$\sqcup=\max_\text{rank}$（lub），$\sqcap=\min_\text{rank}$（glb）。
全序 ⇒ 自动满足偏序三公理与格公理。**测试**：`constraintLattice.test.js` 断言自反/反对称/传递、
链 $\bot\sqsubset\text{SOFT}\sqsubset\top$、join/meet=lub/glb。

### 5.2 分类（黄金回归既有契约）

两层分类，单一真源：

- **声明天花板** $\mathrm{pos}_\text{src}(\text{source})$：pathTraversal / rateLimit / ssrf / loop-dedup guardrail /
  critical-destructive $\mapsto\bot$；editBoundary / priorRead / fileStale $\mapsto\text{SOFT}$。
  env `KHY_LATTICE_REDLINE_SOURCES` **仅可追加**红线（紧化，永不降级）。
- **运行态** $\mathrm{pos}(g)$：$\text{allow}\mapsto\top$；$\text{block}\wedge\text{approvable}\mapsto\text{SOFT}$，
  **但声明红线源恒 $\bot$**（防误设 approvable 提权，纵深防御）；其余 $\text{block}\mapsto\bot$。

**命题 D.1（黄金回归）.** $\mathrm{pos}$ 对每个既有 guard 结果的分类**逐一复现**当前 `approvable` 契约
（含 editBoundary 的 sensitive-home-write 块无 approvable $\mapsto\bot$ 的旁路）。
*意义*：把"硬守卫永不设 approvable"这条**隐式注释契约**变成**强制可测的代数命题**——
任一 guard 改变其 approvable 发射，测试即报警（tripwire）。

### 5.3 松弛算子（guardApproval = $\lambda$）

$$
\mathrm{relax}(x,\text{approved}) =
\begin{cases}
\top & x=\text{SOFT}\wedge\text{approved}\\
x & \text{otherwise}
\end{cases}
$$

**命题 D.2（红线不可约束 / 不动点）.** $\mathrm{relax}(\bot,\cdot)=\bot$ 对任意审批。
即 $\bot$ 是 $\mathrm{relax}$ 的**不动点**——没有任何人工审批能把红线提升回 $A(s)$。
**命题 D.3（单调 + 幂等）.** $x\sqsubseteq\mathrm{relax}(x,\cdot)$（只升不降）且 $\mathrm{relax}\circ\mathrm{relax}=\mathrm{relax}$。
SOFT 经审批升 $\top$ 的代价 $\lambda_\text{human}$ 折入 $g$（中断成本），与 §1.5 的 $\lambda_\text{irrev}$ 同源。
**测试**：`constraintLattice.test.js` 断言 $\mathrm{relax}(\bot,\text{approved})=\bot$、误设 approvable 仍 $\bot$、
单调、幂等。**强制黏合**：`guardApproval.requestGuardApproval` 入口 `isRedLineSource` 为真直接拒——
红线即便交互通道同意也**不弹窗**（`guardApproval.test.js` GA-8：通道从未被触达）。

### 5.4 活性投影 $\Pi_{\mathcal C}$

**命题 D.4（活性 $A(s)\neq\varnothing$）.** 格顶恒含逃逸地板 $F=\{\texttt{ask\_user},\texttt{abort}\}$
（env `KHY_LIVENESS_FALLBACK` 可扩展），$\Pi_{\mathcal C}$ 保证

$$
\Pi_{\mathcal C}(A_\text{full})(s) = \big(A_\text{full}\cap\mathrm{Feasible}(s)\big)\cup\big[\,\text{若裁空则}\ F\,\big]\neq\varnothing
$$

*填补设计文档 §3.1 的活性缺口*：权限不足导致 $A(s)$ 变空时不再是"未定义挂起"，而是合法的
"询问/中止"终态。**实现锚点**：唯一会把 $A(s)$ 裁空的两处逐调用谓词
`toolCalling._checkToolPolicy`（blocklist+allowlist）与 `_checkActiveSkillPolicy`，
返回 block 前过 `feasibleUnderPolicy` ⇒ 逃逸地板穿透任何 allow/block/skill 名单。
**测试**：`constraintLattice.test.js`（`ensureLiveness` 永非空）+ `toolPolicyLiveness.test.js`
（地板穿透三类名单、env 可扩展）。

---

## 6. 全局一致性：单一 $J$ 中枢（逐条闭合 §3.3 病灶）

| 设计文档 §3.3 病灶 | 落地闭合 |
|---|---|
| 三子系统不共享 $J$ | $h$（B）下估 $J$ 剩余、$g$ 资源分量（C）选臂、$\lambda_\text{human}$（D）计入 $g$、$\Phi$ 封顶——同一 $J$ |
| 验收只当裁判不当指南 | $h(s)=$ 未满足验收项代价 ⇒ acceptance pack **既是考纲又是裁判**（B.1 + B.2 中途校准）|
| 适配器局部省钱全局暴涨 | UCB1 回报含 speed ⇒ 臂估计耦合"达成验收的真实速度"，不再只看可用性罚分（C.1）|
| 两套断路器 | `computeBackoffMs` 唯一真源，消内联双实现（C.4）|
| `'Balance'` 名实不符 | P2C 真均衡（C.2）|
| $A(s)$ 可空（活性）| $\Pi_{\mathcal C}$ 保证 $A(s)\neq\varnothing$（D.4）|

**一句话**：规划（$h/H$）、调度（$g$ 资源分量）、反思/约束（$\Phi$、约束格、$\lambda_\text{human}$）
现在都对着同一个 $J$ 说话——这正是设计文档 §1.5 那个 $\pi^\*$ 要求的全局代价中枢。

---

## 7. 边界与诚实的局限（未接入项）

- 新增模块均 **env 门控 + 默认安全**（默认值与旧行为逐点等价），best-effort 出错回退原行为。
- 投机前瞻（A.2 的 $\mathrm{Lookahead}_k$）目前仅落地**结构保证**（不可逆绝不投机），
  尚**未接入主循环的前瞻驱动**——lookahead 驱动决策可作后续可灰度增量。
- LRTA\* 收敛性（多 trial → 最优）依赖 $h$ 可采纳 + $g$ 非负两前提，二者已测；
  但真实 LLM 转移的随机性使"有限试验内收敛"为经验性而非最坏情形保证。
- 出站网络隔离等 OS 级沙箱约束不在本格内（属内核/容器层），约束格只覆盖工具层六维守卫。

---

## 附：测试即证明索引

| 命题 | 测试文件 | 关键断言 |
|---|---|---|
| B.1 可采纳性 | `heuristic.test.js` | $h\le$ 真实剩余、单调、$h=0\iff$ goal |
| A.1 单调不增 | `lrtaBackfill.test.js` | $H_k\le H_{k-1}$、持久化往返 |
| A.2 不投机 | `reversibility.test.js` | 投机 commit 在 handler 前被拒 |
| C.1 次线性 regret | `ucbRouter.test.js` | $R(T)/T\downarrow$、最优臂 >70% |
| C.2 Θ(ln ln N) | `accountSelector.test.js` | 轮转 $\max-\min\le1$、P2C $<$ 均匀随机 |
| C.3 抢占透明 | `workflowExecutor.quantum.test.js` (+worker) | $Q$ 任意值逐一等价 + 跨进程恢复 |
| C.4 退避等价 | `circuitBreakerBackoff.test.js` | 三旧公式全输入域逐点等价 |
| D.1 黄金回归 | `constraintLattice.test.js` | 每 guard 结果分类复现 approvable 契约 |
| D.2 红线不可约束 | `constraintLattice.test.js` + `guardApproval.test.js` GA-8 | $\mathrm{relax}(\bot)=\bot$、红线不弹窗 |
| D.3 单调幂等 | `constraintLattice.test.js` | 单调、幂等 |
| D.4 活性 | `constraintLattice.test.js` + `toolPolicyLiveness.test.js` | $A(s)\neq\varnothing$、地板穿透名单 |
