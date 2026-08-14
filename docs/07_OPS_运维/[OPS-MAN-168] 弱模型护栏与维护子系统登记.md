# [OPS-MAN-168] 弱模型护栏与维护子系统登记（单人可维护补登记）

> 目标（用户原话）：「补充完善维护脚本，确保可以单人维护」。
> 本篇是**维护映射表登记补丁**的人读说明：把五个此前已在产、却漏登记进
> `docs/维护者/维护映射表.json` 的子系统一次补齐，让 `khy triage` / `maintainer:check` /
> 双击 launcher 能正确路由它们。每节结构统一：**它是什么 / 何时看它 / 怎么验 / 怎么扩展**。

## 为什么补这一篇

CLAUDE.md 第四条红线：「新子系统必须登记进 `docs/维护者/维护映射表.json`
（whenToUse/paths/docs/verify）」。侦察发现下列子系统已接线在产但映射表零命中——
未登记意味着：出问题时 `khy triage` 无法把症状路由到它们、`maintainer:check` 不覆盖它们的
路径、双击维护 launcher 也生成不了它们的一键验证。本篇补齐登记并作为这些 area 的 `docs` 指向。

同时本轮还强化了 `maintainer:check`（`scripts/ci/print-maintainer-map.js --check`）：
过去只校验 `paths`/`docs` 路径存在，现在**额外校验每个 area 的 `verify` 非空、且其
`npm run <name>` 引用的脚本真实存在**——被改名/删除的验证命令会亮 `STALE-VERIFY` 红灯，
不再静默烂掉。

---

## 1. 弱模型护栏引擎 `weak-model-guidance`

**它是什么**：确定性引擎 `weakModelGuidance.js`——「弱/陌生模型改 khyos 时，在哪个高危位置
该看到什么护栏 + 照抄哪个范例」的单一真源。维护三份冻结注册表：`GUARD_SITES`（7 高危位点）、
`WEAK_MODEL_EXEMPLARS`（BAD→GOOD→WHY 死循环反例）、`INTENTIONAL_DESIGNS`（看似 bug 实为
刻意设计的清单，防审查把设计当 CRITICAL「修」坏）。经 `WeakModelGuidanceTool` /
`CommentGuidanceTool` / coding-profile 三出口暴露给模型。纯叶子：零 IO、确定性、绝不抛、
门控 `KHY_WEAK_MODEL_GUIDANCE` 默认开、关门逐字节回退。

**何时看它**：陌生/弱模型动手改本仓源码前先查 `WeakModelGuidance`（尤其 `view='intentional'`
免得把刻意设计当 bug）；或要给某高危位点加护栏文案时。

**怎么验**：`node --test services/backend/src/services/__tests__/weakModelGuidance.test.js`

**怎么扩展**：给某注册表追加一个 `Object.freeze({...})` 条目即可（字段见文件内 HOW-TO-EXTEND
注释头）；既有条目不动。工具会自动把新条目带出。

## 2. 弱模型改动守卫 `weak-model-change-guard`

**它是什么**：`weakModelChangeGuard.js`——按分类红线/敏感文件 × 模型能力档裁决「这次改动是否
该拦下要求强模型复核」。弱档模型改红线文件（.env/发布/CI/权限核心/版本三源）时拦截。门控
`KHY_WEAK_MODEL_EDIT_GUARD` 默认开，接线在 `toolUseLoopCore.js`。纯叶子、fail-soft。

**何时看它**：怀疑改动被误拦/漏拦时；调整红线或敏感文件分类时。

**怎么验**：`node --test services/backend/tests/services/weakModelChangeGuard.test.js`

**怎么扩展**：在 `classifyChangeRisk` 的红线/敏感清单追加匹配项；能力档复用 `modelTier`，不重造。

## 3. 注释引导引擎 `comment-guidance`

**它是什么**：`commentGuidance.js`——「什么地方该写什么注释」的确定性引擎（与
`weakModelGuidance` 同族，正交）。定义 `COMMENT_LAYERS` 五层注释契约、`classifyCommentNeed`
分类、`auditComments` 零假阳性审计（有头注释/有文档的代码不报）。经 `CommentGuidanceTool` 暴露。

**何时看它**：写新代码拿不准该配什么注释时；或想审计某文件注释缺口时。

**怎么验**：`node --test services/backend/tests/commentGuidance.test.js`

**怎么扩展**：给 `COMMENT_LAYERS` 追加一层，或在分类规则里加一条；既有层不动。

## 4. 定时调度 `cron-scheduling`

**它是什么**：定时任务调度。**当前存在两套实现**（诚实登记，合并是独立工程）：
`src/jobs/cronScheduler.js`（CC 对齐，落盘 `~/.khy/scheduled_tasks.json`）与
`src/services/cronScheduler.js`（Hermes 风格，跨渠道投递）。经 `ScheduleCronTool` /
`CronListTool` / `CronDeleteTool` + `cli/handlers/cron.js` 暴露。`_defaultEnqueue` 把触发的
prompt 路由**进 agent** 作 follow-up（agent 架构，非调度器硬编码回测闭环）。

**何时看它**：定时任务不触发/重复触发/落盘异常时；`khy cron` 相关排障。

**怎么验**：`npx jest services/backend/tests/services/cronScheduler.test.js --runInBand`（此测试用 jest，不用 node --test）

**怎么扩展**：优先在既有实现内加能力；**新增定时能力前先确认改哪一套**，避免加深双实现分裂。

## 5. 未来抗性四支柱体检 `future-proofing`

**它是什么**：`futureProofing.js`——`khy maintain freshness` 背后的纯叶子体检：扫 Node EOL 表、
模型退役表、四支柱（pip 生命线 / 守卫免疫系统 / `.ai/` 种子文档 / `maintenance/` 双击 launcher）
是否齐备、守卫覆盖是否达标。接线在 `cli/handlers/maintain.js` + `replSession.js`。

**何时看它**：定期体检项目是否「与时俱进、可无 AI 传承」时；新增支柱/守卫后更新其检查表时。

**怎么验**：`node --test services/backend/tests/services/futureProofing.test.js`

**怎么扩展**：在 EOL/退役表或四支柱检查项里追加一条；表是单一真源，改值别猜。

---

## 相关

- 维护映射表：`docs/维护者/维护映射表.json`（本篇五节即其中五个 area 的人读说明）。
- 维护映射表校验：`npm run maintainer:check`（现已校验 verify 字段）。
- 无 AI 传承宪法：`docs/传承/KHY-OS-传承书.md`；四支柱体检 `khy maintain freshness`。
