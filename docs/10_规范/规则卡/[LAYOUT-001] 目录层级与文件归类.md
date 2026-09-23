---
name: 目录层级与文件归类
id: LAYOUT-001
domain: LAYOUT
nature: 约束为主，兼福利
scope: "kernel/**, platform/**, services/**, apps/**, software/**, extensions/**, tools/**, scripts/**, packaging/**, docs/**（新增或移动目录/文件时；不含测试夹具与 build/ dist/ dist-electron/ *.egg-info/）"
priority: P1
trigger: "新建目录、新建文件、移动文件跨层，或新增跨层依赖时"
constraint: "文件必须落在 ARCH-068 登记的 L0-L6 或横切层内；跨层依赖必须经 pnpm workspace 包，禁止深层相对路径跨层 require；目录名风格必须匹配所在层语言轴；扩展名必须落在其允许层级内；docs 内 .md 必须有同名 .html 孪生；_ 前缀在代码树内表示 PRV 私有，不得被跨包依赖。"
grants: "见约束边界：授权依四问判定树自行决定文件放置位置与可见性档（PUB/INT/PRV），无需事前审批。"
benefit: "一张表回答「放哪、叫什么、谁能用」，不必跨 ARCH-068 / LAY-002 / DOCS-001 三篇拼装答案，降低首次提交流放错位置的返工成本。"
exception: "纯 re-export 单行壳（存量跨层转发，仅当保持单行）；生成目录；层内测试目录四种存量写法并存不追溯；services/backend 内历史 Python 目录不追溯迁移；docs 内文档编号与索引文件名格式归 DOCS-001/DOCS-002。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/DESIGN-LAY/[DESIGN-LAY-002] 目录层级与文件归类规范.md"
formerly: GOV-MOD-001/GOV-MOD-002
owner: architecture-team
---

# [LAYOUT-001] 目录层级与文件归类

<!-- RULES-REGISTRY: LAYOUT-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-LAY/[DESIGN-LAY-002] 目录层级与文件归类规范.md。

## 约束

文件必须落在 ARCH-068 登记的 L0-L6 或横切层内；跨层依赖必须经 pnpm workspace 包，禁止深层相对路径跨层 require；目录名风格必须匹配所在层语言轴；扩展名必须落在其允许层级内；docs 内 .md 必须有同名 .html 孪生；_ 前缀在代码树内表示 PRV 私有，不得被跨包依赖。

## 授予权力

见约束边界：授权依四问判定树自行决定文件放置位置与可见性档（PUB/INT/PRV），无需事前审批。

## 提供福利

一张表回答「放哪、叫什么、谁能用」，不必跨 ARCH-068 / LAY-002 / DOCS-001 三篇拼装答案，降低首次提交流放错位置的返工成本。

## 反例

新建根级 `frontend/` 保存运行时代码。

## 校验方式

`npm run check:layout` 的 `layer-registry`

## 例外

纯 re-export 单行壳（存量跨层转发，仅当保持单行）；生成目录；层内测试目录四种存量写法并存不追溯；services/backend 内历史 Python 目录不追溯迁移；docs 内文档编号与索引文件名格式归 DOCS-001/DOCS-002。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-MOD-001/GOV-MOD-002
