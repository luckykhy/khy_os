---
name: CORS 跨域资源共享规范
id: CORS-001
domain: API
nature: 约束
scope: "services/backend/src/**, services/ai-backend/**"
priority: P0
trigger: 配置或修改跨域中间件时
constraint: "四原则：最小权限（只允许必要的来源/方法/请求头）、严格 SameSite（认证相关 Cookie 用 strict 或 lax）、预检缓存（Access-Control-Max-Age: 86400，24 小时）、凭证隔离（credentials: true 时不允许通配符 origin）。配置：app.options('*', cors({ origin: getCorsOrigin(), methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], credentials: true, maxAge: 86400 }))。credentials: true 时 origin 必须是明确域名，origin: '*' + credentials: true 被浏览器拒绝（CORS 协议禁止此组合）。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: "把浏览器会直接拒绝的非法组合（通配符 + 凭证）在提交前拦住，避免线上才发现跨域不通。"
exception: 无
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-CORS-001] CORS 跨域资源共享规范.md"
formerly: 无
owner: security-team
---

# [CORS-001] CORS 跨域资源共享规范

<!-- RULES-REGISTRY: CORS-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-CORS-001] CORS 跨域资源共享规范.md。

## 约束

四原则：最小权限（只允许必要的来源/方法/请求头）、严格 SameSite（认证相关 Cookie 用 strict 或 lax）、预检缓存（Access-Control-Max-Age: 86400，24 小时）、凭证隔离（credentials: true 时不允许通配符 origin）。配置：app.options('*', cors({ origin: getCorsOrigin(), methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], credentials: true, maxAge: 86400 }))。credentials: true 时 origin 必须是明确域名，origin: '*' + credentials: true 被浏览器拒绝（CORS 协议禁止此组合）。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

把浏览器会直接拒绝的非法组合（通配符 + 凭证）在提交前拦住，避免线上才发现跨域不通。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

无

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
