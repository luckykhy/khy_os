# [IMPL-RPT-043] 输出截断根治与无感接续：max_tokens 元数据缺失与锚点续写

> 实现报告 · 遵循 [MGMT-STD-001] 文档铁律 · 对应设计归 docs/03_DESIGN_设计/，本目录索引见 00_INDEX_实现-分类索引.md

- 日期：2026-08-07
- 范围：`max_tokens` 前飞决议因 provider 元数据缺失而失控（超服务端上限）导致的"半截截断"根治；截断续写从弱指令升级为带断点锚点的无感接续；远端模型探测对 `max_output_length` 字段的识别补齐。
- 状态：定稿（单元测试 + 整体回归通过）

## 一、背景与目标

khy 在 agnes-2.5-flash 上**总是**出现输出"半截截断"：长回复在某一节点停止，恢复机制未能在用户感知层面补全。实测定位到根因不是网络也不是模型能力，而是 **max_tokens 前飞决议把整个 context window 当输出预算，向服务端发送远超其硬上限的 `max_tokens`**，服务端拒绝后输出被判截断。

本次改造分三层完成：**配置根因修复**（正确声明模型输出上限）+ **代码元数据识别补齐**（远端 `/models` 字段 `max_output_length` 自动提取）+ **无感接续增强**（续写指令携带已输出文本锚点，模型从断点精确续写，不重复、不重起）。

## 二、根因：max_tokens 前飞决议失控

### 2.1 完整因果链

```
1. custom_providers.json 中 agnes 只配了 contextWindow: 512000，缺 maxOutputTokens
2. apiAdapter.listModels() 据此返回 { contextWindow: 512000, maxOutputTokens: 0 }
3. maxTokensPolicy 走 Rule 2：contextWindow>0 且 maxOutputTokens=0
   → target = available（整个上下文窗口）→ max_tokens ≈ 50 万
4. khy 把 max_tokens≈50万 发给 agnes
5. agnes 服务端硬上限 65536 → 500 拒绝 / 截断
6. 每次长回复请求都超限 → "总是半截截断"
```

### 2.2 实测证据（agnès 官方端点，经 127.0.0.1:7890 代理）

| 请求 max_tokens | 结果 |
|-----------------|------|
| 65536 | 200，finish_reason=stop，完整输出 |
| 524288 | 500 `max_tokens exceeds the limit of 65536` |

### 2.3 全 provider 服务端上限探测

| Provider | 模型 | 服务端上限 | 修复前元数据 |
|----------|------|-----------|--------------|
| agnes | agnes-2.5-flash | 65536 | 有 contextWindow、无 maxOutputTokens → 发 50万 → 500 |
| sensenova | deepseek-v4-flash | 384000 | 远端 `/models` 返回 `context_length` + `max_output_length`，但探测不识别 `max_output_length` → 发 ~100万 → 超限 |
| stepfun | step-3.7-flash | 无硬上限（400 万也通过） | 无 defaults → abstain → 8192 兜底 |

## 三、修复内容

### 3.1 配置层（用户数据 `.khy/custom_providers.json`）

| Provider | 修复前 | 修复后 |
|----------|--------|--------|
| agnes | `contextWindow: 512000` | + `maxOutputTokens: 65536` |
| sensenova | 无 defaults | `contextWindow: 1048576` + `maxOutputTokens: 65536` |
| stepfun | 无 defaults | `maxOutputTokens: 65536` |

修复后 `maxTokensPolicy` 决议结果统一收敛到 `maxTokens=65536`（source=`model_output_limit`），不再超过任何服务端上限。

### 3.2 代码层（元数据自动提取）

**`services/backend/src/services/gateway/upstreamModelProbe.js`**：远端 `/models` 探测的输出上限字段列表新增 `max_output_length`（sensenova 等国内厂商的字段名）：

```javascript
const maxOut = m.max_output_tokens || m.max_completion_tokens
  || m.max_output_length || m.output_token_limit || m.max_output || m.max_tokens || 0;
```

这样即使配置层没写 defaults，只要 provider 的 `/models` 返回该字段，系统也能自动获得真实输出上限。

### 3.3 无感接续（续写锚点）

**`services/backend/src/services/query/maxTokensRecovery.js`**：`buildContinuationPrompt(partialText)` 新增锚点能力：

- **有已输出文本**（≥ `MIN_CONTINUATION_CHARS` 40 字符）→ 回显其尾部 `CONTINUATION_ANCHOR_TAIL_CHARS`（320）字符作断点锚点，指令明确"从断点无缝继续、不要重复这段内容、不要重新打招呼/重写开头、不要输出前言"。
- **无文本 / 文本过短** → 逐字返回原英文指令，行为完全不变（向后兼容）。

**`services/backend/src/services/toolUseLoopCore.js`**：截断恢复（s11）调用处把累积的已输出文本传入：

```javascript
currentMessage = _maxTokensRecovery.buildContinuationPrompt(_truncationAccumulator);
```

续写从"从零开始的弱指令"升级为"带断点锚点的精确接续"，模型不会重复开头或跑偏，接缝在用户感知层面几乎无感。

## 四、测试与验证

- `tests/maxTokensRecovery.test.js`（jest，29 用例）：新增 `buildContinuationPrompt` 锚点行为 4 用例——无参字节兼容、短文本回退、锚点内容、超长截断到锚窗。
- `test/upstreamModelProbe.test.js`（jest，13 用例）：新增 `max_output_length` 识别用例。
- 修复后 preflight 决议验证：agnes/sensenova/stepfun 全部 `maxTokens=65536`，不超服务端上限。
- 实测：`max_tokens=65536` 对 agnes 返回 200 `finish_reason=stop`，无截断。
- `node scripts/check-agent-rules.js --changed`：0 error（39 warning 为既有 khyquant 其他文件）。

## 五、涉及文件

| 文件 | 职责 |
|------|------|
| .khy/custom_providers.json | 用户配置：agnès/sensenova/stepfun 补 `maxOutputTokens`（进程内缓存，需重启生效） |
| services/backend/src/services/gateway/upstreamModelProbe.js | 远端探测识别 `max_output_length` 字段 |
| services/backend/src/services/query/maxTokensRecovery.js | `buildContinuationPrompt` 带断点锚点 + `CONTINUATION_ANCHOR_TAIL_CHARS` 常量 |
| services/backend/src/services/toolUseLoopCore.js | s11 截断恢复调用点传入已输出文本锚点 |
| services/backend/tests/maxTokensRecovery.test.js | 锚点续写用例 |
| services/backend/test/upstreamModelProbe.test.js | `max_output_length` 识别用例 |

## 六、后续注意事项

1. `.khy/custom_providers.json` 有进程内缓存，**需重启 khy 生效**。
2. 未来新增 provider 时，优先让 `/models` 返回 `context_length` + `max_output_length`/`max_output_tokens` 元数据，系统可自动识别；否则在 `defaults` 中补 `maxOutputTokens`，且务必等于服务端实际硬上限。
3. 恢复机制的 Phase 1 escalation 上限（静态 64000）对已探测 provider 都会被动态钳位到真实上限（≤65536），无超限风险；元数据未知的 provider 回退 64000，仍低于主流服务端上限。

## 七、行业对比：opencode 的截断处理哲学

为校准本方案的取舍，对 opencode（开源 AI 编码 CLI，TypeScript）的实际源码做了对照分析。结论：**opencode 几乎不防截断，而是让截断"无关紧要"**——通过三个设计与 khy 的"续写补救"路线形成互补。

### 7.1 opencode 的三个关键设计

**① max_tokens 每次拉满到合法上限**（`packages/opencode/src/provider/transform.ts`）：

```typescript
const OUTPUT_TOKEN_MAX = 32_000
export function maxOutputTokens(model, outputTokenMax = OUTPUT_TOKEN_MAX) {
  return Math.min(model.limit.output, outputTokenMax) || outputTokenMax
}
```

每次请求都把 `max_tokens` 设为 `min(模型声明输出上限, 32K)`——永远发一个**恰好合法且尽量大**的值，从根上杜绝"请求超服务端上限被拒"这类截断。这与 khy 修复前"max_tokens 撞服务端上限"的故障模式正好相反。

**② 截断后静默接受，不续写**（`packages/opencode/src/session/prompt.ts`）：

```typescript
if (lastAssistant?.finish && !["tool-calls"].includes(lastAssistant.finish) && !hasToolCalls) {
  break  // finish="length" 时直接退出循环，截断文本被当作最终答案
}
```

检测到 `finish === "length"` 时**不续写、不报错**，直接把已产出文本交付。截断信息经 AI SDK 归一化为 `step-finish.reason` 落盘到 `assistantMessage.finish`，但主循环只把 `content-filter` 与 `json_schema` 失败当错误处理，`length` 不触发任何补救。

**③ 主循环天然"多轮拆分"**：`runLoop` 每轮重读 DB，有工具调用就继续下一轮（工具结果回喂再生成）。长任务被拆成多轮短输出，单轮截断概率低；加上 `max_tokens` 大预算（~32K）兜底，纯文本几乎到不了截断点。上下文溢出走 compaction（输入侧压缩），防的是输入溢出而非输出截断。

### 7.2 与 khy 的取舍对比

| 维度 | opencode | khy（本次修复后） |
|------|----------|-------------------|
| max_tokens 策略 | 每次拉满到 `min(模型上限, 32K)` | 前飞决议动态推导，修复后稳定到服务端上限 |
| 截断后 | 静默接受，不做续写 | 带锚点自动续写（最多 3+2 次） |
| 续写质量 | 无续写 | 锚点精确接续，但多轮请求成本 |
| 核心哲学 | 让截断不发生（大预算 + 多轮拆分） | 截断发生后的补救（续写） |
| 对 provider 元数据依赖 | 模型声明 `limit.output` 必需 | 可经 `/models` 探测或 `defaults` 配置 |

### 7.3 可借鉴的后续方向

opencode 的"max_tokens 拉满到模型合法上限 + 工具多轮循环"可作为 khy 的**第一道防线**，续写机制作为**兜底**，而非把所有赌注押在续写上。潜在改进：

1. **preflight 在已知模型合法上限时直接拉满**（而非当前"到 65536 即止"），进一步降低首次截断率；
2. 若某 provider 元数据未知，维持现有 abstain + 适配器兜底路径不变（opencode 要求模型声明 `limit.output`，khy 的探测/配置兜底更宽容，是优势）；
3. 续写机制保留——在"输出确实超过单次上限"的场景（超长文档/代码）仍是无感接续的关键，opencode 在此场景下是直接丢弃后半段的。

### 7.4 落地：截断续写的升级边界修复（第一道防线补强）

对照 opencode"给模型完整合法输出预算"的哲学，定位到 khy 一处让截断更容易复发的边界 bug 并修复：

**问题**：`maxTokensRecovery.shouldRecover()` 的升级判定要求 `effectiveMax <= CAPPED_DEFAULT_MAX_TOKENS (8000)` 才允许升级。但修复配置后 preflight 的常见取值是 `8192`（适配器兜底/preflight 下限）——`8192 > 8000`，导致**首次在 8192 截断后，续写仍用 8192，再次截断**，恢复循环空转。

**修复**（`maxTokensRecovery.js:125`）：

```javascript
// 旧：只在 cap ≤ 8000 时升级（冻结了 8192，截断复发）
const shouldEscalate = effectiveMax <= CAPPED_DEFAULT_MAX_TOKENS && ceiling > effectiveMax;
// 新：只要 ceiling 真正更大就升级（给续写更多余量，opencode 哲学）
const shouldEscalate = ceiling > effectiveMax;
```

调用侧 `toolUseLoopCore.js:3747` 同步放宽，删除重复的 `<= CAPPED_DEFAULT_MAX_TOKENS` 闸门。

**验证矩阵**（修复后）：

| currentMax | 动态上限 | 行为 |
|-----------|---------|------|
| 8192 | 65536 | 升级到 65536 ✅ |
| 16384 | 65536 | 升级到 65536 ✅ |
| 65536 | 65536 | 不升级（已到顶，正确）|
| 8192 | 8192 | 不升级（无提升空间，正确）|
| 8192 | 无元数据 | 升级到静态 64000 |

升级目标 `nextMax` 由 `ceiling = min(dynOut || 64000, contextWindow-可用空间)` 钳位，**永不超服务端合法上限或上下文窗口**，无超限风险。相关测试新增 4 用例锁定（`tests/maxTokensRecovery.test.js`，共 33 用例全过）。

## 八、三项落地改进（调低拆解阈值 + 长回复自动拆段 + 通道失败诊断）

延续"让截断尽量不发生"的方向，落实三项可交付改进。全部 fail-soft，门控可回退，逐字节兼容旧行为。

### 8.1 调低拆解阈值（`services/taskScale.js`）

**缺口**：中复杂度任务（比较/多对象/复合查询）被 small 兜底（Rule 4/5）吞掉，跳过计划拆解注入——"对比 A 和 B 的优缺点""查 A 和 B 的天气顺便看看 C"这类需要多步检索的请求被当成简单问答。

**修复**：新增 `_COMPARE_MULTI_OBJECT` 信号（比较/多对象/复合意图正则），Rule 4/5 命中该信号时排除 small → 进入 normal 走拆解。

**验证矩阵**：

| 输入 | 修复前 | 修复后 |
|------|--------|--------|
| 对比A和B的优缺点 | small | normal ✅ |
| 多目标查询（和…分别…顺便…看看）| small | normal ✅ |
| 纯闲聊 / 简单状态查询 / 简短指令 | small | small（不污染）✅ |
| 编码任务 | normal | normal ✅ |

新增测试 `tests/services/taskScaleDecomposeThreshold.test.js`（jest，8 用例）。

### 8.2 长回复自动拆段（`services/taskComplexity.js`）

**缺口**：复杂任务即使拆解了执行计划，最终交付仍可能试图一轮输出超长内容，撞输出上限截断。

**修复**：`injectPlanningPrompt` 在 `autoDecompose` 分支追加分段交付指令——明确"若最终回答预期很长（多节/超 300 行代码/完整文档），应跨多轮分段交付，每轮完成并呈现一节，绝不尝试单轮输出全部"。

这样长输出**从源头**被规划为多轮，而非截断后再续写补漏。`KHY_AUTO_DECOMPOSE`（默认开）门控控制。新增测试锁定 `autoDecompose:true` 含分段指令、`false` 不含（`taskComplexity.decomposition.test.js`，6 用例）。

### 8.3 通道失败诊断（`services/gateway/buildChannelFailureAdvice.js`）

**缺口**：非带图请求穷尽所有通道后，只看到"所有 AI 通道均不可用"墙——即便 attempts 里握着高频确定性信号（5xx / auth / 限流 / 网络 / 模型不存在），用户也不知道该做什么。

**修复**：新增纯叶子 `buildChannelFailureAdvice`，把各通道失败翻译成可操作指引前置到兜底墙之前（门控 `KHY_CHANNEL_FAILURE_ADVICE`，默认开）：

| 信号 | 指引 |
|------|------|
| server_error (5xx: 502/503/504) | 上游/代理瞬时故障 → 稍后重试 / `khy gateway status` / `/proxy` |
| auth (401/403) | 密钥无效或权限不足 → `ai config` 检查 key |
| rate_limit (429) | 通道被限流 → 降并发稍后重试 |
| network / 代理隧道 | 传输层故障 → 查网络代理稍后重试 |
| model_not_found (404) | 模型不存在/未领取 → 检查模型串 / 领取 |

与视觉专项诊断（`visionExhaustionDiagnostic`）正交：本叶子覆盖**所有**请求，视觉分支覆盖带图请求，二者可叠加。接入点 `aiGatewayGenerateMethod.js` 兜底墙组装处。新增测试 `tests/gateway/buildChannelFailureAdvice.test.js`（node --test，9 用例）；`flagRegistry.js` 登记门控。

### 8.4 计划前多方案选择（`services/taskComplexity.js` + `cli/aiChatCore.js`）

**缺口**：复杂任务拆解时，模型直接提交单一执行计划，用户只能全盘批准/修改/拒绝——无法在**方案层面**先做取舍。

**修复**：`injectPlanningPrompt` 新增 `multiOption` 分支，门控 `KHY_PLAN_MULTI_OPTION`（默认开）。命中时注入指令：模型先用 `AskUserQuestion` 呈现 2-3 个**执行策略**（各带权衡：速度/深度/风险），用户选定后再按所选策略细化 `<execution_plan>`。关门 → 逐字节回退单方案拆解。

**接线**：`aiChatCore.js` 的 `injectPlanningPrompt` 调用点从 `KHY_PLAN_MULTI_OPTION` 解析传入；`flagRegistry.js` 登记门控。

**复用现有基础设施**：多方案选择借道已有的 `AskUserQuestionTool`（对齐 Claude Code 的 AskUserQuestion，已支持选项/推荐置顶/多选/preview），工具循环会拦截其结果回喂模型继续计划——零新增工具，纯指令引导。新增测试 2 用例（`taskComplexity.decomposition.test.js`，共 8 用例）。

### 8.5 全链路总览（"让截断尽量不发生"完整防线）

| 层 | 机制 | 门控 |
|----|------|------|
| 方案层 | 计划前多方案选择（用户先定策略）| `KHY_PLAN_MULTI_OPTION` |
| 拆解层 | 复杂任务计划拆解（`<execution_plan>`）| `KHY_AUTO_DECOMPOSE` |
| 分段层 | 长输出主动分多轮交付 | `KHY_AUTO_DECOMPOSE` |
| 预算层 | preflight 动态 max_tokens + 升级边界修复 | `KHY_MAX_TOKENS_AUTO_RESOLVE` |
| 兜底层 | 带锚点无感续写 + 可见截断提示 | `KHY_LENGTH_RECOVERY_MAX_ATTEMPTS` |
| 诊断层 | 通道失败可操作指引 + 视觉专项诊断 | `KHY_CHANNEL_FAILURE_ADVICE` |

### 8.6 合理拆分的边界（防止无限/过度拆分）

调低拆解阈值、多方案、分段交付都放大了"模型自行决定拆到多细"的自由度，必须有硬边界兜底。khy 现有的防御已覆盖，加上本次补强：

**硬边界（已有，防无限）**：

| 约束 | 默认值 | 位置 |
|------|--------|------|
| 工具循环迭代上限 | 100 次（fallback 10）| `toolUseLoopCore.js` `MAX_ITERATIONS` |
| 循环墙钟 | 600s（可配 `KHY_TOOL_LOOP_MAX_MS`）| `_resolveMaxElapsedMs` |
| 子代理嵌套深度 | ≤2 层（`KHY_MAX_SUBAGENT_DEPTH`）| `AgentTool` `_maxSubagentDepth` |
| 子代理扇出宽度 | 硬件适配（弱机强制串行）| `_maxSubagentFanout` |
| 截断续写次数 | ≤3 次（`KHY_LENGTH_RECOVERY_MAX_ATTEMPTS`）| `maxTokensRecovery` |
| 迭代耗尽收尾 | 1 次 grace 总结后强制结束 | `IterationBudget` |

**补强（防过度拆分，本次新增）**：

- `taskScale.COMPARE_MIN_LEN = 20`：比较/多对象信号**低于 20 字符保持 small**——一句话比较（如「对比X和Y」）一眼可答，拆解指令是过度设计；只有达到足以承载多步骤检索/对比的长度才进入 normal 走拆解。

**验证矩阵**（合理拆分）：

| 输入 | 长度 | 判定 | 是否拆解 |
|------|------|------|----------|
| 对比X和Y | 5 | small | 否（过度拆解守卫）|
| A和B的区别 | 6 | small | 否 |
| 对比一下SSRI和中药的优缺点 | 15 | small | 否（仍过短）|
| 对比一下SSRI类…对轻度抑郁症的优缺点 | 34 | normal | 是（合理）|
| 多目标查询（和…分别…顺便）| 32 | normal | 是（合理）|

**设计原则**：拆解与否由「任务规模 + 消息粒度」双维度决定——规模大（normal/large）才有资格拆解，消息够长（> 20 字）才实际拆解。深度/宽度/迭代/墙钟四重硬边界保证**任何**情况下都不会无限拆，只会「有界地拆」。

### 8.7 停滞检测误判修复（toolLoopDetector Detector 8）

**现象**：扫描类任务（khy 查多个目录/文件）连续调用同一工具，被 `Action stagnation: tool "shell_command" called 8 times consecutively` 误判为停滞而中断——即便每个命令参数不同、都在推进。

**根因**：Detector 8（action stagnation）的 streak 判定只比对**工具名**（`_sameNameStreak` 由 `_lastToolName` 驱动），完全忽略参数。于是「用 bash 查 8 个不同路径」与「反复执行同一命令」无法区分，扫描被误杀。

**修复**（`toolLoopDetector.js`）：
- 新增 `_lastCallHash` 状态，streak 累加条件改为「工具名 + 参数指纹（`hashCall(toolName, params)`）都相同」
- 参数变化即重置 streak——真正循环是「相同调用原样重复」，扫描不同目标是正常进展

**验证矩阵**：

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| bash 查 8 个不同路径 | 误判停滞中断 | 正常放行 ✅ |
| 同一命令重复 8 次 | 拦截 | 拦截（genericRepeat）✅ |
| read_file 读 9 个不同文件 | 误判 | 正常放行 ✅ |
| 同文件读 5 次 | 拦截 | 拦截 ✅ |

**测试孤儿修复**：`tests/services/toolLoopDetector.test.js` 原用 `jest.mock` + `descFn`，既不被 jest 通道识别（`JEST_REGISTER_RE` 不匹配 `descFn(`），也无 `node:test` 标记——**两个通道都不跑**（死测试）。重写为 node:test 风格（去 jest.mock，用真实 contextWasm），现于 `test:node` 通道运行 18 用例，含 3 个新增 Detector 8 用例锁定修复。

### 8.8 启动空白修复（startupAnchor 光标定位）

**现象**：khy OS 启动时，「登录成功」信息（TUI 前的普通输出）与 WelcomeBanner 版本号之间有**大量空白行**——滚动回看时尤其明显。

**根因**：`startupAnchor.js` 的 `anchorBottomPad` 为把 TUI 首帧"贴底"（prompt+footer 紧贴屏幕底部），向真实 stdout 写 `'\n'.repeat(rows-1)` 个换行（默认 24 行 → 23 个空行）。这些换行**原样进入原生 scrollback**，落在登录行与 banner 之间，形成空白块。放大因素：Windows conpty 下 `process.stdout.rows` 常为 undefined → fallback 24 行，与实际屏幕高度错配。

**修复**（`startupAnchor.js`）：换行 pad 改为 **CUP 光标定位**（`\x1b[<rows>;1H`）：

```javascript
// 旧：'\n'.repeat(rows-1) → rows-1 个换行进入 scrollback（空白块）
// 新：`\x1b[${rows};1H` → 光标定位到底行，不进 scrollback
return `\x1b[${target};1H`;
```

**效果**：贴底效果保持（光标到底行后 ink 写内容照常滚动占底），但**不产生 scrollback 空行**——登录行与 banner 之间无空白块。写入 `_realOut`（真实 stdout，非 `_tuiStdout` proxy），不经 scrollbackPreserve/sidebarRail 处理，无交互干扰。

**验证**：`startupAnchor.test.js` 重写为断言 CUP 序列 + 无换行（8 用例）；railLayout/sidebarLayout 相关 159 用例全过；规则检查 0 errors。门控 `KHY_TUI_ANCHOR_BOTTOM`（默认开）保留，可一键回退。

### 8.9 网络抖动不重试修复（toolUseLoop `_isTransientLoopErrorType`）

**现象**：khy 一旦出现网络抖动（如 agnes 上游 502/503/504）即失败，**不会重试**，当前任务永久中断、不可恢复。

**根因**：`toolUseLoopCore.js` 的 `_isTransientLoopErrorType` 集合只含 `timeout/cancelled/network/process/empty/unknown`，**不含 `server_error`（5xx）和 `retry_budget_exceeded`**。网络抖动在网关层表现为 502 → `server_error`：网关已有冷却（15s）+ 网络抖动重试预算增强（`_isNetworkJitterLikeFailure` 识别 502/503/504 → 提升 attempts/delay），**但预算最终耗尽后把 `server_error` 原样返回给工具循环**——工具循环因类型不在瞬态集合而**不触发第二层重试**，任务直接中断。

**修复**（`toolUseLoopCore.js`）：把 `server_error` 与 `retry_budget_exceeded` 加入瞬态集合：

```javascript
|| t === 'server_error'           // 5xx 上游/代理瞬时故障,非冷却时工具循环有界二次重试
|| t === 'retry_budget_exceeded'  // 网关抖动预算耗尽 ≠ 通道永久失败,延迟后可再试
```

**安全性**：`_isCooldownFailure`（先于瞬态判断）会挡住 cooldown 缓存错误——只有**真 server_error**（非冷却）才触发工具循环重试，不会无脑撞同一堵墙。瞬态预算 `transientRecoveryMax` 有界（small≤3 / normal≤4 / large≤6），跨层重试不会失控。

**验证矩阵**：

| 错误类型 | 修复前 | 修复后 |
|----------|--------|--------|
| server_error (502/503/504) | 不重试 → 永久中断 | 有界重试（非冷却时）✅ |
| retry_budget_exceeded | 不重试 → 永久中断 | 有界重试 ✅ |
| network / timeout | 重试 | 重试（不变）|
| auth / permission / refusal | 不重试 | 不重试（不变，安全红线）|

新增测试 `tests/services/toolUseLoopTransientErrorTypes.test.js`（node:test，5 用例）；`_isTransientLoopErrorType` 导出供测试。相关回归：toolUseLoopTransientBudget 5 + serverErrorFastFail 3 + toolUseLoop 系列 27（jest）+ replyGuard 全过；规则检查 0 errors。
