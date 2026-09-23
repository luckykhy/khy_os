---
name: persistent 记录要素
id: MEMORY-002
domain: MEMORY
nature: 约束为主
scope: "长期记忆与 .ai 维护元数据"
priority: P1
trigger: 写入任一 persistent 记录时
constraint: "必须包含主体、来源、写入时间、适用范围与清理条件五要素；不得把凭据写入记录。"
grants: "见约束边界：授权按五要素模板自由组织记录正文。"
benefit: "任何记录都可溯源、可清理；凭据不会通过记忆通道泄露。"
exception: 无
version: "1.0.0+ (2026-09-16)"
status: active
ssot: "docs/10_规范/DESIGN-MEM/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md §2"
formerly: GOV-MEM-002
owner: backend-team
---

# [MEMORY-002] persistent 记录要素

<!-- RULES-REGISTRY: MEMORY-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-MEM/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md §2。

## 约束

必须包含主体、来源、写入时间、适用范围与清理条件五要素；不得把凭据写入记录。

## 授予权力

见约束边界：授权按五要素模板自由组织记录正文。

## 提供福利

任何记录都可溯源、可清理；凭据不会通过记忆通道泄露。

## 反例

无来源的自由文本长期记录。

## 校验方式

契约已冻结：`[DESIGN-MEM-006]` §2；机械守卫待工具化

## 例外

无

## 版本记录

- 1.0.0+ (2026-09-16) 初版 / 迁移自 GOV-MEM-002
