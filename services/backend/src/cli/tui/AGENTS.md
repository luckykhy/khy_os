# AGENTS.md — CC TUI 复刻工程约束

> **定位**：CC 模式 TUI 复刻工程的**单一约束真源**。实施本目录下任何工作时，必须遵守本文档的全部条款。
> **适用范围**：`services/backend/src/cli/tui/` 下所有 Ink 组件、CC 模式相关工具函数、以及 `KHY_CC_TUI=1` 门控的代码路径。
> **冲突解决**：当本文件与 `[DESIGN-ARCH-081]` 冲突时，以 `[DESIGN-ARCH-081]` 为准。
> **优先级不自封**（`[DESIGN-DOC-002]` 公理 A3）：本文件**不**主张在冲突时压过根目录
> `AGENTS.md`——优先级只能由 `RULES-REGISTRY.json` 字面登记，写在文件里也不生效。
> 运行时两者由 cwd 决定各自生效（读取方只扫当前目录与家目录），不存在同一轮里的先后关系；
> 真有冲突时按登记表裁决。

---

## 0. 红线（绝对禁止）

以下规则**无条件禁止**，无任何例外。违反任何一条 = 代码必须被拒绝或重写。

### 0.1 零破坏原则

```
❌ 禁止修改 Legacy 模式（KHY_CC_TUI 未设置）下的任何代码路径
❌ 禁止删除或重命名现有组件/函数（除非显式标记为废弃）
❌ 禁止改变现有 public API 的签名或行为
❌ 禁止引入新的全局副作用

✅ 所有 CC 模式代码必须通过 KHY_CC_TUI=1 门控
✅ 门控关闭时，行为必须与修改前逐字节相同
✅ 新增文件优先于修改现有文件
```

### 0.2 渲染安全

```
❌ 禁止使用 \x1B[n;mr（DECSTBM 滚动区）—— 会杀死滚动历史
❌ 禁止在 resize 时使用 \x1B[2J（全屏清除）—— 会擦除滚动历史
❌ 禁止同步阻塞事件循环超过 16ms
❌ 禁止在渲染路径中执行 IO 操作（文件读写、网络请求）
❌ 禁止在组件 render 函数中创建新对象/数组（破坏 memo）

✅ 使用 \x1B[0J（ED0）清除光标到末尾
✅ 使用保存/恢复光标 + 绝对定位进行局部更新
✅ IO 操作必须异步化（Promise / setTimeout）
✅ render 函数中使用 useMemo / useCallback 稳定引用
```

### 0.3 性能底线

```
❌ 禁止冷启动超过 100ms
❌ 禁止单次渲染超过 16ms（60fps 底线）
❌ 禁止内存泄漏（未清理的定时器、事件监听）
❌ 禁止无防抖的 resize 处理
❌ 禁止无虚拟化的大列表渲染（> 100 条消息）

✅ 启动时间 < 100ms（冷启动），< 50ms（热启动）
✅ 单次渲染 < 16ms
✅ 组件卸载时清理所有定时器和监听器
✅ resize 防抖 50ms
✅ 消息列表虚拟化（仅渲染可见区域）
```

### 0.4 品牌与合规

```
❌ 禁止在 CC 模式 UI 中出现 "Claude Code" 或 "Claude" 品牌文本
❌ 禁止在 CC 模式 UI 中出现 Anthropic 版权信息
❌ 禁止修改 platform/khy_platform/__init__.py 中的 __version__

✅ 品牌文本使用 "Khy"（定义在 ccBrand.js）
✅ 版本信息从 package.json 动态读取
✅ 品牌替换通过 ccBrand.js 集中管理
```

### 0.5 opencode 自动读取

```
❌ 禁止阻塞 TUI 渲染等待 opencode 配置加载
❌ 禁止覆盖 khy 已有的 MCP 服务器配置
❌ 禁止因 opencode 配置错误导致启动失败

✅ 异步探测 opencode 配置（后台执行）
✅ 低优先级合并（不覆盖已有配置）
✅ fail-soft（配置错误时跳过，不影响启动）
✅ 通过 KHY_MCP_ECODE_AUTO_LOAD=0 可禁用
```

### 0.6 输入框约束

```
❌ 禁止在 CC 模式下使用边框包裹输入框
❌ 禁止光标闪烁间隔超过 530ms
❌ 禁止输入延迟超过 16ms
❌ 禁止覆盖模式下无视觉区分

✅ 无边框设计（对齐 Claude Code）
✅ 光标样式随模式变化（INSERT/NORMAL/SHELL/VOICE）
✅ 多行输入支持（Shift+Enter）
✅ 高度窗口化（超过 maxRows 时显示省略标记）
✅ 占位符使用灰色 #6B7280
```

### 0.7 表格与折叠约束

```
❌ 禁止边框嵌套深度 > 1 层
❌ 禁止状态信号 > 2 个/状态
❌ 禁止始终显示的标记（如每行都有 ▸）
❌ 禁止颜色超过 4 种

✅ 表头粗体 + 下划线分隔
✅ 列对齐：文本左、数字右、状态中
✅ 截断用 …，悬停/选中显示完整
✅ 折叠：▸ 折叠 / ▾ 展开
✅ 空状态显示友好提示 + 操作建议
✅ 响应式：窄终端隐藏次要列
```

### 0.8 注意力与选择约束

```
❌ 禁止焦点指示器模糊或缺失
❌ 禁止选中项与未选中项无区分
❌ 禁止模态对话框焦点逃逸
❌ 禁止危险操作默认聚焦

✅ 焦点：边框颜色变化（最强信号）
✅ 选中：反显背景 + ▸ 前缀
✅ 模态：焦点陷阱，Tab 不跳出
✅ 权限：默认安全选项，危险操作红色
✅ 鼠标：增强键盘，修饰键绕过（见下）
```

**「修饰键绕过」不能只写 Shift** —— 各终端的「我要终端原生选择」约定键不一致，
只认 `Shift` 会让相当一部分用户的原生拖选仍然失效。`mouseButtons.js` 的
`parseSgrMouse` 因此把 `isShift` / `isAlt` / `isCtrl` **三个位都拆出来**，
`onInput` 任一为真即放行（`return false`，不消费、也不画自己的选区）：

| 终端 | 用户实际按的是 | 备注 |
|------|---------------|------|
| VS Code 集成终端 / Windows Terminal / xterm | `Shift` | SGR 位 4 |
| iTerm2 | `Option` | SGR 位 8（iTerm2 的 Shift 默认不发送序列）|
| Terminal.app | `Fn` | 部分配置下映射为 `Alt`，同走位 8 |
| 任意（显式回退）| — | `KHY_SELECT=0` 关自绘层；`KHY_MOUSE=off` 连滚轮也不接管 |

⚠ **判据里必须排除滚轮**：`Shift+滚轮` 在终端里是**横向滚动**，不是「我要拖选」，
故 `ev.isWheel` 走在修饰键放行**之前**（滚轮单独分支并 `return true`）。
见 `mouseButtons.js:528-550` 与 [DESIGN-ARCH-119] §4.1.1。

### 0.9 子视图与滚动约束

```
❌ 禁止子视图影响主对话滚动
❌ 禁止视图切换丢失位置状态
❌ 禁止复制操作影响选择状态
❌ 禁止历史搜索干扰当前输入
❌ 禁止用「滚动偏移 = 0」表示「初始状态」(见下)

✅ 视图栈：Esc 返回上一层
✅ 滚动独立：浏览/选择/复制模式分离
✅ 复制：OSC 52 + 系统命令 fallback
✅ 历史：持久化到磁盘，支持搜索
✅ Resume：完成后显示摘要，Enter 继续
```

#### 0.9.1 视口偏移的贴底哨兵（`null` = 跟随最新内容）

转录的默认位置是**最新一条**，不是第一条。滚动偏移因此有两种语义：

| 值 | 含义 |
|----|------|
| `null` / `undefined` / 负数 | **贴底** —— 追随最新内容，新内容进来继续跟随 |
| 数字 | 固定行偏移，用户手动滚到哪里就停在哪里 |

「滚回最底」时必须**回写 `null`**，这样跟随会自动恢复，不需要额外的 sticky 标志位。

真源是 `ink-components/Viewport.js` 的 `resolveViewportOffset` / `applyStickyViewportAction`
（纯叶子、与 `applyViewportScroll` 同处、有单测）。**不要在调用方另抄一份实现。**

> 为什么必须有哨兵值：历史实现把 state 初值写成 `0`，再用 `scroll >= maxScroll` 判断
> 「之前在底部」。内容一旦长过视口，`0 >= maxScroll` 恒假 —— 视口就永远停在**顶部**，
> 用户看到的是最早那几行，「输出回显看不见」的体感一半来自这里。
> 回归测试见 `tests/cli/tui/viewportSticky.test.js`。

#### 0.9.2 帧高必须 ≤ rows − 1（否则备用缓冲区下转录被整片抹掉）

ink 的 fullscreen 判定是 `lastOutputHeight >= stdout.rows`
（`node_modules/ink/build/ink.js:320`，注意用的是**上一帧**的 `outputHeight`，且
`outputHeight = output.split('\n').length`，即「行数」而非「换行数」）。
一旦命中就走 `clearTerminal + fullStaticOutput + output`。

本 TUI 跑在**备用缓冲区**里，没有回滚缓冲，那条清屏会连转录一起抹掉；更糟的是
`scrollbackPreserve` 第三层（`KHY_SUPPRESS_STATIC_REPRINT`）会把 `fullStaticOutput`
剥掉 → 「抹掉之后不重画」。而且这个判定会**自锁**：一旦某帧高度 ≥ rows，
`lastOutputHeight` 就一直是 ≥ rows，此后**每一帧**都清屏。

```
❌ 禁止让 live 区（含所有 chrome 兄弟节点）合计高度 ≥ rows
❌ 禁止新增固定高度的兄弟节点却不登记进 chrome 账本
✅ 高度一律走 chromeBudget.liveBudget(rows, shares)，shares 逐项列出
✅ 排障先开 KHY_TUI_DIAG_H=1 打印账本，再和实测帧行数对照
```

**容易漏计的 chrome（按实测，不是按注释）**：

| 项 | PreviewLayout | legacy |
|----|---------------|--------|
| 标题栏 Topbar | 1 | — |
| 底部固定层顶上的分隔线 | 1 | — |
| PromptFrame | 3 | 3 |
| FooterBar | 1 | 1 |
| 忙态 spinner 块 | 3 | 3 |
| 任务清单 | `3 + 条数 (+1 尾切提示)`，无清单 0 | 同左 |
| slack（conpty pending-wrap 纪律） | 1 | 1 |

> 两个历史坑：
> ① `spinner` 曾被记成 1~2 行 —— 但 ink 的边框语义是「设了 `borderStyle` 就四边全画，
>    单写 `borderBottom: true` 不会关掉其余三边」，legacy 那个 spinner 盒子实际是
>    **上边 + 1 行内容 + 下边 = 3 行**；Preview 的 `paddingY:1` 包法也是 3 行。
> ② PreviewLayout 独有的 topbar + 分隔线曾经完全没进账本，宽终端下 live 区恒定多 1~2 行。
>
> **实测下限：可用高度 ≈ 14 行**（legacy 13 行边缘可用）。低于此值固定 chrome 物理上装不下，
> ink 的全屏清屏无法避免 —— 这不是 bug，是几何不可能。

#### 0.9.3 滚轮必须被应用接管（备用缓冲区下不能交还终端）

备用缓冲区没有回滚缓冲，所以终端会把滚轮**合成为 ↑/↓ 键**送进 stdin；而 ↑/↓ 已被
`arrowRouting` 绑成 `history:previous/next` —— 用户看到的「滚轮回溯历史记录」其实是键位串扰。

```
❌ 禁止在备用缓冲区下把滚轮交给 onNative（= 交还终端）
✅ 滚轮优先走 dispatcher 的 onWheel(dir)，驱动应用内视口
✅ onWheel 缺失时才回退 onNative（逐字节保留旧行为）
✅ onWheel 抛异常必须被吞掉，且**不得**顺带触发 onNative
```

门控与判定见 `mouseButtons.js`：`wheelDirection(button)`（`button & ~28` 剥掉
shift/meta/ctrl 修饰位后比对 64/65）、`mouseExplicitlyDisabled(env)`。
`app.js` 在 `ALT_SCREEN_ENABLED && !mouseExplicitlyDisabled()` 时**强制接管**鼠标。
回归测试见 `tests/cli/tui/mouseWheel.test.js`。

#### 0.9.4 鼠标追踪三档互斥，`enableBytes` 是唯一真源

DECSET 的三个追踪模式是**同一能力的不同档位，互斥**，只能开一个：

| 模式 | 上报内容 | 谁需要它 |
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

⚠ **一条曾被写反的因果**（2026-09-17 修正）：历史注释称「1002 报位移意味着按下已被
吃掉，所以必须降到 1000」。**因果是反的** —— 按下被吃掉是因为 dispatcher 对 `press`
无条件 `return true`，与开哪一档无关；1000 下 press 照样上报、照样被吃。降档只是顺手
删掉了自绘选择唯一需要的位移信息。
⇒ 纪律：**「不报 X」不等于「不报 Y」**，判据要按**事件类别**逐项写清。

回归测试见 `tests/cli/tui/mouseWheel.test.js`（`enableBytes` 三档断言）。

#### 0.9.5 拖选走应用内自绘，不要试图「把事件还给终端」

鼠标追踪一旦开启，事件就被 ink 从 stdin 读走，而 `use-input.js:112-114` 把 handler
返回值**直接丢弃**（`inputHandler(input, key)` 无人消费）—— `return false` 物理上回不到
终端。所以「把拖选透传给终端」这条路**不存在**，唯一解法是**本进程内自绘**：

```
拖按下 → dispatcher onSelectEvent('down')  → 记 anchor，丢弃旧选区
拖位移 → dispatcher onSelectEvent('move')  → normalizeSelection(anchor, pt) → setState
拖松开 → dispatcher onSelectEvent('up')    → extractText + writeClipboard（唯一产出点）
```

坐标换算的**关键不变量**：`_mainContentLines` 的下标 == 屏幕行（Viewport 的 lines 模式
按 `height` 直接 slice，只有一个加性偏移 `clampedScroll`）。因此「屏幕 row − 视口偏移
= 数组下标」，不需要任何布局反查。
⚠ **不要用 `hitTest` 反查坐标**：那是 yoga 树的实时几何，与按列宽预折好的视觉行在软换行
处不一致，拿它的结果索引 `lines` 数组会整体错位。

门控：`KHY_SELECT`（总闸，默认开）/ `KHY_SELECT_CLIP` / `KHY_SELECT_DRAG`。
组件契约：`Viewport` 的 `selection` prop **不传时逐字节不变**（走原单 `<Text>` 分支）。
纯叶子：`selection.js`（12 个导出，零 IO、绝不抛）。
回归测试见 `tests/cli/tui/mouseSelectEvent.test.js`、`mouseNativeSelection.test.js`、
`ink-components/viewportSelection.test.js`、`selection.test.js`。

#### 0.9.6 写 TUI 渲染探针的三条硬前置（否则全是假红）

用**真 ink 渲染器**验证渲染结果时（想确认某段文本真的带了反色 / 某属性真的写进了帧），
有两条前置不满足会得到**看起来像产品缺陷的假红**。2026-09-17 各踩了一次，
2026-09-21 又踩了第三条（同一支探针连错两次），三次都把注意力引向了本来正确的产品代码：

```
① 必须走仓库自己的 inkRuntime，不要自己 import('ink')
   ❌ const ink = await import('ink')                 // 拿到的是"另一份"引用
   ✅ const ir = require('../inkRuntime'); await ir.loadInk(); const ink = ir.get();

   原因：Viewport.js:57 是 `inkRuntime.get()`，get() 在单例未灌值时**抛错**
   （inkRuntime.js:103-107）。真机上 startInkApp() 会 await loadInk()，所以线上没这
   问题；探针跳过这一步，就复刻不了真机的启动顺序 —— 那它验证的就不是真机那条路径。
   典型报文：`inkRuntime.get() called before loadInk() resolved`
   并被归因到 Viewport 的某一行上。

② 必须在 require 任何 ink/chalk 相关模块**之前**设 FORCE_COLOR
   ❌ 在 render() 前才设 —— chalk 早已在模块求值时读完 process.env
   ✅ 放在探针文件最顶部：process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';

   原因：ink 的 `inverse` 是 `chalk.inverse`（ink/build/components/Text.js:40-41），
   chalk 的 level 来自 supports-color，**非 TTY stdout 下 level = 0**，
   此时 chalk.inverse('x') === 'x' —— 一个字节的转义都不吐，帧里自然找不到反色。
   给假 stdout 传 isTTY: true / hasColors(): true 都**没用**，supports-color 在别处
   早就判完了。真机是真 TTY，level ≥ 1，不受影响。

③ 被测代码读的**每一个环境量**，探针都得如实改
   ❌ 只把假 stdout 交给 ink 的渲染流（`setRenderStdout(fake)` / `render(…, { stdout: fake })`）
   ✅ 同时改 App 真正读的那个量：Object.defineProperty(process.stdout, 'rows', { value: n, configurable: true })

   原因：本 TUI 的终端尺寸不是从渲染流拿的 —— App.js `_resRows` ←
   `sidebarLayout.stickyDim(process.stdout.rows, …)`、列宽 ← `_stickyCols(process.env)`。
   2026-09-20 的帧顶探针只注入了假 stdout，于是三档 rows 下 App 全按同一个行高排版
   （帧高恒 22），由此得出两条**并不存在**的结论：「live 帧顶 = staticRows(=8)」「帧高不随
   终端收缩（原 BUG-28）」。公式当时是对的，错的是量级叙事与一条凭空立起的缺陷 ——
   复核后真终端稳态校正只有 **1 行**。
   判据：改完探针先问「如果我改的只有 rows 这一个 env 量，输出真的会变吗？」
   输出纹丝不动 ⇒ 是探针没接上，不是产品不敏感。
```

⇒ 纪律：探针报红时**先怀疑探针的启动环境，再怀疑产品代码**。判据是问一句
「真机跑这条路径时，前置条件是什么？我复刻了吗？」

三条都已落在实际探针中，可作模板抄：
`_产物/应用内自绘选择-真渲染器验证-2026-09-17.js`（13/13 绿）、
`.khy/feedback/tui-ux-audit-20260919/R/frame_top_probe.cjs` 与
`services/backend/tests/tui/liveFrameGeometry.test.js`（③ 的正面样本）。

#### 0.9.7 单写者原则 —— 只有 ink 注入的那条流可以画屏

TUI 存活期间，**任何绕过 ink 注入 stdout 的写入都会在帧下方留下擦不掉的残行**。

```javascript
// ❌ 直接写真实 stdio：字节落屏，但 ink 的 lastOutputHeight 账本不知道
console._stdout.write('...')        // winston Console transport 就是这么写的
process.stdout.write('...')         // 同理
// ✅ 要么走 ink 的树（<Text>/<Box>），要么在会话期把它静音（consoleMute.js）
```

机制（2026-09-21 BUG-13 实测，`T/differential.md`）：`app.js` 把渲染流换成了
`scrollbackPreserve(process.stdout)` 的 Proxy，ink 每帧按 `lastOutputHeight`
`eraseLines(n)` 重画。而 `patch-console` 只替换 `console.log/warn/…` 这 **18 个方法**，
**不碰 `console._stdout`**；winston 的 Console transport 恰好写的就是
`console._stdout.write`（`vendor/shared/src/utils/logger.js` 装配的那份）。于是日志字节
绕开了注入流**与它的帧高账本**，`eraseLines` 永远擦不到它 —— 状态栏下方一行幽灵文本。

**已登记的绕过者**：
- winston Console transport → 已由 `consoleMute.js` 在 `render()` 前把该 transport 的
  level 设成 `silent`，`waitUntilExit()` 后恢复（`process.once('exit')` 兜底）。
  逃生门 `KHY_TUI_CONSOLE_LOG=1` 可整段关掉静音，排障时用。
- `sessionWatchdog.js` `report()` → 直写 `process.stderr`，**确证成立**（BUG-17，
  `U/repro-before.txt` 实测越界行 `[37,38]`、重绘后残留 = 是）。处方：`report()` 先问宿主
  （`opts.onReport`），宿主接走就不写；TUI 在 `ink-components/App.js` 订阅
  `noticeInbox`，诊断行变成转录区的一条 `role:'notice'` —— **外部模块一律不自己画屏，
  要嘛交给我画，要嘛别说**。逃生门 `KHY_WATCHDOG_NOTICE=0` ⇒ `push()` 恒拒 ⇒ 逐字节旧行为。
  同族约束：这类宿主钩子只有**显式 `true`** 算「接走」，返回 false / 抛错 / 无钩子一律回落，
  诊断宁可多一行也不许静默丢（Rule 3 诚实上报）。
- 附带修掉的同源坑（BUG-17b）：`stop()` 过去不还原它 patch 过的 `stream.write`，于是
  已停用的实例仍挂在流上；而它自己的上报（含 `resourceGuard` 那句 `console.error`）本身
  就是一次「活动」写入 ⇒ 重新武装 ⇒ 自持复燃。任何**包裹 stdio `.write` 的机制**在
  卸载时必须按身份还原（`stream.write === myPatch` 才还原，别人套在外面就不动）。

新增直接写 stdio 的模块前，先问「它是否可能在 TUI 存活期被调用」；是，则要么走 ink 树，
要么纳入 `consoleMute` 的同族处理，**不要**指望「反正只是日志」。

### 0.10 微交互与反馈约束

```
❌ 禁止复制操作无反馈
❌ 禁止滚动无边界指示
❌ 禁止错误消息无修复建议
❌ 禁止瞬态消息永久显示

✅ 复制：显示字符/字节数（copied N chars）
✅ 滚动：显示上下方内容指示（⋯ N above/below）
✅ Toast：3-5 秒自动消失
✅ Token：80% 黄色 / 95% 红色警告
✅ 工具超时：显示超时 + 重试建议
✅ 双击退出：首次提示，二次退出
```

### 0.11 快捷键与执行偏差约束

```
❌ 禁止破坏性操作无撤销
❌ 禁止模型跑偏无检测
❌ 禁止快捷键冲突无提示
❌ 禁止偏差无恢复建议

✅ 快捷键：集中注册，上下文感知
✅ Redo：r 重新生成，R 编辑后重做
✅ Fork：f 创建新分支
✅ Undo：z 撤销，Z 重做
✅ 偏差检测：循环检测 + 超时检测
✅ 检查点：失败后自动回滚
✅ 用户引导：可注入指导纠正模型
```

---

## 1. 门控策略

### 1.1 主开关

```javascript
// 唯一合法的门控检测方式
const isCcMode = process.env.KHY_CC_TUI === '1';
```

### 1.2 子功能门控

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `KHY_CC_TUI` | `0` | 主开关 |
| `KHY_CC_LOGO` | 跟随主开关 | Logo 样式 |
| `KHY_CC_STATUS_BAR` | 跟随主开关 | 状态栏样式 |
| `KHY_CC_MSG_STYLE` | 跟随主开关 | 消息渲染样式 |
| `KHY_CC_TOOL_STYLE` | 跟随主开关 | 工具卡片样式 |
| `KHY_CC_PERMISSION` | 跟随主开关 | 权限提示样式 |
| `KHY_CC_COMPLETION` | 跟随主开关 | 补全菜单样式 |
| `KHY_CC_COLORS` | 跟随主开关 | 主题色 |
| `KHY_CC_SIDEBAR` | 跟随主开关 | 右侧看板 |
| `KHY_CC_HELP` | 跟随主开关 | 帮助菜单 |
| `KHY_CC_VIEW_STACK` | 开（CC 视图栈命令面板） | CC 模式命令面板走 `CcViewStack.CcCommandPalette`（[DESIGN-ARCH-085] §1 子视图）；显式 `0` → 回退 `CcFuzzyPicker` 逐字节不变 |
| `KHY_CC_COPY_TOAST` | 开（CC 规范文案） | 复制/Toast 微交互反馈格式；显式 `0` → 中文旧文案逐字节回退（[DESIGN-ARCH-087] §1/§3） |
| `KHY_INLINE_TRANSCRIPT` | 开 | 转录由**应用内 Viewport** 承载（可滚、不被 fullscreen 清屏擦掉）；显式 `0` → 回退「整段转录走 `<Static>`」，逐字节与修改前一致。**备用缓冲区下建议保持开**（见 §0.9.2） |
| `KHY_MOUSE` | `click`（三档：`off`/`click`/`full`） | 鼠标层主开关。`off` = 完全不接管（原生滚轮 + **拖选**全保留）；`click` = 接管**滚轮与按钮**，press/release 按命中**条件性放行**（拖选不受影响）；`full` = 额外开 1003 悬停（事件洪流，**必然**吞拖选）。未识别终端由 `autoDetectTerminal` 兜底不接管。⚠ **用户遇到「拖选选不中」时的第一退路**（[DESIGN-ARCH-119]） |
| `KHY_MOUSE_BUTTONS` | 未设（旧版布尔覆写） | **优先于 `KHY_MOUSE` 档位**：`1`/`true`/`on`/`yes` 强制开点击层；`0`/`false`/`off`/`no` 强制关（等价 `off` 档） |
| `KHY_MOUSE_HOVER` | 仅 `full` 档默认开 | 悬停追踪（1003）独立门控。1003 是 60~120Hz 事件洪流且**必然**吞掉拖选 —— 只在明确需要悬停高亮时开 |
| `KHY_MOUSE_WHEEL` | 开 | 滚轮驱动应用内视口（`onWheel`）；显式 `0` → 回退「交还终端原生滚动」。⚠ **只在主屏幕下有意义** —— 备用缓冲区没有回滚缓冲，交还终端会被合成为 ↑/↓ → 变成输入历史回溯（见 §0.9.3） |
| `KHY_ALT_SCREEN` | legacy 开 / CC 模式关 | 备用缓冲区（1049h）：legacy 模式默认开（退出时恢复原终端内容，防残影）；CC 模式（`KHY_CC_TUI=1`）默认关，让原生回滚正常工作 |
| `KHY_SELECT` | **开** | **应用内自绘选择总闸**。开 → 接管拖选：开 1002（替换 1000）收位移、Viewport 反色画选区、松手写剪贴板。显式 `0` → 逐字节回退旧行为。⚠ 开它意味着**替换**终端原生拖选 —— 这是为「备屏下原生拖选本就被鼠标追踪吃掉」付出的对称代价（[DESIGN-ARCH-119] §4.2） |
| `KHY_SELECT_CLIP` | 开 | 松手自动写剪贴板（`utils/ccClipboard.writeClipboard`）；显式 `0` → 能选中能看但**不自动复制**（仍可走既有 Ctrl+C 路径） |
| `KHY_SELECT_DRAG` | 开 | 1002 拖动位移追踪；显式 `0` → 只认按下/松开两点式选择（不跟手）。**诊断用**：用于区分「1002 没收到位移」与「选区模型算错」 |
| `KHY_PREVIEW_LAYOUT` | 宽终端 ≥122 列自动开 | Preview 布局（标题栏 + 左右分栏 + 底部固定层）；显式 `1`/`0` 强制开关 |
| `KHY_TUI_DIAG_H` | `0` | 诊断：把本帧高度账本（rows/viewport/各 chrome 分项）打到 stderr，用于核对是否漏项 |
| `KHY_TUI_DIAG` | `0` | 诊断：把每次鼠标事件的解析结果打到 stderr，用于排查「图标可见但点不中」 |
| `KHY_TUI_CONSOLE_LOG` | `0` | 逃生门：`1` → TUI 会话期**不**静音 winston 的 Console transport（见 §0.9.7）。默认静音，否则日志绕过 ink 注入流、在状态栏下方留擦不掉的残行（BUG-13） |
| `KHY_WATCHDOG_NOTICE` | `1` | 逃生门：`0` → `noticeInbox.push()` 恒拒 ⇒ 看门狗诊断行回到直写 stderr 的旧行为。默认开：TUI 存活期由转录区接手（`role:'notice'`），否则那一行落在状态栏之外、任何重绘都擦不掉（BUG-17，见 §0.9.7） |

### 1.2b 鼠标层排障表（症状 → 成因 → 修）

| 症状 | 成因 | 修 |
|------|------|-----|
| **拖选选不中 / 复不出文本** | 自绘选择层被关，或终端未上报修饰序列（第一层无可达性）| ① `KHY_SELECT=1`（默认已开）确认未被显式关；② 按住**本终端的原生选择修饰键**拖（见 §0.8：Shift / Option / Fn）；③ 最后退路 `KHY_MOUSE=off` |
| 滚轮翻不了历史（备屏下变成 ↑/↓ 历史回溯）| 滚轮被交还终端，而备屏无回滚缓冲 | 确认 `KHY_MOUSE_WHEEL` 未被设 `0`（见 §0.9.3）|
| **在某个终端里按住鼠标拖动会输出 `[<32;...M` 之类的文本** | **`1002` 残留在终端**：进程被 `SIGKILL` / 终端崩溃 / 断电 → 不走 teardown → 终端仍停在 mouse-tracking 态。⚠ 不是本方案引入的新问题（`1000h` 本就有同样风险），但 `1002` 让可见症状更明显 | `printf '\033[?1002l\033[?1000l\033[?1003l\033[?1006l'` 复位，或**直接重开终端**。见 [DESIGN-ARCH-119] §七 风险 8 |
| 选中了但剪贴板没内容 | `writeClipboard` 走了 OSC 52 而当前是 SSH/tmux 嵌套（native 写不到用户面前的剪贴板）| 看是否有失败提示（`reasons` 已接可见提示）；必要时 `KHY_CLIPBOARD_DUAL=1` |

### 1.3 门控实现模式

```javascript
// ✅ 正确：条件渲染
function FooterBar() {
  if (isCcMode) {
    return <CcStatusLine />;
  }
  return <LegacyFooterBar />;
}

// ✅ 正确：提前返回
function StatusLine() {
  if (!isCcMode) return <LegacyStatusLine />;
  // CC 模式逻辑...
}

// ❌ 错误：在组件内部判断
function Message({ text }) {
  const color = isCcMode ? '#00D4D4' : '#00BCD4'; // 禁止！
  return <Text color={color}>{text}</Text>;
}
```

---

## 2. 渲染约束

### 2.1 布局规则

| 规则 | 值 | 说明 |
|------|-----|------|
| 状态栏高度 | **绝对 1 行** | 不能随内容变化 |
| 输入框最小高度 | **绝对 1 行** | 至少显示一行 |
| 输入框最大高度 | `min(10, rows * 0.3)` | 相对终端高度 |
| 右侧看板宽度 | `min(30, cols * 0.25)` | 相对终端宽度 |
| 主内容区宽度 | `cols - sidebarWidth` | 填充剩余 |
| 消息区高度 | `rows - 1 - inputHeight` | 减去状态栏和输入框 |
| 工具参数缩进 | **绝对 2 空格** | 固定缩进 |
| 边框字符 | **绝对精确** | `─│┌┐└┘├┤┬┴┼` |

### 2.2 颜色规则

```javascript
// ✅ 正确：从主题导入
const { CC_COLORS } = require('../theme/ccTheme');
<Text color={CC_COLORS.toolName}>Read</Text>

// ❌ 错误：硬编码颜色
<Text color="#00D4D4">Read</Text> // 禁止！

// ✅ 正确：使用 ANSI 缓存
const ansi = CC_COLORS.ansi;
process.stdout.write(`${ansi.toolBold}Read${ansi.reset}`);
```

### 2.3 渲染策略

| 内容类型 | 组件 | 策略 |
|----------|------|------|
| 已提交消息 | `<Static>` | memoize，仅 ID 变化时更新 |
| 流式输出 | `<StreamingBlock>` | 16ms 批量，增量 diff |
| 工具卡片 | `<CcToolCard>` | memoize，仅状态/结果变化时更新 |
| 状态栏 | `<CcStatusLine>` | 1秒间隔，memoize |
| 输入框 | `<CcPromptInput>` | 16ms 防抖，光标定位 |
| 右侧看板 | `<CcSidebarPanel>` | 按需渲染，面板切换时更新 |

### 2.4 Resize 处理

```javascript
// ✅ 正确：使用 ResizeHandler
const handler = new ResizeHandler({ debounceMs: 50 });
handler.on('resize', ({ cols, rows }) => {
  setDimensions({ cols, rows });
});
handler.start();

// ✅ 正确：组件卸载时清理
useEffect(() => {
  const handler = new ResizeHandler();
  handler.start();
  return () => handler.stop();
}, []);

// ❌ 错误：直接监听 stdout resize
process.stdout.on('resize', () => { ... }); // 禁止！
```

---

## 3. 计时器约束

### 3.1 计时器常量

```javascript
// 唯一合法的计时器常量来源
const { TIMING } = require('../utils/ccTimers');

// ✅ 正确
setInterval(updateStatusBar, TIMING.statusBar.interval);

// ❌ 错误：硬编码计时器
setInterval(updateStatusBar, 1000); // 禁止！
```

### 3.2 计时器清理

```javascript
// ✅ 正确：useEffect 返回清理函数
useEffect(() => {
  const timer = setInterval(fn, TIMING.statusBar.interval);
  return () => clearInterval(timer);
}, []);

// ✅ 正确：组件卸载时清理
useEffect(() => {
  const handler = new ResizeHandler();
  handler.start();
  return () => handler.stop();
}, []);

// ❌ 错误：不清理定时器
useEffect(() => {
  setInterval(fn, 1000);
}, []); // 禁止！
```

### 3.3 计时器优先级

| 计时器 | 间隔 | 优先级 | 说明 |
|--------|------|--------|------|
| 流式批量 | 16ms | 高 | 60fps，不可丢帧 |
| Spinner | 80ms | 中 | 12.5fps，终端足够 |
| 状态栏 | 1000ms | 低 | 1fps，不阻塞渲染 |
| MCP 轮询 | 5000ms | 低 | 0.2fps，后台运行 |
| Resize 防抖 | 50ms | 中 | 避免频繁重绘 |

---

## 4. 启动速度约束

### 4.1 启动阶段

```
阶段 1 (< 50ms): 核心渲染
  ├─ 加载 Ink 运行时（必须同步）
  ├─ 检测终端能力（必须同步）
  ├─ 初始化主题（必须同步）
  └─ 渲染欢迎界面（必须同步）

阶段 2 (异步，不阻塞交互):
  ├─ 连接 AI 网关
  ├─ 加载 MCP 配置
  ├─ 检查更新
  └─ 预热缓存

阶段 3 (< 100ms): 交互就绪
  ├─ 启用输入
  ├─ 启动状态栏轮询
  └─ 完成启动
```

### 4.2 延迟加载规则

```javascript
// ✅ 正确：非关键模块延迟加载
const CcHelpMenu = React.lazy(() => import('./CcHelpMenu'));

// ✅ 正确：条件加载
function showHelp() {
  if (!helpModule) {
    helpModule = require('./CcHelpMenu');
  }
  return helpModule;
}

// ❌ 错误：启动时加载所有模块
const CcHelpMenu = require('./CcHelpMenu'); // 禁止！
const CcSidebarPanel = require('./CcSidebarPanel'); // 禁止！
```

---

## 5. 文件组织约束

### 5.1 目录结构

```
tui/
├── AGENTS.md                    ← 本文件（工程约束）
├── app.js                       ← 入口（启动流程优化）
├── ink-components/              ← Ink 组件
│   ├── App.js                   ← 根组件（集成 resize + 渲染策略）
│   ├── CcStatusLine.js          ← CC 状态栏
│   ├── CcAssistantMessage.js    ← CC 助手消息
│   ├── CcToolCard.js            ← CC 工具卡片
│   ├── CcPromptInput.js         ← CC 输入框
│   ├── CcPermissionPrompt.js    ← CC 权限提示
│   ├── CcFuzzyPicker.js         ← CC 补全菜单
│   ├── CcHelpMenu.js            ← CC 帮助菜单
│   ├── CcLogo.js                ← CC Logo
│   ├── CcMcpStatus.js           ← MCP 状态栏
│   ├── CcMcpPanel.js            ← MCP 详情面板
│   ├── CcSidebarPanel.js        ← 右侧看板容器
│   ├── CcSidebarContext.js      ← Context 面板
│   ├── CcSidebarFiles.js        ← Files 面板
│   ├── CcSidebarTools.js        ← Tools 面板
│   ├── CcSidebarStats.js        ← Stats 面板
│   └── CcSidebarMcp.js          ← MCP 面板
├── utils/                       ← 工具函数
│   ├── ccMode.js                ← 门控检测
│   ├── ccBrand.js               ← 品牌文本
│   ├── ccFormatters.js          ← 格式化函数
│   ├── ccToolFormat.js          ← 工具参数格式化
│   ├── ccResizeHandler.js       ← Resize 处理
│   ├── ccRenderStrategy.js      ← 渲染策略
│   ├── ccTimers.js              ← 计时器常量
│   ├── ccLayout.js              ← 布局计算
│   ├── ccContextWindows.js      ← 模型上下文窗口
│   └── ccPricing.js             ← 模型定价
├── hooks/                       ← React Hooks
│   ├── useMcpStatus.js          ← MCP 状态桥接
│   └── useSidebarState.js       ← 右侧看板状态
└── theme/                       ← 主题
    ├── ccTheme.js               ← CC 主题色板
    └── themeRegistry.js         ← 主题注册
```

### 5.2 文件命名规则

| 类型 | 前缀 | 示例 |
|------|------|------|
| CC 模式专用组件 | `Cc` | `CcStatusLine.js` |
| CC 模式专用工具 | `cc` | `ccFormatters.js` |
| CC 模式专用 Hook | `use` + 功能 | `useMcpStatus.js` |
| Legacy 组件 | 无前缀 | `FooterBar.js` |

### 5.3 禁止事项

```
❌ 禁止在 tui/ 目录外创建 CC 模式相关文件
❌ 禁止在 tui/ 目录内创建非 CC 模式的无关文件
❌ 禁止修改 Legacy 组件的内部实现
❌ 禁止在 CC 组件中直接引用 Legacy 组件
```

---

## 6. 代码风格约束

### 6.1 通用规则

```javascript
// ✅ 正确：2 空格缩进、单引号、分号
const x = 1;
const y = 'hello';

// ✅ 正确：camelCase 命名
const isCcMode = true;
function formatModelName() {}

// ✅ 正确：英文注释
// Detect terminal color support
const supportsColor = process.env.COLORTERM === 'truecolor';

// ✅ 正确：面向用户的中文字符串
const message = '正在连接数据库...'; // 用户可见
const label = 'model'; // 内部标识，英文
```

### 6.2 组件规则

```javascript
// ✅ 正确：函数组件 + React.memo
function CcStatusLine({ model, context, cost }) {
  return <Text>{model}</Text>;
}
module.exports = { CcStatusLine: React.memo(CcStatusLine) };

// ✅ 正确：props 解构
function CcToolCard({ name, params, status, result }) {
  // ...
}

// ❌ 错误：类组件
class CcStatusLine extends React.Component { // 禁止！
  render() { return <Text />; }
}
```

### 6.3 错误处理

```javascript
// ✅ 正确：try/catch + fail-soft
async function loadMcpServers() {
  try {
    return await getMcpServers();
  } catch {
    return []; // 失败返回空数组，不阻塞渲染
  }
}

// ✅ 正确：错误边界
function ErrorBoundary({ children }) {
  const [error, setError] = useState(null);
  if (error) {
    return <Text color="#F87171">渲染错误: {error.message}</Text>;
  }
  return children;
}

// ❌ 错误：抛出异常
function loadConfig() {
  if (!config) throw new Error('Config not found'); // 禁止！
}
```

---

## 7. 测试约束

### 7.1 必须测试的场景

| 场景 | 测试内容 |
|------|----------|
| 门控开关 | `KHY_CC_TUI=1` 和未设置时行为正确 |
| Resize | 放大/缩小无残影，布局正确 |
| 流式输出 | 60fps 无卡顿 |
| 工具调用 | 状态变化正确渲染 |
| MCP 状态 | 连接/断开/失败状态正确 |
| 启动速度 | 冷启动 < 100ms |
| 内存泄漏 | 定时器/监听器正确清理 |

### 7.2 性能测试

```javascript
// ✅ 正确：测量渲染时间
const start = performance.now();
render(<App />);
const duration = performance.now() - start;
assert(duration < 100, `启动时间 ${duration}ms 超过 100ms 底线`);

// ✅ 正确：测量内存使用
const before = process.memoryUsage().heapUsed;
// ... 执行操作
const after = process.memoryUsage().heapUsed;
const delta = after - before;
assert(delta < 50 * 1024 * 1024, `内存增长 ${delta} 超过 50MB 底线`);
```

---

## 8. 验收清单

### 8.1 Phase 1 验收

- [ ] `KHY_CC_TUI=1 khy` 启动后显示 Khy 品牌 Logo
- [ ] 用户消息无背景框，纯文本显示
- [ ] 工具调用使用 🔧 + 粗体青色
- [ ] 状态栏单行，格式正确
- [ ] 冷启动 < 100ms
- [ ] Resize 无残影
- [ ] Legacy 模式行为不变

### 8.2 Phase 2 验收

- [ ] 状态栏格式：Model │ Context │ Cost
- [ ] MCP 状态显示正确
- [ ] 右侧看板 ≥ 120 列时自动显示
- [ ] 看板面板切换正常
- [ ] 渲染帧率 ≥ 30 FPS

### 8.3 Phase 3 验收

- [ ] 助手消息 ● 前缀
- [ ] 工具调用独立卡片（无过程组）
- [ ] 工具结果块边框正确
- [ ] 思考折叠块可展开/折叠

### 8.4 最终验收

- [ ] 所有门控开关正常
- [ ] 帮助菜单覆盖层正常
- [ ] 斜杠命令菜单正常
- [ ] OpenAI 模型名格式化正确
- [ ] 启动速度 < 100ms
- [ ] 渲染无残影
- [ ] 内存 < 50MB
- [ ] Legacy 模式零破坏

### 8.5 输出回显 / 滚动 验收（2026-09-16）

- [ ] **最大化窗口**（≥122 列）与**小窗口**（80×24）下都能看到转录正文，不只看到输入框
- [ ] 转录默认停在**最新一条**，新输出进来继续跟随；`↑` 指示器显示上方还有多少行
- [ ] 滚轮滚动内容区（`↑`/`↓` 指示器变化），**不**触发输入历史回溯
- [ ] 输入框与页脚在滚动时**位置不动**
- [ ] 帧高硬约束：`KHY_TUI_DIAG_H=1 khy` 打印的 `viewport + 全部 chrome` 合计 **< rows**，
      且 `KHY_MOUSE_WHEEL=0` / `KHY_INLINE_TRANSCRIPT=0` 两条回退路径逐字节回到旧行为
- [ ] `npm run --workspace services/backend test:tui` 全绿（含 `viewportSticky` / `mouseWheel`）

---

## 9. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-09-09 | 初始版本，定义 CC TUI 复刻工程约束 |
| 2026-09-16 | 新增 §0.9.1 视口贴底哨兵（`null` = 跟随最新内容）、§0.9.2 帧高 ≤ rows−1 硬约束与 chrome 逐项清单、§0.9.3 备用缓冲区滚轮接管；§1.2 登记 `KHY_INLINE_TRANSCRIPT` / `KHY_MOUSE_WHEEL` / `KHY_PREVIEW_LAYOUT` / `KHY_TUI_DIAG_H` / `KHY_TUI_DIAG` |
| 2026-09-21 | 新增 §0.9.7 单写者原则（绕过 ink 注入 stdio 的写入擦不掉，BUG-13 根因）：`consoleMute.js` 会话期静音 winston Console transport，§1.2 登记逃生门 `KHY_TUI_CONSOLE_LOG` |
| 2026-09-21 | §0.9.7 绕过者清单结案 BUG-17：`sessionWatchdog.report()` 不再自画屏，改经 `noticeInbox.js`（新）交给 `ink-components/App.js` 订阅者落成 `role:'notice'`；宿主钩子语义定为「显式 `true` 才算接走」。附带修 BUG-17b：`stop()` 现按身份还原被 patch 的 `stream.write`（否则停用实例仍拦截全局写入并自我续命）。§1.2 登记逃生门 `KHY_WATCHDOG_NOTICE` |
