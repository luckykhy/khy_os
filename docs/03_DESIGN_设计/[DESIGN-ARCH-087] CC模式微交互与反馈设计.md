# [DESIGN-ARCH-087] CC 模式微交互与反馈设计

> **定位**：定义 CC 模式下所有微交互、瞬态反馈、状态提示的设计规范。
> **适用边界**：复制反馈、滚动指示、Toast 消息、工具执行反馈、系统状态提示。
> **参考来源**：`interaction-patterns.md` (Confirmation, Error States) + `advanced-patterns.md` (Status Bar, Clipboard)

---

## 0. 设计原则

| 原则 | 说明 |
|------|------|
| **即时反馈** | 用户操作后立即给出反馈 |
| **信息精确** | 反馈内容具体（字符数、行数、百分比） |
| **不干扰** | 反馈不阻挡用户当前操作 |
| **自动消失** | 瞬态消息 3-5 秒后自动消失 |
| **可操作** | 错误反馈包含修复建议 |

---

## 1. 复制反馈设计

### 1.1 反馈格式

| 操作 | 反馈文本 | 示例 |
|------|----------|------|
| 复制单个值 | `copied N chars` | `copied 42 chars` |
| 复制多行 | `copied N lines` | `copied 3 lines` |
| 复制 JSON | `copied JSON (N bytes)` | `copied JSON (1.2KB)` |
| 复制文件路径 | `copied path` | `copied src/index.ts` |
| 复制失败 | `copy failed (reason)` | `copy failed (no clipboard)` |
| 复制到系统剪贴板 | `copied to clipboard` | — |

### 1.2 反馈位置

```
状态栏右侧（临时替换 MCP 状态）：

Sonnet 4 │ Context 45% │ $0.42  │  copied 42 chars     ← 3 秒后恢复
```

### 1.3 实现

```javascript
// tui/utils/ccFeedback.js

'use strict';

/**
 * 反馈管理器
 */
class FeedbackManager {
  constructor() {
    this._timeout = null;
    this._originalStatus = null;
  }

  /**
   * 显示复制反馈
   */
  showCopied(text) {
    let feedback;
    if (typeof text === 'string') {
      const lines = text.split('\n').length;
      const chars = text.length;
      const bytes = Buffer.byteLength(text, 'utf8');
      if (lines > 1) {
        feedback = `copied ${lines} lines`;
      } else if (bytes > 1024) {
        feedback = `copied ${(bytes / 1024).toFixed(1)}KB`;
      } else {
        feedback = `copied ${chars} chars`;
      }
    }
    this._show(feedback, 'success');
  }

  /**
   * 显示通用反馈
   */
  _show(message, type = 'info') {
    // 清除之前的定时器
    if (this._timeout) clearTimeout(this._timeout);

    // 触发 UI 更新（通过事件或回调）
    this._onUpdate?.(message, type);

    // 3 秒后清除
    this._timeout = setTimeout(() => {
      this._onUpdate?.(null);
      this._timeout = null;
    }, 3000);
  }

  /**
   * 显示错误反馈
   */
  showError(message, suggestion) {
    const feedback = suggestion
      ? `${message} — ${suggestion}`
      : message;
    this._show(feedback, 'error');
  }

  /**
   * 销毁
   */
  destroy() {
    if (this._timeout) clearTimeout(this._timeout);
  }
}

module.exports = { FeedbackManager };
```

---

## 2. 滚动指示器设计

### 2.1 指示器格式

| 场景 | 显示 | 位置 |
|------|------|------|
| 上方有 N 条消息 | `⋯ (N above)` | 对话区顶部 |
| 下方有 N 条消息 | `⋯ (N below)` | 对话区底部 |
| 上方有更多 | `⋯ (N more above)` | — |
| 下方有更多 | `⋯ (N more below)` | — |
| 到达顶部 | 无 | — |
| 到达底部 | 无 | — |

### 2.2 视觉样式

```
对话区：
  ⋯ (3 above)                                        ← 顶部指示器（灰色，居左）
  ┌─────────────────────────────────────────────────────┐
  │ 消息 4                                              │
  │ 消息 5                                              │
  │ 消息 6                                              │
  └─────────────────────────────────────────────────────┘
  ⋯ (5 below)                                         ← 底部指示器（灰色，居左）
```

### 2.3 实现

```javascript
// tui/components/CcScrollIndicators.js

'use strict';

const React = require('react');
const { Box, Text } = require('ink');

function CcScrollIndicators({ above, below }) {
  return (
    React.createElement(React.Fragment, null,
      above > 0 ? (
        React.createElement(Box, { paddingLeft: 2 },
          React.createElement(Text, { color: '#6B7280', dimColor: true },
            `⋯ (${above} above)`)
        )
      ) : null,
      below > 0 ? (
        React.createElement(Box, { paddingLeft: 2 },
          React.createElement(Text, { color: '#6B7280', dimColor: true },
            `⋯ (${below} below)`)
        )
      ) : null,
    )
  );
}

module.exports = { CcScrollIndicators };
```

---

## 3. 瞬态消息（Toast）设计

### 3.1 Toast 类型

| 类型 | 图标 | 颜色 | 持续时间 | 示例 |
|------|------|------|----------|------|
| 成功 | `✓` | 绿色 `#4ADE80` | 3s | `✓ Copied 42 chars` |
| 错误 | `✗` | 红色 `#F87171` | 5s | `✗ Connection failed` |
| 警告 | `⚠` | 黄色 `#FBBF24` | 4s | `⚠ Context 80% full` |
| 信息 | `ℹ` | 蓝色 `#58A6FF` | 3s | `ℹ Resumed from checkpoint` |

### 3.2 Toast 位置

```
状态栏（临时替换右侧区域）：

Sonnet 4 │ Context 45% │ $0.42  │  ✓ Copied 42 chars     ← Toast 显示
```

### 3.3 Toast 实现

```javascript
// tui/components/CcToast.js

'use strict';

const React = require('react');
const { Box, Text } = require('ink');

const TOAST_CONFIG = {
  success: { icon: '✓', color: '#4ADE80', duration: 3000 },
  error:   { icon: '✗', color: '#F87171', duration: 5000 },
  warning: { icon: '⚠', color: '#FBBF24', duration: 4000 },
  info:    { icon: 'ℹ', color: '#58A6FF', duration: 3000 },
};

function CcToast({ type = 'info', message }) {
  const config = TOAST_CONFIG[type] || TOAST_CONFIG.info;

  return (
    React.createElement(Box, { marginLeft: 1 },
      React.createElement(Text, { color: config.color },
        config.icon + ' ' + message)
    )
  );
}

// Hook: useToast
function useToast() {
  const [toast, setToast] = React.useState(null);
  const timerRef = React.useRef(null);

  const showToast = React.useCallback((type, message, duration) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ type, message });
    timerRef.current = setTimeout(() => {
      setToast(null);
      timerRef.current = null;
    }, duration || TOAST_CONFIG[type]?.duration || 3000);
  }, []);

  const hideToast = React.useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(null);
  }, []);

  return { toast, showToast, hideToast };
}

module.exports = { CcToast, useToast };
```

---

## 4. 工具执行反馈设计

### 4.1 执行状态反馈

| 状态 | 显示 | 示例 |
|------|------|------|
| 等待执行 | `◦ Waiting...` | 灰色空心圆 |
| 执行中 | `⏳ Running...` | 黄色 + spinner |
| 重试中 | `🔄 Retry (2/3)...` | 黄色 + 计数 |
| 超时 | `⏱ Timeout (30s)` | 红色 + 时间 |
| 被中断 | `⊘ Interrupted` | 灰色 |
| 完成 | `✓ Done` | 绿色 |
| 失败 | `✗ Failed` | 红色 |

### 4.2 超时反馈

```
✗ Timeout (30s): npm test

  Suggestions:
  • Try a longer timeout: khy config set toolTimeout 120
  • Run the command directly: ! npm test
  • Check network connectivity

  [R] Retry  [S] Skip  [Esc] Dismiss
```

### 4.3 输出截断反馈

```
┌─ Bash 结果 ────────────────────────────────────────────┐
│ $ npm test                                              │
│ PASS src/utils.test.ts                                  │
│ PASS src/api.test.ts                                    │
│ ... (truncated, 45 more lines) ...                      │ ← 截断提示
│ FAIL src/index.test.ts                                  │
│   ✗ should render correctly                             │
│     Expected: "Hello"                                   │
│     Received: "World"                                   │
│                                                        │
│ 42 passed, 1 failed                                     │
└────────────────────────────────────────────────────────┘

  Press [f] to view full output
```

---

## 5. 系统状态反馈设计

### 5.1 Token 用量警告

| 使用率 | 颜色 | 状态栏显示 | 行为 |
|--------|------|------------|------|
| < 80% | 默认 | `Context 45% (90k/200k)` | 无 |
| 80-94% | 黄色 | `Context 85% (170k/200k)` | 状态栏黄色 |
| 95-99% | 红色 | `Context 95% (190k/200k)` | 状态栏红色 + Toast |
| 100% | 红色 | `Context FULL` | 提示 /compact |

### 5.2 连接状态反馈

| 状态 | 图标 | 颜色 | 反馈 |
|------|------|------|------|
| 已连接 | `•` | 绿色 | 无 |
| 连接中 | `◦` | 黄色 | `Connecting...` |
| 已断开 | `✗` | 红色 | `Disconnected` + 自动重连 |
| 重连中 | `◐` | 黄色 | `Reconnecting (2/5)...` |
| 重连成功 | `•` | 绿色 | `Reconnected` Toast |

### 5.3 权限模式切换反馈

```
从默认模式切换到自动破甲模式：

  ⚠ Switched to auto-edit mode
  File edits will be applied automatically.
  Dangerous operations still require confirmation.

  Press [p] to cycle back to default mode.
```

### 5.4 双击 Ctrl+C 退出

```
第一次 Ctrl+C：

  ⚠ Press Ctrl+C again to exit
  (or press any other key to continue)

第二次 Ctrl+C（2 秒内）：
  退出程序
```

---

## 6. 输入反馈设计

### 6.1 粘贴反馈

| 场景 | 反馈 | 示例 |
|------|------|------|
| 粘贴文本 | `Pasted ~N lines` | `Pasted ~200 lines` |
| 粘贴图片 | `Image attached` | — |
| 粘贴过大 | `Input truncated to N chars` | — |
| 粘贴为空 | 无反馈 | — |

### 6.2 历史导航反馈

```
按 ↑ 浏览历史时：

  > /model gpt-4o                                        ← 当前输入
  > /login                                                ← 上一条历史（高亮）
  > /mcp list                                             ← 下一条历史

  状态栏显示：History 3/12
```

---

## 7. 会话恢复反馈

### 7.1 恢复提示

```
  ℹ Resumed from checkpoint
  Last activity: 5 minutes ago
  Context: 12,456 tokens preserved

  Press [d] to view diff since checkpoint
```

### 7.2 检查点创建

```
  ℹ Checkpoint saved
  Context: 12,456 tokens
  Location: .khy/checkpoints/chk-20260909-123456
```

---

## 8. 实现架构

### 8.1 反馈优先级

| 优先级 | 类型 | 显示时长 |
|--------|------|----------|
| 1（最高） | 错误 | 5s 或手动关闭 |
| 2 | 警告 | 4s |
| 3 | 成功 | 3s |
| 4 | 信息 | 3s |

### 8.2 反馈队列

```javascript
// 多个反馈同时触发时，按优先级排队
const queue = new PriorityQueue();
queue.enqueue({ type: 'error', message: 'Connection failed', priority: 1 });
queue.enqueue({ type: 'success', message: 'Copied', priority: 3 });
// 先显示错误，3 秒后显示成功
```

---

## 9. 验收标准

| 场景 | 预期 |
|------|------|
| 复制字符 | 显示 `copied N chars` |
| 复制行 | 显示 `copied N lines` |
| 滚动 | 显示 `⋯ (N above/below)` |
| Toast | 3-5 秒自动消失 |
| Token 80% | 状态栏黄色警告 |
| Token 95% | 状态栏红色 + Toast |
| 工具超时 | 显示超时 + 重试建议 |
| 输出截断 | 显示 `... (truncated, N lines)` |
| 粘贴大文本 | 显示 `Pasted ~N lines` |
| 权限切换 | Toast 提示新模式 |
| 双击退出 | 首次提示，二次退出 |
| 会话恢复 | 显示恢复提示 |

---

> **文档状态**：Draft — 待实施
> **创建日期**：2026-09-09
> **依赖**：[DESIGN-ARCH-081] 主设计规范
