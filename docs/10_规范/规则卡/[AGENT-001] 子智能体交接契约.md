---
name: 子智能体交接契约
id: AGENT-001
domain: RUNTIME
nature: 约束为主，兼福利
scope: "一切经 Agent 工具派发或经 SendMessage 续用的子智能体调用：下行派发载荷（prompt / parent_context_summary / subagent_type / 所有权声明 / subtasks）与上行回报载荷（结论 / 证据 / 未决 / 风险）"
priority: P1
trigger: 调用 Agent 工具派发子智能体，或用 SendMessage 续用既有子智能体时
constraint: "子智能体之间不得假定共享内存，所有跨体传递必须走报文；派发时必须给出自包含 prompt，承载性信息禁止指望父对话自动可见（实测机制：子体只收到紧凑摘要而非完整对话）；派发时必须显式指定所有权（哪些文件/模块归它管、可否写入）；并发派发仅限真正独立的子任务，有依赖的必须留在主流程串行；子智能体产出必须带 file:line 引用，禁止无证据声明；只读型子智能体禁止派发写任务；继续既有子体必须用 SendMessage，禁止重复 spawn 同职责智能体；子智能体产出对用户不可见，主智能体必须在回复中转述；后台型子体启动后禁止轮询等待。"
grants: "授权主智能体在声明所有权后自行选择 subagent_type 与派发方式，并按五模式（只读/执行/并行/流水线/团队）自行组织协作拓扑，无需事前审批。"
benefit: "把「子智能体答非所问」从模型疏忽归因为契约违规。实测 AgentTool 的提示词明确写着子体只收到 compact summary、NOT the full conversation，并有 parent_context_summary 入参（显式摘要优先），说明界面设计上就是隔离的 —— 忘记传上下文是违规而非疏忽。同时 26 个内置 agent 可完整映射到书侧五模式，audit→fix 是现成的流水线型范例，可直接作为其他链路的模板。"
exception: "适配器可用性探测（如版本 probe）不构成子智能体派发；外部 fixture 检出与测试夹具豁免；AG-5（file:line 证据）因 output 是自由文本而非结构化字段，目前无法自动校验，属人工评审项。"
version: "1.0.0 (2026-09-18)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-AGENT-001] 子智能体交接契约.md"
formerly: 无
owner: governance-team
enforcement: "services/backend/src/tools/AgentTool/index.js"
---

# [AGENT-001] 子智能体交接契约

<!-- RULES-REGISTRY: AGENT-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-AGENT-001] 子智能体交接契约.md。

## 约束

子智能体之间不得假定共享内存，所有跨体传递必须走报文；派发时必须给出自包含 prompt，承载性信息禁止指望父对话自动可见（实测机制：子体只收到紧凑摘要而非完整对话）；派发时必须显式指定所有权（哪些文件/模块归它管、可否写入）；并发派发仅限真正独立的子任务，有依赖的必须留在主流程串行；子智能体产出必须带 file:line 引用，禁止无证据声明；只读型子智能体禁止派发写任务；继续既有子体必须用 SendMessage，禁止重复 spawn 同职责智能体；子智能体产出对用户不可见，主智能体必须在回复中转述；后台型子体启动后禁止轮询等待。

## 授予权力

授权主智能体在声明所有权后自行选择 subagent_type 与派发方式，并按五模式（只读/执行/并行/流水线/团队）自行组织协作拓扑，无需事前审批。

## 提供福利

把「子智能体答非所问」从模型疏忽归因为契约违规。实测 AgentTool 的提示词明确写着子体只收到 compact summary、NOT the full conversation，并有 parent_context_summary 入参（显式摘要优先），说明界面设计上就是隔离的 —— 忘记传上下文是违规而非疏忽。同时 26 个内置 agent 可完整映射到书侧五模式，audit→fix 是现成的流水线型范例，可直接作为其他链路的模板。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

适配器可用性探测（如版本 probe）不构成子智能体派发；外部 fixture 检出与测试夹具豁免；AG-5（file:line 证据）因 output 是自由文本而非结构化字段，目前无法自动校验，属人工评审项。

## 版本记录

- 1.0.0 (2026-09-18) 初版 / 迁移自 无
