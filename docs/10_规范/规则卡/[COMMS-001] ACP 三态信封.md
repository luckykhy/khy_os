---
name: ACP 三态信封
id: COMMS-001
domain: COMMS
nature: 约束为主
scope: "ACP schema、transport、bridge（services/backend/src/contracts/acp/**, acpTransport.js）"
priority: P1
trigger: 新增或修改任一 ACP 请求/通知/响应时
constraint: "按 JSON-RPC 2.0 三态区分：请求与通知含 method，响应含同一 id 与恰一 result 或 error；禁止响应同时携带 result 与 error。"
grants: "见约束边界：授权按三态选择信封构造器（createRequest/createResponse/createErrorResponse）。"
benefit: "三态互斥使调用方无需分支猜测；transport 层不会把协议级失败当成成功。"
exception: "冻结前存量偏差（response 无 method、无 meta）以 [DESIGN-GOV-001] §4 登记为准。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md §1"
formerly: GOV-ACP-001
owner: protocol-team
---

# [COMMS-001] ACP 三态信封

<!-- RULES-REGISTRY: COMMS-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md §1。

## 约束

按 JSON-RPC 2.0 三态区分：请求与通知含 method，响应含同一 id 与恰一 result 或 error；禁止响应同时携带 result 与 error。

## 授予权力

见约束边界：授权按三态选择信封构造器（createRequest/createResponse/createErrorResponse）。

## 提供福利

三态互斥使调用方无需分支猜测；transport 层不会把协议级失败当成成功。

## 反例

response 同时携带 `result` 与 `error`。

## 校验方式

契约已冻结（UC-004 裁决）：`[DESIGN-ACP-001]` §1 三态信封拆分；schema v2 与 transport 接线按该文 §5 排期，落地前待工具化

## 例外

冻结前存量偏差（response 无 method、无 meta）以 [DESIGN-GOV-001] §4 登记为准。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-ACP-001
