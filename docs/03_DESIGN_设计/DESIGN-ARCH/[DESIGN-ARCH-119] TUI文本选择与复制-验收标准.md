# [DESIGN-ARCH-119] TUI 文本选择与复制 —— 验收标准

> **隶属**：本文属 **TUI 设计族**（20 编号 / 21 文件），总纲与 scope 裁决见 `[DESIGN-ARCH-122] TUI 设计族总纲`；规则冲突一律以 `[DESIGN-ARCH-102] Khy TUI 统一规则手册` 为准。

> **定位**：本文是 `[DESIGN-ARCH-119] TUI原生文本选择与复制可用性修复` **第二层
> （应用内自绘选择）** 的**可执行验收标准**。
>
> **服务对象**：后续由**小模型直接据此实现**。因此本文的每一节都是自足可读的：
> 不依赖前文、不依赖对话历史、不依赖隐含知识。每个测试用例给出
> **输入 → 期望输出 → 通过条件** 三段式，且都映射到一个可复制的断言。
>
> **与设计真源的关系**：设计真源解释**为什么**这么做（含三个参考项目实证与根因分析）；
> 本文只规定**做成什么样算通过**。两者冲突时以设计真源为准，并应回改本文。
>
> **不新增门禁规则**——本验收标准是既有 `[DESIGN-ARCH-102]` §6.2 与 P6 承诺的兑现，
> 不携带 `<!-- RULES-REGISTRY -->` 标记行，不改 `RULES-REGISTRY.json`。
>
> ---
>
> ## 怎么用这份文档（给实现者）
>
> 1. **先读 §1 契约**——它规定了所有函数的签名与返回值形状。照抄即可。
> 2. **再读 §2 到 §7**——每个编号（如 `S-01`）是一个测试用例，三段式齐全。
> 3. **写代码，然后跑 §8 的验收命令**。命令全绿 = 本层通过。
> 4. **不要跳过 §9 的反例矩阵**——它专门防止「看着像修好了」的实现。
>
> **编号约定**：`S-xx` = selection 模型层；`V-xx` = Viewport 渲染层；
> `A-xx` = App 交互层；`X-xx` = 跨层/集成；`N-xx` = 反例（必须"按期望失败"）。
>
> **测试运行器**：`node --test`（不是 jest；本目录所有 `*.test.js` 都用这个）。

---

## 1. 契约（Contract）

> 实现者照此签名实现，不得改名、不得改返回值形状。**所有函数零 IO、绝不抛。**

### 1.1 `selection.js` 导出（新增文件）

路径：`services/backend/src/cli/tui/selection.js`

| 函数 | 签名 | 返回 | 说明 |
|---|---|---|---|
| `createSelection` | `()` | `Selection` | 新建空选区 |
| `beginSelection` | `(sel, line, col)` | `Selection` | 按下：anchor = head = (line, col)，`dragging = true` |
| `extendSelection` | `(sel, line, col)` | `Selection` | 拖动：只改 head，`dragging = true` |
| `endSelection` | `(sel)` | `Selection` | 松手：`dragging = false`，anchor/head 不变 |
| `clearSelection` | `()` | `Selection` | 清空（等价 `createSelection()`）|
| `hasSelection` | `(sel)` | `boolean` | 是否有非空选区（anchor 与 head 不同）|
| `normalizeSelection` | `(sel)` | `Range \| null` | 有序化；无可选内容 → `null` |
| `expandToWord` | `(lines, line, col)` | `Selection` | 双击：选中该处的「词」|
| `expandToLine` | `(lines, line)` | `Selection` | 三击：选中整行 |
| `extractText` | `(lines, sel)` | `string` | 按选区抽文本；空选区 → `''` |
| `selectionRangeFor` | `(lines, sel, line)` | `{from, to} \| null` | 供渲染层：该行要反色的 `[from, to)` 列区间。**端点必为具体列号**（非 `Infinity`），故需 `lines` 解析「到行尾」|
| `wordBoundaryAt` | `(lineText, col)` | `{from, to}` | 词边界算法（`expandToWord` 的内部真源，单独导出便于测试）|

**类型定义**（纯数据，无 class）：

```js
// Selection —— 锚点(anchor)固定，活动端(head)跟随
{ anchor: {line: number, col: number} | null,
  head:   {line: number, col: number} | null,
  dragging: boolean }

// Range —— 有序化后的矩形范围（行列均含端点语义见下）
{ startLine: number, startCol: number,
  endLine:   number, endCol:   number }
```

**`Range` 的端点语义（必须精确，否则 `extractText` 会差一列）**：

- 选区是 **`[start, end)` 半开区间**（head 所在列**不含**，与鼠标拖动的直觉一致：
  拖到第 5 列反色到第 4 列）；
- 单行时：取 `line.slice(startCol, endCol)`；
- 跨行时：首行 `slice(startCol)`，末行 `slice(0, endCol)`，中间行整行，行间以 `'\n'` 连接；
- 反向拖选（head 在 anchor 之前）由 `normalizeSelection` 负责交换，**调用方不必判断方向**。

### 1.2 `Viewport` 新增可选 prop

路径：`services/backend/src/cli/tui/ink-components/Viewport.js`

| prop | 类型 | 默认 | 行为 |
|---|---|---|---|
| `selection` | `Selection \| null` | `null` | 传了 → 可见行按 `selectionRangeFor` 分段反色；不传或 `null` → **逐字节不变** |
| `lines` | `string[]` | — | 既有 prop（不变）|

**必须保证的等价性**：不传 `selection` 时，渲染输出与本次改动前**逐字节相同**。
这是 `N-01` 的判据。

### 1.3 App 层新增门控

路径：`services/backend/src/services/flagRegistry.js`（登记）+ `ink-components/App.js`（消费）

| 门控 | 类型 | 默认 | 关闭时的行为 |
|---|---|---|---|
| `KHY_SELECT` | 布尔 | **开** | 选择层整体不接线；鼠标行为回到第一层完成态 |
| `KHY_SELECT_COPY_ON_RELEASE` | 布尔 | **开** | 松手不自动复制，只保留反色选中 |
| `KHY_SELECT_WORD_BOUNDARY` | 布尔 | **开** | `expandToWord` 改用朴素 `\b` 口径（见 `S-20`）|
| `KHY_SELECT_MAX_BYTES` | 数字 | `100000` | 复制载荷上限；超出则截断并提示 |

**布尔解析口径**（与 `ccClipboard._isOn` 一致，必须复用同款）：
`'0' / 'false' / 'off' / 'no'`（大小写不敏感）→ 关；空字符串 → 用默认；其余 → 开。

> **`KHY_SELECT` 只允许读一次**：在 `App.js` 顶层求值（与 `ALT_SCREEN_ENABLED` 同处，
> `app.js:253-255` 是同一模式的先例），把结果**透传**给 `enableBytes({ select })`
> 和 `onSelectEvent` 的启用判据。**不得**在两处各读一次 env —— 否则会出现
> 「通道开了但选择层没接」（拖动被吞、无反色）或「选择层接了但通道没开」
> （反色永远画不出来，因为收不到 motion）这两类不一致态。`A-13` 覆盖此条。

### 1.4 tracking 档位（`mouseButtons.enableBytes` 契约变更）

路径：`services/backend/src/cli/tui/mouseButtons.js`

| 调用 | 输出（逐字节） | 说明 |
|---|---|---|
| `enableBytes()` | `'\x1b[?1000h\x1b[?1006h'` | **默认不得变**（回归护栏，`A-00` 第一条）|
| `enableBytes({ hover: true })` | `'\x1b[?1000h\x1b[?1006h\x1b[?1003h'` | **不得变** |
| `enableBytes({ select: true })` | `'\x1b[?1002h\x1b[?1006h'` | **新增** —— 把 `1000` 换成 `1002`，不是叠加 |
| `enableBytes({ select: true, hover: true })` | `'\x1b[?1002h\x1b[?1006h\x1b[?1003h'` | 两者同开；`1003` 语义含 `1002`，可接受 |

退出侧 `disableBytes()` **不需要改**：它已经无条件写了
`'\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'`。

> **为什么是「换」不是「叠」**：`1002` 已含 `1000` 的按下/松开语义，叠写只是让模式表
> 更难读，且会让「回滚到 `1000`」变成「移除一个后缀」而非「换一个字符」，
> 增加回滚出错的概率。

### 1.5 按键优先级（`Ctrl+C`）

| 条件 | `Ctrl+C` 行为 |
|---|---|
| `hasSelection(sel)` 为真 | **复制选区**，且**不**中断当前请求 |
| 无选区 | **中断当前请求**（与本次改动前完全一致）|

这是既有语义的**扩展**而非替换：无选区时行为一字不改。

---

## 2. 核心功能 —— selection 模型层（`S-xx`）

> 测试文件：`services/backend/tests/cli/tui/selection.test.js`（新增）

### 通用夹具

```js
const LINES = [
  'hello world',                 // 0
  'second line here',            // 1
  'D:/Portable/khy-os/a.js',     // 2  ← 路径行，双击必须整体选中
  '',                            // 3  ← 空行
  '末行中文内容',                 // 4
];
```

### S-01 新建空选区

| 项 | 内容 |
|---|---|
| **输入** | `createSelection()` |
| **期望输出** | `{ anchor: null, head: null, dragging: false }` |
| **通过条件** | `deepStrictEqual` 完全相等；且 `hasSelection(...)` 为 `false` |

### S-02 按下建立锚点

| 项 | 内容 |
|---|---|
| **输入** | `beginSelection(createSelection(), 1, 3)` |
| **期望输出** | `anchor = {line:1, col:3}`、`head = {line:1, col:3}`、`dragging = true` |
| **通过条件** | 三字段逐一相等；`hasSelection` 仍为 `false`（锚点与活动端相同 = 尚未选中内容）|

### S-03 拖动只改活动端

| 项 | 内容 |
|---|---|
| **输入** | `beginSelection(createSelection(), 0, 0)` → `extendSelection(sel, 0, 5)` |
| **期望输出** | `anchor` 仍是 `{0,0}`；`head` 是 `{0,5}`；`dragging = true` |
| **通过条件** | `anchor` 必须**未被改动**（这是「锚点固定」的核心断言）|

### S-04 松手冻结选区

| 项 | 内容 |
|---|---|
| **输入** | `beginSelection(s,0,0)` → `extendSelection(s,0,5)` → `endSelection(s)` |
| **期望输出** | `dragging = false`；`anchor`/`head` 与松手前相同 |
| **通过条件** | `hasSelection` 为 `true`（锚点 0,0 ≠ 活动端 0,5）|

### S-05 `hasSelection` 的三态

| 输入 | 期望 |
|---|---|
| `createSelection()` | `false`（无锚点）|
| `beginSelection(createSelection(), 0, 0)` | `false`（锚点 = 活动端，零宽）|
| `beginSelection(createSelection(), 0, 0)` 后 `extendSelection(·, 0, 1)` | `true` |
| 跨行零宽：`begin(0,0)` → `extend(1,0)` | `true`（跨行即非空，即便列相同）|

**通过条件**：四条全部成立。第 4 条最易漏——它保证「拖到下一行行首」不被误判为空选区。

### S-06 正向单行抽取

| 项 | 内容 |
|---|---|
| **输入** | `lines = LINES`，选区 `begin(0,0)` → `extend(0,5)` 的 `endSelection` 结果 |
| **期望输出** | `'hello'` |
| **通过条件** | 严格相等。**注意半开区间**：`extend(0,5)` 得 5 个字符，不是 6 个 |

### S-07 反向单行抽取（`normalizeSelection` 必须交换）

| 项 | 内容 |
|---|---|
| **输入** | `begin(0,5)` → `extend(0,0)` 的 `endSelection` 结果 |
| **期望输出** | `extractText` 返回 `'hello'`；`normalizeSelection` 返回 `{0,0, 0,5}` |
| **通过条件** | 与 `S-06` 结果**完全一致**。方向不影响结果——这是调用方不必判方向的保证 |

### S-08 跨行抽取

| 项 | 内容 |
|---|---|
| **输入** | `begin(0,6)` → `extend(2,5)` |
| **期望输出** | `'world\nsecond line here\nD:/Po'` |
| **通过条件** | 严格相等。首行 `slice(6)`、末行 `slice(0,5)`、中间行整行，`'\n'` 连接 |

### S-09 跨三行且含空行

| 项 | 内容 |
|---|---|
| **输入** | `begin(1,0)` → `extend(4,2)` |
| **期望输出** | `'second line here\nD:/Portable/khy-os/a.js\n\n末行'` |
| **通过条件** | 严格相等。**空行必须产出一个 `'\n'`**（即连续两个 `\n`），不得被跳过 |

> **为什么这条重要**：若实现用 `filter(Boolean)` 去掉空行，`S-09` 必红。
> 复制多段文本时空行的丢失是用户可感知的缺陷。

### S-10 整行选区（三击语义）

| 项 | 内容 |
|---|---|
| **输入** | `expandToLine(LINES, 1)` |
| **期望输出** | `extractText` 返回 `'second line here'`（**不含**换行符）|
| **通过条件** | 严格相等。三击选的是**该视觉行**，跨行由用户继续拖动扩展 |

### S-11 空选区抽取 → 空串

| 输入 | 期望 |
|---|---|
| `extractText(LINES, createSelection())` | `''` |
| `begin` 后立即 `end`（零宽，同行）| `''` |

**通过条件**：都返回 `''`（字符串，不是 `null`/`undefined`）。

### S-12 `selectionRangeFor` 的分行区间

| 项 | 内容 |
|---|---|
| **输入** | `selectionRangeFor(LINES, sel, line)`，选区 `begin(1,3)` → `extend(3,2)` |
| **期望输出** | 对 line 1 → `{from:3, to:<line1 长度>}`；line 2 → `{from:0, to:<line2 长度>}`；line 3 → `{from:0, to:2}` |
| **通过条件** | 三条逐一相等；对 line 0 与 line 4 → 返回 `null`（不在选区内）。**端点必须是具体列号**——返回 `Infinity` 视为不通过（会把「查行长度」的负担漏给渲染层）|

### S-13 `selectionRangeFor` 的边界：单行与零宽

| 输入 | 期望 |
|---|---|
| 单行选区 `(0,2)→(0,5)`，问 line 0 | `{from:2, to:5}` |
| 同上，问 line 1 | `null` |
| 零宽选区 `(0,3)→(0,3)`，问 line 0 | `null`（无内容可反色）|
| 跨行选区，末行 `endCol = 0` | `null`（末行取 `slice(0,0)` = 空，无内容可反色）|

---

## 3. 核心功能 —— 词边界（双击）（`S-2x`）

> **设计依据**：Claude Code 的文档明说双击「matching iTerm2's word boundaries so a
> file path selects as one unit」。本仓最高频的复制场景正是**一条路径**，因此词字符集
> 必须包含路径分隔符与扩展名点。

### S-20 词字符集（`wordBoundaryAt` 的真源口径）

**词字符**（`W`）= `[A-Za-z0-9_./\\:~@+-]`

| 项 | 内容 |
|---|---|
| **输入** | 逐字符测 `wordBoundaryAt` 的对调结果 |
| **期望输出** | 对 `D:/Portable/khy-os/a.js` 的**任意一列**，返回 `{from:0, to:22}`（整条）|
| **通过条件** | 遍历该行每个列索引，`expandToWord` 的结果都覆盖整条路径 |

### S-21 双击路径必须整体选中（关键场景）

| 项 | 内容 |
|---|---|
| **输入** | `expandToWord(LINES, 2, 9)`（落在 `khy-os` 中间）|
| **期望输出** | `extractText` 返回 `'D:/Portable/khy-os/a.js'` |
| **通过条件** | 严格相等。**朴素 `\b` 会在此处断开**（`/` 与 `.` 都是非词字符），必红 |

### S-22 双击落在词中间与词首结果一致

| 输入 | 期望 |
|---|---|
| `expandToWord(LINES, 0, 2)`（`hello` 中间）| 抽取得 `'hello'` |
| `expandToWord(LINES, 0, 0)`（`hello` 词首）| 抽取得 `'hello'` |
| `expandToWord(LINES, 0, 4)`（`hello` 词尾最后一字符）| 抽取得 `'hello'` |

**通过条件**：三条一致。落点在同词内任意位置结果相同。

### S-23 双击落在空白处 → 选空白段的边界（不得抛）

| 项 | 内容 |
|---|---|
| **输入** | `expandToWord(['a  b'], 0, 1)`（两个空格之一）|
| **期望输出** | 返回一个合法 `Selection`，不抛异常；`extractText` 返回空格段或空串 |
| **通过条件** | **不抛**是硬条件；具体取空串还是空格段由实现决定，但必须确定性（同输入同输出）|

> **为什么放宽**：不同终端/编辑器对「双击空白」的行为不一致（有的选空格、有的不响应）。
> 本层只要求**不抛且确定**，不锁死具体语义。

### S-24 双击 CJK 内容

| 项 | 内容 |
|---|---|
| **输入** | `expandToWord(LINES, 4, 2)`（`末行中文内容` 中间）|
| **期望输出** | 返回合法 `Selection`，`extractText` 为非空且是原行的子串 |
| **通过条件** | 不抛；`LINES[4].includes(结果)` 为真 |

> **注意**：CJK 无空格分词，是否把整行视作一个「词」由实现决定（按上表的 `W` 集，
> 中文不是词字符，故结果为中文段）。只要求确定性与不抛。

### S-25 双击超出边界

| 输入 | 期望 |
|---|---|
| `expandToWord(LINES, 0, 999)` | 不抛；按行尾处理 |
| `expandToWord(LINES, 999, 0)` | 不抛；返回空选区或 `null`（见 S-30）|
| `expandToWord([], 0, 0)` | 不抛；返回空选区 |

---

## 4. 边界情况 —— 全部输入必须 fail-soft（`S-3x`）

> **总纪律**：`selection.js` 是纯叶子，与 `scrollActions.js` 同范式——
> **绝不抛**。本节的每一条都只断言「不抛 + 返回值形状合法」。

### S-30 越界坐标必须 clamp，不得抛

| 项 | 内容 |
|---|---|
| **输入** | `beginSelection(createSelection(), 999, 999)`；`extendSelection(sel, -5, -5)` |
| **期望输出** | 返回合法 `Selection`；坐标被 clamp 到合法区间 |
| **通过条件** | 不抛；`extractText(LINES, 结果)` 不抛 |

### S-31 `lines` 为异常值

| 输入 | 期望 |
|---|---|
| `extractText(null, someSel)` | `''`，不抛 |
| `extractText(undefined, someSel)` | `''`，不抛 |
| `extractText([], someSel)` | `''`，不抛 |
| `extractText('not-an-array', someSel)` | `''`，不抛 |
| `extractText(LINES, null)` | `''`，不抛 |
| `extractText(LINES, undefined)` | `''`，不抛 |

### S-32 `sel` 形状损坏

| 输入 | 期望 |
|---|---|
| `hasSelection(null)` / `hasSelection(undefined)` / `hasSelection({})` | `false`，不抛 |
| `hasSelection({anchor: null, head: {line:0,col:1}})` | `false`，不抛（半空视为无选区）|
| `extractText(LINES, {anchor: 'x', head: 123})` | `''`，不抛 |
| `normalizeSelection(null)` | `null`，不抛 |

### S-33 行内含 `null` / 非字符串（投影可能有洞）

| 项 | 内容 |
|---|---|
| **输入** | `lines = ['a', null, 'c']`，选区 `begin(0,0)` → `extend(2,1)` |
| **期望输出** | 不抛；`null` 行按空串处理 |
| **通过条件** | 返回 `'a\n\nc'`（`null` → `''`，仍产出分隔 `\n`）|

> **为什么这条真实存在**：`_mainContentLines` 由多个来源拼装（committed / streaming /
> activity），历史上出现过洞。渲染层已有 `line || ' '` 兜底，文本层必须同样健壮。

### S-34 数字/字符串坐标（宽松解析）

| 输入 | 期望 |
|---|---|
| `beginSelection(createSelection(), '1', '3')` | 按数字 1/3 处理（与 `scrollActions._nat` 同宽容度）|
| `beginSelection(createSelection(), NaN, 0)` | 不抛，clamp 到 0 |

### S-35 极端规模不爆栈

| 项 | 内容 |
|---|---|
| **输入** | `lines` = 5000 行（等于 `App.js` 的 `CAP`），选区覆盖首行到末行 |
| **期望输出** | `extractText` 在合理时间内返回，长度 > 0 |
| **通过条件** | 不抛；不递归（本层全部实现为循环，不得用递归展开行）|

### S-36 冻结性：纯函数不得改入参

| 项 | 内容 |
|---|---|
| **输入** | `const sel = beginSelection(createSelection(), 0, 0)`，随后 `extendSelection(sel, 2, 3)` |
| **期望输出** | `sel` 本身**未被改动**（仍是 `{0,0}` / `{0,0}`）；返回的是**新对象** |
| **通过条件** | 对 `sel` 做 `deepStrictEqual` 与快照比对，必须相同 |

> **为什么必须**：React 依赖引用变化触发重渲。若 `extendSelection` 原地改，
> UI 不会更新，选区"画不出来"。

---

## 5. 渲染层（`V-xx`）

> 测试文件：`services/backend/tests/cli/tui/viewportSelection.test.js`（新增）
> 若渲染断言难以在无 TTY 下进行，**允许**降级为「对 `selectionRangeFor` 的调用序列断言」，
> 但 `N-01`（逐字节等价）必须用真实渲染输出比对。

### V-01 不传 `selection` 时逐字节等价（最重要的一条）

| 项 | 内容 |
|---|---|
| **输入** | 用同一组 `lines`/`height`/`scroll` 渲染 Viewport 两次：一次不传 `selection`，一次传 `null` |
| **期望输出** | 两次渲染输出**完全相同** |
| **通过条件** | 严格相等。**这是向后兼容的硬闸**——违反即视为破坏既有行为 |

### V-02 单行选区在三段间切分正确

| 项 | 内容 |
|---|---|
| **输入** | `lines = ['abcdefgh']`，选区覆盖 `[2, 5)` |
| **期望输出** | 该行渲染为「`ab` + 反色`cde` + `fgh`」三段 |
| **通过条件** | 三段文本拼接后等于原行（**不丢字符**）；中段带反色属性 |

> **注意**：`to` 是半开（`S-06` 口径）。若实现按闭区间切，拼出来是 `ab` + `cdef` + `gh`，
> V-02 的「不丢字符」仍成立但 `S-06` 必红——两处口径必须一致。

### V-03 选区跨越可见窗口边界

| 项 | 内容 |
|---|---|
| **输入** | `height = 3`，`lines` 共 10 行，选区覆盖第 2 到第 7 行，`scroll = 0` |
| **期望输出** | 可见的第 0–2 行中：第 0 行不反色；第 1–2 行按跨行规则反色（第 1 行从 `startCol` 到尾，第 2 行整行）|
| **通过条件** | 窗口外的行不被渲染；窗口内的行区间正确；**滚动后（`scroll = 5`）区间同步更新** |

### V-04 反色落在空段上不得产生视觉异常

| 项 | 内容 |
|---|---|
| **输入** | 选区覆盖某行的 `[0, 0)`（零宽）或全行空白 |
| **期望输出** | 该行正常渲染，无多余字符 |
| **通过条件** | 与不传 `selection` 时该行输出相同（`selectionRangeFor` 返回 `null` 时走原路径）|

> **实现提示**：中段为空字符串时必须回退为一个空格 `' '`，否则 ink 会吞掉该 `Text`
> 节点、导致后段前移错位。

### V-05 空行参与选区的渲染

| 项 | 内容 |
|---|---|
| **输入** | `lines = ['a', '', 'c']`，选区覆盖全部三行 |
| **期望输出** | 中间空行也被反色（渲染为一个反色空格）|
| **通过条件** | 中间行输出非空且带反色，否则用户看不出空行在选区内 |

---

## 6. 交互层（`A-xx`）

> 测试文件：`services/backend/tests/cli/tui/selectionInteraction.test.js`（新增）
>
> **可测性设计**：鼠标序列解析与选区状态机应能**脱离 ink 单独驱动**。
> 实现者应把「SGR 事件 → 选区动作」的映射抽成一个可注入的回调集合，
> 使本节的测试无需真 TTY、无需 React 渲染器。

### ⚠️ 本节全部用例的前置条件（`A-00`）

> **不满足这一条，`A-01` 之后的每一条都会「单测绿、真机死」。**

`A-01`/`A-02`/`A-09` 都依赖**拖动过程中的 motion 事件**。而 `1000`（X11 basic）
**一个位移事件都不报**。当前 `enableBytes()`（`mouseButtons.js:261-267`）写的是
`'\x1b[?1000h\x1b[?1006h'` —— 全仓库从未写过 `?1002h`。

因此**必须先完成 2b-0**：`enableBytes` 增加 `select` 参数，`select` 为真时写
`'\x1b[?1002h\x1b[?1006h'`（`1002` = button-event tracking，**仅在有键按下时报位移**，
这正是拖动所需的唯一档位）。`A-00` 就是用来把这条前置条件钉死成可执行用例的。

| 档位 | 代码 | 报按下/松开 | 报位移 | 拖动可用 | 代价 |
|---|---|---|---|---|---|
| X11 basic | `?1000h` | ✅ | ❌ | **不可用** | 无（但拖不动） |
| button-event | `?1002h` | ✅ | **仅按住时** | **✅ 本方案采用** | 按住期间原生拖选不可用 |
| any-event | `?1003h` | ✅ | 任何移动（60~120Hz）| 可用（但洪流）| 持续占用，仅 `full` 档显式 opt-in |
| alt-scroll | `?1007h` | — | — | 无关 | 见设计文档 §4.4，另立项 |

### A-00 tracking 档位前置（本组的第一条，**必须先绿**）

| 项 | 内容 |
|---|---|
| **输入** | 调用 `enableBytes()`（无参数）；再调用 `enableBytes({ select: true })` |
| **期望输出** | 前者**逐字节等于** `'\x1b[?1000h\x1b[?1006h'`；后者含 `'\x1b[?1002h'` 且**不含** `'\x1b[?1000h'` |
| **通过条件** | 两条字节级断言同时成立。前者是回归护栏（不得改动默认行为），后者是本组其余用例能成立的前提 |
| **失败的含义** | 若第二条不成立，**不要继续看 `A-01` 之后的用例** —— 它们在单测里仍会绿，但在真机上拖动收不到任何事件 |

> **真机冒烟（唯一不可用单测替代的验收项）**：临时把 `app.js` 的 `enableBytes` 调用
> 改成 `{ select: true }`，`KHY_TUI_DIAG=1 khy`，按住左键在正文区上下拖，
> **应看到连续的 `[mouse] ... motion` 行**。看到即通；看不到说明 2b-0 没做成。

### A-01 按下 → 拖动 → 松手 的完整序列

| 项 | 内容 |
|---|---|
| **输入** | 依次投喂 `[<0;3;2M`（按下，col=2,row=1）→ `[<32;8;2M`（拖动，col=7,row=1）→ `[<0;8;2m`（松开）|
| **期望输出** | 松手后 `hasSelection` 为 `true`；`extractText` 等于该行 `[2, 7)` 区间 |
| **通过条件** | 三段序列走完后选区正确；`dragging` 回到 `false`（**前置：`A-00` 第二条已绿**）|

> **坐标换算口径**：SGR 是 1-based（`x=3` → `col=2`）；`row` 需经 `screenOffset`
> 换算为 `_mainContentLines` 下标。实现者必须复用既有
> `mouseButtons.screenOffset()` 与 `Viewport.resolveViewportOffset()`，**不得自行另算**。
>
> `[<32;...M` 里的 `32` 是**位移位**（motion bit），不是按钮号 —— `button & 32` 为真
> 即表示「这是一次移动」。解析后 `isMotion` 必须为 `true`，实现不得把它当成新按下。

### A-02 拖动过程随时可见（选区在拖动中就要画）

| 项 | 内容 |
|---|---|
| **输入** | 投喂按下 + 一次拖动，**不投喂松开** |
| **期望输出** | 此时 `hasSelection` 已为 `true`（不必等松手）|
| **通过条件** | 为真。若实现只在松手时才算选区，拖动过程中用户看不到反色 → 必红（**前置：`A-00` 第二条已绿**）|

### A-03 松手即复制（`KHY_SELECT_COPY_ON_RELEASE` 开）

| 项 | 内容 |
|---|---|
| **输入** | `A-01` 的完整序列，`writeClipboard` 用测试替身注入 |
| **期望输出** | 替身被调用**恰好一次**，载荷等于 `A-01` 的 `extractText` 结果 |
| **通过条件** | 调用次数 `=== 1`；载荷严格相等 |

### A-04 松手不复制（门控关）

| 项 | 内容 |
|---|---|
| **输入** | 同 `A-03`，但 `KHY_SELECT_COPY_ON_RELEASE=0` |
| **期望输出** | 替身被调用 **0 次**；选区仍为 `true`（反色保留）|
| **通过条件** | 调用次数 `=== 0` 且 `hasSelection` 为 `true` |

### A-05 空选区松手不得写剪贴板

| 项 | 内容 |
|---|---|
| **输入** | 按下后立即在**同一坐标**松手（零宽）|
| **期望输出** | 替身被调用 0 次 |
| **通过条件** | `=== 0`。**防止把空串写进用户剪贴板**——那会清掉用户原有内容 |

### A-06 `Ctrl+C` 的取值优先级

| 项 | 内容 |
|---|---|
| **输入** | 场景一：有选区时按 `Ctrl+C`；场景二：无选区时按 `Ctrl+C` |
| **期望输出** | 场景一 → 复制选区，**不**触发中断；场景二 → 触发中断，**不**复制 |
| **通过条件** | 两个替身（clipboard / abort）的调用次数分别为 `(1,0)` 与 `(0,1)` |

### A-07 `Esc` 清空选区

| 项 | 内容 |
|---|---|
| **输入** | 建立选区后投喂 `Esc` |
| **期望输出** | `hasSelection` 为 `false`；剪贴板未被写入 |
| **通过条件** | 两者同时成立 |

### A-08 任意普通按键清空选区

| 项 | 内容 |
|---|---|
| **输入** | 建立选区后投喂一个普通字符键（如 `a`）|
| **期望输出** | `hasSelection` 为 `false` |
| **通过条件** | 与既有 `exitNativePassthrough` 的纪律一致（任何非鼠标键都退出瞬时态）|

### A-09 拖动到视口边缘自动滚动

| 项 | 内容 |
|---|---|
| **输入** | 视口 `height = 5`、内容 20 行、当前偏移在最底；按下于视口首行，随后拖动到**视口上方之外** |
| **期望输出** | 视口偏移向上滚动；选区继续扩展 |
| **通过条件** | 偏移值变化且方向正确；选区 `endLine` 增大 |

> **允许简化**：若首版不做边缘自动滚动，则本测试**改为断言「拖出视口不崩且选区被 clamp」**，
> 并在实现里显式标注「边缘自动滚动 deferred」。**不允许**静默不做而无测试覆盖。

### A-10 双击 / 三击的时序（连击窗口）

| 项 | 内容 |
|---|---|
| **输入** | 在 300ms 内向同一坐标投喂两个「按下+松开」；随后向同坐标投喂三个 |
| **期望输出** | 两次 → 词选区；三次 → 行选区 |
| **通过条件** | 两次结果的 `extractText` 不同（词 vs 整行），且均不抛 |

> **可测性要求**：连击判定必须接受**注入的时钟**（便于测试用假时间），
> 不得直接读 `Date.now()` 而无注入口。

### A-11 选区与按钮点击互不干扰

| 项 | 内容 |
|---|---|
| **输入** | 序列一：在按钮上按下+松开（`R9` 场景）；序列二：在空白处按下+拖动+松开 |
| **期望输出** | 序列一 → `onClick` 触发、**不产生选区**；序列二 → 产生选区、**不触发** `onClick` |
| **通过条件** | 两者都不互相污染。这是 `[DESIGN-ARCH-119]` §4.2.7 的「三类事件各有归属」判据 |

### A-12 与滚轮互不干扰

| 项 | 内容 |
|---|---|
| **输入** | 有选区时投喂滚轮 `[<64;1;1M`（`:3` 表示按键释放）|
| **期望输出** | 滚动发生，**选区保持**（滚轮不清选区），滚轮仍被吞（`onInput` 返回 `true`）|
| **通过条件** | 三条同时成立 |

> **为什么不清选区**：用户选中一段后滚动查看上下文，是常见动作。清掉会很烦。

### A-13 门控关时行为回到第一层完成态

| 项 | 内容 |
|---|---|
| **输入** | `KHY_SELECT=0`，重放 `A-01` 的完整序列 |
| **期望输出** | 不产生选区；`onInput` 返回值与 `mouseNativeSelection.test.js` 的 `R1/R2` 完全一致 |
| **通过条件** | 逐条比对 `R1`/`R2` 的期望值（空白处按下 → `false`）|

---

## 7. 集成与回归（`X-xx`）

### X-01 第一层测试集必须仍然全绿

| 项 | 内容 |
|---|---|
| **命令** | 见 §8 |
| **期望输出** | `mouseNativeSelection.test.js` 9/9 通过，且**断言内容未被修改** |
| **通过条件** | 全绿。若为了让第二层通过而改了第一层的断言，视为**任务失败** |

### X-02 全 TUI 测试集无回归

| 项 | 内容 |
|---|---|
| **命令** | 见 §8 |
| **期望输出** | 与改动前对比，**通过数不减**、失败数为 0 或与改动前相同 |
| **通过条件** | 基线是 `744/744`（2026-09-17 实测）。新增测试只会让它变大 |

### X-03 纯叶子纪律：无 IO、无环境读取

| 项 | 内容 |
|---|---|
| **输入** | 静态检查 `selection.js` 源码 |
| **期望输出** | 不含 `require('fs')` / `process.env` / `process.stdout` / `console.` |
| **通过条件** | 正则扫描全部为 0 命中 |

> **理由**：门控读取在 App 层做，纯叶子不得自己读 env——否则无法在测试里确定性驱动。

### X-04 门控已登记

| 项 | 内容 |
|---|---|
| **输入** | 读 `services/backend/src/services/flagRegistry.js` |
| **期望输出** | 4 个 `KHY_SELECT*` 全部在册，且 `default` 值与 §1.3 一致 |
| **通过条件** | 4 个 key 都存在，默认值正确 |

### X-05 `Ctrl+C` 既有中断语义未被破坏

| 项 | 内容 |
|---|---|
| **输入** | 无选区时按 `Ctrl+C` |
| **期望输出** | 与本次改动前**完全一致**的既有行为 |
| **通过条件** | 既有相关测试全绿；`A-06` 场景二通过 |

### X-06 既有鼠标门控登记不得被破坏（回归护栏）

| 项 | 内容 |
|---|---|
| **输入** | 读 `services/backend/src/services/flagRegistry.js` |
| **期望输出** | `KHY_MOUSE` / `KHY_MOUSE_BUTTONS` / `KHY_MOUSE_HOVER` / `KHY_MOUSE_WHEEL` / `KHY_ALT_SCREEN` **五个 key 全部仍在册** |
| **通过条件** | 五个 key 都存在。**这是 2b-0/2b-2 改 `mouseButtons.js` 与新增 `KHY_SELECT_*` 时最容易误删的一处** —— 新增 `KHY_SELECT` 的编辑动作若用整块替换，很容易把相邻的 `KHY_MOUSE` 行一起覆盖掉 |

> **为什么需要这条**：这五个 flag 是本 bug 的**唯一 workaround**（`KHY_MOUSE=off`）。
> 它们在步骤 1 已落地（`flagRegistry.js:2828-2832`），属于**既有正确状态**，
> 因此本验收标准的职责是**守住它**，而不是再实现一遍。
> 对应的文档侧护栏是 `tui/AGENTS.md` §1.2 那五行（`AGENTS.md:285-288`）。

---

## 8. 反例矩阵（`N-xx`）—— 必须"按期望失败"

> **本节的性质**：这些不是「期望通过」的功能测试，而是**演示错误实现的测试**。
> 实现者应在开发期把它们跑一遍，确认**错误实现确实会红**。
> 若某条错误实现竟然通过了，说明你的测试**没有测到点子上**。

| # | 错误实现 | 应当失败的用例 | 为什么 |
|---|---|---|---|
| **N-01** | 忽略 `selection` prop，一律按原路径渲染 | `V-01` 会"意外通过"（因为都不变）→ **必须改用 `V-02` 检出** | 这是最危险的一类：什么都不做看起来是对的 |
| **N-02** | `extractText` 用闭区间（`to` 含端点）| `S-06`（多一个字符）、`V-02`（中段偏长）| 半开/闭区间混淆，最经典的 off-by-one |
| **N-03** | `expandToWord` 用朴素 `\b` 口径 | `S-21`（路径被切碎成 `Portable`）| 正是 CC 文档专门规避的坑 |
| **N-04** | 用 `filter(Boolean)` 去空行 | `S-09`（空行消失）| 多段复制丢空行，用户可感知 |
| **N-05** | `extendSelection` 原地改 `sel` | `S-36`（入参被改）| React 不会重渲，选区"画不出来" |
| **N-06** | 只在松手时才算选区 | `A-02`（拖动中看不到反色）| 用户拖动时无反馈，体感像卡住 |
| **N-07** | 空选区松手也写剪贴板 | `A-05`（清空用户剪贴板）| 破坏性副作用 |
| **N-08** | 中段为空时不回退空格 | `V-04`（后续段落错位）| ink 吞掉空 `Text` 节点 |
| **N-09** | `hasSelection` 只比 `anchor.line !== head.line` | `S-05` 第 3 条（同行非零宽被判空）| 同行选择是最高频场景 |
| **N-10** | 滚轮事件清空选区 | `A-12` | 选中后滚动查看上下文是常见动作 |
| **N-11** | 在 `selection.js` 里读 `process.env` | `X-03` | 纯叶子纪律；测试无法确定性驱动 |
| **N-12** | 改掉 `mouseNativeSelection.test.js` 的断言让新代码通过 | `X-01` | 掩盖第一层回归，是最严重的失败模式 |

---

## 9. 验收命令与通过判定

```bash
cd D:/Portable/khy-os/services/backend

# 0) tracking 档位（2b-0；A-00 在这里）
node --test tests/cli/tui/mouseWheel.test.js

# 1) selection 模型层（本层核心）
node --test tests/cli/tui/selection.test.js

# 2) 渲染层
node --test tests/cli/tui/viewportSelection.test.js

# 3) 交互层
node --test tests/cli/tui/selectionInteraction.test.js

# 4) 第一层回归（X-01）
node --test tests/cli/tui/mouseNativeSelection.test.js tests/cli/tui/mouseWheel.test.js

# 5) 全 TUI 测试集（X-02）
node --test "tests/cli/tui/*.test.js"
```

> **`node` 指可用的 Node 22**（`node --version` 应为 `v22.x`）。本文不写死机器相关的
> 绝对路径 —— 那属于 `RUNTIME-001` 禁止的硬编码，且换机即失效。

> ⚠️ **先做 2b-0（tracking 档位）再做本节的命令 2–3**。若跳过 2b-0，
> 命令 1（`selection.test.js`）仍会全绿 —— 它是纯逻辑，不经过通道；
> 只有 `A-00` 的字节断言 + 真机冒烟能暴露「通道没开」。**不要以命令 1 全绿
> 当作交互层可用的证据。**

**通过判定（全部成立才算本层完成）**：

| # | 条件 |
|---|---|
| 1 | 命令 1–3 全绿，且 `S-xx` / `V-xx` / `A-xx` 每条编号都有对应断言 |
| 2 | 命令 4 **全绿且断言未被修改** |
| 3 | 命令 5 通过数 ≥ `744`，失败数 `0` |
| 4 | §8 的 `N-xx` 逐条确认「错误实现会红」（开发期人工核验一次即可）|
| 5 | `selection.js` 通过 `X-03` 静态检查（无 IO / 无 env）|
| 6 | `flagRegistry.js` 4 个门控在册（`X-04`）|
| 7 | **`A-00` 两条字节断言全绿，且真机冒烟看到连续 `motion` 行**（2b-0；唯一不可用单测替代的一项）|

### 9.1 本标准的自验结果（2026-09-17 实跑）

> 为证明本标准**可执行且确实测到点子上**，已按本文写出参考实现
> `services/backend/src/cli/tui/selection.js` 并实跑全部断言。结果：

| 项 | 命令 | 实测 |
|---|---|---|
| `S-xx` 模型层（27 条）| 命令 1 | ✅ **27/27** |
| 第一层回归（`X-01`）| 命令 4 | ✅ **44/44**（含 `S-xx`）|
| 全 TUI 测试集（`X-02`）| 命令 5 | ✅ **771/771，fail 0**（基线 744 + 新增 27）|
| `X-03` 纯叶子纪律 | 静态扫描 | ✅ 5 项禁令零命中 |
| `N-xx` 反例核验 | 逐个注入错误实现 | ✅ **5/5 均能检出**（N-02/03/04/05/09）|

**核验方式（可复现）**：对 `selection.js` 逐个注入「错误实现」，确认至少一个用例由绿转红：

| 反例 | 注入的错误实现 | 检出的用例 |
|---|---|---|
| `N-02` | `slice(startCol, endCol + 1)`（闭区间）| `S-06` |
| `N-03` | 词集退化为 `[A-Za-z0-9_]` | `S-21` |
| `N-04` | `parts.filter(Boolean).join('\n')` | `S-09` |
| `N-05` | `extendSelection` 原地改 `sel` | `S-36` |
| `N-09` | `hasSelection` 只比 `line` | `S-05` |

> **实现期发现的两处口径修正**（已回写本文与参考实现）：
> 1. `selectionRangeFor` 的端点**必须解析成具体列号**，不得返回 `Infinity` ——
>    否则「查行长度」的负担被漏给渲染层。签名相应为 `(lines, sel, line)`。
> 2. `S-35` 的期望值原写 `'line 49'`，实为 `'line 4'`（`'line 4999'.slice(0,6)`）——
>    是**测试断言本身写错**，非实现问题。已修正。

**真机人工验收（无法自动化，必须人工做一次）**：

```bash
# 关闭自绘选择层 → 应与第一层完成态一致
KHY_SELECT=0 khy

# 开启(默认) → 拖选应反色,松手后可在编辑器里粘贴
khy
#   ① 拖选一段正文 → 松手 → 粘贴,内容正确、无丢字
#   ② 双击一条路径 → 整条被选中(Ctrl+C 复制后粘贴验证)
#   ③ 三击一行 → 整行选中
#   ④ 选中后滚轮滚动 → 选区仍在
#   ⑤ Esc → 选区消失
#   ⑥ 无选区时 Ctrl+C → 仍能中断请求(既有行为)
#   ⑦ 点麦克风按钮 → 仍能触发(A-11)

# 回滚验证(必须逐项与第一层完成态一致)
KHY_SELECT_COPY_ON_RELEASE=0 khy   # 只反色、不自动复制
KHY_SELECT_WORD_BOUNDARY=0 khy     # 双击走朴素 \b(路径会被切碎,预期如此)
KHY_SELECT_MAX_BYTES=20 khy        # 复制超 20 字节应截断并提示
```

---

## 10. 未覆盖项（明确记录，不得静默略过）

以下项**本验收标准不覆盖**，因为它们需要真机/真终端，或属于后续改进。
实现者**不得**声称本层已完成这些：

| # | 未覆盖项 | 原因 | 归属 |
|---|---|---|---|
| 1 | SSH / tmux 下 OSC 52 是否生效 | 需真实转发层；本地 TTY 实测走 native-only | §七 风险 2，另测 |
| 2 | 各终端对 `Shift+鼠标` 的差异行为 | 需真机多终端；第一层已对两种都正确 | §七 风险 3 |
| 3 | 软换行的逻辑行还原 | `_mainContentLines` 含折行，视觉行 ≠ 逻辑行 | §六 不做的事 4，另立提案 |
| 4 | 按消息整体复制 | 行投影无消息元数据 | §七 风险 1，需 `buildTranscriptLineRecords` |
| 5 | `?1007h` 终端兼容性 | 需真机；已降为可独立回滚的实验 | §4.4 |
| 6 | `1003`（`full` 档）下的选区性能 | 需真机高频 motion；`1002` 下的限流不能证明 `1003` 下的限流 | §七 风险 7 |
| 7 | `1002` 在**异常退出**后残留于终端的清除 | 需真机 `SIGKILL` / 终端崩溃；`disableBytes()` 只在正常 teardown 跑到 | §七 风险 8 |
| 8 | 「按住期间终端原生拖选不可用」的用户可感知度 | 需真机 + 用户判断；这是 2b-0 的固有代价，无法用断言表达 | §4.2.7、§六 第 7 条 |

---

**附：本轮验收标准的改动落点**

| 文件 | 性质 | 状态 |
|---|---|---|
| `docs/03_DESIGN_设计/[DESIGN-ARCH-119] TUI文本选择与复制-验收标准.md` | 本文（验收标准真源）| ✅ |
| `services/backend/tests/cli/tui/selection.test.js` | `S-xx` 验收测试（27 条）| ✅ 27/27 |
| `services/backend/src/cli/tui/selection.js` | **参考实现**（纯叶子）| ✅ 27/27 |
| `services/backend/src/cli/tui/mouseButtons.js` `enableBytes` | `A-00` 的被测件（`select` → `?1002h`）| ⬜ 待改（2b-0）|
| `services/backend/tests/cli/tui/mouseWheel.test.js` | `A-00` 两条字节断言 | ⬜ 待写（2b-0）|
| `services/backend/tests/cli/tui/viewportSelection.test.js` | `V-xx` 渲染层验收测试 | ⬜ 待写（2b-1）|
| `services/backend/tests/cli/tui/selectionInteraction.test.js` | `A-xx` 交互层验收测试 | ⬜ 待写（2b-2）|
| `ink-components/Viewport.js` / `App.js` / `flagRegistry.js` | 被测件（接线）| ⬜ 待改（2b-1 / 2b-2）|

> **`selection.js` 已作为参考实现落地**：它不是为了「抢跑」，而是为了证明本标准
> **可执行**——一个真实实现能让全部 `S-xx` 断言转绿，且 §8 的 5 条反例都能被检出。
> `V-xx`/`A-xx` 两层的实现仍待做（需要 `enableBytes` 的 `select` 参数、`Viewport`
> 与 `App` 的接线，属 2b-0 / 2b-1 / 2b-2）。
