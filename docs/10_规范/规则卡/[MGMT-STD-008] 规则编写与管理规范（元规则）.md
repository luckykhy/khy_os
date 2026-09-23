---
name: 规则编写与管理规范（元规则）
id: MGMT-STD-008
domain: DOCS
nature: 约束为主，兼权力
scope: "编写 / 评审 / 修订 / 废弃 Khy OS 任何规则的场景（docs/08_MGMT_项目管理/[MGMT-STD-008]*.md 及引用本规范的规则卡）"
priority: P2
trigger: "编写、评审、修订、废弃任何 Khy OS 规则时"
constraint: "规则必须按 §1 规则卡格式编写，含 name/id/domain/nature/scope/priority/trigger/constraint/grants/benefit/exception/version/status/ssot/owner；ID 全局唯一不复用；scope 为合法 glob 或枚举；授予的权力须在 constraint/scope/exception 中找到边界（配对铁律）。"
grants: "授权维护者按本规范起草并提案新规则（见 PROCESS-101），且符合格式即自动过守卫、省去人工格式评审。"
benefit: "模板 rules:scaffold + 守卫自动过审，使遵循成本低于违反成本；提供明确行动路径与正向激励。"
exception: 无
version: "1.1.0 (2026-09-15)"
status: active
ssot: "docs/08_MGMT_项目管理/MGMT-STD/[MGMT-STD-008] 规则编写与管理规范（元规则）.md"
formerly: 无
owner: governance-team
---

# [MGMT-STD-008] 规则编写与管理规范（元规则）

<!-- RULES-REGISTRY: MGMT-STD-008 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/08_MGMT_项目管理/MGMT-STD/[MGMT-STD-008] 规则编写与管理规范（元规则）.md。

## 约束

规则必须按 §1 规则卡格式编写，含 name/id/domain/nature/scope/priority/trigger/constraint/grants/benefit/exception/version/status/ssot/owner；ID 全局唯一不复用；scope 为合法 glob 或枚举；授予的权力须在 constraint/scope/exception 中找到边界（配对铁律）。

## 授予权力

授权维护者按本规范起草并提案新规则（见 PROCESS-101），且符合格式即自动过守卫、省去人工格式评审。

## 提供福利

模板 rules:scaffold + 守卫自动过审，使遵循成本低于违反成本；提供明确行动路径与正向激励。

## 反例

规则卡缺 `grants` / `benefit`（只写约束）；两条规则 ID 重复；授予权力却无 `scope` / `constraint` 边界。

## 校验方式

`node scripts/ci/check-gov-rules.js` 的 GOV-TOOL-006

## 例外

无

## 版本记录

- 1.1.0 (2026-09-15) 初版 / 迁移自 无
