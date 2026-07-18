# [DESIGN-ARCH-053] 命令与第三方应用输出折叠：几行预览与 Ctrl+O 展开

> 渲染层 `services/backend/src/cli/tui/ink-components/`（ink TUI，默认交互渲染器）
> 目标:bash 命令(如 `ls`)与 khy 终端内第三方应用(如 claude code)的 stdout,默认只显示**几行**,其余折叠为 `… +N 行 (ctrl+o 展开)`(Claude Code 风格),按 **Ctrl+O** 展开完整结果。agent 自身的说明与结构化结果**完整真实显示,绝不折叠**。

## 1. 问题

ink TUI(默认渲染器,`KHY_FULL_TUI` 默认开)里命令输出走两层折叠,结果是**默认看不到命令输出**:

1. `ToolLines.js` 旧逻辑:成功工具折叠时只显示 `✓ 完成`/摘要,展开时 `slice(0,12)` 静默裁剪 —— 命令 stdout 既无折叠标记也无 Ctrl+O 承诺。
2. `ProcessGroup.js` 折叠态:`stepTools = showAll ? tools : failed` —— **成功步骤全部并入表头 `✓N` 计数**,连一行预览都不留。

经典 REPL 渲染器(`toolDisplay.js`)早有 `foldOutput`+`_expandableOutputs`+Ctrl+O,但它在 TTY 下提前 return(交给 TUI),所以交互态从未生效。缺口完全在 ink TUI。

## 2. 设计原则

- **范围严格限定**:只有 shell 族工具(`bash/shell/command/terminal/pty`)与第三方应用 stdout 享受"几行+折叠+Ctrl+O";agent 散文与非命令结构化结果**永不在此折叠**。
- **不太长就全展开**:折叠仅在超过阈值时触发。TUI 专用 `SHELL_COLLAPSED_POLICY = {maxLines:20, foldHead:12, foldTail:6}` —— ≤20 行**完整显示**,>20 行才折为头 12 + 标记 + 尾 6。比共享 `bash` 策略(maxLines:6)宽松,因为用户把命令输出当一个整体读,6 行太激进。
- **三类内容视觉区分(Claude Code 风格)**:
  - 用户提问 `❯`(cyan 粗体);
  - 用户 `!` 直跑命令 `!`(magenta 粗体);
  - AI 生成输出:纯 markdown,**无连接符**;
  - **命令原生结果:首行 `⎿ ` 弯头连接符 + 续行 `  ` 对齐缩进(整块 dim gray)**,读作"命令输出块",与 AI 散文一眼分清。这是 Claude Code 的既有视觉语言(经典 REPL `toolDisplay.js` 早已用 `⎿`);agent 工具 stdout(`ToolLines`)与用户 `!` 输出(`bash-output`)共用同一弯头语言。
- **单一真源**:折叠规则复用 `toolDisplayPolicy.foldOutput`(与经典 REPL 同源);shell 判定 `isShellResult` 由 `ToolLines` 导出,`ProcessGroup` 复用同一函数,折叠决策与逐步渲染锁步。
- **默认即可见**:命令输出是用户运行的结果,折叠态(默认)也要露几行,不并入 `✓` 计数。
- **诚实**:`… +N 行 (ctrl+o 展开)` 标记仅在折叠且确有隐藏行时出现;展开后不再承诺。
- **失败/退出码永不静默**:`success:true, exitCode:2` 的命令在折叠 stdout 下补 `↳ 退出码 N`;失败步骤一律可见(沿用红线)。

## 3. 改动

| 文件 | 改动 |
|---|---|
| `ToolLines.js` | 新增 `SHELL_FAMILY` 集合 + `isShellResult(name)`(规整大小写/分隔符);shell 分支:`git diff` 形 stdout 走红绿着色,否则 `foldOutput(allLines, SHELL_COLLAPSED_POLICY)`(20 行阈值,展开态放宽到 400 行)折叠;**首行加 `⎿ ` 弯头连接符 + 续行 `  ` 对齐**(`SHELL_ELBOW`/`SHELL_CONT`,整块 dim gray,CC 风格)标识命令原生输出;补非零 `退出码 N` 黄色脚注。导出 `isShellResult` 供 `ProcessGroup` 复用。 |
| `ProcessGroup.js` | 折叠态 `stepTools` 由 `failed` 扩为 `tools.filter(t => 失败 ‖ isShellResult(t))` —— 成功 shell 步骤折叠态仍可见(经 `ToolLines` 折叠出几行预览),非 shell 成功步骤仍并入 `✓` 计数。 |
| `Transcript.js` | `bash-output`(用户 `!` 直跑命令的 stdout)首行加同款 `⎿ ` 弯头 + 续行 `  ` 对齐,与 agent 命令输出共用 CC 视觉语言。 |
| `toolDisplayPolicy.js` | `foldOutput` 折叠标记改 Claude Code 风格 `… +N 行 (ctrl+o 展开)`(单 `…` 省略号),两渲染器同源。 |
| `useQueryBridge.js` | `projectToolResultForView` 透传 `exitCode`(此前被字段白名单剥离,属 [[project_tui_bridge_field_stripping]] 同族),使折叠 stdout 能标注退出码。 |

## 4. 防呆

1. **范围锁**:`isShellResult` 单一判定,非 shell 工具与 agent 散文不进折叠分支。
2. **退出码不静默**:有 stdout 时非零退出码补黄色脚注;无 stdout 时摘要已带 `[退出码 N]`。
3. **展开诚实**:展开态绝不显示 `ctrl+o 展开` 承诺,折叠态确有隐藏行才显示标记。
4. **失败永显**:`ProcessGroup` 折叠态失败步骤恒可见。
5. **单源复用**:折叠 `foldOutput`、shell 判定 `isShellResult` 均单一真源,两渲染器/两组件不重复实现。

## 5. 实证

- `tests/tui/inkRenderSmoke.test.js` 新增 6 例(长 stdout 折叠+`ctrl+o 展开` 标记/展开全显无承诺/**不太长全显无折叠**/**`⎿` 弯头区分**/第三方 `terminal` 同折叠+带弯头/`ProcessGroup` 折叠态保留 shell 输出而非 shell 成功并入计数)。
- `tests/tui/foldOutputMarker.test.js` 新增 3 例**回归锁**:锁死 `foldOutput` 标记必须是 CC 形 `… +N 行 (ctrl+o 展开)`——单 `…` 省略号(非 `...`)、含 `+N` 隐藏计数、绝不含旧文案 `查看完整`;短输入不折叠、长输入头+标记+尾且 hiddenCount 诚实。
- 经典 REPL `streamRender.js` 超长 AI 输出折叠标记同步对齐 `… +N 行 (ctrl+o 展开)`(全产品一致),`ProcessGroup.js` 陈旧注释同步。

全套 TUI **194 例绿**。

## 6. 关联

- 上位显示规范 `[DESIGN-ARCH-016] AI_Agent显示规范`;字段剥离族 [[project_tui_bridge_field_stripping]];折叠策略源 `toolDisplayPolicy.foldOutput`(经典 REPL `toolDisplay.js` 同源)。
