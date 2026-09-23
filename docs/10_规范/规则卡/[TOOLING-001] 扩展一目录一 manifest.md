---
name: 扩展一目录一 manifest
id: TOOLING-001
domain: TOOLING
nature: 约束为主
scope: "extensions/**（每个内置扩展目录）"
priority: P1
trigger: "新增、移动或删除任一扩展时"
constraint: "每个内置扩展必须遵守 [DESIGN-TOOL-002] 的「一目录一 khy.extension.json」契约，删除目录即卸载；两个扩展不得共用一个 manifest。"
grants: "见约束边界：授权以目录边界定义扩展生命周期。"
benefit: 卸载语义清晰（删目录即卸），不必维护额外注册表。
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-TOOL-002] 拓展契约与核心边界规范.md"
formerly: GOV-TOOL-001
owner: architecture-team
enforcement: "scripts/ci/check-repo-layout.js extension-contract"
---

# [TOOLING-001] 扩展一目录一 manifest

<!-- RULES-REGISTRY: TOOLING-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-TOOL-002] 拓展契约与核心边界规范.md。

## 约束

每个内置扩展必须遵守 [DESIGN-TOOL-002] 的「一目录一 khy.extension.json」契约，删除目录即卸载；两个扩展不得共用一个 manifest。

## 授予权力

见约束边界：授权以目录边界定义扩展生命周期。

## 提供福利

卸载语义清晰（删目录即卸），不必维护额外注册表。

## 反例

两个扩展共用一个 manifest。

## 校验方式

`npm run check:layout` 的 `extension-contract`

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-TOOL-001
