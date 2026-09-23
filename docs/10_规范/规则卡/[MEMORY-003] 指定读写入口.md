---
name: 指定读写入口
id: MEMORY-003
domain: MEMORY
nature: 约束为主
scope: "记忆持久化模块（未来）与 .ai 三件套"
priority: P1
trigger: 代码需要读写记忆或维护元数据时
constraint: "不得绕过被指定的记忆读写入口直接写存储；入口、格式与清理职责必须在实现前登记（.ai/ 走 khy metadata，上下文走 ACP context.share）。"
grants: "见约束边界：授权经指定入口读写，入口清单可查。"
benefit: "新增存储通道不会绕过审计与清理策略；排查时只需看一个入口。"
exception: 无
version: "1.0.0+ (2026-09-16)"
status: active
ssot: "docs/10_规范/DESIGN-MEM/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md §3"
formerly: GOV-MEM-003
owner: backend-team
---

# [MEMORY-003] 指定读写入口

<!-- RULES-REGISTRY: MEMORY-003 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-MEM/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md §3。

## 约束

不得绕过被指定的记忆读写入口直接写存储；入口、格式与清理职责必须在实现前登记（.ai/ 走 khy metadata，上下文走 ACP context.share）。

## 授予权力

见约束边界：授权经指定入口读写，入口清单可查。

## 提供福利

新增存储通道不会绕过审计与清理策略；排查时只需看一个入口。

## 反例

路由层直接写入持久化记忆文件。

## 校验方式

指定入口已登记：`[DESIGN-MEM-006]` §3（`.ai/` 走 `khy metadata`，上下文走 ACP `context.share`）；守卫待工具化

## 例外

无

## 版本记录

- 1.0.0+ (2026-09-16) 初版 / 迁移自 GOV-MEM-003
