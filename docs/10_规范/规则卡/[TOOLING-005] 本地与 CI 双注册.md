---
name: 本地与 CI 双注册
id: TOOLING-005
domain: TOOLING
nature: 约束为主
scope: "package.json 与 .github/workflows/pr-gate.yml"
priority: P1
trigger: 新增任一治理检查脚本时
constraint: "治理检查必须同时在根 check:structure 与 PR gate 注册，避免本地/CI 任一侧失联。"
grants: "见约束边界：授权自行把新守卫接入两个入口。"
benefit: "本地与 CI 判定一致，不会出现「本地过、CI 挂」或反之的漏检。"
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md"
formerly: GOV-TOOL-005
owner: governance-team
enforcement: "package.json check:structure / .github/workflows/pr-gate.yml"
---

# [TOOLING-005] 本地与 CI 双注册

<!-- RULES-REGISTRY: TOOLING-005 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md。

## 约束

治理检查必须同时在根 check:structure 与 PR gate 注册，避免本地/CI 任一侧失联。

## 授予权力

见约束边界：授权自行把新守卫接入两个入口。

## 提供福利

本地与 CI 判定一致，不会出现「本地过、CI 挂」或反之的漏检。

## 反例

只新增脚本但未纳入 CI。

## 校验方式

`node scripts/ci/check-gov-rules.js`

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-TOOL-005
