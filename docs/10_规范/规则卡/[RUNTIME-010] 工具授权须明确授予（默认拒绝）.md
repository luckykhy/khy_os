---
name: 工具授权须明确授予（默认拒绝）
id: RUNTIME-010
domain: RUNTIME
nature: 约束为主，兼权力与福利
scope: "智能体工具授权面：agent 定义的 tools/disallowedTools、roleToolScope 的角色作用域、toolProfile 白名单、toolAccessGateway 门，以及唯一执行漏斗 executeTool"
priority: P1
trigger: "新增/修改任何智能体的工具授权声明、工具 profile、角色作用域或执行面权限判定时"
constraint: "没有被显式授予的工具不得可被获得。① 未声明授权面不得解释为全权（禁止输出/实现为 All tools）；② 只读角色/profile/agent 不得持有任何写通道，含 Bash（重定向、sed -i、tee、git add、npm install 皆可写）——确需跑命令的角色（verify）必须显式授予，不得默认继承；③ 授权解析禁止 fail-open：未知 profile 名必须收敛为拒绝，而非放行；④ 声明面收窄必须有执行面强制与之对应，禁止仅在提示词中禁止；⑤ 同一个只读角色概念禁止有两份不一致定义；⑥ 提示词中「你没有权限」必须与机制事实一致；⑦ 权限判定失败禁止静默降级为放行，必须留痕。"
grants: "见约束边界：授权客户（团队）获得「任何一个智能体实际能做什么」的可解释、可核查答案——授权面即能力面，不存在未授予却被获得的权力。"
benefit: "此前 explore 等只读角色被提示词告知「没有文件编辑权限」，却仍持有 Bash 与 shell 写能力，声明与能力不一致。本规则把「凭提示词自律」变成「机制层可核查」，让只读是真的只读。"
exception: "verify（verification profile）等职责需要执行 build/test/lint 的角色，其 shell 能力属**显式授予**，不在禁止之列；本规则禁止的是「未明确授予却可获得」，而非禁止授予本身。"
version: "1.0.0 (2026-09-22)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-AGENT-002] 智能体工具授权矩阵.md"
formerly: 无
owner: governance-team
---

# [RUNTIME-010] 工具授权须明确授予（默认拒绝）

<!-- RULES-REGISTRY: RUNTIME-010 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-AGENT-002] 智能体工具授权矩阵.md。

## 约束

没有被显式授予的工具不得可被获得。① 未声明授权面不得解释为全权（禁止输出/实现为 All tools）；② 只读角色/profile/agent 不得持有任何写通道，含 Bash（重定向、sed -i、tee、git add、npm install 皆可写）——确需跑命令的角色（verify）必须显式授予，不得默认继承；③ 授权解析禁止 fail-open：未知 profile 名必须收敛为拒绝，而非放行；④ 声明面收窄必须有执行面强制与之对应，禁止仅在提示词中禁止；⑤ 同一个只读角色概念禁止有两份不一致定义；⑥ 提示词中「你没有权限」必须与机制事实一致；⑦ 权限判定失败禁止静默降级为放行，必须留痕。

## 授予权力

见约束边界：授权客户（团队）获得「任何一个智能体实际能做什么」的可解释、可核查答案——授权面即能力面，不存在未授予却被获得的权力。

## 提供福利

此前 explore 等只读角色被提示词告知「没有文件编辑权限」，却仍持有 Bash 与 shell 写能力，声明与能力不一致。本规则把「凭提示词自律」变成「机制层可核查」，让只读是真的只读。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

verify（verification profile）等职责需要执行 build/test/lint 的角色，其 shell 能力属**显式授予**，不在禁止之列；本规则禁止的是「未明确授予却可获得」，而非禁止授予本身。

## 版本记录

- 1.0.0 (2026-09-22) 初版 / 迁移自 无
