---
name: 新增先提问（求学）
id: RUNTIME-008
domain: RUNTIME
nature: 约束为主，兼福利
scope: "被判定为 BUILD 的改动集（加功能 / 加入口）：新增文件、新增顶层入口（cli/handlers、routes、tools/*/index.js、extensions/*/*/manifest.json）"
priority: P2
trigger: 写第一行代码前（判定为主模态 BUILD 时）
constraint: "必须先产出 requirement-5q.md，回答需求五问（谁用 / 何时用 / 现有替代 / 成功长什么样=命令+期望输出 / 不做会怎样），每条答案须带 `source: <用户原话>` 出处；压缩成 3 行复述待客户点头。五问回答均 <40 字或缺 source 字段判 self-answered。"
grants: "见约束边界：授权说「我不确定」并就此提问而不动代码——本规则明确**不扣分**；被禁止的是装作确定。"
benefit: "需求错误是本仓最贵的返工源，且在写代码前发现成本最低。把「猜需求」换成「问需求」，客户不必在成品阶段才发现做错了。"
exception: 改动集已有 docs/ 设计文档背书（含需求与验收）时豁免——已有文档即已答复五问。
version: "1.0.0 (2026-09-18)"
status: active
ssot: "docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式.md#32-求学模式build"
formerly: 无
owner: governance-team
---

# [RUNTIME-008] 新增先提问（求学）

<!-- RULES-REGISTRY: RUNTIME-008 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式.md#32-求学模式build。

## 约束

必须先产出 requirement-5q.md，回答需求五问（谁用 / 何时用 / 现有替代 / 成功长什么样=命令+期望输出 / 不做会怎样），每条答案须带 `source: <用户原话>` 出处；压缩成 3 行复述待客户点头。五问回答均 <40 字或缺 source 字段判 self-answered。

## 授予权力

见约束边界：授权说「我不确定」并就此提问而不动代码——本规则明确**不扣分**；被禁止的是装作确定。

## 提供福利

需求错误是本仓最贵的返工源，且在写代码前发现成本最低。把「猜需求」换成「问需求」，客户不必在成品阶段才发现做错了。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

改动集已有 docs/ 设计文档背书（含需求与验收）时豁免——已有文档即已答复五问。

## 版本记录

- 1.0.0 (2026-09-18) 初版 / 迁移自 无
