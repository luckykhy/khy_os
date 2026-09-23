---
name: 决策只追加不改写
id: SOURCING-006
domain: SOURCING
nature: 约束为主
scope: "注册表 notes、设计文档、提案正文"
priority: P1
trigger: 修订任一既有架构决策或能力域实现时
constraint: "架构决策只能追加新决策，不得原地改写或删除旧决策；改已存在功能只走 canonical 扩展或三步迁移。"
grants: "见约束边界：授权以「追加新决策 + 标注替代关系」方式演进既有决策。"
benefit: 决策历史可完整回溯，不会用改措辞掩盖曾经的决定。
exception: 三步迁移的分步回滚由评审逐 PR 确认。
version: "1.0.0+ (2026-09-16)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md §4 B-U5、§5 B-L2/B-L3"
formerly: GOV-BORROW-006
owner: architecture-team
---

# [SOURCING-006] 决策只追加不改写

<!-- RULES-REGISTRY: SOURCING-006 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md §4 B-U5、§5 B-L2/B-L3。

## 约束

架构决策只能追加新决策，不得原地改写或删除旧决策；改已存在功能只走 canonical 扩展或三步迁移。

## 授予权力

见约束边界：授权以「追加新决策 + 标注替代关系」方式演进既有决策。

## 提供福利

决策历史可完整回溯，不会用改措辞掩盖曾经的决定。

## 反例

把既有决策措辞改掉以掩盖曾经的决定；以「旧实现有 bug」为由新开并行实现。

## 校验方式

`[DESIGN-SOURCING-001]` §4 B-U5、§5 B-L2/B-L3；`check:duplication` 挡新重复；迁移分步回滚由评审逐 PR 确认

## 例外

三步迁移的分步回滚由评审逐 PR 确认。

## 版本记录

- 1.0.0+ (2026-09-16) 初版 / 迁移自 GOV-BORROW-006
