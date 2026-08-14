> ⚠️ **已归档（孤儿设计稿）· 请勿据此实现** ⚠️
>
> 本规范描述的治理引擎 `marshal（任命/弹劾/接力生命周期半边）` 经 2026-06-14「接线或删除」证据级核实为 **ORPHAN**
> （零消费者、从 `executeTool`/`toolUseLoop`/`aiManagementServer` 三入口均不可达），
> 已按 `.ai/GOVERNANCE-LEDGER.md` §B.0 **删除其实现代码**（基线 `0437b6b`，删除提交
> `a76785e` + `99ea828`）。本文件仅作**历史可追溯**留存，**非在产、不得作为实现依据**。
> 判「在产」唯一标准见 `.ai/GUARDS-AI.md` §0。 **例外**：叶子 `marshal/capabilityVector` 仍在产（经 metaConstraint/capabilityProbe 投影分带），其单一真源文档见 `.ai/GUARDS-AI.md` §2；仅本规范描述的任命/弹劾半边被删。
>
> ——归档于 2026-06-14
# 《khyos 元帅（Marshal）双模式任命与约束规范》

> 文档编号：DESIGN-ARCH-024
> 主题：主控模型（元帅）的「自动选举 ⇄ 用户强制指定」双模式任命，及其能力分级约束与弹劾移交
> 范围：`services/backend` 调度器的**任命与约束**子系统（不触碰核心业务逻辑）
> 关联实现：`src/services/marshal/*`、`platform/khy_platform/cli.py`（`--marshal`）、`tests/services/marshal/marshalSubsystem.test.js`
> 关联规范：[DESIGN-ARCH-002] CB-SSP（可逆性分层 / 约束格）、[DESIGN-ARCH-013] 弱模型兼容

---

## 0. 问题陈述

khyos 是「单人 AI 原生 OS」，其 agent 由一个**主控模型**驱动宏观规划。此前系统：

1. **没有「元帅」这一概念**——既无硬编码的主控选择逻辑，也无用户干预接口；最接近的只是
   hybrid 启动器里硬编码的 `CLAUDE_CODE_SUBAGENT_MODEL`。
2. 因此存在一对**核心矛盾**：
   - 若系统自动用「最强模型」当主控，用户无法把控成本 / 隐私 / 偏好；
   - 若放开让用户指定**任意**模型当主控，一个低能力模型（如 `qwen-4b`）做自由宏观规划时
     极易产出逻辑不自洽的长计划，进而**直接操作文件系统造成不可逆破坏**。

本规范在「**用户意志至上**」与「**系统底线不死**」之间架一座桥：让任何在线模型都能被任命为元帅，
同时保证最弱的元帅在镣铐下也只能产出**文件安全、逻辑自洽**的计划。

---

## 1. 设计目标与硬约束

### 1.1 核心诉求（必须满足）

| # | 诉求 | 本方案如何满足 |
|---|------|----------------|
| ① | **用户意志至上** | 任何在线模型都可经 `--marshal=<model>` 强制任命；系统**绝不**因「太笨」而拒绝或过度警告，只静默切入「弱主适配协议」。 |
| ② | **系统底线不死** | 弱元帅被剥夺自由规划权，只能在严格 JSON Schema 内从**预置战略库**做「选择题」；其选择由**确定性规则引擎**展开为单一微步，不可逆动作一律降级须审批，绝不损坏项目文件。 |
| ③ | **无缝切换** | 弹劾移交时，业务需求与已积累的步骤/观察/失败日志由**上下文接力棒**逐字无损携带给继任者。 |

### 1.2 防呆红线（逐条落到代码，非仅 Prompt）

| # | 红线 | 落点 |
|---|------|------|
| ① | 弱元帅绝不允许直接操作文件系统或执行不可逆命令，必须经规则引擎二次校验 | `ruleEngineGuard.vetAction`：弱主 + A_commit + 未授权 → `allowed:false, requiresApproval:true` |
| ② | 用户指定元帅时，必须校验该模型是否在当前池中存活，否则立刻报错 | `marshalAppointment.appointMarshal`：不在线 → `{error:'model_not_in_pool'}`，不静默降级 |
| ③ | 弱主适配协议的 Prompt 注入绝不修改用户原始业务需求，只能修改「完成需求的方式」 | `contextBaton` 用 `Object.defineProperty` 冻结 `businessRequest`；渲染器逐字嵌入需求于 `"""` 围栏 |
| ④ | 不碰核心业务逻辑，只重构调度器的任命与约束模块 | 全部为 `src/services/marshal/` 新文件，零侵入既有 toolUseLoop / 网关 |

---

## 2. 架构总览

```
                       ┌──────────────────────────────────────────────┐
   用户 --marshal=X ──► │  MarshalCoordinator  (marshal/index.js)        │
   （或留空=自动）       │  一个任务的元帅生命周期编排                      │
                       └──────────────────────────────────────────────┘
                                 │ appoint()
                                 ▼
        §2 marshalAppointment ──────────────► capabilityVector
        ├─ 留空 → electMarshal（reasoning 最高）   （层级 → 连续分数 + 强/弱裁决）
        └─ 指定 → 校验存活(防呆②) → user-override
                                 │ protocol = strength
              ┌──────────────────┴───────────────────┐
              ▼ strong                                 ▼ weak
   §4 strongMasterProtocol                  §3 weakMasterProtocol
   赋予全权 / 跨级指挥 / 自我反省            限制兵权(strategySOP选择题)
   自由文本计划原样接受                       → 解析 → 确定性展开单一微步
                                              → ruleEngineGuard 二次校验(防呆①)
                                                       │ 连续非法 ≥ 阈值
                                                       ▼
                                       §5 impeachment 弹劾状态机
                                       逼宫提案(精确文案) → 用户裁决
                                       批准 → contextBaton.handover(无损,防呆③)
                                            → 继任者按其 strength 重新选协议
                                       拒绝 → 挂起(绝不静默覆盖用户意志)
```

### 2.1 模块清单（`src/services/marshal/`）

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `capabilityVector.js` | 把离散层级投影成连续能力向量 + 强/弱裁决 | `assess`、`capabilityScore`、`strongThreshold` |
| `marshalAppointment.js` | §2 双模式任命 + 防呆② | `appointMarshal`、`electMarshal`、`isAlive` |
| `strategySOP.js` | 预置战略库（弱主选择题）+ JSON Schema | `STRATEGIC_INTENTS`、`buildChoiceSchema`、`isLegalChoice` |
| `ruleEngineGuard.js` | §3 强化护卫 / 防呆① 二次校验 | `vetAction`、`vetBatch` |
| `weakMasterProtocol.js` | §3 渲染 / 解析 / 确定性展开 | `renderWeakMasterPrompt`、`parseStrategicDecision`、`expandToMicroStep` |
| `strongMasterProtocol.js` | §4 强主赋能 | `strongCapabilities`、`renderStrongMasterPrompt`、`ingestStrongPlan` |
| `contextBaton.js` | 无缝切换载体 + 防呆③ 需求冻结 | `createBaton`、`handover`、`assertRequestIntact` |
| `impeachment.js` | §5 降级弹劾状态机 | `recordOutcome`、`buildHandoverProposal`、`resolveProposal` |
| `index.js` | `MarshalCoordinator` 编排（唯一对外集成面） | `MarshalCoordinator` + 全部子模块再导出 |

所有模块**纯函数式、零副作用**（除协调器自身内部状态对象外），复用既有单一真源：
`modelTier`（层级）、`reversibility`（可逆性分层）、`constraintLattice`（约束格 / 红线）、
`safeJsonParse.extractFirstJson`（结构化输出恢复）、`taskDecomposer`（确定性拆解）。

---

## 3. 能力向量与强/弱裁决（capabilityVector）

`modelTier` 给出离散序数层级（T0 前沿 > T1 强 > T2 默认 > T3 弱）。任命子系统在其上叠加两件事：

1. **连续分数**——把四层映射为能力向量（`reasoning` 为选举主维），加权聚合成 `[0,100]` 分数，
   使一池模型可排序、选出唯一最优（§2 自动选举要求「reasoning 得分最高」）。
   - 权重：`reasoning 0.5 / planning 0.25 / instruction 0.15 / jsonStrict 0.1`（和为 1）。
2. **强/弱裁决**——`reasoning ≥ 阈值`（默认 65，`KHY_MARSHAL_STRONG_THRESHOLD` 可覆盖）即「强」，
   决定走哪套协议。结果：T0/T1 强、T2/T3 弱。

> 该模块**不引入任何新的模型知识**，只把既有四层投影到向量；所有阈值带命名默认值、环境可覆盖（零硬编码）。

---

## 4. 双模式任命（§2 marshalAppointment）

- **自动选举（默认）**：`electMarshal` 对在线池按聚合分数排序，并列时比 `reasoning`，再并列按池内稳定顺序——**确定性**。
- **用户指定（皇权特许）**：`appointMarshal({pool, requested})` 命中 `requested` 时：
  1. **防呆②**：`isAlive` 校验该模型在在线池中，否则立即返回 `{error:'model_not_in_pool', available:[…]}`，**绝不静默降级**。
  2. 解析到池内规范大小写，按其 `strength` 选定 `protocol`。
- 池归一化 `normalizePool` 接受 `['id']` / `[{id|model|modelId|name, online|alive|healthy}]`，
  除非显式 `false` 否则视为在线。

---

## 5. 弱主适配协议（§3）

三道镣铐，全部落在代码而非仅 Prompt：

1. **限制兵权**：`renderWeakMasterPrompt` 强制弱元帅**只能**从 `strategySOP` 预置战略库选恰好一个宏观方向，
   输出必须满足 `buildChoiceSchema`（`sopId` 为闭枚举 + 极简 `params` + 一句 `reason`）。
   - 战略库（安全优先排序）：`investigate`(只读探查) / `minimal_change`(最小切片改) / `decompose`(确定性拆解) /
     `verify`(跑构建测试) / `clarify`(向用户澄清·逃生地板) / `halt`(安全停止·逃生地板)。
   - 逃生地板恒为只读，保证可行动作集 `A(s) ≠ ∅`（呼应约束格的活性地板）。
2. **强化护卫**：`expandToMicroStep` 用**确定性 switch**把选择展开成单一微步，**不咨询任何更强模型**
   （弱元帅含混的意图同样会误导聪明模型）。拆解优先用注入 dep，回退 `taskDecomposer` 仅确定性策略。
3. **分割政权**：一次只产出一个小微步，下一轮再选——弱元帅永远跑不远就到下一个校验点。

**防呆① 落点**：任何可变微步都经 `ruleEngineGuard.vetAction(…, {strength:'weak'})`。不可逆（A_commit）动作在弱主下
**绝不自动执行**，降级为 `requiresApproval:true` 的提案；红线来源（`pathTraversalGuard`/`ssrfGuard`/…）硬拦截，
任何审批都不可解除；逃生地板（`abort`/`askuserquestion`）对任何人始终可行。

**防呆③ 落点**：渲染器把原始业务需求逐字放进 `"""…"""` 围栏，并显式声明「只决定怎么做，不改做什么」。

---

## 6. 强主赋能协议（§4）

当系统选出（或用户钦点）高能力元帅，撤掉脚手架、释放「天才红利」：

- **赋予全权**：允许自由文本思维链 + 复杂宏观意图，无 SOP 镣铐（`renderStrongMasterPrompt` 刻意精简，
  对齐 modelTier 的 T0 lean 路径）。
- **跨级指挥**：可直接产出具体微观执行指令，跳过规则引擎展开器，直发工具 / 低智模型（`ruleEngineGuard`
  对 strong 豁免 commit 降级）。
- **自我反省**：失败时可查看完整日志并自我修正宏观策略（`reflecting:true` 渲染修正头）。

> 安全红线与逃生地板对**所有人**生效——赋能放开的是脚手架，不是安全格。

---

## 7. 降级弹劾机制（§5 impeachment）

弱元帅在 SOP 镣铐下仍**连续** `threshold`（默认 2，`KHY_MARSHAL_IMPEACH_THRESHOLD` 可覆盖）次产不出合法战略意图
（「连选择题都做不对」），触发「逼宫」：

```
governing ──(合法)──► governing（计数清零）
    │
    └──(非法)──► governing(n++) ──(n≥阈值)──► proposed
                                                │
                       用户拒绝 ◄───────────────┤
                       → suspended（挂起待用户，绝不静默覆盖意志）
                                                │
                       用户批准 ────────────────► handover
                                                → governing（新元帅）
```

- `buildHandoverProposal` 在排除失败元帅后选出最优继任者，给出**逐字精确**文案：
  `[Action Required] 指定元帅<from>连续规划失败，建议移交<candidate>指挥，是否同意？`
  （池中无其它可接管模型时给出补充模型/调整需求的变体文案）。
- 任务在用户确认前**挂起**；`resolveProposal` 批准 → `handover` 态并清零，拒绝 → `suspended`。

---

## 8. 无缝切换（contextBaton）

接力棒是**与元帅无关**的快照，含：冻结的业务需求、已完成微步、累积观察、触发弹劾的失败日志、历任元帅链。

- **防呆③ 结构性保证**：`businessRequest` 在创建时即被 `Object.defineProperty(writable:false)` 冻结，
  任何操作都无法改写「做什么」；`_clone` 在每次派生时重新钉死该不变量；`assertRequestIntact` 供调用方证明。
- 每个 mutator（`recordStep`/`recordFailure`/`handover`…）返回**新接力棒**，原对象不被篡改，
  故移交时可对前态留快照供审计。`handover` 只换 `currentMarshal`，需求逐字不动。

---

## 9. CLI / API 接入

`platform/khy_platform/cli.py` 的 `_run_claude_code_launcher` 解析 `--marshal <model>` / `--marshal=<model>`，
透传为环境变量 `KHY_MARSHAL`（`_build_khy_proxy_env(marshal=…)`）。**透传层不做任何能力封锁**——
用户意志在入口处即被尊重，能力适配全部下沉到 `MarshalCoordinator`。留空则走自动选举。

---

## 10. 端到端三场景（验收口径）

`MarshalCoordinator` 对**同一复杂任务**在三种任命情形下的完整流转（见 [TEST-RPT-008]）：

| 场景 | 入口 | 任命 | 协议 | 流转 |
|---|---|---|---|---|
| ① 自动选举 | `--marshal` 留空 | `mode:auto`，选出 `claude-opus-4-8` | strong | 接受自由计划，跨级指挥 |
| ② 强主指定 | `--marshal=claude-sonnet-4-6` | `mode:user-override` | strong | 接受自由计划，赋予全权 |
| ③ 弱主指定 | `--marshal=qwen-4b` / `gpt-4o-mini` | `mode:user-override` | weak | 选择题→规则引擎微步；编辑须审批；连续 2 次非法→弹劾→用户批准→无损移交 |

三大核心诉求与四条防呆红线均有对应断言（35 个用例全绿）。

---

## 11. 边界与后续

- 本子系统是**纯任命与约束层**，不自行驱动模型调用；宿主负责：提供在线池 + 用户 `--marshal` 选择、
  调渲染器取 Prompt、把模型原始输出回喂 `ingestPlanningOutput`、把弹劾提案呈现给用户。
- 后续可选增强：把 `KHY_MARSHAL` 在 toolUseLoop 入口实接为协调器的宿主接线（当前为零侵入设计，
  接线属核心业务逻辑改动，依防呆④另行评审）；战略库可随实践扩充新的安全宏观方向。
