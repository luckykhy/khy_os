---
name: 终端无滚动区
id: RUNTIME-004
domain: RUNTIME
nature: 约束为主，兼福利
scope: "与回滚输出共存的 CLI 内联 UI：REPL、交互式 prompt、状态行渲染（services/backend/src/cli/**）"
priority: P1
trigger: 向 stdout 写 ANSI 转义序列或实现内联状态行时
constraint: "禁止使用 ANSI 滚动区 DECSTBM（DECSTBM 行范围序列）——它会丢弃越界滚出内容而非加入回滚缓冲；必须用保存/恢复光标（DECSC / DECRC）+ 绝对定位（CUP）+ 清行（EL）。"
grants: "见约束边界：授权先切到备用屏幕缓冲区（\\x1B[?1049h）后再用滚动区，限全屏 TUI（内置分页器/编辑器），且退出时必须恢复（\\x1B[?1049l）。"
benefit: "用户始终可以向上滚动回看历史输出；状态行不吞输出，REPL 与状态行可安全共存。"
exception: 先切到备用屏幕缓冲区的全屏 TUI 应用例外（守卫检测到 1049h/47h 标志时降级为 warning，需人工确认退出时恢复）。
version: "1.0.0 (2026-09-15)"
status: active
ssot: "AGENTS.md#工程规则-规则4 / docs/04_IMPL_实现/IMPL-RPT/[IMPL-RPT-015] 修复记录时间线.md"
formerly: 规则4/终端渲染
owner: backend-team
---

# [RUNTIME-004] 终端无滚动区

<!-- RULES-REGISTRY: RUNTIME-004 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：AGENTS.md#工程规则-规则4 / docs/04_IMPL_实现/IMPL-RPT/[IMPL-RPT-015] 修复记录时间线.md。

## 约束

禁止使用 ANSI 滚动区 DECSTBM（DECSTBM 行范围序列）——它会丢弃越界滚出内容而非加入回滚缓冲；必须用保存/恢复光标（DECSC / DECRC）+ 绝对定位（CUP）+ 清行（EL）。

## 授予权力

见约束边界：授权先切到备用屏幕缓冲区（\x1B[?1049h）后再用滚动区，限全屏 TUI（内置分页器/编辑器），且退出时必须恢复（\x1B[?1049l）。

## 提供福利

用户始终可以向上滚动回看历史输出；状态行不吞输出，REPL 与状态行可安全共存。

## 反例

❌ `\x1B[1;{rows-1}r`（DECSTBM 滚动区，丢弃越界内容、杀死回滚）→ ✅ `\x1B7` 保存光标 + 绝对定位 + `\x1B[K` 清行 + `\x1B8` 恢复

## 校验方式

`node scripts/ci/check-agent-rules.js --changed`（scroll-region 检查 DECSTBM）

## 例外

先切到备用屏幕缓冲区的全屏 TUI 应用例外（守卫检测到 1049h/47h 标志时降级为 warning，需人工确认退出时恢复）。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 规则4/终端渲染
