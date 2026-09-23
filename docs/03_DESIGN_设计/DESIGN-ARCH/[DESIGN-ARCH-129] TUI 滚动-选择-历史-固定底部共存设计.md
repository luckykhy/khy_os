# [DESIGN-ARCH-129] TUI 滚动 / 文本选择 / 输入历史 / 固定底部 —— 共存机制设计

> **隶属**：本文属 **TUI 设计族**（21 编号 / 22 文件），总纲与 scope 裁决见 `[DESIGN-ARCH-122] TUI 设计族总纲`；
> 规则冲突一律以 `[DESIGN-ARCH-102] Khy TUI 统一规则手册` 为准。
>
> **定位**：把「转录滚动、拖选跨页复制、输入框钉在底部、`↑`/`↓` 历史回溯」这四件
> **互斥诉求**在当前实现里**怎么同时成立**讲清楚，并给出**业内对照**与**取舍代价**。
> 本文是**机制真源**（记录「现在为什么能共存」），不是新提案；不新增门禁规则，
> 因此不携带 `<!-- RULES-REGISTRY -->` 标记行，不改 `RULES-REGISTRY.json`。
>
> **与相邻文档的边界**：
> - `[DESIGN-ARCH-119]` 回答「**怎么修好**拖选复制」——缺陷根因 + 三层方案 + 验收标准；
> - `[DESIGN-ARCH-102]` 回答「**规则是什么**」——键位表、鼠标约定、组件尺寸；
> - **本文回答「四件事为什么互不打架」**——不变量、坐标契约、优先级次序、代价清单。
>
> **依据**：`services/backend/src/cli/tui/AGENTS.md` §0.9.1–§0.9.7、§1.2；
> `arrowRouting.js` / `selection.js` / `Viewport.js` / `mouseButtons.js` / `useTextInput.js` /
> `scrollbackPreserve.js` / `chromeBudget.js` 头部注释；`[DESIGN-ARCH-102]` §6.1/§6.2；
> `[DESIGN-ARCH-119]` §4.2；业内实现见 §8（含 Claude Code 官方全屏渲染文档）。
>
> **代码坐标时点**：2026-09-22，分支 `chore/tui-ux-nightly`。行号为**指路**，不构成契约；
> 判读前以文件头部注释为准（本仓注释密度高于行号稳定性）。

---

## 0. 一分钟结论

四件事能共存，靠的是**三条不变量**加**一张优先级表**，而不是靠某个开关：

| # | 不变量 | 一句话 | 真源 |
|---|--------|--------|------|
| **I1** | **视口偏移是唯一坐标系** | 屏幕行 == `_mainContentLines` 下标（1:1），任何坐标换算都走 `resolveViewportOffset`，不许手写数字判断 | `Viewport.js` |
| **I2** | **填充与渲染走同一把尺子** | 折行宽度、`viewH`（内容行数）、列宽换算三者必须同源；任一处口径不同 → 整屏错位 | `wrapCell.js` / `viewportContentRows` / `charColForDisplay` |
| **I3** | **单写者：只有 ink 注入流能画屏** | TUI 存活期任何绕过注入 stdout 的写入都会留下擦不掉的残行 | `AGENTS.md` §0.9.7 / `consoleMute.js` |

优先级表（键位归属）：**子视图独占 → 忙时队列 → 空闲 → 输入中**，四种 context 由
`arrowRouting.resolveArrowContext()` 一个函数产出，`↑`/`↓`/`←`/`→` 的归属**只在这一处定义**。

> 一句话记忆：**滚动驱动的是「视口偏移」，历史回溯驱动的是「缓冲区文本」，两者读写的
> 是完全不同的 state** —— 它们冲突的不是实现，而是**同一个物理按键**。共存的第一步是让
> 按键有唯一裁决者，第二步是让滚轮**不经过键盘通道**（§3.3）。

---

## 1. 问题定义：这四件事为什么天然打架

先把冲突摆明，否则后面每一条设计都像「随手选的」。

| 诉求 | 想要的行为 | 与谁冲突 | 冲突的物理根源 |
|------|-----------|---------|---------------|
| A. 转录滚动 | 滚轮/`↑` 让内容区上下移动 | C、D | 备屏下终端**把滚轮合成为 `↑`/`↓` 键**（§3.3） |
| B. 拖选跨页复制 | 按住拖、反色、松手即复制；拖到边缘能继续 | A、C | 开鼠标追踪后**终端原生选择被吃掉**，且指针**只能停在窗口内** |
| C. 输入框钉底 | 输入框/页脚**滚动时位置不动** | A、B | 终端只有一张画布：转录一动，若不重排，输入框会跟着走 |
| D. `↑`/`↓` 历史回溯 | 空输入时召回上一条命令 | A | 同一个按键，两种诉求 |
| E. 粘贴/长输入回显 | 输入框内多行、软换行不溢出 | C、A | ink 的擦行账本按**逻辑行**记，终端按**视觉行**显示 |

**关键判断**：A/C/D 的冲突是**按键分配问题**（可解，靠优先级表）；
A/B 的冲突是**通道问题**（可解，靠滚轮不进键盘通道 + 自绘选择）；
B/C 的冲突是**坐标问题**（可解，靠 I1/I2 两条不变量）；
E 是**账本问题**（可解，靠预折行 + 高度硬闸）。

---

## 2. 三层架构总览

```
               ┌────────────────────────────────────────────────┐
   物理输入  →  │ ① 事件层  mouseButtons.parseSgrMouse           │  SGR → 结构化事件
  (stdin)      │           arrowRouting.arrowDirection          │  方向键 → 方向
               └────────────────────┬───────────────────────────┘
                                    ▼
               ┌────────────────────────────────────────────────┐
               │ ② 裁决层  arrowRouting.resolveArrowAction      │  context 栈 → 动作名
               │           mouseButtons.createMouseDispatcher   │  滚轮/拖选 → 语义事件
               └────────────────────┬───────────────────────────┘
                                    ▼
               ┌────────────────────────────────────────────────┐
               │ ③ 状态层  App.js useInput 的 switch            │  动作名 → 副作用
               │           mainViewportScroll / previewView…    │  视口偏移（数字 | null）
               │           useTextInput 的 history/draft        │  缓冲区 + 历史游标
               │           selectRegion                         │  选区 {anchor, head}
               └────────────────────┬───────────────────────────┘
                                    ▼
               ┌────────────────────────────────────────────────┐
               │ ④ 渲染层  Viewport(lines, scroll, selection)   │  切片 + 反色三段 Text
               │           PromptFrame / FooterBar / 布局固定   │  钉底 chrome
               │           chromeBudget.liveBudget(rows, …)     │  帧高 ≤ rows − 1
               └────────────────────────────────────────────────┘
```

四层各自都是**可单测的纯叶子**（`arrowRouting` / `selection` / `scrollActions` / `scrollbackPreserve`
零 IO、零 env、绝不抛）。**env 门控一律在最外层读**（App.js），叶子只吃布尔参数 ——
这是「同一份逻辑能被确定性测试驱动」的前提，也是这四件事能各自独立演进的原因。

---

## 3. 逐项机制

### 3.1 滚动：视口偏移 + 贴底哨兵

**不变量 I1 的落地**：转录被投影成**扁平字符串数组** `_mainContentLines`，
`Viewport` 的 lines 模式按 `height` 直接 `lines.slice(start, end)` 渲染 ——
所以**屏幕第 n 行 == 数组下标 n + 偏移**，不需要任何布局反查（不用 yoga `hitTest`）。

偏移的**两种语义**（`AGENTS.md` §0.9.1）：

| 值 | 含义 |
|----|------|
| `null` / `undefined` / 负数 | **贴底** —— 追随最新内容，新内容进来继续跟 |
| 数字 | 固定行偏移，用户滚到哪停在哪 |

**「滚回最底」必须回写 `null`**，跟随会自动恢复，不需要额外的 sticky 标志位。
真源是 `Viewport.js` 的 `resolveViewportOffset` / `applyStickyViewportAction`（纯叶子、与
`applyViewportScroll` 同处、有单测 `viewportSticky.test.js`）。**任何调用方都不得另抄一份。**

> 为什么必须有哨兵值：历史实现把 state 初值写成 `0`，再用 `scroll >= maxScroll` 判断
> 「之前在底部」。内容一旦长过视口，`0 >= maxScroll` 恒假 —— 视口就永远停在**顶部**，
> 用户看到的是最早那几行。「输出回显看不见」的体感一半来自这里。

**`viewH` 的唯一合法实参是 `viewportContentRows(height, total, showIndicator)`**，
不是盒子高。指示器（`↑N ↓M`）占掉一行，长度是 `height + 1`，yoga 会把多出来的行摊到
所有子节点上 → 中间那行高度取整成 0 → **内容在视口正中凭空少一行**。故指示器要占位
就必须先从预算里扣一行。传盒子高会让 `maxScroll` 比渲染侧小 1，**贴底哨兵与选区行号
整体错位一行**（同一类 bug 的第二次发生）。

### 3.2 固定底部：帧高硬约束 + chrome 账本

输入框钉底不是「用 CSS 固定在底部」，而是**帧高必须 ≤ `rows − 1`**：
ink 把 live 区整体重画，只要它不滚动、输入框在帧内的相对位置自然不变。

ink 的 fullscreen 判定是 `lastOutputHeight >= stdout.rows`（`node_modules/ink/build/ink.js:320`，
用的是**上一帧**的 `outputHeight`，且 `outputHeight = output.split('\n').length`）。
一旦命中就走 `clearTerminal + fullStaticOutput + output` —— 本 TUI 跑在备用缓冲区里，
没有回滚缓冲，那条清屏会**连转录一起抹掉**；而且判定会**自锁**：一旦某帧高度 ≥ rows，
此后**每一帧**都清屏。

```
❌ 禁止让 live 区（含所有 chrome 兄弟节点）合计高度 ≥ rows
❌ 禁止新增固定高度的兄弟节点却不登记进 chrome 账本
✅ 高度一律走 chromeBudget.liveBudget(rows, shares)，shares 逐项列出
✅ 排障先开 KHY_TUI_DIAG_H=1 打印账本，再和实测帧行数对照
```

**容易漏计的 chrome**（按实测，不是按注释）：

| 项 | PreviewLayout | legacy |
|----|---------------|--------|
| 标题栏 Topbar | 1 | — |
| 底部固定层顶上的分隔线 | 1 | — |
| PromptFrame | 3 | 3 |
| FooterBar | 1 | 1 |
| 忙态 spinner 块 | 3 | 3 |
| 任务清单 | `3 + 条数 (+1 尾切提示)`，无清单 0 | 同左 |
| slack（conpty pending-wrap 纪律） | 1 | 1 |

**实测下限：可用高度 ≈ 14 行**（legacy 13 行边缘可用）。低于此值固定 chrome 物理上装不下 ——
这不是 bug，是几何不可能。

#### 3.2.1 输入框自身也要防溢出（E 类冲突）

`PromptFrame` 面对一个 ink 的账本 bug：**ink 按逻辑行记擦除量，终端按视觉行显示**。
一行超宽输入被终端硬折成 2+ 视觉行后，ink 记「1 行」→ 下一次重绘**少擦** → 输入内容
漏到框下方，渗进输出区。

处方是**预折行 + 高度窗口化**（`layoutPromptRows`，纯函数、导出可单测）：

- 每行先按可用列宽（CJK 感知，`cols - 1` slack）折成视觉行，**逐段各占一行**渲染
  ⇒ 逻辑行数恒等于视觉行数，ink 擦得干净；
- 折到超过 `maxRows` 时，渲染**以光标行为中心的窗口**，隐藏的头/尾用灰色 `⋯` 标记；
  `value` 一字不动（纯显示层窗口化，无数据损失）；
- 盒子高度**硬上界**，永远不会自己顶穿视口。

### 3.3 滚轮：必须在应用内消化（A↔D 冲突的根因）

这是四件事里**最反直觉**的一条。备用缓冲区**没有回滚缓冲**，所以终端会把滚轮
**合成为 `↑`/`↓` 键**送进 stdin；而 `arrowRouting` 把 `↑`/`↓` 绑定在
`history:previous/next` —— 用户看到的「滚轮回溯历史记录」**其实是键位串扰**，
不是设计如此。

```
❌ 禁止在备用缓冲区下把滚轮交给 onNative（= 交还终端）
✅ 滚轮优先走 dispatcher 的 onWheel(dir)，驱动应用内视口
✅ onWheel 缺失时才回退 onNative（逐字节保留旧行为）
✅ onWheel 抛异常必须被吞掉，且**不得**顺带触发 onNative
```

**判据顺序是根因级的**（`mouseButtons.createMouseDispatcher`）：
`isWheel` 分支走在**修饰键放行之前**，因为 `Shift+滚轮` 在终端里是**横向滚动**，
不是「我要拖选」。步长 `WHEEL_LINES_PER_NOTCH = 3`（终端惯例，与 `scroll:lineUp` 同族），
逐格累加且**共用贴底语义**（滚到底自动回写 `null`）。

门控 `KHY_MOUSE_WHEEL` 默认开；`app.js` 在 `ALT_SCREEN_ENABLED && !mouseExplicitlyDisabled()` 时
**强制接管**鼠标。回归测试 `mouseWheel.test.js`。

> **设计后果（诚实记录）**：一旦滚轮被应用接管，**主屏模式下的原生滚动也就被剥夺了**。
> 这是为了让备屏可用而付出的对称代价；退路是 `KHY_MOUSE=off`（整层不接管）。

### 3.4 拖选与跨页复制

**为什么不能「把事件还给终端」**：鼠标追踪一旦开启，事件就被 ink 从 stdin 读走，而
`node_modules/ink/build/hooks/use-input.js:112-114` 把 handler 返回值**直接丢弃**
（`inputHandler(input, key)` 无人消费）—— `return false` **物理上回不到终端**。
所以唯一解法是**本进程内自绘**：

```
拖按下 → dispatcher onSelectEvent('down')  → 记 anchor，丢弃旧选区
拖位移 → dispatcher onSelectEvent('move')  → normalizeSelection → setState
拖松开 → dispatcher onSelectEvent('up')    → extractText + writeClipboard（唯一产出点）
```

#### 3.4.1 坐标契约（I1/I2 的具体化）

三层职责分明，**每层只做自己那段换算**：

| 层 | 输入 | 输出 | 谁负责 |
|----|------|------|--------|
| dispatcher | SGR 字节 | **0-based 屏幕绝对坐标** | `parseSgrMouse`（已减 1）；**不减视口偏移** —— 那是 App 层 state |
| App.onSelectEvent | 屏幕 row/col | 行数组下标 + 字符下标 | 见下方公式 |
| `selection.js` | 行数组下标 + 字符下标 | 选区模型 / 文本 | 纯叶子，零 IO |

```
行下标  = ev.row − _viewportScreenTopRef + offset      （加号！见下）
字符下标 = charColForDisplay(lines[行], displayCol)     （显示列 → 字符下标）
```

三条**必须知道**的坑（都是端到端探针抓的，单测各自自洽发现不了）：

1. **`+ offset` 不是 `− offset`**。真源是 `Viewport.js`：
   `const start = clampedScroll; const visible = lines.slice(start, end);`
   即**视口第 0 行 = 数组下标 `clampedScroll`**。写成 `− offset` 的后果是
   「只要滚动过，选中的行就整体偏移」，看起来像随机选错行。

2. **`ev.row` 是物理终端行，不是「视口内第几行」**。ink 把 `<Static>` 横幅先写进屏幕，
   live 帧被推到它下面（实测 118 列、真 App：`rows=40` 时帧高 38 ⇒ 帧首行 1）。
   校正值由鼠标事件入口每次重算写入 `_viewportScreenTopRef`；`NaN` ⇒ 不校正（逐字节退回旧行为）。

3. **显示列 ≠ 字符下标**。SGR 上报的是终端**单元格**列，而 `selection.js` 与
   `Viewport.sliceLineForSelection` 一律按**字符串下标** `slice(from, to)`。
   中文行上两个口径差近一倍 ⇒ 「反色跑不到指针底下、复制比选中的多一截」。
   换算复用 `wrapCell.visWidth` —— 与把这些行折成视觉行的**同一把尺子**（I2）。
   宽字符右半格归到该字符起始下标，**不劈开字形**。

4. **不要用 `hitTest` 反查坐标**：那是 yoga 树的**实时**几何，与按列宽预折好的视觉行
   在软换行处不一致，拿它的结果索引 `lines` 会整体错位。选择层走「视口偏移」这条算术路径
   （与滚轮同源）。

#### 3.4.2 跨页复制：边缘自动滚动（A-09）

终端只把指针报告到**窗口边界**为止 —— 指针到了最后一行就不再产生新行号，选区于是被
**一屏**卡死。用户看到的正是「能选中，但只能选当前这一页，跨页就复制不出来」。

处方是 `Viewport.dragAutoScroll(rawLine, offset, viewH, total)`（纯叶子）：

- 指针在**可见区下沿或更下** → 下滚一格；在上沿或更上 → 上滚一格；内容不超视口／已到端点 → 不动；
- **靠位移事件天然限速，不需要定时器**（一次一格）；
- 返回的 `line` 是**滚动之后**指针所指的绝对行 —— **锚点不动、活动端跟到新行**，
  这才是「继续扩展」而不是「跳回起点」；`offset` 可直接回写 App 侧滚动 ref。

内容与视口等高时 `delta` 恒为 0，退化为「clamp 不崩」（A-09 允许的简化）。

#### 3.4.3 产出点唯一：松手即定稿

```javascript
// App.js onSelectEvent, kind === 'up'
const dragged  = sel.extendSelection(_selectRegionRef.current, pt.line, pt.col);  // 松手点也进选区
const finished = sel.endSelection(dragged);
const range    = sel.normalizeSelection(finished);   // 零宽 → null（普通点击，不成选区）
if (!range) { …清空… return; }
const text = sel.extractText(_mainContentLinesRef.current, finished);  // ← 唯一产出点
if (_selectClipEnabled(process.env) && text) clip.writeClipboard(text);
```

三个细节各有原因：

- **松手点也要算进选区**：1002 的位移上报是「尽力而为」，快速小拖动可能**一个 `move`
  都没到** —— 那样 `head` 还停在按下点，选区零宽，用户看到反色画出来了却复制不出东西
  （最迷惑的一种「复制失灵」）。
- **零宽用 `normalizeSelection` 判**：与 `extractText` 内部同源，不会出现
  「画了但提取为空」的不一致。
- **反色延迟 1.5s 自动清除**（`KHY_SELECT_CLEAR_MS`，`0` = 立即清）：对齐「复制完成即消失」直觉；
  清除前用户若继续拖选/按键，`cancel`/`down` 分支会撤销定时器，不会擦掉进行中的手势；
  卸载时 `useEffect` 兜底撤销（fail-soft，绝不抛）。

#### 3.4.4 剪贴板出口：`ccClipboard` 单源两层

| 层 | 通道 | 触发条件 |
|----|------|---------|
| 1 | **native 先行** | 本地终端有系统工具：`powershell Set-Clipboard` / `pbcopy` / `xclip` / `wl-copy`。载荷走 **stdin 管道，绝不进命令行**（注入安全 + CJK 安全） |
| 2 | **OSC 52 兜底** | **仅**非 TTY stdout（存在转发层：SSH / tmux）。TTY 下喷 `\x1b]52;…` 会污染画面/进 scrollback，纪律是**不发** |

附加规则：tmux/screen 下 OSC 52 须包 `\x1bPtmux;…` 外层 DCS 才能穿透；载荷 base64 后
> 100KB 不再发（`KHY_CLIPBOARD_MAX_BYTES`，保守值，Windows Terminal 曾对大载荷冻结）。
返回**统一状态对象**（绝不抛）：`{ ok, channels, bytes, reasons }`，调用方按 `reasons`
打印「问题 + 原因 + 修复」。

### 3.5 `↑`/`↓` 历史回溯：context 栈 + 草稿暂存

#### 3.5.1 归属判定：一张表，一个函数

`arrowRouting.js` 照抄 Claude Code 的 `context → bindings` 结构。**khy 的 App.js 块 4.7
本来就是一个 context 栈**，只是历史上写成一串有序 `if`，判定条件与动作实现缠在一起，
读的人得从缩进反推优先级。现在判定全下沉到叶子：

```javascript
resolveContext({ shellViewOpen, busy, empty })   // → 'shellView' | 'executing' | 'idle' | 'editing'
resolveArrowAction({ key, …state, queueLen })    // → 动作名
```

| context | 何时进入 | `↑` | `↓` | `←` | `→` |
|---------|---------|-----|-----|-----|-----|
| `shellView` | shell 窥视面板打开 | `scroll:lineUp` | `scroll:lineDown` | `subview:exit` | `noop` |
| `executing` | 忙 **且** 输入为空 | `queue:editLast`（**仅队列非空**，否则 `noop`） | `subview:openShell` | `noop` | `noop` |
| `idle` | 闲 **且** 输入为空 | `history:previous` | `history:next` | `noop` | `input:forward` |
| `editing` | 其余（输入非空） | `history:previous` | `history:next` | `input:forward` | `input:forward` |

**`editing` 下 `↑`/`↓` 是「无条件」绑到历史的** —— 不看缓冲区是否为空、不看有没有换行，
与 CC 的 `Chat` context 一致。

> **这条曾经是 bug，值得记下**：早期实现在「缓冲区非空」时**吞掉**竖直方向键。后果是
> 第一次 `↑` 召回最近一条后缓冲区不再为空，于是后续 `↑` **全被吞** —— 用户只能回溯
> **一条**，想再往前必须先清空整行。当初留了个 env 旋钮 `KHY_HISTORY_BROWSE_EDITING`
> 给这条「字节级回退」，已随 Stage 2 一并退役：既然对齐 CC 就意味「无条件转发」是唯一
> 正确解，留着回退等于**留一个开关让人把 bug 再打开**。
> `historyBrowseDecision.js` 现在只剩兼容外壳（两个函数**恒返回 `true`**，不再读 env）。

#### 3.5.2 草稿暂存：转发不丢输入

`useTextInput` 的 `historyPrev` / `historyNext`（`histIdx` 游标 + `draft` 暂存）：

```javascript
function historyPrev() {
  const h = history.current;
  if (h.length === 0) return;
  if (histIdx.current === -1) {          // 第一次 ↑：暂存实时草稿
    draft.current = cur.text;
    histIdx.current = h.length;
  }
  histIdx.current = Math.max(0, histIdx.current - 1);
  setText(h[histIdx.current]);
}
function historyNext() {
  if (histIdx.current === -1) return;    // 没在浏览中 → 不响应
  histIdx.current += 1;
  if (histIdx.current >= h.length) {     // ↓ 走过最新一条：还原草稿
    histIdx.current = -1;
    setText(draft.current || '');
    if (onHistoryEmpty) onHistoryEmpty();
    return;
  }
  setText(h[histIdx.current]);
}
```

不变量：**每次 `↑`/`↓` 移动的是一条「提交记录」，不是一个视觉行**。`useTextInput`
把含内嵌换行的提交视为**一条**历史 ⇒ 多行缓冲区下转发 `↑` **也不丢任何输入**。

#### 3.5.3 跨会话持久化：复用既有真源

- 门控 `KHY_TUI_HISTORY_PERSIST`（默认开，`0/false/off/no` 关 → 逐字节退回「仅本会话内存历史」）；
- 落盘**复用** `cli/repl/history.js`（经典 REPL 用的同一个 `~/.khyquant_history`）——
  **绝不另造一份存储**；
- `mergeHistory(persisted, session, max)`：旧→新合并、去空白、截到最近 `max` 条（最近的先出）；
- 挂载时 `loadHistory()` 预填 ⇒ 首次 `↑` 就能召回上一会话的命令；**每次 fs 触碰都 fail-soft**，
  坏文件/被锁历史绝不阻断 TUI 挂载。

#### 3.5.4 与「视口滚动键」的分工

`PgUp/PgDn`、`j/k`、`g/G`、`space` 绑**视口滚动**（块 4.8 / 4.9），`↑`/`↓` 在 `idle`/`editing`
绑**历史**。两族键**不共用按键**，所以「键盘滚动」与「键盘历史」本身不冲突。
真正的冲突只在 `↑`/`↓` 上 —— 而它被 context 栈裁决：**输入非空时看历史、子视图打开时看滚动**。

> ⚠ 转录子视图（`Ctrl+O`）与 `shellView` 都**独占全部输入**，在 App.js 更早的分支里
> `return` 掉，**根本到不了**块 4.7。vim / plan / help / 补全菜单各自持有自己的按键处理，
> 块 4.7 整体被跳过。这就是「`↑↓` 在四种 context 下解析成不同动作」之外，
> **还有一层更早的独占**——两层合起来才是完整的键位归属图。

---

## 4. 冲突消解：一张完整的优先级表

`App.js` 的 `useInput` 是唯一的键盘入口，分支**自上而下短路**：

| 序 | 分支 | 条件 | 说明 |
|----|------|------|------|
| 1 | 权限提示 | `query.controlRequest` | 顶层让位，由 overlay 自己的 `useInput` 消费 |
| 1.5 | 看板聚焦 / `Ctrl+G` / 图片删除 | `navOn` 等 | 各自 `return` |
| — | 子视图独占 | `transcriptOpen`（块 4.7 之前） | `Ctrl+O` 转录：`ctrl+u/d/b/f`、`p/n`、`j/k`、`↑↓` 全部归**滚动**；`esc/q/ctrl+c/ctrl+o` 关闭 |
| — | vim / plan / help / 补全 | 各自 handler | 块 4.7 整体跳过 |
| **4.7** | **方向键归属** | `isArrow && !vim && !plan && !help` | **`arrowRouting` 裁决 → 动作名 switch** |
| 4.8 | 主视口滚动 | 非 Preview、无 overlay、无补全 | `↑↓ jk`、`space`、`PgUp/PgDn`、`g/G` |
| 4.9 | Preview 视口 + 右栏滚动 | Preview 布局 | 同一组键，主视口与右栏**独立偏移** |
| 5 | 其余 → 文本编辑 | 兜底 | `textInput.onInput` |

**鼠标事件**走独立通道（`mouseButtons.createMouseDispatcher`），判据顺序同样是根因级的：

```
① 滚轮最先（Shift+滚轮 = 横向滚动，不是拖选）
② 修饰键放行早于 motion / press / release 全部（Shift 放行是硬承诺）
③ motion 早于 hover 限流（否则 30ms 节流吞掉选区轨迹 → 选区「跳格」）
④ press 落空上报 down 后仍返回 false（「不消费」只是不去吞，事件已到过我们手里）
⑤ release 的 up 在 return 之前上报（松手是唯一产出点）
```

**「修饰键绕过」不能只写 Shift**（`AGENTS.md` §0.8）：各终端的「我要终端原生选择」
约定键不一致，只认 `Shift` 会让相当一部分用户的原生拖选仍然失效。`parseSgrMouse`
把 `isShift` / `isAlt` / `isCtrl` **三个位都拆出来**，任一为真即放行：

| 终端 | 用户实际按的 | SGR 位 |
|------|-------------|--------|
| VS Code 集成终端 / Windows Terminal / xterm | `Shift` | 位 4 |
| iTerm2 | `Option` | 位 8（iTerm2 的 Shift 默认不发序列） |
| Terminal.app | `Fn` | 部分映射为 `Alt`，同走位 8 |
| 任意（显式回退） | — | `KHY_SELECT=0` 关自绘层；`KHY_MOUSE=off` 连滚轮也不接管 |

⚠ **诚实边界**：`return false` 物理上回不到终端，放行的真实价值在于**不去吞它、
也不去画自己的选区**。终端能否真的接管 `Shift+鼠标`，取决于终端**是否上报修饰序列** ——
部分终端不上报，那种情况下 Shift 与不按 Shift 无法区分。

### 4.1 鼠标追踪三档互斥：`enableBytes` 是唯一真源

DECSET 的三个追踪模式是**同一能力的不同档位，互斥**，只能开一个：

| 模式 | 上报内容 | 谁需要 |
| --- | --- | --- |
| `1000` X11 basic | 按下 / 松开 | 点击层（按钮高亮） |
| `1002` button-event | 按下 / 松开 / **按住时的位移** | **应用内自绘选择**（选区要跟手扩展） |
| `1003` any-motion | 一切移动（60~120Hz 洪流） | 悬停高亮（**必然**吞掉拖选） |

`1006` 是 SGR 坐标编码，与追踪模式**正交**，永远都要带。

```
❌ 禁止叠加写 1000h 与 1002h（终端按哪一档解释变得不确定）
✅ enableBytes({ select: true }) 写 1002h 时**不写** 1000h（替换语义）
✅ 1003 只在 hover=true 时追加，与 select 正交
✅ 重新接管追踪（enterNativePassthrough 的超时回调）必须与初始开启**同档** ——
   漏了 select 会退回 1000，拖动位移从此不再上报，表现为
   「滚一下滚轮之后拖选就失灵了」这类间歇性故障
```

> ⚠ **一条曾被写反的因果**（2026-09-17 修正）：历史注释称「1002 报位移意味着按下已被
> 吃掉，所以必须降到 1000」。**因果是反的** —— 按下被吃掉是因为 dispatcher 对 `press`
> 无条件 `return true`，与开哪一档无关；1000 下 press 照样上报、照样被吃。降档只是
> 顺手删掉了自绘选择唯一需要的位移信息。
> ⇒ 纪律：**「不报 X」不等于「不报 Y」**，判据要按**事件类别**逐项写清。

---

## 5. 布局与帧高：四件事共享的物理预算

```javascript
// chromeBudget.js —— 唯一的 chrome 账本（DESIGN-ARCH-103 P0-5 / H1）
chromeRows(shares)               // 固定（非滚动）行数之和
liveBudget(rows, shares)         // rows − chrome − 1，clamp 到 [LIVE_MIN, rows]
```

`-1` 是两条纪律的合成：**绝不写最后一行**（conpty pending-wrap）+ **不进 ink 的
fullscreen 触发条件**。历史上这套算术散在**三处**（`ccLayout.messageAreaCap`、
`liveRegionBudget`、`railLayout.railBottomChrome`），各有各的常量 —— 改一处就会脱钩、
帧静默顶穿视口。现在三处降级为账本的薄适配器，签名不变。

**几何分工**（一帧从上到下）：

```
┌─ Topbar (1)                       ← 仅 PreviewLayout
├─ 分隔线 (1)                        ← 仅 PreviewLayout
├─ 主内容视口  Viewport(height=H)     ← 可滚，H 由 liveBudget 分配
│    └─ 可选指示器 (占 1，从 H 里扣)   ← viewportContentRows 扣行
├─ spinner 块 (忙时 3) / 任务清单       ← 可选 chrome，必须进 shares
├─ PromptFrame (3)                   ← 钉底，不受滚动影响
├─ FooterBar (1)                     ← 钉底
└─ slack (1)                         ← conpty 纪律
   ─────────────────────────────────
   合计 ≤ rows − 1
```

**输入框钉底是「帧内固定 + 帧不滚」的合成结果**，不是独立机制。所以 §3.2 的
`≤ rows − 1` 硬约束**同时也是**「固定底部」的前提 —— 这是 A/C 两类诉求**共用一个
约束**的地方，也是设计上最经济的一笔。

---

## 6. 门控总表（共存机制的逃生舱）

所有门控**在最外层读**，叶子只吃布尔参数。`0/false/off/no` 一律等于「关」，关掉时
**逐字节回退**旧行为。

| 门控 | 默认 | 作用 | 关掉后的代价 |
|------|------|------|-------------|
| `KHY_INLINE_TRANSCRIPT` | 开 | 转录由**应用内 Viewport** 承载 | 回退「整段转录走 `<Static>`」，可滚性丧失 |
| `KHY_MOUSE` | `click`（`off`/`click`/`full`） | 鼠标层主开关 | `off` = 完全不接管（原生滚轮 + 拖选全保留） |
| `KHY_MOUSE_WHEEL` | 开 | 滚轮驱动应用内视口 | 交还终端原生滚动 ⚠ **仅主屏有意义** |
| `KHY_MOUSE_HOVER` | 仅 `full` 档 | 1003 悬停（60~120Hz） | —（默认关，开了**必然**吞拖选） |
| `KHY_SELECT` | **开** | 自绘选择总闸（开 1002、画反色、松手写剪贴板） | 回退旧行为，追踪态下**无可用选择通道** |
| `KHY_SELECT_CLIP` | 开 | 松手自动写剪贴板 | 能选中能看但**不自动复制** |
| `KHY_SELECT_DRAG` | 开 | 1002 位移追踪 | 只认按下/松开两点式（**诊断用**） |
| `KHY_SELECT_CLEAR_MS` | `1500` | 复制后选区延时清除 | `0` = 立即清 |
| `KHY_PRESERVE_SCROLLBACK` | 开 | 剥离 `\x1b[3J`，保住原生回滚 | 两平台都退回 ink 原始行为 |
| `KHY_SUPPRESS_STATIC_REPRINT` | 开 | 全屏帧「整段转录重发」抑制 | 历史在 scrollback 里堆叠副本 |
| `KHY_FULLSCREEN_TAILCUT` | 开 | 全屏帧「活区尾切」到 `rows−1` | 帧逐次滚屏 → scrollback 串副本 |
| `KHY_TUI_HISTORY_PERSIST` | 开 | 跨会话历史持久化 | 仅本会话内存历史 |
| `KHY_MOUSE_BUTTONS` | 未设 | 旧版布尔覆写 | **优先于** `KHY_MOUSE` 档位 |
| `KHY_ALT_SCREEN` | legacy 开 / CC 关 | 备用缓冲区（1049h） | 见 §7 架构反转 |
| `KHY_TUI_DIAG_H` | `0` | 打印帧高账本到 stderr | — |
| `KHY_TUI_DIAG` | `0` | 打印鼠标事件解析结果 | — |

### 6.1 排障表（症状 → 成因 → 修）

| 症状 | 成因 | 修 |
|------|------|-----|
| **拖选选不中 / 复不出文本** | 自绘层被关，或终端未上报修饰序列 | ① 确认 `KHY_SELECT` 未被显式关；② 按住**本终端的原生选择修饰键**拖（§4）；③ 退路 `KHY_MOUSE=off` |
| 滚轮翻不了历史（备屏下变成 `↑`/`↓` 回溯） | 滚轮被交还终端，而备屏无回滚缓冲 | 确认 `KHY_MOUSE_WHEEL` 未被设 `0` |
| 拖动会输出 `[<32;…M` 之类文本 | **`1002` 残留在终端**（进程被 `SIGKILL` / 终端崩溃 / 断电 → 不走 teardown） | `printf '\033[?1002l\033[?1000l\033[?1003l\033[?1006l'` 复位，或**重开终端** |
| 选中了但剪贴板没内容 | `writeClipboard` 走 OSC 52 而当前是 SSH/tmux 嵌套 | 看 `reasons` 的可见提示；必要时 `KHY_CLIPBOARD_DUAL=1` |
| 转录被整片抹掉 | 某帧高度 ≥ `rows` → ink fullscreen 分支自锁 | `KHY_TUI_DIAG_H=1` 核对账本，把漏计项补进 `shares` |
| 状态栏下方一行幽灵文本 | 有模块绕过 ink 注入流直写 stdio（winston `console._stdout`） | 走 ink 树，或纳入 `consoleMute` 同族处理（§8.3） |

---

## 7. 业内对照

### 7.1 与本仓同构的实现：Claude Code 全屏渲染

CC 官方文档（`code.claude.com/docs/en/fullscreen`）的描述与本仓高度同构，逐条对照：

| 维度 | Claude Code | khy（本仓） |
|------|-------------|------------|
| 画布 | 备选屏幕缓冲区，像 vim / htop | 同（`KHY_ALT_SCREEN`；legacy 默认开、CC 默认关） |
| 渲染树 | 只保留可见消息，长对话内存平稳 | 同（`_mainContentLines` 预折行 + `lines.slice`） |
| 滚动键 | `PgUp/PgDn` 半屏、`Ctrl+Home/End` 顶/底、滚轮每格几行 | 同族（`halfPage/fullPage` + `top/bottom`，动作名共享 `scrollActions`） |
| 自动跟随 | 向上滚暂停跟随；底部浮动 `Jump to bottom`，显示 `3 new messages` | **贴底哨兵 `null`** + `↑N ↓M` 指示器（无浮动按钮，用 dim 行） |
| 鼠标滚轮 | 需终端转发鼠标事件；`CLAUDE_CODE_SCROLL_SPEED` 调倍速；快速滚轮加速 | `KHY_MOUSE_WHEEL`；步长固定 3 行（无倍速，见 §9 差距） |
| 原生选择被吃 | 「当你捕获鼠标事件，**终端原生 copy-on-select 停止工作**」；选区在 CC 内 | 同判定（§3.4），且**自绘反色** |
| 复制时机 | **鼠标释放时自动复制** | 同（松手即 `extractText + writeClipboard`） |
| 剪贴板路径 | macOS `pbcopy` / Linux `wl-copy`·`xclip`·`xsel`（同时写 PRIMARY）/ Windows PowerShell `Set-Clipboard` / tmux 写自身缓冲 / SSH 降级 OSC 52 | **同构**（`ccClipboard` 两层 + tmux DCS 包裹） |
| 保留原生选择 | 按住 **Fn**（Terminal.app）/ **Option**（iTerm2）/ **Shift**（VS Code 等） | **同位拆分**（`isShift/isAlt/isCtrl` 三位，§4） |
| 选择键行为 | `Esc`/`PgUp`/`Ctrl+Home`/修饰键+方向 ⇒ 选择**保留**；普通方向键/`Enter`/输入字符 ⇒ **清除** | 部分：`cancel` 手势清；**「按键清除」语义本仓未实现**（§9） |
| 逃生门 | `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` / `DISABLE_MOUSE` / `DISABLE_MOUSE_CLICKS` / `NO_FLICKER` / `ALT_SCREEN_FULL_REPAINT` | `KHY_ALT_SCREEN` / `KHY_MOUSE=off` / `KHY_MOUSE_WHEEL=0` / `KHY_SELECT=0` / `KHY_TUI_CONSOLE_LOG` |
| 备屏副作用（诚实记录） | 「终端的 `Cmd+f` 和 tmux 搜索**看不到**对话内容」；需转录模式 + `[` 写回滚 | 同（本仓还有 `scrollbackPreserve` 四层去砸备屏副作用，见 §7.3） |
| 已知终端坑 | Windows Terminal / ConPTY **合并定位写入** → 残片；`tmux -CC` 不兼容 | 同族（`KHY_ALT_SCREEN_FULL_REPAINT` 在 CC 侧；本仓走 `scrollbackPreserve` 的 win32 改写 `[2J[0f` → `[H[J`） |

**结论**：本仓的键盘/鼠标/选择/剪贴板四层与 CC **基本 1:1**，差异集中在
① CC 有滚轮倍速与加速、② CC 有「按键清除选区」的细粒度语义、③ CC 的浮动
`Jump to bottom` 带消息计数按钮。这三条列入 §9 差距清单。

### 7.2 其他路线：为什么它们不能直接照搬

| 实现 | 路线 | 与本仓的差别 |
|------|------|-------------|
| **less / more** | 独占全屏，**自己实现**滚动与搜索，不依赖终端回滚 | 是「分页器」不是「常驻 REPL」：没有钉底输入框，也没有历史回溯共存问题 |
| **tmux copy-mode** | `Prefix+[` **模式化**：进入后方向键归滚动，`Space` 起选、`Enter` 复制、`q` 退出 | 与本仓 `shellView`/`transcriptOpen` 的「子视图独占」**同构**；差别是 tmux 需要一个显式模式键，本仓靠 context 栈**自动**切换 |
| **vim / htop** | 备屏 + 自绘，退出恢复原终端 | 无输入历史共存诉求（vim 的 `:` 历史是另一套） |
| **readline / bash** | **主屏** + 终端原生回滚；`↑↓` 无条件历史 | **不能照搬**：主屏方案下滚轮由终端处理，但备屏下滚轮被合成 `↑↓` → 历史回溯串扰（§3.3） |
| **ink-scroll-view**（社区库） | 给 ink 补 `Viewport` 语义 | 本仓 `Viewport.js` **自带**，且多了选区反色、贴底哨兵、`viewportContentRows` 扣行、`dragAutoScroll` 四项 —— 通用库不含这些产品约束 |

**共同规律**：**所有能同时满足「可滚 + 可复制 + 钉底输入」的实现，都不向终端要滚动，
而是自己维护视口**。终端原生回滚与「应用自管视口」**只能二选一**——这是本仓
`scrollbackPreserve` 的存在理由，也是 CC `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` 的存在理由。

### 7.3 备屏副作用的三层对抗（本仓独有）

备屏丢回滚缓冲，本仓不靠「不用备屏」而是**四层叠加**把副作用压到可接受
（`scrollbackPreserve.js`，纯叶子、门控 `KHY_PRESERVE_SCROLLBACK`）：

| 层 | 做什么 | 门控 |
|----|--------|------|
| 1 | 从写给 ink 的 stdout 边界剥掉 `\x1b[3J`（仅它），保留 `\x1b[2J`/`\x1b[H` | 同上 |
| 2 | win32 额外把 `[2J[0f` 改写为等价的 `[H[J`（ED0 **就地擦除**，不滚屏 ⇒ 不留重复副本） | 同上 |
| 3 | 全屏帧「整段转录重发」抑制：字节级前缀校验后剥掉冗余 static 段 | `KHY_SUPPRESS_STATIC_REPRINT` |
| 4 | 全屏帧「活区尾切」到 `rows−1`：整帧不滚屏 ⇒ scrollback 零副本 | `KHY_FULLSCREEN_TAILCUT` |

> 层 3/4 的因果值得记住：上游 ink 用 `3J` **每帧清空 scrollback** 来掩盖「帧滚屏」，
> 而层 1 恰恰为**保全 scrollback** 剥掉了 `3J` —— 副本于是从「被掩盖」变成**永久积累**。
> 正解不是恢复 `3J`，而是**从源头不让它滚**。

---

## 8. 三条不变量为什么不可让步

### I1 —— 视口偏移是唯一坐标系

任何一处「自己算偏移」都会与渲染侧脱钩。历史三次翻车**同源**：
① 初值 `0` 当「在底部」→ 视口永远停在顶部；
② `hitTest` 反查 → 软换行处整体错位；
③ `Number(null) === 0` 手写解析 → 贴底被误读成停在顶部，屏幕第 0 行映射到数组第 0 行
（**根本看不见的最早那几行**，用户拖动时反色不出现、复制出陈年旧消息）。
⇒ **纪律：偏移只经 `resolveViewportOffset`，`viewH` 只经 `viewportContentRows`。**

### I2 —— 填充与渲染走同一把尺子

`wrapCell.visWidth` 是**唯一**宽度度量。折行用一把尺、列宽换算用另一把，正是
`[DESIGN-ARCH-103]` H6 反复踩的「折行与计费不同源」。`charColForDisplay` 显式复用
`visWidth` 就是为此。

> ⚠ **「折与计算不同源」还有一个未解的残留**（`[DESIGN-ARCH-113]` / H6 同族）：
> `_mainContentLines` 是**按列宽预折**的，而 `wrapCell` 的宽度度量与
> `ink` 内建 `string-width` 在**歧义宽度字符**（East Asian Ambiguous，如 `→` `±` `§`
> 以及部分 emoji）上可能取不同值。此时**终端按更窄的宽度显示**、应用按更宽的宽度填充，
> 视觉行数比 `_mainContentLines` 记录的多，导致：选区坐标整体偏一行、`viewH` 低估、
> 帧高算少 —— 三者又互相跨层叠加（与 §8 I3 的「跨层失真是乘性而非加性」同一族）。
> 目前**未复现出稳定反例**，故不列为缺陷、只列为判读警示：遇到「错位一行」类报告，
> 先查报告者终端/字体是否把某个歧义字符判成双宽。

### I3 —— 单写者：只有 ink 注入流能画屏

`app.js` 把渲染流换成 `scrollbackPreserve(process.stdout)` 的 Proxy，ink 每帧按
`lastOutputHeight` `eraseLines(n)` 重画。而 `patch-console` 只替换 `console.log/warn/…`
这 18 个方法，**不碰 `console._stdout`**；winston 的 Console transport 恰好写的就是
`console._stdout.write`。于是日志字节**绕开了注入流与它的帧高账本**，
`eraseLines` 永远擦不到它 —— 状态栏下方一行幽灵文本（BUG-13）。

**已登记的绕过者**与处方：

| 绕过者 | 处方 | 逃生门 |
|--------|------|--------|
| winston Console transport | `consoleMute.js` 在 `render()` 前把该 transport 的 level 设 `silent`，`waitUntilExit()` 后恢复（`process.once('exit')` 兜底） | `KHY_TUI_CONSOLE_LOG=1` |
| `sessionWatchdog.report()` 直写 `process.stderr` | 先问宿主（`opts.onReport`），宿主接走就不写；TUI 订阅 `noticeInbox` 落成 `role:'notice'` | `KHY_WATCHDOG_NOTICE=0` |

同族约束：宿主钩子只有**显式 `true`** 算「接走」，返回 `false` / 抛错 / 无钩子一律回落 ——
**诊断宁可多一行也不许静默丢**（Rule 3 诚实上报）。另附：任何**包裹 stdio `.write` 的机制**
在卸载时必须**按身份还原**（`stream.write === myPatch` 才还原，别人套在外面就不动）。

---

## 9. 已知偏差与待改进项

诚实边界清单（**记录现状，不构成本文改动**；每条给出代价与可选修法）。

### 9.1 复制保真

| # | 偏差 | 后果 | 可选修法 |
|---|------|------|---------|
| K1 | **跨软换行复制带硬 `\n`**：`_mainContentLines` 含按列宽折好的软换行，视觉行 ≠ 逻辑行 | 复制一段换行折过的长文本，中间多出 `\n`，粘到 shell 里会当成回车 | 行投影补 `softWrap` 元数据，`extractText` 在软换行处用 `''` 而非 `'\n'` 连接（需另立提案，`selection.js` 头部已登记） |
| K2 | **双击选词不含 CJK 分词**：`WORD_CHARS = [A-Za-z0-9_./\\:~@+\-]`，中文按连续串成一个「词」 | 双击中文只选中一整段（与主流编辑器一致，属**刻意**取舍） | 引入 CJK 分词字典；代价是体积与误切 |
| K3 | 选区**跨屏滚动不落屏幕外内容**：`dragAutoScroll` 一次一格，靠位移事件限速 | 极快甩动到边缘时扩展速度受事件率限制 | 边缘处加定时器加速（代价：引入定时器与「拖出窗口不松手」的边界态） |
| K4 | **`1002` 残留**：`SIGKILL` / 崩溃 / 断电不走 teardown，终端停在 mouse-tracking 态 | 拖动输出 `[<32;…M` 文本 | 无法彻底消除（`1000h` 本就有同风险）；文档给复位命令（§6.1） |

### 9.2 交互语义差距（对齐 CC）

| # | 差距 | CC 行为 | 本仓现状 |
|---|------|---------|---------|
| K5 | **「按键清除选区」缺失** | `Esc`/`PgUp`/修饰键+方向 ⇒ 选区**保留**；普通方向键/`Enter`/输入字符 ⇒ **清除** | 仅 `cancel` 手势（resize/切视图）清；普通按键不清 —— 选区会一直挂着到 1.5s 定时器或下次拖选 |
| K6 | **无滚轮倍速/加速** | `CLAUDE_CODE_SCROLL_SPEED`（0.25–20）+ 快速转动加速；JetBrains 终端忽略该变量 | 步长固定 3 行；高速滚轮体验弱于 CC |
| K7 | **无浮动 `Jump to bottom` 按钮** | 底部浮动按钮 + `3 new messages` 计数 | 仅 `↑N ↓M` dim 指示器（信息等价，可点性缺失） |
| K8 | **`v` / `y` 键位入口 deferred** | —— | 功能已被鼠标自绘选择覆盖；键位表**不得**宣称存在（`[DESIGN-ARCH-102]` §6.1） |
| K9 | 选区**跨视图切换不保留** | —— | 切视图触发 `cancel` 清空（刻意：避免悬空选区） |

### 9.3 机制层面

| # | 项 | 说明 |
|---|----|------|
| K10 | 滚轮接管**剥夺主屏原生滚动** | 备屏可用的对称代价；退路 `KHY_MOUSE=off`（§3.3） |
| K11 | `historyBrowseDecision.js` 只剩**兼容外壳** | 两个函数恒返回 `true`、不读 env；保留仅为不打断外部引用。**新代码请直接用 `arrowRouting.resolveArrowAction()`** |
| K12 | `↑`/`↓` 在 `editing` 下**无法移动多行光标** | 这是「无条件绑历史」的直接代价（对齐 CC）。多行内移动光标暂无绑定 —— 若用户反馈强烈，可考虑 `Ctrl+P/N` 或 `Alt+↑↓` |
| K13 | 帧高几何下限 ≈ 14 行 | 低于此值固定 chrome 物理装不下；**不是 bug，是几何不可能**（`AGENTS.md` §0.9.2） |

---

## 10. 维护纪律（改这四个功能前必读）

1. **改方向键归属** → 只改 `arrowRouting.js` 的 `_BINDINGS` 或 `resolveContext()`，
   并同步 `[DESIGN-ARCH-102]` §6.1 键盘总表。**不要在 App.js 里加 `if`**。
2. **改偏移语义** → 只改 `Viewport.js` 的 `resolveViewportOffset` / `applyStickyViewportAction`。
   调用方**不得**手写数字判断（`Number(null) === 0` 陷阱）。
3. **改视口几何** → `viewH` 一律取 `viewportContentRows(...)`，**绝不传盒子高**。
4. **改帧高** → 先读 `chromeBudget.js`，每个新增固定高度节点**必须登记进 `shares`**，
   然后用 `KHY_TUI_DIAG_H=1` 与实测帧行数对账。
5. **加鼠标事件判据** → 遵守 §4 的五步顺序。**修一条判据的顺序前，先想清楚它在谁之前/之后**
   —— 本仓三条根因级顺序（滚轮最先、修饰键最前、up 在 return 前）都是端到端探针抓的。
6. **改宽度度量** → 只认 `wrapCell.visWidth`。另起一把尺 = 折行与计费不同源。
7. **新增绕过 ink 画屏的模块** → 先问「它是否可能在 TUI 存活期被调用」。是，则要么走 ink 树，
   要么纳入 `consoleMute` 同族处理，**不要**指望「反正只是日志」（I3）。
8. **写渲染探针** → 三条硬前置（`AGENTS.md` §0.9.6）：① 走仓库自己的 `inkRuntime.loadInk()`；
   ② `FORCE_COLOR` 必须在 require 任何 ink/chalk 模块**之前**设；③ 被测代码读的
   **每一个环境量**（尤其 `process.stdout.rows`）探针都得如实改。
   **探针报红先怀疑探针的启动环境，再怀疑产品代码。**
9. **改测试运行器** → `tests/tui/**` 需要 `--experimental-vm-modules`（走 `test:tui` 脚本）；
   缺了会**静默 skip，看起来像全绿**。
10. **验收** → 改完必须过 `npm run --workspace services/backend test:tui` 与
    `tests/cli/tui/*`（含 `viewportSticky` / `mouseWheel` / `selection` / `mouseSelectEvent`）。

---

## 11. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-09-22 | 初版。汇总四件互斥诉求的共存机制（三条不变量 + 优先级表）、业内对照（Claude Code 官方全屏文档 / tmux copy-mode / less / readline / ink-scroll-view）、门控与排障总表、13 条已知偏差（K1–K13）与维护纪律十条。机制与代码坐标时点 `chore/tui-ux-nightly`。 |
