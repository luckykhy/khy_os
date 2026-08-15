# khy-os 文件格式协议 (File Format Protocol)

> 本文档为 khy-os 多语言工作台的文件格式使用协议。所有新代码、配置和数据文件必须遵守本协议。
> 违反本协议的 PR 将无法通过 `check-change-safety` 门控。

---

## 1. 协议原则

| 原则 | 说明 |
|------|------|
| **显式优于隐式** | 文件扩展名和目录结构必须自解释，不需要额外文档即可推断用途 |
| **单一职责** | 每种格式有且仅有一个核心职责（配置 / 数据 / 日志 / 文档 / 代码） |
| **机器可读优先** | 优先选择可被工具链（lint、parse、audit、version-sync）自动处理或校验的格式 |
| **向后兼容** | 不废弃已使用的格式，仅在新场景中应用本协议 |

---

## 2. 格式分类协议

### 2.1 核心数据格式

#### JSON — 强层级、强机器校验、小文件

| 维度 | 取值 |
|------|------|
| 复杂度 | 高 |
| 层级支持 | 强（嵌套对象 / 数组） |
| 体积 | 小（< 100 KB 单文件） |
| 机器可读性 | 极强（原生 JS `JSON.parse`） |
| 人类可读性 | 中 |

**适用场景（khy-os 内）：**

| 用途 | 目录 | 示例 |
|------|------|------|
| **npm / 包清单** | `*/package.json` | `package.json`, `services/backend/package.json`, `platform/packages/shared/package.json` |
| **项目配置** | 根目录、服务目录 | `esbuild.config.js` (JSON 内容), `jsconfig.json`, `babel.config.json`, `.eslintrc.json` |
| **运行时状态** | `.khy/` | `api_keys.json`, `integrity_manifest.json`, `version_cache.json`, `model_overrides.json`, `arena-*.json`, `cognitive_snapshots/*.json` |
| **审计记录** | `.khy/receipts/`, `.khy/approvals/` | `RCPT-*.json`, `ledger.json` |
| **会话归档** | `.khy/conversations/` | `*.json`（对话历史，单文件单会话） |
| **构建输出** | `dist/` | `MANIFEST.json`, 模块元数据 |
| **模块定义** | `packaging/` | `modules.json`, `dependency-map.json`, `native-modules.json` |
| **AI 前端状态** | `apps/ai-frontend/dist/vendor/` | `MANIFEST.json` |

**命名约定：**

```
<feature>.json                    — 单文件配置
<feature>-<id>.json              — 按 ID 分片的运行时状态（arena-<id>.json）
RCPT-<hash>.json                  — 审计回执（时间戳或内容哈希后缀）
```

**协议约束：**

1. `.khy/` 下的运行时 JSON 文件**必须**包含 `"version"` 字段（用于迁移兼容性检查）：
   - **格式**：语义化版本字符串（如 `"1.0.0"`）或整数 schema 版本，同一文件族内必须统一；
   - **缺失处理**：加载器检测到缺失 `version` 时**应**报出明确的迁移错误（禁止静默按默认版本处理）；
   - **版本超范围**：版本高于当前支持范围时**应**拒绝加载并提示升级。
2. 审计 / 回执类 JSON **必须**包含 `"ts"`（ISO 8601 时间戳）和 `"actor"`（操作者标识）
3. 所有 JSON 文件通过 `JSON.parse` 解析后**必须**是 Array 或 Object（禁止顶层 String / Number / null）
4. `package.json` 以外的 JSON 配置文件**禁止**包含 `"scripts"` 字段（避免与 npm 混淆）

**JSON Schema 注册表（`scripts/ci/json-schemas/`）：**

| Schema 文件 | 管控对象 |
|-------------|----------|
| `arena-session.schema.json` | `.khy/arena/arena-*.json` |
| `receipt.schema.json` | `.khy/receipts/RCPT-*.json` |
| `integrity-manifest.schema.json` | `.khy/integrity_manifest.json` |
| `runtime-config.schema.json` | `.khy/*.json`（通用运行时配置） |

> 新 JSON 格式上线前**必须**在 `scripts/ci/json-schemas/` 注册 schema，并由 `release-gate.js` 校验。

---

#### JSONL — 中层级、流式写入、极小文件

| 维度 | 取值 |
|------|------|
| 复杂度 | 中 |
| 层级支持 | 单层对象（每行一个） |
| 体积 | 极小（< 100 KB/文件，总集可能很大） |
| 机器可读性 | 强（逐行解析，可 `tail -f`） |
| 人类可读性 | 中 |

**适用场景（khy-os 内）：**

| 用途 | 目录 | 示例 |
|------|------|------|
| **审计日志** | `.khy/audit/` | `sess_*.jsonl`, `trace-events.jsonl` |
| **会话轨迹** | `.khy/sessions/`, `khy-Trajectory/` | `*.jsonl` |
| **安装账本** | `.khy/` | `.install-ledger.jsonl` |
| **A/B 测试数据** | `scripts/ab-traces/` | `*.jsonl` |
| **变更溯源** | `scripts/` | 各类 trace 文件 |

**命名约定：**

```
<feature>.jsonl               — 单文件追加日志
sess_<id>.jsonl               — 按会话分片
trace-events.jsonl            — 全局追踪流
```

**协议约束：**

1. 每行**必须**是完整的 JSON 对象（不得跨行，禁止 pretty-print）
2. 每个 JSON 对象**必须**包含顶层 `"ts"` 字段（毫秒时间戳或 ISO 8601）
3. 每行长度**不得超过 64 KB**（防止单条事件过大导致流式解析卡顿）
4. 追加写入**必须**使用 `JSON.stringify(obj) + '\n'`，禁止 trailing comma
5. 旧文件压缩归档为 `.jsonl.gz`（如 `trace-events.jsonl.1.gz`），保持原始文件名可追溯
6. 读取 JSONL **必须**使用流式 parser（逐行 `JSON.parse`），禁止一次性 `readFileSync` 大文件

---

### 2.2 配置格式

#### TOML — 平铺结构、项目级配置、小文件

| 维度 | 取值 |
|------|------|
| 复杂度 | 中 |
| 层级支持 | 弱（仅 `[section]` + `key = value`，无嵌套） |
| 体积 | 小（< 10 KB） |
| 机器可读性 | 强（Python `tomllib` / `tomli` 原生支持） |
| 人类可读性 | 极强 |

**适用场景（khy-os 内）：**

| 用途 | 目录 | 示例 |
|------|------|------|
| **Python 项目配置** | 根目录、子项目 | `pyproject.toml`, `software/khyquant/pyproject.toml` |
| **部署配置** | 根目录 | `fly.staging.toml` |
| **Rust/Moonbit 互操作** | `.khy/` | `.crates.toml` |

**协议约束：**

1. **仅用于项目元数据和构建配置**，禁止用于运行时状态或业务数据
2. `pyproject.toml` 是**唯一**的 Python 包版本真源（SSoT），`services/backend/package.json` 和 `packaging/npm/package.json` 的版本必须与之同步（由 `check-version-sync.js` 强制）
3. TOML 键名**必须**使用 `snake_case`（与 Python 风格对齐）
4. `[project]` 表内的 `version` 字段**必须**使用双引号字符串：`version = "1.1.8"`
5. 禁止在 TOML 中使用 inline table 存储超过 3 个键的复杂结构（应拆分为独立 section）

---

#### YAML — 强层级、CI/CD 配置、中文件

| 维度 | 取值 |
|------|------|
| 复杂度 | 高 |
| 层级支持 | 强（缩进、列表、锚点） |
| 体积 | 中（< 50 KB） |
| 机器可读性 | 中（缩进敏感，anchor/alias 难以静态校验） |
| 人类可读性 | 极强 |

**适用场景（khy-os 内）：**

| 用途 | 目录 | 示例 |
|------|------|------|
| **CI/CD 工作流** | `.github/workflows/` | `dual-channel-release.yml`, `docker.yml`, `build-executables.yml` 等 |
| **ML 训练配置** | `software/khyquant/ml/` | `config.yaml` |
| **Dependabot 配置** | `.github/` | `dependabot.yml` |

**协议约束：**

1. **仅用于 CI/CD 和 ML 配置**，禁止用于运行时状态或应用数据
2. GitHub Actions 工作流文件名**必须**使用 `kebab-case` 并以 `.yml` 结尾（不用 `.yaml`）
3. YAML 文件**必须**在 CI 中通过 `actionlint` 或 `yamllint` 校验
4. 禁止使用 YAML anchor/alias（`&`, `*`）—— 降低可读性和可维护性
5. 禁止在 YAML 中硬编码 secrets（必须使用 GitHub Secrets / `${{ secrets.* }}`）

---

#### .env — 键值对、运行时敏感配置

| 维度 | 取值 |
|------|------|
| 复杂度 | 低 |
| 层级支持 | 无（扁平键值对） |
| 体积 | 极小（< 5 KB） |
| 机器可读性 | 中（需解析器处理引号、export、注释） |
| 人类可读性 | 中 |

**适用场景（khy-os 内）：**

| 用途 | 目录 | 示例 |
|------|------|------|
| **服务环境变量** | `services/`, `services/backend/` | `.env`, `.env.example` |
| **运行时 secrets** | `.khy/` | `.env` |
| **前端环境变量** | `apps/ai-frontend/` | `.env`（Vite 注入） |

**协议约束：**

1. **`.env` 文件禁止提交到 Git**（`.gitignore` 已覆盖），仅保留 `.env.example` 作为模板
2. `.env.example` **必须**包含所有必需环境变量的注释说明
3. `.env` 值**禁止**使用未加引号的裸字符串（`KEY=value with spaces` 会静默截断）
4. 密钥类变量命名**必须**以 `_SECRET`、`_TOKEN` 或 `_KEY` 结尾，便于审计扫描
5. 读取 `.env` **必须**使用 `dotenv` 库，禁止手动正则解析

---

### 2.3 文档格式

#### Markdown (.md) — 主要文档格式

| 维度 | 取值 |
|------|------|
| 复杂度 | 低 |
| 层级支持 | 强（标题层级） |
| 体积 | 中（< 50 KB） |
| 机器可读性 | 中（可解析为 AST） |
| 人类可读性 | 极强 |

**适用场景（khy-os 内）：**

| 用途 | 目录 | 示例 |
|------|------|------|
| **项目文档** | 根目录、`docs/` | `README.md`, `AGENTS.md`, `CONCEPT-*.md` |
| **架构决策** | `docs/` | `DESIGN-ARCH-*.md` |
| **变更日志** | 根目录 | `CHANGELOG.md` |
| **用户记忆** | `.khy/memory/` | `MEMORY.md`, 各类 memory 文件 |
| **扩展文档** | `extensions/`, `tools/` | `README.md` |

**协议约束：**

1. **所有 Markdown 文件必须使用 LF 换行**（`\n`），禁止 CRLF
2. 标题层级**不得跳级**（`#` → `##` → `###`，禁止 `#` → `###`）
3. 代码块**必须**指定语言标识：\`\`\`javascript 而非 \`\`\`
4. 链接**必须**使用相对路径（禁止绝对路径如 `/docs/xxx.md`）
5. 表格**必须**使用 pipe 语法，对齐列
6. 行宽**不超过 120 字符**（理由：适配标准终端与 diff 审阅宽度；长 URL 与表格行可豁免）

---

#### HTML (.html) — 渲染输出

**适用场景：**

| 用途 | 目录 |
|------|------|
| **文档渲染输出** | `docs/`（`.md` 的渲染产物） |
| **前端入口** | `apps/ai-frontend/index.html` |
| **工具页面** | `tools/khyos-markdown/` |

**协议约束：**

1. `docs/` 下的 `.html` 是 `.md` 的渲染产物，**禁止手动编辑**，由 `docs_site.py` 自动生成
2. 前端 `index.html` **必须**包含 `<meta charset="utf-8">`
3. 禁止使用内联 `<style>` 和 `<script>`（除非是单文件工具）

---

### 2.4 代码格式

| 格式 | 角色 | 协议要点 |
|------|------|----------|
| **JavaScript (.js)** | 主要实现语言 | ES modules (`import`/`export`)，严格模式 `'use strict'`，顶部必须加 shebang `#!/usr/bin/env node` |
| **TypeScript (.ts)** | 类型标注（可选） | 与 `.js` 混用，编译输出到 `dist/` |
| **Python (.py)** | 平台启动器、ML、数据 | UTF-8 编码，顶部必须加 shebang `#!/usr/bin/env python3` |
| **Vue (.vue)** | 前端组件 | `<script setup>` 语法，单文件组件 |
| **Moonbit (.mbt)** | 内核 / WASM | Moonbit 模块系统，`moon.pkg.json` 清单 |
| **C (.c/.h)** | 内核 | 严格 80 列，函数注释遵循 kernel-doc 风格 |
| **Assembly (.asm)** | 引导 / 用户态测试 | NASM 语法，全局标签大写 |
| **SQL (.sql)** | 数据库 schema / 迁移 | 大写 SQL 关键字，每个语句独占一行 |
| **Shell (.sh)** | 构建 / 部署 | `set -euo pipefail`，函数命名 `snake_case` |
| **Batch (.bat)** | Windows 启动 | `@echo off`，REM 注释 |
| **PowerShell (.ps1)** | Windows 部署 | `#` 注释，cmdlet 命名 `Verb-Noun` |

---

### 2.5 禁止使用的格式

| 格式 | 状态 | 原因 | 替代方案 |
|------|------|------|----------|
| **XML** | **禁止新增使用** | 项目不涉及 SOAP/SVG，XML 增加解析复杂度 | 使用 JSON（数据）或 Markdown（文档） |
| **INI** | **禁止新增使用** | 无 section 嵌套能力，值类型有限 | 使用 TOML（配置）或 `.env`（简单键值） |
| **CSV** | **仅存量保留** | 无 schema，易出错 | 新增数据交换使用 JSONL 或 JSON |
| **Protocol Buffers** | **不使用** | 增加编译依赖，项目规模不需要 | 使用 JSON / JSONL |
| **YAML（非 CI/CD）** | **禁止** | 缩进敏感，安全风险（任意对象注入） | 使用 TOML 或 JSON |

---

## 3. 目录级别格式协议

```
khy-os/
├── .github/                    # YAML only (workflows, dependabot)
│   └── workflows/
├── .khy/                       # JSON + JSONL + TOML + .env + DB + PNG
│   ├── *.json                  #  运行时配置（小，结构化）
│   ├── *.jsonl                 #  审计/会话日志（流式追加）
│   ├── .crates.toml            #  Moonbit 互操作配置
│   ├── .env                    #  敏感运行时变量
│   ├── *.db                    #  SQLite 持久化
│   └── cognitive_snapshots/    #  JSON（快照）
├── docs/                       # Markdown (.md) + 渲染 HTML
├── scripts/                    # JavaScript (.js) + Shell (.sh) + Python (.py) + JSONL
├── services/
│   ├── backend/                # JS + JSON + .env + SQL + PY + Dockerfile
│   └── ai-backend/             # JS + JSON + Dockerfile
├── platform/                   # PY + JS + JSON + Moonbit + PNG
├── packaging/                  # JS + JSON + MD
├── kernel/                     # C + H + ASM + MBT + LD + Makefile + Dockerfile
├── software/
│   └── khyquant/               # JS + PY + JSON + YAML + Vue + CSS + HTML
├── apps/
│   └── ai-frontend/            # Vue + JS + CSS + HTML + JSON + Dockerfile
├── extensions/                 # JS + JSON + MD + HTML
├── tools/                      # JS + JSON + CSS + MD + HTML + PNG
├── .github/                    # YAML (CI/CD)
├── pyproject.toml              # Python 项目元数据（版本真源）
├── fly.staging.toml            # Fly.io 部署配置
├── CHANGELOG.md                # 变更日志
├── Dockerfile                  # 容器镜像定义
├── .dockerignore               # Docker 上下文排除
└── [root package.json]         # npm workspace 根清单
```

---

## 4. 命名约定

| 文件类型 | 约定 | 示例 |
|----------|------|------|
| 包清单 | `package.json` | `services/backend/package.json` |
| 运行时状态（单文件） | `<noun>.json` | `integrity_manifest.json` |
| 运行时状态（分片） | `<noun>-<id>.json` | `arena-abc123.json` |
| 审计回执 | `RCPT-<hash>.json` | `RCPT-a1b2c3d4.json` |
| 日志（流式） | `<feature>.jsonl` | `trace-events.jsonl` |
| 会话日志 | `sess_<id>.jsonl` | `sess_T.jsonl` |
| CI 工作流 | `<action>-<target>.yml` | `dual-channel-release.yml` |
| 配置文件 | `<tool>.config.<ext>` | `esbuild.config.js`, `babel.config.json` |
| 版本日志 | `CHANGELOG.md` | 根目录唯一 |
| 架构决策 | `DESIGN-ARCH-<NNN>-<slug>.md` | `DESIGN-ARCH-001-agent-bridge.md` |

---

## 5. 协议执行与门控

本协议由以下工具强制执行：

| 工具 | 检查项 | 触发时机 |
|------|--------|----------|
| `check-version-sync.js` | 4+2 文件版本一致性 | CI on every push |
| `changelog-new.js` | CHANGELOG.md 版本头匹配 | CI on tag push |
| `release-gate.js` | 预发布确定性检查 | CI on tag push |
| `check-change-safety.js` | 变更安全规则 | 预提交 / CI |
| `check-node-syntax.js` | JS 语法 | CI |
| `check-python-syntax.js` | PY 语法 | CI |
| `actionlint` | YAML CI 语法 | CI（待集成） |
| `json-schemas/` | JSON 结构合规 | release-gate |
| `.prettierrc` + `.eslintrc.*` | 代码风格 | CI |

**新增格式或变更格式用途** → 必须更新本文档 → 必须更新对应门控脚本 → 必须通过 `release-gate.js`。

---

## 7. 关联文档

| 文档 | 关系 |
|------|------|
| [`COMMUNICATION-PROTOCOL.md`](./COMMUNICATION-PROTOCOL.md)（规划中，尚未创建） | 互补：本文件定义「存什么」，该文件定义「怎么传」。HTTP/WebSocket/IPC/SSE 等通信信封格式请参见该文件。 |
| `scripts/ci/json-schemas/*.schema.json` | 实现：`.khy/` 下 JSON 文件的 JSON Schema 校验定义 |
| `scripts/ci/validate-json-schemas.js` | 实现：Schema 校验执行器 |
| `scripts/ci/validate-protocol-contracts.js` | 实现：通信协议契约校验执行器 |
| `scripts/release/lib/releaseGateStages.js` | 集成：两个校验均已加入发布门禁 |

---

## 6. 版本与修订

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-07-26 | 初始版本，覆盖 JSON/JSONL/TOML/YAML/.env/Markdown 核心协议 |
