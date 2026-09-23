---
name: AI 模型降级与熔断规范
id: GW-002
domain: API
nature: 约束
scope: "services/backend/src/services/gateway/**"
priority: P1
trigger: "新增或修改 AI 适配器调用、降级链、熔断逻辑时"
constraint: "四原则：可用性优先、成本可控、透明告知（前端显示「正在使用备选模型」）、可配置。降级链：P0 主力模型 → 超时/错误率超阈值 → P1 备选 → 同样失败 → P2 兜底 → 全部不可用 → P3 规则回复（非 AI，保证服务可用）。熔断配置 failureThreshold: 50%（60s 窗口）、minSampleSize: 10、openDuration: 30_000、halfOpenMaxCalls: 5。触发条件：主模型连续 3 次超时切换到 P1；P1 错误率 >50% 熔断切换到 P2；P2 也失败触发 P3；熔断器 OPEN 直接降级下一级。超时：P0 30s、P1 15s、P2 10s。成本熔断：单次请求成本 >$1 降级到更便宜模型、日累计 >$50 切换到 P2、月累计 >$500 触发 P3 规则回复 + 告警。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: AI 不可用时仍有确定降级路径保证服务可用，成本上限定量防止账单失控。
exception: 无
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-GW-002] AI 模型降级与熔断规范.md"
formerly: 无
owner: platform-team
---

# [GW-002] AI 模型降级与熔断规范

<!-- RULES-REGISTRY: GW-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-GW-002] AI 模型降级与熔断规范.md。

## 约束

四原则：可用性优先、成本可控、透明告知（前端显示「正在使用备选模型」）、可配置。降级链：P0 主力模型 → 超时/错误率超阈值 → P1 备选 → 同样失败 → P2 兜底 → 全部不可用 → P3 规则回复（非 AI，保证服务可用）。熔断配置 failureThreshold: 50%（60s 窗口）、minSampleSize: 10、openDuration: 30_000、halfOpenMaxCalls: 5。触发条件：主模型连续 3 次超时切换到 P1；P1 错误率 >50% 熔断切换到 P2；P2 也失败触发 P3；熔断器 OPEN 直接降级下一级。超时：P0 30s、P1 15s、P2 10s。成本熔断：单次请求成本 >$1 降级到更便宜模型、日累计 >$50 切换到 P2、月累计 >$500 触发 P3 规则回复 + 告警。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

AI 不可用时仍有确定降级路径保证服务可用，成本上限定量防止账单失控。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

无

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
