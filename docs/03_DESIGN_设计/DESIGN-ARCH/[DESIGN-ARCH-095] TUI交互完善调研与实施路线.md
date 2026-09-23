# [DESIGN-ARCH-095] TUI 交互完善调研与实施路线

> **隶属**：本文属 **TUI 设计族**（20 编号 / 21 文件），总纲与 scope 裁决见 `[DESIGN-ARCH-122] TUI 设计族总纲`；规则冲突一律以 `[DESIGN-ARCH-102] Khy TUI 统一规则手册` 为准。

> **定位**：基于 2026-09-12 三路 GitHub 实地调研（终端能力与框架层 / AI 编码代理 TUI / 经典 TUI 交互 excellence）与本地代码基线盘点，给出 khy-os TUI 的**交互差距分析**与 **P0–P3 分阶段实施路线**。它是 [DESIGN-ARCH-089]（模式调研）、[DESIGN-ARCH-090]（痛点调研）之后的第三阶段收口件：089/090 回答「别人做了什么、用户抱怨什么」，本文回答「khy-os 缺什么、按什么顺序补」。
> **适用边界**：只覆盖终端交互层（协议、渲染纪律、输入、键位、可发现性）；视觉布局与组件尺寸归 [DESIGN-ARCH-079]；CC 复刻任务分解归 [DESIGN-ARCH-086]。实施时的工程红线（零硬编码 / 状态消息 / 空闲超时 / 禁滚动区）由 AGENTS.md 工程规则约束，本文不重复。
> **证据基础**：全部结论标注 issue 号或仓库来源；本地差距标注具体文件路径。调研证据缓存：`.tui-research/cache/`（123 文件）、`.tmp-tui-research/`（30+ 文件）——**这两处为调研期临时产物，收工即清理，不作长期真源**。

---

## 0. 调研范围与方法

| 路线 | 对象 | 产出要点 |
|------|------|----------|
| A. 终端能力与框架层 | OSC 8/52、bracketed paste、DEC 2026、kitty keyboard、备用屏 vs 内联、失焦上报、鼠标模式；Ink / Bubble Tea / Textual / ratatui；IME、conpty 怪癖、a11y | 协议发射语法 + 支持矩阵 + 事故案例（issue 号）+ P0–P3 采纳清单 |
| B. AI 编码代理 TUI | opencode、crush、gemini-cli（同 Ink 栈）、codex（ratatui）、Claude Code | 键位表、Copy Mode 方案、撤销/检查点、键位可配置工程、审批 UX、用户 issue 痛点排序 |
| C. 经典 TUI excellence | lazygit、yazi、fzf、atuin、k9s、helix、btop、htop | 可发现性（? / which-key）、导航（视图栈/Esc 语义）、选择、撤销、过滤、鼠标、滚动三态、状态栏、防闪烁、可配置性 |

调研方式：WebFetch/WebSearch 直读官方仓库源码、官方文档与 GitHub Issues API 实拉数据（含 issue 正文）。本会话无视觉模型，调研是唯一信息来源，故每条结论均落到可复核的 issue 号/文件路径。

**三路调研共同指向的六个结论**（后续差距分析的主轴）：

1. **复制是第一痛点**（opencode 295 条剪贴板 issue、crush #661/#695/#2155、gemini-cli #25532、codex #2880）——必须有 Copy Mode 逃生舱 + copy-on-select 开关 + OSC 52/原生双通道。
2. **键位不可配置是第二痛点**（crush #737 未解决、codex #3049 已用 `[tui.keymap]` 关闭、claude #12129 Enter/Ctrl+Enter 之争靠可配置化解）。
3. **滚动区（DECSTBM）绝对禁用**——AGENTS.md 规则 4 与调研结论一致；内联渲染纪律（永不清 scrollback）是一切的前提。
4. **审批弹窗必须可见上下文**（crush #149「盲批权限」）——a/s/d 字母键 + 全屏键 + 对话框内可滚。
5. **Shift+Enter 跨终端之战**（crush #2178、gemini #1942/#6438/#15282、Node 20 无 shift+tab nodejs/node#20314）——换行必须 ctrl+j 零配置保底。
6. **Ink 栈工程细节可直接抄 gemini-cli**（同栈）：useBatchedScroll 同帧合并、退出清理序列 `fs.writeSync` 同步写、启动一次探测。

---

## 1. 本地基线盘点摘要

> 详盘见 086 变更记录与 `.ai/MAP.md`；此处只列与差距分析直接相关的锚点。

### 1.1 规模与结构

- **组件面**：79 个 ink 组件（`services/backend/src/cli/tui/ink-components/` + `components/`），CC 系 `Cc*` 17 个（CcApp / CcTranscriptView / CcPromptInput / CcPermissionPrompt / CcViewStack / CcFuzzyPicker / CcHelpMenu / CcSelectable / CcStatusLine / CcSidebarPanel / CcTable / CcCollapsible / CcToast / CcMessageBar / CcScrollIndicators / CcMcpStatus / CcLogo）。
- **配置面**：约 280 个 `KHY_*` 环境变量门控（软换行 `KHY_SOFT_WRAP`、ghost border `KHY_GHOST_BORDER` 等，默认 off）。
- **能力检测单一真源**：`tui/runtime/terminalCapabilities.js`（单例缓存 + `detectCapabilities(stdout)` + `invalidateCache()`），检测 colorDepth / 背景 COLORFGBG / alt screen / unicode / bracketed paste（`=isTTY`，宽松）/ sync output / hyperlinks / italic / strikethrough。

### 1.2 终端能力「检测 vs 发射」矩阵（差距分析核心输入）

| 能力 | 检测 | 发射/使用 | 差距 |
|------|------|-----------|------|
| OSC 8 超链接 | ✅ `supportsHyperlinks` | ❌ 无发射点 | **检测有、发射无**（P1 补） |
| OSC 52 剪贴板 | — | ⚠️ 仅 `tui/utils/ccClipboard.js`（CC 模式） | **仅单模式**；legacy `/copy` 走 imageService.writeClipboardText（注释自述「诚实差异」） |
| Bracketed paste (DEC 2004) | ⚠️ `=isTTY` 宽松 | ⚠️ 仅 `replSession.js` | **未覆盖 CC 模式**；无多行粘贴审查缓冲 |
| DEC 2026 同步输出 | ✅ | ✅ `cli/syncOutput.js`（Ink v6.7 内置） | 覆盖待核查（P0 核查项） |
| 鼠标 SGR (1006) | — | ✅ `tui/mouseButtons.js` | 无事件粒度开关、无 shift 原生保留声明 |
| ED0 (光标下方擦除) | — | ✅ 真实机制：App.js resizeNonce 防抖 → `outputIntegrityMonitor.assessResize` 双向（shrink+grow）全屏重绘 + scrollbackPreserve Proxy 把 win32 ED2 改写为 `ESC[H+ESC[J`；~~ccResizeHandler.js~~（死代码，2026-09-13 删除，见 §6） | resize 全量重绘已走 ED0；**P0-3 已完成**（CcApp resize 监听补齐 + 归因修正，证据见 §6） |
| ED2/ED3（清 scrollback） | — | ✅ 2026-09-13 全仓核查**零不安全发射**（console.clear 实测 = `ESC[1;1H`+`ESC[0J` 的 ED0 安全形式；ink clearTerminal 由 scrollbackPreserve 边界拦截；taskStore.clearTerminal 系任务记录清理的命名巧合） | **P0-1 已完成**（证据见 §6） |
| kitty keyboard | ❌ | ❌ | **完全缺失**（P2；Ink 已内置探测 #895/#849） |
| 标题 OSC 2/0 | ❌ | ❌ | 缺失（P1） |
| 失焦上报 DEC 1004 + 通知 OSC 9/777 | ❌ | ❌ | 缺失（P2） |
| OSC 7 CWD 上报 | ❌ | ❌ | 缺失（P3） |

### 1.3 输入与键位现状

- **键位路由**：`App.js` 57 处处理行（vim 滚动 j/k/space/b/g/G、ctrl+b/f 翻页、ctrl+p/n 历史、ctrl+e 外部编辑器、meta+m 侧栏、F2、alt+v 粘贴 win 平台特判、shift+tab）。
- **上下文键位栈**：`tui/utils/ccKeyRegistry.js` 四上下文；`tui/arrowRouting.js` 上下文箭头；`cli/escapeTimeoutDetector.js` Esc 决策链。
- **历史搜索**：`ink-components/HistorySearchOverlay.js` 已有（ctrl+r 反向搜索已在）。
- **CJK 输入**：`cli/cjkInputNormalize.js` + `cli/fullWidthInput.js`（组字符归一化）；真光标/组字缓冲策略待对照 IME 三件套核查（P0）。
- **滚动单一真源**：`tui/scrollActions.js`（CcScrollIndicators 分页视口已接，086 变更记录 2026-09-12）。

---

## 2. 调研发现精要（按主题归并三路报告）

> 完整报告内容以 issue 号与文件路径形式内嵌于下文差距分析；本节只给跨项目横向基准。

### 2.1 五大 AI 代理关键设计对照

| 维度 | opencode | crush | gemini-cli | codex | Claude Code |
|---|---|---|---|---|---|
| 发送/换行 | enter；shift/ctrl/alt+enter、ctrl+j | enter；shift+enter、ctrl+j | enter；ctrl/cmd/alt/shift+enter、ctrl+j | enter；ctrl+j/m、enter、shift/alt+enter | enter；`\`+enter、Option+enter、shift+enter、ctrl+j |
| 历史搜索 | up/down | up/down | ctrl+p/n + **ctrl+r** | ctrl+r/ctrl+s | up/down（光标优先）+ **ctrl+r** |
| Copy Mode | #2755 请求中 | `mouse *bool` 配置 | **F9 备用屏 + Ctrl+S 鼠标开关 + 警告横幅** | **raw_output_mode + alt+r**；alternate_screen auto/always/never 三档 | transcript 内 `[` 写入原生 scrollback + `v` 调 $EDITOR |
| 剪贴板实现 | **OSC52+原生双通道** + tmux/screen passthrough | 内置 | 图片探测 + 拖放路径解析 | **SSH/tmux/OSC52 优先级链** + 100KB 上限 + arboard | paste-cache 目录 + [Image #N] chip |
| 撤销/回退 | /undo + /redo（Git，还原文件） | #938 请求中（未实现） | **Esc Esc /rewind 三档** + 影子 Git checkpoint（默认关） | alt+↑ 编辑排队消息 | **/rewind 六动作** + 检查点 100/会话、30 天 |
| 键位可配置 | tui.json 合并默认 + leader_timeout | **不可配（#737 最大批评）** | keybindings.json + `-` 前缀解绑 | **config.toml 12 context + 空数组解绑 + /keymap 三步编辑器** | **keybindings.json 23 context + null 解绑 + 热重载 + 保留键公示** |
| 外部编辑器 | VISUAL‖EDITOR + --wait + **suspend/resume 渲染** | ctrl+o | ctrl+g/ctrl+shift+g | ctrl+g；VISUAL 优先；code→code.cmd shim | ctrl+g/ctrl+x ctrl+e；**上次回复作 # 注释注入** |
| 权限弹窗 | ctrl+f 全屏 | **a/s/d + t 切 diff 模式 + f 全屏**（split≥140 列） | shift+tab 改审批模式 | **ctrl+a 全屏 + y/a/p/d + esc=否决并纠指** | Tab 开评论字段 + shift+tab 会话级允许 |
| 排队消息 | — | — | tab | tab（composer.queue） | **enter 直接排**；工具调用后即传；回合末只发最旧；首行↑收回 |
| IME/宽字符 | — | #2155 CJK 复制丢字 | — | #13638 WSL 重音输入 | — |

### 2.2 经典 TUI 十大交互定式（问题 → 解 → 出处）

| # | 问题 | 最佳解 | 出处 |
|---|------|--------|------|
| 1 | 键位不可发现 | `?` 呼出**随上下文分组**的帮助 | lazygit（按 context 分组）/ k9s（激活态助记键） |
| 2 | 多键前缀记不住 | which-key 弦弹窗（按前缀即弹候选+描述） | helix（g/m/z/Space/Ctrl-w minor mode）/ yazi `[which]` cols 可配 |
| 3 | 帮助与操作脱节 | 帮助菜单可直接执行选中动作 | yazi（Enter = close --submit） |
| 4 | 弹窗里迷路 | Esc 分级弹栈 + 数字直达栈层 | k9s（`:` 压栈、`-` 仿 cd -、面包屑跳层）；lazygit `0` 一步回主面板 |
| 5 | Esc 误退出 | **两级语义：先清输入/查询，为空才退** | fzf `--bind 'esc:cancel'`；atuin 首行↓恢复现场 |
| 6 | 误删无法挽回 | 小写安全/大写危险 + 动态计数确认 + 回收站 | yazi（d 回收站 / D 永久删，`"Trash {n} selected file{s}?"`） |
| 7 | undo 栈重启即丢 | undo 外包给底层持久系统 | lazygit `z`/`Z` 基于 git reflog（跨重启、跨工具撤销） |
| 8 | 鼠标劫持原生选择 | shift 永远保留原生 + 事件粒度开关 | k9s enableMouse 默认 false；yazi `mouse_events=["click","scroll","drag"]` 按事件勾选 |
| 9 | 实时流被滚动打断 | **尾随→上滚暂停→显式跳底恢复** 三态 + 暂停横幅 | btop proc_follow/pause（状态色横幅）；crush EndFollow ctrl+end（#2481 修复） |
| 10 | 重绘闪烁 | 终端同步输出 + 刷新率外化 + 排序稳定性 | btop `terminal_sync=true`、`update_ms`、cpu lazy 排序 |

### 2.3 终端协议层关键事实（发射语法与事故案例）

- **擦除序列分级**：`ED0: ESC[J`（光标下方，安全）；`ED2: ESC[2J`（视口被推入 scrollback，内联模式禁用）；`ED3: ESC[3J`（清 scrollback，**绝对禁止**）。全量重绘安全写法：`ESC[1;1H + ESC[J`。
  事故案例：ink#935/#990（clearTerminal 抹 scrollback）、claude-code#2479（三处清 scrollback 用户炸锅）、ms/terminal#8736（Windows Terminal 的 `ESC[3J` 无开关）。
- **OSC 52**：`ESC ] 52 ; c ; base64(payload) ST`；kitty 规范 ≥64MB，codex 实践上限 100KB（`OSC52_MAX_RAW_BYTES`）；tmux 需包 `\x1bPtmux;\x1b...\x1b\\` passthrough；SSH 远程下 OSC 52 是唯一通道。Windows Terminal 不支持且曾有 200 次冻结 bug（ms/terminal#9479/#20210）——**所以必须双通道**（原生 clip.exe/powershell + OSC 52）。
- **OSC 8**：`` const link = (text, url) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`; ``（URL percent-encode、行尾换行前必须关闭）；codex 实现纪律：**注解只在文本进入缓冲区时应用，永不影响布局几何**（ForcedWidth 保证 cell 宽仍为 1）。
- **kitty keyboard**：压栈 `ESC[>flagsu`、弹出 `ESC[<u`、查询 `ESC[?u`；flags 位 1/2/4/8/16。Ink 已内置（#895/#849），Claude Code 依赖它修 Ctrl+[ 语义（v2.1.242+）。
- **括号粘贴**：`ESC[?2004h/l`，载荷包裹 `ESC[200~...ESC[201~`；fzf#4887 纪律——退出时恢复外层 2004 原状（嵌套时不得把自己关掉就完事）。
- **conpty 怪癖**：帧高 ≤ rows−1（ink#971 Windows 右下角单元格滚动）、resize 全量重绘、DEC 2026 缺失走 cursor-only 快路径、CJK 宽字符截断（ink#928/#930）、production 构建（ink#869 dev 模式开销）。
- **Ink 版本注意**：home+erase-down 修法（ink#994/#995）与 LRU/Yoga 内存修复（ink#987/#999）**晚于当前所用版本未发布**——帧高纪律在升级前是本地责任。
- **退出清理必须同步写**（gemini-cli `terminalCapabilities.ts`）：`fs.writeSync` 同步写清理序列，异步 write 在进程退出前可能没刷出去。
- **启动探测预算**（codex `terminal_probe.rs`）：100ms best-effort（crossterm 默认 2s 太长），探测期间消费的字节要**回放**给解析器，保证用户输入不丢；大粘贴（>1024 字节）留给正常事件读取。

### 2.4 用户痛点强度排序（issue 数据支撑）

1. **复制**（五项目全部中招）→ Copy Mode 三件套是最高优先补齐项之一。
2. **键位不可配置**（crush 最痛，codex/claude 已解）。
3. **多路复用器冲突**（tmux prefix ctrl+B、screen ctrl+A、Zellij——crush ctrl+p #737、codex #9115）→ 键位文档公示 + 可配置逃生。
4. **Shift+Enter**（跨终端矩阵 + Node 版本探测降级：Node 20/早期 22 无 shift+tab，nodejs/node#20314）。
5. **性能**（codex #11678 输入慢、crush #2226 滚动 0.7s/行、gemini #2312 ctrl+c 卡顿、#21623 慢启动）→ 流式渲染 cache-key 化 + 输入节流。
6. **审批盲批**（crush #149）→ 审批时上下文必须可见且可滚。

---

## 3. 差距分析（本地现状 × 调研基准）

> 每条差距给出：现状文件 → 目标模式（含出处）→ 归入的路线阶段。P0=正确性修复，P1=核心体验补齐，P2=竞争力特性，P3=长线工程。

### 3.1 内联渲染纪律（P0——一切的前提）

| 项 | 现状 | 目标 | 出处 |
|----|------|------|------|
| ED3/ED2 残留 | ✅ 2026-09-13 扫描完成（66 命中/3465 文件）：4 处真实代码点全核查——`replSession.js:7547/7550`、`router.js:1040` 的 `console.clear()` 经本机 Node v22.18.0 字节级实测仅发 `ESC[1;1H`+`ESC[0J`（即 ED0 安全形式，非 3J）；ink clearTerminal 全部经 scrollbackPreserve 边界拦截；`taskStore.js:488 clearTerminal()` 是任务记录清理非终端序列 | 仓库内联路径**零** `ESC[3J`/`ESC[2J` 发射；全量重绘一律 `ESC[1;1H + ESC[J`（**已达成**） | ink#935/#990、claude-code#2479 |
| 帧高 ≤ rows−1 | ✅ 2026-09-13 完成（P0-2，锚点修正：实测 sidebarRail 自身无 rows−1 需求）：主战场为消息时间线尾窗行计费——`ToolLines.estimateLiteralRows`（与渲染逐分支同源）+ `liveHeightClamp.tailTimelineToVisualRows` 的 `toolCostOf` 回调（tool 条目按真实渲染行计费，`KHY_TOOL_ROW_BUDGET`）+ `ccLayout.messageAreaCap` 份额算术 + CcApp 尾窗 slice（`KHY_CC_MESSAGE_CAP`）；顺带修复 CcApp 挂载即崩 ReferenceError ×3。测试 67/67，证据见 §6 | 全部渲染路径帧高 ≤ `rows−1`（含 right-rail 带外绘制）**已达成**（时间线主路径；right-rail 带外见 P0-6 已收口 + 后续真实视觉验证） | ink#971（conpty 右下角单元格滚动） |
| resize 行为 | ✅ 2026-09-13 全路径核查完成：Legacy（App.js resizeNonce 防抖 → assessResize 双向全屏重绘 + Proxy ED2→ED0 改写 + rail/topicBar onResize 几何失效清槽）与 CC（CcApp 新增 120ms 防抖 resize 监听 + sanitizeDim 门控）双模式均已接线；~~ccResizeHandler.js~~ 死代码已删除（095 原归因有误，真实机制为 App.js + scrollbackPreserve） | ~~待核查~~ 已核查：全部 resize 监听点一致（right-rail 重算 + 主区全量重绘） | conpty 怪癖表 |
| Static 分块 | Static 区无界（**未实现**，2026-09-13 核查：`useBatchedScroll`/`staticChunk` 全仓零命中；现由四层 scrollbackPreserve 栈兜底最坏症状） | 已提交消息 Static 分块 ≤ 视口高度（防 ink 整树重绘）——**登记为 P1 缺口** | gemini-cli useBatchedScroll 同思路 |
| 流式局部更新 | StreamingBlock 存在 | 流式 chunk 只更新末块而非整树；同一帧多次滚动合并落地 | gemini-cli `useBatchedScroll`（pending-ref 模式） |
| 退出清理 | 未核查 | **同步写**清理序列（恢复 2004/鼠标模式/DEC 2026），`fs.writeSync` | gemini-cli `terminalCapabilities.ts` |

### 3.2 输入体验（P0：IME；P1：编辑键族与换行）

| 项 | 现状 | 目标 | 出处 |
|----|------|------|------|
| IME 组字缓冲 | ✅ 2026-09-13 完成（P0-4）：`cjkInputNormalize.js`/`fullWidthInput.js` 字符归一化之上新增 `imeCommitGuard.js` 共享纯叶子——全宽字符上屏后 120ms 守卫窗内吞掉裸 Enter（modifier 让位），四接线（useTextInput / CcPromptInput / App.js revSearch / 补全菜单）防半截组字被提交 | Enter 组字激活时只提交组字不发送**已达成**（守卫式实现：组字期裸 Enter 吞掉；假光标反显由 textMeasure.visWidth 列宽修正一并缓解） | ink#865/#866/#875、ink#759（gemini-cli CJK 输入） |
| 列宽计算 | textMeasure.js 存在 | 一律 string-width（`"中文".length===2` 但占 4 列）；提供 `ime:false` 配置逃生 | kitty/终端宽字符规范 |
| 换行键兜底 | alt+v 是「粘贴」win 特判；换行键待核查 | 五键兜底：shift+enter / ctrl+enter / alt+enter / **ctrl+j（零配置保底）** / `\`+enter；发布各终端配置指南（WT sendInput `\u001b[13;2u`、Node 版本探测降级） | 五项目共识；nodejs/node#20314 |
| readline 全族 | 部分（ctrl+a/e/k/u/w 待核查） | ctrl+a/e 行首尾、ctrl+k/u 删至尾/首、ctrl+w 删词（词界规则文档化）、ctrl+y yank + kill ring、ctrl+_ 撤销保光标 | Claude Code 编辑族（行业最全） |
| 历史光标优先 | up/down 待核查 | 多行输入时↑/↓先移光标，到首/末视觉行才翻历史 | Claude Code 文档 |
| 多行粘贴 | 无审查缓冲 | 括号粘贴载荷含换行 → 显示为折叠占位（`[N 行已粘贴]`）+ ctrl+o 展开，**不自动提交** | gemini-cli ctrl+o showMoreLines、Claude Code 直接粘贴 |

### 3.3 剪贴板与复制（P1——第一痛点）

| 项 | 现状 | 目标 | 出处 |
|----|------|------|------|
| OSC 52 覆盖 | 仅 `ccClipboard.js`（CC 模式） | 全模式统一复制出口：OSC 52 + 原生双通道并行（win32 powershell UTF-8 必设 `[Console]::InputEncoding`、clip.exe；macOS pbcopy；X11 xclip、Wayland wl-copy） | opencode `clipboard.ts`、codex `clipboard_copy.rs` |
| tmux/screen passthrough | 无 | 检测 `TMUX`/`STY` 时包 passthrough | opencode |
| 尺寸上限 | 无 | OSC 52 载荷 >100KB 时降级提示（codex `OSC52_MAX_BYTES=100_000`） | codex |
| Copy Mode | 无 | **三件套**：专用键切备用屏/raw 模式 + Ctrl+S 切鼠标捕获 + 开启时警告横幅（「Copy Mode：PageUp/Down 滚动，按 X 退出」）；配置 `alternate_screen: auto|always|never` 三档 | gemini-cli F9+Ctrl+S、codex raw_output_mode、claude transcript `[` 写原生 scrollback |
| copy-on-select | 无 | 默认**关**；开时 `ctrl+c` 在有选区时=复制而非中断、escape 清选区、toast 反馈 | opencode #4751/#10490（用户要求开关的实证） |
| CJK 复制验证 | 无专项 | Windows 下 CJK 复制必测（crush #2155 丢中文字符前车之鉴） | crush #2155 |
| transcript 导出 | /copy 走文件 | transcript 内 `[` 写入原生 scrollback（原生搜索/复制可用）+ `v` 用 $VISUAL/$EDITOR 打开 | Claude Code |

### 3.4 滚动与消息流（P1）

| 项 | 现状 | 目标 | 出处 |
|----|------|------|------|
| 尾随/暂停三态 | `scrollActions.js` 单一真源已有，三态待核查 | 默认尾随 → 用户上滚立即暂停 + 横幅「已暂停，N 条新消息，按 G 回底」 → 显式 G/End/ctrl+end 恢复尾随 | btop follow/pause 模型、crush EndFollow（#2481） |
| 滚动梯度 | vim 梯度已有（j/k/space/b/g/G、ctrl+b/f） | 补半页档（ctrl+u/ctrl+d 或 u/d）——行/半页/页/首尾四档 | opencode 五档梯度、crush vim 化 |
| scrolloff 边缘留白 | 无 | 光标距边缘 N 行即开始滚动（配置项，默认小值） | yazi `scrolloff=5`、lazygit `scrollOffMargin` |
| 新消息计数 | 无 | 暂停期间底栏显示新消息计数徽章 | btop 暂停横幅 + fzf `(3/57)` 徽章 |

### 3.5 Esc 语义与导航（P1）

| 项 | 现状 | 目标 | 出处 |
|----|------|------|------|
| Esc 两级语义 | `escapeTimeoutDetector.js` 决策链（Esc/Esc-Esc 待核查） | 输入非空 → 清输入（存历史可↑找回）；空输入 → 中断/弹栈一层。**一次 Esc 永远只做最小撤销** | fzf cancel、Claude Code Esc/Esc-Esc（清草稿/rewind 菜单） |
| 视图栈 | `CcViewStack.js` 已有 | 栈式返回 + 面包屑（数字直达栈层可选） | k9s view stack |
| 焦点路由 | `arrowRouting.js` 上下文箭头 | 核查 Tab/方向键在输入框↔消息区↔侧栏的完整环路 | crush 面板焦点模型 |

### 3.6 可发现性与帮助（P1–P2）

| 项 | 现状 | 目标 | 出处 |
|----|------|------|------|
| `?` 动态帮助 | `CcHelpMenu.js` 已有 | 按**当前上下文分组**（输入框聚焦/消息区/审批弹窗各显其键位）；流式输出期间自动隐藏 | lazygit context 分组、gemini-cli `?` 行为 |
| 底栏键位提示 | CcStatusLine 存在 | 底栏左侧 5–7 个高频键超短标签，随上下文变化 | lazygit 底部按键列 |
| 命令面板 | CcFuzzyPicker 已有 | 核查 `/` 命令 + `:` 风格资源寻址 + fuzzy 过滤三合一入口 | k9s `:`、ctrl+p 共识 |
| 弦提示（若引入 chord） | 无 chord | 引入任何多键前缀必须配 which-key 候选面板 + 超时提示（3s + 取消通知） | opencode which-key 面板、claude chord 3s |

### 3.7 审批 UX（P1——CC 模式已有基础）

| 项 | 现状 | 目标 | 出处 |
|----|------|------|------|
| 快捷字母 | `CcPermissionPrompt.js` 存在 | a/s/d 式快捷字母（allow 本次 / allow 本会话 / deny） | crush 权限对话框 |
| diff 模式 | 待核查 | `t` 切 split/unified；<140 列自动降 unified；`f` 全屏 | crush（splitModeMinWidth=140） |
| 审批上下文 | 待核查 | 审批时上下文可见且可滚（shift+↑/↓ 滚动对话）；「否决并给纠正指引」选项 | crush #149（盲批批评）、codex esc=n 纠指 |
| 权限模式轮换 | shift+tab 已有 | 核查轮换序与降级键（Windows alt+m） | Claude Code 五模式轮换、gemini-cli 三模式 |

### 3.8 键位可配置（P2——第二大痛点）

| 项 | 现状 | 目标 | 出处 |
|----|------|------|------|
| 用户配置文件 | `ccKeyRegistry.js` 内置四上下文 | `~/.khyquant/`（随既有配置目录）下 JSON 键位文件：`{context, bindings: {key: action|null}}`；**null/空数组 = 显式解绑不回落**；加载时校验（无效 action 跳过保默认 + 警告） | codex 三层解析（context→global→默认）、claude 23 context |
| 热重载 | 无 | 文件变更自动应用 | claude |
| 保留键公示 | 无 | 文档公示不可重绑键（Ctrl+C 中断、Ctrl+D 退出、Ctrl+M=Enter、Ctrl+I=Tab）与多路复用器冲突键（ctrl+B/A/Z） | claude keybindings 文档 |
| chord 支持 | 无 | 若引入：≤2 键 + 3s 超时 + 取消提示 | codex MAX_KEY_CHORD_STROKES=2、claude 3s |

### 3.9 终端能力补齐（P1–P3 分散）

| 项 | 现状 | 阶段 | 目标 |
|----|------|------|------|
| OSC 8 发射 | 检测有、发射无 | **P1** | URL（http/https 且有 host）才链接化；短 token 化；降级双写（不支持的终端显示 `text (url)`）；**零几何影响**（codex ForcedWidth 纪律） |
| 标题 OSC 2/0 | 无 | **P1** | 状态迁移时更新（工作中/等待输入/审批中）；≤240 字符 + 控制字符/双向文本净化（Trojan Source 防御，codex `title.rs`）；**不恢复旧标题**（跨终端不可移植） |
| 失焦通知对 | 无 | **P2** | DEC 1004 上报 + OSC 9/777 通知，**仅失焦时发**（审批等待/任务完成）；不做声音（留配置面） |
| kitty keyboard | 无 | **P2** | 启动探测 `ESC[?u` 支持位（Ink 内置）；修复 Ctrl+I/Ctrl+M/Ctrl+[ 歧义；退出弹栈 |
| 鼠标粒度 | mouseButtons.js 全量 | **P2** | `mouse_events = ["click","scroll","drag"]` 按事件勾选；**shift+任何鼠标操作永远原生**；inline 模式默认不开滚轮捕获 |
| OSC 7 + OSC 9;9 双发 | 无 | **P3** | CWD 上报给终端/复用器 |
| 颜色检测链 | colorDepth 检测已有 | **P2** | NO_COLOR > CLICOLOR_FORCE > CLICOLOR > tty 判定链 + 16 色 TTY 降级（btop truecolor→256→tty 三档） |

### 3.10 无障碍（P3）

| 项 | 目标 | 出处 |
|----|------|------|
| 屏幕阅读器模式 | `INK_SCREEN_READER` 式开关：关动画/流式降为分块刷新 | Textual App.SCREEN_READER |
| 减少动效 | spinner/闪烁可关（env 配置） | Textual reduced motion |
| 高对比 | NO_COLOR 语义 + 高对比主题档 | 调研 C 节 |

### 3.11 长线特性（P3——大工程，登记不排期）

| 项 | 参考实现 | 备注 |
|----|----------|------|
| 排队消息 | Claude Code（enter 直接排；工具调用后即传；回合末只发最旧；首行↑收回） | 依赖回合生命周期改造 |
| undo/rewind | gemini-cli 影子 Git 检查点（独立仓库不污染用户 git）+ /rewind 三档 + 诚实边界披露（bash 改动/子代理/外部编辑不入检查点） | lazygit reflog 启发：undo 外包给持久系统 |
| 滚动加速度 | opencode scroll_acceleration（macOS 惯性/固定速度） | 性能敏感，后置 |
| 外部编辑器增强 | opencode suspend/resume 渲染 + `--wait` + Claude IDE lock 互操作；Claude Code 上次回复以 # 注释注入 | khy 已有 ctrl+e 基础 |

---

## 4. 实施路线（P0 → P3）

> 每项给验收标准；P0 全部是「正确性修复」性质，不引入新特性面。

### Phase P0 —— 内联渲染纪律与输入正确性（立即）

| # | 任务 | 涉及文件（锚点） | 验收 |
|---|------|------------------|------|
| P0-1 | ✅ 2026-09-13 完成（零不安全发射，免改码）：全仓扫描 `ESC[2J`/`ESC[3J`/`CSI 3J` 发射点，内联路径清零；全量重绘统一 `ESC[1;1H + ESC[J` | 全 tui 树 | 扫描零命中（保留备用屏上下文的豁免登记）→ 实测达成：4 处真实代码点全安全（证据见 §6 变更记录 2026-09-13 条） |
| P0-2 | ✅ 2026-09-13 完成（四子步，锚点修正：实测 sidebarRail 自身无 rows−1 需求，帧高主战场是**消息时间线尾窗行计费**）：① `ToolLines.estimateLiteralRows` —— 与渲染逐分支同源的字面量体行数估算（Write±diff / shell 折叠·展开·unified-diff / 非 shell 摘要·透明体·12 行预览帽）；② `liveHeightClamp.tailTimelineToVisualRows` 新增 `toolCostOf` 回调 + StreamingBlock 下传 `estimateToolEntryRows` —— tool 条目从恒记 1 行改为真实渲染行计费（未传/异常/非有限/<1 → 恒 1 fail-soft 回退；单条超帽仍保留，与 text 最末行同兜底），消 [IMPL-RPT-044]「同段输出重复多份」式低估导致的右下角推挤（门控 `KHY_TOOL_ROW_BUDGET`）；③ `ccLayout.messageAreaCap` 份额算术（logo/agentTree/streaming/messageBar/toasts/statusBar/input/frame slack +2 全计入 chrome）+ CcApp 消息区尾窗 slice（门控 `KHY_CC_MESSAGE_CAP`）；④ flagRegistry 登记两门控（总数 475） | 实际锚点：`ink-components/ToolLines.js`、`ink-components/liveHeightClamp.js`、`ink-components/toolEntryRows.js`（新）、`ink-components/StreamingBlock.js`、`utils/ccLayout.js`、`ink-components/CcApp.js` | 测试 67/67 绿：ccLayout 18/18、liveHeightClamp 27/27（toolCostOf 计费/回退/超帽 5 例）、toolEntryRows 14/14（从 mojibake 空壳恢复，DEBT.md §六除名）+ userMessageCollapse 8/8；**顺带修复 CcApp 挂载即崩 ReferenceError ×3**（KHY_CC_TUI=1 此前完全无法挂载：estimateAllAgents/formatDuration 未 import、AgentTree/CcTranscriptView 裸引用未走懒加载器） |
| P0-3 | ✅ 2026-09-13 完成：resize 全路径核查——Legacy 路径全绿（resizeNonce 防抖 + assessResize 双向全屏重绘 + Proxy ED2→ED0 改写 + rail 几何失效清槽）；**修复缺口** CcApp resize 监听完全缺失（setCols/setRows 零调用，布局冻结在挂载尺寸）→ 新增 120ms 防抖监听 + `ccLayout.sanitizeDim` 三态门控；**删除死代码** ccResizeHandler.js（零消费者，原 §49/§134/§247 归因有误已修正）；Static 分块核查为零命中，登记为 P1 缺口 | `ink-components/CcApp.js`、`utils/ccLayout.js`（+10 测 `tests/cli/tui/ccLayout.test.js`）；删除 `utils/ccResizeHandler.js`、`utils/ccTimers.js` 孤儿条目 | resize 后无内容丢失、无重复帧（Legacy 既有保证维持；CC 模式布局随窗口尺寸更新） |
| P0-4 | ✅ 2026-09-13 完成（IME 组字上屏守卫为核心，列宽与包帧按实际状态收口）：**imeCommitGuard.js 共享纯叶子**——全宽字符插入后 120ms 守卫窗内吞掉裸 Enter（modifier 让位），防半截组字被提交；四接线 useTextInput / CcPromptInput / App.js revSearch / 补全菜单。CcPromptInput 六修：shift+return 死分支（先于 return 判定）、astral 字素步进（Backspace/Vim x 用 _prevStep/_nextStep，代理对一个码点删）、dwidth 回退链接 textMeasure.visWidth（CJK 不再退 UTF-16 长度）、粘贴标记 ESC[200~/201~ 剥离、Vim x/dw astral 安全、Ctrl+W 删前词。列宽：textMeasure.visWidth 为既有真源，本步完成输入框回退链接；DEC 2026 包帧依赖 Ink v6.7 内置 syncOutput（§1.2 已登记），无本地工作 | 实际锚点：`cli/tui/imeCommitGuard.js`（新）、`cli/tui/hooks/useTextInput.js`、`ink-components/CcPromptInput.js`、`ink-components/App.js`、`ink-components/ToolLines.js`（字素叶子 `utils/Cursor`） | 测试 imeCommitGuard.test.js + ccPromptInput.test.js 源级契约全绿（组件依赖 inkRuntime 惰性加载，按 abortInterruptWiring 范式锚定源码结构；纯函数 _prevStep/_nextStep/visWidth 直接断言行为） |
| P0-5 | 括号粘贴全模式 + 多行粘贴折叠占位（不自动提交）+ ctrl+o 展开 | `cli/replSession.js` → 抽公共模块 | 粘贴含换行文本显示 `[N 行已粘贴]`；退出时恢复外层 2004 原状（fzf#4887） |
| P0-6 | 退出清理同步化：`fs.writeSync` 写全部恢复序列（2004/鼠标/DEC 2026 弹栈） | 会话退出路径 | 退出后终端 `infocmp` 式检查无残留模式；嵌套 tmux 不被污染 |

### Phase P1 —— 核心体验补齐（复制/滚动/Esc/标题/OSC 8）

| # | 任务 | 依赖 | 验收 |
|---|------|------|------|
| P1-1 | ✅ 2026-09-13 完成（ccClipboard.js 升级为全模式剪贴板服务：native 系统工具先行 + OSC 52 非 TTY 兜底 + TMUX/STY DCS passthrough + 100KB 上限 + CJK 按 UTF-8 字节；legacy `/copy`、`/share` 与 CC Ctrl+Y/vim y/命令面板三路全收敛同一出口；`describeClipboardFailure` 按 reasons 出具修复建议文案；flagRegistry 登记 5 门控总数 480） | P0-6 | legacy `/copy` 与 CC 模式行为一致；SSH 远程可复制；>100KB 提示降级 |
| P1-2 | ✅ 2026-09-13 完成（启动进度条：bootPhaseLine 新增 `write(text, step, totalSteps)` 签名，无分母时每 1s 刷新 elapsed 时钟「已等待 Xs」，有分母时显示「text (step/total)」；khy.js 调用点改传 step/total=5——`⌛ khy 正在启动`/`⏳ 加载环境配置 (1/5)`/`✓ 环境就绪 (1/5)`/`🔄 准备运行环境 (2/5)`/`✓ 就绪 (2/5)`。裸等待文案合规化：noiseFilter 11 条 RULES 全改走 `formatStatusMessage(action, target, progress)` 三维度；replyGuard `buildRetryStatusLabel` 无 counter 时补「(第 1 次)」；toolUseLoopCore 续接「(第 1 次)」补上） | P1-1 | 启动等待显示 已等待 Xs；所有用户可见状态行含 动作+目标+进度 |
| P1-2 | Copy Mode 三件套：专用键切备用屏 + Ctrl+S 鼠标开关 + 警告横幅 + `alternate_screen` 三档配置 | P1-1 | WT 下鼠标选择复制原生可用；退出横幅明示按键 |
| P1-3 | 尾随/暂停三态滚动 + 新消息计数横幅 + 半页档 + scrolloff 配置 | `tui/scrollActions.js` | 上滚即暂停；G/End 恢复；暂停期计数徽章正确 |
| P1-4 | Esc 两级语义统一（清输入→最小撤销；Esc-Esc 已有基础沿用） | — | fzf cancel 语义回归；草稿可↑找回 |
| P1-5 | 标题 OSC 2/0（状态迁移更新 + 240 字符净化 + 不恢复旧标题） | — | 标题随工作/等待/审批状态切换 |
| P1-6 | OSC 8 发射 + 降级双写（零几何影响纪律） | — | 支持/不支持终端双形态正确；复制不带走转义 |
| P1-7 | 换行五键兜底 + 各终端配置指南文档（WT sendInput、Node 版本探测降级） | — | ctrl+j 零配置可用；Node 20 环境自动降级提示 |
| P1-8 | `?` 帮助上下文分组 + 流式期间自动隐藏 | CcHelpMenu | 三种聚焦态各显对应键位 |

### Phase P2 —— 竞争力特性（键位配置/失焦通知/kitty/鼠标粒度/过滤多选）

| # | 任务 | 验收 |
|---|------|------|
| P2-1 | 键位用户配置文件（JSON + null 解绑 + 三层解析 + 校验警告 + 热重载 + 保留键/复用器冲突公示） | codex 语义回归：解绑后不回落默认 |
| P2-2 | 失焦通知对（DEC 1004 + OSC 9/777，仅失焦时发） | 审批等待时终端标签页出现角标/系统通知 |
| P2-3 | kitty keyboard 探测启用（Ink 内置）+ 退出弹栈 | Ctrl+[/Ctrl+I/Ctrl+M 歧义消除 |
| P2-4 | 鼠标事件粒度配置 + shift 永远原生声明 | 只开滚轮不开点击可配；shift+click 始终原生选择 |
| P2-5 | 消息多选（space=选中+下移 yazi 式）+ `/` 过滤（fzf 语法子集 + `!` 反选）+ 计数徽章 | 批量复制/导出多段消息可用 |
| P2-6 | 删除分级（d 软删可恢复 / D 永久删 + 动态计数确认） | 确认文案含计数「永久删除 3 条消息？」 |
| P2-7 | NO_COLOR > CLICOLOR_FORCE > CLICOLOR > tty 颜色链 + 16 色 TTY 降级 | NO_COLOR 下零彩色输出 |

### Phase P3 —— 长线工程（登记待排期）

OSC 7 CWD、a11y 配置面（screen reader/reduced motion）、排队消息、undo/rewind 影子 Git 检查点、外部编辑器增强（suspend/resume + IDE 互操作）、滚动加速度。

### 4.1 不采纳清单（调研证据支持的反模式）

| 不采纳 | 理由 |
|--------|------|
| ANSI 滚动区（DECSTBM） | AGENTS.md 规则 4 红线；丢弃 scrollback（例外仅全屏备用屏 + 退出恢复） |
| 内联模式默认启用鼠标滚轮捕获 | 没收原生滚轮/选择；k9s 默认 false、yazi 按事件勾选的实证 |
| copy-on-select 默认开 | opencode #4751/#10490/#5489 用户要求开关的实证 |
| `ESC[2J`/`ESC[3J` 在内联路径 | ink#935/#990、claude-code#2479 事故 |
| 退出时恢复旧标题 | codex 判定跨终端不可移植，不做 |
| 异步写退出清理序列 | gemini-cli 实证：进程退出前可能没刷出去 |
| 硬编码键位不可配置 | crush #737 最被诟病点 |
| 探测期间丢弃用户输入 | codex startup replay 纪律：必须回放 |

### 4.2 与现有任务体系的关系

- P0 各项是 [DESIGN-ARCH-086] Phase 0「基础约束」的**延续核查**（086 Phase 0 已完成的部分指布局约束；本 P0 指协议纪律），完成后在 086 变更记录登记。
- P1-2/P1-3/P1-4 对应 086 §2「遗漏细节清单」的复制反馈/滚动指示器两项收口。
- P2-1 键位配置与 [DESIGN-ARCH-088]（CC 快捷键系统 RedoFork）衔接：088 管键位语义设计，095 P2-1 管用户配置面。
- 本路线不改动 [DESIGN-ARCH-079] 的布局/尺寸真源；新增 env 门控沿用 079 §9 命名规范（`KHY_*`）。

---

## 5. 交叉引用

| 文档 | 关系 |
|------|------|
| [DESIGN-ARCH-079] TUI界面设计规范 | 布局/尺寸/组件真源；本文 §3 差距回填其协议章节 |
| [DESIGN-ARCH-086] CC TUI 复刻总计划 | 任务跟踪真源；本文 P0–P3 路线并入其视图 |
| [DESIGN-ARCH-088] CC快捷键系统 | 键位语义设计；P2-1 配置面的上位输入 |
| [DESIGN-ARCH-089] TUI设计模式调研报告 | 调研上游（模式层） |
| [DESIGN-ARCH-090] TUI用户评价调研与痛点分析 | 调研上游（痛点层） |
| AGENTS.md 工程规则 | 红线约束（零硬编码/状态消息/空闲超时/禁滚动区） |

---

## 6. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-09-12 | 初版：三路 GitHub 调研（终端能力与框架层 / AI 编码代理 TUI / 经典 TUI excellence）综合本地基线盘点成文；给出 3.1–3.11 差距分析与 P0–P3 实施路线、不采纳清单 |
| 2026-09-13 | **P0-1 完成**：全仓 ED2/ED3 发射点扫描（五模式扫描脚本，66 命中/3465 文件）+ 4 处真实代码点逐一核查。结论：内联路径零不安全发射，无需改码。证据链：① 本机 Node v22.18.0 字节级实测 `console.clear()` = `cursorTo(0,0)`+`clearScreenDown()` = `ESC[1;1H`+`ESC[0J`（ED0，scrollback 安全）——调研期「console.clear 含 3J」的说法对本 Node 版本不成立，特此更正；② `replSession.js:7547/7550`（TTY 非可用回退路径）与 `router.js:1040`（非 REPL 直跑 clear 命令）三处调用因此全部安全；③ ink 唯一的 2J/3J 构造点（clearTerminal）由 `tui/scrollbackPreserve.js` 在 stdout 边界全面拦截（剥 3J + win32 改写 `[H[J`）；④ `taskStore.js:488 clearTerminal()` 系删除 legacy 终态任务记录的纯命名巧合，非终端序列。门禁 `check-agent-rules.js`（cli+tasks 549 文件）零违规 |
| 2026-09-13 | **P0-5 完成**：粘贴归档与展开——多行粘贴不再自动提交：显示 `[N 行已粘贴 · ID]` 归档占位（带唯一 ID tag），ctrl+o 循环展开/收起，提交前强制展开复原全文（防丢失）。11 个新测试全绿 + 邻近 66 Jest 全绿 + `check-agent-rules.js` 零违规。附带修正 flagRegistry 两个 TUI 门控元数据矛盾（验证全值一致） |
| 2026-09-13 | **P0-6 完成**：备屏退出清理——`?1049l` 备屏恢复双路径汇聚（printInkResumeHint 开头 + replSession 2004/?25h 安全网）+ exit 兜底钩子（once-guard 三钩子）；退出字节全部 `fs.writeSync` 同步化（防异步丢弃）。7 个新测试全绿，含 2 个 spawn 子进程端到端黄金证据 |
| 2026-09-13 | **P0-3 完成**：resize 全路径审计 + 修复。审计结论：Legacy 路径全绿（App.js resizeNonce 120ms 防抖 → terminalCapabilities.invalidateCache → `outputIntegrityMonitor.assessResize` shrink/grow 双向全屏重绘 → scrollbackPreserve 四层栈 + Proxy 单 write 原子性；sidebarRail/topicBar onResize 几何失效清槽）。发现并修复缺口：**CcApp（CC 模式整树替换 Legacy App）resize 监听完全缺失**——setCols/setRows 自挂载后零调用，布局冻结在挂载时尺寸。修复：CcApp 内新增 120ms 防抖 resize useEffect（对齐 App.js:3595 范式）+ `ccLayout.sanitizeDim` 三态门控（0=垃圾测量拒绝、undefined=未知、仅有限正数提交；镜像 App `_resolveResizeCols` 纪律）+ unmount cleanup。删除死代码 `tui/utils/ccResizeHandler.js`（60 行 ResizeHandler 类，全仓零消费者零测试）及 `ccTimers.js` 孤儿 `resize` 条目；本表 §49/§134/§247 原把 resize ED0 安全归因于该死代码，系**错误归因**，已修正为真实机制（App.js resizeNonce + assessResize + Proxy 改写）。另核查 Static 分块（useBatchedScroll/staticChunk 全仓零命中）为未实现目标，登记为 P1 缺口（§134 已标注）。新增 `tests/cli/tui/ccLayout.test.js` 10 测全绿（sanitizeDim 三态 + getLayout 响应式关系 + CcApp 接线源码契约：监听/防抖/cleanup/sanitizeDim）；CcApp/ccTimers 模块加载校验通过；全仓扫描零残留引用 |
| 2026-09-13 | **P0-4 完成**：IME 组字上屏守卫 + CcPromptInput 六修。新增共享纯叶子 `cli/tui/imeCommitGuard.js`（全宽字符插入后 120ms 守卫窗内吞掉裸 Enter，modifier 让位；防 IME 组字半截上屏被 Enter 误提交——Windows Terminal/conpty 中文输入法场景）并四接线：useTextInput / CcPromptInput / App.js revSearch / 补全菜单。CcPromptInput 六修：① shift+return 判定移至 key.return 之前（修复永远不可达死分支）；② astral 字素步进——Backspace/Vim x/dw 借 `utils/Cursor` 的 _prevStep/_nextStep 按字素而非 UTF-16 码元删/移（代理对当一个码点）；③ dwidth 回退链接 `textMeasure.visWidth`（CJK 显示宽度不再退 UTF-16 长度，缓解假光标错位）；④ 粘贴标记 `ESC[200~`/`ESC[201~` 剥离（bracketed paste 标记不再入库污染输入）；⑤ Vim x/dw astral 安全；⑥ Ctrl+W 删前词。DEC 2026 包帧：Ink v6.7 内置 syncOutput 已覆盖（§1.2 登记为 ✅），无本地工作。测试：imeCommitGuard.test.js（守卫窗纯函数行为）+ ccPromptInput.test.js（源码契约：shift+return 顺序 / IME 守卫接线 / astral 步进 / dwidth 回退 / 粘贴标记剥离）全绿；check-agent-rules 零违规 |
| 2026-09-13 | **P1-1 完成**：剪贴板统一出口——`tui/utils/ccClipboard.js` 整体重写为全模式剪贴板服务（单一真源，七导出/五门控）：① native 先行复用 `imageService.writeClipboardText`（powershell Set-Clipboard 保 UTF-8 / pbcopy / xclip / wl-copy，载荷走 stdin 管道注入安全）；② OSC 52 仅非 TTY stdout 发射（TTY 下喷转义污染画面，`shouldEmitOsc52` 返回 `tty` 静默）；③ TMUX/STY 包 DCS passthrough 外层 `\x1bPtmux;`+ESC 字节加倍+`\x1b\\`（`KHY_CLIPBOARD_PASSTHROUGH` 默认开）；④ 载荷 > `KHY_CLIPBOARD_MAX_BYTES`（默认 100000，0=不限）→ `oversize` 由调用方提示降级；⑤ `KHY_CLIPBOARD_DUAL=1`（默认关）时 native 成功后补发 OSC 52。统一返回 `{ok, channels, bytes, reasons}` 绝不抛。**三路接线同一出口**：legacy `handlers/copy.js`（`/copy`）+ `routerDispatchSlash.js` share 分支（`/share`，失败文案改走新纯叶子 `copyReply.describeClipboardFailure`——gate/native/osc52:tty/oversize/全空各分支，oversize 含 KB 数字与 `KHY_CLIPBOARD_MAX_BYTES=0` 修复建议）+ CC 模式（`CcApp` 新增 Ctrl+Y 全局键复制最近助手回复 toast 回执 + `CcPromptInput` vim `y` 剪贴板双写（寄存器 + 系统剪贴板，fail-soft 不阻断 vim 操作）+ 命令面板 `/copy` 项 + `CcHelpMenu` GENERAL_SHORTCUTS 补 Ctrl+Y + `keybindingCatalog` global 组补 Ctrl+Y）。`nativeWrite` 接受 `opts.nativeCall` 注入，jest.mock imageService 在懒 require 下仍命中。**测试**：ccClipboard.test.js（node:test）20/20 绿（门控梯/TTY 静默/CJK base64 可还原/oversize UTF-8 字节级/TMUX DCS 字节级/dual 双通道/空载荷/gate-off/nativeCall 注入）+ copyReply.test.js 13/13（含 describeClipboardFailure 4 例）+ router.test.js 55/55 回归绿（share 三断言不变：mock 仍经 nativeCall 命中、toHaveBeenCalledWith(md) 载荷不变）。flagRegistry 登记 5 门控（KHY_CC_CLIPBOARD 总闸 / KHY_CLIPBOARD_OSC52 / KHY_CLIPBOARD_DUAL(opt-in 默认关) / KHY_CLIPBOARD_PASSTHROUGH / KHY_CLIPBOARD_MAX_BYTES numeric，总数 475→480）；check-agent-rules 11 文件零违规 |
| 2026-09-13 | **P1-2 完成**：启动进度条与状态文案合规化。① `bootPhaseLine.js` 重写：新增 `write(text, step, totalSteps)` 签名——无分母时每 1s 刷新 elapsed 时钟（`已等待 Xs`，`_elapsedMsToStr` 纯叶子格式化 500ms/3.2s/1m 04s 三档）；有分母时静态显示「text (step/total)」，由调用方控制步进节奏；`stopElapsedTimer` 在 clear/end 均触发，绝不活到 TUI 稳态；`elapsedTimer.unref()` 防阻塞 Node 退出。② `bin/khy.js` 5 处调用点改传 step/total=5：`⌛ khy 正在启动`（无分母，elapsed）→ `⏳ 加载环境配置 (1/5)` → `✓ 环境就绪 (1/5)` → `🔄 准备运行环境 (2/5)` → `✓ 就绪 (2/5)`。③ 裸等待文案合规化（规则 2）：`noiseFilter.js` 11 条 RULES 全改走 `formatStatusMessage(action, target, progress)` 三维度（如 `切换 模型通道（第 1 次）`）；`replyGuard.buildRetryStatusLabel` 无 counter 时补「(第 1 次)」；`toolUseLoopCore` 续接 label 补「(第 1 次)」。check-agent-rules 5 文件零违规 |
| 2026-09-13 | **P0-2 完成**：帧高纪律四子步（**锚点修正**：原表锚点 `tui/runtime/sidebarRail.js` 经实测无 rows−1 需求，帧高主战场为消息时间线尾窗行计费，本条按实际实现登记）。① `ToolLines.estimateLiteralRows`：与渲染器逐分支同源的字面量体行数估算（Write±diff 走 buildWriteDiffRows / shell 走折叠·展开·unified-diff·exitCode≠0+1 / 非 shell 折叠恒 1 摘要行·展开透明体门控（KHY_TOOL_RESULT_TRANSPARENT 默认开）走 shell 全量·否则 12 行预览帽+截断标记；全程 try/catch→0）。② `ink-components/toolEntryRows.js`（新）：`estimateToolEntryRows` 门控 `KHY_TOOL_ROW_BUDGET`——未完成=头行 1+progress 1、失败=头行+错误折叠（ccUserFacingToolError 收敛→toolErrorFold.planErrorFold）或展开详情、完成=头行 1+estimateLiteralRows、_agentTree 非空=1、退化输入=1、memo 幂等。③ `liveHeightClamp.tailTimelineToVisualRows` 新增 `toolCostOf` 回调 + StreamingBlock 下传（live 模式 expanded 门控）：tool 条目从恒记 1 行改为真实渲染行计费——未传/抛异常/非有限/<1 → 恒 1 fail-soft 回退、`Math.floor` 取整、单条成本超帽仍保留该条（与 text「至少保留最末 1 行」同兜底）；消 [IMPL-RPT-044]「同段输出重复多份」式低估导致的右下角推挤。④ `ccLayout.messageAreaCap` 份额算术（logo 2+1+副标题 / agentTree / streaming 2 / messageBar 1 / toasts / statusBar / inputRows / frame slack +2 全计入 chrome，`n-chrome` 即消息区帽）+ CcApp 消息区尾窗 slice（门控 `KHY_CC_MESSAGE_CAP`）+ flagRegistry 登记（总数 475）。**顺带修复 CcApp 挂载即崩 ReferenceError ×3**（estimateAllAgents/formatDuration 未 import、AgentTree/CcTranscriptView 裸引用未走 getAgentTree()/getCcTranscriptView() 懒加载器——KHY_CC_TUI=1 此前完全无法挂载，生产路径实渲染证实已修复）。测试 67/67 绿：ccLayout.test.js 18/18（messageAreaCap 算术 6 例 + CcApp 源级契约 2 例）、liveHeightClamp.test.js 27/27（toolCostOf 计费/回退/超帽兜底 5 例）、toolEntryRows.test.js 14/14（**从 mojibake 隔离空壳按当前 src/ 重写恢复**，断言值全部为探针对实现实测；tests/DEBT.md §六同步除名 + 恢复进展注记）、userMessageCollapse.test.js 8/8；check-agent-rules 10 文件零违规；4 个 .tmp 探针全部清除 |

---

> **文档状态**：Active — 随实施进度更新
> **创建日期**：2026-09-12
> **最后更新**：2026-09-13（**P0 全部完成** + **P1-1 剪贴板统一出口完成** + **P1-2 启动进度条与状态文案合规化完成**；详情见 §6）
