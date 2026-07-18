<!-- 文档分类: OPS-MAN-006 | 阶段: 运维 | 原路径: docs/指南/cli-万能接入-abu-案例.md -->
# CLI-Anything 接入案例：Abu-Cowork (阿布)

> 本文档以 Abu-Cowork 为实例，记录 KHY OS 通过 CLI-Anything 接入第三方桌面应用的完整流程与协议规范。

---

## 1. 目标软件概况

| 属性 | 值 |
|------|-----|
| 名称 | Abu-Cowork (阿布) |
| 版本 | v0.19.5 |
| 定位 | 本地 AI 桌面办公助手 |
| 技术栈 | Tauri 2 (Rust) + React (TypeScript) + Vite |
| 协议 | Apache 2.0 |
| 核心能力 | 多 Agent、28 内置 Skill、定时任务、IM 机器人、浏览器操控、MCP 连接器、安全沙箱 |

### 源码结构

```
Abu-Cowork-main/
├── src-tauri/src/           # Rust 后端
│   ├── lib.rs               # Tauri 命令注册 (52K)
│   ├── computer_use.rs      # 电脑操控
│   ├── sandbox.rs           # 沙箱隔离
│   ├── trigger_server.rs    # HTTP 触发器服务
│   ├── feishu_ws.rs         # 飞书 WebSocket
│   ├── secrets.rs           # 密钥管理
│   └── proxy.rs             # 代理
├── src/core/                # TypeScript 核心
│   ├── agent/               # Agent 系统
│   ├── skill/               # 技能管理
│   ├── tools/               # 工具注册与安全
│   ├── session/             # 会话管理
│   ├── scheduler/           # 定时任务
│   ├── im/                  # IM 频道 (飞书/钉钉/企微/Slack)
│   ├── mcp/                 # MCP 连接器
│   ├── llm/                 # LLM 调用
│   ├── memdir/              # 记忆目录
│   ├── safety/              # 内容安全扫描
│   └── search/              # 搜索
├── builtin-skills/          # 28 个内置技能
│   ├── Abu-Browser/         # 浏览器操控
│   ├── pdf/, pptx/, docx/   # 文档处理
│   ├── schedule/            # 定时任务
│   ├── mermaid-diagram/     # 流程图
│   ├── frontend-design/     # 前端设计
│   ├── create-agent/        # 创建 Agent
│   └── ...
└── builtin-agents/          # 预置 Agent
```

---

## 2. 接入命令

```bash
# 标准命令
khy app cli-gen /home/kodehu03/Downloads/Abu-Cowork-main.zip --runtime node

# 中文别名
软件接入 /home/kodehu03/Downloads/Abu-Cowork-main.zip --runtime node
工具生成 /home/kodehu03/Downloads/Abu-Cowork-main.zip --runtime node
cli生成 /home/kodehu03/Downloads/Abu-Cowork-main.zip --runtime node
```

选择 `--runtime node` 的理由：Abu 本身是 TypeScript/Tauri 项目，Node.js CLI 可直接复用其类型定义和 API 结构。

---

## 3. 七阶段生成流水线

### Stage 0 — 源码获取

```json
{
  "software": "abu-cowork",
  "sourcePath": "~/.khy/cli-anything/generated/abu-cowork/source/",
  "language": "javascript",
  "buildSystem": "npm",
  "entryPoints": ["src/main.tsx", "src-tauri/src/main.rs"],
  "hasTests": true,
  "hasDocs": true
}
```

### Stage 1 — 代码分析

AI 分析 Abu 源码后生成 SOP 文档，识别出以下可控能力域：

| 能力域 | 来源模块 | 可 CLI 化操作 |
|--------|----------|--------------|
| Agent 任务 | `src/core/agent/` | 创建/运行/停止/列出 Agent 任务 |
| 技能管理 | `src/core/skill/` + `builtin-skills/` | 列出/搜索/运行/自进化技能 |
| 定时任务 | `src/core/scheduler/` | 创建/删除/启停 Cron 任务 |
| 会话管理 | `src/core/session/` | 列出/恢复/导出会话 |
| IM 频道 | `src/core/im/` | 发送/接收/配置 IM 消息 |
| 工具调用 | `src/core/tools/` | 列出/搜索/调用注册工具 |
| MCP 连接 | `src/core/mcp/` | 连接/断开 MCP 服务器 |
| 记忆系统 | `src/core/memdir/` | 读取/写入/搜索记忆 |
| 安全扫描 | `src/core/safety/` | 触发内容安全扫描 |
| 诊断 | `src/core/diagnostic/` | 系统自检、健康报告 |

### Stage 2 — 架构设计

```
cli-anything-abu
├── agent       # run, stop, list, status
├── skill       # list, search, run, evolve
├── schedule    # create, delete, enable, disable, list
├── session     # list, resume, export, delete
├── im          # send, channels, config
├── tool        # list, search, invoke
├── mcp         # connect, disconnect, list
├── memory      # get, set, search, clear
├── diagnostic  # check, report
└── project     # create, open, list, info
```

### Stage 3 — 实现

生成 `khy-cli-abu/` Node.js CLI 包：

```
khy-cli-abu/
├── openclaw.plugin.json
├── package.json
├── src/
│   ├── index.js               # Commander CLI 入口
│   ├── core/
│   │   ├── project.js         # 项目管理
│   │   ├── session.js         # undo/redo 快照
│   │   └── export.js          # 导出对话/报告
│   └── backend.js             # Abu 通信桥接
├── skills/
│   ├── manifest.json
│   └── prompt.md
└── tests/
```

### Stage 4~5 — 测试

覆盖所有命令组的 happy path、error case、`--json` 模式验证。

### Stage 6 — SKILL.md

```markdown
---
name: cli-anything-abu
description: AI desktop office assistant — manage agents, skills, schedules, IM channels, and sessions
version: 1.0.0
tags: [abu, desktop-assistant, agent, skill, scheduler, im, cli-anything]
entry_point: cli-anything-abu
---
You have access to cli-anything-abu, a command-line tool for controlling Abu (阿布) AI desktop assistant.
...
```

### Stage 7 — 打包注册

```bash
npm link                       # 全局注册 cli-anything-abu 命令
khy app cli-sync               # 自动发现 + 注册到 KHY
```

注册结果：
- **KHY App**: `cli-anything-abu` (runtime: external)
- **KHY Tool**: `cli_anything__abu` (AI 对话可调用)
- **KHY Skill**: `~/.khy/skills/cli-anything-abu/manifest.json`

---

## 4. 通信协议：backend.js 如何桥接 Abu

Abu 是 Tauri 桌面应用，不是传统 CLI 工具。CLI-Anything 的 `backend.js` 按优先级使用三种通信方式：

### 4.1 HTTP API（首选）

Abu 内置 `trigger_server.rs`，在本地端口暴露 HTTP 接口。

```javascript
// backend.js
const BASE_URL = 'http://127.0.0.1:21222'; // Abu trigger server

async function callAbu(endpoint, payload) {
  const resp = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return resp.json();
}
```

适用场景：Abu 正在运行时，所有实时操作（Agent 任务、IM 发送、工具调用）。

### 4.2 文件协议（离线操作）

直接读写 Abu 的本地数据目录。

```javascript
// 路径约定
const ABU_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'com.abu.app');
const MEMDIR   = path.join(ABU_DATA, 'memdir');
const SKILLS   = path.join(ABU_DATA, 'skills');
const SCHEDULE = path.join(ABU_DATA, 'schedules.json');
```

适用场景：Abu 未运行时，读取/修改配置、记忆、技能定义。

### 4.3 Tauri CLI（备选）

如果 Abu 暴露了 Tauri CLI 命令入口：

```javascript
const { execFileSync } = require('child_process');
const result = execFileSync('abu', ['agent', 'run', '--task', task, '--json'], {
  encoding: 'utf-8', timeout: 60000,
});
```

### 协议选择逻辑

```
                      ┌──────────────┐
                      │ Abu running?  │
                      └──────┬───────┘
                        yes  │  no
                    ┌────────┴────────┐
                    ▼                 ▼
            HTTP API (4.1)    File Protocol (4.2)
            port 21222        direct R/W
```

---

## 5. 使用示例

### 5.1 CLI 直接调用

```bash
# Agent
khy app cli-invoke abu agent run --task "整理本周工作报告" --json
khy app cli-invoke abu agent list --json
khy app cli-invoke abu agent stop --id agent_0xa3f --json

# Skill
khy app cli-invoke abu skill list --json
khy app cli-invoke abu skill run --name pdf --input report.pdf --json
khy app cli-invoke abu skill search --query "文档处理" --json

# Schedule
khy app cli-invoke abu schedule create --cron "0 9 * * 1-5" --task "晨报汇总" --json
khy app cli-invoke abu schedule list --json
khy app cli-invoke abu schedule delete --id sched_01 --json

# Session
khy app cli-invoke abu session list --json
khy app cli-invoke abu session export --id sess_01 --format markdown --json

# IM
khy app cli-invoke abu im send --channel feishu --message "日报已生成" --json
khy app cli-invoke abu im channels --json

# Memory
khy app cli-invoke abu memory search --query "用户偏好" --json

# Diagnostic
khy app cli-invoke abu diagnostic check --json
```

### 5.2 AI 对话自动调用

```
用户: 帮我用阿布创建一个每天早上9点自动汇总邮件的定时任务
AI:   [调用 cli_anything__abu]
      → schedule create --cron "0 9 * * *" --task "汇总今日收件箱邮件" --json
      → 返回: {"status":"success","data":{"id":"sched_0xf3a","cron":"0 9 * * *"}}
      已创建定时任务 sched_0xf3a，每天 09:00 自动执行。

用户: 列出阿布现在有哪些技能
AI:   [调用 cli_anything__abu]
      → skill list --json
      → 返回: {"status":"success","data":{"total":28,"skills":[...]}}
      Abu 当前有 28 个技能：PDF 处理、PPTX 生成、浏览器操控、前端设计...

用户: 用阿布的 PDF 技能把这个文件转成摘要
AI:   [调用 cli_anything__abu]
      → skill run --name pdf --input /path/to/doc.pdf --action summarize --json
      → 返回: {"status":"success","data":{"summary":"..."}}
```

### 5.3 注册状态验证

```bash
khy app cli-list
# 输出:
# cli-anything-abu  v0.19.5  [public]  AI Desktop Assistant - agents, skills, scheduler, IM

khy skill list
# 输出:
# cli-anything-abu  "AI desktop office assistant"  [cli-anything]

agent工具
# 同 khy app cli-list
```

---

## 6. 输出格式约定

所有命令支持 `--json` 参数，输出统一的 JSON 格式：

### 成功

```json
{
  "status": "success",
  "command": "agent.run",
  "data": {
    "id": "agent_0xa3f",
    "task": "整理本周工作报告",
    "state": "running"
  },
  "metadata": {
    "duration_ms": 234,
    "abu_version": "0.19.5"
  }
}
```

### 失败

```json
{
  "status": "error",
  "command": "agent.run",
  "error": "Abu is not running",
  "code": "ABU_NOT_RUNNING",
  "details": "Start Abu desktop app first, or use file protocol for offline operations"
}
```

---

## 7. 数据流全景

```
┌─────────────┐     khy app cli-invoke abu ...     ┌──────────────────────┐
│  KHY OS CLI  │ ──────────────────────────────────▶│  cli-anything-abu    │
│  或 AI 对话   │◀─────── JSON 结构化输出 ───────────│  (Node.js CLI)       │
└─────────────┘                                     └──────────┬───────────┘
                                                               │
                                          ┌────────────────────┼────────────────────┐
                                          ▼                    ▼                    ▼
                                   HTTP API             File Protocol         Tauri CLI
                                   port 21222           ~/Library/.../abu     abu <cmd>
                                          │                    │                    │
                                          └────────────────────┴────────────────────┘
                                                               │
                                                               ▼
                                                     ┌──────────────────┐
                                                     │  Abu Desktop App  │
                                                     │  Tauri + React    │
                                                     │  28 Skills        │
                                                     │  Agent System     │
                                                     │  Scheduler        │
                                                     │  IM Channels      │
                                                     └──────────────────┘
```

---

## 8. 注意事项

1. **Abu 必须在运行中** 才能使用 HTTP API 通信方式，否则回退到文件协议
2. **安全权限**：Abu 的沙箱和权限系统仍然生效，CLI 调用同样受限
3. **首次生成耗时**：7 阶段流水线需要 AI 分析完整源码，首次约 5-10 分钟
4. **断点续传**：流水线中断后可从上次完成的阶段恢复
5. **双向同步**：通过 `khy app cli-sync` 可随时刷新注册状态
6. **版本跟踪**：Abu 升级后建议重新运行 `khy app cli-gen` 以更新 CLI 包装

---

## 9. 关联文件

| 文件 | 用途 |
|------|------|
| `backend/src/services/cliAnythingService.js` | CLI-Anything 桥接服务 |
| `backend/src/services/cliAnythingGenerator.js` | 7 阶段生成流水线 |
| `backend/src/cli/handlers/app.js` | CLI 子命令路由 |
| `backend/src/data/cliAnythingTemplates/` | 阶段提示词 + 骨架模板 |
| `docs/07_OPS_运维/[OPS-MAN-007] cli-万能接入-集成指南.md` | 通用集成指南 |
| `~/.khy/cli-anything/generated/abu-cowork/` | 生成产物目录 |
| `~/.khy/skills/cli-anything-abu/` | 注册的 KHY 技能 |
