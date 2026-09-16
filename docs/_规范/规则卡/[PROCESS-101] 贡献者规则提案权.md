---
name: 贡献者规则提案权
id: PROCESS-101
domain: PROCESS
nature: 权力为主，兼约束
scope: 任何仓库贡献者（含 AI 代理）
priority: P2
trigger: 贡献者认为需要新增 / 修订一条规则时
constraint: "提案须按 [MGMT-STD-008] §1 规则卡模板起草、填全三元字段，并完成查重（无同 domain 同 subject）。"
grants: 授权任何贡献者在对应 DOMAIN 下发起新规则草案（draft）并提 PR，无需事前审批。
benefit: "不必先征询可否提案；模板 + 查重即路径，降低「要不要提、怎么提」的决策成本。"
exception: "涉及 P0 宪法级的修订仍须维护者 + 独立复核门槛，不可由本权力绕过。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/08_MGMT_项目管理/[MGMT-STD-008] 规则编写与管理规范（元规则）.md §4.2"
formerly: 无
owner: governance-team
---

# [PROCESS-101] 贡献者规则提案权

<!-- RULES-REGISTRY: PROCESS-101 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/08_MGMT_项目管理/[MGMT-STD-008] 规则编写与管理规范（元规则）.md §4.2。

## 约束

提案须按 [MGMT-STD-008] §1 规则卡模板起草、填全三元字段，并完成查重（无同 domain 同 subject）。

## 授予权力

授权任何贡献者在对应 DOMAIN 下发起新规则草案（draft）并提 PR，无需事前审批。

## 提供福利

不必先征询可否提案；模板 + 查重即路径，降低「要不要提、怎么提」的决策成本。

## 反例

❌ 在 issue 里口头讨论「要不要加条规则」却不落卡 → ✅ 直接 `npm run rules:scaffold PROCESS` 起草草案提 PR

## 校验方式

`node scripts/ci/check-gov-rules.js`（字段齐全 + 查重）+ PR 评审

## 例外

涉及 P0 宪法级的修订仍须维护者 + 独立复核门槛，不可由本权力绕过。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 无
