---
name: 仓库层级可发现性
id: LAYOUT-006
domain: LAYOUT
nature: 约束为主，兼权力与福利
scope: "L0–L6 各层内部（kernel/**, platform/**, services/**, apps/**, software/**, extensions/**, tools/**）、横切层（scripts/**, docs/**, packaging/**）及其任何子目录（一切「东西放在哪个目录里」的容量与检索判定；不含仓库顶层目录的层归属——那是 [DESIGN-LAY-005] / LAYOUT-001 的辖区）"
priority: P1
trigger: "在一个目录里新增第 N 个直接条目时；把一个平铺目录拆成子目录时；给超预算目录写 00_INDEX_* 时；审计「新人为什么找不到东西」时"
constraint: "任何目录的直接条目数不得超过其可发现性预算（top 50 / category 50 / implementation 40 / docs 30，见 [DESIGN-LAY-006] §2）；超预算的目录必须按前缀家族拆分为子目录，或（仅文档目录）提供一个真编组的 00_INDEX_*（单个标题块内条目行数 ≤ 80，见 §3）；拆分必须整族一次移动并留下纯 re-export 壳，不得逐文件迁移；⚠ 实测（§1.3.1）：壳**计入**可发现性预算，故「迁移 + 留壳」使父目录条目 +1 —— 真正的降档必须「迁移 + 清壳」两步，且须改边数按**目标解析**判定（ 前缀 ≠ 兄弟边，实测 386 条  中仅 76 条是真兄弟）；.zcode / node_modules / vendor / 产物目录 / 一切点目录不计入。"
grants: "授权任何人在不询问维护者的前提下，对超预算目录执行「整族拆分子目录 + 留 re-export 壳」的标准动作（[DESIGN-LAY-006] §4 给出精确步骤与实测代价模型）；授权对平铺目录执行大规模 git mv（判定依据是可发现性预算这一客观量，不是主观审美）；授权维护者按 §7 分层分批推进而不必一次做完。边界：本授权只覆盖「移动 + 留壳」，不覆盖删除任何业务文件；删除仍受 check-change-safety.js 与 [DESIGN-ARCH-113] 管辖。"
benefit: "新人第一次进仓就能凭目录名预判内容，不必先 ls | grep；把「这个函数在哪」的检索成本从「全仓 grep + 人眼筛」压到「按层走一次路径」；同时从根因上减少一类长期潜伏 bug——本仓实测有 24 处深层 require 因历史搬迁时 ../ 级数算错而指向不存在的路径（[DESIGN-LAY-005] §2.1 已登记），本规范的「整族一次移动 + 出边计数」正是该缺陷的疗法。"
exception: "五类：① 生成物目录（docs/10_规范/规则卡/）由生成器产出，手拆会被覆盖；② 外部工具按名/按序读取的目录（migrations/、assets/）；③ 第三方代码落点（vendor/、node_modules/）；④ 产物目录（dist/build/out/release/coverage/_build/dist-electron，与 [DESIGN-LAY-004] 共用豁免名单）；⑤ 一切点目录（.github/、.claude/、.zcode/ 等，按工具约定命名，改它们等于改工具契约）。五类均须在本文 §5 登记并在叶子常量同步落地，不得裸豁免。"
version: "1.0.0 (2026-09-18) 初版；配套原型 scripts/ci/discoverability-demo.js 14 场景实测；实测存量 40 error + 3 warning 已逐条核验为真"
status: draft
ssot: "docs/10_规范/DESIGN-LAY/[DESIGN-LAY-006] 仓库层级可发现性规范.md"
formerly: 无
owner: architecture-team
enforcement: "scripts/ci/check-discoverability.js"
---

# [LAYOUT-006] 仓库层级可发现性

<!-- RULES-REGISTRY: LAYOUT-006 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-LAY/[DESIGN-LAY-006] 仓库层级可发现性规范.md。

## 约束

任何目录的直接条目数不得超过其可发现性预算（top 50 / category 50 / implementation 40 / docs 30，见 [DESIGN-LAY-006] §2）；超预算的目录必须按前缀家族拆分为子目录，或（仅文档目录）提供一个真编组的 00_INDEX_*（单个标题块内条目行数 ≤ 80，见 §3）；拆分必须整族一次移动并留下纯 re-export 壳，不得逐文件迁移；⚠ 实测（§1.3.1）：壳**计入**可发现性预算，故「迁移 + 留壳」使父目录条目 +1 —— 真正的降档必须「迁移 + 清壳」两步，且须改边数按**目标解析**判定（ 前缀 ≠ 兄弟边，实测 386 条  中仅 76 条是真兄弟）；.zcode / node_modules / vendor / 产物目录 / 一切点目录不计入。

## 授予权力

授权任何人在不询问维护者的前提下，对超预算目录执行「整族拆分子目录 + 留 re-export 壳」的标准动作（[DESIGN-LAY-006] §4 给出精确步骤与实测代价模型）；授权对平铺目录执行大规模 git mv（判定依据是可发现性预算这一客观量，不是主观审美）；授权维护者按 §7 分层分批推进而不必一次做完。边界：本授权只覆盖「移动 + 留壳」，不覆盖删除任何业务文件；删除仍受 check-change-safety.js 与 [DESIGN-ARCH-113] 管辖。

## 提供福利

新人第一次进仓就能凭目录名预判内容，不必先 ls | grep；把「这个函数在哪」的检索成本从「全仓 grep + 人眼筛」压到「按层走一次路径」；同时从根因上减少一类长期潜伏 bug——本仓实测有 24 处深层 require 因历史搬迁时 ../ 级数算错而指向不存在的路径（[DESIGN-LAY-005] §2.1 已登记），本规范的「整族一次移动 + 出边计数」正是该缺陷的疗法。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

五类：① 生成物目录（docs/10_规范/规则卡/）由生成器产出，手拆会被覆盖；② 外部工具按名/按序读取的目录（migrations/、assets/）；③ 第三方代码落点（vendor/、node_modules/）；④ 产物目录（dist/build/out/release/coverage/_build/dist-electron，与 [DESIGN-LAY-004] 共用豁免名单）；⑤ 一切点目录（.github/、.claude/、.zcode/ 等，按工具约定命名，改它们等于改工具契约）。五类均须在本文 §5 登记并在叶子常量同步落地，不得裸豁免。

## 版本记录

- 1.0.0 (2026-09-18) 初版；配套原型 scripts/ci/discoverability-demo.js 14 场景实测；实测存量 40 error + 3 warning 已逐条核验为真 初版 / 迁移自 无
