---
name: 规则登记表
id: TOOLING-006
domain: TOOLING
nature: 约束为主，兼权力与福利
scope: "docs/10_规范/registry/RULES-REGISTRY.json"
priority: P1
trigger: "新增、激活、修订或废弃任一规则时"
constraint: "规则必须登记进 RULES-REGISTRY.json：字段齐全（含三元字段 nature/grants/benefit）、ID 全局唯一且格式 <DOMAIN>-<NNN>、domain/priority/status 枚举合法、授予权力必有约束边界配对、同 domain 同名判职责重叠预警。"
grants: "授权维护者按元规则 §1 模板起草并登记新规则（见 PROCESS-101）；字段齐全即自动过守卫，免人工格式评审。"
benefit: "全仓规则可一文件检索；守卫自动校验格式，省去逐条人工核对字段。"
exception: 文件缺失时守卫静默跳过（外部 fixture / 尚未启用登记表的仓库）。
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md"
formerly: GOV-TOOL-006
owner: governance-team
enforcement: "docs/10_规范/registry/RULES-REGISTRY.json / scripts/ci/check-gov-rules.js checkRulesRegistry"
---

# [TOOLING-006] 规则登记表

<!-- RULES-REGISTRY: TOOLING-006 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md。

## 约束

规则必须登记进 RULES-REGISTRY.json：字段齐全（含三元字段 nature/grants/benefit）、ID 全局唯一且格式 <DOMAIN>-<NNN>、domain/priority/status 枚举合法、授予权力必有约束边界配对、同 domain 同名判职责重叠预警。

## 授予权力

授权维护者按元规则 §1 模板起草并登记新规则（见 PROCESS-101）；字段齐全即自动过守卫，免人工格式评审。

## 提供福利

全仓规则可一文件检索；守卫自动校验格式，省去逐条人工核对字段。

## 反例

只写约束不写 `grants`/`benefit`；两条规则 ID 相同；授予权力却无 `scope`/`constraint`。

## 校验方式

`node scripts/ci/check-gov-rules.js` 的 `checkRulesRegistry`（元规则 `[MGMT-STD-008]` §1/§3/§5.8）

## 例外

文件缺失时守卫静默跳过（外部 fixture / 尚未启用登记表的仓库）。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-TOOL-006
