---
name: 工具注册契约
id: TOOLING-002
domain: TOOLING
nature: 约束为主
scope: "工具注册表与 toolContract（名称、风险、类别、输入 schema）"
priority: P1
trigger: 注册新工具或修改工具契约时
constraint: "注册条目必须通过名称归一、风险/类别与输入 schema 契约；不得有两个不同风险工具共享同一归一名称，避免解析顺序改变行为。"
grants: "见约束边界：授权按归一名称规则自行命名工具。"
benefit: "工具调用不会因注册顺序不同而行为漂移；风险判定在注册期即可静态验证。"
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-TOOL-001] 工具与扩展升级废弃规范.md"
formerly: GOV-TOOL-002
owner: backend-team
enforcement: "scripts/ci/check-tool-contract.js"
---

# [TOOLING-002] 工具注册契约

<!-- RULES-REGISTRY: TOOLING-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-TOOL-001] 工具与扩展升级废弃规范.md。

## 约束

注册条目必须通过名称归一、风险/类别与输入 schema 契约；不得有两个不同风险工具共享同一归一名称，避免解析顺序改变行为。

## 授予权力

见约束边界：授权按归一名称规则自行命名工具。

## 提供福利

工具调用不会因注册顺序不同而行为漂移；风险判定在注册期即可静态验证。

## 反例

两个不同风险工具共享同一归一名称。

## 校验方式

`node scripts/ci/check-tool-contract.js`

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-TOOL-002
