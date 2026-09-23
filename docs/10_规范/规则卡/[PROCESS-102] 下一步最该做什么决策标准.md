---
name: 下一步最该做什么决策标准
id: PROCESS-102
domain: PROCESS
nature: 约束为主，兼权力与福利
scope: "回答「现在最该做什么 / 下一步」的一切通道（AI 问答、khy hq next）；.ai/hq/PROGRESS.json 与 BUGS.json 的任务选取逻辑"
priority: P1
trigger: "被问「最该做什么」或运行 khy hq next 时；新任务登记时"
constraint: "按五档瀑布 G0→G4 依序判定，首个能产出唯一赢家的档即答案：G0 验收债（review 任务 / pending_verify Bug / 过期占用租约）先报清单不排新活；G1 open Bug 按严重度；G2 P0/P1 待办；G3 P2/P3 待办；同档并列时仅当全体具备 cod/conf/size 字段才按 延迟成本×把握÷工量 评分决胜，禁止按登记顺序任取；评分并列或缺字段判 G4——列出候选+一句话理由停下来问人。AI 回答须先读同一数据源（或跑 khy hq next --json）并引用档位与证据计数，不得凭印象推荐未登记任务。"
grants: "授权 AI 与 CLI 在瀑布算不出唯一赢家时拒绝给出单一建议、改为反问（G4）；授权任何人用 khy hq next --task T-XXX / --verify BUG-XXX 显式指定跳过瀑布——人的当场意图高于标准。"
benefit: "一条命令得到带档位证据的唯一建议；平局以提问显性化而不是被登记顺序伪造成优先级；技术债（验收、排障）与功能在 G0/G1 有明确的先到位置，无需每次重新争论。"
exception: "用户本轮已明确点名做什么时直接执行，不再走瀑布；无候选（idle）时如实报 idle 并建议登记，不得硬凑推荐。"
version: "1.0.0 (2026-09-18)"
status: draft
ssot: "docs/10_规范/其它规范/PROCESS-102-下一步最该做什么决策标准.md"
formerly: 无
owner: governance-team
---

# [PROCESS-102] 下一步最该做什么决策标准

<!-- RULES-REGISTRY: PROCESS-102 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/PROCESS-102-下一步最该做什么决策标准.md。

## 约束

按五档瀑布 G0→G4 依序判定，首个能产出唯一赢家的档即答案：G0 验收债（review 任务 / pending_verify Bug / 过期占用租约）先报清单不排新活；G1 open Bug 按严重度；G2 P0/P1 待办；G3 P2/P3 待办；同档并列时仅当全体具备 cod/conf/size 字段才按 延迟成本×把握÷工量 评分决胜，禁止按登记顺序任取；评分并列或缺字段判 G4——列出候选+一句话理由停下来问人。AI 回答须先读同一数据源（或跑 khy hq next --json）并引用档位与证据计数，不得凭印象推荐未登记任务。

## 授予权力

授权 AI 与 CLI 在瀑布算不出唯一赢家时拒绝给出单一建议、改为反问（G4）；授权任何人用 khy hq next --task T-XXX / --verify BUG-XXX 显式指定跳过瀑布——人的当场意图高于标准。

## 提供福利

一条命令得到带档位证据的唯一建议；平局以提问显性化而不是被登记顺序伪造成优先级；技术债（验收、排障）与功能在 G0/G1 有明确的先到位置，无需每次重新争论。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

用户本轮已明确点名做什么时直接执行，不再走瀑布；无候选（idle）时如实报 idle 并建议登记，不得硬凑推荐。

## 版本记录

- 1.0.0 (2026-09-18) 初版 / 迁移自 无
