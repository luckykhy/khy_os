# [DESIGN-DOC-003] README 内容规范

<!-- RULES-REGISTRY: DOCS-004 -->

> **定位**：管仓库内一切 `README.md` 及其语言变体**写什么内容**。
> 与 `[DESIGN-DOC-002]`（AI 指令文件标准，管 `AGENTS.md`/`CLAUDE.md`/`khy.md` 一族）**互斥**，
> 两族无重叠管辖；README 的**位置**归 `check-repo-layout.js` 的 `ROOT_DOC_WHITELIST` /
> `README_VARIANT_RE`，`docs/**` 内 README 的**命名**归 `DOCS-001`。
> 实测证据、公理、判据论证与落地设计见 `[IMPL-DOC-002]`。
>
> **【scope 边界 2026-09-17，DOCS 域四篇分工】** 文档规则族按 scope 分层、互不覆盖
> （依据元规则 `[MGMT-STD-008]` §2.2「重叠即违规」）：
>
> | 文档 | 管什么 |
> | --- | --- |
> | `[MGMT-STD-007] 文档规则总纲` | 命名 / 放置 / 登记 / 生命周期（总纲） |
> | `[DESIGN-DOC-001] 文档结构规范` | `.md` 的结构（§12 骨架）+ 中文排版（§13，唯一真源） |
> | `[DESIGN-DOC-002] AI 指令文件标准` | `AGENTS.md`/`CLAUDE.md`/`khy.md` 一族 |
> | **本篇** | **`README.md` 一族**，与 `DOC-002` **互斥**，两族无重叠管辖 |
>
> **结论**：① **README 不得成为第二真源** —— 端口、版本、命令全集、目录树等一律给指针不给副本；
> ② **每条命令必须在写作时实际可执行**；③ 必答内容按档位递减（T0 七问 / T1 五问 / T2 三问），
> **必备项是下限，不是上限**。

---

## 1. 红线

### 1.1 全域禁项（不分档位，本文核心）

| 正文禁止出现 | 只能给指针，真源是 |
|---|---|
| 端口 / IP / 域名 / URL 字面量 | `constants/serviceDefaults.js`（`RUNTIME-001` 单一真源） |
| 引擎与运行时版本阈值 | 各 `package.json` 的 `engines`、`pyproject.toml` 的 `requires-python` |
| 版本号字面量 | 三条版本轨道的 9 个 manifest（`check-version-sync.js`） |
| 版本同步的源清单 | `check-version-sync.js` 的 `VERSION_GROUPS`（代码即真源） |
| 命令全集 | `khy --help`、`[OPS-MAN-174]` 任务入口总表、就近 `package.json` |
| 完整目录树 | `[DESIGN-LAY-005]` + `npm run check:layout` |
| 规则正文 | `RULES-REGISTRY.json` + 各规则 `ssot`（正文只给规则 ID 与指针） |
| 变更历史 | `CHANGELOG.md` |
| 进度 / TODO / 临时说明 | 任务板、`tests/DEBT.md` |

### 1.2 指针标识 ≠ 事实副本

判据：写**标识**合法，写**值**违规 —— `AI_FRONTEND_PORT` ✅ / `:8090` ❌；
`npm run test:backend` ✅（须真实存在）/ 列出全部脚本 ❌。

**引用代码时给符号名，不给行号**：`serviceDefaults.js` 的 `BACKEND_PORT` ✅ /
`serviceDefaults.js:89` ❌。行号是最易漂移的副本 —— 任何一次在文件前部的插入都会
让全文引用集体失准，而符号名不会。**同理适用于其他一切「位置型」引用**：
不写「第 N 节」「第 N 行」，写小节标题或符号名。

**三类例外**（必须可机械识别）：
① 落在 `❌`/`✅` 对照块，或紧邻标题含「示例 / Example / 示意 / e.g.」的语境；
② 徽章 URL（**只允许外部服务实时取值**，如 PyPI/npm 版本、CI 覆盖率；手写数字徽章违规）；
③ 指向真源的变量名 / 脚本名 / 规则 ID / 文档编号。

### 1.3 档位判据（机械可判）

`T0` = 仓库根；`T1` = 所在目录存在 `package.json` / `pyproject.toml` / `Makefile` /
`Cargo.toml` 之一（即可独立构建或启动的单元）；`T2` = 其余（含 `docs/**`，其命名另归 `DOCS-001`）。

### 1.4 必答清单

**T0 仓库入口（`README.md`）—— 必答 7 问**

| # | 必答 | 怎样算答了 |
|---|------|-----------|
| Q1 | 这是什么 | 一句话定位 + **不是什么**（边界） |
| Q2 | 凭什么用它 | 3–5 条能力，每条一句话，不堆形容词 |
| Q3 | 怎么装 | 每个分发渠道一条**可复制**命令 |
| Q4 | 装完第一步 | 一条命令 + 读者会看到什么 |
| Q5 | 源码怎么跑 | 环境要求 + 依赖安装 + 启动；版本阈值给真源指针 |
| Q6 | 东西放在哪 | 配置 / 数据位置；目录结构给指针，不抄树 |
| Q7 | 去哪看更多 / 参与 / 许可 | 文档索引、贡献指南、许可各一条指针 |

**T1 部署单元 —— 必答 5 问**：职责与边界 / 依赖谁与被谁用 / 本地怎么起（端口给环境变量名）/
怎么测（一条命令）/ 真源指针（配置、契约、上层规范）。

**T2 内部模块 —— 必答 3 问**：这个目录里有什么（**全域唯一允许的清单** —— 它描述目录自身，
不会与外部真源漂移）/ 怎么跑它的校验或测试 / 与上级单元的关系。

### 1.5 首屏、台账与孪生件

- **首屏**（首个 H2 之前 + 第一个 H2 节）必须答完「这是什么 + 怎么跑」；徽章墙、目录树、长表不得占据首屏。
- README **不承载**进度、TODO、临时说明。
- **孪生件必须成对**：有 `.md` 必须有同名 `.html`（由 LAY-5 / `scripts/docs/verify_docs_site.js` 硬门）；
  **有 `.html` 不得无源**（孤儿孪生属违规）；`.html` 由 `npm run docs:build` 生成，**禁止手改**。
- 文件名须匹配 `check-repo-layout.js` 的 `README_VARIANT_RE`。

---

## 2. 反例 → 正例

| # | ❌ 反例 | ✅ 正例 | 判据 |
|---|--------|--------|------|
| 1 | `后端 API http://localhost:5000` | `后端 API 端口由 `PORT` 决定，真源 `constants/serviceDefaults.js`` | 1.1 端口 |
| 2 | `Node.js ≥ 20` | `Node.js ≥ 20.18.1（见 `services/backend` 的 `engines`）` | 1.1 版本阈值 |
| 3 | `run.ps1` 等价于 `npm run dev` | `run.ps1 -Command dev -Workspace apps/ai-frontend` | 1.1 命令全集 |
| 4 | 贴出整棵顶层目录树 | 指向 `[DESIGN-LAY-005]`，由 `npm run check:layout` 强制 | 1.1 目录树 |
| 5 | 「版本需同步三处真源」 | 「版本一致性由 `check-version-sync.js` 强制，源清单见其 `VERSION_GROUPS`」 | 1.1 源清单 |
| 6 | 「本次重构已完成 80%，待办…」 | 删除；进度写任务板，变更写 `CHANGELOG.md` | 1.5 台账 |
| 7 | `README-联调.md` | `README.zh-CN.md`，或并入上级 README | 1.5 命名 |
| 8 | `apps/khy-mobile/README.html`（有 html 无 md） | 补同名 `.md`，或删除孤儿 `.html` | 1.5 孪生件 |
| 9 | T2 模块 README 只写标题一行 | 至少答 Q1/Q2/Q3 三问 | 1.4 T2 |
| 10 | 首屏只有徽章墙 + 长目录树 | 首屏先给「是什么 + 怎么跑」 | 1.5 首屏 |
| 11 | 手写 `v1.1.15` 徽章 | 用 shields.io 的 `pypi/v/khy-os`（实时取值） | 1.2 例外② |

> 反向对照（**证明不是无脑拦**）：T2 README 写到 200 行 ✅（下限非上限）；
> `❌ :3000 / ✅ 由 PORT 决定` 对照块 ✅；`khy gateway status`（真实子命令）✅；
> 引擎版本写成 `engines` 指针 ✅。

---

## 3. 校验（守卫）

| 项 | 现状 |
|---|---|
| 自动执行器 | **本期无**。规则 `DOCS-004` 的 `gate` = `manual`，执行强度为**人工评审**（诚实登记，不伪造门） |
| 人工评审清单 | 8 项：禁项（1.1）/ 命令可达 / 路径可达 / 档位节齐备 / 首屏 / 台账污染 / 命名与孪生 / 指针有效性。逐条判据见 `[IMPL-DOC-002]` §5 |
| 已有的相邻守卫 | LAY-5 孪生：`scripts/docs/verify_docs_site.js`（硬门）· 根目录白名单与命名：`scripts/ci/check-repo-layout.js`（`DOCS-001`） |
| 机械化子集 | **可复用** `check-agent-docs.js` 的 D3a/D3b/D3d 判据（`npm run` / `khy` 子命令 / 路径可达性），不另写一套。执行器 `scripts/ci/check-readme.js` 的接线清单（含 `check-wiring.js` 的零接线会判 error、P2 棘轮基线、规则卡重生成）见 `[IMPL-DOC-002]` §6 |
| 复现核对方式 | 见 `[IMPL-DOC-002]` §5 |

> **为什么本期不建执行器**：判据先于执行器 —— 执行器若把错误判据写死，会重演
> `[DESIGN-DOC-002]` §1.1 的循环论证（拿守卫自己的输出当实测证据）。故先登记判据、
> 标为人工评审，验证有效后再机械化。

---

## 4. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-17 | 初版。登记为规则 `DOCS-004`（P2 / `gate=manual`）；确定全域禁项表、指针标识判据、T0/T1/T2 档位与必答清单；§1.2 补「引用代码给符号名、不给行号」（编写过程中 `check-repo-layout.js` 行号被并发改动而当场失准，见 `[IMPL-DOC-002]` §1.3 教训）；实测证据与落地设计移入 `[IMPL-DOC-002]` |
