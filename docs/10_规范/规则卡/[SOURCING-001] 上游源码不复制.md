---
name: 上游源码不复制
id: SOURCING-001
domain: SOURCING
nature: 约束为主
scope: "services/**, apps/**, platform/**, software/**, kernel/**, tools/**, scripts/**"
priority: P0
trigger: 从外部项目引入任一源码文件时
constraint: "上游源码文件不得复制进 khyos 源码目录；唯一例外是 vendored 档且六条件全过。"
grants: "见约束边界：授权走 vendored 档引入（须六条件全过 + 许可证可复核）。"
benefit: "借鉴可以「学而不抄」，不必担心上游许可证或归属纠纷。"
exception: vendored 档六条件全过为唯一例外。
version: "1.0.0+ (2026-09-16)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md §1 B-S3"
formerly: GOV-BORROW-001
owner: architecture-team
---

# [SOURCING-001] 上游源码不复制

<!-- RULES-REGISTRY: SOURCING-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md §1 B-S3。

## 约束

上游源码文件不得复制进 khyos 源码目录；唯一例外是 vendored 档且六条件全过。

## 授予权力

见约束边界：授权走 vendored 档引入（须六条件全过 + 许可证可复核）。

## 提供福利

借鉴可以「学而不抄」，不必担心上游许可证或归属纠纷。

## 反例

把上游 `src/` 目录整体拷进本仓再改命名。

## 校验方式

`[DESIGN-SOURCING-001]` §1 B-S3；人工评审 + `check:duplication` 的克隆类信号

## 例外

vendored 档六条件全过为唯一例外。

## 版本记录

- 1.0.0+ (2026-09-16) 初版 / 迁移自 GOV-BORROW-001
