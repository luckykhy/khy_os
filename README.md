<h1 align="center">Khy-OS</h1>

<p align="center">
  <b>AI 平台操作系统 · The AI-native operating system.</b><br>
  一个可扩展的 AI 平台基座：Claude-Code 级智能体 CLI + 多后端 AI 网关 + 手写 OS 内核。<br>
  一次安装，开箱即用。
</p>

<p align="center">
  <a href="https://pypi.org/project/khy-os/"><img alt="PyPI" src="https://img.shields.io/pypi/v/khy-os?logo=pypi&logoColor=white&label=pip%20khy-os"></a>
  <a href="https://www.npmjs.com/package/@khy-os/khy-os"><img alt="npm" src="https://img.shields.io/npm/v/@khy-os/khy-os?logo=npm&label=npm%20%40khy-os%2Fkhy-os"></a>
  <img alt="Python" src="https://img.shields.io/badge/python-%E2%89%A53.8-3776AB?logo=python&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white">
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
</p>

---

## 项目简介

**Khy-OS** 是一个通过 PyPI（`pip install khy-os`）和 npm（`@khy-os/khy-os`）双渠道分发的 AI 平台操作系统。它启动一个可扩展的默认应用运行时，主要包含：

- **智能体 CLI**：流式 TUI、工具调用循环、权限门控、子智能体、工作流、目标模式、上下文压缩；
- **多后端 AI 网关**：以统一 API 前置 Claude、Qwen、Cursor、Kiro、Windsurf、Warp、Trae、Ollama、Codex 等多家供应商，支持级联故障转移与熔断，无供应商锁定；
- **手写 OS 内核**（`kernel/`，C 语言）：抢占式调度、按需分页、写时复制 `fork`、POSIX 风格信号、管道、ELF + PE 双格式加载器，可在 QEMU 下引导运行。

**khyquant**（量化交易终端，位于 `software/khyquant/`）是运行在该基座之上的**内置默认应用**——而非项目本身。

分层结构：

- **Python 层**（`platform/khy_platform/`）：轻量启动器，负责检测环境并拉起 Node.js；
- **Node.js 后端**（`services/backend/`）：承载所有业务逻辑（CLI、AI 网关、各类服务、Web API）；
- **前端**：`apps/ai-frontend/`（AI 平台管理 UI，Vue 3 + Vite）与 `software/khyquant/frontend/`（内置的 khyquant 交易 UI）。

## 架构概览

```text
User → khy 命令 → Python cli.py → Node.js services/backend/bin/khy.js
                                          │
                         ┌────────────────┼────────────────┐
                         ▼                ▼                ▼
                   CLI Layer        Service Layer      Web API
                  (src/cli/)      (src/services/)    (src/routes/)
```

### 关键入口点

| 组件 | 文件 | 用途 |
|------|------|------|
| CLI 路由器 | `services/backend/src/cli/router.js` | 命令解析 + 分派 |
| 别名表 | `services/backend/src/cli/aliases.js` | 中文/拼音 → 英文命令映射 |
| REPL 循环 | `services/backend/src/cli/repl.js` | readline 接口 + AI 模式 |
| AI 网关 | `services/backend/src/services/gateway/aiGateway.js` | 统一的多供应商 AI 调用 |
| Token 统计 | `services/backend/src/services/tokenUsageService.js` | 以人民币计的用量统计 |
| 训练 | `services/backend/src/services/modelTrainingService.js` | LoRA/蒸馏/导出 |
| 回测 | `services/backend/src/services/backtestEngine.js` | 策略模拟 |

## 安装方式

### 包管理器安装（二选一，两渠道内容一致）

```powershell
# pip 渠道
python -m pip install -U khy-os

# npm 渠道
npm install -g @khy-os/khy-os
```

安装后直接运行：

```powershell
khy                        # 启动智能体终端
khy preflight              # 首次运行前诊断 PATH / Node / 依赖
khy ai "总结这个仓库"       # 一次性 AI 调用，不进 REPL
khy gateway status         # 查看各 AI 后端的可用状态
khy doctor                 # 系统健康检查
```

### 本仓库源码运行

要求 Python ≥ 3.8、Node.js ≥ 20。在仓库根目录：

```powershell
# Windows：通过便携启动器进入 khy CLI（自动探测 Python / Node）
.\khy.bat

# 或使用 PowerShell 便携化启动脚本（npm workspaces monorepo）
.\scripts\portable\run.ps1                  # 等价于 npm run dev
.\scripts\portable\run.ps1 build            # npm run build
.\scripts\portable\run.ps1 shell            # 进入带 node/npm 环境的 PowerShell
```

Linux / macOS 使用 `./khy.sh`。便携模式详见 [PORTABLE.md](docs/06_DEPLOY_部署/PORTABLE.md)。

## 快速开始（开发者）

### 启动后端

```powershell
cd services\backend
npm install
npm start                  # 生产模式：node server.js
npm run dev                # 开发模式：nodemon 热重载
npm run cli                # 直接进入 CLI：node bin/khy.js
```

### 启动 AI 平台前端

```powershell
cd apps\ai-frontend
npm install
npm run dev                # Vite 开发服务器
npm run build              # 生产构建
```

### 默认管理员账号

后端启动时会**自动初始化**默认管理员（幂等：若账号已存在则跳过，绝不覆盖现有密码），无需手动运行脚本，启动日志中会输出账号信息。

> ⚠️ **没有固定的默认口令**。出于安全考虑，默认管理员密码由**机器指纹 + 随机熵**生成（约 16 位混合字符强密码），首次启动时保存于数据目录 `.khy/credentials/default-admin.json`（`KHY_DATA_HOME` 覆盖时在其下）。请打开该文件查看初始密码。

默认管理员用户名解析顺序：`KHY_ADMIN_USERNAME` 环境变量 → 已存在的凭据文件 → 当前 OS 用户名（小写化 + 过滤非法字符）→ 兜底 `admin`。

可通过环境变量控制：

| 变量 | 说明 |
|------|------|
| `KHY_ADMIN_AUTO_INIT` | 设为 `0` 或 `false` 禁用自动初始化（默认开启） |
| `KHY_ADMIN_USERNAME` | 自定义用户名（默认取 OS 用户名） |
| `KHY_ADMIN_PASSWORD` | 自定义密码；设置后不会打印到日志，也不写凭据文件 |

手动脚本仍可用于**重置**管理员账号：

```powershell
cd services\backend
node scripts\create-admin.js       # 仅创建/重置管理员账号
node scripts\seed.js               # 或：完整种子数据（含管理员）
```

前端登录页提供「**使用默认管理员用户名填充**」按钮，一键填入后端解析出的默认用户名；密码需在数据目录 `.khy/credentials/default-admin.json` 中查看。登录后通过顶部**工作区切换**进入管理员视图。

> ⚠️ 生产环境部署时**务必修改默认密码**（或设置 `KHY_ADMIN_PASSWORD`），并妥善保管凭据文件。

## 配置文件位置

| 文件 | 位置 |
|------|------|
| 用户配置 | `~/.khyquant/config.json` |
| Token 用量 | `~/.khyquant/token_usage.json` |
| 对话记录 | `~/.khyquant/conversations/` |
| 训练数据 | `~/.khyquant/training_data/` |
| 模型 | `~/.khyquant/models/` |
| 命令历史 | `~/.khyquant_history` |

API key 存于 `~/.khyquant/config.json`（已 gitignore），Token 用量数据仅存于本地。

## 目录结构

```text
khy-os/
├── khy.bat / khy.sh          # CLI 启动器（自动探测 Python / Node）
├── pyproject.toml            # Python 包真源（版本 / 依赖）
├── package.json              # npm workspaces 根（monorepo 依赖管理）
├── AGENTS.md                 # AI 与人工维护指南
│
├── platform/                 # Python 启动层（pip 入口：khy_platform）
│   ├── khy_platform/         #   轻量启动器：cli.py、bootstrap、node_provisioner
│   ├── packages/
│   │   ├── shared/           #   @khy/shared：模型、认证、数据库、缓存（workspace）
│   │   └── moonbit-plugin-sdk/
│   └── delivery/             #   多渠道交付编排
│
├── services/                 # Node.js 后端
│   ├── backend/              #   主后端（npm workspaces 成员）
│   │   ├── src/              #     CLI（src/cli/）、服务（src/services/）、Web API（src/routes/）
│   │   ├── bin/              #     khy.js 入口
│   │   ├── config/ / migrations/ / sql/
│   │   ├── scripts/          #     模块维护脚本（seed、prepack、daemon 等）
│   │   ├── akshare_scripts/ / wasm-*/       # 行情脚本与 WASM 指标
│   │   └── vendor/shared →   #     符号链接指向 platform/packages/shared
│   └── ai-backend/           #   AI 后端生态（独立版本轨道）
│
├── apps/                     # 上层应用
│   └── ai-frontend/          #   Vue 3 + Vite 管理 UI（src/、public/、scripts/）
│
├── kernel/                   # 手写 OS 内核（C 语言）
│   ├── src/                  #   调度、分页、vfs、syscall、framebuffer 等
│   ├── boot/ / linker.ld / Makefile
│   ├── bridge/               #   内核 ↔ 智能体桥接
│   ├── moonbit/              #   MoonBit WASM 模块
│   ├── iso/ / build/         #   ISO 构建产物
│   └── tools/                #   构建 / 测试工具脚本
│
├── software/                 # 内置默认应用
│   └── khyquant/             #   量化交易终端（config/、services/、routes/、frontend/、ml/、tools/）
│
├── packaging/                # 分发渠道
│   ├── npm/                  #   npm 渠道清单（@khy-os/khy-os）
│   ├── modules/              #   模块化打包清单（entries/、runtime/）
│   └── build/                #   独立可执行构建脚本
│
├── scripts/                  # 维护 / 构建 / CI / 发布脚本
│   ├── admin/  alpine/  bench/  ci/  diagnostics/  docs/
│   ├── install/  khytogo/  lib/  maintenance/  moonbit/
│   ├── portable/             #   便携化：run.ps1、run-portable.bat/.sh、pack-portable.js 等
│   ├── qoder-bridge/  release/  restore/  tests/
│   └── README.md             #   scripts 目录索引与分类说明
│
├── tools/                    # 独立工具
│   ├── deepseek-eyes/        #   图像理解 MCP 服务
│   └── khyos-markdown/       #   Markdown 渲染桥接
│
├── alpine/                   # Alpine Linux ISO 构建相关
├── extensions/               # 扩展（khy-trae-bridge）
├── docs/                     # 全套中文文档（01_INIT ~ 09_STORY + 维护手册）
└── _source/                  # 源码快照 / 恢复参考
```

### 分层概览

- **Python 层**（`platform/khy_platform/`）：轻量启动器，负责检测环境并拉起 Node.js；
- **Node.js 后端**（`services/backend/`）：承载所有业务逻辑（CLI、AI 网关、各类服务、Web API）；
- **前端**：`apps/ai-frontend/`（AI 平台管理 UI，Vue 3 + Vite）与 `software/khyquant/frontend/`（内置的 khyquant 交易 UI）；
- **内核**（`kernel/`）：手写 C 语言 OS 内核，可在 QEMU 下引导运行。

## 文档导航

- 文档总索引：[docs/00_INDEX_文档索引.md](docs/00_INDEX_文档索引.md)
- 概念入门（Agent / Tool Calling / MCP / LLM 等）：`docs/02_CONCEPTS_概念入门/`
- 设计与实现记录：`docs/03_DESIGN_设计/`、`docs/04_IMPL_实现/`
- 部署与运维手册：`docs/06_DEPLOY_部署/`、`docs/07_OPS_运维/`

## 版本同步

版本号由 `scripts/ci/check-version-sync.js` 强制校验（pre-commit / CI）。升级版本时必须同步更新以下**三处真源**，且保持完全一致：

1. `pyproject.toml` → `[project] version`
2. `packaging/npm/package.json` → `version`
3. `services/backend/package.json` → `version`

不要在 `platform/khy_platform/__init__.py` 中硬编码 `__version__`——它从 `pyproject.toml` / 已安装元数据中动态解析，硬编码会导致版本同步检查失败。

## 贡献与维护

- AI 助手与维护者指南（架构速查、工程规则、代码风格、评审清单）：[AGENTS.md](AGENTS.md)
- 便携模式说明：[PORTABLE.md](docs/06_DEPLOY_部署/PORTABLE.md)
- 工程红线（零硬编码、状态透明、活动超时、终端渲染）详见 AGENTS.md 的「工程规则」章节；提交前可运行本地检查：

```powershell
node scripts\ci\check-agent-rules.js --changed
```

代码风格：JS 用 2 空格缩进、单引号、分号；命名 camelCase（JS）/ snake_case（Python）；面向用户的字符串用中文，代码注释用英文。

## 许可

**Source-available（源码可见）**。Khy-OS 可免费下载、运行、学习与非商业使用；复制、修改、再分发源码及商业使用需获得作者（孔浩原 / Kong Haoyuan）的书面许可。
