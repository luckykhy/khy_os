---
name: Prompt Engineering 规范
id: PROMPT-001
domain: API
nature: 约束
scope: "services/backend/src/services/**, services/backend/src/prompts/**"
priority: P2
trigger: 新增或修改 Prompt 模板时
constraint: "五原则：版本化（每个 Prompt 模板有版本号，变更可追溯）、参数化（不硬编码业务数据，用变量占位）、可测试（模板可独立评估输出质量）、安全边界（防注入）、成本可控（有长度上限）。注册结构 prompts/index.js：{ version, template: readFile('templates/...'), params, maxTokens, createdAt }。禁止硬编码用户数据（You are helping user zhangsan with strategy ABC-123 错误；You are helping user {{userName}} with strategy {{strategyName}} 正确）。长度上限：System Prompt 2000 字符、User Prompt 4000、Tool Description 500/tool、总输入 6000（input tokens 预算）。注入防护：直接注入靠参数隔离（用户输入不进 System Prompt）、间接注入靠对外部数据消毒并标记来源、越狱靠 System Prompt 加护栏指令。变更步骤：1 修改模板文件、2 运行回归测试、3 人工评估 3 组代表性输入、4 提交时注明版本 bump、5 发布时保存版本快照。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: "Prompt 变成可版本化、可回归测试的资产而非散落的字符串，注入面与 token 成本都有上限。"
exception: 无
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-PROMPT-001] Prompt Engineering 规范.md"
formerly: 无
owner: platform-team
---

# [PROMPT-001] Prompt Engineering 规范

<!-- RULES-REGISTRY: PROMPT-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-PROMPT-001] Prompt Engineering 规范.md。

## 约束

五原则：版本化（每个 Prompt 模板有版本号，变更可追溯）、参数化（不硬编码业务数据，用变量占位）、可测试（模板可独立评估输出质量）、安全边界（防注入）、成本可控（有长度上限）。注册结构 prompts/index.js：{ version, template: readFile('templates/...'), params, maxTokens, createdAt }。禁止硬编码用户数据（You are helping user zhangsan with strategy ABC-123 错误；You are helping user {{userName}} with strategy {{strategyName}} 正确）。长度上限：System Prompt 2000 字符、User Prompt 4000、Tool Description 500/tool、总输入 6000（input tokens 预算）。注入防护：直接注入靠参数隔离（用户输入不进 System Prompt）、间接注入靠对外部数据消毒并标记来源、越狱靠 System Prompt 加护栏指令。变更步骤：1 修改模板文件、2 运行回归测试、3 人工评估 3 组代表性输入、4 提交时注明版本 bump、5 发布时保存版本快照。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

Prompt 变成可版本化、可回归测试的资产而非散落的字符串，注入面与 token 成本都有上限。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

无

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
