---
name: API 版本化与弃用政策
id: API-002
domain: API
nature: 约束为主，兼福利
scope: 外部 HTTP / SSE / WS / 兼容 API
priority: P1
trigger: 新增或变更任一公开 API 时
constraint: "必须登记版本、请求/响应字段、认证方式、错误码与迁移说明；破坏性变更需维护者裁决后发布，并保留兼容期 + removedIn。"
grants: "见约束边界：授权按五要素登记制自行发布新 API；破坏性变更授权申请维护者裁决。"
benefit: "消费方能提前获知变更并规划迁移；维护者有清晰的裁决入口，不必逐案临场判断。"
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/_规范/[DESIGN-API-002] 外部错误信封与版本弃用政策.md §4/§7"
formerly: GOV-API-002
owner: backend-team
---

# [API-002] API 版本化与弃用政策

<!-- RULES-REGISTRY: API-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/_规范/[DESIGN-API-002] 外部错误信封与版本弃用政策.md §4/§7。

## 约束

必须登记版本、请求/响应字段、认证方式、错误码与迁移说明；破坏性变更需维护者裁决后发布，并保留兼容期 + removedIn。

## 授予权力

见约束边界：授权按五要素登记制自行发布新 API；破坏性变更授权申请维护者裁决。

## 提供福利

消费方能提前获知变更并规划迁移；维护者有清晰的裁决入口，不必逐案临场判断。

## 反例

删除响应字段且无版本或迁移说明。

## 校验方式

契约已冻结：`[DESIGN-API-002]` §4 版本化 + 弃用政策 + 五要素登记制；API 目录真源为该文 §7

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-API-002
