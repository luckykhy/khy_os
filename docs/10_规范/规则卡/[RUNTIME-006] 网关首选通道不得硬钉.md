---
name: 网关首选通道不得硬钉
id: RUNTIME-006
domain: RUNTIME
nature: 约束为主，兼福利
scope: "仓库内生效的 .env 配置文件（services/**, packaging/**, platform/**）；备份文件降级为告警"
priority: P1
trigger: "新增或修改 .env 中的 GATEWAY_PREFERRED_ADAPTER / GATEWAY_PREFERRED_STRICT 时"
constraint: "生效配置里 GATEWAY_PREFERRED_ADAPTER 必须为空或 auto；确需固定通道时必须同时写 GATEWAY_PREFERRED_STRICT=false，并经 `khy provider use <key>` 写入，禁止手改 .env 值。STRICT 语义为「未显式 false 即 strict」（与 routeFact.isStrictPinned 逐字一致），缺省等同钉死，不得因未写而放过。注释与值不得背离：注释声明了解钉（=auto /=false）而实际赋值不是，即判背离。"
grants: "见约束边界：授权用 `khy provider use <key>` 自由固定任意通道（该命令同步 STRICT 语义）；授权在确需例外时用行内 `# khy-allow-RUNTIME-006: <理由>` 抑制（理由必填，空理由不生效）。"
benefit: "把「钉选残留 → 所有 AI 通道均不可用」这一 2026-09-14 起四次复发（codex → windsurf → windsurf → api）的故障形态变成提交即拦截；并首次让「只改注释不改值」这个具体成因可机检，不必靠人记得同步改两处。"
exception: "备份文件（*.env.bak*）不生效，降级为 warning 不阻塞（直接恢复备份会把钉选带回，故仍告警）；.khyos/ 本机态与其下 housekeeping/ 隔离区不扫描。"
version: "1.0.0 (2026-09-17)"
status: active
ssot: "scripts/ci/check-env-gateway-pin.js"
formerly: 无
owner: backend-team
enforcement: "scripts/ci/check-env-gateway-pin.js"
---

# [RUNTIME-006] 网关首选通道不得硬钉

<!-- RULES-REGISTRY: RUNTIME-006 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：scripts/ci/check-env-gateway-pin.js。

## 约束

生效配置里 GATEWAY_PREFERRED_ADAPTER 必须为空或 auto；确需固定通道时必须同时写 GATEWAY_PREFERRED_STRICT=false，并经 `khy provider use <key>` 写入，禁止手改 .env 值。STRICT 语义为「未显式 false 即 strict」（与 routeFact.isStrictPinned 逐字一致），缺省等同钉死，不得因未写而放过。注释与值不得背离：注释声明了解钉（=auto /=false）而实际赋值不是，即判背离。

## 授予权力

见约束边界：授权用 `khy provider use <key>` 自由固定任意通道（该命令同步 STRICT 语义）；授权在确需例外时用行内 `# khy-allow-RUNTIME-006: <理由>` 抑制（理由必填，空理由不生效）。

## 提供福利

把「钉选残留 → 所有 AI 通道均不可用」这一 2026-09-14 起四次复发（codex → windsurf → windsurf → api）的故障形态变成提交即拦截；并首次让「只改注释不改值」这个具体成因可机检，不必靠人记得同步改两处。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

备份文件（*.env.bak*）不生效，降级为 warning 不阻塞（直接恢复备份会把钉选带回，故仍告警）；.khyos/ 本机态与其下 housekeeping/ 隔离区不扫描。

## 版本记录

- 1.0.0 (2026-09-17) 初版 / 迁移自 无
