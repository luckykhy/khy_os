---
name: 修复先复现（看病）
id: RUNTIME-007
domain: RUNTIME
nature: 约束为主，兼权力与福利
scope: "被判定为 FIX 的改动集（改 bug / 修回归）：改动集含失败特征词、或改了既有测试（services/**、apps/**、extensions/**、scripts/**）"
priority: P1
trigger: 动手修 bug 前（判定为主模态 FIX 时）
constraint: "必须有 repro-before.txt（复现命令的**原始输出**，非转述）才可改代码；改后必须有 repro-after.txt 跑同一条命令；differential.md 须列 ≥2 个候选病因且每个给可证伪预测；处方必须最小化——FIX 触及 ≥4 文件或 ≥3 顶层目录即报 fix-blast-radius。"
grants: "见约束边界：授权在「复现输出已存证」后动手，也授权因无法复现而**拒绝修改**并回报客户（不修不是失败，谎报已复现才是）。"
benefit: "把「修 bug」从 AI 单方面手术变成可复核的诊疗记录：客户不必相信 AI 的转述，直接看原始输出。防止「改了三处、病没好、顺手重构」这一类最贵的失败。"
exception: "纯文档 / 纯注释改动；或改动集无法构造复现命令时，须在 complaint.md 写明「不可复现」及理由——缺此说明不豁免。"
version: "1.0.0 (2026-09-18)"
status: active
ssot: "docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式.md#31-看病模式fix"
formerly: 无
owner: governance-team
---

# [RUNTIME-007] 修复先复现（看病）

<!-- RULES-REGISTRY: RUNTIME-007 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式.md#31-看病模式fix。

## 约束

必须有 repro-before.txt（复现命令的**原始输出**，非转述）才可改代码；改后必须有 repro-after.txt 跑同一条命令；differential.md 须列 ≥2 个候选病因且每个给可证伪预测；处方必须最小化——FIX 触及 ≥4 文件或 ≥3 顶层目录即报 fix-blast-radius。

## 授予权力

见约束边界：授权在「复现输出已存证」后动手，也授权因无法复现而**拒绝修改**并回报客户（不修不是失败，谎报已复现才是）。

## 提供福利

把「修 bug」从 AI 单方面手术变成可复核的诊疗记录：客户不必相信 AI 的转述，直接看原始输出。防止「改了三处、病没好、顺手重构」这一类最贵的失败。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

纯文档 / 纯注释改动；或改动集无法构造复现命令时，须在 complaint.md 写明「不可复现」及理由——缺此说明不豁免。

## 版本记录

- 1.0.0 (2026-09-18) 初版 / 迁移自 无
