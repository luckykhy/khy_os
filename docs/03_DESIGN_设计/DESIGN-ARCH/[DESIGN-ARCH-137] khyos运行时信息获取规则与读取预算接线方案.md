# [DESIGN-ARCH-137] khyos 运行时信息获取规则与读取预算接线方案

> 状态：**提案待评审**（2026-09-23 初稿，尚未编码）
> 范围：`PROCESS-007`（B4 引导式搜索 / B5 压缩保留清单）从「只服务外部 AI 改本仓」扩展为「同时约束 khyos 运行时的信息获取」，并把它已建成但休眠的执行体接电
> 上游依赖：`[DESIGN-ARCH-052]`（任务驱动读取与搜索范围规划）、`[DESIGN-ARCH-135]`（压缩回写，一期已落地）、`[DESIGN-ARCH-121]` §K-06（B4/B5 的来源）
> 规则映射：`PROCESS-007`（本文扩展对象）、`PROCESS-008`（新机制落地阶段）、`RUNTIME-003`（活动式超时）
> 模板合规：体例照 `[DESIGN-ARCH-124]`；**不引入任何外部借用**，故不涉及 B-P2 七字段

---

## 0. 一句话结论

规则早就有了，缺的是**接线**——而接线断在四个各自独立、都已被实测确认的缝上：

1. **B4/B5 的正文与运行时脱节**：`services/backend/src` 下 3120 个文件中，「引导式搜索」「全量读取」「精准而非全知」「PROCESS-007」命中数**全部为 0**。B4 只管「外部 AI 改这个仓库」，不管「khyos 做用户的任务」。
2. **B4 的执行体已建成但三重休眠**：`contextScope` 五个模块齐备、测试全绿，却「默认关 × 输出零消费者 × 能力矩阵标 catalog-only」。
3. **B5 的通道建了半截**：`PreCompact` 在 `hookRunner.js:33` 声明了 `additionalContext`，而唯一的触发方 `contextCompressor.js:624` **只读 `.blocked`**，1600 行内该字段命中 0 ⇒ 今天就算插一条 PreCompact 钩子，它返回的保留清单也会被**静默丢弃**。
4. **真正填满窗口的东西不在规则射程内**：单次工具结果 = 窗口的 5%，**且全仓无任务级累计上限**；同时动态预算**覆盖**而非取小，使一批刻意调小的 per-tool 上限在 loop 内全部失效。

⇒ 本方案不新建规则体系、不新建注入通道，只把既有实现接上电，并在 **S1 观察者档**起步。

---

## 1. 现状实证（file:line 可复核）

### 1.1 规则存在，但只作用于「改本仓」这一场景

| 项 | 位置 | 实测 |
|---|---|---|
| B4 引导式搜索 | `CLAUDE.md:63` | 正文是四步动作序（Grep 符号 → Glob → Read 2–3 个 → 大输出先评估委派） |
| B5 压缩保留清单 | `CLAUDE.md:79` | 四类：已改文件路径 / 失败用例与堆栈 / 未完成步骤 / 本次守卫结论 |
| 登记 | `RULES-REGISTRY.json:2760-2784` | `gate: "manual"`，**无 `exec`、无 `severity`** |
| 自认无守卫 | `RULES-REGISTRY.json:2772` | `exception` 原文：「B4/B5 均属流程约定，**无机械守卫**，靠人工评审与压缩器日志兜底」 |
| 运行时命中 | `services/backend/src/**`（3120 文件） | 四个特征串命中 **0** |

### 1.2 B4 的执行体已建成，但三重休眠

- 路径：`services/contextScope/index.js:2` 是转发壳（注释「Do not edit - move …」），实体在 `services/backend/src/services/domain/session/contextScope/`。
- 五个模块齐备：`taskSignalExtractor` / `aiMapIndex`（解析 `.ai/CONTEXT.yaml` 建符号倒排）/ `scopeRanker`（带理由排序）/ `budgetController`（**「不全知」内核**）/ `searchPlanBuilder`。
- `budgetController.js:22-29` 的默认值就是 R3 要的契约：`maxFiles 8` / `maxBytes 256KB` / `marginalFloorRatio 0.18` / `satisfiedConfidence 0.85` / `confidenceScale 18`；`:114-121` 恒返回 `selected/deferred/stopReason/confidence`，注释明写 *"The function never selects 'all files'"*。

**休眠三重（三重都必须解，缺一不可）**：

| # | 休眠 | 证据 |
|---|---|---|
| 1 | 默认关 | `agenticHarnessService.js:141` 要求 `KHY_CONTEXT_SCOPE === '1' \|\| 'on'`；未在 `flagRegistry` 注册 |
| 2 | **输出零消费者** | 全仓 `scopePlan` 命中 6 处：3 处在文档，3 处在 `agenticHarnessService.js` 的 `let`/赋值/`return`。**无一处读取 `.readPlan` 或 `.searchPlan`**（`readPlan`/`searchPlan` 的其它命中全在测试里） |
| 3 | 能力矩阵标只读 | `capabilityMatrix/predicates.js:81` 注释 `(cognitiveSnapshot, contextScope). Catalog-only in cut 1.` |

> `[DESIGN-ARCH-052]` §7 自认第 2 条：「后续可用 `scopePlan.searchPlan` 驱动 `cli/ai.js` 预取替换启发式 `exploreTool` 推断（**待后续 PR**）」。该 PR 从未落地。

### 1.3 B5 的通道建了半截

```js
// contextCompressor.js:624  ——  生产端已就位，消费端缺失
const preHr = await hookSys.trigger('PreCompact', { messageCount, totalTokens, usageRatio });
if (preHr.blocked) { /* … */ }        // ← 只读这一个字段
```

- `hookRunner.js:33`：`PreCompact: ['additionalContext']` —— 契约上允许返回。
- `contextCompressor.js` 全文 1600 行：`additionalContext` 命中 **0**。
- 全仓 `additionalContext` 的**唯一有效消费者**是 `toolUseLoopCore.js:2359`（`PrePrompt` 路径，clean append 语义）。这一点本仓已实测记录在 `agentFeedbackService.js:16-18` 与 `hookSystem.js:48-53` 的注释里：
  > *「Lives on PrePrompt because `additionalContext`（the only field that reaches the conversation）is whitelisted for PrePrompt but NOT for PreToolUse」*
- `.khy/hooks.json` 现有 4 条 `PreToolUse`，**无 `PreCompact`**。

### 1.4 「顷刻间就满」的确切算术

```js
// tools/index.js:977-988
const CHARS_PER_TOKEN = 3;
const contextChars = contextWindowTokens * CHARS_PER_TOKEN;
const budget = Math.round(contextChars * 0.05);         // 窗口的 5%
_dynamicResultLimit = Math.max(8000, Math.min(40000, budget));
```

| 事实 | 后果 |
|---|---|
| 200K 模型 → `600000 × 0.05 = 30000` 字符 ≈ **10,000 token／次调用** | 单次工具结果即占窗口 5% |
| 该预算是**每次调用独立计算**的，全仓**无任务级累计上限** | 约 20 次调用 = 100% 窗口 |
| `tools/index.js:1029-1043` 优先级为 `显式参数 > 动态预算 > per-tool 静态值` | 动态预算一旦设置，per-tool 静态值**完全不被查询** |
| ⇒ `FileWriteTool=1000` / `ConfigureModelProvider=2000` / `scaffoldFiles=3000` | 在 loop 内被统一抬到 8K–40K，**刻意调小的上限静默失效** |

**完整时间线（这就是用户感知到的现象）**：约 20 次工具调用 → 触发压缩（阈值单一表达式见 `[DESIGN-ARCH-135]` §10.6）→ 摘要折叠细节 → 模型重读刚读过的文件 → 再次触发。

> 压缩只**推迟**一轮症状，**读取量本身无人约束**。B4 管「读几个文件」，而填满窗口的是「每次能塞多少」，这一层此前没有任何一条规则在管。

### 1.5 可复用的既有范式（本方案不重造）

| 范式 | 位置 | 复用于 |
|---|---|---|
| **钉住原文而非嘱咐模型** | `contextCompressor.js:745-767`（`<original_task>` 锚点，`TASK_ANCHOR_MAX_CHARS = 1500`）；`:843-846` 把锚点作为独立消息注入压缩结果 | 契约 D |
| 摘要提示词的拼装缝 | `contextCompressor.js:772-774`（`[Original task to preserve]` + `oldTextWithTasks` → `callModelFn`） | 契约 D |
| 工作集 pin | `contextCompressor.js:1349`（Working-Set Aware Pinning，B8）+ `:1468 adjustSplitForPins` | 契约 D |
| **代码级 function hook 注入** | `hookSystem.js:37-47`（`ChangeWatchInjector`）/ `:54-64`（`AgentFeedbackInjector`）—— `registerFunction('PrePrompt', makePrePromptInjector(), {source, priority})` | 契约 A、D |
| PrePrompt 注入器工厂 | `changeWatchService.js:695-711`、`agentFeedbackService.js:217-234`（返回 `{action:'modify', additionalContext}`） | 契约 A、D |
| `iteration` 已传入 PrePrompt | `toolUseLoopCore.js:2346-2349` | 契约 A（只在首轮注入） |

> **关键约束（决定契约 D 的生产端形态）**：`.khy/` 被 gitignore，属**本机态**（`AGENTS.md`）。因此保留清单**不能**依赖 `.khy/hooks.json` 条目——那份配置不随产品发布。生产端必须是 `hookSystem.init()` 里的**代码级 function hook**。两个既有注入器正是这么做的，本方案照此。

### 1.6 已闭环项（明确不在本方案范围）

- `[DESIGN-ARCH-135]` 一期/二期**已于 2026-09-23 落地**：压缩结果**已回写会话真源**（`reconcileTurnHistory` 可选第四参 + `_applyCompactedView`），终态信号已透出。本方案**不再处理**「压缩不接续」。
- 压缩阈值三方不一致已收敛为同一表达式（`contextRouter.toolLoopCompactTriggerTokens`）。本方案**不再处理**阈值。

---

## 2. 规则设计：运行时信息获取规则（三轴六条）

**三轴**：**定位**（搜什么）→ **取样**（读多少）→ **存续**（读过的怎么活过压缩）。

| # | 轴 | 规则 | 可机判契约 | 复用机制 | 现状 |
|---|---|---|---|---|---|
| **R1** | 定位 | **先定位后读取**——任何 Read 之前必须有一次 Grep/Glob 或 `.ai/` 索引命中 | 同一任务内 `Read` 调用不得早于首个 `Grep`/`Glob` | `aiMapIndex` + `searchPlanBuilder` | 已建成，未接 |
| **R2** | 定位 | **按符号名定位**——以符号/标识符为主键，不以文件名为唯一依据（本仓同名文件多） | 排序理由须含「精确符号 / 部分符号」类证据 | `taskSignalExtractor` + `scopeRanker` | 已建成，未接 |
| **R3** | 取样 | **任务级累计读取预算 + 充分即停**——累计 `maxFiles`/`maxBytes` 双上限，恒返回 `stopReason`，禁止「读全部」 | `applyBudget` 恒有 `stopReason`；累计而非单次 | `budgetController.applyBudget` | 已建成，未接 |
| **R4** | 取样 | **单次上限取小**——`min(动态预算, per-tool 静态值)`，不覆盖 | `applyResultBudget` 的取值序 | `tools/index.js:1029` | **缺陷**：现为覆盖 |
| **R5** | 存续 | **读过的活过压缩**——四类保留清单以**钉住区块**注入，不依赖模型服从 | 压缩结果中四类区块存在 | `contextCompressor`（两端各缺一半） | **半接通** |
| **R6** | 存续 | **已读不重读**——同任务内已读且未变的文件不重读 | 读取台账去重 | 新增（会话内台账） | 未建 |

**规则归属决策**：**扩展 `PROCESS-007`，不新建规则 ID**。理由：`[DESIGN-ARCH-052]` 已把 B4 的语义完整实现并验证（22 例测试），新建规则会产生两份意图相同的语义真源，违反单一真源原则。扩展方式是在 B4/B5 正文各补一句「运行时同样适用 + 执行器指向」，**不改规则语义**。

---

## 3. 目标形态（组件级契约）

### 契约 A —— 读取计划的送达（R1/R2 生效）

**不新建注入通道**，用 `PrePrompt` 的 `additionalContext`（唯一被证明可达对话的字段）。

- 新增 `builtin:ReadScopeInjector`，注册在 `hookSystem.init()`，范式照 `ChangeWatchInjector`（`hookSystem.js:37-47`）。
- **仅在 `iteration === 1` 注入**（`toolUseLoopCore.js:2346-2349` 已把 `iteration` 传入 context）。
- 内容 = `scopePlan.readPlan.files`（≤ `maxFiles` 条，含理由）+ `searchPlan.grepPatterns`，渲染为确定性中文块（零 LLM、可单测），并附一句 `stopReason` 与 `confidence` —— 让模型知道「这是**够用**的清单，不是候选清单」。
- **落在 user 轮，不落 system 段**（理由见 §6）。
- 依赖：`agenticHarnessService.buildContextPacket` 的 `scopePlan` 需可达注入器（一期打通）。

### 契约 B —— 累计读取预算生效（R3 生效）

- `KHY_CONTEXT_SCOPE` 由「默认关」改为「**默认开、可关**」（`KHY_CONTEXT_SCOPE=0` 关）。不新增 env 门（§5）。
- `budgetController` 的 `maxBytes` 默认值从 `256KB` **下调**：256KB ÷ 3 ≈ **87K token ≈ 200K 窗口的 43%**，等于没省。改为按窗口派生，与 `contextProfile.deriveToolResultCap` 同源。
- 保留 `applyBudget` 的确定性内核不动——它是对的。

### 契约 C —— 单次上限取小（R4 生效）

`tools/index.js:1029-1043` 改为：

```
limit = min(显式参数 ?? ∞, 动态预算 ?? ∞, per-tool 静态值 ?? DEFAULT)
```

三者全缺 → `DEFAULT_MAX_RESULT_CHARS`。per-tool 未声明的工具行为不变 ⇒ 可逐字节回滚（撤一处改动即回旧行为）。

### 契约 D —— 保留清单钉住（R5 生效）

**两处改动，缺一不可**（这是 1.3 实测的直接结论）：

| 端 | 改动 | 落点 |
|---|---|---|
| **消费端** | 新增读取 `preHr.context?.additionalContext`，非空则拼进摘要提示 | `contextCompressor.js:624`（触发处）+ `:772`（`summaryInput` 拼装处） |
| **生产端** | 新增 `builtin:CompactRetentionInjector`（代码级 function hook，**非** `.khy/hooks.json`，理由见 §1.5） | `hookSystem.init()`，范式照 `:54-64` |
| **落点** | 生成的四类区块以 **pin 形式**追加到压缩结果（照 `:843-846` 任务锚点范式） | `contextCompressor.js` |

**四类的确定性来源**（不依赖模型回忆）：

| 类别 | 来源 | 现成度 |
|---|---|---|
| 已修改文件完整路径 | 本回合 tool call log / `git status --porcelain` | 现有 |
| 失败用例与错误堆栈 | 工具结果中的 test/build 输出（`smartTruncation` 已按 profile 分类） | 现有 |
| 未完成步骤 | `<execution_plan>` 的 `parseExecutionPlan`（`aiChatCore.js:3657-3671`） | 现有 |
| 本次守卫结论 | ruleguard 台账 `.khy/ruleguard/violations.jsonl` | 现有 |

> **诚实边界**：某一类若无法确定性取得，**如实留空并标注该类别未采集**，不得用摘要代填（`RUNTIME-002`）。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 触及文件 | 回滚方式 | 独立价值 |
|---|---|---|---|---|
| **一期** | 契约 B + C：取小 + 累计预算生效 | `tools/index.js`、`agenticHarnessService.js` | 恢复旧优先级 / 恢复旧门 | **最高**——直接减少单次与累计读取量，不需要任何新通道 |
| **二期** | 契约 A：读取计划注入 | 新增 injector + `hookSystem.js` | 注销 `registerFunction` | 让 B4 从文档变成每轮一次的注入 |
| **三期** | 契约 D：保留清单钉住 | `contextCompressor.js` ×2 + 新增生成器 | 字段缺省 → 走旧 prompt | 打断「压缩 → 忘 → 重读 → 又满」循环 |
| **四期** | R6 读取台账 | 会话内台账 | 台账缺省 → 不拦截 | 消除重复读取 |

**一期单独就应可交付**，且不依赖任何后续期。建议按一 → 三 → 二 → 四的顺序做：三期打断的是**循环**（结构性收益），二期只优化**首轮**（边际收益）。

### 4.1 每期随附的登记动作（`PROCESS-008`）

每期落地时同步完成，缺一则守卫会报：

| 动作 | 落点 | 判据 |
|---|---|---|
| 新增执行器 | `scripts/ci/check-read-discipline.js`（**必须在 `scripts/ci/` 下**，ruleguard 只跑该目录） | 顶部 `const STAGE = 'S1';`，单点 `if (STAGE === 'S1' \|\| STAGE === 'S2') return 0;` |
| 登记机制 | `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]` | `stage/stageSince/previousStage/executorStage{file,constant,note}/samples{observed,target,note}/rollback/blockedBy` |
| 挂执行器 | `RULES-REGISTRY.json` 的 `PROCESS-007` | `gate: "manual" → "commit"`（**不可写 `advisory`**——`gate=advisory` 在任何门档都不执行）、`severity: "advisory"`、`exec: {script, args, findings, anchors, carriers}` |
| 更新 `exception` | `RULES-REGISTRY.json:2772` | 现文「无机械守卫」在挂上执行器后**即失效**，须改写 |
| npm 别名 | `package.json` 加 `check:read-discipline` | `check:wiring` 要求 `scripts/ci/` 下检查器被至少一个门面引用 |
| 重生成规则卡 | `npm run docs:rules-cards` | 规则卡是构建产物，禁手改；`check:rules` 会比对 |

**执行器的 findings（S1 只记录，不阻断）**——它检查的是**接线完整性**，不是行为：

| finding | 判据 |
|---|---|
| `retention-consumer-missing` | `PreCompact` 声明了 `additionalContext`，而 `contextCompressor` 未读取 |
| `retention-producer-missing` | `hookSystem.init()` 未注册 PreCompact function hook |
| `result-budget-shadows-static` | `applyResultBudget` 的取值序仍是覆盖而非取小 |
| `scope-plan-unconsumed` | `scopePlan` 被产出但无消费者 |
| `scope-gate-default-off` | 读取计划仍为默认关闭 |

> 这个守卫的价值正在于钉住**接线**：本方案要修的四个缝，全都是「两端各自存在、中间没连上」——只有接线完整性守卫能防它再次断开。

---

## 5. 诚实边界（刻意不纳入 —— 逐条给原因）

| 不做 | 原因 |
|---|---|
| **不新建规则 ID** | 见 §2 归属决策：会产生两份同义真源 |
| **不新增 env 门** | `scripts/ci/check-tui-gates.js` 的 `MAX_GATES = 220` 是**只降不升**棘轮；`utils/selectGates.js:18` 明写「只有当开关对应一种真实的用户可见权衡时才值得加门」。回滚能力用「可选参数缺省 = 旧行为」实现 |
| **不改 `PROCESS-007` 的 `ssot`**（仍为 `CLAUDE.md`） | 只在 B4/B5 正文补「运行时同样适用」一句，保持单一语义真源 |
| **S1 不阻断** | `PROCESS-008` PP-3 是红线：S1/S2 必须旁路记录 |
| **不重复处理「压缩不接续」/压缩阈值** | `[DESIGN-ARCH-135]` 一二期已落地（§1.6） |
| **不引入向量检索 / embedding** | 词法打分 + `.ai/` 符号倒排已足够定位；引入 embedding 是另一个量级的成本与依赖 |
| **不引入固定时长 kill** | 与 `RUNTIME-003` 冲突；读取预算用累计上限表达，不用墙钟 |
| **不试图拦截模型的每一次 Read** | 工具层硬拦截属 S3 门禁档，须先有 S1/S2 的样本；一期只做「让读取计划可见 + 让预算真的生效」 |

---

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| **把读取计划注入 system prompt** | 它每任务一变 → 摧毁 prompt 缓存。`systemPromptSections.js:68` 的 `DANGEROUS_uncachedSystemPromptSection` 正是为此存在的；正确落点是 user 轮 |
| **用 PreCompact 钩子直接往对话里注入** | `PreCompact` 的 `additionalContext` **无消费者**（§1.3）；能从钩子进对话的**只有 `PrePrompt`** |
| **靠「嘱咐模型保留四类」实现 B5** | 与 B5 失效同因：文本约束零机制强制。要**钉住**（`<original_task>` 范式），不要**嘱咐** |
| **把 `maxBytes = 256KB` 原样接上** | 87K token ≈ 200K 窗口 43%，等于没省。接线时必须一并下调 |
| **在 `.khy/hooks.json` 里配 `PreCompact`** | 该目录 gitignore，不随产品发布；必须是 `hookSystem.init()` 的代码级 hook |
| **为「让回滚可测」新增 env 门** | 撞门预算棘轮。用可选参数缺省（`undefined` → 旧行为）+ 逐字节等价断言 |
| **`process.exitCode = 0` 之后没有单点短路** | S1 的正确形态是「判定全跑、finding 全打印、**单点**决定退出码」；分散短路会漏掉 finding |

---

## 7. 验收方式（可复现命令 + 关联门禁）

### 7.1 单元层（每期各自的用例）

```bash
# 一期：取小语义 + per-tool 静态值不再被静默覆盖
node --test services/backend/tests/services/contextResultBudget.minSemantics.test.js

# 一期：累计预算恒返回 stopReason，且永不为「读全部」
node --test services/backend/tests/services/contextScopeBudget.test.js

# 二期：仅 iteration===1 注入；计划渲染确定性（同输入同输出）
node --test services/backend/tests/hooks/prePromptScopeInjector.test.js

# 三期：消费端读到 additionalContext；四类区块 pin 进压缩结果
node --test services/backend/tests/services/contextCompressorRetention.test.js

# 接线完整性守卫（S1 只记录）
node scripts/ci/check-read-discipline.js
```

**必须钉住的两条语义**（照 `[DESIGN-ARCH-135]` 的方法论）：

1. **逐字节等价回滚**：契约 C 改动后，per-tool **未声明** `maxResultSizeChars` 的工具，其截断行为与改动前 `deepStrictEqual`；
2. **缺失即降级**：契约 D 的生产端不返回 `additionalContext` 时，`contextCompressor` 的摘要提示词与改动前**逐字节相同**。

> ⚠️ 新增用例一律用 `require('node:test')`——CI 跑 `test:node = node --test tests/**/*.test.js`，**落地即绿**是硬要求；用 jest 全局写在 `node --test` 下会 `jest is not defined` 落地即红（`[DESIGN-ARCH-135]` §4.1/§10.7 已实测）。

### 7.2 集成层（人工，一次性）

1. 开 TUI，给一个会触发多轮工具调用的任务；
2. 用 `KHY_CONTEXT_PREEMPTIVE_RATIO=0.1` + `KHY_CONTEXT_HARD_FLOOR=0` 让压缩提前触发（`contextRouter.js:51-64` 已支持）；
3. 断言：**首轮**的对话上下文中含读取计划块，且带 `stopReason`；
4. 断言：压缩结果行出现后，**下一轮**的上下文里四类区块仍在，且**不是摘要转述**（含原始路径/堆栈原文）；
5. 断言：把同一任务的文件读取次数与改动前对比，**累计读取字符数下降**（这是本方案唯一的量化收益判据）。

### 7.3 关联门禁

```bash
npm run docs:verify          # 本文 .html 孪生（docs:build 产物）
npm run check:layout         # 层级 / 索引完整性
npm run check:wiring         # 新执行器必须被门面引用
npm run rules:coverage       # 覆盖率红线（P0 无执行器 / 死指针）
npm run check:rules          # 登记表 ↔ 真源双向可达 + 规则卡一致
npm run rules:gate -- --mode pr
```

> ⚠️ `docs:build` 是**手动**的（`.githooks/*` 与 `.github/workflows/*` 均未接线），`docs:verify` 也未进 CI ⇒ 新文档的 `.html` 孪生必须本机跑完，否则遗漏不会被自动发现。

---

## 8. 待核实项

| # | 项 | 影响 | 优先级 |
|---|---|---|---|
| 1 | `scopePlan` 该由谁持有给注入器——`buildContextPacket` 的返回值在 TUI 直调路径上是否可达（TUI 绕过 harness，见 `[DESIGN-ARCH-135]` §0） | 决定契约 A 二期是走 harness 还是需在 TUI 侧另取 | **高** |
| 2 | `parseExecutionPlan` 在压缩发生时是否已有当前步骤进度（`onPlanProgress` 的时点） | 决定「未完成步骤」这一类的可用性 | 中 |
| 3 | ruleguard 台账 `.khy/ruleguard/violations.jsonl` 的「本次」边界如何切（按任务 ID 还是按会话） | 决定第四类的语义精确度 | 中 |
| 4 | 下调后的 `maxBytes` 取值（按窗口比例派生 vs 固定值） | 影响 R3 的实际收益 | 中 |

> 未列入的都没查清就**不写**。以上四项均为已知未决，不是遗漏。

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-23 | 初稿。诊断基于 `tools/index.js` / `contextCompressor.js` / `hookRunner.js` / `hookSystem.js` / `agenticHarnessService.js` / `contextScope/*` 源码实测；「运行时零命中」经 `services/backend/src` 全量 3120 文件扫描确认；`scopePlan` 零消费者经全仓符号扫描确认；压缩回写与阈值两项已确认由 `[DESIGN-ARCH-135]` 闭环，故不在本方案范围 |
