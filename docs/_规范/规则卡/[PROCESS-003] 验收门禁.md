---
name: 验收门禁
id: PROCESS-003
domain: PROCESS
nature: 约束为主，兼福利
scope: AI 代理与人类贡献者的多步任务与 PR
priority: P1
trigger: 声称任何任务完成，或提交任一 PR 之前
constraint: "多步任务先列 plan、每步带 verify；未跑过验证不许声称完成。验收门禁（node --check、相关测试、check-change-safety、check-agent-rules、check-repo-layout、check-gov-rules、arch:god、khy doctor）任一红即未完成。"
grants: "见约束边界：授权按 /goal 自循环协议（轮数上限 6）自行验证到通过。"
benefit: "「做完」有唯一可机判的标准，不必逐案争论；验证清单可直接复制执行。"
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "CLAUDE.md#三验收门禁"
formerly: B2
owner: governance-team
enforcement: "services/backend/src/cli/handlers/goal.js / services/backend/src/services/goalModeService.js"
---

# [PROCESS-003] 验收门禁

<!-- RULES-REGISTRY: PROCESS-003 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：CLAUDE.md#三验收门禁。

## 约束

多步任务先列 plan、每步带 verify；未跑过验证不许声称完成。验收门禁（node --check、相关测试、check-change-safety、check-agent-rules、check-repo-layout、check-gov-rules、arch:god、khy doctor）任一红即未完成。

## 授予权力

见约束边界：授权按 /goal 自循环协议（轮数上限 6）自行验证到通过。

## 提供福利

「做完」有唯一可机判的标准，不必逐案争论；验证清单可直接复制执行。

## 反例

改了代码没跑任何验证就说「修好了」。

## 校验方式

`CLAUDE.md` §三 验收门禁命令清单（`node --check`、三守卫、`arch:god`、映射表覆盖）+ 人工核对

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 B2
