---
name: 状态透明
id: RUNTIME-002
domain: RUNTIME
nature: 约束为主，兼福利
scope: "CLI 输出、TUI 状态行与 spinner、后端 console.log / logger.info、面向用户的错误消息"
priority: P1
trigger: "任何面向用户的状态、进度、spinner 或错误文本被打印时"
constraint: "必须包含「动作 + 目标 + 进度」三维；禁止单独使用「正在工作/处理中/Loading/Connecting/尝试连接/请稍候/Processing」。子规则：2.1 简洁性（不冗余、动词前置）、2.2 错误消息具体化（问题+识别码+修复建议）、2.3 工具执行状态（动词+具体目标）、2.4 AI 思考状态（显示分析内容）、2.5 等待状态（显示等待目标+耗时）、2.6 多阶段进度（步骤 n/m）。"
grants: "见约束边界：授权按「动作+目标+进度」模板自由撰写状态文本；错误消息模板与动词映射表提供现成句式可直接套用。"
benefit: "用户知道系统在做什么、对谁做、做到哪一步，不必反复询问或猜测；错误消息自带修复命令，不必查文档。"
exception: "UI 枚举标签、i18n 翻译键、状态解析正则与字符串常量、数据库 ENUM 值属数据不违规（展示前会被代码进一步处理）；当前 check-agent-rules.js 未对这些做自动豁免，命中即 warning，由人工评审按判断标准放行。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "AGENTS.md#工程规则-规则2"
formerly: 规则2/状态透明
owner: backend-team
enforcement: "scripts/ci/check-agent-rules.js"
---

# [RUNTIME-002] 状态透明

<!-- RULES-REGISTRY: RUNTIME-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：AGENTS.md#工程规则-规则2。

## 约束

必须包含「动作 + 目标 + 进度」三维；禁止单独使用「正在工作/处理中/Loading/Connecting/尝试连接/请稍候/Processing」。子规则：2.1 简洁性（不冗余、动词前置）、2.2 错误消息具体化（问题+识别码+修复建议）、2.3 工具执行状态（动词+具体目标）、2.4 AI 思考状态（显示分析内容）、2.5 等待状态（显示等待目标+耗时）、2.6 多阶段进度（步骤 n/m）。

## 授予权力

见约束边界：授权按「动作+目标+进度」模板自由撰写状态文本；错误消息模板与动词映射表提供现成句式可直接套用。

## 提供福利

用户知道系统在做什么、对谁做、做到哪一步，不必反复询问或猜测；错误消息自带修复命令，不必查文档。

## 反例

❌ `正在工作…` / `Loading…` → ✅ `解析 AST (已处理 340/1200 节点)…`

## 校验方式

`node scripts/ci/check-agent-rules.js --changed`（generic-status 检查）

## 例外

UI 枚举标签、i18n 翻译键、状态解析正则与字符串常量、数据库 ENUM 值属数据不违规（展示前会被代码进一步处理）；当前 check-agent-rules.js 未对这些做自动豁免，命中即 warning，由人工评审按判断标准放行。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 规则2/状态透明
