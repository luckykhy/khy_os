# GitHub 调研 — 终端渲染 / TUI / ANSI 规范板块 — 2026-09-17

> 每日板块轮转调研（索引 8/12）：khy-os 终端渲染板块（`services/backend/src/cli/tui/`，基于 ink 6.8.0 + React.createElement 桥接）对标 GitHub 开源终端 UI / 渲染框架，寻找可借鉴点。

## 调研对象

khy-os 终端渲染板块现状（`services/backend/src/cli/tui/`）：

| 组件 | 位置 | 机制 |
|---|---|---|
| ink 运行时桥接 | `inkRuntime.js` | 动态 `import('ink')`（ESM-only → CJS 单例缓存）+ `.jsx` 即 CommonJS 的 require 处理；内部 `instances.js` WeakMap 直连 |
| 备用缓冲区纪律 | `app.js` + `chromeBudget.js` | 1049h/1049l 进出、`frame ≤ rows-1` 硬约束（conpty pending-wrap -1 行）、单一定义 chrome 账本 |
| 回滚保留 | `scrollbackPreserve.js` | 4 层 stdout Proxy：剥 `3J`、win32 `ED2→H+J`、抑制 static 重发、活区尾切 rows-1 |
| 视口贴底 | `ink-components/Viewport.js` | `null` 贴底哨兵 + `resolveViewportOffset`/`applyStickyViewportAction` 纯叶子 |
| 滚轮接管 | `mouseButtons.js` | 备用缓冲区下强制接管滚轮（否则被合成为 ↑/↓ → 误触输入历史） |
| 节拍调优 | `perfTunables.js` | spinner/heartbeat/topicBar 节拍纯函数 + `INK_THROTTLE_MS=34` 镜像 |

**短板（5 条）**：

1. **16ms 帧预算未接入渲染主循环**：`AGENTS.md §0.3` 白纸黑字写了「单次渲染 <16ms」「冷启动 <100ms」，但渲染路径里**没有任何实测帧计时守卫**——ink 6.8.0 自带 `options.onRender?.({ renderTime })`（`ink.js:252` 已确认）却没被利用，超帧只是性能测试里偶发断言，没有滚动 p95 窗口 + 棘轮基线。
2. **缺 TUI 健康记分卡**：帧高 vs 账本、fps 窗口、内存趋势、备用缓冲区开关、回滚救援是否生效——散在 `KHY_TUI_DIAG_H` / `KHY_TUI_DIAG` 两个诊断开关里，没有一条只读命令能一次性读出。
3. **ink 内部实例解析失败时静默降级**：`inkRuntime.getInkInstance()` 靠直连 `instances.js` WeakMap（`_renderStdout` Proxy 作 key），内部布局一变就返回 `null`，调用方**默默退回** ink 内建 resize 行为（残线不修），无任何告警。
4. **无金帧/视觉回归测试**：现有 `viewportSticky` / `mouseWheel` 都是逻辑单测，没有「对渲染出的 ANSI 帧做快照 + 归一化 diff」的护栏。
5. **内存泄漏只有清单没有检测器**：AGENTS.md 列了「定时器/监听器必须清理」，但无自动化 weak-ref sweep / active-resources diff 守卫。

## 对标项目

| 项目 | Star（2026-09-17） | 技术栈 | 相关度 | 链接 |
|---|---|---|---|---|
| ink | ~39.9k | TS/React | 高：就是底座；`onRender({renderTime})`/`maxFps` 是现成集成面 | https://github.com/vadimdemedes/ink |
| bubbletea | ~45.0k | Go / Elm | 高：帧率上限 + 渲染/逻辑解耦 + 健康态显式降级（非静默） | https://github.com/charmbracelet/bubbletea |
| blessed-contrib | ~15.8k | JS | 中：Table 强制 columnWidth 前置校验 = chrome 账本该学的 fail-fast | https://github.com/yaronn/blessed-contrib |
| terminal-kit | ~3.4k | JS | 低：stream/TTY 分层参照，印证 scrollbackPreserve 单一 stdout 收口 | https://github.com/cronvel/terminal-kit |
| ink `test/helpers` (node-pty + reconstruct-terminal) | — | 随 ink | 高：金帧范式可直接搬 | https://github.com/vadimdemedes/ink/tree/main/test/helpers |

## 值得借鉴的点

### 1. 帧预算守卫接入 ink `onRender({renderTime})`（P0）

**对方怎么做**：ink `src/ink.tsx` 暴露 `options.onRender?: (metrics:{renderTime}) => void`（本机 6.8.0 `ink.js:252` 已确认 `this.options.onRender?.({ renderTime: performance.now() - startTime })`），`maxFps` 经 es-toolkit throttle 限流。bubbletea 把 FPS 上限当**渲染器级不变量**而非测试（`tea.go:1403` framerate ticker），超预算 = 告警而非「文档写了的地板」。

**khy-os 现状差在哪**：`app.js` 的 `render(...)` 没传 `onRender`；16ms 只是 AGENTS.md 纸面约束，渲染路径无实测。

**改哪些文件**：`app.js`（`render` 增 `onRender` 回调 → 滚动窗口 p95）+ 新增 `tui/frameBudget.js`（纯叶子：窗口 p50/p95/p99 + 超帧告警 + 棘轮基线读取）。

### 2. 内部实例解析失败的显式告警（P0）

**对方怎么做**：bubbletea `cursed_renderer.go`/`nil_renderer.go` —— 标准渲染器建不出来时用**具名降级实现** + 显式日志，绝不静默改行为；ink `instances.ts` 的 WeakMap 按 stream 作 key 是**稳定契约**而非易碎内部。

**khy-os 现状差在哪**：`inkRuntime.getInkInstance()` 返回 `null`（内部布局变化）时，`app.js` 的 resize 全重绘修复**静默失效**，残线回归无任何信号。

**改哪些文件**：`inkRuntime.js`（`getInkInstance` 加一次性降级告警 + 健康标志位），`app.js`（resize 分支据告警改走 SIGWINCH 兜底并打点）。

### 3. TUI 健康记分卡：一条只读命令聚合（P0/P1）

**对方怎么做**：bubbletea 把状态 `push` 进 model（`WithWindowSize`/ColorProfileMsg）且**只写 stderr/文件**（stdout 归 TUI 独占）；ink 的 `onRender` tick 天然可作记分卡心跳。

**khy-os 现状差在哪**：帧高/账本、fps、内存、备用缓冲区/回滚救援状态散在两个 DIAG 开关，无统一读视图。

**改哪些文件**：新增 `tui/healthScorecard.js`（纯叶子：聚合 `chromeBudget` 账本 + `frameBudget` 窗口 + 进程内存 + 安全网激活态，输出表格 / `--json`，默认写 stderr 不碰受管 stdout）+ 一个 `khy tui health` 入口（**不新增顶层目录/npm run 入口**，走既有 CLI router 或脚本目录）。

### 4. 金帧/ANSI 快照回归（P1）

**对方怎么做**：ink `test/helpers/reconstruct-terminal.ts` + node-pty，replay 只有 ink 真发的 CSI 序列还原**可见屏**（scrollback + viewport），对金帧归一化 diff；`atago`/`tuitest` 同款范式。

**khy-os 现状差在哪**：只有逻辑单测，无渲染输出快照护栏。

**改哪些文件**：新增 `tui/goldenFrames.js`（frame 归一化 + 快照 diff），CI 跑 `--leak-check`/golden 作业（P1 留后续）。

### 5. 内存泄漏 CI 检测器（P1）

**对方怎么做**：`@sinonjs/fake-timers` + `WeakRef` sweep + `process.getActiveResourcesInfo()` diff。

**khy-os 现状差在哪**：内存 <50MB 只是文档清单，无自动检测。

**改哪些文件**：新增 `tui/leakGuard.js`（P1 留后续）。

## 落地建议（排序）

| # | 行动 | 优先级 | 工作量 |
|---|---|---|---|
| 1 | 帧预算守卫：`app.js` 传 `onRender({renderTime})` → 新增 `tui/frameBudget.js` 纯叶子（滚动 p95 + 超帧告警 + 棘轮基线） | P0 | 半天 |
| 2 | 内部实例解析失败显式告警：`inkRuntime.getInkInstance` 加一次性降级告警 + 健康标志 | P0 | 1 小时 |
| 3 | TUI 健康记分卡：新增 `tui/healthScorecard.js`（聚合账本+帧窗口+内存+安全网，表格/--json，写 stderr） | P1（P0 不足 3 条补位） | 半天 |
| 4 | 金帧/ANSI 快照回归 `goldenFrames.js` | P1 | 1 天 |
| 5 | 内存泄漏检测器 `leakGuard.js` | P1 | 半天 |

## 参考链接

- https://github.com/vadimdemedes/ink — `src/ink.tsx` `onRender({renderTime})` + `maxFps`、`test/helpers/reconstruct-terminal.ts`、`src/instances.ts`
- https://github.com/charmbracelet/bubbletea — `tea.go` framerate ticker、`options.go WithFPS`、`cursed_renderer.go`/`nil_renderer.go` 显式降级
- https://github.com/yaronn/blessed-contrib — `lib/widget/table.js` 前置列宽校验
- https://github.com/cronvel/terminal-kit — stream/TTY 分层
- https://github.com/nao1215/atago / https://github.com/Gaurav-Gosain/tuitest — PTY 金帧 + 确定性等待范式

## 落地记录

> 本轮落地 3 项（P0×2 + P0 补位×1）；第 4、5 项（P1）留后续。
> 全程遵守工程红线：零硬编码、纯叶子零 IO、stderr-only（stdout 归 TUI 独占）、无固定硬超时、无滚动区转义。

### P0-1 帧预算守卫（已实现）

- 新增 `services/backend/src/cli/tui/frameBudget.js`（纯叶子，零 IO，`createGuard` 滚动窗口 p50/p95/p99/max + 一次性超帧告警 `maybeWarn` + `reset`）。
- `perfTunables.js` 增 `frameBudgetMs`（SSOT，默认 16ms，env `KHY_TUI_FRAME_BUDGET_MS` 可覆盖）——补上「16ms 地板」单一真源。
- `app.js`：`render(...)` 增 `onRender: (m) => frameGuard.record(m?.renderTime ?? 0)`，接入 ink 6.8.0 现成的 `onRender({renderTime})`（`ink.js:252`）；守卫门控 `KHY_TUI_FRAME_BUDGET`（默认开）。
- 新增测试 `services/backend/tests/cli/tui/frameBudget.test.js`（8 条，`node --test` 全绿）。

### P0-2 内部实例解析失败显式告警（已实现）

- `inkRuntime.js`：`getInkInstance()` 内部 WeakMap 解析失败时不再静默降级——置位 `_instanceLookupDegraded` 并发一次性 stderr 告警（门控 `KHY_TUI_INSTANCE_WARN`，默认开），并导出 `isInstanceLookupDegraded()` 供记分卡 / 测试读取。

### P0-3 TUI 健康记分卡（已实现，P0 补位）

- 新增 `services/backend/src/cli/tui/healthScorecard.js`（纯叶子，只读）：聚合 `chromeBudget` 账本（H1 不变式）+ `frameBudget` 窗口 + `inkRuntime` 实例解析态 + 各安全网 env 激活态 + 进程内存快照；`renderTable()`（stderr-ready 字符串）/ `toJSON()`（机器读）两个出口，本模块自身**绝不写 stdout**。
- CLI 入口（`khy tui health`）留后续，走既有 router，不新增 npm run 入口。

### 校验结果

| 检查 | 结果 |
|---|---|
| `node --test services/backend/tests/cli/tui/frameBudget.test.js` | 8/8 通过 |
| `node scripts/run-ink-tui-tests.js` | 29/29 套件、435 条测试通过 |
| `node scripts/ci/check-agent-rules.js`（改动 5 源文件 + 1 测试） | 零违规（零硬编码 / 无含糊状态 / 无固定硬超时 / 无滚动区 / 无死循环） |

### 未实现项（P1，留后续）

| 项 | 说明 | 阻塞点 |
|---|---|---|
| 金帧 / ANSI 快照回归 `goldenFrames.js` | 需 node-pty + reconstruct-terminal，引入 PTY 依赖与 CI golden 作业 | P1，半天–1 天 |
| 内存泄漏 CI 检测器 `leakGuard.js` | `WeakRef` sweep + `getActiveResourcesInfo` diff，需挂 CI `--leak-check` | P1，半天 |
| `khy tui health` CLI 入口 | 走既有 router，不新增 npm run 入口 | 依赖 P0-3 接线 |
