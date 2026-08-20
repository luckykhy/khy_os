# 00_INDEX 设计模式分类索引

> **索引总领文件** · 本目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章

## 一、分类内容边界

本目录（`docs/_设计模式/`）收容**设计模式注册表等机器可读数据**（JSON），供模式图谱与学习流程消费，非人工撰写说明文档。

## 二、文件清单

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| 模式注册表.json | 设计模式注册表 | 机器生成 + 手工补录，守卫把关 |

**注册表怎么改**：批量重生成走 `npm run maintenance:pattern-registry`（`generate-pattern-registry.js` 按启发式分类，**不**读源码里的 `@pattern` 注解）；单个文件补标注直接改本 JSON，并在源文件头部写上同样的 `@pattern`，两边保持一致。

**守卫**：`npm run check:pattern-coverage`（`check-pattern-coverage.js`，已接入 `check:structure` 与 PR 门禁）查三项——跟踪源文件没有条目、条目指向已删文件（幽灵）、模式名不在 GoF 23 内。三项都走 `scripts/ci/pattern-coverage-baseline.json` 棘轮，只降不升；后两项基线为 0，新增一处即 error。「本仓有哪些源文件」以 `git ls-files` 为准而非扫盘——文件系统里的 `.venv`、构建产物不是本仓的代码。

## 三、跨分类关联指引

- 文档总入口：`docs/00_INDEX_文档索引.md`。
- 模式图谱设计：`docs/03_DESIGN_设计/[DESIGN-ARCH-014]`。
