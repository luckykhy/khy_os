---
name: 通知与邮件规范
id: NOTIFY-001
domain: API
nature: 约束
scope: "services/backend/src/services/notifications/**, services/backend/src/routes/notifications/**"
priority: P2
trigger: "新增或修改邮件、Webhook、站内通知投递逻辑时"
constraint: "邮件投递保障：超时 10 秒、重试 3 次（指数退避 1s/2s/4s）、最终失败退入 DLQ、批量限制 100/分钟（防被邮件服务商限流）。必须提供 List-Unsubscribe 头（同时给 URL 与 mailto: 形式）。Webhook 签名验证用 crypto.createHmac('sha256', secret).update(payload).digest('hex') 配合 crypto.timingSafeEqual 防时序攻击。Webhook 重试：5 次，间隔 1m/5m/30m/2h/6h，超时 10s，User-Agent Khy-Webhook/1.0；连续 5 次失败暂停 webhook 并通知用户，4xx 不重试（配置错误需人工处理），5xx/超时按退避重试。审计：投递记录保留 180 天，安全通知必须记录不可删除，投递失败超过 3 次触发告警。优先级：系统通知 P1、安全通知 P0、任务通知 P2、营销通知 P3、Webhook P2。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: 投递失败有确定重试上限与死信路径，安全通知不可退订，合规要求（List-Unsubscribe）不遗漏。
exception: 4xx 错误不重试（配置错误需人工处理）。
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/_规范/[DESIGN-NOTIFY-001] 通知与邮件规范.md"
formerly: 无
owner: ops-team
---

# [NOTIFY-001] 通知与邮件规范

<!-- RULES-REGISTRY: NOTIFY-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/_规范/[DESIGN-NOTIFY-001] 通知与邮件规范.md。

## 约束

邮件投递保障：超时 10 秒、重试 3 次（指数退避 1s/2s/4s）、最终失败退入 DLQ、批量限制 100/分钟（防被邮件服务商限流）。必须提供 List-Unsubscribe 头（同时给 URL 与 mailto: 形式）。Webhook 签名验证用 crypto.createHmac('sha256', secret).update(payload).digest('hex') 配合 crypto.timingSafeEqual 防时序攻击。Webhook 重试：5 次，间隔 1m/5m/30m/2h/6h，超时 10s，User-Agent Khy-Webhook/1.0；连续 5 次失败暂停 webhook 并通知用户，4xx 不重试（配置错误需人工处理），5xx/超时按退避重试。审计：投递记录保留 180 天，安全通知必须记录不可删除，投递失败超过 3 次触发告警。优先级：系统通知 P1、安全通知 P0、任务通知 P2、营销通知 P3、Webhook P2。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

投递失败有确定重试上限与死信路径，安全通知不可退订，合规要求（List-Unsubscribe）不遗漏。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

4xx 错误不重试（配置错误需人工处理）。

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
