---
name: AI 指令文件标准
id: DOCS-003
domain: DOCS
nature: 约束为主，兼权力
scope: "仓库内一切面向 AI 的指令文件（AGENTS.md / CLAUDE.md / khy.md / KHY.md / agent.md / GEMINI.md / .windsurfrules / .cursorrules / .clinerules / .github/copilot-instructions.md / .cursor/rules/** 等）的编写与维护"
priority: P2
trigger: 新建或修改任一 AI 指令文件时
constraint: "指令文件必须落在读取器会扫到的位置（不得放 `_产物/` 等资产暂存区）；单文件字符数不得超过其 tier 的读取预算（own/compat 8000、eco 4000，真源 instructionFileService.js 与 instructionEcosystemRegistry.js），超限即静默截断；同一事实只允许一处真源，其余必须写成指针；非根指令文件不得自行声明优先级，优先级只能在登记表以字面路径登记；文件内引用的仓库路径、`npm run` 脚本、`khy` 子命令与 `[域-NNN]` 编号必须真实可达；`khy-metadata:pointer` 机器管理块不得手改且必须 START/END 成对；示意性命令必须落在可识别语境（❌/✅ 对照块，或紧邻标题含「示例/映射」字样）。"
grants: "授权维护者在预算内自行拆分指令文件（细节移入 docs/ 只留指针）即视为合规，无需事前审批；授权在登记表以字面路径登记某指令文件的优先级后，该文件即可合法声明覆盖关系。"
benefit: "把「写了但 AI 读不到」的静默失效变成可判定 finding，作者在写作时就知道边界；预算、候选清单、可达性三类判据全部从既有源码常量与注册表派生，不新增第二真源；存量走基线棘轮只降不升，不阻塞在途工作。"
exception: "上游第三方克隆（.research-tmp/）与用户级目录（~/.khyquant/khy.md）不在管辖范围；docs/ 下的普通文档不受本条约束（归 DOCS-001 / DOCS-002）。"
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/10_规范/DESIGN-DOC/[DESIGN-DOC-002] AI 指令文件标准.md"
formerly: 无
owner: governance-team
---

# [DOCS-003] AI 指令文件标准

<!-- RULES-REGISTRY: DOCS-003 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-DOC/[DESIGN-DOC-002] AI 指令文件标准.md。

## 约束

指令文件必须落在读取器会扫到的位置（不得放 `_产物/` 等资产暂存区）；单文件字符数不得超过其 tier 的读取预算（own/compat 8000、eco 4000，真源 instructionFileService.js 与 instructionEcosystemRegistry.js），超限即静默截断；同一事实只允许一处真源，其余必须写成指针；非根指令文件不得自行声明优先级，优先级只能在登记表以字面路径登记；文件内引用的仓库路径、`npm run` 脚本、`khy` 子命令与 `[域-NNN]` 编号必须真实可达；`khy-metadata:pointer` 机器管理块不得手改且必须 START/END 成对；示意性命令必须落在可识别语境（❌/✅ 对照块，或紧邻标题含「示例/映射」字样）。

## 授予权力

授权维护者在预算内自行拆分指令文件（细节移入 docs/ 只留指针）即视为合规，无需事前审批；授权在登记表以字面路径登记某指令文件的优先级后，该文件即可合法声明覆盖关系。

## 提供福利

把「写了但 AI 读不到」的静默失效变成可判定 finding，作者在写作时就知道边界；预算、候选清单、可达性三类判据全部从既有源码常量与注册表派生，不新增第二真源；存量走基线棘轮只降不升，不阻塞在途工作。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

上游第三方克隆（.research-tmp/）与用户级目录（~/.khyquant/khy.md）不在管辖范围；docs/ 下的普通文档不受本条约束（归 DOCS-001 / DOCS-002）。

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
