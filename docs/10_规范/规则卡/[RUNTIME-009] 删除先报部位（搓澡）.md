---
name: 删除先报部位（搓澡）
id: RUNTIME-009
domain: RUNTIME
nature: 约束为主，兼权力与福利
scope: "被判定为 DELETE 的改动集（删文件 / 下线模块）：git 状态 D 的代码文件（*.js/.ts/.vue/.py 等），跨全仓"
priority: P1
trigger: 删除任何代码文件前（判定为主模态 DELETE 或改动集含 D 状态代码文件时）
constraint: "删除前必须产出 scrub-plan.md（部位清单 + 逐条证据 + 力度档：轻搓标记/中搓下线入口/重搓物理删除，一次提交只做一步）与 rollback.txt（**可执行**回滚命令）；一次删除 >10 个文件须分片；被删代码若在 docs/ 设计文档中有背书则**拒绝放行**（delete-documented-code），须先「救活」或订正文档。"
grants: "见约束边界：授权客户在任何一片搓完后喊停并回滚——故 rollback.txt 是授予权力兑现的前提条件，不是可选项。"
benefit: "删除是不可逆操作。本规则把「静默清理」变成「先报部位、给力度、留回滚」，客户始终握有喊停权。"
exception: "删除纯粹的生成产物、缓存目录、`_产物/` 与 `docs/_报告/历史/` 等已废弃目录内的文件；`.md` 等文档类文件的增删按 DOCS-001 处理，不由本条管辖。"
version: "1.0.0 (2026-09-18)"
status: active
ssot: "docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式.md#33-搓澡模式delete"
formerly: 无
owner: governance-team
---

# [RUNTIME-009] 删除先报部位（搓澡）

<!-- RULES-REGISTRY: RUNTIME-009 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式.md#33-搓澡模式delete。

## 约束

删除前必须产出 scrub-plan.md（部位清单 + 逐条证据 + 力度档：轻搓标记/中搓下线入口/重搓物理删除，一次提交只做一步）与 rollback.txt（**可执行**回滚命令）；一次删除 >10 个文件须分片；被删代码若在 docs/ 设计文档中有背书则**拒绝放行**（delete-documented-code），须先「救活」或订正文档。

## 授予权力

见约束边界：授权客户在任何一片搓完后喊停并回滚——故 rollback.txt 是授予权力兑现的前提条件，不是可选项。

## 提供福利

删除是不可逆操作。本规则把「静默清理」变成「先报部位、给力度、留回滚」，客户始终握有喊停权。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

删除纯粹的生成产物、缓存目录、`_产物/` 与 `docs/_报告/历史/` 等已废弃目录内的文件；`.md` 等文档类文件的增删按 DOCS-001 处理，不由本条管辖。

## 版本记录

- 1.0.0 (2026-09-18) 初版 / 迁移自 无
