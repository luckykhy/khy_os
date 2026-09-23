---
name: 能力域归属登记
id: SOURCING-004
domain: SOURCING
nature: 约束为主
scope: "能力域注册表与 PR 裁决（docs/10_规范/registry/FEATURE-OWNERSHIP.json）"
priority: P1
trigger: 新增或变更任一能力域实现时
constraint: "每个能力域必须登记唯一 canonical；vendored/fork 档的批准人不得是作者本人。"
grants: "见约束边界：授权维护者担任批准人，作者不得自批。"
benefit: "同一能力不会长出多个并行实现；归属可查，责任可追。"
exception: "forbidden 路径仍存在的属已登记存量重复（ai-gateway / token-usage 的 notes 已写明三步迁移动因），按 warning 记入棘轮；登记表  自称守卫待建，check-feature-ownership.js 已补齐。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md §3"
formerly: GOV-BORROW-004
owner: architecture-team
enforcement: "docs/10_规范/registry/FEATURE-OWNERSHIP.json"
---

# [SOURCING-004] 能力域归属登记

<!-- RULES-REGISTRY: SOURCING-004 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md §3。

## 约束

每个能力域必须登记唯一 canonical；vendored/fork 档的批准人不得是作者本人。

## 授予权力

见约束边界：授权维护者担任批准人，作者不得自批。

## 提供福利

同一能力不会长出多个并行实现；归属可查，责任可追。

## 反例

两个服务各实现一份「多供应商 AI 调用」，无人登记。

## 校验方式

现有 `check:duplication`；`check:feature-ownership` 待建（104 §6 B-G1/B-G2）；裁决留痕由 `check:gov-rules` 覆盖入口接线

## 例外

forbidden 路径仍存在的属已登记存量重复（ai-gateway / token-usage 的 notes 已写明三步迁移动因），按 warning 记入棘轮；登记表  自称守卫待建，check-feature-ownership.js 已补齐。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-BORROW-004
