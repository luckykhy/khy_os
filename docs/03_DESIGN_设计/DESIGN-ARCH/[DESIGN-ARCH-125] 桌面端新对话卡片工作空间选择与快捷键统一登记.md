# [DESIGN-ARCH-125] 桌面端新对话卡片工作空间选择与快捷键统一登记

> **状态**：**一期 + 二期已实施**（2026-09-18）；三期（TUI 前缀键）待做。见 §10 实施记录。
> **范围**：`apps/khyos-desktop/`（渲染层 + 主进程 IPC + preload）。TUI 前缀键列为三期，见 §7。
> **上游依赖**：`[DESIGN-ARCH-117]`（多端入口矩阵）、`[IMPL-RPT-027]`（前后端对接与交互重构日志）。
> **调研指针**：`docs/03_DESIGN_设计/[DESIGN-OTHER-005]`；调研档案 `extensions/scripts/khy-desktop-rd/`。
> **同源调研**：`[DESIGN-RES-001]`（差距分析）、`[DESIGN-RES-002]`（每日调研）。
> **模板合规**：本文 §2 按 `[DESIGN-SOURCING-001]` §3 B-P2 七字段填写；索引 `docs/10_规范/registry/PROPOSAL-ARTIFACT-INDEX.json`。

---

## 0. 一句话结论

「交互不方便」的病灶**不是卡片长得不好看**——空态卡片已经 90% 是目标形态：问候语、居中悬浮卡片、
工具行整簇、卡片下方快捷 chips 全都在位（`components/ui/EmptyState.tsx:107-175`）。

真正的不方便是三条**入口一致性**问题：

| # | 病灶 | 一句话 |
|---|---|---|
| 1 | **卡片里没有工作空间** | 工作空间只在标题栏有一个 chip（`components/layout/TitleBar.tsx:201`）。开新对话时想换工作空间，必须先离开卡片去翻菜单，换完再回来 |
| 2 | **切换入口有 3 份重复实现，且每次都弹系统目录框** | `TitleBar.tsx:97-107`、`WorkspaceSidebar.tsx:134-144`、`CommandCenter.tsx:30` 各自写了一遍；没有「最近打开」，每次都要在文件系统里重新找路 |
| 3 | **命令面板与快捷键在骗人** | `CommandCenter.tsx` 28 条命令里 **20 条是 `console.log` 空壳**，正好包括「新建任务」「打开工作区」；它展示的 `Ctrl+N`/`Ctrl+O` 定义在一个**未被任何文件引入**的 `main/menu.ts` 里，而主进程随后 `Menu.setApplicationMenu(null)`（`main/index.ts:1261`），preload 也没有任何菜单桥 |

⇒ 在卡片里补一行工作空间选择 + 把命令面板诚实接线，收益远大于重新设计卡片。

---

## 1. 现状实证（file:line 可复核）

### 1.1 卡片已存在，缺的只有「工作空间」这一行

| 目标形态构成 | 现状 | 位置 |
|---|---|---|
| 大字问候（按时段） | ✅ 已有 5 档文案 | `EmptyState.tsx:120-128` |
| 居中悬浮输入卡片 | ✅ `variant="card"` | `Composer.tsx:738-740`；`App.tsx:330-343` |
| 占位文案「使用 @ 添加上下文 / 选择命令或能力」 | ✅ 已对齐 | `Composer.tsx:817` |
| 工具行左：`+` 添加上下文 | ✅ 5 项菜单 | `Composer.tsx:22-83` |
| 工具行左：模式选择器（如「变更前确认」） | ✅ | `Composer.tsx:848`、`ModeSelector.tsx` |
| 工具行右：模型 / 推理强度 / 发送 | ✅ 同簇 | `Composer.tsx:835-889` |
| 卡片下方快捷 chips | ✅ 6 张 | `EmptyState.tsx:98-105` |
| **输入框上方：工作空间选择行** | ❌ **完全缺失** | — |

**结论：本次不动卡片的版式，只加一个 `header` 槽位。**

### 1.2 工作空间链路已通，但入口分裂

主进程侧的设计是干净的，且有明确注释约束：

> `main/index.ts:85-89`
> 「Single workspace-root resolver. 打开工作区 / 添加项目 persist the chosen directory to
> `settings.desktopWorkspacePath`; every workspace-scoped channel (app:workspacePath,
> workspace:listFiles, workspace:readTree default) reads through here **so the chip, the file tree
> and the file index can never disagree**.」

真源实现与字段：

| 件 | 位置 | 说明 |
|---|---|---|
| 唯一解析器 | `main/index.ts:90-97` | `settings.desktopWorkspacePath` → `path.resolve` → `existsSync`+`isDirectory` 校验，失效则回落 `process.cwd()` |
| 持久化字段 | `main/settingsStore.ts:67-71` | `desktopWorkspacePath`，单一值 |
| IPC | `main/index.ts:612` `app:workspacePath`；`preload/index.ts:139` | 只读当前根 |
| 切换动作 | `TitleBar.tsx:100-107` | picker → `setSetting` → 刷新 chip → 广播 `khy:workspace-changed` |
| 切换动作（重复 2） | `WorkspaceSidebar.tsx:135-144` | 同一链路，复制粘贴了一遍 |
| 消费方 | `AppLayout.tsx:258-264` | 监听 `khy:workspace-changed` → `workspaceEpoch++` 重挂文件树 |

**缺口 = 没有「列出可切换的工作空间」这个能力**。链路只能「选一个新目录」，不能「回到上次那个」。

### 1.3 命令面板：28 条里 20 条是空壳

`components/message/CommandCenter.tsx:29-56` 实测统计：

| 分类 | 条数 | 例 |
|---|---|---|
| **已接线**（走 `onPanelAction` 或 hash 路由） | **8** | 切换面板、切换终端、添加终端/浏览器/审查/辅助对话标签、打开文件、设置 |
| **空壳**（`action: () => console.log(...)`） | **20** | **新建任务**、**打开工作区**、切换全屏、查找任务、切换模型、切换执行模式、思考强度、压缩上下文、清空对话、重载会话、技能、MCP 服务器、问题反馈、用户社群、切换主题×2、检查更新、导出日志、开发者工具、命令面板自身 |

其中「新建任务」「打开工作区」恰好是本次任务最相关的两条，而它们点了没有任何反应：

```ts
// CommandCenter.tsx:29-30
{ id: 'new-task', ..., shortcut: 'Ctrl+N', action: () => console.log('[cmd] new task') },
{ id: 'open-workspace', ..., shortcut: 'Ctrl+O', action: () => console.log('[cmd] open workspace') },
```

同时注意：`新建任务` 的能力**后端其实已有**——`App.tsx:247-251` `handleNewTask`（清消息 + 复位 goal/sessionTitle），
只是没有从命令面板接过去。**这不是缺功能，是缺接线。**

### 1.4 加速键定义在未被引入的文件里

| 件 | 位置 | 状态 |
|---|---|---|
| `Ctrl+N` / `Ctrl+O` 定义 | `main/menu.ts:42-49` | 定义了，`click: () => mainWindow.webContents.send('menu:new-task')` |
| 主进程是否装载该菜单 | `main/index.ts:1259-1261` | 注释称「Menu items fire via IPC (menu:new-task etc.) **which createWindow registers on every window**」，紧接着 `Menu.setApplicationMenu(null)` |
| 谁 import 了 `./menu` | 全仓搜索 `from './menu'` / `buildAppMenu` / `installMenu` | **零命中** |
| preload 是否有菜单桥 | `preload/index.ts` 搜 `menu\|Menu\|new-task\|open-workspace` | **No matches found** |
| 渲染层是否监听 `menu:*` | 全部 `.tsx` 搜 `menu:new-task\|menu:open-workspace` | **零命中**（仅 `globals.css` 的 `--color-menu` 变量名撞词） |

⇒ `Ctrl+N` / `Ctrl+O` 在当前桌面端**不生效**，而命令面板仍在向用户展示这两个快捷键。
另：`App.tsx:212-231` 的全局键盘处理只挂了 `Ctrl+K`、`Ctrl+T`、`Escape` 三个。

### 1.5 两处工作空间状态，其中一处是 mock（须一并清理）

`state/workspaceSlice.ts` 持有 `currentWorkspace` 与 `tasks`，但：

| 字段 | 现状 | 风险 |
|---|---|---|
| `currentWorkspace` | `null`，且**没有任何 reducer 能写入它**（reducer 只有 `setViewMode` / `setSortBy` / `setSearchQuery` / `archiveTask`，`workspaceSlice.ts:26-34`） | 空置 |
| `tasks` | 两条硬编码假数据：`sess_001 实现登录功能`、`sess_002 修复终端渲染问题`（`workspaceSlice.ts:17-20`） | 真实会话列表来自 `listSessions`（`AppLayout.tsx:277-290`），两套并存 |

**这是本次必须处理的分叉真源**：如果卡片的工作空间选择器从 `workspaceSlice` 取数，就会显示假路径。

---

## 2. 借鉴提案（B-P2 七字段）

### 【借鉴提案 P-01】新对话卡片内的「工作空间选择行」

| # | 字段 | 内容 |
|---|---|---|
| 1 | **借鉴对象** | ZCode 桌面端（闭源分发；行为依据 = 用户提供的首页截图 + 本仓解包产物 `apps/khyos-desktop/zcode-analysis/unpacked/`）。交互命名依据 = 本仓 `i18n/zh-CN.json` 中标注「ZCode 同源 i18n 实测值」的既有键（如 `workspace.openWorkspace`） |
| 2 | **借鉴内容** | **行为 + 结构**：把「当前工作空间」提到对话输入卡片的顶端独立一行（`▣ 名称 ⌄`），与输入区、工具行同一张卡片内；点开它是一个 **combobox（选 + 切）**，而不是每次弹系统目录框 |
| 3 | **解决的问题** | 空态卡片无法切换工作空间：唯一入口是标题栏 chip（`TitleBar.tsx:201`）与窗口菜单；切换入口重复 3 份（`TitleBar.tsx:97-107`、`WorkspaceSidebar.tsx:134-144`、`CommandCenter.tsx:30`）；无「最近打开」。指向上表现象，不指「上游有这个」 |
| 4 | **许可证与代码性质** | ZCode **闭源**，无可引用许可证声明 ⇒ 按 B-S4.1 **从严**。本提案只借交互结论，**不引入任何上游代码、二进制或资源**；不修改 `zcode-analysis/` 下任何内容 |
| 5 | **借鉴方式** | `idea`。判定依据：上游无许可证可依，且落点组件（React/TSX）与上游打包产物（压缩 JS）无代码可移植性，只能借结论 |
| 6 | **落点与现有实现对比** | **a. 落点**：新增 `src/renderer/components/workspace/WorkspacePicker.tsx`；`Composer.tsx` 增 `header` 槽位；`main/settingsStore.ts` 增 `desktopRecentWorkspaces`；`main/index.ts` 增 `workspace:list` / `workspace:open` 两个 IPC；`preload/index.ts` 暴露对应方法。<br>**b. 现有同类实现**：搜索词 `workspace\|Workspace\|打开工作区\|desktopWorkspacePath\|openDirectoryPicker`，目录 `apps/khyos-desktop/src/`。**已有 canonical**：`getWorkspaceRoot()`（`main/index.ts:90`）+ `TitleBar.pickWorkspace()`（`TitleBar.tsx:100`）。**本提案是「扩展既有 canonical」而非新增并行实现**——切换动作抽成共用函数后，`TitleBar` 与 `WorkspaceSidebar` 改为调用它，实现「一份实现、三处入口」 |
| 7 | **验收方式** | `npm run electron:dev` → 空态卡片顶部出现工作空间行 → 点开见「最近打开 / 打开其他文件夹…」→ 选择后卡片行与标题栏 chip 同步变化 → 发一条消息，新会话 JSONL 的 `cwd` 等于新路径。见 §8 |

### 【借鉴提案 P-02】「最近打开」与入口归一

| # | 字段 | 内容 |
|---|---|---|
| 1 | **借鉴对象** | 同 P-01（ZCode 工作空间 combobox 的 recents 语义）；键位标签口径沿用本仓 `i18n/zh-CN.json:2520` `quickPick.command.openWorkspace` |
| 2 | **借鉴内容** | **结构**：切换器 = 「最近打开（MRU，上限 8）+ 分隔线 + 打开其他文件夹…」。列表项显示目录 basename + 完整路径（hover title） |
| 3 | **解决的问题** | 当前每次切换都强制走 `openDirectoryPicker`（`TitleBar.tsx:101`、`WorkspaceSidebar.tsx:139`）：在盘上多项目间来回切，每次都要重新导航到目录。且 `desktopWorkspacePath` 是**单值**（`settingsStore.ts:71`），旧路径一换就丢 |
| 4 | **许可证与代码性质** | 同 P-01：无上游代码引入 |
| 5 | **借鉴方式** | `idea` |
| 6 | **落点与现有实现对比** | **a. 落点**：`main/settingsStore.ts`（新增 `desktopRecentWorkspaces: string[]`，MRU 去重、上限 8）；`main/index.ts`（`workspace:list` 返回 `{ current, recents }`，写前去重 + 用 `fs.existsSync` 过滤已失效路径）；`TitleBar.tsx` / `WorkspaceSidebar.tsx` 改调共用函数。<br>**b. 现有同类实现**：搜索词 `recent` 在 `apps/khyos-desktop/src/` → 仅命中 `agentItemStore` / `indexStore` 等无关件，**工作空间无任何 MRU 实现**，故为新增。但要复用既有持久化通道 `settingsStore`（`setSetting`），不新建存储 |
| 7 | **验收方式** | 连续切换 A→B→A：第二次到 A 时不弹目录框，直接从「最近打开」列表选中。见 §8 |

### 【借鉴提案 P-03】快捷键与命令面板的单一真源

| # | 字段 | 内容 |
|---|---|---|
| 1 | **借鉴对象** | Claude Code 的 `keybindings/defaultBindings.ts`（**本仓已在引用**：`services/backend/src/cli/tui/chatChords.js:9` 明确写「对齐 Claude Code keybindings/defaultBindings.ts」）。本次沿用同一上游依据，不新增代码来源 |
| 2 | **借鉴内容** | **结构**：一张「按键 → 动作名」的纯叶子映射表，渲染层与命令面板从它派生（而不是把手写字符串散落在每个菜单项里） |
| 3 | **解决的问题** | 命令面板展示的 `Ctrl+N`/`Ctrl+O` 不生效（§1.4）；28 条命令 20 条空壳（§1.3）；同一快捷键字符串在 `menu.ts`、`CommandCenter.tsx:29-30`、`TitleBar.tsx:110-111` 三处各写一遍，改一处漏两处 |
| 4 | **许可证与代码性质** | 上游许可证未在本仓核验过；`chatChords.js` 既有的引用方式是**纯注释级对齐**（照抄键位结论、不引代码），本提案沿用该性质。若评审要求显式许可证依据，先补核验再落地 |
| 5 | **借鉴方式** | `idea`。判定依据：只借「集中登记 + 纯叶子派生」这一结构结论 |
| 6 | **落点与现有实现对比** | **a. 落点**：新增 `src/shared/keymap.ts`（纯叶子：零 IO、确定性、不抛异常——与 `chatChords.js` 同范式）；`CommandCenter.tsx` / `TitleBar.tsx` 菜单 / 帮助入口改为从它渲染；`App.tsx:212-231` 的全局监听改为查表。<br>**b. 现有同类实现**：搜索词 `keymap\|shortcut\|accelerator\|快捷键`，目录 `apps/khyos-desktop/src/` → **仅散落的手写字符串**，无注册表；TUI 侧**已有 canonical 范式**：`services/backend/src/cli/tui/chatChords.js`（纯叶子 + 门控 `KHY_CHAT_CHORDS` + 显式 deferred 清单）。**本提案是把 TUI 已验证的范式搬到桌面端**，不是另发明一套 |
| 7 | **验收方式** | 命令面板中每一条展示的快捷键，按下后都必须触发对应动作；未接线的命令**不渲染**或标注禁用。见 §8 |

---

## 3. 目标形态（组件级契约）

```
ChatEmptyState
├── 问候语（2xl，居中）                      ← 不动
├── 输入卡片（max-w-[560px]）                ← 不动
│   ├── [新增] WorkspacePicker   header 槽位  ← 本次唯一版式改动
│   ├── textarea（占位文案）                  ← 不动
│   └── 工具行：+ / 模式 · 模型 / 推理强度 / 发送  ← 不动
└── 快捷 chips（6 张）                        ← 不动（可改为真实数据，见 §5）
```

`WorkspacePicker` 契约：

```ts
interface WorkspacePickerProps {
  variant: 'card-header' | 'titlebar'   // 两处共用同一组件，避免第三份实现
  onChanged?: (path: string) => void    // 切换后回调；卡片旁需同步刷新
}
// 数据来自 window.__KHYOS__.workspaceList() —— host 真值，非本地造
// 结构：{ current: string; recents: { path: string; name: string }[] }
```

**样式（走既有 CSS 变量，勿硬编码色值）**：`text-foreground/60` 文字、`hover:bg-surface-hover` 悬停、
`bg-popover` + `border-popover-border` 弹层、`bg-selected` 选中态——这些变量在 `theme/globals.css` 里已定义，
新增组件若写死 hex 会撞 `npm run check:frontend-design-tokens`。

**文案（优先复用，勿新增键）**：`workspace.openWorkspace`（`zh-CN.json:4965`）、
`workspace.startFromScratch`（:4966）、`titleBar.menu.file.openWorkspace`（:4712）已存在同义键，
新增键需中英双语齐全。

---

## 4. 实施分期（每期独立可回滚）

### 一期：卡片内工作空间选择行（P-01 + P-02）

| 步 | 动作 | 文件 | 可独立提交 |
|---|---|---|---|
| 1 | `settingsStore` 增 `desktopRecentWorkspaces`（MRU ≤8） | `main/settingsStore.ts` | ✅ |
| 2 | 新增 `workspace:list` / `workspace:open` IPC，open 复用 `openDirectoryPicker` + 广播 `khy:workspace-changed` | `main/index.ts`、`preload/index.ts` | ✅ |
| 3 | 抽出 `openWorkspace()` 共用函数，`TitleBar` / `WorkspaceSidebar` 改为调用 | `renderer/workspace/*` 或 `renderer/utils/` | ✅ |
| 4 | 新建 `WorkspacePicker.tsx`；`Composer` 增 `header` 槽位；`ChatEmptyState` 传入 | 渲染层 3 文件 | ✅ |

**本期不删任何旧入口**（窗口菜单、侧栏「添加项目」保留），因此**不触发 B-L2 迁移流程**（无 deprecated 标记动作）。

### 二期：命令面板诚实化 + 快捷键登记（P-03）

1. 新建 `shared/keymap.ts` 纯叶子；
2. `CommandCenter` 的 20 条空壳：**能接线的接线**（`新建任务` → `App.handleNewTask`、`重载会话` → `App.handleReload`、
   `打开工作区` → 共用 `openWorkspace()`、`命令面板` → 关闭自身、`开发者工具` → 既有 IPC），
   **不能接线的直接不渲染**（不保留「点了没反应的菜单项」）；
3. `Ctrl+N` 接 `handleNewTask`；`Ctrl+O` 接 `openWorkspace()`——让命令面板展示的快捷键变成真的。
4. 删除或引入 `main/menu.ts`（当前既未被引入、又与 `Menu.setApplicationMenu(null)` 矛盾），二选一，不留悬空件。

### 三期：TUI 前缀键（见 §7，需先做按键占用普查）

---

## 5. 诚实边界（刻意不纳入）

| # | 不做的事 | 原因 |
|---|---|---|
| 1 | 不复制 ZCode 任何代码 / 二进制 / 图标资源 | 闭源，无许可证可依；按 B-S4.1 从严。`zcode-analysis/` 只读不改 |
| 2 | **不造假的「最近打开」** | 列表来自 `desktopRecentWorkspaces` 真值 + `fs.existsSync` 过滤。空时不渲染该分组，不塞 3 条示例路径 |
| 3 | 不在卡片里消费 `workspaceSlice.tasks` | 那是 mock（`workspaceSlice.ts:17-20`）。真实会话列表来自 `listSessions` |
| 4 | 本轮不清理 `workspaceSlice` 的 mock 与空置 `currentWorkspace` | 属独立技术债，另开条目；**但卡片不得依赖它**，避免把假数据洗白成「已接线」 |
| 5 | 不动卡片版式、配色、圆角、间距 | `[DESIGN-RES-001]` §12 已完成一轮视觉对齐，本轮只加一个槽位 |
| 6 | 不改 4 级模式与后端 6 profile 的映射 | 已在 `App.tsx:73-81` 与 `ModeSelector` 落地，与本次无关 |
| 7 | 三期前不动 TUI 任何键位 | 见 §7：先普查占用，再谈前缀键 |
| 8 | 不新增并行的事件总线 | 沿用既有 `khy:workspace-changed` / `khy:open-file` 窗口事件 |

---

## 6. 反模式（这条路别走）

| # | 别走 | 为什么 |
|---|---|---|
| 1 | **在卡片里新建第三份 workspace 状态** | `main/index.ts:85-89` 的注释已把「一处真源、三处不打架」写死了。前端再存一份 = 破坏该不变量（chip / 文件树 / 文件索引会各说各话） |
| 2 | **用 `workspaceSlice.currentWorkspace` 当数据源** | 它是 `null` 且无写入 reducer；顺手接线会连带把 mock `tasks` 拉进 UI |
| 3 | **为桌面端另发明一套快捷键注册表** | TUI 的 `chatChords.js` 已是同范式 canonical（纯叶子 + 门控 + deferred 清单）。另起一套 = 两套真源 |
| 4 | **保留 `console.log` 占位按钮** | 「点了没反应」= 假功能，违诚实红线。宁可少渲染一条 |
| 5 | **把 `Ctrl+O` 改指到别的功能** | 与 `titleBar.menu.file.openWorkspace`、`quickPick.command.openWorkspace` 的既有口径冲突；应让它**真的能用**，而不是换掉 |
| 6 | **每次切换都弹目录框** | 这就是当前「不方便」的成因。MRU 列表是本提案的一半价值 |
| 7 | **把 `main/menu.ts` 重新 `setApplicationMenu` 装回去** | 会与无边框窗口 + `TitleBar` 自绘菜单（L 区对齐）冲突。二选一：删掉它，或把它降级为「快捷键表的数据来源」 |

---

## 7. TUI 快捷键（三期，先普查再动手）

TUI 侧**已有**正确的架构，不需要重做：

| 件 | 位置 | 现状 |
|---|---|---|
| 单一真源（纯叶子） | `services/backend/src/cli/tui/chatChords.js` | 「按键 → 动作名」纯映射，**绝不执行动作**（副作用留在薄壳） |
| 已登记 chord | 同上 `resolveChatChord` | 4 个：`meta+p` 模型选择、`meta+o` fast、`meta+t` thinking、`ctrl+t` 任务面板 |
| 门控 | `KHY_CHAT_CHORDS` | 关 → 恒返 null，逐字节回退历史行为 |
| 显式 deferred | 同上文件头注释 | externalEditor / stash / undo / yank-pop —— **明确列为不做**，理由「khy 无对应功能，造半成品违背诚实红线」 |
| 反向历史搜索 | 注释指向 `services/keybindings/historyReverseSearch` | 由上层层 `useInput` 驱动，门控 `KHY_HISTORY_REVERSE_SEARCH` |

因此三期的正确做法是**沿既有范式扩展**，而不是引入前缀键框架：

1. **先做按键占用普查**：把 `chatChords.js` + `App.js` 顶层 `useInput` + vim 模式（`tui/vim/*`）+
   各 overlay（`HistorySearchOverlay` / `RewindPicker` / `CcTranscriptView` / `TaskListPanel`）已占用的键位列成表。
   **没有这张表就谈前缀键，等于蒙眼改键位。**
2. 冲突是真实存在的：`[DESIGN-RES-002]` §4 P3 建议引入 `Ctrl+K` 前缀，但 `Ctrl+K` 在桌面端是命令面板；
   且 `Ctrl+O` 在 TUI 已语义为「展开过程组」（`chatChords.js:26-27` 记为 honest-NA，明确不为对齐而破坏它）。
3. 前缀键的收益（避免冲突）只有在**键位数量接近上限**时才成立。当前 TUI 只登记了 4 个 chord ⇒
   **优先级低于桌面端三条**，列为三期合理。

---

## 8. 验收方式

### 8.1 一期（卡片 + 工作空间）

```bash
npm run electron:dev
```

| # | 操作 | 期望 |
|---|---|---|
| 1 | 打开应用（无消息，空态） | 卡片**顶部**出现工作空间行，显示当前目录 basename |
| 2 | 点击该行 | 弹出 combobox：「最近打开」分组（首次为空则只有「打开其他文件夹…」）+ 分隔线 + 打开其他文件夹 |
| 3 | 选中另一目录 | 卡片行、标题栏 chip **同步**更新（不能只有一处变） |
| 4 | 发一条消息 | 新会话 JSONL 的 `cwd` == 新路径（证明切换真落到 host，不只是 UI 换了皮） |
| 5 | 切 A→B→A | 第二次回 A **不弹**系统目录框 |

### 8.2 二期（快捷键 + 命令面板）

| # | 操作 | 期望 |
|---|---|---|
| 1 | `Ctrl+K` → 搜「工作区」→ 回车 | 真的弹出目录选择器（当前无反应，可直接证伪现状） |
| 2 | 按 `Ctrl+O` / `Ctrl+N` | 分别触发打开工作区 / 新建任务（当前均不生效） |
| 3 | 遍历命令面板每一条已渲染项 | 每条的快捷键按下都有效；不出现「点了没反应」的项 |

### 8.3 关联门禁

```bash
npm run check:frontend-design-tokens   # 新增组件不得硬编码色值
npm run check:frontend-size            # 前端体积守卫
npm run check:changed                  # 提交前变更集检查
```

---

## 9. 待核实项（编码前须先闭环）

| # | 问题 | 为什么重要 |
|---|---|---|
| 1 | `App.tsx:202-209` 的 `workspacePath` 只在 mount 拉一次（`useEffect` deps 为 `[]`），未监听 `khy:workspace-changed`；而 `AppLayout.tsx:261-264` 与 `TitleBar` 各自刷新 ⇒ **`AppHeader` 的工作区信息在切换后可能陈旧** | 若成立，一期必须一并修，否则卡片行是新的、`AppHeader` 是旧的，反而放大不一致 |
| 2 | `AppLayout` 的 `listSessions` 拉取是否在切换工作区后重跑 | 决定「切完工作空间，侧栏会话列表要不要跟着换」 |
| 3 | `main/menu.ts` 是否还有别处动态 `import`（本次仅静态搜索） | 决定二期是「删」还是「降级改造」（§6 #7） |
| 4 | `zcode-analysis/` 解包产物的留存合规性 | 本提案只读不动它；若评审认为需单独处置，另开条目 |

---

## 10. 实施记录（2026-09-18）

> 本提案先于代码落盘、经用户确认后才开始实施，满足 SOURCING-003 B-P2.1「先提案、后编码」。

### 10.1 一期：卡片内工作空间选择行（P-01 + P-02）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/main/settingsStore.ts` | 新增默认字段 `desktopRecentWorkspaces: []`（注明它不是第二个真源） |
| 2 | `src/main/index.ts` | 新增 `readRecentWorkspaces()` / `switchWorkspace()` 两个内部函数；新增 IPC `workspace:list` / `workspace:open` |
| 3 | `src/preload/index.ts` | 暴露 `workspaceList` / `workspaceOpen` |
| 4 | `src/renderer/utils/openWorkspace.ts`（新增） | 切换工作空间的**唯一**渲染层入口：发起 → 广播 `khy:workspace-changed` → 提示用户 |
| 5 | `src/renderer/components/workspace/WorkspacePicker.tsx`（新增） | 选择器组件，`card-header` / `titlebar` 两态共用同一实现 |
| 6 | `src/renderer/components/composer/Composer.tsx` | 新增 `header?: ReactNode` 槽位（含分隔线） |
| 7 | `src/renderer/App.tsx` | 空态卡片传入 `header={<WorkspacePicker/>}`；`workspacePath` 改为订阅 `khy:workspace-changed` |
| 8 | `src/renderer/components/layout/TitleBar.tsx` | 只读 chip → `WorkspacePicker`；菜单「打开工作区」改调共用入口；订阅 `khy:workspace-changed` |
| 9 | `src/renderer/components/layout/WorkspaceSidebar.tsx` | 「添加项目」改调共用入口 |

切换逻辑由「3 份重复实现」收敛为 1 处；空态卡片是第 4 个入口，但共用同一函数。
**§9 待核实项 #1 已确认为真并修复**：`App.tsx` 原先只在挂载时拉一次 `workspacePath`，切工作空间后
`AppHeader` 显示旧根（`TitleBar` / `AppLayout` 各自刷新，唯独 App 层没订阅）。现已订阅。

### 10.2 二期：快捷键单一真源 + 命令面板诚实化（P-03）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/renderer/shared/keymap.ts`（新增） | 纯叶子：7 条绑定 + `resolveDesktopAction()` + `keyLabelFor()` |
| 2 | `src/renderer/App.tsx` | 全局监听改为查表；`Ctrl+N` / `Ctrl+O` / `Ctrl+,` 首次真正生效 |
| 3 | `src/renderer/components/layout/AppLayout.tsx` | 面板快捷键 `Ctrl+Alt+B` / `Ctrl+J` 接线；向命令面板注入 `onNewTask` / `onReloadSession` |
| 4 | `src/renderer/components/message/CommandCenter.tsx` | 命令 28 → **13 条，全部真接线**；键位徽标改从 keymap 取 |
| 5 | `src/renderer/components/layout/TitleBar.tsx` | 菜单键位标签改从 keymap 取（不再手写字符串） |

**删除清单（14 条，连同其假快捷键）**：命令面板自身、查找任务(`Ctrl+F`)、切换模型、切换执行模式(`Shift+Tab`)、
思考强度、压缩上下文、技能、MCP 服务器、问题反馈、用户社群、检查更新、导出日志、开发者工具(`F12`)、切换全屏(`F11`)。
理由：既无后端能力也无现成 UI 可接线，留着就是「点了没反应」的假功能。模型与执行模式的真正入口是
Composer 工具行右下角那一簇；技能与 MCP 在设置页。

**`console.log` 空壳计数：20 → 0**（仓库棘轮的 `countConsole` 实测，它先剥掉 `//` 行注释再计数）。

### 10.3 与方案的偏离（逐条给原因）

| # | 方案原定 | 实际做法 | 原因 |
|---|---|---|---|
| 1 | keymap 落点 `src/shared/keymap.ts` | `src/renderer/shared/keymap.ts` | `tsconfig.node.json` 的 include 含 `src/shared/**/*`（那是主进程/preload 工程，产物进 `dist-ts`）。渲染层专用的叶子放进去会让每次新增都依赖 node 工程先重建，且 `tsc` 直接报 TS6305 |
| 2 | 卡片 header 分隔线通栏到底 | 内缩在卡片内边距之内 | 通栏需要给卡片外壳加 `overflow-hidden`，而 `AddContextButton` / 模型选择器的弹层是 `absolute bottom-full` **向上溢出**的，加了会被裁掉 |
| 3 | 方案未指定「广播由谁发」 | 由渲染层发，沿用既有窗口事件 `khy:workspace-changed` | main 侧发 IPC 事件等于新增一条事件通道；而既有事件已有 3 个消费者在监听，沿用即可 |
| 4 | 「不能接线的直接不渲染」 | 删除 14 条（而非置灰） | 置灰仍占位置并暗示「以后能用」；把不存在的功能撤下更诚实 |
| 5 | 未提及 | 顺手修 Composer 两处既有缺陷 | 见 §10.4 |

### 10.4 顺带修复的既有缺陷（各 1 行，均在本次已改动的文件内）

| # | 缺陷 | 证据 | 修复 |
|---|---|---|---|
| 1 | `Composer.tsx` 调用了 `addToast` 却从未 import 它 | `dispatch(addToast(...))` 出现在文件选择失败路径上；import 列表里没有 `toastSlice` | 补 `import { addToast } from '../../state/toastSlice'`。修前该路径一旦执行就是 ReferenceError |
| 2 | `Composer.tsx` 解构并使用 `modelName`，却没写进 props 类型 | 改前 props 类型只有 `prefillText`…`onModeChange`；`App.tsx:330/367` 传 `modelName` 一直是类型错误 | 补 `modelName?: string` |

### 10.5 验收结果（实测，可复现）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | 桌面端 UI 契约（含 D6「preload↔main 通道一致」、D9 品牌合规） | `node --test apps/khyos-desktop/tests/desktopUiContract.test.cjs` | **26/26 pass**，新通道两侧齐备 |
| 2 | 渲染层类型检查 | `tsc -p apps/khyos-desktop/tsconfig.json --noEmit` | **本次改动零新增错误**（改前 5 条关于 `modelName`/`addToast` 的报错已消失）；剩余全部是既有债，见 §10.7 |
| 3 | 前端设计令牌 | `npm run check:frontend-design-tokens` | `checked=333 findings=53 exit=0` —— findings 全部落在 `apps/ai-frontend` 与 `khyquant/frontend`，**新增组件零 finding** |
| 4 | 前端体积 | `npm run check:frontend-size` | exit=2，原因是产物目录不存在（需先 `build`），**与本次改动无关** |
| 5 | 防劣化棘轮 | `npm run check:file-ratchet` | 本机跑到 **8 分 29 秒仍未完成，已终止**（该检查器按 `GIT_BASE_REF` 比对基线，本地场景不适用，交 CI）。静态核对：HARD 指标里 `consoleCount` 由 20 → 0，`debugger` 0，无新增 `TODO/FIXME` |
| 6 | **构建产物完整性** | `electron-vite build` 后在新 `out/` 中 grep 本次新增标识符 | **exit=0（35s）**；`desktopRecentWorkspaces` / `resolveDesktopAction` / `workspaceOpen` 在 `out/main`、`out/preload`、新渲染包 `index-NjUDTL7C.js` **三处均命中**，`out/renderer/index.html` 已指向该新包 |

> **第 6 行是补测的**：首轮只验了 1-4 就直接交付，用户反馈「还是没变」——因为他跑的是
> `out/` 里的旧构建产物，而我改的是源码。`out/main/index.js` 用的是
> `win.loadFile("../renderer/index.html")`（生产构建，非 dev server），所以**源码改完必须重建 +
> 重启应用**才可见。这条教训已写进 skill `khyos-design-proposal` §8.3。

### 10.6 第二轮修复：自动化页空白 + 全站缺错误兜底（用户实测反馈）

用户反馈「自动化页面点击后是空白」。实测根因**不在自动化功能本身**，而是一条 TDZ 崩溃，
外加一个早就实现却从未挂载的错误边界。

#### a. 白屏根因：渲染期 TDZ（`AutomationsPage.tsx`）

| 事实 | 位置 |
|---|---|
| 轮询 effect 的**依赖数组**里引用了 `refresh` | 改前 `AutomationsPage.tsx:116` — `}, [hasRunning, refresh])` |
| 而 `refresh` 在这之后才用 `const` + `useCallback` 声明 | 改前 `AutomationsPage.tsx:123` |
| 依赖数组是**渲染期求值**的 ⇒ 每次进页面即抛 `Cannot access 'refresh' before initialization` | — |
| React 卸载整棵树 ⇒ 纯白屏 | — |

**这是「同一个 bug 被两套机制看见」的典型**：`tsc` 早就在报
`TS2448 Block-scoped variable 'refresh' used before its declaration` + `TS2454 Variable 'refresh' is used before being assigned`，
但既有类型债长期漂在噪声里，没人当回事 —— 直到它变成用户可见的白屏。
**修复**：把 `flash` / `refresh` / 首屏 effect 整体移到轮询 effect 之前，并在原地留下顺序警告注释，
防止后续改动把这四处对调回去。

#### b. 为什么是白屏而不是报错：`ErrorBoundary` 从未挂载

`ui/ErrorBoundary.tsx` 组件本身是完整的（含「重试 / 刷新应用」与组件堆栈折叠），
它的兜底文案里写着「刚才的页面错误已经被拦住了，**所以不会直接白屏**」——
但全仓 grep 显示：**除自身定义外零处引用**。设计意图在，挂载点不在，于是任何渲染期异常都是纯白屏。

**修复**：补上三级挂载。

| 层级 | 位置 | 形态 | 作用 |
|---|---|---|---|
| 顶层 | `main.tsx`，包住 `<App />` | 非 section | 兜住 App 自身的渲染错误，任何异常都不再是白屏 |
| 路由页 | `App.tsx` 的 `keyManager` / `settings` / `automations` 三个分支 | 非 section | 全屏页面崩了给出重试入口，而不是空白 |
| 内容区 | `App.tsx` 主布局的 `flex-col` 内容块 | `section` | 崩了只替换内容区，标题栏与侧栏保持可用（正是 section 文案的语义） |

#### c. 顺带修掉的契约缺口：`skipped`

`fireAutomation` 在「调度触发撞上上一条仍在跑」时会返回 `{ ok: true, skipped: true }`
（`main/index.ts:432`），但它自己的返回类型（`main/index.ts:418`）只写了 `ok` / `error`，
渲染层的 `KhyosAutomationsApi.automationsRunNow`（`AutomationsPage.tsx:37`）也跟着漏了。
**运行时是好的，是契约没写全** —— 与 §10.7 里 `aiSend` 那 8 条同属一类。两处类型已补齐。

#### d. 本轮验收

| # | 检查 | 结果 |
|---|---|---|
| 1 | `tsc -p apps/khyos-desktop/tsconfig.json --noEmit` | **31 → 28 条**，正好少掉 `AutomationsPage.tsx` 的 3 条；`App.tsx` / `main.tsx` / `ErrorBoundary` **零新增错误** |
| 2 | `electron-vite build` + 在 `out/` grep 新标识符 | 见 §10.5 第 6 行的同款流程（本轮同样执行后交付） |

### 10.7 明确不做 / 遗留

- **三期 TUI 前缀键**：仍按 §7 等「按键占用普查」，本轮**一行未动 TUI**。
- **既有类型债 28 条**（本轮修掉 3 条后的实测值，由 31 → 28；**修正**：首轮登记时误记为 33），
  分布在本提案未触及的文件，建议另开条目：
  `src/host/index.ts`（15 条）、`Composer.tsx` 的 `aiSend` 返回类型偏窄（8 条）、
  `BrowserPane.tsx`（3 条）、`ui/Tooltip.tsx`（1 条）、`i18n/index.ts`（1 条，`import.meta.env` 未声明）。
  其中 `aiSend` 那 8 条值得优先：**UI 在真实读取 `empty` / `actualAdapter` / `provider` / `fallbackReason`
  四个字段，而 preload 的契约只声明了 `ok` / `text` / `error`** —— 这是契约漂移，不是纯类型噪声。
- **`main/menu.ts` 处置未决**：§9 待核实项 #3 仍未闭环（静态搜索未见任何 importer）。它当前既不生效也不害人，
  删除或降级属维护者决策，本轮不动，仅记录。

---

## 11. 变更日志

- 2026-09-18：初版。基于 `apps/khyos-desktop` 实测（`App.tsx` / `Composer.tsx` / `EmptyState.tsx` /
  `CommandCenter.tsx` / `TitleBar.tsx` / `WorkspaceSidebar.tsx` / `main/index.ts` / `main/menu.ts` /
  `preload/index.ts` / `state/workspaceSlice.ts` / `cli/tui/chatChords.js`）与 `[DESIGN-RES-001]`/`[DESIGN-RES-002]`
  既有调研。状态：待评审，尚未编码。
- 2026-09-18：**一期 + 二期实施完成**（§10）。改动 12 个源码文件（新增 3 / 修改 9），
  命令面板 28 → 13 条且全部真接线，`console.log` 空壳 20 → 0。
  验收：UI 契约 26/26 通过、类型检查零新增错误、设计令牌零 finding。
  与方案偏离 5 条（含 keymap 落点从 `src/shared` 改到 `src/renderer/shared`）、顺带修既有缺陷 2 条，
  见 §10.3 / §10.4。三期 TUI 前缀键未动，既有类型债另行登记（§10.7）。
- 2026-09-18（晚）：**第二轮修复：`#/automations` 白屏 + 全站补上错误兜底**（§10.6）。
  根因是渲染期 TDZ（`AutomationsPage.tsx` 轮询 effect 的依赖数组引用了尚未声明的 `refresh`），
  而 `ErrorBoundary` 组件早已实现却零处挂载，所以崩溃表现为纯白屏而非报错。
  修复：调序 + 补齐 `skipped` 契约 + 三级挂载错误边界（`main.tsx` / 三个路由分支 / 内容区 section）。
  验收：`tsc` 31 → 28（正是那 3 条），零新增。
