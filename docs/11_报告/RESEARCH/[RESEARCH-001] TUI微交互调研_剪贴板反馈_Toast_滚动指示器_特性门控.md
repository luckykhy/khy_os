# TUI 微交互调研报告：剪贴板反馈 / Toast / 滚动指示器 / 特性门控

> 调研日期：2026-09-15
> 方法：全部结论来自**一手源码**（shallow-clone 本地仓库 + GitHub 原始文件），未采用博客/二手来源。
> 本地源码快照位于 `D:\Portable\khy-os\.research-tmp\repos\`（各仓库 HEAD 提交与日期已注明）。

**仓库快照清单（一手来源的基准）**

| 仓库 | 路径 | HEAD / 日期 |
|---|---|---|
| opencode (sst/anomalyco) | `D:\Portable\khy-os\.research-tmp\repos\opencode` | `4ae17652` 2026-09-14 |
| 本机 opencode（交叉验证） | `D:\Portable\Tools\opencode\src` | `7a6ce05` "2.0 exploration (#22335)" |
| bubbletea | `...\repos\bubbletea` | `73b6d91a` 2026-08-19 |
| bubbles | `...\repos\bubbles` | `0a69b19b` 2026-09-01 |
| lipgloss | `...\repos\lipgloss` | `6a419c65` 2026-09-11 |
| charmbracelet/x | `...\repos\charm-x` | `c615ff2f` 2026-09-13 |
| charmbracelet/log | `...\repos\charm-log` | `394fd9b1` v2.0.1 2026-09-03 |
| cli/cli (GitHub CLI) | `...\repos\cli` | `38316c1c` 2026-09-14 |
| claude-code | `...\repos\claude-code` | `f4ceeeca` 2026-09-14 |
| ink (facebook/vadimdemedes) | npm `ink@7.1.1`（`gitHead 70af033`） | 经 npm registry + GitHub raw 验证 |

> 说明：Claude Code 本体（CLI/ink 运行时）是闭源二进制，仓库 `anthropics/claude-code`（实际为 `claude-code` 镜像）**不发布可执行源码**；可引用的一手材料只有其 `CHANGELOG.md`、`mods/`（可编辑的插件/钩子）与 `plugins/`。下面凡涉 Claude Code，均明确标注证据类型（CHANGELOG 条目 vs 插件源码）。

---

## 1. 复制（copy）到剪贴板的反馈

### 1.1 各家的措辞与呈现方式

**opencode —— 瞬态 toast（transient），信息级，无 N 计数**

复制成功统一走 toast，措辞带标点、含对象名；变体分 `info`（选区/代码块复制）与 `success`（会话级复制）。**注意：opencode 主 TUI 的复制反馈不显示字符/行数**，只显示对象。

- 措辞实例（逐字，含行号）：
  - `packages/tui/src/util/selection.ts:39` → `toast.show({ message: "Copied to clipboard", variant: "info" })`（终端选区 Ctrl+C）
  - `packages/tui/src/app.tsx:444` → 同上（`onCopySelection` 回调，"Wire up console copy-to-clipboard"）
  - `packages/tui/src/component/dialog-provider.tsx:258` → `"Copied to clipboard"`（代码块复制）
  - `packages/tui/src/routes/session/index.tsx:479` → `"Share URL copied to clipboard!"`（success）
  - `packages/tui/src/routes/session/index.tsx:911` → `"Message copied to clipboard!"`（success）
  - `packages/tui/src/routes/session/index.tsx:939` → `"Session transcript copied to clipboard!"`（success）
  - 失败路径：`routes/session/index.tsx:480/912` → `variant: "error"`，`"Failed to copy URL to clipboard"` / `"Failed to copy to clipboard"`
- **行内（inline）复制态**（非 toast）：`component/error-component.tsx` 用一个 React-like `copied` 信号，复制成功后才在按钮旁追加行内文字：
  - 行 75：`{copied() && <text fg={colors.muted}>Successfully copied</text>}`（常驻，非自动消失）
  - 行 59-60：`Clipboard.copy(issueURL...).then(() => setCopied(true))`
- 设计取舍：**选区/对话框复制 → 瞬态 toast；错误页（全屏/异常态）→ 行内持久标记**。同一仓库两种范式并存。

**Claude Code —— 有 N 计数的 toast，措辞 "copied N chars"（经 CHANGELOG 证实）**

- `CHANGELOG.md:3577`：`Fixed the "copied N chars" toast overcounting emoji and other multi-code-unit characters`
  → 证明 CC 的复制反馈是 **toast**、**带 N 计数**、**单位是 chars（按 code point 修正后）**。
- `CHANGELOG.md:4367`：`copy toast now indicates whether to paste with ⌘V or tmux prefix+]`
  → 复制 toast 会随环境（tmux/SSH）改变提示，证明 toast 是**可定制的多行/带上下文**的瞬态区。
- `CHANGELOG.md:1328`：`Fixed copy-on-select on Wayland sometimes not reaching the clipboard`、`:2541`：WSL 下"now uses PowerShell interop instead of OSC 52" → 底层用 **OSC 52 + 平台回退**（与 opencode 同一套纪律）。

**GitHub CLI（gh）—— 非 TUI，行内静态行，无自动消失**

`internal/authflow/flow.go:50-58`（OAuth device-flow）：
```go
err := clipboard.WriteAll(code)
if err == nil {
  fmt.Fprintf(w, "%s One-time code (%s) copied to clipboard\n", cs.Yellow("!"), cs.Bold(code))
} else {
  fmt.Fprintf(w, "%s Failed to copy one-time code to clipboard\n", cs.Red("!"))
}
fmt.Fprintf(w, "%s First copy your one-time code: %s\n", ...)
```
- 措辞：`"One-time code (XXX) copied to clipboard"`（**含对象+内容**，info 语义，前缀 `!` 黄色）。失败行单独打印。
- 呈现：**写进 stderr 的静态行，不自动消失**（gh 是命令式 CLI，非全屏 TUI）。这是"行内常驻"范式的代表。

**bubbletea / bubbles / lipgloss（Charm 系）—— 库层只暴露能力，不提供反馈**

- `bubbletea/clipboard.go`：只导出 `SetClipboard(s)` / `ReadClipboard()`（OSC 52），**无任何"已复制"文案/反馈**。
- `bubbles/textarea/textarea.go:1827-1840` `CopySelection()`：成功 `return copyMsg(text)`，失败 `return copyErrMsg{err}`；`textarea.go:1448` 仅 `m.Err = msg`。**没有面向用户文案，反馈完全留给宿主应用**（库保持中性）。
- `lipgloss`：纯样式库，无 toast/反馈概念。
- → 结论：Charm 生态里"复制反馈"是**应用层职责**，库不内建；各家（crush、charm 示例）自行决定措辞与呈现。

**ink（facebook）—— 库层同样中性**

`ink@7.1.1` 无任何 `toast`/`copied`/`clipboard` 导出（src 全文件清单 297 项逐一核验）。反馈由宿主用 `useEffect`+`setTimeout` 自绘。

**本机 khy-os（对照基线，非外部发现）**

- `services/backend/src/cli/tui/utils/ccFormatters.js:154-163` `formatCopyFeedback()` 已经实现**带 N 计数的三级措辞**（这是你方现有基线）：
  ```js
  if (lines > 1) return `copied ${lines} lines`;
  if (bytes > 1024) return `copied ${(bytes/1024).toFixed(1)}KB`;
  return `copied ${chars} chars`;
  ```
  即：**多行→行数；大文本→KB；小文本→chars**。这套优先级（lines 优先于 chars）与 CC 的 "copied N chars" 不同，CC 恒用 chars。
- `utils/ccFeedback.js:58-72`：`show()` 支持按 `FEEDBACK_TYPE` 取 `TIMING.toast[type]` 的时长；复制走 `SUCCESS`。

### 1.2 设计要点小结（copy）

| 维度 | 行业做法 | 一手证据 |
|---|---|---|
| 措辞 | "Copied to clipboard"（opencode）、"copied N chars"（CC）、"… copied to clipboard"（gh） | 见上 |
| 是否带 N | CC 带（chars，code-point 修正）；opencode 不带；gh 带对象名 | CC CHANGELOG:3577；opencode selection.ts:39 |
| 呈现 | 全屏 TUI → 瞬态 toast；异常页 → 行内常驻；命令式 CLI → 静态行 | opencode toast vs error-component; gh flow.go |
| 自动消失 | toast 自动消失（见 §2）；行内/静态行不消失 | opencode toast.tsx:62-67 |

### 1.3 对 CC 模式 TUI copy 规格的设计含义

- 措辞建议沿用你方 `ccFormatters.js` 的**三级 N 计数**（lines/KB/chars），这是比 CC 的纯 chars 更细的既有基线，且已存在。若要向 CC 对齐，至少保证**多字节/emoji 按 code point 计数**（CC 专门修过过计数 bug，CHANGELOG:3577）——你方 `chars = text.length` 在 emoji 上会**复现同类 bug**（`"😀".length === 2`），建议改用 `Array.from(text).length` 或 `[...text].length`。
- 呈现：常规会话选区复制 → 瞬态 toast（success/info）；错误/全屏态 → 行内常驻（照抄 opencode error-component 双轨）。

---

## 2. Toast / 瞬态消息模式

### 2.1 时长区间

**opencode（默认 5000ms，单槽 replace）**

- 默认时长 5000ms 在两处独立定义（事件 schema + 渲染组件），二者一致：
  - `packages/schema/src/tui-event.ts:9` `const DEFAULT_TOAST_DURATION = 5000`，行 46 `duration` 字段解码默认即 5000。
  - `packages/tui/src/ui/toast.tsx:62` `const toastOptions = { ...options, duration: options.duration ?? 5000 }`；行 65-67 `setTimeout(...).unref()` 自动清空。
- **单槽 / replace 语义**（不堆叠）：`toast.tsx:54-56` `currentToast: null as ToastOptions | null` 只有一个槽位；`show()` 先 `clearTimeout(timeoutHandle)` 再重置（行 62-64）→ **新 toast 直接替换旧的**，不排队、不堆叠。
- 位置：`toast.tsx:24-28` 绝对定位 `top={2} right={2}`，`maxWidth={Math.min(60, width-6)}`，左右边框（`border=["left","right"]`）。即**右上角浮层，不占正文流**。
- 变体：`info | success | warning | error`（`tui-event.ts:45`），边框色取 `theme[variant]`。
- 桌面/web 端（solid-sonner）默认也是 5000ms、右下角、宽度 320、gap 12：`packages/ui/src/v2/components/toast-v2.tsx:54` `duration={5000}`、行 50-53 `position="bottom-right" / offset{right:32,bottom:48} / gap=12`；支持 `persistent`（`duration=Infinity`，行 148）与按 key 去重/脉冲（行 190-219 `showToastV2`，重复同 key 不新增而是 pulse）。

**bubbles（list 状态消息，默认 1s）**

- `bubbles/list/list.go:240` `StatusMessageLifetime: time.Second`（默认 1 秒）。
- `list.go:188-190` 注释："How long status messages should stay visible. By default this is 1 second."
- 机制：`NewStatusMessage()`（`list.go:669-682`）设文本 + `time.NewTimer(Lifetime)`，超时消息 `statusMessageTimeoutMsg`（行 839）清空；**再次调用会 `Stop()` 旧 timer 再重开**（行 671-675）→ **替换/重置语义，不堆叠**。
- 位置：渲染在**标题栏行内**（`list.go:1113` `view += "  " + m.statusMessage`），即"状态栏 + 瞬态区"合并在同一行，截断用 `ansi.Truncate(..., ellipsis)`（行 1114）。
- 示例：`bubbletea/examples/list-fancy/main.go:159` `NewStatusMessage("Added "+title)`、`delegate.go:25/33` "You chose …" / "Deleted …"。

**GitHub CLI（无 toast，行内静态行）**
gh 无全屏 toast；最接近的是 `pkg/iostreams/iostreams.go:343-359` `startTextualProgressIndicator`：禁用 spinner 时打印 `label + "..."`（默认 "Working..."）为**一次性静态行**，不自动消失。

**本机 khy-os（对照基线）**
`utils/ccTimers.js:48-53` 已定义**分变体时长**：`toast = { success:3000, error:5000, warning:4000, info:3000 }`。`ccFeedback.js:59` 按 `TIMING.toast[type]` 取值。即你方基线已是"success/info 3s、warning 4s、error 5s"，比 opencode 的"一律 5s"更细。

### 2.2 堆叠 vs 替换、位置

| 实现 | 堆叠/替换 | 位置 | 默认时长 |
|---|---|---|---|
| opencode 主 TUI | 替换（单槽） | 右上 `top=2,right=2` 浮层 | 5000ms |
| opencode web/desktop | 按 key 去重+堆叠（gap 12） | 右下 `320px` 宽 | 5000ms / 可 persistent |
| bubbles list | 替换（重置 timer） | 标题栏行内，ellipsis 截断 | 1000ms |
| gh CLI | 无 toast | stderr 静态行 | 不消失 |

- **全屏 TUI 主流是"替换 + 右上/状态栏行内"**；"堆叠"主要出现在桌面/web（solid-sonner）而非终端。终端里堆叠 toast 会吃掉正文高度，因此 opencode 全屏版刻意做单槽替换。

### 2.3 关于 charmbracelet/x 的 "log" 组件（重要澄清）

- 你方任务假设"charmbracelet/x 有 log 组件"。**经一手核验，此前提不成立**：
  - `charm-x` main 分支顶层目录树（GitHub API `git/trees/main` + 本地 379 个 .go 全量 grep）**无 `log/` 包**，`exp/` 下也没有（`charmtone, golden, higherorder, maps, open, ordered, slice, strings, teatest, toner`）。
  - 早期 PR #4（2023-05，未合并，`merged_at: null`）"feat: add log mr slog … changes the module path from `github.com/charmbracelet/log` to `github.com/charmbracelet/x/exp/log`"——即 log **始终住在独立仓库 `charmbracelet/log`**，从未并入 x。
- `charmbracelet/log`（独立仓，HEAD `394fd9b1` v2.0.1）是**结构化日志库**（`Logger.Info/Warn/Error`、`SetLevel`、`SetTimeFormat`、`SetReportCaller`、`With`/`WithPrefix`），**没有** transient/expire/auto-dismiss/toast 能力（全量 grep `transient|expir|Clear|Reset|spinner|ticker` 无命中）。它写往 `os.Stderr`，条目**永不自动清除**。
- → **结论：charmbracelet 生态里"瞬态/自动消失"的原语不在 x 或 log，而在（a）`bubbles` 的 list 状态消息（1s，§2.1）与（b）`charmbracelet/x/ansi` 的进度条转义（`ansi/progress.go`：`SetProgressBar`/`SetErrorProgressBar`/`SetWarningProgressBar`/`SetIndeterminateProgressBar`，走 Windows Terminal `\x1b]9;4;N\x07`）。** 若报告需引用"Charm 的 toast"，应引 bubbles list，而非 x/log。

### 2.4 设计含义（Toast）

- 全屏 TUI 用**替换语义 + 固定角位（右上或状态栏行内）**最稳，避免堆叠抢占正文；时长分变体（success/info 短 ~2–3s、error 长 ~5s）符合你方 `ccTimers` 既有基线，比 opencode 的一刀切 5s 体验更好，建议保留。
- 若要"按 key 去重/脉冲"（opencode web 端做法），终端里可用同 key 重置 timer 实现（bubbles 的 `Stop()+NewTimer` 即此模式），避免同类 toast 刷屏。

---

## 3. 滚动指示器（"N above / N below"）

### 3.1 该模式是否常见：是，且分两种流派

**流派 A：数字边缘按钮 "↑ N more above / ↓ N more below"（可点击、可键盘）**

- **Claude Code diff 插件（一手源码 + 测试断言，最完整证据）**
  - 逻辑：`mods/diff/hooks/views/body/plan/segments/list-window-of.ts:13-28` `listWindowOf()` 返回 `{ shown, above, below }`，`above = first`（已滚过行数），`below = 总行 - first - shown`。
  - 渲染：`mods/diff/hooks/views/body/list-block-of.tsx:63-71`
    ```tsx
    const upperEdge = hasMoreAbove
      ? Sections.listEdgeButton(kit, 'list-up', `↑ ${above} more above`)
      : null
    const lowerEdge = hasMoreBelow
      ? Sections.listEdgeButton(kit, 'list-down', `↓ ${lower}`)   // lower 还拼接 "N not shown"
      : hasNotShown ? Sections.dimNote(kit, `… ${lower}`) : null
    ```
  - 底部文案常量：`mods/diff/hooks/names/texts/more-below-text.ts:5`
    `MORE_BELOW_TEXT = 'more below (opt+↓ to scroll)'`（附带操作提示！）
  - 边缘按钮本体：`list-edge-button.tsx:17-36`——`plain dimColor` 的 Button，绑定 `app:diffFileListUp/Down` 与 `scrollList(±1)`。
  - **测试逐字锁定文案**（最强证据）：`mods/diff/tests/views.test.ts`
    - 行 84 `expect(after).toContain('\u2191 1 more above')`
    - 行 100 `toContain('\u2193 2 more below (opt+\u2193 to scroll)')`
    - 行 111 `toContain('\u2193 1 more below')`
  - 约束：窗口上限 8 行（`mods/diff/hooks/limits/sizes/pane/max-summary-rows.ts:5` `MAX_SUMMARY_ROWS = 8`），"past eight files the docked list scrolls by key"（views.test.ts:89 注释）。
  - CHANGELOG 佐证：`CHANGELOG.md:2176` `Fixed /plugin Installed showing a "more above" indicator when already scrolled to the top`（证明"more above"是通用词）。

**流派 B：百分比分页 / 行号 gutter / 滚动条轨道（被动、不可点）**

- **bubbletea pager 示例**：页脚显示 `垂直% : 水平%`（`examples/pager/main.go:113` `fmt.Sprintf("%3.f%%:%3.f%%", ScrollPercent*100, HorizontalScrollPercent*100)`）→ **百分比**而非 N 计数。
- **bubbletea 行号 gutter**：`examples/pager/main.go:66-74` `LeftGutterFunc`，软换行 `if info.Index >= info.TotalLines return "   ~ │ "`，否则 `fmt.Sprintf("%4d │ ", info.Index+1)` → **行号 + `~` 标记**（bubbles `UPGRADE_GUIDE_V2.md:477-485` 给了同款示例）。bubbles API：`bubbles/viewport/viewport.go:126-145`（`GutterFunc`/`GutterContext{Index,TotalLines,Soft}`、`NoGutter`）。
- **opencode 滚动条**（被动轨道，可开关）：`packages/tui/src/routes/session/index.tsx:1183-1192` `verticalScrollbarOptions={{ paddingLeft:1, visible: showScrollbar(), trackOptions:{ backgroundColor, foregroundColor } }}`，且 `stickyScroll={true} stickyStart="bottom"`（行 1193-1194）。开关命令：`routes/session/index.tsx:734-739` `"Toggle session scrollbar"`；键位默认 `keybind.ts:82` `scrollbar_toggle: keybind("none", ...)`（**默认不绑定**，即默认隐藏，`kv.signal("scrollbar_visible", false)` 行 265 默认 false）。
- **charm-x pony scrollview**（新框架，1 行轨道）：`pony/scrollview.go:23-39,120-130` `showScrollbar: true`，`scrollbarWidth=1`，属性 `scrollbar="true"`、`scrollbar-style="fg:cyan"`。
- **bubbles paginator**（`%d/%d`）：`bubbles/paginator/paginator.go:135-137` 默认 `ActiveDot "•"`、`InactiveDot "○"`、`ArabicFormat "%d/%d"` → 页码或点两种渲染（`list-fancy/main.go:147-149` 可切换）。

### 3.2 数字指示 vs 渐变/轨道：哪种被偏好

- **数字 "N more above/below" 是目前 AI-CLI 会话流里的事实标准**（CC 专门做了可点击边缘按钮 + 键盘 opt+↑/↓ + 测试逐字断言），因为它同时给出**计数**与**跳转操作**，且边缘行可 dim 处理。
- **百分比 / 页码**（bubbletea pager、paginator）用于**只读文档/分页列表**，不用于会话流。
- **行号 gutter**（`~` 标记）用于**代码/编辑器**场景。
- **轨道滚动条**（opencode、pony）是**被动位置指示**，默认关闭（opencode 默认 `false`），仅作"我在哪"的视觉锚点，**不替代** "N above" 语义。
- 未见任何家使用"渐变/fade mask"作滚动提示（终端淡出成本高且无先例）；**数值 + 可点边缘**是唯一在会话流被广泛验证的方案。

### 3.3 设计含义（滚动规格）

- 会话流建议采用 **流派 A 数字边缘**：`↑ N more above` / `↓ N more below`，并把"更多未显示"与"N below"合并到下行（CC 的 `lower = "${below} ${MORE_BELOW_TEXT}"` 再拼 `"${notShown} not shown"`）。
- 边缘行应 **dim/可点**，附键盘提示（CC 把 `opt+↓ to scroll` 写进常量）。
- 若想兼顾被动位置感知，可再加一条**默认关闭的 1 行轨道滚动条**（opencode 的 `verticalScrollbarOptions` 范式，默认 false），避免与数字边缘二选一。
- 窗口上限设 8 行（CC 的 `MAX_SUMMARY_ROWS=8`）是已验证的折中。

---

## 4. 零破坏 / 特性门控（env-gate）约定

### 4.1 行业惯例：单前缀 + 真值解析 + 配置层回退

**GitHub CLI（GH_* 前缀，最成体系）**

- 前缀 `GH_`（实测 55 个不同变量），解析纪律见 `internal/ghcmd/cmd.go:349-385` `newIOStreams()`：
  - `GH_PROMPT_DISABLED`：`os.LookupEnv` 命中即 `SetNeverPrompt(true)`（行 352-356）。
  - **真值解析集中**（行 358 `falseyValues := []string{"false","0","no",""}`）：`GH_ACCESSIBLE_PROMPTER`/`GH_EXPERIMENTAL_PROMPTER`/`GH_SPINNER_DISABLED` 均先判 `IsSet`，值落在 falsey 集合才关闭；**env 优先于 config 与 agent 默认**（行 376-384：env set → 用 env；否则 invokingAgent → 禁用；否则 config）。
  - 零破坏保证：`pkg/iostreams/iostreams.go:309-316`——`spinnerDisabled` 时**不创建** spinner 实例，改走 `startTextualProgressIndicator`；`iostreams.go:361-372` `StopProgressIndicator()` 在无 spinner 时是 **no-op**（注释明确"不创建指示器故为 no-op"）→ **关闭路径与开启路径互不干扰，旧路径零改动**。
- "设任意值即生效"惯例：`internal/update/update.go:83` `GH_NO_UPDATE_NOTIFIER`（`!= ""` 即关闭）、`pkg/cmd/root/help_topic.go:94/111` 文档措辞 "set to any value to disable …"。
- 测试逐值锁行为（`internal/ghcmd/cmd_test.go:318-359`）：`GH_SPINNER_DISABLED=0/false/no → 不禁用`、`=1/true → 禁用`、`false 可覆盖 agent 默认`、`env 与 config 互覆盖`；`cmd_test.go:365-368` 用 `t.Setenv(..., "")` + `os.Unsetenv` 双清，确保"set-but-empty 也走 env 分支"。
- 可访问性出口：`pkg/cmd/accessibility/accessibility.go:134` "Set `GH_SPINNER_DISABLED=yes` 环境变量"。

**Claude Code（CLAUDE_CODE_ 前缀，CHANGELOG 反复强调"opt-in/opt-out + 旧行为可恢复"）**

- 数百个 `CLAUDE_CODE_*` 变量（实测命中 168 处），命名纪律：**特性/开关 = `CLAUDE_CODE_ENABLE_X` / `CLAUDE_CODE_DISABLE_X`，参数 = `CLAUDE_CODE_<THING>`，"恢复旧行为" 单独给 `DISABLE` 变体**。
- 零破坏范例（逐字，`CHANGELOG.md`）：
  - `:19` `set CLAUDE_CODE_BG_TASKS_REPORT_RUNNING=0 to restore the old behavior`
  - `:1364` `set CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 to restore the previous behavior`
  - `:1523` cap 默认 20，`override with CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
  - `:3167` `CLAUDE_CODE_DISABLE_ALTERNALTE_SCREEN=1` opt out 全屏 alt-screen，**"keep the conversation in the terminal's native scrollback"**（正是你方滚动区规范的对位开关）
  - `:4000` `CLAUDE_CODE_NO_FLICKER=1` opt-in 无闪烁渲染
  - `:4199/1199` `CLAUDE_CODE_ENABLE_TASKS=false` "keep the old system temporarily"（新功能默认 + 旧系统可暂留）
  - 布尔解析：`TRUE/true/yes/on/1` 视为真（`mods/telemetry/tests/fixtures/analytics-off-environments.ts:11-17` 用 `1/yes/on/TRUE` 各值测试），`DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 可被 `CLAUDE_CODE_ENABLE_*` 反向解除（`:3091`）。
  - 渐进灰度：`:3099` "PowerShell tool now enabled by default on Windows … Opt out with `CLAUDE_CODE_USE_POWERSHELL_TOOL=0`"、`:3606` "progressively rolling out. Opt in or out with …"。

**opencode（OPENCODE_ 前缀，集中 Flag 对象 + 实验位）**

- 集中定义：`packages/core/src/flag/flag.ts:15-78`，纪律清晰：
  - `truthy(key)`（行 3-6）：仅 `"true"/"1"` 为真。
  - **实验位默认关闭**：`enabledByExperimental(key)`（行 11-13）—— `OPENCODE_EXPERIMENTAL_WORKSPACES`/`_REFERENCES` 等**只有同时设了 `OPENCODE_EXPERIMENTAL` 才生效**，否则回落到该 key 自身。这是"KHY_* 风格门控"的最直接对位：**特性默认 off，需显式 env 开启**。
  - **平台条件默认**：`OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT`（行 43-44）`copy===undefined ? process.platform==="win32" : truthy(copy)`——**Windows 默认关、其它平台默认开，env 可覆盖**。
  - **访问时求值**（行 52-77）：`get OPENCODE_DISABLE_PROJECT_CONFIG()` 等用 getter 而非模块加载时取值，注释说明"测试/CLI/外部工具在运行时设这些 env"。
- 消费侧：`packages/opencode/src/config/tui.ts:176,188-192,203` 按 `Flag.OPENCODE_DISABLE_PROJECT_CONFIG` / `OPENCODE_TUI_CONFIG` / `OPENCODE_CONFIG_DIR` 分层加载；`packages/tui/src/app.tsx:277-278` 直读 `process.env.OPENCODE_ROUTE` / `OPENCODE_FAST_BOOT`。

**本机 khy-os（KHY_* 前缀，对照基线）**

- 全仓 `process.env.KHY_*` 命中 280+ 变量（`services/backend/src/cli` 下 37 个与 TUI 直接相关：`KHY_ALT_SCREEN`、`KHY_NO_ALT_SCREEN`、`KHY_REDUCED_MOTION`、`KHY_CC_TUI`、`KHY_INK_TUI_ACTIVE`、`KHY_BRIDGE_FOOTER`、`KHY_BELL_ON_DONE`…）。
- 既有门控风格（一手，`replSession.js`/`tui/app.js`）：
  - `KHY_FULL_TUI`（行 398/640-648）："TUI 模式默认开（opt out via `KHY_FULL_TUI=0`）"，注释明示 `tuiOptOut = KHY_FULL_TUI==='0' || options.fullTui===false`。
  - `KHY_ALT_SCREEN`（`tui/app.js:254-255`）：`CC 模式默认不开备用缓冲区(KHY_ALT_SCREEN=0)`，`非 CC 模式默认开`——**同一变量按运行模式取不同默认**，且 `cc` 模式默认值 `'0'`、其它默认 `'1'`。这正是"CC 模式 vs 其它模式"对位门控的现成先例。
  - `KHY_REDUCED_MOTION`（`ink-components/Spinner.js:25`、`CompactionProgress.js:21`）：`==='1'` 时渲染静态帧（对位 GH 的 spinner 关闭、对位 `prefers-reduced-motion`）。
  - `KHY_INK_TUI_ACTIVE`（`tui/app.js:117` 置 1、行 327 退出 delete）：**运行期注入/清理**的内部开关，配合 `delete process.env.KHY_INK_TUI_ACTIVE` 保证退出后不残留。

### 4.2 通用"零破坏 + 门控"四要素（行业共识提炼）

1. **单前缀**：`GH_*` / `CLAUDE_CODE_*` / `OPENCODE_*` / `KHY_*`。新特性一律挂前缀，杜绝散落的裸变量。
2. **默认值即旧行为**：新特性默认 off（opencode `enabledByExperimental`、CC `ENABLE_*` 显式开、khy `KHY_FULL_TUI` 默认开但可 `=0` 回退）；**关闭路径不得触碰开启路径的分支**（gh `StopProgressIndicator` no-op 注释、`iostreams.go:309-316`）。
3. **真值解析集中且可被更高层覆盖**：`falseyValues=["false","0","no",""]`（gh）、`truthy`（opencode）、`TRUE/true/yes/on/1`（CC）；优先级 **env > 项目/用户配置 > 模式默认**（gh `cmd.go:376-384`、opencode `tui.ts:183-210`）。
4. **可逆 + 可恢复旧行为**：CC 反复给 `DISABLE_*`/`=0` 变体"restore the old behavior"；khy `KHY_FULL_TUI=0` 降级经典模式（`replSession.js:755`）。

### 4.3 设计含义（KHY_* 门控规约）

- 新增"CC 模式 copy/Toast/滚动"微交互时，照抄行业四要素：
  - 用 `KHY_` 前缀（与全仓 280+ 既有变量一致），例如 `KHY_CC_COPY_TOAST`、`KHY_CC_SCROLL_EDGE`。
  - **默认值必须等于当前字节级行为**：新 toast/边缘若默认开，则提供 `KHY_...=0` 一键回退（CC `=0 restore old behavior` 范式）；若默认关，则显式 `=1` 开启（opencode `OPENCODE_EXPERIMENTAL` 范式）。
  - **关闭路径零副作用**：仿 gh `Start/StopProgressIndicator`——关闭时**不创建**实例、`stop` 为 no-op，保证"旧路径逐字节不变"。
  - 真值解析集中：定义 `KHY truthy`（`true/1`）与 `falsy`（`false/0/no/空`）单一函数，env > config > 模式默认，优先级写死并在注释声明（gh `cmd.go:376-384` 注释范式）。
  - 运行期注入/清理：仿 `KHY_INK_TUI_ACTIVE`（`tui/app.js:117` set、`327` delete），门控变量只在进程内有效，退出即清，不写回 shell。
  - **CC 模式对位默认**：参考 `KHY_ALT_SCREEN` 的"CC 默认 `'0'`、其它默认 `'1'`"（`tui/app.js:254-255`），让"CC 模式"与"全屏模式"在门控默认上分流，避免污染非 CC 用户。

---

## 附：可直接链接的一手参考（仓库 + 路径/行号）

**复制反馈**
- opencode `packages/tui/src/util/selection.ts:39`、`app.tsx:438-448`、`component/error-component.tsx:58-75`、`routes/session/index.tsx:479/911/939`
- gh `internal/authflow/flow.go:48-58`
- CC `CHANGELOG.md:3577`（"copied N chars" toast）、`:4367`（copy toast 按 tmux 改提示）、`clipboard.go`（bubbletea OSC52）
- 本机基线 `services/backend/src/cli/tui/utils/ccFormatters.js:154-173`

**Toast / 瞬态**
- opencode `packages/schema/src/tui-event.ts:9/40-50`、`packages/tui/src/ui/toast.tsx:15-67`、`packages/ui/src/v2/components/toast-v2.tsx:48-66/143-219`
- bubbles `bubbles/list/list.go:125/188-193/240/669-682/811-814/1113`、`bubbles/paginator/paginator.go:135-137/190-199`
- charm-x `ansi/progress.go:7-47`（进度条 OSC）；`charmbracelet/log`（独立仓，**无**瞬态能力，澄清 §2.3）

**滚动指示器**
- CC `mods/diff/hooks/views/body/list-block-of.tsx:34-71`、`mods/diff/hooks/views/body/plan/segments/list-window-of.ts:13-28`、`mods/diff/hooks/names/texts/more-below-text.ts:5`、`mods/diff/hooks/views/sections/list-edge-button/list-edge-button.tsx:17-36`、`mods/diff/tests/views.test.ts:84/100/111`、`mods/diff/hooks/limits/sizes/pane/max-summary-rows.ts:5`
- bubbletea `examples/pager/main.go:66-74/113`、`bubbles/viewport/viewport.go:126-145`、`bubbles/UPGRADE_GUIDE_V2.md:477-485`
- opencode `packages/tui/src/routes/session/index.tsx:1183-1194/734-739`、`packages/tui/src/config/keybind.ts:82`
- charm-x `pony/scrollview.go:23-39/120-130`

**门控约定**
- gh `internal/ghcmd/cmd.go:349-385`、`pkg/iostreams/iostreams.go:300-372`、`internal/update/update.go:83`、`pkg/cmd/root/help_topic.go:87-131`、`internal/ghcmd/cmd_test.go:318-380`
- CC `CHANGELOG.md:19/1364/1523/3167/4000/4199`、`mods/telemetry/tests/fixtures/analytics-off-environments.ts`
- opencode `packages/core/src/flag/flag.ts:3-78`、`packages/opencode/src/config/tui.ts:176/188-210`、`packages/tui/src/app.tsx:277-278`
- 本机 `services/backend/src/cli/replSession.js:398/640-648/755`、`services/backend/src/cli/tui/app.js:117/232-255/327`、`tui/utils/ccTimers.js:48-53`
