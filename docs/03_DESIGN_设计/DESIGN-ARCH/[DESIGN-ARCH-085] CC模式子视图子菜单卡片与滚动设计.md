# [DESIGN-ARCH-085] CC 模式子视图、子菜单、卡片与滚动设计

> **隶属**：本文属 **TUI 设计族**（20 编号 / 21 文件），总纲与 scope 裁决见 `[DESIGN-ARCH-122] TUI 设计族总纲`；规则冲突一律以 `[DESIGN-ARCH-102] Khy TUI 统一规则手册` 为准。

> **定位**：定义 CC 模式下子视图（Agent）、子菜单、卡片、滚动/复制/历史的设计规范。>   
> **适用边界**：Agent 面板、命令面板、工具卡片、消息历史、滚动交互。>   
> **参考来源**：`advanced-patterns.md` (View Stack, History, Clipboard) + `interaction-patterns.md` (fzf, OSC) + `exemplar-apps.md` (Claude Code)
>
> ⚠ **参考来源为悬空引用**（2026-09-18 核实）：上述三份 `*.md` 在**本仓 `find` 零命中**，>   
> 应为设计期的外部资料，未随文档入库。因此本文头部无法据以回溯 Claude Code / opencode 的>   
> 原始设计依据。**回溯原始依据请改看**：`[DESIGN-ARCH-063]`（对照《Claude Code 架构》）、>   
> `[DESIGN-ARCH-075]`（opencode 差距补齐路线）、`[DESIGN-ARCH-081]`（Claude Code TUI 复刻计划）、>   
> `[DESIGN-ARCH-121]`（CC-Harness 借鉴清单，含源码级行号核对）。
>
> ⚠ **§4 已于 2026-09-18 按实现校正**。此前 §4.1/§4.2 的键位表与示例代码是**设计期草案**，>   
> 与落地实现严重脱节（表格里三个键在代码中不存在、示例代码的通道优先级与实现相反）。>   
> 现 §4 以「**实现现状**（file:line 可复核）+ **设计意图**（草案保留并标注）+ **差距**」三段式重写。>   
> 若本文与实现冲突，**以实现为准**，并回来改本文。

---

## 0. 设计原则

| 原则        | 说明           |
| --------- | ------------ |
| **视图隔离**  | 子视图不影响主对话流   |
| **渐进披露**  | 复杂操作分步呈现     |
| **滚动独立**  | 滚动/复制/历史互不干扰 |
| **上下文保持** | 切换视图后恢复位置和状态 |
| **键盘优先**  | 所有操作键盘可达     |

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

| 操作       | 效果     |
| -------- | ------ |
| `Ctrl+P` | 打开命令面板 |
| 输入字符     | 实时过滤命令 |
| `↑/↓`    | 导航命令   |
| `Enter`  | 执行选中命令 |
| `Esc`    | 关闭面板   |
| `1-9`    | 跳转到分组  |

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

| 属性       | 规范               |
| -------- | ---------------- |
| **边框**   | 单线 `─│┌┐└┘`，圆角可选 |
| **标题**   | 图标 + 名称，粗体       |
| **内容**   | 缩进 2 空格          |
| **折叠**   | `▸` 折叠 / `▾` 展开  |
| **状态**   | 右下角显示状态          |
| **最大宽度** | 80 列或终端宽度        |

---

## 4. 滚动/复制/历史设计

> **本节的读法**（2026-09-18 重写）：每条分 **① 实现现状**（file:line 可复核，权威）/>   
> **② 设计意图**（原始草案，保留以存演进痕迹）/ **③ 差距**（两者差在哪、为何）。>   
> 实现与本节冲突时**以实现为准**。


### 4.1 滚动设计（不影响选择和复制）

#### 4.1.1 滚动模式分离

##### ① 实现现状

**核心事实：CC 模式当前没有「滚动模式 / 选择模式 / 复制模式」的**作用域状态机。  
滚动是**无模式**的 —— 任何时刻按键都直接作用，不需要先「进入」某个模式。

| 作用对象                                   | 触发键                   | 行为                  | 真源                                                 |
| -------------------------------------- | --------------------- | ------------------- | -------------------------------------------------- |
| 转录覆盖层（`Ctrl+O` 打开的 `CcTranscriptView`） | `↑` / `↓`             | 单条上/下移（**同时**移动选中项） | `CcTranscriptView.js:96-108`                       |
| 同上                                     | `PageUp` / `PageDown` | 半页上/下               | `CcTranscriptView.js:110-118`                      |
| 同上                                     | `g` / `G`             | 跳顶 / 跳底             | `CcTranscriptView.js:120-128`                      |
| 同上                                     | `Enter`               | 切换当前条的工具展开          | `CcTranscriptView.js:130-140`                      |
| 同上                                     | `Esc`                 | 关闭覆盖层               | `CcTranscriptView.js:93-95`                        |
| 主对话区                                   | 鼠标滚轮                  | 视口滚动                | `mouseButtons` → `onWheel` → `applyViewportScroll` |

> ⚠ **无 `PageUp`/`PageDown` 的全局绑定**：全仓 `grep -rn "pageup\|pagedown" --include=*.js`>   
> 在 `tui/` 下**零命中** —— 翻页键只存在于 `CcTranscriptView` 覆盖层内部。>   
> 主对话区目前**只能靠滚轮**滚动，没有键盘翻页。

所有滚动动作统一收敛到 **`tui/scrollActions.js` 的 `applyScroll(action, dims)`**（单一真源）：

```js
// scrollActions.js:27-36 —— CC `scroll:*` 动作族全集（顺序 = CC 注册表出现顺序）
'lineUp' | 'lineDown' | 'halfPageUp' | 'halfPageDown'
| 'fullPageUp' | 'fullPageDown' | 'top' | 'bottom'
```

设计上刻意与 CC 注册表同名，且**同时接受裸名与带前缀名**（`'lineUp'` 与 `'scroll:lineUp'`）——  
调用方可逐字节照抄 CC 注册表而不必再翻译一层（`scrollActions.js:20-24`）。

##### ② 设计意图（原始草案，未落地）

```
| 模式 | 触发 | 行为 |
| 浏览模式 | 默认 | ↑/↓ 浏览历史，PageUp/PageDown 滚动 |
| 选择模式 | v 进入 | ↑/↓ 选择文本，Space 标记 |
| 复制模式 | c 进入 | 选择后 y 复制 |
```

##### ③ 差距

| 差距               | 说明                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------- |
| **无模式机**         | 草案的三个模式均未实现。`v` 的现状是**输入框的 vim visual 模式**（见 §4.2.3），不是「选择模式」                           |
| **无 `Space` 标记** | 草案的「多选标记」未实现；选中态是单选（`selectedIndex`）                                                    |
| **主对话区无键盘翻页**    | 草案的 `PageUp/PageDown` 只落在转录覆盖层；主区仅滚轮                                                    |
| **模式机未做并非缺陷**    | 无模式更贴合 Claude Code 实际体验（`Ctrl+O` 开覆盖层后直接 `↑/↓`/`g`/`G`，无需先进入模式）；**建议把草案的三个模式正式废弃**，而非补齐 |

#### 4.1.2 滚动实现（Claude Code 风格）

**实现现状**：滚动指示器由 `components/CcScrollIndicators.js` 渲染，  
`Viewport.js` 负责切片与边界钳制（`clampedScroll = clamp(scroll, 0, maxScroll)`）。

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

##### ① 实现现状（权威）

**CC 模式下当前只有两个复制入口**：

| 操作                          | 效果                                              | 反馈                                        | 真源                                               |
| --------------------------- | ----------------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| **`Ctrl+Y`**                | 复制**最近一条助手回复**到剪贴板                              | `copied N chars` / `已复制 N 字节到剪贴板(native)` | `CcApp.js:359-361` → `handleCopyLast()` (`:239`) |
| **`y`**（输入框 vim VISUAL 模式下） | yank 输入框选中片段：写入内部寄存器 `_vimYank` **并**写系统剪贴板（双写） | `已复制 N 字节到剪贴板(channels)` / `复制失败:reason`  | `CcPromptInput.js:326-347`                       |
| `Ctrl+C`                    | **中断**（非复制）                                     | —                                         | `CcApp.js:299-311`                               |

`Ctrl+Y` 的反馈文案走 `utils/ccFormatters.formatCopyFeedback`（code-point 计数，emoji 安全），  
门控 `KHY_CC_COPY_TOAST`（默认开）；显式 `0` → 回退中文旧文案。**失败时如实告知，绝不假装成功**  
（`CcApp.js:267-281`）。`y` 的反馈同理走 `onToast`，且 **fail-soft**：剪贴板不可用不阻断 vim 操作。

**输入框 vim 模式的其他相关键**（`CcPromptInput.js:246-350`，供对照）：

| 键                                 | 作用                                              |
| --------------------------------- | ----------------------------------------------- |
| `v` / `V`                         | 进 VISUAL：`v` 从光标起、`V` 整行（`visualStart=0`，光标到行尾） |
| `h` / `l` / `w` / `b` / `0` / `$` | 光标移动                                            |
| `d` / `x`                         | 删除选中片段                                          |
| `y`                               | yank（见上）                                        |
| `p`                               | 粘贴（粘 `_vimYank`）                                |
| `u`                               | 撤销                                              |
| `i` / `a`                         | 回 INSERT                                        |

##### ② 设计意图（原始草案，未落地）

```
| c              | 复制当前选中内容   | copied 42 bytes        |
| C              | 复制整行/整段      | copied 1 line          |
| Ctrl+C         | 中断操作           | —                      |
| Ctrl+Shift+C   | 复制到剪贴板       | copied                 |
```

##### ③ 差距（重要：**三个键在代码中不存在**）

```
❌ `c`             → 全仓无此绑定
❌ `C`             → 全仓无此绑定
❌ `Ctrl+Shift+C`  → 全仓无此绑定（且终端普遍不上报带 Shift 的 Ctrl 组合，
                      ink 的 key 对象也拿不到可靠判据 —— 草案这条在终端层就不成立）
✅ `Ctrl+Y`        → 实现采用的键（草案未提）
```

⇒ **草案的键位表不可作为实施依据**。若要让「复制选中内容」成立，  
真正缺的是 §4.2.4 说的**消息区选择消费者**（见 `[DESIGN-ARCH-124]`），  
不是补三个键绑定。

#### 4.2.2 复制实现

##### ① 实现现状（权威，`tui/utils/ccClipboard.js`）

模块头注释写明的策略与**草案相反** —— **native 先行，OSC 52 仅作非 TTY 兜底**：

| 顺序 | 通道         | 条件                                                                                         | 真源                       |
| -- | ---------- | ------------------------------------------------------------------------------------------ | ------------------------ |
| 1  | **native** | 总是先试；复用 `services/imageService.writeClipboardText`（跨平台工具链单一真源，stdin 管道注入安全 + CJK UTF-8 安全） | `ccClipboard.js:112-123` |
| 2  | **OSC 52** | 仅当 native **失败**时兜底；或 `KHY_CLIPBOARD_DUAL=1` 时双通道并行                                        | `ccClipboard.js:178-188` |

统一出口 `writeClipboard(text)` **绝不抛**，返回 `{ ok, channels, bytes, reasons }`。

**OSC 52 的三个额外约束**（草案完全没写）：

```js
shouldEmitOsc52(stream, env)   // ccClipboard.js:70-80
  → 门控关            → { on:false, reason:'gate-off' }
  → stream.isTTY      → { on:false, reason:'tty' }      // TTY 下喷转义会污染画面
  → 否则              → { on:true }

buildOsc52Frame(text, {env})   // 载荷 > maxBytes → { skip:true, reason:'oversize' }

TMUX/STY passthrough           // ccClipboard.js:98-102
  → tmux 下须包 `\x1bPtmux;\x1b…\x1b\\` 外层 DCS 才能穿透
  → 嵌套 tmux 只包一层（tmux 自身会透传内层）
```

**环境变量**（真源 `services/backend/src/services/flagRegistry.js`）：

| 变量                          | 默认       | 作用                                             |
| --------------------------- | -------- | ---------------------------------------------- |
| `KHY_CC_CLIPBOARD`          | **开**    | 统一出口总闸；关 → 逐字节回退 legacy 直调 `imageService`      |
| `KHY_CLIPBOARD_OSC52`       | 开        | OSC 52 通道独立门控                                  |
| `KHY_CLIPBOARD_DUAL`        | **关**    | native 成功后仍补发 OSC 52（opencode #4751 实证用户要这个开关） |
| `KHY_CLIPBOARD_PASSTHROUGH` | 开        | tmux/screen 的 DCS 外层包装                         |
| `KHY_CLIPBOARD_MAX_BYTES`   | `100000` | OSC 52 载荷上限；`0` = 不限                           |

##### ② 设计意图（原始草案）

```js
// 草案写法：OSC 52 优先，失败才 fallback 到系统命令
const OSC_52 = '\x1B]52;c;';
function copyToClipboard(text) {
  try {
    process.stdout.write(OSC_52 + Buffer.from(text,'utf8').toString('base64') + '\x07');
    return true;
  } catch {
    // fallback: pbcopy / xclip / clip
  }
}
```

##### ③ 差距（**优先级完全颠倒**，且草案版本会污染 TTY）

| 维度      | 草案            | 实现                        | 为何实现更优                                       |
| ------- | ------------- | ------------------------- | -------------------------------------------- |
| 通道优先级   | OSC 52 **优先** | native **优先**             | OSC 52 依赖终端支持（部分终端忽略），native 走系统工具链**确定性更高** |
| TTY 判定  | **无**         | `isTTY → 不发射`             | 草案会在用户画面上**喷出 base64 转义串**                   |
| tmux 穿透 | **无**         | DCS 外层包装                  | 草案在 tmux 内**静默失效**                           |
| 载荷上限    | **无**         | 100KB（可配）                 | 超大载荷会卡住终端                                    |
| 门控      | **无**         | 5 个 env                   | 无法在异常环境降级                                    |
| 失败可见性   | `false`       | `{ok, channels, reasons}` | 草案的布尔值**无法区分失败原因**                           |

⇒ 草案是**早期草稿**，实现已演进为生产级版本。**保留草案只为记录演进，不作为依据。**

#### 4.2.3 与 `v`/`y` 的真实关系（澄清高频误读）

`[DESIGN-ARCH-102]` §6.1 与本文草案都提「`v` 进入选择模式 / `y` 复制」，  
容易误读为「消息区的 vim 式选择复制」。**实际语义完全不同**：

| 键                   | 真实作用域    | 真实语义                                                     | 真源                         |
| ------------------- | -------- | -------------------------------------------------------- | -------------------------- |
| `v`                 | **输入框内** | 进入 vim **VISUAL 模式**，标记 `visualStart = offset`（`V` 则为整行） | `CcPromptInput.js:252-253` |
| `y`（visual 中）       | 输入框内     | **yank**：写入 `_vimYank` 寄存器，**并**双写系统剪贴板（有 Toast 回执）      | `CcPromptInput.js:326-347` |
| `d` / `x`（visual 中） | 输入框内     | 删除输入框内的选中片段                                              | `CcPromptInput.js:317-326` |

> ⚠ **无 `Space` 标记**：草案与早期文档常提「`Space` 标记选择」，实际**全仓无 `input === ' '`>   
> 的 visual 分支** —— 该键未实现。

⇒ 这是 **输入框的 vim 编辑语义**（作用于 `value`/`offset`），  
**不是消息区的文本选择**。消息区（转录）**当前没有任何选择/复制能力** ——  
这正是 `[DESIGN-ARCH-124]` 要补的那个洞。

#### 4.2.4 消息区复制：唯一的结构性缺口

**CC 模式下，鼠标拖选复制不可用的根因**（`[DESIGN-ARCH-124]` §1 逐层实证）：

| 层                                         | 状态               |
| ----------------------------------------- | ---------------- |
| 进程级鼠标层（`tui/app.js` 开 1002）               | ✅ 已在收 SGR 事件     |
| 事件分发（`mouseButtons.js` 的 `onSelectEvent`） | ✅ 通道完整           |
| 选区算法（`selection.js`）                      | ✅ 纯叶子，27/27 绿    |
| 反色渲染（`Viewport.js` 的 `selection` prop）    | ✅ 通用，未传时逐字节不变    |
| 剪贴板出口（`ccClipboard.js`）                   | ✅ 本节 4.2.2 已实测可用 |
| **消费者（`CcApp.js`）**                       | ❌ **零命中**        |

⇒ 前 5 层全部就绪且实测通过，**断点只在最后一层**：CC 消息区没有消费鼠标事件、把  
消息树投影成 `lines[]` 的组件。补齐方案见 **`[DESIGN-ARCH-124]` §2 方案 A**  
（投影成 `lines[]` 喂给现成的 `Viewport`，复用 legacy 已验证的路径；**Legacy 路径一行不改**）。


### 4.3 历史回溯设计

#### 4.3.1 输入历史

| 操作       | 效果      |
| -------- | ------- |
| `↑`      | 上一条历史输入 |
| `↓`      | 下一条历史输入 |
| `Ctrl+R` | 反向搜索历史  |

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

| 操作      | 效果       |
| ------- | -------- |
| `Enter` | 继续对话（默认） |
| `r`     | 查看执行详情   |
| `n`     | 新建任务     |
| `Esc`   | 关闭面板     |

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

> ⚠ **本节已按实现校正**（2026-09-18）。原草案指定的 `tui/hooks/useScroll.js` **不存在**>   
> （`hooks/` 下无此文件），草案把「滚动」与「光标跟随」揉进一个 hook，实现则拆成三个正交件。

#### 6.2.1 实现现状（权威）

| 职责            | 真源                                                   | 说明                                                             |
| ------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| **滚动动作计算**    | `tui/scrollActions.js` 的 `applyScroll(action, dims)` | 纯函数叶子，零 React 依赖，8 个动作                                         |
| **边界钳制**      | `tui/scrollActions.js` 的 `clampOffset` / `maxOffset` | `offset ∈ [0, max(0, total-viewport)]`                         |
| **视口切片**      | `tui/ink-components/Viewport.js`                     | `visible = lines.slice(clampedScroll, clampedScroll + height)` |
| **光标（选中项）跟随** | 调用点各自持有 `selectedIndex`，**不**与 `scrollOffset` 自动联动   | 见 `CcTranscriptView.js:96-108`（两者同时改，但语义独立）                    |

`applyScroll` 的契约（`scrollActions.js:94-125`）：

```js
applyScroll(action, { offset, viewport, total })
  // action: 'lineUp'|'lineDown'|'halfPageUp'|'halfPageDown'
  //       | 'fullPageUp'|'fullPageDown'|'top'|'bottom'
  //          （亦接受 CC 带前缀名 'scroll:lineUp'）
  // 返回: 新 offset（已钳制，绝不抛；非数/NaN/Infinity/负数 → 按 0 处理）
```

**为什么拆成这样**：`applyScroll` 是纯函数 ⇒ 可被 `node --test` 直接单测（`tests/cli/tui/scrollActions.test.js`），  
不必挂 React 渲染器。这是本仓 TUI 的通用纪律：**能抽成纯叶子的，就不要塞进 hook**。

#### 6.2.2 设计意图（原始草案，未落地）

草案的 `useScroll(itemCount, visibleCount)` 把「滚动偏移」与「光标跟随」耦合在  
一个 hook 里，并让 `useEffect` 在 cursor 越界时回推 `scrollOffset`。**未采用**，原因：

| 草案做法                          | 为何不采用                                         |
| ----------------------------- | --------------------------------------------- |
| 滚动 + 光标耦合在一个 hook             | 破坏「能测的纯叶子优先」纪律；且不同视图对「光标是否跟随滚动」诉求不同           |
| `useEffect` 回推 scrollOffset   | 隐式联动，长转录下每帧 effect 开销；且与 `autoScroll` 贴底语义会打架 |
| 硬编码 `scrollUp/scrollDown` 两动作 | 缺半页/整页/顶/底；`scrollActions` 的 8 动作集已被 CC 注册表对齐 |

<details>

<summary>原始草案代码（保留以存演进痕迹，不作为依据）</summary>

```javascript
// tui/hooks/useScroll.js   ← 此文件不存在

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

</details>

---

## 7. 验收标准

> 本节按**实现现状**重写（2026-09-18）。原版把「滚动/复制」写成验收项，>   
> 但混合了草案键位；现拆成 **已成条目**（可用现状验收）与 **未成条目**（待 ARCH-124 等落地后验收）。

### 7.1 已成（可用现状验收）

| 场景       | 预期                                                   | 验收方式                                       |
| -------- | ---------------------------------------------------- | ------------------------------------------ |
| Agent 列表 | 显示所有 Agent 状态，数字键跳转                                  | 人工                                         |
| Agent 详情 | 分屏显示详情和日志                                            | 人工                                         |
| 命令面板     | `Ctrl+P` 打开，实时过滤                                     | 人工                                         |
| 子菜单      | 嵌套导航，`Esc` 返回                                        | 人工                                         |
| 工具卡片     | 可折叠，状态清晰                                             | 人工                                         |
| 信息卡片     | 数据对齐，易读                                              | 人工                                         |
| 转录滚动     | 覆盖层内 `↑/↓` 单条、`PgUp/PgDn` 半页、`g/G` 跳顶底               | `tests/cli/tui/scrollActions.test.js` + 人工 |
| 主区滚动     | 鼠标滚轮滚动，边界钳制正确                                        | 人工                                         |
| 复制（最近回复） | `Ctrl+Y` 复制最近的助手回复；成功/失败**均有回执**，绝不假装成功              | 人工                                         |
| 复制（输入框）  | vim VISUAL 下 `y` yank 并双写系统剪贴板（有 Toast）；`d`/`x` 删除选中 | 人工                                         |
| 剪贴板通道    | native 先行；非 TTY 时 OSC 52 兜底；tmux 下 DCS 穿透            | `tests/cli/tui/ccClipboard*.test.js`       |
| 历史       | `Ctrl+R` 搜索输入历史                                      | 人工                                         |
| Resume   | 完成后显示摘要，`Enter` 继续                                   | 人工                                         |

### 7.2 未成（**当前不满足，勿据此判缺陷**）

| 场景                                 | 现状                                | 阻塞项                         |
| ---------------------------------- | --------------------------------- | --------------------------- |
| **消息区拖选复制**                        | ❌ 完全不可用（CC 无选择消费者）                | `[DESIGN-ARCH-124]` §2 方案 A |
| **复制选中内容（`c`/`C`/`Ctrl+Shift+C`）** | ❌ 三键均无绑定，且 `Ctrl+Shift+C` 在终端层不可靠 | 同上；建议**废弃草案键位**，改由拖选承担      |
| **主区键盘翻页**                         | ❌ 仅覆盖层有 `PgUp/PgDn`；主区只有滚轮        | 待定（是否值得补，见 §4.1.1 ③）        |
| **滚动/选择/复制三模式机**                   | ❌ 未实现                             | 见 §4.1.1 ③ —— **建议正式废弃**    |

---

> **文档状态**：**Implemented（§4 已按实现校正，2026-09-18）** —— 非 Draft。>   
> 子视图/子菜单/卡片/滚动主体已在 CC 模式落地；**复制部分存在结构性缺口**（消息区无选择消费者），>   
> 缺口与补齐方案见 `[DESIGN-ARCH-124]`。>   
> **创建日期**：2026-09-09>   
> **校正日期**：2026-09-18（§4 滚动/复制全节重写；§6.2 按实现校正；§7 拆已成/未成）>   
> **依赖**：[DESIGN-ARCH-081] 主设计规范 · [DESIGN-ARCH-102] TUI 统一规则手册（规则真源） ·>   
> [DESIGN-ARCH-119] 应用内自绘选择 · [DESIGN-ARCH-124] CC 剪贴板补齐提案
