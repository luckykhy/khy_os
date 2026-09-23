# 00_INDEX 设计分类索引

> **索引总领文件** · 本目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章

## 一、分类内容边界

本目录（`docs/03_DESIGN_设计/`）收容**架构与设计规范**类文档：架构设计（ARCH）、协议、数学建模、治理规范、设计期提示词（OTHER）。**不收**实现报告（归 `04_IMPL_实现/`）、运维指南（归 `07_OPS_运维/`）。

> 注：`DESIGN-ARCH-026`、`DESIGN-ARCH-029` 历史遗留重号已治理——`khy-agent-sdk` 改 `DESIGN-ARCH-043`、`Agent自愈微循环` 改 `DESIGN-ARCH-044`，内部印记与外部引用已同步更新，全目录编号现唯一。

## 二、文件清单

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
|[DESIGN-ARCH-001] khy-移动智能体协议.md|移动智能体协议|在产|
|[DESIGN-ARCH-002] Khyos-CB-SSP-数学建模与实现映射.md|CB-SSP数学建模|在产|
|[DESIGN-ARCH-003] Khyos-数学重塑-受约束随机最短路径.md|受约束随机最短路径|在产|
|[DESIGN-ARCH-004] _cbssp_progress.md|CB-SSP进度档|在产|
|[DESIGN-ARCH-005] agentfs-智能体文件系统.md|智能体文件系统|在产|
|[DESIGN-ARCH-006] ai-gateway-适配器协议架构.md|网关适配器协议|在产|
|[DESIGN-ARCH-007] m1-微内核-ipc-moonbit.md|微内核IPC设计|在产|
|[DESIGN-ARCH-008] moonbit-系统边界.md|MoonBit系统边界|在产|
|[DESIGN-ARCH-009] 可视化拖拽工作流编辑器-2026-06-09.md|可视化工作流编辑|在产|
|[DESIGN-ARCH-010] 核心架构.md|核心架构|在产|
|[DESIGN-ARCH-011] 应用接入标准.md|应用接入标准|在产|
|[DESIGN-ARCH-012] 工具延迟加载.md|工具延迟加载|在产|
|[DESIGN-ARCH-013] 弱模型兼容.md|弱模型兼容|在产|
|[DESIGN-ARCH-014] 模式图谱.md|模式图谱|在产|
|[DESIGN-ARCH-015] 编码规范.md|编码规范|在产|
|[DESIGN-ARCH-016] AI_Agent显示规范.md|Agent显示规范|在产|
|[DESIGN-ARCH-017] 元工具系统设计.md|元工具系统|在产|
|[DESIGN-ARCH-018] Agent提示词复用机制.md|提示词复用机制|在产|
|[DESIGN-ARCH-019] 用户输入预处理规范.md|输入预处理规范|在产|
|[DESIGN-ARCH-020] 架构债治理报告.md|架构债治理|在产|
|[DESIGN-ARCH-021] 巨型环反转设计.md|巨型环反转|在产|
|[DESIGN-ARCH-022] khyos多实例并发文件控制规范.md|多实例文件锁|在产|
|[DESIGN-ARCH-023] khyos文档排版与格式控制规范.md|文档排版规范|在产|
|[DESIGN-ARCH-025] khyos元规划协议与动态约束注入规范.md|元规划约束注入|在产|
|[DESIGN-ARCH-026] khyos系统级服务调用审批网关规范.md|服务调用审批网关|在产|
|[DESIGN-ARCH-027] Agent依赖自愈机制规范.md|依赖自愈机制|在产|
|[DESIGN-ARCH-028] Agent通信防御-零静默失败与精准归因.md|通信防御零静默|在产|
|[DESIGN-ARCH-029] Agent有限窗口降级与强制兜底执行协议.md|有限窗口降级兜底|在产|
|[DESIGN-ARCH-030] 源端构建-目标机自愈运行.md|源端构建自愈部署|在产|
|[DESIGN-ARCH-031] 网关日志租界隔离-按需可见与净味翻译.md|网关日志租界隔离|在产|
|[DESIGN-ARCH-032] 内嵌MD工作台与跨平台右键集成.md|内嵌MD工作台右键集成|在产|
|[DESIGN-ARCH-034] 动态自适应约束求解引擎.md|能力向量动态配约束|在产|
|[DESIGN-ARCH-036] 万物结构化熔炉引擎.md|NL前置坍缩结构化|在产|
|[DESIGN-ARCH-037] Khyos自举创世-需求内源发生器与闭环自愈引擎.md|自举创世闭环自愈|在产|
|[DESIGN-ARCH-041] Khyos意图精准裁决-意图光谱解析与动态提权网关.md|意图光谱动态提权（已在产，见 GOVERNANCE-LEDGER）|在产|
|[DESIGN-ARCH-043] khy-agent-sdk-Claude对齐与D1-D6融合规范.md|agent-sdk对齐融合|在产|
|[DESIGN-ARCH-044] Agent自愈微循环-诊断修复重试.md|自愈微循环|在产|
|[DESIGN-ARCH-045] 非活跃通道生命周期治理-僵尸后台收回与日志越权阻断.md|非活跃通道僵尸治理|在产|
|[DESIGN-ARCH-046] 聊天状态污染与回复截断治理-原子轮提交与空结果重试与截断信号保真.md|聊天污染与截断治理|在产|
|[DESIGN-ARCH-047] 轨迹溯源标准-溯源信封与防篡改链与注入隔离.md|轨迹溯源与防投毒|在产|
|[DESIGN-ARCH-048] khyos轨迹回放与确定性复现.md|轨迹回放确定性复现|在产|
|[DESIGN-ARCH-049] 轨迹即教材-AI引导回放.md|轨迹即教材AI引导回放|在产|
|[DESIGN-ARCH-051] 单人维护者健康驾驶舱.md|单人维护健康驾驶舱|在产|
|[DESIGN-ARCH-052] 任务驱动读取与搜索范围规划-精准而非全知.md|任务驱动读取搜索范围规划|在产|
|[DESIGN-ARCH-053] 命令与第三方应用输出折叠-几行预览与Ctrl+O展开.md|命令输出折叠与展开|在产|
|[DESIGN-ARCH-054] AI逆向工程-从产物还原与自验软件.md|AI逆向工程还原自验|在产|
|[DESIGN-ARCH-055] 对抗式训练-极端环境抗压自检与加固.md|对抗式训练抗压自检|在产|
|[DESIGN-ARCH-056] khyos桌面操控-眼耳嘴与模拟操作.md|桌面操控眼耳嘴模拟操作|在产|
|[DESIGN-ARCH-058] 细粒度权限策略与记忆主动化引擎.md|细粒度权限+记忆主动化|在产|
|[DESIGN-ARCH-059] 能力即代码.md|能力即代码（学习落为可执行模块+测试+自动发现）|在产|
|[DESIGN-ARCH-060] khy 功能接线与编排总图.md|接线五件套+编排主线切点图|在产|
|[DESIGN-ARCH-061] 更新包学习-取其精华弃其糟粕.md|开源更新包只读甄别精华弃糟粕|在产|
|[DESIGN-ARCH-062] khyos 后台常驻与按需加载生命周期边界.md|常驻/一次性/按需 三层 SSoT + 操作化 + 守卫|在产|
|[DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS.md|书序架构阅读主线（书目录→khy 真源映射+术语对照）|在产|
|[DESIGN-ARCH-064] khyos 后端请求生命周期与逻辑关系图.md|后端纵向逻辑关系图（一条消息下行路径·汇流点/单一出口/IoC 缝三骨架点）|在产|
|[DESIGN-ARCH-065] Hermes Agent v0.18.0 参考学习-判断验证自我进化.md|Hermes v0.18.0 三支柱研究+gap 分析；落地 /goal 证据门（evidence-based completion）|在产|
|[DESIGN-ARCH-066] 前端代理出站桥-选节点实际路由与启用停用开关.md|前端代理出站桥路由与启停开关|在产|
|[DESIGN-ARCH-067] opencode高含金量功能教学与khy-os差距补齐路线.md|opencode 12 项功能对照教学；References/LSP 诊断/权限 auto 三项差距分阶段补齐|在产|
|[DESIGN-ARCH-067] 动态模型差异化适配引擎.md|动态模型差异化适配引擎（**编号与上一行冲突，待重编**）|在产|
|[DESIGN-LAY-005] 仓库层级板块规范.md|顶层目录 L0–L6 分层 + 允许依赖边 + docs 统一编号轴 + 任务入口命名（层级单一真源）|在产|
|[DESIGN-TOOL-002] 拓展契约与核心边界规范.md|核=壳+漏斗+网关；拓展=一目录一 manifest；根优先级+惰性激活+删目录即消失（拓展契约单一真源）|在产|
|[DESIGN-ARCH-071] 通道选择决策矩阵.md|五通道（读状态/服务直调/CLI/API/看屏幕）判定顺序+反模式+降级（通道裁决单一真源）|在产|
|[DESIGN-ARCH-072] 任务最小闭环-裁决接线与交付台账.md|收尾仲裁门三态裁决+交付台账（任务最小闭环单一真源）|在产|
|[DESIGN-ARCH-073] khyos 核心任务循环-稳定交付总纲.md|受理→交付核心循环运行时契约（072 上位总纲）|在产|
|[DESIGN-ARCH-074] khyos 账号体系收口-用户名唯一键 alias 软冲突 密码必填 局域网登录.md|账号=用户名；alias 软冲突；密码必填；ai-backend LAN 暴露（账号体系单一真源）|在产|
|[DESIGN-ARCH-078] khyos桌面端与CLI-TUI互联共享方案.md|桌面端↔CLI/TUI 互联：发现链(backend_runtime.json)+会话/供应商真源归一+bridge(9222) 实时共享，P0-P4 分期落地|在产|
|[DESIGN-ARCH-090] TUI用户评价调研与痛点分析.md|TUI 痛点调研（081–089 上游输入）|在产|
|[DESIGN-ARCH-091] 密钥与端点中心管理（KeyManager）GUI设计规范.md|一处配置全 Agent 密钥端点（GUI 门面+应用矩阵+测试规范）|在产|
|[DESIGN-ARCH-095] TUI交互完善调研与实施路线.md|TUI 交互差距分析与 P0–P3 路线（三路调研收口件）|在产|
|[DESIGN-ARCH-097] KhyOS 核心边界定稿-一词一解.md|七核两层（运行核：壳/漏斗/网关/智能体；主张核：工作流/记忆/拓展契约）一词一解收口件；证据锚点+定位裁决|在产|
|[DESIGN-SOURCING-001] 借鉴与实现统一规则.md|可借/不可借黑白名单 + 五种借鉴方式 + 六字段提案 + FEATURE-OWNERSHIP 归属登记（借鉴与实现统一单一真源）|在产|
|[DESIGN-OTHER-001] Khyos-数学重塑-实施提示词链.md|数学重塑提示词链|在产|
|[DESIGN-OTHER-002] _cbssp_分阶段防闪退提示词.md|分阶段防闪退提示|在产|
|[DESIGN-OTHER-003] khy-系统提示词结构图.md|系统提示词结构图|在产|
|[DESIGN-OTHER-004] 特性访问-提示词胶囊-2026-06-01.md|特性访问提示胶囊|在产|
|[DESIGN-OTHER-005] desktop-rd-桌面端调研指针.md|桌面端开源项目调研指针|在产|
|[DESIGN-PERF-002] khy-cli-交互流畅度修复方案-v1.md|CLI 流畅度三阶段修复方案（2026-09-15 改号：`PERF-001` 归 `10_规范/` 性能规范）|在产|
|[DESIGN-PERF-003] TUI 启动阻塞治理方案.md|TUI 启动阻塞实测与治理（方向为预加载+去阻塞，非更加懒加载）|在产|
|[DESIGN-SIZE-001] khy-os 体积优化方案.md|体积三层优化方案|在产|

**历史未编号件**（保留原名；重命名须同步改写全部入站引用与 `.html` 孪生件，属独立一轮工作）：

|文件名|核心职责(10字内)|在产|状态|
| --- | --- | --- | --- |
|[DESIGN-ARCH-109] Y-code 借鉴实施方案.md|ycode 借鉴点与落地计划（原 `ycode-inspiration-plan 设计与实现记录`，占用 `083`）|在产|在产|
|[DESIGN-ARCH-108] CC-TUI复刻执行提示词.md|CC TUI 复刻执行提示词（原 `EXECUTION_PROMPT 设计与实现记录`，占用 `083`）|在产|在产|
|[DESIGN-ARCH-111] 规则遵守保障机制.md|规则登记表→门禁绑定层：门成员资格从登记表派生、归类枚举、门档强度、抑制、覆盖率红线、反孤儿守卫|派生|派生|
|[DESIGN-ARCH-112] khyos-Harness架构对照.md|四层架构与 Harness 五要素→khyos 文件路径映射、baseline 六处更正、病灶章节归属|在产|在产|
|[DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式.md|AI修改三模态反馈契约|在产|在产|
|[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md|谁做 vs 怎么做：默认自做 + 三闸门(G1 点名/G2 能力缺失/G3 隔离)准入、委派契约、禁止项、降级与反模式；规则 PROCESS-004|在产|在产|
|[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md|CH-6 外部智能体委派准入：G1 显式点名 / G2 本地能力缺失 / G3 需隔离环境，其余一律 khy 自做（默认档是自做，委派需举证）|在产|在产|
|[DESIGN-ARCH-115] TUI 启动板块设计.md|TUI 板块设计第 1 块：进程→输入框可用的六拍节拍链与契约、两渲染层原子交接、失败态二分、门控净新增 0、10 条验收|在产|在产|
|[DESIGN-ARCH-116] khyos-插件系统契约(@khy/plugin-sdk).md|自有插件系统契约真源：① @khy/plugin-sdk（manifest 4 必填字段 name/namespace/engines.khy/main、发现源 6 路 eager-lazy 边界、命名空间+版本门控，测试 26 条全绿）；② 姊妹篇 .khy/hooks.json Hooks 配置契约（hookConfigSchema 真源 + 11 事件 + 阻断/审计退出码语义 + 最小 PreToolUse 危险命令拦截样例，测试 17 条全绿）；与 `ccSkillBridge`（借 CC 生态）并行|在产|在产|
|[DESIGN-ARCH-117] khy-多端入口矩阵.md|四端（cli/desktop/mobile/web）入口的单一真源：把此前五处互相矛盾的端定义收敛成带检活的登记表；落点 L2 `services/backend/src/services/entrypoints/`（不新建顶层目录）、仓库级 vs 本机级定档分离、产物坐标只存指针不复制；含幽灵端等四条未收口清单|在产|在产|
|[DESIGN-ARCH-119] TUI原生文本选择与复制可用性修复.md|拖选复制失效的三条独立根因（press 被无条件吞 / Shift 修饰位被丢弃 / 备屏绕过未知终端保护）；v2 三层方案：判据收窄（已完成）→ 应用内自绘选择（跳出鼠标通道互斥，对齐 claude-code 松手即复制）→ 门控与登记收口；含 13 条反例矩阵与三层落地清单|在产|在产|
|[DESIGN-ARCH-119] TUI文本选择与复制-验收标准.md|ARCH-119 第二层（应用内自绘选择）的可执行验收标准：`S-xx`/`V-xx`/`A-xx`/`X-xx`/`N-xx` 五组用例的三段式（输入→期望输出→通过条件），面向小模型直接据以实现；含自验结果（模型层 27/27 实跑绿、全 TUI 771/771 无回归、5 条反例均能检出错误实现）|在产|在产|
|[DESIGN-ARCH-120] khy-移动端合并方案.md|收口 ARCH-117 遗留幽灵端：`apps/khy-mobile` 0 个 git 跟踪文件、源码已丢失，故不存在源码级合并，改为三段收编（契约收编 / 引用收口 / 目录隔离）；唯一真实差距是扫码，用 `mobile_scanner` 补齐并修掉 `Uri.splitQueryString` 误用；含能力对等矩阵、解析器四条不变量、跨语言契约测试、三条不可回退不变量；目录隔离明确不执行并列出爆炸半径|在产|在产|
|[DESIGN-ARCH-121] khyos-CC-Harness借鉴清单.md|黄佳《Claude Code 实战：Harness 工程之道》全书机制→借鉴决策 36 条（✅17/🔄10/🔁8/❌1）；P0/P1 落地详析 12 条（K-01~K-12）；载体改造（YAML→JSON 双文件）、不采纳 4 条理由、三轮施工序、整合总图 3 不变量|在产|在产|
|[DESIGN-ARCH-122] TUI 设计族总纲.md|TUI 设计族唯一导航入口与 scope 裁决真源（20 编号 / 21 文件，5 组；含 119 同号双文件）；规则冲突以 `[DESIGN-ARCH-102]` 为准|在产|
|[DESIGN-ARCH-123] K-01~K-12 施工盘点清单.md|施工前只读盘点：4 处复核订正（K-12 落点应为 `_patternRules` 而非 `rules`、pattern rules 的 `default:true` 对 opt-in 模式无效、内置 agent 实为 26 个非 5 个、`loadAgents.js` 的 YAML frontmatter 与 §2.5 冲突）；逐条落点/巨石/改动量/门禁风险表；5 件待裁决事项；前置检查命令与 `.khy/` 回滚路径|在产|在产|
|[DESIGN-ARCH-124] CC 模式剪贴板复制能力补齐提案.md|CC 模式（`KHY_CC_TUI=1`）下剪贴板底层通道（`utils/ccClipboard.writeClipboard`）与选区算法叶子（`selection.js`）补齐提案（**提案待评审、尚未编码**）；上游依赖 `[DESIGN-ARCH-119]`/`[DESIGN-ARCH-111]`；含盲区实证（6 层逐层定位，断点为 `CcApp.js` 零消费者）、方案 A/B 对比、7 项移植清单、键盘语义待决项、附录 A 编号冲突收口说明|在产|在产|
|[DESIGN-RES-001] 桌面端智能体UI调研与差距分析-2026-09-09.md|桌面端 UI 调研差距分析|在产|在产|
|[DESIGN-RES-002] 桌面端智能体UI每日调研-2026-09-10.md|桌面端 UI 每日调研日志|在产|在产|
|[DESIGN-ARCH-137] khyos运行时信息获取规则与读取预算接线方案.md|PROCESS-007 从「只约束改本仓的 AI」扩展为「约束 khyos 运行时」：三轴六条（定位/取样/存续）+ 契约 A–D + 四期落地；含四项实测断点（运行时零命中 3120 文件、`scopePlan` 零消费者、`PreCompact.additionalContext` 零消费、无任务级累计读取预算）|提案|提案|

**2026-09-10 规范族拆分**：全部独立编号规范族（`DESIGN-A11Y/API/ACP/BACKUP/CACHE/CICD/COMM/DB/DEP/
DEPLOY/DOC/ENV/ERR/FE/GIT/I18N/INDEX/LOG/MEM/MONITOR/MS/OUT/PERF/PRIV/REVIEW/SEC/TEST/TOOL`，
以及未编号协议件 `FILE-FORMAT-PROTOCOL.md`、`RELIABILITY-PROTOCOL.md`）已迁入
[`docs/10_规范/`](../10_规范/00_INDEX_规范-总目录.md)（规范目录）。ARCH 编号的设计族与治理单一真源
（068/069/070/071 等）留在本目录——拆分口径与台账见该目录 00_INDEX 第三节与
`docs/04_IMPL_实现/[IMPL-RPT-049]`。`FILE-FORMAT-PROTOCOL` 于 2026-08-15 曾从 `02_CONCEPTS_概念入门/`
迁入本目录，本次随规范族一并迁出。

> `FILE-FORMAT-PROTOCOL.md` 于 2026-08-15 从 `docs/02_CONCEPTS_概念入门/` 迁入本目录：它是
> **强制标准**（违反即过不了 `check-change-safety` 门控），不是给小白读的概念入门篇，此前落在
> 概念目录是历史批量搬迁的遗留，并因此成为 `docs:check-beginner` 的孤儿页。
> 它与 `RELIABILITY-PROTOCOL.md` 互补；后者正文提到的 `COMMUNICATION-PROTOCOL.md`
> **在仓库中不存在**（如实登记，本轮不补写）。

> **`[DESIGN-LAY-005]` 是「新代码/新目录该放哪一层、能依赖谁」的单一真源**，
> 由 `npm run check:layout` 的 `layer-registry` 规则强制执行。`AGENTS.md`、`README.md`、
> `[OPS-MAN-169]` 均指向它，不重复其内容。
>
> **`[DESIGN-TOOL-002]` 是「这东西该进核还是该做成拓展」的单一真源**，是 `068` 的下位法：
> `068` 管顶层目录属于哪一层，`069` 只把 L5 `extensions/` 内部的契约写细（manifest 形状、
> 根优先级、惰性激活、删目录即消失）。由同一守卫的 `extension-contract` 规则强制执行。
>
> **`[DESIGN-ARCH-071]` 是「一次操作该走哪条通道」的单一真源**：五通道（直接读状态/服务层直调/CLI/Web API/看屏幕）
> 的五问判定顺序、适用/禁止/降级与反模式。`AGENTS.md` 架构速查的「通道选择判定」节是它的压缩版，两处同改。
>
> **编号缺陷（如实登记，本轮不重编）**：`[DESIGN-ARCH-067]` 被两份文档同时占用
> （`opencode高含金量功能教学…` 与 `动态模型差异化适配引擎`），违反 [MGMT-STD-001]
> 编号唯一性。重编需同步改写入站引用与 `.html` 孪生件，属独立一轮工作。
> 因此本次新增文档取 **068**（跳过冲突号），下一个空号为 069。
>
> **订正（2026-09-16，二次）**：上一段的「下一个空号为 114」写于 `113` 落盘当时，**已两次过时**
> ——`114` 已于 2026-09-16 被 `委派边界决策矩阵-第六通道外部智能体` 占用，`115` 同日被
> `TUI 启动板块设计` 占用。**当时下一个空号为 116。**
> 另注：`114` 在本索引中**被登记了两行**（一行标「定稿」、一行标「提案」，指向同一文件），
> 与 [MGMT-STD-001] 的编号唯一性不符，待维护者裁决去重（本轮未擅自删除，避免与并行的写入冲突）。
> 新增文档前请以本节文件清单为准复核，勿沿用旧结论。
>
> **订正（2026-09-17，三次）**：上一段的「下一个空号为 116」同样**已过时**。实测本目录占用号已达
> `119`（`116` 插件系统契约、`117` 多端入口矩阵、`118` HQ 能力吸收与多机协作规范、`119` TUI 原生
> 文本选择修复先后落盘）。本次新增 `khyos-CC-Harness借鉴清单` 取 **121**：`120` 留作缓冲，
> 避免与并行写入再次撞号。**当前下一个空号为 122（120 为保留缓冲）。**
> 注意：`119` 当前仅存在 `.md`（无 `.html` 孪生件），属未完成的三件套同步，待其作者补齐或
> 运行 `npm run docs:build` 收口。
>
> **订正（2026-09-22，四次）**：上一段的「下一个空号为 122」已过时。实测本目录占用号
> 已达 `127`（`122` TUI 设计族总纲、`123` K-01~K-12 施工盘点清单、`124` CC 模式剪贴板
> 复制能力补齐提案、`125` 桌面端新对话卡片工作空间选择、`126` 跨端 AI 编程任务看板泳道
> 编排方案、`127` khyos 可维护性诊断与减负方案先后落盘）。本次新增
> `khyos结构化输出方案-输出卫生层与语义渲染契约` 取 **128**。**当前下一个空号为 129。**
> 新增文档前请以本节文件清单为准复核，勿沿用旧结论。

## 三、已归档（已删除孤儿引擎）

下列设计稿对应的治理引擎经 2026-06-14「接线或删除」核实为 ORPHAN（三入口不可达），其实现已删除，
设计稿移入 `docs/18_归档/03_DESIGN_设计/`（2026-09-15 自本目录提级为跨阶段冷存储）仅作历史留存，**非在产**：DESIGN-ARCH-024（marshal，
叶子 capabilityVector 仍在产）、033（dualTrack）、035（cognitiveSnapshot）、038（dualTrackForge）、
039（envSymbiosis）、040（dataSovereignty）、042（selfSustainingInfra）。

- 归档子索引：`docs/18_归档/03_DESIGN_设计/00_INDEX_已删除孤儿引擎归档.md`。
- 删除裁决与证据：`.ai/GOVERNANCE-LEDGER.md` §B.0；在产判据：`.ai/GUARDS-AI.md` §0。

## 四、跨分类关联指引

- 文档总入口：`docs/00_INDEX_文档索引.md`。
- 设计的实现落地：`docs/04_IMPL_实现/`；验证：`docs/05_TEST_测试/`。
- 治理标准上位规范：`docs/08_MGMT_项目管理/[MGMT-STD-001]`。
