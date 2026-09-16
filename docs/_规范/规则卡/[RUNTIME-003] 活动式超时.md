---
name: 活动式超时
id: RUNTIME-003
domain: RUNTIME
nature: 约束为主，兼福利
scope: "AI 循环、构建、回测、数据同步等长时间运行任务，以及一切用于任务截止的 setTimeout / Promise.race"
priority: P1
trigger: "为长任务设置超时、或任务执行中出现无界循环时"
constraint: "任何超时机制不得在固定时长后无条件杀死仍在推进的任务；必须用空闲/滑动超时，由进度事件重置计时器。超时触发时必须诚实说明完成了什么、还剩什么，绝不假装成功，并给出具体下一步。"
grants: "见约束边界：授权用「进度事件重置计时器」模式自行实现空闲超时；授权为刻意无限循环加 khy-allow-unbounded-loop 注释豁免。"
benefit: "长任务不会被误杀，也不需要为每个任务手写一套超时逻辑；超时报告自带诊断，不必回滚排查。"
exception: "短生命周期网络 fetch 超时与认证握手超时不算违规（防挂死 I/O 而非活跃计算）；<500ms setTimeout、Promise 延迟睡眠、计数器重置、≤5s UI 重置计时器、≤10s 短 I/O 超时、SIGTERM→SIGKILL 优雅期、仅 .abort()、仅 reject 的 Promise 超时。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "AGENTS.md#工程规则-规则3"
formerly: 规则3/基于活动的超时
owner: backend-team
enforcement: "scripts/ci/check-agent-rules.js"
---

# [RUNTIME-003] 活动式超时

<!-- RULES-REGISTRY: RUNTIME-003 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：AGENTS.md#工程规则-规则3。

## 约束

任何超时机制不得在固定时长后无条件杀死仍在推进的任务；必须用空闲/滑动超时，由进度事件重置计时器。超时触发时必须诚实说明完成了什么、还剩什么，绝不假装成功，并给出具体下一步。

## 授予权力

见约束边界：授权用「进度事件重置计时器」模式自行实现空闲超时；授权为刻意无限循环加 khy-allow-unbounded-loop 注释豁免。

## 提供福利

长任务不会被误杀，也不需要为每个任务手写一套超时逻辑；超时报告自带诊断，不必回滚排查。

## 反例

❌ `const start = Date.now(); if (Date.now() - start > 120_000) kill()` → ✅ 每次产出事件重置 `lastActivity`，仅在空闲超限时触发

## 校验方式

`node scripts/ci/check-agent-rules.js --changed`（hard-timeout 检查）+ 人工评审

## 例外

短生命周期网络 fetch 超时与认证握手超时不算违规（防挂死 I/O 而非活跃计算）；<500ms setTimeout、Promise 延迟睡眠、计数器重置、≤5s UI 重置计时器、≤10s 短 I/O 超时、SIGTERM→SIGKILL 优雅期、仅 .abort()、仅 reject 的 Promise 超时。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 规则3/基于活动的超时
