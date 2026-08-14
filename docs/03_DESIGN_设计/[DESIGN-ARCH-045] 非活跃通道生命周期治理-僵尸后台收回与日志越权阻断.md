# [DESIGN-ARCH-045] 非活跃通道生命周期治理 — 僵尸后台收回与日志越权阻断

状态：已实现（[EvoRequirement]「非活跃通道后台僵尸行为与日志越权」闭环）
依赖前序：[DESIGN-ARCH-006] 网关适配器协议 · [DESIGN-ARCH-031] 网关日志租界隔离
实现位置：`services/backend/src/services/gateway/aiGateway.js`（网关基石） · `services/backend/src/services/gateway/adapters/kiroAdapter.js`（通道局部） · `services/backend/src/cli/ai.js`（CLI 切换入口） · `services/backend/src/services/aiManagementServer.js`（web/daemon 切换入口）
验收测试：`services/backend/tests/services/gateway/channelLifecycle.test.js`（8 例） · `services/backend/tests/services/gateway/channelLogGating.test.js`（3 例） · `services/backend/tests/aiManagementServer.webChannelSwitchReconcile.test.js`（4 例）

---

## 1. 问题：通道切换只是「路由指派」，旧通道不死

用户已切到 API 直连通道，功能上确实走直连。但被弃用的 Kiro 通道仍在后台：

- **僵尸后台任务**：网关每 5 分钟的后台模型刷新 `_refreshModelsBackground` 仍对每个适配器
  调 `listModels()`，Kiro 的 `listModels` → `getAccessToken({autoOpenLogin:true})` →
  `maybeOpenKiroLogin`，触发 Token 刷新网络请求，甚至弹出 IDE 登录。
- **日志越权**：Kiro 内部的 Token 失效以 `[kiroAdapter] Kiro login required` 等 WARN 级别
  直接打到 UI 主控台，误导用户对当前系统状态的判断。

根因：切换机制只改路由偏好（`GATEWAY_PREFERRED_ADAPTER`），未对旧通道执行**状态降级**或
**资源收回**；日志输出缺乏**通道上下文感知**，非活跃通道的异常越权冒泡到 UI。

## 2. 设计：生命周期钩子 + 双层「弃用」语义

### 2.1 网关基石 — 通道生命周期感知（`aiGateway.js`）

- `_resolveActiveChannelKey()`：从 `GATEWAY_PREFERRED_ADAPTER` 解析当前活跃通道键。
  - `auto` / 空 → `null`（**无任何通道被弃用**，每个通道照常工作）。
  - 具体 key（大小写归一到注册键，`localllm`→`localLLM`）→ 该通道活跃，其余皆弃用。
  - 未注册的偏好 → `null`（绝不把某个真实通道误判成弃用）。
- `_syncChannelLifecycle()`：把「活跃/弃用」状态用**鸭子类型** `setChannelActive(active)` 下推到
  每个声明了该钩子的适配器；无钩子者安全跳过（非侵入），钩子抛错被吞（fail-safe，绝不影响路由）。
- `_refreshModelsBackground()`：刷新前先 `_syncChannelLifecycle()`，再 `if (activeKey && entry.key !== activeKey) return;`
  ——显式选定下，**弃用通道的后台网络工作被完全跳过**（僵尸任务收回）。auto 模式 `activeKey===null`，
  条件恒假，所有通道照常刷新（不误杀）。
- `setActiveChannel(key)`：公开切换入口，写偏好并**立即**对齐生命周期（弃用通道当即静默，
  不等下一个后台 tick）。`init()` 末尾与 `refreshAdapters()` 末尾各调一次 `_syncChannelLifecycle()` 兜底。

### 2.2 通道局部 — Kiro 自我降级（`kiroAdapter.js`）

- 模块级 `_channelActive`（默认 `true`），由网关经 `setChannelActive` 驱动。激活→恢复 token 文件
  watcher；弃用→停 watcher（释放 `fs.watch` 句柄）。幂等。
- `_isDeprecatedChannel()`：**显式弃用**判定——`_channelActive===false`，**或** `GATEWAY_PREFERRED_ADAPTER`
  指向另一真实通道（非 `kiro`/`auto`）。**auto 模式永不算弃用**。
- `_emitChannelWarn(text)`：弃用通道的内部异常（Token 刷新失败 / login required）降级到
  `debugLog`，**绝不**上 UI 主控台；活跃通道与 auto 模式保留原有 WARN 可见性。
- `maybeOpenKiroLogin`：在显式弃用通道下提前返回，**绝不**拉起 IDE/浏览器（副作用在源头封堵，
  不只是日志层）。

### 2.3 切换入口（`cli/ai.js`）

`/gateway` 切换在设 `GATEWAY_PREFERRED_ADAPTER` 后调 `gw.setActiveChannel(s.type)`，使切换瞬间生效。

### 2.4 web/daemon 切换入口（`aiManagementServer.js`，复盘补强）

**复盘发现**：CLI 路径（§2.3）切换后立即对齐，但 **web/daemon 配置保存路径** 不然。两个 web 端点
（`handleUpdateConfig` 与 `handleAiGatewayConfigPut`）都收敛到 `applyGatewayConfigPatch`，它原先**只把
`GATEWAY_PREFERRED_ADAPTER` 写进 `.env`**，从不触发 `_syncChannelLifecycle`。于是经 web/管理面切换通道后，
被弃用通道（如 kiro）的 token 文件 watcher 仍活、`Kiro login required` 仍越权冒泡——直到下一次 30s 后台
tick 才被收回。这段窗口正是症状的 web 复现路径。

**修复**：`applyGatewayConfigPatch` 在原子写入 `.env` 后，若本次补丁触及 `preferredAdapter`，立即
`getGateway().setActiveChannel(process.env.GATEWAY_PREFERRED_ADAPTER || '')`，与 CLI 路径同样**瞬间对齐**，
不等后台 tick。空串 → auto 模式 → 全通道恢复活跃（不误杀，honor 硬约束）。整段包在 `try/catch` 中——
生命周期对齐是 best-effort，**绝不因对齐失败而破坏配置落盘**。

## 3. 硬性约束的工程化保证

> 绝对不能因为修复此问题，导致**活跃通道**的必要后台任务或关键错误日志被误杀。

两条铁律落到代码与测试：

1. **auto 模式 ≠ 弃用**。网关 `activeKey===null` 时不跳过任何通道；适配器 `_isDeprecatedChannel()`
   在 auto 模式恒 `false`。`channelLogGating.test.js` 的「auto 模式 deliberate login 照常拉起」用例
   守护这条——它正是历史 `kiroAdapter.autoLogin` 契约的复刻（早期把「空闲」误当「弃用」会回归此契约）。
2. **活跃通道从不被跳过/静默**。`if (activeKey && entry.key !== activeKey)` 永不命中活跃键；
   活跃通道的 `_emitChannelWarn` 走 `console.warn`。`channelLogGating.test.js` 的活跃用例断言
   活跃通道照常报 `login required` 且照常拉起登录。

## 4. 关键设计抉择：「弃用」必须是显式信号，不是「最近未用」

早期实现用 `_isActiveChannel()`（含 `_kiroRecentlyActive()` 空闲启发式）做门控，导致 auto 模式
冷启动下 `getAccessToken({autoOpenLogin:true})` 被误挡——把「空闲」当成「弃用」，违反既有 autoLogin
契约。最终改为 `_isDeprecatedChannel()`：弃用 ⇔ 网关显式下推 deactivation **或** 用户显式切到别的通道。
auto/空闲一律保留原行为。网关 `_resolveActiveChannelKey` 与适配器 `_isDeprecatedChannel` 两层语义对齐：
`auto/空 → 不弃用任何通道`。

## 5. 验收

- `channelLifecycle.test.js`（8 例）：键解析归一/auto→null/弃用收 false 活跃收 true/无钩子跳过/钩子抛错 fail-safe/
  `setActiveChannel` 即时对齐/`setChannelActive` 幂等。
- `channelLogGating.test.js`（3 例，症状级，零真实网络/IDE）：弃用通道 `getAccessToken` 仍如实抛
  `No Kiro token` 但**零 WARN、零 IDE 拉起**；活跃通道与 auto 模式照常报 WARN 且照常拉起登录。
- `webChannelSwitchReconcile.test.js`（4 例，web 路径补强，stub `setActiveChannel` + 隔离 `.env`）：
  web 切换 `preferredAdapter` → 立即对齐（不等后台 tick）/ 清空 → 以空串调用回到 auto 全活跃 /
  与通道无关的配置变更不触碰生命周期 / `setActiveChannel` 抛错不影响配置落盘（fail-safe，硬约束）。
- 邻近回归：`gatewayLogLease.test.js`（22 例）零回归；三模块（kiroAdapter / aiGateway / cli/ai）冒烟加载干净。

## 6. 非目标（刻意不动，honor 硬约束）

- 不接管全局 console-patch 式的 `gatewayLogLease`（env 门控、风险面大）——本次只做外科手术式的
  适配器局部 + 网关改动。
- 不动 codex 心跳、trae `_refreshInterval` 等其它适配器的独立定时器——它们与本症状无关，
  贸然收回有误杀活跃通道后台任务的风险。后续如需，应各自实现 `setChannelActive` 钩子并独立验收。
