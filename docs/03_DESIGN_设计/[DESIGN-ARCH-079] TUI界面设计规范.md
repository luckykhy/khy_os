# [DESIGN-ARCH-079] khy-os TUI 界面设计规范

> **定位**：定义 khy-os 终端用户界面（TUI）的视觉布局、组件尺寸、交互行为与环境变量配置的**唯一权威规范**。
> **适用边界**：覆盖 Ink TUI 的全部渲染路径（legacy 单栏 + three-column 三栏 + right-rail 右栏带外绘制）；不替代 `[DESIGN-ARCH-016]`（AI Agent 显示规范）、`[DESIGN-ARCH-078]`（桌面端互联方案）——冲突时以各单一真源为准。
> **设计原则**：输入框永远固定在底部；右栏看板仅在终端宽度足够时显示；滚动条仅在内容溢出时出现；一切尺寸可通过环境变量覆盖。

---

## 0. 术语表

| 术语 | 含义 |
|------|------|
| **Legacy 模式** | 单栏全宽布局，`ThreeColumnLayout` 未激活时的默认路径 |
| **Three-Column 模式** | 三栏布局：左侧会话列表 \| 中间聊天区 \| 右侧标签面板 |
| **Right-Rail 模式** | 右栏看板通过带外 ANSI 绝对坐标绘制（不占 ink 行），默认开启 |
| **PromptFrame** | 底部输入框组件，带边框 + 光标 + 多行折叠 |
| **SidebarPanel** | 右侧任务看板面板（in-tree 版本，rail 关闭时使用） |
| **FooterBar** | 底部状态栏（模型/精度/上下文/权限/桥接/目标） |
| **Topbar** | 顶部标题栏（macOS 风格交通灯 + 标题） |
| **Statusbar** | 三栏模式下的底部状态栏（替代 FooterBar） |
| **Viewport** | 有界视口，消息区内滚动不带动输入框（Bubble Tea 范式） |

---

## 1. 整体布局架构

### 1.1 两种布局路径

khy-os TUI 存在两条**并行**的渲染路径，由 `App.js` 的 `threeColumnMode` 标志选择：

```
路径 A (Legacy):  单栏全宽
┌─────────────────────────────────────────┐
│  Topbar (macOS 交通灯 + 标题)            │  ← height: 1 row
├─────────────────────────────────────────┤
│                                         │
│  Static 区 (已提交消息, scrollback)       │  ← flexGrow: 1
│  Live 区 (流式输出 + 工具卡片 + spinner)  │
│  TaskListPanel (全宽任务清单, Ctrl+T)     │
│  CompletionMenu (斜杠补全, 浮层)          │
│  PromptFrame (输入框, 固定底部)           │  ← height: 自适应 (4~maxRows)
│                                         │
├─────────────────────────────────────────┤
│  FooterBar (状态栏)                      │  ← height: 2 rows
└─────────────────────────────────────────┘

路径 B (Three-Column): 三栏布局
┌──────┬──────────────────────┬──────────┐
│ Topbar (跨三栏)                              │  ← height: 1 row
├──────┼──────────────────────┼──────────┤
│      │                      │          │
│ 会话  │   ChatColumn          │ RightPanel│
│ 侧栏  │   (Static+Live+      │ (计划/    │
│      │    PromptFrame)       │  任务/    │  ← flexGrow: 1
│      │                      │  终端/    │
│      │                      │  文件)    │
├──────┼──────────────────────┼──────────┤
│ Statusbar (跨三栏)                          │  ← height: 1 row
└──────┴──────────────────────┴──────────┘
```

### 1.2 Right-Rail 带外绘制（默认开启）

当终端宽度 ≥ 120 列时，右栏看板通过 ANSI 绝对坐标**带外绘制**（out-of-band paint），不占用 ink 的任何行：

```
┌─────────────────────────────┬──────────┐
│ Topbar                                │  ← row 1
├─────────────────────────────┤          │
│                             │          │
│  ink 渲染区域               │  看板     │  ← rows 2..(R-chrome-1)
│  (Transcript + Streaming    │  (带外    │
│   + PromptFrame)            │  绝对坐标 │
│                             │  绘制)    │
│                             │          │
├─────────────────────────────┤          │
│ FooterBar                             │  ← rows (R-1)..R
└─────────────────────────────┴──────────┘
  ← cols - railWidth →  ← railWidth →
```

**关键约束**：
- ink 永远不写入最右侧 `railWidth` 列（由 `contentCols()` 保证）
- 看板底边与 FooterBar 顶边对齐（`railBottomChrome` 计算）
- 看板顶边由内容高度决定（`railGeometry` 的 bottom-anchor 模式）

---

## 2. 组件尺寸规范

### 2.1 顶层区域（自顶向下）

| # | 区域 | 组件 | 高度 | 宽度 | 可见条件 |
|---|------|------|------|------|----------|
| ① | BANNER | WelcomeBanner | 7~9 rows (启动时) → 0 (提交后变透明占位) | 全宽 | 仅首轮，提交后消失 |
| ② | MAIN | 左列主区 | `minHeight: 6` (regionLayout.MAIN_MIN_HEIGHT) | `cols - railWidth` (rail开) 或 全宽 | 始终可见 |
| ③ | SIDEBAR | SidebarPanel / RightPanel | `stableRows` 或 `fillRows` | `sidebarWidth(cols)` 默认 30 | 宽终端 + 会话最大尺寸 |
| ④ | TASK_PANEL | TaskListPanel | 内容自适应 (0~N rows) | 全宽 | 有任务 + Ctrl+T 未隐藏 |
| ⑤ | COMPLETION_MENU | CompletionMenu | 内容自适应 | 内容自适应 | 补全激活时 |
| ⑥ | PROMPT | PromptFrame | `4 ~ vrows-10` (自适应) | `cols - 1` (anti-spill slack) | 未被覆盖层隐藏 |
| ⑦ | FOOTER | FooterBar | `2 rows` (固定) | 全宽 | 未被覆盖层隐藏 |
| ⑧ | STATUS_AREA | (预留) | `5 rows` (预留) | 全宽 | 预留扩展 |
| ⑨ | OVERLAY | 各覆盖层 | 全屏 | 全屏 | 按需挂载 |

### 2.2 PromptFrame（输入框）详细规范

```
┌───────────────────────────────────────────────────────┐  ← 顶边框 (cyan/busy色)
│❯ _placeholder_                                        │  ← 首行: "> " 标记 (绿色粗体) + 光标/占位符
│  续行内容...                                          │  ← 续行: "  " 标记 (dim) + 文本
│  ⋯ 上方还有 N 行（输入已折叠，内容未丢失）             │  ← 折叠标记 (超过 maxRows 时)
├───────────────────────────────────────────────────────┤  ← 底边框 (同顶边框色)
```

**尺寸计算**：
- **宽度**：`cols - 1`（留 1 列 slack 防止 pending-wrap 导致行数不一致）
- **最小高度**：4 rows
- **最大高度**：`vrows - 10`（vrows = `process.stdout.rows || 24`）
- **可用文本宽度**：`cols - MARKER_W(2) - 2`（标记 2 列 + 光标 + margin）
- **折叠触发**：wrapped 行数 > maxRows 时，以光标为中心窗口化显示

**边框行为**：
- 空闲态：cyan 色边框
- 忙碌态：dim 色边框
- 覆盖层激活时：整个 PromptFrame 隐藏

**MIC 按钮**（语音输入）：
- 位置：顶边框左端，替换前 5 列
- 尺寸：` MIC ` (5 列)
- 空闲态：cyan 文字
- 悬停态：白底黑字
- 听写态：品红底白字

### 2.3 RightPanel（右侧面板，三栏模式）

```
┌──────────────────────────────┐
│ 计划 │ 任务 │ 终端 │ 文件     │  ← 标签栏 (height: 1 row)
├──────────────────────────────┤
│                              │
│  标签内容区域                 │  ← flexGrow: 1, paddingX: 1
│  (可滚动, viewportHeight)    │
│                              │
├──────────────────────────────┤
│  ↑↓ 1-10/25                  │  ← 滚动指示器 (仅可滚动时)
└──────────────────────────────┘
```

**尺寸**：
- **宽度**：30 columns（固定）
- **高度**：100%（填满父容器）
- **标签栏**：1 row
- **滚动指示器**：1 row（仅 `maxScroll > 0` 时显示）

**标签定义**：
| Key | 标签 | 说明 |
|-----|------|------|
| `plan` | 计划 | 计划步骤进度 |
| `tasks` | 任务 | 待办树形列表 |
| `terminal` | 终端 | 终端输出 |
| `files` | 文件 | 项目文件树 |

**颜色方案**：
- 活动标签：`#6a92d8`（蓝色），bold + underline
- 非活动标签：`#a8a7a0`（灰色）
- 背景：`#20201e`
- 边框：`#34332f`（非聚焦）/ `#6a92d8`（聚焦）

### 2.4 SessionSidebar（会话侧栏，三栏模式）

**尺寸**：
- **宽度**：22 columns（固定）
- **高度**：100%（填满父容器）
- **背景**：`#161b22`

### 2.5 Topbar（标题栏）

**尺寸**：
- **高度**：1 row（固定）
- **宽度**：100%
- **背景**：`#161b22`
- **内容**：`● ● ●  KhyOS Desktop`（macOS 风格交通灯 + 标题）

**颜色**：
- 红点：`#ff5f57`
- 黄点：`#febc2e`
- 绿点：`#28c840`
- 标题文字：`#8b949e`

### 2.6 FooterBar / Statusbar（状态栏）

**FooterBar（Legacy 模式）**：
- **高度**：2 rows（固定）
- **第 1 行**：权限模式 + 模型名 + 精度 + 上下文百分比 + 目标指示器
- **第 2 行**：Token 用量 + 桥接状态 + 快捷键提示

**Statusbar（三栏模式）**：
- **高度**：1 row（固定）
- **背景**：`#20201e`
- **内容**：`● 后端已连接  模型名  工作目录  Token XX%`

---

## 3. 右栏看板（Right-Rail）详细规范

### 3.1 激活条件

| 条件 | 默认值 | 环境变量 | 说明 |
|------|--------|----------|------|
| 总开关 | ON | `KHY_SIDEBAR=0` 关闭 | 关闭后退化为 Legacy 树内看板 |
| Rail 开关 | ON | `KHY_SIDEBAR_RAIL=0` 关闭 | 关闭后退化为 in-tree SidebarPanel |
| 最小列宽 | 120 cols | `KHY_SIDEBAR_MIN_COLS` | 低于此值不显示 |
| 最小行高 | 24 rows | `KHY_SIDEBAR_MIN_ROWS` | 会话最大尺寸门槛 |
| 全屏判定 | 容差 2 | `KHY_SIDEBAR_FULLSCREEN_TOL` | 当前尺寸 ≈ 会话最大尺寸 |
| 字体缩放容差 | 0.15 | `KHY_SIDEBAR_ZOOM_TOL` | Ctrl+wheel 缩放不翻转判定 |
| 激活迟滞 | 2 cols | `KHY_SIDEBAR_HYSTERESIS` | 防止阈值边界抖动 |
| 未知尺寸回退 | 80 cols | `KHY_SIDEBAR_MIN_COLS_FALLBACK` | Windows conpty 未报告尺寸时 |

### 3.2 宽度计算

```
width = clamp(
  round(cols * KHY_SIDEBAR_WIDTH_RATIO),  // 默认 0.16
  KHY_SIDEBAR_WIDTH_MIN,                   // 默认 24
  KHY_SIDEBAR_WIDTH_MAX                    // 默认 36
)
```

**遗留覆盖**：`KHY_SIDEBAR_WIDTH`（绝对列数）优先于比例计算。

### 3.3 高度与锚定

**底部锚定（默认）**：
```
bottomEdge = rows - bottomChrome - topOffset
height = min(contentRows, availableRows)
top = bottomEdge - height + 1
```

- `bottomChrome`：FooterBar 行数（默认 2）+ 桥接行(0/1) + 主题行(0/1)
- `topOffset`：默认 6 rows（将看板从底边上移，避免贴角）
- **内容自适应**：看板高度 = min(内容行数, 可用行数)，内容不足时有最小高度

**顶部锚定（Legacy）**：
```
top = 1
height = rows - 1  (跳过 pending-wrap 行)
```

### 3.4 背景与边框

| 属性 | 默认值 | 环境变量 |
|------|--------|----------|
| 背景色 | `#2e2e2e` | `KHY_SIDEBAR_BG` |
| 边框字符 | `│` | `KHY_SIDEBAR_BORDER_CHAR` |
| 边框开关 | ON | `KHY_SIDEBAR_BORDER=0` 关闭 |
| 通知行淡化比 | 0.7 | `KHY_SIDEBAR_NOTIFY_FADE` |

**颜色格式支持**：`#hex3` / `#hex6` / `rgb(r,g,b)` / `ansi256(n)` / chalk 颜色名

### 3.5 滚动与聚焦

| 功能 | 默认 | 环境变量 | 快捷键 |
|------|------|----------|--------|
| 看板滚动 | OFF | `KHY_SIDEBAR_SCROLL=1` 开启 | 方向键 |
| 看板聚焦 | OFF | `KHY_SIDEBAR_FOCUS=1` 开启 | `KHY_SIDEBAR_FOCUS_KEY`（默认 `b`）|

---

## 4. 滚动行为规范

### 4.1 主内容区滚动（Viewport）

**原则**：输入框固定在底部，消息区在有界视口内滚动。

```
┌─────────────────────────────┐
│  滚动区域 (viewport)         │  ← 可滚动，不带动输入框
│  ┌─────────────────────────┐│
│  │ 已提交消息 (Static)      ││
│  │ 流式输出 (StreamingBlock)││
│  │ 工具卡片 (ToolLines)     ││
│  │ 活动指示 (Spinner)       ││
│  └─────────────────────────┘│
├─────────────────────────────┤
│  PromptFrame (固定底部)      │  ← 永远不动
├─────────────────────────────┤
│  FooterBar (固定底部)        │  ← 永远不动
└─────────────────────────────┘
```

**滚动触发**：
- `Ctrl+O`：打开 Transcript 视图（全量会话可滚动）
- `↑/↓`：在 Transcript 视图内滚动
- `PageUp/PageDown`：快速翻页
- `Ctrl+G`：折叠/展开网关探测通知

**滚动偏移状态**：
- `mainViewportScroll`：主内容视口滚动偏移
- `previewViewportScroll`：Preview 布局主内容视口滚动偏移
- `previewSidebarScroll`：Preview 布局右栏看板滚动偏移
- `transcriptScroll`：Transcript 视图滚动偏移

### 4.2 右栏看板滚动

- 仅在 `KHY_SIDEBAR_SCROLL=1` 时启用
- 滚动偏移存储在 `previewSidebarScroll`
- 滚动指示器：`↑↓ 1-10/25`（仅可滚动时显示）

### 4.3 PromptFrame 内滚动

- 输入内容超过 `maxRows` 时，以光标为中心窗口化
- 折叠标记：`⋯ 上方还有 N 行` / `⋯ 下方还有 N 行`
- **内容不丢失**：窗口化仅影响显示，`value` 完整保留

---

## 5. 右栏滚动条显示规则

### 5.1 显示条件

**右栏滚动指示器**仅在以下条件**全部满足**时显示：

1. 当前标签的内容行数 > `viewportHeight`（内容溢出视口）
2. `maxScroll > 0`（存在可滚动空间）

### 5.2 格式

```
  ↑↓ {start}-{end}/{total}
```

**示例**：
- `↑↓ 1-10/25`（显示第 1~10 行，共 25 行）
- `↑↓ 16-25/25`（滚动到底部）

### 5.3 隐藏条件

- 内容行数 ≤ viewportHeight（无溢出）
- 当前无内容（空标签）

---

## 6. 颜色规范

### 6.1 全局色板

| 用途 | 颜色 | 代码 |
|------|------|------|
| 主背景 | 深灰 | `#1a1a1e` |
| 看板背景 | 中灰 | `#2e2e2e` |
| 面板背景 | 深灰 | `#20201e` |
| 标题栏背景 | 深黑 | `#161b22` |
| 边框（空闲） | 青色 | `cyan` |
| 边框（忙碌） | dim | `dimColor` |
| 输入标记 | 绿色粗体 | `green bold` |
| 占位符 | 反色 | `inverse` |
| 活动标签 | 蓝色 | `#6a92d8` |
| 非活动标签 | 灰色 | `#a8a7a0` |
| 成功/完成 | 绿色 | `#4ea96a` |
| 错误/警告 | 红色 | `#d9635b` |
| 进行中 | 黄色 | `#c9a24a` |
| Dim 文字 | 暗灰 | `#85847d` |
| 正文文字 | 浅灰 | `#d9d9d4` |
| 次要文字 | 灰色 | `#a8a7a0` |

### 6.2 Vim 模式颜色

| 模式 | 光标 | 状态文字 |
|------|------|----------|
| INSERT | 反色（默认） | 黄色 `-- INSERT --` |
| NORMAL | 绿色反色块 | 绿色 `-- NORMAL --` |

### 6.3 会话颜色

- 由 `sessionColor.js` / `sessionColorState.js` 管理
- 每个会话可独立配色

---

## 7. 键盘交互规范

### 7.1 全局快捷键

| 快捷键 | 功能 | 备注 |
|--------|------|------|
| `Enter` | 发送消息 | |
| `Shift+Enter` | 换行（多行输入） | |
| `Ctrl+C` | 中断/退出 | 双击确认退出 |
| `Ctrl+D` | 退出 | 双击确认 |
| `Esc` | 取消/返回 | 双击清除输入 |
| `Ctrl+L` | 清屏 | |
| `Ctrl+O` | Transcript 视图 | 需 `KHY_TRANSCRIPT_VIEW=1` |
| `Ctrl+T` | 切换任务面板 | |
| `Ctrl+G` | 折叠/展开网关通知 | |
| `Ctrl+R` | 反向增量历史搜索 | 需 `KHY_HISTORY_REVERSE_SEARCH=1` |
| `Tab` | 补全菜单 | |
| `Shift+Tab` | Plan 模式 | |

### 7.2 看板聚焦模式

| 快捷键 | 功能 |
|--------|------|
| `b`（默认） | 切换看板聚焦 |
| `↑/↓` | 看板内滚动 |
| `Enter` | 选择看板项 |

### 7.3 覆盖层快捷键

| 覆盖层 | 触发 | 关闭 |
|--------|------|------|
| `/model` | ModelPicker | `Esc` |
| `/khyos` | KhyOsView (QEMU) | `Esc` |
| `/rollback` | RewindPicker | `Esc` |
| `/topology view` | TopologyPanel | `Esc` / `Enter` |
| `/login` `/register` | FormFlow | `Esc` |

---

## 8. 响应式行为

### 8.1 终端尺寸分类

| 分类 | 条件 | 行为 |
|------|------|------|
| 超窄 | `cols < 80` | 仅核心输入，无看板 |
| 窄屏 | `80 ≤ cols < 120` | 单栏，无看板 |
| 标准 | `120 ≤ cols < 160` | 单栏 + 右栏 rail |
| 宽屏 | `cols ≥ 160` | 三栏 + 右栏 rail |

### 8.2 字体缩放免疫

- Ctrl+wheel 字体缩放导致 cols/rows 同向变化
- `classifyResize` 检测：两轴同向 + 比率差 ≤ 0.15 → 判定为 zoom
- zoom 时不翻转看板显示/隐藏判定（`_lastSidebarVerdict` 缓存）

### 8.3 Windows conpty 抖动抑制

- conpty 可能在帧间报告 undefined → 真实值 → undefined
- `stickyDim` 机制：未知尺寸时沿用上一帧有效值（`KHY_TERM_STICKY_DIMS` 默认开）
- `effectiveCols.stickyCols`：列宽的单一真源，深组件共享

---

## 9. 环境变量速查表

### 9.1 看板开关

| 变量 | 默认 | 说明 |
|------|------|------|
| `KHY_SIDEBAR` | ON | 总开关 |
| `KHY_SIDEBAR_RAIL` | ON | Rail 模式开关 |
| `KHY_SIDEBAR_SCROLL` | OFF | 看板滚动 |
| `KHY_SIDEBAR_FOCUS` | OFF | 看板聚焦 |
| `KHY_SIDEBAR_FOCUS_KEY` | `b` | 聚焦切换键 |

### 9.2 看板尺寸

| 变量 | 默认 | 说明 |
|------|------|------|
| `KHY_SIDEBAR_MIN_COLS` | 120 | 最小激活列宽 |
| `KHY_SIDEBAR_MIN_ROWS` | 24 | 最小激活行高 |
| `KHY_SIDEBAR_WIDTH_RATIO` | 0.16 | 宽度比例 |
| `KHY_SIDEBAR_WIDTH_MIN` | 24 | 最小宽度 |
| `KHY_SIDEBAR_WIDTH_MAX` | 36 | 最大宽度 |
| `KHY_SIDEBAR_WIDTH` | (无) | 绝对宽度覆盖 |
| `KHY_SIDEBAR_MAX_RATIO` | 0.85 | 最大高度比例 |
| `KHY_SIDEBAR_MIN_CHROME` | 10 | 底部保留行数 |
| `KHY_SIDEBAR_STACK_MAX_RATIO` | (无) | 额外高度上限 |

### 9.3 看板外观

| 变量 | 默认 | 说明 |
|------|------|------|
| `KHY_SIDEBAR_BG` | `#2e2e2e` | 背景色 |
| `KHY_SIDEBAR_BORDER_CHAR` | `│` | 边框字符 |
| `KHY_SIDEBAR_BORDER` | ON | 边框开关 |
| `KHY_SIDEBAR_NOTIFY_FADE` | 0.7 | 通知行淡化比 |

### 9.4 Rail 模式

| 变量 | 默认 | 说明 |
|------|------|------|
| `KHY_SIDEBAR_RAIL_BOTTOM_CHROME` | 2 | 底部 chrome 行数 |
| `KHY_SIDEBAR_RAIL_TOP_OFFSET` | 6 | 底边上移偏移 |

### 9.5 终端回退

| 变量 | 默认 | 说明 |
|------|------|------|
| `KHY_TERM_FALLBACK_COLS` | 80 | 未知列宽回退 |
| `KHY_TERM_FALLBACK_ROWS` | 24 | 未知行高回退 |
| `KHY_TERM_STICKY_DIMS` | ON | 尺寸粘性 |

### 9.6 功能门控

| 变量 | 默认 | 说明 |
|------|------|------|
| `KHY_TRANSCRIPT_VIEW` | ON | Transcript 视图 |
| `KHY_HISTORY_REVERSE_SEARCH` | ON | Ctrl+R 搜索 |
| `KHY_CHAT_CHORDS` | ON | CC 对齐快捷键 |
| `KHY_LIVE_HEIGHT_BUDGET` | ON | 流式高度预算 |
| `KHY_LIVE_HEIGHT_CLAMP` | ON | 流式高度钳制 |
| `KHY_PROMPT_LAYOUT_MEMO` | ON | 输入框布局缓存 |
| `KHY_MOUSE_NATIVE_MS` | 1500 | 鼠标原生透传窗口 |

---

## 10. 文件索引

### 10.1 核心布局文件

| 文件 | 职责 |
|------|------|
| `cli/tui/ink-components/App.js` | 根组件，状态管理，快捷键路由 |
| `cli/tui/ink-components/ThreeColumnLayout.js` | 三栏布局壳 |
| `cli/tui/ink-components/ChatColumn.js` | 中间聊天区 |
| `cli/tui/ink-components/RightPanel.js` | 右侧标签面板（三栏模式） |
| `cli/tui/ink-components/SessionSidebar.js` | 会话侧栏（三栏模式） |
| `cli/tui/ink-components/PromptFrame.js` | 输入框（固定底部） |
| `cli/tui/ink-components/FooterBar.js` | 底部状态栏（Legacy） |
| `cli/tui/ink-components/Statusbar.js` | 底部状态栏（三栏） |
| `cli/tui/ink-components/Topbar.js` | 顶部标题栏 |

### 10.2 布局计算文件

| 文件 | 职责 |
|------|------|
| `cli/tui/sidebarLayout.js` | 看板宽度/激活/全屏判定 |
| `cli/tui/railLayout.js` | Rail 几何/绘制/清除 |
| `cli/tui/effectiveCols.js` | 有效列宽 SSOT |
| `cli/tui/ink-components/regionLayout.js` | 区域 ID 枚举与顺序 |
| `cli/tui/ink-components/regionLayout.js` → `MAIN_MIN_HEIGHT` | 主区最小高度 |

### 10.3 渲染相关文件

| 文件 | 职责 |
|------|------|
| `cli/tui/ink-components/StreamingBlock.js` | 流式输出渲染 |
| `cli/tui/ink-components/Transcript.js` | 已提交消息渲染 |
| `cli/tui/ink-components/TranscriptView.js` | Transcript 视图 |
| `cli/tui/ink-components/TaskListPanel.js` | 全宽任务清单 |
| `cli/tui/ink-components/CompletionMenu.js` | 补全菜单 |
| `cli/tui/ink-components/Spinner.js` | 活动指示器 |
| `cli/tui/runtime/sidebarRail.js` | Rail 带外绘制运行时 |

---

## 11. 边框与剪贴板：OpenCode 风格「视觉可见但复制不可见」设计

### 11.1 问题背景

传统 TUI 表格用 `╭─╮│╰─╯` 画满格框，用户复制时连框线一起带走：

```
╭───────┬───────╮
│ Name  │ Age   │    ← 复制时这些 │ ─ ╭ ╮ 也会被选中
├───────┼───────┤
│ Alice │ 30    │
╰───────┴───────╯
```

OpenCode 的精妙之处：**边框视觉可见，但复制时不会被选中**。

### 11.2 三层边框体系

khy-os 实现三层边框策略，由 `KHY_TABLE_BORDERS` 和 `KHY_SIDEBAR_BORDER` 分别控制：

| 层级 | 模式 | 边框字符 | 复制行为 | 适用场景 |
|------|------|----------|----------|----------|
| **L0: 无框** | `minimal` (默认) | 无（纯空白对齐） | ✅ 不复制 | CLI 表格、错误面板 |
| **L1: 单侧栏** | `minimal` + gutter | `│`（仅左侧） | ⚠️ 可复制 | 错误面板左竖条 |
| **L2: 全框** | `full` | `╭─╮│╰─╯`（完整框） | ❌ 会复制 | 传统表格、覆盖层 |

### 11.3 实现机制

#### L0: 无框模式（`tableStyle.js`）

```javascript
// cli/tableStyle.js — 所有边框字符置空
const BORDERLESS_CHARS = {
  top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
  bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
  left: '', 'left-mid': '', mid: '', 'mid-mid': '',
  right: '', 'right-mid': '',
  middle: ' ',  // 列间分隔：一个空格
};

// cli-table3 用这些空字符渲染 → 无任何框线
// 列距靠 padding-right: 2 撑开
```

**复制效果**：
```
Name    Age
Alice   30        ← 复制得到纯文本，无框线
Bob     25
```

#### L1: 单侧栏模式（`formatters.js` 错误面板）

```javascript
// 无框时：红色左竖条 + 内容，无右边框
const gutter = '  ' + chalk.red.bold('│') + ' ';

// 渲染效果：
  ✗ Error Title          ← 红色标题，无框
  │ Error message text   ← 红色 │ 作为视觉锚点
  │ Suggestion: do this
```

**关键设计**：
- `│` 用 `chalk.red.bold()` 渲染 → 视觉突出
- 右侧无 `│` → 内容可自然换行到终端边缘
- 复制时 `│` 会被选中，但因为它在每行开头，用户可以手动删除

#### L2: 全框模式（`formatters.js` 完整框）

```javascript
// full 模式：╭─╮│╰─╯ 完整框
lines.push(dim('  ╭─') + chalk.red.bold(titleText) + dim('─'.repeat(dashCount) + '╮'));
lines.push(dim('  │') + '  ' + text + ' '.repeat(pad) + dim('│'));
lines.push(dim('  ╰' + '─'.repeat(maxW) + '╯'));
```

**复制效果**：
```
╭─ ✗ Error Title ─────╮
│  Error message text  │    ← 复制时框线会被选中
╰──────────────────────╯
```

### 11.4 PromptFrame 边框的精妙设计

输入框边框用 `─` 水平线，但有特殊处理：

```javascript
// PromptFrame.js
// 留 1 列 slack：防止 pending-wrap 导致行数不一致
const border = '─'.repeat(Math.max(1, cols - 1));

// 边框颜色：空闲 cyan / 忙碌 dim
const borderColor = busy ? undefined : accent || 'cyan';
```

**精妙点**：
1. `cols - 1` 而非 `cols` → 防止终端 pending-wrap 状态导致的行数不一致
2. 边框用 `chalk.dim()` 渲染 → 视觉弱化，不抢注意力
3. 复制时 `─` 会被选中，但因为它在独立行，用户可以轻松删除

### 11.5 右栏看板边框的「视觉可见但可忽略」

右栏看板的左侧边框：

```javascript
// sidebarRail.js
function _border(env) {
  const ch = sb.borderChar(env);  // 默认 '│'
  return { str: chalk.dim(chalk.gray(ch)), cols: 1 };
}
```

**设计意图**：
- `chalk.dim(chalk.gray(ch))` → 视觉弱化（暗灰 + dim）
- 复制时 `│` 会被选中，但因为它在最右侧且颜色暗淡，用户心理上"忽略"它
- 可通过 `KHY_SIDEBAR_BORDER=0` 完全关闭

### 11.6 OpenCode 的「真正不可复制」技术

OpenCode 的表格边框实现了一种更精妙的技术：**用 ANSI 转义序列渲染边框，使其不占用字符单元格**。

```
传统方式（会复制）：
  │ Alice │ 30 │     ← │ 是字符，会被选中

OpenCode 方式（不复制）：
  ESC[2D│ ESC[0m Alice ESC[2D│ ESC[0m 30  ← │ 是光标定位，不占字符
```

**原理**：
1. 用 `ESC[row;colH`（光标定位）移动到边框位置
2. 用 `ESC[...m`（SGR）设置颜色
3. 输出 `│` 字符
4. 用 `ESC[...m` 重置颜色
5. 用 `ESC[row;colH` 移回内容位置

这样 `│` 只是"画"在屏幕上，不占用内容的字符流 → 复制时不会被选中。

### 11.7 khy-os 的当前实现 vs OpenCode

| 维度 | khy-os 当前 | OpenCode |
|------|-------------|----------|
| 表格边框 | `cli-table3` 字符框 或 空白对齐 | ANSI 光标定位绘制 |
| 复制时框线 | 会被复制（全框模式） | 不会被复制 |
| 实现复杂度 | 低（字符渲染） | 高（光标定位） |
| 兼容性 | 100% 终端 | 需支持 ANSI 光标定位 |

### 11.8 GitHub 调研：行业现状与最佳实践

#### 11.8.1 Ink 的硬换行问题（vadimdemedes/ink#883）

**根本原因**：Ink 使用 `wrap-ansi` 在终端宽度处插入**字面 `\n` 字符**，终端将其视为硬换行。复制时这些换行符会被保留。

```
Ink 渲染流程：
wrap-ansi(text, width, { hard: true }) → "word1 word2\nword3 word4"
→ terminal displays 2 lines → copy gets \n（破坏粘贴）
```

**终端原生软换行**（正确行为）：
```
应用输出："word1 word2 word3 word4"（无 \n）
→ terminal soft-wraps visually → copy joins lines（粘贴正确）
```

**Ink 作者的回复**：「这需要专门的 opt-in 渲染模式，而不是对当前管道的小修小补。」

#### 11.8.2 Claude Code 的相同问题（anthropics/claude-code#13378, #22073, #47652）

Claude Code 使用 Ink，因此存在相同的硬换行问题。用户报告：
- 复制长命令时，换行符破坏 shell 命令
- 复制段落时，换行符破坏文本结构
- 社区工具 `claude-code-command-fix` 专门用于修复此问题

**用户评价**：「It should behave as opencode. Simply!」

#### 11.8.3 opencode 的正确做法

opencode 使用 TypeScript + Bun + SolidJS + @opentui/core，**正确处理软换行**：
- 复制的文本不包含硬换行符
- 长行在复制时保持为单行
- 终端原生软换行 + 应用层不插入 `\n`

#### 11.8.4 各框架的边框处理对比

| 框架 | 边框实现 | 复制行为 | 软换行支持 |
|------|----------|----------|------------|
| **Ink** | `borderStyle: 'round'` 字符框 | 会复制 | ❌ 硬换行 |
| **Bubbletea** | `lipgloss.Border()` 字符框 | 会复制 | ✅ 软换行 |
| **tview** | `screen.SetContent()` 直接写屏 | 取决于终端 | ✅ 软换行 |
| **opentui** | 像素级覆盖层 | 不复制 | ✅ 软换行 |
| **Ghostty** | 独立 canvas 覆盖层 | 不复制 | ✅ 软换行 |

#### 11.8.5 关键洞察

1. **tview 的做法**：直接操作 `tcell.Screen`，边框是屏幕网格上的独立字符。复制行为由终端决定，应用无法控制。

2. **Ghostty 的做法**：用独立 canvas 层绘制高亮/覆盖物，不占用字符单元格。这是**像素级**方案，不适用于纯文本 TUI。

3. **Bubbletea 的软换行**：Bubbletea 本身不硬换行，让终端处理软换行。复制时终端会合并软换行的行。

4. **opencode 的关键差异**：opencode 的渲染器不插入硬换行符，让终端原生处理换行。这是**应用层**的改变，不是终端层的。

### 11.9 推荐改进路径（基于 GitHub 调研）

#### Phase 1: 实现软换行（最高优先级，对齐 opencode）

**核心改变**：对于全宽文本块（流式输出、消息渲染），不插入硬换行符，让终端原生处理软换行。

```javascript
// 新函数：软换行模式
function softWrapText(text, width) {
  // 对于全宽文本块，不插入 \n
  // 让终端的 DECAWM 自动换行
  return text;  // 直接输出，不换行
}

// 对于需要精确布局的场景（表格、边框），仍使用硬换行
function hardWrapText(text, width) {
  return wrapAnsi(text, width, { hard: true, trim: false });
}
```

**影响范围**：
- `StreamingBlock.js`：流式输出不硬换行
- `Transcript.js`：已提交消息不硬换行
- `ChatColumn.js`：聊天区内容不硬换行
- **不影响**：表格、边框、覆盖层等需要精确布局的组件

#### Phase 2: 实现 Ghost Border（中优先级）

对于需要边框但不想复制的场景，使用 ANSI 光标定位绘制「幽灵边框」：

```javascript
// 用光标定位绘制边框，不占用字符流
function ghostVerticalBorder(col, topRow, bottomRow, ch = '│', color = 'dim') {
  let out = '';
  for (let r = topRow; r <= bottomRow; r++) {
    out += `\x1b[s\x1b[${r};${col}H\x1b[2m${ch}\x1b[0m\x1b[u`;
  }
  return out;
}
```

**适用场景**：
- 右栏看板边框（`sidebarRail.js`）
- 错误面板左竖条（`formatters.js`）
- 覆盖层边框

#### Phase 3: 保持无框模式（低优先级）

默认 `minimal` 模式（无框）→ 复制天然干净，作为 fallback。

### 11.10 khy-os vs opencode 差异分析

| 维度 | khy-os 当前 | opencode | 差距 |
|------|-------------|----------|------|
| 文本换行 | 硬换行（`\n`） | 软换行（终端原生） | **关键差距** |
| 表格边框 | `cli-table3` 字符框 | 字符框（可选） | 相同 |
| 看板边框 | `chalk.dim()` 字符 | 字符（可选） | 相同 |
| 复制行为 | 硬换行破坏粘贴 | 软换行保持完整 | **关键差距** |
| 渲染器 | Ink (React) | opentui (SolidJS) | 架构不同 |

**结论**：khy-os 与 opencode 的核心差距不在边框本身，而在**换行策略**。实现软换行是对齐 opencode 的最高优先级改进。

---

## 12. 组件详细规范

### 12.1 输入框（PromptFrame）

#### 12.1.1 布局结构

```
┌─────────────────────────────────────────────────────────────────┐ ← 顶边框 (cyan/dim)
│❯ _placeholder_                                                  │ ← 首行: "> " 标记 + 光标/占位符
│  续行内容...                                                    │ ← 续行: "  " 标记 + 文本
│  ⋯ 上方还有 N 行（输入已折叠，内容未丢失）                       │ ← 折叠标记 (超过 maxRows 时)
├─────────────────────────────────────────────────────────────────┤ ← 底边框 (同顶边框色)
│ Build · claude-opus-4-5 · anthropic                              │ ← 元信息行 (agent/model/provider)
└─────────────────────────────────────────────────────────────────┘
```

#### 12.1.2 尺寸计算

| 属性 | 计算公式 | 说明 |
|------|----------|------|
| 宽度 | `cols - 1` | 留 1 列 slack 防 anti-spill |
| 最小高度 | `4 rows` | 保证短输入完全显示 |
| 最大高度 | `max(4, vrows - 10)` | 防止大粘贴撑破视口 |
| 可用文本宽度 | `cols - MARKER_W(2) - 2` | 标记 2 列 + 光标 + margin |
| 折叠触发 | `wrappedRows > maxRows` | 以光标为中心窗口化 |

#### 12.1.3 光标行为

| 模式 | 光标样式 | 颜色 |
|------|----------|------|
| INSERT (默认) | 反色块 | 默认 |
| NORMAL (Vim) | 绿色反色块 | `green` |
| 禁用态 | 不可见 | `backgroundElement` |

#### 12.1.4 IME 支持

- 使用 ink 的 `useCursor().setCursorPosition()` 对齐系统输入法候选窗
- 光标几何通过 `caretGeometry.js` 使用 yoga node 链遍历计算
- 韩文/中文等复合字符需要 double-defer 确保最后一个字符刷入 `plainText`

#### 12.1.5 Shell 模式

- 输入 `!` 进入 shell 模式（占位符变为 "Run a command…"）
- `Escape` 或 `Backspace`（光标在首位时）退出 shell 模式
- 提交时走 `sdk.client.session.shell()` 而非 `prompt()`

#### 12.1.6 粘贴处理

| 场景 | 行为 |
|------|------|
| 短文本 (< 150 字符, < 3 行) | 直接插入 |
| 长文本 (≥ 150 字符或 ≥ 3 行) | 折叠为 `[Pasted ~N lines]` 占位符 |
| 图片粘贴 | 插入 `[Image N]` 占位符 + 附件 |
| 文件路径 | 自动检测并读取文件内容/图片 |
| URL | 直接插入文本 |

#### 12.1.7 Prompt 历史

- `↑/↓` 浏览历史
- `Ctrl+R` 反向增量搜索（需 `KHY_HISTORY_REVERSE_SEARCH=1`）
- 提交后自动保存到历史
- 清空时（≥ 20 字符）自动保存草稿

#### 12.1.8 与 OpenCode 差异

| 维度 | khy-os | OpenCode |
|------|--------|----------|
| 输入组件 | Ink Textarea | OpenTUI Textarea |
| 虚拟文本 | 不支持 | Extmarks 系统（文件/Agent/粘贴标记） |
| Shell 模式 | `!` 前缀 | `!` 前缀 |
| 粘贴摘要 | 环境变量门控 | 配置项 `paste_summary_enabled` |
| 编辑器集成 | 不支持 | 外部编辑器（`$EDITOR`） |
| Prompt 暂存 | 不支持 | Stash 系统（`Ctrl+S`） |

---

### 12.2 斜杠菜单（CompletionMenu）

#### 12.2.1 布局结构

```
❯ /mo
┌─────────────────────────────────────┐
│ › /model        切换模型            │ ← 选中行 (cyan 背景)
│   /mode         切换模式            │
│   /mcp          MCP 服务器管理      │
│   /memory       记忆系统            │
│   ...                               │
├─────────────────────────────────────┤
│ 斜杠命令 · 1/3 · Tab/Enter 选择 · Esc 取消 │ ← 页脚
└─────────────────────────────────────┘
```

#### 12.2.2 尺寸规格

| 属性 | 值 | 说明 |
|------|-----|------|
| 每页最大项数 | 10 | `MAX_VISIBLE = 10` |
| 标签最大宽度 | 28 字符 | 超出截断 |
| 描述最大宽度 | `cols - 32` | 自适应 |
| 对齐 | 跟随光标 | `marginLeft` 属性 |

#### 12.2.3 键盘交互

| 快捷键 | 功能 |
|--------|------|
| `Tab` / `Enter` | 选择当前项 |
| `↑/↓` | 上下移动 |
| `PageUp/PageDown` 或 `[/]` | 翻页 |
| `Esc` | 取消 |

#### 12.2.4 命令分类

| 分类 | 命令示例 |
|------|----------|
| 会话 | `/new`, `/clear`, `/undo` |
| 模型 | `/model`, `/mode` |
| 工具 | `/mcp`, `/skill` |
| 系统 | `/help`, `/compact` |

---

### 12.3 任务看板（TaskListPanel）

#### 12.3.1 布局结构

```
┌─────────────────────────────────────┐
│ 任务清单（共 5 项: 2 完成、1 进行中、2 待办）│ ← 标题
├─────────────────────────────────────┤
│ ✓ 完成的任务一                       │ ← 完成 (绿色 + 删除线)
│ → 正在进行的任务二                   │ ← 进行中 (青色 + 粗体)
│ ○ 待办任务三                         │ ← 待办 (dim)
│ ○ 待办任务四                         │
│ ✗ 失败的任务五                       │ ← 错误 (红色)
├─────────────────────────────────────┤
│ ↑↓ 1-5/5                            │ ← 滚动指示器
└─────────────────────────────────────┘
```

#### 12.3.2 状态图标

| 状态 | 图标 | 颜色 | 样式 |
|------|------|------|------|
| 完成 | `✓` | 绿色 | 删除线 + dim |
| 进行中 | `→` | 青色 | 粗体 |
| 待办 | `○` | dim | 默认 |
| 错误 | `✗` | 红色 | 默认 |

#### 12.3.3 语义分组

```
本会话清单
  ✓ 修复 Bug A
  → 实现功能 B

项目任务 · 跨会话
  ○ 重构模块 C
  ○ 文档更新 D
```

#### 12.3.4 优先级截断

当任务数量超过可用行数时，按优先级保留：
1. `in_progress` (最高)
2. `error`
3. `pending`
4. `completed` (最低)

#### 12.3.5 数据源

| 来源 | 说明 |
|------|------|
| `_taskStore.snapshot()` | 模型的 TodoWrite/TaskCreate V2 依赖图 |
| `taskPanelState.getTasks()` | 计划审批执行步骤 |

---

### 12.4 输入回显（Transcript - User Message）

#### 12.4.1 白底模式（默认）

```
┌─────────────────────────────────────────────────┐
│❯ 这是用户输入的消息内容，显示在奶油色背景上。      │
│  多行内容会自动换行，保持可读性。                  │
└─────────────────────────────────────────────────┘
```

| 属性 | 值 |
|------|-----|
| 背景色 | `#F0EAD6` (奶油色) |
| 文字色 | `#1A1A1A` (深色) + 粗体 |
| 标记 | `❯` (蓝色 + 粗体) |
| 内边距 | 自适应填充至全宽 |

#### 12.4.2 长消息折叠

| 条件 | 行为 |
|------|------|
| 消息 ≤ 10,000 字符 | 完整显示 |
| 消息 > 10,000 字符 | 头部 2,500 + `… +N lines …` + 尾部 2,500 |

#### 12.4.3 透明模式（Legacy）

- 无背景色，仅 `❯ ` + 粗体文本
- 通过环境变量切换

---

### 12.5 输出显示（StreamingBlock）

#### 12.5.1 反阶梯架构

```
问题：当 live 区高度超过终端视口时，Ink 的擦除计数错误 → "阶梯" 伪影

解决方案：高度预算管理
┌─────────────────────────────────────┐
│  流式输出区                          │ ← liveBudget = max(6, rows - reserve)
│  ┌─────────────────────────────────┐│
│  │ Thinking section (可折叠)        ││ ← thinkBudget = floor(liveBudget * 0.3)
│  │ Body timeline (文本+工具交替)    ││ ← bodyBudget = liveBudget - thinkBudget
│  └─────────────────────────────────┘│
│  Tool lines (最多 6 行)             │ ← 固定上限
├─────────────────────────────────────┤
│  PromptFrame (固定底部)              │
└─────────────────────────────────────┘
```

#### 12.5.2 流式组件

| 组件 | 说明 |
|------|------|
| Thinking section | dim 文本，尾部钳制到 thinkBudget |
| Body timeline | 有序的文本↔工具交替 |
| Status broadcast | 实时进行中摘要 |

#### 12.5.3 归一化管道

- **分层门控**：强模型 (`selfRender`) 用 `sanitize()`，其他用 `normalizeStreaming()`
- **前缀稳定**：live 预览中不关闭 fence/不去重/不修剪（防止跳动）
- **内容键控缓存**：`streamNormCache` 将 O(n²)/轮 优化为 O(n)/轮

#### 12.5.4 Markdown 流式渲染

- `renderMarkdownStreaming()`：关闭悬挂的 ``` fence，优雅处理中间状态
- `streamMdCache`：缓存冻结段，仅增长段重新计算
- 宽度感知：传递列宽用于左栏渲染

---

### 12.6 加载指示器（Spinner）

#### 12.6.1 动画

| 属性 | 值 |
|------|-----|
| 字符集 | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (Braille 旋转) |
| 帧间隔 | `perfTunables.spinnerFrameMs()` (默认 80ms) |
| 减弱运动 | 静态 `●` |

#### 12.6.2 状态显示

| 状态 | 显示 |
|------|------|
| 正常 | `{glyph} {label/detail}` |
| 停滞 (> 600ms) | `⏳ 等待中 · {等待原因}` |
| 停滞颜色 | 黄色/灰色交替呼吸效果 |

#### 12.6.3 进度元数据

- 经过时间 + token 计数
- 30 秒阈值（CC 对齐）：短时间内隐藏
- CC 格式：`5m`（非 `300s`），`~1.2k tok`（非 `~1234 tok`）

#### 12.6.4 与 OpenCode 差异

| 维度 | khy-os | OpenCode |
|------|--------|----------|
| 动画字符 | Braille 旋转 | 自定义帧 + 颜色 |
| 停滞检测 | 600ms 脉冲 | 类似 |
| 进度显示 | 时间 + token | 时间 + token |
| 性能 | React.memo | SolidJS signals |

---

### 12.7 输出表格

#### 12.7.1 无框模式（默认）

```
  Name    Age    City
  ─────────────────────
  Alice   30     Beijing
  Bob     25     Shanghai
```

| 属性 | 值 |
|------|-----|
| 分隔符 | 空白对齐 |
| 缩进 | 2 空格 |
| 表头下划线 | dim `─` |
| 列距 | `paddingRight: 2` |

#### 12.7.2 全框模式

```
  ╭───────┬───────┬──────────╮
  │ Name  │ Age   │ City     │
  ├───────┼───────┼──────────┤
  │ Alice │ 30    │ Beijing  │
  │ Bob   │ 25    │ Shanghai │
  ╰───────┴───────┴──────────╯
```

| 属性 | 值 |
|------|-----|
| 边框字符 | `╭─╮│╰─╯` |
| 列间分隔 | `│` |
| 内边距 | `paddingLeft: 1, paddingRight: 1` |

#### 12.7.3 切换方式

```bash
KHY_TABLE_BORDERS=minimal  # 无框（默认）
KHY_TABLE_BORDERS=full     # 全框
```

#### 12.7.4 CJK 支持

- `padToWidth()` 使用显示宽度（非字符数）
- 中文字符占 2 列
- ANSI 转义序列不计入宽度

---

### 12.8 结构化输出（Markdown）

#### 12.8.1 代码块

```
  ┌─ javascript ──────────────────────┐
  │ const x = 42;                     │
  │ console.log(x);                   │
  └───────────────────────────────────┘
```

| 属性 | 值 |
|------|-----|
| 语言标签 | 左上角 dim |
| 背景色 | 深灰 |
| 语法高亮 | 关键字=品红, 字符串=绿, 数字=黄, 注释=dim |
| 边框 | 无（便于复制） |

#### 12.8.2 表格

- Unicode box-drawing 对齐
- 宽终端时支持并排显示

#### 12.8.3 LaTeX

- `$...$` → Unicode 数学符号
- `$$...$$` → 块级显示

#### 12.8.4 标题层级

| 级别 | 样式 |
|------|------|
| H1 | 粗体 + 主题色 |
| H2 | 粗体 + 青色 |
| H3-H6 | dim + 蓝色 + 层级缩进 |

#### 12.8.5 列表

- 无序列表：彩色 `•` 标记
- 有序列表：数字对齐

#### 12.8.6 引用块

```
│ 这是引用内容
│ 支持多层嵌套
```

- 每层嵌套使用不同 dim 级别

#### 12.8.7 性能优化

- LRU 缓存（500 条目）：终端大小/主题切换时失效
- 代码块占位符：强调/链接渲染期间保护
- 流式变体：`renderMarkdownStreaming()` 关闭悬挂 fence

#### 12.8.8 CJK/换行

- `_wrapRawToWidth()`：词边界感知 + 禁则处理
- `_hardSplitToken()`：长不可断 token 的字符级回退
- CJK 断集：`_NO_BREAK_BEFORE`, `_NO_BREAK_AFTER`

---

## 13. 设计决策记录

### 13.1 为什么用带外绘制而不是 ink flex row

**问题**：in-tree 看板（SidebarPanel）只能从 ink LIVE 区顶部开始，结构上钉在视口底部，上方空间全部浪费。

**方案**：Rail 通过 ANSI 绝对坐标在 ink 渲染区域外绘制，从屏幕第 2 行铺到底部。

**优势**：
- 零 live-region 行数消耗
- 看板可从任意行开始（bottom-anchor 模式）
- 不影响 ink 的行计数和 scrollback

**代价**：
- 需要 `contentCols()` 保证 ink 不写入保留列
- 需要 `DECSC/DECRC` 保存/恢复光标
- 需要 `buildRailClear` 在退出时清除

### 13.2 为什么输入框用 `cols - 1` 而不是 `cols`

**问题**：终端在最右列有一个 pending-wrap 状态，ink 的行计数与终端实际行数不一致，导致输入内容溢出到输出区（anti-spill 问题）。

**方案**：输入框边框和文本都用 `cols - 1`，留 1 列 slack。

**效果**：逻辑行数 == 视觉行数，ink 擦除计数准确。

### 13.3 为什么看板默认底部锚定

**问题**：顶部锚定的看板在首轮消息后被推到很下方，视觉上与对话区割裂。

**方案**：底部锚定，看板底边与 FooterBar 顶边对齐，内容向上增长。

**效果**：看板始终在视野底部，不随对话增长而移动。

---

## 14. 提示词：TUI 软换行与边框优化

> **角色**：khy-os TUI 高级工程师，熟悉 Ink 渲染模型、ANSI 转义序列、终端软换行机制、clipboard 行为。
>
> **目标**：基于 `[DESIGN-ARCH-079]` 第 11-12 节 GitHub 调研与组件规范，实现 opencode 风格的软换行 + ghost border 系统，修复复制粘贴破坏问题。
>
> **工作目录**：`D:\Portable\khy-os`

---

### 执行流程

#### Phase 1: 实现软换行（最高优先级）

**目标**：对于全宽文本块（流式输出、消息渲染），不插入硬换行符，让终端原生处理软换行。

**读取文件**：
| 文件 | 审计点 |
|------|--------|
| `cli/tui/ink-components/StreamingBlock.js` | 流式输出的换行逻辑 |
| `cli/tui/ink-components/Transcript.js` | 已提交消息的换行逻辑 |
| `cli/tui/ink-components/ChatColumn.js` | 聊天区内容的换行逻辑 |
| `cli/tui/ink-components/TextBlock.js` | 文本块的换行逻辑 |
| `node_modules/wrap-ansi/index.js` | 硬换行的实现位置 |

**实现步骤**：

1. **新增 `cli/softWrap.js`**：
```javascript
'use strict';

/**
 * softWrap.js — 软换行模式：不插入 \n，让终端原生处理换行。
 *
 * 门控 KHY_SOFT_WRAP（默认 off，渐进式启用）。
 */

function isSoftWrapEnabled(env) {
  const v = String(env && env.KHY_SOFT_WRAP || '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

/**
 * 对于全宽文本块，不换行，让终端 DECAWM 处理。
 * 对于需要精确布局的场景（表格、边框），仍使用硬换行。
 */
function softWrapText(text, width) {
  // 直接返回，不插入 \n
  return text;
}

module.exports = { isSoftWrapEnabled, softWrapText };
```

2. **修改 `StreamingBlock.js`**：
```javascript
// 在流式输出渲染时，检查 KHY_SOFT_WRAP
if (isSoftWrapEnabled(process.env)) {
  // 软换行：不插入 \n，让终端处理
  return h(Text, null, text);
} else {
  // 硬换行：现有逻辑
  return h(Text, null, wrapAnsi(text, width, { hard: true }));
}
```

3. **修改 `Transcript.js`**：
```javascript
// 已提交消息的渲染，同样检查 KHY_SOFT_WRAP
```

4. **修改 `ChatColumn.js`**：
```javascript
// 聊天区内容的渲染，同样检查 KHY_SOFT_WRAP
```

#### Phase 2: 实现 Ghost Border（中优先级）

**目标**：对于需要边框但不想复制的场景，使用 ANSI 光标定位绘制「幽灵边框」。

**新增 `cli/ghostBorder.js`**：
```javascript
'use strict';

/**
 * ghostBorder.js — 用 ANSI 光标定位绘制「幽灵边框」。
 *
 * 原理：边框字符通过 ESC[row;colH 定位绘制，不占用内容的字符流。
 * 终端复制时只选中内容字符，不选中光标定位绘制的边框。
 *
 * 门控 KHY_GHOST_BORDER（默认 off）。
 */

function ghostChar(row, col, ch, color) {
  return `\x1b[s\x1b[${row};${col}H\x1b[2m${ch}\x1b[0m\x1b[u`;
}

function ghostVerticalBorder(col, topRow, bottomRow, ch = '│', color = 'dim') {
  let out = '';
  for (let r = topRow; r <= bottomRow; r++) {
    out += ghostChar(r, col, ch, color);
  }
  return out;
}

function ghostHorizontalBorder(row, leftCol, rightCol, ch = '─', color = 'dim') {
  let out = '';
  for (let c = leftCol; c <= rightCol; c++) {
    out += ghostChar(row, c, ch, color);
  }
  return out;
}

module.exports = { ghostChar, ghostVerticalBorder, ghostHorizontalBorder };
```

**修改 `sidebarRail.js`**：
```javascript
// _border() 函数改为 ghost border 模式
function _border(env) {
  if (isGhostBorderEnabled(env)) {
    // ghost border 模式：返回空字符串，边框由 painter 叠加
    return { str: '', cols: 0, ghost: true };
  }
  // 现有逻辑
  return { str: chalk.dim(chalk.gray(ch)), cols: 1 };
}
```

**修改 `formatters.js`**：
```javascript
// printErrorPanel() 的左竖条改为 ghost border
if (isGhostBorderEnabled(process.env)) {
  // 先输出内容（无 │）
  console.log(chalk.red.bold('  ✗ ' + title));
  // 再用光标定位叠加红色 │
  // ghostVerticalBorder(3, startRow, endRow, '│', 'red')
}
```

#### Phase 3: 回归测试

```bash
# 1. 验证软换行
KHY_SOFT_WRAP=1 node -e "
const { render } = require('ink');
const React = require('react');
const { Text } = require('ink');
render(React.createElement(Text, null, 'This is a long text that should soft-wrap instead of hard-wrap'));
"

# 2. 验证 ghost border
node -e "const g = require('./cli/ghostBorder'); console.log(g.ghostChar(1, 1, '│', 'dim'))"

# 3. 验证复制行为（手动）
# 启动 TUI，选中长文本，粘贴到文本编辑器
# 期望：只粘贴内容，不粘贴硬换行符

# 4. 全量回归
node services/backend/src/cli/tui/vim/test-vim-mode.js
node services/backend/src/cli/tui/test-cli-keys.js
python scripts/hq_check.py
```

---

### 验收标准

- [ ] `KHY_SOFT_WRAP=1` 时，流式输出不插入硬换行符
- [ ] `KHY_SOFT_WRAP=1` 时，复制长文本不包含 `\n`（对齐 opencode）
- [ ] `KHY_GHOST_BORDER=1` 时，边框通过光标定位绘制，不占字符流
- [ ] `KHY_GHOST_BORDER=1` 时，复制内容不包含边框字符
- [ ] `KHY_SOFT_WRAP` 未设置时，所有行为与改动前完全一致（向后兼容）
- [ ] `KHY_GHOST_BORDER` 未设置时，所有行为与改动前完全一致（向后兼容）
- [ ] `hq_check.py` 全绿

---

### 工程铁律

1. **零盘符硬编码**
2. **向后兼容**：`KHY_SOFT_WRAP` 和 `KHY_GHOST_BORDER` 默认 off
3. **JS 风格**：2 空格缩进、单引号、分号、CommonJS
4. **不改 `platform/khy_platform/__init__.py`**
5. **改完必跑** `python scripts/hq_check.py`
6. **软换行只用于全宽文本块**：表格、边框等需要精确布局的组件仍使用硬换行

---

### 回填

```bash
python scripts/update_status.py task T-XXX done --note "软换行 + Ghost Border 基础设施，对齐 opencode 复制行为"
```

---

*最后更新：2026-09-08*
*单一真源：`services/backend/src/cli/tui/` 目录下的实际代码*
*GitHub 调研：vadimdemedes/ink#883, anthropics/claude-code#13378, ghostty-org/ghostty, rivo/tview, charmbracelet/bubbletea*
