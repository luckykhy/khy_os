---
name: session 与 persistent 区分
id: MEMORY-001
domain: MEMORY
nature: 约束为主
scope: agent/ACP 上下文与一切记忆记录
priority: P2
trigger: 写入任一记忆或上下文记录时
constraint: "仅当前任务需要且无需跨会话复用的信息归 session；跨会话稳定事实才归 persistent。"
grants: "见约束边界：授权按 ACP context.share.scope 声明作用域。"
benefit: "不必为「该不该记住」逐条争论；一次性输出不会污染长期记忆。"
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "docs/_规范/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md §1"
formerly: GOV-MEM-001
owner: backend-team
---

# [MEMORY-001] session 与 persistent 区分

<!-- RULES-REGISTRY: MEMORY-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/_规范/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md §1。

## 约束

仅当前任务需要且无需跨会话复用的信息归 session；跨会话稳定事实才归 persistent。

## 授予权力

见约束边界：授权按 ACP context.share.scope 声明作用域。

## 提供福利

不必为「该不该记住」逐条争论；一次性输出不会污染长期记忆。

## 反例

把一次性命令输出写入长期项目记忆。

## 校验方式

契约已冻结：`[DESIGN-MEM-006]` §1；机械守卫待工具化

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 GOV-MEM-001
