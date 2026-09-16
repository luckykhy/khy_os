---
name: 弱模型改动护栏
id: SECURITY-003
domain: SECURITY
nature: 约束为主，兼福利
scope: "services/backend/src/services/weakModelChangeGuard.js（门控 KHY_WEAK_MODEL_EDIT_GUARD，默认开）"
priority: P1
trigger: 弱档模型（T2/T3）请求修改任一文件时
constraint: "弱档 + red-line 路径（.env / 发布·CI / flagRegistry SSOT / 版本三源 / 权限核心 / .git）→ 拒绝并要求强模型复核；弱档 + sensitive（god 级：gateway / harness / tool-loop）→ 放行但须确认。"
grants: "见约束边界：授权在强模型复核后修改 red-line 路径；授权用 env 关闭护栏回退。"
benefit: "弱模型不会静默改坏安全关键路径；关闭护栏时行为逐字节回退，不引入半启用状态。"
exception: "关闭、异常或入参不全时返回 null，逐字节回退旧行为。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "services/backend/src/services/weakModelChangeGuard.js"
formerly: 无
owner: backend-team
---

# [SECURITY-003] 弱模型改动护栏

<!-- RULES-REGISTRY: SECURITY-003 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：services/backend/src/services/weakModelChangeGuard.js。

## 约束

弱档 + red-line 路径（.env / 发布·CI / flagRegistry SSOT / 版本三源 / 权限核心 / .git）→ 拒绝并要求强模型复核；弱档 + sensitive（god 级：gateway / harness / tool-loop）→ 放行但须确认。

## 授予权力

见约束边界：授权在强模型复核后修改 red-line 路径；授权用 env 关闭护栏回退。

## 提供福利

弱模型不会静默改坏安全关键路径；关闭护栏时行为逐字节回退，不引入半启用状态。

## 反例

弱档模型直接修改 `.env` / 发布链路 / 权限核心等 red-line 文件。

## 校验方式

`weakModelChangeGuard.assessWeakModelChange` + 人工评审（无机械守卫）

## 例外

关闭、异常或入参不全时返回 null，逐字节回退旧行为。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 无
