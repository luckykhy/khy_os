---
name: 委派边界
id: PROCESS-004
domain: PROCESS
nature: 约束为主，兼福利
scope: "khy-os 判定「这件活自己干还是交给外部智能体」的三处面：认知层注入文案（externalAgentDirective）、路由层委派决策（AgentTool/claudeDelegation）、以及任何拉起外部 CLI（claude/codex/opencode）的进程起点"
priority: P1
trigger: "任何一件任务出现「可以交给外部智能体做」的念头时——含注入文案、auto 启发式命中、模型自选 subagent_type"
constraint: "默认档是**自做**：委派是例外，须举证。仅当三闸门之一成立方可委派——G1 用户本轮显式点名该外部智能体；G2 本地能力确实缺失且已列出缺失清单；G3 任务必须在隔离的外部环境里执行。委派必须同时携带：闸门 id（G1/G2/G3）+ 可核验理由 + 对应证据 + 自包含 prompt；缺任一项即判 deny。子规则：4.1 理解不可外包（需求理解/任务拆解/方案裁决/结果验收必须 khy 自己做）；4.2 本地已覆盖时禁止委派（重构、跨文件改动、迁移、端到端实现、调研、设计、验收等属 khy 自有能力，命中这些关键词是「自做」的强信号而非委派理由）；4.3 禁止以「更适合/更强/更快/更省事」等不可核验措辞作为委派理由，注入给模型的文案禁止出现开放式授权句式；4.4 委派失败不得级联改派另一外部智能体；4.5 每次委派须留痕并在回复用户时显式声明「已交给 X（闸门 Gn）」。"
grants: "见约束边界：闸门成立时，授权直接发起委派并按闸门自选 subagent_type，无需逐次审批。"
benefit: "「自己干还是派出去」有一句可判的答案，不必靠模型临场揣度；外部重进程与外部 token 成本变成可预期事项，用户也不会再看到活被莫名其妙甩出去。详见真源 §2 判定顺序与 §8 反模式表。"
exception: "用户显式点名的若是顶层会话型 agent（cursor/kiro/trae/warp/windsurf），不得经 subagent_type 委派，须提示 `khy <agent>` 启动；适配器的可用性探测（如 `claude --version` 式 probe）不构成任务委派；外部 fixture 检出与测试夹具豁免。"
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md"
formerly: 无
owner: governance-team
enforcement: "scripts/ci/check-delegation-boundary.js / services/backend/src/services/externalAgentDirective.js"
---

# [PROCESS-004] 委派边界

<!-- RULES-REGISTRY: PROCESS-004 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md。

## 约束

默认档是**自做**：委派是例外，须举证。仅当三闸门之一成立方可委派——G1 用户本轮显式点名该外部智能体；G2 本地能力确实缺失且已列出缺失清单；G3 任务必须在隔离的外部环境里执行。委派必须同时携带：闸门 id（G1/G2/G3）+ 可核验理由 + 对应证据 + 自包含 prompt；缺任一项即判 deny。子规则：4.1 理解不可外包（需求理解/任务拆解/方案裁决/结果验收必须 khy 自己做）；4.2 本地已覆盖时禁止委派（重构、跨文件改动、迁移、端到端实现、调研、设计、验收等属 khy 自有能力，命中这些关键词是「自做」的强信号而非委派理由）；4.3 禁止以「更适合/更强/更快/更省事」等不可核验措辞作为委派理由，注入给模型的文案禁止出现开放式授权句式；4.4 委派失败不得级联改派另一外部智能体；4.5 每次委派须留痕并在回复用户时显式声明「已交给 X（闸门 Gn）」。

## 授予权力

见约束边界：闸门成立时，授权直接发起委派并按闸门自选 subagent_type，无需逐次审批。

## 提供福利

「自己干还是派出去」有一句可判的答案，不必靠模型临场揣度；外部重进程与外部 token 成本变成可预期事项，用户也不会再看到活被莫名其妙甩出去。详见真源 §2 判定顺序与 §8 反模式表。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

用户显式点名的若是顶层会话型 agent（cursor/kiro/trae/warp/windsurf），不得经 subagent_type 委派，须提示 `khy <agent>` 启动；适配器的可用性探测（如 `claude --version` 式 probe）不构成任务委派；外部 fixture 检出与测试夹具豁免。

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
