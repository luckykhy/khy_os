# [ZC-ALIGN-003] ZCode 设置页逐项对齐补充（第四轮 computer-use 实测）

> 本文件是 ZC-ALIGN-002「页面/弹窗穷举清单」的**增量补充**：把 002 里标 ◻（未核对）
> 的设置内容页，在第四轮 computer-use 实测中逐一打开、截图、读 a11y 树，落地为
> **逐页设计对齐笔记**——ZCode 真实结构 → khy-os 复刻现状 → 缺口 → 修法。
> 与 092 / ZC-ALIGN-001 / ZC-ALIGN-002 冲突时，以 092 + 002 为准；本文件只补 002 的空白。
>
> - 审计日期：2026-09-12（第四轮）
> - 审计对象：真实 ZCode Desktop v3.11.2（`C:\Program Files\ZCode\ZCode.exe`，
>   pid 4872 → 中途重启为 pid 8900，账号由 `ntblocfk` 变为 `旅行者8665`）
> - 证据：`docs/zcode-pages/` 下 22 张 PNG + 每页 a11y 全树（`get_app_state detail=full`）
> - 方法：computer-use element AXPress 导航 + `shot.ps1` 全屏截屏 + a11y 树逐字段提取

---

## 0. 本轮新增截图清单（22 张，其中本轮新拍/重拍 7 张）

| 文件 | 内容 | 大小 | 拍摄 | 备注 |
|------|------|------|------|------|
| 01-常规.png | 常规设置全页 | 105KB | 04:05 重拍 | 替换 03:01 旧版，内容更完整 |
| 02-外观.png | 外观设置 | 101KB | 03:02 | 前轮遗留，未重拍 |
| 03-模型设置.png | 模型设置页 | 96KB | 03:00 | 前轮遗留（002 I7 已实拍） |
| 04-浏览器控制.png | 浏览器控制设置 | 83KB | 03:03 | 前轮遗留 |
| 05-电脑控制.png | 电脑控制设置 | 58KB | 03:04 | 前轮遗留 |
| 06-记忆.png | 记忆设置 | 54KB | 03:05 | 前轮遗留 |
| 07-子智能体.png | 子智能体设置 | 79KB | 03:06 | 前轮遗留 |
| 08-插件.png | 插件页 | 87KB | 03:06 | 前轮遗留 |
| 08b-插件tab.png | 插件 tab 视图 | 97KB | 03:07 | 前轮遗留 |
| **09-MCP服务器.png** | **MCP 服务器页（新）** | 92KB | 04:08 | **002 I5 内容页由 ◻→✅** |
| 10-技能tab.png | 技能 tab 视图 | 86KB | 03:09 | 前轮遗留 |
| 11-命令.png | 命令页 | 68KB | 03:10 | 前轮遗留 |
| 11b-命令列表.png | 命令列表视图 | 57KB | 03:11 | 前轮遗留 |
| 12-钩子.png | 钩子页 | 71KB | 03:12 | 前轮遗留 |
| 12b-钩子列表.png | 钩子列表视图 | 57KB | 03:13 | 前轮遗留 |
| 13-索引库.png | 索引库设置 | 61KB | 03:14 | 前轮遗留 |
| 14-使用统计.png | 使用统计页 | 109KB | 03:15 | 前轮遗留 |
| **15-引导.png** | **引导页 → 首次启动弹窗（新）** | 483KB | 04:43 | **002 I12 / R3 由 ◻→✅** |
| **15b-引导迁移向导.png** | **数据迁移向导弹窗（新）** | 131KB | 04:46 | **002 R3 由 ◻→✅** |
| **16-账户菜单.png** | 账户 chip 展开菜单 | 89KB | 04:11 | 002 C1 增量证据 |
| **17-账户-语言子菜单.png** | 界面语言子菜单 | 64KB | 04:26 | 002 C1 子菜单细化 |
| **18-账户-缩放子菜单.png** | 界面缩放子菜单 | 65KB | 04:33 | 002 C1 子菜单细化 |

> 19-账户-主题子菜单：本轮未单独截图；002 C1 已有实拍记录
> （`s-31/s-33`：界面主题 > 子菜单＝系统默认／深色主题✓／浅色主题），不补。

---

## 1. 引导页（002 I12 / R3，由 ◻ → ✅）

### 1.1 ZCode 真实结构（a11y 实测，pid 8900，s-8/s-11/s-12）

「引导」导航项**不是设置内容页，而是一个模态弹窗触发器**。点击后弹出「欢迎使用 ZCode」
首次启动设置弹窗（全屏遮罩 + 居中卡片），结构如下：

```
┌─ 首次启动设置 ─────────────────────────────┐
│  选择如何开始第一次会话。                    │
│                                             │
│  [数据迁移向导]  ← 次要按钮（opens wizard） │
│  [开始使用 ZCode] ← 主按钮（focused，直接进入）│
│                                             │
│  ── 两条路径说明 ──                          │
│  • 可立即导入旧工具设置，或先跳过，稍后在    │
│    设置中继续迁移。                          │
│  • 选择一个工作区，继续上次的进度，保持界面   │
│    干净清爽。快速打开，专注工作。            │
└─────────────────────────────────────────────┘
```

弹窗右上 `Close`（X）按钮关闭后回到设置页（非工作区）。

### 1.2 数据迁移向导（点击「数据迁移向导」后，s-12 实测）

**多步骤模态**，标题栏 `会话` + `Close` + `上一步` / `继续` 底部按钮。当前步骤
`选择工作区`：

```
迁移向导                                    [Close]
┌─ 左列：检测结果摘要 ─┐  ┌─ 右列：当前步骤 ────────────────┐
│ 迁移 6              │  │ 选择工作区                       │
│ AGENTS.md 5         │  │ 查看检测结果，选择要迁移的会话…   │
│ 命令 4              │  │                                  │
│ MCP 服务器 3        │  │ [扫描候选会话] 按钮               │
│ Skills 2           │  │ 会话数 combobox: 100 个会话        │
│ 会话 1             │  │ 时间窗 combobox: 最近 30 天        │
│                    │  │ 已选择 0 个工作区                 │
│                    │  │ （空态）暂无可迁移工作区。请先扫描 │
│                    │  │ 本地历史，再勾选要迁移的工作区。  │
│                    │  │ [全选] (disabled)                │
└────────────────────┘  └──────────────────────────────────┘
                                  [上一步]  [继续]
```

左列是**检测到的外部 Agent 资产计数**（Claude Code / Codex 等本地历史扫描结果），
6 个类别：迁移 / AGENTS.md / 命令 / MCP 服务器 / Skills / 会话。

### 1.3 khy-os 复刻现状

- **完全缺失**：复刻无引导/Onboarding 弹窗，无数据迁移向导。
- 002 I12 标「未实现」，R3 标「未实现」——本轮确认。

### 1.4 对齐修法（P2，非阻塞，但影响首跑体验）

1. **引导弹窗**：新增 `OnboardingDialog` 组件（模态），仅在「首次启动」
   （检测 `~/.khyquant/.onboarded` 标记不存在时）弹出。两条路径：
   - 「开始使用 KhyOS」→ 写标记，进入主工作区
   - 「数据迁移向导」→ 进入 `MigrationWizard` 组件
2. **迁移向导**：扫描本地 Claude Code / Codex / ZCode 配置目录
   （`~/.claude/`、`~/.codex/`、`%APPDATA%/ZCode/`），提取 AGENTS.md / 命令 /
   MCP 服务器 / Skills / 会话历史，让用户勾选导入。复刻后端已有 `aiGateway`，
   可复用 `services/backend/src/services/` 下的配置读取逻辑。
3. **引导入口常驻**：设置 → 引导页内容 = `优化体验` toggle（数据使用授权）+
   `打开引导` 按钮（重新弹出向导），对齐 s-30 [29]/[33]。

---

## 2. MCP 服务器页（002 I5，由 ◻ → ✅）

### 2.1 ZCode 真实结构（a11y 实测，pid 4872，s-32/s-33）

```
MCP 服务器                              [用户 ▾]    ← 顶部：作用域 + 计数
[搜索 MCP 服务器…]                           ③      ← 搜索框 + 总数 badge

已安装 0                                     ← 用户安装区（空态）
─────────────────────────────────────────────
  尚未安装 MCP 服务器
  手动新建服务器，或导入已有配置。
  [新建]  [刷新]  [更多操作 ▾]

─────────────────────────────────────────────
  ↓ 插件宿主区（3 个由插件提供、非用户安装的 MCP 服务器）

  ┌─ node_repl ──────────────────── 浏览器操作 1 ─┐
  │ 该 MCP 服务器由 ZCode 宿主为 browser-use 插件 │
  │ 提供，运行时身份由宿主管理。        [详情 ▾] │
  └──────────────────────────────────────────────┘
  ┌─ computer-use ───────────────── 电脑控制 1 ─┐
  │ 该插件 MCP 服务器已连接并可用。    [详情 ▾]  │  ← 绿点=已连接
  └──────────────────────────────────────────────┘
  ┌─ image_search ───────────────── 文档技能 1 ─┐
  │ 当前账号没有 Coding Plan，请先购买或  [详情 ▾]│  ← 红点=无套餐
  │ 配置 Coding Plan。                          │
  └──────────────────────────────────────────────┘

[新建 MCP 服务器]  [导入]                       ← 底部操作
```

### 2.2 关键发现（002 未记录的细节）

1. **双层结构**：MCP 页分「用户安装」(已安装 N) + 「插件宿主」(plugin-provided)
   两区。插件宿主区的服务器**不可删除/编辑**，只能查看状态。
2. **插件宿主身份托管**：`node_repl` / `computer-use` / `image_search` 三个 MCP
   服务器由 ZCode 宿主进程为对应插件（browser-use / computer-use / document-skills）
   提供，运行时身份由宿主管理——用户无需配置 API key。
3. **状态三态**：
   - 已连接并可用（computer-use，绿点）
   - 无套餐不可用（image_search，红点 + "当前账号没有 Coding Plan"）
   - 宿主提供但未显式说明连接状态（node_repl）
4. **卡片字段**：server name（monospace）+ capability label（中文）+ 工具数 badge
   + 状态文案 + `[详情 ▾]` has_menu 按钮。
5. **作用域切换**：顶部 `用户 ▾` dropdown，推测可切 `用户` / `工作区` 作用域
   （类似 VSCode settings scope）。

### 2.3 khy-os 复刻现状

- 复刻无 MCP 服务器管理页（002 I5 标「未实现」）。
- khy-os 有 MCP 适配器（`services/backend/src/services/gateway/`），但无 UI 管理。

### 2.4 对齐修法（P1，Agent 能力板块核心）

1. **MCP 管理页**：新增 `McpServersSettings` 组件，双层结构：
   - 顶部：搜索 + 作用域 dropdown + 已安装计数
   - 用户安装区：空态 + 新建/导入/刷新/更多操作
   - 插件宿主区：只读卡片列表（server name + capability + status + 详情菜单）
2. **新建/导入流程**：
   - 新建 → 表单（名称 + 协议 stdio/HTTP/SSE + 命令/URL + env + OAuth）
   - 导入 → 从 JSON 剪贴板 / 文件导入 `mcp.json`
3. **状态映射**：从 `services/backend/src/services/gateway/mcpPool.js` 读连接状态，
   映射到绿点/红点/灰点。
4. **套餐门控**：`image_search` 类需要 Coding Plan → khy-os 替换为自有授权
   （`tokenUsageService` 配额检查），文案改 "当前账号无 X 权限"。

---

## 3. 常规设置页（002 I1，内容由 ◻ → ✅）

### 3.1 ZCode 真实结构（a11y 全树，pid 4872，s-30）

常规页是**单列滚动表单**，约 25 个设置项，分 6 组：

| 组 | 设置项 | 控件类型 | 默认值 / 实测值 |
|----|--------|---------|----------------|
| **数据** | 数据存储路径 | textfield + 选择文件夹 | `C:\Users\25789`（后缀 `.zcode/v2`） |
| | 归档保留时长 | combobox (disabled) | `7 天后归档` |
| | 自动归档旧任务 | toggle | — |
| **消息流分组** | 分组文件更改 | toggle | 聚合 Write/Edit/ApplyPatch 为 Changes |
| | 分组终端命令 | toggle | 聚合非只读 Shell 为 Terminal |
| | 分组探索工具 | toggle | 聚合读取/搜索为 Explore |
| **消息流显示** | 显示待办 | toggle | Todo 工具卡片 |
| | 显示思考过程 | toggle | 完整 reasoning（关闭后每轮只显首思） |
| | 完整保留模型 I/O | toggle | 不压缩/限制/删除 |
| | 提问自动继续 | toggle | 5 分钟未答自动继续 |
| | 交互行为 | combobox | `队列` |
| **系统行为** | 保持电脑运行 | toggle | 阻止空闲休眠 |
| | 关闭窗口时隐藏到托盘 | toggle | Windows 专属 |
| | 通知声音 | toggle | 任务通知提示音 |
| | 任务通知 | toggle | 完成/失败/需确认时通知 |
| **更新** | 自动下载并安装更新 | toggle | — |
| | 接受提前收到预览版更新 | toggle | — |
| | Chrome 硬件加速 | toggle | 关闭可规避白屏/闪退 |
| **网络/证书** | 自定义证书 | textfield + 保存 | PEM 路径 → `NODE_EXTRA_CA_CERTS` |
| | 不使用代理的地址 | textfield + 保存 | `localhost,127.0.0.1,...` |
| | HTTP 代理 | textfield + 保存 | `http://127.0.0.1:7890` |
| **终端** | 增强 Find 和 Grep | toggle | 新会话/重启后生效 |
| | 集成终端 Shell | combobox | `自动选择`（Git Bash → cmd 回退） |
| | 终端字体 | textfield + 保存 | 留空自动继承 |
| | 继承系统终端 Profile | toggle | 登录 shell + 代理 + Kube + 字体 |
| **语言** | 界面语言 | combobox | `系统默认` |
| **引导** | 优化体验 | toggle | 数据使用授权 |
| | 打开引导 | button | 重新弹出 Onboarding |

### 3.2 khy-os 复刻现状

- 复刻无设置页（002 I1 标「未实现」）。
- ZC-ALIGN-001 I1 已标「未实现」。

### 3.3 对齐修法（P0，设置域是 IDE 完整度门槛）

1. **设置页骨架**（已在 ZC-ALIGN-001 I1 规划）：全屏替换式 + 左导航三组
   `基础设置 / Agent 能力 / 数据与统计` + 独立项 `引导` + `返回工作区`。
2. **常规页**：按上表 25 项逐个实现，控件用复刻已有的 `Toggle` / `ComboBox` /
   `TextField` 组件。每项 = `label + description + control` 三栏布局。
3. **分组聚合**：3 个 toggle（文件更改/终端命令/探索工具）控制消息流工具调用
   的聚合显示——复刻 `MessageList` 需支持 Changes / Terminal / Explore 分组容器。
4. **终端继承**：`继承系统终端 Profile` + `集成终端 Shell` + `终端字体` 三项
   对齐 092 `terminalInheritSystemProfile`，复刻 Terminal 组件需读这三项。
5. **网络/证书**：`HTTP 代理` / `不使用代理的地址` / `自定义证书` 三项写入
   `~/.khyquant/config.json` 的 `network` 段，host 进程启动时注入 `HTTP_PROXY` /
   `NODE_EXTRA_CA_CERTS` / `NO_PROXY` env。
6. **归档**：`归档保留时长` + `自动归档旧任务` → scheduler 进程定时扫描
   `~/.khyquant/conversations/` 归档超期会话。

---

## 4. 账户菜单子菜单（002 C1 增量细化）

### 4.1 界面语言子菜单（s-44 实测）

```
界面语言 >
  ○ 系统默认        ← 默认选中
  ○ English
  ○ 中文简体
```

radio 单选，3 项。对应 i18n `settings.language.*`。

### 4.2 界面缩放子菜单（s-46 实测）

```
界面缩放 >
  放大 Ctrl++        ← pressable
  缩小 Ctrl+-        ← pressable
  实际大小 Ctrl+0     ← disabled（当前已是 100%）
```

menuitem 三项，`实际大小` 在缩放=100% 时 disabled。快捷键直接绑定。

### 4.3 界面主题子菜单（002 C1 旧轮实拍，未重拍）

```
界面主题 >
  ○ 系统默认
  ○ 深色主题  ✓
  ○ 浅色主题
```

### 4.4 完整账户菜单结构（s-42 实测，pid 8900 账号 `旅行者8665`）

```
旅行者8665                          ← 账号名（focused header，非 pressable）
界面语言 >                          ← has_menu (radio: 系统默认/English/中文简体)
界面主题 >                          ← has_menu (radio: 系统默认/深色✓/浅色)
界面缩放 >                          ← has_menu (放大/缩小/实际大小[disabled])
─────────                          ← separator
使用统计                            ← pressable（跳设置→使用统计）
升级                                ← pressable（跳升级套餐弹窗 G0e）
─────────                          ← separator
断开连接                            ← pressable（logout.*）
```

### 4.5 khy-os 复刻现状

- ZC-ALIGN-001 C1 标「缺」——复刻无账户 chip + 菜单。
- ZC-ALIGN-001 A4 已把账号区加到 `WorkspaceSidebar` 底部，但**无展开菜单**。

### 4.6 对齐修法（P1）

1. **账户 chip**：`WorkspaceSidebar` 底部账号 chip 改为 `has_menu` button，
   AXExpand 打开下拉菜单。
2. **三子菜单**：
   - 界面语言 → radio 3 项，写 `~/.khyquant/config.json` `ui.locale`
   - 界面主题 → radio 3 项，写 `ui.theme`，触发 `document.documentElement.classList`
     切换 `theme-dark` / `theme-light`
   - 界面缩放 → menuitem 3 项，调 `webFrame.setZoomFactor()` (Electron) 或
     `document.body.style.zoom`
3. **使用统计 / 升级**：菜单项跳转对应设置页 / 升级弹窗。
4. **断开连接**：清 `~/.khyquant/config.json` 的 `auth.token`，回登录态。

---

## 5. 对 ZC-ALIGN-002 清单的更新（◻ → ✅ 汇总）

| 002 编号 | 名称 | 002 状态 | 本轮更新 | 证据 |
|----------|------|----------|----------|------|
| I5 | MCP 服务器内容页 | ◻ | ✅ | 09-MCP服务器.png + s-32 a11y |
| I12 | 引导导航项 | ✅(导航) | ✅(内容) | 15-引导.png + s-8 a11y |
| C1 | 账户菜单子菜单 | ✅(主菜单) | ✅(三子菜单) | 16/17/18.png + s-44/s-46 a11y |
| R3 | 首次引导 Onboarding | ◻ | ✅ | 15b-引导迁移向导.png + s-12 a11y |
| I1 | 常规设置内容页 | ◻ | ✅ | 01-常规.png + s-30 a11y 全树 |

### 仍未核对（保持 ◻，需特定触发或破坏性操作）

| 002 编号 | 名称 | 原因 |
|----------|------|------|
| I2 | 插件内容页 | 导航项 ✅，内容页本轮未点入（留待实现时按需） |
| I3 | 技能内容页 | 同上 |
| I4 | 子智能体内容页 | 同上 |
| I6 | 浏览器控制内容页 | 同上 |
| I8 | 使用统计内容页 | 002 已 ✅（前轮），本轮未重拍 |
| I9 | 设置同步 | 可能在常规页内（未发现独立项） |
| H1/H4-H7 | 右面板各磁贴 | 需会话态/独立窗口/git 仓库 |
| F7/F9/F11 | elicitation/hooks/追问 | 需 agent 运行态触发 |
| G2-G4 | #/$// 键入提及 | 需在输入框键入触发 |
| J/N/O/P1/Q/R2 | 更新流/错误边界/环境/Bot/Wiki/登出 | 避免破坏性操作 |

---

## 6. 失真对齐优先级（本轮新增项，接入 ZC-ALIGN-001 §2 方案表）

| 优先级 | 编号 | 任务 | 依赖 |
|--------|------|------|------|
| P0 | D1 | 设置页骨架 + 左导航三组 | ZC-ALIGN-001 A1-A6 已完成 |
| P0 | D2 | 常规页 25 项表单 | D1 |
| P1 | D3 | MCP 服务器管理页（双层结构） | D1 + mcpPool 状态读取 |
| P1 | D4 | 账户 chip 菜单 + 三子菜单 | ZC-ALIGN-001 A4（已完成账号区） |
| P2 | D5 | 引导 Onboarding 弹窗 | D1 + 首次启动检测 |
| P2 | D6 | 数据迁移向导 | D5 + 本地配置扫描 |

> **建议实施顺序**：D1 → D2 → D4 → D3 → D5 → D6。
> D1/D2 是设置域可用性门槛；D4 是账户交互闭环；D3 是 Agent 能力板块核心；
> D5/D6 影响首跑体验但不阻塞核心功能。

---

## 7. 附录：a11y 证据片段（关键页，state_id 可追溯）

### 7.1 引导弹窗（s-8，pid 8900）

```
[12]  欢迎使用 ZCode
[13] button Close (pressable)
[17] text 选择一个工作区，继续上次的进度，保持界面干净清爽。
[19] text 快速打开，专注工作。
[23] text 可立即导入旧工具设置，或先跳过，稍后在设置中继续迁移。
[25] button 数据迁移向导 (pressable)
[26] button 开始使用 ZCode (pressable focused)
[31] text 首次启动设置 = 首次启动设置
[33] text 选择如何开始第一次会话。 = 选择如何开始第一次会话。
```

### 7.2 迁移向导（s-12，pid 8900）

```
[12]  会话 (focused)
[13] button Close (pressable)
[14] button 继续 (pressable)
[15] button 上一步 (pressable)
[16] text 已选择 0 个工作区
[17] text 暂无可迁移工作区。请先扫描本地历史，再勾选要迁移的工作区。
[20] text 选择工作区
[21] button 扫描候选会话 (pressable)
[22] combobox: 100 个会话
[25] combobox: 最近 30 天
[34] text 迁移 = 迁移        [35] text 6
[37] text AGENTS.md          [38] text 5
[40] text 命令              [41] text 4
[43] text MCP 服务器        [44] text 3
[46] text Skills            [47] text 2
[49] text 会话              [50] text 1
[52] text 迁移向导
```

### 7.3 MCP 服务器页（s-32，pid 4872）

```
[26] button 详情 (pressable has_menu)              ← image_search 卡片
[27] text 当前账号没有 Coding Plan，请先购买或配置 Coding Plan。
[29] text image_search
[32] text 文档技能 1  [33] text 1  [34] text 文档技能
[37] text 该插件 MCP 服务器已连接并可用。           ← computer-use 卡片
[39] text computer-use
[42] text 电脑控制 1  [43] text 1  [44] text 电脑控制
[47] text 该 MCP 服务器由 ZCode 宿主为 browser-use 插件提供，运行时身份由宿主管理。
[49] text node_repl
[52] text 浏览器操作 1  [53] text 1  [54] text 浏览器操作
[56] button 导入 (pressable)
[57] button 新建 MCP 服务器 (pressable)
[61] text 尚未安装 MCP 服务器
[62] button 新建  [63] button 刷新  [64] button 更多操作 (has_menu)
[65] text 已安装 0  [69] textfield 搜索 MCP 服务器…
[70] text 3  [71] text MCP  [72] button 用户 (has_menu)
```

### 7.4 账户菜单（s-42，pid 8900）

```
[13] menuitem ntblocfk/旅行者8665 (focused)    bounds=[20,681,250,277]
[14] menuitem 断开连接 (pressable)              bounds=[26,912,238,40]
[16] menuitem 升级 (pressable)                  bounds=[26,857,238,40]
[17] menuitem 使用统计 (pressable)              bounds=[26,817,238,39]
[19] menuitem 界面缩放 (has_menu)              bounds=[26,764,238,37]
[20] menuitem 界面主题 (has_menu)              bounds=[26,725,238,37]
[21] menuitem 界面语言 (has_menu)              bounds=[26,687,238,37]
```

### 7.5 界面缩放子菜单（s-46，pid 8900）

```
[20] menuitem 界面缩放
[21] menuitem 实际大小 Ctrl+0 (pressable disabled)    ← 当前 100% 时灰置
[24] menuitem 缩小 Ctrl+- (pressable)
[27] menuitem 放大 Ctrl++ (pressable)
[30] menuitem 界面缩放 (has_menu focused)
```

---

## 8. 复现步骤留档

```powershell
# ZCode 已运行（C:\Program Files\ZCode\ZCode.exe）
# 截图脚本：docs/zcode-pages/shot.ps1
#   param([string]$Name) → 保存 {Name}.png 到 docs/zcode-pages/

# 导航路径（computer-use element AXPress）：
#   工作区 → 侧栏底部设置齿轮 → 设置页
#   左导航 → 目标页（常规/模型设置/MCP 服务器/引导…）
#   引导 → 弹窗 → 数据迁移向导 → 向导
#   账户 chip → AXExpand → 子菜单 AXExpand

# 截图：
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-pages\shot.ps1" -Name "15-引导"

# 注意：
# 1. ZCode 内嵌 agent 会抢鼠标/键盘 → 截图前先点「停止生成」
# 2. shot.ps1 用 CopyFromScreen(0,0) 截全屏 → 确保 ZCode 窗口在最前
# 3. 引导弹窗是模态 → 关闭后回到设置页，非工作区
# 4. 账号可能因重启变化（ntblocfk → 旅行者8665），不影响菜单结构
```

> 本文件不替代 092 / ZC-ALIGN-001 / ZC-ALIGN-002，只补 002 的 ◻ 空白。
> 下一步：按 §6 优先级表 D1→D2→D4→D3→D5→D6 实施，每完成一项回填 ZC-ALIGN-001 §2 勾选。
