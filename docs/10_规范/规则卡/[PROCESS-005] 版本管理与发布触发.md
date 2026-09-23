---
name: 版本管理与发布触发
id: PROCESS-005
domain: PROCESS
nature: 约束为主，兼福利
scope: "四条轨道：① bump 触发判定（CHANGELOG 段位 → 递增位）② 版本号递增语义（与 [DESIGN-SEMVER-001] 同义）③ 推送分层（GitHub / Gitee 双远端与 tag）④ 发布链路的 workflow 触发条件与自动化边界（.github/workflows/dual-channel-release.yml、sync-gitee.yml、scripts/release/publish-dual.sh）"
priority: P1
trigger: "需要改动版本号（bump）、打 tag、推送远端或调整任何发布 workflow 的触发条件时"
constraint: "R-1 bump 只在三种情形发生：T1 面向用户的功能新增（CHANGELOG ### Added 非空）→ MINOR；T2 行为/破坏性变更（### Changed / ### Removed / ### Security 非空）→ MAJOR 或 MINOR；T3 仅缺陷修复（### Fixed 非空且 Added/Changed/Removed 三段均空）→ PATCH；其余一律不 bump（仅文档/注释/测试/CI/.gitignore 改动、对外行为不变的内部重构、上游依赖小版本、工作区尚未收口）。R-2 版本号格式与递增语义依 [DESIGN-SEMVER-001]，规则不得比 check-version-sync.js 的 isSemver() 更宽或更窄。R-3 推送分层：git push origin main 与 git push origin vX.Y.Z 均须用户点头（P0 红线 PROCESS-001 不得放宽；推 tag 是「发布须人工确认」的最后一道闸）。R-4 tag 推送之后的一切（构建/签名/SBOM/发包/镜像/Release 资产）全自动、无条件触发，不允许第二次人工判断。R-5 发布链路的 mechanical 条件：每个 release 档 workflow 的 on: 块非空且含明确触发器；sync-gitee.yml 的 branches 覆盖当前默认分支；四条硬条件 step（check-version-sync / changelog-new --check / release-gate / updateIndex.test）均不得设 continue-on-error: true；dual-channel-release.yml 的 concurrency 必须 cancel-in-progress: false。豁免须以 # release-trigger-exempt: <理由> 显式声明，理由必填。"
grants: "见约束边界：授权在 T1/T2/T3 判定成立时自行 bump 三源（pyproject.toml / packaging/npm/package.json / services/backend/package.json 同一次提交内齐变）并写 CHANGELOG；授权在 tag 推送后按 workflow 定义全自动完成整条发布链路，无需逐次审批。"
benefit: "「什么时候 bump、bump 成几、什么时候推、推完谁接手」有一份可机判的答案，不必靠人记；发布时机的判断从「人的记忆」搬进 workflow 的 on: 块，改一个字符就静默失效的那类事实（触发器、并发开关、硬条件豁免）变成会红的 finding。"
exception: "纯 re-export 与生成目录不适用本规则；workflow_dispatch 单独存在、tags: ['v*'] 通配、branches 同时列 main 与 master（迁移期兼容）、concurrency 组名任意 —— 四种写法均判绿。本规则只自动化「发布链路」，不触碰 PROCESS-001 的推送红线；若未来要把「推 tag」也自动化，须先改 PROCESS-001 并单独评审。"
version: "1.0.0 (2026-09-17)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-SEMVER-002] 版本管理与发布触发规范.md"
formerly: 无
owner: governance-team
enforcement: "scripts/ci/check-release-triggers.js / scripts/ci/check-version-sync.js"
---

# [PROCESS-005] 版本管理与发布触发

<!-- RULES-REGISTRY: PROCESS-005 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-SEMVER-002] 版本管理与发布触发规范.md。

## 约束

R-1 bump 只在三种情形发生：T1 面向用户的功能新增（CHANGELOG ### Added 非空）→ MINOR；T2 行为/破坏性变更（### Changed / ### Removed / ### Security 非空）→ MAJOR 或 MINOR；T3 仅缺陷修复（### Fixed 非空且 Added/Changed/Removed 三段均空）→ PATCH；其余一律不 bump（仅文档/注释/测试/CI/.gitignore 改动、对外行为不变的内部重构、上游依赖小版本、工作区尚未收口）。R-2 版本号格式与递增语义依 [DESIGN-SEMVER-001]，规则不得比 check-version-sync.js 的 isSemver() 更宽或更窄。R-3 推送分层：git push origin main 与 git push origin vX.Y.Z 均须用户点头（P0 红线 PROCESS-001 不得放宽；推 tag 是「发布须人工确认」的最后一道闸）。R-4 tag 推送之后的一切（构建/签名/SBOM/发包/镜像/Release 资产）全自动、无条件触发，不允许第二次人工判断。R-5 发布链路的 mechanical 条件：每个 release 档 workflow 的 on: 块非空且含明确触发器；sync-gitee.yml 的 branches 覆盖当前默认分支；四条硬条件 step（check-version-sync / changelog-new --check / release-gate / updateIndex.test）均不得设 continue-on-error: true；dual-channel-release.yml 的 concurrency 必须 cancel-in-progress: false。豁免须以 # release-trigger-exempt: <理由> 显式声明，理由必填。

## 授予权力

见约束边界：授权在 T1/T2/T3 判定成立时自行 bump 三源（pyproject.toml / packaging/npm/package.json / services/backend/package.json 同一次提交内齐变）并写 CHANGELOG；授权在 tag 推送后按 workflow 定义全自动完成整条发布链路，无需逐次审批。

## 提供福利

「什么时候 bump、bump 成几、什么时候推、推完谁接手」有一份可机判的答案，不必靠人记；发布时机的判断从「人的记忆」搬进 workflow 的 on: 块，改一个字符就静默失效的那类事实（触发器、并发开关、硬条件豁免）变成会红的 finding。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

纯 re-export 与生成目录不适用本规则；workflow_dispatch 单独存在、tags: ['v*'] 通配、branches 同时列 main 与 master（迁移期兼容）、concurrency 组名任意 —— 四种写法均判绿。本规则只自动化「发布链路」，不触碰 PROCESS-001 的推送红线；若未来要把「推 tag」也自动化，须先改 PROCESS-001 并单独评审。

## 版本记录

- 1.0.0 (2026-09-17) 初版 / 迁移自 无
