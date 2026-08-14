<!-- 文档分类: IMPL-RPT-016 | 阶段: 实现 | 原路径: docs/指南/剪贴板粘贴修复.md -->
# 剪贴板粘贴修复

> 修复日期：2026-05-24
> 涉及模块：`backend/src/cli/repl.js`
> 状态：已实施

---

## 问题背景

khy REPL 中粘贴内容会被**自动发送**给 AI，用户无法在粘贴后添加提示词或编辑内容。

期望行为（对齐 Claude Code）：
- 短粘贴（≤5 行）：直接显示在 readline 中，可编辑
- 长粘贴（>5 行）：折叠为 `[Pasted text #N +M lines]` 标签
- 用户可以在标签前后输入提示词
- 只有用户主动按 Enter 才发送

## 根因分析

### 问题 1：Burst 检测时间判断 bug

粘贴作为单个 stdin chunk 到达时，Node.js `emitKeypressEvents` 同步处理所有字符。
`Date.now()` 在同一 event loop tick 返回相同值，导致 `elapsed === 0`。

```javascript
// BUG: elapsed === 0 时 (0 > 0) 为 false，burst 永远检测不到
if (elapsed > 0 && elapsed <= BURST_CHAR_INTERVAL_MS) {

// FIX: 用 _burstLastCharAt > 0 判断是否有前序字符
if (_burstLastCharAt > 0 && elapsed <= BURST_CHAR_INTERVAL_MS) {
```

### 问题 2：finally 块绕过粘贴保护

AI 完成后的 `finally` 清理代码中，有独立的 `_busyQueueAccum` flush 逻辑，
直接把多行内容推入 `_queuedInputs` 并自动执行，绕过了 `_storePendingPaste`。

```javascript
// BUG: 直接推入队列自动执行
_queuedInputs.push(`<pasted-content>\n${merged}\n</pasted-content>`);

// FIX: 调用 _storePendingPaste 等待用户确认
_storePendingPaste(merged, null, '', false);
```

### 问题 3：`_busyQueueWithMerge` 自动排队

多行粘贴通过 `_busyQueueWithMerge` 累积后，自动推入 `_queuedInputs`，
不经过用户确认。

### 问题 4：`_shouldBatchInputLine` 在空闲状态不生效

空闲状态下第一行到达时，`_shouldBatchInputLine` 返回 false，
直接穿过 batch 检测被执行。

### 问题 5：Ghost Enter 事件

粘贴尾部的 `\n` 产生幽灵 Enter 事件，在 `_pendingPaste` 设置后
立即触发 flush 发送。

## 方案：采用 DeepSeek-TUI 风格的粘贴突发检测

对比了 4 个项目的粘贴处理方案后，采用 DeepSeek-TUI 的**快速按键启发式检测**：

| 项目 | 检测方式 | 防止自动发送 | 适用场景 |
|------|---------|------------|---------|
| **Claude Code** | bracketed paste + isPasted flag | `if (isPasting && key.return) return` | React/Ink TUI |
| **DeepSeek-TUI** | bracketed paste + 快速按键启发式 | 120ms Enter 抑制窗口 | Rust 终端 |
| **LibreChat** | 浏览器 onPaste 事件 | Enter-to-Send 可配 | Web 应用 |
| **oh-my-openagent** | 委托 opencode | — | 插件层 |

选择 DeepSeek-TUI 方案的原因：
1. khy 和 DeepSeek 面临相同问题——终端环境，无法依赖浏览器事件
2. 双层检测覆盖所有终端类型（有/无 bracketed paste）
3. 在 `_ttyWrite` keypress 层直接拦截，不与 readline `line` 事件竞争

## 实现

### 三层粘贴检测

```
Terminal Input
    │
    ├─ Layer 1: Bracketed Paste (_ttyWrite)
    │   检测 \x1b[200~ ... \x1b[201~ 标记
    │   设置 _pasteCapturing = true，缓冲所有内容
    │   → _finishPasteCapture → _storePendingPaste
    │
    ├─ Layer 2: Raw Stdin Large Chunk (prependListener)
    │   检测 length >= 40 && newlines >= 2
    │   设置 _rawPasteActive = true，_ttyWrite 吞掉所有 keypress
    │   → _flushRawPaste → _storePendingPaste
    │
    └─ Layer 3: Paste-Burst Heuristic (_ttyWrite, DeepSeek style)
        追踪连续字符间隔，3+ 字符在 12ms 内 → 判定为粘贴
        缓冲所有字符，Enter → 换行而非提交
        150ms 静默后 → _flushBurst → _storePendingPaste
```

### 粘贴突发检测状态机

```
                    ┌─ char, elapsed > 12ms ─→ reset consecutive=1
                    │
[Idle] ─ char ─→ [Counting]
                    │
                    ├─ 2nd char, ≤12ms ─→ consecutive=2
                    │
                    └─ 3rd char, ≤12ms ─→ [Active]
                                            │
                        ┌─ char ─→ buffer, reset timer
                        ├─ Enter ─→ buffer '\n', reset timer
                        └─ 150ms silence ─→ _flushBurst → _storePendingPaste
```

### 关键常量

```javascript
BURST_CHAR_INTERVAL_MS = 12   // DeepSeek uses 8ms; 12ms for Node overhead
BURST_MIN_CHARS        = 3    // 3+ rapid chars → paste
BURST_SUPPRESS_MS      = 150  // suppress Enter for 150ms after last char
```

### `_storePendingPaste` — 统一入口

无论哪层检测到粘贴，统一走 `_storePendingPaste(text, writeFn, prefix, autoCommittedLine)`：

- **短粘贴**（≤5 行 && ≤500 字符）：内容直接写入 readline，可编辑
- **长粘贴**：设置 `_pendingPaste`，注入 `[Pasted text #N +M lines]` 标签
- Busy/非 busy 行为一致：都等用户按 Enter

### Ghost Enter 防护

```javascript
// 600ms 时间窗口：_storePendingPaste 后的空 Enter 一律视为幽灵事件
const msSincePaste = Date.now() - _pendingPasteSetAt;
if (msSincePaste < 600) {
    // 静默吞掉，重新注入标签
    return;
}
```

### Finally 块保护

AI 完成后的 `finally` 清理代码中：
- 多行 `_busyQueueAccum` → `_storePendingPaste` 而非 `_queuedInputs.push`
- `_burstActive` 残留 → flush 到 `_storePendingPaste`
- `_pendingPaste !== null` → 阻止 `_queuedInputs` 自动 dequeue

## 修改文件

- `backend/src/cli/repl.js` — 所有修改集中在此文件

### 新增状态变量

| Variable | Scope | Purpose |
|----------|-------|---------|
| `_burstLastCharAt` | outer | 上一个 plain char 的时间戳 |
| `_burstConsecutive` | outer | 连续快速字符计数 |
| `_burstActive` | outer | burst 模式是否激活 |
| `_burstBuf` | outer | burst 缓冲区 |
| `_burstWindowUntil` | outer | Enter 抑制窗口截止时间 |
| `_burstFlushTimer` | outer | 150ms flush 定时器 |
| `_pendingPasteSetAt` | outer | `_storePendingPaste` 调用时间戳 |
| `_pasteCapturing` | outer | 提升自 `_ttyWrite` 闭包，line handler 可检查 |

## 测试验证

1. **空闲状态粘贴**：粘贴多行 → 应显示 `[Pasted text #N +M lines]`，不自动发送
2. **Busy 状态粘贴**：AI 运行时粘贴 → 同上，显示标签 + hint
3. **粘贴后加提示词**：粘贴后输入 "分析这段代码" → Enter → 发送粘贴内容 + 提示词
4. **短粘贴**：粘贴 3 行 → 内容直接显示在 readline 可编辑
5. **单行输入**：正常输入 Enter → 应正常发送（~90ms 延迟不可感知）
6. **SSH/tmux**：无 bracketed paste 的终端 → burst 检测应生效

## 参考资料

- DeepSeek-TUI paste-burst: `crates/tui/src/tui/paste_burst.rs`
- Claude Code paste handler: `src/hooks/usePasteHandler.ts`
- Claude Code submit handler: `src/utils/handlePromptSubmit.ts`
