---
name: 权限档 fail-closed
id: SECURITY-004
domain: SECURITY
nature: 约束为主
scope: "services/backend/src/services/permissionStore.js, permissions/rules.js, permissions/ 网关"
priority: P0
trigger: 任一工具调用需要权限裁决时
constraint: "权限档共 6 档（strict / normal / acceptEdits / auto / dontAsk / yolo），失败即拒（fail-closed）；模式化 allow/deny 规则库中 deny 优先于 allow；auto 档下 high/critical 风险仍问。"
grants: "见约束边界：授权用户按档调整自动放行范围，但永远无法使 deny 失效。"
benefit: 权限默认收紧，误配置也不会变成越权放行。
exception: "静态校验四个 fail-closed 不变量（冻结档表 / 未知档不得落宽松档 / yolo 别名显式映射 / deny 先于 allow）；第二份 PERMISSION_MODES 定义为 warning 棘轮。运行时语义（auto 档下 high 风险仍问）由载体 toolCallingPermissions.js 实现。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "services/backend/src/services/permissionStore.js VALID_PROFILES"
formerly: 无
owner: backend-team
enforcement: "services/backend/src/permissions/rules.js"
---

# [SECURITY-004] 权限档 fail-closed

<!-- RULES-REGISTRY: SECURITY-004 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：services/backend/src/services/permissionStore.js VALID_PROFILES。

## 约束

权限档共 6 档（strict / normal / acceptEdits / auto / dontAsk / yolo），失败即拒（fail-closed）；模式化 allow/deny 规则库中 deny 优先于 allow；auto 档下 high/critical 风险仍问。

## 授予权力

见约束边界：授权用户按档调整自动放行范围，但永远无法使 deny 失效。

## 提供福利

权限默认收紧，误配置也不会变成越权放行。

## 反例

allow 规则覆盖了 deny，或 `dontAsk` 档放行了未显式 allow 的工具。

## 校验方式

`permissionStore.js` 的 `VALID_PROFILES` + `permissions/rules.js` 的 deny 优先逻辑 + 人工评审

## 例外

静态校验四个 fail-closed 不变量（冻结档表 / 未知档不得落宽松档 / yolo 别名显式映射 / deny 先于 allow）；第二份 PERMISSION_MODES 定义为 warning 棘轮。运行时语义（auto 档下 high 风险仍问）由载体 toolCallingPermissions.js 实现。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 无
