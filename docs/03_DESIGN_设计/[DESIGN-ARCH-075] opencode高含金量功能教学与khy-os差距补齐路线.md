# [DESIGN-ARCH-067] opencode 高含金量功能教学与 khy-os 差距补齐路线

> **本文是「对照学习 + 差距分析 + 分阶段实施路线」,不是一次性落地稿。**
> 以开源 AI 编码代理 opencode(当前环境为 1.18.x,文档核对于 2026-08-06)为对照对象,
> 逐项提炼其**高含金量功能**(教学要点),如实标注 khy-os 中**相同 / khy 特有 / 未做或做法不同**之处,
> 并给出**分阶段补齐路线**(每阶段含验收标准)。
>
> 与 [DESIGN-ARCH-063](对照《Claude Code 架构》)同属「借他山之石」系列,但对象换成 opencode;
> 沿用其**以真实源码行号为准、不猜测、不转抄**的核对纪律。
>
> **阅读者**:负责逐个教学 + 实现的维护者/AI。教学顺序、差距判定、验收标准均以本文为单一真源。

---

## 0. opencode 高含金量功能全景(教学大纲)

按「学习价值 × khy-os 复用价值」排序,共 12 项。每项含:一句话是什么、khy-os 对应实现(真源)、差距级别。

| # | 功能 | 一句话价值 | khy-os 对应实现(真源) | 差距 |
|---|---|---|---|---|
| 1 | **References 跨目录引用** | 把工作区外的文档库/共享库/其他仓库以 `@alias` 注入上下文 | **未发现对应实现** | 🔴 真差距 |
| 2 | **LSP 自动诊断反馈循环** | 自动拉起语言服务器,把诊断喂回 agent 循环 | `tools/LSPTool/index.js`(手动查询式) | 🟡 部分 |
| 3 | **Permissions auto 模式 + 目录边界** | 全局 `--auto` 自动批准 + `external_directory` 边界 | `permissionStore.js`(normal/acceptEdits/auto/yolo)、`approvalLedger.js` | 🟡 部分 |
| 4 | **Agent 体系(主/子代理、Plan 模式)** | 专业化代理 + 只读计划模式 | `agents/built-in/`(17 个)、`subAgentOrchestrator.js`、`EnterPlanMode/ExitPlanMode` | ✅ 已覆盖 |
| 5 | **Skills 按需加载** | SKILL.md 定义可复用行为,on-demand 加载 | `SkillTool`、`skillRegistry`、`DiscoverSkillsTool`、`ccSkillBridge` | ✅ 已覆盖 |
| 6 | **MCP(本地+远程+OAuth)** | 外接工具生态,含 Streamable HTTP 与 OAuth | `services/mcp/` 全套 + `McpAuthTool` + governance | ✅ 已覆盖 |
| 7 | **Commands 自定义斜杠命令** | `/命令` + `$ARGUMENTS`/`!shell`/`@file` 模板 | `commands/ccCommandBridge.js`、`repl/ccUserCommands.js` | ✅ 已覆盖 |
| 8 | **Custom Tools** | 用户自建工具,与内置工具并列 | `CreateToolTool` + 约定式工具发现(`tools/index.js`) | ✅ 已覆盖 |
| 9 | **上下文压缩** | 长会话自动摘要续跑 | `services/contextCompressor.js`(智能切点) | ✅ 已覆盖 |
| 10 | **/undo /redo 可逆** | 撤销/重做消息与文件改动 | `handlers/rollback.js`(`rewind`/`undo`) | ✅ 已覆盖 |
| 11 | **Rules 分层指令(AGENTS.md)** | 项目/全局/CC 兼容分层规则 | `services/instructionFileService.js`、`metadataPointers.js` | ✅ 已覆盖(本地) |
| 12 | **会话分享(/share)** | 生成可分享链接 | `/share` 仅导出本地 markdown | ⚪ 产品决策差异 |

> 结论:khy-os 已覆盖 opencode 约 80% 核心能力。**值得教学并补齐的是第 1、2、3 项**;其余为「已覆盖,可作教学对照」。

---

## 1. 差距详解

### 1.1 🔴 References 跨目录引用(opencode 独有,khy-os 缺失)

**opencode 是什么**:在 `opencode.json` 里用 `references` 声明工作区外的本地目录(`path`)或 Git 仓库(`repository`),
带 `description` 注入 agent 系统上下文、`hidden` 控制 `@` 补全可见性。使用方式:
- `@alias` 把引用根作为上下文附加;`@alias/` 搜索其内部文件。
- agent 在系统上下文里拿到已解析路径 + 描述,相关时自行读取。
- 引用目录自动豁免 `external_directory` 权限边界(只豁免读,编辑仍需权限)。

**khy-os 现状**:全仓未发现等价概念。khy-os 的 `@` 文件引用(`repl/atPicker.js`、`atMentionInject.js`)仅限工作区内的模糊搜索,
无「外部目录 / Git 仓库注册 + 描述注入 + 权限边界豁免」机制。

**补齐方案**(待实现阶段细化):
1. 新增配置区(拟 `~/.khyquant/references.json` 或 `.khy/references.json`),字段对齐 opencode:`alias/path|repository/branch/description/hidden`。
2. 启动/REPL 会话装配时解析引用,把「别名 + 路径 + 描述」注入系统上下文(纯文本块,`@alias` 补全数据源)。
3. 扩展 `atPicker`/`atMentionInject` 支持 `@alias` 与 `@alias/子路径` 模糊搜索。
4. 权限边界:读取引用目录走「引用目录豁免」路径,但写/执行仍走既有 permission gate。
5. Git 仓库引用:克隆/更新到缓存目录(`dataHome` 既有体系),可选用 `scout` 式只读材料化。

**验收**:配置两条引用(本地目录 + Git 仓库)后,`@alias` 可补全并注入内容;agent 上下文可见描述;越权写被 permission gate 拦截。

### 1.2 🟡 LSP 自动诊断反馈循环(opencode 为自动,khy-os 为手动)

**opencode 是什么**:按文件扩展名自动发现并拉起语言服务器(typescript/pyright/eslint/vue/rust 等 30+),
把 `diagnostics` 作为反馈喂给 agent,自动修错。`lsp` 配置项控制启用/禁用/自定义 server + `initialization` 选项。
文档明确提示「LSP 有内存/不同步代价,多数项目建议直接跑 lint/typecheck 命令更划算」——即这是**可选项**。

**khy-os 现状**:`tools/LSPTool/index.js` 提供 `definition/references/hover/symbols/diagnostics/…` 十一种动作,
是 agent **主动查询**式;`execute()` 若无连接 server 直接返回「configure a language server」提示。
未见「按文件扩展名自动拉起 server → 自动注入 diagnostics → 触发修复」的自动闭环。

**补齐方案**(待实现阶段细化):
1. 新增 `lspManager`:懒扫描工作区扩展名 → 匹配 server 注册表(内置 typescript/pyright/eslint/vue/py 等)→ 拉起进程。
2. 在工具循环里加「诊断检查点」:agent 改动文件后,对受影响文件跑一次 diagnostics,结果作为 tool result 喂回。
3. 复用既有 LSP 客户端连接层(查询 LSPTool 依赖的同一 client),避免双协议栈。
4. 默认关闭(对齐 opencode 谨慎立场),用 flag/配置开启。

**验收**:开启后,改动一个含类型错误的 TS 文件,agent 循环内自动收到该文件 diagnostics 并可据此修复。

### 1.3 🟡 Permissions auto 模式 + 外部目录边界

**opencode 是什么**:
- `opencode --auto` 或运行时切换「auto-approve」:未显式 deny 的请求自动批准;`deny` 仍强制生效。
- `external_directory`:任何触达工作区外的路径操作需边界放行;`~`/`$HOME` 通配符;允许后继承工作区默认权限。
- 对象语法按工具输入做 glob 级规则,「最后匹配生效」;`doom_loop` 检测同一工具 3 次重复调用。

**khy-os 现状**:
- 权限模式已有 `normal / acceptEdits / auto / bypass / yolo`(`permissionStore.js:6-17`),`auto` 已自动放行常规调用、
  破坏性仍问(对齐 CC `--permission-mode` 语义);`approvalLedger.js` 有 `KHY_AUTO_APPROVE` 门(默认关)。
  → **auto 模式本体已覆盖**,但缺「`opencode --auto` 式的进程级一键开关 + 显式 deny 仍强制的同级 UX」确认。
- 工作区外路径:未见 `external_directory` 语义的显式边界层(搜 `external_directory` 无命中);
  khy-os 靠 `agentFsService` + syscallGateway 做沙箱,但「按路径模式放行外部目录」未显式化。

**补齐方案**(待实现阶段细化):
1. 审计 `permissionStore`/`approvalRouter` 是否已覆盖「deny 优先于 auto」;缺则补。
2. 新增 `external_directory` 规则面:路径模式(支持 `~`/`$HOME`)→ allow/ask/deny,接入既有 permission 判定链。
3. 为 `approvalLedger`/permissionStore 提供进程级 auto 开关 CLI(`khy --auto` / `permission auto on|off`),显式 deny 不受影响。

**验收**:`khy --auto` 后常规工具不弹窗,`deny` 规则仍拦截;配置外部目录放行后,`read` 允许但 `edit` 仍按默认。

---

## 2. 分阶段实施路线

> 原则:每阶段一小步,先教学(讲清 opencode 机制与 khy-os 对应)、再设计(本文更新/细化)、再实现、再验收。
> 所有改动遵守 khy-os 工程规则(零硬编码 / 状态透明 / 活动超时 / 无滚动区),改动后跑
> `node scripts/check-agent-rules.js --changed` + 既有单测。

| 阶段 | 内容 | 输出 | 验收 |
|---|---|---|---|
| **P0** | References 跨目录引用(差距 1.1) | 配置 + 装配 + `@alias` 补全 + 权限边界 + Git 缓存 | 见 1.1 验收 |
| **P1** | LSP 自动诊断反馈循环(差距 1.2) | lspManager + 诊断检查点 + 开关 | 见 1.2 验收 |
| **P2** | Permissions auto 开关 + 外部目录边界(差距 1.3) | 规则面 + CLI 开关 + deny 优先审计 | 见 1.3 验收 |
| **P3** | 已覆盖功能逐一对照教学 + 收尾 | 对照文档补记 + 索引更新 | 12 项全部有定稿对照 |

每阶段动工前,先在本文档对应小节更新「方案」为带文件:行的落地设计(沿 [DESIGN-ARCH-060] 接线铁律)。

---

## 3. 关联文档

- 系列对照:[DESIGN-ARCH-063] 对照《Claude Code 架构》、[DESIGN-ARCH-061] 更新包学习。
- 实现规范:[DESIGN-ARCH-060] khy 功能接线与编排总图(接线五件套)、[DESIGN-ARCH-017] 元工具系统。
- 治理上位规范:`docs/08_MGMT_项目管理/[MGMT-STD-001]`;维护者入口 `.ai/`。
