# [DESIGN-ARCH-088] CC 快捷键系统、Redo/Fork 与执行偏差处理

> **定位**：定义 CC 模式下快捷键系统、撤销/重做、分叉、执行偏差处理的设计规范。
> **适用边界**：全局快捷键、消息操作、计划执行、错误恢复。
> **参考来源**：`interaction-patterns.md` (Undo/Redo, Confirmation, fzf, lazygit) + `advanced-patterns.md` (Destructive Actions)

---

## 0. 设计原则

| 原则 | 说明 |
|------|------|
| **快捷键一致性** | 相同操作在所有视图中行为一致 |
| **可发现性** | 快捷键可通过 `?` 或底部提示发现 |
| **安全网** | 破坏性操作可撤销或有确认 |
| **偏差可恢复** | 模型跑偏时用户可中断、回滚、分叉 |
| **渐进披露** | 常用快捷键显眼，高级快捷键可搜索 |

---

## 1. 快捷键系统设计

### 1.1 快捷键分层

| 层级 | 触发方式 | 示例 | 说明 |
|------|----------|------|------|
| **L1 全局** | 任何时候 | `Ctrl+C` `Ctrl+D` `Ctrl+P` `?` | 最高优先级 |
| **L2 视图** | 当前视图内 | `↑/↓` `Enter` `Esc` | 视图上下文相关 |
| **L3 面板** | 面板内 | `j/k` `Space` `c` | 面板特定操作 |
| **L4 模式** | 特定模式 | Vim `i/a/o` | 模式相关 |

### 1.2 全局快捷键（L1）

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `Ctrl+C` | 中断/退出 | 首次提示，双击退出 |
| `Ctrl+D` | 退出 REPL | — |
| `Ctrl+P` | 命令面板 | — |
| `Ctrl+R` | 历史搜索 | — |
| `Ctrl+O` | Transcript 模式 | 展开/折叠思考 |
| `Ctrl+B` | 切换右侧看板 | — |
| `Ctrl+T` | 任务列表 | — |
| `?` | 帮助菜单 | — |
| `q` | 退出（非输入模式） | — |

### 1.3 对话区快捷键（L2）

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `↑/↓` | 浏览历史输入 | — |
| `PageUp/PageDown` | 滚动对话 | — |
| `Home/End` | 跳到顶部/底部 | — |
| `c` | 复制当前消息 | — |
| `Ctrl+Shift+C` | 复制全部对话 | — |
| `r` | 重做（重新生成） | 从当前点重新生成回复 |
| `R` | 重做（编辑后） | 编辑上一条消息后重做 |
| `f` | 分叉 | 从当前点创建新分支 |
| `e` | 编辑上一条消息 | — |
| `d` | 删除消息 | 需确认 |
| `z` | 撤销 | 撤销上一次操作 |
| `Z` | 重做 | 重做上一次撤销 |

### 1.4 消息操作快捷键（L3）

| 快捷键 | 功能 | 目标 |
|--------|------|------|
| `Enter` | 展开/折叠 | 工具结果 |
| `Space` | 切换折叠 | 思考块 |
| `Tab` | 切换焦点 | 面板间 |
| `Esc` | 关闭/返回 | 模态/子菜单 |
| `o` | 打开 | 选中项 |
| `x` | 关闭/折叠 | 当前面板 |

### 1.5 Vim 模式快捷键（L4）

| 快捷键 | 功能 | 模式 |
|--------|------|------|
| `i` | 进入 INSERT | NORMAL → INSERT |
| `a` | 在光标后插入 | NORMAL → INSERT |
| `Esc` | 进入 NORMAL | INSERT → NORMAL |
| `h/j/k/l` | 移动光标 | NORMAL |
| `0/$` | 行首/行尾 | NORMAL |
| `x` | 删除字符 | NORMAL |
| `dd` | 删除行 | NORMAL |
| `u` | 撤销 | NORMAL |
| `Ctrl+R` | 重做 | NORMAL |

---

## 2. Redo 设计

### 2.1 重做类型

| 类型 | 触发 | 效果 | 说明 |
|------|------|------|------|
| **重新生成** | `r` | 从当前消息重新生成回复 | 保持上下文，重新调用模型 |
| **编辑重做** | `R` | 编辑上一条用户消息后重新生成 | 修改问题，重新回答 |
| **分叉** | `f` | 从当前点创建新分支 | 保留原分支，创建新对话路径 |
| **撤销重做** | `Z` | 撤销上一次撤销 | 恢复被撤销的操作 |

### 2.2 重新生成（Redo）

```
用户发送消息 → 模型回复 → 用户按 r

  ┌─────────────────────────────────────────────────────┐
  │ > 分析一下这个文件                                   │
  │                                                      │
  │ ● 这是一个包含 Portable 环境完整规则的文档...         │  ← 原回复
  │                                                      │
  │ ⏳ Regenerating...                                   │  ← 重新生成中
  │                                                      │
  └─────────────────────────────────────────────────────┘
```

**实现**：

```javascript
// 重新生成
function handleRedo(messageId) {
  // 1. 找到消息索引
  const idx = messages.findIndex(m => m.id === messageId);
  if (idx < 0) return;

  // 2. 截断消息（删除当前回复及之后的所有消息）
  const truncated = messages.slice(0, idx + 1); // 保留用户消息

  // 3. 重新调用模型
  regenerateResponse(truncated);
}
```

### 2.3 分叉（Fork）

```
原始对话：
  消息 1 → 消息 2 → 消息 3 → 消息 4
                            │
                            │ 按 f 分叉
                            ▼
  分叉 A（保留）：消息 1 → 消息 2 → 消息 3 → 消息 4
  分叉 B（新建）：消息 1 → 消息 2 → 消息 3 → [新回复]
```

**实现**：

```javascript
// 分叉
function handleFork(messageId) {
  // 1. 保存当前对话为快照
  const snapshot = createSnapshot(messages);

  // 2. 创建新分支
  const branch = {
    id: generateId(),
    parent: currentBranch.id,
    messages: messages.slice(0, messages.findIndex(m => m.id === messageId) + 1),
    createdAt: Date.now(),
  };

  // 3. 保存到分支列表
  branches.push(branch);

  // 4. 切换到新分支
  switchBranch(branch.id);
}
```

### 2.4 分支管理

```
┌─ Branches ────────────────────────────────────────────┐
│                                                        │
│  ▸ main                     4 messages                │
│    branch-1 (from msg 3)    5 messages                │
│    branch-2 (from msg 2)    3 messages                │
│                                                        │
├────────────────────────────────────────────────────────┤
│ 1-9: jump  Enter: switch  d: delete  n: new  Esc: back│
└────────────────────────────────────────────────────────┘
```

---

## 3. Undo 设计

### 3.1 撤销类型

| 类型 | 触发 | 效果 | 实现方式 |
|------|------|------|----------|
| **消息删除** | `d` + 确认 | 删除消息及之后所有 | 状态快照 |
| **操作撤销** | `z` | 撤销上一次操作 | 操作栈 |
| **重做恢复** | `Z` | 恢复被撤销的操作 | 撤销栈 |

### 3.2 操作栈实现

```javascript
// tui/utils/ccUndoStack.js

'use strict';

/**
 * 操作栈 — 支持撤销/重做
 */
class UndoStack {
  constructor(limit = 50) {
    this._undoStack = [];
    this._redoStack = [];
    this._limit = limit;
  }

  /**
   * 执行操作
   */
  execute(command) {
    command.execute();
    this._undoStack.push(command);
    this._redoStack = []; // 新操作清空重做栈
    if (this._undoStack.length > this._limit) {
      this._undoStack.shift();
    }
  }

  /**
   * 撤销
   */
  undo() {
    if (this._undoStack.length === 0) return false;
    const command = this._undoStack.pop();
    command.undo();
    this._redoStack.push(command);
    return true;
  }

  /**
   * 重做
   */
  redo() {
    if (this._redoStack.length === 0) return false;
    const command = this._redoStack.pop();
    command.execute();
    this._undoStack.push(command);
    return true;
  }

  /**
   * 清空
   */
  clear() {
    this._undoStack = [];
    this._redoStack = [];
  }

  get canUndo() { return this._undoStack.length > 0; }
  get canRedo() { return this._redoStack.length > 0; }
}

module.exports = { UndoStack };
```

### 3.3 命令模式

```javascript
// 命令基类
class Command {
  execute() {}
  undo() {}
}

// 删除消息命令
class DeleteMessageCommand {
  constructor(messageId, messages, onUpdate) {
    this.messageId = messageId;
    this.messages = messages;
    this.onUpdate = onUpdate;
    this._deleted = null;
  }

  execute() {
    const idx = this.messages.findIndex(m => m.id === this.messageId);
    this._deleted = this.messages.slice(idx);
    this.onUpdate(this.messages.slice(0, idx));
  }

  undo() {
    if (this._deleted) {
      this.onUpdate([...this.messages, ...this._deleted]);
    }
  }
}
```

---

## 4. 执行偏差处理

### 4.1 偏差检测

| 偏差类型 | 检测方式 | 严重程度 |
|----------|----------|----------|
| **工具调用失败** | 工具返回 error | 中 |
| **工具执行超时** | 超过设定时间 | 高 |
| **模型无响应** | 流式输出中断 | 高 |
| **输出截断** | 输出超过 maxTokens | 低 |
| **权限被拒绝** | 用户拒绝工具执行 | 中 |
| **上下文溢出** | Token 超过限制 | 高 |
| **循环检测** | 相同工具调用重复 N 次 | 高 |

### 4.2 偏差处理策略

#### 4.2.1 工具调用失败

```
✗ Read failed: File not found

  Suggestions:
  • Check the file path
  • Use Glob to search for the file
  • Create the file first

  [R] Retry  [S] Skip  [E] Edit path  [Esc] Cancel
```

#### 4.2.2 工具执行超时

```
✗ Bash timeout (30s): npm test

  The command took too long to complete.

  Suggestions:
  • Increase timeout: khy config set toolTimeout 120
  • Run directly: ! npm test
  • Check if the process is hanging

  [R] Retry  [S] Skip  [K] Kill process  [Esc] Cancel
```

#### 4.2.3 模型跑偏（循环检测）

```
⚠ Loop detected: The same tool "Read" has been called 5 times with similar parameters.

  Possible causes:
  • The model is stuck in a loop
  • The task is too complex for a single step

  [I] Interrupt and provide guidance
  [C] Continue (ignore warning)
  [R] Restart from last checkpoint
  [Esc] Dismiss
```

#### 4.2.4 上下文溢出

```
⚠ Context 95% full (190k/200k)

  The conversation is approaching the token limit.

  Suggestions:
  • Run /compact to compress the context
  • Start a new conversation
  • Remove unnecessary messages

  [/compact] Compress  [New] New conversation  [Esc] Dismiss
```

### 4.3 中断与恢复

#### 4.3.1 中断策略

| 操作 | 效果 | 恢复方式 |
|------|------|----------|
| `Ctrl+C` | 中断当前工具执行 | 自动重试或跳过 |
| `Esc` | 取消当前操作 | 返回上一状态 |
| `Ctrl+Z` | 挂起（Unix） | `fg` 恢复 |

#### 4.3.2 检查点机制

```
检查点：在关键操作前自动保存状态

  ┌─ 工具执行前 ────────────────────────────────────────┐
  │ 1. 保存当前消息状态为检查点                          │
  │ 2. 执行工具                                         │
  │ 3. 成功 → 继续                                      │
  │ 4. 失败 → 回滚到检查点                              │
  └─────────────────────────────────────────────────────┘
```

#### 4.3.3 回滚界面

```
⚠ Execution failed — rollback to checkpoint?

  The following operations will be undone:
  • Read src/index.ts (success)
  • Edit src/index.ts (failed: permission denied)

  [R] Rollback to checkpoint
  [C] Continue from here
  [V] View diff
  [Esc] Cancel
```

### 4.4 用户引导纠正

当模型跑偏时，用户可以注入引导：

```
模型正在执行一个错误的操作...

  > 请停止当前操作，改为分析 src/utils.ts 文件

  [Send guidance]  [Interrupt]  [Let it continue]
```

---

## 5. 快捷键发现性

### 5.1 四层发现机制

| 层级 | 机制 | 说明 |
|------|------|------|
| **L1** | 底部提示栏 | 始终显示 3-5 个最常用快捷键 |
| **L2** | `?` 帮助菜单 | 显示所有快捷键，按分组 |
| **L3** | `Ctrl+P` 命令面板 | 搜索命令，显示快捷键 |
| **L4** | Tab 补全 | 输入 `/` 显示命令列表 |

### 5.2 底部提示栏

```
j/k: navigate  Enter: select  /: search  ?: help  q: quit
```

### 5.3 帮助菜单

```
┌─ Keyboard Shortcuts ───────────────────────────────────┐
│                                                        │
│ Global                                                 │
│   Ctrl+C        Cancel/Exit                            │
│   Ctrl+D        Exit REPL                              │
│   Ctrl+P        Command palette                        │
│   Ctrl+R        History search                         │
│   ?             Toggle this help                       │
│                                                        │
│ Conversation                                           │
│   r             Regenerate response                    │
│   R             Edit & regenerate                      │
│   f             Fork from here                          │
│   e             Edit last message                      │
│   c             Copy message                           │
│   z             Undo                                   │
│   Z             Redo                                   │
│                                                        │
│ Navigation                                             │
│   j/k or ↑/↓    Move                                   │
│   PageUp/Down   Scroll                                 │
│   Home/End      Jump to top/bottom                     │
│                                                        │
└────────────────────────────────────────────────────────┘
```

---

## 6. 实现架构

### 6.1 快捷键注册表

```javascript
// tui/utils/ccKeyRegistry.js

'use strict';

/**
 * 快捷键注册表 — 集中管理所有快捷键
 */
class KeyRegistry {
  constructor() {
    this._bindings = new Map();
    this._context = 'global';
  }

  /**
   * 注册快捷键
   */
  register(key, handler, options = {}) {
    const k = this._normalize(key);
    this._bindings.set(k, {
      handler,
      context: options.context || 'global',
      description: options.description || '',
      group: options.group || 'General',
    });
  }

  /**
   * 处理按键
   */
  handle(input, key) {
    const k = this._normalizeKey(input, key);
    const binding = this._bindings.get(k);
    if (!binding) return false;

    // 检查上下文
    if (binding.context !== 'global' && binding.context !== this._context) {
      return false;
    }

    binding.handler(input, key);
    return true;
  }

  /**
   * 获取当前上下文的快捷键列表
   */
  getBindingsForContext(context) {
    return [...this._bindings.entries()]
      .filter(([_, b]) => b.context === context || b.context === 'global')
      .map(([k, b]) => ({ key: k, ...b }));
  }

  _normalizeKey(input, key) {
    const parts = [];
    if (key.ctrl) parts.push('ctrl');
    if (key.shift) parts.push('shift');
    if (key.meta) parts.push('meta');
    parts.push(input || key.name || 'unknown');
    return parts.join('+');
  }
}

module.exports = { KeyRegistry };
```

### 6.2 执行监控器

```javascript
// tui/utils/ccExecutionMonitor.js

'use strict';

/**
 * 执行监控器 — 检测偏差并触发恢复
 */
class ExecutionMonitor {
  constructor(options = {}) {
    this._toolCallCounts = new Map();
    this._maxRepeatCalls = options.maxRepeatCalls || 5;
    this._timeout = options.timeout || 30000;
    this._onLoopDetected = options.onLoopDetected || (() => {});
    this._onTimeout = options.onTimeout || (() => {});
  }

  /**
   * 记录工具调用
   */
  recordToolCall(name, params) {
    const key = `${name}:${JSON.stringify(params)}`;
    const count = (this._toolCallCounts.get(key) || 0) + 1;
    this._toolCallCounts.set(key, count);

    if (count >= this._maxRepeatCalls) {
      this._onLoopDetected({ name, params, count });
      return false; // 阻止继续执行
    }
    return true;
  }

  /**
   * 重置计数
   */
  reset() {
    this._toolCallCounts.clear();
  }

  /**
   * 设置超时
   */
  startTimeout(callback) {
    this._timeoutId = setTimeout(() => {
      this._onTimeout();
    }, this._timeout);
  }

  /**
   * 清除超时
   */
  clearTimeout() {
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
  }
}

module.exports = { ExecutionMonitor };
```

---

## 7. 验收标准

| 场景 | 预期 |
|------|------|
| 快捷键注册 | 集中管理，支持上下文 |
| 重新生成 | `r` 从当前点重新生成 |
| 分叉 | `f` 创建新分支 |
| 撤销 | `z` 撤销上一次操作 |
| 重做 | `Z` 重做上一次撤销 |
| 工具失败 | 显示错误 + 重试/跳过建议 |
| 工具超时 | 显示超时 + 增加超时建议 |
| 循环检测 | 检测到重复调用时警告 |
| 上下文溢出 | 80% 黄色 / 95% 红色 |
| 检查点回滚 | 失败后回滚到检查点 |
| 用户引导 | 可注入指导纠正模型 |
| 快捷键发现 | 底部提示 + `?` 帮助 + `Ctrl+P` |

---

> **文档状态**：Draft — 待实施
> **创建日期**：2026-09-09
> **依赖**：[DESIGN-ARCH-081] 主设计规范
