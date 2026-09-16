---
name: Session 管理规范
id: AUTH-002
domain: SECURITY
nature: 约束
scope: "services/backend/src/routes/auth/**, services/backend/src/services/auth/**, services/ai-backend/**"
priority: P0
trigger: "新增或修改登录、刷新令牌、Session 生命周期逻辑时"
constraint: "ACCESS_TOKEN_EXPIRY = '15m'，REFRESH_TOKEN_EXPIRY = '7d'；JWT 用 RS256、issuer: 'khy-auth'、audience: 'khy-api'；必选字段 sub/iat/exp/jti，禁止字段 password/apiKey/secret 等敏感信息；MAX_CONCURRENT_SESSIONS = 5（超额淘汰最早，管理员无限但可审计）；refresh_token 存 httpOnly cookie，sameSite: 'strict'，secure: NODE_ENV === 'production'，path: '/api/v1/auth/refresh'；refresh_token SameSite=strict HttpOnly，session_id SameSite=lax HttpOnly；Token 轮换（每次刷新更换 Refresh Token 防重放）、Revocation（DB 标记 + 黑名单 jti cache）、IP 绑定、UA 变化降级确认。禁止：localStorage 存 Refresh Token（XSS 可窃取）、Access Token 有效期 > 30 分钟、Refresh Token 永不过期、URL 传 Token、JWT Secret 硬编码（必须走 env / secrets manager）。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: "令牌过期、算法、存储位置与轮换策略全部定量，审计只需核对常量而非推断意图。"
exception: 无
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/_规范/[DESIGN-AUTH-002] Session 管理规范.md"
formerly: 无
owner: security-team
---

# [AUTH-002] Session 管理规范

<!-- RULES-REGISTRY: AUTH-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/_规范/[DESIGN-AUTH-002] Session 管理规范.md。

## 约束

ACCESS_TOKEN_EXPIRY = '15m'，REFRESH_TOKEN_EXPIRY = '7d'；JWT 用 RS256、issuer: 'khy-auth'、audience: 'khy-api'；必选字段 sub/iat/exp/jti，禁止字段 password/apiKey/secret 等敏感信息；MAX_CONCURRENT_SESSIONS = 5（超额淘汰最早，管理员无限但可审计）；refresh_token 存 httpOnly cookie，sameSite: 'strict'，secure: NODE_ENV === 'production'，path: '/api/v1/auth/refresh'；refresh_token SameSite=strict HttpOnly，session_id SameSite=lax HttpOnly；Token 轮换（每次刷新更换 Refresh Token 防重放）、Revocation（DB 标记 + 黑名单 jti cache）、IP 绑定、UA 变化降级确认。禁止：localStorage 存 Refresh Token（XSS 可窃取）、Access Token 有效期 > 30 分钟、Refresh Token 永不过期、URL 传 Token、JWT Secret 硬编码（必须走 env / secrets manager）。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

令牌过期、算法、存储位置与轮换策略全部定量，审计只需核对常量而非推断意图。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

无

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
