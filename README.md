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
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520.18.1-339933?logo=node.js&logoColor=white">
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
</p>

---

## 项目简介

**Khy-OS** 是一个通过 PyPI（`pip install khy-os`）和 npm（`@khy-os/khy-os`）双渠道分发的 AI 平台操作系统。它启动一个可扩展的默认应用运行时，主要包含：

- **智能体 CLI**：流式 TUI、工具调用循环、权限门控、子智能体、工作流、目标模式、上下文压缩；
- **多后端 AI 网关**：以统一 API 前置 Claude、Qwen、Cursor、Kiro、Windsurf、Warp、Trae、Ollama、Codex 等多家供应商，支持级联故障转移与熔断，无供应商锁定；
- **手写 OS 内核**（`kernel/`，C 语言）：抢占式调度、按需分页、写时复制 `fork`、POSIX 风格信号、管道、ELF + PE 双格式加载器，可在 QEMU 下引导运行。

除 CLI 外，同一后端还支撑多个客户端：Web 管理台（`apps/ai-frontend/`）、
Electron 桌面端（`apps/khyos-desktop/` 与根级 `electron/`）、Android 随身 App
（`apps/khy-os-client-app/`，Flutter；旧的 Capacitor 壳 `apps/khy-mobile/` 已隔离，
见 [DESIGN-ARCH-120]）。

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

要求 Python ≥ 3.8、Node.js ≥ 20.18.1（`services/backend` 的 `engines`）。这是一份
monorepo（npm workspaces + pnpm workspace），先按需安装工作区依赖：

```powershell
npm run install:core       # 只装运行时最小闭包（backend + ai-backend + @khy/shared）
npm run install:all        # 全量安装（corepack pnpm install --frozen-lockfile）
```

然后在仓库根目录进入 CLI：

```powershell
# Windows：通过便携启动器进入 khy CLI（自动探测 Python / Node）
.\khy.bat

# 或使用便携化开发启动器：在项目内落地一份已验证的 Node 运行时（默认 22.12.0），
# 运行时状态与包缓存都留在项目内。参数是「要跑的 npm script 名」，
# 加 -Workspace 即在该工作区里执行。
.\extensions\scripts\khy-portable\run.ps1 -Command install
.\extensions\scripts\khy-portable\run.ps1 -Command dev -Workspace apps/ai-frontend
.\extensions\scripts\khy-portable\run.ps1 -Command test:backend
.\extensions\scripts\khy-portable\run.ps1 -Command shell          # 进入带 node/npm 环境的 PowerShell
```

Linux / macOS 使用 `./khy.sh`。便携模式详见 [PORTABLE.md](docs/06_DEPLOY_部署/DEPLOY/[DEPLOY-0101] PORTABLE.md)。

> 根 `package.json` 只登记 curated 任务入口（`check:` / `docs:` / `rules:` / `gate:` /
> `portable:` 等，见 [DESIGN-LAY-005] 第四节），**没有** `dev` / `build` 顶层脚本——
> 构建与开发命令一律落到具体 workspace，例如 `npm run test:backend`、
> `npm run install:frontend`。

仓库**不跟踪可再生的构建产物**：Markdown 工作台的 muya WYSIWYG 引擎（`extensions/tools/khy-markdown/vendor/`）
与离线文档站的图表引擎（`docs/19_资产/site/mermaid.min.js`）都由同级源码按需重建。开发路径 fail-soft
（缺失时自动回退），发布路径硬失败。想立刻补齐：

```bash
node extensions/tools/khy-markdown/muya-embed/ensure-vendor.mjs   # muya 所见即所得引擎（约 11 MB）
npm run docs:mermaid                                     # 文档站 Mermaid 图表引擎（约 3.3 MB）
```

## 快速开始（开发者）

依赖统一从仓库根安装（workspace 会把 `services/backend/vendor/shared` 链到
`platform/packages/shared`），装完后各 workspace 可单独起服务：

```powershell
npm run install:core        # backend + ai-backend + @khy/shared
npm run install:frontend    # ai-frontend + khyquant frontend
```

### 启动后端

```powershell
cd services\backend
npm start                  # 生产模式：node server.js
npm run dev                # 开发模式：nodemon 热重载
npm run cli                # 直接进入 CLI：node bin/khy.js
```

### 启动 AI 平台前端

```powershell
cd apps\ai-frontend
npm run dev                # Vite 开发服务器
npm run build              # 生产构建
```

### 本地开发访问地址

后端与前端各占一个终端窗口；两者都起来后浏览器打开前端地址即可进入管理界面。
端口全部可用环境变量覆盖（`PORT` / `AI_FRONTEND_PORT` / `AI_MGMT_PORT`），
真源是 `services/backend/src/constants/serviceDefaults.js`。

| 服务 | 默认地址 | 说明 |
|------|------|------|
| AI 管理前端 | http://127.0.0.1:8090 | Vue 3 管理 UI（`AI_FRONTEND_PORT`） |
| 后端 API | http://127.0.0.1:3000 | RESTful API（`PORT`；被占用时自动探测下一个端口） |
| WebSocket | ws://127.0.0.1:3000 | 与后端 API 同端口 |
| AI 管理后端 | http://localhost:9090 | ai-backend 守护进程（`AI_MGMT_PORT`） |

只想用 CLI 而不开 Web 界面时，不需要起前端——直接 `.\khy.bat`（或在
`services\backend` 下 `npm run cli`）即可。

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
├── khy.bat / khy.sh / khy-cli.bat   # CLI 启动器（自动探测 Python / Node）
├── pyproject.toml            # pip 渠道清单与 G1 版本真源（包名 khy-os，入口 khy）
├── pnpm-workspace.yaml       # monorepo 工作区定义（package.json 为 npm scripts 总入口）
├── AGENTS.md                 # AI 与人工维护指南（工程规则语义真源）
│
├── kernel/                   # L0 手写 OS 内核（C 语言）
│   ├── src/ boot/ userland/  #   调度、分页、vfs、syscall、framebuffer、用户态
│   ├── bridge/ moonbit/      #   内核 ↔ 智能体桥接、MoonBit WASM 模块
│   └── iso/ Makefile linker.ld
│
├── platform/                 # L1 平台层
│   ├── khy_platform/         #   Python 启动器（detect env → 拉起 Node.js）
│   ├── packages/             #   @khy/shared、@khy/ui-shared、plugin-sdk、moonbit-plugin-sdk
│   └── delivery/             #   多渠道交付编排
│
├── services/                 # L2 服务层
│   ├── backend/              #   主后端：src/cli/、src/services/、src/routes/、bin/khy.js
│   └── ai-backend/           #   AI 管理后端（独立版本轨道，默认端口 9090）
│
├── apps/                     # L3 上层应用
│   ├── ai-frontend/          #   Vue 3 + Vite AI 平台管理 UI（开发端口 8090）
│   ├── khyos-desktop/        #   Electron 桌面端
│   ├── provider-hub/         #   供应商 / 模型统一管理 GUI
│   └── khy-os-client-app/    #   Flutter Android 随身 App（旧的 khy-mobile Capacitor 壳已隔离）
│
├── software/                 # L4 内置应用
│   ├── khyquant/             #   量化交易终端（内置默认应用：services/ routes/ frontend/ ml/）
│   └── akshare_scripts/      #   行情数据脚本
│
├── extensions/               # L5 内置拓展：一个目录一个拓展，删目录即卸载
│   ├── tools/                #   khy-markdown / khy-notebook / khy-dsh-compat
│   ├── bridges/              #   khy-trae-bridge（Trae / VS Code 登录态桥接）
│   └── scripts/              #   khy-portable / khy-installer / khy-diagnostics / khy-alpine-iso
│
├── tools/                    # L6 独立开发者工具（不参与运行时）
│   └── deepseek-eyes/        #   图像理解 MCP 服务
│
├── scripts/                  # 横切：CI 守卫、质量门、规则门、发布、恢复、文档站、维护
├── packaging/                # 横切：npm 渠道清单、模块清单、独立可执行、NSIS 安装包
├── docs/                     # 横切：全套中文文档（单编号轴，01_INIT ~ 19_资产）
├── electron/                 # 根级 Electron 桌面壳（入口 npm run electron:dev）
├── deploy/free-test/         # 免服务器部署试验（GitHub 工作流 + Supabase 配置）
├── patches/                  # 第三方依赖本地补丁（pnpm patchedDependencies）
├── tests/DEBT.md             # 已知失败用例的测试债务登记
└── entries/                  # 多端入口真源 + 构建产物单一根（LAYOUT-005；提交的仅 3 件索引文件，entries/<producer>/ 子目录 gitignore）
```

### 分层概览

- **Python 层**（`platform/khy_platform/`）：轻量启动器，负责检测环境并拉起 Node.js；
- **Node.js 后端**（`services/backend/`）：承载所有业务逻辑（CLI、AI 网关、各类服务、Web API）；
- **前端**：`apps/ai-frontend/`（AI 平台管理 UI，Vue 3 + Vite）与 `software/khyquant/frontend/`（内置的 khyquant 交易 UI）；
- **内核**（`kernel/`）：手写 C 语言 OS 内核，可在 QEMU 下引导运行。

> 顶层七个业务目录的**层级定位（L0–L6）、允许的依赖方向、以及新文件该放哪一层**，
> 真源是 [`docs/10_规范/DESIGN-LAY/[DESIGN-LAY-005] 仓库层级板块规范.md`](docs/10_规范/DESIGN-LAY/[DESIGN-LAY-005]%20仓库层级板块规范.md)，
> 由 `npm run check:layout` 强制执行。新增文件或新增顶层目录前先读它。

> 构建产物一律落 `entries/<producer>[/<variant>]`（深度 ≤ 2，2026-09-18 由仓库根 `_build/` 迁入），并在
> `docs/10_规范/registry/BUILD-OUTPUTS.json` 登记 `path` + `rebuild` + `inBuildAll`；
> `.gitignore` / `.dockerignore` 由该登记表派生，不得手写第二份。
> 守卫：`npm run check:build-root`。

## 文档导航

- 文档总索引：[docs/00_INDEX_文档索引.md](docs/00_INDEX_文档索引.md)
- 概念入门（Agent / Tool Calling / MCP / LLM 等）：`docs/02_CONCEPTS_概念入门/`
- 设计与实现记录：`docs/03_DESIGN_设计/`、`docs/04_IMPL_实现/`
- 部署与运维手册：`docs/06_DEPLOY_部署/`、`docs/07_OPS_运维/`
- 规范与规则登记表：`docs/10_规范/`（`RULES-REGISTRY.json` 是规则真源）

`docs/` 顶层采用**单一编号轴**：`01`–`09` 是生命周期阶段（立项 → 概念 → 设计 →
实现 → 测试 → 部署 → 运维 → 项目管理 → 传承），`10`–`19` 是跨阶段资产
（规范、报告、模板、维护记录、设计模式、归档、资产）。

> 离线文档站（`docs/**/*.html`）随仓库提供，可直接用浏览器打开。但它的图表引擎
> `docs/19_资产/site/mermaid.min.js` 是构建产物、不进 git：**首次克隆后跑一次 `npm run docs:build`**，
> Mermaid 图表才会渲染。在此之前图表区域留白 —— `docs/19_资产/site/docs-site.js` 已做优雅降级，
> 不会报错，其余正文与导航一切正常。

## 版本同步

版本号由 `scripts/ci/check-version-sync.js` 强制校验（pre-commit / CI），校验
**三条独立的版本轨道、共 9 个真源**：组内必须完全一致，组间刻意不同。

**轨道 1 — 主 khy-os 包（4 源，必须完全一致）**

1. `pyproject.toml` → `[project] version`
2. `packaging/npm/package.json` → `version`
3. `services/backend/package.json` → `version`
4. `packaging/modules/modules.json` → `version`

**轨道 2 — ai-backend 生态（3 源，组内一致；与轨道 1 刻意不同）**

1. `services/ai-backend/package.json` → `version`
2. `platform/packages/shared/package.json` → `version`
3. `platform/packages/plugin-sdk/package.json` → `version`

**轨道 3 — 浏览器 UI 共享包（依赖声明对齐，不是版本号对齐）**

1. `platform/packages/ui-shared/package.json` → `version`
2. `apps/ai-frontend/package.json` → 其 `@khy/ui-shared` 依赖声明
3. `software/khyquant/frontend/package.json` → 其 `@khy/ui-shared` 依赖声明

发布时 `scripts/release/publish-dual.sh` 从单一 `--version` 输入同步轨道 1 的前三处；
最终仍由上述守卫统一校验三轨道 9 源的一致性。

不要在 `platform/khy_platform/__init__.py` 中硬编码 `__version__`——它从 `pyproject.toml` / 已安装元数据中动态解析，硬编码会导致版本同步检查失败。

## 贡献与维护

- AI 助手与维护者指南（架构速查、工程规则、代码风格、评审清单）：[AGENTS.md](AGENTS.md)；同一份内容的人类指南见 [CONTRIBUTING.md](CONTRIBUTING.md)
- 便携模式说明：[PORTABLE.md](docs/06_DEPLOY_部署/DEPLOY/[DEPLOY-0101] PORTABLE.md)
- 工程红线（零硬编码、状态透明、活动超时、终端渲染）详见 AGENTS.md 的「工程规则」章节。

提交前建议跑这几道门：

```powershell
node scripts\ci\check-agent-rules.js --changed   # 工程红线静态体检
npm run check:layout                             # 顶层层级与依赖方向
npm run rules:gate                               # 规则门（pr 档；commit 档更快）
npm run rules:apply -- <改动文件路径>              # 查「我要改这个文件，适用哪些规则」
```

规则登记表在 `docs/10_规范/registry/RULES-REGISTRY.json`，**门的成员资格由登记表派生**
（不在 workflow YAML 或 npm `&&` 链里硬编码）；覆盖率与红线用 `npm run rules:coverage` 查看。

代码风格：JS 用 2 空格缩进、单引号、分号；命名 camelCase（JS）/ snake_case（Python）；面向用户的字符串用中文，代码注释用英文。

## 许可

**Source-available（源码可见）**。Khy-OS 可免费下载、运行、学习与非商业使用；复制、修改、再分发源码及商业使用需获得作者（孔浩原 / Kong Haoyuan）的书面许可。
