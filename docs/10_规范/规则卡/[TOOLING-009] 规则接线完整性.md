---
name: 规则接线完整性
id: TOOLING-009
domain: TOOLING
nature: 约束为主，兼福利
scope: "docs/10_规范/registry/RULES-REGISTRY.json 里每一条已登记规则（88 条）的接线触点；判定面为「登记表宣告的接线」与「磁盘实况」之间的一致性，覆盖执行器存在性、package.json 别名、真源标记行、规则卡及其孪生件五类。不含规则语义是否合理（那是元规则 [MGMT-STD-008] §4.3 的辖区）、不含检查器是否被门表面引用（那是 check-wiring / TOOLING-005 的辖区）、不含登记表与真源的拓扑可达性（那是 TOOLING-007 的辖区）。"
priority: P2
trigger: "新增或修订一条规则之后；改动 package.json 的 check:* 别名、脚本或规则卡目录之后；季度健康检查时；以及任何时候想回答「新增一条规则到底要同步几处」时。"
constraint: "每条已登记规则的五类接线触点必须齐备：① 若声明了 exec.script，则该文件必须存在；② 该执行器必须被 package.json 某个 script 引用（否则 check-wiring 判零接线）；③ 每条能从 ssot 摘出文件路径的真源文件必须带 <!-- RULES-REGISTRY: <ID> --> 标记行；④ 规则卡 [ID] 名称.md 必须存在；⑤ 其 .html 孪生件必须存在。登记表自身必须自洽（meta.ruleCount === rules.length、无重复 id）。此外，gate=\"advisory\" 的规则必须在报告中显式列出——该值在任何门档都不会被选中（GATE_ORDER.advisory=4 > max=2），属「登记了但不生效」，不得被误认为「已观察」。"
grants: "授权维护者依据本规则的输出直接判断「某条规则的接线缺了哪一段」，无须逐个文件手工比对；授权对 gate=\"advisory\" 的规则按本规则报告逐条裁决归宿（降格为 commit+advisory / 保持 manual 并显式标注人工兜底 / 废弃），无须先补全其它守卫；授权把本规则作为「新增规则成本」的度量入口（--list 打印触点清单）。边界：本规则只读、只报告，不代为改动任何文件，也不代替人裁决某条规则应否存在。"
benefit: "把 khy-os 可维护性的头号成本项从隐性变显性：实测新增一条规则需同步 13 处触点，其中 5 项是从登记表可派生的生成物，而此前没有任何守卫校验「这 13 处是否彼此一致」——既有守卫只校验「有没有声明」，不校验「声明与磁盘是否吻合」。本规则补上这一段，并使 gate=\"advisory\" 的 15 条永不执行规则首次可见（此前 check:wiring / check:gov-rules 全绿，仓库无法从任何输出看出这些规则从没跑过）。"
exception: "三类：① 未声明 exec.script 的纯规范规则（gate=\"manual\"）不要求执行器与别名，是合法形态；② ssot 为纯命令或纯锚点（如 npm run check:duplication、AGENTS.md#工程规则-规则1）时不要求标记行，因为标记行的语义是「本文件是这些规则的 ssot」，只对承载正文的文件成立；③ 从 ssot 摘不出路径的目标不参与标记行检查。三类均须在叶子源码里以常量或判据体现，不得靠人工放过。"
version: "1.0.0 (2026-09-22) 初版；配套叶子 scripts/lib/ruleScaffold.js（纯叶子，零 IO）+ 走盘层 scripts/ci/check-rule-scaffold.js；19 项单测含双向断言与两次反向验证（改空判定 → 3 红；改坏解析 → 4 红）；实测存量 5 条 rule-scaffold-gap + 15 条 advisory-never-executes，已逐条人工核验为真（初版曾因把 ssot 当路径产生 37 条误报，已修）"
status: active
ssot: "docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-127] khyos 可维护性诊断与减负方案.md"
formerly: 无
owner: governance-team
---

# [TOOLING-009] 规则接线完整性

<!-- RULES-REGISTRY: TOOLING-009 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-127] khyos 可维护性诊断与减负方案.md。

## 约束

每条已登记规则的五类接线触点必须齐备：① 若声明了 exec.script，则该文件必须存在；② 该执行器必须被 package.json 某个 script 引用（否则 check-wiring 判零接线）；③ 每条能从 ssot 摘出文件路径的真源文件必须带 <!-- RULES-REGISTRY: <ID> --> 标记行；④ 规则卡 [ID] 名称.md 必须存在；⑤ 其 .html 孪生件必须存在。登记表自身必须自洽（meta.ruleCount === rules.length、无重复 id）。此外，gate="advisory" 的规则必须在报告中显式列出——该值在任何门档都不会被选中（GATE_ORDER.advisory=4 > max=2），属「登记了但不生效」，不得被误认为「已观察」。

## 授予权力

授权维护者依据本规则的输出直接判断「某条规则的接线缺了哪一段」，无须逐个文件手工比对；授权对 gate="advisory" 的规则按本规则报告逐条裁决归宿（降格为 commit+advisory / 保持 manual 并显式标注人工兜底 / 废弃），无须先补全其它守卫；授权把本规则作为「新增规则成本」的度量入口（--list 打印触点清单）。边界：本规则只读、只报告，不代为改动任何文件，也不代替人裁决某条规则应否存在。

## 提供福利

把 khy-os 可维护性的头号成本项从隐性变显性：实测新增一条规则需同步 13 处触点，其中 5 项是从登记表可派生的生成物，而此前没有任何守卫校验「这 13 处是否彼此一致」——既有守卫只校验「有没有声明」，不校验「声明与磁盘是否吻合」。本规则补上这一段，并使 gate="advisory" 的 15 条永不执行规则首次可见（此前 check:wiring / check:gov-rules 全绿，仓库无法从任何输出看出这些规则从没跑过）。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

三类：① 未声明 exec.script 的纯规范规则（gate="manual"）不要求执行器与别名，是合法形态；② ssot 为纯命令或纯锚点（如 npm run check:duplication、AGENTS.md#工程规则-规则1）时不要求标记行，因为标记行的语义是「本文件是这些规则的 ssot」，只对承载正文的文件成立；③ 从 ssot 摘不出路径的目标不参与标记行检查。三类均须在叶子源码里以常量或判据体现，不得靠人工放过。

## 版本记录

- 1.0.0 (2026-09-22) 初版；配套叶子 scripts/lib/ruleScaffold.js（纯叶子，零 IO）+ 走盘层 scripts/ci/check-rule-scaffold.js；19 项单测含双向断言与两次反向验证（改空判定 → 3 红；改坏解析 → 4 红）；实测存量 5 条 rule-scaffold-gap + 15 条 advisory-never-executes，已逐条人工核验为真（初版曾因把 ssot 当路径产生 37 条误报，已修） 初版 / 迁移自 无
