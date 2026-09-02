# 📚 Khy-OS 文档索引

> 本索引为文档总入口，按「阶段 → 类型 → 序号」归类，命名格式 `[阶段-类型-序号] 中文名`（更新于 2026-08-17）。
> 各阶段目录另设 `00_INDEX_*` 分类索引作为该目录的就近导航入口。

> 📈 **首次克隆后请跑一次 `npm run docs:build`**：图表引擎 `docs/_assets/mermaid.min.js`
> 是 `scripts/docs/mermaid-embed/` 的构建产物、不进 git，在重建之前所有 Mermaid 图表区域留白。

## 阶段总览

| 序号 | 阶段目录 | 文档数 | 本索引已列 |
|---|---|---:|---:|
| 01 | `01_INIT_立项/` | 2 | 2 |
| 02 | `02_CONCEPTS_概念入门/` | 33 | 目录入口（见下） |
| 03 | `03_DESIGN_设计/` | 78 | 78 |
| 04 | `04_IMPL_实现/` | 38 | 38 |
| 05 | `05_TEST_测试/` | 9 | 9 |
| 06 | `06_DEPLOY_部署/` | 22 | 22 |
| 07 | `07_OPS_运维/` | 178 | 178 |
| 08 | `08_MGMT_项目管理/` | 38 | 38 |
| 09 | `09_STORY_修仙学AI/` | 29 | 目录入口（见下） |
| — | `_AI协作预设包/`（跨阶段·分「给人看/给AI看」两线 + 可安装 skills/） | 12 文档 + 8 skill | — |

> ✅ **本页与磁盘现实已对齐**（2026-08-17 实测）：「文档数」是各阶段目录下非索引 `.md` 的
> 实际文件数，「本索引已列」是本页实际链到的文档份数。上一轮遗留的 **`07_OPS_运维/` 102 份
> 漏链**已于本轮全部补齐（连同 `03_DESIGN_设计/` 的 1 份），`docs-index-complete` 实测为 **0**。
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

> 📖 **想按「从启动到愿景」的认知顺序读懂架构**：[`[DESIGN-ARCH-063]` 对照《Claude Code 架构》一书读懂 Khy-OS](03_DESIGN_设计/%5BDESIGN-ARCH-063%5D%20对照《Claude%20Code%20架构》一书读懂%20Khy-OS.md) — 借一本讲 Claude Code 架构的书的目录当骨架，逐章把「书里的 CC 概念」对齐到「khy 此刻真实的实现（文件:行）」，并如实标注相同/khy 特有/未做之处。它与本索引的**生命周期分类法互补**：本索引答「一个功能怎么落地」，那篇答「按认知顺序从启动一路读到 Agent-as-OS 愿景」。

## ⚖️ 规则与标准（改动前必读三篇）

**任何要改本仓库的人或 AI，动手前必须先读这三篇**：它们构成完整的治理三角 — 文档规范 + 代码层级 + 综合规则索引。

1. **[`[MGMT-STD-001]` 项目文档结构与索引铁律规范](08_MGMT_项目管理/%5BMGMT-STD-001%5D%20项目文档结构与索引铁律规范.md)** — **文档侧单一真源**：① 根目录只允许 README（封闭白名单外的说明性文件必须归入 `docs/`）；② `docs/` 下每个子目录**必须**有一个排序首位的索引文件；③ 编号与命名**由 AI 动态决策**（感知目录既有惯例、确保逻辑连贯），严禁写死固定格式。守卫：`npm run check:layout`（`docs-index-complete` / `root-whitelist` / `docs-index-first` 规则）。

2. **[`[DESIGN-ARCH-068]` 仓库层级板块规范](03_DESIGN_设计/%5BDESIGN-ARCH-068%5D%20仓库层级板块规范.md)** — **代码侧单一真源**：① 顶层目录的层级定位（L0 内核 → L1 启动器 → L2 业务逻辑 → L3 平台前端 → L4 内置应用 → L5 IDE 桥接 → L6 开发工具）；② 允许的依赖方向白名单（不是全序）；③ `docs/` 两轴命名（编号轴 `NN_STAGE_` 是生命周期阶段，`_` 前缀轴是跨阶段资产）；④ 任务入口命名规约。守卫：`npm run check:layout`（`layer-registry` / `cross-layer-require` / `unresolved-require` 规则）。

3. **[`[OPS-MAN-169]` 项目规则总纲-命名·skill·权限·mcp](07_OPS_运维/%5BOPS-MAN-169%5D%20项目规则总纲-命名·skill·权限·mcp.md)** — **一站式规则索引与导读**：把散落在 `CLAUDE.md` / `AGENTS.md` / `.ai/GUARDS.md` 与各处代码里的「项目规则」收拢到一张地图 — 红线（R1–R4：分支纪律、密钥防泄露、双渠道版本同步、上帝文件门）、行为准则（B1–B3：先想再写、目标驱动执行、外科手术式改动）、验收门禁（三守卫 + arch:god + 映射表覆盖）、板块层级速查、文档命名速查、Skill 规则（CC 斜杠命令 + khy 原生 SKILL.md 引擎 + 桥接）、权限规则（6 档 + critical gate + 弱模型护栏）、MCP 规则、双渠道版本同步。每一条规则都标了它的**强制真源**（代码读取点或章程原文）；规则语义**永远以真源为准**。

> 📌 **为什么是这三篇**：[MGMT-STD-001] 管文档怎么放、怎么命名、怎么索引；[DESIGN-ARCH-068] 管代码怎么分层、哪层能调哪层、新文件该放哪；[OPS-MAN-169] 是上面两篇 + `CLAUDE.md` / `AGENTS.md` 的统一入口索引。读完这三篇，你就知道「红线在哪、规范怎么查、守卫怎么跑」。

## 🐣 完全新手从这里开始（概念入门 + 修仙故事）

如果你**没有编程/AI 基础**，别从上面的架构文档入手，先读这两套面向小白的材料：

- 📗 **[概念入门总览](02_CONCEPTS_概念入门/00_INDEX_概念入门-总览.md)** — 用生活比喻把 AI 助手背后的 **13 个核心概念**讲透：Agent、工具调用（Tool Calling）、工具循环（Tool Loop）、MCP、Skill（基础五篇）＋ LLM 大模型、Prompt、上下文与令牌、Embedding 向量、向量数据库、RAG、机器学习、深度学习（进阶八篇）。每篇都有比喻、图表、常见误区、动手小实验。
- 📖 **[《算道天书》：修仙学 AI](09_STORY_修仙学AI/00_INDEX_修仙学AI-总目录.md)** — 一部 14 章的修仙长篇小说，主人公孔浩原从山村药童修炼成 **AI 大师**，每个境界对应一个上面的概念，章末「凡人笔记」翻译回真实术语。**当爽文看会上头，当教材看会开窍。**

## 01_INIT_立项

- [`INIT-PRD-001` Khy-OS-定位与已实现能力-2026-06-12](01_INIT_立项/%5BINIT-PRD-001%5D%20Khy-OS-定位与已实现能力-2026-06-12.md)
- [`INIT-PRD-002` 项目-定位](01_INIT_立项/%5BINIT-PRD-002%5D%20项目-定位.md)

## 03_DESIGN_设计

- [`DESIGN-ARCH-001` khy-移动智能体协议](03_DESIGN_设计/%5BDESIGN-ARCH-001%5D%20khy-移动智能体协议.md)
- [`DESIGN-ARCH-002` Khyos-CB-SSP-数学建模与实现映射](03_DESIGN_设计/%5BDESIGN-ARCH-002%5D%20Khyos-CB-SSP-数学建模与实现映射.md)
- [`DESIGN-ARCH-003` Khyos-数学重塑-受约束随机最短路径](03_DESIGN_设计/%5BDESIGN-ARCH-003%5D%20Khyos-数学重塑-受约束随机最短路径.md)
- [`DESIGN-ARCH-004` _cbssp_progress](03_DESIGN_设计/%5BDESIGN-ARCH-004%5D%20_cbssp_progress.md)
- [`DESIGN-ARCH-005` agentfs-智能体文件系统](03_DESIGN_设计/%5BDESIGN-ARCH-005%5D%20agentfs-智能体文件系统.md)
- [`DESIGN-ARCH-006` ai-gateway-适配器协议架构](03_DESIGN_设计/%5BDESIGN-ARCH-006%5D%20ai-gateway-适配器协议架构.md)
- [`DESIGN-ARCH-007` m1-微内核-ipc-moonbit](03_DESIGN_设计/%5BDESIGN-ARCH-007%5D%20m1-微内核-ipc-moonbit.md)
- [`DESIGN-ARCH-008` moonbit-系统边界](03_DESIGN_设计/%5BDESIGN-ARCH-008%5D%20moonbit-系统边界.md)
- [`DESIGN-ARCH-009` 可视化拖拽工作流编辑器-2026-06-09](03_DESIGN_设计/%5BDESIGN-ARCH-009%5D%20可视化拖拽工作流编辑器-2026-06-09.md)
- [`DESIGN-ARCH-010` 核心架构](03_DESIGN_设计/%5BDESIGN-ARCH-010%5D%20核心架构.md)
- [`DESIGN-ARCH-011` 应用接入标准](03_DESIGN_设计/%5BDESIGN-ARCH-011%5D%20应用接入标准.md)
- [`DESIGN-ARCH-012` 工具延迟加载](03_DESIGN_设计/%5BDESIGN-ARCH-012%5D%20工具延迟加载.md)
- [`DESIGN-ARCH-013` 弱模型兼容](03_DESIGN_设计/%5BDESIGN-ARCH-013%5D%20弱模型兼容.md)
- [`DESIGN-ARCH-014` 模式图谱](03_DESIGN_设计/%5BDESIGN-ARCH-014%5D%20模式图谱.md)
- [`DESIGN-ARCH-015` 编码规范](03_DESIGN_设计/%5BDESIGN-ARCH-015%5D%20编码规范.md)
- [`DESIGN-ARCH-016` AI_Agent显示规范](03_DESIGN_设计/%5BDESIGN-ARCH-016%5D%20AI_Agent显示规范.md)
- [`DESIGN-ARCH-017` 元工具系统设计](03_DESIGN_设计/%5BDESIGN-ARCH-017%5D%20元工具系统设计.md)
- [`DESIGN-ARCH-018` Agent提示词复用机制](03_DESIGN_设计/%5BDESIGN-ARCH-018%5D%20Agent提示词复用机制.md)
- [`DESIGN-ARCH-019` 用户输入预处理规范](03_DESIGN_设计/%5BDESIGN-ARCH-019%5D%20用户输入预处理规范.md)
- [`DESIGN-ARCH-020` 架构债治理报告](03_DESIGN_设计/%5BDESIGN-ARCH-020%5D%20架构债治理报告.md)
- [`DESIGN-ARCH-021` 巨型环反转设计](03_DESIGN_设计/%5BDESIGN-ARCH-021%5D%20巨型环反转设计.md)
- [`DESIGN-ARCH-022` khyos多实例并发文件控制规范](03_DESIGN_设计/%5BDESIGN-ARCH-022%5D%20khyos多实例并发文件控制规范.md)
- [`DESIGN-ARCH-023` khyos文档排版与格式控制规范](03_DESIGN_设计/%5BDESIGN-ARCH-023%5D%20khyos文档排版与格式控制规范.md)
- [`DESIGN-ARCH-024` khyos元帅双模式任命与约束规范（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/%5BDESIGN-ARCH-024%5D%20khyos元帅双模式任命与约束规范.md)
- [`DESIGN-ARCH-025` khyos元规划协议与动态约束注入规范](03_DESIGN_设计/%5BDESIGN-ARCH-025%5D%20khyos元规划协议与动态约束注入规范.md)
- [`DESIGN-ARCH-026` khyos系统级服务调用审批网关规范](03_DESIGN_设计/%5BDESIGN-ARCH-026%5D%20khyos系统级服务调用审批网关规范.md)
- [`DESIGN-ARCH-027` Agent依赖自愈机制规范](03_DESIGN_设计/%5BDESIGN-ARCH-027%5D%20Agent依赖自愈机制规范.md)
- [`DESIGN-ARCH-028` Agent通信防御-零静默失败与精准归因](03_DESIGN_设计/%5BDESIGN-ARCH-028%5D%20Agent通信防御-零静默失败与精准归因.md)
- [`DESIGN-ARCH-029` Agent有限窗口降级与强制兜底执行协议](03_DESIGN_设计/%5BDESIGN-ARCH-029%5D%20Agent有限窗口降级与强制兜底执行协议.md)
- [`DESIGN-ARCH-030` 源端构建-目标机自愈运行](03_DESIGN_设计/%5BDESIGN-ARCH-030%5D%20源端构建-目标机自愈运行.md)
- [`DESIGN-ARCH-031` 网关日志租界隔离-按需可见与净味翻译](03_DESIGN_设计/%5BDESIGN-ARCH-031%5D%20网关日志租界隔离-按需可见与净味翻译.md)
- [`DESIGN-ARCH-032` 内嵌MD工作台与跨平台右键集成](03_DESIGN_设计/%5BDESIGN-ARCH-032%5D%20内嵌MD工作台与跨平台右键集成.md)
- [`DESIGN-ARCH-033` 模型自适应与双轨热插拔架构（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/%5BDESIGN-ARCH-033%5D%20模型自适应与双轨热插拔架构.md)
- [`DESIGN-ARCH-034` 动态自适应约束求解引擎](03_DESIGN_设计/%5BDESIGN-ARCH-034%5D%20动态自适应约束求解引擎.md)
- [`DESIGN-ARCH-035` 上下文永续与认知压缩引擎（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/%5BDESIGN-ARCH-035%5D%20上下文永续与认知压缩引擎.md)
- [`DESIGN-ARCH-036` 万物结构化熔炉引擎](03_DESIGN_设计/%5BDESIGN-ARCH-036%5D%20万物结构化熔炉引擎.md)
- [`DESIGN-ARCH-037` Khyos自举创世-需求内源发生器与闭环自愈引擎](03_DESIGN_设计/%5BDESIGN-ARCH-037%5D%20Khyos自举创世-需求内源发生器与闭环自愈引擎.md)
- [`DESIGN-ARCH-038` Khyos双轨淬火-确定性保底与模型辅助增强的Bug升维引擎（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/%5BDESIGN-ARCH-038%5D%20Khyos双轨淬火-确定性保底与模型辅助增强的Bug升维引擎.md)
- [`DESIGN-ARCH-039` Khyos环境共生-环境感知与原生亲和架构（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/%5BDESIGN-ARCH-039%5D%20Khyos环境共生-环境感知与原生亲和架构.md)
- [`DESIGN-ARCH-040` Khyos数据主权与极权路由-数据主权绝对论与单一权威注入网关（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/%5BDESIGN-ARCH-040%5D%20Khyos数据主权与极权路由-数据主权绝对论与单一权威注入网关.md)
- [`DESIGN-ARCH-041` Khyos意图精准裁决-意图光谱解析与动态提权网关](03_DESIGN_设计/%5BDESIGN-ARCH-041%5D%20Khyos意图精准裁决-意图光谱解析与动态提权网关.md)
- [`DESIGN-ARCH-042` Khyos自持基建-契约即文档与影响面评估与行为守卫（已归档·孤儿引擎）](03_DESIGN_设计/_archive_已删除孤儿引擎/%5BDESIGN-ARCH-042%5D%20Khyos自持基建-契约即文档与影响面评估与行为守卫.md)
- [`DESIGN-ARCH-043` khy-agent-sdk-Claude对齐与D1-D6融合规范](03_DESIGN_设计/%5BDESIGN-ARCH-043%5D%20khy-agent-sdk-Claude对齐与D1-D6融合规范.md)
- [`DESIGN-ARCH-044` Agent自愈微循环-诊断修复重试](03_DESIGN_设计/%5BDESIGN-ARCH-044%5D%20Agent自愈微循环-诊断修复重试.md)
- [`DESIGN-ARCH-045` 非活跃通道生命周期治理-僵尸后台收回与日志越权阻断](03_DESIGN_设计/%5BDESIGN-ARCH-045%5D%20非活跃通道生命周期治理-僵尸后台收回与日志越权阻断.md)
- [`DESIGN-ARCH-046` 聊天状态污染与回复截断治理-原子轮提交与空结果重试与截断信号保真](03_DESIGN_设计/%5BDESIGN-ARCH-046%5D%20聊天状态污染与回复截断治理-原子轮提交与空结果重试与截断信号保真.md)
- [`DESIGN-ARCH-047` 轨迹溯源标准-溯源信封与防篡改链与注入隔离](03_DESIGN_设计/%5BDESIGN-ARCH-047%5D%20轨迹溯源标准-溯源信封与防篡改链与注入隔离.md)
- [`DESIGN-ARCH-048` khyos轨迹回放与确定性复现](03_DESIGN_设计/%5BDESIGN-ARCH-048%5D%20khyos轨迹回放与确定性复现.md)
- [`DESIGN-ARCH-049` 轨迹即教材-AI引导回放](03_DESIGN_设计/%5BDESIGN-ARCH-049%5D%20轨迹即教材-AI引导回放.md)
- [`DESIGN-ARCH-050` 项目整体意识与自驱收尾保障](03_DESIGN_设计/%5BDESIGN-ARCH-050%5D%20项目整体意识与自驱收尾保障.md)
- [`DESIGN-ARCH-051` 单人维护者健康驾驶舱](03_DESIGN_设计/%5BDESIGN-ARCH-051%5D%20单人维护者健康驾驶舱.md)
- [`DESIGN-ARCH-052` 任务驱动读取与搜索范围规划-精准而非全知](03_DESIGN_设计/%5BDESIGN-ARCH-052%5D%20任务驱动读取与搜索范围规划-精准而非全知.md)
- [`DESIGN-ARCH-053` 命令与第三方应用输出折叠-几行预览与Ctrl+O展开](03_DESIGN_设计/%5BDESIGN-ARCH-053%5D%20命令与第三方应用输出折叠-几行预览与Ctrl+O展开.md)
- [`DESIGN-ARCH-054` AI逆向工程-从产物还原与自验软件](03_DESIGN_设计/%5BDESIGN-ARCH-054%5D%20AI逆向工程-从产物还原与自验软件.md)
- [`DESIGN-ARCH-055` 对抗式训练-极端环境抗压自检与加固](03_DESIGN_设计/%5BDESIGN-ARCH-055%5D%20对抗式训练-极端环境抗压自检与加固.md)
- [`DESIGN-ARCH-056` khyos桌面操控-眼耳嘴与模拟操作](03_DESIGN_设计/%5BDESIGN-ARCH-056%5D%20khyos桌面操控-眼耳嘴与模拟操作.md)
- [`DESIGN-ARCH-058` 细粒度权限策略与记忆主动化引擎](03_DESIGN_设计/%5BDESIGN-ARCH-058%5D%20细粒度权限策略与记忆主动化引擎.md)
- [`DESIGN-ARCH-059` 能力即代码](03_DESIGN_设计/%5BDESIGN-ARCH-059%5D%20能力即代码.md)
- [`DESIGN-ARCH-060` khy 功能接线与编排总图](03_DESIGN_设计/%5BDESIGN-ARCH-060%5D%20khy%20功能接线与编排总图.md)
- [`DESIGN-ARCH-061` 更新包学习-取其精华弃其糟粕](03_DESIGN_设计/%5BDESIGN-ARCH-061%5D%20更新包学习-取其精华弃其糟粕.md)
- [`DESIGN-ARCH-062` khyos 后台常驻与按需加载生命周期边界](03_DESIGN_设计/%5BDESIGN-ARCH-062%5D%20khyos%20后台常驻与按需加载生命周期边界.md)
- [`DESIGN-ARCH-063` 对照《Claude Code 架构》一书读懂 Khy-OS（书序架构阅读主线）](03_DESIGN_设计/%5BDESIGN-ARCH-063%5D%20对照《Claude%20Code%20架构》一书读懂%20Khy-OS.md)
- [`DESIGN-ARCH-064` khyos 后端请求生命周期与逻辑关系图](03_DESIGN_设计/%5BDESIGN-ARCH-064%5D%20khyos%20后端请求生命周期与逻辑关系图.md)
- [`DESIGN-ARCH-065` Hermes Agent v0.18.0 参考学习-判断验证自我进化](03_DESIGN_设计/%5BDESIGN-ARCH-065%5D%20Hermes%20Agent%20v0.18.0%20参考学习-判断验证自我进化.md)
- [`DESIGN-ARCH-066` 前端代理出站桥-选节点实际路由与启用停用开关](03_DESIGN_设计/%5BDESIGN-ARCH-066%5D%20前端代理出站桥-选节点实际路由与启用停用开关.md)
- [`DESIGN-ARCH-067` opencode高含金量功能教学与khy-os差距补齐路线](03_DESIGN_设计/%5BDESIGN-ARCH-067%5D%20opencode高含金量功能教学与khy-os差距补齐路线.md)
- [`DESIGN-ARCH-067` 动态模型差异化适配引擎](03_DESIGN_设计/%5BDESIGN-ARCH-067%5D%20动态模型差异化适配引擎.md) ⚠️ 编号与上一条冲突，待重编
- [`DESIGN-ARCH-068` 仓库层级板块规范](03_DESIGN_设计/%5BDESIGN-ARCH-068%5D%20仓库层级板块规范.md) — **顶层目录 L0–L6 分层、允许依赖边、`docs/` 两轴命名、任务入口命名的单一真源**；新增文件或新增顶层目录前先读它，由 `npm run check:layout` 强制
- [`DESIGN-ARCH-069` 拓展契约与核心边界规范](03_DESIGN_设计/%5BDESIGN-ARCH-069%5D%20拓展契约与核心边界规范.md) — **「什么是核、什么是拓展」的单一真源**：核 = 壳+漏斗+网关；一个拓展 = 一个目录 + 一份 `khy.extension.json`；五个拓展根与优先级；发现→惰性激活→停用；删目录即消失。`[DESIGN-ARCH-068]` 是其上位法，由 `npm run check:layout` 的 `extension-contract` 规则强制
- [`DESIGN-ARCH-070` 治理总纲与可执行规则](03_DESIGN_设计/%5BDESIGN-ARCH-070%5D%20治理总纲与可执行规则.md) — **既有治理规则的索引与缺口登记**：MOD、MEM、TOOL、ACP、API 五板块；不推翻既有单一真源；由 `node scripts/ci/check-gov-rules.js` 守住总纲与 CI 接线。
- [`DESIGN-ARCH-071` 通道选择决策矩阵](03_DESIGN_设计/%5BDESIGN-ARCH-071%5D%20通道选择决策矩阵.md) — **「一次操作该走哪条通道」的单一真源**：五通道（直接读状态/服务层直调/CLI/Web API/看屏幕）五问判定顺序、适用/禁止/降级与反模式；`AGENTS.md`「通道选择判定」节是其首屏压缩版。
- [`DESIGN-ARCH-072` 任务最小闭环-裁决接线与交付台账](03_DESIGN_设计/%5BDESIGN-ARCH-072%5D%20任务最小闭环-裁决接线与交付台账.md) — 普通任务从「模型想停」到「交付完成」的最小闭环单一真源：收尾仲裁门（close/redrive/close_partial 三态）+ 交付台账 `khy deliveries`
- [`DESIGN-ARCH-073` khyos 核心任务循环-稳定交付总纲](03_DESIGN_设计/%5BDESIGN-ARCH-073%5D%20khyos%20核心任务循环-稳定交付总纲.md) — 任务从受理到交付的核心循环运行时契约（登记→执行→裁决→交付→台账 + 想停轮 20 道门序），`072` 的上位总纲
- [`DESIGN-ARCH-074` khyos 账号体系收口-用户名唯一键 alias 软冲突 密码必填 局域网登录](03_DESIGN_设计/%5BDESIGN-ARCH-074%5D%20khyos%20账号体系收口-用户名唯一键%20alias%20软冲突%20密码必填%20局域网登录.md) — 账号=用户名；alias 全局唯一软冲突；强制密码；ai-backend 默认绑 0.0.0.0 让 LAN 上其他机器可用账号密码登录。承接用户反馈「khyos 欢迎语和登录账号不对」并扩大账号体系口径
- [`DESIGN-OTHER-001` Khyos-数学重塑-实施提示词链](03_DESIGN_设计/%5BDESIGN-OTHER-001%5D%20Khyos-数学重塑-实施提示词链.md)
- [`DESIGN-OTHER-002` _cbssp_分阶段防闪退提示词](03_DESIGN_设计/%5BDESIGN-OTHER-002%5D%20_cbssp_分阶段防闪退提示词.md)
- [`DESIGN-OTHER-003` khy-系统提示词结构图](03_DESIGN_设计/%5BDESIGN-OTHER-003%5D%20khy-系统提示词结构图.md)
- [`DESIGN-OTHER-004` 特性访问-提示词胶囊-2026-06-01](03_DESIGN_设计/%5BDESIGN-OTHER-004%5D%20特性访问-提示词胶囊-2026-06-01.md)
- [`DESIGN-OTHER-005` desktop-rd-桌面端调研指针](03_DESIGN_设计/%5BDESIGN-OTHER-005%5D%20desktop-rd-桌面端调研指针.md) — 指向 `extensions/scripts/khy-desktop-rd/`：4 个外部开源桌面 AI Agent 项目（OpenFlux / goose / ChatML / one-api）+ Cmd+K 组件范式（kbar）的归档与对比，待路线评审
- [`DESIGN-PERF-001` khy-cli-交互流畅度修复方案-v1](03_DESIGN_设计/%5BDESIGN-PERF-001%5D%20khy-cli-交互流畅度修复方案-v1.md) — khy CLI 流畅度对位调研（10 处推断校正）与三阶段修复方案（fast-startup 默认化 / CLI bundle / 首 token 解耦），只立项未动码
- [`DESIGN-SIZE-001` khy-os 体积优化方案](03_DESIGN_设计/%5BDESIGN-SIZE-001%5D%20khy-os%20体积优化方案.md) — 开发盘占 1.25GB → 分发 bundle <15MB 的三层优化：删可弃物 / 依赖替代 / 三档分发（Draft）
- [`DESIGN-RESEARCH`（未编号）跨Agent技能MCP统一管理-阶段一调研](03_DESIGN_设计/%5BDESIGN-RESEARCH%5D%20跨Agent技能MCP统一管理-阶段一调研.md) — 只读调研：现有 `ccMcpBridge`/`ocMcpBridge`/`*SkillBridge` 只发现不写入，缺 agent 注册表与统一 import 原语；立法清单冻结前不动代码
- [`DESIGN-LEGISLATION`（未编号）跨Agent技能MCP统一管理-阶段二立法清单](03_DESIGN_设计/%5BDESIGN-LEGISLATION%5D%20跨Agent技能MCP统一管理-阶段二立法清单.md) — 阶段三实现的冻结依据：`khy unify` 的 export/import/list/sync 范围、MCP 与技能 bridge 注册表、存量纳管写入口；依据阶段一调研 §1-§5 与铁律 F1-F8

历史未编号件（保留原名，重命名须同步改写全部入站引用，属独立一轮工作）：

- [`FILE-FORMAT-PROTOCOL`（未编号）](03_DESIGN_设计/FILE-FORMAT-PROTOCOL.md) — 文件格式使用协议（JSON/YAML/JSONL/…各自的职责边界），由 `check-change-safety` 门控；2026-08-15 从 `02_CONCEPTS_概念入门/` 迁来（它是标准而非概念入门篇）
- [`RELIABILITY-PROTOCOL`（未编号）](03_DESIGN_设计/RELIABILITY-PROTOCOL.md)
- [`ycode-inspiration-plan`（未编号）](03_DESIGN_设计/ycode-inspiration-plan.md)

## 04_IMPL_实现

- [`IMPL-DOC-001` 任务完成判断地图](04_IMPL_实现/%5BIMPL-DOC-001%5D%20任务完成判断地图.md) — 「任务何时算做完」的三条通道架构地图（taskClosure 三态仲裁 / goalStopGate 四门 / 后台 FSM），改收尾与预算逻辑前必读
- [`IMPL-RPT-001` executeCode-进程级真隔离-2026-06-10](04_IMPL_实现/%5BIMPL-RPT-001%5D%20executeCode-进程级真隔离-2026-06-10.md)
- [`IMPL-RPT-002` kiro-连接修复-2026-06-05](04_IMPL_实现/%5BIMPL-RPT-002%5D%20kiro-连接修复-2026-06-05.md)
- [`IMPL-RPT-003` tui-inquirer闪退修复-2026-06-05](04_IMPL_实现/%5BIMPL-RPT-003%5D%20tui-inquirer闪退修复-2026-06-05.md)
- [`IMPL-RPT-004` tui-叙事与选择覆盖层-2026-06-01](04_IMPL_实现/%5BIMPL-RPT-004%5D%20tui-叙事与选择覆盖层-2026-06-01.md)
- [`IMPL-RPT-005` tui-权限授权掉cooked模式修复-2026-06-09](04_IMPL_实现/%5BIMPL-RPT-005%5D%20tui-权限授权掉cooked模式修复-2026-06-09.md)
- [`IMPL-RPT-006` tui-流式与上下文显示-2026-06-01](04_IMPL_实现/%5BIMPL-RPT-006%5D%20tui-流式与上下文显示-2026-06-01.md)
- [`IMPL-RPT-007` v0.1.84-修复说明](04_IMPL_实现/%5BIMPL-RPT-007%5D%20v0.1.84-修复说明.md)
- [`IMPL-RPT-008` 修复-桥接状态刷屏](04_IMPL_实现/%5BIMPL-RPT-008%5D%20修复-桥接状态刷屏.md)
- [`IMPL-RPT-009` 特性访问与代理解耦-2026-06-01](04_IMPL_实现/%5BIMPL-RPT-009%5D%20特性访问与代理解耦-2026-06-01.md)
- [`IMPL-RPT-010` 网关适配器可用性严格化-本地安装与登录-2026-06-10](04_IMPL_实现/%5BIMPL-RPT-010%5D%20网关适配器可用性严格化-本地安装与登录-2026-06-10.md)
- [`IMPL-RPT-011` 航天级重构白皮书-2026-06-10](04_IMPL_实现/%5BIMPL-RPT-011%5D%20航天级重构白皮书-2026-06-10.md)
- [`IMPL-RPT-012` 航天级重构白皮书-第二轮-2026-06-10](04_IMPL_实现/%5BIMPL-RPT-012%5D%20航天级重构白皮书-第二轮-2026-06-10.md)
- [`IMPL-RPT-013` khy-claude-认证冲突修复](04_IMPL_实现/%5BIMPL-RPT-013%5D%20khy-claude-认证冲突修复.md)
- [`IMPL-RPT-014` trae-适配器-官方扫描修复-2026-05-25](04_IMPL_实现/%5BIMPL-RPT-014%5D%20trae-适配器-官方扫描修复-2026-05-25.md)
- [`IMPL-RPT-015` 修复记录时间线](04_IMPL_实现/%5BIMPL-RPT-015%5D%20修复记录时间线.md)
- [`IMPL-RPT-016` 剪贴板粘贴修复](04_IMPL_实现/%5BIMPL-RPT-016%5D%20剪贴板粘贴修复.md)
- [`IMPL-RPT-017` 守护进程端口发现修复](04_IMPL_实现/%5BIMPL-RPT-017%5D%20守护进程端口发现修复.md)
- [`IMPL-RPT-018` 管理前端自动可用修复-2026-05-31](04_IMPL_实现/%5BIMPL-RPT-018%5D%20管理前端自动可用修复-2026-05-31.md)
- [`IMPL-RPT-019` 终端提示符泄漏与交付空行修复-2026-05-31](04_IMPL_实现/%5BIMPL-RPT-019%5D%20终端提示符泄漏与交付空行修复-2026-05-31.md)
- [`IMPL-RPT-020` 网关传输韧性修复-2026-05-29](04_IMPL_实现/%5BIMPL-RPT-020%5D%20网关传输韧性修复-2026-05-29.md)
- [`IMPL-RPT-021` 网关超时与帧修复](04_IMPL_实现/%5BIMPL-RPT-021%5D%20网关超时与帧修复.md)
- [`IMPL-RPT-022` HOTFIX_MODEL_SELECTION](04_IMPL_实现/%5BIMPL-RPT-022%5D%20HOTFIX_MODEL_SELECTION.md)
- [`IMPL-RPT-023` 文档排版-内容与样式分离-2026-06-12](04_IMPL_实现/%5BIMPL-RPT-023%5D%20文档排版-内容与样式分离-2026-06-12.md)
- [`IMPL-RPT-024` 元帅双模式任命与约束-2026-06-12](04_IMPL_实现/%5BIMPL-RPT-024%5D%20元帅双模式任命与约束-2026-06-12.md)
- [`IMPL-RPT-025` 元规划协议与动态约束注入-2026-06-12](04_IMPL_实现/%5BIMPL-RPT-025%5D%20元规划协议与动态约束注入-2026-06-12.md)
- [`IMPL-RPT-026` 生态架构重塑日志-2026-06-12](04_IMPL_实现/%5BIMPL-RPT-026%5D%20生态架构重塑日志-2026-06-12.md)
- [`IMPL-RPT-027` 前后端对接与交互重构日志-2026-06-12](04_IMPL_实现/%5BIMPL-RPT-027%5D%20前后端对接与交互重构日志-2026-06-12.md)
- [`IMPL-RPT-028` 按需加载与零噪音重构日志-2026-06-12](04_IMPL_实现/%5BIMPL-RPT-028%5D%20按需加载与零噪音重构日志-2026-06-12.md)
- [`IMPL-RPT-029` 夜间代码质量与健壮性完善日志-2026-06-11](04_IMPL_实现/%5BIMPL-RPT-029%5D%20夜间代码质量与健壮性完善日志-2026-06-11.md)
- [`IMPL-RPT-030` Agnes四模型一键置备-文生图图改图视频-2026-06-20](04_IMPL_实现/%5BIMPL-RPT-030%5D%20Agnes四模型一键置备-文生图图改图视频-2026-06-20.md)
- [`IMPL-RPT-031` 多视角模型配置-单一图谱八视角-2026-06-20](04_IMPL_实现/%5BIMPL-RPT-031%5D%20多视角模型配置-单一图谱八视角-2026-06-20.md)
- [`IMPL-RPT-032` 有学习价值的Bug汇编-UX漂移与half-wired](04_IMPL_实现/%5BIMPL-RPT-032%5D%20有学习价值的Bug汇编-UX漂移与half-wired.md)
- [`IMPL-RPT-033` 后端公理化重构-网关与定价原子化-2026-07-30](04_IMPL_实现/%5BIMPL-RPT-033%5D%20后端公理化重构-网关与定价原子化-2026-07-30.md)
- [`IMPL-RPT-040` CC-zip1 命令对齐账本](04_IMPL_实现/%5BIMPL-RPT-040%5D%20CC-zip1%20命令对齐账本.md)
- [`IMPL-RPT-041` Qoder接入khy网关与开机自启实现记录-2026-07-13](04_IMPL_实现/%5BIMPL-RPT-041%5D%20Qoder接入khy网关与开机自启实现记录-2026-07-13.md)
- [`IMPL-RPT-042` 交互过程与输出结构化-持久化与机器可读输出-2026-07-27](04_IMPL_实现/%5BIMPL-RPT-042%5D%20交互过程与输出结构化-持久化与机器可读输出-2026-07-27.md)
- [`IMPL-RPT-043` 输出截断根治与无感接续-max_tokens元数据缺失与锚点续写-2026-08-07](04_IMPL_实现/%5BIMPL-RPT-043%5D%20输出截断根治与无感接续-max_tokens元数据缺失与锚点续写-2026-08-07.md)
- [`IMPL-RPT-044` khyos 账号体系收口实施记录-ARCH-074-2026-09-02](04_IMPL_实现/%5BIMPL-RPT-044%5D%20khyos%20账号体系收口实施记录-ARCH-074-2026-09-02.md) — 承接 [DESIGN-ARCH-074]：User.aliases/displayName + loginKeyResolver + 默认账号密码自动补齐 + ai-backend 绑 0.0.0.0 让 LAN 端可登录

> 编号 034–039 为历史断档（删除后不回收，见 [MGMT-STD-001] 第 2.4 条），非漏链。

## 05_TEST_测试

- [`TEST-RPT-001` 验收不合规-2026-05-16](05_TEST_测试/%5BTEST-RPT-001%5D%20验收不合规-2026-05-16.md)
- [`TEST-RPT-002` khy-os-测试指南](05_TEST_测试/%5BTEST-RPT-002%5D%20khy-os-测试指南.md)
- [`TEST-RPT-003` windows-ui-聊天回归报告模板](05_TEST_测试/%5BTEST-RPT-003%5D%20windows-ui-聊天回归报告模板.md)
- [`TEST-RPT-004` windows-ui-聊天回归报告示例-2026-05-20](05_TEST_测试/%5BTEST-RPT-004%5D%20windows-ui-聊天回归报告示例-2026-05-20.md)
- [`TEST-RPT-005` windows-ui-聊天回归清单](05_TEST_测试/%5BTEST-RPT-005%5D%20windows-ui-聊天回归清单.md)
- [`TEST-RPT-006` khy-os-交付验证-2026-05-09](05_TEST_测试/%5BTEST-RPT-006%5D%20khy-os-交付验证-2026-05-09.md)
- [`TEST-RPT-007` 文档排版-测试报告-2026-06-12](05_TEST_测试/%5BTEST-RPT-007%5D%20文档排版-测试报告-2026-06-12.md)
- [`TEST-RPT-008` 元帅双模式任命-测试报告-2026-06-12](05_TEST_测试/%5BTEST-RPT-008%5D%20元帅双模式任命-测试报告-2026-06-12.md)
- [`TEST-RPT-009` 元规划协议与动态约束注入-测试报告-2026-06-12](05_TEST_测试/%5BTEST-RPT-009%5D%20元规划协议与动态约束注入-测试报告-2026-06-12.md)

## 06_DEPLOY_部署

- [`DEPLOY-MAN-001` DEMO](06_DEPLOY_部署/%5BDEPLOY-MAN-001%5D%20DEMO.md)
- [`DEPLOY-MAN-002` PRODUCT_HUNT](06_DEPLOY_部署/%5BDEPLOY-MAN-002%5D%20PRODUCT_HUNT.md)
- [`DEPLOY-MAN-003` PUBLISHING](06_DEPLOY_部署/%5BDEPLOY-MAN-003%5D%20PUBLISHING.md)
- [`DEPLOY-MAN-004` README](06_DEPLOY_部署/%5BDEPLOY-MAN-004%5D%20README.md)
- [`DEPLOY-MAN-005` REDDIT](06_DEPLOY_部署/%5BDEPLOY-MAN-005%5D%20REDDIT.md)
- [`DEPLOY-MAN-006` REPO_META](06_DEPLOY_部署/%5BDEPLOY-MAN-006%5D%20REPO_META.md)
- [`DEPLOY-MAN-007` SHOW_HN](06_DEPLOY_部署/%5BDEPLOY-MAN-007%5D%20SHOW_HN.md)
- [`DEPLOY-MAN-008` TWITTER](06_DEPLOY_部署/%5BDEPLOY-MAN-008%5D%20TWITTER.md)
- [`DEPLOY-MAN-009` pip-打包对等-发布说明-2026-05-17](06_DEPLOY_部署/%5BDEPLOY-MAN-009%5D%20pip-打包对等-发布说明-2026-05-17.md)
- [`DEPLOY-MAN-010` pip-打包对等-发现-2026-05-17](06_DEPLOY_部署/%5BDEPLOY-MAN-010%5D%20pip-打包对等-发现-2026-05-17.md)
- [`DEPLOY-MAN-011` pip-docker-打包部署](06_DEPLOY_部署/%5BDEPLOY-MAN-011%5D%20pip-docker-打包部署.md)
- [`DEPLOY-MAN-012` pip发布后-github发布手册](06_DEPLOY_部署/%5BDEPLOY-MAN-012%5D%20pip发布后-github发布手册.md)
- [`DEPLOY-MAN-013` pypi-发布手册-0.1.17-0.1.18](06_DEPLOY_部署/%5BDEPLOY-MAN-013%5D%20pypi-发布手册-0.1.17-0.1.18.md)
- [`DEPLOY-MAN-014` 发布说明-0.1.27](06_DEPLOY_部署/%5BDEPLOY-MAN-014%5D%20发布说明-0.1.27.md)
- [`DEPLOY-MAN-015` 源码还原与手工发布](06_DEPLOY_部署/%5BDEPLOY-MAN-015%5D%20源码还原与手工发布.md)
- [`DEPLOY-MAN-016` 部署指南-域名](06_DEPLOY_部署/%5BDEPLOY-MAN-016%5D%20部署指南-域名.md)
- [`DEPLOY-MAN-017` 部署指南-无域名](06_DEPLOY_部署/%5BDEPLOY-MAN-017%5D%20部署指南-无域名.md)
- [`DEPLOY-MAN-018` khyos-Android构建避坑指南](06_DEPLOY_部署/%5BDEPLOY-MAN-018%5D%20khyos-Android构建避坑指南.md)
- [`DEPLOY-MAN-019` 模型可用性与适配器探测](06_DEPLOY_部署/%5BDEPLOY-MAN-019%5D%20模型可用性与适配器探测.md) — **`/model` 里没有模型时先读这篇**：18 个适配器默认全部 enabled，`available` 由独立探测轮决定；`GATEWAY_<KEY>_ENABLED` 只是关闭开关
- [`DEPLOY-MAN-020` AI供应商与APIKey配置](06_DEPLOY_部署/%5BDEPLOY-MAN-020%5D%20AI供应商与APIKey配置.md) — Ollama / 11 家供应商的**真实**变量名；`JWT_SECRET` 无需手写（自动生成）
- [`DEPLOY-MAN-021` IDE桥接模式](06_DEPLOY_部署/%5BDEPLOY-MAN-021%5D%20IDE桥接模式.md) — 复用 Claude Code / Cursor / Windsurf / VS Code 已有凭据，不需额外 API Key
- [`PORTABLE`（未编号）便携化打包与启动](06_DEPLOY_部署/PORTABLE.md) — 源码三档启动 + 发布版一键打包 + 数据宿主隔离
- [`LAN-FIREWALL`（未编号）局域网登录防火墙放行](06_DEPLOY_部署/LAN-FIREWALL.md) — ARCH-074 配套文档：ai-backend 默认绑 0.0.0.0，让 LAN 上其他机器可用账号密码登录；本文给出 Windows / macOS / Linux 三平台防火墙放行命令

## 07_OPS_运维

> 📦 **pip 安装从这里开始**：[`OPS-MAN-027` 快速开始](07_OPS_运维/%5BOPS-MAN-027%5D%20快速开始.md) → [`OPS-MAN-043` 从0到高手](07_OPS_运维/%5BOPS-MAN-043%5D%20从0到高手-新手成长路线与pip安装后清单.md) ⭐ → [`OPS-MAN-023` 完整功能清单](07_OPS_运维/%5BOPS-MAN-023%5D%20pip安装后-完整功能清单.md) → [`OPS-MAN-024` 按需配置体验](07_OPS_运维/%5BOPS-MAN-024%5D%20pip安装后-按需配置体验.md)；门槛与还原见 [`OPS-MAN-028` 环境要求](07_OPS_运维/%5BOPS-MAN-028%5D%20环境要求.md) / [`OPS-MAN-037` 完整还原](07_OPS_运维/%5BOPS-MAN-037%5D%20pip安装后-完整还原与全功能开启指南.md)。

> 🗂️ **本区 178 份怎么读**：001–070 是**使用与配置手册**（上手、指南、速查）；071–164 多为**单点能力的落地记录**，
> 按族群成串阅读更省力 —— 还原/离机自检族（075·076·079·082·084–090·095·105·107·108·110·113·114·117·119·128·130·133）多由
> `scripts/restore-*.js --gen-doc` 确定性生成，**请勿手改**；OCR 兜底诚实与显示降噪族（104·109·111·112·115·116·118·120·122·124·126·127·132·134·138·140·142·144·145·148·150·159·161·164）；
> 读前防卡死守卫族（121·123·125·129·143·146·147·149）；波次调度与结果诚实族（083·087·091–094·097–099·101）；
> 孤儿能力接线族（151–158·160·162·163）。165 以后是**新增手册**（个性化、消息、技能、MCP、任务入口、备份恢复）。

- [`OPS-MAN-001` ai-快速通道](07_OPS_运维/%5BOPS-MAN-001%5D%20ai-快速通道.md)
- [`OPS-MAN-002` ai-管理-新api对齐](07_OPS_运维/%5BOPS-MAN-002%5D%20ai-管理-新api对齐.md)
- [`OPS-MAN-003` ai-管理-访问与登录](07_OPS_运维/%5BOPS-MAN-003%5D%20ai-管理-访问与登录.md)
- [`OPS-MAN-004` claude-code-代理配置](07_OPS_运维/%5BOPS-MAN-004%5D%20claude-code-代理配置.md)
- [`OPS-MAN-005` claude-code-规则到-khy-映射表](07_OPS_运维/%5BOPS-MAN-005%5D%20claude-code-规则到-khy-映射表.md)
- [`OPS-MAN-006` cli-万能接入-abu-案例](07_OPS_运维/%5BOPS-MAN-006%5D%20cli-万能接入-abu-案例.md)
- [`OPS-MAN-007` cli-万能接入-集成指南](07_OPS_运维/%5BOPS-MAN-007%5D%20cli-万能接入-集成指南.md)
- [`OPS-MAN-008` deepseek-tui-资源清理对齐](07_OPS_运维/%5BOPS-MAN-008%5D%20deepseek-tui-资源清理对齐.md)
- [`OPS-MAN-009` github-分支保护基线](07_OPS_运维/%5BOPS-MAN-009%5D%20github-分支保护基线.md)
- [`OPS-MAN-010` hermes风格-模型配置](07_OPS_运维/%5BOPS-MAN-010%5D%20hermes风格-模型配置.md)
- [`OPS-MAN-011` khy-os-学习指南](07_OPS_运维/%5BOPS-MAN-011%5D%20khy-os-学习指南.md)
- [`OPS-MAN-012` khy-os-应用接入指南](07_OPS_运维/%5BOPS-MAN-012%5D%20khy-os-应用接入指南.md)
- [`OPS-MAN-013` khy-os-开发者指南](07_OPS_运维/%5BOPS-MAN-013%5D%20khy-os-开发者指南.md)
- [`OPS-MAN-014` khy-os-用户指南-仅cli](07_OPS_运维/%5BOPS-MAN-014%5D%20khy-os-用户指南-仅cli.md)
- [`OPS-MAN-015` khy-os-用户指南](07_OPS_运维/%5BOPS-MAN-015%5D%20khy-os-用户指南.md)
- [`OPS-MAN-016` khy-ux-交付-深度学习指南](07_OPS_运维/%5BOPS-MAN-016%5D%20khy-ux-交付-深度学习指南.md)
- [`OPS-MAN-017` khy-智能体-五步实施](07_OPS_运维/%5BOPS-MAN-017%5D%20khy-智能体-五步实施.md)
- [`OPS-MAN-018` khy-编程智能体-风险预防-2026-05-30](07_OPS_运维/%5BOPS-MAN-018%5D%20khy-编程智能体-风险预防-2026-05-30.md)
- [`OPS-MAN-019` khy-远程ssh-实施清单](07_OPS_运维/%5BOPS-MAN-019%5D%20khy-远程ssh-实施清单.md)
- [`OPS-MAN-020` openagent-对齐日志](07_OPS_运维/%5BOPS-MAN-020%5D%20openagent-对齐日志.md)
- [`OPS-MAN-021` opencode-任务编排经验](07_OPS_运维/%5BOPS-MAN-021%5D%20opencode-任务编排经验.md)
- [`OPS-MAN-022` pip-安装布局参考](07_OPS_运维/%5BOPS-MAN-022%5D%20pip-安装布局参考.md)
- [`OPS-MAN-023` pip安装后-完整功能清单](07_OPS_运维/%5BOPS-MAN-023%5D%20pip安装后-完整功能清单.md) 📦 pip 上手
- [`OPS-MAN-024` pip安装后-按需配置体验](07_OPS_运维/%5BOPS-MAN-024%5D%20pip安装后-按需配置体验.md) 📦 pip 上手
- [`OPS-MAN-025` windows-vmware-清单](07_OPS_运维/%5BOPS-MAN-025%5D%20windows-vmware-清单.md)
- [`OPS-MAN-026` 会话恢复-按id](07_OPS_运维/%5BOPS-MAN-026%5D%20会话恢复-按id.md)
- [`OPS-MAN-027` 快速开始](07_OPS_运维/%5BOPS-MAN-027%5D%20快速开始.md) 📦 pip 上手·新手第一篇
- [`OPS-MAN-028` 环境要求](07_OPS_运维/%5BOPS-MAN-028%5D%20环境要求.md) 📦 pip 上手
- [`OPS-MAN-029` 磁盘守卫-防膨胀机制](07_OPS_运维/%5BOPS-MAN-029%5D%20磁盘守卫-防膨胀机制.md)
- [`OPS-MAN-030` 移动端远程指南](07_OPS_运维/%5BOPS-MAN-030%5D%20移动端远程指南.md)
- [`OPS-MAN-031` 终端-tui-有框输入区重构方案-2026-05-31](07_OPS_运维/%5BOPS-MAN-031%5D%20终端-tui-有框输入区重构方案-2026-05-31.md)
- [`OPS-MAN-032` 网关-自定义provider配置-agnes](07_OPS_运维/%5BOPS-MAN-032%5D%20网关-自定义provider配置-agnes.md)
- [`OPS-MAN-033` 自动保护与回滚](07_OPS_运维/%5BOPS-MAN-033%5D%20自动保护与回滚.md)
- [`OPS-MAN-034` TODO](07_OPS_运维/%5BOPS-MAN-034%5D%20TODO.md)
- [`OPS-MAN-035` 特性访问-维护速查-2026-06-01](07_OPS_运维/%5BOPS-MAN-035%5D%20特性访问-维护速查-2026-06-01.md)
- [`OPS-MAN-036` khyos跨平台构建-Windows支持方案](07_OPS_运维/%5BOPS-MAN-036%5D%20khyos跨平台构建-Windows支持方案.md)
- [`OPS-MAN-037` pip安装后-完整还原与全功能开启指南](07_OPS_运维/%5BOPS-MAN-037%5D%20pip安装后-完整还原与全功能开启指南.md)
- [`OPS-MAN-038` AI元数据-.ai-种子文档-用法指南-2026-06-15](07_OPS_运维/%5BOPS-MAN-038%5D%20AI元数据-.ai-种子文档-用法指南-2026-06-15.md)
- [`OPS-MAN-039` 文档排版-用法指南-2026-06-12](07_OPS_运维/%5BOPS-MAN-039%5D%20文档排版-用法指南-2026-06-12.md)
- [`OPS-MAN-040` Git入门-main-HEAD-分支-工作树-结合本仓库](07_OPS_运维/%5BOPS-MAN-040%5D%20Git入门-main-HEAD-分支-工作树-结合本仓库.md)
- [`OPS-MAN-041` 通过KHY学习模式-从0到1面试大厂Agent岗-路线图-2026-06-15](07_OPS_运维/%5BOPS-MAN-041%5D%20通过KHY学习模式-从0到1面试大厂Agent岗-路线图-2026-06-15.md)
- [`OPS-MAN-042` 发布手册-pip与npm-无AI照做](07_OPS_运维/%5BOPS-MAN-042%5D%20发布手册-pip与npm-无AI照做.md)
- [`OPS-MAN-043` 从0到高手-新手成长路线与pip安装后清单](07_OPS_运维/%5BOPS-MAN-043%5D%20从0到高手-新手成长路线与pip安装后清单.md) ⭐ 新手从这里开始
- [`OPS-MAN-044` 从使用入门到开发精通-开发者成长路线](07_OPS_运维/%5BOPS-MAN-044%5D%20从使用入门到开发精通-开发者成长路线.md) ⭐ 想做开发的接这里
- [`OPS-MAN-045` 账号池与多租户-深度指南](07_OPS_运维/%5BOPS-MAN-045%5D%20账号池与多租户-深度指南.md)
- [`OPS-MAN-046` 旗舰特性目录-vault-notify-mesh-insights-forge-image2web](07_OPS_运维/%5BOPS-MAN-046%5D%20旗舰特性目录-vault-notify-mesh-insights-forge-image2web.md)
- [`OPS-MAN-047` 代理服务器深度指南-khy-proxy](07_OPS_运维/%5BOPS-MAN-047%5D%20代理服务器深度指南-khy-proxy.md)
- [`OPS-MAN-048` 本地模型微调-khy-train](07_OPS_运维/%5BOPS-MAN-048%5D%20本地模型微调-khy-train.md)
- [`OPS-MAN-049` 算力与加速器自检-khy-compute](07_OPS_运维/%5BOPS-MAN-049%5D%20算力与加速器自检-khy-compute.md)
- [`OPS-MAN-050` 成长档案迁移-khy-growth](07_OPS_运维/%5BOPS-MAN-050%5D%20成长档案迁移-khy-growth.md)
- [`OPS-MAN-051` 知识库与教学自我认知-khy-knowledge](07_OPS_运维/%5BOPS-MAN-051%5D%20知识库与教学自我认知-khy-knowledge.md)
- [`OPS-MAN-052` 安全守护-khy-security](07_OPS_运维/%5BOPS-MAN-052%5D%20安全守护-khy-security.md)
- [`OPS-MAN-053` 监控与自检-khy-monitor](07_OPS_运维/%5BOPS-MAN-053%5D%20监控与自检-khy-monitor.md)
- [`OPS-MAN-054` 变更裁决-khy-verdict](07_OPS_运维/%5BOPS-MAN-054%5D%20变更裁决-khy-verdict.md)
- [`OPS-MAN-055` 可变性分级与变更治理-khy-evolve](07_OPS_运维/%5BOPS-MAN-055%5D%20可变性分级与变更治理-khy-evolve.md)
- [`OPS-MAN-056` 按需依赖自愈-khy-deps](07_OPS_运维/%5BOPS-MAN-056%5D%20按需依赖自愈-khy-deps.md)
- [`OPS-MAN-057` 工作流引擎-khy-workflow](07_OPS_运维/%5BOPS-MAN-057%5D%20工作流引擎-khy-workflow.md)
- [`OPS-MAN-058` 环境开关与文档命名规范](07_OPS_运维/%5BOPS-MAN-058%5D%20环境开关与文档命名规范.md)
- [`OPS-MAN-059` 文档-PDF与HTML生成与查看](07_OPS_运维/%5BOPS-MAN-059%5D%20文档-PDF与HTML生成与查看.md)
- [`OPS-MAN-060` 高危操作为何被拒与如何放行](07_OPS_运维/%5BOPS-MAN-060%5D%20高危操作为何被拒与如何放行.md)
- [`OPS-MAN-061` 发布门禁](07_OPS_运维/%5BOPS-MAN-061%5D%20发布门禁.md)
- [`OPS-MAN-062` 键盘快捷键参考与跨平台对齐](07_OPS_运维/%5BOPS-MAN-062%5D%20键盘快捷键参考与跨平台对齐.md)
- [`OPS-MAN-063` cc订阅迁移到新电脑-khy-claude-adopt-env](07_OPS_运维/%5BOPS-MAN-063%5D%20cc订阅迁移到新电脑-khy-claude-adopt-env.md)
- [`OPS-MAN-064` 打造最佳环境-如何扩展](07_OPS_运维/%5BOPS-MAN-064%5D%20打造最佳环境-如何扩展.md)
- [`OPS-MAN-065` npm安装加速-npmrc模板](07_OPS_运维/%5BOPS-MAN-065%5D%20npm安装加速-npmrc模板.md)
- [`OPS-MAN-066` khyos进化提示词手册-1000条](07_OPS_运维/%5BOPS-MAN-066%5D%20khyos进化提示词手册-1000条.md)
- [`OPS-MAN-067` 症状分诊速查表](07_OPS_运维/%5BOPS-MAN-067%5D%20症状分诊速查表.md)
- [`OPS-MAN-068` 离机还原自检清单](07_OPS_运维/%5BOPS-MAN-068%5D%20离机还原自检清单.md)
- [`OPS-MAN-069` 已装副本完整性自检清单](07_OPS_运维/%5BOPS-MAN-069%5D%20已装副本完整性自检清单.md)
- [`OPS-MAN-070` 首启依赖hydration自检清单](07_OPS_运维/%5BOPS-MAN-070%5D%20首启依赖hydration自检清单.md)
- [`OPS-MAN-071` 卸载第三方应用怎么保证卸干净-原生自带卸载器](07_OPS_运维/%5BOPS-MAN-071%5D%20卸载第三方应用怎么保证卸干净-原生自带卸载器.md)
- [`OPS-MAN-072` 目标连续多日运行不中断的底气自检](07_OPS_运维/%5BOPS-MAN-072%5D%20目标连续多日运行不中断的底气自检.md)
- [`OPS-MAN-073` 离机渠道启动入口契约自检清单](07_OPS_运维/%5BOPS-MAN-073%5D%20离机渠道启动入口契约自检清单.md)
- [`OPS-MAN-074` 首启崩溃真实原因加方法归因](07_OPS_运维/%5BOPS-MAN-074%5D%20首启崩溃真实原因加方法归因.md)
- [`OPS-MAN-075` Agent 还原方案合成器](07_OPS_运维/%5BOPS-MAN-075%5D%20Agent%20还原方案合成器.md)
- [`OPS-MAN-076` 三面镜子矛盾冲突检测](07_OPS_运维/%5BOPS-MAN-076%5D%20三面镜子矛盾冲突检测.md)
- [`OPS-MAN-077` Windows md 文件建议的应用注册](07_OPS_运维/%5BOPS-MAN-077%5D%20Windows%20md%20文件建议的应用注册.md)
- [`OPS-MAN-078` khy doctor 离机还原自检](07_OPS_运维/%5BOPS-MAN-078%5D%20khy%20doctor%20离机还原自检.md)
- [`OPS-MAN-079` 三面镜子矛盾冲突消解](07_OPS_运维/%5BOPS-MAN-079%5D%20三面镜子矛盾冲突消解.md)
- [`OPS-MAN-080` recap 的 CJK 化](07_OPS_运维/%5BOPS-MAN-080%5D%20recap%20的%20CJK%20化.md)
- [`OPS-MAN-081` npm 渠道 Node 版本预检](07_OPS_运维/%5BOPS-MAN-081%5D%20npm%20渠道%20Node%20版本预检.md)
- [`OPS-MAN-082` 三面镜子还原收敛与防循环](07_OPS_运维/%5BOPS-MAN-082%5D%20三面镜子还原收敛与防循环.md)
- [`OPS-MAN-083` 依赖感知波次调度](07_OPS_运维/%5BOPS-MAN-083%5D%20依赖感知波次调度.md)
- [`OPS-MAN-084` 还原自驱授权门](07_OPS_运维/%5BOPS-MAN-084%5D%20还原自驱授权门.md)
- [`OPS-MAN-085` 还原补救追索](07_OPS_运维/%5BOPS-MAN-085%5D%20还原补救追索.md)
- [`OPS-MAN-086` 还原轨迹日志](07_OPS_运维/%5BOPS-MAN-086%5D%20还原轨迹日志.md)
- [`OPS-MAN-087` 波次执行故障感知](07_OPS_运维/%5BOPS-MAN-087%5D%20波次执行故障感知.md)
- [`OPS-MAN-088` 还原策略台账](07_OPS_运维/%5BOPS-MAN-088%5D%20还原策略台账.md)
- [`OPS-MAN-089` 还原学习应用器](07_OPS_运维/%5BOPS-MAN-089%5D%20还原学习应用器.md)
- [`OPS-MAN-090` 还原导航器](07_OPS_运维/%5BOPS-MAN-090%5D%20还原导航器.md)
- [`OPS-MAN-091` 波次前驱结果注入](07_OPS_运维/%5BOPS-MAN-091%5D%20波次前驱结果注入.md)
- [`OPS-MAN-092` 跳过与失败在最终报告分列](07_OPS_运维/%5BOPS-MAN-092%5D%20跳过与失败在最终报告分列.md)
- [`OPS-MAN-093` 确定性顺序链拆解](07_OPS_运维/%5BOPS-MAN-093%5D%20确定性顺序链拆解.md)
- [`OPS-MAN-094` 角色工具作用域](07_OPS_运维/%5BOPS-MAN-094%5D%20角色工具作用域.md)
- [`OPS-MAN-095` 还原解包完整性对账](07_OPS_运维/%5BOPS-MAN-095%5D%20还原解包完整性对账.md)
- [`OPS-MAN-096` 多模型类型 Provider 配置对账](07_OPS_运维/%5BOPS-MAN-096%5D%20多模型类型%20Provider%20配置对账.md)
- [`OPS-MAN-097` 角色工具作用域接线](07_OPS_运维/%5BOPS-MAN-097%5D%20角色工具作用域接线.md)
- [`OPS-MAN-098` 并行写冲突检测](07_OPS_运维/%5BOPS-MAN-098%5D%20并行写冲突检测.md)
- [`OPS-MAN-099` 空产出成功检测](07_OPS_运维/%5BOPS-MAN-099%5D%20空产出成功检测.md)
- [`OPS-MAN-100` 便携 CLI 子系统](07_OPS_运维/%5BOPS-MAN-100%5D%20便携%20CLI%20子系统.md)
- [`OPS-MAN-101` 角色归属诚实](07_OPS_运维/%5BOPS-MAN-101%5D%20角色归属诚实.md)
- [`OPS-MAN-102` 卡住任务的强制终止逃生舱](07_OPS_运维/%5BOPS-MAN-102%5D%20卡住任务的强制终止逃生舱.md)
- [`OPS-MAN-103` 写记忆·召回记忆明确告知用户](07_OPS_运维/%5BOPS-MAN-103%5D%20写记忆·召回记忆明确告知用户.md)
- [`OPS-MAN-104` 纯文本模型图片 OCR 兜底与低置信诚实告诫](07_OPS_运维/%5BOPS-MAN-104%5D%20纯文本模型图片%20OCR%20兜底与低置信诚实告诫.md)
- [`OPS-MAN-105` 还原快照格式兼容性对账](07_OPS_运维/%5BOPS-MAN-105%5D%20还原快照格式兼容性对账.md)
- [`OPS-MAN-106` unpack 未知格式自救](07_OPS_运维/%5BOPS-MAN-106%5D%20unpack%20未知格式自救.md)
- [`OPS-MAN-107` 还原来源可溯性对账](07_OPS_运维/%5BOPS-MAN-107%5D%20还原来源可溯性对账.md)
- [`OPS-MAN-108` 还原归档形制可提取性对账](07_OPS_运维/%5BOPS-MAN-108%5D%20还原归档形制可提取性对账.md)
- [`OPS-MAN-109` 纯文本模型图片 OCR 兜底覆盖率诚实告诫](07_OPS_运维/%5BOPS-MAN-109%5D%20纯文本模型图片%20OCR%20兜底覆盖率诚实告诫.md)
- [`OPS-MAN-110` 还原解密套件可执行性对账](07_OPS_运维/%5BOPS-MAN-110%5D%20还原解密套件可执行性对账.md)
- [`OPS-MAN-111` 纯文本模型图片 OCR 兜底截断诚实告诫](07_OPS_运维/%5BOPS-MAN-111%5D%20纯文本模型图片%20OCR%20兜底截断诚实告诫.md)
- [`OPS-MAN-112` 纯文本模型图片 OCR 兜底语言包可用性诚实告诫](07_OPS_运维/%5BOPS-MAN-112%5D%20纯文本模型图片%20OCR%20兜底语言包可用性诚实告诫.md)
- [`OPS-MAN-113` 还原字段效应探针（雅可比透镜）](07_OPS_运维/%5BOPS-MAN-113%5D%20还原字段效应探针（雅可比透镜）.md)
- [`OPS-MAN-114` 还原字段归属探针（label preservation）](07_OPS_运维/%5BOPS-MAN-114%5D%20还原字段归属探针（label%20preservation）.md)
- [`OPS-MAN-115` 纯文本模型图片 OCR 兜底方向自动校正](07_OPS_运维/%5BOPS-MAN-115%5D%20纯文本模型图片%20OCR%20兜底方向自动校正.md)
- [`OPS-MAN-116` 纯文本模型图片 OCR 兜底低分辨率自动放大](07_OPS_运维/%5BOPS-MAN-116%5D%20纯文本模型图片%20OCR%20兜底低分辨率自动放大.md)
- [`OPS-MAN-117` 还原完整性对账·运行时接线](07_OPS_运维/%5BOPS-MAN-117%5D%20还原完整性对账·运行时接线.md)
- [`OPS-MAN-118` 视觉描述级联全失败 OCR 兜底底线解耦](07_OPS_运维/%5BOPS-MAN-118%5D%20视觉描述级联全失败%20OCR%20兜底底线解耦.md)
- [`OPS-MAN-119` 还原解密前兼容性预检·运行时接线](07_OPS_运维/%5BOPS-MAN-119%5D%20还原解密前兼容性预检·运行时接线.md)
- [`OPS-MAN-120` 剥图必留痕最小底线与OCR功能门解耦](07_OPS_运维/%5BOPS-MAN-120%5D%20剥图必留痕最小底线与OCR功能门解耦.md)
- [`OPS-MAN-121` readFile二进制文件读前防护·接线](07_OPS_运维/%5BOPS-MAN-121%5D%20readFile二进制文件读前防护·接线.md)
- [`OPS-MAN-122` post-failure救援网剥图必留痕解耦](07_OPS_运维/%5BOPS-MAN-122%5D%20post-failure救援网剥图必留痕解耦.md)
- [`OPS-MAN-123` readFile按格式路由到提取器·接线](07_OPS_运维/%5BOPS-MAN-123%5D%20readFile按格式路由到提取器·接线.md)
- [`OPS-MAN-124` OCR成功路径向用户透明告知用了OCR](07_OPS_运维/%5BOPS-MAN-124%5D%20OCR成功路径向用户透明告知用了OCR.md)
- [`OPS-MAN-125` readFile特殊文件读前防护·接线](07_OPS_运维/%5BOPS-MAN-125%5D%20readFile特殊文件读前防护·接线.md)
- [`OPS-MAN-126` OCR成功路径确定性脚注兜底告知用了OCR](07_OPS_运维/%5BOPS-MAN-126%5D%20OCR成功路径确定性脚注兜底告知用了OCR.md)
- [`OPS-MAN-127` OCR救援网成功实时状态告知已降级到OCR](07_OPS_运维/%5BOPS-MAN-127%5D%20OCR救援网成功实时状态告知已降级到OCR.md)
- [`OPS-MAN-128` restore解密后归档形制解包前把关·接线](07_OPS_运维/%5BOPS-MAN-128%5D%20restore解密后归档形制解包前把关·接线.md)
- [`OPS-MAN-129` readFile伪文件系统有界超时读·接线](07_OPS_运维/%5BOPS-MAN-129%5D%20readFile伪文件系统有界超时读·接线.md)
- [`OPS-MAN-130` 还原来源可溯性·接线运行时横幅](07_OPS_运维/%5BOPS-MAN-130%5D%20还原来源可溯性·接线运行时横幅.md)
- [`OPS-MAN-131` 重复代码检测门与公共测试脚手架](07_OPS_运维/%5BOPS-MAN-131%5D%20重复代码检测门与公共测试脚手架.md)
- [`OPS-MAN-132` prep期OCR兜底非verbose实时状态告知已降级到OCR](07_OPS_运维/%5BOPS-MAN-132%5D%20prep期OCR兜底非verbose实时状态告知已降级到OCR.md)
- [`OPS-MAN-133` restore跨OS路径可移植性解包前把关·接线](07_OPS_运维/%5BOPS-MAN-133%5D%20restore跨OS路径可移植性解包前把关·接线.md)
- [`OPS-MAN-134` 视觉级联网络不可达终局诊断](07_OPS_运维/%5BOPS-MAN-134%5D%20视觉级联网络不可达终局诊断.md)
- [`OPS-MAN-135` 工作流列表载入本页降级不泄漏全局横幅](07_OPS_运维/%5BOPS-MAN-135%5D%20工作流列表载入本页降级不泄漏全局横幅.md)
- [`OPS-MAN-136` 首响应静默窗口守护·提交到首token及时回应·接线](07_OPS_运维/%5BOPS-MAN-136%5D%20首响应静默窗口守护·提交到首token及时回应·接线.md)
- [`OPS-MAN-137` 网页代理内核二进制去哪下载·接确切官方URL到前端横幅](07_OPS_运维/%5BOPS-MAN-137%5D%20网页代理内核二进制去哪下载·接确切官方URL到前端横幅.md)
- [`OPS-MAN-138` 空OCR剥图路径模型仍谎称没收到图的确定性纠正脚注](07_OPS_运维/%5BOPS-MAN-138%5D%20空OCR剥图路径模型仍谎称没收到图的确定性纠正脚注.md)
- [`OPS-MAN-139` khy doctor 离机自检补代理内核下载指引CLI侧接线](07_OPS_运维/%5BOPS-MAN-139%5D%20khy%20doctor%20离机自检补代理内核下载指引CLI侧接线.md)
- [`OPS-MAN-140` OCR成功读出但模型仍谎称没收到图的确定性纠正脚注](07_OPS_运维/%5BOPS-MAN-140%5D%20OCR成功读出但模型仍谎称没收到图的确定性纠正脚注.md)
- [`OPS-MAN-141` 代理内核安装显式CLI表面接线](07_OPS_运维/%5BOPS-MAN-141%5D%20代理内核安装显式CLI表面接线.md)
- [`OPS-MAN-142` 失败墙推迟到OCR结果已知后减少心灵噪音](07_OPS_运维/%5BOPS-MAN-142%5D%20失败墙推迟到OCR结果已知后减少心灵噪音.md)
- [`OPS-MAN-143` Windows保留设备名读前防护](07_OPS_运维/%5BOPS-MAN-143%5D%20Windows保留设备名读前防护.md)
- [`OPS-MAN-144` describe-fail到OCR成功的用户可见闭合减少心灵噪音](07_OPS_运维/%5BOPS-MAN-144%5D%20describe-fail到OCR成功的用户可见闭合减少心灵噪音.md)
- [`OPS-MAN-145` 级联逐候选请稍候提示减冗余减少心灵噪音](07_OPS_运维/%5BOPS-MAN-145%5D%20级联逐候选请稍候提示减冗余减少心灵噪音.md)
- [`OPS-MAN-146` 主读工具FileReadTool防卡死守卫族parity接线](07_OPS_运维/%5BOPS-MAN-146%5D%20主读工具FileReadTool防卡死守卫族parity接线.md)
- [`OPS-MAN-147` 次级读取工具统一读前防卡死前检](07_OPS_运维/%5BOPS-MAN-147%5D%20次级读取工具统一读前防卡死前检.md)
- [`OPS-MAN-148` Site1-prep状态与OCR成功闭合跨层去重减少心灵噪音](07_OPS_运维/%5BOPS-MAN-148%5D%20Site1-prep状态与OCR成功闭合跨层去重减少心灵噪音.md)
- [`OPS-MAN-149` 编辑与探索读取工具接入统一读前防卡死前检](07_OPS_运维/%5BOPS-MAN-149%5D%20编辑与探索读取工具接入统一读前防卡死前检.md)
- [`OPS-MAN-150` 级联中间提示显示归一去provider前缀减少心灵噪音](07_OPS_运维/%5BOPS-MAN-150%5D%20级联中间提示显示归一去provider前缀减少心灵噪音.md)
- [`OPS-MAN-151` 缓存前缀击穿归因接线](07_OPS_运维/%5BOPS-MAN-151%5D%20缓存前缀击穿归因接线.md)
- [`OPS-MAN-152` 交付门人类可读报告落盘接线](07_OPS_运维/%5BOPS-MAN-152%5D%20交付门人类可读报告落盘接线.md)
- [`OPS-MAN-153` 会话快照损坏兜底修复接线](07_OPS_运维/%5BOPS-MAN-153%5D%20会话快照损坏兜底修复接线.md)
- [`OPS-MAN-154` 任务模板执行手册注入接线](07_OPS_运维/%5BOPS-MAN-154%5D%20任务模板执行手册注入接线.md)
- [`OPS-MAN-155` 指令注册表编译期收敛守卫接线](07_OPS_运维/%5BOPS-MAN-155%5D%20指令注册表编译期收敛守卫接线.md)
- [`OPS-MAN-156` 取来即执行安全守卫接线](07_OPS_运维/%5BOPS-MAN-156%5D%20取来即执行安全守卫接线.md)
- [`OPS-MAN-157` 用户显式 git-init 白名单覆盖接线](07_OPS_运维/%5BOPS-MAN-157%5D%20用户显式%20git-init%20白名单覆盖接线.md)
- [`OPS-MAN-158` 本地模型并入统一目录接线](07_OPS_运维/%5BOPS-MAN-158%5D%20本地模型并入统一目录接线.md)
- [`OPS-MAN-159` 失败墙视觉模型名显示归一去provider前缀减少心灵噪音](07_OPS_运维/%5BOPS-MAN-159%5D%20失败墙视觉模型名显示归一去provider前缀减少心灵噪音.md)
- [`OPS-MAN-160` 行为特征化并入误报收口裁决接线](07_OPS_运维/%5BOPS-MAN-160%5D%20行为特征化并入误报收口裁决接线.md)
- [`OPS-MAN-161` 失败墙真实失败原因标签去重减少心灵噪音](07_OPS_运维/%5BOPS-MAN-161%5D%20失败墙真实失败原因标签去重减少心灵噪音.md)
- [`OPS-MAN-162` CLI-Web管理面平价守卫接线](07_OPS_运维/%5BOPS-MAN-162%5D%20CLI-Web管理面平价守卫接线.md)
- [`OPS-MAN-163` 动作契约核验器CI强制接线](07_OPS_运维/%5BOPS-MAN-163%5D%20动作契约核验器CI强制接线.md)
- [`OPS-MAN-164` 视觉池失败状态人话化减少心灵噪音](07_OPS_运维/%5BOPS-MAN-164%5D%20视觉池失败状态人话化减少心灵噪音.md)
- [`OPS-MAN-165` khy 个性化调优与使用建议](07_OPS_运维/%5BOPS-MAN-165%5D%20khy%20个性化调优与使用建议.md)
- [`OPS-MAN-166` cc(Claude Code)个性化使用说明书·重逢版](<07_OPS_运维/[OPS-MAN-166] cc(Claude Code)个性化使用说明书·重逢版.md>)
- [`OPS-MAN-167` khy msg 多平台消息收发（钉钉·飞书·企业微信）](07_OPS_运维/%5BOPS-MAN-167%5D%20khy%20msg%20多平台消息收发（钉钉·飞书·企业微信）.md)
- [`OPS-MAN-168` 弱模型护栏与维护子系统登记](07_OPS_运维/%5BOPS-MAN-168%5D%20弱模型护栏与维护子系统登记.md)
- [`OPS-MAN-169` 项目规则总纲-命名·skill·权限·mcp](07_OPS_运维/%5BOPS-MAN-169%5D%20项目规则总纲-命名·skill·权限·mcp.md)
- [`OPS-MAN-170` 外部技能安装-khy-skill-add](07_OPS_运维/%5BOPS-MAN-170%5D%20外部技能安装-khy-skill-add.md)
- [`OPS-MAN-171` 技能包规范-manifest与prompt模板](07_OPS_运维/%5BOPS-MAN-171%5D%20技能包规范-manifest与prompt模板.md)
- [`OPS-MAN-172` 自定义供应商接入指南](07_OPS_运维/%5BOPS-MAN-172%5D%20自定义供应商接入指南.md)
- [`OPS-MAN-173` MCP工具接入快速上手](07_OPS_运维/%5BOPS-MAN-173%5D%20MCP工具接入快速上手.md)
- [`OPS-MAN-174` 任务入口总表](07_OPS_运维/%5BOPS-MAN-174%5D%20任务入口总表.md) — 根 `package.json` 每条 `npm run` 入口：跑哪个脚本、守住什么、何时跑，附旧名→新名对照
- [`OPS-MAN-175` 首次运行自动登录与凭据](07_OPS_运维/%5BOPS-MAN-175%5D%20首次运行自动登录与凭据.md) — 默认管理员如何生成、密码落在哪、CLI 为什么不需要先起后端
- [`OPS-MAN-176` 数据备份与恢复](07_OPS_运维/%5BOPS-MAN-176%5D%20数据备份与恢复.md) — `khy backup` 全流程：备份集布局、备什么不备什么、SQLite 只能热备、恢复的五道闸、保留策略语义、JSON 原子写迁移
- [`config-auto-repair`（未编号）](07_OPS_运维/config-auto-repair.md) — 启动时自动检测并修复网关配置问题，含手动重置入口
- [`快速配置说明`（未编号）](07_OPS_运维/快速配置说明.md) — `khy gateway` API 厂商快速配置：输入 Key 即自动完成配置，附支持厂商表

## 08_MGMT_项目管理

- [`MGMT-OTHER-001` RESTORE_WINDOWS](08_MGMT_项目管理/%5BMGMT-OTHER-001%5D%20RESTORE_WINDOWS.md)
- [`MGMT-OTHER-002` 事后分析-终端崩溃-2026-05-09](08_MGMT_项目管理/%5BMGMT-OTHER-002%5D%20事后分析-终端崩溃-2026-05-09.md)
- [`MGMT-OTHER-003` 索引](08_MGMT_项目管理/%5BMGMT-OTHER-003%5D%20索引.md)
- [`MGMT-OTHER-004` 事后分析-Windows内核构建为何之前失败现在成功-2026-06-26](08_MGMT_项目管理/%5BMGMT-OTHER-004%5D%20事后分析-Windows内核构建为何之前失败现在成功-2026-06-26.md)
- [`MGMT-PLAN-001` khy-os-体验改进计划-2026-05-26](08_MGMT_项目管理/%5BMGMT-PLAN-001%5D%20khy-os-体验改进计划-2026-05-26.md)
- [`MGMT-PLAN-002` khy-librechat-差距修复路线图](08_MGMT_项目管理/%5BMGMT-PLAN-002%5D%20khy-librechat-差距修复路线图.md)
- [`MGMT-PLAN-003` khy-大任务框架蓝图](08_MGMT_项目管理/%5BMGMT-PLAN-003%5D%20khy-大任务框架蓝图.md)
- [`MGMT-PLAN-004` 三项目改进计划-2026-05-24](08_MGMT_项目管理/%5BMGMT-PLAN-004%5D%20三项目改进计划-2026-05-24.md)
- [`MGMT-PLAN-005` 自主生产计划-r2-2026-05-24](08_MGMT_项目管理/%5BMGMT-PLAN-005%5D%20自主生产计划-r2-2026-05-24.md)
- [`MGMT-PLAN-006` 智能体-操作系统-路线图](08_MGMT_项目管理/%5BMGMT-PLAN-006%5D%20智能体-操作系统-路线图.md)
- [`MGMT-PLAN-007` Khy-OS远景演进路线图-2026-06-12](08_MGMT_项目管理/%5BMGMT-PLAN-007%5D%20Khy-OS远景演进路线图-2026-06-12.md)
- [`MGMT-RPT-001` deepseek-tui-对标](08_MGMT_项目管理/%5BMGMT-RPT-001%5D%20deepseek-tui-对标.md)
- [`MGMT-RPT-002` khy-对比-desirecore-借鉴分析](08_MGMT_项目管理/%5BMGMT-RPT-002%5D%20khy-对比-desirecore-借鉴分析.md)
- [`MGMT-RPT-003` khy-对比-hermes-成长架构](08_MGMT_项目管理/%5BMGMT-RPT-003%5D%20khy-对比-hermes-成长架构.md)
- [`MGMT-RPT-004` khy-对比-openagent-交付差距](08_MGMT_项目管理/%5BMGMT-RPT-004%5D%20khy-对比-openagent-交付差距.md)
- [`MGMT-RPT-005` khy-对比-qwen-code-差距分析](08_MGMT_项目管理/%5BMGMT-RPT-005%5D%20khy-对比-qwen-code-差距分析.md)
- [`MGMT-RPT-006` AB-交付质量对齐-2026-06-03](08_MGMT_项目管理/%5BMGMT-RPT-006%5D%20AB-交付质量对齐-2026-06-03.md)
- [`MGMT-RPT-007` cli-基准对比-2026-05-19](08_MGMT_项目管理/%5BMGMT-RPT-007%5D%20cli-基准对比-2026-05-19.md)
- [`MGMT-RPT-008` hermes-khy-p0-执行任务-2026-05-17](08_MGMT_项目管理/%5BMGMT-RPT-008%5D%20hermes-khy-p0-执行任务-2026-05-17.md)
- [`MGMT-RPT-009` hermes-成长架构-学习清单-2026-05-17](08_MGMT_项目管理/%5BMGMT-RPT-009%5D%20hermes-成长架构-学习清单-2026-05-17.md)
- [`MGMT-RPT-010` windows-工具调用循环冻结-2026-05-28](08_MGMT_项目管理/%5BMGMT-RPT-010%5D%20windows-工具调用循环冻结-2026-05-28.md)
- [`MGMT-RPT-011` 三项目深度学习-2026-05-21](08_MGMT_项目管理/%5BMGMT-RPT-011%5D%20三项目深度学习-2026-05-21.md)
- [`MGMT-RPT-012` ai-显示-对标与对齐](08_MGMT_项目管理/%5BMGMT-RPT-012%5D%20ai-显示-对标与对齐.md)
- [`MGMT-RPT-013` cc-对标-第六轮-2026-05-26](08_MGMT_项目管理/%5BMGMT-RPT-013%5D%20cc-对标-第六轮-2026-05-26.md)
- [`MGMT-RPT-014` khy-qwen-差距修复清单](08_MGMT_项目管理/%5BMGMT-RPT-014%5D%20khy-qwen-差距修复清单.md)
- [`MGMT-RPT-015` khy-ux-交互对标](08_MGMT_项目管理/%5BMGMT-RPT-015%5D%20khy-ux-交互对标.md)
- [`MGMT-RPT-016` 竞品情报图谱](08_MGMT_项目管理/%5BMGMT-RPT-016%5D%20竞品情报图谱.md)
- [`MGMT-RPT-017` 项目矛盾审计-2026-05-21-r2](08_MGMT_项目管理/%5BMGMT-RPT-017%5D%20项目矛盾审计-2026-05-21-r2.md)
- [`MGMT-RPT-018` 项目矛盾审计-2026-05-21](08_MGMT_项目管理/%5BMGMT-RPT-018%5D%20项目矛盾审计-2026-05-21.md)
- [`MGMT-RPT-019` 架构对比-cc-vs-khy](08_MGMT_项目管理/%5BMGMT-RPT-019%5D%20架构对比-cc-vs-khy.md)
- [`MGMT-RPT-020` 项目痛点诊断报告-2026-06-13](08_MGMT_项目管理/%5BMGMT-RPT-020%5D%20项目痛点诊断报告-2026-06-13.md)
- [`MGMT-RPT-021` 全量审查报告甄别-bundled路径与本仓源码对照-2026-07-14](08_MGMT_项目管理/%5BMGMT-RPT-021%5D%20全量审查报告甄别-bundled路径与本仓源码对照-2026-07-14.md)
- [`MGMT-STD-001` 项目文档结构与索引铁律规范](08_MGMT_项目管理/%5BMGMT-STD-001%5D%20项目文档结构与索引铁律规范.md)
- [`MGMT-STD-002` 工程交付综合系统提示词-文档结构与内嵌MD工作台](08_MGMT_项目管理/%5BMGMT-STD-002%5D%20工程交付综合系统提示词-文档结构与内嵌MD工作台.md)
- [`MGMT-STD-003` 任务三综合系统提示词-模型自适应与双轨热插拔架构](08_MGMT_项目管理/%5BMGMT-STD-003%5D%20任务三综合系统提示词-模型自适应与双轨热插拔架构.md)
- [`MGMT-STD-004` 曼孚-vibecoding-交付方法论-流程铁律](08_MGMT_项目管理/%5BMGMT-STD-004%5D%20曼孚-vibecoding-交付方法论-流程铁律.md)
- [`MGMT-STD-005` Khyos工作方法论-证据搜集与计划落地铁律](08_MGMT_项目管理/%5BMGMT-STD-005%5D%20Khyos工作方法论-证据搜集与计划落地铁律.md)
- [`MGMT-STD-006` khy-vibecoding与speccoding能力对齐-可量化验收标准](08_MGMT_项目管理/%5BMGMT-STD-006%5D%20khy-vibecoding与speccoding能力对齐-可量化验收标准.md)


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
- [skills 集合总说明](_AI协作预设包/skills/README.md) — 8 个可安装 skill：onboarding / safe-change / weak-model-guardrails / pick-task / troubleshoot / gateway-fix / release-safety / honest-closure。装法：`khy skill import <目录>` 或放 `~/.khy/skills/`。
