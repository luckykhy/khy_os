---
name: A2A 与 ACP 命名及术语规范
id: NAM-002
domain: COMMS
nature: 约束
scope: 全仓（代码 / 文档 / 环境变量 / 任务入口命名）
priority: P1
trigger: "任何文档、注释、提交信息或代码提到 A2A / ACP 时"
constraint: "术语表为唯一真源：「标准 A2A」= Linux Foundation Agent2Agent（0.3.0，JSON-RPC 2.0 over HTTP + SSE，跨厂商跨网络）；「私有 ACP」= khy-os 自有进程内 agent 编排方言（1.0，单进程内）。NAM-A2A-1 全仓禁止 a2a.<域>.<动作> 形式方法名（a2a.discovery.register 等仅为设计草案遗留，实现中零存在），唯一豁免为文件前 40 行内 <!-- naming-guard: exempt 理由（≤60 字） --> 且理由必填、仅用于记录历史错误命名；NAM-A2A-2 标准 A2A 用 KHY_A2A_* 前缀且新增须登记进 scripts/ci/protocol-naming.json 的 a2aEnvAllowlist，私有方言新增一律用 KHY_ACP_*；NAM-A2A-3 描述私有 ACP 的文档标题与首段必须出现「私有」或「进程内」；NAM-A2A-4 标准 A2A 能力声明必须诚实（真源 agentCardSpec.IMPLEMENTED_CAPABILITIES），禁止先改卡片再补实现；NAM-A2A-5 私有方言的方法名/状态集/传输方式禁止出现在 Agent Card skills/capabilities/description 与 contracts/a2a/** 的 schema 中。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: "外部读者不会被不存在的 API 误导；两套同名字面量协议被强制区分，避免把私有方言当成对外契约发布。"
exception: "文件顶部（前 40 行内）<!-- naming-guard: exempt 理由（≤60 字） -->，理由必填，且仅允许用于「记录历史错误命名」。"
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-NAM-002] A2A 与 ACP 命名及术语规范.md"
formerly: 无
owner: architecture-team
---

# [NAM-002] A2A 与 ACP 命名及术语规范

<!-- RULES-REGISTRY: NAM-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-NAM-002] A2A 与 ACP 命名及术语规范.md。

## 约束

术语表为唯一真源：「标准 A2A」= Linux Foundation Agent2Agent（0.3.0，JSON-RPC 2.0 over HTTP + SSE，跨厂商跨网络）；「私有 ACP」= khy-os 自有进程内 agent 编排方言（1.0，单进程内）。NAM-A2A-1 全仓禁止 a2a.<域>.<动作> 形式方法名（a2a.discovery.register 等仅为设计草案遗留，实现中零存在），唯一豁免为文件前 40 行内 <!-- naming-guard: exempt 理由（≤60 字） --> 且理由必填、仅用于记录历史错误命名；NAM-A2A-2 标准 A2A 用 KHY_A2A_* 前缀且新增须登记进 scripts/ci/protocol-naming.json 的 a2aEnvAllowlist，私有方言新增一律用 KHY_ACP_*；NAM-A2A-3 描述私有 ACP 的文档标题与首段必须出现「私有」或「进程内」；NAM-A2A-4 标准 A2A 能力声明必须诚实（真源 agentCardSpec.IMPLEMENTED_CAPABILITIES），禁止先改卡片再补实现；NAM-A2A-5 私有方言的方法名/状态集/传输方式禁止出现在 Agent Card skills/capabilities/description 与 contracts/a2a/** 的 schema 中。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

外部读者不会被不存在的 API 误导；两套同名字面量协议被强制区分，避免把私有方言当成对外契约发布。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

文件顶部（前 40 行内）<!-- naming-guard: exempt 理由（≤60 字） -->，理由必填，且仅允许用于「记录历史错误命名」。

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
