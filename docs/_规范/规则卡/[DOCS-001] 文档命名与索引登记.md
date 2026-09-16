---
name: 文档命名与索引登记
id: DOCS-001
domain: DOCS
nature: 约束为主，兼福利
scope: "docs/**（新增、移动、重命名、删除任一文档）"
priority: P1
trigger: "新增、移动、重命名或删除任一 docs/ 下文档时"
constraint: "业务文档必须带编号前缀 [<STAGE>-<TYPE>-NNN] 中文名.md，严禁裸名；每个 docs/ 子目录必须有排序首位的 00_INDEX_* 索引文件；新增/移动文档必须同步更新该目录 00_INDEX 与 docs/00_INDEX_文档索引.md 两处；编号删除不回收。"
grants: "见约束边界：授权依目录既有惯例自行选取下一个未占用编号。"
benefit: "命名、放置、登记三件事由一张表回答；编号不回收避免指代歧义。"
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/08_MGMT_项目管理/[MGMT-STD-007] 文档规则总纲.md R1-R7/§2/§4"
formerly: "[MGMT-STD-007] R1-R5"
owner: governance-team
---

# [DOCS-001] 文档命名与索引登记

<!-- RULES-REGISTRY: DOCS-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/08_MGMT_项目管理/[MGMT-STD-007] 文档规则总纲.md R1-R7/§2/§4。

## 约束

业务文档必须带编号前缀 [<STAGE>-<TYPE>-NNN] 中文名.md，严禁裸名；每个 docs/ 子目录必须有排序首位的 00_INDEX_* 索引文件；新增/移动文档必须同步更新该目录 00_INDEX 与 docs/00_INDEX_文档索引.md 两处；编号删除不回收。

## 授予权力

见约束边界：授权依目录既有惯例自行选取下一个未占用编号。

## 提供福利

命名、放置、登记三件事由一张表回答；编号不回收避免指代歧义。

## 反例

裸名文档（如 `BORROWINGS.md`、`SPLIT-PLAN.md`）；落文档不更新两级索引。

## 校验方式

`npm run check:layout` 的 `docs-index-first` / `docs-index-complete`；`npm run docs:verify`

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 [MGMT-STD-007] R1-R5
