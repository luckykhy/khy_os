<!-- 文档分类: DESIGN-ARCH-004 | 阶段: 设计 | 原路径: docs/架构/_cbssp_progress.md -->
# CB-SSP 数学重塑 · 实施进度

> 配套：设计文档 [`docs/03_DESIGN_设计/[DESIGN-ARCH-003] Khyos-数学重塑-受约束随机最短路径.md`](%5BDESIGN-ARCH-003%5D%20Khyos-数学重塑-受约束随机最短路径.md)
> 提示词链 [`docs/03_DESIGN_设计/[DESIGN-OTHER-001] Khyos-数学重塑-实施提示词链.md`](%5BDESIGN-OTHER-001%5D%20Khyos-数学重塑-实施提示词链.md)
> 顺序锁死 **B→A→C→D**。本文件用于跨会话续接：崩了重开照对应阶段提示词继续。

---

## 阶段 B —— 验收包做启发 h(s)（§4.B）✅ 已完成

- 新增 `services/backend/src/services/heuristic.js`：
  `h(s) = costPerCriterion × 未满足必需验收项数`（`hAdmissible`，可采纳下估）
  `+ costPerCriterion × optionalWeight × 未满足可选项数`（仅用于停滞检测）。
  `shouldCalibrate(prevH, currH)` 在 h 未严格下降且仍有剩余时触发只读校准。
  全部阈值 env 可调（`KHY_HEURISTIC_*`），纯函数零副作用。
- 接入 `agenticHarnessService.js` `_attachHeuristic()`：在 delivery gate 与每轮
  remediation 后把 `report.heuristic` 作为**附加遥测**挂出（零控制流改动、env 门
  `KHY_HEURISTIC_ENABLED` 默认开）。
- 测试 `tests/services/heuristic.test.js`：**16 例全绿**——可采纳性（h≤真实剩余）、
  单调性（满足一项 h 严格下降）、goal 条件（h=0 ⟺ 全部满足）、停滞检测。

## 阶段 A —— 可逆性分层 LRTA*（§4.A）✅ 已完成

**A1 价值回填**
- 新增 `services/backend/src/services/lrtaBackfill.js`：
  回填规则 `H_k = min(H_{k-1}, g_k + h_k)`（运行最小值 ⇒ **跨 trial 单调不增**，
  设计文档断言的性质）。`roundCost({iterations})` = `KHY_LRTA_STEP_COST_WEIGHT` × 本轮
  迭代数（非负 ⇒ 不破坏单调性）。隔离 sidecar 持久化
  `<dataHome>/boulder/lrta/<cwdHash>.json`（复用 dataHome + boulderState._cwdHash，
  **不动 checkpoint schema**），下一 trial/会话热启动。
- 接入 `agenticHarnessService.js`：`_seedLearnedHeuristic()` 在 gate 开始读热启动值，
  `_backfillTrial()` 在 round 0 与每轮 remediation 后回填+持久化+发 `lrta_backfill`
  遥测。env 门 `KHY_LRTA_ENABLED` 默认开，best-effort 出错返回原值（零回归）。
- 锚点说明：设计文档写 "在 agenticHarnessService.js:365 Ralph 环回填"，实测 h(s)
  只在 **remediation 试验环**（现 ~487 行）可观测（该环才有 delivery gate 信号），
  故回填落在此环——它正是 §2.2 列举的两个 trial 环之一。

**A2 可逆性分层执行**
- 新增 `services/backend/src/services/reversibility.js`：
  `classifyAction` → `safe`(只读且非破坏)/`commit`(其余，含未知，保守)；
  `speculationGuard(assessment, speculative)` 在投机上下文对 commit 动作返回结构化硬拒；
  `resolveReversibility` 从 `../tools` 注册表取权威 isReadOnly/isDestructive；
  `boundedReadOnlyLookahead` 只保留 safe 候选且束宽 k≤3（`KHY_LOOKAHEAD_WIDTH` clamp [0,3]）。
- 接入 `executeTool`（`toolCalling.js` ~2422）：`traceContext.speculative===true` 时在
  权限/执行**之前**对不可逆动作硬拒 `_speculativeBlocked`（**不可逆绝不投机执行 +
  前瞻只产生只读代价/预算守恒**）。fail-closed：守卫不可用则拒绝投机。默认路径
  （speculative 假）完全不变 ⇒ 零回归。
- 测试 `tests/services/lrtaBackfill.test.js`（13 例）+ `tests/services/reversibility.test.js`
  （15 例）**全绿**：回填 min 公式/单调/持久化往返、分类/守卫/真注册表解析/束宽 clamp、
  executeTool 投机 commit 在 handler 前被拒（handler 未调用）、非投机路径与真只读工具放行。

**Phase A 回归**：heuristic+lrtaBackfill+reversibility+deliveryConclusion+harnessProfile+
verificationGate+postHookStop+queryEngine.toolLoopParity 共 **56 例全绿**。

> 既存失败（与本次无关，已核验在 committed `toolCalling.js` 上同样复现）：
> `tests/toolCalling.shellForkClassify.test.js`、`tests/services/toolLoopDetector.test.js`
> ——属工作区既有未提交改动的 pre-existing 失败，非 Phase A 引入。

---

## 阶段 C —— 调度统一（§4.C）✅ 已完成

**C-1 适配器路由 UCB1 ✅ 已完成**
- 新增 `services/backend/src/services/gateway/ucbRouter.js`：UCB1 老虎机
  `a* = argmax[μ̂_a + c·√(2 ln N / n_a) − cooldownDamp_a]`。臂回报
  `r = success ? speed(latency) : 0 ∈ [0,1]`（`speed = refLatency/max(latency,refLatency)`，
  单调），μ̂ 收敛到「成功率×速度」。未拉过的臂探索项 +∞（强制先试）；冷却臂的
  探索奖励按剩余冷却比例阻尼向 0（**cooldown 折入探索项**，不另设罚分）。
  `failoverOrderStore` 顺序作乐观先验伪计数（队首先验均值高），有真实证据后让位。
  臂统计在进程内（singleton），非持久真相，不碰任何 schema。全 env 可调
  （`KHY_UCB_EXPLORATION/REF_LATENCY_MS/NEUTRAL_SPEED/PRIOR_WEIGHT`）。
- 接入 `aiGateway.js`：`KHY_UCB_ROUTING` 灰度门控**默认关**（罚分路径不变零回归）。
  开启时罚分分数仍决定**可选集**（blocked/unavailable 过滤不动），UCB1 只对 eligible
  **重排**（`_applyUcbRouting`，cooldown 经 `_getRecentFastFail.remainingMs` 阻尼）。
  outcome 记录：`_recordAdapterFailure` 记失败、`_clearAdapterFailure` 记成功
  （`_recordAdapterOutcome` no-throw + 门控关时 no-op）。
- 测试 `tests/services/ucbRouter.test.js` **11 例全绿**：回报形状、UCB1 选择公式精确值、
  探索常数可调、强制探索、cooldown 阻尼、failover 先验冷启动、**统计性次线性 regret**
  （3 臂 Bernoulli，LCG 确定性，R(T)/T 随 T 增大严格下降 + 最优臂占比>70% + 远低于线性界）。
  回归 `aiGateway.stability.regressions`+`apiPoolStrategy`+`failoverOrderStore` **45 例全绿**。

**C-4 统一断路器三态机 ✅ 已完成**
- `circuitBreaker.js` 新增唯一真源纯函数 `computeBackoffMs({baseMs,attempt,multiplier,maxMs,maxSteps})`
  = `min(maxMs, baseMs·m^clamp(attempt,0,maxSteps))`，并让断路器自身 `_onFailure`
  半开重开也走它（不再内联 `current*multiplier`）。
- 消三处双实现：`aiGateway._recordAdapterFailure` 冷却升级
  （旧 `min(300000, max(base,floor)·2^min(over,4))`）+ `_enforceRateLimit` 重试前退避
  （旧 `min(cap, base·2^(failures-1))`）全部改为委托 `computeBackoffMs`。冷却 cap 与
  步数上限提为 env（`GATEWAY_CIRCUIT_BREAKER_MAX_COOLDOWN_MS`=300000 /
  `_MAX_BACKOFF_STEPS`=4），默认值与旧行为**逐点 byte-identical**（零魔数 + 零回归）。
- 测试 `tests/services/circuitBreakerBackoff.test.js` **全绿**：规范形状/单调/cap+步数饱和/
  默认取自 DEFAULTS/坏输入加固 + **对三条旧公式全输入域逐点等价**（零回归证明）。
  回归 `circuitBreaker.management`+`stability.regressions`+`apiPoolStrategy` 等 **66 例全绿**。
  既存失败 `aiGateway.retryBudget`（2 例）已证 committed HEAD 同样复现 → 工作区 pre-existing。

**C-2 账号池真均衡 ✅ 已完成**
- 新增 `services/backend/src/services/accountSelector.js`：纯函数 LRU/P2C 选择器。
  `loadKey(account)` = 使用近度（`last_used_at` ms，null→0/`created_at` 兜底；越小越闲越优）。
  `selectLru` 取最闲账号（id 平局确定性）；`selectPowerOfTwo(accounts, rng)` 抽两个取较闲
  （rng 可注入，默认 Math.random）—— power-of-two-choices 把最大负载压到 Θ(ln ln N)。
  `policyForMode`：仅 `Balance` 走均衡默认策略，其余保持 legacy MRU（可回退）。
  全 env 可调（`KHY_ACCOUNT_BALANCE_POLICY` 默认 p2c，非法值安全回落）。
- 接入 `accountPool.js`：`DEFAULT_SCHEDULING_CONFIG.schedulingMode='Balance'`；新增
  `_pickNextAccountRow(norm, excludeId)` 统一选址（mru 保留旧 `ORDER BY last_used_at DESC`，
  否则取全可选集 `ASC` 后 `pickBalanced`）。替换三处 MRU（getActiveAccount 兜底 /
  banActiveAccount / cooldownAccount 的 next-pick）+ acquire 的 `ORDER BY RANDOM()`。
  `excludeClause` 为固定字面量（id 绑定，无注入）。
- 测试 `tests/services/accountSelector.test.js` **13 例全绿**：loadKey 时序、LRU 最闲选择 +
  **重复选择=轮转完美均衡（max−min≤1）**、**P2C 最大负载显著低于均匀随机**（统计性，LCG）
  + P2C max < 1.25·(T/N)、policyForMode（仅 Balance 均衡）、env 可调、pickBalanced 分派。
  实盘 SQL smoke：getActiveAccount→active / banActiveAccount 1→2 切换 / 12× acquire+release
  全程无错。回归 selector+ucb+breaker+kiro/windsurf 适配器+stability **60 例全绿**。

**C-3 工作流 quantum 抢占 ✅ 已完成**
- `workflowExecutor.js` 单游标解释器加 `options.quantum`（>0 启用）：每执行 quantum 个
  节点即让出，返回 `{status:'paused', pause:{kind:'quantum', nodeId:<下一节点>, loopState}}`。
  让出点在游标推进**之后**、指向**下一个待执行节点**（恢复时正常执行，不像 answer-resume
  跳过/注入）。新增 `isQuantumResume` 区分：quantum 恢复只定位游标，answer 恢复才注入答案。
  **抢占透明性**：跨任意 quantum 让出/恢复，最终 vars、节点执行序列、log 与不间断运行逐一相同。
- `workflowRunWorker.js`：`executeRun` 按 `pending.kind` 分流——quantum 让出 → 状态回
  `queued` 立即重排（非 awaiting_input，无需人工），保留 partial log；answer/awaiting_input
  走旧路径。`claimNext` 在 quantum 开启时排序 `updatedAt ASC, id ASC`（让出的 run updatedAt
  刷新→沉到队尾=ready-queue 公平轮转），关闭时保持 `id ASC` FIFO（默认零行为变更）。
  `quantumSteps()` 动态读 `KHY_WORKFLOW_QUANTUM_STEPS`（默认 0=关），`_stats.preempted` 计数。
- 测试 `tests/workflowExecutor.quantum.test.js` **11 例** + `tests/workflowRunWorker.quantum.test.js`
  **4 例** = **15 例全绿**：抢占透明性（Q∈{1,2,3,5,7,100} 逐一等价不间断运行 + 循环计数器跨
  让出存活）、让出边界（首段恰 Q 步、停在第 Q+1 节点）、无虚假让出（≤Q 步一段跑完）、Q=0 等价
  无 quantum、**quantum 恢复≠answer 恢复**（落在 askUserQuestion 上恢复时正常执行该节点并暂停
  等输入，绝不注入幻影答案）、**跨进程恢复**（多 tick 落盘 checkpoint 重排，终态与不间断逐一相同）、
  **ready-queue 公平**（让出的 run 让出本轮，低 id 也排队尾）、quantum 关闭保持 FIFO-by-id。
  回归既有 `workflowExecutor.test.js`(16)+`workflowRunWorker.test.js`(11) **27 例全绿**，零回归。

**Phase C 全部完成**（C-1 UCB1 路由 / C-2 账号池真均衡 / C-3 工作流 quantum 抢占 / C-4 统一断路器）。

## 阶段 D —— 约束格形式化（§4.D）✅ 已完成

- 新增 `services/backend/src/services/constraintLattice.js`：把六维 guards 形式化为
  三元偏序格 **⊥(BOTTOM 红线) ⊏ SOFT(可审批) ⊏ ⊤(TOP 可行)**（`RANK` 即序，
  `leq/lt/join/meet` 全备）。分类两层：
  - `positionOfSource(source)` = 声明天花板单一真源（pathTraversal/rateLimit/ssrf/
    loop-dedup guardrail/critical → ⊥；editBoundary/priorRead/fileStale → soft），
    env `KHY_LATTICE_REDLINE_SOURCES` 仅可**追加**红线（紧化，永不降级）。
  - `position(guardResult)` = 运行态分类（黄金回归既有契约）：allow→⊤；block 且
    `approvable===true`→SOFT，**但声明红线源恒 ⊥**（防误设 approvable 提权，纵深防御）；
    其余 block→⊥。
  - 松弛算子 `relax(el,{approved})` = guardApproval 的 λ：`relax(⊥)=⊥`（红线不动点·
    不可松弛）、`relax(SOFT,true)=⊤` 否则 SOFT、`relax(⊤)=⊤`；**单调 + 幂等**，未知元
    fail-closed 落 ⊥。
  - 活性：`ensureLiveness(actions)` 永不返回空集（裁空则回退逃逸地板 ask_user/abort）；
    `isLivenessFloor` + `feasibleUnderPolicy(tool,reason)` 供策略层放行逃逸动作，env
    `KHY_LIVENESS_FALLBACK` 可扩展地板。纯函数零副作用、零硬编码。
- 黏合剂（最小、加性、零回归）：
  - `guardApproval.js` `requestGuardApproval` 入口加红线不可约束言——`isRedLineSource(source)`
    为真直接拒（今日红线本不到此因不设 approvable → 零回归，但把契约**变成强制可测**，
    fail-open 防模块缺失）。
  - `toolCalling.js` `_checkToolPolicy`（blocklist+allowlist 两支）与 `_checkActiveSkillPolicy`
    返回 block 原因前过 `_latticeLiveness` → 逃逸地板动作（ask_user/abort）永不被任何
    allow/block 名单裁掉，**保证 A(s)≠∅**（填补 §3.1 活性缺口，唯一会把 A(s) 裁空的点）。
    导出 `_checkActiveSkillPolicy` 供测试。
- 测试 `tests/services/constraintLattice.test.js`（30 例）+ `guardApproval.test.js` 新增
  GA-8（1 例）+ `tests/services/toolPolicyLiveness.test.js`（7 例）= **38 例全绿**：
  偏序自反/反对称/传递+链 ⊥⊏SOFT⊏⊤+join/meet=lub/glb；**黄金回归**（每个既有 guard 结果
  分类复现现行 approvable 契约，含 editBoundary sensitive-home-write 无 approvable→⊥ 的旁路）；
  **红线不可约束**（relax(⊥,approved)=⊥、误设 approvable 仍 ⊥、guardApproval 红线源即便
  channel 同意也不弹窗直接拒）；soft 松弛单调+幂等；**活性**（ensureLiveness 永非空、逃逸
  地板穿透 allowlist/blocklist/skill 白名单、env 可扩展）。
  回归 `toolGuards`+`toolGuardsExtended`+`guardApproval` **73 例全绿**，零回归。
  > 既存失败 `toolCalling.shellForkClassify`（BUILTIN_TOOLS shell 解析）已 git-stash 核验
  > committed HEAD 同样复现 → 工作区 pre-existing，非 Phase D 引入。
- 全部未提交，推送前需用户确认（CP3）。

---

## 续接须知

- 新增模块均 env 门控 + 默认开，best-effort，**未接入投机前瞻驱动**（仅落地结构保证：
  不可逆绝不投机执行）。lookahead 驱动可作为后续可灰度增量。
- 跑测试用根 jest：`node /home/kodehu03/Khy-OS/node_modules/jest/bin/jest.js <file> --no-cache`
  （`rtk` 重写 `npx jest` 会 Exec format error）。
- 全部为未提交改动；提交/推送前需经用户确认（提示词链 CP3）。
