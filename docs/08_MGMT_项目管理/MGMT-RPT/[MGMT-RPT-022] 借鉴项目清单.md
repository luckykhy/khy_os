# khy-os 借鉴/参考项目清单

> 本文梳理 khy-os 各模块借鉴了哪些外部项目，以及借鉴的具体内容。
> 目的：让 khy-os 从"四不像"变成"有据可查的拼装体"，便于后续取舍和重构。
> 生成时间：2026-09-12

---

## 总览

| # | 借鉴来源 | 类型 | 借鉴深度 | 影响模块 |
|---|----------|------|----------|----------|
| 1 | Claude Code (Anthropic) | AI 编码助手 | **深度** — 架构+UI+交互 | CLI/TUI、Agent、权限、上下文、提示词 |
| 2 | OpenCode | AI 编码助手 | **深度** — 配置+生态 | MCP、Provider、Agent、配置体系 |
| 3 | ZCode (智谱) | AI 桌面端 | **深度** — UI 1:1 复刻 | khyos-desktop、品牌、交互文案 |
| 4 | Hermes Agent v0.18.0 | AI Agent 框架 | **中等** — 验证支柱 | Goal 证据门、/goal 实现 |
| 5 | cc-switch (farion1231) | 多工具密钥管理 | **中等** — 架构模式 | 密钥中心、Agent 导出、工具矩阵 |
| 6 | Y-code (星瑶) | AI 编程助手 | **中等** — 模式借鉴 | Prompt 组装、记忆、工具压缩 |
| 7 | xv6 / Linux | 教学 OS 内核 | **中等** — 设计模式 | kernel/ 调度/分页/VFS/进程 |
| 8 | MoonBit | WASM 语言 | **轻度** — 集成 | kernel/moonbit/ 桥接 |
| 9 | Electron + VS Code | 桌面框架 | **中度** — 架构模式 | khyos-desktop 四进程模型 |
| 10 | React + Ink | TUI 框架 | **中度** — 渲染层 | CLI TUI 组件体系 |
| 11 | Qoder CLI | AI CLI 工具 | **轻度** — CLI 模式 | CLI 参数解析、命令体系 |
| 12 | Command Code (cmdc) | AI CLI 工具 | **轻度** — 配置模式 | Provider 配置、CLI 入口 |

---

## 1. Claude Code — 最深借鉴

**来源**：Anthropic 官方 Claude Code；khy-os 文档 `DESIGN-ARCH-063` 明确以 CC 架构为阅读主线。

### 借鉴内容

| 方面 | 借鉴点 | khy-os 实现 |
|------|--------|-------------|
| **整体架构** | Agent-as-OS 理念 | `kernel/` + `services/backend/` + `apps/ai-frontend/` |
| **REPL 循环** | 提示→模型→工具→结果回灌→收敛 | `services/backend/src/cli/repl.js` + `toolUseLoop.js` |
| **命令系统** | 大 switch 分发 + handler 模式 | `services/backend/src/cli/router.js` + `handlers/` (115个) |
| **工具系统** | 约定式自动发现 + 工具面按角色裁剪 | `src/tools/index.js` + `toolProfile.js` (minimal/coding/analysis/verification) |
| **上下文压缩** | CLAUDE.md 记忆 + 上下文窗口管理 | `MEMORY.md` + `memdir/` + `services/compact/` |
| **MCP 扩展** | MCP 服务器作为扩展通道 | `services/mcp/` 全套 |
| **权限模型** | normal/acceptEdits/auto/yolo 模式 | `permissionStore.js` + `approvalLedger.js` |
| **Agent 体系** | 内置 Agent (Explore/Plan/General) | `agents/built-in/` (17个) + `subAgentOrchestrator.js` |
| **提示词工程** | 负向指令(NEVER) + 验证Agent + 工具级Prompt | `src/constants/prompts.js` |
| **TUI 渲染** | Ink 渲染 + 状态栏 + 工具卡片 | `services/backend/src/cli/tui/` (完整 CC TUI 复刻计划) |
| **品牌系统** | 橙色品牌色 + Logo + 状态栏 | `ccTheme.js` + `ccBrand.js` (Khy 品牌替换) |
| **快捷键** | Ctrl+O/R/C 等交互模式 | `DESIGN-ARCH-088` 快捷键系统设计 |
| **输入框** | ShimmeredInput + ModeIndicator | `DESIGN-ARCH-082` CC模式输入框设计 |
| **状态消息** | 动作+目标+进度 三维 | AGENTS.md 规则 2 |
| **活动超时** | 空闲重置计时器 | AGENTS.md 规则 3 |
| **禁止 ANSI 滚动区** | 保存/恢复光标模式 | AGENTS.md 规则 4 |
| **fail-soft** | 叶子函数返回 `{ok:false, error}` | AGENTS.md 工程红线 |

### 设计文档

- `docs/03_DESIGN_设计/[DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS.md`
- `docs/03_DESIGN_设计/[DESIGN-ARCH-081] Claude Code TUI 1:1 复刻实施计划.md`
- `docs/03_DESIGN_设计/[DESIGN-ARCH-086] CC TUI 复刻总计划与子任务跟踪.md`
- `docs/03_DESIGN_设计/[DESIGN-ARCH-082] CC模式输入框与光标设计.md`
- `docs/03_DESIGN_设计/[DESIGN-ARCH-083] CC模式表格与折叠设计.md`
- `docs/03_DESIGN_设计/[DESIGN-ARCH-084] CC模式注意力与选择设计.md`
- `docs/03_DESIGN_设计/[DESIGN-ARCH-085] CC模式子视图子菜单卡片与滚动设计.md`
- `docs/03_DESIGN_设计/[DESIGN-ARCH-087] CC模式微交互与反馈设计.md`
- `docs/03_DESIGN_设计/[DESIGN-ARCH-088] CC快捷键系统RedoFork与执行偏差处理.md`
- `docs/03_DESIGN_设计/[DESIGN-ARCH-089] TUI设计模式调研报告.md` (100项目调研)
- `docs/03_DESIGN_设计/[DESIGN-ARCH-090] TUI用户评价调研与痛点分析.md`

### 关键证据

- `DESIGN-ARCH-063` 原文："本文是一条「阅读主线」,不是新设计。它借用一本讲 Claude Code 架构的书的目录作为骨架"
- `DESIGN-ARCH-081` 原文："定义 khy-os TUI 复刻 Claude Code 官方 TUI 的 1:1 视觉与交互实施方案"
- khy-os TUI 组件全部以 `Cc` 前缀命名（`CcStatusLine`、`CcToolCard`、`CcPromptInput` 等）

---

## 2. OpenCode — 配置与生态借鉴

**来源**：sst/opencode 开源项目；khy-os 文档 `DESIGN-ARCH-075` 明确以 OpenCode 为对照。

### 借鉴内容

| 方面 | 借鉴点 | khy-os 实现 |
|------|--------|-------------|
| **References 跨目录引用** | `@alias` 注入外部目录上下文 | 未实现（差距清单 P0） |
| **LSP 自动诊断** | 自动拉起语言服务器 + 反馈循环 | `tools/LSPTool/index.js`（手动查询式，缺少自动闭环） |
| **Permissions auto 模式** | `--auto` 自动批准 + 目录边界 | `permissionStore.js` (normal/acceptEdits/auto/yolo) |
| **Agent 体系** | 主/子代理 + Plan 模式 | `agents/built-in/` (17个) + `subAgentOrchestrator.js` |
| **Skills 按需加载** | SKILL.md 可复用行为 | `SkillTool` + `skillRegistry` + `DiscoverSkillsTool` |
| **Commands 斜杠命令** | `/命令` + 模板变量 | `commands/ccCommandBridge.js` + `repl/ccUserCommands.js` |
| **Custom Tools** | 用户自建工具 | `CreateToolTool` + 约定式工具发现 |
| **上下文压缩** | 长会话自动摘要 | `services/contextCompressor.js` |
| **Undo/Redo** | 撤销/重做 | `handlers/rollback.js` |
| **Rules 分层指令** | AGENTS.md 分层规则 | `services/instructionFileService.js` |
| **MCP** | 本地+远程+OAuth | `services/mcp/` 全套 |
| **配置格式** | `opencode.json` 配置结构 | `.opencode/config.json` (khy-os 也有) |
| **Provider 树** | provider 配置树 | `opencodeAdapter.js` |

### 设计文档

- `docs/03_DESIGN_设计/[DESIGN-ARCH-075] opencode高含金量功能教学与khy-os差距补齐路线.md`
- `docs/03_DESIGN_设计/[DESIGN-ARCH-067] opencode高含金量功能教学与khy-os差距补齐路线.md` (重复/早期版)

### 关键证据

- `DESIGN-ARCH-075` 原文："以开源 AI 编码代理 opencode(当前环境为 1.18.x)为对照对象,逐项提炼其高含金量功能"
- khy-os 适配了 OpenCode 的 `mcp` 配置格式（而非 Claude Code 的 `mcpServers`）

---

## 3. ZCode (智谱) — 桌面端 1:1 复刻

**来源**：ZCode Desktop (智谱 GLM 编程 Agent 桌面端)；khy-os 文档 `DESIGN-ARCH-092` 明确 1:1 复刻。

### 借鉴内容

| 方面 | 借鉴点 | khy-os 实现 |
|------|--------|-------------|
| **UI 布局** | 1:1 复刻 ZCode Desktop v3.11.2 界面 | `apps/khyos-desktop/` 完整复刻 |
| **交互文案** | 文案/交互/数据契约完全对齐 | `zcode-analysis/i18n-zh.json` (5070条) |
| **CSS 令牌** | 456 个 CSS 自定义属性 | `zcode-analysis/tokens.txt` |
| **RPC 表面** | 127 个 RPC 方法 | `zcode-analysis/rpc-surface.json` |
| **四进程模型** | main/host/scheduler/preload ×6 | khyos-desktop 进程架构 |
| **Provider 配置** | provider 槽位 + 登录门 | `zcodeAdapter.js` |
| **品牌替换** | ZCode → KhyOS | `check-brand-replacement.js` |

### 设计文档

- `docs/03_DESIGN_设计/[DESIGN-ARCH-092] ZCode 1：1 复刻设计文档.md`（在 khyos-desktop CLAUDE.md 中引用）

### 关键证据

- `khyos-desktop/CLAUDE.md` 原文："khyOS 桌面端：ZCode 1:1 复刻，对外呈现与 ZCode Desktop v3.11.2 完全一致的界面、交互、文案与数据契约"
- `zcode-analysis/` 目录含解包 ZCode 的完整真源数据

---

## 4. Hermes Agent — 验证支柱借鉴

**来源**：Hermes Agent v0.18.0（Python agentic CLI）；khy-os 文档 `DESIGN-ARCH-065` 明确参考。

### 借鉴内容

| 方面 | 借鉴点 | khy-os 实现 |
|------|--------|-------------|
| **验证证据门** | 5字段契约 + 外部 judge 裁决 + 证据要求 | `goalStopGate.js` + `KHY_GOAL_EVIDENCE_GATE` |
| **Goal 系统** | /goal 命令 + 契约模型 | `goalCore.js` + `goalStopGate.js` |
| **MoA 判断** | 虚拟 provider + 参考并行 + aggregator 综合作答 | 仅 Arena 排名，未实现综合作答 |
| **/learn 进化** | 目录/网页蒸馏 → SKILL.md | `skillLearningService`（缺少目录/网页来源） |
| **/journey 时间线** | skill + memory 可视化 | 未实现统一视图 |

### 设计文档

- `docs/03_DESIGN_设计/[DESIGN-ARCH-065] Hermes Agent v0.18.0 参考学习-判断验证自我进化.md`

### 关键证据

- `DESIGN-ARCH-065` 原文："Hermes Agent v0.18.0 的三大关键词——判断（MoA）/ 验证（evidence-based completion）/ 自我进化（/learn·/journey）——对 Khy-OS 各有不同的落地价值"
- "样本仅供设计参考，未引入任何 Hermes 源码/依赖"

---

## 5. cc-switch — 密钥管理架构借鉴

**来源**：farion1231/cc-switch；khy-os 文档 `DESIGN-ARCH-093` 明确参考。

### 借鉴内容

| 方面 | 借鉴点 | khy-os 实现 |
|------|--------|-------------|
| **双层存储** | SQLite 可同步 + JSON 设备级 | `cc_switch.json` + `api_keys.json` |
| **双向同步** | 切换写 live + 编辑回填 live | 模式 B 同步（cc-switch 式兜底） |
| **最小侵入** | 不改工具原生配置 | adapter 模式只写目标工具 live 配置 |
| **Agent 导出** | 统一 MCP/Skills/Prompts 面板 | khy agent 注册表为 SSoT |
| **工具矩阵** | 多工具 × 投递模式 × 激活卡片 | ccSwitch APPS 矩阵 |

### 设计文档

- `docs/03_DESIGN_设计/[DESIGN-ARCH-093] 密钥与智能体统一管理（工具矩阵与zcodeAdapter）设计规范.md`

### 关键证据

- `DESIGN-ARCH-093` 原文："外部调研源：farion1231/cc-switch、sst/opencode（docs/config+agents+models）、Claude Code 官方 docs（sub-agents/settings）、kingsword09/zcode-cli（CONFIGURATION.md）、pjpv/zcode-switch、smartlizi/zcode-account-switcher"

---

## 6. Y-code (星瑶) — 模式借鉴

**来源**：Y-code AI 编程助手（feng-chenhao/xingyao-y-code）；khy-os 文档 `[DESIGN-ARCH-109] Y-code 借鉴实施方案` 明确参考。

### 借鉴内容

| 方面 | 借鉴点 | khy-os 实现 |
|------|--------|-------------|
| **Stable+Dynamic Prompt** | 稳定前缀(跨turn缓存) + 动态上下文 | `promptAssemblyService.js` |
| **ToolSpec 元数据权限** | frozen dataclass 驱动权限检查 | 部分（权限检查仍隐式） |
| **源码压缩** | 去除尾部空白+合并空行 | `sourceTextCompressor.js` |
| **工具结果压缩** | head+tail 截断 | `toolResultCompressor.js` |
| **长期记忆 KAIROS** | 日志+MEMORY.md+dream consolidation | `memoryKairos.js` |
| **Session Undo/Checkpoint** | 撤销/检查点 | 未实现 |
| **Session Share/Export** | MD/HTML/JSON 导出 | 未实现 |
| **工具参数幻觉过滤** | schema 过滤 LLM 伪造参数 | 部分实现 |
| **失败子 Agent 自愈** | 重试+换策略注入 | 已实现 |

### 设计文档

- `docs/03_DESIGN_设计/[DESIGN-ARCH-109] Y-code 借鉴实施方案.md`

---

## 7. xv6 / Linux — 内核设计模式借鉴

**来源**：教学操作系统 xv6（MIT）和 Linux 内核设计模式。

### 借鉴内容

| 方面 | 借鉴点 | khy-os 实现 |
|------|--------|-------------|
| **引导流程** | Multiboot2 → 长模式切换 | `kernel/boot/boot.asm` + `long_mode.asm` |
| **内存管理** | 物理页分配器 + 虚拟内存分页 + COW | `kernel/src/pmm.c` + `vmm.c` + `process.c` |
| **进程调度** | 抢占式调度 + Ring 3 用户态 | `kernel/src/sched.c` + `process.c` |
| **文件系统** | VFS 抽象 + 持久化文件系统 | `kernel/src/vfs.c` + `diskfs.c` + `ramfs.c` |
| **系统调用** | int 0x80 + 系统调用表 | `kernel/src/syscall.c` (20个调用) |
| **信号** | POSIX 风格信号 | `kernel/src/signal.c` |
| **管道** | 管道 IPC | `kernel/src/ipc.c` |
| **ELF 加载器** | ELF64 加载 | `kernel/src/elf.c` |
| **PE 加载器** | Windows PE 加载 + IAT 重定向 | `kernel/src/pe.c` + `wincompat.c` |
| **终端** | VGA 文本 + framebuffer | `kernel/src/vga.c` + `framebuffer.c` |
| **窗口管理器** | 简易 WM | `kernel/src/wm.c` |
| **网络栈** | 雏形网络栈 | `kernel/src/net.c` |
| **能力安全** | 基于 capability 的访问控制 | `kernel/src/capability.c` |

### 关键证据

- `kernel/README.md` 明确列出了上述所有子系统
- `DESIGN-ARCH-007` 微内核 IPC 设计参考了微内核架构模式
- MoonBit 桥接参考了 WASM 模块集成模式

---

## 8. Electron + VS Code — 桌面端架构借鉴

**来源**：VS Code (Electron) 架构模式。

### 借鉴内容

| 方面 | 借鉴点 | khy-os 实现 |
|------|--------|-------------|
| **多进程模型** | 主进程 + 渲染进程 + 预加载 | khyos-desktop 四进程模型 |
| **IPC 通信** | 主渲染进程通信 | `electron/services/` |
| **窗口管理** | 多窗口 + 托盘 | `electron/main.js` |
| **自动更新** | electron-updater | `khyos-desktop` 内置 |
| **菜单栏** | 系统菜单 + 上下文菜单 | `electron/` |
| **终端集成** | xterm.js | `@xterm/xterm` |

---

## 9. React + Ink — TUI 框架借鉴

**来源**：React + Ink (React for CLI)。

### 借鉴内容

| 方面 | 借鉴点 | khy-os 实现 |
|------|--------|-------------|
| **组件模型** | React 组件 + Hook | `services/backend/src/cli/tui/ink-components/` |
| **渲染引擎** | Ink 运行时 | `inkRuntime.js` CJS 桥接 |
| **状态管理** | React hooks + useQueryBridge | `useQueryBridge.js` (4181行) |
| **上下文菜单** | 右键菜单 | Ink 组件 |
| **输入处理** | 键盘事件 + 光标控制 | `tui/` 输入处理 |
| **静态渲染** | `<Static>` 组件 | 滚动历史保持 |

---

## 10. Qoder CLI / Command Code — CLI 工具借鉴

**来源**：Qoder AI CLI (qodercli)、Command Code (cmdc)。

### 借鉴内容

| 方面 | 借鉴点 | khy-os 实现 |
|------|--------|-------------|
| **CLI 入口** | 命令行入口 + 子命令 | `bin/khy.js` |
| **Provider 配置** | 多 Provider 配置 | `opencodeAdapter.js` + `zcodeAdapter.js` |
| **环境变量** | API Key 环境变量 | `env` 块配置 |
| **CLI 模式** | headless 模式 | `khy ai "prompt"` 一次性调用 |

---

## 借鉴度评分

| 模块 | 借鉴度 | 说明 |
|------|--------|------|
| CLI TUI 界面 | **95%** | 几乎完整复刻 Claude Code TUI |
| Agent 体系 | **85%** | Agent-as-OS 理念 + CC 架构 |
| 提示词系统 | **80%** | CC 提示词模式 + 负向指令 + 验证 Agent |
| 权限系统 | **70%** | CC 权限模式 + auto 模式 |
| 上下文管理 | **75%** | CLAUDE.md 记忆 + 上下文压缩 |
| 密钥管理 | **65%** | cc-switch 双层存储 + 双向同步 |
| 内核 | **50%** | xv6/Linux 设计模式 + 自研 PE 兼容层 |
| 桌面端 | **70%** | Electron 四进程 + ZCode 1:1 UI |
| AI 网关 | **40%** | 自研多供应商适配器（独特设计） |
| 量化终端 | **30%** | 自研交易终端（独立产品） |
| 移动 APP | **20%** | Flutter 骨架（自研方向） |

---

## 建议

1. **TUI 复刻**：当前 CC TUI 复刻已高度完成（设计文档 100%），建议进入实施阶段后逐步剥离对 CC 的直接复制，转向 Khy 自有品牌
2. **内核**：xv6/Linux 借鉴明确，建议在 `kernel/README.md` 中注明参考来源
3. **ZCode 复刻**：`khyos-desktop` 已明确 1:1 复刻，建议保持品牌替换完整性
4. **Hermes 验证**：证据门已实现，建议继续完善 MoA 判断支柱
5. **Y-code 模式**：Prompt 组装 + 记忆压缩已落地，建议继续 session undo/checkpoint
6. **cc-switch 集成**：密钥中心已对接 zcodeAdapter，建议完成工具矩阵 GUI
