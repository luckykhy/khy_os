# [DESIGN-RESEARCH] 桌面端智能体 UI 每日调研

> **定位**：khy-os 对齐 ZCode 目标的每日动态跟踪。
> **日期**：2026-09-10
> **状态**：Daily Report

---

## 0. 今日核心发现

| # | 发现 | 影响 | 优先级 |
|---|------|------|--------|
| 1 | **Crush**（Charmbracelet，28k★）是 OpenCode 的精神续作 | 多模型切换、LSP 集成 | **观察** |
| 2 | **Codewhale**（40.9k★，Rust）的 4 级审批模式与 khy-os 高度对齐 | 验证了我们的权限 UX 方向 | **参考** |
| 3 | **Herdr**（37.1k★）的终端多路复用器 + 可视状态指示器 | 多 Agent 管理的新范式 | **参考** |
| 4 | Rust 成为新 Agent 工具的主流语言（Codewhale、Herdr） | 性能优势明显 | **趋势** |
| 5 | 审批模式（Plan/Ask/Auto/Full）已成行业标配 | 验证 khy-os 方向正确 | **确认** |

---

## 1. 新发现项目

### 1.1 Crush（Charmbracelet）— 28k★

| 维度 | 详情 |
|------|------|
| **仓库** | `charmbracelet/crush` |
| **语言** | Go（Bubble Tea 生态） |
| **Stars** | 28,000 |
| **定位** | "Coding bestie" — 终端 Agentic 编码助手 |
| **核心特性** | 多模型支持、会话中切换模型、LSP 集成、MCP 扩展 |
| **与 OpenCode 关系** | OpenCode 已于 2025-09-18 归档，Crush 是其精神续作 |
| **UI 特点** | 紧凑模式（compact_mode）、键盘驱动 |

**可借鉴点**：
- 会话中切换模型（保持上下文）
- LSP 集成提供代码智能
- Charm 生态的成熟组件库

### 1.2 Codewhale — 40.9k★

| 维度 | 详情 |
|------|------|
| **仓库** | `Hmbown/Codewhale` |
| **语言** | Rust |
| **Stars** | 40,900 |
| **定位** | 开源终端编码 Agent，社区驱动改进 |
| **核心特性** | 4 级审批、/undo、/restore、/goal、MCP、Skills |
| **UI 特点** | 聊天式 TUI + 命令面板（/ 前缀） |

**审批模式（与 khy-os 对比）**：

| Codewhale | khy-os | 对齐度 |
|-----------|--------|--------|
| Plan（只读） | dontAsk / plan 模式 | ✅ 已对齐 |
| Ask（需确认） | normal / strict | ✅ 已对齐 |
| Auto-Review | acceptEdits / auto | ✅ 已对齐 |
| Full Access | yolo | ✅ 已对齐 |

**可借鉴点**：
- `/goal` 命令（明确任务目标）
- `/undo` 和 `/restore`（简化版撤销）
- 社区驱动的 VS Code 扩展

### 1.3 Herdr — 37.1k★

| 维度 | 详情 |
|------|------|
| **仓库** | `herdrdev/herdr` |
| **语言** | Rust |
| **Stars** | 37,100 |
| **定位** | "Coding agents 的运行时" — 终端多路复用器 |
| **核心特性** | 可分离会话、多机统一窗口、Agent 状态指示器 |
| **UI 特点** | tmux 风格前缀键 + 鼠标支持 |

**核心创新**：
- **状态指示器**：每个面板标记为 working / blocked / idle
- **可分离**：客户端关闭后，后台服务器继续运行
- **多机合一**：本地 + SSH 机器 + Agent 列表统一窗口
- **Agent 原生**：Agent 通过 CLI + Socket API 控制面板

**可借鉴点**：
- 状态指示器（working/blocked/idle）— 比我们的 AgentTree 更直观
- tmux 风格前缀键（Ctrl+b）— 比我们的单键快捷键更系统化

### 1.4 oh-my-openagent — 68.9k★

| 维度 | 详情 |
|------|------|
| **仓库** | `code-yeongyu/oh-my-openagent` |
| **语言** | TypeScript |
| **Stars** | 68,900 |
| **定位** | 图工程工具，通过 "mass ulw" 提示词激活 |
| **UI 特点** | 图形化 Agent 编排 |

---

## 2. 行业趋势

### 2.1 技术栈分布（2025-2026 新项目）

| 语言 | 代表项目 | 优势 |
|------|----------|------|
| **Rust** | Codewhale, Herdr, yazi | 性能、安全、单二进制分发 |
| **Go** | Crush, oh-my-pi | 并发、Bubble Tea 生态 |
| **TypeScript** | oh-my-openagent, dsh-TUI | React/Ink 组件生态 |
| **Python** | Aider, Textual 项目 | 快速原型、AI 生态 |

**趋势**：Rust 正成为高性能 Agent 工具的首选语言。

### 2.2 权限控制演进

```
2023: 允许/拒绝（二进制）
  ↓
2024: 允许/拒绝/始终允许（三级）
  ↓
2025: Plan/Ask/Auto/Full（四级审批）← 当前行业标准
  ↓
2026: 细粒度 wildcard 规则 + 项目级持久化（khy-os 已对齐）
```

### 2.3 多 Agent 协作模式

| 模式 | 代表 | 特点 |
|------|------|------|
| **父子层级** | ZCode, Claude Code | 主 Agent 委派子 Agent |
| **状态面板** | Herdr | working/blocked/idle 可视化 |
| **图编排** | oh-my-openagent | 可视化 Agent 关系图 |

---

## 3. 与 khy-os 的差距分析

### 3.1 已对齐（无需改动）

| 特性 | khy-os 状态 | 竞品对比 |
|------|-------------|----------|
| 4 级审批模式 | ✅ 6 profile 映射 4 级 | Codewhale 验证 |
| 权限 wildcard 规则 | ✅ 已启用 | Claude Code 对齐 |
| 父子 Agent 工具树 | ✅ AgentTree 已集成 | ZCode 对齐 |
| 任务时间预估 | ✅ ccTaskEstimate | ZCode 对齐 |
| 外部编辑器 Ctrl+E | ✅ 已实现 | OpenCode 对齐 |
| Vim 模式 | ✅ NORMAL/INSERT/VISUAL | Claude Code 对齐 |

### 3.2 可借鉴的新方向

| 方向 | 来源 | 工作量 | 价值 |
|------|------|--------|------|
| **Agent 状态指示器** | Herdr | 2d | 高 — 比文字更直观 |
| **tmux 风格前缀键** | Herdr | 3d | 中 — 更系统的快捷键 |
| **会话中模型切换** | Crush | 1d | 高 — 用户期望 |
| **/goal 命令** | Codewhale | 1d | 中 — 明确任务目标 |
| **紧凑模式** | Crush | 2d | 中 — 小终端适配 |

---

## 4. 优化建议（按优先级）

### P1：Agent 状态指示器（Herdr 对齐）

**现状**：AgentTree 仅显示文字状态（running/completed）

**建议**：增加颜色编码的状态指示器
- 🟢 绿色 = completed
- 🟡 黄色 = running
- 🔴 红色 = error/blocked
- ⚪ 灰色 = idle/pending

**文件**：`services/backend/src/cli/tui\ink-components\AgentTree.js`

### P2：会话中模型切换（Crush 对齐）

**现状**：模型在会话开始时选定

**建议**：添加 `/model` 命令或 `Alt+P` 切换模型

**文件**：`services/backend/src/cli/tui\ink-components\CcApp.js`

### P3：tmux 风格前缀键（Herdr 对齐）

**现状**：单键快捷键（Ctrl+C/O/T/V/E）

**建议**：引入前缀键（如 Ctrl+K）避免冲突
- `Ctrl+K` + `O` = 转录视图
- `Ctrl+K` + `T` = 工具树
- `Ctrl+K` + `V` = Vim 切换
- `Ctrl+K` + `E` = 外部编辑器

---

## 5. 竞品 Stars 追踪（2026-09-10）

| 项目 | Stars | 较上次变化 | 趋势 |
|------|-------|-----------|------|
| Claude Code | 144.6k | +0.4k | 稳定增长 |
| Aider | 48.9k | +0.9k | 快速增长 |
| Codewhale | 40.9k | 新项目 | 爆发期 |
| Herdr | 37.1k | 新项目 | 爆发期 |
| Crush | 28k | 新项目 | 快速增长 |
| OpenCode | 13.7k | 已归档 | 被 Crush 取代 |
| oh-my-openagent | 68.9k | 新项目 | 图编排新范式 |

---

## 6. 结论

khy-os 的核心功能（权限控制、Agent 工具树、时间预估、Vim 模式）已与行业主流对齐甚至领先。2025-2026 年的新趋势集中在：

1. **Rust 化**：高性能单二进制分发
2. **多 Agent 可视化**：状态指示器 > 文字列表
3. **模型灵活性**：会话中切换模型
4. **前缀键系统**：避免快捷键冲突

khy-os 已建立坚实的功能基础，下一步应聚焦于**打磨体验**（状态指示器、前缀键）和**生态集成**（LSP、MCP）。

---

> **下次调研**：每日凌晨 3 点自动执行。
> **数据来源**：GitHub WebFetch 实时数据。
