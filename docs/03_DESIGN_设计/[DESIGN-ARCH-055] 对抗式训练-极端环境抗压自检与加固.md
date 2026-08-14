# [DESIGN-ARCH-055] 对抗式训练 —— 极端环境抗压自检与加固

> 状态：已实现（确定性核心 + 活防御驱动 + 破防收口 + 真实破口已修复）
> 子系统：`services/backend/src/services/adversarial/`
> 测试：`services/backend/tests/services/adversarial/adversarialEngine.test.js`（12 例绿）
> 加固落地：`services/backend/src/services/resilience/budgetExecutor.js`（`makeStepBudget` 语义修正）

## 1. 背景与目标

Khy-OS 已有一整套**防御方**与**从失败中学习**的生态：`resilience`（有限窗口降级 + 强制兜底，
ARCH-029）、`selfHeal`（先救后报微循环，ARCH-029）、`failsafe`（零静默失败归因 E01–E08，
ARCH-028）、`evoEngine`（自举创世闭环自愈，ARCH-037）、`dualTrackForge`（一切 Bug 皆需求，
ARCH-038）、`structuredFurnace`（万物结构化熔炉，ARCH-036）。

但这套生态的 friction（阻力信号）全是**被动**的：只有线上真实失败经 `frictionBridge` 旁路抄送
才会留痕。缺的是一支**主动红队**——在防御从未见过的极端/敌对条件下系统性施压，逼出抗压短板，
**在它们于生产中被真实触发之前**就找到并修复。

本设计补上这个缺口：一个零侵入的对抗式训练子系统，对各防御子系统的**公开契约**发起极端攻击，
按统一「抗压不变量」判定是否破防，并把破防收口进既有进化生态。再用它**实际跑一遍**，找出真实
破口并完成抗压修复（§6）。

## 2. 设计原则（与全局工程铁律一致）

- **零侵入**（防呆①）：只驱动各防御子系统已导出的公开 API，绝不对任何热路径动刀。所有开关都在
  本子系统门面，被测子系统代码零改动（唯一例外是 §6 在 `resilience` 源头修复的真实破口）。
- **判定与驱动分离**：「怎么打」（`stressHarness`）与「算不算活」（`survivalCriteria`）正交解耦，
  使抗压不变量成为跨子系统统一的合格线，而非每个攻击各判各的。
- **确定性可复现**（防呆②）：向量 `build()` 无随机、无时钟（退化输入用固定构造），同一战役多次
  运行结论一致——对抗结果可被测试锁定、可被回归守护。
- **永不抛、有界**（防呆③）：单条向量翻车被规约成一条破防记录，绝不拖垮整场战役；每次驱动包在
  硬死线内（默认 3s），被测子系统真卡死则规约为 BOUNDED 破防，施压器自身永不被拖挂。
- **非破坏默认**（防呆④）：把破防沉淀进 `evoLedger` 的 harden 档**默认关闭**——纯评测不污染进化
  需求池；显式开启才沉淀。
- **评分器有牙、fail-closed**（防呆⑤）：评分器零依赖、永不抛；判定器自身异常折叠成一条保守的
  NO_THROW 破防（宁可误报破防，不可漏报）。100% 存活只有在「引擎能真正判出破防」被独立证明后
  才有意义——故负控用例与「注入旧 bug 端到端抓 bug」的元测试是一等公民。

## 3. 抗压不变量（`survivalCriteria.js` —— 单一真源）

一支防御在极端/敌对输入下「活下来」不是「没报错」，而是六条硬不变量在施压全程恒成立。任一破防
即记一笔 breach（附归因）：

| 不变量 | 含义 |
|---|---|
| `NO_THROW` | 非预期异常零容忍——设计内拒损（FurnaceRejection / 验封拒绝）不算 |
| `BOUNDED` | 有界——绝不无限重试/死循环，必在迭代或时间封顶内终止 |
| `NO_SILENT_FAILURE` | 零静默失败——绝不「返回空且无归因」，必带 E0x 码 / 兜底 / 显式拒损 |
| `ALWAYS_SALVAGE` | 强制兜底——降级耗尽后必交付结构化 salvage，绝不躺平 |
| `BUDGET_FLOOR_HONORED` | 预算地板——极限预算下绝不越界燃烧，地板必被尊重 |
| `FORGERY_REJECTED` | 封印不可伪造——裸/篡改/跨进程伪造的 payload 必被验封拒绝 |

`evaluate(observation)` 逐条检查该向量要求的不变量子集，汇总 breaches；`summarize(results)` 给出
存活率与按不变量/子系统的破防分布。

## 4. 四步闭环（5 模块）

```
武器库(attackVectors) → 施压器(stressHarness) → 评分器(survivalCriteria) → 加固回路(hardeningLoop)
 ──「打什么」───────────   ──「怎么打」──────────   ──「算不算活」──────────   ──「沉淀成需求」──
                                                                              门面: index.js
```

### 4.1 `attackVectors.js` —— 对抗向量单一真源
声明式冻结目录（~19 向量）。每条 `{id, family, target, severity, description, build(), expectInvariants[]}`。
- `TARGET`：`resilience` / `failsafe` / `structuredFurnace`（施压器据此路由驱动器）。
- `FAMILY`：畸形回复 / 资源枯竭 / 故障风暴 / 死循环诱饵 / 高熵混沌 / 封印伪造 / 退化输入。
- 退化原料确定性构造：孤立高代理对（半个 emoji）、200 层深嵌套、32 个控制字、256KB 噪声、拒绝
  套话前缀。`build()` 产出纯数据：`llm-reply` / `raw-error` / `fault-plan`（failEvery/throwEvery/
  identicalSignature/budget/floorPct）/ `unknown-intent` / `nl` / `forge-attempt`（bare/fake-brand/tamper）。

### 4.2 `survivalCriteria.js` —— 抗压不变量评分器
见 §3。纯函数、零依赖、永不抛、fail-closed。

### 4.3 `stressHarness.js` —— 极端环境施压器
把一条向量真正打到对应活防御上，规约成标准 observation。三路驱动器：
- **RESILIENCE**：构造 3 层降级树 + 恒失败/恒抛 runner + 极限预算适配器，驱动 `ResilienceCoordinator.run`；
  死循环诱饵用三层共用同一 (tool, params) 签名逼死循环检测斩断；捕获 `calls`/`salvage`/`circuit`。
- **FAILSAFE**：驱动 `SafeResponseWrapper.validateLLM` / `classify`，捕获 E0x 归因结构。
- **FURNACE**：驱动 `intercept`（敌对 NL 坍缩或显式拒损）与 `assertForged`（伪造 payload 验封）。
- 每次驱动包硬死线；无界/卡死 → BOUNDED 破防。

### 4.4 `hardeningLoop.js` —— 破防 → 需求 加固回路
每条 breach 经 `evoEngine.frictionBridge.observeFailure` 沉淀为进化需求（确定性、fail-soft、自带
去重、落 evoLedger 观测分支）。不变量 → `evoRequirement.SIGNALS.*` 稳定映射。可选注入
`DualTrackForge` 做双轨二次沉淀。永不抛、永不阻断战役。

### 4.5 `index.js` —— 门面 `AdversarialTrainer`
`runCampaign({target?, family?, vectorIds?, harden?})`：逐向量 build → stress → evaluate →（可选）
harden，产出 `{results, observations, summary, breaches, hardened}`。便捷入口 `runDefaultCampaign()`。

## 5. 验证

`node --test tests/services/adversarial/adversarialEngine.test.js` → 12 例绿：
- 武器库自洽（唯一 id / 合法 target / build 确定性 / 合法 expectInvariants / 三子系统全覆盖）；
- 评分器**有牙**：六类破防各一条负控必判破防 + 干净观测绝不误报 + 判定器异常 fail-closed；
- 全量向量打**活防御** → 100% 存活；每子系统向量被真实驱动；无效向量规约为 threw；
- 加固回路：破防经注入 bridge 沉淀且 friction 携完整归因；存活不沉淀；bridge 抛错被吞；
- §6 真实破口的活体回归 + **元测试**（注入旧 buggy 预算语义 → 引擎端到端判出 BUDGET_FLOOR 破防）。

邻近回归：`resilience` / `selfHeal` / `dualTrackForge` / `evoEngine` 共 120 例绿，零回归。

## 6. 由本引擎逼出并已修复的真实破口

**`makeStepBudget(0)` 静默退化为缺省 3 步**（`resilience/budgetExecutor.js`）。

旧实现 `Math.max(1, Number(totalSteps) || MAX_FALLBACK_DEPTH)`：因 `0` 是 falsy，`Number(0) || MAX`
求值为 `MAX`。后果——调用方声明「已无预算」（0 步），执行器却仍获得缺省 3 步预算，越过地板烧掉
最多 3 个 Plan，**预算地板形同虚设**。这是一条隐藏在巧合背后的 `BUDGET_FLOOR_HONORED` 破防。

修复：**显式数字一律照单全收**（向下取整、夹到 ≥0），只有「压根没给可解析数字」（undefined /
NaN / 非数）才回落缺省。`Number.isFinite(n) ? Math.max(0, Math.floor(n)) : MAX_FALLBACK_DEPTH`；
`snapshot()` 在 `total===0` 时返回 `remainingPct:0`，使地板闸门立即熔断、绝不空转烧 Plan。

安全性：仓内仅有的两处内部调用均传 `tree.plans.length`（恒 ≥1），不受影响；语义变化只触及显式
0/负的「真枯竭」场景。`zero-step-budget` 向量去掉施压器旧旁路后**经公开工厂**驱动，成为该修复的
活体回归守护——工厂一旦退回旧 `||default` 行为，0 步预算会静默变 3 步，引擎当即判出破防。

## 7. 后续增强（未接线，留后续 PR）

- 把 agent 主循环模型作为 `brain` 注入 `DualTrackForge`，对破防做 L2 架构级需求增益（当前仅
  确定性 frictionBridge 主沉淀）。
- 周期性自动战役（如 `khy selfcheck --adversarial`）+ 破防趋势台账，把对抗训练纳入 CI 门禁。
- 扩展武器库到 `selfHeal` 微循环与 `evoEngine` 沙箱毒性闸门的直接施压（当前经 resilience 间接覆盖）。
