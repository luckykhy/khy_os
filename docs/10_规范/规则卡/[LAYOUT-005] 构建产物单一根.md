---
name: 构建产物单一根
id: LAYOUT-005
domain: LAYOUT
nature: 约束为主，兼权力与福利
scope: "kernel/**, platform/**, services/**, apps/**, software/**, extensions/**, tools/**, docs/**, packaging/**, scripts/**（一切构建 / 测试 / 打包 / 代码生成产物的落盘路径；不含源码同名目录 packaging/build 与 scripts/release）"
priority: P1
trigger: "任何工具向磁盘写入可再生输出时；新增或移动产物目录时；修改 .gitignore / .dockerignore / clean.js 的产物清单时"
constraint: "可再生构建产物的落盘路径必须位于仓库根 entries/ 之下，形如 entries/<producer>[/<variant>]（深度 ≤ 2）；每条产物必须在 docs/10_规范/registry/BUILD-OUTPUTS.json 登记 path + rebuild（一条能把它变回来的命令）+ inBuildAll: true；entries/ 之外不得存在未登记为 migrating 或 parasitic 的产物目录；无法重定向的寄生产物必须登记 hook（重建钩子）与 sunset（到期日），且寄生条目总数不得超过 meta.parasiticBudget（只降不升）；.gitignore 与 .dockerignore 中的产物规则必须由登记表派生，不得手写第二份清单。"
grants: "授权任何人在不阅读任何构建配置的前提下执行 npm run clean:apply 后接 build:all 得到完整产物（登记表是唯一真源）；授权对 entries/ 整树执行无事前审批的删除（其内容按定义可再生）；授权维护者按 [DESIGN-LAY-004] §8 三步流程调整 parasiticBudget 与 sunset。边界：entries/ 之外的删除不在本授权内，仍受 check-change-safety.js 与 [DESIGN-ARCH-113] DELETE 模态管辖。"
benefit: "找产物进一个目录、删产物删一个目录、CI 缓存一个 key；「产物在哪 / 删了怎么回来」不再需要跨 .gitignore + .dockerignore + clean.js + 各包构建配置四处拼装答案。"
exception: "三类：① 源码同名目录（packaging/build、scripts/release、services/backend/src/services/*/build|publish、kernel/vendor）由守卫 SOURCE_DIR_ALLOWLIST 显式排除，不入登记表；② 机器本地 vendored 检出（tools/deepseek-eyes/**）登记为 parasitic 但 sunset 为空；③ 工具强制且不可重定向的路径（kernel/moonbit/_build、apps/ai-frontend/public/vendor、extensions/tools/*/vendor、docs/19_资产/site/mermaid.min.js）登记为 parasitic 并计入预算。三类均须登记，不得裸豁免。"
version: "1.0.0 (2026-09-16) 初版；配套原型 docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js 12 场景实测；1.0.1 (2026-09-18) 单一产物根由 _build/ 迁移至 entries/"
status: draft
ssot: "docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] 构建产物单一根规范.md"
formerly: 无
owner: architecture-team
enforcement: "scripts/ci/check-build-root.js"
---

# [LAYOUT-005] 构建产物单一根

<!-- RULES-REGISTRY: LAYOUT-005 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] 构建产物单一根规范.md。

## 约束

可再生构建产物的落盘路径必须位于仓库根 entries/ 之下，形如 entries/<producer>[/<variant>]（深度 ≤ 2）；每条产物必须在 docs/10_规范/registry/BUILD-OUTPUTS.json 登记 path + rebuild（一条能把它变回来的命令）+ inBuildAll: true；entries/ 之外不得存在未登记为 migrating 或 parasitic 的产物目录；无法重定向的寄生产物必须登记 hook（重建钩子）与 sunset（到期日），且寄生条目总数不得超过 meta.parasiticBudget（只降不升）；.gitignore 与 .dockerignore 中的产物规则必须由登记表派生，不得手写第二份清单。

## 授予权力

授权任何人在不阅读任何构建配置的前提下执行 npm run clean:apply 后接 build:all 得到完整产物（登记表是唯一真源）；授权对 entries/ 整树执行无事前审批的删除（其内容按定义可再生）；授权维护者按 [DESIGN-LAY-004] §8 三步流程调整 parasiticBudget 与 sunset。边界：entries/ 之外的删除不在本授权内，仍受 check-change-safety.js 与 [DESIGN-ARCH-113] DELETE 模态管辖。

## 提供福利

找产物进一个目录、删产物删一个目录、CI 缓存一个 key；「产物在哪 / 删了怎么回来」不再需要跨 .gitignore + .dockerignore + clean.js + 各包构建配置四处拼装答案。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

三类：① 源码同名目录（packaging/build、scripts/release、services/backend/src/services/*/build|publish、kernel/vendor）由守卫 SOURCE_DIR_ALLOWLIST 显式排除，不入登记表；② 机器本地 vendored 检出（tools/deepseek-eyes/**）登记为 parasitic 但 sunset 为空；③ 工具强制且不可重定向的路径（kernel/moonbit/_build、apps/ai-frontend/public/vendor、extensions/tools/*/vendor、docs/19_资产/site/mermaid.min.js）登记为 parasitic 并计入预算。三类均须登记，不得裸豁免。

## 版本记录

- 1.0.0 (2026-09-16) 初版；配套原型 docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js 12 场景实测；1.0.1 (2026-09-18) 单一产物根由 _build/ 迁移至 entries/ 初版 / 迁移自 无
