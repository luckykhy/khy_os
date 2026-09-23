# [DESIGN-ARCH-103] TUI 终端界面重设计方案

> **隶属**：本文属 **TUI 设计族**（20 编号 / 21 文件），总纲与 scope 裁决见 `[DESIGN-ARCH-122] TUI 设计族总纲`；规则冲突一律以 `[DESIGN-ARCH-102] Khy TUI 统一规则手册` 为准。

> ## ⚠️ 本文档的规则部分已并入 [DESIGN-ARCH-102] Khy TUI 统一规则手册
>
> **自 2026-09-15 起，本文的硬约束与布局规则不再维护**，全部并入 `[DESIGN-ARCH-102]` §3（硬约束 H1–H10）、§4（布局规范）、§5（组件目录）。
> 本文保留作为**渲染架构的设计说明与 GitHub 调研证据存档**：三区模型的推导、缩放三条根因的论证、四条目标项目（opencode / Claude Code / dsh-TUI / command-code）对照、P0–P3 实施路线、外部证据索引（ink#907 / duo#2747 / claude-code#2479 等）。
> **查阅"必须怎么做"去 102；查阅"为什么这样做"的原始论证与调研证据来本文。规则冲突一律以 102 为准。**

> **定位**：在 [DESIGN-ARCH-079]（布局/组件真源）、[DESIGN-ARCH-086]（CC 复刻总计划）、[DESIGN-ARCH-095]（交互差距与 P0–P3 路线）三层既有设计之上，对 khy-os Ink TUI 做一次**渲染架构层**的重设计。079/086/095 回答「界面长什么样、缺什么、按什么顺序补」，本文回答「**为什么缩放会残影、边框会断、界面会抖，以及要怎么从架构上根除**」。
> **适用边界**：覆盖 `services/backend/src/cli/tui/` 全部渲染路径（Legacy 单栏 + CcApp CC 模式 + 右栏 rail 带外绘制）。**不替代** 079 的组件尺寸规范与配色表（本文只改其"宽度/高度从哪来"的取数方式），**不替代** 095 的协议纪律清单（本文把其中若干条从"补丁"升格为"唯一路径"）。
> **触发**：用户报「缩放操作残留残影、界面不稳定、加载缓慢」三项严重问题，并要求新方案达成五项验收：① 缩放稳定且无残痕 ② 输入框上下边框正常显示 ③ 支持点击展开摘要 ④ 视觉简洁直观 ⑤ 任务看板清晰易用。
> **证据基准**：本地 `file:line` 来自 2026-09-15 实际代码勘察；外部结论全部标注 issue 号或仓库来源。

---

## 0. 结论先行（TL;DR）

当前 TUI 的稳定性问题**不是若干独立 bug，而是一个架构性根因的多种症状**：我们在一套「逐行拼字符串 + 手工维护光标账本」的渲染模型上，持续用补丁对冲 [Ink 的固有缺陷](https://github.com/vadimdemedes/ink/issues/907)，同时叠了 4 套布局分支、2 套看板实现、215 个环境变量门控。补丁越多，账本越难对齐，症状越随机。

三条关键判断：

1. **缩放残影的主因是「行账本按逻辑行、渲染按视觉行」的错配**（Ink #907 原样命中），叠加**右栏 rail 的带外绘制在 resize 时缺少 union-clear**、以及 **120 列处的宽度阶跃导致全树一次性 reflow**。这三者互相放大。
2. **输入框边框"不正常"不是样式问题，是取数与布局问题**：宽度来自 `effectiveCols()` 的隐式全局读取而非显式 props，上下边框用两条**独立** `'─'.repeat()` 计算，MIC 变体还会做 `cols-1-5` 的二次减法。任何一次宽度取值不一致，两条边框就不再等宽。
3. **「点击展开」与「缩放无残影」是同一件事**：dsh-TUI 的实证教训是——展开状态**必须进"行高签名"**，否则展开后布局扫描拿到陈旧行高，直接复现残影。二者必须同批设计、同批落地。

新方案的核心动作：**取消右栏 rail 作为默认路径，把渲染收敛为「滚动区 / 活动区 / 固定框架」三区模型；宽度与高度各收敛为单一真源；缩放改为一次原子 ED0 重绘；展开状态纳入行高签名；门控从 215 收敛到 ≤40。**

---

## 1. 现状审计

### 1.1 规模数据（2026-09-15 实测）

| 指标 | 数值 | 说明 |
|------|------|------|
| `cli/tui/` 下 JS 文件数 | **157** | 含 79 个 ink 组件（075 §1.1 口径） |
| `cli/tui/` 内 `KHY_*` 门控 token 数 | **215**（唯一值） | 095 §1.1 记为「约 280」（含全仓口径） |
| `ink-components/App.js` | **5751 行** | Legacy 路径的**单组件**，承载全部状态与键位路由 |
| `cli/replSession.js` | **13453 行** | Ink 挂载、降级回退、退出清理 |
| `ink-components/ToolLines.js` | 1378 行 | 工具结果渲染 + 行数估算 |
| `tui/sidebarLayout.js` | 759 行 | 看板宽度/激活/全屏判定 |
| `ink-components/CcApp.js` | 552 行 | CC 模式根组件 |
| `tui/scrollbackPreserve.js` | 500 行 | ED2→ED0 改写 + 四层栈 |

**读法**：`App.js` 5751 行意味着**任何一个 state 变化（一次按键、一次心跳、一次流式 chunk）都会让 React 重新生成整棵树**，而 Ink 的标准渲染模式在每次更新时**全量重写整个输出**（Ink 官方文档：Standard 模式 "erases all previous output and rewrites the entire screen on each update"）。这是「加载缓慢」与「界面不稳定」的共同上游，也是所有下游补丁的成因。

### 1.2 架构复杂度：4 条布局路径 × 2 套看板 × 2 套状态栏

| 维度 | 分支 A | 分支 B | 冲突点 |
|------|--------|--------|--------|
| 布局 | Legacy 单栏（079 §1.1 路径 A） | Three-Column 三栏（路径 B） | 两套组件树，需分别验证 |
| 看板 | 右栏 rail **带外 ANSI 绝对坐标绘制**（默认开） | in-tree `SidebarPanel` | 两套几何 + 两套宽度取数 |
| 状态栏 | `FooterBar`（2 行，Legacy） | `Statusbar`（1 行，三栏） | chrome 行数不一致 |
| 用户消息 | 086 Phase 1 声称「无背景框，纯文本 ✅」 | 079 §12.4.1 称「白底模式（默认）背景 `#F0EAD6` 奶油色」 | **两份"单一真源"直接矛盾** |

**已实测确认的两处数值分歧**（同一概念两个公式）：

| 概念 | 公式 1（`tui/sidebarLayout.js`） | 公式 2（`tui/utils/ccLayout.js:52`） | 分歧 |
|------|----------------------------------|--------------------------------------|------|
| 看板宽度 | `clamp(round(cols × 0.16), 24, 36)` | `min(30, floor(cols × 0.25))` | **cols=120 时：24 vs 30** |
| 看板激活阈值 | `KHY_SIDEBAR_MIN_COLS`（默认 120，**可配**） | `shouldShowSidebar = cols >= 120`（**硬编码**） | 用户设 `MIN_COLS=100` 后两处判定永久不一致 |

> 这两处分歧就是「界面不稳定」的一个确定性来源：**看板宽度按 A 公式画、主区宽度按 B 公式留**时，两者之和 ≠ 终端宽度，多出或少掉几列 → 折行点错位 → 残影。

### 1.3 文档与实现的自相矛盾

`tui/mouseButtons.js` 头部注释明确写：

> `KHY_MOUSE_BUTTONS  **默认全平台关**；显式 1/true/on/yes 才开点击层`

但实现是：

```js
// mouseButtons.js:148
return true; // 默认开启（现代终端大概率支持）
```

`autoDetectTerminal()` 的**四条分支全部返回 `true`**（WT_SESSION / TERM_PROGRAM / TERM 包含 / 兜底）。即**默认状态下鼠标追踪是开启的**，用户因此**默认失去终端原生滚轮翻 scrollback 与鼠标拖选复制**——这正是 045 号报告与 095 §4.1「不采纳清单」共同反对的反模式（「内联模式默认启用鼠标滚轮捕获」被明确列为不采纳）。而「点击展开」又是用户本次的明确需求，所以这一条**必须重新裁决**，不能简单改回默认关。

---

## 2. 根因分析

### 2.1 缩放残影（Req ①）

#### 根因 A：行账本按逻辑行、渲染按视觉行 —— Ink #907 原样命中

Ink 在 `src/output.ts` 用 `output.split("\n").length` 计行：

```js
const lines = output.split("\n").length;   // 不计终端软换行
```

缩窗时终端把**已显示的旧行**重新软折成更多行，而 Ink 仍记录折行前的行数 → 下一次重绘上移行数不足 → **顶部旧行擦不掉，成为永久残影**。上游 issue 给出的最小复现就是"渲染一段接近终端宽度的长文本，然后拖窄窗口"。

khy-os 的应对是**逐点预折行**：`PromptFrame` 的 `wrapByWidth()`/`layoutPromptRows()` 把输入按 `avail` 预折成多行再交给 Ink，注释里写得很清楚（"逻辑行数 == 视觉行数，ink 擦除计数准确"）。**这个思路是对的，但只覆盖了输入框**。

未覆盖的路径（每一处都是残影候选）：

| 路径 | 现状 | 风险 |
|------|------|------|
| 助手流式正文 | 交给 markdown 渲染器折行 | 宽度变化时视觉行数变化，无统一计费 |
| 工具结果体（`ToolLines`） | `estimateLiteralRows` **逐分支同源估算**（079 §12.5） | "同源"是**约定**而非构造性保证，分支增删即漂移 |
| 表格 / 代码块 | `wrap-ansi` 硬折 | 硬折自身是逻辑行，但宽度参数变了会整体重构 |
| 右栏 rail 行 | `fit()` 逐行 pad/truncate 到 `geom.width` | 宽度变化时由 `geom` 重算，但**旧几何没擦** |

#### 根因 B：rail 带外绘制缺少 union-clear

`railLayout.js` 用 `railGeometry()` 算 1-based 屏幕坐标，用 `buildRailPaint()` 在 `\x1b[row;colH` 绝对位置画，用 `buildRailClear(geom)` 擦。问题在于**几何不是尺寸的纯函数**：

```js
// railLayout.js:279-305
let bottom = Math.max(1, Math.min(R - 1, R - chrome - topOffset));
...
if (avail < 3 && topOffset <= R - chrome) {   // 小终端局部衰减
  topOffset = Math.max(0, R - chrome - 3);
  bottom = ...;                                // ← 又一次重算
}
const height = Math.max(0, Math.min(cr, avail));
return { on: true, width, left, top: bottom - height + 1, height };
```

一次 resize 后，`chrome`（FooterBar 行数，随 collab/topic 两个布尔变化）、`topOffset`（6 起，小终端会衰减）、`contentRows`（看板内容行数）**三者任一变化都改变 `top`/`height`**。若只按**新**几何重绘、不先擦**旧**几何，则 `old \ new` 的差集就是残影。注释里也承认 clear 的用途是"the shrink half of a resize where the OLD geometry must be wiped"——**但调用点是否真的传了旧几何，依赖调用方纪律**。

#### 根因 C：120 列处的宽度阶跃 → 全树一次性 reflow

`contentCols()` 的窄化是**阶跃函数**：`cols < 120` → 全宽；`cols ≥ 120` → `cols - 24..36`。跨越阈值时**可用宽度瞬间变化 24~36 列**，整棵树的每一个折行点同时改变 → 一次全屏 reflow → 正是根因 A 的触发条件。

现有的对冲手段是 `stickyCols` + `railActiveHysteresis` + `KHY_SIDEBAR_ZOOM_TOL`，但它们**只防"判定翻转"，不防"判定不变但宽度值变了"**：119 → 118 都处于非激活区，判定未翻转所以迟滞不生效，但宽度从 119 变 118，**所有折行仍然重算**。而且每一列的变化都会重算——终端拖拽 resize 是连续的，一秒内可以产生几十个宽度值。

#### 根因 D：行高没有 sticky 化，且 fallback 值不统一

`effectiveCols.js` 为列宽做了完整的 sticky 缓存（`_lastValidCols` + `stickyDim`），但**行高完全没有对应机制**。各处直接读 `process.stdout.rows` 并各自兜底：

| 位置 | 读法 | fallback |
|------|------|----------|
| `PromptFrame.js:373` | `process.stdout.rows && > 0 ? ... : 24` | **24** |
| `railLayout.js:250` | `rows == null ? sidebarLayout.fallbackRows(env) : ...` | `fallbackRows()` |
| `liveHeightClamp` / `liveRegionBudget` | 各自传入的 rows | 调用方决定 |
| `ccLayout.messageAreaCap(cols, rows, ...)` | 调用方传入 | 调用方决定 |

conpty 在 resize 期间会瞬时报 `undefined`（`effectiveCols.js` 头部注释已记录这一现象）。此时**四处各自 fallback 到不同值** → chrome 账本不一致 → 帧高超出视口 → Ink 进入 fullscreen 分支（GitLab duo 报告 #2747：`lastOutputHeight >= rows` 时"full-static-output 每帧全文重印"）→ 剧烈抖动 + 残影。

### 2.2 输入框上下边框异常（Req ②）

`PromptFrame.js:326` 与 `:479` 两条边框**独立计算**：

```js
// 上边框（MIC 变体，:362）
h(Text, {...}, '─'.repeat(Math.max(1, cols - 1 - 5)))
// 上边框（普通，:326）
const border = '─'.repeat(Math.max(1, cols - 1));
// 下边框（:479）—— 复用同一个 border 变量
h(Text, { color: borderColor, dimColor: busy }, border)
```

问题清单：

| # | 问题 | 后果 |
|---|------|------|
| 1 | `cols` 来自 `effectiveCols(80)`（**隐式全局读** `process.stdout.columns`），不是 props | 同一帧内不同组件的取数时点不同 → 顶/底边框宽度可能差 1~36 列 |
| 2 | MIC 变体做 `cols - 1 - 5` 的二次减法 + `Math.max(1, ...)` 兜底 | `cols < 6` 时总宽 = 6 > `cols-1` → 顶边框折行 → **断成两行** |
| 3 | 用 `'─'.repeat()` 而非 display-width pad | 边界值（奇数宽、与 CJK 行混排）下两条边框不等宽 |
| 4 | `busy` 态 `color: undefined` + `dimColor: true` | 部分终端 dim 默认前景 ≈ 不可见 → 边框"消失" |
| 5 | rail 底边锚定公式 `bottom = R - chrome - topOffset` 中 `chrome` 默认 2（`DEFAULT_BOTTOM_CHROME`） | 三栏模式用 1 行 `Statusbar` 时 chrome 多算 1 行 → rail 底边**压住输入框下边框** |
| 6 | 顶/底边框是 `column` Box 的**直接 Text 子节点**，中间行是 `Box` | 宽度不一致时 Ink 的 flex 列不会自动对齐 Text 与 Box 的右边界 |

**结论**：边框"不正常"是**取数架构**问题（隐式全局读取 + 两处独立计算），不是样式问题。仅调样式永远无法收敛。

### 2.3 点击展开缺失且与残影耦合（Req ③）

现状：可点击元素只有 2 个（`PromptFrame` 的 MIC 按钮、待发图片的 ×），工具输出展开唯一路径是 `Ctrl+O`。

外部实证（dsh-TUI PR #848，200k 字符单行实测）：

- 折叠必须在**进入布局引擎之前**完成（`fold-long-lines.ts`），保留行边界（markdown/diff 行模型安全），短文本走零分配快路径，代理对不劈半；
- **`signatureParts` 必须把 `expanded` 与 `expandedRows.has(id)` 纳入行高计算输入**，否则"展开状态不同步导致陈旧行高喂给布局扫描"；
- 该项优化把真实 `MessageList` 挂载从 **162.4ms → 4.5ms**、重渲染 **12.0ms → 0.6ms**。

**这条是本方案最关键的耦合点**：如果先做「点击展开」而不做「行高签名」，展开动作会**直接复现缩放残影**。所以 Req ① 与 Req ③ 必须同批设计。

### 2.4 视觉繁杂（Req ④）

- **门控爆炸**：`cli/tui/` 内 215 个 `KHY_*`，且大量是"默认 = 旧行为 + `0` 回退"的历史兼容层。用户心智负担与回归成本都极高（每加一个门控，测试矩阵翻倍）。
- **无意义装饰**：`Topbar.js` 渲染 `● ● ● KhyOS Desktop` 的 macOS 交通灯——终端里没有窗口可关，纯噪音。
- **两套状态栏**、**两套看板**、**两套布局**（§1.2）。
- **配色硬编码**：079 §6.1 直接给 `#6a92d8`/`#a8a7a0`/`#20201e` 等字面量，无语义分层，无法适配 `NO_COLOR`（095 §3.9 P2-7 已登记为缺口）。

### 2.5 任务看板（Req ⑤）

- **10+ 个调参 + 3 个容差**：`KHY_SIDEBAR_MIN_COLS` / `MIN_ROWS` / `WIDTH_RATIO` / `WIDTH_MIN` / `WIDTH_MAX` / `WIDTH` / `MAX_RATIO` / `MIN_CHROME` / `STACK_MAX_RATIO` / `RAIL_BOTTOM_CHROME` / `RAIL_TOP_OFFSET` + `FULLSCREEN_TOL` / `ZOOM_TOL` / `HYSTERESIS`。多数参数互斥或叠加，普通用户无法预测结果。
- **同一信息两个入口**：右栏 rail 的 4 个 tab（计划/任务/终端/文件）+ 全宽 `TaskListPanel`（Ctrl+T）。
- **"悬浮"而非"侧栏"**：底部锚定 + `topOffset` 默认 6 行，看板悬浮在半空（注释承认这是为了绕开 Ink live 区的结构限制）。这与用户对"侧栏"的心智模型冲突。
- **宽度公式分歧**（§1.2 已实测）。

---

## 3. 外部调研

### 3.1 四个目标项目横向对照

| 维度 | **opencode** | **Claude Code** | **dsh-TUI** | **command-code** |
|------|--------------|-----------------|-------------|------------------|
| 渲染栈 | SolidJS + **@opentui/core**（Zig 原生） | React + **自研渲染器**（弃用 Ink 上游） | React + **Ink** | CLI（细节未公开） |
| 差分粒度 | **Cell 级**：Zig 比较 current/next buffer，只发变化单元格的 ANSI | **Cell 级**：自研 diff | 行级（Ink） | — |
| 双缓冲 | ✅ 两块 2MiB ANSI buffer 交替提交 | ✅ | ❌ | — |
| 损伤追踪 | ✅ render list + scissor + culling | ✅ damage tracking | ❌ | — |
| 同步输出 | 支持 | **DEC 2026**（BSU/ESU） | — | — |
| 屏幕模式 | alternate / main / **split-footer** 三模式；`writeToScrollback()` | 主屏（明确拒绝 alt mode） | 全屏 | — |
| 线程模型 | **UI 线程 + Worker 业务线程**（默认 RPC 直连，免 HTTP） | — | — | — |
| 工具展开 | **InlineTool 恒 1 行** / **BlockTool 有框 + 折叠 + 点击展开**（generic 3 行 / shell 10 行） | `Ctrl+O` | 长行 >1000 字符折叠，**点击整行展开** | — |
| 鼠标 | `mouse: true` 默认捕获，`mouse:false` 恢复原生 | 主 REPL **不接管鼠标**（仅 vendored 多选组件用 1000/1006） | — | — |

### 3.2 关键外部结论（逐条标注来源）

**A. Ink 的 resize 残影是上游缺陷，且有明确 issue**

- **vadimdemedes/ink #907**：「Terminal resize causes rendering artifacts when line wrapping changes row count」——根因 `output.split("\n").length` 不计视觉折行；上游建议的 workaround 是 resize 时全屏 clear（`\x1b[2J\x1b[H`）。**注意**：这是 ED2，会污染 scrollback，khy-os 不能照抄（见 §4.1 R1-1，改用 ED0）。
- **Ink 的标准模式逐字全文重写**：官方文档确认 Standard 模式 "erases all previous output and rewrites the entire screen on each update"；`incrementalRendering: true` 才是行级 diff（"Standard: Erases 30 lines, writes 30 lines / Incremental: Moves cursor, writes 2 lines"）。**khy-os 未启用 incrementalRendering。**

**B. 「活动区无界」会触发每帧全文重印**

- **GitLab duo #2747**：`lastOutputHeight >= rows` 时 Ink 走 full-static-output 分支，**每帧重印全部历史**（实测 redraw span 2000+ 行 → 打补丁后 ≤24 行）。同时该报告发现 **Ink 6.8.0 已内置 BSU/ESU**，而应用层再加一层 Proxy 包裹会造成 **双包裹**（`bsu+bsu+esu` → 内层 `esu` 提前关闭同步）→ 撕裂。结论：**同步输出只包一层**。

**C. Claude Code 的渲染器重写（8 个月）与五项技术**

社区复盘与官方信息汇总为五项：① Cell 级精确更新 ② 双缓冲 ③ 损伤追踪 ④ 宽字符/CJK 显式处理 ⑤ 避免意外滚动（**先写空格再退格**，避免最后一行最后一列写入触发自动换行）。外加 **DEC 2026 同步更新协议**。关键判断：**「这是 Ink 的架构限制，无法用简单补丁修复。只有两条路：要么接受这个限制，要么重写渲染系统。」**

**D. 屏幕模式的选择：主屏 + 差分渲染优于 alt screen（针对编码代理）**

- **Amp** 转向 alt mode；**Gemini** 上线 alt-mode TUI 后因用户反对**一周内回滚**；**Codex** 留在主屏；**opencode** 提供三种模式。
- 业界批评 alt mode 的核心理由：**破坏文本选择、原生滚动、搜索**（"find fails unless the text is currently on-screen"）。
- **结论**：khy-os 应**留在主屏**（符合既有「内联渲染纪律」），用差分渲染消灭闪烁，而非切 alt screen。

**E. 工具显示的「两条防闪烁规则」（四项目共同遵守）**

| 规则 | 内容 | 各项目实践 |
|------|------|-----------|
| **Rule 1：恒定高度** | 工具从出现到完成，行数**恒定或单调增长，绝不 0→N 跳变** | CC 1→1 行；Codex 1→1~5；opencode InlineTool 1→1；Pi/OMP 1→1+预览 |
| **Rule 2：不自动折叠** | 完成时**绝不**自动收起，展开/收起永远由用户控制 | 四项目全部为手动（CC `Ctrl+O`、Codex `Ctrl+T`、opencode 点击、Pi 全局开关） |

**F. 点击展开的实现要点（opencode + dsh-TUI）**

- opencode：`BlockTool` 有框 + 输出折叠到 `maxLines`（generic 3 / shell 10），`…` 截断标记，**点击切换展开**；`/details` 命令与 `tui.json` 的 `dynamic_details_max_lines: 15` / `dynamic_details_show_arrows: true` 可配。
- dsh-TUI：`fold-long-lines.ts` 在**布局前**裁切超 1000 字符的行，行尾内联提示 `… 已折叠 N 字符（点击或 ctrl+o 展开）`；**流式中的行也支持点击**；`signatureParts` 纳入 `expanded` 防陈旧行高（§2.3）。
- **注意**（dsh-TUI 的坑）：`foldClickable` 曾漏掉 `streaming` 分支导致点击行为不一致，后续补了 streaming 分支的 `onClick`。**实现时必须覆盖流式态**。

**G. 鼠标策略的正确形态**

- **opencode**：`mouse: true` 默认捕获，`mouse: false` 恢复原生选择与滚动（文档明示）。
- **yazi**：`mouse_events = ["click","scroll","drag"]` **按事件粒度勾选**。
- **k9s**：`enableMouse` 默认 **false**。
- **090 的不采纳清单**：「内联模式默认启用鼠标滚轮捕获」被明确反对；**shift + 任何鼠标操作永远原生**。
- **结论**：需要的是**事件粒度**配置 + **shift 原生保证**，而不是"全开/全关"二选一。

**H. command-code 与 dsh-TUI 的共性交互**

- command-code：`/` 命令菜单、`!` bash 模式、`@` 文件提及补全；`cmd` 为入口命令。
- dsh-TUI：底部状态栏默认显示**模型 / 推理强度 / 上下文占用条**；`DEFAULT_STATUS_BAR.contextBar` 默认 `false → true`；抽出 `MINIMAL_STATUS_BAR` 把装饰开关钉死为 `false` 而不继承共享默认值（**防止极简模式被共享默认值波及**——这条对 khy-os 的 215 门控治理直接可借鉴）。

---

## 4. 目标架构

### 4.1 三区模型（唯一布局路径）

```
┌──────────────────────────────────────────────────────────────┐
│  A 区  SCROLLBACK（不可变，一次写入永不重绘）                  │
│       已提交历史：用户消息 / 助手消息 / 工具结果 / 完成的任务   │
│       ink <Static>；宽度 = contentWidth；软换行交给终端        │
│       行高计费 = visualRows(text, contentWidth)  ← 单一真源    │
├──────────────────────────────────────────────────────────────┤
│  B 区  LIVE（唯一可变区，高度硬上限 = rows - chrome - 1）      │
│       流式正文 / 进行中工具 / 审批 / Toast / 完成卡片          │
│       折叠与展开在此区发生；展开态进「行高签名」               │
├──────────────────────────────────────────────────────────────┤
│  C 区  CHROME（固定，不参与滚动）                              │
│       ┌────────────────────────────────────────────┐          │
│       │ ❯ 输入内容…                                 │ 3~N 行   │
│       └────────────────────────────────────────────┘          │
│       Khy · <cwd 简写> · <模型> · <上下文 %>        1 行        │
└──────────────────────────────────────────────────────────────┘
窄终端 / 宽终端唯一区别：C 区或 B 区右侧是否再切出一栏看板
```

**三条不可协商的原则**：

1. **A 区只写不读**：进入 `scrollback` 的内容永不重绘（对齐既有 `scrollbackPreserve` 纪律，也对齐 opencode 的 `writeToScrollback()` 语义）。
2. **宽度与高度的真源各只有一处**：`contentWidth()` / `contentHeight()`（新 `effectiveDims.js`），**禁止组件自行读 `process.stdout`**。
3. **一个尺寸 = 一次重绘**：resize 是唯一的全量重绘触发点，且必须是**原子一次写入**。

### 4.2 关键决策：取消右栏 rail 作为默认路径

| | rail 带外绘制（现状，默认） | 三区模型（新方案，默认） |
|---|---|---|
| 跨坐标系 | ✅ 有（ink 内容坐标系 + 屏幕绝对坐标系） | ❌ 无 |
| resize 正确性 | 需 union-clear 才正确（易错） | 天然正确（同一坐标系） |
| 行数账本 | 不计入 live 区（优点） | 计入（但有唯一账本） |
| 宽度分歧 | `contentCols()` 与组件各自读取 | props 下发，无分歧 |
| 复杂度 | `railLayout` 482 行 + `sidebarRail` 运行时 | 合并进 `SidebarPanel` |
| 残影来源 | **根因 B** | 消除 |

**裁决**：rail 的**唯一优势**是"看板可从屏幕第 2 行开始、不消耗 live 区行数"。但在三区模型中，**看板是 B 区的一部分**，其行数由 `contentHeight()` 统一分配 —— 这个限制已不存在。因此：

- **默认**：`KHY_SIDEBAR_RAIL=0`（改为 opt-in，**默认关**）；
- **保留**：作为超宽终端（`cols ≥ 160`）的逃生舱，但 `buildRailClear` 必须改为**先擦 `union(old, new)` 几何**（见 §4.3 R1-1）；
- **删除**：`KHY_SIDEBAR_ZOOM_TOL` / `KHY_SIDEBAR_FULLSCREEN_TOL` / `KHY_SIDEBAR_STACK_MAX_RATIO` / `KHY_SIDEBAR_HYSTERESIS`（rail 退役后无消费者；迟滞逻辑改为 §4.3 R1-2 的带宽模型）。

### 4.3 Req ①：缩放稳定且无残痕 —— 六条硬规则

#### R1-1 单次 resize = 一次原子 ED0 重绘

```
resize / 尺寸变化
  → 120ms 防抖（沿用 App.js resizeNonce + CcApp 既有 120ms）
  → ① sticky 化 cols 与 rows（effectiveDims，单一缓存）
  → ② 纯函数计算 newLayout（无 IO、无 process 读取）
  → ③ 若 rail 曾激活：追加 buildRailClear(unionGeom(old, new))
  → ④ 全量重绘 = '\x1b[1;1H' + '\x1b[J'        ← ED0，唯一允许形式
  → ⑤ DECSC('\x1b7') 包裹，末尾 DECRC('\x1b8')
  → ⑥ 若 rail 仍激活：buildRailPaint(newGeom)
```

**为什么必须是 ED0 而非 ED2**：ED2（`ESC[2J`）把当前视口推进 scrollback、永久污染用户历史。事故案例：ink #935/#990（`clearTerminal` 抹 scrollback）、claude-code #2479（三处清 scrollback 引发用户强烈反弹）、ms/terminal #8736（Windows Terminal 的 `ESC[3J` 无开关）。`ESC[3J`（清 scrollback）**绝对禁止**。

> 好消息：`scrollbackPreserve.js` 已经在 stdout 边界做了 ED2→ED0 改写与 3J 剥离（四层栈 + win32 Proxy）。**新方案只是把这条"兜底拦截"升格为"唯一发射路径"**，让 ED0 成为设计意图而非补丁。

#### R1-2 取消窄化的阶跃：带宽 + 量化

```js
// effectiveDims.js —— 宽度窄化（替代 railActive + hysteresis + sticky 三件套）
const BREAK_IN  = 120;   // 进入带宽需 ≥120
const BREAK_OUT = 108;   // 退出带宽需 ≤108（12 列死区）
// 带宽内宽度量化到 4 的倍数 → 带内 1~3 列抖动不改变窄化值
```

两条改进：

1. **死区用"进入/退出双阈值"而非"迟滞布尔"**：现有 `railActiveHysteresis` 只在判定翻转时有作用；双阈值 + 量化后，`119→118` 期间 `contentWidth` **完全不变** → 不触发任何 reflow。
2. **窄化值量化到 4 的倍数**：终端拖拽 resize 产生的连续宽度变化中，约 75% 的取值不会改变 `contentWidth`。

#### R1-3 行高也 sticky，且 fallback 唯一

新增 `stickyRows()`，与 `stickyCols()` 同住 `effectiveDims.js`，共享同一套 `stickyDim` 纯规则与同一个 `KHY_TERM_STICKY_DIMS` 门控。

**改造点**（全部改为走 `contentHeight()` / `stickyRows()`）：

| 位置 | 现状 | 改为 |
|------|------|------|
| `PromptFrame.js:373` | `process.stdout.rows ... : 24` | `contentHeight().rows` |
| `railLayout.js:250` | `sidebarLayout.fallbackRows(env)` | 同一 fallback |
| `liveHeightClamp` | 调用方传入 | `contentHeight()` |
| `ccLayout.messageAreaCap` | 调用方传入 | `contentHeight()` |

`effectiveCols.js` 保留为 `effectiveDims.js` 的**别名导出**（零破坏迁移）。

#### R1-4 帧高硬约束 + chrome 账本单一真源

新增 `chromeBudget.js` 纯叶子，**取代**现在分散在 `ccLayout.messageAreaCap()`、`liveRegionBudget.js`、`railBottomChrome()` 的**三套**算术：

```js
// chromeBudget.js（纯函数，无 IO）
function chromeRows({ inputRows, statusRows, toastRows, messageBarRows, agentTreeRows }) {
  return ALWAYS(inputRows, statusRows) + optional(...);
}
function liveBudget(rows, shares) {
  return clamp(rows - chromeRows(shares) - 1, LIVE_MIN /*3*/, rows);
}
```

- **单一 chrome 定义**：任何组件需要知道"我还剩多少行"时，**只调这一个函数**，不再各自估。
- **`-1` 是硬纪律**：帧高 ≤ `rows - 1`，绝不写满最后一行（conpty 的 pending-wrap 陷阱，ink #971），也避免触发 Ink 的 fullscreen 分支（duo #2747）。
- **测试**：`chromeBudget.test.js` 断言"所有调用点算出的 chrome 一致"。

#### R1-5 消灭"未计费的行"：折行与计费同一函数

新增 `wrapCell.js`（纯叶子）：

```js
// 与渲染共用同一个折行器 —— 构造性保证，而非"逐分支同源"的约定
function wrapCell(text, width) -> string[]   // grapheme-aware, CJK 双宽, 禁则
function visualRows(text, width) -> number   // = wrapCell(text,width).length
```

**规则**：任何渲染行数的组件，**必须**用 `visualRows()` 计费，**必须**用 `wrapCell()` 渲染。`ToolLines.estimateLiteralRows` 的分支估算改为调用 `visualRows()`。这条把 079 §12.5 的"逐分支同源"从**约定**升级为**构造性保证**。

#### R1-6 软换行统一 + 视觉行计费

- 全宽散文块（助手正文、工具输出）**不插 `\n`**，交终端 DECAWM 软折 —— 对齐 opencode，**复制不带硬换行符**（这是 079 §11 已识别的"关键差距"）。
- **但行高计费必须按视觉行**：`visualRows(text, width) = ceil` 而非 `text.split('\n').length`。**这正是 Ink #907 的修法**（上游建议的 `getActualRows()` 与 `visualRows()` 同构）。
- 门控 `KHY_SOFT_WRAP` **默认改为 on**（080 §14 Phase 1 建的骨架已存在，只是默认 off）。

### 4.4 Req ②：输入框上下边框正常显示 —— 重设计

#### 新结构（固定 3 行起，宽度单一真源）

```
┌──────────────────────────────────────────────┐  ← 行 1：上边框
│ ❯ 输入内容…                                   │  ← 行 2..N-1：输入（多行时扩展）
└──────────────────────────────────────────────┘  ← 行 N：下边框
```

#### 六条修正

| # | 修正 | 具体做法 |
|---|------|----------|
| 1 | **宽度只从 props 来** | `PromptFrame({ width })`，App 调一次 `contentWidth()` 下发全树；组件内**删除** `effectiveCols()` 调用 |
| 2 | **两条边框同一个函数产出** | `const topRow = fitBorder(width, {left:'┌',right:'┐'})` / `bottomRow = fitBorder(width, {left:'└',right:'┘'})`；实现用 **display-width pad**，不用 `'─'.repeat()` |
| 3 | **渲染前断言** | dev 模式：`assert(visWidth(topRow) === width && visWidth(bottomRow) === width)`；prod 静默 pad。**机器可验证的"边框正常"** |
| 4 | **MIC 移出边框** | 按钮移到输入行内（`❯ [MIC] …`）或状态行右侧；**彻底删除** `cols-1-5` 与 `Math.max(1,...)` 组合 |
| 5 | **busy 不改边框色** | 只改左侧 gutter 字符（`─` → `╌`）；颜色保持可见。避免 `dim + undefined color` 在部分终端等于不可见 |
| 6 | **高度用 sticky rows** | `maxRows = clamp(floor(rows/3), 3, 10)`，`rows` 来自 `contentHeight()`；不再 `rows - 10` |

#### 边框字符（默认圆角，`KHY_TABLE_BORDERS=minimal` 时退化为无框）

```
╭──────────────────────────────╮   ← 顶边框（accent 色）
│ ❯ 输入内容…                   │
╰──────────────────────────────╯   ← 底边框（accent 色，与顶边框同函数）
```

**关于复制**：079 §11.4 已论证 `─` 独占一行时用户可轻松删除；本方案保留该取舍，并把 ghost border（079 §14 Phase 2，`KHY_GHOST_BORDER`）从"默认 off 的实验"**提升为可选优化**（`tui.json.copy.ghostBorder: true`），不设为默认（避免 CUP 绘制在部分终端引入新残影）。

### 4.5 Req ③：点击展开摘要 —— 统一可折叠模型

#### 鼠标策略重新裁决（修掉 §1.3 的自相矛盾）

```js
// mouseButtons.js —— 三档，替代现有布尔
KHY_MOUSE = off | click | full      // 默认 click
```
- `off`：完全不接管（= 现状文档声称的行为）
- `click`：只开 `?1000h ?1006h`（按下/松开，**不报位移**）→ 保住拖选；滚轮事件一律 `fireNative()` → 保住原生滚动
- `full`：额外开 `?1003h` 悬停高亮（事件洪流，明确 opt-in）

**修正实现**：`autoDetectTerminal()` 的兜底 `return true` 改为 `return false`（**未知终端不接管**）；探测结果写入既有的 `terminalCapabilities.js` 单例（已有），不再各处自行判定。

**shift 永远原生**：文档与 UI 公示「**Shift+点击 = 终端原生选择**」（xterm 标准行为：tracking 下 shift 透传）。对齐 090 不采纳清单与 yazi/k9s 实践。

#### 可折叠元素统一模型

```js
// foldModel.js（纯叶子）—— 所有可折叠元素的单一描述
{
  id, kind: 'tool'|'longline'|'thinking'|'task'|'message',
  collapsedRows, expandedRows,      // 行高（由 wrapCell 计算）
  expanded: boolean,                 // 用户态
  toggle(action)                     // 与键盘动作同源
}
```

| 元素 | 收起态（恒 1 行） | 展开态 | 等价键盘 |
|------|------------------|--------|----------|
| 工具卡片（shell） | `→ Shell: npm test` | 参数 + 输出（≤12 行预览帽 + 截断标记） | `Ctrl+O` |
| 工具卡片（generic） | `→ Read: src/a.js` | 输出（≤3 行，opt-in `showGenericToolOutput`） | `Ctrl+O` |
| 长行（>1000 字符） | `… 已折叠 N 字符（点击展开）` | 全文 | `Ctrl+O` |
| 思考块 | `▸ 思考 (N 行)` | 全文 | `Ctrl+T` |
| 任务项 | `→ 修复 Bug A` | 详情 + 耗时 | `Enter` |
| 已完成任务组 | `✓ 12 已完成` | 展开列表 | `Enter` |

#### 四条硬约束（外部实证）

1. **折叠在进入布局前完成**（`foldLongLines()` 纯叶子，dsh-TUI 同款）：保留 markdown/diff 行边界、代理对不劈半、短文本走零分配快路径（身份返回）。
2. **展开态必须进"行高签名"**：`lineHeightSignature(item) = hash(kind, wrapCell(text, width).length, item.expanded)`。**状态变 → 签名变 → 布局重算**。这是 Req ① 与 Req ③ 的耦合点，必须同批落地（§2.3）。
3. **流式态也支持点击**（dsh-TUI 的 `foldClickable` 曾漏掉 `streaming` 分支的坑）。
4. **Rule 1 恒定高度 + Rule 2 不自动折叠**（外部调研 E 节，四项目共识）：工具**绝不** 0→N 跳变；完成时**绝不**自动收起。

### 4.6 Req ④：视觉简洁直观

#### 门控收敛：215 → ≤ 40

| 类别 | 处置 | 示例 |
|------|------|------|
| **平台差异（保留）** | 保留为 env | `KHY_TERM_FALLBACK_COLS/ROWS`、`KHY_TERM_STICKY_DIMS` |
| **能力开关（保留）** | 保留为 env | `KHY_SOFT_WRAP`、`KHY_GHOST_BORDER`、`KHY_MOUSE` |
| **用户偏好（迁移）** | 迁到 `~/.khyquant/tui.json` | 主题、看板宽度档位、鼠标档位、折叠默认态 |
| **历史兼容层（删除）** | 直接删 | `KHY_SIDEBAR_STACK_MAX_RATIO`（零消费者）、rail 退役后的 4 个容差 |
| **重复门控（合并）** | 合并为单开关 | `KHY_FULL_TUI` 与 `KHY_CC_TUI` 的关系必须写清 |

**借鉴 dsh-TUI 的 `MINIMAL_STATUS_BAR` 手法**：极简模式的开关**钉死为 `false`，不继承共享默认值** —— 防止"极简模式被共享默认值波及"导致模式失效。

**CI 检查**：新增 `scripts/ci/check-tui-gates.js` 断言 `cli/tui/` 内唯一 `KHY_*` token ≤ 40，并接入 `check-gov-rules.js`。让"简洁"成为**机器可验证的约束**而非口号。

#### 布局与组件收敛

| 项 | 现状 | 新方案 |
|---|------|--------|
| 布局路径 | Legacy 单栏 + ThreeColumn 三栏 | **一条**自适应路径（宽窄自动切右栏） |
| 看板实现 | rail 带外 + in-tree SidebarPanel | **一套** `SidebarPanel` |
| 状态栏 | FooterBar（2 行）+ Statusbar（1 行） | **一行** + 按需展开 |
| Topbar | `● ● ● KhyOS Desktop` 交通灯 | 删除；标题并入状态行 `Khy · <cwd> · <模型>` |
| 用户消息 | 086 说"无背景"，079 说"奶油色背景" | 以**无背景**为准；奶油色降为 opt-in 主题 |

#### 语义色 token（替代硬编码）

```
accent / muted / success / warn / danger / border / focus   // 7 个语义 token
```
- 接 `NO_COLOR > CLICOLOR_FORCE > CLICOLOR > tty` 检测链（095 §3.9 P2-7）。
- 16 色降级档（btop 的 truecolor→256→tty 三档思路）。
- `ccTheme.js` 已是雏形，扩展为语义层；079 §6.1 的字面量表改为"token → 默认值"映射。

### 4.7 Req ⑤：任务看板清晰易用

#### 参数收敛：10+ 调参 + 3 容差 → **3 项**

```jsonc
// ~/.khyquant/tui.json
{
  "sidebar": {
    "width": "auto",        // "narrow" | "wide" | "auto"（唯一宽度入口）
    "tab": "tasks",         // 默认落在任务页
    "minCols": 120          // 唯一阈值，死区由 R1-2 的带宽模型内置
  }
}
```

**删除**：`WIDTH_RATIO` / `WIDTH_MIN` / `WIDTH_MAX` / `WIDTH` / `MIN_ROWS` / `MAX_RATIO` / `MIN_CHROME` / `STACK_MAX_RATIO` / `RAIL_BOTTOM_CHROME` / `RAIL_TOP_OFFSET` + 3 个容差。

#### 消除宽度公式分歧（§1.2 实测的 30 vs 24）

**删除 `ccLayout.sidebarWidth()`**，全仓只留 `sidebarLayout.sidebarWidth()` 一处。新增回归测试：

```js
// 断言两个模块不可能再分歧（因为只有一个）
assert(require('ccLayout').sidebarWidth === undefined);
```

#### 看板结构：4 tab → 2 段

```
┌─ 任务 ────────────────┬─ 上下文 ──────────────┐
│ → 修复缩放残影   2m   │ 模型  opus-4-5        │
│ → 重写 PromptFrame 1m │ 上下文 ███████░░ 72%  │
│ ○ 收敛门控            │ 权限  auto-edit       │
│ ✓ 12 已完成 (点击展开) │ 桥接  ● 已连接        │
└───────────────────────┴───────────────────────┘
```

- **删除** `终端` / `文件` 两个常驻 tab → 下沉为 `/terminal`、`/files` **覆盖层**（需要时才占屏）。理由：这两个是"偶发查阅"，常驻占用看板 2/4 空间但使用率极低。
- **固定顶锚 + 独立滚动**（取消底部锚定 + `topOffset` 悬浮）。理由：取消 rail 后"看板必须贴 bottom"的结构性限制消失；"侧栏"心智模型应固定。
- **完成项默认折叠为计数**：`✓ 12 已完成 (点击展开)` —— 看板只显示"现在要看的"。这也直接服务 Req ③（点击展开）。
- **失败项显示一行原因**（复用既有 `toolErrorFold`）。
- **`in_progress` 显示耗时**（复用既有 `formatDuration`）。

---

## 5. 分阶段实施路线

> 原则：**P0 全部是正确性修复**（不引入新特性面），且**每一条都有机器可验证的验收**。P0-1..P0-6 之间存在依赖，建议按序。

### Phase P0 —— 渲染正确性（最高优先）

| # | 任务 | 涉及文件 | 验收（机器可验证） |
|---|------|----------|-------------------|
| **P0-1** | `effectiveDims.js`：合并 `stickyCols` + 新增 `stickyRows`；唯一 fallback；`effectiveCols.js` 保留为别名 | `tui/effectiveDims.js`（新）、`tui/effectiveCols.js`（改别名） | 单测：conpty 抖动序列 `(120,undefined,120,0,119)` 下行高/列宽取值稳定；所有原读取点改为走新模块（静态扫描断言） |
| **P0-2** | resize 原子 ED0 重绘；rail 激活时 union-clear | `ink-components/App.js`、`CcApp.js`、`tui/railLayout.js`（+`unionGeom`） | 无头测试：resize 序列 `(120→80→200→119→120)` 后的屏幕快照，与**直接以该尺寸冷渲染**逐 cell 相同（残影 = 快照不等） |
| **P0-3** | `PromptFrame` 重写：宽度从 props；`fitBorder()` 双边框同函数；MIC 移出行；dev 断言 | `ink-components/PromptFrame.js` | 断言 `visWidth(top) === visWidth(bottom) === width`，覆盖 `cols ∈ {40,79,80,119,120,121,200} × 输入长度 {0,1,79,80,1000} × {纯 ASCII, CJK, emoji, 混合}`（28×4×4 组） |
| **P0-4** | `wrapCell.js`：折行 + `visualRows()` 单一真源；`ToolLines.estimateLiteralRows` 改为调用它；软换行默认开启 | `tui/wrapCell.js`（新）、`ink-components/ToolLines.js`、`StreamingBlock.js` | 单测：`visualRows(text, w) === wrapCell(text, w).length`（属性测试）；随机 1000 组文本宽组合；CJK/emoji 双宽正确 |
| **P0-5** | `chromeBudget.js`：chrome 账本单一真源；帧高 ≤ `rows-1` | `tui/chromeBudget.js`（新）、`utils/ccLayout.js`、`liveRegionBudget.js`、`railLayout.js` | 单测：所有调用点的 chrome 算出一致；属性测试断言任意 shares 组合下 `frameHeight ≤ rows-1` |
| **P0-6** | 鼠标三档 `KHY_MOUSE`；修 `autoDetectTerminal` 兜底；探测结果入 `terminalCapabilities` | `tui/mouseButtons.js`、`runtime/terminalCapabilities.js` | 单测：`KHY_MOUSE` 三档的字节序列；未知终端下默认**不接管**（回归断言）；滚轮事件必走 `fireNative()` |

### Phase P1 —— 交互（依赖 P0）

| # | 任务 | 依赖 | 验收 |
|---|------|------|------|
| **P1-1** | `foldLongLines.js` + `foldModel.js`；工具卡/长行/思考块/任务项可点击展开 | P0-4 | 合成 SGR 序列 → 命中 → 展开态变化；流式态**同样可点**（dsh-TUI 的坑回归断言） |
| **P1-2** | **行高签名纳入 expanded** | P1-1 | 回归断言：展开 → 签名变化 → 布局重算；展开后 resize 无残影 |
| **P1-3** | Rule 1 恒定工具高度 + Rule 2 取消自动折叠 | P1-1 | 断言工具行数从出现到完成**恒 1 或单调增**；完成时不自动收起 |
| **P1-4** | 滚动三态（尾随 / 上滚暂停 / 显式跳底）+ 暂停横幅 + 新消息计数 | — | 上滚即暂停；`G`/`End` 恢复；横幅计数正确（095 §3.4 已有基础） |
| **P1-5** | 鼠标事件粒度配置 + shift 原生公示（帮助菜单 + 文档） | P0-6 | `shift+点击` 在 tracking 下仍走原生选择；帮助菜单可见该提示 |

### Phase P2 —— 收敛（依赖 P0/P1）

| # | 任务 | 验收 |
|---|------|------|
| **P2-1** | 单一布局路径：删除 Legacy / ThreeColumn 分支 | 布局路径只剩 1 条；旧门控零消费者 |
| **P2-2** | 门控收敛至 ≤40 + `~/.khyquant/tui.json` 配置文件 | `check-tui-gates.js` 通过；接入 `check-gov-rules.js` |
| **P2-3** | 看板 4 tab → 2 段；删除 `ccLayout.sidebarWidth`；参数收敛至 3 项 | 断言 `ccLayout.sidebarWidth === undefined`；看板渲染快照 |
| **P2-4** | 语义色 token + `NO_COLOR` 链 + 16 色降级 | `NO_COLOR=1` 下零彩色输出；语义 token 表 |
| **P2-5** | 删交通灯、消解 086/079 用户消息矛盾、rail 默认关 | 文档一致性检查；`KHY_SIDEBAR_RAIL` 默认 `0` |

### Phase P3 —— 长线（登记待排期）

| 项 | 说明 |
|---|------|
| **可选 cell-diff 渲染器** | 若 P0-P2 后仍有残余闪烁，评估在 Ink 之上自研 cell buffer 渲染层（对齐 Claude Code 五项技术 + opencode 双缓冲）。**这是大工程，不在本次范围**（CC 团队花了 8 个月） |
| **UI 线程 / 业务线程分离** | 对齐 opencode：UI 渲染与业务逻辑分线程，避免长任务阻塞渲染（治"加载缓慢"的上游） |
| **rail 彻底退役** | P2 后若无人使用 `KHY_SIDEBAR_RAIL`，删除 `railLayout.js` / `runtime/sidebarRail.js` |
| **App.js 拆分** | 5751 行单组件按三区拆为 `ScrollbackRegion` / `LiveRegion` / `ChromeRegion` |

---

## 6. 验收总表（可机器验证）

| Req | 验收项 | 方法 |
|-----|--------|------|
| ① 缩放稳定无残痕 | resize 序列后屏幕快照 == 冷渲染快照（逐 cell） | 无头渲染测试（`run-ink-tui-tests.js` harness） |
| ① | `frameHeight ≤ rows - 1` 恒成立 | 属性测试（随机 shares 组合） |
| ① | 全仓零 `ESC[2J` / `ESC[3J` 发射 | 静态扫描（095 P0-1 已建基线，改为 CI 门） |
| ② 边框正常 | `visWidth(top) === visWidth(bottom) === contentWidth` | 28×4×4 组合断言 |
| ② | MIC 存在时总宽不变 | 断言含/不含 MIC 的上边框等宽 |
| ③ 点击展开 | 命中测试 → 展开态变化；流式态可点 | 合成 SGR 序列测试 |
| ③ | **行高签名随 expanded 变化** | 回归断言（防残影的核心） |
| ③ | 工具高度恒 1 或单调增；不自动折叠 | 状态机轨迹断言 |
| ④ 视觉简洁 | `cli/tui/` 唯一 `KHY_*` ≤ 40 | `check-tui-gates.js` |
| ④ | 布局路径只剩 1 条 | 静态断言 |
| ④ | `NO_COLOR=1` 零彩色 | 渲染快照断言 |
| ⑤ 看板 | `ccLayout.sidebarWidth === undefined` | 模块导出断言 |
| ⑤ | 看板参数仅 3 项 | `tui.json` schema 校验 |

**回归基线**：本次改造不得使既有 TUI 测试下降。当前基线（2026-09-14 专项）为 425 用例 / 307 通过（72%），其中 `inkRenderSmoke.test.js` + `ccFormat` / `toolResultTransparency` / `diffLineNumbers` 四个文件的失败属**测试代码自身笔误**（断言写错、变量名 `off` 未加引号），**应与本次改造一并修复**，否则无法验证新架构。

---

## 7. 不采纳清单（附理由）

| 不采纳 | 理由 |
|--------|------|
| 切换到 alternate screen（alt mode） | 破坏文本选择 / 原生滚动 / 搜索（Gemini 上线后一周回滚；Amp 的 alt mode 被批评"find 找不到屏外文本"）。khy-os 留在主屏 + 差分渲染 |
| resize 时用 `ESC[2J` 全屏清（Ink #907 的 workaround） | 污染 scrollback（ink #935/#990、claude-code #2479）。改用 ED0 `ESC[1;1H + ESC[J` |
| 自行再加一层 BSU/ESU 包裹 | Ink 6.8.0 已内置同步输出；**双包裹会让内层 ESU 提前关闭同步**（duo #2747 实测）→ 撕裂 |
| 保留 rail 作为默认 | 跨坐标系是残影根因 B；三区模型下其唯一优势（不占 live 行数）已不存在 |
| 先做「点击展开」再做「行高签名」 | 展开会引起行高陈旧 → **直接复现缩放残影**（dsh-TUI 实证）。必须同批 |
| 工具完成时自动折叠 | 四项目（CC/Codex/opencode/Pi）**全部**为手动控制（外部调研 Rule 2） |
| 鼠标默认全开 | 吞掉原生滚轮与拖选（090 不采纳清单）；改三档默认 `click` |
| 鼠标默认全关 | 与用户本次"点击展开"需求冲突；改三档默认 `click` + shift 原生 |
| 继续新增 `KHY_*` 门控 | 215 已是回归灾难；新偏好一律进 `tui.json` |
| 保留两套看板宽度公式 | 实测分歧（120 列时 30 vs 24）是确定性残影来源 |

---

## 8. 交叉引用

| 文档 | 关系 |
|------|------|
| [DESIGN-ARCH-102] Khy TUI 统一规则手册 | **收口**：本文的规则部分已并入 102 §3/§4；**查阅规则以 102 为准** |
| [DESIGN-ARCH-101] TUI 交互与展示规则细则 | **下位**：（该文亦已并入 102 §6）本文交付**渲染模型**，101 交付**行为语义**。本文 §4.3 R1-5（折行器）、§4.5（鼠标三档 + 行高签名）、§4.7（看板迟滞）是 101 §1–§6 全部规则的**实现前提**；101 §8 同时裁定本文登记的部分实现冲突（spinner 帧间隔三源、空看板占位） |
| [DESIGN-ARCH-079] TUI 界面设计规范 | 布局/尺寸/组件真源。本文改其**取数方式**（§4.4/§4.7），并以 §4.6 消解其 §12.4.1 与 086 的矛盾 |
| [DESIGN-ARCH-086] CC TUI 复刻总计划 | 任务跟踪真源。本文 P0–P2 应并入其视图 |
| [DESIGN-ARCH-089] TUI 设计模式调研报告 | 上游（模式层）。本文 §3 在其基础上补充**渲染器内部机制**层证据 |
| [DESIGN-ARCH-090] TUI 用户评价调研与痛点分析 | 上游（痛点层）。本文 §7 沿用其不采纳清单（鼠标/alt screen/copy-on-select） |
| [DESIGN-ARCH-095] TUI 交互完善调研与实施路线 | 上游（协议纪律层）。本文把其 P0-1（ED0）、P0-3（resize）、P0-2（帧高）从**补丁**升格为**唯一路径**，并新增 §4.3 的 R1-2/R1-3/R1-5 |
| [IMPL-RPT-045] TUI 按钮点击调研 | 鼠标层现状。本文 §4.5 修正其"默认全关"与实现的矛盾 |
| AGENTS.md 工程规则 | 红线：零硬编码、状态消息合规、禁滚动区（DECSTBM）、零不安全发射 |

---

## 9. 外部证据索引

| 来源 | 引用于 |
|------|--------|
| vadimdemedes/ink **#907**（resize 折行行数错配） | §2.1 根因 A、§4.3 R1-6 |
| vadimdemedes/ink **#971**（conpty 右下角单元格滚动） | §4.3 R1-4 |
| vadimdemedes/ink **#935 / #990**（clearTerminal 抹 scrollback） | §4.3 R1-1、§7 |
| Ink 官方文档（Standard vs Incremental Rendering） | §2.1、§4.3 R1-1 注 |
| GitLab duo **#2747**（活动区无界 → 每帧全文重印；BSU/ESU 双包裹致撕裂） | §2.1 根因 D、§4.3 R1-4、§7 |
| anthropics/claude-code **#2479**（清 scrollback 引发用户反弹） | §4.3 R1-1 |
| anthropics/claude-code **#37076 / #29937 / #769**（Ink 全量重绘致闪烁） | §3.2 C |
| anthropics/claude-code **#3108**（click-to-expand 工具输出的社区实现） | §4.5 |
| Peter Steinberger《The Signature Flicker》（alt mode 权衡、CC 重写渲染器） | §3.2 D、§7 |
| quidproquo.cc《Two Rules for Flicker-Free Tool Result Display》 | §3.2 E、§4.5 |
| opencode 官方 TUI 文档（`tui.json`、`mouse`、`/details`） | §3.1、§4.5 |
| opencodebook.xyz 12.2 / DeepWiki（SolidJS + @opentui/core、Cell diff、Worker 线程） | §3.1、§3.2 C |
| ccch1mneyyy/**dsh-TUI** PR #848 / #893（`fold-long-lines.ts`、`signatureParts`、折叠性能） | §2.3、§4.5 |
| CommandCodeAI/**command-code**（`/` `!` `@` 交互形态） | §3.1 H |
| yazi / k9s / btop（鼠标粒度、enableMouse 默认、follow/pause 三态） | §4.5、§4.6 |

---

## 10. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-09-15 | 初版。基于 079/086/089/090/095/045/078 文档 + 实际代码勘察（App.js 5751 行等实测数据），并完成 opencode / Claude Code / dsh-TUI / command-code 四项目渲染实现调研。建立三区模型、六条缩放硬规则、输入框边框重设计、统一可折叠模型、门控收敛与看板收敛方案，给出 P0–P3 路线与可机器验证验收表。发现并记录两处实测数值分歧（看板宽度 30 vs 24、激活阈值可配 vs 硬编码）与一处文档/实现矛盾（鼠标默认开/关） |

---

> **文档状态**：Active — 待评审
> **创建日期**：2026-09-15
> **单一真源**：布局与组件尺寸以 [DESIGN-ARCH-079] 为准；协议纪律以 [DESIGN-ARCH-095] 为准；本文只拥有**取数与重绘模型**（§4.1–§4.3）与 **Req ②③⑤ 的重设计**（§4.4/§4.5/§4.7）。落地时如代码漂移，以代码为准并回改本文。
