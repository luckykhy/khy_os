---
name: 仓库整理与巡检
id: LAYOUT-004
domain: LAYOUT
nature: 约束为主，兼福利
scope: "docs/10_规范/**, _产物/**, .research-tmp/**, 仓库根目录文件, .khyos/housekeeping/**（存量杂物巡检与隔离时；不含 L0-L6 源码层内部文件）"
priority: P2
trigger: "每日巡检、清理临时物/生成物/产物，或移动存量文件时"
constraint: "整理对象只限生成物/临时物/产物三类；git 已跟踪文件一律不动；.khy 与 .khyos 运行时数据只读（housekeeping 子目录除外）；只隔离不删除，淘汰进 .khyos/housekeeping/<日期>/ 并保留 manifest 可原路撤回；.html 孪生属 LAY-5 合法产出，不得当孤儿清理；不穿透软链与 junction；单批限流 10 个；目标同名不覆盖。"
grants: "见约束边界：授权每日自动巡检并隔离白名单内超期临时文件，无需事前审批；源码、配置与运行时数据不在授权范围内。"
benefit: "把「存量杂物怎么清」从口头默契变成可机械执行的红线，避免误删 .html 孪生（LAY-5）或误动在途重构文件。"
exception: "构建产物目录（build/ dist/ dist-electron/ *.egg-info/）不纳入巡检；docs 内文档编号与索引文件名格式归 DOCS-001/DOCS-002；junction 目标解析失败时仅记录不阻断。"
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/10_规范/DESIGN-LAY/[DESIGN-LAY-003] 仓库整理与巡检规范.md"
formerly: 无
owner: architecture-team
---

# [LAYOUT-004] 仓库整理与巡检

<!-- RULES-REGISTRY: LAYOUT-004 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-LAY/[DESIGN-LAY-003] 仓库整理与巡检规范.md。

## 约束

整理对象只限生成物/临时物/产物三类；git 已跟踪文件一律不动；.khy 与 .khyos 运行时数据只读（housekeeping 子目录除外）；只隔离不删除，淘汰进 .khyos/housekeeping/<日期>/ 并保留 manifest 可原路撤回；.html 孪生属 LAY-5 合法产出，不得当孤儿清理；不穿透软链与 junction；单批限流 10 个；目标同名不覆盖。

## 授予权力

见约束边界：授权每日自动巡检并隔离白名单内超期临时文件，无需事前审批；源码、配置与运行时数据不在授权范围内。

## 提供福利

把「存量杂物怎么清」从口头默契变成可机械执行的红线，避免误删 .html 孪生（LAY-5）或误动在途重构文件。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

构建产物目录（build/ dist/ dist-electron/ *.egg-info/）不纳入巡检；docs 内文档编号与索引文件名格式归 DOCS-001/DOCS-002；junction 目标解析失败时仅记录不阻断。

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
