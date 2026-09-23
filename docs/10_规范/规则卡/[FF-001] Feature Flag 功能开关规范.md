---
name: Feature Flag 功能开关规范
id: FF-001
domain: API
nature: 约束
scope: "services/backend/src/**, apps/ai-frontend/src/**"
priority: P2
trigger: "新增或移除功能开关、灰度发布逻辑时"
constraint: "四原则：默认关闭（新功能默认 false，渐进开启）、可回滚（关闭立即生效无需回滚代码）、可审计（变更有日志有时间有操作人）、自动清理（功能稳定后及时移除，最长存活 3 个月，过期自动升级为 FIXME）。生命周期：创建（默认 off，必须有移除计划）→ 灰度 7-14 天（10% → 50% → 100%）→ 全量 7 天（on 状态稳定运行）→ 移除（代码清理，开关删除）。配置结构含 enabled、rollout { type, value }、createdAt、expiresAt、owner。变更必须记录 flag、oldValue、newValue、actor、timestamp。开关级别：global、percentage（按用户哈希灰度）、whitelist、cohort。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: 开关有确定过期时限与移除计划，灰度不会永久留存在代码里变成僵尸配置。
exception: 无
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-FF-001] Feature Flag 功能开关规范.md"
formerly: 无
owner: platform-team
---

# [FF-001] Feature Flag 功能开关规范

<!-- RULES-REGISTRY: FF-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-FF-001] Feature Flag 功能开关规范.md。

## 约束

四原则：默认关闭（新功能默认 false，渐进开启）、可回滚（关闭立即生效无需回滚代码）、可审计（变更有日志有时间有操作人）、自动清理（功能稳定后及时移除，最长存活 3 个月，过期自动升级为 FIXME）。生命周期：创建（默认 off，必须有移除计划）→ 灰度 7-14 天（10% → 50% → 100%）→ 全量 7 天（on 状态稳定运行）→ 移除（代码清理，开关删除）。配置结构含 enabled、rollout { type, value }、createdAt、expiresAt、owner。变更必须记录 flag、oldValue、newValue、actor、timestamp。开关级别：global、percentage（按用户哈希灰度）、whitelist、cohort。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

开关有确定过期时限与移除计划，灰度不会永久留存在代码里变成僵尸配置。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

无

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
