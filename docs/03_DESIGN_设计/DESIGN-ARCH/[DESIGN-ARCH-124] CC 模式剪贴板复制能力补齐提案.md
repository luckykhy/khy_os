# [DESIGN-ARCH-124] CC 模式剪贴板复制能力补齐提案

> **状态**：提案（待评审）—— 尚未编码。
> **范围**：`services/backend/src/cli/tui/` 下 CC 模式（`KHY_CC_TUI=1`）路径。
> **上游依赖**：`[DESIGN-ARCH-119]`（应用内自绘选择）、`[DESIGN-ARCH-111]`（规则遵守保障）。
> **约束真源**：`services/backend/src/cli/tui/AGENTS.md`（本目录工程约束）。

---

## 0. 一句话结论

剪贴板**底层通道**（`utils/ccClipboard.writeClipboard`）与**选区算法叶子**（`selection.js`）
都是模式无关的，已实测全绿；断的不是这两层，而是 **CC 模式没有消费鼠标事件的组件**。
补齐 = 在 CC 消息区接一个消费者 + 把消息树投影成 `lines[]` 喂给现成的 `Viewport`。
**Legacy 路径一行不改。**

---

## 1. 盲区实证（file:line 可复核）

### 1.1 断点定位

| 层 | 文件 | 状态 |
|---|---|---|
| 进程级鼠标层 | `tui/app.js` §294–329 | ✅ 已按 `KHY_SELECT` 开 1002 —— **CC 模式已经在收 SGR 事件** |
| 事件分发 | `tui/mouseButtons.js` `createMouseDispatcher` | ✅ `onSelectEvent` 通道完整 |
| 选区算法 | `tui/selection.js`（12 导出，零 IO） | ✅ 纯叶子，27/27 测试绿 |
| 反色渲染 | `tui/ink-components/Viewport.js` | ✅ `selection` prop 通用，16/16 绿 |
| 剪贴板出口 | `tui/utils/ccClipboard.js` | ✅ `writeClipboard()` 20/20 绿 |
| **消费者** | **`tui/ink-components/CcApp.js`** | ❌ **零命中** |

实测（`Grep` over `CcApp.js`）：

```
pattern="isMouseSequence|onInput|mouseDispatcher|_mouse"  → No matches found
pattern="onSelectEvent|_selectOn|selection"               → 0 hits（上一轮已确认）
```

⇒ `app.js` 把事件推进了 CC 的 stdin，**没有任何人接**。

### 1.2 比 Legacy 少的四件东西

Legacy `App.js` 有、CC 完全没有的：

| # | 机制 | Legacy 位置 | CC 现状 |
|---|---|---|---|
| 1 | 鼠标序列守卫 | `App.js:4390–4435` `if (_mouse.isMouseSequence(input)) {...}` | 无 → SGR 字节**落到文本处理**，可能被当输入 |
| 2 | 选区状态 + ref 镜像 | `App.js:1086–1100`、`5589–5602` | 无 |
| 3 | 坐标换算 | `App.js:1431–1518` `row + offset` | 无 |
| 4 | 反色渲染挂载点 | `App.js:6173–6185` `selection: _selectOn ? selectRegion : null` | 无（消息区是 `visibleMessages.map(...)`，`CcApp.js:582–591`） |

### 1.3 消息区结构差异（关键，决定方案）

Legacy：`_mainContentLines` 是**预折好的扁平 `string[]`**，不变量 `lines 下标 == 屏幕行`，
`Viewport` lines 模式直接 `slice(clampedScroll, clampedScroll+height)`。

CC（`CcApp.js:582–591`）：消息区是 **React 组件树**——

```js
visibleMessages.map(msg =>
  msg.role === 'user'
    ? <Box marginTop={1}><Text>{msg.text}</Text></Box>
    : <CcAssistantMessage text={msg.text} />
)
```

且 `CcAssistantMessage`（`CcAssistantMessage.js:29–42`）自己也是 `Box marginTop:1` +
按 `\n` 分行 + 首行加 `●` 前缀。

`CcApp.js:177–183` 已有的 `estimateMessageRows` 是**估算**（`1 + max(1, 行数)`），
它只用于窗口化裁切，**不足以**支撑 `row == index` 不变量 —— 软换行、`●` 前缀宽度、
`marginTop` 叠加都会让估算值偏离真实屏幕行。

⇒ **这是本次改动的真正技术难点，不是接鼠标。**

---

## 2. 方案（两条路，推荐 A）

### 2.1 方案 A（推荐）：消息区投影成 `lines[]`，走现成 `Viewport`

**做法**：把 CC 消息区从「组件树直接渲染」改为「先投影成扁平 `string[]`，再交给
`Viewport` 渲染」，与 Legacy 同构。

新增纯叶子 `ink-components/ccMessageProjection.js`（**新增文件优先于改现有文件**，
符合 `AGENTS.md:27`）：

```js
// 输入 messages[] + width → 输出 { lines: string[], ranges: {msgId,start,end}[] }
// 纯函数、零 IO、绝不抛（对齐 selection.js 的叶子纪律）
function projectMessages(messages, width) { ... }
```

- 折行复用仓库现有的 cell 宽度逻辑（`wrapCell.js` / `effectiveCols.js`，**不要自己写 wrap**）。
- `●` 前缀、`marginTop` 空行在投影里**显式产出行**，于是 `row == index` 重新成立。
- 组件侧改为 `<Viewport lines={lines} selection={selectOn ? selectRegion : null} ... />`。
- `CcAssistantMessage` **保留**（`Ctrl+O` 转录视图还在用），不删不重命名。

**代价**：CC 消息区失去 per-message 的富组件渲染能力（颜色分段、折叠块）。
若 `CcAssistantMessage` 目前有颜色分段（实测：只有 `●` 用 `CC_COLORS.dimColor`，
正文是裸 `<Text>`，**没有富分段**），方案 A 视觉损失≈0。

### 2.2 方案 B（备选）：保留组件树，另建行映射

保留现有渲染，额外维护一张「屏幕行 → (msgIdx, lineInMsg)」映射表，
`onSelectEvent` 收到 `(line, col)` 后反查。**不推荐**：

> ⚠️ **反模式，这条路别走**：这张映射表必须复刻 ink 的 yoga 布局
> （`marginTop`、软换行、`●` 宽度），一旦复刻不精确就整体错位 ——
> 正是 `AGENTS.md:268–269` 明令禁止的「用实时几何反查坐标」的翻版。
> 维护成本高、且**错位是静默的**（选到隔壁行），排查成本极高。

---

### 2.3 实际采用：C3 —— 手写投影（运行时）+ `renderToString` 当测试 oracle

方案 A 的方向对，但**落地方式**在上轮侦察后被替换成 C3：

> **C3（手写投影 + ink 当测试基准）**
> 运行时回到手写**纯字符串投影**（零 ink 开销），**但把 `renderToString` 当作测试
> oracle 来对拍** —— 正确性由 ink 保证，性能不付 ink 的代价。

| | 方案 A（原） | C3（实际） |
|---|---|---|
| 运行时行投影 | 调 `renderToString` 现算 | 手写纯字符串，`~0.1ms` |
| 正确性来源 | 天然一致（就是 ink 算的） | `ccMessageProjection.oracle.test.js` 逐字节对拍 |
| 每次渲染成本 | 12.78ms / 帧（实测） | 0 |

**三处「推理 vs 实测」的修正（都已落进代码与测试，别再改回去）**：

1. **`padToRows` 不能传。** 文档与投影注释曾假设「消息区 `flexGrow:1`，内容短于
   终端时多出来的行会画在屏幕上」。实测推翻：ink 6.8.0 的 `render()` 根容器**没有**
   显式 `height`（`ink.js` 只在 fullscreen 检测里读 `stdout.rows`，从不给 yoga 根
   设高），yoga 按内容定高 ⇒ `flexGrow:1` 分不到任何空间。探针（3 节点列，中间
   `flexGrow:1`）：无根 height → 3 行；根 height=10 → 10 行。**CC 主布局的根 Box
   没有 height，帧高就是内容高。**
2. **`●` 必须与正文分离固定宽度。** 原 `CcAssistantMessage` 把 `●` 与正文做成裸
   兄弟 `Text`，正文接近终端宽度时 yoga 把 `●` 挤成 0 列 —— `●` 消失 **且** 消息块
   凭空多出条数不可预测的 1~2 个空行（8 个长度样本里 6 个错）。已改为
   `Box{width:1, flexShrink:0}`，8/8 可预测。
3. **松手点必须算进选区。** `endSelection` 只把 `dragging` 置假、不吸收松手坐标；
   1002 的位移上报是尽力而为，快速小拖动可能一个 `move` 都不到 ⇒ `head` 停在按下点
   ⇒ 零宽 ⇒ 「反色画出来了却复制不出东西」。CC 与 Legacy 两侧都在 `'up'` 里先
   `extendSelection` 再 `endSelection`。

---

## 3. 要移植的东西（逐项）

### 3.1 门控与门控辅助函数（照抄 `App.js:180–284`）

`_OFF_VALUES` / `_selectEnabled` / `_selectClipEnabled` / `_selectDragEnabled`，
三个都**默认开**，读 `process.env.KHY_SELECT` / `KHY_SELECT_CLIP` / `KHY_SELECT_DRAG`。

> 移植方式：这三个函数在 `App.js` 里是 100 行左右的小助手。**不 require `App.js`**
> （`AGENTS.md:627` 禁止 CC 组件引用 Legacy 组件）。建议**提到独立叶子**
> `tui/utils/ccSelectGates.js`，两处共用 —— 但这会改到 Legacy 的 require 行，
> 需要在评审时单独确认；**保守做法是 CC 侧抄一份**，接受重复。

### 3.2 状态 + ref 镜像（照抄 `App.js:1086–1100` + `5589–5602`）

```js
const [selectRegion, setSelectRegion] = React.useState(null);
const _selectRegionRef   = React.useRef(null);
const _selectingRef      = React.useRef(false);
const _selectTextRef     = React.useRef('');
const _mainContentLinesRef = React.useRef([]);
```

> ⚠️ **ref 镜像是强制的，不是优化**：`onSelectEvent` 是渲染期早建的 `useCallback`
> 闭包，直接读 state 拿到的是**上一帧**的值。这段在 Legacy 已经踩过，
> CC 侧必须同样在渲染体里同步。

### 3.3 坐标换算（照抄 `App.js:1431–1456`）

```js
const viewH = Math.max(1, Number(_viewportHeightRef.current) || 1);
const total = Math.max(0, Number(_viewportTotalLinesRef.current) || 0);
const maxScroll = Math.max(0, total - viewH);
const n = Number(_mainViewportScrollRef.current);
const offset = !Number.isFinite(n) || n < 0 ? maxScroll : Math.max(0, Math.min(n, maxScroll));
const line = Math.max(0, Math.min(Math.trunc(Number(ev.row)) + offset, Math.max(0, total - 1)));
const col  = Math.max(0, Math.trunc(Number(ev.col)));
```

> ⚠️ **方向是 `+ offset`，不是 `− offset`**。且 `null`/负数偏移要按「贴底」解释成
> `maxScroll`（`AGENTS.md` §0.9.1 的贴底哨兵）。

### 3.4 事件四态（照抄 `App.js:1457–1518`）

| `kind` | 动作 |
|---|---|
| `down` | `beginSelection(_selectRegionRef.current, line, col)` → `setSelectRegion` |
| `move` | `_selectingRef.current` 守卫 → `extendSelection` |
| `up` | `endSelection` → `normalizeSelection`；无区间则清 `_selectTextRef`；否则 `extractText(_mainContentLinesRef.current, sel)` → `writeClipboard(text)`（`_selectClipEnabled` 守卫） |
| `cancel` | `clearSelection()` |

### 3.5 鼠标序列守卫（**CC 侧新增，Legacy 也缺**）

在 CC 的全局 `useInput`（`CcApp.js:295`）**开头**加：

```js
if (_mouse && mouseDispatcherRef.current && _mouse.isMouseSequence(input)) {
  mouseDispatcherRef.current.onInput(input, { rows, anchorBottom: false });
  return;                       // 关键：吞掉，别让 SGR 字节进文本处理
}
```

> 这是本提案里**唯一一处「Legacy 也没有」的补强**：Legacy 有守卫（`App.js:4390`），
> CC 从来没收过事件所以不需要；一旦开了 1002，**没有守卫就会把鼠标字节当键盘输入**。
> 属于本次改动的**新引入风险**，必须一起补。

### 3.6 重新接管追踪必须同档（`AGENTS.md` §0.9.4）

若 CC 侧也有 `enterNativePassthrough` 的超时重开逻辑，重开时
`opts.select` 必须与初始一致，否则退回 1000 → 「滚一下滚轮拖选就失灵」。

### 3.7 剪贴板写入（直接用，不改）

```js
const clip = require('../utils/ccClipboard');
const res = clip.writeClipboard(text);   // {ok, channels, bytes, reasons}
```

反馈文案走已有的 `addToast` / `formatCopyFeedback`（`KHY_CC_COPY_TOAST` 门控）。

---

## 4. 键盘路径（Ctrl+C / `v` / `y` / Ctrl+Y）—— 需先定语义

### 4.1 实测现状

| 键 | Legacy | CC 现状 |
|---|---|---|
| `Ctrl+Y` | 无 | ✅ 已有 → `handleCopyLast()`（`CcApp.js:360–363`），复制**最近助手回复** |
| `Ctrl+C` | 无特殊 | ✅ 已占用 → **双击退出**（`CcApp.js:299–309`） |
| `v` | 无 | 无 |
| `y` | 无 | 无 |

且 Legacy 的 `_selectTextRef` **只写不读**（实测：写在 `App.js:1492/1500`，
`5589–5602` 同步进 ref，**全仓无读取点**）。

⇒ 结论：**`v` / `y` / `Ctrl+C 复制当前选区` 是净新增，不是移植。** Legacy 没有可抄的语义。

### 4.2 提案（需用户拍板）

| 键 | 建议语义 | 理由 |
|---|---|---|
| `Ctrl+Y` | **保持现状**（复制最近回复） | 已有行为，动了就是破坏 |
| `Ctrl+C` | **不加复制**；维持双击退出 | `AGENTS.md:332` 「禁止快捷键冲突无提示」；双击退出是已验收项 |
| `y` | 有选区 → 复制当前选区 | vim 风格，`AGENTS.md:143`「复制：OSC 52 + 系统命令 fallback」 |
| `v` | 有选区 → 复制当前选区（同 `y` 别名） | 冗余绑定降认知负担 |

**反模式，这条路别走**：不要把 `Ctrl+C` 改成「有选区则复制、无选区则双击退出」——
同一按键两种含义且**无视觉提示**，用户在「想退出」和「想复制」之间会互相误触发；
真要给 `Ctrl+C` 加复制，必须先有选中态视觉 + `AGENTS.md:332` 要求的冲突提示。

### 4.3 冲突域的额外发现（顺带）

`CcApp.js:354` 把 `Ctrl+V` 绑成 vim 开关，而 vim 的 `v` 是 visual 模式 ——
**语义撞车但按键不撞**（`Ctrl+V` vs `v`），暂不用动，仅记录。

---

## 5. 题目 3：`AGENTS.md:20` 规则对本改动的适用范围

用户引用的「禁止修改 Legacy 模式代码路径」**不在根 `AGENTS.md`**，实测在
**`services/backend/src/cli/tui/AGENTS.md:20`**（根目录那份没有这条）：

```
### 0.1 零破坏原则
❌ 禁止修改 Legacy 模式（KHY_CC_TUI 未设置）下的任何代码路径
❌ 禁止删除或重命名现有组件/函数（除非显式标记为废弃）
❌ 禁止改变现有 public API 的签名或行为
❌ 禁止引入新的全局副作用
✅ 所有 CC 模式代码必须通过 KHY_CC_TUI=1 门控
✅ 门控关闭时，行为必须与修改前逐字节相同
✅ 新增文件优先于修改现有文件
```

同目录还有更紧的两条：`AGENTS.md:626` `❌ 禁止修改 Legacy 组件的内部实现`、
`AGENTS.md:627` `❌ 禁止在 CC 组件中直接引用 Legacy 组件`。

### 适用范围判定

| 本改动的动作 | 是否触碰 | 判定 |
|---|---|---|
| **新增** `ccMessageProjection.js` | 否 | ✅ 明确鼓励（`AGENTS.md:27`） |
| **新增** CC 侧鼠标守卫 / 选区状态 | 否（全在 `CcApp.js`，只在 `KHY_CC_TUI=1` 下被 require） | ✅ 合规 |
| **修改** `CcApp.js` 消息区渲染 | 否（该文件只在 CC 分支加载，`app.js:96–103`） | ✅ 合规 |
| **复用** `Viewport.js` / `selection.js` / `ccClipboard.js` | 只读引用，不改内部 | ✅ 合规（这三者是**共用叶子**，非 Legacy 组件） |
| **抽取** `_selectEnabled` 等到共用叶子 → 需改 `App.js` 的 require 行 | 是 | ⚠️ **需评审**；保守做法：CC 侧抄一份 |
| **修改** `app.js` 进程级鼠标层 | 否（已存在，且不新增行为） | ✅ 无需改 |

**结论**：本提案主体**落在规则允许范围内**。唯一需要单独确认的是 §3.1 的
「抽取三个门控助手到共用叶子」——两个选项：
① CC 侧抄一份（重复 ~40 行，零 Legacy 触碰，**推荐**）；
② 抽共用叶子（去重，但要动 Legacy require 行，需走评审）。

> 判定依据不是「看起来像」，而是 `app.js:96–103` 的三元分支：
> **Legacy 路径 = 未设 `KHY_CC_TUI` 时 require 的那个文件树**。新增文件 +
> 只改 CC 分支内文件，天然不触碰 Legacy。

---

## 6. 题目 4：端到端验证方法与期望结果

### 6.1 改动前基线（已实测）

```
services/backend/tests/cli/tui/selection.test.js                       27/27 pass
services/backend/tests/cli/tui/mouseSelectEvent.test.js                15/15 pass
services/backend/tests/cli/tui/mouseNativeSelection.test.js             9/9  pass
services/backend/tests/cli/tui/ink-components/viewportSelection.test.js 16/16 pass
services/backend/tests/cli/tui/ccClipboard.test.js                     20/20 pass
                                                             合计 87/87
```

### 6.2 改动后必须新增的测试

| 文件 | 覆盖 | 状态（2026-09-18） |
|---|---|---|
| `tests/cli/tui/ccMessageProjection.test.js` | 纯叶子：折行、`●` 前缀、`marginTop` 空行、`row==index` 不变量、空输入不抛 | ✅ 36/36 |
| `tests/cli/tui/ccMessageProjection.oracle.test.js` | **零容忍逐字节对拍**：手写投影 vs `renderToString`（列宽 20–120、ASCII/CJK、`●` 永不消失） | ✅ 13/13 |
| `tests/cli/tui/ccSelectionWiring.test.js` | **接线后**的布局（`Viewport` 渲染消息段）与投影仍逐行一致；`row==index` 恒等；拖选 → 原文 | ✅ 8/8 |
| `tests/cli/tui/ccMouseGuard.test.js` | 原始 SGR 字节 → 剪贴板文本全链；普通输入**不**被误判成鼠标；Shift/滚轮不产选区 | ✅ 8/8 |
| 扩 `viewportSelection.test.js` | `lines` 来自投影时反色范围正确 | 既有文件已覆盖 `sliceLineForSelection` 恒等（`head+mid+tail===line`），未另扩 |

### 6.2.1 实施期的根因发现（比本提案更严重，已一并修）

接线时发现：**`createMouseDispatcher` 根本没实现 `onSelectEvent`** —— `App.js`
把它传进去了，但 `mouseButtons.js` 既没在解构里收，也没在 `onInput` 里调。
后果是「自绘选择」这条链在 **Legacy 与 CC 两种模式下一次都没触发过**，
`mouseSelectEvent.test.js` 15 条里 5 条是红的。

> 这正是「文档写了、组件接了、测试也有，但功能一次都没跑起来」的那类缝：
> 事件层的**契约**（测试）与**实现**（dispatcher）各自自洽，中间那根线没接。
> 已实现 `fireSelect` + `down/move/up/cancel` 四态 + `reset()` 发 `cancel`，
> 判据顺序按 §2.3 的①②③固定，15/15 绿。

### 6.3 命令清单与期望

```bash
# ① 选择层回归（期望：四个文件全绿，无新增失败）
node tests/cli/tui/selection.test.js
node tests/cli/tui/mouseSelectEvent.test.js
node tests/cli/tui/mouseNativeSelection.test.js
node tests/cli/tui/ink-components/viewportSelection.test.js
node tests/cli/tui/ccClipboard.test.js

# ② TUI 全量
npm run --workspace services/backend test:tui          # 期望全绿

# ③ 真渲染器探针（AGENTS.md §0.9.6 两条硬前置必须满足）
#    FORCE_COLOR 置于文件最顶部；走 inkRuntime.loadInk() 而非 import('ink')
#    模板：docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 应用内自绘选择-真渲染器验证-2026-09-17.js
```

### 6.4 双路径人工验收

**Legacy 路径**（`KHY_CC_TUI` 未设）：

| 步骤 | 期望 |
|---|---|
| `KHY_SELECT=0 khy` 拖选 | 与改动前**逐字节相同**（走终端原生拖选） |
| `KHY_SELECT=1 khy` 拖选正文 | 反色跟手；松手 `Get-Clipboard` 读回一致 |
| `KHY_SELECT_CLIP=0 khy` 拖选 | 能选中能看，**不**自动写剪贴板 |

**CC 路径**（`KHY_CC_TUI=1`，改动前**全部不可用**）：

| 步骤 | 改动前 | 改动后期望 |
|---|---|---|
| 拖选消息区正文 | ❌ 无反应 | ✅ 反色跟随鼠标 |
| 松手 | ❌ 无写入 | ✅ 剪贴板有内容，`Get-Clipboard` 读回 == 屏幕选中文本 |
| 跨消息拖选 | ❌ | ✅ 用 `\n` 连接（`extractText` 语义） |
| 拖选含空行 | ❌ | ✅ 空行产出空串**不被丢弃** |
| `y`（有选区） | ❌ 无此键 | ✅ 复制当前选区 + Toast 提示字符数 |
| `Ctrl+Y` | ✅ 复制最近回复 | ✅ **行为不变** |
| `Ctrl+C` 单击 / 双击 | ✅ 提示 / 退出 | ✅ **行为不变** |
| 拖动时滚动 | — | ✅ 无异常，坐标不漂 |
| 拖动中 `resize` | — | ✅ 不崩，选区可继续 |
| `KHY_SELECT=0` 启动 CC | — | ✅ 鼠标层关闭，无回归 |

**通用不变量**（两条路径都要）：反色覆盖的列区间与 `Get-Clipboard` 文本**逐字符对应**；
`KHY_SELECT=0` 时行为与改动前逐字节一致。

### 6.5 仓库级守卫

```bash
npm run check:agent-rules     # RUNTIME-001~004（零硬编码 / 状态透明 / 活动式超时 / 无滚动区）
npm run check:layout          # 层级板块（新增文件位置）
npm run check:build-root      # 构建产物落 `entries/`
npm run verify                # 18 份快照（含 docs-html-parity）
```

> 注意 `AGENTS.md` §0.9.2：新增固定高度兄弟节点**必须**登记进 chrome 账本
> （`chromeBudget.liveBudget`）。若方案 A 让消息区高度计算方式变化，
> 需核对 `KHY_TUI_DIAG_H=1` 打印的账本合计仍 **< rows**。

---

## 7. 未决问题（需用户拍板）

1. **方案 A vs B** —— 推荐 A（投影成 `lines[]`）。若 CC 消息区后续要上富组件渲染，
   B 的长期价值才显现；当前实测 `CcAssistantMessage` 无富分段，A 损失≈0。
2. **§3.1 门控助手：抄一份（推荐）还是抽共用叶子？** —— 抄一份零 Legacy 触碰。
3. **键盘语义** —— `y`/`v` 是否采纳？`Ctrl+C` 是否维持双击退出不加复制？
4. **HTML 孪生** —— 本目录规范要求 `.md` 有 `.html` 孪生（LAY-5 强制），
   本提案落盘后需一并生成，否则 `docs:verify` 会红。

---

## 8. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-09-18 | 初始提案；完成盲区实证与双路径验证设计 |
| 2026-09-18 | **编号 120 → 124**：初版落盘时误用 `DESIGN-ARCH-120`，与既有的《khy-移动端合并方案》撞号（该号已被索引 `00_INDEX_设计-分类索引.md:110` 占用且在产）。改用下一个空闲号 **124**（全仓 `find` + `grep` 双重确认无占用）。本文件与 `.html` 孪生件同步改名，标题同步，并新增本行变更记录。 |
| 2026-09-18 | **实施落地（方案 C3）**：① 修 `mouseButtons.createMouseDispatcher` —— `onSelectEvent` 从未被实现，导致自绘选择在 Legacy/CC **两种模式下都从未触发**（`mouseSelectEvent.test.js` 5 红 → 15/15 绿）；② `CcApp.js` 完成 §3.1–§3.6 接线（门控走新的 `utils/selectGates.js` 单一真源、四态事件、鼠标序列守卫、消息段改走 `Viewport lines`、松手 `extractByAnchors` + `writeClipboard`）；③ 新增 `ccMessageProjection.js` 纯叶子 + 三个测试文件；④ 修正 §2.3 的三处「推理 vs 实测」错误（`padToRows` / `●` 挤压 / 松手点），Legacy 侧的「松手点」缺陷同步修。`tests/cli/tui/*.test.js` **861/861 全绿**。 |

---

## 附录 A：编号冲突的收口说明

### A.1 冲突事实

| 项 | 内容 |
| --- | --- |
| 冲突号 | `DESIGN-ARCH-120` |
| 既有占用者 | `[DESIGN-ARCH-120] khy-移动端合并方案.md`（+ `.html`），已登记于 `00_INDEX_设计-分类索引.md:110`，状态**在产** |
| 误用者 | 本文件（提案落盘时未先查号） |
| 处置 | 本文件改用 **124**；既有 120 保持不动（它是先到的、且已进索引） |

### A.2 为什么选 124 而不是别的

```
ARCH-110 ~ 118  各 2 个文件（.md + .html）→ 已占用
ARCH-119        4 个文件（正文 + 验收标准，各带 .html）→ 已占用
ARCH-120        4 个文件（移动端合并 + 本文件撞号）→ 冲突源
ARCH-121 ~ 123  各 2 个文件 → 已占用
ARCH-124        0 个文件 → ✅ 下一个空闲号
```

选号依据是**连续性优先**：不跳跃、不回收旧号，取紧随其后的第一个空闲号。
（回收已删除文档的旧号会破坏「编号→文档」的历史可追溯性，不做。）

### A.3 复核命令（可复现）

```bash
cd D:/Portable/khy-os
# ① 编号占用扫描
for i in $(seq 110 130); do
  n=$(ls docs/03_DESIGN_设计/ | grep -c "^\[DESIGN-ARCH-$i\]")
  printf "ARCH-%s: %s\n" "$i" "$n"
done

# ② 全仓确认 124 无占用（文件名 + 引用双向）
find . -path ./node_modules -prune -o -name "*ARCH-124*" -print
grep -rn "DESIGN-ARCH-124" --include="*.md" --include="*.js" --include="*.json" . \
  | grep -v node_modules

# ③ 索引唯一性（124 应恰好一条，120 应恰好两条且都不是本文件）
grep -n "DESIGN-ARCH-12[04]" docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md
```

### A.4 防复发

编号冲突的根因是**落盘前没查号**。后续新建设计文档的固定前置动作：

```
✅ 先跑 §A.3 的 ①（占用扫描）拿到第一个空闲号
✅ 再跑 §A.3 的 ②（全仓双向确认）确认该号真的没人用
✅ 最后才写文件 —— 文件名、H1 标题、索引三处编号必须一致
❌ 不要凭"看起来没人用"猜号
```

⚠ 本次的教训值得记下：**索引条目在冲突曝光时就已经写好了**（`00_INDEX:111` 那条
自己标注了「同号 120 撞号」）—— 也就是说，**索引比文件名更早发现冲突，但没有人在
落盘那一刻去比对索引**。索引是事后补救的载体，不能当作事前校验的替代。

