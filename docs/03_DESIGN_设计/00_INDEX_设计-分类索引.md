# 00_INDEX 设计分类索引

> **索引总领文件** · 本目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章

## 一、分类内容边界

本目录（`docs/03_DESIGN_设计/`）收容**架构与设计规范**类文档：架构设计（ARCH）、协议、数学建模、治理规范、设计期提示词（OTHER）。**不收**实现报告（归 `04_IMPL_实现/`）、运维指南（归 `07_OPS_运维/`）。

> 注：`DESIGN-ARCH-026`、`DESIGN-ARCH-029` 历史遗留重号已治理——`khy-agent-sdk` 改 `DESIGN-ARCH-043`、`Agent自愈微循环` 改 `DESIGN-ARCH-044`，内部印记与外部引用已同步更新，全目录编号现唯一。

## 二、文件清单

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [DESIGN-ARCH-001] khy-移动智能体协议.md | 移动智能体协议 | 定稿 |
| [DESIGN-ARCH-002] Khyos-CB-SSP-数学建模与实现映射.md | CB-SSP数学建模 | 定稿 |
| [DESIGN-ARCH-003] Khyos-数学重塑-受约束随机最短路径.md | 受约束随机最短路径 | 定稿 |
| [DESIGN-ARCH-004] _cbssp_progress.md | CB-SSP进度档 | 草稿 |
| [DESIGN-ARCH-005] agentfs-智能体文件系统.md | 智能体文件系统 | 定稿 |
| [DESIGN-ARCH-006] ai-gateway-适配器协议架构.md | 网关适配器协议 | 定稿 |
| [DESIGN-ARCH-007] m1-微内核-ipc-moonbit.md | 微内核IPC设计 | 定稿 |
| [DESIGN-ARCH-008] moonbit-系统边界.md | MoonBit系统边界 | 定稿 |
| [DESIGN-ARCH-009] 可视化拖拽工作流编辑器-2026-06-09.md | 可视化工作流编辑 | 定稿 |
| [DESIGN-ARCH-010] 核心架构.md | 核心架构 | 定稿 |
| [DESIGN-ARCH-011] 应用接入标准.md | 应用接入标准 | 定稿 |
| [DESIGN-ARCH-012] 工具延迟加载.md | 工具延迟加载 | 定稿 |
| [DESIGN-ARCH-013] 弱模型兼容.md | 弱模型兼容 | 定稿 |
| [DESIGN-ARCH-014] 模式图谱.md | 模式图谱 | 定稿 |
| [DESIGN-ARCH-015] 编码规范.md | 编码规范 | 定稿 |
| [DESIGN-ARCH-016] AI_Agent显示规范.md | Agent显示规范 | 定稿 |
| [DESIGN-ARCH-017] 元工具系统设计.md | 元工具系统 | 定稿 |
| [DESIGN-ARCH-018] Agent提示词复用机制.md | 提示词复用机制 | 定稿 |
| [DESIGN-ARCH-019] 用户输入预处理规范.md | 输入预处理规范 | 定稿 |
| [DESIGN-ARCH-020] 架构债治理报告.md | 架构债治理 | 定稿 |
| [DESIGN-ARCH-021] 巨型环反转设计.md | 巨型环反转 | 定稿 |
| [DESIGN-ARCH-022] khyos多实例并发文件控制规范.md | 多实例文件锁 | 定稿 |
| [DESIGN-ARCH-023] khyos文档排版与格式控制规范.md | 文档排版规范 | 定稿 |
| [DESIGN-ARCH-025] khyos元规划协议与动态约束注入规范.md | 元规划约束注入 | 定稿 |
| [DESIGN-ARCH-026] khyos系统级服务调用审批网关规范.md | 服务调用审批网关 | 定稿 |
| [DESIGN-ARCH-027] Agent依赖自愈机制规范.md | 依赖自愈机制 | 定稿 |
| [DESIGN-ARCH-028] Agent通信防御-零静默失败与精准归因.md | 通信防御零静默 | 定稿 |
| [DESIGN-ARCH-029] Agent有限窗口降级与强制兜底执行协议.md | 有限窗口降级兜底 | 定稿 |
| [DESIGN-ARCH-030] 源端构建-目标机自愈运行.md | 源端构建自愈部署 | 定稿 |
| [DESIGN-ARCH-031] 网关日志租界隔离-按需可见与净味翻译.md | 网关日志租界隔离 | 定稿 |
| [DESIGN-ARCH-032] 内嵌MD工作台与跨平台右键集成.md | 内嵌MD工作台右键集成 | 定稿 |
| [DESIGN-ARCH-034] 动态自适应约束求解引擎.md | 能力向量动态配约束 | 定稿 |
| [DESIGN-ARCH-036] 万物结构化熔炉引擎.md | NL前置坍缩结构化 | 定稿 |
| [DESIGN-ARCH-037] Khyos自举创世-需求内源发生器与闭环自愈引擎.md | 自举创世闭环自愈 | 定稿 |
| [DESIGN-ARCH-041] Khyos意图精准裁决-意图光谱解析与动态提权网关.md | 意图光谱动态提权（已在产，见 GOVERNANCE-LEDGER） | 定稿 |
| [DESIGN-ARCH-043] khy-agent-sdk-Claude对齐与D1-D6融合规范.md | agent-sdk对齐融合 | 定稿 |
| [DESIGN-ARCH-044] Agent自愈微循环-诊断修复重试.md | 自愈微循环 | 定稿 |
| [DESIGN-ARCH-045] 非活跃通道生命周期治理-僵尸后台收回与日志越权阻断.md | 非活跃通道僵尸治理 | 定稿 |
| [DESIGN-ARCH-046] 聊天状态污染与回复截断治理-原子轮提交与空结果重试与截断信号保真.md | 聊天污染与截断治理 | 定稿 |
| [DESIGN-ARCH-047] 轨迹溯源标准-溯源信封与防篡改链与注入隔离.md | 轨迹溯源与防投毒 | 定稿 |
| [DESIGN-ARCH-048] khyos轨迹回放与确定性复现.md | 轨迹回放确定性复现 | 定稿 |
| [DESIGN-ARCH-049] 轨迹即教材-AI引导回放.md | 轨迹即教材AI引导回放 | 定稿 |
| [DESIGN-ARCH-051] 单人维护者健康驾驶舱.md | 单人维护健康驾驶舱 | 定稿 |
| [DESIGN-ARCH-052] 任务驱动读取与搜索范围规划-精准而非全知.md | 任务驱动读取搜索范围规划 | 定稿 |
| [DESIGN-ARCH-053] 命令与第三方应用输出折叠-几行预览与Ctrl+O展开.md | 命令输出折叠与展开 | 定稿 |
| [DESIGN-ARCH-054] AI逆向工程-从产物还原与自验软件.md | AI逆向工程还原自验 | 定稿 |
| [DESIGN-ARCH-055] 对抗式训练-极端环境抗压自检与加固.md | 对抗式训练抗压自检 | 定稿 |
| [DESIGN-ARCH-056] khyos桌面操控-眼耳嘴与模拟操作.md | 桌面操控眼耳嘴模拟操作 | 定稿 |
| [DESIGN-ARCH-058] 细粒度权限策略与记忆主动化引擎.md | 细粒度权限+记忆主动化 | 定稿 |
| [DESIGN-ARCH-059] 能力即代码.md | 能力即代码（学习落为可执行模块+测试+自动发现） | 定稿 |
| [DESIGN-ARCH-060] khy 功能接线与编排总图.md | 接线五件套+编排主线切点图 | 定稿 |
| [DESIGN-ARCH-061] 更新包学习-取其精华弃其糟粕.md | 开源更新包只读甄别精华弃糟粕 | 定稿 |
| [DESIGN-ARCH-062] khyos 后台常驻与按需加载生命周期边界.md | 常驻/一次性/按需 三层 SSoT + 操作化 + 守卫 | 定稿 |
| [DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS.md | 书序架构阅读主线（书目录→khy 真源映射+术语对照） | 定稿 |
| [DESIGN-ARCH-064] khyos 后端请求生命周期与逻辑关系图.md | 后端纵向逻辑关系图（一条消息下行路径·汇流点/单一出口/IoC 缝三骨架点） | 定稿 |
| [DESIGN-ARCH-065] Hermes Agent v0.18.0 参考学习-判断验证自我进化.md | Hermes v0.18.0 三支柱研究+gap 分析；落地 /goal 证据门（evidence-based completion） | 定稿 |
| [DESIGN-OTHER-001] Khyos-数学重塑-实施提示词链.md | 数学重塑提示词链 | 定稿 |
| [DESIGN-OTHER-002] _cbssp_分阶段防闪退提示词.md | 分阶段防闪退提示 | 草稿 |
| [DESIGN-OTHER-003] khy-系统提示词结构图.md | 系统提示词结构图 | 定稿 |
| [DESIGN-OTHER-004] 特性访问-提示词胶囊-2026-06-01.md | 特性访问提示胶囊 | 定稿 |

## 三、已归档（已删除孤儿引擎）

下列设计稿对应的治理引擎经 2026-06-14「接线或删除」核实为 ORPHAN（三入口不可达），其实现已删除，
设计稿移入子目录 `_archive_已删除孤儿引擎/` 仅作历史留存，**非在产**：DESIGN-ARCH-024（marshal，
叶子 capabilityVector 仍在产）、033（dualTrack）、035（cognitiveSnapshot）、038（dualTrackForge）、
039（envSymbiosis）、040（dataSovereignty）、042（selfSustainingInfra）。

- 归档子索引：`_archive_已删除孤儿引擎/00_INDEX_已删除孤儿引擎归档.md`。
- 删除裁决与证据：`.ai/GOVERNANCE-LEDGER.md` §B.0；在产判据：`.ai/GUARDS-AI.md` §0。

## 四、跨分类关联指引

- 文档总入口：`docs/00_INDEX_文档索引.md`。
- 设计的实现落地：`docs/04_IMPL_实现/`；验证：`docs/05_TEST_测试/`。
- 治理标准上位规范：`docs/08_MGMT_项目管理/[MGMT-STD-001]`。
