---
name: ACP 方法登记制
id: COMMS-002
domain: COMMS
nature: 约束为主
scope: ACP 方法扩展（schema 与 transport 两侧）
priority: P1
trigger: 新增任一 ACP 方法时
constraint: "新方法必须同时登记 method、params schema、错误码、兼容性影响与 transport 测试；不得只在 transport 加字符串方法名。"
grants: "见约束边界：授权按五要素模板一次性登记新方法。"
benefit: "调用方不必翻 transport 源码找方法签名；schema 变更有测试兜底。"
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/_规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md / scripts/ci/validate-json-schemas.js"
formerly: GOV-ACP-002
owner: protocol-team
enforcement: "scripts/ci/validate-json-schemas.js"
---

# [COMMS-002] ACP 方法登记制

<!-- RULES-REGISTRY: COMMS-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/_规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md / scripts/ci/validate-json-schemas.js。

## 约束

新方法必须同时登记 method、params schema、错误码、兼容性影响与 transport 测试；不得只在 transport 加字符串方法名。

## 授予权力

见约束边界：授权按五要素模板一次性登记新方法。

## 提供福利

调用方不必翻 transport 源码找方法签名；schema 变更有测试兜底。

## 反例

只在 transport 加字符串方法名。

## 校验方式

`validate-json-schemas.js` + ACP 测试；兼容性登记待工具化

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-ACP-002
