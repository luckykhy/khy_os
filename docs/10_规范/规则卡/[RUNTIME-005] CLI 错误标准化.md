---
name: CLI 错误标准化
id: RUNTIME-005
domain: RUNTIME
nature: 约束为主，兼福利
scope: "CLI / TUI 面向用户的失败展示（services/backend/src/cli/**）；不含 REST/SSE/WS（API-003）与 ACP JSON-RPC（COMMS-004）"
priority: P1
trigger: "网关请求失败、级联耗尽或通道不可用需要向用户报错时"
constraint: "必须由结构化失败信封渲染，禁止对 result.content 做长度截断后当作失败信息展示；信封必须含稳定机器码（单射互斥，一次失败只落一个码）+ 主因（一条，非清单）+ 路由披露（钉选时必现）+ 可执行 hint；静态推广清单只在无任何 hint 可给时出现。钉选优先有严格边界：仅当被钉通道 statusCode===0/不存在时才报钉选专项码，通道给出真实 HTTP 拒绝（401/403/404/429/5xx）时须照实报通道侧事实，不得用元原因覆盖已观测事实。"
grants: "见约束边界：授权按信封字段自由撰写 title/hint 文案（遵循 AGENTS.md 规则 2.2），并按 §3 表新增机器码（先入表再用）。"
benefit: "用户看首屏即知「哪条通道、什么码、本轮路由是否被钉死、下一步敲什么命令」，不必在四段近义散文里翻找；支持可凭机器码归因与检索，不必解析自然语言。"
exception: "第三方库直接抛出的原始错误、调试模式 KHY_DEBUG_TOOLS=1 的调试输出、以及门 KHY_CLI_FAILURE_ENVELOPE=0 时逐字节回退今日行为不追溯。"
version: "1.0.0 (2026-09-17)"
status: active
ssot: "docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-114] CLI 错误标准化规范.md"
formerly: 无
owner: backend-team
enforcement: "services/backend/src/services/gateway/cliFailureEnvelope.js"
---

# [RUNTIME-005] CLI 错误标准化

<!-- RULES-REGISTRY: RUNTIME-005 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-114] CLI 错误标准化规范.md。

## 约束

必须由结构化失败信封渲染，禁止对 result.content 做长度截断后当作失败信息展示；信封必须含稳定机器码（单射互斥，一次失败只落一个码）+ 主因（一条，非清单）+ 路由披露（钉选时必现）+ 可执行 hint；静态推广清单只在无任何 hint 可给时出现。钉选优先有严格边界：仅当被钉通道 statusCode===0/不存在时才报钉选专项码，通道给出真实 HTTP 拒绝（401/403/404/429/5xx）时须照实报通道侧事实，不得用元原因覆盖已观测事实。

## 授予权力

见约束边界：授权按信封字段自由撰写 title/hint 文案（遵循 AGENTS.md 规则 2.2），并按 §3 表新增机器码（先入表再用）。

## 提供福利

用户看首屏即知「哪条通道、什么码、本轮路由是否被钉死、下一步敲什么命令」，不必在四段近义散文里翻找；支持可凭机器码归因与检索，不必解析自然语言。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

第三方库直接抛出的原始错误、调试模式 KHY_DEBUG_TOOLS=1 的调试输出、以及门 KHY_CLI_FAILURE_ENVELOPE=0 时逐字节回退今日行为不追溯。

## 版本记录

- 1.0.0 (2026-09-17) 初版 / 迁移自 无
