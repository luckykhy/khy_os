---
name: 多轨道版本同步
id: PROCESS-002
domain: PROCESS
nature: 约束为主，兼福利
scope: "pyproject.toml, packaging/npm/package.json, services/backend/package.json, packaging/modules/modules.json, services/ai-backend/package.json, platform/packages/shared/package.json, platform/packages/ui-shared/package.json, apps/ai-frontend/package.json, software/khyquant/frontend/package.json"
priority: P1
trigger: 改动任一端版本号，或发布前
constraint: "三条版本轨道共 9 个真源，组内必须完全一致、组间刻意不同：G1 主包 4 源、G2 ai-backend 2 源、G3 浏览器 UI 3 源（G3 为 @khy/ui-shared 依赖声明精确对齐）。platform/khy_platform/__init__.py 的 __version__ 必须运行时动态解析，不得硬编码。"
grants: "见约束边界：授权发布时以 publish-dual.sh 的单一 --version 输入同步 G1 前三源；check-version-sync 在发布之外强制同一不变式。"
benefit: "一次输入同步多源，不会漏 bump 某渠道；CI 门防止手动编辑造成漂移。"
exception: "G2 与 G1 版本刻意不同；G3 是依赖声明对齐而非版本号对齐。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "CLAUDE.md#一红线-r1-r4（R3）/ AGENTS.md#版本同步 / scripts/ci/check-version-sync.js specs"
formerly: R3
owner: backend-team
---

# [PROCESS-002] 多轨道版本同步

<!-- RULES-REGISTRY: PROCESS-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：CLAUDE.md#一红线-r1-r4（R3）/ AGENTS.md#版本同步 / scripts/ci/check-version-sync.js specs。

## 约束

三条版本轨道共 9 个真源，组内必须完全一致、组间刻意不同：G1 主包 4 源、G2 ai-backend 2 源、G3 浏览器 UI 3 源（G3 为 @khy/ui-shared 依赖声明精确对齐）。platform/khy_platform/__init__.py 的 __version__ 必须运行时动态解析，不得硬编码。

## 授予权力

见约束边界：授权发布时以 publish-dual.sh 的单一 --version 输入同步 G1 前三源；check-version-sync 在发布之外强制同一不变式。

## 提供福利

一次输入同步多源，不会漏 bump 某渠道；CI 门防止手动编辑造成漂移。

## 反例

只改 `pyproject.toml` 就发布，`services/backend/package.json` 仍是旧版本。

## 校验方式

`node scripts/ci/check-version-sync.js`（三轨道 9 源，真源即该脚本的 `specs` 数组）

## 例外

G2 与 G1 版本刻意不同；G3 是依赖声明对齐而非版本号对齐。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 R3
