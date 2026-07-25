# [OPS-MAN-136] 首响应静默窗口守护 · 提交提示词到首个模型 token 之间及时回应（让 khy 在交互终端里不再「提交后一片死寂」）

> 本文件为手写维护文档（此层是运行时接线，无 `--gen-doc` 生成器）。承接 turn 级即时确认
> `turnAckVoice`（门 `KHY_TURN_ACK`）——那一层只在**首个工具即将派发**时出，本层补它够不到的
> 「首个模型 token 迟迟不来」这段静默窗口。
> 判定叶：`services/backend/src/cli/firstResponseAckVoice.js`（纯叶子 + DI 计时器调度器·绝不抛）。
> 接线：`services/backend/src/cli/replSession.js`（create/arm 于 `spinner.start('request')`、
> markChunk 于 onChunk 首 chunk、disarm 于 finally）。

## 这一层闭合什么：提交提示词 → 首个模型 token 之间是**静默窗口**

用户 `/goal`：「当我向 Khy 输入提示词时，khy 要及时回应」。

复盘交互路径发现一段**看不到任何动静**的窗口：

- 交互 raw-mode 终端里，动态 spinner 被 **render-suppress**（`spinner.js:122`
  `if (process.stdin.isRaw && blockInRawMode) return;`）——提交那刻起，屏幕上**不转圈、不打字**；
- 现有 `turnAckVoice` 的即时确认只在**本轮首个工具即将派发**时才出（`replSession.js` onChunk 的
  `tool_use` 分支），那已经是**模型跑起来、chunk 已经到**之后的事；
- 于是从**用户敲下回车**到**第一个模型 chunk 到达**之间，若模型 / 网络慢（首 token 就要等几秒），
  用户对着一个纹丝不动的终端，**无从判断 khy 是在思考还是卡死了**。

`grep`「提交 → 首 token 之间主动出声」的消费者 = 零。这正是本轮要补的断桥。

## 离机场景为什么也吃这一亏

这台云电脑过期，源码靠 pip / npm 还原到别人的机器上复活。别人第一次跑起 khy、敲下第一句提示词，
若首 token 慢，看到的就是一个死寂的终端——**第一印象就是「这工具卡死了」**。及时的一句
「收到，正在为你连接模型，请稍候…」是最廉价、最有效的信任建立。

## 这一层怎么做（全 additive · 门 default-on · DI 计时器可测 · 绝不卡死）

### 判定叶（纯叶子 + DI 计时器调度器·绝不抛）

`firstResponseAckVoice.js`：

- `isEnabled(env)` —— 门控 `KHY_FIRST_RESPONSE_ACK`（default-on；仅 CANON 4 词
  `{0,false,off,no}` 关）。flagRegistry 优先，本地 CANON 回退。
- `firstResponseAckDelayMs(env)` —— 静默窗口阈值（ms）。经 `flagRegistry.resolveNumeric` 读
  `KHY_FIRST_RESPONSE_ACK_MS`（numeric，默认 **1200**，clamp **[200,60000]**）；注册表不可用时
  本地读 env + clamp；畸形 → 默认 1200。
- `computeFirstResponseAck({ turnIndex, elapsedMs, env })` —— 纯函数产句：门控关 / 异常 → `''`；
  否则按 `turnIndex` 在 `_ACK_LINES`（5 条 wait-aware 短句）里轮换取一句，`elapsedMs ≥ 1000` 时
  附「（已等待约 Ns）」。绝不抛。
- `createFirstResponseAckScheduler({ turnIndex, env, deps })` —— **DI 计时器调度器**，把
  `setTimeout / clearTimeout / emit / now` 全经 `deps` 注入（缺省回退全局），使异步时序**可用假
  计时器单测**。返回句柄：
  - `arm()` —— 请求发出那刻调用。门控关 / 缺 `emit` / 缺 `setTimeout` / 已 arm / 已 done →
    **no-op 返回 false**（逐字节回退无提示）；否则挂计时器返回 true。计时器到点且**仍无 chunk**
    → 计算 elapsed、产句、`emit(line)`（每回合至多 emit 一次）。
  - `markChunk()` —— **首个 chunk 到达**（模型已开始响应）→ `clearTimeout` 取消未决提示。幂等。
  - `disarm()` —— 请求边界（finally）兜底取消。幂等。
  - `get fired` / `get armed` —— 供测试 / 接线观测。
  - 所有方法 `try/catch` 吞异常，**绝不抛**。

### 接线 `replSession.js`（外科·四处）

- **holder 声明**（`try` 之外、与 `finally` 同作用域）：`let _firstResponseAckScheduler = null;`
  —— 让 onChunk（markChunk）、arm 点、finally（disarm）三处都能看见同一句柄。
- **create + arm**：在 `spinner.start('request')` 之后创建调度器（那里 `renderer` /
  `_turnAckEmitted` / `_turnAckIndex` 均在作用域内），`emit` 回调 =
  `renderer.printStepDetail(line)` **并置 `_turnAckEmitted = true`**（已代码级回应用户 → 抑制后续
  turnAck，避免同回合两处叠话），随即 `arm()`。整体 try/catch fail-soft。
- **markChunk**：onChunk 顶部（TUI record 之后）——任何 chunk 到达 = 模型已开始响应 → 取消未决提示。
- **disarm**：finally 里 `spinner.stop()` 之后——无论正常完成 / abort / 错误,兜底取消未决计时器,
  杜绝「回合已结束,过期计时器仍打出一句 stale 等待提示」。

## 中途选项也要及时回应（selection 变体 · 门 `KHY_FIRST_RESPONSE_ACK_SELECTION`）

用户 `/goal` 的第二半句：「**包括中途的选项也要依据用户的选择及时回应**」。

同一段静默窗口在**中途选项**处会**再来一次**：当模型请求一个需要用户决策的工具时，
`replSession.js` 的 `handleControlRequest` 会弹出交互卡片——`AskUserQuestion` 选项、
L2（红线）确认、或权限 `Allow / Deny`。用户选完，决策回传给工具循环、**模型据此恢复流式**，
而恢复到「第一个恢复 chunk 到来」之间，又是一段 raw-mode spinner 被抑制的死寂窗口。
本回合最初那次「提交守护」早已被此前的 chunk `markChunk` 消费掉（`_done`），
覆盖不到这段恢复窗口。

这一层就补它：

- **判定叶**（同一个 `firstResponseAckVoice.js`，全 additive）新增 `variant: 'submit' | 'selection'`
  参数（缺省 `'submit'`，对既有调用方**逐字节等价**）。`variant: 'selection'` 走
  `_SELECTION_ACK_LINES`（措辞传达「收到了你的选择·正在据此继续」，**不复述用户选了什么**——
  那由 `qaEchoLines` 做静态回显），并额外过 selection 子门 `isSelectionEnabled`。
- **子门** `KHY_FIRST_RESPONSE_ACK_SELECTION`（default-on，父门 `KHY_FIRST_RESPONSE_ACK`）：
  父门关则整体关；子门单独 CANON 4 词 `{0,false,off,no}` 关 → 逐字节回退到「选择后无提示」。
- **接线**：`handleControlRequest` 的 `finally`（`spinner.start('request')` 之后，覆盖
  AskUserQuestion / L2 / 权限三条决策路径的**单一缝**）——先 `disarm` 任何残留句柄，再新建一个
  `variant: 'selection'` 调度器并 `arm`。首个恢复 chunk 到达即由 onChunk 顶部的 `markChunk` 取消；
  回合 `finally` 的 `disarm` 兜底。`emit` 同样置 `_turnAckEmitted = true`，与 turnAck 不叠话。

这是「无感·明显告知」的又一正交层：模型恢复快 → 永远不出这句；恢复慢 → 用户看到
「收到你的选择，正在据此继续…」，知道自己的选择已被 khy 接住、正在推进。

## 工具迭代之间也要及时回应（resume 变体 · 门 `KHY_FIRST_RESPONSE_ACK_RESUME`）

用户 `/goal`「khy 要及时回应，不论我发送任何的提示词……立刻及时回应」的**处理全程**面：
一条提示词往往触发一整轮 agentic 工具循环（读文件、跑命令、再读、再改……）。主模型调用是
**单次** `ai().chat(message, { onChunk })`，其「自然工具循环」把所有迭代都通过**同一个 onChunk**
流式回来——于是 `spinner.start('request')` 处那次「提交守护」**一回合只 arm 一次**、被本回合
**首个 chunk** `markChunk` 消费掉（`_done`），`turnAckVoice` 也**一回合至多一次**（`_turnAckEmitted`）。

结果：在**第 2、3、…N 次工具迭代**里，「一个工具刚返回 → 模型据此续跑出下一个 chunk」之间，
若模型迟迟不开口（交互 raw-mode 下 spinner 被 render-suppress），**又是一段像卡死的死寂**——
这正是真实 agentic 工作里 khy 最常「看起来卡死」的窗口，也直接对应送别礼的第三诉求
「让它不要再次……长时间卡死」。

这一层就补它：

- **判定叶**（同一个 `firstResponseAckVoice.js`，全 additive）新增 `variant: 'resume'`，走
  `_RESUME_ACK_LINES`（措辞传达「工具已收到结果·正在继续处理」，**不复述工具结果内容**——
  那已由 step 行渲染），并额外过 resume 子门 `isResumeEnabled`。
- **子门** `KHY_FIRST_RESPONSE_ACK_RESUME`（default-on，父门 `KHY_FIRST_RESPONSE_ACK`）：
  父门关则整体关；子门单独 CANON 4 词 `{0,false,off,no}` 关 → 逐字节回退到「工具返回后无提示」。
- **接线**：`replSession.js` 的 onChunk 里定义一个 hoisted 辅助 `_rearmResumeAck()`——先 `disarm`
  任何残留句柄，再新建一个 `variant: 'resume'` 调度器并 `arm`。在**每个「工具已收尾」信号处**
  调用它：`tool_result` 分支末、`tool_complete` 分支末。下一个 chunk 到达即由 onChunk 顶部的
  `markChunk` 取消；回合 `finally` 的 `disarm` 兜底。

**为什么在多个工具收尾信号处都重装**：`markChunk` 在 onChunk 顶部对**任何** chunk 生效（提交守护
本就该被首 chunk 取消）。若只在 `tool_result` 重装，紧随其后的 `tool_complete`（同一工具的富完成）
会在其顶部 `markChunk` 把刚装的 resume 守护取消掉，之后的静默便再次失守。于是在**每个工具收尾
chunk** 处都重装：模型输出类 chunk（`text` / `thinking` / `assistant_preface` / `tool_use`）**不重装**，
故模型一开口即被取消且不再复活——「最后一个工具收尾 → 模型下一 chunk」这段窗口稳稳被守住。
快循环（工具秒回、模型秒续）永远等不到阈值，一句都不出；只有真正 >阈值 的慢续跑才出声。

正交四层：`turnAck`（首工具·模型已开口）· submit（提交→首 token·模型没开口）· selection（中途
选项已选→模型恢复）· **resume（工具返回→模型续跑·工具循环迭代之间）**。同一回合可出多句 resume
（每段真·慢间隔一句），互为「仍在为你处理」的定期安抚，绝不在快循环里刷屏。

## 图片提示词也要及时回应（image 变体 · 门 `KHY_FIRST_RESPONSE_ACK_IMAGE`）

用户 `/goal`「**不论我发送任何的提示词**，khy 都要立刻及时回应」的**图片分析**面：当用户发出
一条图片提示词（`/paste`、`图片识别`、`分析这张图 <path>`、剪贴板自动识别），处理路径**不是**
主回合那次流式 `ai().chat(message, { onChunk })`，而是一条**独立的非流式**
`await ai().chat(prompt, { images })` 子流——**没有 `onChunk` 流、没有 `markChunk`**，
只有一个长 `await`，期间终端**全程静默**。

这段静默恰恰最长、最像卡死：视觉级联（vision 模型 → OCR 兜底）是全链路最耗时的一环；更糟的是
模型偶尔会谎称「没有收到图片」。一句**先确认「图片确已收到」再告知「正在识别」**的短句，
既补住这段窗口，又即时反驳那种假阴性——用户第一时间就知道「khy 拿到我的图了，正在看」。

这一层就补它：

- **判定叶**（同一个 `firstResponseAckVoice.js`，全 additive）新增 `variant: 'image'`，走
  `_IMAGE_ACK_LINES`（措辞刻意**先确认图片已收到**、再传达「正在识别·别急」，**不复述用户
  提示词原话**），并额外过 image 子门 `isImageEnabled`。
- **子门** `KHY_FIRST_RESPONSE_ACK_IMAGE`（default-on，父门 `KHY_FIRST_RESPONSE_ACK`）：
  父门关则整体关；子门单独 CANON 4 词 `{0,false,off,no}` 关 → 逐字节回退到「图片分析无提示」。
- **接线**：`replSession.js` 里定义一个**自包含**的 hoisted 辅助 `_armImageAck()`（内部
  lazy-require `aiRenderer`、用 `_replTurnAckSeq++` 轮换、创建 `variant: 'image'` 调度器并 `arm`，
  返回句柄；门控关 / 叶缺失 / 异常 → 返回 `null`）。在**三处**非流式图片 `ai().chat({images})`
  子流的 `await` **之前** `_imgAck = _armImageAck()`、在其 `await` 完成 / 异常的收尾处 `disarm`：
  - 剪贴板图片自动识别子流（`_onceImagePrompt`）；
  - `/paste` 菜单选择子流（`selected.flag === 'paste'`，无 finally → 成功、catch 两处各 disarm）；
  - 主图片命令子流（`imageMatch || pasteMatch || inlineImage || clipboardAssist`，有
    `finally { _busy = false; }` → 在 finally 里 disarm）。

**为什么 image 变体没有 `markChunk`**：这三条子流是**非流式**的单次 `await`，不存在「首个
chunk」这个取消信号。于是 `disarm`（在 `await` 完成 / 异常兜底处调用）就是**唯一**的取消路径——
答复在阈值内落地 → `disarm` 取消，一句不出；只有 `await` 真的拖过阈值（视觉级联慢）才 emit。
`holder`（`let _imgAck = null;`）**必须声明在 `try` 之前**，让 `finally` / `catch` 都能看见它
（block-scoped `let` 声明在 `try` 体内则 `finally` 不可见 → ReferenceError）。
image emit **不置** `_turnAckEmitted`——图片子流不走主回合的流式 tool loop，turnAck 不会触发，
无叠话风险。

正交五层：`turnAck`（首工具·模型已开口）· submit（提交→首 token）· selection（中途选项已选→
模型恢复）· resume（工具返回→模型续跑）· **image（图片提示词→非流式 `ai().chat` 完整答复落地）**。

## 和 turnAckVoice 的分工（正交，不重叠）

| 层 | 触发时机 | 面向的窗口 |
|---|---|---|
| `firstResponseAckVoice`（OPS-135，本层） | 请求发出后、**首个模型 chunk 到来之前** | 提交 → 首 token 的静默窗口（模型还没开口） |
| `turnAckVoice`（`KHY_TURN_ACK`） | 本轮**首个工具即将派发**时 | 模型已开口、要跑工具的耗时轮次 |

接线方在本层 emit 时置 `_turnAckEmitted = true`，两者**同回合至多出一句**，不叠话。

## 恒久红线

- **只加不改**：门 `KHY_FIRST_RESPONSE_ACK` default-on，关 → `arm()` no-op、逐字节回退到「无提示」
  的历史行为（连计时器都不挂，无开销）。
- **绝不卡死、绝不误伤**：调度器纯计时器 + fail-soft，任何异常吞成 no-op；`emit` 回调抛错也不影响
  主流程；首个 chunk 一到即取消，正常快响应的回合**永远不会出这句**。
- **不碰密钥 / 不碰用户输入内容**：只产固定短句（按 turnIndex 轮换），不复述用户原话、不读任何文件。
- **确定性**：无随机（按 turnIndex 轮换）；异步时序经 DI 计时器，单测用假计时器完全可控。

## 验证

```
node --check services/backend/src/cli/firstResponseAckVoice.js
node --check services/backend/src/cli/replSession.js
node --check services/backend/src/services/flagRegistry.js
npm run test:first-response-ack                # 纯叶 + DI 假计时器 68/68 全绿
npm run test:maintainer:safety                 # 聚合无回归
node scripts/check-flag-registry.js            # KHY_FIRST_RESPONSE_ACK(+_MS numeric / _SELECTION / _RESUME / _IMAGE 子门) 登记
```

**LIVE 真计时器证据**（用真实 `setTimeout` / `clearTimeout`，不用假计时器）：

- A 静默超过 delay（`KHY_FIRST_RESPONSE_ACK_MS=250`，真等 450ms，无 chunk）→ `emit` 真的触发，
  打出「收到，正在为你连接模型，请稍候…」。
- B 首 chunk 快速到达（60ms 内 `markChunk()`）→ `clearTimeout` 真的取消 → 再等 450ms `emit` 从不触发。
- C 门 `KHY_FIRST_RESPONSE_ACK=0` → `arm()` 返回 false、计时器从不挂、`emit` 从不触发（字节等价）。
- D `disarm()`（finally 兜底）在 fire 前调用 → `emit` 从不触发。

## HOW-TO-EXTEND（抄写式）

改静默窗口默认阈值 → 改 flagRegistry 的 `KHY_FIRST_RESPONSE_ACK_MS.default`（并同步叶内
`_DEFAULT_DELAY_MS`）。加 / 改等待短句 → 改 `_ACK_LINES`（保持 ≥2 条且互异，治相邻回合重复）。
接线新的「首响应窗口」消费者（如 TUI 侧）→ 复用同一个 `createFirstResponseAckScheduler`，注入该端的
`emit` 渲染回调即可，判定逻辑一处不动。**切勿**把 `emit` 放进热路径每 chunk 调用——它只由计时器
在「静默到点」时触发一次。
