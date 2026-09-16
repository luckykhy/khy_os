---
name: 许可证分级硬门槛
id: SOURCING-002
domain: SOURCING
nature: 约束为主
scope: 一切外部代码与文档片段
priority: P0
trigger: 引入任一外部片段时
constraint: "许可证分级是硬门槛：无法核实许可证的文件按最严格档 idea 处理；GPL/AGPL 家族禁止进入源码目录。"
grants: "见约束边界：授权按许可证分级选择引入方式（idea / pattern / vendored）。"
benefit: "不必为每个借鉴来源重新评估法律风险；分级表给出默认路径。"
exception: "private:true 的内部 workspace 包与测试夹具不分发，跳过；LicenseRef-Source-Available 属源码可用档，按 warning 记入棘轮而非阻断。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/03_DESIGN_设计/[DESIGN-ARCH-104] 借鉴与实现统一规则.md §1 B-S4"
formerly: GOV-BORROW-002
owner: architecture-team
---

# [SOURCING-002] 许可证分级硬门槛

<!-- RULES-REGISTRY: SOURCING-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/03_DESIGN_设计/[DESIGN-ARCH-104] 借鉴与实现统一规则.md §1 B-S4。

## 约束

许可证分级是硬门槛：无法核实许可证的文件按最严格档 idea 处理；GPL/AGPL 家族禁止进入源码目录。

## 授予权力

见约束边界：授权按许可证分级选择引入方式（idea / pattern / vendored）。

## 提供福利

不必为每个借鉴来源重新评估法律风险；分级表给出默认路径。

## 反例

以「大概 MIT」为由直接 vendored。

## 校验方式

`[DESIGN-ARCH-104]` §1 B-S4；人工评审（许可证文件路径必须在提案中可复核）

## 例外

private:true 的内部 workspace 包与测试夹具不分发，跳过；LicenseRef-Source-Available 属源码可用档，按 warning 记入棘轮而非阻断。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-BORROW-002
