# [DESIGN-ARCH-046] 聊天状态污染与回复截断治理 — 原子轮提交、空结果自动重试与截断信号保真

状态：已实现（[EvoRequirement]「聊天状态污染与回复截断导致的对话僵化」闭环）
依赖前序：[DESIGN-ARCH-028] 通信防御零静默失败（E01–E08 归因） · [DESIGN-ARCH-044] Agent 自愈微循环
实现位置：
- `services/backend/src/services/chatStateIsolation/index.js`（原子轮提交，纯模块）
- `services/backend/src/services/queryEngine.js`（会话历史两处提交站点改道 + 轮快照 `_turnHistoryMark`）
- `services/backend/src/cli/ai.js`（**权威历史孤儿轮回滚** `_uncommitOrphanTurn`——见 §2.4）
- `services/backend/src/services/toolUseLoop.js`（空回复有界自动重试）
- `services/backend/src/services/gateway/adapters/_anthropicSseStream.js`（提前关闭→截断信号保真）

验收测试：
- `services/backend/tests/services/chatStateIsolation/chatStateIsolation.test.js`（10 例，纯模块）
- `services/backend/tests/services/chatStateIsolation/orphanTurnRollback.test.js`（4 例，真 `ai.js` 模块闭包历史）
- `services/backend/tests/services/chatStateIsolation/emptyReplyRetry.test.js`（3 例，真 `runToolUseLoop`）
- `services/backend/tests/services/chatStateIsolation/sseTruncationSignal.test.js`（4 例，真 SSE 解析器）

---

## 1. 症状与病灶

**症状一「一次异常导致后续回复复读」**：一次模型调用异常（网络/超时/格式错误）后，系统进入「污染状态」，
后续所有正常请求都返回同一句罐头话（如「抱歉，我无法回答这个问题」）。

**症状二「截断/空结果需二次触发」**：回复被意外截断（流式中断、超时）或返回空结果时，系统不自动重试也不提示，
而是僵在「等用户二次提问」的状态，必须用户主动再问才会重新执行。

**病灶定位（三处精确缺陷）**：

1. **状态污染**：会话历史的两处 push 站点（`queryEngine.js` 主路径与 harness 路径）只看 `reply` 非空，
   对「真实回答」与「兜底错误文案」一视同仁。于是一次异常把罐头文案写进 `_messages`，
   下一轮作为上下文重放，模型照抄——「复读」由此而来。
2. **空结果无自动恢复**：`toolUseLoop` 的空回复分支直接返回罐头兜底（带 E01 归因），未先尝试重试，
   把「再问一次」的责任推给用户。`_isTransientLoopErrorType` 不含 `empty_reply`，空回复拿不到既有的瞬时重试预算。
3. **截断信号被抹平**：Anthropic SSE 解析器在流 `end` 时无条件 `finishReason: finishReason || 'end_turn'`。
   若 socket 在生成中途断开（无 `message_delta.stop_reason`、无 `message_stop`），半截话被当作正常 `end_turn` 收尾，
   既有的 `length` 续传恢复路径永远不会触发。

## 2. 设计：三处外科手术式修复，正常路径零代价

### 2.1 原子轮提交 — `chatStateIsolation`（状态隔离，治本）

新纯模块 `chatStateIsolation/index.js`，把「这一轮该不该落历史」收敛为可单测的纯判定 + **原子提交**语义：

- `isErrorTurn(finalResult)`：结构化判错——`finalResult` 携带 `errorType`（timeout/network/empty_reply/...）
  或 `error_code`（E01..E08）即为失败轮。复用 DESIGN-ARCH-028 的精准归因产物，**不对文案做字符串匹配**。
- `commitTurn(messages, { reply, finalResult, maxHistory, historyMark })`：就地变异调用方持有的数组（不重赋引用）：
  - **成功轮**：push assistant 回复，按 `maxHistory` 截断（与原行为逐字节一致）。
  - **失败轮**：回滚到 `historyMark`（本轮开始前的历史长度快照），**连同本轮已 push 的 user 消息一并撤回**。
    这既实现「异常后自动重置对话上下文」，又避免「孤儿 user 消息」破坏 user/assistant 角色交替。

`queryEngine.js` 在 push 本轮 user 消息后记下 `this._turnHistoryMark = this._messages.length - 1`，
两处提交站点统一改道 `commitTurn(...)`。罐头文案从此**绝不进入** `_messages`，下一次请求从干净状态开始。

### 2.2 空回复有界自动重试 — `toolUseLoop`

空回复分支（`!aiResult.reply`）在返回罐头兜底**之前**，先尝试有界自动重试：

- 预算 `_resolveEmptyRecoveryMax`：默认 `1`（「自动触发一次重试」），env `KHY_TOOL_LOOP_EMPTY_RECOVERIES` 可调，
  clamp 到 `[0,3]`。独立于瞬时重试预算——即便小任务关闭了 `transientRecovery`，空回复仍享有这一次重试。
- 重试前经 `onToolResult('_system_retry', ...)` 推送「生成被中断或为空，正在重试（n/m）…」状态，用户被告知而非空等。
- 注入续写提示并 `continue` 重跑循环；预算耗尽后才返回带 E01 归因的罐头兜底（再由 §2.1 隔离出历史）。
- **守卫**：请求已 abort 不重试；模型返回了结构化 `toolUseBlocks`（合法工具轮）不重试。

### 2.3 截断信号保真 — `_anthropicSseStream`

- 新增 `sawTerminal` 标志：`message_delta.stop_reason` 或 `message_stop` 任一到达即置真。
- 流 `end` 时，若 **无任何终止标记** 且 **已有内容**，把 `finishReason` 置为 `'length'`（提前关闭=截断），
  而非抹平成 `end_turn`。该信号汇入既有的续传恢复（`claudeAdapter` 的 `finishReason==='length'` 续写 +
  `toolUseLoop` 的 `_maxTokensRecovery`），用「从上次中断处继续，勿重复」续写补全半截话。
- 干净流（带终止标记）保留真实 `stop_reason`；无内容的空流不臆造截断（交由 §2.2 空回复重试处理）。

### 2.4 权威历史孤儿轮回滚 — `ai.js`（复盘补强：修对账本）

**复盘发现**：系统存在两套并行历史。`queryEngine._messages`（§2.1 作用对象）**不喂给模型**——它只经
`initialMessages` 进入 `toolUseLoop` 的 token 估算器。模型真正看到的上下文 `conversationPrompt` 由
**`ai.js` 模块级 `_messages`** 构建（`ai.js` 的 `routeContextStrategy(_messages,...)` → `buildFlatConversation`）。
`clearHistory()` 需同时清两者（`queryEngine.js` 注释「both engine and ai.js」）即为佐证。

**真正的半途丢弃**：`ai.chat` 先 push 本轮 user 消息，再调用网关；生成为空/出错时**提前 return**，
走不到末尾的 assistant push。于是 user 消息被**孤儿化**——记进权威历史却无配对 assistant，破坏 user/assistant
角色交替，下一轮再 push user 即出现连续两个 user，污染模型上下文。这才是 REPL「复读」的真凶。

**修复**：`_uncommitOrphanTurn(committedMsg)` 在两处失败提前 return 前，**仅按引用身份弹出本次调用刚 push 的
那一条孤儿消息**（且必须仍是尾部）：
- **绝不**回滚整轮——多轮工具任务中，前序已完成的工具迭代（任务进度）必须原样保留，否则才是「丢弃数据导致
  无法完成使命」的真正灾难。
- 意图不丢失：空回复由 §2.2 的循环重试重新供给同一条消息（不重复堆叠）；非重试失败本就无答案可承接。
- 防呆：非尾部目标（已被 trim）/空历史/null 目标一律安全 no-op，绝不静默误删。

> 注：daemon `/api/ai/chat/stream` 路径走 `gw.generate(message)` **无状态单发**，不累积历史、不受此污染；
> 受影响的仅 REPL（含 `queryEngine` 模式）累积历史的路径。

## 3. 硬性约束的工程化保证

> 1）绝不增加正常对话延迟（如不必要的重试）；2）绝不因自动重试导致内容重复或逻辑混乱；
> 3）必须通过构造异常场景回归测试。

落到代码与测试：

1. **正常路径零代价**。`commitTurn` 成功轮与旧 push 行为等价；空回复重试块仅在 `reply` 已空时进入
   （`emptyReplyRetry.test.js` 的「非空首回复 → chat 仅调 1 次」用例守护）；SSE 截断改写仅在
   「无终止标记且有内容」时命中，干净流逐字节不变（`sseTruncationSignal.test.js` 的 end_turn 用例守护）。
2. **不重复、不死循环**。空回复无内容可重复；重试预算有界（默认 1，clamp ≤3），耗尽即兜底
   （`emptyReplyRetry.test.js` 的「持续空回复→恰两次调用」用例守护）；截断续写用「勿重复」提示。
   失败轮罐头文案被隔离出历史，根除「复读」（`chatStateIsolation.test.js` 的 REPRO 用例守护）。
3. **异常场景回归**。三套 `node:test` 套件构造了网络/超时错误轮、强制截断流式输出（提前关闭无终止标记）、
   空结果三类异常场景，共 17 例，全绿。

## 4. 验收

- `chatStateIsolation.test.js`（10 例）：判错信号识别 / 成功轮 push+trim 等价 / 失败轮回滚 / E01 不落历史 /
  「一次异常不污染后续正常轮」REPRO / 坏 mark 防呆（最坏不回滚但绝不落兜底）/ 非数组安全 no-op。
- `orphanTurnRollback.test.js`（4 例）：尾部孤儿 user 弹出 / **保留前序工具迭代（任务进度不丢）** /
  非尾部目标安全 no-op / 空历史·null 目标安全 no-op。驱动真 `ai.js` 模块闭包历史。
- `emptyReplyRetry.test.js`（3 例）：空→一次重试→真答案（含「正在重试」状态）/ 持续空→有界两次→E01 兜底 /
  非空首回复零重试（硬约束①）。
- `sseTruncationSignal.test.js`（4 例）：提前关闭+有内容→`length` / 干净 `end_turn` 保真 / 真 `max_tokens` 保真 /
  提前关闭无内容不臆造截断。
- 邻近回归：`toolUseLoop.bareRefusal` / `pseudoRefusal` / `failsafe` / `channelLifecycle` / `channelLogGating`
  合计 69 例零回归（`queryEngine.*` 与 `toolUseLoop.terminalNotice` 等 jest 套件本 env 无 jest 跑不了，与本次改动无关）。

## 5. 非目标（刻意不动）

- 不接管全局上下文压缩 / 认知快照（DESIGN-ARCH-035）——本次只隔离「失败轮副产物」，不动正常轮的历史管理。
- 不改 `_maxTokensRecovery` 续传策略与 `claudeAdapter` 续写循环——截断信号只是把「提前关闭」正确归类为 `length`，
  复用既有恢复管道，零新增重试逻辑。
- 不改 OpenAI SSE 解析器——本次症状定位在 Anthropic 直连流；OpenAI 路径如需同等保真应另行验收。
