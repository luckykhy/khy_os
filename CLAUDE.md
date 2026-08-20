# CLAUDE.md — Khy-OS 项目规范

> 本文件是**项目级** Claude Code 工作规范，与仓库根目录的 AGENTS.md（AI 与人工维护指南）、
> CONTRIBUTING.md（贡献指南）互补。涉及工程红线、贡献流程、发布流程时，以这两份文档的原文为准；
> 本文件只做索引与「开箱即用」的速查，不重复展开。

---

## 项目是什么

**Khy-OS** 是一个通过 PyPI（`pip install khy-os`）和 npm（`@khy-os/khy-os`）双渠道分发的
AI 平台操作系统：Claude-Code 级智能体 CLI + 多后端 AI 网关 + 手写 OS 内核。

- **Python 层**（`platform/khy_platform/`）：轻量启动器，检测环境并拉起 Node.js（pip 入口）。
- **Node.js 后端**（`services/backend/`）：全部业务逻辑（CLI、AI 网关、各类 service、Web API）。
- **前端**：`apps/ai-frontend/`（AI 平台管理 UI，Vue 3 + Vite）与 `software/khyquant/frontend/`。
- **内核**（`kernel/`）：手写 C 语言 OS 内核（抢占式调度、按需分页、COW fork、ELF+PE 双加载器），
  QEMU 下引导，与 Node 栈无运行时耦合。

**khyquant**（`software/khyquant/`）是运行在该基座之上的**内置默认应用**，不是项目本身。

调用链：`User → khy 命令 → Python cli.py → services/backend/bin/khy.js → CLI(src/cli/) / Service(src/services/) / Web API(src/routes/)`

---

## 先读这些（权威文档）

| 文档 | 作用 |
| --- | --- |
| `AGENTS.md` | **AI 助手必读**：架构速查、代码风格、四条工程红线（强制）、评审清单 |
| `CONTRIBUTING.md` | 分支策略、提交规范、改动规模硬门禁、PR 前自检、发布流程 |
| `docs/03_DESIGN_设计/[DESIGN-ARCH-068] 仓库层级板块规范.md` | **新增文件/顶层目录/任务入口前必读**：L0–L6 层级、依赖方向、命名规约（`npm run check:layout` 强制执行） |
| `docs/00_INDEX_文档索引.md` | 文档总索引；`docs/` 两轴命名见 [DESIGN-ARCH-068] 第三节 |
| `.ai/GOVERNANCE-LEDGER.md` | 跨 Block 过程登记（治理台账） |

> 仓库交流允许中英双语，随用户语言切换；代码注释用中文或英文均可（仓库惯例：代码注释英文）。

---

## 目录分层（真源 [DESIGN-ARCH-068]，改动前先读它）

| 层 | 目录 | 职责 |
| --- | --- | --- |
| L0 | `kernel/` | 手写 OS 内核（C/ASM/MoonBit） |
| L1 | `platform/` | Python 启动器 + 共享包（`@khy/shared`）+ 交付编排 |
| L2 | `services/` | Node 运行时，全部业务逻辑（backend / ai-backend） |
| L3 | `apps/` | 平台自带管理前端（ai-frontend） |
| L4 | `software/` | 跑在平台之上的内置默认应用（khyquant） |
| L5 | `extensions/` | 内置拓展，随主包分发，一目录一拓展，删目录即卸载 |
| L6 | `tools/` | 独立开发者工具，不参与运行时 |

横切层（不参与依赖判定）：`scripts/`、`packaging/`、`docs/`、`alpine/`、`_source/`。
生成目录：`build/`、`dist/`、`*.egg-info/`（不进 git）。

**新文件放哪一层，先查 [DESIGN-ARCH-068] 第一节；改完跑 `npm run check:layout` 验证。**

---

## 常用命令

```powershell
# ── 开发启动 ────────────────────────────────────────────────
.\khy.bat                      # Windows 便携启动器进入 khy CLI（自动探测 Python / Node）
cd services\backend
npm install && npm start       # 生产模式
npm run dev                    # nodemon 热重载
npm run cli                    # 直接进入 CLI（node bin/khy.js）
npm run migrate                # 数据库迁移

# ── 测试 ────────────────────────────────────────────────────
npm run test:one -- <path>     # 跑单个测试文件（node --test 把位置参数当 glob，必须写路径）
npm run test:scripts           # scripts 测试（scripts/tests/**/*.test.js）
npm run test:backend           # 后端全量（jest + node:test，workspace）
npm test --prefix apps\ai-frontend   # 前端（vitest + node:test）
npm run quality:pr             # PR 质量门（脚本测试 / agent-rules / provider 契约 / workflow 回归 / 覆盖率 / 版本同步）

# ── PR 前自检（按代价从低到高，全部零安装）─────────────────
node scripts\ci\check-change-safety.js --changed --promote=sensitive-paths   # 凭据阻断，其余报告
node scripts\ci\check-version-sync.js                                        # 双轨道 6 源版本一致
node scripts\ci\check-agent-rules.js --changed                               # 四条工程红线
node scripts\ci\check-leaf-contract.js --changed                             # 纯叶子契约
node scripts\ci\check-repo-layout.js --promote=root-whitelist,docs-index-first,layer-registry  # 层级
node scripts\ci\check-flag-registry.js                                       # KHY_* flag 注册表结构
node scripts\ci\check-model-hardcoding.js --changed                          # 模型名单一真源
node scripts\ci\check-python-syntax.py <改动到的 .py 文件...>                # Python 语法（py_compile）

# ── 构建产物（不进 git，需按需重建）────────────────────────
node extensions	ools\khy-markdown\muya-embed\ensure-vendor.mjs   # muya WYSIWYG 引擎（约 11 MB）
npm run docs:mermaid                                        # 文档站 Mermaid 图表引擎（约 3.3 MB）
npm run docs:build                                          # 离线文档站 HTML（含 mermaid）

# ── 便捷入口 ────────────────────────────────────────────────
npm run check:structure       # 层级 + 模式注册表 + JSON schema + JS 语法 + 构建产物 + 运行时放置
npm run check:changed         # 变更安全 + agent 规则 + 叶子契约
npm run gate:release          # 发布门
```

---

## 工程红线（强制，全文见 AGENTS.md「工程规则」）

1. **零硬编码**：源码禁止字面量 IP/端口/绝对路径/第一方生产域名（`khyquant.top` 等）。
   生产端点从 `services/backend/src/constants/serviceDefaults.js` 导入或 env 覆盖
   （`process.env.KHY_CLOUD_ENDPOINT || <default>` 式回退**不豁免**）。
2. **状态透明**：面向用户的状态文本必须「动作 + 目标 + 进度」——禁止「正在工作… / 处理中… / Loading…」。
3. **基于活动的超时**：长时间运行任务用空闲/滑动超时（`lastActivity` 重置），禁止固定时长硬 kill。
4. **终端渲染**：内联 CLI 不用 ANSI 滚动区（`\x1B[n;mr`），用保存/恢复光标 + 绝对定位。

每条红线都有 `scripts/ci/check-agent-rules.js` 自动扫描。

---

## 版本与发布

**三个独立版本轨道，组内必须一致（`scripts/ci/check-version-sync.js` 强制）：**

- **轨道 1（主 khy-os 包，4 源）**：`pyproject.toml [project] version`、`packaging/npm/package.json`、`services/backend/package.json`、`packaging/modules/modules.json`
- **轨道 2（ai-backend 生态，2 源，与轨道 1 刻意不同）**：`services/ai-backend/package.json`、`platform/packages/shared/package.json`（捆绑成 pip wheel 共同发布，1.6.x）
- **轨道 3（浏览器 UI 共享包，3 源，独立发布）**：`platform/packages/ui-shared/package.json`、`apps/ai-frontend/package.json`、`software/khyquant/frontend/package.json`（后两者以 `@khy/ui-shared` 依赖声明对齐，0.1.0）

**不要编辑 `platform/khy_platform/__init__.py`**——它的 `__version__` 从 pyproject / 已安装
元数据动态解析，硬编码字面量会让版本同步检查**故意失败**。发布时 `scripts/release/publish-dual.sh`
从单一 `--version` 同步主轨道三源。

---

## 编码约定

- **JS**：2 空格缩进、单引号、分号；命名 camelCase。ESLint 9 flat config（`services/backend/eslint.config.js`）。
- **Python**：snake_case；CI 只做 `py_compile` 语法检查（flake8/black **未配置**，勿引入）。
- 面向用户的字符串用中文；代码注释用英文（两者都是仓库惯例，不是硬门禁）。
- **纯叶子契约**：自声明「纯叶子」的文件（头部 docstring 标记）必须守住「零 IO、env 门控、fail-soft」，
  `check-leaf-contract.js` 机器强制——改叶子时**不要顺手加 `require('fs')` 或删掉门控**。
- 顺手修复附近坏味道可以，但别扩大改动集：**PR 20 个文件是硬上限，8 个以内是舒适区**
  （`scripts/ci/check-change-safety.js`）。
- 新增文档/文件后自查一次 `git grep -I -o -h --untracked -E 'npm run [a-zA-Z0-9:_-]+' | sort -u`——
  dangling-task 守卫只看被跟踪内容，占位符写 `npm run <目标>`，别把假目标名带进索引。

## 提交与分支

- Conventional Commits：`<type>(<scope>): <简述>`，scope 用维护映射表 area-id
  （`docs/_维护者/维护映射表.json`，111 个区域，与 CODEOWNERS 归属对应）。
- 分支：`feat/<area-id>/<简述>`、`fix/...`、`docs/<简述>`、`chore/<简述>`、`dev/<姓名>/<简述>`。
  主干名是 **`master`**（workflow 同时监听 `[main, master]`）。
- 合并前 `git fetch && git rebase origin/master`；启用 `git config rerere.enabled true`。

## 发布注意事项（易踩坑）

- 模型导出**不再有密码门**（`verifyExportPassword()` 始终授权），访问控制靠部署/网络层。
- 仓库**不跟踪可再生的构建产物**：`extensions/tools/khy-markdown/vendor/` 与 `docs/_assets/mermaid.min.js`
  需按需重建（命令见上）。开发路径 fail-soft，发布路径硬失败。
- API key 存于 `~/.khyquant/config.json`（gitignore）；Token 用量数据仅存本地，绝不外传。
- 生产部署务必修改默认管理员密码（首次启动生成于 `.khy/credentials/default-admin.json`，
  可用 `KHY_ADMIN_PASSWORD` 环境变量覆盖）。
