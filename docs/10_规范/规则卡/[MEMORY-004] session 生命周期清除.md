---
name: session 生命周期清除
id: MEMORY-004
domain: MEMORY
nature: 约束为主
scope: "session 缓存、队列、临时日志"
priority: P1
trigger: "会话结束、过期或主体删除时"
constraint: "session 数据必须按登记生命周期清除或归档，不得静默转为 persistent；进程重启后临时上下文不得留作长期事实。"
grants: "见约束边界：授权按登记的生命周期策略自行清除或归档。"
benefit: 临时上下文不会悄悄变成永久事实，避免记忆污染。
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/DESIGN-MEM/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md §4"
formerly: GOV-MEM-004
owner: backend-team
---

# [MEMORY-004] session 生命周期清除

<!-- RULES-REGISTRY: MEMORY-004 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-MEM/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md §4。

## 约束

session 数据必须按登记生命周期清除或归档，不得静默转为 persistent；进程重启后临时上下文不得留作长期事实。

## 授予权力

见约束边界：授权按登记的生命周期策略自行清除或归档。

## 提供福利

临时上下文不会悄悄变成永久事实，避免记忆污染。

## 反例

进程重启后把临时上下文留作长期事实。

## 校验方式

契约已冻结：`[DESIGN-MEM-006]` §4；生命周期策略随该文裁决，守卫待工具化

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-MEM-004
