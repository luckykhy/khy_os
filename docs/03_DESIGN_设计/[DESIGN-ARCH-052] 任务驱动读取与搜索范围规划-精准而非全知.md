# [DESIGN-ARCH-052] 任务驱动读取与搜索范围规划：精准而非全知

> 子系统 `services/backend/src/services/contextScope/`
> 目标:khy 拿到任务后,确定性地判断**该读哪些文件、该搜什么**,做到准确读取,而非全量扫描追求全知。

## 1. 问题

agent 之前"读什么"靠两条路:

1. 模型在 `toolUseLoop.js` 里临场选 Read/Grep/Glob —— 无引导,可能漏读关键文件,也可能为求稳读太多。
2. `cli/ai.js` 一个启发式**预取**:把原始用户消息丢给 `exploreTool`,由它正则猜 glob/grep,2s 超时。猜得粗。

更关键的缺口:仓库**确定性生成** `.ai/MAP.md` + `.ai/CONTEXT.yaml`(每文件符号表、调用链),但**运行时从不读取**。项目自己有一张"文件→符号"地图,agent 却用不上。

且没有任何"读够了就停"的判据 —— 要么不规划,要么倾向读全。

## 2. 设计原则

- **确定性地板 + 可选模型增强**:无模型也能产出可用计划;模型只在地板之上**裁剪/重排**,绝不扩张。
- **精准而非全知**:强制充分性停止 —— 读到能动手的置信度即止。
- **单一真源**:候选文件只来自 `任务信号 ∪ .ai 索引 ∪ glob`,零硬编码文件清单。
- **零侵入**:`KHY_CONTEXT_SCOPE=1` 开关接入 `agenticHarnessService.buildContextPacket`,默认关闭。

## 3. 流水线

```
task → extractSignals → buildIndex(.ai/) → rankCandidates
     → applyBudget(充分性停止) → buildSearchPlan → ScopePlan
```

| 模块 | 职责 |
|---|---|
| `taskSignalExtractor.js` | 任务文本 → `{identifiers, fileHints, dirHints, extHints, quoted, keywords, intent}`,纯函数,识 camelCase/snake_case/PascalCase/dotted、路径、扩展名、引号串、中英关键词,去停用词。 |
| `aiMapIndex.js` | 解析 `.ai/CONTEXT.yaml`+`MAP.md`+`SKELETON.auto.md` → `文件→{符号,关键词}` 正排 + `关键词→文件` 倒排。按 mtime 缓存。**填补 `.ai/` 运行时从不被读取的缺口**。缺失即 `ok:false` 优雅降级。 |
| `scopeRanker.js` | 信号 × 索引 → 带理由的排序候选。权重:精确符号 10 > 文件名直指 9 > 部分符号 7 > 文件名含标识符 6 > `.ai` 关键词 5 > 目录 3 / 关键词 3 / 扩展 2 / 近期文件 +2 / 多信号 +2。 |
| `budgetController.js` | **"不全知"内核**。硬上限 maxFiles(默认 8) + 边际递减(分数 < 0.18×峰值即停) + 置信度饱和(≥0.85 即停)。永远返回 stopReason。 |
| `searchPlanBuilder.js` | 信号 → 具体 `{globs, grepPatterns, searchQueries}`,直接驱动 `exploreTool` 的 `patterns`/`grep_pattern` 覆写,取代其盲目正则推断。Web 搜索仅在显式外部标记或仓库内无目标时发出。 |
| `index.js` | `ContextScopePlanner.planScope()` 门面:确定性地板 + 可选 `modelPlanner`(超时 4s,只能在候选全集内选,经 `enforceBudget` 夹回硬上限)。 |

## 4. 置信度与停止

置信度 = `1 − e^(−Σ选中分数 / 18)`:强而具体的命中快速饱和,弱而零散的命中难达标。停止原因恒为五者之一:`budget_full` / `diminishing_returns` / `confidence_satisfied` / `exhausted` / `no_candidates`,**绝不输出"读全部"**。

## 5. 防呆

1. **硬预算上限**:模型增强后经 `enforceBudget` 夹回 maxFiles,且只能取候选全集内的路径 —— 模型无法新增文件、无法越界。
2. **强制充分性停止**:`applyBudget` 永远带 stopReason。
3. **`.ai/` 缺失优雅降级**:空索引,计划仍由信号+glob 产出,绝不抛错。
4. **零硬编码文件清单**:候选全部派生自信号/索引/glob。
5. **模型失败/超时**:回退确定性地板,绝不阻塞或抛错。

## 6. 实证

`tests/contextScopePlanner.test.js` 22 例全绿。真实仓库验证:任务"修复 syscall_dispatch 在 fork 时的 trap frame"经 `.ai/CONTEXT.yaml`(179 文件)精准定位 `kernel/src/syscall.c`+`process.c`+`isr.asm`,停止于 `confidence_satisfied`(conf=0.857),grep 计划 `syscall_dispatch` —— 而非全量扫描内核。

## 7. 接入点

- 已接 `agenticHarnessService.buildContextPacket`:`KHY_CONTEXT_SCOPE=1` 时输出 `scopePlan` 字段,关闭时为 `null`。
- 后续可用 `scopePlan.searchPlan` 驱动 `cli/ai.js` 预取替换启发式 `exploreTool` 推断(待后续 PR)。

## 8. 关联

- 复用 `.ai/` 种子文档(`projectMetadataService` 生产,本子系统首个运行时消费者)。
- 与 `[[project_maintainability_metadata]]`、`taskDecomposer`、`ragRetrievalService` 互补:本子系统管"读什么/搜什么的范围",后者管"任务拆解/知识检索"。
