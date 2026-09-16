---
name: 全链路追踪标识
id: COMMS-003
domain: COMMS
nature: 约束为主，兼福利
scope: "agent、task、tool message 与跨边界消息（meta.traceId/correlationId/callId/idempotencyKey/deadline/version）"
priority: P1
trigger: 消息跨越进程/协议边界，或并发工具调用需要回配结果时
constraint: "可跨边界追踪的消息必须具有可传播的 trace 标识；并发工具调用必须有唯一调用标识，不得仅按 tool 名回配 result。"
grants: "见约束边界：授权在 meta 块写入 traceId/correlationId/callId/idempotencyKey/deadline/version 六字段。"
benefit: "并发同名工具调用不会串结果；一次失败可从 HTTP requestId 一路追到 stream 事件。"
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/_规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md §2 / scripts/ci/check-gov-rules.js checkAcpProtocolCompliance"
formerly: GOV-ACP-003
owner: protocol-team
enforcement: "scripts/ci/check-gov-rules.js checkAcpProtocolCompliance"
---

# [COMMS-003] 全链路追踪标识

<!-- RULES-REGISTRY: COMMS-003 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/_规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md §2 / scripts/ci/check-gov-rules.js checkAcpProtocolCompliance。

## 约束

可跨边界追踪的消息必须具有可传播的 trace 标识；并发工具调用必须有唯一调用标识，不得仅按 tool 名回配 result。

## 授予权力

见约束边界：授权在 meta 块写入 traceId/correlationId/callId/idempotencyKey/deadline/version 六字段。

## 提供福利

并发同名工具调用不会串结果；一次失败可从 HTTP requestId 一路追到 stream 事件。

## 反例

两个同名 tool 调用仅按 tool 名回配 result。

## 校验方式

契约已冻结：`[DESIGN-ACP-001]` §2（`meta.traceId/correlationId/callId/idempotencyKey/deadline/version`）；schema 与 transport 接线按该文 §5 排期，落地前待工具化

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-ACP-003
