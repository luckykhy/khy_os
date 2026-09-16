---
name: 密钥防泄露
id: SECURITY-001
domain: SECURITY
nature: 约束为主
scope: "全部源码、打包产物、配置文件、日志与备份"
priority: P0
trigger: "处理任一密钥、令牌或敏感凭据时"
constraint: "真 key/token 永不进 bundle、源码或提交；只经 env 变量瞬时注入、绝不落盘；占位 key 必须一眼假；诊断与备份刻意排除密钥，绝不写入日志明文。"
grants: "见约束边界：授权经 env 变量注入密钥（customProviderRegistrar 无默认值，不设即对应能力不可用）。"
benefit: "密钥永不落盘，泄露面收敛到一个 env 注入点；占位 key 一眼假，不会被误当真值使用。"
exception: 无
version: "1.0.0 (2026-09-15)"
status: active
ssot: "CLAUDE.md#一红线-r1-r4（R2）/ services/backend/src/services/customProviderRegistrar.js"
formerly: R2
owner: backend-team
---

# [SECURITY-001] 密钥防泄露

<!-- RULES-REGISTRY: SECURITY-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：CLAUDE.md#一红线-r1-r4（R2）/ services/backend/src/services/customProviderRegistrar.js。

## 约束

真 key/token 永不进 bundle、源码或提交；只经 env 变量瞬时注入、绝不落盘；占位 key 必须一眼假；诊断与备份刻意排除密钥，绝不写入日志明文。

## 授予权力

见约束边界：授权经 env 变量注入密钥（customProviderRegistrar 无默认值，不设即对应能力不可用）。

## 提供福利

密钥永不落盘，泄露面收敛到一个 env 注入点；占位 key 一眼假，不会被误当真值使用。

## 反例

真实 API key 提交进仓库，或写进 `.env` 之外的配置文件后落盘。

## 校验方式

`node scripts/ci/check-change-safety.js --changed --promote=sensitive-paths` + PR diff 密钥扫描

## 例外

无

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 R2
