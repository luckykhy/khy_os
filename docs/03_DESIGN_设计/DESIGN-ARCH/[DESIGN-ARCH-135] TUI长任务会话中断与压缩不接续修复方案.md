# [DESIGN-ARCH-135] TUI 长任务会话中断与压缩不接续修复方案

> 状态：**一期 / 二期 / 阈值同源 / 三期（自动续跑）已落地**（2026-09-23，见 §10 实施记录）；**四期（结束闸门）待拍板**
> 范围：`services/backend/src/cli/tui/` 的查询桥接层 + 会话历史真源的压缩回写
> 上游依赖：`[DESIGN-ARCH-111]`（规则遵守保障）、`[DESIGN-ARCH-122]`（TUI 设计族总纲）、`[DESIGN-ARCH-130]`（前台与后台任务编排）
> 调研指针：`services/backend/src/services/tool/toolUseLoopCore.js`、`services/backend/src/services/agenticHarnessService.js`、`services/backend/src/cli/aiConversationOps.js`
> 模板合规：体例照 `[DESIGN-ARCH-124]`；本文属 **B-P1 豁免**（见 §2）
> 规则映射：`RUNTIME-002`（状态透明）、`RUNTIME-003`（活动式超时）、`PROCESS-008`（新机制落地阶段）

---

## 0. 一句话结论

TUI 直接调用 `runToolUseLoop` 却**只取回 4 个字段**，把循环的两个真值丢在了局部变量里：

1. **「循环为什么结束」** —— 达到迭代上限 / 绝对时间上限时循环返回 `maxIterationsReached: true`，TUI 不读它 ⇒ 长任务停在半路，界面**一个字都不提示**。这就是用户说的「不知什么原因会中断」——不是原因神秘，是**信号被丢弃了**。
2. **「压缩后的上下文」** —— 轮内压缩把 `messages[0..split)` 折成 `<compressed_context>` 摘要，但该结果只赋给函数局部变量 `conversationMessages`；会话真源 `_chatState.messages` 的写回函数 `reconcileTurnHistory` **只认纯文本**，从不接收消息数组 ⇒ **摘要从未进入会话历史**，下一轮的 `initialMessages` 仍是未压缩的原始历史 ⇒ 每轮压缩都是「一次性局部优化」，历史占用单调增长，直到某一轮开局即超窗。

更关键的是：**自动续跑（Ralph Loop）在本仓已经存在，但 TUI 不走它**。`agenticHarnessService.js:511` 的 `while (loopResult?.maxIterationsReached && ...)` 正是用户要的「自动接续」，它的唯一调用方是经典 REPL 与 `queryEngine` —— TUI 不在其中。

### 病灶对照表

| 能力 | 经典 REPL / queryEngine | TUI（用户实际在用） | 证据 |
|---|---|---|---|
| 调用 `runToolUseLoop` | 经 `agenticHarnessService` | **直调**，绕过 harness | `useQueryBridge.js:2934` |
| 读「循环为何结束」 | 读 `timeLimitReached` / `maxIterationsReached` | **零引用** | `replSession.js:12291,12310` vs `useQueryBridge.js` 全文件 |
| 自动续跑 | Ralph Loop，最多 8 轮 | **无** | `agenticHarnessService.js:511-553`；`cli/tui/` 下 `agenticHarness` 命中数 = 0 |
| 压缩结果回写 | 续跑时作为 `initialMessages` 传入 | **丢弃** | `agenticHarnessService.js:539,548` vs `aiConversationOps.js:403-417` |
| 跨轮上下文延续物 | `loopResult.conversationMessages` | 仅一个防重复调用的签名 ring | `useQueryBridge.js:974`（`recentToolSigsRef`）|

---

## 1. 现状实证（file:line 可复核）

### 1.1 压缩确实发生了，但成果止步于局部变量

`services/backend/src/services/tool/toolUseLoopCore.js:2641-2668`：

```js
if (_ccTotalTokens > _ccThreshold) {              // :2641  阈值 = _ccCtxWindow * 0.7
  const cc = require('../contextCompressor');
  const _ccResult = await cc.compress(conversationMessages, {...});
  if (_ccResult.compressed && _ccResult.compressed.length < conversationMessages.length) {
    conversationMessages = _ccResult.compressed;  // :2650  ← 只改局部变量
    const _lastUser = [...conversationMessages].reverse().find((m) => m.role === 'user');
    if (_lastUser) { currentMessage = _lastUser.content; }   // :2654  只把「当前消息」换成最后一条 user
  }
}
```

压缩本身工作正常（`contextCompressor.js` 有完整的 4 阶段切分、任务锚点保留、增量摘要、反抖动、审计）。问题在**产物去哪了**。

### 1.2 会话真源从不接收压缩结果

`services/backend/src/cli/aiConversationOps.js`：

| 函数 | 行 | 行为 |
|---|---|---|
| `getConversation()` | `:342-344` | 返回 `_chatState.messages` 的浅拷贝 —— **下一轮 `initialMessages` 的来源** |
| `snapshotHistoryTurn()` | `:353-359` | 回合开始前的锚点 |
| `reconcileTurnHistory(snapshot, userText, assistantText)` | `:381-422` | 只 `msgs.push({role:'user', content: cleanUser})` 与 `msgs.push({role:'assistant', content: finalAssistant})` —— **签名里就没有消息数组这个入参** |

`useQueryBridge.js:3066` 的调用点实参也只有三项：

```js
_aiMod.reconcileTurnHistory(_turnHistorySnapshot, text, loopResult.finalResponse);
```

⇒ 压缩产生的 `<compressed_context>`、`<original_task>` 锚点、任务快照、被截断的工具结果，**全部随回合结束被 GC 掉**。

### 1.3 循环的结束态被 TUI 丢弃

`useQueryBridge.js:3071-3078`（TUI 拿到 `loopResult` 后构造 `result`）：

```js
result = {
  reply: loopResult.finalResponse,
  provider: loopResult.provider,
  tokenUsage: loopResult.tokenUsage,
  toolCallLog: loopResult.toolCallLog,
};
```

`maxIterationsReached` / `timeLimitReached` / `absoluteLimit` / `maxElapsedMs` / `conversationMessages` / `executedCallKeys` / `contextSummary` —— **一个都没进来**。

对照 `replSession.js:12291-12338`：经典 REPL 不但读了，还分四种情形给不同文案（绝对时间上限 / 空闲超时 / 迭代上限 / 连续失败），并在 `_panelSuccess` 里降级完成面板。

### 1.4 续跑引擎存在但 TUI 未接线

`services/backend/src/services/agenticHarnessService.js:511-553`：

```js
while (loopResult?.maxIterationsReached && continuationRound < maxContinuationRounds && _shouldAutoContinue(userMessage)) {
  continuationRound++;
  const priorMessages = loopResult?.conversationMessages || [];   // :539  ↑ 压缩结果在这
  loopResult = await runToolUseLoop(continuationMessage, {
    ...loopOptions, chat, chatOpts: {...},
    initialMessages: priorMessages,                                // :548  作为下一轮输入
    inheritedDedupKeys: loopResult?.executedCallKeys || new Map(), // :552  跨轮去重
  });
  saveBoulderState(cwd, { ..., conversationMessages: loopResult?.conversationMessages || [] });  // :561-577 检查点落盘
}
```

`agenticHarnessService` 的调用方只有 `replSession.js:11897` 与 `queryEngine.js:459` —— **`cli/tui/` 下零命中**。

`useQueryBridge.js:971` 的注释自己承认了这一点：

> *each「继续」is a new runToolUseLoop with a fresh per-turn detector, which is exactly why the ring must live one level up*

即：TUI 里每个「继续」都是**用户手打触发的新回合**，跨轮唯一延续物是 `recentToolSigsRef`（只用于防重复调用），**不携带任何上下文**。

### 1.5 次级发现（顺带记录，非本次主线）

| 发现 | 位置 | 说明 |
|---|---|---|
| 注释与代码不符 | `toolUseLoopCore.js:685` 写 *fallback: `KHY_TOOL_LOOP_MAX_ITERATIONS` or 10* | 真值 `MAX_ITERATIONS = 100`（`services/tool/loop/iterations.js:21`）。注释过时 |
| 压缩阈值基准可能双源 | `toolUseLoopCore.js:2640` 用 `_ccCtxWindow * 0.7`；底栏用 `contextRouter.autoCompactTriggerTokens(budget)` = `budget × 0.9 / 1.2` | 两者代数不同基。截图实测底栏 `@78.3k`；若 `_ccCtxWindow` 是 128k，实际触发在 `89.6k`。**列为 §8 待核实**（不阻断本提案）|

---

## 2. 借鉴提案（B-P2）

**判据（`[DESIGN-SOURCING-001]` §3 B-P1）**：对**已登记能力域**的行为修正（bugfix）不需要提案，豁免依据是能力域已在注册表中存在且有 `canonical` 路径。

本提案修正的三个能力域均已登记：

| 能力域 | 注册位置 | 状态 |
|---|---|---|
| tool-use loop | `capabilityMatrix/descriptors.js`、`services/tool/toolUseLoopCore.js` | canonical 存在 |
| 上下文压缩 | `services/contextCompressor.js`（`context-compress` 审计工具名已注册） | canonical 存在 |
| 外层 Ralph 续跑 | `capabilityMatrix/seams.js:54` `[SEAMS.OUTER_RALPH]: 'agenticHarnessService.js'` | canonical 存在 |

⇒ **本方案不引入任何外部项目代码/二进制/资源，无借鉴关系**，故 B-P2 七字段据实填「不适用」：

| # | 字段 | 填写 |
|---|---|---|
| 1 | 借鉴对象 | 不适用 —— 无外部借鉴，修复本仓自研缺陷 |
| 2 | 借鉴内容 | 不适用（同上） |
| 3 | 解决的问题 | TUI 长任务静默中断 + 压缩成果跨轮丢失（见 §0/§1） |
| 4 | 许可证与代码性质 | 不适用 —— 不含任何第三方代码 |
| 5 | 借鉴方式 | 不适用 |
| 6 | 落点与现有实现对比 | 落点见 §3；**不新建并行实现**：续跑复用 `agenticHarnessService` 的既有语义，压缩回写复用 `aiConversationOps` 既有写回入口，完成度判定复用既有 delivery gate 与 `<execution_plan>` 步骤 |
| 7 | 验收方式 | 见 §7 |

> ❌ 不要为了「看起来合规」硬借一个上游。`agenticHarnessService` 的 Ralph 语义来自 DeepSeek-TUI 对齐（`contextCompressor.js:1236` 注释，路径 **B7**），那是**既成事实**，不是本次新借。

---

## 3. 目标形态（组件级契约）

### 契约 A —— 压缩结果必须回写会话真源

新增 `aiConversationOps` 的一个可选入参，**不改变既有调用方语义**（缺参 → 逐字节等价旧行为，保住可回滚性）：

```js
// 现状
reconcileTurnHistory(snapshot, userText, assistantText)
// 目标（第四参可选）
reconcileTurnHistory(snapshot, userText, assistantText, { compactedMessages })
```

- `compactedMessages` 存在时：用它**替换** `snapshot` 边界之后的回合尾部，而不是 push 两条文本；
- 缺省 / 非法 → 走既有三分支，逐字节相同；
- 替换前把被替换掉的原始消息写入 `_整档` 之外的归档区（沿用 `agenticHarnessService` 的 `archiveDir` 口径），**不删原始历史，只切分**。

### 契约 B —— 循环终止信号必须透出

TUI 的 `result` 构造补上 `loopResult` 的终态字段，并至少做两件事：

1. **在消息流里插一条 `notice`**（TUI 已有 `role:'notice'` 渲染路径，见 `useQueryBridge.js:2985-2988` 的先例）：
   `⚠ 工具循环达到上限（完成 N 轮 / M 次工具调用），任务可能未完成`
2. **把 `hasPendingWork` 作为可续跑判据**，交给契约 C。

### 契约 C —— 结束闸门 = 「阶段性任务完成」

**不要新造完成度判定**。本仓已有两个真源可复用：

| 判据 | 真源 | 现状 |
|---|---|---|
| 结构化步骤进度 | `<execution_plan>` → `parseExecutionPlan`（`aiChatCore.js:3657-3671`），`onPlanProgress` 回调 | TUI 已接线（`useQueryBridge.js:2998`）|
| 交付达成判定 | delivery gate（`seams.js:53` `[SEAMS.DELIVERY_GATE]: 'agenticHarnessService.js'`），`loopResult` 携带 verdict | 经典 REPL 已消费（`replSession.js:12250-12261`），TUI 未消费 |

目标语义：

```
允许结束 ⟺ 无未完成计划步骤 ∧ 无 delivery 未达成项 ∧ 无「达到上限但任务未收口」标记
否则 → 触发续跑（复用 agenticHarnessService 既有循环语义，非新造）
```

**硬边界**：续跑必须有界（沿用 `adaptiveMaxRounds = min(ceil(3 × complexity), 8)`），且**绝不设固定时长 kill**（`RUNTIME-003` 活动式超时）。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 触及文件 | 回滚方式 |
|---|---|---|---|
| **一期** | 压缩结果回写：`reconcileTurnHistory` 加可选第四参 + 归档 | `cli/aiConversationOps.js`、`cli/tui/hooks/useQueryBridge.js:3066` | 撤调用方那一处传参 → 旧行为 |
| **二期** | 终止信号透出：`result` 补终态字段 + `notice` 提示 | `cli/tui/hooks/useQueryBridge.js:3071-3078` | 纯新增字段，删即可 |
| **三期** | TUI 续跑接线：低复杂度路径复用 `agenticHarnessService`；若直调不可拆，则把 Ralph 循环体抽成可与 harness 共用的纯函数 | `agenticHarnessService.js`（抽函数）、`useQueryBridge.js` | 保留直调分支开关 |
| **四期** | 结束闸门：接 `execution_plan` 步骤 + delivery verdict | 同上 | 判据缺省 → 退回「跑完即结束」 |

**一期与二期可当天落地且互不依赖**，建议先做这两期 —— 它们能让「中断」从**静默**变**可见**，即使三/四期未上，用户也能立刻知道发生了什么。

### 4.1 先说清 CI 约束（`PROCESS-008`）

实测（2026-09-23，已复核）：

- `.github/workflows/pr-gate.yml:476` 跑 `npm run test:node`；
- `services/backend/package.json:59`：`test:node = node --test tests/**/*.test.js`。

⇒ **`services/backend/tests/` 下任何新 `*.test.js` 都会被 CI 扫到，必须「落地即绿」**。

因此**不采用**「先落一条故意红的探针钉住缺陷」的做法 —— 那会让流水线在修复完成前一直红。

正确顺序：**先接线 → 再落断言**。用例一律用 `require('node:test')` 写，前置条件不满足时显式 skip。

> ⚠️ 致死陷阱：不要在 `services/backend/tests/tui/` 下用 jest 全局（裸 `describe`/`test`）。该目录属 jest 套件（`test:tui`），但 `tests/**/*.test.js` 的 glob 会把它一并扫走，在 `node --test` 下 `describe` 未定义 → 落地即红。既有受害者：`tests/tui/liveFrameGeometry.test.js`。

---

## 5. 诚实边界（刻意不纳入 —— 逐条给原因）

| 不做 | 原因 |
|---|---|
| **无限续跑** | 与 `RUNTIME-003` 冲突，且会把「任务卡死」变成「烧钱卡死」。有界是硬约束 |
| **把 Ralph Loop 整个搬进 `useQueryBridge`** | 该文件已 ~3000 行，逻辑进去就测不到（藏在 `useCallback` 里）。正确做法是把循环体抽成可测的纯函数，两边共用 |
| **压缩后自动 re-plan（重新生成执行计划）** | 计划已由 `<execution_plan>` 承载，重生成会丢掉已完成的步骤进度，退化为「从头再来」 |
| **删除被压缩的原始消息** | 压缩是**视图切换**不是**数据销毁**。归档区保留原文，出问题可回溯 |
| **新增 env 门做开关** | 详见 §6 —— 撞门预算棘轮 |

---

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| **用「把 `conversationMessages` 直接赋给 `_chatState.messages`」实现回写** | 会把 TUI 的**显示历史**与模型的**工作历史**合并成一个真源。二者语义不同（显示历史需要保留用户看到的完整原文），合并后用户会看到界面历史被摘要顶掉，且丢证据 |
| **为「让功能变正确」新增 `KHY_AUTO_CONTINUE` 之类 env 门** | `scripts/ci/check-tui-gates.js:32` 的 `MAX_GATES = 220` 是**只降不升**的棘轮；且 `utils/selectGates.js:18` 明写「只有当开关对应一种真实的用户可见权衡时才值得加门」。回滚能力用**可选参数**（`undefined` → 老行为）即可，既不加门、又保住 B-P1 豁免 |
| **在 `useQueryBridge` 里就地写续跑 `while` 循环** | 见 §5。逻辑进叶子/纯函数，App 层只负责取数据传进去（`[DESIGN-ARCH-132]` §6 同款纪律）|
| **只补 UI 文案（「达到上限」）就算修好了** | 文案只解决「可见性」（二期），不解决「压缩不接续」（一期）。二者都要做，但**一期才是长任务能不能活下去的关键** |

---

## 7. 验收方式（可复现命令 + 关联门禁）

### 7.1 单元层

```bash
# 会话回写：压缩消息进历史，且缺参时逐字节等价旧行为
"<node>" --test services/backend/tests/cli/aiConversationOps.compactWriteback.test.js

# 读回的三段真源：# tests / # pass / # fail
```

新增用例必须覆盖两条钉住语义的断言：

1. `reconcileTurnHistory(s, u, a)` 与加第四参前的行为**逐字节相同**（`deepStrictEqual`）；
2. 传 `compactedMessages` 时，`getConversation()` 返回的历史**含** `<compressed_context>`。

### 7.2 集成层（人工，一次性）

复现步骤：

1. 开 TUI，给一个会触发多轮工具调用的任务；
2. 用 `KHY_CONTEXT_PREEMPTIVE_RATIO=0.1` + `KHY_CONTEXT_HARD_FLOOR=0` 让压缩提前触发（`contextRouter.js:51-64` 已支持）；
3. 断言：压缩结果行出现后，**下一轮**的 `initialMessages` 里能看到摘要（而非原始长历史）；
4. 断言：达到迭代上限时，界面出现提示而非静默停止。

### 7.3 关联门禁

```bash
npm run check:leaf-contract -- services/backend/src/cli/aiConversationOps.js
npm run check:tui-gates          # 比改动前后 counts 零漂移，不要求全绿
npm run check:changed
```

> ⚠️ `check-leaf-contract` **不带参数**会报 `No target files found`（要 `--changed` 或显式路径），别误判成 PASS。

---

## 8. 待核实项

| # | 项 | 影响 | 优先级 |
|---|---|---|---|
| 1 | ~~`_ccCtxWindow` 在 TUI 路径下到底是 window 还是 budget？~~ | **已核实：是 window。三方不一致成立** | 已闭环，见 §10.6 |
| 2 | `queryEngine` 是否也被 TUI 间接使用？ | 若是，则 TUI 有一半路径其实走了 harness，一/二期的必要性排序要调整 | 中 |
| 3 | `MAX_HISTORY` 的具体值与截断策略 | 决定回写时归档区怎么切 | 低（一期落地时顺带查）|

> 未列入的都没查清就**不写**。以上三项均为已知未决，不是遗漏。

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-23 | 初稿。诊断基于 `toolUseLoopCore.js` / `agenticHarnessService.js` / `aiConversationOps.js` / `useQueryBridge.js` / `replSession.js` / `iterations.js` 源码实测；CI 测试范围已复核 `pr-gate.yml:476` 与 `package.json:59` |
| 2026-09-23 | 一期 + 二期落地（见 §10）。新增单测 `tests/cli/aiConversationOps.compactWriteback.test.js` **10/10 绿** |
| 2026-09-23 | §8 待核实 1 闭环 + 压缩阈值同源修复（见 §10.6）：底栏 78.3k / REPL 73.3k / TUI 89.6k 三方不一致 ⇒ 收敛为**同一表达式**。新增 `tests/services/contextRouter.toolLoopThreshold.test.js` **7/7 绿**，一期用例零回归 |
| 2026-09-23 | 三期落地（见 §10.8）：TUI 有界自动续跑，策略取自 harness 同一批函数。**顺带挖出第二个根因** —— `_shouldAutoContinue` 的 `\b` 与中文不兼容，致中文长任务的 Ralph 续跑**从不触发**（经典 REPL 同样受影响），已修。新增 `tests/tui/loopAutoContinue.test.js` **10/10 绿** |

---

## 10. 实施记录（一期 + 二期）

### 10.1 落地清单

| # | 改动 | 落点 | 说明 |
|---|---|---|---|
| 1 | `reconcileTurnHistory(snapshot, userText, assistantText, opts?)` 加**可选第四参** | `cli/aiConversationOps.js:381` | `opts.compactedMessages` 存在且为**非空数组**时，走 `_applyCompactedView` 回写；否则逐字节等价旧逻辑 |
| 2 | 新增 `_applyCompactedView(compacted, finalAssistant)` | `cli/aiConversationOps.js`（紧随 `reconcileTurnHistory`） | 压缩视图浅拷贝为新真源 + 必要时补一条最终回复 + 尾部截断 |
| 3 | 抽出 `_trimHistory()` | 同上 | `MAX_HISTORY` 尾部保留截断的**单一实现**，供「正常收尾」与「压缩回写」两条路径共用（原来是内联的三行） |
| 4 | 调用点传参 | `cli/tui/hooks/useQueryBridge.js:3066-3071` | `{ compactedMessages: loopResult.conversationMessages }` |
| 5 | `result` 补终态字段 | `cli/tui/hooks/useQueryBridge.js` `result = {...}` | 新增 `loopStoppedByLimit` / `maxIterationsReached` / `timeLimitReached` / `absoluteLimit` / `loopIterations` / `loopElapsedMs` |
| 6 | 截断提示 | 同上，紧随 `result` | 命中上限/超时时插一条 `role:'notice'`：「工具循环…（完成 N 轮 / M 次工具调用），任务可能未完成」 |
| 7 | 新增单测 | `tests/cli/aiConversationOps.compactWriteback.test.js` | 10 条，`node:test` |

### 10.2 与方案的偏离及原因

| 偏离 | 原因 |
|---|---|
| **一期不落盘归档**被替换掉的原文 | 提案 §3 契约 A 原本写了「写入归档区，不删原始历史只切分」。落地时**主动去掉**：`aiConversationOps.js` 目前是**零 IO 的纯内存操作**，为一次压缩引入写盘，会把 IO 失败面塞进本回合的收尾路径（该路径本就 `try/catch` 成 best-effort）。原文仍可经 `khy resume` 的 transcript 回溯。若日后确需归档，应沿用 `agenticHarnessService` 既有 archiveDir 口径，**不在此另开一条**。已写进 `_applyCompactedView` 的 JSDoc |
| **二期未把终态信号接到 `result` 之外** | 提案 §3 契约 B 说「把 `hasPendingWork` 作为可续跑判据交给契约 C」。三/四期未落地，故本次只做到「透出 + 提示」，未定义 `hasPendingWork` 语义 —— 避免造一个无人消费的字段 |
| 提示文案用 `⚠` 前缀 + 括号明细 | 对齐 `RUNTIME-002` §2.5「显示等待目标 + 耗时」：把「为什么停」与「做到哪了」放在同一行，不新造消息类型 |

### 10.3 验收实测

| 项 | 命令 | 结果 |
|---|---|---|
| 语法 | `node --check` × 2 个改动文件 | exit=0 |
| **新单测** | `node --test tests/cli/aiConversationOps.compactWriteback.test.js` | **`# tests 10 / # pass 10 / # fail 0`** |
| notice 形状 | `node --test tests/cli/tui/noticeShape.test.js` | 2/2 绿（确认 `role:'notice'` 是正确形状） |
| 纯叶子契约 | `node scripts/ci/check-leaf-contract.js services/backend/src/cli/aiConversationOps.js` | `Leaf-contract check passed` |
| 适用规则 | `node scripts/ruleguard/index.js apply <两个文件>` | 正常输出，无新增违规 |
| 门预算 | `node scripts/ci/check-tui-gates.js` | 226/220 FAIL —— **既有红，非本次引入**（本次 **零新增 env 门**） |

**改动的回归面实测**：`reconcileTurnHistory` 的调用方**唯一** —— `cli/tui/hooks/useQueryBridge.js:3069`，经 `ai.js:660` 转发导出。第三参旧形态在别处不存在 ⇒ 无第三方回归面。

### 10.4 归因记录：`clearResetsHistory.test.js` 的 3 处失败**非本次引入**

该测试读的是 **`App.js`** 的源码（`appSrc`），不是本次改动的文件。对照实验（`git show HEAD:` 版 vs 工作区版，逐条断言）：

| 断言 | HEAD | 工作区 |
|---|---|---|
| rewind 分支是单行 `try { openRewindPicker(); } catch` | **false** | **false** |
| resume 重放块可定位（锚点 `try { refreshGoalActive();`） | **false** | **false** |
| 该块含 `buildResumedTranscript(` | **false** | **false** |
| 该块含 `result === true` | **false** | **false** |

⇒ **HEAD 就已红**，与本次改动无关。同时实测 `App.js` 正被并行会话大改（`--stat`：**+445 / −138**，265491 → 279449 字符）。

> 方法论：这是 `MEMORY.md`「三步区分法」的升级版 —— 对**按源码文本断言**的测试，最干净的归因不是比对 counts，而是**取 `git show HEAD:<file>` 跑同一组断言做对照**。HEAD 与工作区同值 ⇒ 定案「非本次引入」，无需算术闭合。

### 10.5 明确不做

- 不做三/四期（TUI 接 Ralph 续跑、结束闸门 = 阶段性完成）—— 待拍板。
- 不为压缩回写新增 env 门（撞门预算棘轮，详见 §6）。
- 不把被压缩的原文落盘（见 §10.2）。

### 10.6 §8 待核实 1 已闭环 —— 压缩阈值三方不一致，已收敛

**原问题**：`_ccCtxWindow` 在 TUI 路径下是 window 还是 budget？

**结论：是 window。且同一个「该压缩了」在一轮里有三个不同的数值** —— 用户看到的是一个，行为走的是另一个。

| 路径 | 阈值来源 | 128k 窗 / medium 档实测值 |
|---|---|---|
| 底栏倒计时 | `autoCompactTriggerTokens(budget)` = budget × 0.75 | **78.3k** |
| 经典 REPL | 经 `agenticHarnessService` 把 budget 塞进 `contextWindowTokens` → **budget × 0.7** | 73.3k |
| **Ink TUI**（用户实际在用） | `contextWindowTokens` 缺席 → 回退模型窗口 → **window × 0.7** | **89.6k** |

**证据链（两个独立来源互证）**：

1. **公式侧**：`_resolveContextBudget`（`aiRequestAnalysis.js:216`）
   `budget = window − reserve − safety = 128000 − 4096 − 19200 = 104704`；
   `autoCompactTriggerTokens(104704) = floor(104704 × 0.9 / 1.2) = 78528` = **78.5k**，
   与截图 `@78.3k` 吻合。
2. **实测侧**：直接调 `gateway.getModelContextWindow('agnes-3.0-flash')` → `0`（无缓存）→
   `toolUseLoopCore.js:2620-2625` 回退 `UNKNOWN_MODEL_CONTEXT_WINDOW = 128000`
   ⇒ `_ccThreshold = 128000 × 0.7 = ` **`89600`**。
3. **截图自洽性反证**：若底栏用的是 89600，同一占用 65.3k 应显示
   `round((89600−65300)/89600×100) = 27%`；截图是 **17%** ⇒ 底栏确实用的是 78.3k。

⇒ **TUI 用户在 78.3k ~ 89.6k 之间会看到「底栏说该压了，却迟迟不压」** —— 这正是用户报的
「无法在上下文爆满时自动压缩」的**观感来源**（不是压缩坏了，是它比承诺晚 11.3k 才动手）。

**修法（最小、可回滚、单一真源）**：

| # | 改动 | 落点 |
|---|---|---|
| 1 | 新增权威函数 `toolLoopCompactTriggerTokens(contextWindow, contextBudget)` + 常量 `TOOL_LOOP_COMPACT_RATIO = 0.7` | `services/contextRouter.js` |
| 2 | `_ccThreshold` 改用它 | `services/tool/toolUseLoopCore.js:2640` |
| 3 | 把上一轮学到的真实预算传给工具循环 | `cli/tui/hooks/useQueryBridge.js` 的 `chatOpts.contextBudgetTokens` |

收敛规则：**有预算 → 走 `autoCompactTriggerTokens(budget)`**（与底栏**同一个表达式**，
结构上不可能再漂移）；**无预算 → `floor(window × 0.7)`**，与改动前**逐字节相同** ⇒
回滚只需撤掉调用方那一处传参。

TUI 首轮 `contextPlan` 为 null → 不传，走旧回退；第二轮起为真实预算（fail-soft）。

**为什么 TUI 能拿到预算**：`aiChatCore.js:2604-2609` 每轮发
`onStatus({phase:'context-plan', contextWindow, contextBudget, autoCompactAt})`，
TUI 在 `useQueryBridge.js:2227-2233` 存进 `contextPlan` state（此前只用了 `autoCompactAt` 画底栏）。

**本次未做（记入待办）**：`agenticHarnessService.js` 的 4 处 `runToolUseLoop` 调用点
（`:419` / `:540` / `:707` / `:834`）未补 `contextBudgetTokens`。harness 内部**已有**
`contextBudget`（`:61-63`），补传即可；未做的原因是该文件不在本次主线，且它的偏差方向是
**更早压缩**（安全侧），不产生用户可感知的「该压没压」。

**验收实测**：

| 项 | 结果 |
|---|---|
| 语法检查 × 3 个改动文件 | exit=0 |
| 新增 `tests/services/contextRouter.toolLoopThreshold.test.js` | **7/7 绿** |
| 一期回归 `tests/cli/aiConversationOps.compactWriteback.test.js` | **10/10 绿（零回归）** |
| `check-leaf-contract contextRouter.js` | PASS |
| `check:tui-gates` | 226/220 —— 与改动前**同值，零漂移**（未新增任何 env 门） |
| `check:wiring` | 通过（91 检查器全部接线） |
| `rules:apply` × 2 个文件 | 无新增违规 |

**关键用例** `#135-13` 钉住的正是本节的算术：
`toolLoopCompactTriggerTokens(128000, 104704) === 78528`（同源），
而 `floor(128000 × 0.7) === 89600`（旧行为），差 ≥ 10000 tokens —— 两侧若再分叉即红。

### 10.7 顺带查清：jest / node:test 两套 runner 的边界

`jest.config.js:57` 用 `findStandaloneTestFiles` 扫描 `tests|src|test|vendor`，
**把含 `require('node:test')` 或含 JEST 注册宏的文件互相排除**：
- 用 `node:test` 写的新文件 → 被 jest **忽略**（不会报 "no tests in file"）；
- 用 jest 全局写的新文件 → 在 `node --test` 下 **`jest is not defined` 落地即红**。

实测：`tests/services/contextRouter.test.js` 与 `tests/cli/sessionClear.test.js`（均为 jest 风格）
在 `node --test` 下都 exit=1。⇒ **本提案所有新增用例一律用 `node:test`**。

### 10.8 三期：TUI 有界自动续跑 —— 以及顺带挖出的第二个根因

#### 10.8.1 落地清单

| # | 改动 | 落点 |
|---|---|---|
| 1 | 导出续跑**策略**（`shouldAutoContinue` / `assessTaskComplexity` / `buildContinuationSummary` / `buildContinuationInput`） | `services/agenticHarnessService.js` 的 `module.exports.continuation` |
| 2 | 新增 `runLoopRoundWithContinuation(runRound, userMessage, firstMessages, hooks)` | `cli/tui/hooks/useQueryBridge.js`（模块级，可单测） |
| 3 | 「跑一轮」封成闭包 `_runRoundOnce(roundMsg, roundMsgs, dedupKeys)`（原回调集合与缩进**原样保留**） | 同上，`_runSubmit` 内 |
| 4 | `loopResult` 改由续跑循环产出；每轮开始插一条 `role:'notice'` | 同上 |
| 5 | 导出 `runLoopRoundWithContinuation` 供单测 | 同上 |

#### 10.8.2 ★ 为什么能这样做（设计取舍）

**没有让 TUI 改走 `agenticHarnessService`。** 虽然它的 `loopOptions` 是透传的（`:385`），
但 harness 还会自己构造 `loopInput`（`_buildLoopInput(contextPacket)`，`:379`）、跑
`_tryAutoDecompose`（`:439`）、维护 `taskHandle` 状态机 —— TUI 走它等于**换入口**，
会连带改变送给模型的内容与整轮时序。风险与收益不成比例。

**也没有在 TUI 里抄一份续跑策略。** 那样两边条件会像压缩阈值一样各自漂移（§10.6 刚吃过这个教训）。

**采取的折中**：只把「**循环骨架**」（十几行 `while`）写在 TUI 侧，而
「该不该续 / 续什么 / 最多几轮」全部取自 harness 的**同一批函数**。骨架之所以必须重写，
是因为 harness 的骨架绑死了 `taskHandle` / boulder 检查点 / 自己的上下文构造，TUI 不适用；
但这十几行里**没有任何策略判断**。

#### 10.8.3 ★ 顺带挖出的第二个根因：`\b` 与中文不兼容

写三期测试时，`shouldAutoContinue`（270 字、含「实现」）竟然返回 **false**。探针定位到
`agenticHarnessService.js` 的启发式分支：

```js
// 修复前
const actionPatterns =
  /\b(create|implement|build|refactor|migrate|add|write|develop|设计|实现|创建|重构|编写|开发|搭建|迁移)\b/i;
```

`\b` 基于 `\w`（**仅 ASCII** 字母数字下划线）。中文两侧都不构成单词边界
⇒ **`\b实现\b` 永不匹配**，「设计|实现|创建|…」这半边是**死码**。

**后果比想象严重**：这不只影响 TUI —— **经典 REPL 的 Ralph 续跑对中文任务从来不会触发**。
即本仓主要使用场景（中文长任务）下，「自动接续」从第一天起就是失效的。
用户报的「长任务不会自动接续」，这是**第二个、且更根本的根因**。

**修法**（`agenticHarnessService.js`）：中英分成两条正则 —— 英文保留 `\b`
（否则 `add` 会命中 `address`），中文不加 `\b`。

**这是行为变更**：修复后中文长任务会**开始**触发续跑（此前从不）。有界性由
`maxContinuationRounds`（默认 3，上限 8）保证；已实测 harness 既有测试
`tests/services/agenticHarnessService.test.js` **未断言** `shouldAutoContinue`，不受影响。

#### 10.8.4 有界性（`RUNTIME-003`）

| 约束 | 实现 |
|---|---|
| 轮数上限 | `min(adaptive, DEFAULTS.maxContinuationRounds)`；`adaptive = min(ceil(3 × complexity), 8)` ∪ 可被 `hooks.maxContinuationRounds` 收紧 |
| 每轮重新判定 | 每轮都必须重新满足 `shouldAutoContinue(userMessage)` |
| 无固定时长 kill | 只有轮间冷却（`DEFAULTS.continuationCooldownMs`），不设总时长上限 |
| 没上下文不硬续 | 上一轮未带回 `conversationMessages` → 不续（硬续会失忆） |
| 失败即停 | 任一续跑轮抛错 → `break`，**保留已有结果**，不把续跑失败升级成整轮失败 |

#### 10.8.5 验收实测

| 项 | 结果 |
|---|---|
| 语法检查 × 2 文件 | exit=0 |
| 新增 `tests/tui/loopAutoContinue.test.js` | **10/10 绿** |
| `tests/services/contextRouter.toolLoopThreshold.test.js` | 7/7 绿（零回归） |
| `tests/cli/aiConversationOps.compactWriteback.test.js` | 10/10 绿（零回归） |
| `check:tui-gates` | 226/220 —— 与改动前**同值，零漂移** |
| `check:wiring` | 通过（91 检查器全接线） |
| `rules:apply` × 2 文件 | 无新增违规 |

其中 `#135-27` 专门钉住 `\b` 那条：中文动作词必须触发，同时英文 `address` **不得**被 `add` 误命中。

#### 10.8.6 明确不做

- **四期（结束闸门 = 阶段性完成）**：需要定义「未完成」判据（复用 `<execution_plan>` 步骤 +
  delivery verdict）。**待拍板** —— 它会改变「什么时候允许停」，属能力增强而非缺陷修复。
- 未给 `runLoopRoundWithContinuation` 加 env 门（撞门预算棘轮；回滚靠 `hooks` 可选参数）。

