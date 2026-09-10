# [DESIGN-ARCH-084] CC 模式注意力与选择设计

> **定位**：定义 CC 模式下强注意力引导、焦点管理、选择交互的设计规范。
> **适用边界**：工具调用卡片、MCP 列表、帮助菜单、权限提示、补全菜单等需要用户交互的组件。
> **参考来源**：`interaction-patterns.md` (Focus, Selection, Mouse) + `exemplar-apps.md` (Claude Code) + `visual-patterns.md` (Hierarchy)

---

## 0. 设计原则

| 原则 | 说明 |
|------|------|
| **焦点可见** | 当前焦点必须始终可见，无歧义 |
| **选择明确** | 选中项与未选中项有明确视觉区分 |
| **注意力克制** | 不强求用户注意，只在需要时引导 |
| **键盘优先** | 所有操作键盘可达，鼠标是增强 |
| **渐进披露** | 复杂操作分步呈现，不一次性轰炸 |

---

## 1. 注意力引导层级

### 1.1 注意力信号强度排序

| 强度 | 信号 | 使用场景 |
|------|------|----------|
| **1（最强）** | 边框颜色变化 | 焦点面板切换 |
| **2** | 反显（reverse video） | 当前选中行 |
| **3** | 粗体 + 强调色 | 标题、重要信息 |
| **4** | 符号前缀 `▸` `●` `◆` | 状态指示 |
| **5** | 颜色（绿/红/黄） | 状态语义 |
| **6（最弱）** | 缩进 + 竖线 `│` | 层级关系 |

### 1.2 组合使用规则

```
❌ 禁止：同时使用 4+ 个信号表示同一状态
✅ 正确：边框颜色(1) + 反显(2) = 焦点面板
✅ 正确：符号(4) + 颜色(5) = 状态指示
✅ 正确：粗体(3) + 颜色(5) = 重要信息
```

---

## 2. 焦点管理

### 2.1 焦点指示器

#### 2.1.1 边框颜色变化（最强信号）

```
┌─ 对话区 ─────────────────────────────────────────────┐  ← 无焦点（灰色边框）
│                                                      │
└──────────────────────────────────────────────────────┘

╔═ 对话区 ═════════════════════════════════════════════╗  ← 有焦点（青色边框）
│                                                      │
╚══════════════════════════════════════════════════════╝
```

| 状态 | 边框样式 | 颜色 |
|------|----------|------|
| **无焦点** | 单线 `─│┌┐└┘` | 灰色 `#374151` |
| **有焦点** | 双线 `═║╔╗╚╝` | 青色 `#00D4D4` |
| **警告** | 单线 | 黄色 `#FBBF24` |
| **错误** | 单线 | 红色 `#F87171` |

#### 2.1.2 反显选择（标准信号）

```
  普通行：  白色文字，默认背景
  选中行：  黑色文字，青色背景（反显）
```

```javascript
// 反显实现
function SelectedRow({ children }) {
  return (
    <Box backgroundColor="#00D4D4">
      <Text color="#000000">{children}</Text>
    </Box>
  );
}
```

#### 2.1.3 符号前缀（辅助信号）

| 符号 | 含义 | 颜色 |
|------|------|------|
| `▸` | 当前选中项 | 青色 `#00D4D4` |
| `●` | 已连接/活跃 | 绿色 `#4ADE80` |
| `○` | 未连接/非活跃 | 灰色 `#6B7280` |
| `◆` | 执行中 | 黄色 `#FBBF24` |
| `✓` | 完成 | 绿色 `#4ADE80` |
| `✗` | 失败 | 红色 `#F87171` |

### 2.2 焦点导航

| 方法 | 适用场景 | 实现 |
|------|----------|------|
| **Tab / Shift+Tab** | 2-3 个面板 | 线性循环 |
| **数字键 1-9** | 5+ 个面板 | 直接跳转 |
| **鼠标点击** | 增强 | 聚焦面板 |
| **Esc** | 退出当前焦点 | 返回上一层 |

### 2.3 焦点陷阱

```
模态对话框：Tab 在对话框内循环，不跳出
输入框：   字符输入时，不触发全局快捷键
补全菜单： ↑↓ 导航选项，Esc 关闭
```

---

## 3. 选择设计

### 3.1 单选列表

#### 3.1.1 模型选择器

```
  模型列表：

    Claude Sonet 4
  ▸ Claude Opus 4                                    ← 当前选中（▸ + 反显）
    Claude Haiku 4.5
    GPT-4o
    GPT-4o-mini
    o1-preview

  ↑/↓ navigate  Enter select  Esc cancel
```

**设计规范**：

| 属性 | 规范 |
|------|------|
| **选中指示** | `▸` 前缀 + 反显背景 |
| **悬停效果** | 无（终端不支持） |
| **滚动** | 超出显示区域时滚动，保持选中项可见 |
| **过滤** | 输入字符实时过滤列表 |

#### 3.1.2 实现

```javascript
function SelectableList({ items, selectedIndex, onSelect, onCancel }) {
  const [filter, setFilter] = useState('');
  const filtered = items.filter(i => i.label.toLowerCase().includes(filter.toLowerCase()));

  useInput((input, key) => {
    if (key.upArrow) onSelect(Math.max(0, selectedIndex - 1));
    if (key.downArrow) onSelect(Math.min(filtered.length - 1, selectedIndex + 1));
    if (key.return) onSelect(selectedIndex, true); // confirm
    if (key.escape) onCancel();
    if (input && !key.ctrl) setFilter(f => f + input);
    if (key.backspace) setFilter(f => f.slice(0, -1));
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="#00D4D4" padding={1}>
      <Text bold color="#00D4D4">选择模型：</Text>
      <Box height={1} />
      {filtered.map((item, i) => (
        <Box key={i}>
          {i === selectedIndex ? (
            <Text backgroundColor="#00D4D4" color="#000000">▸ {item.label}</Text>
          ) : (
            <Text>  {item.label}</Text>
          )}
        </Box>
      ))}
      <Box height={1} />
      <Text color="#6B7280" dimColor>↑/↓ navigate  Enter select  Esc cancel</Text>
    </Box>
  );
}
```

### 3.2 多选列表

#### 3.2.1 功能选择

```
  选择功能：

  [x] Authentication                                ← 已选中
  [ ] Database migrations                           ← 未选中
  [x] Logging
  [ ] Monitoring
  [x] Docker support

  Space toggle  Enter confirm  Esc cancel
```

**设计规范**：

| 操作 | 效果 |
|------|------|
| `Space` | 切换当前行的选中状态 |
| `Enter` | 确认选择 |
| `Esc` | 取消 |
| `Ctrl+A` | 全选（备选） |
| `*` | 反选 |

### 3.3 权限提示选择

#### 3.3.1 工具执行确认

```
┌─ 权限请求 ─────────────────────────────────────────────┐
│                                                        │
│  Do you want to proceed?                               │
│                                                        │
│  ❯ Yes, proceed                                        │
│    No, reject                                          │
│    Always allow                                        │
│                                                        │
│  Esc to cancel · Tab to amend                          │
└────────────────────────────────────────────────────────┘
```

**设计规范**：

| 属性 | 规范 |
|------|------|
| **默认焦点** | 最安全的选项（No/Cancel） |
| **危险操作** | 红色高亮，非默认焦点 |
| **键盘导航** | `↑/↓` 或 `Tab` |
| **确认** | `Enter` |
| **取消** | `Esc` |

---

## 4. 强注意力组件

### 4.1 错误/警告提示

#### 4.1.1 错误横幅

```
╔═ 错误 ════════════════════════════════════════════════╗
║                                                        ║
║  ❌ 工具执行失败                                        ║
║                                                        ║
║  [Read 错误] 文件不存在：D:\Portable\nonexistent.txt    ║
║                                                        ║
║  建议：                                                 ║
║  - 检查文件路径是否正确                                  ║
║  - 使用 Glob 工具搜索文件位置                            ║
║                                                        ║
║  Esc to dismiss                                         ║
╚════════════════════════════════════════════════════════╝
```

**设计规范**：

| 类型 | 边框颜色 | 图标 | 背景 |
|------|----------|------|------|
| **错误** | 红色 `#F87171` | `❌` | 深红 `#3D0F0F` |
| **警告** | 黄色 `#FBBF24` | `⚠️` | 深黄 `#3D300F` |
| **信息** | 蓝色 `#58A6FF` | `ℹ️` | 深蓝 `#0F1A3D` |
| **成功** | 绿色 `#4ADE80` | `✅` | 深绿 `#0F3D1A` |

### 4.2 加载状态

#### 4.2.1 Spinner + 消息

```
⠋ AI is thinking...                                  ← 旋转 spinner + 消息
```

#### 4.2.2 进度条

```
  上传文件... [████████░░░░░░░░░░░░] 40%               ← 进度条 + 百分比
```

### 4.3 工具执行状态

```
◆ Read(src/index.js)                                  ← 执行中（黄色 ◆ + spinner）
✓ Read(src/index.js)                                  ← 完成（绿色 ✓）
✗ Bash(npm test)                                      ← 失败（红色 ✗）
```

---

## 5. 鼠标支持

### 5.1 支持的操作

| 操作 | 支持 | 说明 |
|------|------|------|
| **点击面板聚焦** | ✅ | 增强，非必需 |
| **点击标签切换** | ✅ | 增强，非必需 |
| **滚动列表** | ✅ | 滚轮支持 |
| **点击按钮** | ✅ | 表单按钮 |
| **拖拽调整** | ❌ | 复杂度高，暂不支持 |

### 5.2 鼠标协议

```javascript
// 启用鼠标支持
process.stdout.write('\x1B[?1000h');  // 启用鼠标跟踪
process.stdout.write('\x1B[?1002h');  // 启用拖拽跟踪
process.stdout.write('\x1B[?1006h');  // 启用 SGR 坐标格式

// 禁用鼠标支持
process.stdout.write('\x1B[?1006l');
process.stdout.write('\x1B[?1002l');
process.stdout.write('\x1B[?1000l');
```

### 5.3 Shift 绕过

```
当鼠标捕获开启时：
- 普通点击/拖拽 → 应用处理
- Shift + 点击/拖拽 → 终端原生文本选择
```

---

## 6. 实现架构

### 6.1 焦点上下文

```javascript
// tui/context/FocusContext.js

const FocusContext = createContext({
  focusedPanel: 'input',      // 当前焦点面板
  setFocusedPanel: () => {},
  trapFocus: false,            // 是否捕获焦点
  focusStack: [],              // 焦点栈（用于模态对话框）
});

function FocusProvider({ children }) {
  const [state, setState] = useState({
    focusedPanel: 'input',
    trapFocus: false,
    focusStack: [],
  });

  const setFocusedPanel = useCallback((panel) => {
    setState(s => ({ ...s, focusedPanel: panel }));
  }, []);

  const pushFocus = useCallback((panel) => {
    setState(s => ({
      ...s,
      focusStack: [...s.focusStack, s.focusedPanel],
      focusedPanel: panel,
      trapFocus: true,
    }));
  }, []);

  const popFocus = useCallback(() => {
    setState(s => {
      const stack = [...s.focusStack];
      const prev = stack.pop() || 'input';
      return {
        ...s,
        focusStack: stack,
        focusedPanel: prev,
        trapFocus: stack.length > 0,
      };
    });
  }, []);

  return (
    <FocusContext.Provider value={{ ...state, setFocusedPanel, pushFocus, popFocus }}>
      {children}
    </FocusContext.Provider>
  );
}
```

### 6.2 选择状态管理

```javascript
// tui/hooks/useSelection.js

function useSelection(items, multiSelect = false) {
  const [selected, setSelected] = useState(multiSelect ? new Set() : -1);

  const select = useCallback((index) => {
    if (multiSelect) {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
    } else {
      setSelected(index);
    }
  }, [multiSelect]);

  const clear = useCallback(() => {
    setSelected(multiSelect ? new Set() : -1);
  }, [multiSelect]);

  return { selected, select, clear };
}
```

---

## 7. 验收标准

| 场景 | 预期 |
|------|------|
| 焦点切换 | 边框颜色变化，明确可见 |
| 选中行 | 反显背景 + `▸` 前缀 |
| 模态对话框 | 焦点陷阱，Tab 不跳出 |
| 错误提示 | 红色边框 + 图标 + 建议 |
| 加载状态 | Spinner + 消息 |
| 鼠标点击 | 聚焦面板，滚动列表 |
| Shift+点击 | 终端原生文本选择 |
| 权限提示 | 默认安全选项，危险操作红色 |

---

> **文档状态**：Draft — 待实施
> **创建日期**：2026-09-09
> **依赖**：[DESIGN-ARCH-081] 主设计规范
