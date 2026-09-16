# 📚 Khy-OS 文档索引

> 本索引为文档总入口，按「阶段 → 类型 → 序号」归类，命名格式 `[阶段-类型-序号] 中文名`（更新于 2026-09-08）。
> 各阶段目录另设 `00_INDEX_*` 分类索引作为该目录的就近导航入口。

> 📈 **首次克隆后请跑一次 `npm run docs:build`**：图表引擎 `docs/_assets/mermaid.min.js`
> 是 `scripts/docs/mermaid-embed/` 的构建产物、不进 git，在重建之前所有 Mermaid 图表区域留白。

## 阶段总览

| 序号 | 阶段目录 | 文档数 | 本索引已列 |
|---|---|---:|---:|
| 01 | `01_INIT_立项/` | 3 | 3 |
| 02 | `02_CONCEPTS_概念入门/` | 32 | 目录入口（见下） |
| 03 | `03_DESIGN_设计/` | 117 | 见分区 |
| 04 | `04_IMPL_实现/` | 47 | 47 |
| 05 | `05_TEST_测试/` | 11 | 11 |
| 06 | `06_DEPLOY_部署/` | 25 | 25 |
| 07 | `07_OPS_运维/` | 182 | 182 |
| 08 | `08_MGMT_项目管理/` | 48 | 48 |
| 09 | `09_STORY_修仙学AI/` | 29 | 目录入口（见下） |
| — | `_archive/`（跨阶段冷存储：已废弃设计文档归档，2026-09-15 自 `03_DESIGN_设计/` 提级） | 7 | 目录入口（见下） |
| — | `_AI协作预设包/`（跨阶段·分「给人看/给AI看」两线 + 可安装 skills/） | 12 文档 + 8 skill | — |
| — | `_规范/`（跨阶段规范目录，2026-09-10 自 `03_DESIGN_设计/` 拆出的全部规范族） | 77 | 目录入口（见下） |

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

> 🧭 **换任何 AI 接手先看**：[`_AI协作预设包/`](_AI协作预设包/00_INDEX_总入口.md) — 严格区分**给人看**（怎么用/排错/选活/保命）与**给AI看**（可直接粘贴的开场白/铁律/错误自查/任务卡）；含两份总说明（人的一页速览 + AI 的一次读懂全局）；并附一套可 `khy skill import` 的 **skills/**（8 个指导弱模型现场使用 khy 的 skill）。适用于「只能用弱模型 / 陌生大模型、且靠 pip 分发」的维护场景。

> 📖 **想按「从启动到愿景」的认知顺序读懂架构**：[`[DESIGN-ARCH-063]` 对照《Claude Code 架构》一书读懂 Khy-OS](03_DESIGN_设计/[DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS.md) — 借一本讲 Claude Code 架构的书的目录当骨架，逐章把「书里的 CC 概念」对齐到「khy 此刻真实的实现（文件:行）」，并如实标注相同/khy 特有/未做之处。它与本索引的**生命周期分类法互补**：本索引答「一个功能怎么落地」，那篇答「按认知顺序从启动一路读到 Agent-as-OS 愿景」。

## ⚖️ 规则与标准（改动前必读三篇）

**任何要改本仓库的人或 AI，动手前必须先读这三篇**：它们构成完整的治理三角 — 文档规范 + 代码层级 + 综合规则索引。

1. **[`[MGMT-STD-001]` 项目文档结构与索引铁律规范](08_MGMT_项目管理/[MGMT-STD-001] 项目文档结构与索引铁律规范.md)** — **文档侧单一真源**：① 根目录只允许 README（封闭白名单外的说明性文件必须归入 `docs/`）；② `docs/` 下每个子目录**必须**有一个排序首位的索引文件；③ 编号与命名**由 AI 动态决策**（感知目录既有惯例、确保逻辑连贯），严禁写死固定格式。守卫：`npm run check:layout`（`docs-index-complete` / `root-whitelist` / `docs-index-first` 规则）。

2. **[`[DESIGN-ARCH-068]` 仓库层级板块规范](03_DESIGN_设计/[DESIGN-ARCH-068] 仓库层级板块规范.md)** — **代码侧单一真源**：① 顶层目录的层级定位（L0 内核 → L1 启动器 → L2 业务逻辑 → L3 平台前端 → L4 内置应用 → L5 IDE 桥接 → L6 开发工具）；② 允许的依赖方向白名单（不是全序）；③ `docs/` 两轴命名（编号轴 `NN_STAGE_` 是生命周期阶段，`_` 前缀轴是跨阶段资产）；④ 任务入口命名规约。守卫：`npm run check:layout`（`layer-registry` / `cross-layer-require` / `unresolved-require` 规则）。

3. **[`[OPS-MAN-169]` 项目规则总纲-命名·skill·权限·mcp](07_OPS_运维/[OPS-MAN-169] 项目规则总纲-命名·skill·权限·mcp.md)** — **一站式规则索引与导读**：把散落在 `CLAUDE.md` / `AGENTS.md` / `.ai/GUARDS.md` 与各处代码里的「项目规则」收拢到一张地图 — 红线（R1–R4：分支纪律、密钥防泄露、双渠道版本同步、上帝文件门）、行为准则（B1–B3：先想再写、目标驱动执行、外科手术式改动）、验收门禁（三守卫 + arch:god + 映射表覆盖）、板块层级速查、文档命名速查、Skill 规则（CC 斜杠命令 + khy 原生 SKILL.md 引擎 + 桥接）、权限规则（6 档 + critical gate + 弱模型护栏）、MCP 规则、双渠道版本同步。每一条规则都标了它的**强制真源**（代码读取点或章程原文）；规则语义**永远以真源为准**。

> 📌 **为什么是这三篇**：[MGMT-STD-001] 管文档怎么放、怎么命名、怎么索引；[DESIGN-ARCH-068] 管代码怎么分层、哪层能调哪层、新文件该放哪；[OPS-MAN-169] 是上面两篇 + `CLAUDE.md` / `AGENTS.md` 的统一入口索引。读完这三篇，你就知道「红线在哪、规范怎么查、守卫怎么跑」。

## 🐣 完全新手从这里开始（概念入门 + 修仙故事）

如果你**没有编程/AI 基础**，别从上面的架构文档入手，先读这两套面向小白的材料：

- 📗 **[概念入门总览](02_CONCEPTS_概念入门/00_INDEX_概念入门-总览.md)** — 用生活比喻把 AI 助手背后的 **13 个核心概念**讲透：Agent、工具调用（Tool Calling）、工具循环（Tool Loop）、MCP、Skill（基础五篇）＋ LLM 大模型、Prompt、上下文与令牌、Embedding 向量、向量数据库、RAG、机器学习、深度学习（进阶八篇）。每篇都有比喻、图表、常见误区、动手小实验。
- 📖 **[《算道天书》：修仙学 AI](09_STORY_修仙学AI/00_INDEX_修仙学AI-总目录.md)** — 一部 14 章的修仙长篇小说，主人公孔浩原从山村药童修炼成 **AI 大师**，每个境界对应一个上面的概念，章末「凡人笔记」翻译回真实术语。**当爽文看会上头，当教材看会开窍。**

## 01_INIT_立项

- [`INIT-PRD-001` Khy-OS-定位与已实现能力-2026-06-12](01_INIT_立项/[INIT-PRD-001] Khy-OS-定位与已实现能力-2026-06-12.md)
- [`INIT-PRD-002` 项目-定位](01_INIT_立项/[INIT-PRD-002] 项目-定位.md)
- [`INIT-PRD-003` KhyOS 的核心-定位口径单一真源](01_INIT_立项/[INIT-PRD-003] KhyOS 的核心-定位口径单一真源.md) — **「核心」一词的轴切分与定位层收口**：把全仓四套「核心」口径切成 A 不可卸载核 / B 产品核心 / C 定位叙事 / D 设计不变式，声明 `A ⊂ B`；给出一句话核心、七核清单（附实测锚点）与 3 处口径冲突登记（内核 README vs 097、核心多口径、编号冲突 5 组）

## 03_DESIGN_设计

- [`DESIGN-ARCH-001` khy-移动智能体协议](03_DESIGN_设计/[DESIGN-ARCH-001] khy-移动智能体协议.md)
- [`DESIGN-ARCH-002` Khyos-CB-SSP-数学建模与实现映射](03_DESIGN_设计/[DESIGN-ARCH-002] Khyos-CB-SSP-数学建模与实现映射.md)
- [`DESIGN-ARCH-003` Khyos-数学重塑-受约束随机最短路径](03_DESIGN_设计/[DESIGN-ARCH-003] Khyos-数学重塑-受约束随机最短路径.md)
- [`DESIGN-ARCH-004` _cbssp_progress](03_DESIGN_设计/[DESIGN-ARCH-004] _cbssp_progress.md)
- [`DESIGN-ARCH-005` agentfs-智能体文件系统](03_DESIGN_设计/[DESIGN-ARCH-005] agentfs-智能体文件系统.md)
- [`DESIGN-ARCH-006` ai-gateway-适配器协议架构](03_DESIGN_设计/[DESIGN-ARCH-006] ai-gateway-适配器协议架构.md)
- [`DESIGN-ARCH-007` m1-微内核-ipc-moonbit](03_DESIGN_设计/[DESIGN-ARCH-007] m1-微内核-ipc-moonbit.md)
- [`DESIGN-ARCH-008` moonbit-系统边界](03_DESIGN_设计/[DESIGN-ARCH-008] moonbit-系统边界.md)
- [`DESIGN-ARCH-009` 可视化拖拽工作流编辑器-2026-06-09](03_DESIGN_设计/[DESIGN-ARCH-009] 可视化拖拽工作流编辑器-2026-06-09.md)
- [`DESIGN-ARCH-010` 核心架构](03_DESIGN_设计/[DESIGN-ARCH-010] 核心架构.md)
- [`DESIGN-ARCH-011` 应用接入标准](03_DESIGN_设计/[DESIGN-ARCH-011] 应用接入标准.md)
- [`DESIGN-ARCH-012` 工具延迟加载](03_DESIGN_设计/[DESIGN-ARCH-012] 工具延迟加载.md)
- [`DESIGN-ARCH-013` 弱模型兼容](03_DESIGN_设计/[DESIGN-ARCH-013] 弱模型兼容.md)
- [`DESIGN-ARCH-014` 模式图谱](03_DESIGN_设计/[DESIGN-ARCH-014] 模式图谱.md)
- [`DESIGN-ARCH-015` 编码规范](03_DESIGN_设计/[DESIGN-ARCH-015] 编码规范.md)
- [`DESIGN-ARCH-016` AI_Agent显示规范](03_DESIGN_设计/[DESIGN-ARCH-016] AI_Agent显示规范.md)
- [`DESIGN-ARCH-017` 元工具系统设计](03_DESIGN_设计/[DESIGN-ARCH-017] 元工具系统设计.md)
- [`DESIGN-ARCH-018` Agent提示词复用机制](03_DESIGN_设计/[DESIGN-ARCH-018] Agent提示词复用机制.md)
- [`DESIGN-ARCH-019` 用户输入预处理规范](03_DESIGN_设计/[DESIGN-ARCH-019] 用户输入预处理规范.md)
- [`DESIGN-ARCH-020` 架构债治理报告](03_DESIGN_设计/[DESIGN-ARCH-020] 架构债治理报告.md)
- [`DESIGN-ARCH-021` 巨型环反转设计](03_DESIGN_设计/[DESIGN-ARCH-021] 巨型环反转设计.md)
- [`DESIGN-ARCH-022` khyos多实例并发文件控制规范](03_DESIGN_设计/[DESIGN-ARCH-022] khyos多实例并发文件控制规范.md)
- [`DESIGN-ARCH-023` khyos文档排版与格式控制规范](03_DESIGN_设计/[DESIGN-ARCH-023] khyos文档排版与格式控制规范.md)
- [`DESIGN-ARCH-024` khyos元帅双模式任命与约束规范（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-024] khyos元帅双模式任命与约束规范.md)
- [`DESIGN-ARCH-025` khyos元规划协议与动态约束注入规范](03_DESIGN_设计/[DESIGN-ARCH-025] khyos元规划协议与动态约束注入规范.md)
- [`DESIGN-ARCH-026` khyos系统级服务调用审批网关规范](03_DESIGN_设计/[DESIGN-ARCH-026] khyos系统级服务调用审批网关规范.md)
- [`DESIGN-ARCH-027` Agent依赖自愈机制规范](03_DESIGN_设计/[DESIGN-ARCH-027] Agent依赖自愈机制规范.md)
- [`DESIGN-ARCH-028` Agent通信防御-零静默失败与精准归因](03_DESIGN_设计/[DESIGN-ARCH-028] Agent通信防御-零静默失败与精准归因.md)
- [`DESIGN-ARCH-029` Agent有限窗口降级与强制兜底执行协议](03_DESIGN_设计/[DESIGN-ARCH-029] Agent有限窗口降级与强制兜底执行协议.md)
- [`DESIGN-ARCH-030` 源端构建-目标机自愈运行](03_DESIGN_设计/[DESIGN-ARCH-030] 源端构建-目标机自愈运行.md)
- [`DESIGN-ARCH-031` 网关日志租界隔离-按需可见与净味翻译](03_DESIGN_设计/[DESIGN-ARCH-031] 网关日志租界隔离-按需可见与净味翻译.md)
- [`DESIGN-ARCH-032` 内嵌MD工作台与跨平台右键集成](03_DESIGN_设计/[DESIGN-ARCH-032] 内嵌MD工作台与跨平台右键集成.md)
- [`DESIGN-ARCH-033` 模型自适应与双轨热插拔架构（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-033] 模型自适应与双轨热插拔架构.md)
- [`DESIGN-ARCH-034` 动态自适应约束求解引擎](03_DESIGN_设计/[DESIGN-ARCH-034] 动态自适应约束求解引擎.md)
- [`DESIGN-ARCH-035` 上下文永续与认知压缩引擎（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-035] 上下文永续与认知压缩引擎.md)
- [`DESIGN-ARCH-036` 万物结构化熔炉引擎](03_DESIGN_设计/[DESIGN-ARCH-036] 万物结构化熔炉引擎.md)
- [`DESIGN-ARCH-037` Khyos自举创世-需求内源发生器与闭环自愈引擎](03_DESIGN_设计/[DESIGN-ARCH-037] Khyos自举创世-需求内源发生器与闭环自愈引擎.md)
- [`DESIGN-ARCH-038` Khyos双轨淬火-确定性保底与模型辅助增强的Bug升维引擎（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-038] Khyos双轨淬火-确定性保底与模型辅助增强的Bug升维引擎.md)
- [`DESIGN-ARCH-039` Khyos环境共生-环境感知与原生亲和架构（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-039] Khyos环境共生-环境感知与原生亲和架构.md)
- [`DESIGN-ARCH-040` Khyos数据主权与极权路由-数据主权绝对论与单一权威注入网关（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-040] Khyos数据主权与极权路由-数据主权绝对论与单一权威注入网关.md)
- [`DESIGN-ARCH-041` Khyos意图精准裁决-意图光谱解析与动态提权网关](03_DESIGN_设计/[DESIGN-ARCH-041] Khyos意图精准裁决-意图光谱解析与动态提权网关.md)
- [`DESIGN-ARCH-042` Khyos自持基建-契约即文档与影响面评估与行为守卫（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-042] Khyos自持基建-契约即文档与影响面评估与行为守卫.md)
- [`DESIGN-ARCH-043` khy-agent-sdk-Claude对齐与D1-D6融合规范](03_DESIGN_设计/[DESIGN-ARCH-043] khy-agent-sdk-Claude对齐与D1-D6融合规范.md)
- [`DESIGN-ARCH-044` Agent自愈微循环-诊断修复重试](03_DESIGN_设计/[DESIGN-ARCH-044] Agent自愈微循环-诊断修复重试.md)
- [`DESIGN-ARCH-045` 非活跃通道生命周期治理-僵尸后台收回与日志越权阻断](03_DESIGN_设计/[DESIGN-ARCH-045] 非活跃通道生命周期治理-僵尸后台收回与日志越权阻断.md)
- [`DESIGN-ARCH-046` 聊天状态污染与回复截断治理-原子轮提交与空结果重试与截断信号保真](03_DESIGN_设计/[DESIGN-ARCH-046] 聊天状态污染与回复截断治理-原子轮提交与空结果重试与截断信号保真.md)
- [`DESIGN-ARCH-047` 轨迹溯源标准-溯源信封与防篡改链与注入隔离](03_DESIGN_设计/[DESIGN-ARCH-047] 轨迹溯源标准-溯源信封与防篡改链与注入隔离.md)
- [`DESIGN-ARCH-048` khyos轨迹回放与确定性复现](03_DESIGN_设计/[DESIGN-ARCH-048] khyos轨迹回放与确定性复现.md)
- [`DESIGN-ARCH-049` 轨迹即教材-AI引导回放](03_DESIGN_设计/[DESIGN-ARCH-049] 轨迹即教材-AI引导回放.md)
- [`DESIGN-ARCH-050` 项目整体意识与自驱收尾保障](03_DESIGN_设计/[DESIGN-ARCH-050] 项目整体意识与自驱收尾保障.md)
- [`DESIGN-ARCH-051` 单人维护者健康驾驶舱](03_DESIGN_设计/[DESIGN-ARCH-051] 单人维护者健康驾驶舱.md)
- [`DESIGN-ARCH-052` 任务驱动读取与搜索范围规划-精准而非全知](03_DESIGN_设计/[DESIGN-ARCH-052] 任务驱动读取与搜索范围规划-精准而非全知.md)
- [`DESIGN-ARCH-053` 命令与第三方应用输出折叠-几行预览与Ctrl+O展开](03_DESIGN_设计/[DESIGN-ARCH-053] 命令与第三方应用输出折叠-几行预览与Ctrl+O展开.md)
- [`DESIGN-ARCH-054` AI逆向工程-从产物还原与自验软件](03_DESIGN_设计/[DESIGN-ARCH-054] AI逆向工程-从产物还原与自验软件.md)
- [`DESIGN-ARCH-055` 对抗式训练-极端环境抗压自检与加固](03_DESIGN_设计/[DESIGN-ARCH-055] 对抗式训练-极端环境抗压自检与加固.md)
- [`DESIGN-ARCH-056` khyos桌面操控-眼耳嘴与模拟操作](03_DESIGN_设计/[DESIGN-ARCH-056] khyos桌面操控-眼耳嘴与模拟操作.md)
- [`DESIGN-ARCH-058` 细粒度权限策略与记忆主动化引擎](03_DESIGN_设计/[DESIGN-ARCH-058] 细粒度权限策略与记忆主动化引擎.md)
- [`DESIGN-ARCH-059` 能力即代码](03_DESIGN_设计/[DESIGN-ARCH-059] 能力即代码.md)
- [`DESIGN-ARCH-060` khy 功能接线与编排总图](03_DESIGN_设计/[DESIGN-ARCH-060] khy 功能接线与编排总图.md)
- [`DESIGN-ARCH-061` 更新包学习-取其精华弃其糟粕](03_DESIGN_设计/[DESIGN-ARCH-061] 更新包学习-取其精华弃其糟粕.md)
- [`DESIGN-ARCH-062` khyos 后台常驻与按需加载生命周期边界](03_DESIGN_设计/[DESIGN-ARCH-062] khyos 后台常驻与按需加载生命周期边界.md)
- [`DESIGN-ARCH-063` 对照《Claude Code 架构》一书读懂 Khy-OS（书序架构阅读主线）](03_DESIGN_设计/%5BDESIGN-ARCH-063%5D%20对照《Claude%20Code%20架构》一书读懂%20Khy-OS.md)
- [`DESIGN-ARCH-064` khyos 后端请求生命周期与逻辑关系图](03_DESIGN_设计/[DESIGN-ARCH-064] khyos 后端请求生命周期与逻辑关系图.md)
- [`DESIGN-ARCH-065` Hermes Agent v0.18.0 参考学习-判断验证自我进化](03_DESIGN_设计/[DESIGN-ARCH-065] Hermes Agent v0.18.0 参考学习-判断验证自我进化.md)
- [`DESIGN-ARCH-066` 前端代理出站桥-选节点实际路由与启用停用开关](03_DESIGN_设计/[DESIGN-ARCH-066] 前端代理出站桥-选节点实际路由与启用停用开关.md)
- [`DESIGN-ARCH-067` 动态模型差异化适配引擎](03_DESIGN_设计/[DESIGN-ARCH-067] 动态模型差异化适配引擎.md) ⚠️ 编号与上一条冲突，待重编
- [`DESIGN-ARCH-068` 仓库层级板块规范](03_DESIGN_设计/%5BDESIGN-ARCH-068%5D%20仓库层级板块规范.md) — **顶层目录 L0–L6 分层、允许依赖边、`docs/` 两轴命名、任务入口命名的单一真源**；新增文件或新增顶层目录前先读它，由 `npm run check:layout` 强制
- [`DESIGN-ARCH-069` 拓展契约与核心边界规范](03_DESIGN_设计/[DESIGN-ARCH-069] 拓展契约与核心边界规范.md) — **「什么是核、什么是拓展」的单一真源**：核 = 壳+漏斗+网关；一个拓展 = 一个目录 + 一份 `khy.extension.json`；五个拓展根与优先级；发现→惰性激活→停用；删目录即消失。`[DESIGN-ARCH-068]` 是其上位法，由 `npm run check:layout` 的 `extension-contract` 规则强制
- [`DESIGN-ARCH-070` 治理总纲与可执行规则](03_DESIGN_设计/[DESIGN-ARCH-070] 治理总纲与可执行规则.md) — **既有治理规则的索引与缺口登记**：MOD、MEM、TOOL、ACP、API 五板块；不推翻既有单一真源；由 `node scripts/ci/check-gov-rules.js` 守住总纲与 CI 接线。
- [`DESIGN-ARCH-071` 通道选择决策矩阵](03_DESIGN_设计/[DESIGN-ARCH-071] 通道选择决策矩阵.md) — **「一次操作该走哪条通道」的单一真源**：五通道（直接读状态/服务层直调/CLI/Web API/看屏幕）五问判定顺序、适用/禁止/降级与反模式；`AGENTS.md`「通道选择判定」节是其首屏压缩版。
- [`DESIGN-ARCH-072` 任务最小闭环-裁决接线与交付台账](03_DESIGN_设计/[DESIGN-ARCH-076] 任务最小闭环-裁决接线与交付台账.md) — 普通任务从「模型想停」到「交付完成」的最小闭环单一真源：收尾仲裁门（close/redrive/close_partial 三态）+ 交付台账 `khy deliveries`
- [`DESIGN-ARCH-073` khyos 核心任务循环-稳定交付总纲](03_DESIGN_设计/[DESIGN-ARCH-077] khyos 核心任务循环-稳定交付总纲.md) — 任务从受理到交付的核心循环运行时契约（登记→执行→裁决→交付→台账 + 想停轮 20 道门序），`072` 的上位总纲
- [`DESIGN-ARCH-074` khyos 账号体系收口-用户名唯一键 alias 软冲突 密码必填 局域网登录](03_DESIGN_设计/[DESIGN-ARCH-074] khyos 账号体系收口-用户名唯一键 alias 软冲突 密码必填 局域网登录.md) — 账号=用户名；alias 全局唯一软冲突；强制密码；ai-backend 默认绑 0.0.0.0 让 LAN 上其他机器可用账号密码登录。承接用户反馈「khyos 欢迎语和登录账号不对」并扩大账号体系口径
- [`DESIGN-ARCH-078` khyos桌面端与CLI-TUI互联共享方案](03_DESIGN_设计/[DESIGN-ARCH-078] khyos桌面端与CLI-TUI互联共享方案.md) — 桌面端（Electron）与 CLI/TUI 互联共享：发现链（backend_runtime.json / bridge 9222）、会话与供应商真源归一、实时共享（输出镜像/远程发消息/审批）与 P0-P4 分期
- [`DESIGN-OTHER-001` Khyos-数学重塑-实施提示词链](03_DESIGN_设计/[DESIGN-OTHER-001] Khyos-数学重塑-实施提示词链.md)
- [`DESIGN-OTHER-002` _cbssp_分阶段防闪退提示词](03_DESIGN_设计/[DESIGN-OTHER-002] _cbssp_分阶段防闪退提示词.md)
- [`DESIGN-OTHER-003` khy-系统提示词结构图](03_DESIGN_设计/[DESIGN-OTHER-003] khy-系统提示词结构图.md)
- [`DESIGN-OTHER-004` 特性访问-提示词胶囊-2026-06-01](03_DESIGN_设计/[DESIGN-OTHER-004] 特性访问-提示词胶囊-2026-06-01.md)
- [`DESIGN-OTHER-005` desktop-rd-桌面端调研指针](03_DESIGN_设计/[DESIGN-OTHER-005] desktop-rd-桌面端调研指针.md) — 指向 `extensions/scripts/khy-desktop-rd/`：4 个外部开源桌面 AI Agent 项目（OpenFlux / goose / ChatML / one-api）+ Cmd+K 组件范式（kbar）的归档与对比，待路线评审
- [`DESIGN-PERF-001` khy-cli-交互流畅度修复方案-v1](03_DESIGN_设计/[DESIGN-PERF-001] khy-cli-交互流畅度修复方案-v1.md) — khy CLI 流畅度对位调研（10 处推断校正）与三阶段修复方案（fast-startup 默认化 / CLI bundle / 首 token 解耦），只立项未动码
- [`DESIGN-SIZE-001` khy-os 体积优化方案](03_DESIGN_设计/[DESIGN-SIZE-001] khy-os 体积优化方案.md) — 开发盘占 1.25GB → 分发 bundle <15MB 的三层优化：删可弃物 / 依赖替代 / 三档分发（Draft）
- [`[DESIGN-RES-003]` 跨Agent技能MCP统一管理-阶段一调研](03_DESIGN_设计/[DESIGN-RES-003] 跨Agent技能MCP统一管理-阶段一调研.md) — 只读调研：现有 `ccMcpBridge`/`ocMcpBridge`/`*SkillBridge` 只发现不写入，缺 agent 注册表与统一 import 原语；立法清单冻结前不动代码
- [`DESIGN-LEGISLATION`（未编号）跨Agent技能MCP统一管理-阶段二立法清单](03_DESIGN_设计/[DESIGN-LEGISLATION] 跨Agent技能MCP统一管理-阶段二立法清单.md) — 阶段三实现的冻结依据：`khy unify` 的 export/import/list/sync 范围、MCP 与技能 bridge 注册表、存量纳管写入口；依据阶段一调研 §1-§5 与铁律 F1-F8

历史未编号件（保留原名，重命名须同步改写全部入站引用，属独立一轮工作）：

- [`ycode-inspiration-plan`（未编号）](03_DESIGN_设计/[DESIGN-ARCH-083] ycode-inspiration-plan 设计与实现记录.md)

2026-09-08 补登记（此前漏链，docs-index-complete 由此降为 0）：

- [`DESIGN-ARCH-072` 模型上下文窗口探测规范](03_DESIGN_设计/[DESIGN-ARCH-072] 模型上下文窗口探测规范.md)
- [`DESIGN-ARCH-072` 项目规范化总纲](03_DESIGN_设计/[DESIGN-ARCH-072] 项目规范化总纲.md)
- [`DESIGN-ARCH-073` 规范快速参考卡](03_DESIGN_设计/[DESIGN-ARCH-073] 规范快速参考卡.md)
- [`DESIGN-ARCH-075` opencode高含金量功能教学与khy-os差距补齐路线](03_DESIGN_设计/[DESIGN-ARCH-075] opencode高含金量功能教学与khy-os差距补齐路线.md)
- [`DESIGN-ARCH-076` 任务最小闭环-裁决接线与交付台账](03_DESIGN_设计/[DESIGN-ARCH-076] 任务最小闭环-裁决接线与交付台账.md)
- [`DESIGN-ARCH-077` khyos 核心任务循环-稳定交付总纲](03_DESIGN_设计/[DESIGN-ARCH-077] khyos 核心任务循环-稳定交付总纲.md)
- [`DESIGN-ARCH-079` TUI界面设计规范](03_DESIGN_设计/[DESIGN-ARCH-079] TUI界面设计规范.md)
- [`DESIGN-ARCH-079` TUI组件实现提示词](03_DESIGN_设计/[DESIGN-ARCH-079] TUI组件实现提示词.md)
- [`DESIGN-ARCH-080` 网页端信息架构与四页重设计-2026-09-08](03_DESIGN_设计/[DESIGN-ARCH-080] 网页端信息架构与四页重设计-2026-09-08.md) — `apps/ai-frontend` IA 重构方案（Draft，冻结前不动 src）。调研 7 个同类项目实测源码（New API = `QuantumNous/new-api`、One API、1Panel、Nginx Proxy Manager、CLI Proxy API 管理中心、Chat2DB、AppFlowy Cloud）得出规范与例外：**7/7 无独立 admin 登录页、6/7 无独立 admin 前端、只有 2/7 有忘记密码页**。现状实测：42 处 API 调用指向不存在端点、`/usage` 与 `/pricing` 两整页空转、`/proxies` 菜单指向 NotFound、`routes/crossPlatform.js` 无鉴权且被裸 `fetch()` 调用、后端存在**两套并行的密码重置方案**而 CLI 调用的那套端点根本不存在、忘记密码前端 0 引用而后端已挂载、`workspace` 切换器是 7/7 项目里唯一的反模式
- [`DESIGN-ARCH-081` Claude Code TUI 1复刻实施计划](03_DESIGN_设计/[DESIGN-ARCH-081] Claude Code TUI 1复刻实施计划.md) — CC TUI 1:1 复刻实施方案：品牌替换为 Khy，全面支持 OpenAI 协议
- [`DESIGN-ARCH-082` CC模式输入框与光标设计](03_DESIGN_设计/[DESIGN-ARCH-082] CC模式输入框与光标设计.md) — 输入框布局、光标、多行输入、模式切换与占位符
- [`DESIGN-ARCH-083` CC模式表格与折叠设计](03_DESIGN_设计/[DESIGN-ARCH-083] CC模式表格与折叠设计.md) — 表格显示与折叠/隐藏组件
- [`DESIGN-ARCH-084` CC模式注意力与选择设计](03_DESIGN_设计/[DESIGN-ARCH-084] CC模式注意力与选择设计.md) — 强注意力引导、焦点管理与选择交互
- [`DESIGN-ARCH-085` CC模式子视图子菜单卡片与滚动设计](03_DESIGN_设计/[DESIGN-ARCH-085] CC模式子视图子菜单卡片与滚动设计.md) — 子视图（Agent）、子菜单、卡片、滚动/复制/历史
- [`DESIGN-ARCH-086` CC TUI 复刻总计划与子任务跟踪](03_DESIGN_设计/[DESIGN-ARCH-086] CC TUI 复刻总计划与子任务跟踪.md) — CC TUI 复刻工程的总计划文档，汇总 081–089 各子设计并跟踪实施进度
- [`DESIGN-ARCH-087` CC模式微交互与反馈设计](03_DESIGN_设计/[DESIGN-ARCH-087] CC模式微交互与反馈设计.md) — 微交互、瞬态反馈与状态提示
- [`DESIGN-ARCH-088` CC快捷键系统RedoFork与执行偏差处理](03_DESIGN_设计/[DESIGN-ARCH-088] CC快捷键系统RedoFork与执行偏差处理.md) — 快捷键系统、撤销/重做、分叉与执行偏差处理
- [`DESIGN-ARCH-089` TUI设计模式调研报告](03_DESIGN_设计/[DESIGN-ARCH-089] TUI设计模式调研报告.md) — 100+ 开源 TUI 项目综合调研，提炼最佳实践指导 CC TUI 复刻
- [`DESIGN-PHILOSOPHY` 设计哲学总纲](03_DESIGN_设计/[DESIGN-PHILOSOPHY] 设计哲学总纲.md)
- [`DESIGN-QUICK-REF` 设计模式速查卡](03_DESIGN_设计/[DESIGN-QUICK-REF] 设计模式速查卡.md)

2026-09-10 补登记（此前漏链，`check:layout` 的 `docs-index-complete` 因此报 4）：

- [`DESIGN-ARCH-090` TUI用户评价调研与痛点分析](03_DESIGN_设计/[DESIGN-ARCH-090] TUI用户评价调研与痛点分析.md) — 基于用户 Issue / 社区讨论的 TUI 痛点分析，指导 TUI 设计改进（081–089 复刻子设计的上游输入）
- [`[DESIGN-RES-001]` 桌面端智能体UI调研与差距分析-2026-09-09](03_DESIGN_设计/[DESIGN-RES-001] 桌面端智能体UI调研与差距分析-2026-09-09.md) — 桌面端智能体 UI 现状调研与差距分析
- [`[DESIGN-RES-002]` 桌面端智能体UI每日调研-2026-09-10](03_DESIGN_设计/[DESIGN-RES-002] 桌面端智能体UI每日调研-2026-09-10.md) — 桌面端智能体 UI 每日调研日志
- [`DESIGN-ARCH-108` CC-TUI复刻执行提示词](03_DESIGN_设计/[DESIGN-ARCH-108] CC-TUI复刻执行提示词.md) — `[DESIGN-ARCH-086]` 总计划的配套执行提示词，交给 AI 编码助手按步骤实施 CC TUI 复刻
- [`DESIGN-ARCH-091` 密钥与端点中心管理（KeyManager）GUI设计规范](03_DESIGN_设计/[DESIGN-ARCH-091] 密钥与端点中心管理（KeyManager）GUI设计规范.md) — 密钥与端点中心管理（KeyManager）的 GUI 设计规范，覆盖密钥生命周期、端点注册与轮询策略
- [`DESIGN-ARCH-095` TUI交互完善调研与实施路线](03_DESIGN_设计/[DESIGN-ARCH-095] TUI交互完善调研与实施路线.md) — 089/090 之后的调研收口件：三路 GitHub 实地调研（终端能力协议 / 五款 AI 代理 TUI / 七款经典 TUI）综合本地基线，给出交互差距分析与 P0–P3 实施路线 + 不采纳清单
- [`DESIGN-ARCH-093` 密钥与智能体统一管理（工具矩阵与zcodeAdapter）设计规范](03_DESIGN_设计/[DESIGN-ARCH-093] 密钥与智能体统一管理（工具矩阵与zcodeAdapter）设计规范.md) — 「只在 khy 配置」的密钥/Agent 统一管理：双投递模式（khy 网关中继优先、cc-switch 式同步兜底）+ 工具矩阵现状表 + zcodeAdapter 契约（zai 登录门/内联 key/双模型角色）；P1 已落地
- [`DESIGN-ARCH-094` Provider卡片枢纽（CardHub）GUI设计规范](03_DESIGN_设计/[DESIGN-ARCH-094] Provider卡片枢纽（CardHub）GUI设计规范.md) — 本机全部 provider/agent 模型统一管理的卡片式 GUI（UI 风格参照 cc-switch，数据模型参照 Codex++）：独立应用 `apps/provider-hub`（不并入 khyos-desktop）、卡片 CRUD/模型拉取/工具矩阵/一键导入，M0–M3 TDD 排期
- [`DESIGN-ARCH-096` ycode 第二轮增量借鉴调研报告](03_DESIGN_设计/[DESIGN-ARCH-096] ycode 第二轮增量借鉴调研报告.md) — 接续 [DESIGN-ARCH-083] 第一轮，对标 gitee 星瑶（xingyao-y-code）2026-09-08~13 共 74 提交增量：按回合撤销深化、星轨自动化「定时 agent 回合」、压缩提速、内置技能指纹升级、CLI 对齐、事件断点续传、权限按会话绑定 8 项逐区对照 + 行动项（仅调研未实施）
- [`DESIGN-ARCH-097` KhyOS 核心边界定稿-一词一解](03_DESIGN_设计/[DESIGN-ARCH-097] KhyOS 核心边界定稿-一词一解.md) — 核心定义收口件：调研定稿七核两层（运行核：壳/漏斗/网关/智能体；主张核：工作流/记忆/拓展契约）各一词一解，附证据锚点、五核提法映射与定位裁决（技能/MCP 归拓展契约，内核降为实验分支，khyquant 定为示例应用）
- [`DESIGN-ARCH-098` 系统提示词结构重设计-静态动态分层与缓存优化方案](03_DESIGN_设计/[DESIGN-ARCH-098] 系统提示词结构重设计-静态动态分层与缓存优化方案.md) — 系统提示词按静态/动态四层分区重构与缓存优化的设计方案
- [`DESIGN-ARCH-099` 提示词架构横向调研与khy-os对齐方案](03_DESIGN_设计/[DESIGN-ARCH-099] 提示词架构横向调研与khy-os对齐方案.md) — 提示词架构的横向对标调研与 khy-os 对齐方案
- [`DESIGN-ARCH-100` 模型列表真值校验与过滤规范](03_DESIGN_设计/[DESIGN-ARCH-100] 模型列表真值校验与过滤规范.md) — 模型列表真值校验与过滤规范（本条目原误标为「TUI 终端界面重设计方案」并指向不存在的 `ARCH-100` 同名文件，2026-09-15 校正；该方案实为 `[DESIGN-ARCH-103]`）
- [`DESIGN-ARCH-101` TUI 交互与展示规则细则](03_DESIGN_设计/[DESIGN-ARCH-101] TUI 交互与展示规则细则.md) — 把 TUI「何时出现/消失、显示什么、点击后如何、如何断行」六类离散行为规则收敛为单一真源（触发条件→表现→持续/终止→边界四要素）
- [`DESIGN-CPA-001` CPA 反代集成方案](03_DESIGN_设计/[DESIGN-CPA-001] CPA 反代集成方案.md) — CPA 反代集成方案设计
- [`DESIGN-CPA-002` CPA+NewAPI 分层架构实施方案](03_DESIGN_设计/[DESIGN-CPA-002] CPA+NewAPI 分层架构实施方案.md) — CPA 接入层 + New API 治理层的调研现状/架构/文件清单/四 Phase 实施顺序/验收与风险（只调研未写码）
- [`DESIGN-CPA-003` CPA接入层+NewAPI治理层分层架构](03_DESIGN_设计/[DESIGN-CPA-003] CPA接入层+NewAPI治理层分层架构.md) — CPA 接入层与 NewAPI 治理层分层架构
- [`DEPLOY-0102` CPA+NewAPI分层架构快速指南](06_DEPLOY_部署/[DEPLOY-0102] CPA+NewAPI分层架构快速指南.md) — CPA/NewAPI 分层架构指引（原 `06A_GUIDE_指南` 已于 2026-09-15 并入 `06_DEPLOY_部署`，目录已删除）
- [`DEPLOY-0103` CPA集成快速指南](06_DEPLOY_部署/[DEPLOY-0103] CPA集成快速指南.md) — CPA 集成快速上手（与 provider-hub 集成版）

2026-09-15 整理登记（撞号修复 + 漏链补齐，`docs-index-complete` 实测归零）：

- ⚠️ 原 `DESIGN-ARCH-085` Git规范与自动化治理 已迁入 `_规范/` 改编号为 `[DESIGN-GIT-003]`（`085` 归 CC模式子视图子菜单卡片与滚动设计）；原 `DESIGN-ARCH-082` 后端分层架构规范 已改编号为 `[DESIGN-LAY-001]`；原 `DESIGN-PERF-001` khy-cli-交互流畅度修复方案 已改编号为 `[DESIGN-PERF-002]`（`PERF-001` 归 `_规范/` 性能规范）
- [`DESIGN-ARCH-102` Khy TUI 统一规则手册](03_DESIGN_设计/[DESIGN-ARCH-102] Khy TUI 统一规则手册.md)
- [`DESIGN-ARCH-103` TUI 终端界面重设计方案](03_DESIGN_设计/[DESIGN-ARCH-103] TUI 终端界面重设计方案.md)
- [`DESIGN-ARCH-105` ycode 第三轮增量借鉴调研报告](03_DESIGN_设计/[DESIGN-ARCH-105] ycode 第三轮增量借鉴调研报告.md)
- [`DESIGN-ARCH-106` 项目规范化总纲](03_DESIGN_设计/[DESIGN-ARCH-106] 项目规范化总纲.md) — 原占用 `072`，因与模型上下文窗口探测规范撞号改号
- [`DESIGN-ARCH-107` TUI组件实现提示词](03_DESIGN_设计/[DESIGN-ARCH-107] TUI组件实现提示词.md) — 原占用 `079`，因与 TUI界面设计规范撞号改号
- [`DESIGN-ARCH-109` Y-code 借鉴实施方案](03_DESIGN_设计/[DESIGN-ARCH-109] Y-code 借鉴实施方案.md) — Y-code（星瑶）对标借鉴的实施方案（原文件名 `ycode-inspiration-plan 设计与实现记录`，原占用 `083`）
- [`DESIGN-ARCH-110` TUI-CLASSIC-SYNC 设计笔记](03_DESIGN_设计/[DESIGN-ARCH-110] TUI-CLASSIC-SYNC 设计笔记.md) — 原在 `docs/design/`，该目录已合并删除
- [`DESIGN-ARCH-111` 规则遵守保障机制](03_DESIGN_设计/[DESIGN-ARCH-111] 规则遵守保障机制.md) — 规则登记表 → 门禁的绑定层设计：门成员资格从 `RULES-REGISTRY.json` 派生，含归类枚举、门档强度映射、抑制约定、覆盖率红线与反孤儿守卫
- [`DESIGN-PERF-002` khy-cli-交互流畅度修复方案-v1](03_DESIGN_设计/[DESIGN-PERF-002] khy-cli-交互流畅度修复方案-v1.md)
- [`DESIGN-ARCH-104` 借鉴与实现统一规则](03_DESIGN_设计/[DESIGN-ARCH-104] 借鉴与实现统一规则.md) — 可借/不可借白黑名单 + 五种借鉴方式判定 + 六字段提案流程 + FEATURE-OWNERSHIP 归属登记与「同一功能唯一实现」裁决（`[DESIGN-ARCH-061]` 的流程上位规则）

## _规范/（跨阶段规范目录，2026-09-10 自 `03_DESIGN_设计/` 拆出）

> 全部独立编号的规范族（`DESIGN-A11Y/API/ACP/BACKUP/CACHE/CICD/COMM/DB/DEP/DEPLOY/DOC/ENV/ERR/
> FE/GIT/I18N/INDEX/LAY/LOG/MEM/MONITOR/MS/NAM/OUT/PERF/PRIV/REVIEW/SEC/TEST/TOOL` + 未编号协议件
> `FILE-FORMAT-PROTOCOL`、`RELIABILITY-PROTOCOL`）已迁入 [`_规范/`](_规范/00_INDEX_规范-总目录.md)
> （`_` 前缀轴 = 跨阶段资产，见 `[DESIGN-ARCH-068]` §3.1；该目录不在 `docs-index-complete`
> 的阶段扫描范围，完整性由其目录内 `00_INDEX` 与 `DESIGN-INDEX-001` 维护）。ARCH 编号的设计族与
> 治理单一真源留在 `03_DESIGN_设计/`。台账见 `[IMPL-RPT-049]`。

- [_规范-总目录（目录入口）](_规范/00_INDEX_规范-总目录.md)
- [`DESIGN-INDEX-001` 规范索引](_规范/[DESIGN-INDEX-001] 规范索引.md) — 编号 ↔ 标题 ↔ 文件对照总表
- [`DESIGN-GIT-003` Git 自动化治理规范](_规范/[DESIGN-GIT-003] Git 自动化治理规范.md) — 原 `03_DESIGN_设计/[DESIGN-ARCH-085]`，因 `085` 被占用且属规范性质而迁入
- [`DESIGN-LAY-001` 后端分层架构规范](_规范/[DESIGN-LAY-001] 后端分层架构规范.md) — 原 `DESIGN-ARCH-082`，与 `03_DESIGN_设计/[DESIGN-ARCH-082] CC模式输入框与光标设计` 跨目录撞号，改用 LAY 域码退出 ARCH 序列
- [`DESIGN-LAY-002` 目录层级与文件归类规范](_规范/[DESIGN-LAY-002] 目录层级与文件归类规范.md) — **放新文件前先看这篇**：ARCH-068 层级之外的四个空白——可见性轴 PUB/INT/PRV（谁能依赖我）、分层→命名风格映射、扩展名归类矩阵、完整典型目录树；含 `_` 前缀三义裁定与三条存量冲突裁决（HTML 孪生是否入库、JS 文件名 camelCase 优先、`_source/` 注册表幻影）；规则登记为 `LAYOUT-001`
- [`DESIGN-PERF-001` 性能规范](_规范/[DESIGN-PERF-001] 性能规范.md) — 保留 `PERF-001`；设计提案 `[DESIGN-PERF-002]` 在 `03_DESIGN_设计/`
- [`DESIGN-MEM-006` 记忆与维护元数据生命周期规范](_规范/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md) — GOV-MEM-001–004 契约真源：session/persistent 判定口径、persistent 记录五字段格式、记忆与 `.ai/` 元数据的指定读写入口、清理与生命周期；含 UC-001（`.ai/` 三件套缺失）裁决
- [`DESIGN-TOOL-001` 工具与扩展升级废弃规范](_规范/[DESIGN-TOOL-001] 工具与扩展升级废弃规范.md) — GOV-TOOL-003 契约真源：`khy.extension.json` 的 `lifecycle` 块冻结、工具改名/移除的兼容期与迁移说明、manifest 版本策略与最小权限边界
- [`DESIGN-ACP-001` ACP消息元数据与终态契约](_规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md) — GOV-ACP-001/003/004 契约真源 + UC-004 裁决：请求/通知/响应三态信封拆分、`meta`（traceId/callId/deadline/idempotencyKey）元数据、超时/取消/重试/关闭的可观察终态与错误码表
- [`DESIGN-API-002` 外部错误信封与版本弃用政策](_规范/[DESIGN-API-002] 外部错误信封与版本弃用政策.md) — GOV-API-001–004 契约真源 + UC-005 裁决：内部 adapter 形状与外部 API 的边界、统一错误信封与机器码登记表、SSE/WS 终态枚举、API 版本化与弃用政策
- [`FILE-FORMAT-PROTOCOL`（未编号）](_规范/FILE-FORMAT-PROTOCOL.md) — 文件格式使用协议（JSON/YAML/JSONL/…各自的职责边界），由 `check-change-safety` 门控
- [`RELIABILITY-PROTOCOL`（未编号）](_规范/RELIABILITY-PROTOCOL.md)

## 04_IMPL_实现

- [`IMPL-DOC-001` 任务完成判断地图](04_IMPL_实现/[IMPL-DOC-001] 任务完成判断地图.md) — 「任务何时算做完」的三条通道架构地图（taskClosure 三态仲裁 / goalStopGate 四门 / 后台 FSM），改收尾与预算逻辑前必读
- [`IMPL-RPT-001` executeCode-进程级真隔离-2026-06-10](04_IMPL_实现/[IMPL-RPT-001] executeCode-进程级真隔离-2026-06-10.md)
- [`IMPL-RPT-002` kiro-连接修复-2026-06-05](04_IMPL_实现/[IMPL-RPT-002] kiro-连接修复-2026-06-05.md)
- [`IMPL-RPT-003` tui-inquirer闪退修复-2026-06-05](04_IMPL_实现/[IMPL-RPT-003] tui-inquirer闪退修复-2026-06-05.md)
- [`IMPL-RPT-004` tui-叙事与选择覆盖层-2026-06-01](04_IMPL_实现/[IMPL-RPT-004] tui-叙事与选择覆盖层-2026-06-01.md)
- [`IMPL-RPT-005` tui-权限授权掉cooked模式修复-2026-06-09](04_IMPL_实现/[IMPL-RPT-005] tui-权限授权掉cooked模式修复-2026-06-09.md)
- [`IMPL-RPT-006` tui-流式与上下文显示-2026-06-01](04_IMPL_实现/[IMPL-RPT-006] tui-流式与上下文显示-2026-06-01.md)
- [`IMPL-RPT-007` v0.1.84-修复说明](04_IMPL_实现/[IMPL-RPT-007] v0.1.84-修复说明.md)
- [`IMPL-RPT-008` 修复-桥接状态刷屏](04_IMPL_实现/[IMPL-RPT-008] 修复-桥接状态刷屏.md)
- [`IMPL-RPT-009` 特性访问与代理解耦-2026-06-01](04_IMPL_实现/[IMPL-RPT-009] 特性访问与代理解耦-2026-06-01.md)
- [`IMPL-RPT-010` 网关适配器可用性严格化-本地安装与登录-2026-06-10](04_IMPL_实现/[IMPL-RPT-010] 网关适配器可用性严格化-本地安装与登录-2026-06-10.md)
- [`IMPL-RPT-011` 航天级重构白皮书-2026-06-10](04_IMPL_实现/[IMPL-RPT-011] 航天级重构白皮书-2026-06-10.md)
- [`IMPL-RPT-012` 航天级重构白皮书-第二轮-2026-06-10](04_IMPL_实现/[IMPL-RPT-012] 航天级重构白皮书-第二轮-2026-06-10.md)
- [`IMPL-RPT-013` khy-claude-认证冲突修复](04_IMPL_实现/[IMPL-RPT-013] khy-claude-认证冲突修复.md)
- [`IMPL-RPT-014` trae-适配器-官方扫描修复-2026-05-25](04_IMPL_实现/[IMPL-RPT-014] trae-适配器-官方扫描修复-2026-05-25.md)
- [`IMPL-RPT-015` 修复记录时间线](04_IMPL_实现/[IMPL-RPT-015] 修复记录时间线.md)
- [`IMPL-RPT-016` 剪贴板粘贴修复](04_IMPL_实现/[IMPL-RPT-016] 剪贴板粘贴修复.md)
- [`IMPL-RPT-017` 守护进程端口发现修复](04_IMPL_实现/[IMPL-RPT-017] 守护进程端口发现修复.md)
- [`IMPL-RPT-018` 管理前端自动可用修复-2026-05-31](04_IMPL_实现/[IMPL-RPT-018] 管理前端自动可用修复-2026-05-31.md)
- [`IMPL-RPT-019` 终端提示符泄漏与交付空行修复-2026-05-31](04_IMPL_实现/[IMPL-RPT-019] 终端提示符泄漏与交付空行修复-2026-05-31.md)
- [`IMPL-RPT-020` 网关传输韧性修复-2026-05-29](04_IMPL_实现/[IMPL-RPT-020] 网关传输韧性修复-2026-05-29.md)
- [`IMPL-RPT-021` 网关超时与帧修复](04_IMPL_实现/[IMPL-RPT-021] 网关超时与帧修复.md)
- [`IMPL-RPT-022` HOTFIX_MODEL_SELECTION](04_IMPL_实现/[IMPL-RPT-022] HOTFIX_MODEL_SELECTION.md)
- [`IMPL-RPT-023` 文档排版-内容与样式分离-2026-06-12](04_IMPL_实现/[IMPL-RPT-023] 文档排版-内容与样式分离-2026-06-12.md)
- [`IMPL-RPT-024` 元帅双模式任命与约束-2026-06-12](04_IMPL_实现/[IMPL-RPT-024] 元帅双模式任命与约束-2026-06-12.md)
- [`IMPL-RPT-025` 元规划协议与动态约束注入-2026-06-12](04_IMPL_实现/[IMPL-RPT-025] 元规划协议与动态约束注入-2026-06-12.md)
- [`IMPL-RPT-026` 生态架构重塑日志-2026-06-12](04_IMPL_实现/[IMPL-RPT-026] 生态架构重塑日志-2026-06-12.md)
- [`IMPL-RPT-027` 前后端对接与交互重构日志-2026-06-12](04_IMPL_实现/[IMPL-RPT-027] 前后端对接与交互重构日志-2026-06-12.md)
- [`IMPL-RPT-028` 按需加载与零噪音重构日志-2026-06-12](04_IMPL_实现/[IMPL-RPT-028] 按需加载与零噪音重构日志-2026-06-12.md)
- [`IMPL-RPT-029` 夜间代码质量与健壮性完善日志-2026-06-11](04_IMPL_实现/[IMPL-RPT-029] 夜间代码质量与健壮性完善日志-2026-06-11.md)
- [`IMPL-RPT-030` Agnes四模型一键置备-文生图图改图视频-2026-06-20](04_IMPL_实现/[IMPL-RPT-030] Agnes四模型一键置备-文生图图改图视频-2026-06-20.md)
- [`IMPL-RPT-031` 多视角模型配置-单一图谱八视角-2026-06-20](04_IMPL_实现/[IMPL-RPT-031] 多视角模型配置-单一图谱八视角-2026-06-20.md)
- [`IMPL-RPT-032` 有学习价值的Bug汇编-UX漂移与half-wired](04_IMPL_实现/[IMPL-RPT-032] 有学习价值的Bug汇编-UX漂移与half-wired.md)
- [`IMPL-RPT-033` 后端公理化重构-网关与定价原子化-2026-07-30](04_IMPL_实现/[IMPL-RPT-033] 后端公理化重构-网关与定价原子化-2026-07-30.md)
- [`IMPL-RPT-040` CC-zip1 命令对齐账本](04_IMPL_实现/[IMPL-RPT-040] CC-zip1 命令对齐账本.md)
- [`IMPL-RPT-041` Qoder接入khy网关与开机自启实现记录-2026-07-13](04_IMPL_实现/[IMPL-RPT-041] Qoder接入khy网关与开机自启实现记录-2026-07-13.md)
- [`IMPL-RPT-042` 交互过程与输出结构化-持久化与机器可读输出-2026-07-27](04_IMPL_实现/[IMPL-RPT-042] 交互过程与输出结构化-持久化与机器可读输出-2026-07-27.md)
- [`IMPL-RPT-043` 输出截断根治与无感接续-max_tokens元数据缺失与锚点续写-2026-08-07](04_IMPL_实现/[IMPL-RPT-043] 输出截断根治与无感接续-max_tokens元数据缺失与锚点续写-2026-08-07.md)
- [`IMPL-RPT-044` khyos 账号体系收口实施记录-ARCH-074-2026-09-02](04_IMPL_实现/[IMPL-RPT-044] khyos 账号体系收口实施记录-ARCH-074-2026-09-02.md) — 承接 [DESIGN-ARCH-074]：User.aliases/displayName + loginKeyResolver + 默认账号密码自动补齐 + ai-backend 绑 0.0.0.0 让 LAN 端可登录
- [`IMPL-RPT-045` TUI按钮点击调研与鼠标/历史回溯设计决策-2026-09-05](04_IMPL_实现/[IMPL-RPT-045] TUI按钮点击调研与鼠标历史回溯设计决策-2026-09-05.md) — 用户调研 ratatui GitHub 示例后询问 khyos 方案；结论：khyos 已有 mouseButtons.js（二态门控）+ arrowRouting.js（context 栈）+ scrollbackPreserve（无残影），无需引入 ratatui
- [`IMPL-RPT-046` 渠道 API 文档板块-2026-09-08](04_IMPL_实现/[IMPL-RPT-046] 渠道 API 文档板块-2026-09-08.md) — T-023：`/admin/channel-apis` 页管理各 AI 渠道端点与 AES-256-GCM 加密 Key（明文仅 `POST /reveal` 一次性返回并审计）+ 7 个 Agent 客户端配置指南（环境变量名/配置文件路径/可复制代码块）
- [`IMPL-RPT-047` 六道治理债清理与密钥轮换-2026-09-08](04_IMPL_实现/[IMPL-RPT-047] 六道治理债清理与密钥轮换-2026-09-08.md) — 承接 046 的 6 项建议后续：前端 lint 门禁显式覆盖 `.vue`（error 硬 0 + warning 预算只减不增）、`detectRouterBase` 去掉白名单改由已注册路由派生、6 个 error 级真 bug（最重是云端配置同步从未执行过）、`check:layout` 5 项预存 error 清零、jest 基线 501→465 套件的归因修正（**不是** moduleDirectories，是 domain 迁移删模块）、渠道 API Key 升级为 DEK/KEK 双层 envelope + 密钥环平滑轮换
- [`IMPL-RPT-048` 网页端 Phase1 把坏暴露出来-落地记录-2026-09-08](04_IMPL_实现/[IMPL-RPT-048] 网页端 Phase1 把坏暴露出来-落地记录-2026-09-08.md) — 承接 [DESIGN-ARCH-080] Phase 1 全部 8 步：`crossPlatform` 全线加鉴权并收口裸 `fetch`（顺带修掉 `/notify` 的请求体越权）、`GET /api/auth/capabilities` 让登录能力位单点可查、`loadError` 三件套 + `LoadErrorBanner` 把 137 处 `catch {}` 中会落成空默认值的那几处浮成错误态、`/proxies` 接通（菜单项此前指向 NotFound）、`.env.example` 重写 + `check:env` 只减不增门禁。**推翻计划 3 处事实错误**：第三控制面的 token 参数其实必需（守护进程先验 token 再分派路径）、`/api/proxy-egress` 一直有后端（在 9090 守护进程，不在 Express）、`useProxies.egress.wiring.test.js` 实测 11/11 通过；新增 proxy-egress 归属守卫
- [`IMPL-RPT-049` 规范族文档拆分为独立规范目录-2026-09-10](04_IMPL_实现/[IMPL-RPT-049] 规范族文档拆分为独立规范目录-2026-09-10.md) — 39 篇规范族 + 2 协议件 + CICD 目录（42 项）自 `03_DESIGN_设计/` 迁入跨阶段资产轴新目录 `docs/_规范/`（规范目录）；设计族与治理单一真源（ARCH 编号）留 03；入站引用修复、主索引/就近索引重登记、构建产物（html 孪生件/nav-data/dead-links）重生成，台账全文见该篇
- [`IMPL-RPT-050` 规范简洁化与情景速查-2026-09-10](04_IMPL_实现/[IMPL-RPT-050] 规范简洁化与情景速查-2026-09-10.md) — 4 篇 GOV 契约规范（MEM-006/TOOL-001/ACP-001/API-002）按红线骨架压缩重写（§ 锚点保留）；`DESIGN-INDEX-001` 重写为「情景 → 规范 → 一条红线」速查入口（24 情景）；`DESIGN-DOC-001` 新增 §12 规范骨架（新规范 ≤150 行、条文可判定）
- [`IMPL-RPT-051` 工具注册表自愈层规范](04_IMPL_实现/[IMPL-RPT-051] 工具注册表自愈层规范.md) — 工具定义加载期的纯叶子自愈层（KHY_TOOL_HEAL 门控）：检测并自动修复工具注册错误，单个工具出错不中断整表加载；原文件被误建成 `[IMPL-RPT-045/]` 异常目录，2026-09-15 修正路径并改号（`045` 归 TUI按钮点击调研）

> 编号 034–039 为历史断档（删除后不回收，见 [MGMT-STD-001] 第 2.4 条），非漏链。

2026-09-08 补登记（此前漏链，docs-index-complete 由此降为 0）：

- [`IMPL-MIG-001` 命令注册表迁移指南](04_IMPL_实现/[IMPL-MIG-001] 命令注册表迁移指南.md)

## 05_TEST_测试

- [`TEST-RPT-001` 验收不合规-2026-05-16](05_TEST_测试/[TEST-RPT-001] 验收不合规-2026-05-16.md)
- [`TEST-RPT-002` khy-os-测试指南](05_TEST_测试/[TEST-RPT-002] khy-os-测试指南.md)
- [`TEST-RPT-003` windows-ui-聊天回归报告模板](05_TEST_测试/[TEST-RPT-003] windows-ui-聊天回归报告模板.md)
- [`TEST-RPT-004` windows-ui-聊天回归报告示例-2026-05-20](05_TEST_测试/[TEST-RPT-004] windows-ui-聊天回归报告示例-2026-05-20.md)
- [`TEST-RPT-005` windows-ui-聊天回归清单](05_TEST_测试/[TEST-RPT-005] windows-ui-聊天回归清单.md)
- [`TEST-RPT-006` khy-os-交付验证-2026-05-09](05_TEST_测试/[TEST-RPT-006] khy-os-交付验证-2026-05-09.md)
- [`TEST-RPT-007` 文档排版-测试报告-2026-06-12](05_TEST_测试/[TEST-RPT-007] 文档排版-测试报告-2026-06-12.md)
- [`TEST-RPT-008` 元帅双模式任命-测试报告-2026-06-12](05_TEST_测试/[TEST-RPT-008] 元帅双模式任命-测试报告-2026-06-12.md)
- [`TEST-RPT-009` 元规划协议与动态约束注入-测试报告-2026-06-12](05_TEST_测试/[TEST-RPT-009] 元规划协议与动态约束注入-测试报告-2026-06-12.md)
- [`TEST-RPT-010` khy-os-测试覆盖率提升报告](05_TEST_测试/[TEST-RPT-010] khy-os-测试覆盖率提升报告.md)
- [`TEST-RPT-011` khy-os 全免费上线测试方案（GitHub Pages + Supabase）](05_TEST_测试/[TEST-RPT-011] 全免费上线测试方案.md) — 不备案零成本上线可行性：前端上 GitHub Pages、后端的免费落点拆解与折中结论（原散落于 `docs/` 根，2026-09-15 归位）

## 06_DEPLOY_部署

- [`DEPLOY-MAN-001` DEMO](06_DEPLOY_部署/[DEPLOY-MAN-001] DEMO.md)
- [`DEPLOY-MAN-002` PRODUCT_HUNT](06_DEPLOY_部署/[DEPLOY-MAN-002] PRODUCT_HUNT.md)
- [`DEPLOY-MAN-003` PUBLISHING](06_DEPLOY_部署/[DEPLOY-MAN-003] PUBLISHING.md)
- [`DEPLOY-MAN-004` README](06_DEPLOY_部署/[DEPLOY-MAN-004] README.md)
- [`DEPLOY-MAN-005` REDDIT](06_DEPLOY_部署/[DEPLOY-MAN-005] REDDIT.md)
- [`DEPLOY-MAN-006` REPO_META](06_DEPLOY_部署/[DEPLOY-MAN-006] REPO_META.md)
- [`DEPLOY-MAN-007` SHOW_HN](06_DEPLOY_部署/[DEPLOY-MAN-007] SHOW_HN.md)
- [`DEPLOY-MAN-008` TWITTER](06_DEPLOY_部署/[DEPLOY-MAN-008] TWITTER.md)
- [`DEPLOY-MAN-009` pip-打包对等-发布说明-2026-05-17](06_DEPLOY_部署/[DEPLOY-MAN-009] pip-打包对等-发布说明-2026-05-17.md)
- [`DEPLOY-MAN-010` pip-打包对等-发现-2026-05-17](06_DEPLOY_部署/[DEPLOY-MAN-010] pip-打包对等-发现-2026-05-17.md)
- [`DEPLOY-MAN-011` pip-docker-打包部署](06_DEPLOY_部署/[DEPLOY-MAN-011] pip-docker-打包部署.md)
- [`DEPLOY-MAN-012` pip发布后-github发布手册](06_DEPLOY_部署/[DEPLOY-MAN-012] pip发布后-github发布手册.md)
- [`DEPLOY-MAN-013` pypi-发布手册-0.1.17-0.1.18](06_DEPLOY_部署/[DEPLOY-MAN-013] pypi-发布手册-0.1.17-0.1.18.md)
- [`DEPLOY-MAN-014` 发布说明-0.1.27](06_DEPLOY_部署/[DEPLOY-MAN-014] 发布说明-0.1.27.md)
- [`DEPLOY-MAN-015` 源码还原与手工发布](06_DEPLOY_部署/[DEPLOY-MAN-015] 源码还原与手工发布.md)
- [`DEPLOY-MAN-016` 部署指南-域名](06_DEPLOY_部署/[DEPLOY-MAN-016] 部署指南-域名.md)
- [`DEPLOY-MAN-017` 部署指南-无域名](06_DEPLOY_部署/[DEPLOY-MAN-017] 部署指南-无域名.md)
- [`DEPLOY-MAN-018` khyos-Android构建避坑指南](06_DEPLOY_部署/[DEPLOY-MAN-018] khyos-Android构建避坑指南.md)
- [`DEPLOY-MAN-019` 模型可用性与适配器探测](06_DEPLOY_部署/[DEPLOY-MAN-019] 模型可用性与适配器探测.md) — **`/model` 里没有模型时先读这篇**：18 个适配器默认全部 enabled，`available` 由独立探测轮决定；`GATEWAY_<KEY>_ENABLED` 只是关闭开关
- [`DEPLOY-MAN-020` AI供应商与APIKey配置](06_DEPLOY_部署/[DEPLOY-MAN-020] AI供应商与APIKey配置.md) — Ollama / 11 家供应商的**真实**变量名；`JWT_SECRET` 无需手写（自动生成）
- [`DEPLOY-MAN-021` IDE桥接模式](06_DEPLOY_部署/[DEPLOY-MAN-021] IDE桥接模式.md) — 复用 Claude Code / Cursor / Windsurf / VS Code 已有凭据，不需额外 API Key
- [`PORTABLE`（未编号）便携化打包与启动](06_DEPLOY_部署/[DEPLOY-0101] PORTABLE.md) — 源码三档启动 + 发布版一键打包 + 数据宿主隔离
- [`LAN-FIREWALL`（未编号）局域网登录防火墙放行](06_DEPLOY_部署/[DEPLOY-0100] LAN-FIREWALL.md) — ARCH-074 配套文档：ai-backend 默认绑 0.0.0.0，让 LAN 上其他机器可用账号密码登录；本文给出 Windows / macOS / Linux 三平台防火墙放行命令
- [`DEPLOY-0102` CPA+NewAPI分层架构快速指南](06_DEPLOY_部署/[DEPLOY-0102] CPA+NewAPI分层架构快速指南.md) — CPA/NewAPI 分层架构指引（原 `[GUIDE-001]`，`06A_GUIDE_指南` 已删除并入本目录）
- [`DEPLOY-0103` CPA集成快速指南](06_DEPLOY_部署/[DEPLOY-0103] CPA集成快速指南.md) — CPA 集成快速上手，与 provider-hub 集成版（原 `[GUIDE-002]`）

## 07_OPS_运维

> 📦 **pip 安装从这里开始**：[`OPS-MAN-027` 快速开始](07_OPS_运维/[OPS-MAN-027] 快速开始.md) → [`OPS-MAN-043` 从0到高手](07_OPS_运维/[OPS-MAN-043] 从0到高手-新手成长路线与pip安装后清单.md) ⭐ → [`OPS-MAN-023` 完整功能清单](07_OPS_运维/[OPS-MAN-023] pip安装后-完整功能清单.md) → [`OPS-MAN-024` 按需配置体验](07_OPS_运维/[OPS-MAN-024] pip安装后-按需配置体验.md)；门槛与还原见 [`OPS-MAN-028` 环境要求](07_OPS_运维/[OPS-MAN-028] 环境要求.md) / [`OPS-MAN-037` 完整还原](07_OPS_运维/[OPS-MAN-037] pip安装后-完整还原与全功能开启指南.md)。

> 🗂️ **本区 178 份怎么读**：001–070 是**使用与配置手册**（上手、指南、速查）；071–164 多为**单点能力的落地记录**，
> 按族群成串阅读更省力 —— 还原/离机自检族（075·076·079·082·084–090·095·105·107·108·110·113·114·117·119·128·130·133）多由
> `scripts/restore-*.js --gen-doc` 确定性生成，**请勿手改**；OCR 兜底诚实与显示降噪族（104·109·111·112·115·116·118·120·122·124·126·127·132·134·138·140·142·144·145·148·150·159·161·164）；
> 读前防卡死守卫族（121·123·125·129·143·146·147·149）；波次调度与结果诚实族（083·087·091–094·097–099·101）；
> 孤儿能力接线族（151–158·160·162·163）。165 以后是**新增手册**（个性化、消息、技能、MCP、任务入口、备份恢复）。

未编号运维条目（2026-09-10 补登记，此前漏链）：

- [disaster-recovery 依赖清单](07_OPS_运维/[OPS-MAN-201] dependencies.html) — 灾备关键依赖：基础设施、外部服务与故障半径
- [On-Call 值班表](07_OPS_运维/[OPS-MAN-202] oncall.html) — 当前值班轮换、升级路径与值班职责
- [规范代码 Enforcement 指南](07_OPS_运维/[OPS-MAN-203] standards-enforcement.html) — 架构总览、守卫脚本清单与 P0 阻断级规范守卫
- [CI Gate 技术债清理报告](07_OPS_运维/[OPS-MAN-204] technical-debt-report.html) — CI 门禁技术债总览与分规则统计

- [`OPS-MAN-001` ai-快速通道](07_OPS_运维/[OPS-MAN-001] ai-快速通道.md)
- [`OPS-MAN-002` ai-管理-新api对齐](07_OPS_运维/[OPS-MAN-002] ai-管理-新api对齐.md)
- [`OPS-MAN-003` ai-管理-访问与登录](07_OPS_运维/[OPS-MAN-003] ai-管理-访问与登录.md)
- [`OPS-MAN-004` claude-code-代理配置](07_OPS_运维/[OPS-MAN-004] claude-code-代理配置.md)
- [`OPS-MAN-005` claude-code-规则到-khy-映射表](07_OPS_运维/[OPS-MAN-005] claude-code-规则到-khy-映射表.md)
- [`OPS-MAN-006` cli-万能接入-abu-案例](07_OPS_运维/[OPS-MAN-006] cli-万能接入-abu-案例.md)
- [`OPS-MAN-007` cli-万能接入-集成指南](07_OPS_运维/[OPS-MAN-007] cli-万能接入-集成指南.md)
- [`OPS-MAN-008` deepseek-tui-资源清理对齐](07_OPS_运维/[OPS-MAN-008] deepseek-tui-资源清理对齐.md)
- [`OPS-MAN-009` github-分支保护基线](07_OPS_运维/[OPS-MAN-009] github-分支保护基线.md)
- [`OPS-MAN-010` hermes风格-模型配置](07_OPS_运维/[OPS-MAN-010] hermes风格-模型配置.md)
- [`OPS-MAN-011` khy-os-学习指南](07_OPS_运维/[OPS-MAN-011] khy-os-学习指南.md)
- [`OPS-MAN-012` khy-os-应用接入指南](07_OPS_运维/[OPS-MAN-012] khy-os-应用接入指南.md)
- [`OPS-MAN-013` khy-os-开发者指南](07_OPS_运维/[OPS-MAN-013] khy-os-开发者指南.md)
- [`OPS-MAN-014` khy-os-用户指南-仅cli](07_OPS_运维/[OPS-MAN-014] khy-os-用户指南-仅cli.md)
- [`OPS-MAN-015` khy-os-用户指南](07_OPS_运维/[OPS-MAN-015] khy-os-用户指南.md)
- [`OPS-MAN-016` khy-ux-交付-深度学习指南](07_OPS_运维/[OPS-MAN-016] khy-ux-交付-深度学习指南.md)
- [`OPS-MAN-017` khy-智能体-五步实施](07_OPS_运维/[OPS-MAN-017] khy-智能体-五步实施.md)
- [`OPS-MAN-018` khy-编程智能体-风险预防-2026-05-30](07_OPS_运维/[OPS-MAN-018] khy-编程智能体-风险预防-2026-05-30.md)
- [`OPS-MAN-019` khy-远程ssh-实施清单](07_OPS_运维/[OPS-MAN-019] khy-远程ssh-实施清单.md)
- [`OPS-MAN-020` openagent-对齐日志](07_OPS_运维/[OPS-MAN-020] openagent-对齐日志.md)
- [`OPS-MAN-021` opencode-任务编排经验](07_OPS_运维/[OPS-MAN-021] opencode-任务编排经验.md)
- [`OPS-MAN-022` pip-安装布局参考](07_OPS_运维/[OPS-MAN-022] pip-安装布局参考.md)
- [`OPS-MAN-023` pip安装后-完整功能清单](07_OPS_运维/[OPS-MAN-023] pip安装后-完整功能清单.md) 📦 pip 上手
- [`OPS-MAN-024` pip安装后-按需配置体验](07_OPS_运维/[OPS-MAN-024] pip安装后-按需配置体验.md) 📦 pip 上手
- [`OPS-MAN-025` windows-vmware-清单](07_OPS_运维/[OPS-MAN-025] windows-vmware-清单.md)
- [`OPS-MAN-026` 会话恢复-按id](07_OPS_运维/[OPS-MAN-026] 会话恢复-按id.md)
- [`OPS-MAN-027` 快速开始](07_OPS_运维/[OPS-MAN-027] 快速开始.md) 📦 pip 上手·新手第一篇
- [`OPS-MAN-028` 环境要求](07_OPS_运维/[OPS-MAN-028] 环境要求.md) 📦 pip 上手
- [`OPS-MAN-029` 磁盘守卫-防膨胀机制](07_OPS_运维/[OPS-MAN-029] 磁盘守卫-防膨胀机制.md)
- [`OPS-MAN-030` 移动端远程指南](07_OPS_运维/[OPS-MAN-030] 移动端远程指南.md)
- [`OPS-MAN-031` 终端-tui-有框输入区重构方案-2026-05-31](07_OPS_运维/[OPS-MAN-031] 终端-tui-有框输入区重构方案-2026-05-31.md)
- [`OPS-MAN-032` 网关-自定义provider配置-agnes](07_OPS_运维/[OPS-MAN-032] 网关-自定义provider配置-agnes.md)
- [`OPS-MAN-033` 自动保护与回滚](07_OPS_运维/[OPS-MAN-033] 自动保护与回滚.md)
- [`OPS-MAN-034` TODO](07_OPS_运维/[OPS-MAN-034] TODO.md)
- [`OPS-MAN-035` 特性访问-维护速查-2026-06-01](07_OPS_运维/[OPS-MAN-035] 特性访问-维护速查-2026-06-01.md)
- [`OPS-MAN-036` khyos跨平台构建-Windows支持方案](07_OPS_运维/[OPS-MAN-036] khyos跨平台构建-Windows支持方案.md)
- [`OPS-MAN-037` pip安装后-完整还原与全功能开启指南](07_OPS_运维/[OPS-MAN-037] pip安装后-完整还原与全功能开启指南.md)
- [`OPS-MAN-038` AI元数据-.ai-种子文档-用法指南-2026-06-15](07_OPS_运维/[OPS-MAN-038] AI元数据-.ai-种子文档-用法指南-2026-06-15.md)
- [`OPS-MAN-039` 文档排版-用法指南-2026-06-12](07_OPS_运维/[OPS-MAN-039] 文档排版-用法指南-2026-06-12.md)
- [`OPS-MAN-040` Git入门-main-HEAD-分支-工作树-结合本仓库](07_OPS_运维/[OPS-MAN-040] Git入门-main-HEAD-分支-工作树-结合本仓库.md)
- [`OPS-MAN-041` 通过KHY学习模式-从0到1面试大厂Agent岗-路线图-2026-06-15](07_OPS_运维/[OPS-MAN-041] 通过KHY学习模式-从0到1面试大厂Agent岗-路线图-2026-06-15.md)
- [`OPS-MAN-042` 发布手册-pip与npm-无AI照做](07_OPS_运维/[OPS-MAN-042] 发布手册-pip与npm-无AI照做.md)
- [`OPS-MAN-043` 从0到高手-新手成长路线与pip安装后清单](07_OPS_运维/[OPS-MAN-043] 从0到高手-新手成长路线与pip安装后清单.md) ⭐ 新手从这里开始
- [`OPS-MAN-044` 从使用入门到开发精通-开发者成长路线](07_OPS_运维/[OPS-MAN-044] 从使用入门到开发精通-开发者成长路线.md) ⭐ 想做开发的接这里
- [`OPS-MAN-045` 账号池与多租户-深度指南](07_OPS_运维/[OPS-MAN-045] 账号池与多租户-深度指南.md)
- [`OPS-MAN-046` 旗舰特性目录-vault-notify-mesh-insights-forge-image2web](07_OPS_运维/[OPS-MAN-046] 旗舰特性目录-vault-notify-mesh-insights-forge-image2web.md)
- [`OPS-MAN-047` 代理服务器深度指南-khy-proxy](07_OPS_运维/[OPS-MAN-047] 代理服务器深度指南-khy-proxy.md)
- [`OPS-MAN-048` 本地模型微调-khy-train](07_OPS_运维/[OPS-MAN-048] 本地模型微调-khy-train.md)
- [`OPS-MAN-049` 算力与加速器自检-khy-compute](07_OPS_运维/[OPS-MAN-049] 算力与加速器自检-khy-compute.md)
- [`OPS-MAN-050` 成长档案迁移-khy-growth](07_OPS_运维/[OPS-MAN-050] 成长档案迁移-khy-growth.md)
- [`OPS-MAN-051` 知识库与教学自我认知-khy-knowledge](07_OPS_运维/[OPS-MAN-051] 知识库与教学自我认知-khy-knowledge.md)
- [`OPS-MAN-052` 安全守护-khy-security](07_OPS_运维/[OPS-MAN-052] 安全守护-khy-security.md)
- [`OPS-MAN-053` 监控与自检-khy-monitor](07_OPS_运维/[OPS-MAN-053] 监控与自检-khy-monitor.md)
- [`OPS-MAN-054` 变更裁决-khy-verdict](07_OPS_运维/[OPS-MAN-054] 变更裁决-khy-verdict.md)
- [`OPS-MAN-055` 可变性分级与变更治理-khy-evolve](07_OPS_运维/[OPS-MAN-055] 可变性分级与变更治理-khy-evolve.md)
- [`OPS-MAN-056` 按需依赖自愈-khy-deps](07_OPS_运维/[OPS-MAN-056] 按需依赖自愈-khy-deps.md)
- [`OPS-MAN-057` 工作流引擎-khy-workflow](07_OPS_运维/[OPS-MAN-057] 工作流引擎-khy-workflow.md)
- [`OPS-MAN-058` 环境开关与文档命名规范](07_OPS_运维/[OPS-MAN-058] 环境开关与文档命名规范.md)
- [`OPS-MAN-059` 文档-PDF与HTML生成与查看](07_OPS_运维/[OPS-MAN-059] 文档-PDF与HTML生成与查看.md)
- [`OPS-MAN-060` 高危操作为何被拒与如何放行](07_OPS_运维/[OPS-MAN-060] 高危操作为何被拒与如何放行.md)
- [`OPS-MAN-061` 发布门禁](07_OPS_运维/[OPS-MAN-061] 发布门禁.md)
- [`OPS-MAN-062` 键盘快捷键参考与跨平台对齐](07_OPS_运维/[OPS-MAN-062] 键盘快捷键参考与跨平台对齐.md)
- [`OPS-MAN-063` cc订阅迁移到新电脑-khy-claude-adopt-env](07_OPS_运维/[OPS-MAN-063] cc订阅迁移到新电脑-khy-claude-adopt-env.md)
- [`OPS-MAN-064` 打造最佳环境-如何扩展](07_OPS_运维/[OPS-MAN-064] 打造最佳环境-如何扩展.md)
- [`OPS-MAN-065` npm安装加速-npmrc模板](07_OPS_运维/[OPS-MAN-065] npm安装加速-npmrc模板.md)
- [`OPS-MAN-066` khyos进化提示词手册-1000条](07_OPS_运维/[OPS-MAN-066] khyos进化提示词手册-1000条.md)
- [`OPS-MAN-067` 症状分诊速查表](07_OPS_运维/[OPS-MAN-067] 症状分诊速查表.md)
- [`OPS-MAN-068` 离机还原自检清单](07_OPS_运维/[OPS-MAN-068] 离机还原自检清单.md)
- [`OPS-MAN-069` 已装副本完整性自检清单](07_OPS_运维/[OPS-MAN-069] 已装副本完整性自检清单.md)
- [`OPS-MAN-070` 首启依赖hydration自检清单](07_OPS_运维/[OPS-MAN-070] 首启依赖hydration自检清单.md)
- [`OPS-MAN-071` 卸载第三方应用怎么保证卸干净-原生自带卸载器](07_OPS_运维/[OPS-MAN-071] 卸载第三方应用怎么保证卸干净-原生自带卸载器.md)
- [`OPS-MAN-072` 目标连续多日运行不中断的底气自检](07_OPS_运维/[OPS-MAN-072] 目标连续多日运行不中断的底气自检.md)
- [`OPS-MAN-073` 离机渠道启动入口契约自检清单](07_OPS_运维/[OPS-MAN-073] 离机渠道启动入口契约自检清单.md)
- [`OPS-MAN-074` 首启崩溃真实原因加方法归因](07_OPS_运维/[OPS-MAN-074] 首启崩溃真实原因加方法归因.md)
- [`OPS-MAN-075` Agent 还原方案合成器](07_OPS_运维/[OPS-MAN-075] Agent 还原方案合成器.md)
- [`OPS-MAN-076` 三面镜子矛盾冲突检测](07_OPS_运维/[OPS-MAN-076] 三面镜子矛盾冲突检测.md)
- [`OPS-MAN-077` Windows md 文件建议的应用注册](07_OPS_运维/[OPS-MAN-077] Windows md 文件建议的应用注册.md)
- [`OPS-MAN-078` khy doctor 离机还原自检](07_OPS_运维/[OPS-MAN-078] khy doctor 离机还原自检.md)
- [`OPS-MAN-079` 三面镜子矛盾冲突消解](07_OPS_运维/[OPS-MAN-079] 三面镜子矛盾冲突消解.md)
- [`OPS-MAN-080` recap 的 CJK 化](07_OPS_运维/[OPS-MAN-080] recap 的 CJK 化.md)
- [`OPS-MAN-081` npm 渠道 Node 版本预检](07_OPS_运维/[OPS-MAN-081] npm 渠道 Node 版本预检.md)
- [`OPS-MAN-082` 三面镜子还原收敛与防循环](07_OPS_运维/[OPS-MAN-082] 三面镜子还原收敛与防循环.md)
- [`OPS-MAN-083` 依赖感知波次调度](07_OPS_运维/[OPS-MAN-083] 依赖感知波次调度.md)
- [`OPS-MAN-084` 还原自驱授权门](07_OPS_运维/[OPS-MAN-084] 还原自驱授权门.md)
- [`OPS-MAN-085` 还原补救追索](07_OPS_运维/[OPS-MAN-085] 还原补救追索.md)
- [`OPS-MAN-086` 还原轨迹日志](07_OPS_运维/[OPS-MAN-086] 还原轨迹日志.md)
- [`OPS-MAN-087` 波次执行故障感知](07_OPS_运维/[OPS-MAN-087] 波次执行故障感知.md)
- [`OPS-MAN-088` 还原策略台账](07_OPS_运维/[OPS-MAN-088] 还原策略台账.md)
- [`OPS-MAN-089` 还原学习应用器](07_OPS_运维/[OPS-MAN-089] 还原学习应用器.md)
- [`OPS-MAN-090` 还原导航器](07_OPS_运维/[OPS-MAN-090] 还原导航器.md)
- [`OPS-MAN-091` 波次前驱结果注入](07_OPS_运维/[OPS-MAN-091] 波次前驱结果注入.md)
- [`OPS-MAN-092` 跳过与失败在最终报告分列](07_OPS_运维/[OPS-MAN-092] 跳过与失败在最终报告分列.md)
- [`OPS-MAN-093` 确定性顺序链拆解](07_OPS_运维/[OPS-MAN-093] 确定性顺序链拆解.md)
- [`OPS-MAN-094` 角色工具作用域](07_OPS_运维/[OPS-MAN-094] 角色工具作用域.md)
- [`OPS-MAN-095` 还原解包完整性对账](07_OPS_运维/[OPS-MAN-095] 还原解包完整性对账.md)
- [`OPS-MAN-096` 多模型类型 Provider 配置对账](07_OPS_运维/[OPS-MAN-096] 多模型类型 Provider 配置对账.md)
- [`OPS-MAN-097` 角色工具作用域接线](07_OPS_运维/[OPS-MAN-097] 角色工具作用域接线.md)
- [`OPS-MAN-098` 并行写冲突检测](07_OPS_运维/[OPS-MAN-098] 并行写冲突检测.md)
- [`OPS-MAN-099` 空产出成功检测](07_OPS_运维/[OPS-MAN-099] 空产出成功检测.md)
- [`OPS-MAN-100` 便携 CLI 子系统](07_OPS_运维/[OPS-MAN-100] 便携 CLI 子系统.md)
- [`OPS-MAN-101` 角色归属诚实](07_OPS_运维/[OPS-MAN-101] 角色归属诚实.md)
- [`OPS-MAN-102` 卡住任务的强制终止逃生舱](07_OPS_运维/[OPS-MAN-102] 卡住任务的强制终止逃生舱.md)
- [`OPS-MAN-103` 写记忆·召回记忆明确告知用户](07_OPS_运维/[OPS-MAN-103] 写记忆·召回记忆明确告知用户.md)
- [`OPS-MAN-104` 纯文本模型图片 OCR 兜底与低置信诚实告诫](07_OPS_运维/[OPS-MAN-104] 纯文本模型图片 OCR 兜底与低置信诚实告诫.md)
- [`OPS-MAN-105` 还原快照格式兼容性对账](07_OPS_运维/[OPS-MAN-105] 还原快照格式兼容性对账.md)
- [`OPS-MAN-106` unpack 未知格式自救](07_OPS_运维/[OPS-MAN-106] unpack 未知格式自救.md)
- [`OPS-MAN-107` 还原来源可溯性对账](07_OPS_运维/[OPS-MAN-107] 还原来源可溯性对账.md)
- [`OPS-MAN-108` 还原归档形制可提取性对账](07_OPS_运维/[OPS-MAN-108] 还原归档形制可提取性对账.md)
- [`OPS-MAN-109` 纯文本模型图片 OCR 兜底覆盖率诚实告诫](07_OPS_运维/[OPS-MAN-109] 纯文本模型图片 OCR 兜底覆盖率诚实告诫.md)
- [`OPS-MAN-110` 还原解密套件可执行性对账](07_OPS_运维/[OPS-MAN-110] 还原解密套件可执行性对账.md)
- [`OPS-MAN-111` 纯文本模型图片 OCR 兜底截断诚实告诫](07_OPS_运维/[OPS-MAN-111] 纯文本模型图片 OCR 兜底截断诚实告诫.md)
- [`OPS-MAN-112` 纯文本模型图片 OCR 兜底语言包可用性诚实告诫](07_OPS_运维/[OPS-MAN-112] 纯文本模型图片 OCR 兜底语言包可用性诚实告诫.md)
- [`OPS-MAN-113` 还原字段效应探针（雅可比透镜）](07_OPS_运维/[OPS-MAN-113] 还原字段效应探针（雅可比透镜）.md)
- [`OPS-MAN-114` 还原字段归属探针（label preservation）](07_OPS_运维/[OPS-MAN-114] 还原字段归属探针（label preservation）.md)
- [`OPS-MAN-115` 纯文本模型图片 OCR 兜底方向自动校正](07_OPS_运维/[OPS-MAN-115] 纯文本模型图片 OCR 兜底方向自动校正.md)
- [`OPS-MAN-116` 纯文本模型图片 OCR 兜底低分辨率自动放大](07_OPS_运维/[OPS-MAN-116] 纯文本模型图片 OCR 兜底低分辨率自动放大.md)
- [`OPS-MAN-117` 还原完整性对账·运行时接线](07_OPS_运维/[OPS-MAN-117] 还原完整性对账·运行时接线.md)
- [`OPS-MAN-118` 视觉描述级联全失败 OCR 兜底底线解耦](07_OPS_运维/[OPS-MAN-118] 视觉描述级联全失败 OCR 兜底底线解耦.md)
- [`OPS-MAN-119` 还原解密前兼容性预检·运行时接线](07_OPS_运维/[OPS-MAN-119] 还原解密前兼容性预检·运行时接线.md)
- [`OPS-MAN-120` 剥图必留痕最小底线与OCR功能门解耦](07_OPS_运维/[OPS-MAN-120] 剥图必留痕最小底线与OCR功能门解耦.md)
- [`OPS-MAN-121` readFile二进制文件读前防护·接线](07_OPS_运维/[OPS-MAN-121] readFile二进制文件读前防护·接线.md)
- [`OPS-MAN-122` post-failure救援网剥图必留痕解耦](07_OPS_运维/[OPS-MAN-122] post-failure救援网剥图必留痕解耦.md)
- [`OPS-MAN-123` readFile按格式路由到提取器·接线](07_OPS_运维/[OPS-MAN-123] readFile按格式路由到提取器·接线.md)
- [`OPS-MAN-124` OCR成功路径向用户透明告知用了OCR](07_OPS_运维/[OPS-MAN-124] OCR成功路径向用户透明告知用了OCR.md)
- [`OPS-MAN-125` readFile特殊文件读前防护·接线](07_OPS_运维/[OPS-MAN-125] readFile特殊文件读前防护·接线.md)
- [`OPS-MAN-126` OCR成功路径确定性脚注兜底告知用了OCR](07_OPS_运维/[OPS-MAN-126] OCR成功路径确定性脚注兜底告知用了OCR.md)
- [`OPS-MAN-127` OCR救援网成功实时状态告知已降级到OCR](07_OPS_运维/[OPS-MAN-127] OCR救援网成功实时状态告知已降级到OCR.md)
- [`OPS-MAN-128` restore解密后归档形制解包前把关·接线](07_OPS_运维/[OPS-MAN-128] restore解密后归档形制解包前把关·接线.md)
- [`OPS-MAN-129` readFile伪文件系统有界超时读·接线](07_OPS_运维/[OPS-MAN-129] readFile伪文件系统有界超时读·接线.md)
- [`OPS-MAN-130` 还原来源可溯性·接线运行时横幅](07_OPS_运维/[OPS-MAN-130] 还原来源可溯性·接线运行时横幅.md)
- [`OPS-MAN-131` 重复代码检测门与公共测试脚手架](07_OPS_运维/[OPS-MAN-131] 重复代码检测门与公共测试脚手架.md)
- [`OPS-MAN-132` prep期OCR兜底非verbose实时状态告知已降级到OCR](07_OPS_运维/[OPS-MAN-132] prep期OCR兜底非verbose实时状态告知已降级到OCR.md)
- [`OPS-MAN-133` restore跨OS路径可移植性解包前把关·接线](07_OPS_运维/[OPS-MAN-133] restore跨OS路径可移植性解包前把关·接线.md)
- [`OPS-MAN-134` 视觉级联网络不可达终局诊断](07_OPS_运维/[OPS-MAN-134] 视觉级联网络不可达终局诊断.md)
- [`OPS-MAN-135` 工作流列表载入本页降级不泄漏全局横幅](07_OPS_运维/[OPS-MAN-135] 工作流列表载入本页降级不泄漏全局横幅.md)
- [`OPS-MAN-136` 首响应静默窗口守护·提交到首token及时回应·接线](07_OPS_运维/[OPS-MAN-136] 首响应静默窗口守护·提交到首token及时回应·接线.md)
- [`OPS-MAN-137` 网页代理内核二进制去哪下载·接确切官方URL到前端横幅](07_OPS_运维/[OPS-MAN-137] 网页代理内核二进制去哪下载·接确切官方URL到前端横幅.md)
- [`OPS-MAN-138` 空OCR剥图路径模型仍谎称没收到图的确定性纠正脚注](07_OPS_运维/[OPS-MAN-138] 空OCR剥图路径模型仍谎称没收到图的确定性纠正脚注.md)
- [`OPS-MAN-139` khy doctor 离机自检补代理内核下载指引CLI侧接线](07_OPS_运维/[OPS-MAN-139] khy doctor 离机自检补代理内核下载指引CLI侧接线.md)
- [`OPS-MAN-140` OCR成功读出但模型仍谎称没收到图的确定性纠正脚注](07_OPS_运维/[OPS-MAN-140] OCR成功读出但模型仍谎称没收到图的确定性纠正脚注.md)
- [`OPS-MAN-141` 代理内核安装显式CLI表面接线](07_OPS_运维/[OPS-MAN-141] 代理内核安装显式CLI表面接线.md)
- [`OPS-MAN-142` 失败墙推迟到OCR结果已知后减少心灵噪音](07_OPS_运维/[OPS-MAN-142] 失败墙推迟到OCR结果已知后减少心灵噪音.md)
- [`OPS-MAN-143` Windows保留设备名读前防护](07_OPS_运维/[OPS-MAN-143] Windows保留设备名读前防护.md)
- [`OPS-MAN-144` describe-fail到OCR成功的用户可见闭合减少心灵噪音](07_OPS_运维/[OPS-MAN-144] describe-fail到OCR成功的用户可见闭合减少心灵噪音.md)
- [`OPS-MAN-145` 级联逐候选请稍候提示减冗余减少心灵噪音](07_OPS_运维/[OPS-MAN-145] 级联逐候选请稍候提示减冗余减少心灵噪音.md)
- [`OPS-MAN-146` 主读工具FileReadTool防卡死守卫族parity接线](07_OPS_运维/[OPS-MAN-146] 主读工具FileReadTool防卡死守卫族parity接线.md)
- [`OPS-MAN-147` 次级读取工具统一读前防卡死前检](07_OPS_运维/[OPS-MAN-147] 次级读取工具统一读前防卡死前检.md)
- [`OPS-MAN-148` Site1-prep状态与OCR成功闭合跨层去重减少心灵噪音](07_OPS_运维/[OPS-MAN-148] Site1-prep状态与OCR成功闭合跨层去重减少心灵噪音.md)
- [`OPS-MAN-149` 编辑与探索读取工具接入统一读前防卡死前检](07_OPS_运维/[OPS-MAN-149] 编辑与探索读取工具接入统一读前防卡死前检.md)
- [`OPS-MAN-150` 级联中间提示显示归一去provider前缀减少心灵噪音](07_OPS_运维/[OPS-MAN-150] 级联中间提示显示归一去provider前缀减少心灵噪音.md)
- [`OPS-MAN-151` 缓存前缀击穿归因接线](07_OPS_运维/[OPS-MAN-151] 缓存前缀击穿归因接线.md)
- [`OPS-MAN-152` 交付门人类可读报告落盘接线](07_OPS_运维/[OPS-MAN-152] 交付门人类可读报告落盘接线.md)
- [`OPS-MAN-153` 会话快照损坏兜底修复接线](07_OPS_运维/[OPS-MAN-153] 会话快照损坏兜底修复接线.md)
- [`OPS-MAN-154` 任务模板执行手册注入接线](07_OPS_运维/[OPS-MAN-154] 任务模板执行手册注入接线.md)
- [`OPS-MAN-155` 指令注册表编译期收敛守卫接线](07_OPS_运维/[OPS-MAN-155] 指令注册表编译期收敛守卫接线.md)
- [`OPS-MAN-156` 取来即执行安全守卫接线](07_OPS_运维/[OPS-MAN-156] 取来即执行安全守卫接线.md)
- [`OPS-MAN-157` 用户显式 git-init 白名单覆盖接线](07_OPS_运维/[OPS-MAN-157] 用户显式 git-init 白名单覆盖接线.md)
- [`OPS-MAN-158` 本地模型并入统一目录接线](07_OPS_运维/[OPS-MAN-158] 本地模型并入统一目录接线.md)
- [`OPS-MAN-159` 失败墙视觉模型名显示归一去provider前缀减少心灵噪音](07_OPS_运维/[OPS-MAN-159] 失败墙视觉模型名显示归一去provider前缀减少心灵噪音.md)
- [`OPS-MAN-160` 行为特征化并入误报收口裁决接线](07_OPS_运维/[OPS-MAN-160] 行为特征化并入误报收口裁决接线.md)
- [`OPS-MAN-161` 失败墙真实失败原因标签去重减少心灵噪音](07_OPS_运维/[OPS-MAN-161] 失败墙真实失败原因标签去重减少心灵噪音.md)
- [`OPS-MAN-162` CLI-Web管理面平价守卫接线](07_OPS_运维/[OPS-MAN-162] CLI-Web管理面平价守卫接线.md)
- [`OPS-MAN-163` 动作契约核验器CI强制接线](07_OPS_运维/[OPS-MAN-163] 动作契约核验器CI强制接线.md)
- [`OPS-MAN-164` 视觉池失败状态人话化减少心灵噪音](07_OPS_运维/[OPS-MAN-164] 视觉池失败状态人话化减少心灵噪音.md)
- [`OPS-MAN-165` khy 个性化调优与使用建议](07_OPS_运维/[OPS-MAN-165] khy 个性化调优与使用建议.md)
- [`OPS-MAN-166` cc(Claude Code)个性化使用说明书·重逢版](<07_OPS_运维/[OPS-MAN-166] cc(Claude Code)个性化使用说明书·重逢版.md>)
- [`OPS-MAN-167` khy msg 多平台消息收发（钉钉·飞书·企业微信）](07_OPS_运维/[OPS-MAN-167] khy msg 多平台消息收发（钉钉·飞书·企业微信）.md)
- [`OPS-MAN-168` 弱模型护栏与维护子系统登记](07_OPS_运维/[OPS-MAN-168] 弱模型护栏与维护子系统登记.md)
- [`OPS-MAN-169` 项目规则总纲-命名·skill·权限·mcp](07_OPS_运维/%5BOPS-MAN-169%5D%20项目规则总纲-命名·skill·权限·mcp.md)
- [`OPS-MAN-170` 外部技能安装-khy-skill-add](07_OPS_运维/[OPS-MAN-170] 外部技能安装-khy-skill-add.md)
- [`OPS-MAN-171` 技能包规范-manifest与prompt模板](07_OPS_运维/[OPS-MAN-171] 技能包规范-manifest与prompt模板.md)
- [`OPS-MAN-172` 自定义供应商接入指南](07_OPS_运维/[OPS-MAN-172] 自定义供应商接入指南.md)
- [`OPS-MAN-173` MCP工具接入快速上手](07_OPS_运维/[OPS-MAN-173] MCP工具接入快速上手.md)
- [`OPS-MAN-174` 任务入口总表](07_OPS_运维/[OPS-MAN-174] 任务入口总表.md) — 根 `package.json` 每条 `npm run` 入口：跑哪个脚本、守住什么、何时跑，附旧名→新名对照
- [`OPS-MAN-175` 首次运行自动登录与凭据](07_OPS_运维/[OPS-MAN-175] 首次运行自动登录与凭据.md) — 默认管理员如何生成、密码落在哪、CLI 为什么不需要先起后端
- [`OPS-MAN-176` 数据备份与恢复](07_OPS_运维/[OPS-MAN-176] 数据备份与恢复.md) — `khy backup` 全流程：备份集布局、备什么不备什么、SQLite 只能热备、恢复的五道闸、保留策略语义、JSON 原子写迁移
- [`OPS-MAN-200` config-auto-repair](07_OPS_运维/[OPS-MAN-200] config-auto-repair.md) — 启动时自动检测并修复网关配置问题，含手动重置入口
- [`OPS-MAN-205` API厂商快速配置指南](07_OPS_运维/[OPS-MAN-205] API厂商快速配置指南.md) — `khy gateway` API 厂商快速配置：8 家厂商的环境变量名/默认端点/注册取 Key 步骤/各厂商可用模型清单/故障排除；2026-09-15 由原 279 行完整版取代同题 116 行薄副本（薄副本内容为其子集，编号槽保留）

2026-09-15 补登记（此前漏链，`check:layout` 的 `docs-index-complete` 因此报 15）：

- [`OPS-MAN-201` dependencies](07_OPS_运维/[OPS-MAN-201] dependencies.md)
- [`OPS-MAN-202` oncall](07_OPS_运维/[OPS-MAN-202] oncall.md)
- [`OPS-MAN-203` standards-enforcement](07_OPS_运维/[OPS-MAN-203] standards-enforcement.md)
- [`OPS-MAN-204` technical-debt-report](07_OPS_运维/[OPS-MAN-204] technical-debt-report.md)

## 08_MGMT_项目管理

- [`MGMT-OTHER-001` RESTORE_WINDOWS](08_MGMT_项目管理/[MGMT-OTHER-001] RESTORE_WINDOWS.md)
- [`MGMT-OTHER-002` 事后分析-终端崩溃-2026-05-09](08_MGMT_项目管理/[MGMT-OTHER-002] 事后分析-终端崩溃-2026-05-09.md)
- [`MGMT-OTHER-003` 索引](08_MGMT_项目管理/[MGMT-OTHER-003] 索引.md)
- [`MGMT-OTHER-004` 事后分析-Windows内核构建为何之前失败现在成功-2026-06-26](08_MGMT_项目管理/[MGMT-OTHER-004] 事后分析-Windows内核构建为何之前失败现在成功-2026-06-26.md)
- [`MGMT-PLAN-001` khy-os-体验改进计划-2026-05-26](08_MGMT_项目管理/[MGMT-PLAN-001] khy-os-体验改进计划-2026-05-26.md)
- [`MGMT-PLAN-002` khy-librechat-差距修复路线图](08_MGMT_项目管理/[MGMT-PLAN-002] khy-librechat-差距修复路线图.md)
- [`MGMT-PLAN-003` khy-大任务框架蓝图](08_MGMT_项目管理/[MGMT-PLAN-003] khy-大任务框架蓝图.md)
- [`MGMT-PLAN-004` 三项目改进计划-2026-05-24](08_MGMT_项目管理/[MGMT-PLAN-004] 三项目改进计划-2026-05-24.md)
- [`MGMT-PLAN-005` 自主生产计划-r2-2026-05-24](08_MGMT_项目管理/[MGMT-PLAN-005] 自主生产计划-r2-2026-05-24.md)
- [`MGMT-PLAN-006` 智能体-操作系统-路线图](08_MGMT_项目管理/[MGMT-PLAN-006] 智能体-操作系统-路线图.md)
- [`MGMT-PLAN-007` Khy-OS远景演进路线图-2026-06-12](08_MGMT_项目管理/[MGMT-PLAN-007] Khy-OS远景演进路线图-2026-06-12.md)
- [`MGMT-PLAN-008` replSession与toolUseLoopCore拆分分批计划](08_MGMT_项目管理/[MGMT-PLAN-008] replSession与toolUseLoopCore拆分分批计划.md)
- [`MGMT-RPT-001` deepseek-tui-对标](08_MGMT_项目管理/[MGMT-RPT-001] deepseek-tui-对标.md)
- [`MGMT-RPT-002` khy-对比-desirecore-借鉴分析](08_MGMT_项目管理/[MGMT-RPT-002] khy-对比-desirecore-借鉴分析.md)
- [`MGMT-RPT-003` khy-对比-hermes-成长架构](08_MGMT_项目管理/[MGMT-RPT-003] khy-对比-hermes-成长架构.md)
- [`MGMT-RPT-004` khy-对比-openagent-交付差距](08_MGMT_项目管理/[MGMT-RPT-004] khy-对比-openagent-交付差距.md)
- [`MGMT-RPT-005` khy-对比-qwen-code-差距分析](08_MGMT_项目管理/[MGMT-RPT-005] khy-对比-qwen-code-差距分析.md)
- [`MGMT-RPT-006` AB-交付质量对齐-2026-06-03](08_MGMT_项目管理/[MGMT-RPT-006] AB-交付质量对齐-2026-06-03.md)
- [`MGMT-RPT-007` cli-基准对比-2026-05-19](08_MGMT_项目管理/[MGMT-RPT-007] cli-基准对比-2026-05-19.md)
- [`MGMT-RPT-008` hermes-khy-p0-执行任务-2026-05-17](08_MGMT_项目管理/[MGMT-RPT-008] hermes-khy-p0-执行任务-2026-05-17.md)
- [`MGMT-RPT-009` hermes-成长架构-学习清单-2026-05-17](08_MGMT_项目管理/[MGMT-RPT-009] hermes-成长架构-学习清单-2026-05-17.md)
- [`MGMT-RPT-010` windows-工具调用循环冻结-2026-05-28](08_MGMT_项目管理/[MGMT-RPT-010] windows-工具调用循环冻结-2026-05-28.md)
- [`MGMT-RPT-011` 三项目深度学习-2026-05-21](08_MGMT_项目管理/[MGMT-RPT-011] 三项目深度学习-2026-05-21.md)
- [`MGMT-RPT-012` ai-显示-对标与对齐](08_MGMT_项目管理/[MGMT-RPT-012] ai-显示-对标与对齐.md)
- [`MGMT-RPT-013` cc-对标-第六轮-2026-05-26](08_MGMT_项目管理/[MGMT-RPT-013] cc-对标-第六轮-2026-05-26.md)
- [`MGMT-RPT-014` khy-qwen-差距修复清单](08_MGMT_项目管理/[MGMT-RPT-014] khy-qwen-差距修复清单.md)
- [`MGMT-RPT-015` khy-ux-交互对标](08_MGMT_项目管理/[MGMT-RPT-015] khy-ux-交互对标.md)
- [`MGMT-RPT-016` 竞品情报图谱](08_MGMT_项目管理/[MGMT-RPT-016] 竞品情报图谱.md)
- [`MGMT-RPT-017` 项目矛盾审计-2026-05-21-r2](08_MGMT_项目管理/[MGMT-RPT-017] 项目矛盾审计-2026-05-21-r2.md)
- [`MGMT-RPT-018` 项目矛盾审计-2026-05-21](08_MGMT_项目管理/[MGMT-RPT-018] 项目矛盾审计-2026-05-21.md)
- [`MGMT-RPT-019` 架构对比-cc-vs-khy](08_MGMT_项目管理/[MGMT-RPT-019] 架构对比-cc-vs-khy.md)
- [`MGMT-RPT-020` 项目痛点诊断报告-2026-06-13](08_MGMT_项目管理/[MGMT-RPT-020] 项目痛点诊断报告-2026-06-13.md)
- [`MGMT-RPT-021` 全量审查报告甄别-bundled路径与本仓源码对照-2026-07-14](08_MGMT_项目管理/[MGMT-RPT-021] 全量审查报告甄别-bundled路径与本仓源码对照-2026-07-14.md)
- [`MGMT-RPT-022` 借鉴项目清单](08_MGMT_项目管理/[MGMT-RPT-022] 借鉴项目清单.md)
- [`MGMT-RPT-023` GitHub调研-模型训练-2026-09-12](08_MGMT_项目管理/[MGMT-RPT-023] GitHub调研-模型训练-2026-09-12.md) — 模型训练方向的 GitHub 调研记录（LoRA/蒸馏/导出相关生态，modelTrainingService 的上游调研输入）
- [`MGMT-RPT-024` 数据整备与多教师蒸馏设计方案-2026-09-13](08_MGMT_项目管理/[MGMT-RPT-024] 数据整备与多教师蒸馏设计方案-2026-09-13.md)
- [`MGMT-RPT-025` 模型发现UI与一键链路收敛-2026-09-13](08_MGMT_项目管理/[MGMT-RPT-025] 模型发现UI与一键链路收敛-2026-09-13.md)
- [`MGMT-RPT-026` GitHub调研-回测引擎-2026-09-13](08_MGMT_项目管理/[MGMT-RPT-026] GitHub调研-回测引擎-2026-09-13.md)
- [`MGMT-RPT-027` GitHub调研-双机同步-2026-09-14](08_MGMT_项目管理/[MGMT-RPT-027] GitHub调研-双机同步-2026-09-14.md)
- [`MGMT-STD-001` 项目文档结构与索引铁律规范](08_MGMT_项目管理/%5BMGMT-STD-001%5D%20项目文档结构与索引铁律规范.md)
- [`MGMT-STD-002` 工程交付综合系统提示词-文档结构与内嵌MD工作台](08_MGMT_项目管理/[MGMT-STD-002] 工程交付综合系统提示词-文档结构与内嵌MD工作台.md)
- [`MGMT-STD-003` 任务三综合系统提示词-模型自适应与双轨热插拔架构](08_MGMT_项目管理/[MGMT-STD-003] 任务三综合系统提示词-模型自适应与双轨热插拔架构.md)
- [`MGMT-STD-004` 曼孚-vibecoding-交付方法论-流程铁律](08_MGMT_项目管理/[MGMT-STD-004] 曼孚-vibecoding-交付方法论-流程铁律.md)
- [`MGMT-STD-005` Khyos工作方法论-证据搜集与计划落地铁律](08_MGMT_项目管理/[MGMT-STD-005] Khyos工作方法论-证据搜集与计划落地铁律.md)
- [`MGMT-STD-006` khy-vibecoding与speccoding能力对齐-可量化验收标准](08_MGMT_项目管理/[MGMT-STD-006] khy-vibecoding与speccoding能力对齐-可量化验收标准.md)
- [`MGMT-STD-007` 文档规则总纲](08_MGMT_项目管理/[MGMT-STD-007] 文档规则总纲.md)
- [`MGMT-STD-008` 规则编写与管理规范（元规则）](08_MGMT_项目管理/%5BMGMT-STD-008%5D%20规则编写与管理规范（元规则）.md)
- [`MGMT-STD-008` 规则编写与管理规范（元规则）](08_MGMT_项目管理/[MGMT-STD-008] 规则编写与管理规范（元规则）.md) — 如何编写/登记/退役一条治理规则本身的元规则


## AI协作预设包（跨阶段 · 分「给人看 / 给AI看」两线）

> 用途：在「只能用弱模型/陌生大模型、且靠 pip 分发」的场景下继续维护本项目。
> **严格区分受众**：`给人看/` 是你自己的操作与决策；`给AI看/` 是可直接整段粘贴给 AI 的内容。

- [总入口](_AI协作预设包/00_INDEX_总入口.md)

**🚀 先看两份总说明（最快掌握）**
- 🧑 [总说明-一页速览（给人）](_AI协作预设包/给人看/总说明-一页速览.md) — 你自己 30 秒看懂全局
- 🤖 [总说明-一次读懂全局（给AI）](_AI协作预设包/给AI看/总说明-一次读懂全局.md) — 整段发给 AI 即读懂全貌

**🧑 给人看/（你先从这里开始）**
- [总说明-一页速览](_AI协作预设包/给人看/总说明-一页速览.md)
- [使用说明-怎么用这套包](_AI协作预设包/给人看/使用说明-怎么用这套包.md)
- [排错速查-给人](_AI协作预设包/给人看/排错速查-给人.md)
- [发展路径-决策与选活](_AI协作预设包/给人看/发展路径-决策与选活.md)
- [命脉自保清单-给人](_AI协作预设包/给人看/命脉自保清单-给人.md)
- [长任务提示词库-给人](_AI协作预设包/给人看/长任务提示词库-给人.md) — 9 条长任务/无人值守/断点续跑提示词，全部对齐 Boulder 断点、错误分类引擎、熔断与 RELIABILITY-PROTOCOL 七大约束。

**🤖 给AI看/（复制里面内容发给 AI）**
- [总说明-一次读懂全局](_AI协作预设包/给AI看/总说明-一次读懂全局.md)
- [项目情况说明-开场白](_AI协作预设包/给AI看/项目情况说明-开场白.md)
- [协作铁律](_AI协作预设包/给AI看/协作铁律.md)
- [错误自查手册](_AI协作预设包/给AI看/错误自查手册.md)
- [任务派发卡](_AI协作预设包/给AI看/任务派发卡.md)

**🧩 skills/（装进 khy 指导弱模型现场执行）**
- [skills 集合总说明](_AI协作预设包/skills/00_INDEX_技能包-总目录.md) — 8 个可安装 skill：onboarding / safe-change / weak-model-guardrails / pick-task / troubleshoot / gateway-fix / release-safety / honest-closure。装法：`khy skill import <目录>` 或放 `~/.khy/skills/`。
