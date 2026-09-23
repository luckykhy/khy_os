---
name: 实现唯一性与四步检索
id: SOURCING-005
domain: SOURCING
nature: 约束为主，兼福利
scope: "新增实现、重命名、换实现范式"
priority: P1
trigger: 写任何新实现之前
constraint: "同一功能只允许一个公开名称与一个实现层；写新代码前必须完成四步检索并留下检索结论。"
grants: "见约束边界：授权按四步检索模板自行查重，结论留档即可放行。"
benefit: "不必担心造出并行近似副本；四步模板给出明确的查重路径。"
exception: 命名分歧由维护者一次裁决。
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md §4 B-U2/B-U4 / npm run check:duplication"
formerly: GOV-BORROW-005
owner: architecture-team
---

# [SOURCING-005] 实现唯一性与四步检索

<!-- RULES-REGISTRY: SOURCING-005 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md §4 B-U2/B-U4 / npm run check:duplication。

## 约束

同一功能只允许一个公开名称与一个实现层；写新代码前必须完成四步检索并留下检索结论。

## 授予权力

见约束边界：授权按四步检索模板自行查重，结论留档即可放行。

## 提供福利

不必担心造出并行近似副本；四步模板给出明确的查重路径。

## 反例

已存在 `aiGateway` 又新增 `gatewayClient` 并行入口。

## 校验方式

`[DESIGN-SOURCING-001]` §4 B-U2/B-U4；`check:layout` 的 `layer-registry` 判层级错放；命名分歧交维护者一次裁决

## 例外

命名分歧由维护者一次裁决。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-BORROW-005
