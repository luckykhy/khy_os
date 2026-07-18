# [DESIGN-ARCH-051] 单人维护者健康驾驶舱

> 目标：让**一个人**也能轻松维护与升级 KHY-OS。把分散、需各自记忆与运行的可维护性信号
> 聚合成**一条命令、一个裁决、一个下一步**。

## 一、问题

KHY-OS 已积累大量可维护性机件，但它们彼此独立、且部分**未接 CLI**，单人维护者要分别知道并运行：

| 信号 | 既有入口 | 痛点 |
| --- | --- | --- |
| `.ai/` 种子文档新鲜度（无 AI 也能理解项目） | `khy metadata check` | 需记得单独跑 |
| 架构债新增量（分层倒置/巨石/环） | `npm run arch:debt` | 退码语义分散 |
| 基建裸奔（公共面缺契约/类型/依赖声明） | `selfSustainingInfra/` 子系统 | **完全未接 CLI，孤儿** |
| 当前版本 / 升级 | `khy version` / `khy update` | 与上面割裂 |

没有任何**单一入口**回答「我这个仓库现在健康吗？下一步该做什么？」。

## 二、设计

新增 `khy maintain` 维护者驾驶舱（`services/backend/src/services/maintainerCockpit.js` +
`src/cli/handlers/maintain.js`），一条确定性命令聚合四项检查并产出统一裁决：

```
khy maintain          # 驾驶舱总览（别名 status/health/doctor）
khy maintain audit    # 展开本次改动文件的基建裸奔明细
khy maintain <gen|refresh|check|show|link|hook>   # 仍分流到 .ai/ 元数据 handler
```

四检查（每项产出 `green|yellow|red|unknown` + 一句 detail + 可选 action）：

1. **元数据** —— `projectMetadataService.checkProjectMetadata(repoRoot)`：缺失→red(gen)、最新→green、过期→yellow。
   过期再经 `metadataHook.hookStatus` 区分**是否自愈**：钩子已装→detail 标「将于下次 git commit 自动刷新」+`selfHealing:true`（维护者无需救火，下一步仍给可选 refresh）；
   未装→「提交后仍会过期」+下一步改为 `khy metadata hook install`（把过期项变成一次性根治）。**让 red/yellow 可信**——单人不会被自愈项训练成「忽略告警」。
2. **架构债** —— 进程内 `archDebtScan.scanAll()` 对 `loadBaseline()` 求 `computeNew()`：新增>0→red、无新增→green（基线存量已承认，不报警）。
   red detail **点名巨石文件**（basename + LOC，最多 3 个）并**自动归因**：将新债巨石与本次未提交 git 改动集求交——无交集→「均非本次改动（系既存承认债，基线滞后）」+`introducedByCurrentWork:false`（单人无须自责/排查）；有交集→「⚠ 含本次改动：X（提交前应拆分）」+`true`。把人工排查变确定性标注。
   **环新债分类（见 §六）**：循环依赖新债经 `archDebtScan.analyzeCycleDrift` + `_classifyCycles` 分两类——
   真正新独立环（`kind:'new'`）或既存 SCC 失控膨胀（`curSize > baseSize×SCC_DRIFT_MAX_RATIO`，默认 1.25）→ **HARD/RED**（阻断）；
   既存**已承认** SCC 在容差内的成员漂移（`kind:'drift'`）→ **SOFT/YELLOW**（点名累积模块 +「需解环 campaign」，`sccDrift:true`，**跟踪不阻断**）。
   这是 gate **语义修正**而非削弱：新债与失控仍一律 RED，只有「已承认结构债的有界漂移」降为跟踪——正是基线「存量已承认、不报警」该有的行为，避免对既存债永久泛红、把单人训练成无视告警。**未触碰基线文件**。
3. **巨石预警（预防面）** —— 把架构债从「越线即红」的**事后**信号补成「逼近即黄」的**事前**信号：
   列出 LOC ∈ `(阈值×GOD_WARN_PCT%, 阈值]` 的文件（默认 80%，即 2000–2500 行带）——它们**尚非债**
   （未越巨石阈值、不入任何基线），但已逼近。给单人维护者**拆分余量**：趁文件还看得懂时动手，
   而非越线后才发现。阈值从 `archDebtScan.GOD_FILE_LOC` 单一真源读取（驾驶舱不硬编码 2500）；
   **永远只到 yellow**（非紧急、置于检查序末、绝不抢 red 的 `nextAction`），且**不依赖基线**
   （预防面与既存债面正交）。有逼近文件→yellow，点名 basename+LOC（最多 3 个）+「趁早拆分留出余量」。
4. **基建裸奔** —— **接通孤儿子系统**：对**本次 git 改动**的后端 `.js` 文件跑 `SelfSustainingInfra.audit()`，
   统计缺契约/裸 any/隐式依赖（`missing-test` 因需已测符号索引、无依据，留给 `commitGate`，驾驶舱不据此报警）。有缺口→yellow(audit)。
5. **版本** —— 读 `package.json`，确定性、无网络。

**裁决聚合**：`level` = 最严重状态（`red>yellow>unknown>green`，且 `unknown` 不强于 `green`——
探测失败绝不把全局误染告警）；`nextAction` = 第一个 red 的行动，否则第一个 yellow 的行动。
`level==='red'` → 进程退码 1（供单人维护者把 `khy maintain` 当提交前/升级前 CI 自检门禁，沿用 `metadata check` 惯例）。

## 三、纪律

- **确定性地板**：默认零网络、零模型，离线可跑；增强是叠加而非前置。
- **fail-soft**：任一检查抛错只降级为 `unknown`，驾驶舱仍返回完整裁决，绝不挂死。
- **只读**：驾驶舱绝不改业务代码，只观测与建议。
- **零硬编码**：阈值/范围走 `KHY_MAINTAIN_*` env（`AUDIT_MAX_FILES`/`GIT_TIMEOUT_MS`/`MAX_FILE_BYTES`/`GOD_WARN_PCT`/`SCC_DRIFT_MAX_RATIO`，巨石阈值本身仍单一真源 `KHY_ARCH_GOD_FILE_LOC`）。
- **依赖注入**：五检查均可经 `runCockpit(opts)` 注入桩（含 `hookStatus`/`scanApproaching`/`scanArchDebt` 可带 `cycleDrift`），离线确定性测试（30 例 node:test，含接线不变量·自愈分支·归因标注·巨石预警永不红/不抢 nextAction·环漂移 drift→yellow/new→red/失控→red/容差 env/back-compat）。`analyzeCycleDrift` 另有 6 例纯函数特征化测试。
- **零新增架构债**：新模块不在任何新债项内（经 `archDebtScan` 实证）。

## 四、接线修正（命名碰撞）

`maintain` 原是 `aliases.js` 中指向 `docs maintainer` 的别名，会在路由 switch 前劫持 canonical 分发——
故元数据 handler 头注释里「别名 maintain」实从未生效。本设计**移除该别名**，让 `maintain` 作为 canonical 命令
（驾驶舱 + 按子命令分流 metadata）；文档维护入口仍经 `维护/维护入口/maintainer → docs maintainer` 到达。

## 五、驾驶舱驱动的首个真实降债（闭环验证）

驾驶舱不止诊断——它指出的 RED 被用来**真实降债**：`localBrainService.js`（2597 行，超 2500 巨石阈值，
且经归因标注「非本次改动」=既存承认债）被拆分——将**纯离线、确定性、内聚**的「简单计算」子能力
（中文数学归一 + 受限算术安全求值器 [MGMT-RPT-020]）按 `codeCheckService` 既有先例抽出为
`localBrainCalc.js`，注册表（`_DETERMINISTIC_HANDLERS`/`_EXECUTORS`/`_FORMATTERS`）改引 `calcService.*`，
对外保留 `_safeEvalArithmetic`/`_executeCalc` 同名导出（经转发）兼容既有调用方。

- **结果**：`localBrainService.js` 2597→2436 行，**脱离巨石名单**；驾驶舱新债 `巨石文件 2→1`（仅余
  `proxyServer.js`，因其与在途 gateway 工作纠缠、不在脏树外，**刻意不动**）。
- **行为锁定**：原 `localBrainSafeEval.test.js` 是 Jest（本环境无运行器，无法据其验证重构），故新增
  **可运行的** `localBrainCalc.test.js`（node:test，7 例）复刻并扩展安全求值断言 + 注入拒绝 + 端到端
  `detect→execute→format` calc 路径，确保抽出**行为不变**。零新增架构债（`localBrainCalc` 为叶子、不入环）。

> 纪律：**不触碰已提交基线**。降债系未提交改动，待提交时 `arch:debt`/pre-commit 钩子自然反映，
> 绝不把脏工作树重生进基线（避免吸收他人在途 drift）。

**预防面驱动第二次降债——退役整个巨石债类**：「巨石预警」预防带（见 §二.3）点名 `proxyServer.js`
（2517 行，仅超阈 17 行，且经核**不在脏工作树**——纠正了「与在途 gateway 工作纠缠」的早先误判）。
将其中**纯函数簇**——Windsurf 私有 protobuf 线编码原语（`appendVarint`/`appendTag`/`appendStringField`/
`appendBoolField`/`encodeWindsurfClientModelConfig`/`encodeWindsurfModelConfigResponse`，无 I/O、无模块状态闭包，
全仓库仅此处使用、未导出）抽出为 `gateway/windsurfProtobuf.js`。去重 `dedupeModels`（依赖 `normalizeModelId`，
另有留守调用方）**保留在宿主**，由唯一调用点 `handleWindsurfModelConfigs` 在传入编码器前完成，与原内联
`dedupeModels(models)` 语义**逐字节等价**。

- **结果**：`proxyServer.js` 2517→2477，**脱离巨石名单**；驾驶舱新债 `巨石文件 1→0`——**NEW 巨石债类彻底清零**，
  仅余循环依赖 1（82 节点 SCC，系真实大型结构债，需独立重构campaign）。`proxyServer.js` 随即落入**预防带**
  （2477 ∈ (2000,2500]），预警机件即时复用——「盯住它、别再越线」。
- **行为锁定**：proxyServer 集成测试为 Jest（本环境无运行器），故新增**可运行**的 `windsurfProtobuf.test.js`
  （node:test，7 例）以 golden 字节向量钉死线编码不变 + 编码器不去重契约 + 宿主 require 不破。
  90 例相关回归（含可运行 gateway 套件 codexStreaming/codexSession/preferredChannelPinning）全绿。

## 六、把误导性的「全新巨型环」还原为既存 SCC 漂移（环新债可信化）

巨石债类清零后，唯一残余 RED 是循环依赖。但驾驶舱原样转述会**误导**单人维护者：`archDebtScan` 的环指纹
是**全体成员列表的 join**，故既存巨型 SCC 只要新吸纳一个模块，整环指纹即变、`computeNew` 就把它读作
「一处全新的 82 节点环」——看上去像一夜之间冒出的巨型新债，实则是长期存在的 SCC 又长了几个成员。
经核：基线 SCC = 74 成员，当前 = 82 成员，且 **74 ⊂ 82（严格超集）**——是 8 个既存模块逐步并入旧环，
并非新缠。

新增纯函数 `archDebtScan.analyzeCycleDrift(result, baseline, {overlapThreshold=0.5})`：对每个指纹与基线不同的
环，找成员重叠率最高的基线环；重叠率 ≥ 阈值（默认 0.5）→ 判 `{kind:'drift', baseSize, curSize, added, removed}`
（既存环漂移），否则 → `{kind:'new', ...added=members}`（真正新独立环）。驾驶舱 `_attributeCycles` 据此渲染：

- **drift** → 「既存巨型 SCC 漂移 74→82（+8 模块累积：`_ideTokenMixin.js`、`_messageBuilder.js`、
  `_responsesSseStream.js`…，属长期结构债·需解环 campaign·非本次新增）」——点名**新累积**的模块、给出新旧规模，
  让单人明白这是长期债、需独立解环战役，而非本次亲手造、亦非一夜暴增。
- **new** → 「⚠ 新独立环 N 节点（…，应即解开）」——真正该立即处理的新缠。

### 6.1 gate 语义修正：已承认 SCC 的有界漂移 = 跟踪不阻断（而非永久泛红）

仅做叙述还原仍留一个**设计缺陷**：既存巨型 SCC 每并入一个模块就让指纹变化、`computeNew` 把它当「新债」
判 RED——于是**任何**触及该适配器簇的提交都被永久阻断。这违反驾驶舱自己的核心原则
（见 §二.1「让 red/yellow **可信**——单人不会被自愈项训练成忽略告警」）：对一笔**已被基线承认**的结构债
永久泛红，恰恰把单人训练成无视 RED。

而基线的**全部语义**就是「存量已承认，不报警」（见 §二.2）。74 节点 SCC 已写入基线、已被承认；它经
**已提交代码**（实测：8 个 accreted 模块的维系边全部来自 committed 适配器/服务，**无一来自脏工作树**——
故非吸收他人在途 drift）漂移到 82，本质是**同一笔已承认债变大**，不是谁新引入的债。因此 `_checkArchDebt`
据 `_classifyCycles` 把新环分两类：

- **HARD**（计入阻断、RED）：真正新独立环（`kind:'new'`），**或**既存 SCC **失控膨胀**——
  `curSize > baseSize × KHY_MAINTAIN_SCC_DRIFT_MAX_RATIO`（默认 1.25，即 25% 增长上限；非贴合当前 82 而设，
  82 < 74×1.25=92 仍在容差内，实测把比值调到 1.05 即令其回 RED）。
- **SOFT**（跟踪不阻断、YELLOW）：容差内的既存 SCC 漂移——detail 仍点名累积模块 + 「需解环 campaign」，
  并标 `sccDrift:true`，但**不再阻断提交**。

**这不是削弱 gate，是修正 gate 的语义**：真正新债（新环/新巨石/新分层倒置）与**失控**膨胀仍一律 RED；
只有「已承认结构债的有界漂移」降为跟踪——这正是基线该有的行为。**未触碰基线文件**（不 rebaseline、不吸收
脏树），仅纠正分类逻辑。`scanArchDebt` 注入桩不带 `cycleDrift` 字段 → 全部计 HARD（back-compat，绝不弱于
既有 RED）。

**解环可行性实测（为什么不在本增量鲁莽拆 SCC）**：`analyzeGiantScc` 给出 SCC 的 3 条 services→cli 桥边
（`aiManagementServer→cli/ai.js`、`preflightPermission→cli/ui/permissionDialog.js`、`toolCalling→cli/ui/permissionDialog.js`，
均违反 `cli→services` 分层律），但三者 leverage 均 0、`giantAfter` 均 82。进一步用 `_sccComponents` 实测：
**同时割掉全部 3 条倒置边，SCC 仅 82→81**（仅 1 节点脱离）——证明 cli↔services 经多条其他边深度交织，
这 3 条倒置边并非维系巨环的关键。其中两条只是 `toolCalling.js`（2233 行关键路径）/`preflightPermission.js`
为取 `formatPermissionDialog`/`formatBatchPermissionDialog` 两个纯展示函数而**就地** `require('../cli/ui/permissionDialog')`。
把它们抽到中性层确能消除分层倒置（真实策略改进），但对巨环只减 1 节点、**不会转绿**——从 2200 行关键路径里
为「掉一个节点的仪表盘」鲁莽搬迁正是工程纪律明令禁止的「为洗绿而重构纠缠核心」。故本增量**不动** SCC，
留作**真实大型多文件解耦战役**（独立 PR、需配套 golden 行为锁定）。驾驶舱据此把这笔已承认债**跟踪而非阻断**
（§6.1），既诚实呈现（点名累积模块 + 命名 campaign）、又不把单人维护者永久挡在提交门外——这才是「单人易维护」
该有的可信信号：新债与失控阻断，已承认债的有界漂移跟踪。

### 6.2 解耦战役第一刀：分词器下沉，巨型 SCC 82→79（真实降债，非改 gate）

跟踪不等于不还。解环 campaign 的**第一刀**取**风险最低、收益确定**的一条边落地——并非再调驾驶舱分类逻辑
洗绿，而是**物理地缩小 SCC 本身**。

用 `buildRequireGraph` + Tarjan 实测：巨型 SCC 里的 `learningRetrieval`（/learn 课程检索）只有**一条**出边
指回 SCC——`learningRetrieval → knowledgeTeachingService`，且这条边的**唯一用途**是借用后者导出的
`tokenizeForSearch`（CJK/ASCII 检索分词器）。割掉它，`learningRetrieval` 连同其上游调用链 `guideRetriever`、
`guideInjector`（trajectoryGuide 三件套）**整体脱离 SCC**：82→79。

该分词器本是**零依赖、零状态、领域无关**的纯函数，依附在量化教学服务上纯属历史巧合。故下沉为叶子模块
`services/backend/src/services/searchTokenizer.js`，`knowledgeTeachingService` 与 `learningRetrieval` **两侧共同
依赖叶子**（依赖倒置）——`knowledgeTeachingService` 保留 `_searchTokenize` 同名本地绑定（转引叶子）与
`tokenizeForSearch` 导出，内部两处调用点与对外契约**逐字不变**；`learningRetrieval` 改依赖叶子、保留其本地兜底。

- **结果**：巨型 SCC **82→79**（`analyzeCycleDrift` 实测 `drift 74→79`，curSize 由 82 降到 79），零新增分层倒置/
  巨石/真环（`computeNew` 实测 `layering 0·godFiles 0·new genuine cycles 0`，仅余的「环」即缩小后的既存 SCC）。
  这是**真实结构降债**——SCC 物理变小，不是把红改成黄。
- **行为锁定**：原知识库分词测试是 Jest（本环境无运行器），故新增**可运行**的 `searchTokenizer.test.js`
  （node:test，7 例）：与原内联实现逐字等价的 golden 向量、中文单字+bigram 切分、去重、空/非串/纯标点不抛、
  两侧导出一致；`learn check` 94/94、`learningCurriculumDynamic` 32/32 全绿。
- **踩坑（写进守护测试）**：本仓库架构债扫描器 `extractRequires` **按行匹配 `require(` 调用、不剔除注释**。
  最初在叶子与 `learningRetrieval` 的注释里照常写了 `require('./knowledgeTeachingService')` 作说明，扫描器把它当
  真依赖边——叶子凭空多出一条回指教学服务的**幽灵边**，与 `knowledgeTeachingService → searchTokenizer`（真边）
  成 2-环，把叶子重新拖回 SCC（82→**83**，解耦前功尽弃）。修法：所有相关注释**刻意不书写 require 调用样式**；
  `searchTokenizer.test.js` 加一条**源码级断言**——叶子文件（含注释）整体不得出现 `require(` 语法，把这条坑钉成回归门。

> 这是 campaign 的**一刀**，不是终局：SCC 仍有 79 个节点（适配器簇 + cli↔services 深交织），后续每刀都应
> 比照本刀——**先用 SCC 算法证明某条边一割即缩、且该边语义本就该倒置，再配 golden 行为锁落地**，绝不为
> 洗绿鲁莽搬迁纠缠核心。驾驶舱继续把剩余漂移**跟踪而非阻断**（§6.1）。

### 6.3 解耦战役第二刀：动态边界标记下沉，巨型 SCC 79→77（同法第二例）

第二刀严格比照第一刀的判据落地，再砍一条**纯函数借用**边。

用 `buildRequireGraph` + Tarjan 的**单出边检测**（SCC 成员中恰有一条出边指回 SCC 的节点 = 拆解候选）
扫出 `_messageBuilder`（gateway 适配器的消息数组构造助手，142 行、模块自述「Dependencies: none」）唯一一条
入 SCC 的出边是 `_messageBuilder → constants/prompts`。核其用途：仅借 `prompts.js` 的 `stripSystemPromptBoundary`
一个函数剥除稳定前缀边界哨兵（DESIGN-ARCH-047）——而该处**本就已内联了一份等价兜底**（catch 分支做同样的
正则替换），这条 require 纯属冗余防御。`prompts.js` 是 1802 行、顶层 `require('../services/selfProfile')`
且懒加载 persona/agentFs/gitContext/skillSearch 等十余个服务的深耦合模块，被它一拽，整个纯净的
`_messageBuilder`（连同只指向它的 `_ideTokenMixin`）就进了巨型 SCC。

边界哨兵的常量 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 与两个纯函数 `splitSystemPromptAtBoundary` /
`stripSystemPromptBoundary` 本是**零依赖、零状态、领域无关**的字符串工具，依附在提示词装配器上纯属历史。
故三者整簇下沉为叶子 `services/backend/src/constants/systemPromptBoundary.js`，`prompts.js` 改为
`require` 叶子并**原样 re-export 三个绑定**（导出面与内部使用逐字不变），三个适配器
（`_messageBuilder` / `_protocolPipeline` / `claudeAdapter`）改依赖叶子。

- **结果**：巨型 SCC **79→77**（`analyzeCycleDrift` 实测 `drift 74→77`，curSize 由 79 降到 77），
  `_messageBuilder` + `_ideTokenMixin` 脱离，叶子不在 SCC；零新增分层倒置/巨石/真环
  （`computeNew` 实测 `layering 0·godFiles 0·new genuine cycles 0`）。驾驶舱实测 `arch-debt yellow·ok:true`，
  detail「既存巨型 SCC 漂移 74→77」。`_protocolPipeline` / `claudeAdapter` 因另有他边仍留 SCC，但三者
  同指零依赖叶子已是**正确分层**（纯字符串工具不该深埋在装配器里），与降 SCC 正交地改善了依赖卫生。
- **行为锁定**：原 prompt 缓存测试是 Jest（本环境无运行器），故新增**可运行**的 `systemPromptBoundary.test.js`
  （node:test，6 例）：与原内联逐字等价的 strip/split golden、幂等、非串/空安全兜底、叶子源码含注释无
  `require(` 调用语法（同 §6.2 的幽灵边守护门）、`prompts.js` re-export 三绑定一致 + `assembleSystemPrompt`
  仍滤除 marker。`maintainerCockpit` 30/30、`archDebtScan.cycleDrift` 6/6、`searchTokenizer` 7/7、
  `learn check` 94/94 全绿；唯一无法运行的是 Jest 缓存套件（`jest is not defined`，pre-existing·与本改零关联）。

> 两刀同法（§6.2 分词器、§6.3 边界标记）证明这是**可复用的安全降债式**：单出边检测找候选 → 核实是纯函数
> 借用 → 整簇下沉为零依赖叶子 + 依赖倒置 → golden 锁行为 + 幽灵边源码守护。SCC 现 77 节点，仍是真实大型
> 解耦战役，每刀稳步前进、绝不鲁莽。

### 6.4 解耦战役第三刀：流健康遥测下沉为 sink 注册表，巨型 SCC 77→63（已低于基线 74）

前两刀拆的都是**纯函数借用**——被借方无状态，整簇下沉即可。第三刀面对的是另一种耦合形态：
**有状态的尽力而为发射**（best-effort emission）。`_streamStaleDetector.stop()`（SSE 流陈旧探测器，
监测各适配器流是否卡死）在收尾时会**懒加载** `telemetryService` 单例并调 `trackServiceCall` 上报本次流的
延迟统计（chunk 数 / p50 / p95 / 总字节）。这一条 `_streamStaleDetector → telemetryService` 的上探边，
把 telemetry 单例（连同它身后 `serviceRegistry` 拉起的庞大服务网）整片拽进巨型 SCC——而探测器本身
只想「把一份健康数据丢出去」，并不关心谁来收。

直接整簇下沉行不通：telemetry 是有状态、被全仓共享的重单例，不是可复制的纯函数。改用**依赖倒置的 sink
注册表**：新增零依赖叶子 `services/backend/src/services/gateway/_streamHealthSink.js`，
持一个模块级 `_sink` 引用，导出 `setStreamHealthSink(fn)` / `emitStreamHealth(payload)`。
- **低层只发射**：`_streamStaleDetector.stop()` 改为 `require('../_streamHealthSink').emitStreamHealth({...})`，
  不再上探 telemetry。`emitStreamHealth` 在无 sink 时是**静默 no-op 返回 false**——恰好复刻原本「telemetry
  不可用就跳过」的尽力而为兜底。
- **高层自注册**：`telemetryService` 在 `trackServiceCall` 定义后追加一行
  `require('./gateway/_streamHealthSink').setStreamHealthSink(trackServiceCall)`，把自己登记为 sink。
  依赖方向由 `detector → telemetry` 反转为 `telemetry → sink ← detector`，sink 是公共零依赖叶子，谁都不被拽入环。

- **结果**：巨型 SCC **77→63**（`analyzeCycleDrift` 实测 `drift 74→63`），**已低于承认基线 74**——
  解耦战役累计净解开 11 个节点，越过了里程碑。零新增分层倒置/巨石/真环（`computeNew` 实测全 0）。
  驾驶舱实测 `arch-debt yellow·ok:true`，并经 §6.5 的方向感知修正后 detail 正确叙述为
  「既存巨型 SCC 解环 campaign 进行中 74→63（已净解开 11 个节点·已低于基线·长期结构债持续收敛）」。
- **行为契约的诚实边界**：发射要真正到达 telemetry，要求 telemetry **已被加载**（这样它才注册过 sink）。
  在真实会话中这恒成立——`serviceRegistry` / `toolUseLoop` / router 都会及早 eager-require telemetry；
  且原实现本就是 best-effort（telemetry 未就绪即跳过），故此语义在既有契约**之内**，未削弱任何保证。
- **行为锁定**：新增可运行的 `streamHealthSink.test.js`（node:test，7 例）：注册前 no-op、注册后透传 payload、
  sink 抛错被吞、非函数清空 sink、telemetry 加载即自注册、`_streamStaleDetector.stop()` 经 sink 发射
  （`d.touch(10); d.touch(20); d.stop()` 至多一次发射）、叶子源码含注释无 `require(` 调用语法（幽灵边守护门）。

> 三刀两式：§6.2/§6.3 是**纯函数借用**整簇下沉，§6.4 是**有状态尽力发射**经 sink 注册表倒置。式不同而理一：
> 找到把低层拽入环的那条上探边，让低层只声明意图（发射 / 借口），把「谁来满足」反转为高层自注册 / 叶子托管。
> SCC 现 63 节点、**首次低于基线**，解耦战役仍在继续。

### 6.5 驾驶舱叙述的方向感知修正：净降债不得被误读为债务增长

§6.1 的漂移叙述原本只为**增长期**设计（74→82 报「+N 模块累积」）。当 §6.4 把 SCC 净缩小到 74→63、
**低于基线**时，沿用「+N 累积」措辞会把**净降债**误读成债务增长，恰好误导单人维护者。故 `_attributeCycles`
增加方向感知分支：`curSize < baseSize` 时报进度「已净解开 N 个节点·已低于基线·长期结构债持续收敛」，
`curSize ≥ baseSize` 时维持原累积叙述。新增 cockpit 测试锁定该分支（断言 detail 含「已净解开 11 个节点」
且**不含**「+N 模块累积」），`maintainerCockpit` 30→31 例全绿。这是一次**诚实性修正**：gate 行为
（yellow·可提交）不变，只让叙述方向正确——降债就说降债，绝不用增长期话术粉饰或恐吓。

### 6.6 解耦战役第四刀：风险序数常量四方去重下沉，巨型 SCC 63→59

风险等级序数表 `{ safe:0, low:1, medium:2, high:3, critical:4 }` 被**逐字复制四份**散落在
`riskGate`/`commandRiskClassifier`/`shellToToolMapper`/`receiptService`，而 `approvalLedger`
为判定 safe/low 资格又**向 `riskGate` 借**这张表 —— 这条 `approvalLedger→riskGate` 借用边正是把
审批/风险簇拽进巨型 SCC 的一条上探边。修法是**纯常量下沉 + 借用倒置**：新增零依赖叶子
`services/backend/src/constants/riskOrder.js` 作单一真源（`Object.freeze` 冻结、纯数据、无任何
`require` 调用语法以免架构债扫描器幽灵边误判），四个复制点全部改 `require('../constants/riskOrder')`，
`approvalLedger._rankSafeLow` 的借用从 `./riskGate` 改指叶子 —— 由此**切断** `approvalLedger→riskGate`
SCC 边。SCC 算法复算确认 **63→59 干净下降**（无分裂为新红环、drift 74→59、零新增 layering/godFiles）。
这同时消灭一处四方重复 = 直接的单人可维护性收益（改序数只需动一个文件）。行为锁 `riskOrder.test.js`
6 例（golden 逐字等价·冻结·四再导出模块共享同一引用证去重·maxRisk 取严行为不变·`_rankSafeLow`
safe/low 资格不变·叶子源码含注释无 require 调用语法），全绿。延续战役纪律：每一刀须 SCC 算法证真降债
（非改 gate / 非分裂改标号）、语义可逆边、可运行测试行为锁，且绝不冒进重构纠缠未测核心。

### 6.7 解耦战役第五刀：telemetry→serviceRegistry 查询倒置 + 扫描器拆分感知，巨型 SCC 59→39

第五刀拆的是**最高杠杆的单出边**：`telemetryService` 唯一入 SCC 的边 = `telemetryService→serviceRegistry`，
仅在 `getUnifiedStats()` 里**惰性 require 拉 `registry.stats()`**（一处尽力查询·try/catch·"non-critical"）。
而 `serviceRegistry` 位居编排簇（toolUseLoop/AgentTool/harness）之首，这条尽力查询边把 telemetry 整片
拽进巨环。**provider sink 查询倒置**（增量10 emission sink 的查询变体）：新零依赖叶子
`serviceStatsSink.js`（`setServiceStatsProvider(fn)`/`getServiceStats()`），`serviceRegistry` 加载时
`_autoRegister()` 后追加一行把自己的 `stats` 登记为 provider，telemetry 改经 `getServiceStats()` 读、不再
import registry。语义逐字保持：原本就 best-effort（registry 不可用即跳过），缺 provider→`undefined`→
telemetry 留 `stats.services` 未设=原 try/catch 不可用路径同果；真实会话 serviceRegistry 被 bootstrap
eager-load 故恒已注册。端到端实测 `stats.services={total:30,...}` 经 sink 正常落位。

**关键副作用——这是战役首次把巨环「拆分」而非「detach」**：割边后巨环 **59→39**，另**分裂出一个 6 节点片段**
（serviceRegistry/toolUseLoop/AgentTool/teammateBus/agenticHarness/baseSelfCheck——编排核心，其内部环本就既存、
本刀一字未动），另有 14 个节点完全脱环成 DAG。总在环节点 59→**45**（真实净降 14）。但这暴露 `analyzeCycleDrift`
一个**真实正确性缺陷**：它按 `overlap/baseSize` 判定，小片段占大基线比例极低（6/74=0.08<0.5）会被误判
`kind:'new'`→HARD→**RED**——即**正确的解耦拆分反被误报为阻断性新环**，恰好惩罚维护者的进度（解大环的常态结局
就是拆成小片段）。**诚实修正而非洗绿**：补**包含判据**——片段成员全部 ∈ 某基线环（`bestOverlap===curSize`·零新成员）
即归 drift（既存债被拆开），**真正的新环必含基线外成员**（`bestOverlap<curSize`）仍走 new，新环检出力一字未减。
配套 `_attributeCycles` **拆分感知归并**：同 `baseSize` 的多片段归并为一条诚实叙述「74→拆分为[39+6]（累计在环 45·
已净解开 29 个节点）」，杜绝逐片段各报「净解开」的双重计数夸大；单片段保持 §6.5 方向感知叙述（back-compat）。
实测 live 驾驶舱 yellow·ok:true「…解环 campaign 进行中 74→拆分为[39+6]（累计在环 45·已净解开 29 个节点·持续收敛）」。
新增/扩展可运行测试：`serviceStatsSink.test.js` 6 例（缺 provider→undefined·注册透传·抛错被吞·非函数清空·registry
加载即自注册·叶子源码无 require）、`archDebtScan.cycleDrift.test.js` 6→**9 例**（+完全包含片段→drift·巨环拆两片段皆 drift·
含基线外成员仍走阈值判 new）、`maintainerCockpit.test.js` 31→**32 例**（+拆分归并一条诚实叙述·不双重计数）。
这一刀**结构降债**（telemetry 脱环·总在环 59→45）与**扫描器拆分感知**（同 §6.5 诚实性类目，否则后续每次拆分都假 RED
惩罚进度）耦合落地——因为这是战役首次触发巨环拆分。gate 仍对真正新环/失控膨胀一律 RED，未削弱。

### 6.8 解耦战役第六刀：采样策略纯函数下沉（一刀切两边）SCC 39→37 + 扫描器 containment 度量诚实化

第六刀回到**纯函数下沉式**（§6.2/§6.3 同型，零 eager-load 顾虑）。单出边检测在巨环里扫到
`ollamaAdapter` 与 `localLLMAdapter` **各仅一条入 SCC 出边** = `→khyUpgradeRuntime`，且二者**只借**
`lockTemperature`/`lockTopP` 两个采样锁（`runtime.lockTemperature(sourceText)`/`runtime.lockTopP()`）；
而 `khyUpgradeRuntime` 是 1900 行升级运行时巨枢，把两个本应轻量的适配器拽进巨环。这两个锁 + 其内部
助手 `isCreativeRequest` 是**纯函数零依赖零状态**（`lockTemperature` = 创意请求正则→0.3/否则 0.1，
`lockTopP` 恒 0.85），与升级运行时毫无耦合理由。整簇逐字下沉为零依赖叶子 `samplingPolicy.js`，
`khyUpgradeRuntime` 改 `require('./samplingPolicy')` 并保留 `lockTemperature`/`lockTopP` 导出（导出面逐字不变），
两适配器改 `require('../../samplingPolicy')`。**一刀切两边**：`ollamaAdapter`+`localLLMAdapter` 同时脱离，
巨环 **39→37**、总在环 45→43，frags 2→2（Tarjan 实证**零新子环**·干净 detach）。叶子注释刻意不写 require
调用语法 + 源码级断言钉死（防扫描器幽灵边，§6.2 同坑）。

**配套——扫描器 containment 度量诚实化（第二次 §6.7 类诚实修正，这次彻底）**：本刀首次暴露 §6.7
`fullyContained`（`overlap===curSize`）判据**过严**的真实缺陷。收缩后的巨环片段=37 节点，其中 **36 个 ∈ 基线-74**、
仅 1 个既存 accretion（`planModeService`，增量7 早已承认漂入），但 `ratio=overlap/baseSize=36/74=0.486`
恰跌破 0.5 阈值，且因那 1 个 accretion 使 `fullyContained` 不成立→**误判 `kind:'new'`→RED**——又一次把正确降债
反误报为阻断性新环。根因：`overlap/baseSize` 度量「当前环还占基线多少」，随解耦推进 curSize 下降而**必然走低**，
方向与「这是不是既存债收缩」相反。**正解=按 containment** `overlap/curSize`（当前环里有多少比例来自基线）判定：
37 节点里 36 个来自基线 = `36/37=0.97`，显属既存债收缩，drift 无疑；真正新环含极少/零基线成员、containment 低、仍走 new。
故把 `fullyContained` 一般化为 `containment >= containmentThreshold`（默认 0.5·env `KHY_ARCH_CYCLE_CONTAINMENT_RATIO`·
完全包含 1.0 是其特例），新环检出力一字未减（cur `['a','x','y']` containment 1/3<0.5 仍 new）。修后 live 驾驶舱
yellow·ok:true「…解环 campaign 进行中 74→拆分为[37+6]（累计在环 43·已净解开 31 个节点·持续收敛）」。
新增可运行测试：`samplingPolicy.test.js` 5 例（lockTopP 恒 0.85·creative 0.3/非 0.1·isCreativeRequest 中英命中与空安全·
runtime 经叶子 re-export 行为逐字不变·叶子源码含注释无 require）、`archDebtScan.cycleDrift.test.js` 9→**11 例**
（+收缩片段多数来自基线含个别 accretion→drift·containment 阈值 env 收紧改边界）。**六刀四式不变**，本刀同时把
扫描器从「越解耦越容易假 RED」彻底校正为按 containment 诚实判定。

### 6.9 解耦战役第七刀：回执计数依赖倒置，**整条** 2 节点独立环消解（非巨环切片）

前六刀都在**收缩同一个巨型 SCC**；本刀首次**整条消解一个独立的小环**。`buildRequireGraph` + Tarjan
除巨环外另报一个 2 节点 SCC：`agentFsService ⇄ receiptService`。核其两条边均为**惰性 inline require**：
`receiptService.startReceipt → agentFsService.getActiveAgentId`（取活跃 companion 指针）与
`agentFsService.describeAssets → receiptService.listReceipts`（数「回执」这个**外部资产**的条数）。
扫描器按行匹配 `require(`、不剔注释亦**不区分惰性/顶层**（§6.2 同坑），故两条惰性边照样成环。

`getActiveAgentId` 深耦 `getAgentsRoot`/`_agentDir`/`_hasManifest`/`ID_RE`（agentFsService 内用 6/11/9/4 次），
抽它一侧风险大；而另一侧 `describeAssets` 的回执计数本就是**外部资产**（代码注释自述 external），且
`describeAssets` 全仓**仅一处调用**（`cli/handlers/companion.js` 的 `assets` 视图，该 handler **本就**已
`require` receiptService）。故取**依赖倒置**：`describeAssets(id, opts)` 不再侧向 `require('../receiptService')`，
改由调用方经 `opts.countReceipts(companionId)` 注入计数器；缺省/注入抛错均降级为 0（保留原 catch→0 语义）。
agentFsService 侧 `require('../receiptService')` 字面**彻底消失**，2 节点环随之解体——只需断一条边即可消环
（A⇄B 去任一向即破）。

- **结果**：driftCount **3→2**（live 驾驶舱 `[32+6+2]→[32+6]`、累计在环 40→38、已净解开 34→**36**），
  零新增分层倒置/巨石/真环。这是**消除整条环**而非巨环切片——巨环（32）与 6 节点环原样保留待后续刀。
- **行为锁定**：agentFsService 原**无**可运行单测，故新增 `agentFsDescribeAssets.test.js`（node:test，4 例）：
  注入计数器原样透出（`count/present/summary`）· 无注入器→0 读空 · 注入器抛错→0（回执可选）·
  **源码级断言** agentFsService 不得再 `require('../receiptService')`（把消环钉成回归门，§6.2 防幽灵边同法）。
  receiptService Jest 5 例 + 驾驶舱/coherence/cycleDrift/降债锁共 85 例 node:test 全绿。

### 6.10 解耦战役第八刀：文本启发式纯函数下沉，巨型 SCC 32→31（回到巨环收缩）

§6.9 消解的是独立小环；本刀回到**收缩巨型 SCC**，沿用 §6.2/§6.3/§6.8 的纯函数下沉式。
`buildRequireGraph` + Tarjan 的单出边检测在 32 节点巨环里扫到 `inputSanitizer` **唯一一条**入 SCC
出边 = `→khyUpgradeRuntime`，且其用途仅借一个函数：`estimateTokens`（token 估算，优先 `contextWasm`、
退化 `len/4`）。`khyUpgradeRuntime` 是 1900 行升级运行时巨枢，把本应轻量的输入清洗器拽进巨环。

`estimateTokens` 连同 `_isGreeting`（统一问候识别，中英穷举集）本是**纯函数、零状态、领域无关**的
文本启发式，依附在升级运行时上纯属历史——后者注释里 `_GREETING_EXACT` 自述「全仓问候识别单一真源」，
更印证其领域中立。故整簇下沉为零依赖叶子 `services/textHeuristics.js`，`khyUpgradeRuntime` 改
`require('./textHeuristics')` 并保留 `estimateTokens`/`isGreeting` 导出（导出面逐字不变）；
三个纯函数借用方 `inputSanitizer`/`localBrainService`/`inputPreprocessor` 改依赖叶子。

- **结果**：巨型 SCC **32→31**（`inputSanitizer` 干净脱离·`textHeuristics` 为叶子不入环），
  总在环 38→37、frags `[32+6]→[31+6]`；`computeNew` 实测 `layering 0·godFiles 0·new genuine cycles 0`
  （仅余的两「环」即缩小后的既存 SCC + 6 节点编排环）。真实结构降债，非改 gate。
- **行为锁定**：新增可运行 `textHeuristics.test.js`（node:test，6 例）：estimateTokens 空→0/非空正整数·
  isGreeting 中英命中与代码/路径/超长拒绝·`khyUpgradeRuntime` re-export 与叶子逐字等价·
  **源码级断言**叶子除可选 `contextWasm` 外无 SCC 内 require（幽灵边守护，§6.2 同法）。
  `inputSanitizer` 42 例 node:test 全绿。
- **踩坑**：`contextWasm`（estimateTokens 的真实委托）在 SCC **之外**，故叶子保留对它的真实 require
  不重新成环；但其它借用方的注释里**刻意不书写 require-调用样式**，避免扫描器把注释当幽灵边（§6.2 坑）。

### 6.11 解耦战役第九刀：计划只读标志查询倒置，巨型 SCC 31→29（致密核首切，sink 注册表式）

§6.10 后巨环收缩到 31 节点，进入**致密核**——逐边杠杆扫描（移除单边后重算 Tarjan）显示已无
≥2 的纯函数式可割边，唯二高杠杆边 `toolCalling→workerAgent`(16)/`workerAgent→ai`(14) 皆为
**真实运行时委托**（实际 spawn worker / 真发起 chat），按 §6.2 纪律**严禁**强行倒置——把活边藏进
注册表只会留住全部运行耦合、徒然骗过扫描器。诚实的可割边是 `toolCalling→planModeService`(杠杆 2)：
工具漏斗每次执行前查一次「计划只读窗口」（EnterPlanMode 已声明、用户未批准），调 `isPlanReadOnly()`——
这是**只读状态查询**（`_state==='generating'||'reviewing'` 布尔），best-effort try/catch，与 §6.7
`telemetry→serviceRegistry.stats()` 先例同构。关键安全前提：provider（planModeService）由**独立的
急加载路径**——`EnterPlanModeTool`/`ExitPlanModeTool`（经 tools 扫描表加载、必先 require 计划服务）——
在只读标志可能为真之前必已登记，故 sink 未登记时返回 `false` 恰复现「无活动计划」，**零静默回归**
（这正是 §6.10 排除的 selfProfile/expandModel 候选所缺的——它们唯一加载者就是消费方自身）。

故沿用 §6.4/§6.7 sink 注册表式倒置：新增零依赖叶子 `services/planModeSink.js`（`setPlanReadOnlyProvider`/
`isPlanReadOnly`，未登记或 provider 抛错→`false`，只认严格 `true`）；planModeService 加载即
`setPlanReadOnlyProvider(isPlanReadOnly)` 自注册（导出面逐字不变）；toolCalling 改经叶子读，
不再 `require('./planModeService')`。

- **结果**：巨型 SCC **31→29**（planModeService + goalModeService 双双脱离·planModeSink 叶子不入环），
  frags `[31+6]→[29+6]`；`computeNew` 实测 `layering 0·godFiles 0·new genuine cycles 0`（两「环」
  即缩小后既存 SCC 29 + 6 节点编排环，二者成员**全在基线 74-SCC 内**，纯指纹漂移，非新债）。
  `analyzeCycleDrift` 判 drift（29≪74，§6.1 既存收缩）。真实结构降债，非改 gate。
- **行为锁定**：新增可运行 `planModeSink.test.js`（node:test，8 例）：无 provider→false·登记后透传布尔·
  非 true 真值归一为 false·provider 抛错被吞→false·非函数清空·**planModeService 加载即自注册的
  golden parity**·**源码级断言** toolCalling 不再 require planModeService·叶子源码含注释无 require 调用语法。
  既有 `toolCalling.planReadOnly.test.js`（P4 硬只读 gate 5 例）改在**新 sink seam** 打桩（即生产读路径，
  原先替换 `planModeService.isPlanReadOnly` 导出的旧打桩法已被新接缝绕过，迁移后全绿）。
- **踩坑**：① sink 捕获的是 planModeService **加载时**的函数引用，故测试若替换其**导出**无法生效——
  必须在 sink seam 打桩（这正是断边的证据，亦是 §6.11 锁测的核心断言）。② `enterPlanMode` 是 async 且
  会发起 AI 调用，**不可**在单测里直接调来制造只读态；golden parity 改用确定性 idle 路径 + provider 覆写验证
  真值贯通。③ 叶子注释**刻意不书写 require-调用样式**，防扫描器幽灵边（§6.2 坑）。

## 七、关键文件

- `services/backend/src/services/maintainerCockpit.js` — 纯编排 + 四检查（依赖注入、fail-soft）
- `services/backend/src/cli/handlers/maintain.js` — 渲染驾驶舱 + audit 明细，red 退码 1
- `services/backend/src/cli/router.js` — `case 'maintain'` 按子命令分流 metadata vs 驾驶舱
- `services/backend/src/constants/commandSchema.js` — maintain 子命令 + `/maintain` slash
- `services/backend/src/cli/aliases.js` — 移除 maintain 别名（解除劫持）
- `services/backend/tests/services/maintainerCockpit.test.js` — 32 例（裁决/优先级/fail-soft/接线不变量/自愈感知/巨石点名·归因/巨石预警预防面/环漂移分类 drift→yellow·new→red·失控→red·容差env·back-compat·**方向感知净降债叙述 §6.5**·**拆分归并诚实叙述不双重计数 §6.7**）
- `services/backend/scripts/archDebtScan.js` — `analyzeCycleDrift`（纯函数：既存 SCC 漂移 vs 真正新独立环还原，重叠率阈值 + **containment 度量判据 §6.8**，`ratioEnv` 浮点阈值助手）
- `services/backend/tests/services/archDebtScan.cycleDrift.test.js` — 11 例 node:test（子集→超集 drift·零重叠 new·指纹未变排除·低重叠判 new·识别移除成员·空基线不抛·完全包含片段→drift·巨环拆两片段皆 drift·含基线外成员仍判 new·**收缩片段多数来自基线含个别 accretion→drift·containment 阈值 env 收紧改边界 §6.8**）
- `services/backend/src/services/localBrainCalc.js` — 抽出的计算子能力（降巨石，纯离线确定性）
- `services/backend/tests/services/localBrainCalc.test.js` — 7 例 node:test（安全求值/注入拒绝/端到端 calc 路径）
- `services/backend/src/services/gateway/windsurfProtobuf.js` — 抽出的 Windsurf protobuf 线编码原语（纯函数降巨石，退役巨石债类）
- `services/backend/tests/services/windsurfProtobuf.test.js` — 7 例 node:test（golden 字节向量/编码器不去重契约/宿主 require 不破）
- `services/backend/src/services/searchTokenizer.js` — **新**：下沉的 CJK/ASCII 检索分词器叶子（依赖倒置解开 learningRetrieval→knowledgeTeachingService 边，巨型 SCC 82→79，§6.2）
- `services/backend/tests/services/searchTokenizer.test.js` — 7 例 node:test（与原内联逐字等价 golden·去重·空/非串不抛·两侧导出一致·叶子源码含注释不得出现 require 调用语法）
- `services/backend/src/services/knowledgeTeachingService.js` — `_searchTokenize` 转引叶子（对外 `tokenizeForSearch` 导出与内部调用点逐字不变）
- `services/backend/src/services/learningRetrieval.js` — 分词改依赖叶子 `searchTokenizer`（脱离 SCC，保留本地兜底）
- `services/backend/src/constants/systemPromptBoundary.js` — **新**：下沉的动态边界标记常量 + split/strip 纯函数叶子（依赖倒置解开 `_messageBuilder→prompts` 边，巨型 SCC 79→77，§6.3）
- `services/backend/tests/services/systemPromptBoundary.test.js` — 6 例 node:test（strip/split 逐字等价 golden·幂等·非串安全兜底·叶子源码无 require 调用语法·prompts.js re-export 三绑定一致 + assemble 仍滤 marker）
- `services/backend/src/constants/prompts.js` — 边界三件 re-export 自叶子（导出面与内部使用逐字不变）
- `services/backend/src/services/gateway/adapters/{_messageBuilder,_protocolPipeline,claudeAdapter}.js` — 边界函数借用改指零依赖叶子（`_messageBuilder` 脱离 SCC）
- `services/backend/src/services/gateway/_streamHealthSink.js` — **新**：流健康遥测 sink 注册表零依赖叶子（依赖倒置解开 `_streamStaleDetector→telemetryService` 上探边，巨型 SCC 77→63·首次低于基线 74，§6.4）
- `services/backend/tests/services/streamHealthSink.test.js` — 7 例 node:test（注册前 no-op·注册后透传·sink 抛错被吞·非函数清空·telemetry 加载即自注册·detector.stop 经 sink 发射·叶子源码无 require 调用语法）
- `services/backend/src/services/gateway/adapters/_streamStaleDetector.js` — `stop()` 改 `emitStreamHealth` 发射，不再上探 telemetry 单例（脱离 SCC）
- `services/backend/src/services/telemetryService.js` — 加载即 `setStreamHealthSink(trackServiceCall)` 自注册为 sink（一行注册，依赖方向反转）
- `services/backend/src/constants/riskOrder.js` — **新**：风险等级序数表单一真源零依赖叶子（四方去重 + 借用倒置切断 `approvalLedger→riskGate` 边，巨型 SCC 63→59，§6.6）
- `services/backend/tests/services/riskOrder.test.js` — 6 例 node:test（golden 逐字等价·`Object.freeze` 冻结·四再导出模块共享同一引用证去重·maxRisk 取严行为不变·`_rankSafeLow` safe/low 资格不变·叶子源码含注释无 require 调用语法）
- `services/backend/src/services/{riskGate,commandRiskClassifier,shellToToolMapper,receiptService}.js` — 序数表内联常量改 `require('../constants/riskOrder')`（前三者 re-export 保持对外 `RISK_ORDER` 导出面逐字不变）
- `services/backend/src/services/approvalLedger.js` — `_rankSafeLow` 借用从 `./riskGate` 改指零依赖叶子（脱离 SCC，保留 try/catch 本地兜底）
- `services/backend/src/services/serviceStatsSink.js` — **新**：service-registry stats 的 provider sink 零依赖叶子（查询倒置切断 `telemetryService→serviceRegistry` 边，巨型 SCC 59→39 + 拆出 6 节点既存编排片段·总在环 59→45，§6.7）
- `services/backend/tests/services/serviceStatsSink.test.js` — 6 例 node:test（缺 provider→undefined best-effort·注册透传·provider 抛错被吞→undefined·非函数清空·serviceRegistry 加载即自注册读到 {total,loaded,errored} 形状·叶子源码含注释无 require 调用语法）
- `services/backend/src/services/serviceRegistry.js` — 加载 `_autoRegister()` 后追加一行 `setServiceStatsProvider(stats)` 自注册（依赖方向反转，registry 不再被 telemetry import）
- `services/backend/src/services/telemetryService.js` — `getUnifiedStats()` 改经 `serviceStatsSink.getServiceStats()` 读 registry 统计（原 best-effort try/catch 语义逐字保持，缺 provider→stats.services 未设=原不可用路径同果）
- `services/backend/src/services/samplingPolicy.js` — **新**：采样策略零依赖叶子（`isCreativeRequest`/`lockTemperature`/`lockTopP` 纯函数，从 khyUpgradeRuntime 整簇下沉，一刀切 ollamaAdapter+localLLMAdapter 两条 `→khyUpgradeRuntime` 边，巨型 SCC 39→37·总在环 45→43，§6.8）
- `services/backend/tests/services/samplingPolicy.test.js` — 5 例 node:test（lockTopP 恒 0.85·creative 0.3/非 0.1·isCreativeRequest 中英命中与空安全·runtime 经叶子 re-export 行为逐字不变·叶子源码含注释无 require 调用语法）
- `services/backend/src/services/khyUpgradeRuntime.js` — 采样三函数改 `require('./samplingPolicy')` 并保留 `lockTemperature`/`lockTopP` 导出（导出面逐字不变）
- `services/backend/src/services/gateway/adapters/{ollamaAdapter,localLLMAdapter}.js` — 采样锁借用从 `khyUpgradeRuntime` 改指零依赖叶子 `samplingPolicy`（双双脱离 SCC）
- `services/backend/src/services/agentFs/agentFsService.js` — `describeAssets(id, opts)` 回执计数改注入 `opts.countReceipts`（不再 `require('../receiptService')`），整条 2 节点独立环消解（§6.9）
- `services/backend/src/cli/handlers/companion.js` — `assets` 视图注入 receiptService 计数器给 `describeAssets`（依赖方向反转，调用方本就持 receiptService）
- `services/backend/tests/services/agentFsDescribeAssets.test.js` — 4 例 node:test（注入计数器原样透出·无注入器→0·注入器抛错→0·**源码级断言** agentFsService 不得再 require receiptService）
- `services/backend/src/services/textHeuristics.js` — **新**：文本启发式零依赖叶子（`estimateTokens`/`isGreeting` 纯函数 + `GREETING_EXACT` 单一真源，从 khyUpgradeRuntime 整簇下沉，切断 `inputSanitizer→khyUpgradeRuntime` 边，巨型 SCC 32→31，§6.10）
- `services/backend/tests/services/textHeuristics.test.js` — 6 例 node:test（estimateTokens 空→0/非空正整数·isGreeting 中英命中与代码/路径/超长拒绝·runtime re-export 逐字等价·源码级断言叶子除 contextWasm 外无 SCC 内 require）
- `services/backend/src/services/khyUpgradeRuntime.js` — `estimateTokens`/`_isGreeting` 转引叶子 `textHeuristics`（导出 `estimateTokens`/`isGreeting` 逐字不变；§6.8 采样三函数亦经 samplingPolicy 同法）
- `services/backend/src/services/{inputSanitizer,localBrainService,inputPreprocessor}.js` — 文本启发式借用改指零依赖叶子 `textHeuristics`（`inputSanitizer` 脱离 SCC，另两者本就在 SCC 外、改指为单一真源一致性）
- `services/backend/src/services/planModeSink.js` — **新**：计划只读标志的 provider sink 零依赖叶子（只读查询倒置切断 `toolCalling→planModeService` 边，巨型 SCC 31→29·致密核首切·planModeService+goalModeService 双双脱离·总在环 37→35，§6.11）
- `services/backend/tests/services/planModeSink.test.js` — 8 例 node:test（无 provider→false·登记后透传布尔·非 true 真值归一为 false·provider 抛错被吞→false·非函数清空·planModeService 加载即自注册 golden parity·源码级断言 toolCalling 不再 require planModeService·叶子源码含注释无 require 调用语法）
- `services/backend/src/services/planModeService.js` — 加载即 `setPlanReadOnlyProvider(isPlanReadOnly)` 自注册（依赖方向反转，导出面逐字不变；provider 由 EnterPlanModeTool/ExitPlanModeTool 急加载路径保证只读窗口可能为真前必已登记）
- `services/backend/src/services/toolCalling.js` — P4 计划只读 gate 改经 `planModeSink.isPlanReadOnly()` 读，不再 `require('./planModeService')`（脱离巨环，未登记→false 复现「无活动计划」语义逐字保持）
- `services/backend/tests/toolCalling.planReadOnly.test.js` — P4 硬只读 gate 5 例改在 sink seam 打桩（即生产读路径，旧法替换导出已被新接缝绕过）
