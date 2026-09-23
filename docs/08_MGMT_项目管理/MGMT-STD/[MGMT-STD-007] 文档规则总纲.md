# [MGMT-STD-007] 文档规则总纲 — 命名·放置·登记·生命周期

<!-- RULES-REGISTRY: DOCS-001 -->


> **定位**：本文是 khy-os 文档体系的**单一真源**，收拢散落在 `[MGMT-STD-001]`（索引铁律）、`[DESIGN-DOC-001]`（结构规范）、`[DESIGN-LAY-005]`（仓库层级）中的全部文档规则，并新增「登记」与「生命周期」两章。
> 任何新增、移动、重命名、删除文档的操作，**动手前必须读本文**。

---

## 1. 红线（必须/禁止，可判定）

| # | 红线 | 判定方式 |
|---|------|----------|
| R1 | 根目录**只允许** `README.md` + 封闭白名单（`AGENTS.md`/`CLAUDE.md`/`CHANGELOG.md`/`CONTRIBUTING.md`/`SECURITY.md`/`LICENSE` 等）；其余说明性 `.md` 一律归入 `docs/` | `check:layout` 的 `root-whitelist` 规则 |
| R2 | `docs/` 每个子目录**必须**有排序首位的 `00_INDEX_*` 索引文件；无索引的子目录不得存放业务文档 | `check:layout` 的 `docs-index-first` 规则 |
| R3 | 每篇业务文档必须带编号前缀 `[<STAGE>-<TYPE>-NNN] 中文名.md`；**严禁**裸名（如 `BORROWINGS.md`、`SPLIT-PLAN.md`） | `check:layout` 的 `docs-index-complete` + 人工评审 |
| R4 | 新增/移动/重命名文档后，**必须**同步更新该目录 `00_INDEX` 与 `docs/00_INDEX_文档索引.md` 的两处登记；只落文档不更新索引 = 违规 | `check:layout` 的 `docs-index-complete`（漏链即亮红灯） |
| R5 | 编号删除后**不回收**；断档保留原样（如 `IMPL-RPT` 034–039 为空） | 人工评审 |
| R6 | HTML 孪生件（`.html`）是 `npm run docs:build` 的**构建产物**，不是手工维护文件；禁止手改 `.html`，只改源 `.md` | `check:build-artifacts` 规则 |
| R7 | 文档内容遵循三段式骨架（红线/反例→正例/校验/版本历史），全文 ≤ 150 行；超出拆子篇 | `[DESIGN-DOC-001]` §12 规范骨架 |

## 2. 命名规则

### 2.1 编号轴（STAGE）

`docs/` 顶层按生命周期阶段分目录，目录名 = `NN_STAGE_中文名/`：

| 目录 | 编号前缀 | 收什么 |
|------|----------|--------|
| `01_INIT_立项/` | `INIT-` | 项目定位、PRD |
| `02_CONCEPTS_概念入门/` | 无编号 | 小白向概念（Agent/Tool/MCP/RAG…） |
| `03_DESIGN_设计/` | `DESIGN-ARCH-` / `DESIGN-PERF-` / `DESIGN-SIZE-` / `DESIGN-OTHER-` / `DESIGN-RESEARCH` / `DESIGN-PHILOSOPHY` 等 | 架构设计、调研、方案 |
| `04_IMPL_实现/` | `IMPL-RPT-` / `IMPL-DOC-` / `IMPL-MIG-` | 实现记录、修复时间线 |
| `05_TEST_测试/` | `TEST-RPT-` | 测试报告 |
| `06_DEPLOY_部署/` | `DEPLOY-MAN-` | 部署、发布、安装 |
| `07_OPS_运维/` | `OPS-MAN-` | 运维手册、快速开始、配置 |
| `08_MGMT_项目管理/` | `MGMT-STD-` / `MGMT-PLAN-` / `MGMT-RPT-` / `MGMT-OTHER-` | 治理标准、计划、对标报告、杂项 |
| `09_STORY_修仙学AI/` | 无编号 | 故事化教材 |

### 2.2 类型轴（TYPE）

各阶段目录内的文档类型码：

| 阶段 | 类型码 | 含义 |
|------|--------|------|
| MGMT | `STD` | 工程治理标准（红线、方法论） |
| MGMT | `PLAN` | 计划/路线图/拆分方案 |
| MGMT | `RPT` | 对标/调研/诊断/报告 |
| MGMT | `OTHER` | 杂项（事后分析、环境还原等） |
| DESIGN | `ARCH` | 架构设计（001–094 + CPA 等未编号件） |
| DESIGN | `PERF` / `SIZE` | 性能/体积方案 |
| DESIGN | `OTHER` / `RESEARCH` / `LEGISLATION` / `PHILOSOPHY` / `QUICK-REF` | 杂项调研 |
| IMPL | `RPT` | 实现记录 |
| IMPL | `DOC` / `MIG` | 文档/迁移指南 |

### 2.3 编号分配

- 序号 3 位数字（`001`–`999`）
- 由 AI 感知目录既有文件序列，取**下一个未占用**的编号
- 删除的编号**不回收**（R5）
- 同编号冲突 → 保留先创建者，新文档取新编号

### 2.4 完整文件名格式

```
[<STAGE>-<TYPE>-NNN] 中文标题.md
```

示例：
```
[MGMT-RPT-022] 借鉴项目清单.md
[MGMT-PLAN-008] replSession与toolUseLoopCore拆分分批计划.md
[DESIGN-ARCH-094] Provider卡片枢纽（CardHub）GUI设计规范.md
```

## 3. 放置规则（该放哪里）

| 文档内容 | 放哪 | 理由 |
|----------|------|------|
| 项目级治理标准 | `docs/08_MGMT_项目管理/` | 跨阶段约束 |
| 架构设计方案 | `docs/03_DESIGN_设计/` | 设计血缘 |
| 某次实现/修复记录 | `docs/04_IMPL_实现/` | 实现落地 |
| 测试报告 | `docs/05_TEST_测试/` | 验证 |
| 部署/发布操作手册 | `docs/06_DEPLOY_部署/` | 交付 |
| 运维配置指南 | `docs/07_OPS_运维/` | 运行 |
| 规范族（独立编号跨阶段约束） | `docs/10_规范/` | 编号 ≥ 10 = 跨阶段资产 |
| 子项目专属文档 | 子项目目录内（如 `apps/khyos-desktop/docs/`） | 就近原则 |
| 根目录说明 | **禁止** | R1 |

**判断口诀**：先看「管什么阶段的生命周期」→ 选 01–09；再看「是约束还是记录」→ 约束去 `10_规范/`、记录去对应阶段目录。

## 4. 登记规则（CP-3 细化）

每新增/移动/重命名一篇文档，**必须**同时：

1. **更新该目录 `00_INDEX_*.md`**：在文件清单表中加/改对应行
2. **更新 `docs/00_INDEX_文档索引.md`**：在对应阶段分区加一行链接（或归入「补登记」块）
3. **重命名时**：全局搜索旧文件名，改写所有入站引用（`.md` 内链接 + CI 脚本 + `.ai/` 文件）

漏第 2 步 → `docs-index-complete` 亮红灯；漏第 3 步 → 死链。

## 5. 生命周期

| 事件 | 操作 |
|------|------|
| **新建** | 取下一编号 → 写 `.md` → 更新两级索引 |
| **移动** | 重命名（编号保留）→ 更新旧目录索引（删行）+ 新目录索引（加行）+ 主索引（改路径） |
| **重命名** | 同上 + 全局替换入站引用 |
| **归档** | 移入 `_archive_已删除孤儿引擎/`（03 内）或本目录 `18_归档/`，主索引标注「已归档」 |
| **删除** | 编号不回收；主索引标注「已删除（编号保留）」 |
| **HTML 重建** | `npm run docs:build`（全量）或 `npm run docs:mermaid`（仅图表引擎） |

## 6. 索引文件三段式模板（MGMT-STD-001 第三章的速查版）

每个 `00_INDEX_*.md` **必须**包含且仅包含三段：

```markdown
# 00_INDEX <分类名>

> **索引总领文件** · 本目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章

## 一、分类内容边界
（一段话：收什么、不收什么）

## 二、文件清单
| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [XXX-NNN] 标题.md | ... | 草稿/定稿 |

## 三、跨分类关联指引
（指明相关其他 docs/ 子目录及其入口）
```

## 7. 校验工具速查

| 命令 | 检查什么 |
|------|----------|
| `npm run check:layout` | 顶层层级、`docs-index-complete`、`root-whitelist`、`docs-index-first` |
| `npm run docs:build` | 全量重建 HTML 孪生件 + nav-data.js |
| `npm run docs:verify` | HTML 完整性 + 本地链接死链 |
| `npm run docs:lint` | 文档站 widget 语法 |

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-12 | 初始版本：收拢 MGMT-STD-001 + DESIGN-DOC-001 + DESIGN-LAY-005 §3 的文档规则为单一真源；新增登记与生命周期两章 |
