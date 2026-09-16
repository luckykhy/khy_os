---
name: critical gate 不可绕过
id: SECURITY-002
domain: SECURITY
nature: 约束为主
scope: "services/backend/src/services/riskGate.js, toolCallingPermissions.js, syscallGateway/"
priority: P0
trigger: 任一操作被评估为不可逆或显式 critical 时
constraint: "不可逆操作（rm / kill / drop table / git reset --hard）或显式 critical，即便 KHY_SYSCALL_GATEWAY=off、即便 bypass/yolo，也不得绕过，永远要求键入 YES；持久化 allow 规则与 policyAutoAllow 都覆盖不了它。"
grants: "见约束边界：授权在键入 YES 后执行该次操作，仅此一次。"
benefit: 最坏的操作（不可逆删除）永远不会被静默放行，即使模式是 yolo。
exception: "行为断言 isUnbypassableGate 四条不变量（不可逆必阻断 / 判定与 KHY_SYSCALL_GATEWAY 及权限档无关 / 非 human-gate 返回 false / critical 与 destructive 双通道独立）。python -c 与 find -delete 等形态属 commandRiskClassifier 启发式覆盖缺口，记 warning 不阻断。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "services/backend/src/services/riskGate.js isUnbypassableGate"
formerly: 无
owner: backend-team
---

# [SECURITY-002] critical gate 不可绕过

<!-- RULES-REGISTRY: SECURITY-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：services/backend/src/services/riskGate.js isUnbypassableGate。

## 约束

不可逆操作（rm / kill / drop table / git reset --hard）或显式 critical，即便 KHY_SYSCALL_GATEWAY=off、即便 bypass/yolo，也不得绕过，永远要求键入 YES；持久化 allow 规则与 policyAutoAllow 都覆盖不了它。

## 授予权力

见约束边界：授权在键入 YES 后执行该次操作，仅此一次。

## 提供福利

最坏的操作（不可逆删除）永远不会被静默放行，即使模式是 yolo。

## 反例

以 `yolo` / bypass 绕过 `rm`、`drop table` 等不可逆操作的 critical gate。

## 校验方式

`riskGate.isUnbypassableGate` 代码路径 + 人工评审（无机械守卫）

## 例外

行为断言 isUnbypassableGate 四条不变量（不可逆必阻断 / 判定与 KHY_SYSCALL_GATEWAY 及权限档无关 / 非 human-gate 返回 false / critical 与 destructive 双通道独立）。python -c 与 find -delete 等形态属 commandRiskClassifier 启发式覆盖缺口，记 warning 不阻断。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 无
