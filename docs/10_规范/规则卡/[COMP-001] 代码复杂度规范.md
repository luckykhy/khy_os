---
name: 代码复杂度规范
id: COMP-001
domain: TOOLING
nature: 约束
scope: "services/backend/src/**, apps/ai-frontend/src/**, software/khyquant/frontend/src/**, platform/khy_platform/**"
priority: P2
trigger: "新增或修改函数、文件、嵌套结构时"
constraint: "圈复杂度：单函数 ≤10 通过、10-14 warning、15 error（PR 阻断）；函数长度：异步 ≤50 行、同步 ≤40 行、回调 ≤30 行，25-49 行为 warning；参数数量：≤3 通过、4-5 warning、6+ error；嵌套深度：≤2 通过、3-4 warning、5+ error；文件大小：JS 源文件 <400 行通过、400-600 warning、600+ error。行数 = 函数体 {} 之间的实际代码行，不含注释和空行。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: "四条量化阈值替代「函数太长了」的主观争论，门禁可自动判定且阈值可追溯。"
exception: "存量文件（3400+ 个文件）的复杂度超标不阻断合并；新增文件零违规，修改文件仅要求被修改的函数达标。"
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-COMP-001] 代码复杂度规范.md"
formerly: 无
owner: architecture-team
---

# [COMP-001] 代码复杂度规范

<!-- RULES-REGISTRY: COMP-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-COMP-001] 代码复杂度规范.md。

## 约束

圈复杂度：单函数 ≤10 通过、10-14 warning、15 error（PR 阻断）；函数长度：异步 ≤50 行、同步 ≤40 行、回调 ≤30 行，25-49 行为 warning；参数数量：≤3 通过、4-5 warning、6+ error；嵌套深度：≤2 通过、3-4 warning、5+ error；文件大小：JS 源文件 <400 行通过、400-600 warning、600+ error。行数 = 函数体 {} 之间的实际代码行，不含注释和空行。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

四条量化阈值替代「函数太长了」的主观争论，门禁可自动判定且阈值可追溯。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

存量文件（3400+ 个文件）的复杂度超标不阻断合并；新增文件零违规，修改文件仅要求被修改的函数达标。

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
