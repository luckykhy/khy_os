# [DESIGN-ARCH-082] CC 模式输入框与光标设计

> **定位**：定义 CC 模式下输入框组件的完整设计规范，包括布局、光标、多行输入、模式切换、占位符等。
> **适用边界**：`tui/ink-components/CcPromptInput.js` 的实现约束。
> **参考来源**：`D:\Portable\Docs\design\claude-code-tui\visual-mockup.md` + `component-catalog.md` + `interaction-patterns.md`

---

## 0. 设计原则

| 原则 | 说明 |
|------|------|
| **极简主义** | 无边框、无装饰，空间全给内容 |
| **终端原生** | 继承终端主题，不强制覆盖颜色 |
| **即时反馈** | 输入延迟 < 16ms，光标跟随无跳跃 |
| **模式可见** | Vim 模式、Shell 模式、Voice 模式有明确视觉区分 |
| **零破坏** | Legacy 模式行为不变 |

---

## 1. 输入框布局

### 1.1 外观（对齐 Claude Code）

```
> Type a message...                              ← 空输入时显示占位符（灰色）

> Hello, world!                                  ← 有输入时显示内容

> Line 1                                         ← 多行输入（Shift+Enter 换行）
  Line 2
  Line 3

! npm run build                                  ← Shell 模式（! 前缀）

🎤 Listening...                                  ← Voice 模式
```

### 1.2 关键差异：khy-os vs Claude Code

| 特性 | Claude Code | Khy CC 模式 | 处理方式 |
|------|-------------|-------------|----------|
| **边框** | 无边框 | 无边框（对齐 CC） | 去除现有边框 |
| **提示符** | `> ` | `> `（对齐 CC） | 统一为 `> ` |
| **多行** | Shift+Enter | Shift+Enter（保留） | 保留现有实现 |
| **Shell 模式** | 无 | `!` 前缀 | 保留 khy 特色 |
| **Voice 模式** | 无 | `🎤` 前缀 | 保留 khy 特色 |
| **Vim 模式** | 无 | NORMAL/INSERT 指示 | 保留 khy 特色 |
| **占位符** | 灰色文字 | 灰色文字（对齐 CC） | 统一风格 |

### 1.3 布局规范

| 属性 | 值 | 说明 |
|------|-----|------|
| **最小高度** | 1 行 | 绝对值 |
| **最大高度** | `min(10, rows * 0.3)` | 相对终端高度 |
| **宽度** | `cols`（全宽） | 无边框，占满可用宽度 |
| **提示符宽度** | 2 字符 | `> ` 或 `  `（续行） |
| **内边距** | 0 | 无额外内边距 |
| **边框** | 无 | 对齐 CC 极简风格 |

---

## 2. 光标设计

### 2.1 光标样式

| 模式 | 样式 | 颜色 | 说明 |
|------|------|------|------|
| **INSERT 模式** | 竖线 `│` | 绿色 `#4ADE80` | 经典插入光标 |
| **NORMAL 模式** | 方块 `█` | 绿色 `#4ADE80` | Vim 风格块光标 |
| **Shell 模式** | 竖线 `│` | 黄色 `#FBBF24` | 区分普通输入 |
| **Voice 模式** | 闪烁 `●` | 红色 `#F87171` | 录音指示 |
| **覆盖模式** | 下划线 `_` | 绿色 `#4ADE80` | Vim replace 模式 |

### 2.2 光标渲染实现

```javascript
// tui/ink-components/CcPromptInput.js

'use strict';

const React = require('react');
const { Text, Box } = require('ink');
const { useCursor } = require('../hooks/useCursor');

/**
 * 光标字符映射
 */
const CURSOR_CHARS = {
  insert: '│',      // 竖线
  normal: '█',      // 方块（Vim NORMAL）
  shell: '│',       // 竖线（Shell 模式）
  voice: '●',       // 圆点（录音）
  replace: '_',     // 下划线（覆盖）
};

/**
 * 光标颜色映射
 */
const CURSOR_COLORS = {
  insert: '#4ADE80',    // 绿色
  normal: '#4ADE80',    // 绿色
  shell: '#FBBF24',     // 黄色
  voice: '#F87171',     // 红色
  replace: '#4ADE80',   // 绿色
};

/**
 * 渲染光标
 */
function Cursor({ mode = 'insert', visible = true }) {
  const char = CURSOR_CHARS[mode] || CURSOR_CHARS.insert;
  const color = CURSOR_COLORS[mode] || CURSOR_COLORS.insert;

  if (!visible) {
    return null;
  }

  return (
    <Text color={color} bold>
      {char}
    </Text>
  );
}
```

### 2.3 光标定位策略

```javascript
// 使用 Ink 的 useCursor hook 进行精确定位
const { showCursor, hideCursor, setCursorPosition } = useCursor();

// 在输入框中获得焦点时显示光标
useEffect(() => {
  if (focused) {
    showCursor();
  } else {
    hideCursor();
  }
  return () => hideCursor();
}, [focused]);

// 光标位置跟随输入偏移
useEffect(() => {
  if (focused) {
    const { x, y } = calculateCaretPosition(value, offset);
    setCursorPosition(x, y);
  }
}, [value, offset, focused]);
```

### 2.4 光标闪烁

| 属性 | 值 | 说明 |
|------|-----|------|
| **闪烁间隔** | 530ms | 与终端默认一致 |
| **闪烁模式** | 可见/隐藏 | 简单切换 |
| **NORMAL 模式** | 常亮 | 不闪烁（Vim 风格） |
| **录音模式** | 快速闪烁 | 200ms 间隔 |

---

## 3. 输入模式

### 3.1 模式指示器

```
> Type a message...                    ← 默认模式（无指示）

[INSERT] > Type a message...           ← Vim INSERT 模式

[NORMAL] > Type a message...           ← Vim NORMAL 模式

[SHELL] ! npm run build                ← Shell 模式

[VOICE] 🎤 Listening...                ← Voice 模式
```

### 3.2 模式切换

| 快捷键 | 从 | 到 | 说明 |
|--------|-----|-----|------|
| `i` | NORMAL | INSERT | Vim 标准 |
| `Esc` | INSERT | NORMAL | Vim 标准 |
| `v` | 任意 | VOICE | 语音输入（Win+H） |
| `!` + 输入 | 任意 | Shell | 命令执行 |
| `Enter` | Shell | 默认 | 执行后返回 |

### 3.3 模式状态机

```
                    ┌─────────┐
                    │ DEFAULT │
                    └────┬────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │  INSERT  │  │  SHELL   │  │  VOICE   │
    │  (Vim)   │  │  (! 前缀) │  │  (Win+H) │
    └────┬─────┘  └────┬─────┘  └────┬─────┘
         │              │              │
         │    ┌─────────┘              │
         │    │                        │
         ▼    ▼                        │
    ┌──────────┐                       │
    │  NORMAL  │ ◄─────────────────────┘
    │  (Vim)   │
    └──────────┘
```

---

## 4. 占位符设计

### 4.1 占位符文本

| 模式 | 占位符 | 颜色 |
|------|--------|------|
| **默认** | `Send a message...` | `#6B7280`（灰色） |
| **Shell** | `Run a command...` | `#6B7280`（灰色） |
| **Voice** | `Listening...` | `#F87171`（红色） |
| **Busy** | `AI is thinking...` | `#6B7280`（灰色） |

### 4.2 占位符渲染

```javascript
/**
 * 渲染占位符
 */
function Placeholder({ mode = 'default', busy = false }) {
  if (busy) {
    return <Text color="#6B7280">AI is thinking...</Text>;
  }

  const placeholders = {
    default: 'Send a message...',
    shell: 'Run a command...',
    voice: 'Listening...',
  };

  const text = placeholders[mode] || placeholders.default;
  return <Text color="#6B7280">{text}</Text>;
}
```

---

## 5. 多行输入

### 5.1 换行处理

| 操作 | 效果 |
|------|------|
| `Shift+Enter` | 插入换行符，继续输入 |
| `Enter` | 发送消息 |
| `Ctrl+Enter` | 多行模式下发送 |
| `粘贴多行` | 自动分割为多行 |

### 5.2 行号提示

```
> Line 1                                         ← 第 1 行："> " 前缀
  Line 2                                         ← 第 2 行："  " 前缀（对齐）
  Line 3
```

### 5.3 高度窗口化

当输入行数超过最大高度时，显示滚动窗口：

```
⋯ (3 lines above)                                ← 上方省略标记
  Line 4
  Line 5
> Line 6                                         ← 光标所在行
⋯ (2 lines below)                                ← 下方省略标记
```

---

## 6. 实现架构

### 6.1 组件结构

```
CcPromptInput (容器)
├── ModeIndicator (模式指示器，可选)
├── InputArea (输入区域)
│   ├── LinePrefix (行前缀 "> " 或 "  ")
│   ├── TextContent (文本内容)
│   ├── Cursor (光标)
│   └── Placeholder (占位符)
└── FooterHint (底部提示，可选)
```

### 6.2 Props 接口

```javascript
/**
 * CcPromptInput Props
 */
interface CcPromptInputProps {
  // 核心状态
  value: string;                    // 当前输入值
  onChange: (value: string) => void; // 输入变化回调
  onSubmit: (value: string) => void; // 提交回调
  
  // 模式
  mode: 'default' | 'insert' | 'normal' | 'shell' | 'voice'; // 当前模式
  busy: boolean;                    // 是否正在处理（禁用输入）
  
  // 配置
  placeholder?: string;             // 自定义占位符
  maxRows?: number;                 // 最大行数
  vimEnabled?: boolean;             // 是否启用 Vim 模式
  
  // 回调
  onModeChange?: (mode: string) => void;     // 模式切换
  onShellCommand?: (cmd: string) => void;    // Shell 命令
  onVoiceStart?: () => void;                 // 语音输入开始
}
```

### 6.3 状态管理

```javascript
function CcPromptInput(props) {
  const [value, setValue] = useState('');
  const [offset, setOffset] = useState(0);        // 光标位置（UTF-16 偏移）
  const [mode, setMode] = useState('default');     // 当前模式
  const [focused, setFocused] = useState(true);    // 是否聚焦
  
  // 使用 useInput 处理键盘事件
  useInput(handleInput, { isActive: focused });
  
  // 使用 useCursor 控制光标显示
  const { showCursor, hideCursor } = useCursor();
  
  // ...
}
```

---

## 7. 性能约束

| 约束 | 值 | 说明 |
|------|-----|------|
| **输入延迟** | < 16ms | 按键到屏幕响应 |
| **光标跟随** | 无跳跃 | 光标位置与输入偏移同步 |
| **多行渲染** | O(可见行) | 仅渲染可见区域 |
| **内存** | O(输入长度) | 不缓存历史帧 |

---

## 8. 验收标准

| 场景 | 预期 |
|------|------|
| 空输入 | 显示灰色占位符 `Send a message...` |
| 单行输入 | 显示 `> ` 前缀 + 内容 |
| 多行输入 | 续行显示 `  ` 前缀，对齐 |
| Vim INSERT | 绿色竖线光标 `│` |
| Vim NORMAL | 绿色方块光标 `█`，常亮 |
| Shell 模式 | `!` 前缀 + 黄色光标 |
| Voice 模式 | `🎤` 前缀 + 红色闪烁光标 |
| 输入中 | 光标跟随输入位置，无跳跃 |
| 长输入 | 高度窗口化，显示省略标记 |
| 粘贴多行 | 自动分割，保留换行 |

---

> **文档状态**：Draft — 待实施
> **创建日期**：2026-09-09
> **依赖**：[DESIGN-ARCH-081] 主设计规范
