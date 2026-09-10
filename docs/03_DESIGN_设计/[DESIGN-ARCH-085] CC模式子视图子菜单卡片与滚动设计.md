# [DESIGN-ARCH-085] CC 模式子视图、子菜单、卡片与滚动设计

> **定位**：定义 CC 模式下子视图（Agent）、子菜单、卡片、滚动/复制/历史的设计规范。
> **适用边界**：Agent 面板、命令面板、工具卡片、消息历史、滚动交互。
> **参考来源**：`advanced-patterns.md` (View Stack, History, Clipboard) + `interaction-patterns.md` (fzf, OSC) + `exemplar-apps.md` (Claude Code)

---

## 0. 设计原则

| 原则 | 说明 |
|------|------|
| **视图隔离** | 子视图不影响主对话流 |
| **渐进披露** | 复杂操作分步呈现 |
| **滚动独立** | 滚动/复制/历史互不干扰 |
| **上下文保持** | 切换视图后恢复位置和状态 |
| **键盘优先** | 所有操作键盘可达 |

---

## 1. Agent 子视图设计

### 1.1 视图栈模型

```
主对话视图（根）
  ├─ Agent 列表视图
  │   ├─ Agent 详情视图
  │   │   └─ Agent 执行日志
  │   └─ Agent 配置视图
  ├─ MCP 管理视图
  │   ├─ MCP 服务器列表
  │   └─ MCP 服务器详情
  └─ 设置视图
      ├─ 模型设置
      └─ 权限设置
```

### 1.2 视图状态管理

```javascript
// tui/context/ViewContext.js

function ViewProvider({ children }) {
  const [viewStack, setViewStack] = useState(['main']); // 视图栈
  const [viewState, setViewState] = useState({});        // 每视图状态缓存

  const currentView = viewStack[viewStack.length - 1];

  const pushView = useCallback((viewId, initialState = {}) => {
    setViewStack(s => [...s, viewId]);
    setViewState(s => ({ ...s, [viewId]: initialState }));
  }, []);

  const popView = useCallback(() => {
    if (viewStack.length <= 1) return; // 主视图不能弹出
    setViewStack(s => s.slice(0, -1));
  }, [viewStack]);

  const replaceView = useCallback((viewId) => {
    setViewStack(s => [...s.slice(0, -1), viewId]);
  }, []);

  return (
    <ViewContext.Provider value={{
      currentView,
      viewStack,
      viewState,
      pushView,
      popView,
      replaceView,
    }}>
      {children}
    </ViewContext.Provider>
  );
}
```

### 1.3 Agent 列表视图

```
┌─ Agents ───────────────────────────────────────────────┐
│                                                        │
│  ▸ main          idle     Khy v1.0.0                   │
│    code-review   running  Analyzing src/index.ts        │
│    test-runner   done     ✓ 42 tests passed            │
│    deploy        failed   ✗ Connection timeout         │
│                                                        │
├────────────────────────────────────────────────────────┤
│ 1-9: jump  Enter: focus  n: new  d: delete  Esc: back  │
└────────────────────────────────────────────────────────┘
```

### 1.4 Agent 详情视图（分屏）

```
┌─ Agent: code-review ────────────┬─ Logs ───────────────┐
│                                 │                       │
│  Status: running                │  12:34:05 Starting...  │
│  Model: Sonnet 4                │  12:34:06 Reading...   │
│  Started: 2 min ago             │  12:34:07 Analyzing... │
│  Tokens: 1,245 / 200k           │  12:34:08 Found 3...   │
│                                 │  12:34:09 ...          │
│  Task:                          │                       │
│  Review src/index.ts for        │                       │
│  security issues                │                       │
│                                 │                       │
│  [Stop]  [Restart]  [Config]    │                       │
│                                 │                       │
├─────────────────────────────────┴───────────────────────┤
│ Esc: back  Tab: switch panel  Ctrl+C: stop agent       │
└───────────────────────────────────────────────────────┘
```

---

## 2. 子菜单设计

### 2.1 命令面板（Ctrl+P）

```
┌─ Command Palette ──────────────────────────────────────┐
│ > model                                               │ ← 搜索输入
├────────────────────────────────────────────────────────┤
│ Model & Provider                                       │
│   /model                Switch AI model                │
│   /login                Configure provider             │
│   /status               Gateway status                 │
│                                                        │
│ Session                                                │
│   /clear                Clear conversation             │
│   /compact              Compress context               │
│   /cost                 Token usage                    │
│                                                        │
│ Tools                                                  │
│   /mcp                  MCP server management          │
│   /agents               Agent management               │
│   /goal                 Set goal                       │
│                                                        │
│ Help                                                   │
│   /help                 Show help                      │
│   /doctor               System health                  │
└────────────────────────────────────────────────────────┘
```

### 2.2 子菜单交互

| 操作 | 效果 |
|------|------|
| `Ctrl+P` | 打开命令面板 |
| 输入字符 | 实时过滤命令 |
| `↑/↓` | 导航命令 |
| `Enter` | 执行选中命令 |
| `Esc` | 关闭面板 |
| `1-9` | 跳转到分组 |

### 2.3 嵌套子菜单

```
/model →
  ├─ Claude Sonnet 4        ← 当前使用（✓）
  ├─ Claude Opus 4
  ├─ Claude Haiku 4.5
  ├─ GPT-4o
  ├─ GPT-4o-mini
  ├─ o1-preview
  └─ o1-mini

/mcp →
  ├─ List servers
  ├─ Add server
  ├─ Remove server
  └─ Configure server
```

---

## 3. 卡片设计

### 3.1 工具调用卡片

```
┌─ 🔧 Read ──────────────────────────────────────────────┐
│ file_path: src/index.ts                                │
│                                                        │
│ ▸ 5 lines                                              │
│                                                        │
│ Status: ✓ done                                         │
└────────────────────────────────────────────────────────┘

┌─ 🔧 Read ──────────────────────────────────────────────┐
│ file_path: src/index.ts                                │
│                                                        │
│ ▾ 结果:                                                │
│   │ 1 │ import React from 'react'                      │
│   │ 2 │ import { View } from 'ink'                     │
│   │ 3 │ export function App() {                       │
│   │ 4 │   return <View>...</View>                     │
│   │ 5 │ }                                             │
│                                                        │
│ Status: ✓ done                                         │
└────────────────────────────────────────────────────────┘
```

### 3.2 信息卡片

```
┌─ 📊 Session Stats ─────────────────────────────────────┐
│                                                        │
│  Tokens:  12,456 / 200,000 (6%)                        │
│  Cost:    $0.42                                        │
│  Messages: 23                                          │
│  Tools:   8 calls                                      │
│  Duration: 15 min                                      │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### 3.3 卡片设计规范

| 属性 | 规范 |
|------|------|
| **边框** | 单线 `─│┌┐└┘`，圆角可选 |
| **标题** | 图标 + 名称，粗体 |
| **内容** | 缩进 2 空格 |
| **折叠** | `▸` 折叠 / `▾` 展开 |
| **状态** | 右下角显示状态 |
| **最大宽度** | 80 列或终端宽度 |

---

## 4. 滚动/复制/历史设计

### 4.1 滚动设计（不影响选择和复制）

#### 4.1.1 滚动模式分离

| 模式 | 触发 | 行为 |
|------|------|------|
| **浏览模式** | 默认 | `↑/↓` 浏览历史，`PageUp/PageDown` 滚动 |
| **选择模式** | `v` 进入 | `↑/↓` 选择文本，`Space` 标记 |
| **复制模式** | `c` 进入 | 选择后 `y` 复制 |

#### 4.1.2 滚动实现（Claude Code 风格）

```
对话区（可滚动）：
  ┌─────────────────────────────────────────────────────┐
  │ ▸ 消息 1                                            │  ← 可见区域顶部
  │   消息 2                                            │
  │   消息 3                                            │
  │   消息 4                                            │
  │   消息 5                                            │  ← 可见区域底部
  └─────────────────────────────────────────────────────┘
  
  滚动指示器：
  ⋯ (3 above)        ← 上方有 3 条消息
  ⋯ (5 below)        ← 下方有 5 条消息
```

### 4.2 复制设计

#### 4.2.1 复制方式

| 操作 | 效果 | 反馈 |
|------|------|------|
| `c` | 复制当前选中内容 | `copied 42 bytes` |
| `C` | 复制整行/整段 | `copied 1 line` |
| `Ctrl+C` | 中断操作 | — |
| `Ctrl+Shift+C` | 复制到剪贴板 | `copied` |

#### 4.2.2 复制实现（OSC 52）

```javascript
// tui/utils/ccClipboard.js

'use strict';

/**
 * 剪贴板工具 — 使用 OSC 52 协议
 * 支持 SSH 和本地环境
 */

const OSC_52 = '\x1B]52;c;';
const ST = '\x07';

/**
 * 复制到剪贴板
 * @param {string} text
 */
function copyToClipboard(text) {
  if (!text) return false;

  try {
    // Base64 编码
    const base64 = Buffer.from(text, 'utf8').toString('base64');
    // 发送 OSC 52 序列
    process.stdout.write(OSC_52 + base64 + ST);
    return true;
  } catch {
    // Fallback: 尝试使用系统命令
    try {
      const { execSync } = require('child_process');
      const platform = process.platform;
      if (platform === 'darwin') {
        execSync('pbcopy', { input: text });
      } else if (platform === 'linux') {
        execSync('xclip -selection clipboard', { input: text });
      } else if (platform === 'win32') {
        execSync('clip', { input: text });
      }
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { copyToClipboard };
```

### 4.3 历史回溯设计

#### 4.3.1 输入历史

| 操作 | 效果 |
|------|------|
| `↑` | 上一条历史输入 |
| `↓` | 下一条历史输入 |
| `Ctrl+R` | 反向搜索历史 |

#### 4.3.2 历史持久化

```javascript
// tui/utils/ccHistory.js

'use strict';

/**
 * 输入历史管理
 * 持久化到 ~/.khyquant/.khy_history
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HISTORY_FILE = path.join(os.homedir(), '.khyquant', '.khy_history');
const MAX_HISTORY = 100;

let _cache = null;

function loadHistory() {
  if (_cache) return _cache;
  try {
    const text = fs.readFileSync(HISTORY_FILE, 'utf8');
    _cache = text.split('\n').filter(Boolean).slice(-MAX_HISTORY);
  } catch {
    _cache = [];
  }
  return _cache;
}

function saveHistory(history) {
  _cache = history.slice(-MAX_HISTORY);
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, _cache.join('\n') + '\n');
  } catch {
    // fail-soft
  }
}

function addHistory(entry) {
  if (!entry || !entry.trim()) return;
  const history = loadHistory();
  // 去重：如果最后一条相同则不添加
  if (history[history.length - 1] === entry) return;
  history.push(entry);
  saveHistory(history);
}

function searchHistory(query) {
  const history = loadHistory();
  if (!query) return history;
  const q = query.toLowerCase();
  return history.filter(h => h.toLowerCase().includes(q));
}

module.exports = { loadHistory, addHistory, searchHistory };
```

#### 4.3.3 历史搜索界面

```
┌─ History Search ───────────────────────────────────────┐
│ > model                                               │ ← 搜索输入
├────────────────────────────────────────────────────────┤
│   /model claude-opus-4                                │
│   /model gpt-4o                                       │
│   /login                                              │
│   /mcp list                                           │
│   /compact                                            │
│                                                        │
│   5 matches                                           │
└────────────────────────────────────────────────────────┘
```

---

## 5. Resume 设计（完成后恢复）

### 5.1 完成状态显示

```
┌─ Task Complete ────────────────────────────────────────┐
│                                                        │
│  ✓ 任务完成                                            │
│                                                        │
│  摘要：                                                │
│  - 修改了 3 个文件                                     │
│  - 运行了 42 个测试                                    │
│  - 生成了 1 个提交                                     │
│                                                        │
│  耗时：2m 34s                                          │
│  Token：12,456                                         │
│  费用：$0.42                                           │
│                                                        │
│  [Continue]  [Review]  [New Task]                      │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### 5.2 Resume 交互

| 操作 | 效果 |
|------|------|
| `Enter` | 继续对话（默认） |
| `r` | 查看执行详情 |
| `n` | 新建任务 |
| `Esc` | 关闭面板 |

### 5.3 子命令完成后的恢复

```
> /model gpt-4o

✓ 模型已切换到 GPT-4o

  按 Enter 继续对话，或输入 /help 查看可用命令
```

---

## 6. 实现架构

### 6.1 视图路由

```javascript
// tui/views/ViewRouter.js

const VIEWS = {
  main: MainView,
  agents: AgentListView,
  agentDetail: AgentDetailView,
  mcpList: McpListView,
  mcpDetail: McpDetailView,
  settings: SettingsView,
  help: HelpView,
  commandPalette: CommandPalette,
};

function ViewRouter({ viewId }) {
  const View = VIEWS[viewId] || MainView;
  return <View />;
}
```

### 6.2 滚动状态管理

```javascript
// tui/hooks/useScroll.js

function useScroll(itemCount, visibleCount) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [cursor, setCursor] = useState(0);

  // 确保 cursor 在可见范围内
  useEffect(() => {
    if (cursor < scrollOffset) {
      setScrollOffset(cursor);
    } else if (cursor >= scrollOffset + visibleCount) {
      setScrollOffset(cursor - visibleCount + 1);
    }
  }, [cursor, scrollOffset, visibleCount]);

  const scrollUp = useCallback(() => {
    setScrollOffset(s => Math.max(0, s - 1));
  }, []);

  const scrollDown = useCallback(() => {
    setScrollOffset(s => Math.min(itemCount - visibleCount, s + 1));
  }, [itemCount, visibleCount]);

  const moveCursor = useCallback((delta) => {
    setCursor(c => Math.max(0, Math.min(itemCount - 1, c + delta)));
  }, [itemCount]);

  return {
    scrollOffset,
    cursor,
    visibleItems: Math.min(visibleCount, itemCount - scrollOffset),
    scrollUp,
    scrollDown,
    moveCursor,
    setCursor,
  };
}
```

---

## 7. 验收标准

| 场景 | 预期 |
|------|------|
| Agent 列表 | 显示所有 Agent 状态，数字键跳转 |
| Agent 详情 | 分屏显示详情和日志 |
| 命令面板 | Ctrl+P 打开，实时过滤 |
| 子菜单 | 嵌套导航，Esc 返回 |
| 工具卡片 | 可折叠，状态清晰 |
| 信息卡片 | 数据对齐，易读 |
| 滚动 | 浏览时不影响选择 |
| 复制 | OSC 52 + fallback，有反馈 |
| 历史 | ↑↓ 浏览，Ctrl+R 搜索 |
| Resume | 完成后显示摘要，Enter 继续 |

---

> **文档状态**：Draft — 待实施
> **创建日期**：2026-09-09
> **依赖**：[DESIGN-ARCH-081] 主设计规范
