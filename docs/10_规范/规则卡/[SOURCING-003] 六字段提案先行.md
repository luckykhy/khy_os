---
name: 六字段提案先行
id: SOURCING-003
domain: SOURCING
nature: 约束为主，兼权力
scope: 新增工具/服务/命令/视图族/API 端点/协议消息/配置键
priority: P1
trigger: 开始编码任一新能力域之前
constraint: "新能力域必须先出六字段提案再编码；事后补写不得豁免。"
grants: 授权任何贡献者在六字段提案通过后开始编码，无需事前单独审批。
benefit: "「要不要做、参考谁、会不会重复」在动手前就已答清，避免返工。"
exception: 无
version: "1.0.0+ (2026-09-16)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md §3 B-P2/B-P2.1"
formerly: GOV-BORROW-003
owner: architecture-team
---

# [SOURCING-003] 六字段提案先行

<!-- RULES-REGISTRY: SOURCING-003 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md §3 B-P2/B-P2.1。

## 约束

新能力域必须先出六字段提案再编码；事后补写不得豁免。

## 授予权力

授权任何贡献者在六字段提案通过后开始编码，无需事前单独审批。

## 提供福利

「要不要做、参考谁、会不会重复」在动手前就已答清，避免返工。

## 反例

代码写完后在 PR 里补一句「参考了 X 项目」。

## 校验方式

`[DESIGN-SOURCING-001]` §3 B-P2/B-P2.1；人工评审（提案六字段齐全）

## 例外

无

## 版本记录

- 1.0.0+ (2026-09-16) 初版 / 迁移自 GOV-BORROW-003
