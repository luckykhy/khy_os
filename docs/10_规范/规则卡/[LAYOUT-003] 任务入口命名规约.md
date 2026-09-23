---
name: 任务入口命名规约
id: LAYOUT-003
domain: LAYOUT
nature: 约束为主，兼福利
scope: "package.json 的 scripts 字段（全部 npm run 入口）"
priority: P2
trigger: 新增或改名任一 npm run 入口时
constraint: "根任务入口必须遵循 <域>:<动作>[:<变体>]（如 check:layout、rules:scaffold）；check:* 入口引用的 scripts/ci/ 脚本必须真实存在。"
grants: "见约束边界：授权按三段式命名自行注册新入口，check:gov-rules 自动校验脚本存在性。"
benefit: "看一眼脚本名就知道它属于哪个域、做什么动作，不必翻 package.json 全文；坏引用被守卫当场拦下。"
exception: 历史遗留的非三段式入口按基线保留，不追溯改名。
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/DESIGN-LAY/[DESIGN-LAY-005] 仓库层级板块规范.md"
formerly: GOV-MOD-003/GOV-TOOL-004
owner: architecture-team
enforcement: "scripts/ci/check-gov-rules.js checkRegisteredTargets"
---

# [LAYOUT-003] 任务入口命名规约

<!-- RULES-REGISTRY: LAYOUT-003 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-LAY/[DESIGN-LAY-005] 仓库层级板块规范.md。

## 约束

根任务入口必须遵循 <域>:<动作>[:<变体>]（如 check:layout、rules:scaffold）；check:* 入口引用的 scripts/ci/ 脚本必须真实存在。

## 授予权力

见约束边界：授权按三段式命名自行注册新入口，check:gov-rules 自动校验脚本存在性。

## 提供福利

看一眼脚本名就知道它属于哪个域、做什么动作，不必翻 package.json 全文；坏引用被守卫当场拦下。

## 反例

`check:foo` 指向不存在的 `scripts/ci/foo.js`。

## 校验方式

`GOV-TOOL-004`；`check:layout` 的 `dangling-task`

## 例外

历史遗留的非三段式入口按基线保留，不追溯改名。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-MOD-003/GOV-TOOL-004
