<!-- 文档分类: IMPL-RPT-008 | 阶段: 实现 | 原路径: docs/修复记录/修复-桥接状态刷屏.md -->
# Bugfix: Claude 中转桥接状态刷屏

> ⚠️ **已归档 / 被取代**：本修复落在自研 REPL 运行时 `liteRepl.js` 上，该文件已于 2026-06-05 随 TUI 迁移官方 Ink 运行时（`backend/src/cli/tui/ink-components/`）一并删除。本文仅作历史修复记录保留，最新 TUI 行为请参阅 [tui-inquirer闪退修复-2026-06-05.md](%5BIMPL-RPT-003%5D%20tui-inquirer闪退修复-2026-06-05.md)。

**日期**: 2026-06-03
**影响范围**: 交互式 REPL (`khy` 命令)
**严重程度**: P1 — 终端输出完全被淹没，无法正常使用

## 现象

在交互模式下发送任何消息（如 `你好`），终端被 `中转桥接：通过 Claude CLI 子进程启动... (0s)` 反复刷屏，时间戳递增 (0s → 1s → 2s)，持续到请求结束。

## 根因

`claudeAdapter.js` 在启动 Claude CLI 子进程时发射了一个 `onChunk({ type: 'status', text: '🔗 中转桥接：...' })` 状态块。虽然该状态只发射一次，但在交互式 REPL 中触发了 **spinner / keepalive / prompt 重绘** 的连锁反应：

```
claudeAdapter 发射 status chunk (1次)
    ↓
repl.js onChunk handler
    ↓
emitRuntimeStatus → _writeTransientStatus
    ↓ 调用 spinner.stop() + process.stdout.write('\r\x1b[K...')
    ↓ 状态行写入当前终端行（无换行）
    ↓
500ms busy prompt keepalive 定时器触发
    ↓ showBusyInterjectPrompt() → 清除当前行 + console.log(hint) + prompt
    ↓ 状态行被推到新行（变成永久输出）
    ↓
spinner.start('request') 被某处重新调用
    ↓ spinner 以 120ms 间隔渲染 "Thinking... (Ns)"
    ↓ 但 spinner._phase 或显示路径以某种方式包含了桥接文本
    ↓
每 120ms 产生一行新的 "中转桥接... (Ns)" → 刷屏
```

核心矛盾：**REPL 的 busy prompt keepalive (500ms) 和 DynamicSpinner (120ms) 两个独立定时器争抢同一个终端行**。任何 `\r\x1b[K` 原地覆盖策略都会被另一个定时器的 `console.log` / `process.stdout.write` 打断，导致状态行被推到新行。

## 尝试过但失败的方案（5 次）

| # | 方案 | 失败原因 |
|---|------|----------|
| 1 | 行计数 `_transientTotalRows` + 光标上移 | patched `console.log` 触发 `showBusyInterjectPrompt`，行数不可预测 |
| 2 | `_busyStreaming = true` 抑制 console.log patch | spinner 本身就是刷屏源，不经过 console.log |
| 3 | `_writeTransientStatus` 纯 `\r\x1b[K` 原地写入 | keepalive 500ms 后覆盖状态行，spinner 重启 |
| 4 | `_transientStatusActive` 标志位阻止 keepalive/prompt | 标志位工作正常，但 spinner 通过未知路径仍在渲染桥接文本 |
| 5 | `emitRuntimeStatus` 入口过滤 + 只显示一次 | 同上，渲染管道中某处仍将文本喂给 spinner |

**关键教训**: 5 次方案全部试图在渲染管道中修复，但 REPL 的渲染管道有 3+ 个并发定时器（spinner 120ms、keepalive 500ms、adapter pulse 4s）共享同一个 stdout 行，竞态条件难以在非 TTY 测试中复现。`-p` 模式不触发 busy prompt keepalive，因此无法复现。

## 最终修复

**从源头消除** — 在 `claudeAdapter.js` 中删除桥接状态块的发射。

```js
// Before (claudeAdapter.js:812-819)
try {
  onChunk({
    type: 'status',
    text: '🔗 中转桥接：通过 Claude CLI 子进程启动...',
  });
} catch { /* best effort */ }

// After — 完全移除，替换为注释
// Bridge handshake status suppressed — the adapter pulse
// ("Claude Code 正在生成响应（已耗时 Ns）") already communicates
// progress, and emitting a status chunk here caused terminal flooding.
```

**理由**: 适配器脉冲 `"Claude Code 正在生成响应（已耗时 Ns）"` 每 4s 自动发射，已经向用户传达了"请求正在进行"的信息。桥接握手消息没有额外的用户价值。

## 修改文件

| 文件 | 改动 |
|------|------|
| `backend/src/services/gateway/adapters/claudeAdapter.js` | 删除桥接 status chunk 发射（根因修复） |
| `backend/src/cli/repl.js` | 添加 `_transientStatusActive` 防护（防御性改进，防止其他 status 刷屏） |
| `backend/src/cli/repl.js` | `emitRuntimeStatus` 入口添加"中转桥接"过滤（双保险） |
| `backend/src/cli/liteRepl.js` | 同步添加"中转桥接"过滤 |

## 防御性改进保留

虽然根因修复只需要 `claudeAdapter.js` 一行删除，但 `repl.js` 中的 `_transientStatusActive` 机制作为防御性改进保留：

- `_transientStatusActive` 标志位阻止 `showBusyInterjectPrompt()` 和 500ms keepalive 覆盖原地状态行
- 对其他可能的 transient status 刷屏场景（适配器切换、重试状态等）提供保护
- 在 `_writeTransientStatus` / `_writeOnStatusTransient` / `_isDynamicProgressStatus` 路径中设置
- 在 `_flushTransientStatus` / `_flushLiveStatusLine` / 内容到达 / 请求结束时清除

## 经验总结

1. **当渲染管道有多个并发定时器争抢同一个终端行时，从管道内部修复几乎不可能** — 竞态条件太多，测试环境无法复现
2. **优先从源头消除问题** — 如果一条消息可以不发，就不要发
3. **`-p` 模式和交互模式的代码路径差异很大** — busy prompt keepalive 只在交互模式存在，必须在交互模式下测试
4. **信息冗余是 bug 的温床** — 适配器脉冲已经提供了进度反馈，桥接状态消息是多余的
