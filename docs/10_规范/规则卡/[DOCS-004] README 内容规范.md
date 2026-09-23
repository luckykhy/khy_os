---
name: README 内容规范
id: DOCS-004
domain: DOCS
nature: 约束为主，兼福利
scope: "仓库内一切 README.md 及其语言变体（T0 仓库入口 / T1 部署单元 / T2 内部模块三档，档位由所在目录是否含 package.json / pyproject.toml / Makefile / Cargo.toml 判定）；docs/** 下的 README 仅适用其禁项表"
priority: P2
trigger: 新建或修改任一 README 时
constraint: "README 不得成为第二真源：端口/IP/域名/URL、版本号字面量、引擎版本阈值、命令全集、完整目录树、版本同步源清单、规则正文、变更历史与进度台账，一律只能给指针（变量名 / 脚本名 / 规则 ID / 文档编号属指针标识，不算副本），不得给副本；引用代码与文档位置一律给符号名或小节标题，不得给行号 / 节序号（行号是最易漂移的副本）；每条命令必须在写作时实际可执行 —— `npm run X` 须存在于就近 package.json、`khy Y` 须真实注册、反引号路径须存在；必答内容按档位递减（T0 七问、T1 五问、T2 三问），必备项是下限不是上限；首屏须答完「这是什么 + 怎么跑」；`.html` 孪生件由 `npm run docs:build` 生成，禁止手改；文件名须匹配 check-repo-layout.js 的 README_VARIANT_RE。"
grants: "授权维护者按档位下限自行裁剪或扩写 README（T2 可写到任意长度，只要不含禁项），无需事前审批；授权在 ❌/✅ 对照块或「示例 / e.g.」紧邻语境中展示命令与端点示意而不判违规。"
benefit: "把「README 抄了一份本该由别处维护的事实」这一结构性漂移变成可判定 finding —— 实测根 README 290 行中 5 处失实全部属此类，同一份文档的定位与约定类正文零漂移，说明修法是删复述而非提醒作者更勤快；判据全部从既有真源（serviceDefaults、VERSION_GROUPS、engines、就近 package.json）派生，不新增第二真源；档位决定下限，避免统一模板逼 17 行的模块 README 长出无关章节。"
exception: "docs/** 下的 README（现存 [DEPLOY-MAN-004] README.md）只适用禁项表，其命名与索引归 DOCS-001；AGENTS.md / CLAUDE.md 一族归 DOCS-003，不归本条；用户级（~/.khyquant/）与第三方克隆（.research-tmp/）不在管辖范围；本期无自动执行器，执行强度为人工评审，机械化子集与接线设计见 [IMPL-DOC-002] §5/§6。"
version: "1.0.0 (2026-09-17)"
status: active
ssot: "docs/10_规范/DESIGN-DOC/[DESIGN-DOC-003] README 内容规范.md"
formerly: 无
owner: governance-team
---

# [DOCS-004] README 内容规范

<!-- RULES-REGISTRY: DOCS-004 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-DOC/[DESIGN-DOC-003] README 内容规范.md。

## 约束

README 不得成为第二真源：端口/IP/域名/URL、版本号字面量、引擎版本阈值、命令全集、完整目录树、版本同步源清单、规则正文、变更历史与进度台账，一律只能给指针（变量名 / 脚本名 / 规则 ID / 文档编号属指针标识，不算副本），不得给副本；引用代码与文档位置一律给符号名或小节标题，不得给行号 / 节序号（行号是最易漂移的副本）；每条命令必须在写作时实际可执行 —— `npm run X` 须存在于就近 package.json、`khy Y` 须真实注册、反引号路径须存在；必答内容按档位递减（T0 七问、T1 五问、T2 三问），必备项是下限不是上限；首屏须答完「这是什么 + 怎么跑」；`.html` 孪生件由 `npm run docs:build` 生成，禁止手改；文件名须匹配 check-repo-layout.js 的 README_VARIANT_RE。

## 授予权力

授权维护者按档位下限自行裁剪或扩写 README（T2 可写到任意长度，只要不含禁项），无需事前审批；授权在 ❌/✅ 对照块或「示例 / e.g.」紧邻语境中展示命令与端点示意而不判违规。

## 提供福利

把「README 抄了一份本该由别处维护的事实」这一结构性漂移变成可判定 finding —— 实测根 README 290 行中 5 处失实全部属此类，同一份文档的定位与约定类正文零漂移，说明修法是删复述而非提醒作者更勤快；判据全部从既有真源（serviceDefaults、VERSION_GROUPS、engines、就近 package.json）派生，不新增第二真源；档位决定下限，避免统一模板逼 17 行的模块 README 长出无关章节。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

docs/** 下的 README（现存 [DEPLOY-MAN-004] README.md）只适用禁项表，其命名与索引归 DOCS-001；AGENTS.md / CLAUDE.md 一族归 DOCS-003，不归本条；用户级（~/.khyquant/）与第三方克隆（.research-tmp/）不在管辖范围；本期无自动执行器，执行强度为人工评审，机械化子集与接线设计见 [IMPL-DOC-002] §5/§6。

## 版本记录

- 1.0.0 (2026-09-17) 初版 / 迁移自 无
