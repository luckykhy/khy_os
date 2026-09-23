---
name: 上帝文件门
id: LAYOUT-002
domain: LAYOUT
nature: 约束为主，兼福利
scope: "全部源码文件（services/**, platform/**, apps/**, software/**, kernel/**, tools/**）"
priority: P1
trigger: 新增或修改任一源码文件时
constraint: "任何文件不得新增超过 2500 行（env KHY_PROJECT_GOD_FILE_LOC → KHY_ARCH_GOD_FILE_LOC，默认 2500）；拆解必须走 god-file governance：同名 re-export 壳 + DI，保函数体字节等价。"
grants: "见约束边界：授权以「同名 re-export + DI」模式自行拆分大文件，无需事前审批；授权用 env 在测试或会话中临时调整阈值。"
benefit: "单一阈值数字全仓共用，作者期守卫与 CI 扫描读同一个数，不必逐案争论「多大算大」。"
exception: 存量超限文件按基线只降不升，不追溯整改。
version: "1.0.0 (2026-09-15)"
status: active
ssot: "CLAUDE.md#一红线-r1-r4（R4）"
formerly: R4
owner: backend-team
enforcement: "services/backend/src/services/domain/project/projectHygiene/thresholds.js godFileLoc() / services/backend/scripts/archDebtScan.js"
---

# [LAYOUT-002] 上帝文件门

<!-- RULES-REGISTRY: LAYOUT-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：CLAUDE.md#一红线-r1-r4（R4）。

## 约束

任何文件不得新增超过 2500 行（env KHY_PROJECT_GOD_FILE_LOC → KHY_ARCH_GOD_FILE_LOC，默认 2500）；拆解必须走 god-file governance：同名 re-export 壳 + DI，保函数体字节等价。

## 授予权力

见约束边界：授权以「同名 re-export + DI」模式自行拆分大文件，无需事前审批；授权用 env 在测试或会话中临时调整阈值。

## 提供福利

单一阈值数字全仓共用，作者期守卫与 CI 扫描读同一个数，不必逐案争论「多大算大」。

## 反例

单个文件长到 2500 行以上仍继续往里加功能，而不是按 god-file governance 拆分。

## 校验方式

`npm run arch:god --workspace services/backend`（阈值真源 `projectHygiene/thresholds.js` 的 `godFileLoc()`）

## 例外

存量超限文件按基线只降不升，不追溯整改。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 R4
