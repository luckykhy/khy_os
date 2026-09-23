---
name: 规则登记表与真源双向可达
id: TOOLING-007
domain: TOOLING
nature: 约束为主，兼福利
scope: "docs/10_规范/registry/RULES-REGISTRY.json 及每条规则 ssot 指向的全部真源文件（含代码真源）"
priority: P1
trigger: 新增 / 修订 / 废弃任何登记规则，或移动 / 删除其真源文件时
constraint: "登记表的语义真源（ssot 首个目标）必须在其文件内以 RULES-REGISTRY 标记行声明所承载的规则 ID（Markdown 用 HTML 注释、代码用行注释）；标记行中出现的 ID 必须已登记（禁孤儿标记）；enforcement 列出的执行/常量真源路径必须存在；真源文件不得被删除而不先改登记表。"
grants: 见约束边界
benefit: "登记表与真源互为索引：从任一条规则可一步定位到原文，从任一份真源文件可一步定位到规则 ID，无需人工 grep 排查；新增规则漏标即被守卫当场拦截。"
exception: "纯证据性引用（如复盘文档 [IMPL-RPT-015]）不计入标记义务；登记表自身（RULES-REGISTRY.json）作为 JSON 文件不内嵌标记，其语义真源为 GOV-TOOL-006 条款。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md"
formerly: 无
owner: governance-team
enforcement: "scripts/ci/check-rules-registry.js"
---

# [TOOLING-007] 规则登记表与真源双向可达

<!-- RULES-REGISTRY: TOOLING-007 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md。

## 约束

登记表的语义真源（ssot 首个目标）必须在其文件内以 RULES-REGISTRY 标记行声明所承载的规则 ID（Markdown 用 HTML 注释、代码用行注释）；标记行中出现的 ID 必须已登记（禁孤儿标记）；enforcement 列出的执行/常量真源路径必须存在；真源文件不得被删除而不先改登记表。

## 授予权力

见约束边界

## 提供福利

登记表与真源互为索引：从任一条规则可一步定位到原文，从任一份真源文件可一步定位到规则 ID，无需人工 grep 排查；新增规则漏标即被守卫当场拦截。

## 反例

登记表改了 ID 但真源文档未标 ID（反向查不到）；真源标了未登记的 `RULES-REGISTRY: X-999`。

## 校验方式

`node scripts/ci/check-rules-registry.js`（根入口 `check:rules`，已纳入 `check:structure` 与 PR gate）

## 例外

纯证据性引用（如复盘文档 [IMPL-RPT-015]）不计入标记义务；登记表自身（RULES-REGISTRY.json）作为 JSON 文件不内嵌标记，其语义真源为 GOV-TOOL-006 条款。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 无
