---
name: 规则卡由登记表生成
id: TOOLING-008
domain: TOOLING
nature: 约束为主，兼福利
scope: "docs/_规范/规则卡/**（逐条规则卡与目录索引）、docs/_规范/RULES-REGISTRY.json"
priority: P1
trigger: 新增 / 修订 / 废弃任何登记规则，或规则卡内容与登记表出现不一致时
constraint: "规则卡是 scripts/docs/gen-rules-cards.js 的构建产物，禁止手工编辑；规则字段以 RULES-REGISTRY.json 为唯一真源；卡片的 frontmatter 与六个固定小节必须出自同一次生成，不得只改一侧；生成器对每张卡的「反例 / 校验方式」取自治理总纲 §3 表格，仅 ENRICH 补全表内的条目为人工维护，新增规则须判定归入哪一侧；产物过期时 check-rules-registry.js --check 必须报红。"
grants: 见约束边界
benefit: "43 张卡与登记表永不分叉：改登记表一处即全量同步，不必为一致性手改 43 个文件；「卡与登记不一致」从人肉排查变成一条可机判的脏 diff，与 CODEOWNERS / .html 孪生件同一套棘轮。"
exception: "生成器内的 ENRICH 补全表是手工维护数据（治理总纲 §3 未覆盖的 17 条反例 / 校验方式），修改它属于规则内容修订，须经评审并重新生成。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/03_DESIGN_设计/[DESIGN-ARCH-070] 治理总纲与可执行规则.md"
formerly: 无
owner: governance-team
enforcement: "scripts/docs/gen-rules-cards.js / scripts/ci/check-rules-registry.js"
---

# [TOOLING-008] 规则卡由登记表生成

<!-- RULES-REGISTRY: TOOLING-008 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/03_DESIGN_设计/[DESIGN-ARCH-070] 治理总纲与可执行规则.md。

## 约束

规则卡是 scripts/docs/gen-rules-cards.js 的构建产物，禁止手工编辑；规则字段以 RULES-REGISTRY.json 为唯一真源；卡片的 frontmatter 与六个固定小节必须出自同一次生成，不得只改一侧；生成器对每张卡的「反例 / 校验方式」取自治理总纲 §3 表格，仅 ENRICH 补全表内的条目为人工维护，新增规则须判定归入哪一侧；产物过期时 check-rules-registry.js --check 必须报红。

## 授予权力

见约束边界

## 提供福利

43 张卡与登记表永不分叉：改登记表一处即全量同步，不必为一致性手改 43 个文件；「卡与登记不一致」从人肉排查变成一条可机判的脏 diff，与 CODEOWNERS / .html 孪生件同一套棘轮。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

生成器内的 ENRICH 补全表是手工维护数据（治理总纲 §3 未覆盖的 17 条反例 / 校验方式），修改它属于规则内容修订，须经评审并重新生成。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 无
