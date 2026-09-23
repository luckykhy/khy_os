<!-- 文档分类: DESIGN-ARCH-003 | 阶段: 设计 | 原路径: docs/架构/Khyos-数学重塑-受约束随机最短路径.md -->
# Khyos 架构重塑：作为「受约束·有预算·随机最短路径求解器」的全局最优设计

> 文档性质：首席科学家级架构设计文档（数学本质 → 现状重述 → 批判审查 → 全局最优重构 → 落地映射）
> 范围：用户态智能体（`services/backend/src` 的 agent loop / 工具 / 调度 / 反思）为主，自研 C 内核（`kernel/src`）为对照与上提范式来源
> 日期：2026-06-11

---

## 0. 核心论断（TL;DR）

把 Khyos 一切表象（ReAct 循环、16 适配器、循环检测器、目标模式、Ralph 续轮、交付门）剥到底，它在数学上是**同一个问题的一个退化解**：

> **在部分可观测、随机转移、带硬约束、带资源预算的状态空间中，寻找一条从初始状态到「可验证目标状态」的最小代价路径。**
> 即一个 **Constrained, Budgeted, Stochastic Shortest-Path（受约束·有预算·随机最短路径，下称 CB-SSP）** 问题，定义在**信念状态（belief state）**之上的 POMDP。

而 Khyos 当前对这个问题的求解，是它的**最弱形式**：

| 维度 | CB-SSP 应有的结构 | Khyos 现状 | 退化代价 |
|---|---|---|---|
| 策略 | 价值引导的最优策略 π* | **单步贪心采样** `a ~ LLM(·\|s)`，无价值函数、无前瞻 | 陷局部最优，只能盲目重试逃逸 |
| 搜索 | 带 visited 集 + 代价单调的 best-first | **纯线性前向链**，无 frontier / 无回溯 | 需 10 个检测器手工补「防环」 |
| 重试 | 收敛的迭代加深（价值回填） | **固定次数盲目重跑**（Ralph ≤3、remediation ≤3） | 重试不学习，不保证逼近最优 |
| 目标 | 单一全局代价函数 J，三子系统共享 | **规划/调度/反思各优化各的**，无共享 J | 局部优化损害全局（见 §4.3） |
| 调度 | 统一资源-代价模型 | **两套范式拼接**（内核干净 RR ╱ 用户态 ad-hoc 罚分） | 魔数遍地、名实不符、双断路器并存 |

**本文论证：只要把这五个退化项还原成 CB-SSP 的正则结构，绝大多数现有组件不必推倒——它们恰好是新模型缺了「黏合剂」的零件。** 最关键的发现是：**Ralph 续轮环在结构上已经是 LRTA\*（实时学习 A\*）的外层试验环，只差一个价值回填步骤**；补上它，盲目重试当场变成可证明收敛的学习式搜索，几乎零额外成本。

---

## 1. 第一性原理：Khyos 的数学本质

### 1.1 为什么是 POMDP 而不是普通图搜索

一个"能安全高效完成系统操作任务的智能体"，其根本困难不在于"动作多"，而在于**它看不见真实世界**。真实世界状态

$$
w \in W = (\text{文件系统} \times \text{进程表} \times \text{网络} \times \text{内存} \times \dots)
$$

是巨大且**不可直接观测**的。智能体唯一的世界信息来自工具调用的**返回值（观测）**。因此它真正持有并操作的，是一个**信念状态**而非世界状态。这把问题从"在 $W$ 上找路径"升格为"在信念空间上做决策"——一个 **POMDP**。

> 这一点不是学究式区分，而是直接解释了 Khyos 为什么会自发演化出 `verificationAgent.adversarialVerify()`（`verificationAgent.js:373`）：目标谓词 `Goal(w)` 定义在**真实世界 $w$** 上，而智能体只有**信念 $b$**；二者之间的鸿沟（belief–goal gap）必须靠一次**重新观测**来坍缩——派一个只读 agent 重新读世界、强制吐 `VERDICT: PASS/FAIL`，本质是 POMDP 里的**测量算子**。Khyos 已经摸到了正确的数学，只是没有把它命名、没有把它纳入统一框架。

### 1.2 状态（State）

定义智能体状态为四元组：

$$
s = (h,\; b,\; r,\; c)
$$

- $h$：对话/历史，即上下文窗口——智能体的**工作记忆**。`toolUseLoop.js` 的 `messages` 即此。
- $b$：对真实世界 $w$ 的**信念**（由历次观测累积）。Khyos 中没有显式 $b$ 对象，它隐式散落在 $h$ 里——**这是第一个可形式化的缺口**。
- $r = (r_\text{tok}, r_\text{time}, r_\text{iter}, r_\$)$：**资源向量**。对应 `IterationBudget`（`toolUseLoop.js:96`）、`usageTracker`、墙钟 600s。
- $c$：约束/权限上下文（活跃 profile、已授予的审批、guard 状态）。对应 `riskGate`/`requestPermission`/`toolProfile`。

### 1.3 动作（Action）与**可行性投影**

全动作集 $A_\text{full}$ = 工具注册表（`tools/index.js`）。但任一状态下**可行**的动作是其受约束子集：

$$
A(s) \;=\; \Pi_{\mathcal C}(s)\big(A_\text{full}\big) \;=\; A_\text{full} \cap \mathrm{Feasible}(s)
$$

其中 $\Pi_{\mathcal C}$ 是**约束投影算子**，$\mathcal C$ 是六维约束集（探针实测）：

$$
\mathcal C = \{\underbrace{\text{工具可用性}}_{\text{policy/skill/profile/deferral}},\; \underbrace{\text{用户授权}}_{\text{per-tool/once/forever}},\; \underbrace{\text{FS 边界}}_{\text{越界/先读/TOCTOU}},\; \underbrace{\text{网络}}_{\text{SSRF/DNS-pin}},\; \underbrace{\text{资源}}_{\text{timeout/rate/size}},\; \underbrace{\text{能力闸}}_{\text{capabilityGate}}\}
$$

**关键的、Khyos 尚未形式化的结构——动作的可逆性分层：**

$$
A(s) = A_\text{safe}(s) \;\dot\cup\; A_\text{commit}(s)
$$

- $A_\text{safe}$：**可逆/只读**动作（read、grep、search、dry-run、`--check`）。执行它们**不改变 $w$**，只改变 $b$（信息增益）。
- $A_\text{commit}$：**不可逆**动作（write、`rm`、kill、网络副作用）。一旦执行无法回溯——**这是 Khyos 与经典 A\* 的根本区别：真实世界没有「撤销」按钮。**

这个分层是后文整个重构的支点（§5）。

### 1.4 转移（Transition）

$$
s' = T(s, a, \omega), \qquad \omega \sim P(\cdot \mid s, a)
$$

$\omega$ 是随机结果（LLM 非确定性 ⊕ 真实世界返回）。转移核 $P$ **未知、仅可采样**——每次"采样"就是一次真实工具执行，代价高昂且 $A_\text{commit}$ 部分不可重采。这正是为什么不能做朴素树搜索。

### 1.5 目标函数（Objective）——本设计的灵魂

用户要求的"不仅衡量是否完成，还要量化完成得好不好"，就是给出**单一标量代价**。定义每步代价为资源与风险的加权和：

$$
g(s,a,s') \;=\; \lambda_\text{time}\,\Delta t \;+\; \lambda_\text{tok}\,\Delta\text{tok} \;+\; \lambda_\$\,\Delta\$ \;+\; \lambda_\text{risk}\,\mathrm{Risk}(a) \;+\; \lambda_\text{irrev}\,\mathrm{Irrev}(a)
$$

- $\mathrm{Risk}(a)$ 来自 `riskGate.assess()`，$\mathrm{Irrev}(a)$ 来自 §1.3 的可逆性分层（`isDestructive` 元数据已有）。
- $\lambda$ 是策略权重向量——**这就是"高效/省资源/安全"三目标的统一旋钮**，把 Khyos 散落各处的度量（`elapsedMs`、`onCost`、risk level）第一次收进同一个标量。

总目标：在硬约束与预算下，求最小**期望累计代价 + 终端势**的策略：

$$
\boxed{\;\pi^\* = \arg\min_{\pi}\; \mathbb{E}\!\left[\sum_{t=0}^{T} g(s_t,a_t,s_{t+1}) \;+\; \Phi(s_T)\right]\;}
$$

$$
\text{s.t.}\quad
\underbrace{a_t \in A(s_t)\ \forall t}_{\text{硬约束（guards）}},\qquad
\underbrace{r_T \preceq R_\text{max}}_{\text{预算（IterationBudget）}},\qquad
\underbrace{\mathrm{Verify}(s_T)=\text{PASS}}_{\text{目标（delivery gate）}}
$$

终端势 $\Phi(s_T)$：若目标已验证则 $0$，否则 $+\infty$（或"未满足验收项数 × 大常数"，给 anytime 部分解打分）。

> 这一个式子同时统一了三件 Khyos 今天分开做的事：**预算**（约束二）、**安全**（约束一 + $\lambda_\text{risk}$）、**验收**（约束三）。下文所有重构都是"如何高效地近似求解这个 $\pi^\*$"。

---

## 2. 用数学语言重述现有 Khyos

把四路探针测到的真实逻辑，逐块翻译进 §1 的框架。

### 2.1 规划 = 无价值函数的单步贪心 rollout

`toolUseLoop.js:1213` 的主循环 `while(!budget.depleted)`，每轮把 $h$ 发给 LLM，由 `stop_reason=tool_use` 直接产出下一批动作（`:1757`），执行后回灌。用 §1 语言：

$$
\pi_\text{khy}(s) \;=\; \text{sample}\; a \sim \mathrm{LLM}(\cdot \mid h), \qquad \text{无 } \arg\min_a\big[g(s,a)+V(s')\big]
$$

- **没有价值函数 $V$**，没有对 $g$ 的任何显式优化，没有前瞻。`<execution_plan>`（`:6150`）只是**软进度轨道**，不驱动决策。
- `planModeService` 提供"先 plan→审批→逐步执行"，但只有 **per-step 重试**（`:914`），**无全局 replan**。
- 这是教科书意义上的 **greedy / 深度优先且无启发**：完备性差，逃逸局部最优的唯一手段是外层盲目重跑。

### 2.2 外层 = 固定次数的盲目重试环（而非收敛搜索）

`agenticHarnessService.js` 套了两层串行负反馈：

$$
\text{Ralph 续轮: } \texttt{while(maxIterationsReached \&\& round < 3)}\quad(\text{:365})
$$
$$
\text{交付门 remediation: } \texttt{while(!gate.passed \&\& round < 3)}\quad(\text{:480})
$$

用 §1 语言：这是**对同一个 SSP 实例的多次独立试验（trials）**。问题在于——**每次试验之间不传递任何学到的价值**：第 $k$ 轮失败的教训不会变成第 $k{+}1$ 轮的启发 $h(s)$。它是 *restart*，不是 *learning restart*。

### 2.3 动作空间 = 约束投影 $\Pi_{\mathcal C}$ 的精确实现

探针证实 Khyos 已经**实现了 $\Pi_{\mathcal C}$**，只是没命名：
- `toolProfile.js` 的 minimal/coding/analysis/full 白名单 = 对 LLM 隐藏工具的投影。
- `executeTool`（`toolCalling.js:2299`）= 单一漏斗，六维约束在此逐一施加，违例返回结构化 `ToolError`（硬拒）。
- `guardApproval.js` = **约束松弛算子**：把软越界动作通过"人工审批转移"提升回 $A(s)$，代价为 $\lambda_\text{human}$（中断成本）。

数学上这是一个**约束格（lattice）**，但代码里是散落的 if 分支（见 §4.1、§5.4）。

### 2.4 调度 = 两套范式拼接 + 一个**未命名的劣化老虎机**

- **内核侧（`sched.c:270`）**：纯轮转 RR + 10ms 固定时间片抢占（`timer.c:43`）+ bitmap first-fit 物理页（`pmm.c:45`）。**干净、对称、无启发式——是全系统最接近最优的部分。**
- **适配器路由（`aiGateway.js:2115`）**：`score = basePriority×10 + Σpenalty`，按 score 升序选适配器。用 §1 语言，这是一个**手工搓的、未调参的多臂老虎机（MAB）**：score 是臂的劣化估计，cooldown 是探索惩罚，但权重全是魔数、无 regret 保证。
- **账号池（`accountPool.js:3121`）**：配置名曰 `'Balance'`，SQL 实为 `ORDER BY last_used_at DESC`（**最近使用优先、粘性**）——**名实不符**：声称负载均衡，实做反均衡。
- **工作流（`workflowExecutor.js`）**：单游标顺序解释器 + FIFO 乐观锁认领（`workflowRunWorker.js:116`），**非抢占**——一个长 run 阻塞后续（`tick` 每拍只认领一个）。

### 2.5 反思 = 外部测量算子 + 防环补丁

- `verificationAgent.adversarialVerify`（`:373`）= §1.1 的**信念坍缩测量**，强制 `VERDICT`。
- `toolLoopDetector.js`（10 检测器，`:28`）= **对「无 visited 集 + 无代价单调」的搜索缺陷的事后补丁**。在正则 SSP 里，环由 $g$ 的单调递增 + visited 集**结构性杜绝**，根本不需要 pingPong / genericRepeat / circuitBreaker 这一堆探测器。
- `boulderState.js`（SQLite WAL + 文件快照，`:32`/`:125`）= **状态 $s$ 的持久化检查点**，已支持跨进程 resume 与工作区漂移检测——这是把 $s$ 外化的良好基础（正好补 §1.2 的 $b$ 缺口）。

> **重述结论（数学形状）**：Khyos = 在 belief-POMDP 上跑的**无启发、无回溯的贪心前向链**，外包**固定次数的非学习重启**，用**事后防环补丁**维持稳定，用**外部测量**判定终止；调度层是**干净内核 RR** 与**未调参启发式**的拼接。它处处碰到了 CB-SSP 的正确零件，却没有把它们装进同一台机器。

---

## 3. 批判性审查（思想实验）

### 3.1 完备性：模型能处理所有边界吗？

| 边界 | 当前行为 | 数学缺陷 |
|---|---|---|
| 权限不足 | 动作被 guard 硬拒 / 或 fail-closed 阻塞 | $A(s)$ 可能**变空**而无定义的 fallback → 违反**活性（liveness）**：应保证 $A(s)$ 永不空（至少含 `ask_user` / `abort_with_reason`），否则是未定义挂起而非合法终态 |
| 命令失败 | `errorClassifier` 分类 → 线性重试 | 失败 = 高 $g$ 的随机转移；正确做法是**绕路**（搜索到次优动作），但无回溯 → 只能原地重试到硬上限 |
| 资源耗尽 | grace 轮收尾 | 已具 **anytime** 雏形，但未形式化"始终可返回已验证的最优部分解" |
| belief–goal 鸿沟 | 末端跑一次 verify | 验证**只在终点**，中途无信念校准 → 走偏要到最后才发现，remediation 成本被推到最贵的时刻 |
| 不可逆动作 | 与可逆动作同等对待 | **最危险的缺口**：无 $\mathrm{Irrev}$ 分层 → 在信念不足时就 commit，制造大量返工 |

### 3.2 效率：组合爆炸与复杂度

- **贪心 ReAct**：$O(\text{depth})$ 次 LLM 调用，breadth 不爆——**便宜但不完备**。逃逸局部最优靠 Ralph 盲重启，期望试验次数无界（最坏在 ≤3 上限处直接放弃）。
- **朴素 belief 上的全 A\***：$O(b^d)$（$b$=分支因子，$d$=深度）——**组合爆炸**。每个节点 = 一次 LLM 调用 + 一次真实副作用，且 $A_\text{commit}$ 不可重采，**绝对不可行**。
- 故两端都不行：贪心太弱，全搜索太贵。**最优区间在中间**（§5.1）。

### 3.3 一致性：局部最优是否损害全局？——**最深的病灶**

三个子系统**各自优化各自的目标，彼此不知道对方的代价**：

1. **规划**优化"让 LLM 满意地产出下一步"（无显式目标）；
2. **调度**优化"适配器可用性罚分"（`aiGateway` 的 score）；
3. **反思/验收**优化"acceptance pack 是否满足"（`buildAcceptancePack`）。

三者**没有共享的 $J$**。后果（可观测的真实矛盾）：
- 适配器路由为降低 score 切到一个**便宜但能力弱**的适配器，导致规划层多花 5 轮才达成同一验收项——局部省了适配器代价，全局 $J$ 暴涨。
- **验收标准（acceptance pack）只在终点用作裁判，却不在规划中用作指南**——规划是"盲走"，走完才被 gate 评判。这等于考试不发考纲、交卷才告诉你考什么。
- **两套断路器并存**（规范的 `circuitBreaker.js` 三态机 vs `aiGateway` 内联指数退避），主路径用后者——同一概念两套实现、未统一。
- **`'Balance'` 名实不符**——配置承诺均衡，实现是粘性 MRU。

> 一句话：**Khyos 缺一个"全局代价中枢"，让规划、调度、验收都对着同一个 $J$ 优化。** 这正是 §1.5 那个 $J(\pi)$ 要解决的。

---

## 4. 全局最优重构

设计原则：**不推倒重来**。把现有零件接到 §1 的 CB-SSP 框架上，补齐缺失的"黏合剂"。共四项改造（A–D）。

### 4.A 规划器：贪心 rollout → **可逆性分层的 LRTA\***

**核心洞察：Ralph 续轮环已经是 LRTA\*（Learning Real-Time A\*）的外层试验环，只差价值回填。**

LRTA\* 是为"动作有真实代价、不能自由回溯、需多次试验逐步逼近最优"而生的实时搜索算法——**与智能体处境天然同构**。它维护一张启发表 $h(s)$（到目标的代价-去估计），每步做有界前瞻后执行一步，并**回填**：

$$
h(s) \;\leftarrow\; \min_{a \in A(s)} \big[\, g(s,a) + h\big(T(s,a)\big) \,\big]
$$

多次试验后 $h \to h^\*$，路径**可证明收敛到最优**。把它落到 Khyos：

1. **可逆性分层执行**（§1.3 的支点）：
   - 对 $A_\text{safe}$（只读/可逆）：**允许有界前瞻 / beam（宽度 $k{\le}3$）**。因为只读动作不改 $w$、只锐化信念 $b$，可廉价并行试探（best-of-N 在只读子空间是安全的）。用它**在 commit 前把 $b$ 的不确定性降到阈值以下**。
   - 对 $A_\text{commit}$（不可逆）：**禁止投机分支**，做**一步最优承诺** $a^\* = \arg\min_a[g(s,a)+h(s')]$，并对高 $\mathrm{Irrev}$ 动作强制 plan-then-confirm（已有 `requestPermission` 通道）。
2. **Ralph 环 = LRTA\* 试验环**：把 `agenticHarnessService.js:365` 的盲重跑，改成"重跑前先用上一轮的 $(s,a,\text{结果})$ 回填 $h$"。**几乎零新增成本**（$h$ 存进已有的 `boulderState` SQLite），却把"不学习的 restart"升级为"收敛的 learning restart"。

**复杂度**：每次 commit 前的前瞻仅在 $A_\text{safe}$ 上、宽度 $k$、深度 $1$~$2$，额外**只读**代价 $O(k)$（不触发副作用、可缓存）；不可逆动作绝不分支 → **避免 $b^d$ 爆炸**。试验维度上 LRTA\* 在重复 trial 下收敛到最优 → **避免贪心的不完备**。这就是 §3.2 说的"中间最优区间"。

### 4.B 启发式 $h(s)$：用验收包统一规划/执行/反思的同一目标

**直接消灭 §3.3 的一致性病灶。** `buildAcceptancePack()` 已枚举目标谓词 $\{\phi_1,\dots,\phi_m\}$（验收项）。定义：

$$
h(s) \;=\; \sum_{i:\ \phi_i \text{ 在信念 } b \text{ 下未满足}} \widehat{c}(\phi_i)
$$

$\widehat c(\phi_i)$ = 满足第 $i$ 项验收的估计代价（保守下估，每项 $\ge 1$ 个动作 → **可采纳（admissible）** → A\*/LRTA\* 最优性成立）。

效果：
- **规划层**现在每步都对着"还差哪些验收项"做 $\arg\min$ —— 考纲提前发，不再盲走。
- **反思层**的 delivery gate 从"终点裁判"变成"全程启发"——**同一个 acceptance pack 同时充当目标、启发、终止判据**，三子系统第一次共享 $J$。
- **中途信念校准**：当 $h(s)$ 停滞或上升时，触发一次只读 verify（廉价 $A_\text{safe}$ 测量）校准 $b$，把"走偏"在最便宜的时刻发现，而非拖到终点 remediation。

### 4.C 调度统一：一个资源-代价模型治三层

把内核的**干净纪律上提**，把用户态的**启发式正规化**，让 CPU、适配器、账号、worker 服从同一抽象：*在代价 $g$ 下把受限资源分配给竞争需求*。

1. **适配器路由：手搓 MAB → UCB1 老虎机。** 现状 `score=basePriority×10+Σpenalty` 是没有 regret 保证的劣化老虎机。换成 UCB1：
   $$
   \text{select}\;\arg\max_a\Big[\underbrace{\hat\mu_a}_{\text{成功率×速度}} + \underbrace{\sqrt{\tfrac{2\ln N}{n_a}}}_{\text{探索项}}\Big]
   $$
   cooldown 自然成为探索项的一部分，**魔数自动调参**，且有**对数 regret 上界**。用户 failover 顺序作为先验注入 $\hat\mu_a$ 初值（保留现有 `failoverOrderStore`）。
2. **账号池：兑现 `'Balance'` 的承诺。** 把粘性 MRU（`ORDER BY last_used_at DESC`）改为真正的**最少负载 / power-of-two-choices**（随机取两个账号、选负载低者）——名实相符，且对热点账号限流有可证明的均衡性。
3. **工作流 worker：把内核的「时间片 + 抢占」上提。** 现状单游标非抢占 → 长 run 饿死短 run。给 worker 一个 **quantum**（每 $N$ 步经 `boulderState` 落盘检查点即可让出），把 RR + 抢占从内核搬到工作流层 → **两套调度范式合一**：同一个 (ready-queue, quantum, preempt) 抽象既治内核任务又治 agent 工作流。
4. **统一断路器**：废弃 `aiGateway` 内联退避，全栈改用规范的 `circuitBreaker.js` 三态机（CLOSED/OPEN/HALF_OPEN）——消除"双实现并存"。

### 4.D 约束格：把散落的 if 分支形式化为偏序

把六维约束的"硬拒 / 可审批 / 放行"形式化为一个**约束格**（偏序 $\sqsubseteq$）：

$$
\bot\ (\text{红线，恒不可行})\;\sqsubset\; \text{approvable-soft}\ (\text{经人工转移可行})\;\sqsubset\; \top\ (\text{恒可行})
$$

- 红线（pathTraversal、SSRF、critical-destructive）= 格底 $\bot$，$\Pi_{\mathcal C}$ 直接抹去，**任何审批不可松弛**。
- 软约束（editBoundary、priorRead、fileStale）= 中间元，`guardApproval` 是把它**沿格向上提升**到 $\top$ 的松弛算子，代价 $\lambda_\text{human}$ 计入 $g$。
- 这样"硬 vs 可审批"从一堆 if 变成一个清晰偏序，新增 guard 只需声明它在格中的位置，**$A(s)$ 永不为空**（格顶恒含 `ask_user`/`abort`，补 §3.1 活性缺口）。

---

## 5. 为何新设计全局最优（逐条论证）

| 病灶（§3） | 旧方案 | 新方案 | 为何更优 |
|---|---|---|---|
| 规划无价值、靠盲重试 | 贪心 + Ralph restart | LRTA\* + 价值回填 | 多 trial **可证明收敛到最优**；复用现有 Ralph 环与 SQLite，近零成本 |
| 防环靠 10 个补丁 | toolLoopDetector | 代价单调 + visited 集 | 环被**结构性杜绝**；检测器降级为可选监控而非正确性依赖 |
| 三子系统无共享目标 | 各优化各的 | 统一 $J$ + 验收包做启发 | 消除局部优化害全局；规划/调度/反思**对同一 $J$ 优化** |
| 不可逆动作无保护 | 一视同仁 | 可逆性分层 | 只在信念充分时 commit → **返工/remediation 锐减** |
| 走偏末端才发现 | 终点 verify | $h(s)$ 停滞触发只读校准 | 在**最便宜时刻**纠偏，而非最贵时刻 |
| 适配器魔数老虎机 | 罚分 score | UCB1 | **对数 regret 上界 + 自动调参** |
| 账号名实不符 | 粘性 MRU | 真 LRU/P2C | 名实相符、可证明均衡 |
| 长 run 饿死 | 非抢占单游标 | quantum + 抢占 | 公平性，与内核范式统一 |
| 双断路器 | 内联 + 类并存 | 统一三态机 | 单一真源 |

**全局最优的含义**：不是某个函数更快，而是**整个系统第一次服从同一个最优性判据 $\pi^\*=\arg\min J$**——规划在 $J$ 下选动作，调度在 $J$ 下分资源，反思用 $J$ 的终端势判完成。子系统不再各自为政。

---

## 6. 落地映射（最小改动，不推倒）

| 新模型构件 | 复用的现有零件 | 需补的"黏合剂" |
|---|---|---|
| 状态 $s=(h,b,r,c)$ | `messages` + `boulderState` + `IterationBudget` + `riskGate` | 显式 $b$（信念对象，挂进 boulder 快照） |
| 启发 $h(s)$ | `buildAcceptancePack` / `acceptanceCriteria.js` | 把验收项数→代价估计，暴露给规划层 |
| LRTA\* 回填 | `agenticHarnessService` Ralph 环 + SQLite | 一行回填 `h(s)←min[g+h(s')]`，存 boulder.db |
| 可逆性分层 | 工具元数据 `isReadOnly`/`isDestructive` | 在 `executeTool` 入口按分层路由（前瞻 vs 承诺） |
| UCB1 路由 | `aiGateway` 罚分骨架 + `failoverOrderStore` | 把 score 换成 UCB 公式，penalty→探索项 |
| 抢占工作流 | `workflowRunWorker` + `boulderState` 检查点 | quantum 计数 + 让出 + ready-queue |
| 约束格 | 六维 guards + `guardApproval` | 给每个 guard 标注格位置（⊥/soft/⊤） |
| 统一断路器 | 现成 `circuitBreaker.js` | 把 `aiGateway` 内联退避替换为它 |

**推荐实施顺序**（按"收益/风险"排序）：
1. **§4.B 启发 $h(s)$**（验收包做启发）——纯增量、立刻消灭一致性病灶、零回归风险。
2. **§4.A LRTA\* 回填**——复用 Ralph 环，把盲重试变学习重试。
3. **§4.C-1 UCB 路由 + §4.C-4 统一断路器**——隔离在 gateway 层，可灰度。
4. **§4.D 约束格** + **§4.A 可逆性分层执行**——触及 executeTool，需充分回归测试。
5. **§4.C-3 抢占工作流**——最大改动，最后做。

---

## 7. 风险、边界与诚实的局限

- **$h(s)$ 的可采纳性依赖代价估计保守**。若高估，A\*/LRTA\* 失去最优性保证（退化为加权 A\*，仍完备、仅次优）。建议初期用"未满足验收项数 × 1"的极保守估计，宁可慢不可错。
- **belief $b$ 的维护成本**。显式信念对象会增加状态体积；用 `boulderState` 的文件快照 + 增量 diff 控制，只追踪与当前验收项相关的世界切片，而非全 $W$。
- **LRTA\* 收敛是"多 trial 渐近"**，单次任务未必触达最优——但这恰好匹配 Ralph 环的 ≤3 轮预算：每轮都比上轮严格不差（价值单调），即"有限预算内的单调改进"，已优于现状的"无单调性盲重启"。
- **不可逆动作的根本不可搜索性**是物理事实，非算法可消除。本设计的回应是"用廉价只读搜索换取昂贵不可逆承诺的正确率"，把搜索预算花在可逆侧——这是该约束下的最优策略，而非绕过约束。
- **内核侧无需重构**：`sched.c` 的 RR + 10ms 抢占 + first-fit 已是其作用域内的近最优；本设计是把这套纪律**向上传播**到用户态，而非反向。最干净的数学在系统最底层，重塑是让它向上生长。

---

### 附：一页纸的数学全景

$$
\underbrace{s=(h,b,r,c)}_{\text{信念态}}\ \xrightarrow[\ a\in A_\text{safe}\dot\cup A_\text{commit}\ ]{\ \pi^\*=\arg\min_a[g(s,a)+h(s')]\ }\ \underbrace{s'=T(s,a,\omega)}_{\text{随机转移}}
$$
$$
J(\pi)=\mathbb E\Big[\textstyle\sum g(s,a,s')+\Phi(s_T)\Big],\quad
\Pi_{\mathcal C}:\bot\sqsubset\text{soft}\sqsubset\top,\quad
h\leftarrow\min_a[g+h\circ T]\ \text{(LRTA\* 回填，跨 Ralph trial)}
$$

> 一个目标函数 $J$ 统辖规划、调度、反思；一个投影 $\Pi_{\mathcal C}$ 统辖安全；一个回填规则把盲目重试变成收敛搜索。这就是 Khyos 应有的、全局最优的数学灵魂。
