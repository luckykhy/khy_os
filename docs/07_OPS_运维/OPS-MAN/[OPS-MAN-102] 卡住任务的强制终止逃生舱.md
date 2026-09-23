# [OPS-MAN-102] 卡住任务的强制终止逃生舱（busy 分支 Ctrl+C/Esc 三次升级结束会话）

> 直接回应用户诉求：「khy 总是会有时执行到一半卡住，但是任务转圈还在转，
> Ctrl+C 两次无法终止，Esc 无法打断，我需要 Ctrl+C 和 Esc 可以达到这样的效果。3 次，Ctrl+C 结束会话。」
> 本条为 REPL busy 分支加一个**强制结束会话的逃生舱**：前几次按键先走优雅取消（打断卡住的任务），
> 同一时间窗内**累计第 3 次** busy 中断 → 保存会话后 `process.exit(130)` 结束会话，
> 无论底层 adapter 是否兑现 abort 信号，只要事件循环还活着就能杀掉卡住的回合。

## 一句话

转圈动画还在转 = `setInterval` 还在跑 = 事件循环仍活 = JS 处理器仍执行。所以这**不是**
冻死的循环（`Atomics.wait`/`execSync` 会冻住一切、连转圈都停），而是**优雅取消没传导到位 +
busy 分支永不升级**。busy 分支的 Ctrl+C（`replSession.js` SIGINT 处理）与 Esc（busy 输入分支）
原本恒做「优雅取消 + `return`」并把 `_ctrlCCount` 归零，**永不升级**——所以一个 wedged 回合
（优雅取消落不了地）按几次都杀不掉。本条抽出纯叶 `busyInterruptEscalation.js` 判定「同窗口内累计第 3 次 busy 中断是否该强制结束会话」，`replSession` 在优雅取消**之前**先问它：该 force-exit 就
保存会话/历史 + 打印恢复提示 + `process.exit(130)`；否则（前两次按键或门关）照旧走优雅取消。

## 为什么需要它（真实缺口 = busy 分支无升级路径）

- **事件循环存活的证据**：用户明说「任务转圈还在转」。转圈是 `setInterval` 动画，它还在动
  说明事件循环没有被同步阻塞，SIGINT/Esc 的 JS 处理器**确实在跑**。
- **确定性缺陷**：busy 分支的 Ctrl+C（`replSession.js` SIGINT busy 分支）与 Esc（busy 输入
  分支 `~1955`）总是做优雅取消 `_requestRelayCancel(...)` 然后 `return`，并重置 `_ctrlCCount=0`；
  它们**从不升级**。于是若优雅取消没落地（底层 in-flight `chat()` 调用没吃到 abort），
  按几次都是同一条不升级的路径 → 永远杀不掉。
- **网关 abort 链本身是接好的**：`ai.js cancelActiveRequest` → 中止已注册 controller →
  `aiChatCore.js:530` 把 `abortSignal` 传给 `gw.generate()`。所以首次按键做优雅取消是**合理**的
  （多数情况能取消）；本条只补「优雅取消没生效」这条尾巴上的逃生舱，不改动正常取消路径。

## 怎么做的（外科式 + 门控 + 纯叶）

**纯叶** `services/backend/src/cli/repl/busyInterruptEscalation.js`（零 IO、绝不抛）：

- `busyForceExitEnabled(env)`：门 `KHY_BUSY_FORCE_EXIT`，default-on；CANON falsy
  `['0','false','off','no']`（大小写/空白归一）才关闭；敌意 env 绝不抛，异常兜底为**开启**。
- `resolveThreshold(env)`：`KHY_BUSY_FORCE_EXIT_PRESSES`，默认 3，clamp `[2,10]`，非法 → 3。
- `resolveWindowMs(env)`：`KHY_BUSY_FORCE_EXIT_WINDOW_MS`，默认 3000ms，clamp `[500,30000]`，非法 → 3000。
- `nextBusyInterruptState(prev, now, opts)`：纯状态推进。窗口外/首次 → `count=1`；窗口内递增；
  返回 `{count, lastTs, shouldForceExit: count >= threshold}`；任何异常兜底 `{count:1,lastTs:0,shouldForceExit:false}`。

**接线**（`replSession.js`，additive；此文件是已超限 god-file，只做加法、不新增违规）：

- `require` 纯叶；`_ctrlCCount` 附近加状态 `let _busyInterruptState = null;`。
- 新 helper `_maybeForceExitOnBusyInterrupt(sourceLabel)`：门关或未达阈值 → 返回 `false`（调用方照旧优雅取消）；
  达阈值 → 尽力 `_requestRelayCancel` + `saveConversation` + `saveHistory` + 打印恢复提示 →
  `_intentionalExit = true` → `process.exit(130)`。
- Esc busy 分支：`if (_maybeForceExitOnBusyInterrupt('Esc')) return;` 置于优雅取消之前。
- SIGINT busy 分支：`if (_maybeForceExitOnBusyInterrupt('Ctrl+C')) return;` 置于 `_ctrlCCount = 0;` 之前。
- `finally` 重置块加 `_busyInterruptState = null;`。

## 诚实边界

- 阈值默认 3 = 精确对齐用户原话「3 次，Ctrl+C 结束会话」；前两次先走优雅取消（尽量打断卡住的任务），
  第 3 次才强制结束会话。时间窗 + busy 守卫防误触：**若某次优雅取消成功**，
  `_busy` 转 false → 下一次按键走**非 busy** 路径，永不进本逃生舱。
- 只在 busy 分支生效；前两次按键永不 force-exit；门关 → 逐字节回退到原优雅取消行为。
- `exit(130)` = 标准 SIGINT 退出码。退出前尽力保存会话与历史（best-effort，各自 try/catch）。
- **未触碰** `toolUseLoopCore.js:2597`（in-flight `chat()` 不吃 abort 是更深的回归面）——
  逃生舱只要事件循环活着就够用，不需要改动那条更危险的路径。

## 验证

```
npm run test:busy-interrupt-escalation      # 纯叶 12/12
node --check services/backend/src/cli/repl/busyInterruptEscalation.js
node --check services/backend/src/cli/replSession.js
npm run arch:god                            # replSession 加行后无新增超限
```

