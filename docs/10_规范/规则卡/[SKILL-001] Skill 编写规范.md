---
name: Skill 编写规范
id: SKILL-001
domain: DOCS
nature: 约束为主，兼福利
scope: "仓库与运行时的 Skill 定义：`.khy/skills/<name>/manifest.json` 的 description / when_to_use / disableModelInvocation / allowed-tools 字段，以及 `prompt.md` 与 `reference/` 的组织方式"
priority: P1
trigger: "新建或修改任一 Skill 的 manifest.json / prompt.md / reference/ 时"
constraint: "description 必须四段式（触发短语前置 / What / When / Not For），且触发短语必须落在前 60 字符内；description 不得超过 1024 字符；必须写 when_to_use 且不超过 120 字符；任务型 Skill 必须显式声明 disableModelInvocation: true；需要工具的 Skill 必须写 allowed-tools，禁止留空表示全部允许；allowed-tools 的 Bash 项必须用 `Bash(<prefix>:*)` 前缀形式（`:*` 而非 ` *`，两者语义不同且写错不报错）；触发短语必须可命中，禁止 help/assist/general 等空泛词；细则必须下沉 reference/，禁止全文塞进 prompt.md。"
grants: "授权 Skill 作者按四段式自行组织 description 与 prompt.md，并按需拆分 reference/ 任意多文件，无需事前审批。"
benefit: "把「Skill 写了但从来不被触发」这一静默失效变成可判定 finding。实测 43 个技能在 128K 窗口下 maxDescLen 被压到 62 字符，而触发短语必须在前 60 字符内 —— 二者几乎相等，意味着触发信号一旦不在前 60 就必被截掉，技能从此检索不到；同时实测 when_to_use 只填了 16/43，且渲染层此前漏算其长度导致一批技能静默溢出预算（已在并行修订中补为 hintLen）。"
exception: "learn-*.md 一族（25 个未成型的学习素材）不是 Skill 定义，不适用本条；内置（built-in）技能的非 manifest 元数据不追溯；allowed-tools 的强制力当前仅对 handler 技能生效（实测 0/43 有 handler），故本条要求「配」但不要求「现阶段已被强制」。"
version: "1.0.0 (2026-09-18)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-SKILL-001] Skill 编写规范.md"
formerly: 无
owner: governance-team
---

# [SKILL-001] Skill 编写规范

<!-- RULES-REGISTRY: SKILL-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-SKILL-001] Skill 编写规范.md。

## 约束

description 必须四段式（触发短语前置 / What / When / Not For），且触发短语必须落在前 60 字符内；description 不得超过 1024 字符；必须写 when_to_use 且不超过 120 字符；任务型 Skill 必须显式声明 disableModelInvocation: true；需要工具的 Skill 必须写 allowed-tools，禁止留空表示全部允许；allowed-tools 的 Bash 项必须用 `Bash(<prefix>:*)` 前缀形式（`:*` 而非 ` *`，两者语义不同且写错不报错）；触发短语必须可命中，禁止 help/assist/general 等空泛词；细则必须下沉 reference/，禁止全文塞进 prompt.md。

## 授予权力

授权 Skill 作者按四段式自行组织 description 与 prompt.md，并按需拆分 reference/ 任意多文件，无需事前审批。

## 提供福利

把「Skill 写了但从来不被触发」这一静默失效变成可判定 finding。实测 43 个技能在 128K 窗口下 maxDescLen 被压到 62 字符，而触发短语必须在前 60 字符内 —— 二者几乎相等，意味着触发信号一旦不在前 60 就必被截掉，技能从此检索不到；同时实测 when_to_use 只填了 16/43，且渲染层此前漏算其长度导致一批技能静默溢出预算（已在并行修订中补为 hintLen）。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

learn-*.md 一族（25 个未成型的学习素材）不是 Skill 定义，不适用本条；内置（built-in）技能的非 manifest 元数据不追溯；allowed-tools 的强制力当前仅对 handler 技能生效（实测 0/43 有 handler），故本条要求「配」但不要求「现阶段已被强制」。

## 版本记录

- 1.0.0 (2026-09-18) 初版 / 迁移自 无
