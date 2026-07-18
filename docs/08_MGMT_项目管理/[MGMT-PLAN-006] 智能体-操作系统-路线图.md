<!-- 文档分类: MGMT-PLAN-006 | 阶段: 项目管理 | 原路径: docs/智能体-操作系统-路线图.md -->
# Khy OS Agentic OS 实施路线图

> 目标：将 Khy OS 从量化交易平台升级为 **Agentic OS** — 既支持内核级部署（定制 Linux 发行版），也支持用户态安装（`npm install -g` / `pip install`）。对标 ANOLISA 全部六大组件 + MoonBit WASM 沙箱架构，分阶段落地。
>
> 架构红线：**"内核绝不动，沙箱任你卷"** — 微内核层用 C/Rust，沙箱/应用层用 MoonBit WASM。

---

## 现有能力 vs ANOLISA 差距矩阵

| ANOLISA 组件 | Khy OS 已有 | 差距 |
|---|---|---|
| Copilot Shell (AI CLI) | CLI REPL + AI Gateway + 多适配器 + 工具系统 | 缺 Hooks 系统、扩展市场、i18n、PTY 模式、非交互模式 |
| Agent Sec Core (安全内核) | securityGuardService, authGuard, toolSandbox, fileIntegrity, antivirus | 缺 Prompt 注入检测、代码扫描引擎、技能签名验证 |
| AgentSight (可观测性) | aiMonitor, auditLog, tokenUsageService, telemetry | 缺 eBPF 探针、SSL 流量拦截、GenAI 语义事件、进程自动发现 |
| Tokenless (Token 优化) | 无 | 全新实现 — Schema 压缩、Response 压缩、命令重写 |
| OS Skills (技能库) | skillRegistry, skillLearningService, 19个内置工具 | 缺 SKILL.md 标准格式、远程技能发现、技能优先级链 |
| ws-ckpt (工作区快照) | 无 | 全新实现 — btrfs/overlayfs 快照、守护进程 |

---

## 阶段一：Copilot Shell 增强（预计 3 周）

强化现有 CLI 为完整的 AI 编程终端。

### 1.1 Hooks 系统
- **位置**: `backend/src/cli/hooks/`
- **实现**: hookRegistry → hookPlanner → hookRunner 三层架构
- **事件**: `PreToolUse`, `PostToolUse`, `PrePrompt`, `PostResponse`
- **配置**: `~/.khyquant/hooks.json` 声明式挂钩
- **参考**: ANOLISA `packages/core/src/hooks/`

### 1.2 技能标准化（SKILL.md 格式）
- **位置**: `backend/src/skills/` + `~/.khyquant/skills/`
- **格式**: YAML frontmatter + Markdown body（同 ANOLISA 的 SKILL.md）
- **字段**: name, version, description, layer, lifecycle, tags, platforms, dependencies
- **发现链**: 项目目录 > 用户目录 > 内置 > 远程仓库
- **现有改造**: 将 skillRegistry.js 适配新格式

### 1.3 PTY 模式
- **位置**: `backend/src/cli/pty.js`
- **实现**: 使用 `node-pty` 创建伪终端，支持 sudo、交互式命令
- **集成**: CLI 的 `/bash` 命令切换到 PTY 子 shell

### 1.4 非交互模式（Headless / SDK）
- **位置**: `backend/src/cli/nonInteractive.js`
- **实现**: JSON stdin/stdout 协议，支持外部进程调用 CLI
- **用途**: CI/CD 集成、IDE 扩展后端、ACP 协议对接

### 1.5 扩展系统
- **位置**: `backend/src/cli/extensions/`
- **实现**: extensionManager（安装/卸载/启用/禁用）、MCP 服务器管理
- **扩展格式**: `openclaw.plugin.json`（兼容 ANOLISA）

---

## 阶段二：Agent Sec Core 安全内核（预计 4 周）

OS 级安全能力，保护 AI Agent 的每一次操作。

### 2.1 Prompt 注入检测器
- **位置**: `backend/src/services/security/promptScanner/`
- **三层检测**:
  - `ruleEngine.js` — 正则规则引擎（关键词、模式匹配）
  - `semanticDetector.js` — 语义分析（向量相似度检测已知攻击模式）
  - `mlClassifier.js` — ML 分类器（DeBERTa/PromptGuard 模型推理）
- **pipeline**: preprocessor → detectors[] → verdict → audit
- **参考**: ANOLISA `agent-sec-cli/src/prompt_scanner/`

### 2.2 代码扫描引擎
- **位置**: `backend/src/services/security/codeScanner/`
- **实现**:
  - `codeExtractor.js` — 从 Markdown/对话中提取代码块
  - `regexEngine.js` — 基于规则的危险代码检测
  - `ruleLoader.js` — YAML 规则加载器
- **规则覆盖**: 命令注入、文件系统越权、网络外连、密钥泄露
- **参考**: ANOLISA `agent-sec-cli/src/code_scanner/`

### 2.3 技能签名与验证
- **位置**: `backend/src/services/security/skillLedger/`
- **实现**:
  - ed25519 密钥对生成
  - `sign-skill.sh` 签名工具
  - `verifier.js` 运行时签名验证
- **流程**: 技能加载前验证签名 → 签名不合法则拒绝执行
- **参考**: ANOLISA `agent-sec-cli/src/asset_verify/`

### 2.4 沙箱命令分级
- **位置**: 增强现有 `toolSandbox.js`
- **实现**: 命令分级（safe / moderate / dangerous / critical）
- **策略**: safe 自动放行 → moderate 需确认 → dangerous 需 sudo → critical 禁止
- **参考**: ANOLISA `agent-sec-cli/src/sandbox/classify_command.py`

---

## 阶段三：AgentSight 可观测性（预计 5 周）

eBPF 零侵入监控 + 用户态可观测性双模架构。

### 3.1 用户态监控（Node.js，无需 root）
- **位置**: `backend/src/services/agentsight/`
- **增强现有**: 统一 aiMonitor + auditLog + tokenUsageService
- **数据管线**: Interceptor → Parser → Aggregator → Analyzer → Storage
- **存储**: SQLite（已有）+ 可选远程导出

### 3.2 GenAI 语义事件模型
- **位置**: `backend/src/services/agentsight/genai/`
- **事件类型**:
  - `llm.call` — LLM API 调用（模型、token、耗时）
  - `tool.use` — 工具调用（工具名、参数、结果）
  - `agent.step` — Agent 步骤（推理链、决策点）
- **格式**: 兼容 OpenTelemetry GenAI Semantic Conventions
- **参考**: ANOLISA `src/agentsight/src/atif/`

### 3.3 Agent 进程自动发现
- **位置**: `backend/src/services/agentsight/discover.js`
- **实现**: 扫描 `/proc`，监控 `execve`（通过 child_process），识别已知 AI Agent 进程
- **识别**: claude-code, copilot, cursor, cosh, openai-codex 等

### 3.4 eBPF 探针（内核级，需 root）
- **位置**: `backend/src/services/agentsight/ebpf/`
- **语言**: C (BPF) + Rust (用户态加载器) 或 Python (bcc)
- **探针**:
  - `sslsniff.bpf.c` — SSL_read/SSL_write uprobe，捕获明文 LLM API 流量
  - `proctrace.bpf.c` — execve 追踪，构建进程树
  - `procmon.bpf.c` — 进程创建/退出监控
- **降级**: 非 root 环境自动回退到用户态监控（3.1）
- **参考**: ANOLISA `src/agentsight/src/bpf/`

---

## 阶段四：Tokenless Token 优化（预计 2 周）

减少 LLM API 调用的 token 消耗，直接降本。

### 4.1 Schema 压缩器
- **位置**: `backend/src/services/tokenless/schemaCompressor.js`
- **实现**: JSON Schema → 极简类型标注（如 `{name:s, age:i, items:[{id:i,qty:i}]}`）
- **目标**: 工具定义 schema 压缩 60-80%
- **集成**: AI Gateway pluginChain 前置压缩

### 4.2 Response 压缩器
- **位置**: `backend/src/services/tokenless/responseCompressor.js`
- **实现**: 对 LLM 返回的长文本做结构化摘要、去重、缩写
- **集成**: AI Gateway 后置处理

### 4.3 命令重写器
- **位置**: `backend/src/services/tokenless/commandRewriter.js`
- **实现**: 将冗长的自然语言指令重写为紧凑的结构化指令
- **场景**: 多轮对话中的历史消息压缩

### 4.4 Token 统计
- **集成**: 增强现有 tokenUsageService
- **实现**: 记录压缩前/后 token 数，计算节省比例
- **参考**: ANOLISA `tokenless/crates/tokenless-stats/`

---

## 阶段五：OS Skills 技能库（预计 3 周）

系统管理、安全、DevOps 技能集。

### 5.1 技能框架
- **位置**: `backend/src/skills/`
- **标准**: 每个技能一个目录，包含 `SKILL.md`（定义）+ 可选的执行脚本
- **加载器**: 解析 YAML frontmatter，按 layer/lifecycle/tags 索引

### 5.2 内置技能集
- **system-admin/**: Linux 系统管理、systemd、网络、磁盘
- **security/**: CVE 查询、漏洞扫描、安全加固
- **devops/**: Git 工作流、CI/CD、容器管理
- **monitor-perf/**: 性能监控、资源分析
- **ai/**: 模型管理、MCP 配置、Agent 部署
- **quant/**: 量化交易专属技能（策略回测、数据获取、信号分析）

### 5.3 远程技能仓库
- **位置**: `backend/src/services/skillMarketplace.js`
- **实现**: 远程 Git 仓库拉取、本地缓存、版本管理
- **安全**: 下载后经 skillLedger 签名验证才可加载

---

## 阶段六：ws-ckpt 工作区快照（预计 3 周）

AI Agent 工作区的秒级快照与回滚。

### 6.1 用户态快照（跨平台）
- **位置**: `backend/src/services/workspace/`
- **实现**: Git worktree + tar 增量备份
- **命令**: `khyquant workspace save/restore/list/diff`
- **适用**: 任何文件系统，无需 root

### 6.2 内核级快照（Linux btrfs）
- **位置**: `backend/src/services/workspace/btrfs/`
- **实现**: btrfs subvolume snapshot（COW，毫秒级）
- **守护进程**: systemd 服务，Unix Socket IPC
- **降级**: 非 btrfs 自动回退到用户态方案（6.1）

### 6.3 自动检查点
- **触发**: 工具执行前自动创建检查点
- **策略**: 可配置频率（每次/每分钟/手动）
- **清理**: 自动过期，保留最近 N 个

---

## 阶段七：MoonBit WASM 沙箱运行时（预计 4 周）

双模架构：Unikernel 极简部署 + 组件化 OS 应用沙箱。

### 7.1 WASM 沙箱运行时
- **位置**: `backend/src/services/wasm-sandbox/`
- **实现**: 嵌入 Wasmtime/Wasmer 运行时（Node.js N-API 绑定）
- **能力**: 加载 MoonBit 编译的 `.wasm` 模块，在沙箱中执行
- **隔离**: WASM 天然沙箱，模块只能通过显式 Host Function 访问系统资源
- **用途**: 插件执行、策略运算、指标计算、第三方扩展

### 7.2 MoonBit 插件 SDK
- **位置**: `packages/moonbit-plugin-sdk/`
- **实现**: MoonBit 语言编写的插件标准接口
- **接口**: `init()`, `execute(input: Bytes) -> Bytes`, `metadata() -> PluginMeta`
- **构建**: `moon build --target wasm` → 产物 < 100KB
- **示例插件**:
  - 技术指标计算（MA/RSI/MACD，纯 WASM，零依赖）
  - Schema 压缩器（阶段四的 Tokenless 可选用 MoonBit 实现极致性能版）
  - 自定义策略评分器

### 7.3 Unikernel 部署模式
- **位置**: `scripts/unikernel/`
- **实现**: 将核心 API 网关编译为 MoonBit WASM → 跑在 Firecracker 微虚拟机上
- **目标**: 冷启动 < 5ms，镜像 < 500KB
- **适用**: 无状态 API 网关节点、Serverless 策略执行器、边缘行情转发节点

### 7.4 组件化 OS 架构
- **架构**:
```
┌──────────────────────────────────────────────────────┐
│                    应用层 (MoonBit WASM)              │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ 策略引擎 │  │ 指标计算 │  │ 第三方量化插件     │  │
│  └────┬─────┘  └────┬─────┘  └──────────┬─────────┘  │
├───────┼─────────────┼───────────────────┼────────────┤
│       │   WASM 虚拟机运行时 (Wasmtime)  │            │
│       │   Host Functions: fs/net/db/ai  │            │
├───────┴─────────────┴───────────────────┴────────────┤
│             Khy OS Core (Node.js / Rust)             │
│    AI Gateway · 安全内核 · 可观测性 · 技能系统       │
├──────────────────────────────────────────────────────┤
│           微内核层 (Linux Kernel / Firecracker)       │
│    内存 · 调度 · IPC · 设备驱动                      │
└──────────────────────────────────────────────────────┘
```
- **Host Functions 白名单**: 文件读写(受限路径)、网络请求(受限域名)、数据库查询(只读)、AI 推理调用
- **安全**: 插件无法越权，所有系统调用必须经过 Host Function 网关 + Agent Sec Core 审计

---

## 阶段八：OS 发行版集成（预计 4 周）

打包为可安装的操作系统层。

### 8.1 RPM/DEB 打包
- **位置**: `scripts/packaging/`
- **产物**: `khy-quant-os`, `khy-copilot-shell`, `khy-agent-sec`, `khy-agentsight`, `khy-tokenless`, `khy-os-skills`, `khy-ws-ckpt`, `khy-wasm-runtime`
- **依赖**: Node.js 20+, Python 3.10+, 可选 Rust runtime

### 8.2 系统服务化
- **实现**: systemd unit files
- **服务**: khy-backend, khy-agentsight-daemon, khy-ws-ckpt-daemon
- **配置**: `/etc/khyquant/` 统一配置目录

### 8.3 ISO/OVA 镜像（内核级）
- **基础**: Debian/Ubuntu minimal 或 Anolis OS
- **预装**: 全部组件 + 预配置 + 首次启动向导
- **目标**: 开箱即用的 AI 量化操作系统

---

## 实施优先级

```
阶段一 ──┐
         ├── 阶段二 ──┐
阶段四 ──┘            ├── 阶段三 ── 阶段六 ──┐
                      │                      ├── 阶段八
         阶段五 ──────┘            阶段七 ───┘
```

- **阶段一 + 四** 可并行（CLI 增强 + Token 优化，无依赖）
- **阶段二** 依赖阶段一的 Hooks 系统（安全拦截需要挂钩点）
- **阶段五** 依赖阶段一的技能标准化
- **阶段三** 依赖阶段二（安全事件需上报可观测性系统）
- **阶段六** 依赖阶段三（快照操作需审计记录）
- **阶段七** 独立可并行（WASM 沙箱是独立子系统）
- **阶段八** 最后集成打包，依赖所有前置阶段

---

## 文件组织预览

```
backend/
├── src/
│   ├── cli/
│   │   ├── hooks/              # [新] Hooks 系统
│   │   ├── extensions/         # [新] 扩展管理
│   │   ├── pty.js              # [新] PTY 模式
│   │   └── nonInteractive.js   # [新] 非交互模式
│   ├── services/
│   │   ├── security/           # [新] 安全内核
│   │   │   ├── promptScanner/
│   │   │   ├── codeScanner/
│   │   │   └── skillLedger/
│   │   ├── agentsight/         # [新] 可观测性
│   │   │   ├── genai/
│   │   │   ├── ebpf/
│   │   │   └── discover.js
│   │   ├── tokenless/          # [新] Token 优化
│   │   │   ├── schemaCompressor.js
│   │   │   ├── responseCompressor.js
│   │   │   └── commandRewriter.js
│   │   ├── workspace/          # [新] 工作区快照
│   │   │   ├── btrfs/
│   │   │   └── gitWorktree.js
│   │   └── wasm-sandbox/       # [新] WASM 沙箱运行时
│   │       ├── runtime.js      # Wasmtime N-API 绑定
│   │       ├── hostFunctions.js # Host Function 白名单
│   │       └── pluginLoader.js # 插件加载器
│   └── skills/                 # [新] 技能库
│       ├── system-admin/
│       ├── security/
│       ├── devops/
│       ├── ai/
│       └── quant/
packages/
├── moonbit-plugin-sdk/         # [新] MoonBit 插件 SDK
│   ├── src/
│   │   ├── lib.mbt            # 插件标准接口
│   │   └── examples/
│   └── moon.pkg.json
scripts/
├── packaging/                  # [新] 系统打包
│   ├── rpm/
│   ├── deb/
│   └── iso/
└── unikernel/                  # [新] Unikernel 构建
    ├── firecracker.json
    └── build-unikernel.sh
```
