# 📚 Khy-OS 文档索引

> 本索引为文档总入口，按「阶段 → 类型 → 序号」归类，命名格式 `[阶段-类型-序号] 中文名`（更新于 2026-09-08）。
> 各阶段目录另设 `00_INDEX_*` 分类索引作为该目录的就近导航入口。

> 📈 **首次克隆后请跑一次 `npm run docs:build`**：图表引擎 `docs/19_资产/site/mermaid.min.js`
> 是 `scripts/docs/mermaid-embed/` 的构建产物、不进 git，在重建之前所有 Mermaid 图表区域留白。

## 🧭 一分钟导读：怎么找文档

本索引是**总入口**，但不再逐篇重复内容——按你的意图选一条路：

- **「我要做 X，该看哪篇规范？」** → [`10_规范/规范总目录`](10_规范/00_INDEX_规范-总目录.md) 的 **48 条情景速查**（按域分组，每条带「一条红线」）。这是全仓唯一「按意图查」入口。
- **「我在某个阶段目录下，找同目录的文档」** → 每个阶段目录都有排序首位的 `00_INDEX_*` 就近索引（下表「本索引已列」列即其入口）。
- **「我是小白，从零开始」** → [`02_CONCEPTS 概念入门`](02_CONCEPTS_概念入门/00_INDEX_概念入门-总览.md) + [`09_STORY 修仙学AI`](09_STORY_修仙学AI/00_INDEX_修仙学AI-总目录.md)。
- **「改仓库前必读的铁律」** → 见下方「⚖️ 规则与标准」三篇治理三角。

> **B8 已完成（2026-09-18）**：`docs-index-complete` 守卫已改为接受**就近 `00_INDEX_*` 的覆盖**
> ——主索引不再被要求逐篇点名 `01`–`09` 阶段文档，「索引三重」的强制冗余就此解除。
> 本页下方各阶段分区现只保留**总纲/入口类**与**就近索引尚未收录的补漏**（主索引 706 → 325 行，
> 389 篇由就近索引接管）。完整清单一律以就近 `00_INDEX_*` 为准。
> 落地记录见 `[IMPL-RPT-056] 文档精简与结构化整理落地记录`（`04_IMPL_实现/`）。

## § 规范重复主题边界裁决（10 组，[MGMT-STD-008] §2.2「重叠即违规」）

同主题被多篇各说一遍时，按下表归口——**真源那篇保留，其余加「边界」头并删重复段，不靠优先级覆盖**：

| 主题 | 重复陈述者 | 真源（归口） | 裁决 |
| --- | --- | --- | --- |
| 「核心」一词定义 | `INIT-PRD-003` + `ARCH-097` | `INIT-PRD-003` | 一词一解以立项口径为准 |
| 记忆系统 | `MEM-000`~`006`（7 篇） | `MEM-001` + `MEM-006` | 其余转参考卡（按角色分层，非合并） |
| 仓库层级 | `LAY-002` + `LAY-005` | `LAY-005` | 本篇管层与层，`LAY-002` 管层内 |
| 代码注释 | `COM-001` + `ARCH-015` | `COM-001` | `ARCH-015` 实为设计模式，已正名不重叠 |
| 测试 | `TEST-001` + `UI-TEST-001` | `TEST-001` | 后者降为子篇 |
| 错误处理 | `ERR-001` + `ARCH-114` | `ERR-001` | 后者降为子篇 |
| 通信协议 | `COMM-001` + `MS-001` + `A2A-001` | 各保留 | 互补，补边界声明 |
| 前端 | `FE-001`~`004` + `ARCH-016` | `FE-001`~`004` | 单一入口已声明，不改 |
| 文档规则 | `STD-001` + `DOC-001`~`003` | `STD-007` 总纲 | 其余为下位件 |
| 规则编写 | `STD-008` + `GOV-001` | `STD-008` 元规则 | `GOV-001` 为总纲落地 |

> 各篇首部已加「边界」块（详见 `10_规范/00_INDEX_规范-总目录.md` 与各规范正文）。

## 阶段总览

| 序号 | 阶段目录 | 文档数 | 本索引已列 |
|---|---|---:|---:|
| 01 | `01_INIT_立项/` | 3 | 3 |
| 02 | `02_CONCEPTS_概念入门/` | 32 | 目录入口（见下） |
| 03 | `03_DESIGN_设计/` | 121 | 见分区 |
| 04 | `04_IMPL_实现/` | 47 | 47 |
| 05 | `05_TEST_测试/` | 11 | 11 |
| 06 | `06_DEPLOY_部署/` | 25 | 25 |
| 07 | `07_OPS_运维/` | 182 | 182 |
| 08 | `08_MGMT_项目管理/` | 48 | 48 |
| 09 | `09_STORY_修仙学AI/` | 29 | 目录入口（见下） |
| 10 | `10_规范/`（跨阶段·规范族，2026-09-10 自 `03_DESIGN_设计/` 拆出） | 145 | 目录入口（见下） |
| 11 | `11_报告/`（跨阶段·一次性快照报告与调研件，写完即冻结） | 19 | 目录入口（见下） |
| 12 | `12_模板/`（跨阶段·文档模板） | 0 | 目录入口（见下） |
| 13 | `13_传承/`（跨阶段·生存文档，不隶属任何生命周期阶段） | 3 | 目录入口（见下） |
| 14 | `14_维护者/`（跨阶段·维护映射表与值班） | 0 | 目录入口（见下） |
| 15 | `15_维护记录/`（跨阶段·根因分析与复盘） | 1 | 目录入口（见下） |
| 16 | `16_设计模式/`（跨阶段·模式图谱） | 0 | 目录入口（见下） |
| 17 | `17_AI协作预设包/`（跨阶段·分「给人看/给AI看」两线 + 可安装 skills/） | 20 + 8 skill | 目录入口（见下） |
| 18 | `18_归档/`（跨阶段冷存储：已废弃设计文档归档，2026-09-15 自 `03_DESIGN_设计/` 提级） | 7 | 目录入口（见下） |
| 19 | `19_资产/`（跨阶段·文档站 CSS/JS/nav-data，构建产物，非文档；索引见 `19_资产/00_INDEX_资产-总目录.md`） | 8 | 机器生成 |

> 🔢 **2026-09-16 编号轴变更**：`docs/` 顶层原为「`NN_STAGE_` 阶段轴 + `_` 跨阶段轴」双轴，
> 现收敛为**统一编号轴**——`01`–`09` 是生命周期阶段，`10`–`19` 是跨阶段资产（不再是 `_` 前缀）。
> 真源 `[DESIGN-LAY-005]` §3.1。上表「文档数」为各目录下**非索引 `.md`** 的实测值（2026-09-16），
> 跨阶段目录的旧值（`10_规范` 记 77、`17_AI协作预设包` 记 12）已按实测更新。
> `12_模板`/`14_维护者`/`16_设计模式` 显示 0 是因为其主要内容是 `.json` 配置与资产而非 `.md`，非空目录。

> ✅ **本页与磁盘现实已对齐**（2026-09-08 实测）：「文档数」是各阶段目录下非索引 `.md` 的
> 实际文件数，「本索引已列」是本页实际链到的文档份数。七个被扫描阶段目录全部 100% 覆盖，
> `docs-index-complete` 实测为 **0**。上一轮遗留的 **`07_OPS_运维/` 102 份漏链**已在 2026-08-17
> 全部补齐；2026-09-08 本轮又补齐 **44 份**（`03_DESIGN_设计/` 43 + `04_IMPL_实现/` 1）——
> 这批是 2026-08-17 之后新增的设计文档没同步登记造成的，各分区末的「补登记」块即本轮补的。
> 该状态不靠人工记忆维持：由 `npm run check:layout` 的 `docs-index-complete` 规则实测，
> 计入 `scripts/ci/repo-layout-baseline.json` 基线（已下调至 0），只允许下降；
> 全量漏链名单跑 `node scripts/ci/check-repo-layout.js --list=docs-index-complete`。
> 新增阶段文档时**必须同时**在本页补一行，否则 `check:layout` 亮红灯。
>
> ⚠️ 文件名含**半角括号**的文档（如 `[OPS-MAN-166] cc(Claude Code)…`）在本页用
> `[标题](<路径>)` 尖括号形式链接：括号不能百分号编码（`docs-index-complete` 只解 `%5B`/`%5D`/`%20`），
> 裸括号又会截断 Markdown 链接，尖括号是唯一同时满足渲染与校验的写法。
>
> `02_CONCEPTS_概念入门/` 与 `09_STORY_修仙学AI/` **刻意不在本页逐篇点名**：这两个
> 小白向目录的可达性由 `npm run docs:check-beginner`（`scripts/docs/check_beginner_docs.js`）
> 保证——禁孤儿页、禁死链、禁无导航死胡同页，比「本页有没有这一行」更强。
> 本页只链它们的目录入口（见下一节）。`docs-index-complete` 规则对这两个目录同样豁免。

> 🧭 **换任何 AI 接手先看**：[`17_AI协作预设包/`](17_AI协作预设包/00_INDEX_总入口.md) — 严格区分**给人看**（怎么用/排错/选活/保命）与**给AI看**（可直接粘贴的开场白/铁律/错误自查/任务卡）；含两份总说明（人的一页速览 + AI 的一次读懂全局）；并附一套可 `khy skill import` 的 **skills/**（8 个指导弱模型现场使用 khy 的 skill）。适用于「只能用弱模型 / 陌生大模型、且靠 pip 分发」的维护场景。

> 📖 **想按「从启动到愿景」的认知顺序读懂架构**：[`[DESIGN-ARCH-063]` 对照《Claude Code 架构》一书读懂 Khy-OS](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS.md) — 借一本讲 Claude Code 架构的书的目录当骨架，逐章把「书里的 CC 概念」对齐到「khy 此刻真实的实现（文件:行）」，并如实标注相同/khy 特有/未做之处。它与本索引的**生命周期分类法互补**：本索引答「一个功能怎么落地」，那篇答「按认知顺序从启动一路读到 Agent-as-OS 愿景」。

## ⚖️ 规则与标准（改动前必读三篇）

**任何要改本仓库的人或 AI，动手前必须先读这三篇**：它们构成完整的治理三角 — 文档规范 + 代码层级 + 综合规则索引。

1. **[`[MGMT-STD-001]` 项目文档结构与索引铁律规范](08_MGMT_项目管理/MGMT-STD/[MGMT-STD-001] 项目文档结构与索引铁律规范.md)** — **文档侧单一真源**：① 根目录只允许 README（封闭白名单外的说明性文件必须归入 `docs/`）；② `docs/` 下每个子目录**必须**有一个排序首位的索引文件；③ 编号与命名**由 AI 动态决策**（感知目录既有惯例、确保逻辑连贯），严禁写死固定格式。守卫：`npm run check:layout`（`docs-index-complete` / `root-whitelist` / `docs-index-first` 规则）。

2. **[`[DESIGN-LAY-005]` 仓库层级板块规范](10_规范/DESIGN-LAY/[DESIGN-LAY-005] 仓库层级板块规范.md)** — **代码侧单一真源**：① 顶层目录的层级定位（L0 内核 → L1 启动器 → L2 业务逻辑 → L3 平台前端 → L4 内置应用 → L5 IDE 桥接 → L6 开发工具）；② 允许的依赖方向白名单（不是全序）；③ `docs/` 统一编号轴命名（`01`–`09` = 生命周期阶段，`10`–`19` = 跨阶段资产；2026-09-16 由双轴收敛）；④ 任务入口命名规约。守卫：`npm run check:layout`（`layer-registry` / `cross-layer-require` / `unresolved-require` 规则）。

3. **[`[OPS-MAN-169]` 项目规则总纲-命名·skill·权限·mcp](07_OPS_运维/OPS-MAN/[OPS-MAN-169] 项目规则总纲-命名·skill·权限·mcp.md)** — **一站式规则索引与导读**：把散落在 `CLAUDE.md` / `AGENTS.md` / `.ai/GUARDS.md` 与各处代码里的「项目规则」收拢到一张地图 — 红线（R1–R4：分支纪律、密钥防泄露、双渠道版本同步、上帝文件门）、行为准则（B1–B3：先想再写、目标驱动执行、外科手术式改动）、验收门禁（三守卫 + arch:god + 映射表覆盖）、板块层级速查、文档命名速查、Skill 规则（CC 斜杠命令 + khy 原生 SKILL.md 引擎 + 桥接）、权限规则（6 档 + critical gate + 弱模型护栏）、MCP 规则、双渠道版本同步。每一条规则都标了它的**强制真源**（代码读取点或章程原文）；规则语义**永远以真源为准**。

> 📌 **为什么是这三篇**：[MGMT-STD-001] 管文档怎么放、怎么命名、怎么索引；[DESIGN-LAY-005] 管代码怎么分层、哪层能调哪层、新文件该放哪；[OPS-MAN-169] 是上面两篇 + `CLAUDE.md` / `AGENTS.md` 的统一入口索引。读完这三篇，你就知道「红线在哪、规范怎么查、守卫怎么跑」。

## 🐣 完全新手从这里开始（概念入门 + 修仙故事）

如果你**没有编程/AI 基础**，别从上面的架构文档入手，先读这两套面向小白的材料：

- 📗 **[概念入门总览](02_CONCEPTS_概念入门/00_INDEX_概念入门-总览.md)** — 用生活比喻把 AI 助手背后的 **13 个核心概念**讲透：Agent、工具调用（Tool Calling）、工具循环（Tool Loop）、MCP、Skill（基础五篇）＋ LLM 大模型、Prompt、上下文与令牌、Embedding 向量、向量数据库、RAG、机器学习、深度学习（进阶八篇）。每篇都有比喻、图表、常见误区、动手小实验。
- 📖 **[《算道天书》：修仙学 AI](09_STORY_修仙学AI/00_INDEX_修仙学AI-总目录.md)** — 一部 14 章的修仙长篇小说，主人公孔浩原从山村药童修炼成 **AI 大师**，每个境界对应一个上面的概念，章末「凡人笔记」翻译回真实术语。**当爽文看会上头，当教材看会开窍。**

## 01_INIT_立项

> **清单真源**：本阶段完整清单（3 篇）见 [`00_INDEX_立项-分类索引.md`](01_INIT_立项/00_INDEX_立项-分类索引.md)；主索引此处只保留总纲/入口类与就近索引尚未收录的 0 篇补漏。（B8 去重，2026-09-18：主索引不再逐篇点名，`check-repo-layout` 的 `docs-index-complete` 已接受就近索引的覆盖。）



## 03_DESIGN_设计

> **清单真源**：本阶段完整清单（129 篇）见 [`00_INDEX_设计-分类索引.md`](03_DESIGN_设计/00_INDEX_设计-分类索引.md)；主索引此处只保留总纲/入口类与就近索引尚未收录的 40 篇补漏。（B8 去重，2026-09-18：主索引不再逐篇点名，`check-repo-layout` 的 `docs-index-complete` 已接受就近索引的覆盖。）
> **B9 按标签归夹（2026-09-18）**：本阶段内设计文档已按 `[TAG-XXX]` 标签归入 `03_DESIGN_设计/[TAG-XXX]/` 子目录；DR7 代码耦合文档（如 `[DESIGN-LAY-005]`、`[DESIGN-TOOL-002]`）留根目录不移动。子目录内文档由 `npm run docs:build` 的 `nav-data.js` 全量收录进站点导航，近索引只点名根级件。


- [`DESIGN-ARCH-024` khyos元帅双模式任命与约束规范（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-024] khyos元帅双模式任命与约束规范.md)
- [`DESIGN-ARCH-033` 模型自适应与双轨热插拔架构（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-033] 模型自适应与双轨热插拔架构.md)
- [`DESIGN-ARCH-035` 上下文永续与认知压缩引擎（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-035] 上下文永续与认知压缩引擎.md)
- [`DESIGN-ARCH-038` Khyos双轨淬火-确定性保底与模型辅助增强的Bug升维引擎（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-038] Khyos双轨淬火-确定性保底与模型辅助增强的Bug升维引擎.md)
- [`DESIGN-ARCH-039` Khyos环境共生-环境感知与原生亲和架构（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-039] Khyos环境共生-环境感知与原生亲和架构.md)
- [`DESIGN-ARCH-040` Khyos数据主权与极权路由-数据主权绝对论与单一权威注入网关（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-040] Khyos数据主权与极权路由-数据主权绝对论与单一权威注入网关.md)
- [`DESIGN-ARCH-042` Khyos自持基建-契约即文档与影响面评估与行为守卫（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-042] Khyos自持基建-契约即文档与影响面评估与行为守卫.md)
- [`DESIGN-ARCH-050` 项目整体意识与自驱收尾保障](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-050] 项目整体意识与自驱收尾保障.md)
- [`DESIGN-ARCH-063` 对照《Claude Code 架构》一书读懂 Khy-OS（书序架构阅读主线）](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS.md)
- [`DESIGN-LAY-005` 仓库层级板块规范](10_规范/DESIGN-LAY/[DESIGN-LAY-005] 仓库层级板块规范.md) — **顶层目录 L0–L6 分层、允许依赖边、`docs/` 统一编号轴命名、任务入口命名的单一真源**；新增文件或新增顶层目录前先读它，由 `npm run check:layout` 强制
- [`DESIGN-GOV-001` 治理总纲与可执行规则](10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md) — **既有治理规则的索引与缺口登记**：MOD、MEM、TOOL、ACP、API 五板块；不推翻既有单一真源；由 `node scripts/ci/check-gov-rules.js` 守住总纲与 CI 接线。
- [`DESIGN-ARCH-072` 任务最小闭环-裁决接线与交付台账](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-076] 任务最小闭环-裁决接线与交付台账.md) — 普通任务从「模型想停」到「交付完成」的最小闭环单一真源：收尾仲裁门（close/redrive/close_partial 三态）+ 交付台账 `khy deliveries`
- [`DESIGN-ARCH-073` khyos 核心任务循环-稳定交付总纲](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-077] khyos 核心任务循环-稳定交付总纲.md) — 任务从受理到交付的核心循环运行时契约（登记→执行→裁决→交付→台账 + 想停轮 20 道门序），`072` 的上位总纲
- [`DESIGN-PERF-001` khy-cli-交互流畅度修复方案-v1](03_DESIGN_设计/DESIGN-PERF/[DESIGN-PERF-001] khy-cli-交互流畅度修复方案-v1.md) — khy CLI 流畅度对位调研（10 处推断校正）与三阶段修复方案（fast-startup 默认化 / CLI bundle / 首 token 解耦），只立项未动码
- [`[DESIGN-RES-003]` 跨Agent技能MCP统一管理-阶段一调研](03_DESIGN_设计/DESIGN-RES/[DESIGN-RES-003] 跨Agent技能MCP统一管理-阶段一调研.md) — 只读调研：现有 `ccMcpBridge`/`ocMcpBridge`/`*SkillBridge` 只发现不写入，缺 agent 注册表与统一 import 原语；立法清单冻结前不动代码
- [`DESIGN-LEGISLATION`（未编号）跨Agent技能MCP统一管理-阶段二立法清单](03_DESIGN_设计/其它设计/[DESIGN-LEGISLATION] 跨Agent技能MCP统一管理-阶段二立法清单.md) — 阶段三实现的冻结依据：`khy unify` 的 export/import/list/sync 范围、MCP 与技能 bridge 注册表、存量纳管写入口；依据阶段一调研 §1-§5 与铁律 F1-F8

历史未编号件（保留原名，重命名须同步改写全部入站引用，属独立一轮工作）：

- [`ycode-inspiration-plan`（未编号）](03_DESIGN_设计/[DESIGN-ARCH-083] ycode-inspiration-plan 设计与实现记录.md)

2026-09-08 补登记（此前漏链，docs-index-complete 由此降为 0）：

- [`DESIGN-ARCH-072` 模型上下文窗口探测规范](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-072] 模型上下文窗口探测规范.md)
- [`DESIGN-ARCH-072` 项目规范化总纲](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-072] 项目规范化总纲.md)
- [`DESIGN-ARCH-073` 规范快速参考卡](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-073] 规范快速参考卡.md)
- [`DESIGN-ARCH-075` opencode高含金量功能教学与khy-os差距补齐路线](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-075] opencode高含金量功能教学与khy-os差距补齐路线.md)
- [`DESIGN-ARCH-076` 任务最小闭环-裁决接线与交付台账](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-076] 任务最小闭环-裁决接线与交付台账.md)
- [`DESIGN-ARCH-077` khyos 核心任务循环-稳定交付总纲](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-077] khyos 核心任务循环-稳定交付总纲.md)
- [`DESIGN-ARCH-079` TUI界面设计规范](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-079] TUI界面设计规范.md)
- [`DESIGN-ARCH-079` TUI组件实现提示词](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-079] TUI组件实现提示词.md)
- [`DESIGN-ARCH-080` 网页端信息架构与四页重设计-2026-09-08](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-080] 网页端信息架构与四页重设计-2026-09-08.md) — `apps/ai-frontend` IA 重构方案（Draft，冻结前不动 src）。调研 7 个同类项目实测源码（New API = `QuantumNous/new-api`、One API、1Panel、Nginx Proxy Manager、CLI Proxy API 管理中心、Chat2DB、AppFlowy Cloud）得出规范与例外：**7/7 无独立 admin 登录页、6/7 无独立 admin 前端、只有 2/7 有忘记密码页**。现状实测：42 处 API 调用指向不存在端点、`/usage` 与 `/pricing` 两整页空转、`/proxies` 菜单指向 NotFound、`routes/crossPlatform.js` 无鉴权且被裸 `fetch()` 调用、后端存在**两套并行的密码重置方案**而 CLI 调用的那套端点根本不存在、忘记密码前端 0 引用而后端已挂载、`workspace` 切换器是 7/7 项目里唯一的反模式
- [`DESIGN-ARCH-081` Claude Code TUI 1复刻实施计划](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-081] Claude Code TUI 1复刻实施计划.md) — CC TUI 1:1 复刻实施方案：品牌替换为 Khy，全面支持 OpenAI 协议
- [`DESIGN-ARCH-082` CC模式输入框与光标设计](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-082] CC模式输入框与光标设计.md) — 输入框布局、光标、多行输入、模式切换与占位符
- [`DESIGN-ARCH-083` CC模式表格与折叠设计](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-083] CC模式表格与折叠设计.md) — 表格显示与折叠/隐藏组件
- [`DESIGN-ARCH-084` CC模式注意力与选择设计](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-084] CC模式注意力与选择设计.md) — 强注意力引导、焦点管理与选择交互
- [`DESIGN-ARCH-085` CC模式子视图子菜单卡片与滚动设计](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-085] CC模式子视图子菜单卡片与滚动设计.md) — 子视图（Agent）、子菜单、卡片、滚动/复制/历史
- [`DESIGN-ARCH-086` CC TUI 复刻总计划与子任务跟踪](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-086] CC TUI 复刻总计划与子任务跟踪.md) — CC TUI 复刻工程的总计划文档，汇总 081–089 各子设计并跟踪实施进度
- [`DESIGN-ARCH-087` CC模式微交互与反馈设计](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-087] CC模式微交互与反馈设计.md) — 微交互、瞬态反馈与状态提示
- [`DESIGN-ARCH-088` CC快捷键系统RedoFork与执行偏差处理](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-088] CC快捷键系统RedoFork与执行偏差处理.md) — 快捷键系统、撤销/重做、分叉与执行偏差处理
- [`DESIGN-ARCH-089` TUI设计模式调研报告](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-089] TUI设计模式调研报告.md) — 100+ 开源 TUI 项目综合调研，提炼最佳实践指导 CC TUI 复刻
- [`DESIGN-PHILOSOPHY` 设计哲学总纲](03_DESIGN_设计/其它设计/[DESIGN-PHILOSOPHY] 设计哲学总纲.md)
- [`DESIGN-QUICK-REF` 设计模式速查卡](03_DESIGN_设计/其它设计/[DESIGN-QUICK-REF] 设计模式速查卡.md)

2026-09-10 补登记（此前漏链，`check:layout` 的 `docs-index-complete` 因此报 4）：

- [`DESIGN-ARCH-093` 密钥与智能体统一管理（工具矩阵与zcodeAdapter）设计规范](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-093] 密钥与智能体统一管理（工具矩阵与zcodeAdapter）设计规范.md) — 「只在 khy 配置」的密钥/Agent 统一管理：双投递模式（khy 网关中继优先、cc-switch 式同步兜底）+ 工具矩阵现状表 + zcodeAdapter 契约（zai 登录门/内联 key/双模型角色）；P1 已落地
- [`DESIGN-ARCH-094` Provider卡片枢纽（CardHub）GUI设计规范](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-094] Provider卡片枢纽（CardHub）GUI设计规范.md) — 本机全部 provider/agent 模型统一管理的卡片式 GUI（UI 风格参照 cc-switch，数据模型参照 Codex++）：独立应用 `apps/provider-hub`（不并入 khyos-desktop）、卡片 CRUD/模型拉取/工具矩阵/一键导入，M0–M3 TDD 排期
- [`DESIGN-ARCH-096` ycode 第二轮增量借鉴调研报告](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-096] ycode 第二轮增量借鉴调研报告.md) — 接续 [DESIGN-ARCH-083] 第一轮，对标 gitee 星瑶（xingyao-y-code）2026-09-08~13 共 74 提交增量：按回合撤销深化、星轨自动化「定时 agent 回合」、压缩提速、内置技能指纹升级、CLI 对齐、事件断点续传、权限按会话绑定 8 项逐区对照 + 行动项（仅调研未实施）
- [`DESIGN-ARCH-098` 系统提示词结构重设计-静态动态分层与缓存优化方案](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-098] 系统提示词结构重设计-静态动态分层与缓存优化方案.md) — 系统提示词按静态/动态四层分区重构与缓存优化的设计方案
- [`DESIGN-ARCH-099` 提示词架构横向调研与khy-os对齐方案](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-099] 提示词架构横向调研与khy-os对齐方案.md) — 提示词架构的横向对标调研与 khy-os 对齐方案
- [`DESIGN-ARCH-100` 模型列表真值校验与过滤规范](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-100] 模型列表真值校验与过滤规范.md) — 模型列表真值校验与过滤规范（本条目原误标为「TUI 终端界面重设计方案」并指向不存在的 `ARCH-100` 同名文件，2026-09-15 校正；该方案实为 `[DESIGN-ARCH-103]`）
- [`DESIGN-ARCH-101` TUI 交互与展示规则细则](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-101] TUI 交互与展示规则细则.md) — 把 TUI「何时出现/消失、显示什么、点击后如何、如何断行」六类离散行为规则收敛为单一真源（触发条件→表现→持续/终止→边界四要素）
- [`DESIGN-CPA-001` CPA 反代集成方案](03_DESIGN_设计/DESIGN-CPA/[DESIGN-CPA-001] CPA 反代集成方案.md) — CPA 反代集成方案设计
- [`DESIGN-CPA-002` CPA+NewAPI 分层架构实施方案](03_DESIGN_设计/DESIGN-CPA/[DESIGN-CPA-002] CPA+NewAPI 分层架构实施方案.md) — CPA 接入层 + New API 治理层的调研现状/架构/文件清单/四 Phase 实施顺序/验收与风险（只调研未写码）
- [`DESIGN-CPA-003` CPA接入层+NewAPI治理层分层架构](03_DESIGN_设计/DESIGN-CPA/[DESIGN-CPA-003] CPA接入层+NewAPI治理层分层架构.md) — CPA 接入层与 NewAPI 治理层分层架构
- [`DEPLOY-0102` CPA+NewAPI分层架构快速指南](06_DEPLOY_部署/DEPLOY/[DEPLOY-0102] CPA+NewAPI分层架构快速指南.md) — CPA/NewAPI 分层架构指引（原 `06A_GUIDE_指南` 已于 2026-09-15 并入 `06_DEPLOY_部署`，目录已删除）
- [`DEPLOY-0103` CPA集成快速指南](06_DEPLOY_部署/DEPLOY/[DEPLOY-0103] CPA集成快速指南.md) — CPA 集成快速上手（与 provider-hub 集成版）

2026-09-15 整理登记（撞号修复 + 漏链补齐，`docs-index-complete` 实测归零）：

- ⚠️ 原 `DESIGN-ARCH-085` Git规范与自动化治理 已迁入 `10_规范/` 改编号为 `[DESIGN-GIT-003]`（`085` 归 CC模式子视图子菜单卡片与滚动设计）；原 `DESIGN-ARCH-082` 后端分层架构规范 已改编号为 `[DESIGN-LAY-001]`；原 `DESIGN-PERF-001` khy-cli-交互流畅度修复方案 已改编号为 `[DESIGN-PERF-002]`（`PERF-001` 归 `10_规范/` 性能规范）
- [`DESIGN-ARCH-102` Khy TUI 统一规则手册](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-102] Khy TUI 统一规则手册.md)
- [`DESIGN-ARCH-103` TUI 终端界面重设计方案](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-103] TUI 终端界面重设计方案.md)
- [`DESIGN-ARCH-105` ycode 第三轮增量借鉴调研报告](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-105] ycode 第三轮增量借鉴调研报告.md)
- [`DESIGN-ARCH-106` 项目规范化总纲](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-106] 项目规范化总纲.md) — 原占用 `072`，因与模型上下文窗口探测规范撞号改号
- [`DESIGN-ARCH-107` TUI组件实现提示词](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-107] TUI组件实现提示词.md) — 原占用 `079`，因与 TUI界面设计规范撞号改号
- [`DESIGN-ARCH-110` TUI-CLASSIC-SYNC 设计笔记](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-110] TUI-CLASSIC-SYNC 设计笔记.md) — 原在 `docs/design/`，该目录已合并删除
- [`DESIGN-ARCH-114` CLI 错误标准化规范](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-114] CLI 错误标准化规范.md) — 补齐 API-003（机器面）/ COMMS-004（进程面）之后的**人面**：CLI/TUI 失败展示的机器码登记表、结构化失败信封字段规约、三屏渲染秩序（推广清单不得占首屏）、以及「钉选优先的严格边界」；规则 `RUNTIME-005`，叶子 `cliFailureEnvelope.js`
- [`DESIGN-ARCH-116` khyos-插件系统契约(@khy/plugin-sdk)](03_DESIGN_设计/[DESIGN-ARCH-116] khyos-插件系统契约(@khy-plugin-sdk).md) — 自有插件系统契约单一真源：manifest 4 必填字段（name / namespace / engines.khy / main）、发现源 6 路的 eager/lazy 边界、命名空间 + 版本门控；落地件 `platform/packages/plugin-sdk/`，与 `[DESIGN-TOOL-002]`（拓展契约）分工互补、与 `ccSkillBridge`（借 CC 生态）并行
- [`DESIGN-ARCH-117` khy-多端入口矩阵](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-117] khy-多端入口矩阵.md) — 回答「khy 有哪些端、入口在哪、怎么起、怎么构建、现在能不能用」：把此前五份互相矛盾的端定义（`crossLauncher.js` 硬编码表 / `android_build.py` / `khy desktop` 与 `khy mobile` 两个同名不同义命令 / 三套桌面线）收敛成一份带检活的登记表。落点 L2 `services/backend/src/services/entrypoints/`（不新建顶层目录）、仓库级 vs 本机级定档分离、产物坐标只存指针不复制；含幽灵端 `apps/khy-mobile` 等四条未收口清单
- [`DESIGN-ARCH-118` HQ 能力吸收与多机协作规范](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-118] HQ 能力吸收与多机协作规范.md) — 把指挥部仓库 `khy-os-hq` 的能力**吸收**进 khy-os 单仓（非搬家）后废弃 HQ：状态真源落 `.ai/hq/`、命令面 `khy hq`（10 子命令 + 状态机 + 多机租约）、自动同步落 `.khyos/autopull.js`。含四条硬约束死因（D1 向上四级推算 `PORTABLE_ROOT` / D2 递归自扫）、`DOCS-003` D9 补上 HQ `drivability` 丢弃后的孪生面机械保障、步骤 1–3 已完成记录与「诚实代价」清单
- [`DESIGN-ARCH-124` CC 模式剪贴板复制能力补齐提案](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-124] CC 模式剪贴板复制能力补齐提案.md) — CC 模式（`KHY_CC_TUI=1`）下剪贴板底层通道（`utils/ccClipboard.writeClipboard`）与选区算法叶子（`selection.js`）的补齐提案（**提案待评审、尚未编码**）；上游依赖 `[DESIGN-ARCH-119]`、`[DESIGN-ARCH-111]`；属 TUI 设计族，总纲见 `[DESIGN-ARCH-122]`
- [`DESIGN-ARCH-122` TUI 设计族总纲](03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-122] TUI 设计族总纲.md) — `docs/03_DESIGN_设计/` 中 TUI 设计族的**唯一导航入口与 scope 裁决真源**：20 个编号 / 21 个文件分 5 组（设计规范 · CC 复刻 · 组件设计 · 调研痛点 · 启动与可用性修复）；裁决重叠归属（规则真源 = `[DESIGN-ARCH-102]`、`[DESIGN-ARCH-079]` 已降级、`[DESIGN-ARCH-119]` 同号双文件勿合并），各子篇已加「隶属」头指向本文件

## 10_规范/（跨阶段规范目录，2026-09-10 自 `03_DESIGN_设计/` 拆出）

> 全部独立编号的规范族（`DESIGN-A11Y/API/ACP/BACKUP/CACHE/CICD/COMM/DB/DEP/DEPLOY/DOC/ENV/ERR/
> FE/GIT/I18N/INDEX/LAY/LOG/MEM/MONITOR/MS/NAM/OUT/PERF/PRIV/REVIEW/SEC/TEST/TOOL` + 未编号协议件
> `FILE-FORMAT-PROTOCOL`、`RELIABILITY-PROTOCOL`）已迁入 [`10_规范/`](10_规范/00_INDEX_规范-总目录.md)
> （`10`–`19` 编号段 = 跨阶段资产，见 `[DESIGN-LAY-005]` §3.1；该目录不在 `docs-index-complete`
> 的阶段扫描范围，完整性由其目录内 `00_INDEX`（含情景速查与文件清单两张表）维护）。ARCH 编号的设计族与
> 治理单一真源留在 `03_DESIGN_设计/`。台账见 `[IMPL-RPT-049]`。

- [10_规范-总目录（目录入口）](10_规范/00_INDEX_规范-总目录.md) — **唯一入口**：§2「做什么 → 看哪篇 → 一条红线」情景速查 + §3 编号↔标题↔状态对照表（原 `[DESIGN-INDEX-001]` 已于 2026-09-17 并入本篇）
- [`DESIGN-GIT-003` Git 自动化治理规范](10_规范/DESIGN-GIT/[DESIGN-GIT-003] Git 自动化治理规范.md) — 原 `03_DESIGN_设计/[DESIGN-ARCH-085]`，因 `085` 被占用且属规范性质而迁入
- [`DESIGN-LAY-001` 后端分层架构规范](10_规范/DESIGN-LAY/[DESIGN-LAY-001] 后端分层架构规范.md) — 原 `DESIGN-ARCH-082`，与 `03_DESIGN_设计/[DESIGN-ARCH-082] CC模式输入框与光标设计` 跨目录撞号，改用 LAY 域码退出 ARCH 序列
- [`DESIGN-LAY-002` 目录层级与文件归类规范](10_规范/DESIGN-LAY/[DESIGN-LAY-002] 目录层级与文件归类规范.md) — **放新文件前先看这篇**：ARCH-068 层级之外的四个空白——可见性轴 PUB/INT/PRV（谁能依赖我）、分层→命名风格映射、扩展名归类矩阵、完整典型目录树；含 `_` 前缀三义裁定与三条存量冲突裁决（HTML 孪生是否入库、JS 文件名 camelCase 优先、`_source/` 注册表幻影）；规则登记为 `LAYOUT-001`
- [`DESIGN-LAY-003` 仓库整理与巡检规范](10_规范/DESIGN-LAY/[DESIGN-LAY-003] 仓库整理与巡检规范.md) — 存量杂物（生成物/临时物/产物）回收；HK-1–HK-8 红线、只隔离不删除；规则登记为 `LAYOUT-004`
- [`DESIGN-LAY-004` 构建产物单一根规范](10_规范/DESIGN-LAY/[DESIGN-LAY-004] 构建产物单一根规范.md) — **产物放哪、删了怎么回来**：唯一产物根 `entries/`（2026-09-18 由 `_build/` 迁入）、三条不变量（可删除性 / 零越界 / 非寄生棘轮）、`BUILD-OUTPUTS.json` 一份真源派生三处清单；实测证据含「`check-build-artifacts` 绿着放行 10 个已跟踪产物」「`clean.js` 漏登记 17 条」「`.gitignore` 指向已改名路径致 3.2 MB 产物裸奔」；规则登记为 `LAYOUT-005`
- [`DESIGN-PERF-001` 性能规范](10_规范/[DESIGN-PERF-001] 性能规范.md) — 保留 `PERF-001`；设计提案 `[DESIGN-PERF-002]` 在 `03_DESIGN_设计/`
- [`DESIGN-MEM-006` 记忆与维护元数据生命周期规范](10_规范/DESIGN-MEM/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md) — GOV-MEM-001–004 契约真源：session/persistent 判定口径、persistent 记录五字段格式、记忆与 `.ai/` 元数据的指定读写入口、清理与生命周期；含 UC-001（`.ai/` 三件套缺失）裁决
- [`DESIGN-TOOL-001` 工具与扩展升级废弃规范](10_规范/其它规范/[DESIGN-TOOL-001] 工具与扩展升级废弃规范.md) — GOV-TOOL-003 契约真源：`khy.extension.json` 的 `lifecycle` 块冻结、工具改名/移除的兼容期与迁移说明、manifest 版本策略与最小权限边界
- [`DESIGN-ACP-001` ACP消息元数据与终态契约](10_规范/其它规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md) — GOV-ACP-001/003/004 契约真源 + UC-004 裁决：请求/通知/响应三态信封拆分、`meta`（traceId/callId/deadline/idempotencyKey）元数据、超时/取消/重试/关闭的可观察终态与错误码表
- [`DESIGN-API-002` 外部错误信封与版本弃用政策](10_规范/DESIGN-API/[DESIGN-API-002] 外部错误信封与版本弃用政策.md) — GOV-API-001–004 契约真源 + UC-005 裁决：内部 adapter 形状与外部 API 的边界、统一错误信封与机器码登记表、SSE/WS 终态枚举、API 版本化与弃用政策
- [`FILE-FORMAT-PROTOCOL`（未编号）](10_规范/其它规范/FILE-FORMAT-PROTOCOL.md) — 文件格式使用协议（JSON/YAML/JSONL/…各自的职责边界），由 `check-change-safety` 门控
- [`RELIABILITY-PROTOCOL`（未编号）](10_规范/其它规范/RELIABILITY-PROTOCOL.md)
- [`DESIGN-DOC-003` README 内容规范](10_规范/DESIGN-DOC/[DESIGN-DOC-003] README 内容规范.md) — **写 README 前先看这篇**：README 不得成为第二真源（全域禁项表 + 指针标识判据）、T0/T1/T2 档位判据与必答清单（7/5/3 问）；规则登记为 `DOCS-004`（本期 `gate=manual` 人工评审，执行器设计见 `[IMPL-DOC-002]`）
- [`DESIGN-SKILL-001` Skill 编写规范](10_规范/其它规范/[DESIGN-SKILL-001] Skill 编写规范.md) — **写 Skill 前先看这篇**：description 四段式（khyos 把「触发短语前置」提到第 0 段，要求落在前 60 字符内）、1024 字符上限、`when_to_use` 必填且 ≤120 字符、任务型必须 `disableModelInvocation`、`allowed-tools` 必须 `Bash(<prefix>:*)` 最小权限；含两套语法（Skill 闸门 `:*` vs 权限 `patternRules` glob）不可混用的实测陷阱；规则 `SKILL-001`
- [`DESIGN-AGENT-001` 子智能体交接契约](10_规范/其它规范/[DESIGN-AGENT-001] 子智能体交接契约.md) — **派发子智能体前先看这篇**：子智能体之间是**报文传输而非共享内存**（机制真源 `AgentTool/index.js:317` 明写子体只收到 compact summary、NOT the full conversation），故必须显式传 `parent_context_summary` 并声明所有权；含下行派发信封 / 上行回报信封（结论·证据·未决·风险）与 26 个内置 agent 的五模式映射（`audit→fix` 为流水线型范例）；规则 `AGENT-001`
- [`DESIGN-PROCESS-002` 新机制落地四阶段流程](10_规范/其它规范/[DESIGN-PROCESS-002] 新机制落地四阶段流程.md) — **给新机制开门禁前先看这篇**：拦截型机制禁止直接进 S3，须走 S1 观察者 → S2 顾问 → S3 门禁 → S4 主动修复；**毕业以样本量计而非时间**（S1 ≥200 事件 / S2 误报 <10% / S3 豁免 <20%），因 khyos 单机单用户无团队接受度维度；含 Token 经济学判据卡（收益优先级重排为「上下文窗口保护 > 响应质量 > 成本」）与 `.khy/` 备份回滚前置；规则 `PROCESS-006`

## 04_IMPL_实现

> **清单真源**：本阶段完整清单（52 篇）见 [`00_INDEX_实现-分类索引.md`](04_IMPL_实现/00_INDEX_实现-分类索引.md)；主索引此处只保留总纲/入口类与就近索引尚未收录的 3 篇补漏。（B8 去重，2026-09-18：主索引不再逐篇点名，`check-repo-layout` 的 `docs-index-complete` 已接受就近索引的覆盖。）


- [`IMPL-RPT-040` CC-zip1 命令对齐账本](04_IMPL_实现/IMPL-RPT/[IMPL-RPT-040] CC-zip1 命令对齐账本.md)
- [`IMPL-RPT-045` TUI按钮点击调研与鼠标/历史回溯设计决策-2026-09-05](04_IMPL_实现/IMPL-RPT/[IMPL-RPT-045] TUI按钮点击调研与鼠标历史回溯设计决策-2026-09-05.md) — 用户调研 ratatui GitHub 示例后询问 khyos 方案；结论：khyos 已有 mouseButtons.js（二态门控）+ arrowRouting.js（context 栈）+ scrollbackPreserve（无残影），无需引入 ratatui
- [`IMPL-RPT-050` 规范简洁化与情景速查-2026-09-10](04_IMPL_实现/IMPL-RPT/[IMPL-RPT-050] 规范简洁化与情景速查-2026-09-10.md) — 4 篇 GOV 契约规范（MEM-006/TOOL-001/ACP-001/API-002）按红线骨架压缩重写（§ 锚点保留）；规范目录增设「情景 → 规范 → 一条红线」速查入口（24 情景，2026-09-17 并入 `10_规范/00_INDEX_规范-总目录.md` §2）；`DESIGN-DOC-001` 新增 §12 规范骨架（新规范 ≤150 行、条文可判定）

> 编号 034–039 为历史断档（删除后不回收，见 [MGMT-STD-001] 第 2.4 条），非漏链。

2026-09-08 补登记（此前漏链，docs-index-complete 由此降为 0）：

- [`IMPL-MIG-001` 命令注册表迁移指南](04_IMPL_实现/其它实现/[IMPL-MIG-001] 命令注册表迁移指南.md)

## 05_TEST_测试

> **清单真源**：本阶段完整清单（11 篇）见 [`00_INDEX_测试-分类索引.md`](05_TEST_测试/00_INDEX_测试-分类索引.md)；主索引此处只保留总纲/入口类与就近索引尚未收录的 0 篇补漏。（B8 去重，2026-09-18：主索引不再逐篇点名，`check-repo-layout` 的 `docs-index-complete` 已接受就近索引的覆盖。）



## 06_DEPLOY_部署

> **清单真源**：本阶段完整清单（25 篇）见 [`00_INDEX_部署-分类索引.md`](06_DEPLOY_部署/00_INDEX_部署-分类索引.md)；主索引此处只保留总纲/入口类与就近索引尚未收录的 2 篇补漏。（B8 去重，2026-09-18：主索引不再逐篇点名，`check-repo-layout` 的 `docs-index-complete` 已接受就近索引的覆盖。）


- [`PORTABLE`（未编号）便携化打包与启动](06_DEPLOY_部署/DEPLOY/[DEPLOY-0101] PORTABLE.md) — 源码三档启动 + 发布版一键打包 + 数据宿主隔离
- [`LAN-FIREWALL`（未编号）局域网登录防火墙放行](06_DEPLOY_部署/DEPLOY/[DEPLOY-0100] LAN-FIREWALL.md) — ARCH-074 配套文档：ai-backend 默认绑 0.0.0.0，让 LAN 上其他机器可用账号密码登录；本文给出 Windows / macOS / Linux 三平台防火墙放行命令

## 07_OPS_运维

> **清单真源**：本阶段完整清单（186 篇）见 [`00_INDEX_运维-分类索引.md`](07_OPS_运维/00_INDEX_运维-分类索引.md)；主索引此处只保留总纲/入口类与就近索引尚未收录的 0 篇补漏。（B8 去重，2026-09-18：主索引不再逐篇点名，`check-repo-layout` 的 `docs-index-complete` 已接受就近索引的覆盖。）


> 📦 **pip 安装从这里开始**：[`OPS-MAN-027` 快速开始](07_OPS_运维/OPS-MAN/[OPS-MAN-027] 快速开始.md) → [`OPS-MAN-043` 从0到高手](07_OPS_运维/OPS-MAN/[OPS-MAN-043] 从0到高手-新手成长路线与pip安装后清单.md) ⭐ → [`OPS-MAN-023` 完整功能清单](07_OPS_运维/OPS-MAN/[OPS-MAN-023] pip安装后-完整功能清单.md) → [`OPS-MAN-024` 按需配置体验](07_OPS_运维/OPS-MAN/[OPS-MAN-024] pip安装后-按需配置体验.md)；门槛与还原见 [`OPS-MAN-028` 环境要求](07_OPS_运维/OPS-MAN/[OPS-MAN-028] 环境要求.md) / [`OPS-MAN-037` 完整还原](07_OPS_运维/OPS-MAN/[OPS-MAN-037] pip安装后-完整还原与全功能开启指南.md)。

> 🗂️ **本区 178 份怎么读**：001–070 是**使用与配置手册**（上手、指南、速查）；071–164 多为**单点能力的落地记录**，
> 按族群成串阅读更省力 —— 还原/离机自检族（075·076·079·082·084–090·095·105·107·108·110·113·114·117·119·128·130·133）多由
> `scripts/restore-*.js --gen-doc` 确定性生成，**请勿手改**；OCR 兜底诚实与显示降噪族（104·109·111·112·115·116·118·120·122·124·126·127·132·134·138·140·142·144·145·148·150·159·161·164）；
> 读前防卡死守卫族（121·123·125·129·143·146·147·149）；波次调度与结果诚实族（083·087·091–094·097–099·101）；
> 孤儿能力接线族（151–158·160·162·163）。165 以后是**新增手册**（个性化、消息、技能、MCP、任务入口、备份恢复）。

未编号运维条目（2026-09-10 补登记，此前漏链）：

- [disaster-recovery 依赖清单](07_OPS_运维/OPS-MAN/[OPS-MAN-201] dependencies.html) — 灾备关键依赖：基础设施、外部服务与故障半径
- [On-Call 值班表](07_OPS_运维/OPS-MAN/[OPS-MAN-202] oncall.html) — 当前值班轮换、升级路径与值班职责
- [规范代码 Enforcement 指南](07_OPS_运维/OPS-MAN/[OPS-MAN-203] standards-enforcement.html) — 架构总览、守卫脚本清单与 P0 阻断级规范守卫
- [CI Gate 技术债清理报告](07_OPS_运维/OPS-MAN/[OPS-MAN-204] technical-debt-report.html) — CI 门禁技术债总览与分规则统计
- [工作树清洁方案](07_OPS_运维/OPS-MAN/[OPS-MAN-206] 工作树清洁方案.html) — 工作树长期变脏的四条根因（HTML 孪生漂移 / 忽略规则缺口 / 根目录怪文件 / pre-commit 只见暂存区）与「四层分离」对策 M1–M7

- [`OPS-MAN-073` 离机渠道启动入口契约自检清单](07_OPS_运维/OPS-MAN/[OPS-MAN-073] 离机渠道启动入口契约自检清单.md)
- [`OPS-MAN-169` 项目规则总纲-命名·skill·权限·mcp](07_OPS_运维/OPS-MAN/[OPS-MAN-169] 项目规则总纲-命名·skill·权限·mcp.md)
- [`OPS-MAN-174` 任务入口总表](07_OPS_运维/OPS-MAN/[OPS-MAN-174] 任务入口总表.md) — 根 `package.json` 每条 `npm run` 入口：跑哪个脚本、守住什么、何时跑，附旧名→新名对照
- [`OPS-MAN-200` config-auto-repair](07_OPS_运维/OPS-MAN/[OPS-MAN-200] config-auto-repair.md) — 启动时自动检测并修复网关配置问题，含手动重置入口

2026-09-15 补登记（此前漏链，`check:layout` 的 `docs-index-complete` 因此报 15）：

- [`OPS-MAN-207` 还原子系统总纲](07_OPS_运维/OPS-MAN/[OPS-MAN-207] 还原子系统总纲.md) — `docs/07_OPS_运维/` 中**还原子系统**（23 篇 / 5 组）的**唯一导航入口与 scope 裁决真源**；给出生成层 18 篇 ↔ `scripts/restore/*.js` 的映射表与「生成层不可手改、手写层 5 篇可编辑」的边界；含 DR7 约束（路径被代码当常量引用，禁移动/重命名）
- [`OPS-MAN-208` OCR 兜底族总纲](07_OPS_运维/OPS-MAN/[OPS-MAN-208] OCR 兜底族总纲.md) — `docs/07_OPS_运维/` 中 **OCR 兜底族**（17 篇 / 3 组）的**唯一导航入口与 scope 裁决真源**；三功能组为「兜底能力与质量边界 / 告知与透明度 / 纠正与降噪」；含代码耦合表（127/138/140/148→`flagRegistry.js`、132/142/144/148→`aiGatewayGenerateMethod.js`、126→`debt-ledger.json`），故受 DR7 约束不物理合并
- [`OPS-MAN-209` AI 供应商接入族总纲](07_OPS_运维/OPS-MAN/[OPS-MAN-209] AI 供应商接入族总纲.md) — **AI 供应商接入族**（4 篇 + 1 邻接）的唯一导航入口；三层分工为「速配 `205` / 流程 `172`+`032` / 对账 `096`」；声明端点与模型清单的数值真源在代码（`providerPresets.js` / `serviceDefaults.js`），`096` 属 `--gen-doc` 生成层禁手改

## 08_MGMT_项目管理

> **清单真源**：本阶段完整清单（52 篇）见 [`00_INDEX_项目管理-分类索引.md`](08_MGMT_项目管理/00_INDEX_项目管理-分类索引.md)；主索引此处只保留总纲/入口类与就近索引尚未收录的 0 篇补漏。（B8 去重，2026-09-18：主索引不再逐篇点名，`check-repo-layout` 的 `docs-index-complete` 已接受就近索引的覆盖。）


- [`MGMT-STD-001` 项目文档结构与索引铁律规范](08_MGMT_项目管理/MGMT-STD/[MGMT-STD-001] 项目文档结构与索引铁律规范.md)
- [`MGMT-STD-007` 文档规则总纲](08_MGMT_项目管理/MGMT-STD/[MGMT-STD-007] 文档规则总纲.md)
- [`MGMT-STD-008` 规则编写与管理规范（元规则）](08_MGMT_项目管理/MGMT-STD/[MGMT-STD-008] 规则编写与管理规范（元规则）.md)


## AI协作预设包（跨阶段 · 分「给人看 / 给AI看」两线）

> 用途：在「只能用弱模型/陌生大模型、且靠 pip 分发」的场景下继续维护本项目。
> **严格区分受众**：`给人看/` 是你自己的操作与决策；`给AI看/` 是可直接整段粘贴给 AI 的内容。

- [总入口](17_AI协作预设包/00_INDEX_总入口.md)

**🚀 先看两份总说明（最快掌握）**
- 🧑 [总说明-一页速览（给人）](17_AI协作预设包/给人看/总说明-一页速览.md) — 你自己 30 秒看懂全局
- 🤖 [总说明-一次读懂全局（给AI）](17_AI协作预设包/给AI看/总说明-一次读懂全局.md) — 整段发给 AI 即读懂全貌

**🧑 给人看/（你先从这里开始）**
- [总说明-一页速览](17_AI协作预设包/给人看/总说明-一页速览.md)
- [使用说明-怎么用这套包](17_AI协作预设包/给人看/使用说明-怎么用这套包.md)
- [排错速查-给人](17_AI协作预设包/给人看/排错速查-给人.md)
- [发展路径-决策与选活](17_AI协作预设包/给人看/发展路径-决策与选活.md)
- [命脉自保清单-给人](17_AI协作预设包/给人看/命脉自保清单-给人.md)
- [长任务提示词库-给人](17_AI协作预设包/给人看/长任务提示词库-给人.md) — 9 条长任务/无人值守/断点续跑提示词，全部对齐 Boulder 断点、错误分类引擎、熔断与 RELIABILITY-PROTOCOL 七大约束。

**🤖 给AI看/（复制里面内容发给 AI）**
- [总说明-一次读懂全局](17_AI协作预设包/给AI看/总说明-一次读懂全局.md)
- [项目情况说明-开场白](17_AI协作预设包/给AI看/项目情况说明-开场白.md)
- [协作铁律](17_AI协作预设包/给AI看/协作铁律.md)
- [错误自查手册](17_AI协作预设包/给AI看/错误自查手册.md)
- [任务派发卡](17_AI协作预设包/给AI看/任务派发卡.md)

**🧩 skills/（装进 khy 指导弱模型现场执行）**
- [skills 集合总说明](17_AI协作预设包/skills/00_INDEX_技能包-总目录.md) — 8 个可安装 skill：onboarding / safe-change / weak-model-guardrails / pick-task / troubleshoot / gateway-fix / release-safety / honest-closure。装法：`khy skill import <目录>` 或放 `~/.khy/skills/`。
