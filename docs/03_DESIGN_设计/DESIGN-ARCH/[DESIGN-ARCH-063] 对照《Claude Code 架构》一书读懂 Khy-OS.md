# [DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS

> **本文是一条「阅读主线」,不是新设计。** 它借用一本讲 Claude Code(下称 CC)架构的书的目录
> 作为骨架,逐章把「书里讲的 CC 概念」对齐到「Khy-OS 里此刻真实的实现(文件:行)」,并如实标注
> **哪里相同、哪里 khy 特有、哪里 khy 没做或做法不同**。
>
> 为什么用书目录当骨架:khy 的 `docs/` 按**生命周期阶段**(设计/实现/测试/部署/运维/管理)归类,擅长
> 「一个功能怎么落地」;但缺一条**按认知顺序**「从启动到 REPL 到治理到愿景」串起来的解说线。这本书的
> 目录正好是这条认知线。两者互补,不改动既有分类法。
>
> 所有 khy 侧的文件行号均由 `node -e fs.readFileSync` 直读源码核出(2026-07-08),非猜测、非旧文档转抄。
> khy 与 CC 是**独立实现**:相同的是「Agent-as-OS」这套工程直觉,不同的是每处的取舍。

---

## 0. 书目录 → khy 阅读路径速查表

| 书章节 | 讲的是 | khy 对应实现(真源) | 深读文档 |
|---|---|---|---|
| 第1章 架构总览与启动 | 分层架构、入口分流、启动主流程 | `bin/khy.js`(身份分流/快速路径)+ `src/bootstrap/*` + `serviceLifecyclePolicy.js` | [DESIGN-ARCH-010] 核心架构、[DESIGN-ARCH-012] 工具延迟加载、[DESIGN-ARCH-062] 生命周期边界 |
| 第2章 REPL | 交互会话层、命令系统、工具系统、执行闭环 | `src/cli/repl.js` + `src/cli/tui/`(官方 Ink)+ `src/cli/router.js` + `src/tools/` + `src/services/queryEngine.js`→`toolUseLoop.js` | [DESIGN-ARCH-017] 元工具系统、[DESIGN-ARCH-021] 巨型环反转、[DESIGN-ARCH-060] 接线与编排总图 |
| 第3章 上下文/记忆/扩展/治理 | 系统 Prompt、文件记忆、上下文压缩、扩展与治理 | `src/constants/prompts.js` + `src/services/compact/` + `MEMORY.md`/`memdir/` + `src/services/mcp/`+`cli/plugins.js` + `flagRegistry.js`+7 守卫 | [DESIGN-ARCH-025] 元规划与约束注入、[DESIGN-ARCH-020] 架构债治理、[DESIGN-ARCH-062] |
| 第4章 Prompt 工程与 Agent 行为 | 负向指令、元 Prompt、验证 Agent、工具级/角色 Prompt、装配优先级 | `src/constants/prompts.js`(各 section 函数)+ `src/agents/built-in/` + `src/services/cliAgentRunner.js` | [DESIGN-ARCH-018] Agent 提示词复用、[DESIGN-ARCH-016] 显示规范、[DESIGN-OTHER-003] 提示词结构图 |
| 第5章 Agent 即操作系统 | 从工具进化为 OS 的愿景 | `kernel/`(MoonBit 微内核)+ 后台任务 + `daemon*` + `bridge/` + 多 Agent 编排 | [DESIGN-ARCH-007/008] 微内核与系统边界、[DESIGN-ARCH-001] 移动智能体协议 |
| 附录 术语表 | 术语对照 | 见本文 §6 khy 术语对照 | — |

> ⚠️ **本文顺带纠正**若干在旧对比文档([MGMT-RPT-019])里已过期的说法(书写于更早,khy 已迭代):
> ① queryEngine 的 **V2 状态机已删除**,现为 legacy loop + 可选 harness 双路;
> ② 全仓只有 **一个** `KHY_DEFER_TOOLS` defer 门,不存在复数 defer 门族;
> ③ TUI 已切**官方 `ink` 包**(经 `inkRuntime.js` CJS 桥接),旧自研 Flux/VirtualScreen 已移除;
> ④ 守卫是 **7 个** `scripts/check-*.js`,不止「三守卫」。以本文为准。

---

## 第1章 架构总览与启动 —— khy 的入口分流与冷启动

### 1.2 系统层次架构与模块
CC 分「入口分流 / 交互会话 / 查询编排 / 工具 / 治理」若干层。khy 同构但落在 `services/backend/`:
- **入口分流层** `bin/khy.js`(~1600 行):唯一可执行入口,决定「轻身份 `khy` / 全栈 `khyquant`」。
- **交互会话层** `src/cli/`(`repl.js` + `tui/` + `router.js` + `handlers/`)。
- **查询编排层** `src/services/queryEngine.js` → `src/services/toolUseLoop.js`。
- **工具层** `src/tools/`(约定式自动发现,~90+ 工具)。
- **治理层** `src/services/flagRegistry.js` + `serviceLifecyclePolicy.js` + `scripts/check-*.js`。

深读:[DESIGN-ARCH-010] 核心架构、[DESIGN-ARCH-014] 模式图谱。

### 1.3 入口分流层与 khy 的启动
- **双身份分流**:身份识别 `bin/khy.js:856-868` —— 优先 `env KHYQUANT_INVOKED_AS` → `basename(argv[1])`
  正则 → 默认回退 `khyquant`。运行时分流在 `main()`(`:298-302` `isKhyQuantBinary` 判定,`:328` 纯 CLI REPL)。
- **快速路径在重型 import 前退出**(与 CC「先响应 `--version` 再加载」同构):`bin/khy.js:969-991` ——
  `--help`(`:981`)、`--version/-V/-v/version`(`:986-991`)立即 `process.exit(0)`,不触发 bootstrap 之后的重模块。
- **bootstrap 初始化链**:`_bootstrapInit`(`bin/khy.js:439-440` → `src/bootstrap/init.js`),`main` 开头异步
  await;目录 `src/bootstrap/` 含 `init.js`/`setup.js`/`shutdown.js`/`prefetch.js`/`startupProfiler.js`/
  `windowsSpawnHardening.js` 等(dotenv/env/CA/proxy/shutdown 钩子)。
- **冷启动懒加载**(khy 的一等大事,因 pip 分发 + Windows 进程创建昂贵):重型模块一律分支内 `require`;
  唯一 defer 门 `KHY_DEFER_TOOLS`(`src/tools/index.js:38`,默认开);启动后的预热 `deferredPrefetch()`
  (`src/bootstrap/prefetch.js:84`)在提示符显示后按 `serviceLifecyclePolicy` 的 `cli-startup` 条目调度。

深读:[DESIGN-ARCH-012] 工具延迟加载、[DESIGN-ARCH-030] 源端构建-目标机自愈运行。

### 1.4 一次 khy 任务的主流程
与 CC 的「启动→装配上下文→进 REPL→查询循环→工具→收尾」一致。khy 的一个对话回合完整时间轴
(系统 Prompt 装配 → 工具循环 → 回合收尾蒸馏)见 **[DESIGN-ARCH-060] §二**(逐切点带行号),此处不复述。

### 1.5 把复杂度交给工程化系统:khy 的三层生命周期
CC 强调「用工程化系统吸收复杂度」。khy 的具体承载是 **`serviceLifecyclePolicy.js`**——把「谁常驻、谁启动跑一次、
谁按需惰性载入」显式化为**单一真源**,消除隐式散落:
- `resident`(常驻,需 shutdown 取消)/ `startup-oneshot`(启动跑一次)/ `on-demand`(首用惰性,永不进同步冷启动)。
- 注册表 `serviceLifecyclePolicy.js:14-17`(tier 定义)、`:55-186`(条目);主门 `KHY_LIFECYCLE_POLICY`(默认开,进 flagRegistry);
  守卫 `scripts/check-lifecycle-policy.js` 防漂移。

深读:[DESIGN-ARCH-062] khyos 后台常驻与按需加载生命周期边界(本条的专篇)。

---

## 第2章 REPL —— khy 的交互会话层与执行闭环

### 2.2 交互会话层的构成 & 2.3 khy 的 REPL
- **REPL 主循环** `src/cli/repl.js`(巨型文件):启动横幅 `printBanner`(`:645`)、「欢迎回来」面板(`:855-856`)、
  工作区自动纳管 `workspaceGitInit.ensureWorkspaceRepo`(`:337`,策略拒绝在 HOME 初始化)。
- **TUI = 官方 `ink`(重要更正)**:CC 用 React/Ink 渲染;khy 曾自研 Flux store/VirtualScreen,**现已移除**,
  改用官方 `ink` 包,经 CJS 桥接层 `src/cli/tui/inkRuntime.js:4-6`(「single entry point for the official `ink`
  package」「`ink` is ESM-only, while the KHY backend is CommonJS」)。组件在 `src/cli/tui/ink-components/`
  (`FooterBar.js`/`WelcomeBanner.js`/`Transcript.js`/`ToolLines.js`/`CompactionProgress.js` 等),主题
  `src/cli/renderTheme.js`(中文优先,尊重 `KHY_UI_LANG`)。

### 2.4.1 命令系统:精确执行任务
- 分发器 `src/cli/router.js`(`async function route` `:593`),按需 `require('./handlers/xxx')`。
- handler 模块族 `src/cli/handlers/`(**115 个**文件);命令名允许集由 `constants/commandSchema.js` 的
  `getRouterCommandNames()`(195 名)守门。命令类功能的「三处登记」铁律见 [DESIGN-ARCH-060] §一。

### 2.4.2 工具系统:给模型接上手脚
- **约定式自动发现** `src/tools/index.js:2/:57-67`(`readdirSync` 扫子目录 index.js + 顶层 .js);总量 ~90+
  (子目录工具 73 个:`AgentTool`/`GrepTool`/`FileEditTool`/`KhyOsTool`/`TaskCreateTool`… + 顶层单文件)。
- **按角色过滤工具面** `src/tools/toolProfile.js`:`PROFILES` = `minimal`(只读探索)/ `coding`(minimal+编辑/执行/git)/
  `analysis`(minimal+量化金融)/ `verification`。**注意**:书里的 "Explore Agent" 在 khy 是**角色名**,映射到
  `minimal` profile,不是独立 profile(见 §4.6)。
- **延迟揭示** `KHY_DEFER_TOOLS`(`index.js:38`):冷启动不急着实例化全部工具面,首用惰性揭示。

深读:[DESIGN-ARCH-017] 元工具系统设计。

### 2.5 REPL 的执行闭环
CC 的 REPL 闭环 = 提示 → 模型 → 工具调用 → 结果回灌 → 收敛。khy 的闭环落在 `queryEngine.js` → `toolUseLoop.js`:
- **更正:V2 状态机已删除**。`queryEngine.js:14-21` 明写「V2 state machine … have been removed」「Deprecated:
  `KHY_QUERY_ENGINE_V2` — the V2 path no longer exists」。当前是 **legacy loop + 可选 agentic harness** 双路
  (`:311/:376` harness,失败回退 legacy `:312/:324`),底层统一委托 `src/services/toolUseLoop.js`(`:241/:252`)。
- **工具环护栏**下沉到 `toolUseLoop`:循环检测、验证 nudge 由它承载(`queryEngine.js:331/:639` 注释说明已下沉,
  不再在 queryEngine 内重复)。
- **模型降级(529 级联)**:`MAX_CONSECUTIVE_529 = 3`(`queryEngine.js:48`),连续过载自动切候选模型。

深读:[DESIGN-ARCH-021] 巨型环反转设计、[DESIGN-ARCH-029] 有限窗口降级与强制兜底。

---

## 第3章 上下文、记忆、扩展与治理

### 3.2.1 上下文与系统 Prompt
- 装配总入口 `src/constants/prompts.js:assembleSystemPrompt(:2157)`,按声明顺序拼接各 section(文件头 `:8`
  「Sections are assembled in order」)。
- 动态自我认知段 `getKhySpecificSection(:1607)` 组装 `[selfAwareness, _coreProfile()]`(`_coreProfile` `:1640`)。
- **按需 section**(省 token):`getOnDemandPromptSections`/`getOnDemandPromptSectionDecision`(`:823/:830`),
  非每轮全量注入。

深读:[DESIGN-ARCH-025] 元规划协议与动态约束注入、[DESIGN-OTHER-003] 系统提示词结构图。

### 3.2.2 基于文件的持久化记忆
- 与 CC 的 `CLAUDE.md`/memory 同源理念:khy 用**基于文件的 `MEMORY.md`**(`.claude/…/memory/`,每条一文件带
  frontmatter),系统 Prompt 侧 `getMemorySection`(`prompts.js:1052`)。
- 记忆引擎 `src/memdir/`(`memdir.js`/`paths.js`/`memorySlug.js`/`projectMemoryContract.js`)+
  `src/services/memoryEngine/`;会话回顾 `src/services/sessionRecapService.js`。
- **编排铁律**:memory 是**外向**摘要,**绝不**自注入本节点上下文(`INJECTABLE_SLOTS` 刻意不含 memory),详见
  [DESIGN-ARCH-060] §二「三槽不对称」。

### 3.2.3 上下文窗口管理(压缩)
- 统一在 `src/services/compact/index.js`:`sessionMemoryCompact(:75)`/`microCompact(:124)`/`shouldCompact(:215)`,
  压缩 Prompt 在 `compact/prompt.js`;裁剪 `src/services/contextPruner.js`;管道 `src/services/query/compactPipeline.js`;
  UI 端 `ink-components/CompactionProgress.js`。
- 注:`docs/03_DESIGN_设计/_archive_已删除孤儿引擎/[DESIGN-ARCH-035] 上下文永续与认知压缩引擎` **已归档,不反映
  当前实现**,勿据它理解压缩链。

### 3.3.1 & 3.3.2 扩展通道与插件
- **MCP 服务器** `src/services/mcp/`(`mcpServer.js`/`mcpHttpServer.js`/`mcpStdioServer.js`/`mcpServerPresets.js`),
  系统 Prompt 侧 `getMcpInstructionsSection`(`prompts.js:1039`)。
- **CLI 插件** `src/cli/plugins.js:loadPlugins(:37)`——从 `~/.khyquant/commands/` 加载用户自定义命令,返回 `Map`。
- **handler 扩展**:新命令即 `src/cli/handlers/` 新模块 + 三处登记。

### 3.4 扩展的治理
CC 强调「扩展要能被治理:启用可控、执行可控」。khy 的治理三件套:
- **启用治理:门控 + 登记** `src/services/flagRegistry.js`(`FLAGS` 表 `:65`;新 `KHY_*` 门**必须**登记,未登记保守放行 `:21`)。
  默认开、`=0/off/false/no` 时**逐字节**回退 legacy。
- **执行治理:守卫**(**更正:7 个**,不止三个)`scripts/check-*.js` = `check-leaf-contract` / `check-agent-rules` /
  `check-change-safety` / `check-flag-registry` / `check-lifecycle-policy` / `check-model-hardcoding` / `check-tool-contract`。
- **生命周期治理** `serviceLifecyclePolicy.js` + `check-lifecycle-policy.js`(见 §1.5)。
- **元数据新鲜度**:`.ai/`(MAP/CONTEXT/GUARDS)由 `khy metadata refresh` + git pre-commit 钩子确定性保鲜。

深读:[DESIGN-ARCH-020] 架构债治理报告、[DESIGN-ARCH-062] 生命周期边界。

---

## 第4章 Prompt 工程与 Agent 行为设计

khy 与本章几乎逐节对应,主战场 `src/constants/prompts.js`:

### 4.2 负向指令的艺术("NEVER" 比 "PLEASE" 更有力)
- 密集 `NEVER` 风格:URL 猜测禁令(`:470`)、git 操作段 `getGitOperationsSection(:980)`(`:987-993` 一连串
  NEVER:改 git config / 破坏性 git / 跳钩子 / force push / 擅自 commit)。
- 分层否定:原则段 → 细节段(`doing-tasks:486`/`execution-discipline:512`/`scope-minimization:525`)。

### 4.4 对抗性自我建模:验证 Agent 的 Prompt
- 验证 Agent `src/agents/built-in/verificationAgent.js` + Prompt 段 `getPlanningAndVerificationSection(:551)`;
  「结构化输出要求」由 AgentTool 的 `StructuredOutput` 约定承载。khy 的验证纪律还外化为「闭环只在**可验证**满足时
  才算达成」(见 always-on `_coreProfile` 的 closure 协议)。

### 4.5 工具级 Prompt
- `getUsingYourToolsSection(enabledTools)`(`:869`)按启用工具面动态生成工具使用偏好;MCP 指令 `:1039`。

### 4.6 内置 Agent 的角色 Prompt(两套并存,须分清)
1. **声明式内置 agents** `src/agents/built-in/`:`exploreAgent.js` / `planAgent.js` / `generalPurposeAgent.js`
   (正对书里的 Explore/Plan/General Purpose),外加 khy 特有的 `auditAgent`/`fixAgent`/`mapAgent`/`readingAgent`/
   `researchAgent`/`khyGuideAgent`/`statuslineSetup`。装配 `agents/builtInAgents.js`(`GENERAL_PURPOSE_AGENT:11`,
   `enableExplorePlan` 开关 `:29/:42/:66`)。
   - 4.6.1 Explore = 只读高效 → khy `exploreAgent` 绑 `minimal` toolProfile。
   - 4.6.2 Plan = 架构师思维 → khy `planAgent`。
   - 4.6.3 General Purpose = 平衡默认 → khy `generalPurposeAgent`。
2. **可配置角色模板** `src/services/cliAgentRunner.js`:`general`(coding)/`explorer`(minimal)/`worker`(coding) 等,
   用户可用 `~/.khyquant/agent_roles.json` 覆盖(`:7-8`),`resolveRoleKey` 默认回退 `general`(`:35`)。

深读:[DESIGN-ARCH-018] Agent 提示词复用机制、[DESIGN-ARCH-043] khy-agent-sdk-Claude 对齐。

### 4.7 记忆系统的行为指令
- `getMemorySection(:1052)` + `getSessionMemoryAndContextSection(:623)`:告诉模型**何时写记忆、写什么、如何用**
  (对齐本仓 `CLAUDE.md` 的记忆纪律:一文件一事实、带 frontmatter、外向摘要不自注入)。

### 4.8 输出风格与人格切换
- 语言段 `getLanguageSection(languagePreference)`(`:1021`)、输出风格段 `getOutputStyleSection`(`:1034`);
  `KHY_UI_LANG` 为语言门控,**中文优先**(khy 相对 CC 的本地化取舍)。

### 4.9.3 Prompt 的装配优先级链
- `assembleSystemPrompt(:2157)` 顺序拼接 + flagRegistry 的父→子门优先级声明;冲突以更高优先级段为准。
  khy 特有的「元规划 + 动态约束注入」优先级见 [DESIGN-ARCH-025]。

### 4.10 设计哲学:Prompt 即 Coding
khy 把这条落成**工程约束**:提示词改动同样过守卫(`check-agent-rules`),提示词结构有专图([DESIGN-OTHER-003]),
提示词复用有机制([DESIGN-ARCH-018])——即「Prompt 当代码维护」。

---

## 第5章 当 Agent 从工具进化为操作系统 —— khy 的 Agent-as-OS

这是 khy 命名里 "OS" 的由来。书讲愿景,khy 已落若干**具体子系统**:

- **微内核(C/MoonBit)**:仓库根 `kernel/`(`kernel/moonbit/lib/khy_kernel/main.mbt`、`Dockerfile.kernel-build`),
  插件 SDK `platform/packages/moonbit-plugin-sdk/khy_sys.mbt`;backend 内 wasm 模块 `wasm-context/`/`wasm-chain/`/
  `wasm-indicators/`。深读 [DESIGN-ARCH-007] 微内核-ipc-moonbit、[DESIGN-ARCH-008] moonbit-系统边界。
- **后台任务(进程即调度单元)**:`src/services/backgroundTaskSpec.js`(纯叶子)+ `scripts/task-runner.js`(分离执行
  进程,`khy tasks run` 每任务一个 detached 子进程,关掉 REPL 也存活)+ `backgroundTaskLauncher.js`(launch/stop/
  tailLogs)+ 复用持久化 `src/tasks/largeTaskRuntimeStore.js` 状态机。这是 khy「让 Agent 拥有后台进程」的最新一块。
- **守护进程(daemon)**:`src/services/daemonEntry.js`/`daemonManager.js`/`daemonSpawnLocation.js` + `cli/handlers/daemon.js`。
- **移动协作(bridge)**:`src/bridge/`(`bridgeServer.js`/`mobilePage.js`/`bridgeAuth.js`),让手机接入同一个 Agent OS。
  深读 [DESIGN-ARCH-001] khy-移动智能体协议。
- **多 Agent 编排**:`src/services/orchestrationFlow.js` + `agentLauncherRegistry.js` + `tools/AgentTool/`
  (`claudeDelegation.js` 委派)+ `cliAgentRunner.js`;自治 `src/services/autonomy/`。

> 定位说明:khy 把「网关(多供应商路由)+ 工具面 + 记忆 + 治理 + 后台进程 + 内核」当成一台面向 Agent 的操作系统来
> 建;CC 侧更聚焦编码助手体验。二者共享 Agent-as-OS 的工程直觉,落点不同。

---

## 6. khy 术语对照(对应书「附录 术语表」)

| 书/CC 术语 | khy 对应 | 位置 |
|---|---|---|
| 入口分流 | 双身份识别(khy/khyquant) | `bin/khy.js:856-868` |
| System Prompt 装配 | `assembleSystemPrompt` + 按需 section | `prompts.js:2157/:823` |
| 文件记忆(CLAUDE.md/memory) | `MEMORY.md` + `memdir/` | `prompts.js:1052`、`src/memdir/` |
| 上下文压缩(compact) | `compact/index.js` compact 家族 | `:75/:124/:215` |
| 工具注册 | 约定式自动发现 | `src/tools/index.js:57-67` |
| 工具面按角色裁剪 | `toolProfile`(minimal/coding/analysis/verification) | `src/tools/toolProfile.js` |
| 查询循环 | `queryEngine`→`toolUseLoop`(V2 已移除) | `queryEngine.js:14-21/:241` |
| 内置 Agent(Explore/Plan/General) | `src/agents/built-in/*` + `cliAgentRunner` 角色 | `agents/built-in/`、`cliAgentRunner.js` |
| 扩展治理 | flagRegistry + 7 守卫 + lifecyclePolicy | `flagRegistry.js`、`scripts/check-*.js` |
| MCP/插件 | `services/mcp/` + `cli/plugins.js` | `plugins.js:37` |
| Agent 即 OS | 内核 + 后台任务 + daemon + bridge + 编排 | `kernel/`、`backgroundTask*`、`bridge/` |

---

## 怎么用这条阅读线

- **新人/换 AI 接手**:按第1→5 章顺序读本文,每节点开「深读」链进对应 DESIGN 文档,即可从启动一路读到愿景。
- **想改某处**:先在速查表定位子系统与真源文件,再看该处的专篇 DESIGN-ARCH,最后遵 [DESIGN-ARCH-060] 的
  接线五件套落地。
- **发现本文与代码不符**:以代码为准并更新本文——本文承诺行号由 node 直读核出,过期即修。

承 [DESIGN-ARCH-010] 核心架构、[DESIGN-ARCH-060] 接线与编排总图;与 [MGMT-RPT-019] CC-vs-khy 对比互补
(那篇逐维度对比优劣,本篇按书目录做认知导览并校正其过期事实)。
