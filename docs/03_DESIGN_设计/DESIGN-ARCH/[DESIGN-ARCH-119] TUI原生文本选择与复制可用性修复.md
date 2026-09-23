# [DESIGN-ARCH-119] TUI 文本选择与复制可用性修复

> **隶属**：本文属 **TUI 设计族**（20 编号 / 21 文件），总纲与 scope 裁决见 `[DESIGN-ARCH-122] TUI 设计族总纲`；规则冲突一律以 `[DESIGN-ARCH-102] Khy TUI 统一规则手册` 为准。

> **定位**：修复 `khy` TUI 下**无法用鼠标选中并复制文本**这一第一痛点。本文是该修复的
> 设计真源：先给出**实测根因**（三条互相独立的缺陷，不是一条），再给**三层方案**——
> 判据收窄 → 应用内自绘选择 → 逃生舱与门控。
>
> **本版（v2）相对 v1 的实质变化**：「保留 `1000` + 有条件的吞」从**终点**降为**第一层**。
> v1 的结论「拖选与点击在鼠标通道内物理互斥、只能二选一」**在鼠标通道内仍然成立**，但它
> 不再是约束——因为三个参考实现在这件事上都不在鼠标通道里做选择，而是**自己画选择、
> 自己写剪贴板**。第二层让「滚轮 + 拖选 + 点击」三项同时成立，并把 v1 里那条唯一的
> 硬赌注（`?1007h` 在各终端的兼容性）**整体绕开**。
>
> **不新增门禁规则**——本修复是既有 `[DESIGN-ARCH-102]` §6.2 与 P6 承诺的**兑现**，
> 因此不携带 `<!-- RULES-REGISTRY -->` 标记行，不改 `RULES-REGISTRY.json`。
>
> **依据**：`[DESIGN-ARCH-102]` §6.2 鼠标约定（三档 + Shift 永远走原生 + P6「鼠标增强
> 不得劫持终端原生选择」）、§6.1 键盘总表（`v` 消息选择模式、`y` vim 复制）；
> `[DESIGN-ARCH-101] TUI 交互与展示规则细则` §8「需要裁决的冲突」第 6 条
> （`mouseButtons` 默认值文档/实现矛盾）与 §4.5 命中测试与鼠标档位；
> `[DESIGN-ARCH-111]`（规则遵守保障，用于门控登记）；
> `mouseButtons.js` 头部「为什么默认全关」；`services/backend/src/cli/tui/AGENTS.md` §0.9.3。
>
> ---
>
> ## 落地状态（2026-09-17）
>
> **第一层已完成并实测绿**（判据收窄 + 测试固化）：
>
> | 改动 | 文件 | 状态 |
> |---|---|---|
> | `parseSgrMouse` 补 `isShift/isAlt/isCtrl` | `services/backend/src/cli/tui/mouseButtons.js` | ✅ |
> | `onInput` 加修饰键前置放行（排除 `isWheel`）| 同上 | ✅ |
> | `press` 分支改「命中按钮才吞」| 同上 | ✅ |
> | `release` 分支改「按命中决定，不按 armed」| 同上 | ✅ |
> | 修正头部错误断言 + `app.js` 注释同步 | `mouseButtons.js` / `app.js` | ✅ |
> | 9 条回归测试 | `services/backend/tests/cli/tui/mouseNativeSelection.test.js` | ✅ 9/9 |
> | 全 TUI 测试集无回归 | `tests/cli/tui/*.test.js` | ✅ 744/744 |
>
> **实现期新发现（原方案未预见，已补进判据）**：`release` 分支若按 `pendingClick`
> 无条件吞，会把「从按钮上按下、拖出后松开」这一手势的**终点**也吃掉 —— 与缺陷 A
> 同一类病（起点在按钮上被吞、终点在空白处被吞，整段手势两头都缺）。故改为按
> **命中**而非按 `armed` 决定。反例矩阵 R10 即此条。
>
> **第二层（应用内自绘选择）—— ✅ 已实施（2026-09-17 晚）**。四步全部落地，
> 端到端探针 **17/17 绿**、**真渲染器探针 13/13 绿**；全 TUI 测试 **869/871**
> （2 条失败为改动前既有，与本提案无关）。
>
> | 步骤 | 产物 | 状态 |
> | --- | --- | --- |
> | 2a 模型 | `cli/tui/selection.js`（12 导出，零 IO 绝不抛）+ `tests/cli/tui/selection.test.js` | ✅ 27/27 |
> | 2b-0 档位 | `enableBytes({select})` 用 `1002` **替换** `1000`；`mouseWheel.test.js` 补三档断言 | ✅ 17/17 |
> | 2b-1 渲染 | `Viewport` 的 `selection` prop（三段 `Text`，中段 `inverse`）；不传时**逐字节不变** | ✅ 16/16 |
> | 2b-2 接线 | `createMouseDispatcher` 的 `onSelectEvent` + `App.js` 接线 + 4 个 `KHY_SELECT_*` 登记 | ✅ 15/15 |
> | 4 真渲染 | 真 ink 渲染器逐帧确认反色落点（**碰真渲染器**，不只碰逻辑） | ✅ 13/13 |
>
> **三层探针抓出的三个真实缺陷（各自那层的单测都发现不了）** ——
> 这条经验值得单独记下：**各层自洽 ≠ 串起来正确；逻辑正确 ≠ 真机画对了**。
> 1. **Shift+拖动位移漏进选区分支**：修饰键放行块原排在 `isMotion` **之后**，
>    于是 `[<36;x;yM`（Shift|motion）被当成选区扩展 → 用户按 Shift 想要终端原生
>    选择，程序同时在画自己的选区，两套打架。修法：修饰键判定提到 motion **之前**。
>    *（端到端探针抓到；当时的 15 条 dispatcher 单测只覆盖了 press，没覆盖 motion。）*
> 2. **坐标偏移方向写反**：`App.js` 里写成 `line = row − offset`，而 `Viewport` 的
>    真源是 `visible = lines.slice(clampedScroll, ...)` ⇒ 应为 `line = row + offset`。
>    后果是「只要滚动过，选中的行就整体偏移」，表现为「随机选错行」。
>    *（端到端探针抓到。）*
> 3. 另有 API 形状误读：`beginSelection`/`extendSelection` 是 **`(sel, line, col)` 三参**，
>    且选区形状是 `{anchor, head}` 而非 `{start, end}` —— 写错会静默返回 null。
>    *（端到端探针抓到。）*
>
> **真渲染器探针自己踩的两个坑（探针的错，不是产品的错，但都会伪装成产品缺陷）** ——
> 这类「假红」若不当场识破，会把人引向去改本来正确的产品代码：
> 1. **没走仓库的 `inkRuntime.loadInk()`**：`Viewport.js:57` 是
>    `inkRuntime.get()`，而 `get()` 在单例未灌值时**抛错**
>    （`inkRuntime.js:103-107`）。探针自己 `import('ink')` 拿到的是**另一份引用**，
>    Viewport 用的那份仍是空的 → 5 条渲染断言全红，报文长得像「Viewport 坏了」。
>    真机上 `startInkApp()` 会 await `loadInk()`，所以线上没这问题。
>    **修法：探针必须复刻真机的启动顺序，否则它验证的不是真机那条路径。**
> 2. **`chalk.level = 0` 导致 `inverse` 一个字节都不吐**：ink 的 `inverse` 是
>    `chalk.inverse`（`ink/build/components/Text.js:40-41`），而 chalk 的 level 来自
>    `supports-color` —— 非 TTY stdout 下为 0，此时 `chalk.inverse('x') === 'x'`。
>    假 stdout 即便 `isTTY: true` 也没用，因为 `supports-color` 在别处已经判过了。
>    修法：**在 require 任何 ink/chalk 相关模块之前**设 `FORCE_COLOR=3`
>    （chalk 在模块求值时读一次 `process.env.FORCE_COLOR`，晚了不生效）。
>    真机是真 TTY，level ≥ 1，不受影响。
>
> 验收探针：
> `docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 应用内自绘选择-端到端验证-2026-09-17.js`（17/17，逻辑链）；
> `docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 应用内自绘选择-真渲染器验证-2026-09-17.js`（13/13，真 ink 渲染器逐帧）。
>
> **第三层的文档/登记收口**：见下方步骤 3 的清单。**主要项已完成**（2026-09-18 复核）：
> `tui/AGENTS.md` 的 §0.8 修饰键口径、三档 tracking、`KHY_SELECT_*` 三行与排障表均已就位；
> `App.js` 的 `_mainContentLines` 契约与 `width` 死 prop 注释、`[DESIGN-ARCH-101]` §8 第 6 条
> 「已修但被绕过」、索引摘要行均已补齐。
>
> ---
>
> ## 独立复核（2026-09-18，第三方复跑，非本文作者）
>
> **结论：三层均已真实落地，接线逐点核到代码，不是文档自述。**
>
> | 验收项 | 命令 | 实测 |
> |---|---|---|
> | 修复前后对照 | `node docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 鼠标拖选修复前后对照-2026-09-17.js` | 空白/Shift 按下由「吞」变「放行」；滚轮与按钮仍「吞」 |
> | 端到端接线 | `node docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 鼠标拖选端到端接线验证-2026-09-17.js` | **17/17** |
> | 反例矩阵 R1–R13 | `node docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 鼠标拖选修复验收-2026-09-17.js` | **17/17** |
> | 自绘选择逻辑链 | `node docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 应用内自绘选择-端到端验证-2026-09-17.js` | **17/17** |
> | 真 ink 渲染器 | `node docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 应用内自绘选择-真渲染器验证-2026-09-17.js` | **13/13** |
> | 单元测试（5 文件）| `node --test tests/cli/tui/{selection,mouseNativeSelection,mouseSelectEvent,viewportSelection,mouseWheel}.test.js` | **61/61** |
>
> 接线核对点：`App.js:1431` `onSelectEvent` 定义、`App.js:1530` 挂入 dispatcher、
> `App.js:1504` `writeClipboard`、`App.js:6197` 给 Viewport 传 `selection`；
> `flagRegistry.js:2849-2851` 三个 `KHY_SELECT*` 已登记。
>
> ⚠ **`docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 鼠标拖选根因探针-2026-09-17.js` 会报 3 条 FAIL，这是设计内的，不要修。**
> 它是**修复前快照**：断言 `parseSgrMouse` 不暴露 `isShift/isAlt/isCtrl`（期望 `undefined`），
> 而实测已是 `boolean` —— 恰好反证修复已落地。该文件的价值是留证，不是回归门。
>
> 🔴 **未收口（唯一实质风险）：整条修复尚未进入版本库。** 复核时 `selection.js` 与
> `selection.test.js` / `mouseSelectEvent.test.js` / `viewportSelection.test.js` /
> `mouseNativeSelection.test.js` / `mouseWheel.test.js` 等均为 **git 未跟踪（`??`）**；
> `mouseButtons.js` / `App.js` / `Viewport.js` / `flagRegistry.js` / `tui/AGENTS.md` 等为
> **已改未提交（` M`）**。本文 §八 要求「2a / 2b-0 / 2b-1 / 2b-2 分开提交」，
> 但**一次都没提交**——700+ 行新代码只存在于工作区，一次误清理即丢失。


---

## 一、现象与复现

用户在 khy TUI 里**拖选文本 → 无法选中/无法复制**。`Shift+点击` 同样无效（文档承诺
「永远走终端原生选择」）。终端的滚轮翻历史也一并失效。

复现（无需改任何代码）：

```bash
# 1) 装上探针,直接读真实模块的判定
cd D:/Portable/khy-os && node .khy/tmp/mouse-select-probe.js

# 2) 想看清楚鼠标事件去了哪,开诊断
KHY_TUI_DIAG=1 khy     # 每次鼠标事件解析结果打到 stderr
```

`KHY_TUI_DIAG=1` 的观察结果：**每一次按下/松开/滚轮都打印了事件行** —— 这本身就是证据：
SGR 序列进了本进程的 stdin，说明终端正处在 mouse tracking 态、且事件被本进程消费。

---

## 二、实测根因（三条独立缺陷）

> 三条**必须各自修**：修好任意两条，用户仍然复制不了。这是第一层方案的核心结论。

### 缺陷 A ——「拖选不受影响」的推理是错的

`mouseButtons.js` 头部第 47 行断言：

> 「1000 不报位移，拖选从来不会变成本进程的事件，原生选择完整保留」

**这条是错的。** `1000`（X11 basic）上报的是**按下/松开与位移的差集**——它确实不报
`motion`，但**按下那一下是 press**（SGR `button=0`，无 `32` 位移位）。而 dispatcher 对
press 无条件 `return true`：

```js
// mouseButtons.js:539-557(修复前)
if (ev.isPress) {
  if (hitTest(layout, ev.col, ev.row, offset)) { pendingClick = true; }
  return true;          // ← 无论命中与否都吞掉
}
```

Swift 的实测判据（探针输出如实）：

```
PASS  空白处左键按下被吞(现状=bug)          实得=true
PASS  Shift+左键按下被吞(现状=违约 §6.2)    实得=true
```

**为什么「空白处按下」也被吞才是致命的**：终端原生拖选是一个**原子手势**——它需要
看到完整的一次「按下 → 拖 → 松开」。按下那一下被本进程吃进 stdin 后，终端**永远等不到
起点**，于是此后整段拖动在它眼里只是一团无主的位移。这正是 `DESIGN-ARCH-102` §6.2
注释里已经写对过的话（「拖选透传补不回来:触发的那一下已经进了 stdin」），但它只被用来
解释「滚轮那一下丢失」，**没有被用来否掉「拖选不受影响」这个结论**——注释自相矛盾。

改档到 `1000` 只消灭了 `motion` 上报，**press 还在**，所以 `pendingSelect` 被删掉之后，
拖选并没有「自动恢复正常」，而是**从「补偿失败」变成「完全无补偿」**。

### 缺陷 B —— `Shift` 修饰位被解析但被丢弃（直接违约 §6.2）

`DESIGN-ARCH-102` §6.2 有一条硬承诺：

| 项 | 规则 |
|---|------|
| **Shift + 任何鼠标操作** | **永远走终端原生选择**，程序不拦截 |

SGR 里 Shift 是 `button` 的低位修饰位（`1`=Shift… 实际为 `4`，见下），`parseSgrMouse`
把整个 `button` 码存了下来，**但从不拆出修饰位**：

```js
// mouseButtons.js:100-108 —— 返回对象里没有 isShift / isAlt / isCtrl
return { button, col, row, isPress, isRelease, isMotion, isWheel };
```

`wheelDirection` 里用了 `button & ~28`（剥 Shift 4 / Meta 8 / Ctrl 16 三个修饰位）
——**证明作者知道修饰位的存在**，只是没在 press 分支用它。探针实测：

```
PASS  parseSgrMouse 暴露 isShift 字段    实得="undefined"
PASS  parseSgrMouse 暴露 isAlt 字段      实得="undefined"
PASS  parseSgrMouse 暴露 isCtrl 字段     实得="undefined"
```

⇒ `Shift+点击/拖选` 的按下照样进 `ev.isPress` 分支、照样 `return true`。终端没收到，
原生选择无从启动。**文档承诺了，代码从不认识它。**

### 缺陷 C —— 备屏强制接管，绕过「未知终端不接管」的保护

`[DESIGN-ARCH-102]` §6.2 与 `[DESIGN-ARCH-101]` §8 第 6 条要求：三档默认 `click`，
**未知终端不接管**（`autoDetectTerminal` 兜底由 `true` 改 `false`）。`mouseButtons.js` 的
`autoDetectTerminal` 确实已改成 `return false`。但 `app.js:288-291` 的合成判定把
它整个绕过去了：

```js
// app.js:288-291
const _explicitOff = mouseButtons.mouseExplicitlyDisabled(process.env);
const _wantMouse =
  mouseButtons.mouseButtonsEnabled(process.env, process.platform) ||
  (ALT_SCREEN_ENABLED && !_explicitOff);      // ← 备屏开 → 恒 true
```

因为 `ALT_SCREEN_ENABLED` 在 **legacy 模式默认 `1`**（`app.js:255`），所以：

```
PASS  mouseButtonsEnabled({}) 无终端标识时不接管            实得=false   ← 保护有效
PASS  mouseExplicitlyDisabled({}) 默认未显式关              实得=false
PASS  默认(备屏开)= 强制接管鼠标 → 用户失去原生拖选          实得=true    ← 但被绕过
```

**只有用户显式 `KHY_MOUSE=off` 才救得回来**——而用户根本不知道有这个开关（`khy` 的
`/help` 里没有它）。文档写「默认不劫持」，实际是「默认劫持，除非你懂这个 env」。

> 缺陷 C 的**存在理由是站得住的**：备屏没有回滚缓冲，不接管滚轮就会被终端合成 `↑/↓`、
> 变成输入历史回溯（§0.9.3 的根因）。所以 **C 不能简单删掉**——它必须被**替换**：
> 从「接管鼠标来保住滚轮」换成「滚轮与选择都由应用自绘消化」。见 §四。

---

## 三、为什么「二选一」不再是约束 —— 三个参考项目的实证

### 3.1 v1 的框架及其边界

v1 得出过一个正确但有边界的结论：

| 需求 | 靠什么通道 | 与鼠标通道的关系 |
|---|---|---|
| 滚轮滚动 | 可改道键盘通道（`1007` 合成 `↑/↓`）| 与追踪模式可解耦 |
| **原生拖选** | 需要鼠标通道**完全关闭** | press 一进 stdin 就被 ink 读走，`return false` 物理上还不到终端 |
| 点击按钮 | 需要鼠标通道**开启** | 与拖选互斥 |

**这个互斥是真的**——只要「拖选」的定义是「由**终端**执行的原生选择」。v1 据此认为三项
不可兼得，唯一的出路是赌 `?1007h` 在 Windows Terminal / kitty / iTerm2 上的兼容性。

**边界在于**：这三个项目并没有放弃，而是**换掉了「拖选」的实现方**。

### 3.2 Claude Code：把选择从终端手里拿回来

CC 全屏模式（`FullscreenLayout.tsx` + `VirtualMessageList.tsx` + `Messages.tsx`）的做法：

1. **上下文回滚不靠终端 scrollback，靠自绘视口虚拟化**。窗口化渲染只画可见行，配一种
   "blit" 策略——屏幕未变化的段不重画，直接把旧字符搬过去。所以「备屏无回滚缓冲」这个
   前提对它不成立：回滚由它自己的视口提供。
2. **选择由应用自绘**，配三个已文档化的交互：
   - 拖选任意文本；
   - **双击选中一个词**，明确「matching iTerm2's word boundaries so a file path selects
     as one unit」；
   - **三击选中整行**；
   - **松手即自动复制**（"Selected text copies to your clipboard automatically on mouse
     release"），`/config` 里的 *Copy on select* 可关掉。
3. **键盘全有等价键**（这对本仓 P6 是硬要求）：有选区时 `Shift+方向键` 从键盘扩展选区；
   `Shift+↑/↓` 在选区顶到上下边缘时滚动视口；有选区时 `Ctrl+c` 复制。
4. **剪贴板多通道**：本机工具链（pbcopy / xclip / wl-copy / PowerShell）→ tmux buffer →
   SSH 下 OSC 52 兜底。
5. **三条逃生舱**（是补充，不是主路）：启动时打印本终端对应的原生选择修饰键；
   `Ctrl+O` 转录模式把整段会话灌进原生 scrollback；`v` 写临时文件开 `$VISUAL/$EDITOR`。

### 3.3 opencode：另一条路，不建议照抄

opencode 有 `HighlightStyle` / `SelectedHighlightStyle` / `SetHighlights` /
`HighlightNext` / `HighlightPrevious` —— 但这是**高亮区间 API，服务于它自己的导航，
不产出可复制文本**。它的真复制走 textarea 的 `ctrl+e` 开 `$EDITOR`。即 opencode 偏向
「原生选择 + 外部编辑器」。**本仓不适合走这条**：`$EDITOR` 往返会打断 TUI 会话模型，
且用户要的是「就地选中就地复制」。

不过它有一个对本仓有直接价值的旁证：viewport 的 `MouseWheelDelta = 3`，且它的
`scroll_acceleration`（惯性滚动）**要求逐格精确的滚轮事件** —— 这反证了滚轮通道不可
被合成方向键替代，**滚轮必须保住**（与本仓 §0.9.3 结论一致，且互为独立验证）。

### 3.4 claude-code-best

继承 CC，无独立实现。可不必单独跟踪。

### 3.5 结论：从「二选一」到「三层各自成立」

| 需求 | v1 的路径 | v2 的路径 |
|---|---|---|
| 滚轮 | 赌 `?1007h` 合成 `↑/↓`（兼容性未验证）| **应用内视口消化**（既有，`onWheelScroll`）|
| 拖选 | 只能靠终端原生；与点击互斥 | **应用自绘选择**，终端不参与 |
| 点击 | 鼠标通道开 | **鼠标通道开**（不变）|

⇒ 三项同时成立的代价不是「赌一个终端特性」，而是「自己实现一个选择层」。
`?1007h` 从**主路**降为**可选实验**（见 §4.4）。

---

## 四、方案：三层

### 4.0 分层与依赖关系

```
第一层  判据收窄（已完成）        ← 让原生路径可用（Shift 放行 + 空白处不吞）
第二层  应用内自绘选择（本版新增） ← 让「滚轮 + 拖选 + 点击」同时成立，不依赖终端
第三层  逃生舱与门控登记（待办）   ← 让默认值可发现、可回退
```

**三层是独立的**：每一层单独合入都能改善用户处境，不存在「必须全做完才有收益」。
这一点是刻意的设计约束（对齐 `SOURCING-006`：一次提交只做一步）。

### 4.1 第一层：按**事件类别**决定吞不吞（已完成）

现状的三档是「一个开关管所有鼠标事件」，第一层把 `click` 档**再细分一层**：

| 事件 | 原状 | 改为 | 理由 |
|---|---|---|---|
| **滚轮** `64/65` | 吞（走 `onWheel`）| **仍吞** | 备屏无回滚缓冲，交还终端会被合成 `↑/↓` → 输入历史回溯。**必须接管** §0.9.3 |
| **含 `Shift` 的任意事件** | 吞 | **放行**（`return false`）| §6.2 明文承诺；`Shift` 是终端的「我要原生选择」约定键 |
| **纯左键按下/松开（无修饰、未命中按钮）** | 吞 | **放行** | 终端原生拖选需要完整手势；本进程拿这一下没有任何用（`pendingClick` 只服务按钮） |
| **命中按钮的左键按下/松开** | 吞 + 触发 | **仍吞 + 触发** | 这是 click 档存在的唯一理由，且两者都有等价键位（Alt+M / Esc）|
| **`Alt`/`Ctrl` + 任意事件** | 吞 | **放行** | 同上：修饰键 = 用户想要终端行为 |

**关键洞察**：`pendingClick` 的语义本来就是「按下落在**按钮**上才 arm」。原代码却
**先吞、再判断命中**；改成**先判断命中、未命中就不吞**，`pendingClick` 的语义一个字都不用动。

#### 4.1.1 三分支判据（写死，不可绕过）

```js
// parseSgrMouse 返回值新增三个**纯派生**字段(不改 button 语义,向后兼容)
const isShift = (button & 4) !== 0;
const isAlt   = (button & 8) !== 0;
const isCtrl  = (button & 16) !== 0;
```

```js
// createMouseDispatcher.onInput 里,在既有 wheel / motion / press-release 三个分支之前
// 插一条**前置放行**判据(顺序是根因级的关键:必须在 wheel 判定之后、press 判定之前)
//
//   ⚠️ shift+滚轮 必须仍然走 wheel 分支(终端里 Shift+滚轮的语义就是横向滚动,
//      不是「我要拖选」)—— 所以放行判据里要排除 isWheel。
if (!ev.isWheel && (ev.isShift || ev.isAlt || ev.isCtrl)) {
  return false;            // 不消费
}
```

```js
// press 分支:未命中按钮 → 不吞
if (ev.isPress) {
  if (hitTest(layout, ev.col, ev.row, offset)) {
    pendingClick = true;
    return true;           // 命中按钮:吞(click 档的核心价值)
  }
  return false;            // 空白处按下:不吞 → 终端看到完整拖选起点
}
// release 分支:同样,未 arm 过 click 且未命中按钮 → 不吞
```

> **关于「`return false` 是否真能到达终端」**：ink 的 `useInput` 无「已消费」语义，
> `return false` 不改变 ink 的转发行为——**事件已经被 ink 从 stdin 读走了**，物理上回不到
> 终端。这是本方案必须诚实说清的一点：**第一层的可达性依赖终端自身对 `Shift` 的处理**。
>
> 实测依据：`[DESIGN-ARCH-102]` §6.2 把 `Shift+鼠标` 列为「程序不拦截」的约定键，
> 而这是 **xterm / Windows Terminal / kitty 的通用约定**——它们**不把 `Shift+鼠标` 的
> 按下送进 tracking 报告**。因此对 `Shift` 路径，放行是**双保险**。
>
> **对纯左键拖选（无 `Shift`）**，第一层**必要但不充分**——这正是第二层存在的理由。

### 4.2 第二层：应用内自绘选择（本版核心）

> **⚠ 前置条件（2026-09-17 核验发现，原方案遗漏，属致命缺口）**：
> **拖动事件在当前追踪模式下根本收不到。**
>
> 实测 `mouseButtons.js:261-267` 的 `enableBytes()` 只写 `?1000h` + `?1006h`：
>
> ```js
> let out = '\x1b[?1000h\x1b[?1006h';   // ← 没有 1002h
> if (hover) { out += '\x1b[?1003h'; }
> ```
>
> 全仓检索确认 **`1002h` 从未被写入**（只有 `1000h` 与 `1003h` 两处）。
> `1000` 的语义是**只报按下/松开，位移一个都不报** —— 头部注释明说
> 「1000 只报『按下 / 松开』,一个位移事件都不报 —— 这正是我们要的」。
>
> 而 4.2.6 的交互表要求「拖动 → `extendSelection` → 反色重绘」，`A-01`/`A-02`
> 也假设位移事件可达。**在 `1000` 档下，拖动期间本进程收不到任何事件**，
> 松手时只能拿到终点，选区要么是零宽、要么退化成「点两下选整段」。
>
> ⇒ **第二层必须先决定追踪档位**，这是本层第一个待决问题，不是实现细节：

| 候选 | 字节 | 拖动可行性 | 代价 | 结论 |
|---|---|---|---|---|
| **`1000`（现状）** | `?1000h` | ❌ 无位移 | 无 | 自绘拖选**不可行**，只能做「两次点击选区间」 |
| **`1002`（推荐）** | `?1002h` | ✅ 按住期间报位移 | 拖动期间本进程独占鼠标 | **推荐**：正是自绘选择需要的粒度 |
| `1003` | `?1003h` | ✅ 全位移 | 60~120Hz 洪流，且**必然**吞掉终端原生拖选 | 不采用（`hover` 档已有明确定位） |
| `1007` | `?1007h` | — | 备屏滚轮合成 `↑/↓` | 与选择无关，见 §4.4 |

**`1002` 的取舍必须在计划里写明**：启用 `1002` 意味着拖动期间鼠标归本进程，
**用户彻底失去终端原生拖选**（这正是 v1 认为不可两全的原因）。而第二层的整个
立论就是「不再需要终端原生拖选」——所以这个代价是**可接受的、且是自觉付出的**。
两者不能同时要：**要么 `1000` + 依赖终端原生（第一层路径），要么 `1002` + 自绘（第二层路径）。**

> **实现顺序建议**：`KHY_SELECT` 开 → 写 `?1002h`（替换 `?1000h`）；关 → 逐字节回到
> `?1000h`。这样两层的回退路径都是干净的。**写 `1002h` 的具体落点是 `enableBytes()`，
> 由它按「选择层是否开启」决定写 `1000` 还是 `1002`** —— 不要在 `app.js` 里再拼一遍字节，
> 那会造出第二处真源。

#### 4.2.1 关键洞察：屏幕行 == 数组下标

> **⚠ 前置条件（2026-09-17 核验补充）**：这条不变量**不是自明的**，它依赖两个既有事实：
>
> 1. `_mainContentLines` 里的每一行**已经被 `buildTranscriptLines` 按列宽折好**
>    （见 `App.js:5277-5283` 的列宽注释）；
> 2. `Viewport` 的 lines 模式用 `overflow: 'hidden'` **截断**而非软换行
>    （`Viewport.js:111` 的注释明说这是硬闸）。
>
> ⇒ 视觉行数**恰等于** `lines.length`，所以屏幕行 == `数组下标`。
>
> **但 `App.js:5943` 传给 `Viewport` 的 `width: _railCols(0) || _resCols || 80`
> 是一个死参数 —— `Viewport` 从不读 `width`（全文件 0 命中）。** 它是历史残留，
> 造成「宽度已受控」的假象。实现者**不得**因为看到这个 prop 就以为渲染层会按它折行。
>
> 若将来 `Viewport` 改为按 `width` 软换行，或 `overflow` 由 `hidden` 改掉，
> **本不变量立刻失效**，`A-xx`/`V-xx` 的坐标换算会整体错位。
> 因此 §八 步骤 2b 要求：把这条不变量写成 `Viewport.js` 与 `selection.js` 两侧的注释。

第二层的可行性**几乎全部**来自一个既有事实：本仓的消息区已经是一个扁平字符串数组，
且视口按 `height` 直接切片渲染。

```js
// App.js:5275  —— 已存在
const _mainContentLines = React.useMemo(() => { ... return lines; }, [...]);  // string[]

// Viewport.js:47-66  —— 已存在,lines 模式
const start = clampedScroll;
const end = Math.min(totalLines, clampedScroll + height);
const visible = lines.slice(start, end);
```

⇒ **屏幕第 N 行就是 `_mainContentLines[clampedScroll + N]`**。行列 ↔ 文本位置的换算
**不需要任何布局反查**（不需要 `collectLayout` 那棵树的 DFS）。CC 要做窗口化 + blit，
本仓已经拥有上半截。

同时，命中所需的坐标**已经在手**：`createMouseDispatcher` 的 press/motion/release
三个分支都已拿到 `ev.col / ev.row`，且已有
`offset = screenOffset(layout.height, ctx)` 能把屏幕行换算成 root 相对行。

#### 4.2.1b 接线点：必须在 4176 块**内**，不能在其后

> **⚠ 2026-09-17 核验发现（原方案未指明，会导致「写了但从不执行」）**：
> `App.js:4176-4215` 的鼠标分支**不接收 `onInput` 的返回值**，且在末尾无条件 `return`：
>
> ```js
> if (_mouse && mouseDispatcherRef.current && _mouse.isMouseSequence(input)) {
>   try {
>     mouseDispatcherRef.current.onInput(input, { ... });   // ← 4200:返回值被丢弃
>   } catch { /* fail-soft */ }
>   return;                                                 // ← 4214:之后一切被吞
> }
> ```
>
> ⇒ **选择层若接在 4176 块之后，永远不会被执行**（那块已经 `return` 了）；
> 接在 4200 之后、4214 之前则可行但脆弱（`try` 块内，异常会静默吞掉）。
>
> **正确接法（二选一，推荐 A）**：
> - **A（推荐）**：把选择处理做成 dispatcher 的一个回调（如 `onSelectEvent`），
>   由 `createMouseDispatcher` 在 press/motion/release 分支里调用 —— 与既有的
>   `onWheel`/`onNative` 完全同构，`mouseButtons.js` 已经是「按事件类别分派」的形状。
> - **B**：在 `App.js:4200` 处接收返回值：`const consumed = onInput(...)`，
>   仅当 `!consumed` 时再喂选择层。**这会改变既有语义**（现在返回值无人消费），
>   风险高于 A。
>
> 方案 A 同时解决另一个问题：它让选择层的单元测试可以**不依赖 React**（`A-xx` 的可测性要求）。

#### 4.2.2 高亮原语已在生产使用（不是新赌注）

ink `Text` 的 `inverse` prop 在本仓**已经跑在真实界面上**：

| 位置 | 用途 |
|---|---|
| `PromptFrame.js:408` | vim NORMAL 模式的实心光标块 |
| `QuestionPrompt.js:440` | 问卷光标字符 |
| `QuestionPrompt.js:454` | 问卷表头反色 |

⇒ 给选区上反色**是已验证能力**，不需要引入任何新依赖或新渲染路径。

#### 4.2.3 剪贴板写入半边已经齐了

```js
// utils/ccClipboard.js  —— 已存在,统一出口
writeClipboard(text) → { ok, channels: ['native'|'osc52'], bytes, reasons }
```

实测确认本地默认路径就是 `native-only`（正是松手即复制需要的）：

```
shouldEmitOsc52(process.stdout, {})
  → { on: false, reason: 'tty' }        // stdout 是 TTY → 不发 OSC 52(喷在画面上会污染)
→ writeClipboard 走 nativeWrite():powershell Set-Clipboard / pbcopy / xclip / wl-copy
```

`KHY_CLIPBOARD_DUAL=1` 时 native 成功后补发 OSC 52 —— 供「本地写成功但用户在
tmux/SSH 嵌套另一端看屏幕」的复合场景。**SSH 场景需单独验证**（见 §七 风险 2）。

⇒ 第二层**只缺「选择模型」这一半**，写入与渲染两侧都已就绪。

#### 4.2.4 选择模型（纯叶子，可独立测试）

新增 `services/backend/src/cli/tui/selection.js` —— 与 `scrollActions.js` 同范式：
**零 IO、绝不抛、纯函数**。

```js
// 选区锚点(anchor)与活动端(head),均为 {line, col}(屏幕坐标 → 数组下标)
createSelection()                       → { anchor: null, head: null, dragging: false }
beginSelection(sel, line, col)          → 新 sel(按下)
extendSelection(sel, line, col)         → 新 sel(拖动)
endSelection(sel)                       → 新 sel(松手,dragging=false)
hasSelection(sel)                       → boolean
normalizeSelection(sel)                 → { startLine, startCol, endLine, endCol }(有序化)
expandToWord(lines, line, col)          → 新 sel(双击;iTerm2 词边界口径)
expandToLine(lines, line)               → 新 sel(三击)
extractText(lines, sel)                 → string(按选区抽文本,跨行用 \n 连接)
```

`expandToWord` 的边界口径必须与 CC 对齐：**把一条文件路径当作一个词**。实现要点是
词字符集取 `[A-Za-z0-9_./\\:~-]`，而不是朴素的 `\b`（`\b` 会在 `/` 和 `.` 处断开，
路径会被切碎 —— 而「复制一条路径」是本仓最高频的复制场景）。

`extractText` 的两个边界：
- 首行从 `startCol` 切、末行到 `endCol` 切、中间行整行取；
- **按显示宽度截断的软换行行要不要补 `\n`** —— 本仓 `_mainContentLines` 里已经含
  `buildTranscriptLines` 折好的软换行（见 `App.js:5277-5279` 的列宽注释），所以视觉行
  不等于逻辑行。v2 的取舍：**首版按视觉行原样连接**（复制长段落会带硬换行），
  另立 `softWrap` 元数据作为后续改进（见 §六 不做的事 4）。

#### 4.2.5 渲染接线

`Viewport.js` 的 `lines` 模式增加一个**可选** prop：

```js
// Viewport.js lines 模式内,渲染每一行时
const rowText = line || ' ';
const sel = selectionRangeFor(selection, start + i);   // 纯函数,返回 null 或 { from, to }
if (sel) {
  rows.push(h(Box, { key }, ...[
    h(Text, null, rowText.slice(0, sel.from)),
    h(Text, { inverse: true }, rowText.slice(sel.from, sel.to) || ' '),
    h(Text, null, rowText.slice(sel.to)),
  ]));
} else {
  rows.push(h(Box, { key }, h(Text, null, rowText)));
}
```

**不传 `selection` 时行为逐字节不变**（向后兼容，符合本仓「零副作用的双保险」习惯）。

> **一个必须处理的坑**：软换行的行若被切断，`rowText.slice()` 拿到的仍是该视觉行的
> 字符串，视觉上正确；但 `extractText` 跨行拼接时会在软换行处插 `\n`。
> 首版接受此行为，并在 `selection.js` 头部注释里写明「已知偏差 + 后续改进方向」。

#### 4.2.6 交互绑定（与 CC 对齐，且满足 P6）

| 手势 | 行为 | 键盘等价（P6 硬要求）|
|---|---|---|
| 按下 | `beginSelection(line, col)` | — |
| 拖动 | `extendSelection(line, col)` + 反色重绘 | `Shift+方向键` 扩展 |
| **松开** | `endSelection()` + **若 `hasSelection` → `writeClipboard(extractText(...))`** | 有选区时 `Ctrl+C` 复制 |
| 双击 | `expandToWord` | — |
| 三击 | `expandToLine` | — |
| 选区顶到视口边缘 | 滚动视口并继续扩展 | `Shift+↑/↓` 同语义 |
| `Esc` | 清空选区 | — |
| 任意其他按键 | 清空选区（与 `exitNativePassthrough` 现有纪律一致）| — |

> **「松手即复制」必须可关**（CC 的 *Copy on select* 是 `/config` 开关）。本仓用门控
> `KHY_SELECT_COPY_ON_RELEASE`（默认开，见 §4.3.2）。

**与 `Ctrl+C` 的冲突必须处理**：本仓 `Ctrl+C` 已是「中断当前请求」。取值优先级：

```
有选区  → Ctrl+C = 复制选区(且不中断)
无选区  → Ctrl+C = 中断(现状不变)
```

这与 CC 完全一致（"With a selection active, `Ctrl+c` copies"），且**不侵占既有语义**
——因为「有选区」是一个用户刚刚主动建立的、明确的瞬时状态。

#### 4.2.7 鼠标通道的最终形态

第二层落地后，追踪档位**从 `1000` 升到 `1002`**（见 4.2 前置条件），三类事件各有归属：

| 事件 | 归属 | 变化 |
|---|---|---|
| 滚轮 | `onWheel` → 应用内视口 | 不变 |
| 按钮上按下/松开 | `pendingClick` → `onClick` | 不变（**点击需求保住**）|
| **空白处按下** | **选择层 `beginSelection`** | **新增** |
| **空白处拖动（位移）** | **选择层 `extendSelection`** | **新增 —— 依赖 `1002`** |
| **空白处松开** | **选择层 `endSelection` + 复制** | **新增** |

⇒ **v1 的互斥消失了**：拖选不再与点击争同一个通道，因为拖选搬到了应用层。

**但要精确说清代价**：启用 `1002` 后，**拖动期间鼠标完全归本进程**，
用户**不再能从终端原生拖选**（终端收不到拖动的起点与位移）。
这不是 bug，是本层自觉付出的代价 —— 换来的是「不依赖终端即可选中并复制」。
若用户坚持要终端原生选择，退路有二：
1. `KHY_SELECT=0` → 回到 `1000` + 第一层（`Shift` 与空白处放行）；
2. `KHY_MOUSE=off` → 完全不接管（同时失去滚轮，仅在主屏幕下可接受）。

**第一层因此不能回退**：`Shift` 放行在第二层存在时仍有价值 ——
`Shift+拖选` 在多数终端上**根本不进 stdin**，那是终端侧的能力，两层并存不冲突。

### 4.3 门控与可回滚性

#### 4.3.1 新增门控（全部经 `flagRegistry.js` 登记）

| 门控 | 默认 | 作用 |
|---|---|---|
| `KHY_SELECT` | 开 | 自绘选择层总开关。关 → 三档行为与第一层完成时逐字节一致 |
| `KHY_SELECT_COPY_ON_RELEASE` | 开 | 松手即复制。关 → 只反色选中，复制走 `Ctrl+C` |
| `KHY_SELECT_WORD_BOUNDARY` | 开 | 双击词边界走「路径友好」集。关 → 用朴素 `\b` 口径 |
| `KHY_SELECT_MAX_BYTES` | `100000` | 单次复制上限，超出截断并提示（对齐 `ccClipboard` 的 OSC 52 上限）|

#### 4.3.2 为什么必须可回滚

第二层是**新增渲染路径**，一旦有终端/ink 版本的边界问题，必须能一行关掉回到第一层的
已知良好状态。这与 `KHY_INLINE_TRANSCRIPT` / `KHY_CC_CLIPBOARD` 的既有纪律一致。

### 4.4 `?1007h` 的降级处理（从主路到可选实验）

v1 把 `?1007h`（备屏滚动 → 合成 `↑/↓`）当作唯一出路。v2 中它**不再是必需**，但作为
「让终端原生滚轮也工作」的独立改进仍有价值，因此：

- **不进第一层、不进第二层**；
- 单独立项，作为**可独立回滚的实验**，前置条件是先实测三个终端
  （Windows Terminal / kitty / iTerm2）是否支持 `?1007h`，以及合成的 `↑/↓`
  是否与真实按键字节可区分（`\x1bOA` vs `\x1b[A`）；
- 若实测不通过，**不影响本方案任何一层**——这正是把它移出主路的收益。

> **opencode 的旁证支持保留滚轮通道**：它的 `scroll_acceleration` 依赖逐格精确滚轮事件，
> 而合成方向键会丢失「一格」的信息。⇒ 即便 `1007` 可用，也只应作为**兜底**，
> 主路仍是 `onWheel` 应用内消化。

---

## 五、与既有机制的边界表

| 既有件 | 它管什么 | 本方案做什么 | 边界（不重叠在哪）|
|---|---|---|---|
| `mouseButtons.js` `wheelDirection` / `onWheel` | 滚轮 → 应用内视口（§0.9.3）| **不动** | 滚轮语义完全不变；放行判据显式排除 `isWheel` |
| `enterNativePassthrough` / `onNative`（`App.js:1210`）| 滚轮「交还终端」的 1500ms 窗口 | **不动**（保留为 `onWheel` 缺失时的回退）| 本方案不发 `onNative`；两条路径正交 |
| `pendingClick` 状态机（`mouseButtons.js:427`）| 按下命中按钮 → 等松开触发 | 只把「吞」变成「命中才吞」| 状态机本身语义零改动 |
| **`_mainContentLines`**（`App.js:5275`）| 消息区行投影（扁平 `string[]`）| **只读消费**，不改投影逻辑 | 第二层依赖它「屏幕行 == 下标」这一性质；若将来改成分段结构，需同步 `selection.js` |
| **`Viewport.js` `lines` 模式** | 有界视口切片渲染 | **加可选 `selection` prop** | 不传即逐字节不变 |
| `scrollActions.js` / `applyStickyViewportAction` | 视口偏移算术 | **不动** | `selection.js` 与它同范式但职责独立 |
| `ccClipboard.writeClipboard` | 已有文本 → 剪贴板 | **直接复用，不改** | 第二层补的是「选中」，不是「写入」 |
| `CcSelectable` / `CcPermissionPrompt` | 列表**键盘**导航 | **不动** | 那是应用内语义选择，不是文本选择 |
| `[DESIGN-ARCH-102]` §6.1 `v`/`y`（消息选择模式）| 应用内选择模式 | **由第二层实质兑现，标注对齐** | 见 §八 步骤 3；不再是「deferred 且无载体」 |
| `[DESIGN-ARCH-102]` §0.9.2 帧高约束 | live 区高度账本 | **不动** | 第二层不新增任何固定高度节点（选择层是覆盖态，不是新节点）|
| `ink` `Text` `inverse` prop | 反色渲染 | **复用** | 已在 `PromptFrame.js:408` 等三处生产使用 |

---

## 六、诚实边界：本方案**不**做什么

1. **不做「拖选透传补偿」**。`pendingSelect` 被删是对的——补偿永远补不回起点
   （按下已被吃掉）。第二层是**换实现方**，不是事后补。
   > 注意：第二层确实**新开**了 `1002`（见 2b-0），但这不是「透传补偿」——
   > 补偿的错在于「想把终端的选择还回去」，而第二层是「自己画、自己复制」，
   > 不需要终端参与选择。两者方向相反。
2. **不接管 `Alt`/`Ctrl` 拖选以外的终端功能**（搜索、链接点击等）。终端的归终端。
3. **不改 `KHY_MOUSE=full`（`1003`）的默认值**。`1003` 是 60~120Hz 洪流，
   继续维持「显式 opt-in + 文档写明代价」。
   > 与 2b-0 的区别：2b-0 开的是 `1002`（**仅按住期间**报位移），默认随
   > `KHY_SELECT` 开；`1003`（**任何移动都报**）仍只在 `mouseTier==='full'`
   > 且用户显式设置时才开。两者不是一回事，不要合并。
4. **不做软换行的逻辑行还原**。`_mainContentLines` 里已含按列宽折好的软换行，
   跨行复制会带硬换行。首版按视觉行原样连接，并在 `selection.js` 头部写明偏差。
   彻底修复需要行投影补 `softWrap` 元数据 —— **另立提案**，不并入本方案。
5. **不引入 `$EDITOR` 往返**（opencode 路线）。会打断 TUI 会话模型，且与「就地复制」
   的用户预期不符。仅作为**可选逃生舱**记录在 §4.2 的键盘等价表里（`v` 键，见步骤 3）。
6. **不做「按消息整体复制」**。首版是**自由文本选择**（与 CC 一致）。按消息复制需要给
   行投影加 sidecar 元数据（「第 N 行属于哪条消息」），当前 `buildTranscriptLines()` 只
   返回裸字符串，**没有这个信息** —— 这是第二层唯一的结构性缺口，见 §七 风险 1。
7. **不做「按住期间的终端原生拖选」**。这是 2b-0 引入的**已知代价**，且**无法消除**：
   `1002` 的语义就是「按键按下时报位移」，一旦开了通道，按住键的那段时间事件必然
   归本进程。缓解只有两条，都已在方案里：（a）`Shift` 前置放行（第一层已实现，
   不需要额外代码）；（b）`KHY_SELECT=0` 整体回滚。
   **不得**尝试「只在按下后延迟开/关 `1002`」之类的花招 —— 模式切换有往返延迟，
   且切换本身可能被终端吞掉，会制造比它解决的问题更多的不确定性（与 v1 删掉
   `pendingSelect` 是同一条教训）。

---

## 七、风险与未收口清单

1. **行投影缺元数据（第二层唯一结构性缺口）**。`buildTranscriptLines()` 返回
   `string[]`，无「行 → 消息/角色」映射。影响：
   - **不影响**自由拖选、双击选词、三击选行、松手复制（这些只需行内文本；
     三击的「整行」= 视觉行，与 CC 语义一致）；
   - **影响**「按消息复制」「选中后显示角色」等增强项。
   ⇒ 首版**不做**这些增强项；若将来要做，需新增 `buildTranscriptLineRecords()`
   并在 `selection.js` 侧定义消息边界。**建议在步骤 2 落地时于 `App.js:5275` 上方
   补一条注释，说明该数组当前是「纯文本投影、无元数据」这一契约**。

2. **SSH / tmux 场景下 OSC 52 的行为未验证**。本地 TTY 下 `shouldEmitOsc52` 返回
   `{on:false, reason:'tty'}`（实测）⇒ native-only，正确。但 SSH 远程时 native 写的
   不是用户面前的剪贴板，需验证 `KHY_CLIPBOARD_DUAL=1` 或转发层下 OSC 52 是否生效。
   **与本方案的关系**：第二层的「松手即复制」在 SSH 下会静默失败（`reasons.native` 有
   原因，但用户看不到）。⇒ 步骤 2 必须把 `writeClipboard` 返回的 `reasons` 接到一条
   **可见提示**（对齐工程规则「错误消息：问题+原因+修复」）。

3. **终端差异**：不同终端对 `Shift+鼠标` 的处理不一致（有的**不发送**序列，有的发送）。
   第一层对两种都正确。**真正的风险**是「发了、放行了、但终端仍不执行原生选择」
   （部分旧版 conhost）。缓解：第二层不再依赖它；`KHY_MOUSE=off` 始终是最后退路，
   且步骤 3 把它写进 `AGENTS.md` 门控表。

4. ~~**env 登记缺口（已实测，需一并修）**~~ —— **已在步骤 1 一并修掉，本项作废**。
   历史情况：`flagRegistry.js` 里 `KHY_MOUSE` / `KHY_MOUSE_BUTTONS` /
   `KHY_MOUSE_HOVER` / `KHY_ALT_SCREEN` / `KHY_MOUSE_WHEEL` 一个都没登记，
   用户无法通过界面发现自己有 `KHY_MOUSE=off` 这条唯一的 workaround。
   **2026-09-17 复核：五个 flag 均已登记**（`flagRegistry.js:2828-2832`，
   含一段 2810-2827 的注释块，明确指向本文），`tui/AGENTS.md` §1.2
   也已补全五行说明（`AGENTS.md:285-288`）。
   ⇒ **本条不再是待办**。剩余唯一未登记的是 2b-2 要新增的四个 `KHY_SELECT_*`。

5. **`v`/`y` 的文档-实现矛盾 —— 已收口，但留了一句待对齐的注**。
   `[DESIGN-ARCH-102]` §6.1 已于 2026-09-17 修正：`v`/`y` 标为「未实现（deferred）」，
   并补注指向本文。**矛盾本身解决了。**
   但该注仍称「应用内自主选择是另一条路、与原生拖选正交、优先级更低、保持 deferred」——
   这句话在第二层落地后不再成立（第二层正是应用内自绘选择，且已是**主路**）。
   ⇒ 步骤 3 第 15 步只补一句对齐说明，**不动键位表**：`v`/`y` 仍 deferred，
   本方案不实现它们；将来若实现，应定位为「键盘驱动的选区模式入口」。

6. **`[DESIGN-ARCH-101]` §8 第 6 条**已记录「默认值文档/实现矛盾」，但只判到
   `autoDetectTerminal` 的兜底值。**本次实测发现该条修得不彻底**——兜底确实改了，
   但 `app.js` 的备屏 `||` 分支又把它绕回了「默认接管」。台账应更新为「已修但被绕过」。

7. **第二层的性能边界**。选区重绘触发整行 `slice` 三段。单行成本可忽略，但
   `Viewport` 一次最多渲染 `height` 行（典型 20~40），且只在拖动的 motion 事件上重算
   （已有限流，`motionThrottleMs` 默认 30ms）。⇒ 无风险，但**必须在 `1003` 档
   （`mouseTier==='full'`，任何移动都发 motion）下也验证一遍**：`1002` 只在按住时
   发 motion，事件频率天然低；`1003` 是持续洪水，限流逻辑若在 `1002` 下没被真正压到，
   到 `1003` 才会暴露。两个档位各测一次。

8. **2b-0 的档位切换在异常退出路径上未验证**（本版新识别）。`app.js:360-363` 在
   teardown 时无条件写 `disableBytes()`（含 `?1002l`），所以正常退出是干净的。
   但**进程被 `SIGKILL` / 终端崩溃 / 断电**时不会走 teardown，终端会残留
   `1002` 态 —— 表现为「之后这个终端里按住鼠标拖动会输出乱码」。
   ⇒ **这不是本方案引入的新问题**（`1000h` 本来就有同样的残留风险，`disableBytes`
   的注释已承认），但 `1002` 让残留的**可见症状**更明显（出现 `[<32;...M` 文本）。
   缓解：文档里把 `KHY_MOUSE=off` / `reset` 写进排障表（步骤 3 第 16 步）；
   **不在本方案里加信号处理器**（`app.js` 已有 `_altScreenExitHooked` 基础设施，
   但复用它是独立改动，另立提案）。

---

## 八、落地清单（三层，一次提交只做一层）

> **注意**：本方案不新增 `scripts/ci/` 检查器、不改 `RULES-REGISTRY.json`、不改
> `package.json`、不动门档。改动集落在 `services/backend/src/cli/tui/` + 测试 + 文档。

### 步骤 1 —— 判据收窄（✅ 已完成）

1. `services/backend/src/cli/tui/mouseButtons.js`：`parseSgrMouse` 加三个修饰位字段；
   `onInput` 加前置放行（排除 `isWheel`）；press/release 改条件性吞；改掉头部错误断言。
2. `services/backend/tests/cli/tui/mouseNativeSelection.test.js`：R1–R13 场景（9/9 绿）。
3. 全 TUI 测试集 744/744 无回归。

验收：

```bash
cd D:/Portable/khy-os/services/backend
node --test tests/cli/tui/mouseWheel.test.js tests/cli/tui/mouseNativeSelection.test.js
```

### 步骤 2 —— 第二层：应用内自绘选择（本版新增，未开工）

> 拆成 **2a / 2b-0 / 2b-1 / 2b-2 四次提交**：2a 是纯逻辑（可独立测试）；
> **2b-0 是前置条件（tracking 档位）—— 不做这一步，2b-1/2b-2 写出来在真机上
> 一条拖动事件都收不到**；2b-1 是渲染；2b-2 才是交互接线。
> 这样 2a 可以在不碰 UI 的前提下先把选择模型测透，2b-0 可以在不碰选择逻辑的前提下
> 先把「事件能不能到达」这件事单独验证。

**2a —— 选择模型（纯叶子）**

> **验收标准已单独成文**，实现者直接据此写代码、据此判通过：
> [`[DESIGN-ARCH-119] TUI文本选择与复制-验收标准.md`]([DESIGN-ARCH-119] TUI文本选择与复制-验收标准.md)。
> 该文给出 `S-xx`/`V-xx`/`A-xx`/`X-xx`/`N-xx` 五组共 50+ 条用例的三段式
> （输入 → 期望输出 → 通过条件），并附**自验结果**（27/27 实跑绿 + 5/5 反例可检出）。

4. 新增 `services/backend/src/cli/tui/selection.js`：按验收标准 §1.1 的契约表实现
   12 个导出（`createSelection` / `beginSelection` / `extendSelection` /
   `endSelection` / `clearSelection` / `hasSelection` / `normalizeSelection` /
   `expandToWord` / `expandToLine` / `extractText` / `selectionRangeFor` /
   `wordBoundaryAt`）。零 IO、绝不抛。
   头部注释必须写明：**软换行视觉行 ≠ 逻辑行**这一已知偏差（§六 不做的事 4）。
5. 新增 `services/backend/tests/cli/tui/selection.test.js`：`S-01`–`S-37` 全部用例
   （覆盖核心功能、边界、异常、冻结性、规模、反例）。

**2b-0 —— tracking 档位（硬前置，不可跳过）**

> **为什么必须独立成一步**：`enableBytes()`（`mouseButtons.js:261-267`）当前**只写**
> `\x1b[?1000h\x1b[?1006h` —— 全仓库从未写过 `?1002h`（已 grep 确认，只有 `1000h` /
> `1003h` / `1006h`）。`1000`（X11 basic）**只报按下/松开，一个位移事件都不报**。
> 因此 2b-1/2b-2 写完后，在真机上**拖动过程中不会有任何事件到达**，
> `extendSelection` 永远不会被调用 —— `A-01`/`A-02`/`S-03` 在单测里绿、在真机上一片死。
> 这一步先把通道打通。

6. `services/backend/src/cli/tui/mouseButtons.js`：`enableBytes` 增加 `select` 参数。

   现状（`mouseButtons.js:261-267`）：

   ```js
   function enableBytes({ hover = false } = {}) {
     let out = '\x1b[?1000h\x1b[?1006h';
     if (hover) { out += '\x1b[?1003h'; }
     return out;
   }
   ```

   改为（**`select` 时把 `1000` 换成 `1002`，不是叠加** —— `1002` 已含 `1000` 的
   按下/松开语义，叠写只会让模式表更难读；`disableBytes()` 已经无条件写了
   `?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l`，所以**退出侧不需要改**）：

   ```js
   function enableBytes({ hover = false, select = false } = {}) {
     // select: 1002 = button-event tracking —— 仅在有键按下时报位移,
     //         这是「拖动」能收到事件的唯一档位(1000 完全不报位移;
     //         1003 报全部位移 = 60~120Hz 洪水)。
     let out = select ? '\x1b[?1002h\x1b[?1006h' : '\x1b[?1000h\x1b[?1006h';
     if (hover) { out += '\x1b[?1003h'; }
     return out;
   }
   ```

   > **`select` 与 `hover` 同时为真时**：`1003` 的语义包含 `1002`，两个都设时终端以
   > 最后设置的为准（即 `1003` 生效）。这是**可接受的** —— `hover` 只在
   > `mouseTier==='full'` 时为真（`mouseHoverEnabled`，`mouseButtons.js:203-208`），
   > 而 `select` 由 `KHY_SELECT` 独立控制；两者同开时拖动仍能收到事件。
   > **不需要**为此加互斥判断。

7. `services/backend/src/cli/tui/AGENTS.md` §0.9.x 补一行：`1000` / `1002` / `1003`
   三档的语义差，以及「选择层需要 `1002`」这一条 —— 避免后来者把 `select` 参数
   当成冗余删掉。

8. `services/backend/tests/cli/tui/mouseWheel.test.js`：补两条断言 ——
   `enableBytes()` 默认输出**逐字节等于** `'\x1b[?1000h\x1b[?1006h'`（回归护栏）；
   `enableBytes({ select: true })` 输出含 `'\x1b[?1002h'` 且**不含** `'\x1b[?1000h'`。

验收（2b-0 独立验收，不依赖任何 UI 代码）：

```bash
cd D:/Portable/khy-os/services/backend
node --test tests/cli/tui/mouseWheel.test.js
# 真机冒烟:临时把 app.js 的 enableBytes 调用改成 { select: true },开 KHY_TUI_DIAG=1 khy,
# 按住左键在正文区上下拖 —— 应看到连续 [mouse] motion 行。
# 看到即通;看不到说明这一步没做成,不要继续 2b-1。
```

> ⚠️ **本步的已知代价（须在 §六 显式登记）**：`1002` 打开期间，**按住键**的整段时间
> 鼠标事件归本进程所有，终端原生拖选在此期间不可用 —— 这正是 v1 说「互斥」的那个
> 约束，但它的作用域从「永久」缩小到「仅按住期间」。松开后 `1002` 仍在，但
> **不按键的移动不报**，所以不按键时的原生悬停/原生拖选**照常**。用户若想用终端
> 原生选择，始终可以：（a）按住 `Shift`（`isShift` 前置放行，不吞）；
> （b）`KHY_SELECT=0` 关掉选择层。

**2b-1 —— 渲染（可见但不可交互）**

9. `services/backend/src/cli/tui/ink-components/Viewport.js`：`lines` 模式加可选
   `selection` prop，按 §4.2.5 三段 `Text`（中段 `inverse: true`）。
   **不传 `selection` 时逐字节不变** —— 这是 2b-1 的唯一硬约束，也是它的验收条件。
   - 必须复用本文件已导出的 `resolveViewportOffset` 把 `sel` 的**数组行号**换算成
     **可见行号**；**不许**在 `Viewport` 里手写 `start`/`end` 算术（见 §4.2.1 不变式）。
   - `selection` 的两端都可能缺省（半开放拖选中途），实现必须容忍 `null`。
   - 不得因为加了选区就改用 `wrap`：`overflow:'hidden'` 是硬闸门（`Viewport.js:111`
     注释），改了会把备用缓冲区里的转录整片抹掉。

验收（2b-1，不依赖交互层）：

```bash
# 临时硬编码 selection={{anchor:{line:2,col:0},head:{line:4,col:3}}} 跑一次,
# 确认反色落在正确行;然后去掉硬编码,确认 Viewport 输出与改动前逐字节一致。
cd D:/Portable/khy-os/services/backend
node --test tests/cli/tui/viewportSticky.test.js
```

**2b-2 —— 交互接线**

10. `services/backend/src/cli/tui/mouseButtons.js`：`createMouseDispatcher` 增加
    `onSelectEvent(kind, ev)` 回调（`kind ∈ 'begin' | 'extend' | 'end' | 'clear'`），
    在既有分支**之前**调用；**回调缺省时行为与改动前逐字节一致**。
    - 建模方式照抄既有 `onWheel` / `onNative`（`mouseButtons.js:455-589`）——
      这样选择层可以**脱离 React 单测**，与 `A-xx` 用例的驱动方式一致。
    - 放行判据：`ev.isWheel`，或 `ev.isShift/isAlt/isCtrl` → **不**产生 select 事件
      （沿用步骤 1 的修饰键放行）；命中按钮的 press/release → **不**产生 select 事件。
    - 只有「**未命中按钮**的 press / motion / release」才产生 select 事件。
    - **不要在这里改 `onInput` 的返回值**：`App.js:4200` 丢弃返回值、`App.js:4214`
      无条件 `return`（见 §4.2.1b）。改返回值不解决接线问题，只会制造一条新的假路径。

11. `services/backend/src/cli/tui/ink-components/App.js`：
    - 新增选区 state（`anchor` / `head` / `dragging`）+ `beginSelection` /
      `extendSelection` / `endSelection` / `clearSelection` 处理；
    - 在 `mouseDispatcherRef` 创建处（`App.js:1304-1312`）挂 `onSelectEvent`；
    - state 变更走 `useState` + 函数式更新（React 重渲染依赖引用变化，**不得原地改**）；
    - 屏幕坐标 → 数组行号：**必须复用** `mouseButtons.screenOffset(rootHeight, ctx)`
      （`mouseButtons.js:353-359`），不得另写一份 —— 两份偏移算法必然发散；
    - **两处** Viewport 调用点都要传 `selection` —— 主路径 `App.js:5935-5944`，
      预览路径 `App.js:6100-6110`（后者仅在 `_inlineTranscript` 为真时才有 `lines`）；
    - 松开时若 `hasSelection` 且 `KHY_SELECT_COPY_ON_RELEASE` 开 → `writeClipboard`
      + **把 `reasons` 接到可见提示**（§七 风险 2）。`writeClipboard` 返回
      `{ok, reasons}`，`ok:false` 时必须让用户看见 —— 否则「复制了但没进剪贴板」
      又是一个静默失败；
    - `Ctrl+C` 取值优先级：有选区 → 复制；无选区 → 中断（§4.2.6）；
    - `Esc` / 任意按键 → 清选区。

12. `services/backend/src/services/flagRegistry.js`：登记 `KHY_SELECT` /
    `KHY_SELECT_COPY_ON_RELEASE` / `KHY_SELECT_WORD_BOUNDARY` / `KHY_SELECT_MAX_BYTES`。

    > **`KHY_SELECT` 只允许读一次**（在 `App.js` 顶层求值，与 `ALT_SCREEN_ENABLED`
    > 同处，`app.js:253-255` 是同一模式的先例），把这个布尔值**透传**给
    > `enableBytes({ select })` 与 `onSelectEvent` 的启用判据。若在两处各读一次
    > `process.env.KHY_SELECT`，会出现「通道开了但选择层没接」或「选择层接了但
    > 通道没开」的不一致态 —— 这正是 `A-xx` 要覆盖的一条。

13. `services/backend/tests/cli/tui/` 新增两个测试文件：
    - `mouseDispatcherSelect.test.js`：模拟 `[<0;c;rM` → `[<32;c;rM` → `[<0;c;rm`
      序列，断言 `onSelectEvent` 收到的 `kind` 序列为 `begin`,`extend`,`end`；
      并断言命中按钮时不产生 select 事件、缺省回调时逐字节不变；
    - `selectionInteraction.test.js`：断言 `KHY_SELECT=0` 时行为与步骤 1 完成态
      逐字节一致（含 `enableBytes` 不写 `1002`）。

验收（2b 全量，含回滚验证）：

```bash
cd D:/Portable/khy-os/services/backend
node --test tests/cli/tui/selection.test.js tests/cli/tui/mouseNativeSelection.test.js \
         tests/cli/tui/mouseWheel.test.js tests/cli/tui/viewportSticky.test.js \
         tests/cli/tui/mouseDispatcherSelect.test.js tests/cli/tui/selectionInteraction.test.js
# 真机:
KHY_TUI_DIAG=1 khy      # 拖选 → 应看到选区反色;松手 → 剪贴板可粘贴
KHY_SELECT=0 khy        # 回滚验证:与步骤 1 完成态逐字节一致
```

### 步骤 3 —— 文档与登记收口（✅ 2026-09-18 完成主要项）

14. `[DESIGN-ARCH-102]` §6.2 表格补判据：`Shift` 是**实现义务**（`isShift` 必须被检查）；
    补「应用内自绘选择」一节，指明它与 P6「不得劫持终端原生选择」**不冲突**
    （因为它不劫持终端，而是不依赖终端）；
    并在 §6.2 的档位说明处补上 `1000 / 1002 / 1003` 三档语义差（2b-0 的产物）。
15. `[DESIGN-ARCH-102]` §6.1：`v`/`y` 的**定案已落地**（2026-09-17）——
    该表已把两者标为「未实现（deferred）」并补注「文本选择的真实通道是终端原生拖选，
    修复见 `[DESIGN-ARCH-119]`」。**本步骤只需核对，不需要改**。
    > ⚠️ **一处需要对齐的矛盾**：该注同时写着「`v`/`y` 作为『应用内自主选择』是
    > **另一条路**，与原生拖选正交，且**优先级更低**……保持 deferred」。
    > 这与第二层落地后的事实**不再一致**：第二层就是「应用内自主选择」，
    > 而它不是「另一条路」，是**已选定的主路**。⇒ 本步骤应在该注末尾补一句
    > 「（2026-09-17 后：应用内自绘选择已成为主路，见 `[DESIGN-ARCH-119]` §八 步骤 2；
    > `v`/`y` 若要复活，应定位为『键盘驱动的选区模式入口』，而非独立路线）」。
    > 只改这一句注，**不动键位表本身**（`v`/`y` 仍为 deferred，本方案不实现它们）。
16. `services/backend/src/cli/tui/AGENTS.md`：
    - ~~§1.2 补 `KHY_MOUSE` / `KHY_MOUSE_BUTTONS` / `KHY_MOUSE_HOVER` 三个 env~~
      —— **已落地**（`AGENTS.md:285-288`，含 `KHY_MOUSE_WHEEL` 与 `KHY_ALT_SCREEN`，
      共五行）。本步骤**只需核对**，不需重写；
    - §1.2 新增 `KHY_SELECT` / `KHY_SELECT_CLIP` / `KHY_SELECT_DRAG` 三行
      （2b-2 的产物，与 `flagRegistry.js:2849-2851` 同步）—— ✅ **已落地**；
    - §0.8 的「鼠标：增强键盘，**Shift** 绕过」改为列出各终端修饰键
      （VS Code/WT/xterm `Shift` / iTerm2 `Option` / Terminal.app `Fn`），
      并补「放行判据必须排除 `isWheel`」—— ✅ **已落地（2026-09-18）**；
    - 新增 §0.9.5：应用内选择层的纪律（不得把滚轮交给 `onNative`；选区是覆盖态、
      不得新增固定高度节点）—— ✅ **已落地（§0.9.5「拖选走应用内自绘」）**；
    - §0.9.4 补三档 tracking 说明（2b-0 的第 7 步）—— ✅ **已落地**；
    - 排障表 —— ✅ **已落地（2026-09-18，新增 §1.2b「鼠标层排障表」）**，含
      §七 风险 8 的 `1002` 残留行（症状「该终端里按住鼠标拖动会显示 `[<32;...M` 文本」，
      修法 `printf '\033[?1002l\033[?1000l\033[?1003l\033[?1006l'` 或重开终端）。
17. `App.js` 的 `_mainContentLines` 上方补注释：该数组当前是「纯文本投影、无消息元数据」
    这一契约（§七 风险 1）；并说明传给 `Viewport` 的 `width` 是**死 prop**
    （`Viewport` 从不读它）—— ✅ **已落地（2026-09-18，`App.js:5492` 与 `App.js:6194`）**。
18. `docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md` 更新本文件那一行的摘要
    —— ✅ **已落地**（索引摘要已含「v2 三层方案：判据收窄 → 应用内自绘选择 → 门控与登记收口」）。
19. `[DESIGN-ARCH-101]` §8 第 6 条更新为「已修但被绕过」（§七 风险 6）
    —— ✅ **已落地（2026-09-18）**。

> **不要把这几步合成一次提交**：违反 `SOURCING-006`，且步骤 1 的行为改动、步骤 2 的
> 渲染改动、步骤 3 的文档改动混在一起时，回归定位会失焦。
> **2a / 2b-0 / 2b-1 / 2b-2 之间也要分开** —— 2b-0 尤其必须独立：它是唯一一步
> 「改一行、真机可见」的改动，与后面两步的失败模式完全不同。

---

## 九、复现方式（汇总）

```bash
# 根因核验(只读,不改业务)
cd D:/Portable/khy-os && node .khy/tmp/mouse-select-probe.js
#   期望: 10 条全部 as-expected —— 其中 4 条揭示 bug/违约

# 真终端观察
KHY_TUI_DIAG=1 khy
#   期望: 每次鼠标操作都打印 [mouse] 行 → 证明事件被本进程消费

# workaround(第二层落地前)
KHY_MOUSE=off khy        # 或 KHY_MOUSE_BUTTONS=0
#   代价:滚轮回到终端原生(主屏幕下正常;备屏下会被合成为 ↑/↓ → 输入历史回溯)

# 第二层落地后的回滚开关
KHY_SELECT=0 khy         # 关掉自绘选择层,回到第一层完成态

# 验收(步骤 2 完成时)
cd D:/Portable/khy-os/services/backend
node --test tests/cli/tui/selection.test.js tests/cli/tui/mouseNativeSelection.test.js
```

---

**附：改动落点一览**

| 文件 | 改动 | 性质 |
|---|---|---|
| `services/backend/src/cli/tui/mouseButtons.js` | `parseSgrMouse` +3 字段；`onInput` 加放行判据；press/release 条件性吞；修头部错误注释 | 业务（步骤 1 ✅）|
| `tests/cli/tui/mouseNativeSelection.test.js` | R1–R13 场景 | 测试（步骤 1 ✅）|
| **`docs/03_DESIGN_设计/[DESIGN-ARCH-119] TUI文本选择与复制-验收标准.md`** | **验收标准真源（`S-xx`/`V-xx`/`A-xx`/`X-xx`/`N-xx`）** | **文档（步骤 2a ✅）** |
| **`services/backend/src/cli/tui/selection.js`** | **选择模型纯叶子（参考实现）** | **业务（步骤 2a ✅）** |
| **`tests/cli/tui/selection.test.js`** | **`S-01`–`S-37` 验收测试（27 条全绿）** | **测试（步骤 2a ✅）** |
| **`mouseButtons.js` `enableBytes`** | **加 `select` 参数 → 写 `?1002h`（不再写 `?1000h`）** | **业务（步骤 2b-0）** |
| **`tests/cli/tui/mouseWheel.test.js`** | **`enableBytes` 两条字节级断言** | **测试（步骤 2b-0）** |
| **`ink-components/Viewport.js`** | **`lines` 模式加可选 `selection` prop；复用 `resolveViewportOffset`** | **业务（步骤 2b-1）** |
| **`mouseButtons.js` `createMouseDispatcher`** | **加 `onSelectEvent` 回调（缺省时逐字节不变）** | **业务（步骤 2b-2）** |
| **`ink-components/App.js`** | **选区 state + 挂回调 + 两处 Viewport 传 `selection` + 复用 `screenOffset` + `Ctrl+C` 优先级 + 清选区 + 可见提示** | **业务（步骤 2b-2）** |
| **`tests/cli/tui/mouseDispatcherSelect.test.js`** | **`onSelectEvent` 的 `begin`/`extend`/`end` 序列** | **测试（步骤 2b-2）** |
| **`tests/cli/tui/selectionInteraction.test.js`** | **`KHY_SELECT=0` 回滚等价** | **测试（步骤 2b-2）** |
| `services/backend/src/services/flagRegistry.js` | 登记 4 个 `KHY_SELECT_*` | 业务（步骤 2b-2） |
| `docs/03_DESIGN_设计/[DESIGN-ARCH-102] Khy TUI 统一规则手册.md` | §6.1 `v`/`y` 定案（✅ 已落地）；§6.2 补判据、自绘选择节、三档 tracking | 文档（步骤 3）|
| `services/backend/src/cli/tui/AGENTS.md` | §1.2 五个 `KHY_MOUSE*`（✅ `AGENTS.md:285-288`）；待补：§1.2 四个 `KHY_SELECT_*`、§0.8 修饰键口径、§0.9.x 选区纪律与 tracking 三档、排障表 | 文档（步骤 3）|
| `services/backend/src/services/flagRegistry.js` | 5 个 `KHY_MOUSE*` + `KHY_ALT_SCREEN`（✅ `flagRegistry.js:2828-2832`）| 业务（步骤 1 已落地，风险 4 作废）|
| `docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md` | 更新本文件摘要行 | 索引（步骤 3）|
| `docs/10_规范/...`（台账所在文件）| `[DESIGN-ARCH-101]` §8 第 6 条改「已修但被绕过」 | 文档（步骤 3）|

> **改动顺序不可交换**：2b-0 必须早于 2b-2。若先做 2b-2，`onSelectEvent` 会永远收不到
> `extend`，而单测（直接驱动 dispatcher）仍然全绿 —— 这是最容易误判「已完成」的顺序。
> **2b-0 的真机冒烟是本方案唯一不可用单测替代的验收项。**
