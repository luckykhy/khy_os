# [DESIGN-ARCH-138] 工具调用能力判定与文本拦截协议

> 状态：**已落地**（P0/P1/P2/P3；P4 余项见 §7）
> 范围：`modelToolingCapability.js`（判定单一真源）、`toolCallingProbe.js`（实测判据）、`toolCapabilityStore.js`（缓存与通道分区）、`capabilityModelKey.js`（键命名空间）、`multiFreeService.js` / `relayApiAdapter.js`（两处剥离门与 400 降级链）、`toolChallengeCadence.js`（挑战节流）、`gatewayRuntimeProbes.js`（排障入口）
> 上游依赖：`RUNTIME-001`（零硬编码）、`RUNTIME-002`（状态透明）、`SECURITY-004`（fail-closed）、`RUNTIME-010`（未明确授予不得可获得）
> 触发：2026-09-23 用户实测 —— 界面提示「模型 agnes-3.0-flash 不支持工具调用…请切换到支持 function calling 的模型」，但同一轮已执行 6 个工具
> 取证：`.khy/feedback/toolcall-capability-falseneg-20260923/`（复现脚本 + 前后对照 + 差分诊断 + 交付记录）
> 借用申报：**不适用**（本方案修复的是本仓自有的判定链，未借鉴任何外部实现；按 `[DESIGN-SOURCING-001]` §3 据实声明）

---

## 0. 一句话结论

**「所有模型都不支持工具调用」不是模型的事实，是判定链的事实：判据把「没有看到原生调用」当成了「不会原生调用」，而一旦这么判，工具就从每个后续请求里被删掉 —— 模型再也无法用原生调用证明自己，误判于是无法被现实推翻。**

四条互相独立的病灶，各自可修、可回滚：

| # | 病灶 | 位置 | 症状 |
|---|---|---|---|
| **A** | 「回文字、没回 tool_calls」= 不支持 | `toolCallingProbe.js`（旧 `interpretProbeResult`） | 散文 / 截断 / 自述不会调用工具，三种无定论证据被判成同一个负向结论 |
| **B** | 名字启发决定 wire | `modelToolingCapability.js`（旧 `shouldStripUpstreamTools`） | 未实测的 `*-flash` 模型开局即被剥离 |
| **C** | 负向裁决自我焊死 | 剥离门 × 被动学习（只晋升不降级） | 判错之后无翻案路径，只能等 7 天 TTL |
| **D** | 逃生舱半坏 + 文案说反 | env 名单裸名比较；内联提示文案 | `KHY_NATIVE_TOOL_MODELS` 修得了剥离门、修不了教学门；提示让用户去换模型 |

---

## 1. 判定链的两种、三态、两维度

### 1.1 工具调用的两类（按**载体**划分，不按模型大小/家族）

| | 原生工具调用（native） | 文本拦截式（text） |
|---|---|---|
| wire | `tools` 随请求上行 | 不上行（或上行被上游丢弃） |
| 模型产出 | 结构化 `tool_calls` / `tool_use` blocks | 正文里的显式调用语法 |
| 判据 | `toolUseBlocks` 非空 或 `finish_reason ∈ {tool_calls, tool_use}` | `toolCallParser.hasExplicitToolCallSyntax` |
| 解析 | `nativeAdapter.parseToolCalls` | `textAdapter.parseToolCalls` → 多方言 |
| 回灌 | 结构化 `tool_result` / `role:'tool'` | 纯文本 |
| 可用前提 | 适配器有原生通道 ∧ 模型具备 ∧ 上游不拒 `tools` | 教学门已注入 ∧ 解析器覆盖该方言 ∧ 工具名可执行 |

**两条纪律**：判据是载体而不是模型大小；两类必须共用同一条执行链（同一 `executeTool`、同一权限门、同一审计），只在「解析」与「回灌格式」两个函数上分叉（`toolProtocolAdapter.js`）。`syntheticToolLayer` 不属于第三类 —— 它是宿主代发起，性质不同，留在兜底层。

### 1.2 三态不对称

| 裁决 | 证据强度 | 有效期 | wire 行为 |
|---|---|---|---|
| `native` | 正面证据，可确证 | 永久 sticky | 发 |
| `text` | **要求正文出现显式调用语法** | 有界 TTL（默认 7 天） | 剥 + 教文本协议 |
| `unknown` | 不下结论（失败/截断/空/散文） | 不落库 | 发 |

### 1.3 两个维度

模型维（`measured`）与**通道维**（`routeRejects`）。「收不收 `tools` 字段」是端点的属性：同一条通道拒绝 `tools` 不代表模型不支持，更不代表换条通道也拒绝。此前能力档案只有模型名一个维度，一条严格端点的拒绝会被记成模型的永久属性。

---

## 2. 落地内容

### 2.1 A — 判据要求正面证据（P1）

`interpretProbeResult(result, opts)` 的判定顺序：

1. 原生信号（`toolUseBlocks` / `finish_reason`）→ `native`
2. `success === false` → `unknown`（瞬时失败绝不判成不支持）
3. `finish_reason ∈ {length, max_tokens, max_output_tokens, content_filter}` → `unknown`
   （**必须早于**文本判定：否则一段被截断的前言会被读成「回了文字 = 不支持」）
4. 正文非空且 `opts.hasExplicitToolCallSyntax(text) === true` → `text`
5. 其余 → `unknown`

判据经 `opts` 注入（单一真源 `tool/toolCallParser.hasExplicitToolCallSyntax`），**不注入则永远得不到 `text`** —— 刻意的 fail-safe 方向。判据排除自然语言档（Format 3）：意图检测是概率的，不能支撑粘性能力裁决。

探测参数：`maxTokens` 64 → 256，提示词要求「不要前言」——前言会吃光输出预算，把「没来得及生成」伪装成「没有调用」。

### 2.2 A′ — 对照组：把通道问题与模型问题分开（P1）

主组**失败**时补一次「同提示词、不带 tools」：A 败 B 成 → `route-rejects-tools`（通道拒绝 `tools`）。该态属通道，**不按模型键落库**。

### 2.3 B — wire 侧只认正面证据（P2）

`shouldStripUpstreamTools` 档位：env 钉子 → 实测 `text`/`native` → 通道拒收 → **其余一律发**。
名字启发退出 wire 判定，但**保留在提示词侧**（`modelLacksReliableToolCalling`）。
两门不锁步是安全的：教学文案是**加性**的（`_toolCallingFallbackProfile` 标题即 `Tool calling (text-based fallback)`，不断言「你没有原生工具」），且文本调用在两条协议下都会被 `resolveToolCalls` 解析执行 —— 暂定档有两条成功路径，任一条走通都算成功。**不得把两门改成耦合**。

未知档的代价是明账：真拒收 `tools` 的通道第一次请求多一个 400 往返，而那一趟正是把 `routeRejects` 记下来的对照证据，记下之后不再付第二次。

### 2.4 通道分区与身份（P2，P4 部分前移）

- `capabilityModelKey.routeKey()` → `<adapter或provider>::<host>[:port]::<裸模型名>`（不硬编码任何主机名，只解析调用方报上来的 endpoint）
- `toolCapabilityStore` 的 `route:` 前缀分区：与模型级记录同文件、不同命名空间、独立 TTL、不参与模型键迁移
- 两处 400 链在**重试成功之后**才记（`_toolsStrippedFor400` / `_toolsStrippedForRetry`）：仅凭「看到 400 且当时带着 tools」不足以下结论，那个 400 可能因为别的字段

### 2.5 C — 隔离式挑战（P3）

`toolChallengeCadence` 按 `(通道 × 模型)` 计请求数，每 N 次（默认 10，`KHY_TOOL_CAP_CHALLENGE_EVERY`）放行一次原生挑战：那一轮照发 `tools`，模型若原生调用即被被动学习晋升 `native`，错误结论当场推翻，不必等 TTL。

**只做单边**（跳过剥离、不动提示词）：教学文案是加性的，模型在挑战轮有「原生调用 / 回退文本语法」两条路，后者照样被解析执行 —— 因此不需要两侧协调，也就没有失同步风险。

**不越权**：通道已被判拒收时不挑战（那是端点的定论，该由它自己的 TTL 到期重试）；env 钉子连挑战轮也不越过。两条都由判据层强制，不依赖调用方自觉（`SECURITY-004` / `RUNTIME-010` 同精神）。

计数粒度是**每 (通道 × 模型) 的请求数**，不是严格回合语义 —— 一次工具循环内有多次请求，本机制按请求采样。这是采样节奏，不是精确回数。

### 2.6 D — 逃生舱与文案（P0）

- env 强制名单改用与实测缓存同一套键（`capabilityModelKey` 规范化）：`KHY_NATIVE_TOOL_MODELS=agnes-3.0-flash` 对路由 id 形态同样生效
- 提示文案收口为 `stripToolsNotice()` 单一真源，两个剥离门不再各持一份字符串；文案陈述事实（未确证 / 工具仍可用）并给出复测命令，不再引导用户换模型

---

## 3. 不变量（不得放宽）

1. **权限门不因协议放宽**：文本协议解析出的调用仍走同一 `executeTool` 审批链。
2. **`native → text` 降级必须显式 `force`**（用户主动重测或 env 钉死）。
3. **门控语义保持**：`KHY_MODEL_TOOLING_CAPABILITY=0` 时字节回退旧内联逻辑（注意：旧正则同样带 `flash`，关掉它并不能解决 flash 误判）。
4. **纯叶子合约**：`modelToolingCapability` / `toolCallingProbe` / `capabilityModelKey` / `toolChallengeCadence` 的纯判定部分零 IO、绝不抛。
5. **通道裁决不写模型键**，模型裁决不写通道键。
6. **两个门不锁步**（§2.3 的理由）。

---

## 4. 机制落地阶段登记（`PROCESS-008`）

| 机制 | 阶段 | 说明 |
|---|---|---|
| 隔离式挑战（`toolChallengeCadence`） | **S1** | 非拦截型：它**放宽**剥离（每 N 次多发一次 `tools`），从不阻断任何流程。登记 S1 是保守取值。回退动作 = `KHY_TOOL_CAP_CHALLENGE=0`（纯配置，满足 PP-4） |
| 剥离门本身（`shouldStripUpstreamTools` 的实际剥离行为） | **不登记，且判定为 `PROCESS-008` 范围外** | 理由见下，可被推翻 |

### 4.1 为什么剥离门不进 `rollout.mechanisms[]`

按 `[DESIGN-PROCESS-002]` 对触发面的定义，那条规则管的是「**新的拦截型机制**（会阻断 AI 或 CI 的**钩子/检查器/门禁**）」。剥离门三条都不满足：

1. **不是新的** —— 它早于该规则存在（`multiFreeService` / `relayApiAdapter` 的 `_decideStripTools` 历史内联正则可溯）。规则不溯及既往。
2. **不是钩子/检查器/门禁** —— 它是网关发请求前的一次 payload 协商，作用对象是上游请求体，不是 AI 的决策流或 CI 的流水线。
3. **不阻断任何东西** —— 请求照样发出、模型照样回答，只是不带 `tools` 字段；调用改由文本协议承载（§1.1 第二类），**工具仍然可执行**。没有任何一步被拒绝。

**明确的反方向判据**（什么情况下这个结论会翻转）：若评审认为「**减少 agent 可用通道**」本身就该受 PP-1 管制 —— 即把「静默降掉一个能力，而 agent 无从知道」视为 gate 级伤害 —— 那么正确做法是登记为 **S3**，并接受 `rollout-stage-skip-s1` / `rollout-stage-samples-insufficient` 点亮。**那两条红点不是误报，而是正确的信号**：该机制确实没有观察期历史（它比规则年长），需要的是补一个观察期方案（例如先把剥离决策改为「记录 + 放行」跑够样本，再恢复剥离），而不是补填一行登记表。本仓没有可用的历史样本，所以我不代填：填 S3 会让仓库变红且无解，填 S1 会让「登记说 S1、代码其实在介入」成为一句假话。

**旁观证据**：自 P2 起剥离已改为「只认正面证据」（未实测一律发、`text` 要求显式调用语法、通道拒收来自带对照的 400），机制自身的冒进面已大幅收窄 —— 这使得「先按现状记录、把观察期方案留作独立决定」在风险上是可接受的。

---

## 5. 复现与验收

```bash
node .khy/feedback/toolcall-capability-falseneg-20260923/repro.js        # 同一条命令的前后对照
node .khy/feedback/toolcall-capability-falseneg-20260923/repro-p1-wired.js
node .khy/feedback/toolcall-capability-falseneg-20260923/check-p2.js
node .khy/feedback/toolcall-capability-falseneg-20260923/check-p3.js
```

回归护栏：`toolCapabilityFalsenegRegression.test.js`（把四条病灶各自钉成断言）、`toolChallengeCadence.test.js`、`toolCallParser.explicitSyntax.test.js`。

---

## 6. 用户可见的变化

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 未实测的 `*-flash` 模型 | 提示「不支持工具调用，请切换到支持 function calling 的模型」，wire 无 tools | 照发 tools；提示仅在确有证据时出现，且给出 `khy gateway probe-tools` 复测入口 |
| 严格端点拒收 `tools` | 每次请求都付一个 400 | 首次付一次（构成对照证据），此后该通道直接剥 |
| 被判 `text` 的模型 | 只能等 7 天 TTL 才能翻案 | 每 N 次请求获得一次原生挑战，可当场翻案 |
| `khy gateway probe-tools list` | 只有模型级两组 | 第三组「通道拒收 tools」，与模型问题分开显示 |

---

## 7. 遗留

1. **`text` 裁决的适配器来源粒度**：已按适配器收敛（`getVerdictFor`，负面不扩散），但记录里仍是适配器级而非**端点级**（同一适配器下两个 pool 共享一条 `text`）。要做到端点级，探测必须报出它实际请求的 endpoint（目前 `verifyToolCalling` 只知道适配器键）。收益递减、改动面不小，暂留。
2. **剥离门的阶段定性**（§4.1）：已给出「范围外」的完整理由与反方向判据，等一次评审确认；若被推翻，后续是补观察期方案，不是补登记行。
3. **khyquant 分叉副本**：`software/khyquant/services/` 下同名文件是独立分支（已分叉，且无 `capabilityModelKey`），仍是旧判定与旧文案。已登记为 BUG-015 待专门决定收敛还是各自维护。
