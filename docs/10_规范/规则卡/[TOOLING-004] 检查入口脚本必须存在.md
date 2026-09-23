---
name: 检查入口脚本必须存在
id: TOOLING-004
domain: TOOLING
nature: 约束为主
scope: "根 package.json 的 check:* 入口及其引用的 scripts/ci/ 脚本"
priority: P1
trigger: "新增或修改任一 check:* 入口时"
constraint: "每个 check:* 入口中引用的 scripts/ci/ 脚本必须真实存在。"
grants: "见约束边界：授权自行注册新检查入口。"
benefit: 坏引用在提交前被发现，而不是 CI 运行时才 404。
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md"
formerly: GOV-TOOL-004
owner: governance-team
enforcement: "package.json / scripts/ci/check-gov-rules.js checkRegisteredTargets"
---

# [TOOLING-004] 检查入口脚本必须存在

<!-- RULES-REGISTRY: TOOLING-004 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md。

## 约束

每个 check:* 入口中引用的 scripts/ci/ 脚本必须真实存在。

## 授予权力

见约束边界：授权自行注册新检查入口。

## 提供福利

坏引用在提交前被发现，而不是 CI 运行时才 404。

## 反例

`check:missing` 指向 `scripts/ci/missing.js`。

## 校验方式

`node scripts/ci/check-gov-rules.js`

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-TOOL-004
