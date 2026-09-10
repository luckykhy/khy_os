# [DESIGN-ARCH-083] CC 模式表格与折叠设计

> **定位**：定义 CC 模式下表格显示和折叠/隐藏组件的设计规范。
> **适用边界**：工具调用卡片、MCP 服务器列表、帮助菜单、设置面板等。
> **参考来源**：`component-catalog.md` (Table, Tabs) + `visual-patterns.md` (Borders, Color, Density) + `interaction-patterns.md` (Discoverability)

---

## 0. 设计原则

| 原则 | 说明 |
|------|------|
| **清晰优先** | 信息层级清晰，一目了然 |
| **密度适中** | 既不空旷也不拥挤，呼吸感充足 |
| **折叠友好** | 长内容默认折叠，展开后完整显示 |
| **色彩克制** | 最多 3-4 种颜色，语义明确 |
| **无冗余** | 通过 clutter audit 消除视觉噪音 |

---

## 1. 表格设计

### 1.1 工具调用结果表格

#### 1.1.1 文件列表表格

```
┌─ Read 结果 ────────────────────────────────────────────┐
│ 文件路径                    大小    修改时间            │
│ ──────────────────────────  ──────  ────────────────── │
│ src/index.ts                 2.4 KB  2 hours ago       │
│ src/utils.ts                 1.1 KB  yesterday         │
│ package.json                 340 B   3 days ago        │
│ README.md                    8.1 KB  yesterday         │
└────────────────────────────────────────────────────────┘
```

**设计规范**：

| 属性 | 规范 |
|------|------|
| **表头** | 粗体 + 下划线分隔，与数据行明确区分 |
| **列对齐** | 文本左对齐，数字右对齐，状态居中 |
| **行高** | 单行，无额外间距 |
| **截断** | 超长内容用 `…` 截断，悬停/选中时显示完整 |
| **边框** | 单线边框 `─│┌┐└┘`，圆角 `╭╮╰╯`（可选） |
| **背景** | 与主背景略有区分（深一度） |

#### 1.1.2 MCP 服务器列表表格

```
┌─ MCP Servers ──────────────────────────────────────────┐
│ 名称              状态      类型    工具数              │
│ ────────────────  ────────  ──────  ────────           │
│ • deepseek-eyes   Connected stdio   5                  │
│ • github          Connected sse     12                 │
│ ✗ slack           Failed    http    --                 │
│   └─ Error: Connection timeout                        │
│ ◦ postgres        Connecting stdio  --                 │
└────────────────────────────────────────────────────────┘
```

**状态指示器**：

| 状态 | 图标 | 颜色 | 说明 |
|------|------|------|------|
| Connected | `•` | 绿色 `#4ADE80` | 实心圆 |
| Connecting | `◦` | 黄色 `#FBBF24` | 空心圆 |
| Failed | `✗` | 红色 `#F87171` | 叉号 |
| Disabled | `○` | 灰色 `#6B7280` | 圆圈 |
| Reconnecting | `◐` | 黄色 `#FBBF24` | 半圆 |

#### 1.1.3 命令列表表格

```
┌─ Commands ─────────────────────────────────────────────┐
│ 命令              别名    功能                         │
│ ──────────────    ────    ─────────────────────────── │
│ /login            —       配置 AI 提供商               │
│ /compact          —       压缩对话历史                  │
│ /cost             —       查看 token 用量               │
│ /model            —       切换模型                      │
│ /mcp              —       MCP 服务器管理                │
│ /help             /?      显示帮助信息                  │
└────────────────────────────────────────────────────────┘
```

### 1.2 表格实现规范

#### 1.2.1 列宽计算

```javascript
/**
 * 列宽计算策略
 */
function calculateColumnWidths(columns, data, availWidth) {
  // 1. 计算每列最小宽度（表头 vs 数据最大宽度）
  const minWidths = columns.map((col, i) => {
    const headerW = displayWidth(col.header);
    const dataW = Math.max(...data.map(row => displayWidth(String(row[i] || ''))));
    return Math.max(headerW, dataW, col.minWidth || 0);
  });

  // 2. 如果总宽度 > 可用宽度，按比例压缩
  const totalW = minWidths.reduce((a, b) => a + b, 0);
  if (totalW <= availWidth) return minWidths;

  // 3. 优先压缩弹性列（flex: true 的列）
  const flexCols = columns.map((c, i) => c.flex ? i : -1).filter(i => i >= 0);
  const fixedW = minWidths.reduce((sum, w, i) => 
    sum + (columns[i].flex ? 0 : w), 0);
  const flexAvail = availWidth - fixedW;
  const flexTotal = minWidths.reduce((sum, w, i) => 
    sum + (columns[i].flex ? w : 0), 0);

  return minWidths.map((w, i) => {
    if (!columns[i].flex) return w;
    return Math.max(columns[i].minWidth || 3, 
      Math.floor(w * flexAvail / flexTotal));
  });
}
```

#### 1.2.2 行截断

```javascript
/**
 * 截断单元格内容
 */
function truncateCell(text, maxW, ellipsis = '…') {
  if (displayWidth(text) <= maxW) return text;
  // 从末尾逐个字符移除，直到宽度 <= maxW - ellipsis 宽度
  let truncated = text;
  while (displayWidth(truncated) + displayWidth(ellipsis) > maxW && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + ellipsis;
}
```

#### 1.2.3 空状态

```
┌─ MCP Servers ──────────────────────────────────────────┐
│                                                        │
│  没有配置 MCP 服务器。                                   │
│                                                        │
│  按 /mcp 添加服务器，或运行:                             │
│    khy mcp add github                                  │
│                                                        │
└────────────────────────────────────────────────────────┘
```

---

## 2. 折叠设计

### 2.1 折叠模式

#### 2.1.1 箭头折叠（Claude Code 风格）

```
▸ Thinking... (3 steps)                    ← 折叠状态（默认）

▾ Thinking...                              ← 展开状态
  │ Claude 正在分析代码结构...
  │ 识别出三个关键模块：
  │   1. 路径解析
  │   2. 工具管理
  │   3. 备份机制
```

**规范**：

| 属性 | 折叠 | 展开 |
|------|------|------|
| **箭头** | `▸`（右指） | `▾`（下指） |
| **摘要** | 显示摘要 + 计数 | 显示完整标题 |
| **内容** | 隐藏 | 显示，缩进 2 空格 |
| **背景** | 无 | 暗色/灰色背景 |
| **边框** | 无 | 可选左侧竖线 `│` |

#### 2.1.2 边框折叠（工具结果风格）

```
┌─ Read 结果 ────────────────────────────────────────────┐  ← 折叠（仅标题）
│ # CLAUDE.md — Portable 便携环境 AI 操作手册            │
│ ... (truncated, 50 more lines) ...                     │  ← 截断提示
└────────────────────────────────────────────────────────┘

┌─ Read 结果 ────────────────────────────────────────────┐  ← 展开（完整内容）
│ # CLAUDE.md — Portable 便携环境 AI 操作手册            │
│                                                        │
│ > 本文档指导任何 AI 如何维护本便携开发环境...            │
│                                                        │
│ ## 🚨 最高优先级规则                                   │
│ ...                                                    │
└────────────────────────────────────────────────────────┘
```

#### 2.1.3 内联折叠（紧凑风格）

```
🔧 Read ▸ 3 lines                          ← 折叠（显示行数）

🔧 Read                                  ← 展开
  │ 1 │ import React from 'react'
  │ 2 │ import { View } from 'ink'
  │ 3 │ export function App() {
```

### 2.2 折叠交互

| 操作 | 效果 |
|------|------|
| `Enter` | 切换折叠/展开 |
| `Space` | 切换折叠/展开 |
| `o` | 展开 |
| `x` | 折叠 |
| `z` | 切换（vim 风格） |
| `Ctrl+O` | 展开所有思考块 |
| `Ctrl+C` | 折叠所有 |

### 2.3 折叠状态机

```
                    ┌─────────┐
                    │ FOLDED  │ ← 默认状态
                    └────┬────┘
                         │
              Enter / Space / o / z
                         │
                         ▼
                    ┌─────────┐
                    │ EXPANDED │
                    └────┬────┘
                         │
              Enter / Space / x / z
                         │
                         ▼
                    ┌─────────┐
                    │ FOLDED  │
                    └─────────┘
```

### 2.4 折叠实现

```javascript
/**
 * 折叠组件
 */
function Collapsible({ 
  title,           // 标题（折叠时显示）
  summary,         // 摘要（可选，折叠时显示）
  children,        // 内容（展开时显示)
  defaultFolded = true,  // 默认折叠
  indent = 2,      // 缩进空格数
  prefix = '│',    // 内容前缀（竖线）
}) {
  const [folded, setFolded] = useState(defaultFolded);

  useInput((input, key) => {
    if (key.return || input === ' ') {
      setFolded(f => !f);
    }
    if (input === 'o') setFolded(false);
    if (input === 'x') setFolded(true);
    if (input === 'z') setFolded(f => !f);
  });

  if (folded) {
    return (
      <Box>
        <Text color="#A0A0A0">▸</Text>
        <Text> {title}</Text>
        {summary && <Text color="#6B7280"> ({summary})</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="#A0A0A0">▾</Text>
        <Text bold> {title}</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={indent}>
        {children}
      </Box>
    </Box>
  );
}
```

---

## 3. 工具调用卡片（折叠 + 表格）

### 3.1 完整设计

```
🔧 Read(src/index.js)                                    ← 卡片标题（工具名 + 参数）
  ▸ 3 lines                                              ← 折叠的结果摘要

---

🔧 Read(src/index.js)                                    ← 展开后
  ▾ 结果:
  │ 1 │ import React from 'react'
  │ 2 │ import { View } from 'ink'
  │ 3 │ export function App() {
  │ 4 │   return <View>...</View>
  │ 5 │ }
```

### 3.2 状态指示

| 状态 | 前缀 | 颜色 | 说明 |
|------|------|------|------|
| 执行中 | `◆` | 黄色 `#FBBF24` | 菱形 + spinner |
| 完成 | `✓` | 绿色 `#4ADE80` | 勾号 |
| 失败 | `✗` | 红色 `#F87171` | 叉号 |
| 等待 | `◦` | 灰色 `#6B7280` | 空心圆 |

### 3.3 参数摘要

```javascript
/**
 * 生成工具参数摘要
 */
function summarizeToolParams(name, input) {
  switch (name) {
    case 'Read':
      return truncatePath(input.file_path, 40);
    case 'Write':
      return truncatePath(input.file_path, 40);
    case 'Edit':
      return truncatePath(input.file_path, 40);
    case 'Bash':
      return truncateCommand(input.command, 40);
    case 'Grep':
      return truncateString(input.pattern, 30);
    case 'Glob':
      return input.pattern || '*';
    default:
      return JSON.stringify(input).slice(0, 40);
  }
}
```

---

## 4. Clutter Audit（视觉噪音审计）

### 4.1 审计清单

| 审计项 | 标准 | 当前状态 |
|--------|------|----------|
| **边框嵌套深度** | ≤ 1 层 | ✅ 输入框无边框 |
| **状态信号数** | ≤ 2 个/状态 | ✅ 图标 + 颜色 |
| **始终显示的标记** | 无 | ✅ 仅选中行显示 `▸` |
| **颜色数量** | ≤ 4 种 | ✅ 绿/红/黄/灰 |

### 4.2 消除噪音规则

```
❌ 禁止：[PASS] + 绿色 + ✅ + ▶ 行前缀 = 4 个信号
✅ 正确：✓ + 绿色 = 2 个信号

❌ 禁止：每行都有 ▸ 标记
✅ 正确：仅选中行有 ▸ 标记

❌ 禁止：边框内再嵌套边框
✅ 正确：单层边框或无边框
```

---

## 5. 响应式行为

### 5.1 宽度断点

| 终端宽度 | 布局 | 表格行为 |
|----------|------|----------|
| **≥ 120 列** | 主内容 + 右侧看板 | 完整显示所有列 |
| **80-119 列** | 单栏，可折叠看板 | 截断长列，优先显示关键列 |
| **60-79 列** | 单栏，无看板 | 仅显示关键列，隐藏次要列 |
| **< 60 列** | 最小布局 | 单列堆叠，隐藏表格 |

### 5.2 表格列优先级

| 列 | 优先级 | < 80 列时 |
|----|--------|-----------|
| 名称/路径 | 高 | 显示 |
| 状态 | 高 | 显示 |
| 大小 | 中 | 隐藏 |
| 修改时间 | 低 | 隐藏 |

---

## 6. 验收标准

| 场景 | 预期 |
|------|------|
| 工具结果表格 | 表头粗体，数据行对齐，截断用 `…` |
| 折叠思考块 | `▸` 折叠 / `▾` 展开，摘要显示步骤数 |
| 折叠工具结果 | 默认折叠，显示行数摘要 |
| MCP 列表 | 状态图标 + 颜色，错误显示原因 |
| 空表格 | 显示友好提示 + 操作建议 |
| 窄终端 | 隐藏次要列，关键信息保留 |
| 颜色 | 最多 4 种，语义明确 |

---

> **文档状态**：Draft — 待实施
> **创建日期**：2026-09-09
> **依赖**：[DESIGN-ARCH-081] 主设计规范
