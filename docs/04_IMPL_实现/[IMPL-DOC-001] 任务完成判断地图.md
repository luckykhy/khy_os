# 任务完成判断地图

> **单一真源**:本文档是 khy-os「任务何时算做完」的架构地图。
> 代码变更触及收尾/停止/预算逻辑前,必须先核对本文档对应的模块与行号。
> 若发现文档与代码不一致,以代码为准并同步更新本文档。

---

## 1. 三条决策通道(平行存在,各管一段)

khy-os 有三种「任务」,各有独立的完成判断通道:

| 通道 | 入口 | 判定模块 | 何时介入 | 是否有界 |
|------|------|----------|----------|----------|
| **普通请求** | 用户在 REPL/TUI/Web 发一条消息 | `taskClosure.decideClosure` | 每轮模型收尾时(模型不再调用工具) | redrive [0,6],默认 1 |
| **持久目标 /goal** | 用户设置 `/goal <目标>` | `goalStopGate.evaluateGoalStop` | /goal 模式下,模型「想停」时 | 单轮 [0,10],默认 1;跨轮由 goalCore 轮次预算兜底 |
| **后台持久任务** | `backgroundTaskManager` / `largeTaskRuntimeStore` | FSM 状态机 | 跨进程,任务生命周期全程 | `TERMINAL_STATUSES` 终态集合 |

**关键**:三条通道互不干扰。普通请求不会触发 goalStopGate(无活动目标时直接 `pass`);持久目标在 goalStopGate 之外还叠加 taskClosure 的通用判定。

---

## 2. 普通请求:taskClosure 三态仲裁

**模块**: `services/backend/src/services/taskClosure.js`
**接线点**: `services/backend/src/services/toolUseLoopCore.js:318-337`(`_looksConcluded`)

### 2.1 三态裁决

```
decideClosure({ reply, planSteps, toolCallLog, redriveCount, maxRedrives })
  │
  ├─ isFinalDelivery(reply) == false ?
  │   ├─ 预算耗尽 → close_partial (诚实降级,绝不假装成功)
  │   └─ 预算未耗尽 → redrive (注入 buildRedriveMessage)
  │
  ├─ isFinalDelivery(reply) == true ?
  │   ├─ 有未完成步骤(steps.length > 0) ?
  │   │   ├─ 预算耗尽 → close_partial
  │   │   └─ 预算未耗尽 → redrive (reason: steps-incomplete)
  │   │
  │   ├─ 声称验证却无真实验证(claimsVerify && !ranVerify) ?
  │   │   ├─ 预算耗尽 → close_partial
  │   │   └─ 预算未耗尽 → redrive (reason: verification-missing)
  │   │
  │   └─ 步骤齐 + 验证已跑 → close (reason: concluded)
  │
  └─ (不可能到达)
```

### 2.2 isFinalDelivery 判定优先级

| 优先级 | 条件 | 结果 |
|--------|------|------|
| 1 | 空回复 | false |
| 2 | 否定完成信号(`_NEGATED_RE`: 尚未/还没/未完成/not done…) | false |
| 3 | 显式目标达成(`_goalLooksDone`: 目标已完成/大功告成…) | true |
| 4 | 终态交付信号(`_FINAL_SIGNAL_RE`) 且未被未来时遮蔽 | true |
| 5 | 终态信号 + 未来时计划主导(`_FUTURE_DOMINANT_RE` + `_PROGRESS_MARKER_RE`) | false (阶段性小结,不是终态) |
| 6 | 其余 | false |

### 2.3 信号词表

**终态交付信号** (`_FINAL_SIGNAL_RE`):
```
已完成|已全部完成|已达成|已实现|已交付|已整理|已创建|已修改|已启动|已打开|
已执行|已运行|已验证|已发送|已部署|已安装|大功告成|完成|成功|无需|不需要|
没有.*需要|已经.*整理|看起来.*整洁|桌面.*干净|结果|总结|结论|以上|如下|本次|
done|completed|finished|accomplished|summary|result|launched|opened|executed|
verified|started|no.*needed|already.*clean|organized
```

**否定完成信号** (`_NEGATED_RE`):
```
尚未|还没|还未|仍未|未能完成|未完成|没(?:有)?完成|不能.*(?:确认|视为)|
not\s+(?:yet\s+)?(?:done|complete(?:d)?|finished)|incomplete|still\s+(?:working|pending)
```

**未来时计划主导** (`_FUTURE_DOMINANT_RE`):
```
接下来|下一步|接下来我|下一步我|我(?:将|会|准备|打算|先|接下来|下一步)|即将|
然后|之后|稍后|再(?:接|继)|还会|还需要|仍需|还有|剩余|待办|继续(?:推进|执行|处理)|
go(?:ing)?\s+to\b|i\s*(?:'|')ll\b|i\s+will\b|let\s+me\b|still\s+(?:need|to\s+do|working)
```

### 2.4 预算

| 参数 | 默认值 | 范围 | env 覆盖 |
|------|--------|------|----------|
| `maxRedrives` | 1 | [0,6] | `KHY_TASK_CLOSURE_REDRIVE_MAX` |

**关闭后行为**: `maxRedrives=0` → 模型第一次无终态回复就直接 `close_partial`(诚实降级,绝不无限续跑)。

---

## 3. 持久目标:goalStopGate 四门裁决

**模块**: `services/backend/src/services/goalStopGate.js`
**接线点**: `services/backend/src/services/toolUseLoopCore.js:7108-7172`

### 3.1 四道门(串行,任一失败 → redrive)

```
evaluateGoalStop({ goal, reply, redriveCount, env, userMessage, toolCallLog })
  │
  ├─ 门关(KHY_GOAL_STOP_GATE=0) → pass (行为回退到无 goal 感知)
  ├─ 无活动目标 → pass
  │
  ├─ looksLikeGoalSatisfied(reply) == false ?
  │   ├─ 预算耗尽 → pass (reason: redrive-exhausted)
  │   └─ 预算未耗尽 → redrive (reason: not-satisfied)
  │
  └─ looksLikeGoalSatisfied(reply) == true ?
      │
      ├─ 【证据门】claimsVerificationWithoutEvidence(reply) ?
      │   ├─ 预算耗尽 → pass (不自动清除未经证实的目标)
      │   └─ 预算未耗尽 → redrive (reason: evidence-missing)
      │
      ├─ 【验证行为门】声称验证但 verificationCommandRan(toolCallLog)==false ?
      │   ├─ 预算耗尽 → pass
      │   └─ 预算未耗尽 → redrive (reason: verify-not-run)
      │
      ├─ 【契约门】parseCompletionContract 有标准 且 matchEvidenceAgainstContract 未全覆盖 ?
      │   ├─ 预算耗尽 → pass
      │   └─ 预算未耗尽 → redrive (reason: contract-unmet)
      │
      └─ 全部通过 → clear (自动清除目标) 或 pass (KHY_GOAL_AUTO_CLEAR=0)
```

### 3.2 looksLikeGoalSatisfied 判定优先级

| 优先级 | 条件 | 结果 |
|--------|------|------|
| 1 | 空回复 | false |
| 2 | 否定完成(`_NEGATED_DONE_RE`) | false |
| 3 | 显式「目标达成」措辞(`_GOAL_DONE_PHRASE_RE`) | true |
| 4 | 完成态通用信号(`_PERFECTIVE_DONE_RE`) 且未被未来时计划遮蔽 | true |
| 5 | 完成态信号 + 未来时计划(`_FUTURE_PLAN_RE`) | false |
| 6 | 其余 | false |

### 3.3 证据门(参考 Hermes v0.18.0)

**验证声称信号** (`_VERIFICATION_CLAIM_RE`):
```
已验证(?:通过)?|验证(?:已)?通过|(?:全部|所有)?\s*测试(?:全部|均)?\s*(?:通过|全绿)|
测试全绿|全部通过|检查(?:已)?通过|校验(?:已)?通过|构建(?:成功|通过)|编译(?:成功|通过)|
all\s+tests?\s+pass(?:ed|ing)?|checks?\s+pass(?:ed|ing)?|build\s+(?:succeeded|passed|success(?:ful)?)|
lint\s+(?:pass(?:ed|ing)?|clean)|verified|\bpassed\b
```

**具体证据信号** (`_EVIDENCE_RE`):
```
``` | ~~~ | 数字+passed/passing/通过 | 数字/数字 | exit code | tests: 数字 |
ok 数字 | # pass/fail | ✓✔√✅❌✗× | PASS | FAIL | $ 命令 | npm test |
node --test | pytest | jest | go test | cargo test
```

### 3.4 验证行为门

**验证命令签名** (`_VERIFY_CMD_RE`):
```
npm\s+(?:run\s+)?(?:test|check|lint|build|verify|arch|maintainer)|
yarn\s+(?:run\s+)?(?:test|check|lint|build)|pnpm\s+(?:run\s+)?(?:test|check|lint|build)|
node\s+--test|node\s+--check|\bpytest\b|\bjest\b|\bvitest\b|\bmocha\b|
go\s+test|cargo\s+test|\beslint\b|\btsc\b|\bruff\b|\bflake8\b|
make\s+(?:test|check|lint)|khy\s+(?:doctor|metadata\s+(?:check|refresh))|
python\s+-m\s+(?:pytest|unittest)
```

### 3.5 完成标准契约门(completionContract)

**模块**: `services/backend/src/services/completionContract.js`

用户可在 `/goal` 目标文本中预先声明「完成标准」:
- 反引号命令: `npm test`、`arch:god` 等(任意位置)
- 标准段:「完成标准 / 验收标准 / definition of done」标题后的条目

契约门据回复证据逐条核对,未被证据全覆盖 → redrive 指名缺哪条。

### 3.6 预算

| 参数 | 默认值 | 范围 | env 覆盖 |
|------|--------|------|----------|
| 单轮再驱动上限 | 1 | [0,10] | `KHY_GOAL_STOP_GATE_MAX` |
| 跨轮轮次预算 | 由 goalCore 管理 | — | `KHY_GOAL_MAX_TURNS` |

**门控层级**(父子嵌套,父关 → 子全关):

| 门控 | 默认 | 作用 |
|------|------|------|
| `KHY_GOAL` | 开 | 持久目标总开关 |
| `KHY_GOAL_STOP_GATE` | 开 | Stop-gate 总开关 |
| `KHY_GOAL_AUTO_CLEAR` | 开 | 达成后自动清除目标 |
| `KHY_GOAL_EVIDENCE_GATE` | 开 | 证据门 |
| `KHY_GOAL_COMPLETION_CONTRACT` | 开 | 完成标准契约门 |
| `KHY_GOAL_VERIFY_RAN_GATE` | 开 | 验证行为门 |

---

## 4. 工具循环硬上限(最终兜底)

**模块**: `services/backend/src/services/toolUseLoopCore.js:341-342`

| 参数 | 默认值 | 范围 | env 覆盖 |
|------|--------|------|----------|
| `MAX_ITERATIONS` | 100 | [1,100] | `KHY_TOOL_LOOP_MAX_ITERATIONS` |
| `MAX_ELAPSED_MS` | 600000 (10min) | [5000, 1800000] | `KHY_TOOL_LOOP_MAX_MS` |

**20 倍模式** (`twentyXMode`):开启后迭代上限顶到硬顶 100。

**IterationBudget**:带 grace call 支持——耗尽后允许一次「grace」迭代让模型总结。

---

## 5. 反无限制续跑:全部 5 道闸

| # | 闸 | 模块 | 默认 | 关闭后行为 |
|---|---|---|---|---|
| 1 | 工具循环硬上限 | `toolUseLoopCore.js:341-342` | 100 轮 / 10min | 跑死(永不退出) |
| 2 | taskClosure redrive 预算 | `taskClosure.js:57,202` | 1 次 | 多烧轮但最终 close_partial |
| 3 | goalStopGate 单轮预算 | `goalStopGate.js:176,185` | 1 次 | 多烧轮但最终 pass |
| 4 | goalCore 跨轮预算 | `goalCore/*` | 由 `KHY_GOAL_MAX_TURNS` | 跨轮无限循环 |
| 5 | FSM TERMINAL_STATUSES | `largeTaskRuntimeStore.js:27` | 终态集合不可逆 | 状态机兜底 |

**关键设计**:每道闸都是**独立有界**的。关闭任何一道闸,其他闸仍然生效。不可能出现「所有闸都关了还无限跑」的情况——至少 `MAX_ITERATIONS=100` 是硬编码的最终兜底。

---

## 6. 辅助守卫(增强完成判断质量)

### 6.1 doomLoopGuard — 同工具重复调用防护

**模块**: `services/backend/src/services/doomLoopGuard.js`

| 工具类型 | escalate 阈值 | ask_user 阈值 | env 覆盖 |
|----------|---------------|---------------|----------|
| 写工具(write_file/shell 等) | 3 次连续相同 | 5 次 | `KHY_DOOM_LOOP_THRESHOLD_WRITE` |
| 读工具(read_file/grep 等) | 5 次连续相同 | — | `KHY_DOOM_LOOP_THRESHOLD_READ` |

**门控**: `KHY_DOOM_LOOP_GUARD`(默认开)

### 6.2 shortStopContinuation — 弱模型早停续写

**模块**: `services/backend/src/services/query/shortStopContinuation.js`

条件:自然 stop(非 length) + 异常短(<40 字符) + 中途断句(无终止标点) → 一次性续写。

**门控**: `KHY_SHORT_STOP_CONTINUATION`(默认**关**,opt-in)

### 6.3 inertiaCompletion — 断线惯性完成

**模块**: `services/backend/src/services/query/inertiaCompletion.js`

条件:流式层瞬断(`interrupted:true`) + 已有 toolUseBlocks → 惯性执行已下达的工具调用 + 无感衔接。

**门控**: `KHY_INERTIA_COMPLETION`(默认开)

### 6.4 crossTurnRepeatDecision — 跨轮工具调用重复防护

**模块**: `services/backend/src/services/toolUseLoopCore.js:1379-1559`

检测跨轮重复的成功工具调用,引导模型「基于已有结果回答,不要重跑」。

**门控**: `KHY_CROSS_TURN_TOOL_DEDUP`(默认开)

### 6.5 answerEchoGuard — 回声断路器

防止模型重复输出已交付的答案(同一答案出现 2+ 次 → 断路)。

### 6.6 followThroughGuard — 智能体纪律兜底

零工具调用的动作轮次里,识别「虚构阻碍就放弃 / 空头承诺却不执行」→ 强制闭环。

### 6.7 resultGuard — 结果守卫

杜绝「执行了工具但只给了承诺式前言、未交付结论、也无收尾」就静默返回。

### 6.8 adaptiveExecution — 边做边想

执行中持续拿过程/结果对照模型最初的设想,出现偏差而模型未自发反思时提示「停一下,原计划是否仍成立?」。

### 6.9 devCourseMonitor — 开发轨迹监控

监听开发轨迹(测试回归 / 未验证 churn / 反复改同一文件 / 连续失败),在跑偏酿成大错前及早提示修正航向。

---

## 7. 后台持久任务:FSM 状态机

**模块**: `services/backend/src/tasks/largeTaskRuntimeStore.js:13-41`

### 7.1 状态集合

```
queued → claimed → running → succeeded
                       ↓
                  retry_wait → claimed (重试)
                       ↓
                  dead_letter (重试耗尽)
                       ↓
任何状态 → cancelling → cancelled
任何状态 → pausing → paused → running
```

### 7.2 终态(不可逆)

```javascript
TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'dead_letter'])
```

### 7.3 状态转换表

| 当前状态 | 可转移到 |
|----------|----------|
| queued | claimed, cancelling, cancelled |
| claimed | running, retry_wait, cancelling, cancelled, failed |
| running | retry_wait, pausing, cancelling, succeeded, failed |
| retry_wait | claimed, dead_letter, cancelling, cancelled |
| pausing | paused, cancelling, cancelled |
| paused | running, cancelling, cancelled |
| cancelling | cancelled |
| succeeded | (终态) |
| failed | (终态) |
| cancelled | (终态) |
| dead_letter | (终态) |

---

## 8. 交付台账:persistent deliveryLedger

**模块**: `services/backend/src/services/deliveryLedger.js`

任务终态经 `backgroundTaskManager.complete/fail/cancel` 或 headless 入口追加一条 JSONL 记录到 `<dataHome>/tasks/delivery_ledger.jsonl`。

**记录字段**: ts, taskId, source, task, status, closure, verdict, iterations, toolCalls, failedToolCalls, summary, gaps, error, cwd

**自裁剪**:默认保留最近 500 条(`KHY_DELIVERY_LEDGER_MAX` 可调)。

---

## 9. 修改路径速查

| 要改什么 | 改哪里 | 注意事项 |
|----------|--------|----------|
| 普通请求的「完成」定义 | `taskClosure.js` 的 `_FINAL_SIGNAL_RE` / `_NEGATED_RE` | 纯叶子,改后跑 `taskClosure.decideClosure.test.js` |
| 持久目标的「达成」定义 | `goalStopGate.js` 的 `_PERFECTIVE_DONE_RE` / `_NEGATED_DONE_RE` | 纯叶子,改后跑 `goalStopGate` 测试 |
| 证据门开关 | `goalStopGate.js` 的 `isEvidenceGateEnabled` | 嵌套父门控 `KHY_GOAL_STOP_GATE` |
| 完成标准契约解析 | `completionContract.js` 的 `parseCompletionContract` | 纯叶子,改后跑 `completionContract` 测试 |
| 再驱动预算 | `taskClosure.js:resolveMaxRedrives` / `goalStopGate.js:resolveMaxRedrives` | clamp 范围在函数内 |
| 工具循环硬上限 | `toolUseLoopCore.js:341-342` | `MAX_ITERATIONS` / `MAX_ELAPSED_MS` |
| Doom Loop 阈值 | `doomLoopGuard.js:107-109` | `DEFAULT_WRITE_THRESHOLD` / `DEFAULT_READ_THRESHOLD` |
| 后台任务终态 | `largeTaskRuntimeStore.js:27` | `TERMINAL_STATUSES` 不可逆集合 |

---

## 10. 测试覆盖

| 测试文件 | 覆盖范围 |
|----------|----------|
| `__tests__/taskClosure.decideClosure.test.js` | 三态仲裁 + 预算语义 |
| `__tests__/toolUseLoop.taskClosureGate.smoke.test.js` | 接线冒烟:无终态 → redrive → close_partial |
| `__tests__/goalStopGate.*.test.js` | 四门裁决 + 证据门 + 契约门 |
| `__tests__/completionContract.*.test.js` | 契约解析 + 证据核对 |
| `__tests__/doomLoopGuard.*.test.js` | 同工具重复检测 |
| `__tests__/shortStopContinuation.*.test.js` | 弱模型早停续写 |
| `__tests__/inertiaCompletion.*.test.js` | 断线惯性完成 |
| `__tests__/deliveryLedger.*.test.js` | 交付台账落盘 |
| `tests/toolUseLoop.*.test.js` (30+ 文件) | 工具循环各场景 |

---

## 11. 决策流程图(文本版)

```
用户发送消息
  │
  ▼
runToolUseLoop 进入循环
  │
  ├─ 每轮:模型回复
  │   │
  │   ├─ 有工具调用? → 执行工具 → 继续循环
  │   │
  │   └─ 无工具调用(模型「想停」)?
  │       │
  │       ├─ [闸1] IterationBudget 耗尽? → 强制退出(grace call)
  │       │
  │       ├─ [闸2] goalStopGate 有活动目标?
  │       │   ├─ 四门裁决 → clear / redrive / pass
  │       │   └─ redrive → 注入再驱动指令 → continue
  │       │
  │       ├─ [闸3] taskClosure.decideClosure
  │       │   ├─ close → 正常退出
  │       │   ├─ redrive → 注入再驱动指令 → continue
  │       │   └─ close_partial → 诚实标注 → 退出
  │       │
  │       ├─ [闸4] doomLoopGuard.assess
  │       │   ├─ continue → 正常
  │       │   ├─ escalate → 提示模型换思路
  │       │   └─ ask_user → 升级为用户询问
  │       │
  │       └─ [闸5] 硬上限 MAX_ITERATIONS / MAX_ELAPSED_MS
  │           └─ 超限 → 强制退出
  │
  └─ 循环结束 → 返回 finalResponse
```

---

## 12. 小步多轮策略(渐进完成,避免硬截断)

### 12.1 核心原则

**不要硬截断,要小步多轮**。任务完成判断的目标不是「在预算耗尽时强制停止」,而是「每步确认后继续,渐进完成」。

现有机制的 `close_partial` 是「预算耗尽后诚实降级」——这仍然是一种截断。更好的模式是:

```
大任务 → 拆成小步骤 → 每步执行 → 每步确认 → 继续下一步 → 全部完成 → 整体验收
```

### 12.2 现有的小步多轮机制

**planModeService.js** 已实现完整的小步多轮工作流:

| 阶段 | 函数 | 作用 |
|------|------|------|
| 生成计划 | `enterPlanMode` | AI 生成结构化执行计划(含步骤/依赖/风险/验证) |
| 用户审批 | `presentForApproval` | 用户可 skip/edit/add 步骤,确认后才执行 |
| 逐步执行 | `executePlanSteps` | 每步独立 chat(),有校验和重试(`maxStepRetry`) |
| 验证落地 | `_runPlanVerification` | 实地运行验证段,用真实证据判定交付是否达标 |

**taskScale.js** 自动检测任务规模:

| 规模 | 判定条件 | 预期轮次 |
|------|----------|----------|
| small | 问候/闲聊/简单问答 | 1 轮 |
| normal | 单文件修改/Bug 修复 | 2~5 轮 |
| large | 多文件重构/架构变更 | 5+ 轮 |

**关键**:large 任务自动触发 planMode,生成计划后逐步执行,而不是一次性做完。

### 12.3 每步确认机制

**步骤校验** (`validateStepResult`):
- 检查 AI 回复是否包含失败信号
- 检查预期文件是否存在(`inferStepFileTargets`)
- 检查写操作是否真的修改了文件(`mtime` 对比)
- 检查运行命令是否有真实证据(`hasRuntimeEvidence`)

**步骤重试** (`maxStepRetry`):
- 默认 1 次重试(`KHY_PLAN_STEP_RETRY` 可调)
- 重试时注入上次失败原因,要求模型修正
- 重试耗尽后标记步骤为 `error`,继续下一步

**人闸门** (`requiresHumanGateStep`):
- 高危/破坏性步骤(删除/清空/重置/覆盖/迁移/发布/部署)执行前暂停确认
- 用户可选择执行或跳过
- Goal Mode 或 `KHY_HUMAN_GATE=off` 时自动放行

### 12.4 两种执行模式

| 模式 | env | 行为 |
|------|-----|------|
| **逐步执行**(默认) | `KHY_PLAN_CONTINUOUS=0` | 每步独立 chat(),步骤间有校验/重试/人闸门 |
| **连续执行** | `KHY_PLAN_CONTINUOUS=1` | 整个计划交给一次 chat(),工具循环连续执行,跨步骤保持上下文 |

**逐步执行**更适合需要精确控制的场景(每步确认、失败隔离)。
**连续执行**更适合上下文连续的场景(跨步骤复用结果、减少模型调用开销)。

### 12.5 与 taskClosure 的协作

taskClosure 的 `planSteps` 参数接收 planModeService 生成的步骤列表:

```javascript
taskClosure.decideClosure({
  reply: strippedReply,
  planSteps: plan.steps,  // 来自 planModeService
  toolCallLog,
  redriveCount,
  maxRedrives,
  taskDescription,
})
```

**协作流程**:
1. planModeService 生成计划,用户审批
2. 逐步执行,每步完成后更新 `step.status`
3. 所有步骤完成后,taskClosure 检查 `incompleteSteps(planSteps)`
4. 若有未完成步骤 → redrive(要求完成剩余步骤)
5. 若声称验证却无真实验证 → redrive(要求实际运行验证)
6. 若步骤齐 + 验证已跑 → close

### 12.6 最佳实践

1. **大任务必须拆步骤**:超过 3 个文件或 5 个步骤的任务,应触发 planMode 生成计划
2. **每步有明确完成条件**:步骤描述应包含「如何验证这一步成功」
3. **失败不阻塞后续**:某步失败后,继续执行不依赖它的后续步骤
4. **验证段必须实地运行**:计划的「验证」段不是装饰,必须实际执行并报告证据
5. **人闸门保护高危操作**:删除/覆盖/部署等操作必须经过用户确认

---

## 13. 已知边界与限制

1. **信号词表是启发式的**: `_FINAL_SIGNAL_RE` / `_PERFECTIVE_DONE_RE` 等正则基于自然语言模式匹配,无法覆盖所有表述。新增完成表述时需同步更新信号词表。

2. **证据门只看回复文本**: `hasConcreteEvidence` 检查回复里是否有证据形状的文字(````、数字/数字、PASS 等),不验证证据是否真实。验证行为门(`verificationCommandRan`)补充了「是否真的跑过验证命令」的检查。

3. **契约门依赖用户声明**: `parseCompletionContract` 只在目标文本含「完成标准」段或反引号命令时生效。用户未声明标准时,契约门不介入。

4. **跨轮预算由 goalCore 管理**: `goalStopGate` 只管单轮内再驱动;跨轮的无限循环由 `goalCore` 的轮次预算(`KHY_GOAL_MAX_TURNS`)结构性兜底。本文档不覆盖 goalCore 的具体实现。

5. **后台任务 FSM 不感知 AI 回复**: `largeTaskRuntimeStore` 的状态机只跟踪任务生命周期(queued→running→succeeded),不参与 AI 回复的内容判定。
