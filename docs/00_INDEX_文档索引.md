# 📚 Khy-OS 文档索引

> 本索引为文档总入口，按「阶段 → 类型 → 序号」归类，命名格式 `[阶段-类型-序号] 中文名`（更新于 2026-06-13）。
> 各阶段目录另设 `00_INDEX_*` 分类索引作为该目录的就近导航入口。

## 阶段总览

| 序号 | 阶段目录 | 文档数 |
|---|---|---:|
| 01 | `01_INIT_立项/` | 2 |
| 03 | `03_DESIGN_设计/` | 66 |
| 04 | `04_IMPL_实现/` | 30 |
| 05 | `05_TEST_测试/` | 9 |
| 06 | `06_DEPLOY_部署/` | 18 |
| 07 | `07_OPS_运维/` | 68 |
| 08 | `08_MGMT_项目管理/` | 34 |
| — | `AI协作预设包/`（跨阶段·分「给人看/给AI看」两线 + 可安装 skills/） | 11 文档 + 8 skill |

> 🧭 **换任何 AI 接手先看**：[`AI协作预设包/`](AI协作预设包/00_INDEX_总入口.md) — 严格区分**给人看**（怎么用/排错/选活/保命）与**给AI看**（可直接粘贴的开场白/铁律/错误自查/任务卡）；含两份总说明（人的一页速览 + AI 的一次读懂全局）；并附一套可 `khy skill import` 的 **skills/**（8 个指导弱模型现场使用 khy 的 skill）。适用于「只能用弱模型 / 陌生大模型、且靠 pip 分发」的维护场景。

> 📖 **想按「从启动到愿景」的认知顺序读懂架构**：[`[DESIGN-ARCH-063]` 对照《Claude Code 架构》一书读懂 Khy-OS](03_DESIGN_设计/%5BDESIGN-ARCH-063%5D%20对照《Claude%20Code%20架构》一书读懂%20Khy-OS.md) — 借一本讲 Claude Code 架构的书的目录当骨架，逐章把「书里的 CC 概念」对齐到「khy 此刻真实的实现（文件:行）」，并如实标注相同/khy 特有/未做之处。它与本索引的**生命周期分类法互补**：本索引答「一个功能怎么落地」，那篇答「按认知顺序从启动一路读到 Agent-as-OS 愿景」。

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
- [`DESIGN-OTHER-001` Khyos-数学重塑-实施提示词链](03_DESIGN_设计/%5BDESIGN-OTHER-001%5D%20Khyos-数学重塑-实施提示词链.md)
- [`DESIGN-OTHER-002` _cbssp_分阶段防闪退提示词](03_DESIGN_设计/%5BDESIGN-OTHER-002%5D%20_cbssp_分阶段防闪退提示词.md)
- [`DESIGN-OTHER-003` khy-系统提示词结构图](03_DESIGN_设计/%5BDESIGN-OTHER-003%5D%20khy-系统提示词结构图.md)
- [`DESIGN-OTHER-004` 特性访问-提示词胶囊-2026-06-01](03_DESIGN_设计/%5BDESIGN-OTHER-004%5D%20特性访问-提示词胶囊-2026-06-01.md)

## 04_IMPL_实现

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
- [`IMPL-RPT-032` 有学习价值的Bug汇编-UX漂移与half-wired](04_IMPL_实现/%5BIMPL-RPT-032%5D%20有学习价值的Bug汇编-UX漂移与half-wired.md)

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

## 07_OPS_运维

> 📦 **pip 安装从这里开始**：[`OPS-MAN-027` 快速开始](07_OPS_运维/%5BOPS-MAN-027%5D%20快速开始.md) → [`OPS-MAN-043` 从0到高手](07_OPS_运维/%5BOPS-MAN-043%5D%20从0到高手-新手成长路线与pip安装后清单.md) ⭐ → [`OPS-MAN-023` 完整功能清单](07_OPS_运维/%5BOPS-MAN-023%5D%20pip安装后-完整功能清单.md) → [`OPS-MAN-024` 按需配置体验](07_OPS_运维/%5BOPS-MAN-024%5D%20pip安装后-按需配置体验.md)；门槛与还原见 [`OPS-MAN-028` 环境要求](07_OPS_运维/%5BOPS-MAN-028%5D%20环境要求.md) / [`OPS-MAN-037` 完整还原](07_OPS_运维/%5BOPS-MAN-037%5D%20pip安装后-完整还原与全功能开启指南.md)。

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
- [`OPS-MAN-066` khyos进化提示词手册-1000条](07_OPS_运维/%5BOPS-MAN-066%5D%20khyos进化提示词手册-1000条.md)
- [`OPS-MAN-067` 症状分诊速查表](07_OPS_运维/%5BOPS-MAN-067%5D%20症状分诊速查表.md)
- [`OPS-MAN-068` 离机还原自检清单](07_OPS_运维/%5BOPS-MAN-068%5D%20离机还原自检清单.md)
- [`OPS-MAN-069` 已装副本完整性自检清单](07_OPS_运维/%5BOPS-MAN-069%5D%20已装副本完整性自检清单.md)
- [`OPS-MAN-070` 首启依赖hydration自检清单](07_OPS_运维/%5BOPS-MAN-070%5D%20首启依赖hydration自检清单.md)
- [`OPS-MAN-169` 项目规则总纲-命名·skill·权限·mcp](07_OPS_运维/%5BOPS-MAN-169%5D%20项目规则总纲-命名·skill·权限·mcp.md)

## 08_MGMT_项目管理

- [`MGMT-OTHER-001` RESTORE_WINDOWS](08_MGMT_项目管理/%5BMGMT-OTHER-001%5D%20RESTORE_WINDOWS.md)
- [`MGMT-OTHER-002` 事后分析-终端崩溃-2026-05-09](08_MGMT_项目管理/%5BMGMT-OTHER-002%5D%20事后分析-终端崩溃-2026-05-09.md)
- [`MGMT-OTHER-003` 索引](08_MGMT_项目管理/%5BMGMT-OTHER-003%5D%20索引.md)
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
- [`MGMT-STD-001` 项目文档结构与索引铁律规范](08_MGMT_项目管理/%5BMGMT-STD-001%5D%20项目文档结构与索引铁律规范.md)
- [`MGMT-STD-002` 工程交付综合系统提示词-文档结构与内嵌MD工作台](08_MGMT_项目管理/%5BMGMT-STD-002%5D%20工程交付综合系统提示词-文档结构与内嵌MD工作台.md)
- [`MGMT-STD-003` 任务三综合系统提示词-模型自适应与双轨热插拔架构](08_MGMT_项目管理/%5BMGMT-STD-003%5D%20任务三综合系统提示词-模型自适应与双轨热插拔架构.md)
- [`MGMT-STD-004` 曼孚-vibecoding-交付方法论-流程铁律](08_MGMT_项目管理/%5BMGMT-STD-004%5D%20曼孚-vibecoding-交付方法论-流程铁律.md)
- [`MGMT-STD-005` Khyos工作方法论-证据搜集与计划落地铁律](08_MGMT_项目管理/%5BMGMT-STD-005%5D%20Khyos工作方法论-证据搜集与计划落地铁律.md)
- [`MGMT-STD-006` khy-vibecoding与speccoding能力对齐-可量化验收标准](08_MGMT_项目管理/%5BMGMT-STD-006%5D%20khy-vibecoding与speccoding能力对齐-可量化验收标准.md)


## AI协作预设包（跨阶段 · 分「给人看 / 给AI看」两线）

> 用途：在「只能用弱模型/陌生大模型、且靠 pip 分发」的场景下继续维护本项目。
> **严格区分受众**：`给人看/` 是你自己的操作与决策；`给AI看/` 是可直接整段粘贴给 AI 的内容。

- [总入口](AI协作预设包/00_INDEX_总入口.md)

**🚀 先看两份总说明（最快掌握）**
- 🧑 [总说明-一页速览（给人）](AI协作预设包/给人看/总说明-一页速览.md) — 你自己 30 秒看懂全局
- 🤖 [总说明-一次读懂全局（给AI）](AI协作预设包/给AI看/总说明-一次读懂全局.md) — 整段发给 AI 即读懂全貌

**🧑 给人看/（你先从这里开始）**
- [总说明-一页速览](AI协作预设包/给人看/总说明-一页速览.md)
- [使用说明-怎么用这套包](AI协作预设包/给人看/使用说明-怎么用这套包.md)
- [排错速查-给人](AI协作预设包/给人看/排错速查-给人.md)
- [发展路径-决策与选活](AI协作预设包/给人看/发展路径-决策与选活.md)
- [命脉自保清单-给人](AI协作预设包/给人看/命脉自保清单-给人.md)

**🤖 给AI看/（复制里面内容发给 AI）**
- [总说明-一次读懂全局](AI协作预设包/给AI看/总说明-一次读懂全局.md)
- [项目情况说明-开场白](AI协作预设包/给AI看/项目情况说明-开场白.md)
- [协作铁律](AI协作预设包/给AI看/协作铁律.md)
- [错误自查手册](AI协作预设包/给AI看/错误自查手册.md)
- [任务派发卡](AI协作预设包/给AI看/任务派发卡.md)

**🧩 skills/（装进 khy 指导弱模型现场执行）**
- [skills 集合总说明](AI协作预设包/skills/README.md) — 8 个可安装 skill：onboarding / safe-change / weak-model-guardrails / pick-task / troubleshoot / gateway-fix / release-safety / honest-closure。装法：`khy skill import <目录>` 或放 `~/.khy/skills/`。
