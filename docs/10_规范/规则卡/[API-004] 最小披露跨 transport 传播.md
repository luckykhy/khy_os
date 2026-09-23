---
name: 最小披露跨 transport 传播
id: API-004
domain: API
nature: 约束为主
scope: "HTTP → gateway → ACP → SSE/WS 的 principal、trace、deadline/retry/fallback 摘要"
priority: P2
trigger: 请求跨越 transport 边界需要传递上下文时
constraint: "认证后的 principal、请求 trace、deadline/retry/fallback 摘要必须按发布的最小披露规则跨 transport 传播；禁止全量透传上游对象。"
grants: "见约束边界：授权按最小披露白名单选择传播字段。"
benefit: 全链路可关联排障，同时不把凭据或内部状态泄露给下游 transport。
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/DESIGN-API/[DESIGN-API-002] 外部错误信封与版本弃用政策.md §5 / [DESIGN-ACP-001] §2"
formerly: GOV-API-004
owner: backend-team
---

# [API-004] 最小披露跨 transport 传播

<!-- RULES-REGISTRY: API-004 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-API/[DESIGN-API-002] 外部错误信封与版本弃用政策.md §5 / [DESIGN-ACP-001] §2。

## 约束

认证后的 principal、请求 trace、deadline/retry/fallback 摘要必须按发布的最小披露规则跨 transport 传播；禁止全量透传上游对象。

## 授予权力

见约束边界：授权按最小披露白名单选择传播字段。

## 提供福利

全链路可关联排障，同时不把凭据或内部状态泄露给下游 transport。

## 反例

HTTP requestId 无法关联 gateway 尝试和 stream 事件。

## 校验方式

契约已冻结：`[DESIGN-API-002]` §5 最小披露白名单 + `[DESIGN-ACP-001]` §2 `traceId` 全链路传播

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-API-004
