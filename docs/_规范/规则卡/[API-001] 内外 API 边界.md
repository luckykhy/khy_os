---
name: 内外 API 边界
id: API-001
domain: API
nature: 约束为主
scope: services/backend 的全部 API surface（内部 adapter 与外部 REST/SSE/WS/兼容 API）
priority: P1
trigger: 把内部对象暴露为公开响应，或新增外部 API surface 时
constraint: "内部 adapter 结果与外部 REST/SSE/WS/兼容 API 必须明确边界；外部变更不得以内部对象形状作为隐式契约。"
grants: "见约束边界：授权在边界处显式映射字段（_responseBuilder），而非直接透传。"
benefit: "内部重构不必担心破坏外部契约；外部消费者不必理解内部对象结构。"
exception: "存量端点按 [DESIGN-API-002] §6 分阶段迁移。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/_规范/[DESIGN-API-002] 外部错误信封与版本弃用政策.md §1"
formerly: GOV-API-001
owner: backend-team
---

# [API-001] 内外 API 边界

<!-- RULES-REGISTRY: API-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/_规范/[DESIGN-API-002] 外部错误信封与版本弃用政策.md §1。

## 约束

内部 adapter 结果与外部 REST/SSE/WS/兼容 API 必须明确边界；外部变更不得以内部对象形状作为隐式契约。

## 授予权力

见约束边界：授权在边界处显式映射字段（_responseBuilder），而非直接透传。

## 提供福利

内部重构不必担心破坏外部契约；外部消费者不必理解内部对象结构。

## 反例

直接将 adapter attempts 原样作为公开响应。

## 校验方式

契约已冻结（UC-005 裁决）：`[DESIGN-API-002]` §1 内外边界红线；表面清单按该文 §6/§7 目录表逐步填实

## 例外

存量端点按 [DESIGN-API-002] §6 分阶段迁移。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-API-001
