---
name: 分支纪律
id: PROCESS-001
domain: PROCESS
nature: 约束为主
scope: 全部贡献者（含 AI 代理）的 git 操作
priority: P0
trigger: 任何 commit 或 push 之前
constraint: "禁止直接在主干开发；禁止 AI 自动 commit/push，必须用户明确点头。"
grants: "见约束边界：授权在用户明确指示后提交与推送。"
benefit: "不会被 AI 静默改动仓库历史；主干始终是可信基线。"
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "CLAUDE.md#一红线-r1-r4（R1）"
formerly: R1
owner: governance-team
---

# [PROCESS-001] 分支纪律

<!-- RULES-REGISTRY: PROCESS-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：CLAUDE.md#一红线-r1-r4（R1）。

## 约束

禁止直接在主干开发；禁止 AI 自动 commit/push，必须用户明确点头。

## 授予权力

见约束边界：授权在用户明确指示后提交与推送。

## 提供福利

不会被 AI 静默改动仓库历史；主干始终是可信基线。

## 反例

AI 在无人点头的情况下直接 `git commit` / `git push`；或在主干上直接开发。

## 校验方式

人工评审 + 分支保护基线 `[OPS-MAN-009]`；`git log` 提交者审计

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 R1
