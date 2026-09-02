# [DESIGN-ARCH-073] khyos 核心任务循环 — 稳定交付总纲

> **定位**：khyos 执行一个用户任务时从「受理」到「交付」的**核心循环单一真源**——即任务最小闭环
> （登记 → 执行 → 裁决 → 交付 → 台账）的完整运行时契约。任何人（AI 助手、维护者、操作者）要回答
> 「khyos 怎么做任务、凭什么算交付完、坏了怎么查」都以本文为准。
> **适用边界**：只描述任务执行循环本体；层级与依赖方向见 `[DESIGN-ARCH-068]`，通道选择见
> `[DESIGN-ARCH-071]`，收尾裁决接线与交付台账的实现细节见 `[DESIGN-ARCH-072]`，持久任务（队列/租约）
> 的状态机见 `docs/03_DESIGN_设计/RELIABILITY-PROTOCOL.md`。
> **代码锚点**：`services/backend/src/services/toolUseLoopCore.js`（循环本体，各门以文件内中文门名注释
> 为 grep 锚点）、`services/backend/src/services/agenticHarnessService.js`（harness 验证层）、
> `services/backend/src/services/backgroundTaskManager.js`（终态咽喉）、
> `services/backend/src/services/deliveryLedger.js`（台账）。

---

## 0. 闭环全景

```text
 用户任务
    │
    ▼
┌─ 登记 ────────────────────────────────────────────────────────┐
│ backgroundTaskManager.register() → durable 任务库            │
│ （.khy/tasks/large_task_runtime.json，canonical 状态机）      │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌─ 执行 ────────────────────────────────────────────────────────┐
│ runToolUseLoop（toolUseLoopCore）                             │
│   工具轮：解析计划 → <tool_call> → 权限网关 → 执行 →          │
│           写后回读自证 → 结果透明化 → 下一轮                  │
│   「想停」轮：门序见 §2（一致性门 → 软门 → 仲裁门 → 硬门）     │
│   有界性：MAX_ITERATIONS=100 · 墙钟 10 分钟 · 每门独立预算     │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌─ 验证（harness 路径；headless 为最小版）──────────────────────┐
│ 交付门 deliveryGate：验收包（空 criteria → 最小兜底）→        │
│   逐条评估 → 不过 → 修复循环 ≤3 轮                            │
│ VerificationAgent：语法/lint/test/build + 一次修复            │
│ 回归门：基线对比                                              │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌─ 裁决 ────────────────────────────────────────────────────────┐
│ buildHarnessDeliveryVerdict → pass/fail；fail 时把缺口        │
│ 如实追加进最终回复，绝不假装成功收尾                          │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌─ 交付 + 台账 ─────────────────────────────────────────────────┐
│ 终态咽喉 backgroundTaskManager.complete/fail/cancel →        │
│ deliveryLedger 追加 JSONL → khy deliveries 回查               │
│ headless -p 路径在 bin/khy.js 退出前入账（含循环报错回退）    │
└──────────────────────────────────────────────────────────────┘
```

**不变式（违反任何一条即闭环破损，评审按红线对待）**：

1. **登记必达**——凡走 harness/后台的任务必先 `register()`，有 ID 可查可取消。
2. **终态必达**——任务不得滞留 running；崩溃/中断走 boulder 断点（§5），可 `khy resume`。
3. **诚实收尾**——`close_partial` / 交付门 fail / 达上限时，缺口必须写进用户可见的最终回复与台账，绝不把过程当结果。
4. **有界续跑**——任何再驱动（nudge / redrive / remediation）都有独立预算，预算耗尽即降级收尾，绝不无限循环。
5. **证据门**——声称「测试通过/已验证」却拿不出真实验证命令记录 → 必须再驱动，声称即接受被禁止。
6. **台账必记**——每个终态（含失败与取消）都进交付台账，5 分钟 TTL 只清活动列表 UI，不灭台账。

---

## 1. 入口与路径矩阵

| 入口 | 命令 | 执行路径 | 验证层级 | 台账 |
|---|---|---|---|---|
| 交互 REPL（默认） | `khy` + 任务文本 | `agenticHarnessService.run()`（`KHY_REPL_HARNESS` 默认开） | 完整：交付门 + 验证代理 + 回归门 + 裁决 | ✓（经终态咽喉） |
| Headless 一次性 | `khy -p "任务"` | `runToolUseLoop` 原生循环（`KHY_HEADLESS_NATIVE_LOOP` 默认开） | 最小：循环内门序 + 台账如实入账 | ✓（bin/khy.js 退出前） |
| 一次性纯问答 | `khy --ai "问题"` | 单发 chat，无工具循环 | 无（问答非任务，不入账避免噪音） | — |
| 后台任务 | AgentTool/Task 工具/`agent run` | durable 队列 + worker | 循环内门序 | ✓（经终态咽喉） |
| 断点续跑 | `khy resume <taskId>` / `khy resume list` | boulder 检查点重激活 | 继承原路径 | ✓ |

---

## 2. 「想停」轮门序（模型不再调工具时的完整序列）

> 这是闭环的裁决核心。顺序即代码顺序（`toolUseLoopCore.js` 内按门名注释 grep 可定位）；
> 「一次性」指每轮循环至多触发一次，「有界」指带显式预算。

| # | 门 | 预算 | 门控（默认态） | 作用 |
|---|---|---|---|---|
| 1 | 项目一致性门 projectCoherence | ≤2 轮 | `KHY_PROJECT_COHERENCE_ROUNDS`（2） | 文件聚合后导入断链/入口失配 → 续推 |
| 2 | concludeNow 短路 | — | — | ≥400 字实质非占位答复直接进入收尾装配（省一轮模型调用） |
| 3 | 承诺式结尾 nudge | ≤2 次 | — | 「让我…/我将…」结尾却零工具调用 → 推它真执行 |
| 4 | 软门抑制判定 | — | `KHY_SUPPRESS_SOFT_REDRIVE`（开） | 实质答复已交付本轮 → 抑制后续软门，防同一答案重复生成 |
| 5 | deliverableClosure 收尾兜底 | 有界 2 | `CAP_SEAMS.EMPTY_TOOLCALLS` | 空壳收尾检测（[DESIGN-ARCH-050]） |
| 6 | selfKickoff 启动兜底 | ≤3 次 | 同上 | 「干了一半又回前言」→ 续推 |
| 7 | 选择腔 nudge | 一次性 | harness profile | 列选项不执行 → 推它执行 |
| 8 | 过短无结论 nudge | 一次性 | harness profile | 零工具+短回复+无结论 → 挑战 |
| 9 | 失败恢复 nudge | 一次性 | harness profile | 工具失败后短回复放弃 → 推它换方法 |
| 10 | 伪成功拒绝 nudge | 一次性 | harness profile | 已取回数据却回套话拒绝 → 用数据作答 |
| 11 | **任务收尾仲裁门** | ≤6（默认 1） | `KHY_TASK_CLOSURE_GATE`（开）；预算 `KHY_TASK_CLOSURE_REDRIVE_MAX`（1） | **权威三态仲裁**（§2.1） |
| 12 | 持久目标门 goalStopGate | ≤10（默认 1） | `KHY_GOAL_STOP_GATE`（开，父门控 `KHY_GOAL`） | 仅 `/goal set` 后生效；达成可自动清除 |
| 13 | coding 验证引导 | 一次性 | harness profile | 改了文件没跑 build/test → 推它验证 |
| 14 | 交付结论 nudge | 一次性 | harness profile | 有工具、回复短且无结论 → 要求补交付说明 |
| 15 | 覆盖率检查 | 一次性 | harness profile | 用户请求关键词覆盖率 <30% → 推它查漏 |
| 16 | 失败静默披露 | 被动 | — | 有失败工具调用且回复未提 → 追加披露 |
| 17 | 结果守卫 C | 一次性 | `KHY_RESULT_GUARD` | 承诺式前言未交付 → 追加诚实收尾 |
| 18 | Stop hook | 可否决 1 次 | hook 配置 | 外部 hook 可拦截自然停机 |
| 19 | answerVerifier | 被动 | `KHY_ANSWER_VERIFIER`（开） | 算式真值/动作声称与工具日志对账，证伪处如实追加 |
| 20 | 空回复兜底 → **close_partial 标注追加** → terminalNotice → return | — | — | 空回复由工具日志合成诚实小结；仲裁门降级标注经此通道流式必达 |

### 2.1 任务收尾仲裁门（#11，闭环的权威裁决）

判定在纯叶子 `taskClosure.decideClosure`（零 IO、可单测），接线处只做落地：

- **close**——终态交付 + 无未完成步骤 + 验证声称有真实命令记录 → 放行交付。
- **redrive**——注入 `buildRedriveMessage`（含原始请求 + 未完成步骤清单）再驱动一轮。
  - 结构化信号（`steps-incomplete` 计划步骤未完成 / `verification-missing` 声称验证却未真跑）是**硬门**：不受软门抑制（#4）拦截——实质性假完成正是抑制门的盲区；
  - 非结构化「无收尾词」再驱动尊重抑制，避免对已交付答案重复生成。
- **close_partial**——预算耗尽即诚实降级：未完成步骤/未经证实的验证/无证据逐条写入标注，随交付返回，绝不假装成功。
- **证据门**：`verificationCommandRan` 要求工具日志里真有验证命令（`params.command` 命中 build/test 模式），「口头上说测过了」不算。
- 作用域：仅 `actionTask`（`_looksLikeActionRequest` 命中）；纯问答/闲聊不受此门。

### 2.2 工具执行失败的多分支恢复梯子（toolFailureRecovery）

工具调用链路的异常按层次各有分支，**每个分支都有界**；判定在纯叶子
`toolFailureRecovery.js`（零 IO、可单测），接线处（并行/串行执行路径）只做 IO：

**A. 单次工具调用内部**（executeTool → ToolError 结构化，绝不崩循环）：
executeTool 自身把超时/取消塑成诚实可重试的结构化结果；循环侧 catch 再给一层
`toolRegistry` 直调二次兜底（并行/串行两条路径**同构**），仍抛才 ToolError 结构化入账。

**B. 工具执行后钩子**（既有意图等价替换，执行失败时依次尝试顶替）：
shell 失败 + 打开应用意图 → `open_app` 候选试跑；shell 失败 + 信息搜索意图 →
`web_search` → `search` → `toolSearch`；错误结果附平台命令提示（Windows/Linux hint）。

**B+. Branch N（工具名执行前确定性纠正，2026-08 新增）**：
近似错误的工具名（`read_fiel` / `web_serch` / `ReadFile` / `web-search`）此前原样进
executeTool → TOOL_UNAVAILABLE → 错误文本回灌模型，模型要花一整轮自行纠正。现在在
解析汇合后、执行前，用已知工具名集合（含别名/变体）做**保守**纠正：键归一（大小写/
分隔符/首尾空白偏差）→ 唯一编辑距离命中（短名 ≤1、长名 ≤2，键空间去重防同工具变体
互相顶票）；**歧义（并列最小）一律不猜**、完全无关名原样放行——错误信号不丢失，交
后续失败分支。纠正成功标 `_originalName` 留痕。判定在纯叶子 `toolCallCorrection.js`，
门控 `KHY_TOOL_NAME_CORRECTION`（默认开）。

**C. Branch R（工具级瞬态自动重跑，2026-08 新增）**：
失败结果满足「瞬态（`error.retryable` 标记 / `TIMEOUT`·`NETWORK_ERROR` 码 / 瞬态文本特征：
ECONNRESET、socket hang up、rate limit、429/529/503…）**且**工具在只读白名单
（read/grep/ls/web_search/web_fetch/git 只读等，幂等重跑无副作用）**且**循环级预算
未耗尽（`KHY_TOOL_TRANSIENT_RETRY_MAX`，默认 2，clamp [0,5]）」→ 以新中断计划 + 原执行
契约自动重跑一次，成功顶替结果并标 `_transientRetried`。**写类工具（shell/write/edit）
绝不自动重跑**——副作用不可重复，失败一律交回模型裁决（Branch H）。

**D. Branch C（chat() 意外抛出的循环内重试，2026-08 新增）**：
适配器抛异常此前一律归一为「诚实本轮结束」——网络抖动类抛出在无人值守 run 里直接终止
本轮（headless 甚至终局）。现在守卫归一**之前**先给一条有界分支：异常文本命中瞬态特征、
非 cooldown、预算未耗尽（`KHY_TOOL_LOOP_CHAT_THROW_RETRIES`，默认 1，clamp [0,3]）→
退避后原地重发同一轮；耗尽/非瞬态 → 原诚实收尾逐字节保留。

**E. Branch H（诚实失败 = 安全默认）**：其余失败原样放行——错误文本（含 `hint`）回灌
模型，由模型决定换参/换工具/拆步；反复同参失败由 doomLoopGuard / loopDetector 断路器
接管；空回复守卫、transient 通道恢复、maxTokens 恢复各自有独立预算（§2 门序）。

**分支裁决准确性红线**（`toolFailureRecovery.decideToolRecovery`）：
- **确定性失败码优先**——`PERMISSION_DENIED` / `INVALID_ARGS` / `RESOURCE_NOT_FOUND` /
  `TOOL_UNAVAILABLE` / `MISSING_DEPENDENCY` 五码**压过** `retryable` 标记与文本特征：
  上游误标 retryable 的参数错误绝不触发自动重跑；
- **负向文本守卫优先于正向特征**——错误文本同时含确定性签名与瞬态字样时（如
  "invalid argument: timeoutMs must be < 120000"）判非瞬态，防 "timeout" 字样误判空跑；
- **只读白名单门槛**——写类工具（shell/write/edit…）瞬态失败绝不自动重跑，副作用
  不可重复；
- **纠正歧义不猜**——工具名纠正遇并列最小编辑距离一律放行，错误信号交模型与探索分支。

### 2.3 输出区分级显示（核心抢占焦点 / 次要折叠防凌乱）

**单一真源**：`cli/toolDisplayPolicy.js` 的**显示矩阵**（家族 × tier × 渲染样式 × 说明文案，
同一注册表）。分级依据＝工具名清单（ALIASES 把注册表 **151 个工具全部**归一到 ~55 个家族），
不看参数；**未注册工具默认 core（宁可见到，不可漏掉）**。
`toolDisplayMatrix.test.js` 是完整性强制门：注册表新增工具而矩阵未分类 → 测试失败，
逼着维护者给新工具一个明确的显示位（tier + 说明 + 样式）。

**视觉语言三级层次**：`▌ 加粗焦点行`（core 说明，抢占焦点）＞ `⏺/◆ 头行` ＞ `⎿ dim 结果行`。
说明文案（intentLabel）是矩阵字段：`_describeToolIntent` 的 switch 只保留高频家族的
参数感知文案（"看看 x.js 里的内容"），**其余全部家族回退到矩阵 intentLabel**——
此前 ~100 个工具没有说明行，现在全部有。目标摘要由调用方拼参数链
（path/file_path/url/query/command/prompt/code/symbol…）。

**家族 → 显示方式矩阵**（★=core 抢占焦点常驻；○=minor 显示后折叠；样式列见下注）：

| 家族（代表性工具） | 级 | 说明文案 | 结果样式 |
|---|---|---|---|
| bash（PowerShell/shellCommand/REPL） | ★ | 执行命令 | **命令预览块**（boxPreview 底色块）+ ⎿ tree 6行 |
| codeexec / testrun / build / deps | ★ | 执行代码 / 运行测试 / 构建编译 / 管理依赖 | tree 8行 |
| write（writeFile/createFile） | ★ | 写入文件 | diff 红绿 10行 |
| edit（editFile/MultiEdit/apply_patch） | ★ | 编辑文件 | diff 红绿 10行 |
| open_app / desktop（ComputerUse/RPA） | ★ | 打开应用 / 桌面控制 | tree 6行 |
| browser（WebBrowser） | ★ | 操作浏览器 | tree 6行 |
| agent（Workflow/adoptRole/Team） | ★ | 委派子代理 | delegate（子代理树接管） |
| gitcommit / gitpush / gitclone（forgeCommits） | ★ | 提交变更 / 推送远端 / 克隆仓库 | tree 6行 |
| taskstop（KillShell） | ★ | 终止任务 | tree 6行 |
| docwrite（createDocument/renderDocument） | ★ | 生成文档 | tree 8行 |
| convert（pdfToWord/image2web） | ★ | 转换/发布文件 | tree 6行 |
| scaffold（scaffoldFiles/createTool） | ★ | 创建文件结构 | tree 8行 |
| mediagen（image_generate/video_generate） | ★ | 生成图片/视频 | tree 6行 |
| mediaedit（image_edit） | ★ | 编辑图片/视频 | tree 6行 |
| configwrite / importfam（Config/Configure 系） | ★ | 修改配置 / 导入模型配置 | tree 6行 |
| cron / trigger / deploy / shutdown / khyupdate / diskcleanup | ★ | 管理计划任务 / 远程触发 / 部署 / 关闭系统 / 更新 khyOS / 清理磁盘 | tree |
| worktree / planmode | ★ | 切换工作树 / 切换规划模式 | tree 4行 |
| mcp（MCPTool/McpAuth） | ★ | MCP 操作 | tree 6行 |
| skillload（Skill） / askuser（AskUserQuestion） | ★ | 加载技能 / 向你提问 | tree 4行 |
| read（readFile/notebookRead） | ○ | 读取文件 | collapsed 3行 |
| grep（search/searchContent） | ○ | 搜索内容 | tree 8行 |
| glob（find/ls/ListDir） | ○ | 查找文件 | tree 8行 |
| websearch（news/forgeSearch 系） | ○ | 搜索网页 | collapsed 4行 |
| webfetch（httpRequest/VaultHttpFetch） | ○ | 抓取网页 | collapsed 4行 |
| dataread / quote / dataquery / backtest | ○★ | 拉取数据 / 查询行情 / 查询数据库 / 运行回测★ | collapsed 4行（backtest★ tree 8行） |
| gitread（gitStatus/gitDiff/gitLog/gitBlame） | ○ | 查看 Git 仓库 | tree 8行 |
| taskmgmt（TaskCreate 系/TodoWrite/GoalTool/Brief） | ○ | 更新任务清单 | inline 3行 |
| memory（SaveMemory/LocalMemoryRecall） | ○ | 记忆读写 | collapsed 4行 |
| mediaread（imageOcr/RecognizeImage/video_analyze） | ○ | 分析图片/视频 | collapsed 4行 |
| verify（lint/security_scan/repoAudit/coverage） | ○ | 验证/检查 | tree 6行 |
| docread（Artifact/ReviewArtifact/inspectDocument） | ○ | 查看文档/产出物 | collapsed 4行 |
| mcpread（ListMcpResources/ReadMcpResource） | ○ | 查看 MCP 资源 | collapsed 4行 |
| appquery（DeviceApps/GetLocation） | ○ | 查询应用/位置 | tree 6行 |
| notify（SendMessage/PushNotify/SendUserFile） | ○ | 发送消息/通知 | collapsed 4行 |
| screencap（Snip） | ○ | 截取屏幕 | collapsed 4行 |
| cronread（CronList） | ○ | 查看计划任务 | collapsed 4行 |
| lsp / registryread / toolssearch | ○ | LSP 查询 / 检索注册表 / 搜索可用工具 | 6行/collapsed |
| aux（Sleep/unpack/Monitor 等内部辅助） | ○ | 辅助操作 | tree 4行 |

四条渲染路径消费同一份矩阵（判定在叶子、着色/布局在接线处）：
- **经典 REPL（TTY）**：`printStepLine` 接 `{toolName}` → 核心工具 `▌` 焦点锚点 + 加粗标签/目标，次要保持 dim（`steps.js` + `replSession` onToolCall 接线）；`toolProgressStart` 未收录家族回退矩阵 intentLabel（此前 ~100 个工具在 TTY 无进度行）；
- **管道/重定向输出**：`toolDisplay.printToolCallStart` 核心工具说明行以 `▌ + bold` 抢占焦点，次要保持 dim；
- **Ink TUI**（TTY 默认）：次要工具完成态收成 `⎿ 摘要 (ctrl+o 展开)` 一行；核心工具执行中 `↳` 叙述行 yellow+bold 强调（`ToolLines.js`）；
- **headless `-p`**：`headlessProgress.formatToolStart` 核心工具加 `▌` 前缀，次保持原轻量行（stderr，stdout 机器契约不动）。

全文回取不变：折叠只是显示层——`_expandableOutputs` + Ctrl+O（REPL）、expanded
prop（TUI）仍可取回完整输出，信息不丢失。

---

## 3. 验证与裁决层（harness）

`runToolUseLoop` 返回后，harness（`agenticHarnessService.js`）继续：

1. **交付门**：`intentGate.detectModes` → `buildAcceptancePack`（按意图模式生成验收标准；
   **criteria 为空时注入最小兜底** `substantive_final_response`——最终回复 ≥30 非空白字符，
   空壳/套话拒绝会被拦下）→ `evaluateDelivery` 逐条评估 → 不过进修复循环
   （`buildRemediationPrompt`，`KHY_DELIVERY_MAX_REMEDIATION` ≤3 轮）。
2. **验证代理**：VerificationAgent 对改动文件跑语法/lint/test/build（每步 60s 上限）+ 一次修复。
3. **回归门**：与任务前基线对比，防「修好一个弄坏三个」。
4. **裁决**：`buildHarnessDeliveryVerdict` 汇总 → `pass/fail`；**fail 时把「缺什么证据」如实追加进
   最终回复**，并把 `delivery-gate-report.md` 落盘到项目轨迹目录（`KHY_DELIVERY_GATE_REPORT` 开）。
5. **收尾**：清 boulder 检查点 → `backgroundTaskManager.complete/fail` → 交付台账入账
   （verdict=fail 的「完成」在台账记 `closure: delivery-gate-fail`，不谎报完整闭环）。

---

## 4. 台账与查询

| 需求 | 用什么 |
|---|---|
| 「上次任务交付了什么、缺什么」 | `khy deliveries`（别名：`交付` / `交付记录` / `台账` / `jiaofu`）；`--status succeeded\|failed\|cancelled`、`--task <taskId>`、`--limit n` 过滤；`khy deliveries stats` 看台账路径与条数 |
| 「这次执行跑了哪些操作、什么风险」 | `khy receipts list/show/search`（执行粒度回执，与台账互补：receipts 记操作，deliveries 记结论） |
| 「当前/历史活动任务」 | `/tasks`（REPL）或 `khy session`；活动列表终态 5 分钟 TTL 清理 |
| 「断了的任务从哪续」 | `khy resume list` → `khy resume <taskId>` |

台账为追加式 JSONL（`<dataHome>/tasks/delivery_ledger.jsonl`），自裁剪
`KHY_DELIVERY_LEDGER_MAX`（默认 500，clamp [1,5000]）；读取 fail-soft，坏行跳过、文件缺失返回空。

---

## 5. 失败模式与恢复

| 失败模式 | 系统行为 | 恢复手段 |
|---|---|---|
| 用户 Ctrl+C 中断 | `markBoulderInterrupted` 打断点（`.khy/boulder/boulder.db`，TTL 24h，512KB 上限） | `khy resume <taskId>` 或 REPL 提示恢复 |
| 循环达 100 轮 / 10 分钟墙钟 | 停止并如实标注「未完整闭环」（headless 可配 `KHY_HEADLESS_EXIT_ON_LIMIT` 反映退出码 3） | 拆小任务重跑，或 `khy resume` |
| 模型假完成（声称完成/验证） | 仲裁门 redrive → 预算耗尽 close_partial；harness 交付门 fail → 修复循环 ≤3 轮 | 交付门报告 + 台账缺口即「差什么」清单 |
| 近似错误的工具名（read_fiel 等） | Branch N：键归一 / 唯一编辑距离纠正后执行（留 `_originalName` 痕）；歧义不猜 | 歧义/无关名走 TOOL_UNAVAILABLE 失败 → unknown exploration 探索 |
| 工具循环整体抛错（headless） | 先走 Branch C：瞬态样抛出循环内有界重试（默认 1 次）；非瞬态/预算耗尽 → stderr 诊断（`KHY_HEADLESS_PROGRESS`）+ 台账记 `closure: error`，回退单发 chat | 依错误信息修复环境后重跑 |
| 只读工具瞬态失败（超时/网络抖动） | Branch R：只读白名单内自动重跑（默认 ≤2 次），成功顶替结果并标 `_transientRetried`；写类工具不自动重跑 | 非只读失败由模型换方法（Branch H） |
| 进程崩溃 | 任务滞留 running → 租约过期被 sweeper 回收重排（RELIABILITY-PROTOCOL） | worker 重新认领；无 checkpoint 则重跑 |
| 交付门误拦（真完成被判缺） | 修复循环后仍 fail → verdict fail 但如实附缺口，不静默丢弃成果 | 人工复核 `delivery-gate-report.md` 后放行 |

---

## 6. 环境变量总表（闭环相关，全部默认开/默认值即生产值）

| 变量 | 默认 | 管什么 |
|---|---|---|
| `KHY_REPL_HARNESS` | 开 | REPL 走 harness 完整闭环 |
| `KHY_TASK_CLOSURE_GATE` | 开 | 任务收尾仲裁门总开关 |
| `KHY_TASK_CLOSURE_REDRIVE_MAX` | 1 | 仲裁门再驱动预算（clamp [0,6]） |
| `KHY_GOAL_STOP_GATE` / `KHY_GOAL` | 开 / 开 | 持久目标门（嵌套父门控） |
| `KHY_DELIVERY_GATE` / `KHY_DELIVERY_MAX_REMEDIATION` | 开 / 3 | 交付门与修复循环 |
| `KHY_DELIVERY_GATE_REPORT` | 开 | 交付门报告落盘 |
| `KHY_ANSWER_VERIFIER` | 开 | 可证伪声称复核 |
| `KHY_PROJECT_COHERENCE_ROUNDS` | 2 | 一致性门轮次预算 |
| `KHY_SUPPRESS_SOFT_REDRIVE` | 开 | 已交付答案的软门抑制 |
| `KHY_TOOL_TRANSIENT_RETRY_MAX` | 2 | Branch R 工具级瞬态自动重跑预算（clamp [0,5]，仅只读工具） |
| `KHY_TOOL_LOOP_CHAT_THROW_RETRIES` | 1 | Branch C chat() 瞬态抛出的循环内重试预算（clamp [0,3]） |
| `KHY_TOOL_NAME_CORRECTION` | 开 | Branch N 工具名执行前纠正总开关 |
| `KHY_HEADLESS_NATIVE_LOOP` | 开 | headless -p 走原生工具循环 |
| `KHY_HEADLESS_PROGRESS` / `_TEXT` / `_HEARTBEAT` | auto/开/开 | headless stderr 进度反馈（stdout 契约不动） |
| `KHY_HEADLESS_EXIT_ON_LIMIT` | 关 | 达上限时退出码 3 + json 如实标注 |
| `KHY_DELIVERY_LEDGER_MAX` | 500 | 台账自裁剪上限（clamp [1,5000]） |

---

## 7. 稳定交付操作规程（操作者 / AI 助手）

1. **派任务**：能一句话说清验收标准的任务直接给；长任务先 `/goal set`——goalStopGate 会经 `completionContract` 从目标文本解析完成标准并逐条对证据，达成前拦截停止。
2. **跑任务**：交互用 REPL（完整验证）；脚本/CI 用 `khy -p`（最小闭环 + 台账）；重任务用后台（durable 队列，崩溃可续）。
3. **收工核对**：`khy deliveries` 看最近交付——`完整闭环` 才算完；`部分闭环`/`交付门未过` 的条目自带缺口清单，照单补课或重派。
4. **中断续跑**：任务被断后先 `khy resume list`，有检查点就 `khy resume <taskId>`，不要凭记忆重做。
5. **AI 助手维护守则**：改循环内任何门时——判定逻辑进纯叶子（照 taskClosure/goalStopGate 形状：零 IO、绝不抛、可单测）、接线处只做 IO 且整块 try/catch fail-soft、每门必须有独立预算、新终态必须入台账。

---

## 8. 已知边界与后续演进

- REPL 非 harness 路径（纯 chat 降级、harness 抛错回退）不写台账——已由循环内门序兜底诚实标注，台账覆盖待后续版本统一。
- 模型侧 Task 工具（TaskCreate/TaskUpdate）创建的计划与循环的 `_parseExecutionPlan` 解析尚未完全打通，计划步骤完成度以循环内解析为准。
- 外层 harness `retryWithBackoff` 仍被「本轮零工具调用」门槛限制（`toolCallLog.length===0`）——跑过工具的 timeout/network 结局不整体重跑，防副作用重复；该层补偿由 Branch R/C 的循环内分支承担。
- 指挥部仓库 khy-os-hq 未部署时，任务/Bug 状态真源离线，台账是本机唯一交付事实来源（详见根目录 `AGENTS.md` 双机流水线自举）。

## 9. 测试锚点

- `taskClosure.decideClosure.test.js` — 三态仲裁/预算/证据门（纯叶子契约）
- `toolFailureRecovery.test.js` — 多分支恢复梯子：瞬态分类/确定性码优先/负向守卫/只读白名单/预算/分支裁决
- `toolCallCorrection.test.js` — 工具名纠正阶梯：键归一/唯一编辑距离/歧义不猜/门控
- `cli/toolDisplayTier.render.test.js` — 输出区分级：tier 注册表/焦点说明行/printStepLine 强调/headless ▌ 前缀
- `cli/toolDisplayMatrix.test.js` — **显示矩阵完整性强制门**：注册表每个工具必有分类、每条家族必有说明文案
- `toolUseLoop.taskClosureGate.smoke.test.js` — 假 chat 驱动循环：redrive 注入 + close_partial 标注 + 有界终止
- `deliveryLedger.test.js` / `backgroundTaskManager.ledger.test.js` — 台账契约与终态咽喉集成
- `toolUseLoop.streamingExecGate.test.js` / `goalStopGate.test.js` — 相邻门既有契约
