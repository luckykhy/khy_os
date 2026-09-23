---
name: 最小权限与升级废弃
id: TOOLING-003
domain: TOOLING
nature: 约束为主，兼福利
scope: 工具与扩展及其 manifest 的 lifecycle 块
priority: P2
trigger: "新增工具/扩展，或升级、废弃已有工具时"
constraint: "新工具或扩展必须声明最小权限边界；升级与废弃必须保留兼容期、迁移说明与移除版本（removedIn），工具名弃用须走兼容期。"
grants: "见约束边界：授权按 lifecycle 块自行声明权限与迁移窗口。"
benefit: "使用者可提前规划迁移；工具作者有明确的兼容期模板可照抄。"
exception: 紧急安全撤回可跳过兼容期，但须在 CHANGELOG 与索引中记录。
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-TOOL-001] 工具与扩展升级废弃规范.md / docs/10_规范/其它规范/[DESIGN-TOOL-002] 拓展契约与核心边界规范.md"
formerly: GOV-TOOL-003
owner: backend-team
---

# [TOOLING-003] 最小权限与升级废弃

<!-- RULES-REGISTRY: TOOLING-003 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-TOOL-001] 工具与扩展升级废弃规范.md / docs/10_规范/其它规范/[DESIGN-TOOL-002] 拓展契约与核心边界规范.md。

## 约束

新工具或扩展必须声明最小权限边界；升级与废弃必须保留兼容期、迁移说明与移除版本（removedIn），工具名弃用须走兼容期。

## 授予权力

见约束边界：授权按 lifecycle 块自行声明权限与迁移窗口。

## 提供福利

使用者可提前规划迁移；工具作者有明确的兼容期模板可照抄。

## 反例

直接移除公开工具名且无迁移说明。

## 校验方式

契约已冻结：`[DESIGN-TOOL-001]`（manifest `lifecycle` 块、工具名弃用兼容期、版本策略、最小权限边界）；机械守卫待工具化

## 例外

紧急安全撤回可跳过兼容期，但须在 CHANGELOG 与索引中记录。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-TOOL-003
