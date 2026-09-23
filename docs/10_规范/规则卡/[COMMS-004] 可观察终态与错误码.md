---
name: 可观察终态与错误码
id: COMMS-004
domain: COMMS
nature: 约束为主
scope: "ACP IPC / WS / HTTP transport 的超时、取消、重试与关闭路径"
priority: P1
trigger: "传输层发生超时、取消、重试或连接关闭时"
constraint: "必须具有可观察的终态与错误码（-32001 超时 / -32002 取消 / -32003 传输失败 / -32004 关闭，四态互斥）；transport 不得把协议级失败作为成功结果回传。"
grants: "见约束边界：授权按四错误码归类失败，调用方可据此决定重试/降级/上报。"
benefit: "调用者不会再收到「发送失败但标记成功」的假成功；重试策略可基于错误码自动决策。"
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md §3"
formerly: GOV-ACP-004
owner: protocol-team
---

# [COMMS-004] 可观察终态与错误码

<!-- RULES-REGISTRY: COMMS-004 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md §3。

## 约束

必须具有可观察的终态与错误码（-32001 超时 / -32002 取消 / -32003 传输失败 / -32004 关闭，四态互斥）；transport 不得把协议级失败作为成功结果回传。

## 授予权力

见约束边界：授权按四错误码归类失败，调用方可据此决定重试/降级/上报。

## 提供福利

调用者不会再收到「发送失败但标记成功」的假成功；重试策略可基于错误码自动决策。

## 反例

WS 发送失败被吞掉且调用者收到成功。

## 校验方式

契约已冻结：`[DESIGN-ACP-001]` §3（-32001 超时 / -32002 取消 / -32003 传输失败 / -32004 关闭，四态互斥）；错误码接线按该文 §5 排期，落地前待工具化

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-ACP-004
