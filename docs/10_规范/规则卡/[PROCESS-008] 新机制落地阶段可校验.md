---
name: 新机制落地阶段可校验
id: PROCESS-008
domain: PROCESS
nature: 约束为主，兼权力与福利
scope: "docs/10_规范/registry/FEATURE-OWNERSHIP.json 的 rollout.mechanisms[] 段：一切按 PROCESS-006 分阶段落地的新机制（拦截型机制尤其适用）"
priority: P1
trigger: "任何机制的 rollout.stage 被改动时；以及每次 commit 档（校验登记表与执行器阶段常量是否漂移）"
constraint: "机制所处阶段必须登记进 FEATURE-OWNERSHIP.json 的 rollout.mechanisms[]，且满足 PROCESS-006 的六条红线：stage 只能取 S1|S2|S3|S4（PP：阶段合法性）；进入 S3 前必须有 S1 观察样本，禁止直进门禁（PP-1）；升阶以样本量计（S1≥200 / S2≥50 / S3≥20），禁止以时间计（PP-2）；S1/S2 阶段的机制其规则强度不得派生为 blocking，必须旁路记录（PP-3）；每阶段必须登记回退动作且不依赖未提交代码（PP-4）；一次只升一阶（PP-6）。登记表的 stage 必须与执行器源码里的阶段常量一致，漂移即错。"
grants: "见约束边界：授权机制维护者在样本达标后按 PP-6 单次升一阶，并在登记表里留下 previousStage 作为升阶证据——升阶是人的决定，守卫只校验不代劳。"
benefit: "把 PROCESS-006 从「人工评审兜底」变成可执行的判据。最直接防住的是「登记说 S1、代码其实在拦」——那看起来一切正常（其他守卫全绿），但机制已经越过了 PP-1 要求的观察期。守卫按 gateStrength 复算强度而非读 severity 字面值，因为「没写 severity」和「写了 advisory」字面不同、效果可能相同。"
exception: "早于 PROCESS-006 成文就已拦截的存量机制（如 shell-command-risk）按存量豁免不予追溯；纯记录型（无拦截能力）的机制无需登记阶段。"
version: "1.0.0 (2026-09-18)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-PROCESS-002] 新机制落地四阶段流程.md"
formerly: 无
owner: governance-team
---

# [PROCESS-008] 新机制落地阶段可校验

<!-- RULES-REGISTRY: PROCESS-008 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-PROCESS-002] 新机制落地四阶段流程.md。

## 约束

机制所处阶段必须登记进 FEATURE-OWNERSHIP.json 的 rollout.mechanisms[]，且满足 PROCESS-006 的六条红线：stage 只能取 S1|S2|S3|S4（PP：阶段合法性）；进入 S3 前必须有 S1 观察样本，禁止直进门禁（PP-1）；升阶以样本量计（S1≥200 / S2≥50 / S3≥20），禁止以时间计（PP-2）；S1/S2 阶段的机制其规则强度不得派生为 blocking，必须旁路记录（PP-3）；每阶段必须登记回退动作且不依赖未提交代码（PP-4）；一次只升一阶（PP-6）。登记表的 stage 必须与执行器源码里的阶段常量一致，漂移即错。

## 授予权力

见约束边界：授权机制维护者在样本达标后按 PP-6 单次升一阶，并在登记表里留下 previousStage 作为升阶证据——升阶是人的决定，守卫只校验不代劳。

## 提供福利

把 PROCESS-006 从「人工评审兜底」变成可执行的判据。最直接防住的是「登记说 S1、代码其实在拦」——那看起来一切正常（其他守卫全绿），但机制已经越过了 PP-1 要求的观察期。守卫按 gateStrength 复算强度而非读 severity 字面值，因为「没写 severity」和「写了 advisory」字面不同、效果可能相同。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

早于 PROCESS-006 成文就已拦截的存量机制（如 shell-command-risk）按存量豁免不予追溯；纯记录型（无拦截能力）的机制无需登记阶段。

## 版本记录

- 1.0.0 (2026-09-18) 初版 / 迁移自 无
