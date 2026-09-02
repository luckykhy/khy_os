# ChatML — Tauri 2 + Go Backend + Claude Agent SDK

> 调研日期: 2026-08-31
> 仓库: <https://github.com/chatml/chatml>
> License: GPL-3.0
> Stars: 48 · Forks: 7 · 1,297 commits
> 官网: <https://chatml.com>

## 一、为什么列为第三

ChatML 是 **Tauri 2 + 多语言后端** 架构的纯典范。它的 4 层架构是 khy-os 桌面端路线选型时**唯一能完整对照**的参考。OpenFlux 是"AI 桌面客户端"，ChatML 是"AI 编码工作流"——目标差异大，但**架构哲学一致**：

- 桌面壳只负责窗口/原生菜单/IPC
- 后端业务用一种"重型"语言（Go）做长寿命进程
- AI Agent 引擎用另一种"轻量"语言（Node.js）做对话/工具调用
- 通信走 HTTP + WebSocket + stdio 三种

## 二、4 层架构

```
┌──────────────────────────────────────────────────────────┐
│                    Tauri Shell (Rust)                     │
│   窗口管理 / PTY 终端 / OAuth deep links /               │
│   Stronghold 凭据存储 / 原生菜单                          │
├──────────────────────────────────────────────────────────┤
│                Next.js 前端 (React 19)                    │
│   UI 组件 / Zustand stores / WebSocket client             │
│   Tauri 服务的静态 HTML export                            │
├──────────────────────────────────────────────────────────┤
│                  Go Backend (:9876)                       │
│   REST API / WebSocket hub / SQLite / git&worktree 操作  │
│   Agent 进程管理 / OAuth handlers                        │
├──────────────────────────────────────────────────────────┤
│              Agent Runner (Node.js)                       │
│   Claude Agent SDK wrapper / MCP server / 工具执行       │
│   每个对话一个进程，在 session worktree 里运行            │
└──────────────────────────────────────────────────────────┘
```

## 三、关键技术点

### 3.1 数据模型

```
Workspace → Session → Conversation → Message
```

- **Workspace** —— 一个本地 git 仓库，包含 settings、branch prefix、custom instructions
- **Session** —— 一个 git worktree 隔离的任务，含 branch / priority / status / PR 跟踪
- **Conversation** —— 一个会话内的对话，类型分 `task`（全工具）/ `review`（代码评审）/ `chat`（普通聊天）
- **Message** —— 一条消息，含 role（`user`/`assistant`/`system`）、content blocks、tool calls、token 用量

### 3.2 Provider 两层抽象

```typescript
// Go 端：轻量 AI 任务
type Provider interface {
    Generate(ctx, prompt) (string, error)
}

// Agent Runner 端：重型 agent 工作
// stdio JSON 协议，每条对话一个进程
type AgentRunner interface {
    Query(prompt, opts) <-chan StreamEvent
}
```

**给 khy-os 的启示**：
- khy-os 当前没有 Go 后端，**不需要照抄这层**
- 但"**Provider 两层抽象**"的思路值得借鉴——khy-os 的轻量任务（PR 描述生成、对话摘要）走 `services/backend/src/services/`，重型任务（编码/工具调用）走 `services/backend/src/services/gateway/aiGateway.js`

### 3.3 Process-per-conversation

每个 AI conversation 跑在独立 Node.js 进程里，自然隔离 + 可杀。Go 后端 spawn agent-runner，agent-runner 在 session 的 git worktree 里运行。

**给 khy-os 的启示**：
- khy-os 当前是"一个长寿命 backend 进程服务所有对话"——**对于纯 AI 对话够用**
- 但对于"重型编码 / 长任务"可以借鉴进程隔离
- **也可以不抄**——进程多了反而调度复杂

### 3.4 通信协议

```
Frontend ←──HTTP/WS──→ Go Backend ←──stdin/stdout──→ Agent Runner
   │                       │                              │
   │  REST: CRUD ops       │  为每个对话 spawn 进程       │  Claude Agent SDK
   │  WebSocket: streaming │  在 session 的 worktree 里   │  query() + hooks
```

**给 khy-os 的启示**：
- khy-os 已经是 `WebSocket: streaming`（`server.js:1334-1414`），结构一致
- ChatML 的 "Agent Runner 接收 stdio JSON 协议" 给"如何把 LLM 调用从单一 gateway 拆出"提供了思路

### 3.5 静态前端 export

> "Next.js generates static HTML that Tauri serves directly, avoiding the need for a separate web server process."

**给 khy-os 的启示**：
- khy-os 当前是"Web SPA + 后端托管 dist"
- 桌面壳改造时**保留这种形态**——`vite build` → `dist/` → 桌面壳加载 `file://` 或 `http://localhost:3000`
- 静态 export 不是必须的，但能减少一项运行依赖

### 3.6 Stronghold 凭据存储

Tauri 官方推荐的"安全本地凭据存储"方案。API key 等敏感数据 AES-256-GCM 加密后存到本地。

**给 khy-os 的启示**：
- khy-os 现有 `~/.khyquant/config.json`（明文，已 gitignore）
- 如果走 Tauri，**应该把 API key 改存到 Stronghold** 而不是明文 JSON
- 如果走 Electron，可以用 `electron.safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）

## 四、目录结构

```
chatml/
├── src/                  # Next.js 前端
│   ├── app/             # App router pages
│   ├── components/      # React 组件
│   │   ├── conversation/  # 对话界面、消息渲染
│   │   ├── session/       # session 管理 UI
│   │   ├── settings/      # 设置面板
│   │   └── workspace/     # 工作区侧栏、仪表盘
│   ├── hooks/            # 自定义 React hooks
│   ├── lib/              # API client、工具、类型
│   └── stores/           # Zustand stores
├── backend/              # Go 后端
│   ├── agent/            # agent 进程 spawn / 管理
│   ├── ai/               # AI provider 接口 + Anthropic client
│   ├── git/              # git & worktree 操作
│   ├── server/           # HTTP handlers, WebSocket hub, router
│   ├── store/            # SQLite 持久化
│   └── main.go           # 服务入口
├── agent-runner/         # Claude Agent SDK runner
│   └── src/
│       ├── index.ts      # 主入口，SDK hooks
│       └── mcp/          # 内置 MCP server
├── src-tauri/            # Tauri 桌面包装
│   ├── src/              # Rust 源码（main.rs, plugins）
│   └── tauri.conf.json   # Tauri 配置
├── docs/                 # 文档
└── public/               # 静态资源
```

**给 khy-os 的启示**：
- 不需要"Go 后端"层——khy-os 已经有 `services/backend`（Node.js）
- `src-tauri/` 是关键参考
- `backend/agent/` 模式可以**简化**为 `services/backend/src/services/ai/` 子模块

## 六、与 khy-os 现状对照

| 层级 | ChatML | khy-os | 决策 |
|------|--------|--------|------|
| 桌面壳 | Tauri 2 | 缺 | **新建 `apps/desktop/src-tauri/`** |
| 前端框架 | Next.js 15 / React 19 | Vue 3 | 保留 Vue（团队熟） |
| 后端 | Go (REST + WS + SQLite) | Node.js (Express + ws) | **复用** |
| Agent | Node.js + Claude Agent SDK | Node.js + 多供应商 | **复用** |
| 数据 | SQLite | 已有 JSON 文件存储 | **保留现状** |
| 凭据 | Tauri Stronghold | 明文 JSON | **改造为加密** |

## 七、本地文件

| 文件 | 来源 |
|------|------|
| `ARCHITECTURE.md` | `ARCHITECTURE.md` |

抓取自 <https://raw.githubusercontent.com/chatml/chatml/main/ARCHITECTURE.md>