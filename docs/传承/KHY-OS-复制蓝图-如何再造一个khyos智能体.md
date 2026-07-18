# Khy-OS 复制蓝图 · 如何从零再造一个 khyos 式智能体

> 写给未来的 khyos（一个 AI 智能体）。
>
> 如果有一天有人对你说「照着 khyos 的路子，再造一个类似 khyos 的智能体」，
> 这份文档就是你的作战地图。它不是「khyos 有哪些功能」的目录，而是把
> **khyos 是怎么被一刀一刀开发出来的**这条真实轨迹提炼成可复用的方法论 +
> 可照抄的脚手架 + 分阶段的自举剧本。
>
> 姊妹篇 `KHY-OS-传承书.md` 讲**如何维护**一个已存在的 khyos;本篇讲**如何创造**
> 一个新的 khyos。前者是生存,后者是繁衍。
>
> 一句话宗旨:**把「强模型的开发纪律」固化成代码与流程,让任何一个后继智能体
> 都能沿着同一套护栏,把一个类似 khyos 的系统安全地、可验证地、一刀一刀地造出来。**
>
> 本蓝图的每一条论断都锚定仓库里真实存在的文件/命令(已逐条核实)。凡引用记忆,
> 指的是本项目开发轨迹沉淀的 `~/.claude/projects/.../memory/*.md`——它们**就是**这条
> Claude 开发轨迹的蒸馏。

---

## 0. 三十秒速览:一个 khyos 式智能体由什么构成、靠什么造出来

**它是什么(五层制品)**

| 层 | 语言 | 位置 | 职责 |
| --- | --- | --- | --- |
| Python 启动器 | Python ≥3.8 | `platform/khy_platform/cli.py` | 薄壳:检查 Node≥20 → 定位 `bin/khy.js` → `subprocess` 拉起 |
| Node 后端(主体) | Node ≥20 | `services/backend/` | CLI / Ink TUI / Agent loop / 16 路 AI 网关 / HTTP·WS 全在此 |
| C 内核 | C + NASM | `kernel/` | 手写 x86_64 内核,QEMU 可引导,ELF 加载/调度/分页/IPC/fork |
| MoonBit WASM | MoonBit | `kernel/src` `kernel/moonbit/` | 内核内经 `moonbit_kernel_run()` 调用 |
| Host 桥 | Node(零依赖) | `kernel/bridge/` | Agent⇄OS 缝,COM2 unix socket + COBS/CRC16 帧,MCP stdio server |

数据路径:khy CLI/TUI/agent loop → AI 网关(多适配器+故障切换)→ Node 后端(工具/工作流/服务)→ khy 内核。经两条渠道发布同一个「车间」:`pip install khy-os` 与 `npm i -g @khy-os/khy-os`。

**它靠什么造出来(一句话方法论,后面逐条展开)**

> 把每个能力拆成**纯零 IO、fail-soft、确定性的叶子** + **只做 IO 的薄壳**;每次改动藏在
> **默认开的 `KHY_*` 门控**后,关掉即**逐字节回退**旧行为;守一个 **SSOT**,把所有发布副本
> **cmp 到字节一致**;把每条架构契约写成**零误报的 pre-commit 守卫**(假想维护者是更弱的模型);
> 主要按**「底座是活的、某个面没接线」**的镜头找 bug;失败姿态按后果匹配(显示层 fail-soft、
> 可用性层 fail-open、审批层 fail-closed);能力放进**测试过、发布出去的代码**而非记忆;
> 每次只发**一刀完全验证过、留在分支未提交**的改动,以固定的验证仪式收尾。

---

## Part A · 先看清目标:一个 khyos 式智能体的架构骨架

复制之前先理解「成品长什么样」。以下全部来自 `.ai/` 种子文档(权威、机器可确定性刷新)。

### A.1 入口点与启动链

- **CLI 二进制**:`services/backend/bin/khy.js`(注册三个 bin 名 `khy`/`khy-os`/`khyquant`)。`khy`=OS 模式,`khy ai`=AI REPL。
- **路由**:`services/backend/src/cli/router.js`(一个大 switch 分发)。
- **HTTP 服务**:`services/backend/server.js`(Express + WS);独立 AI 后端 `services/ai-backend/server.js`。
- **Python 启动器**:`platform/khy_platform/cli.py`——检查 Node≥20 → 定位 `bin/khy.js` → `subprocess [node, bin/khy.js, *args]`。
- **内核引导**:`kernel/boot/boot.asm:_start`(Multiboot2)→ long mode → `kernel/src/main.c:kernel_main` → 25 步有序初始化(serial→vga→pmm→kheap→pic→idt→**gdt(在 idt 之后)**→sched→process→syscall→ipc→cap→ramfs→ata→persist→net→agentbus→fb→wm→`moonbit_kernel_run()`→建任务→`sti`→抢占→idle)。

### A.2 目录职责(顶层)

- `kernel/` 手写内核 + `kernel/bridge/` 主机桥(零依赖)。
- `services/backend/` 业务主体;`services/ai-backend/` 独立 AI 后端;`apps/ai-frontend/` 前端。
- `platform/khy_platform/` Python 启动器 + `app_protocol.py`(生态接入契约单一真源);`platform/packages/` JS workspaces。
- `software/khyquant/` 首款生态应用(与底座物理隔离)。
- `scripts/` 构建/CI/发布/安装;`packaging/npm/` npm 打包;`docs/` 生命周期编号文档;`maintenance/` 双击维护入口;`.ai/` 导航三件套;`.githooks/` 提交门禁。
- **运行时目录(不进版本库、按需生成)**:`~/.khyos/`(底座数据主权根)、`~/.khy`(应用数据家)等。

### A.3 生态数据主权(底座 vs 应用的红线)

`platform/khy_platform/app_protocol.py` 是单一真源,底座对应用**零 import 依赖**:
- 底座拥有 `~/.khyos/{data,cache,models,logs}`;应用拥有 `~/.<app>/...`;互不读写对方目录;跨域数据走公共 API 而非直连 SQL。`app_home(name)` 做路径穿越清洗。
- **发现 vs 激活**(轻注册/重初始化):`discover_apps()` 只读 entry_points + `~/.khyos/apps/*.json` 元数据——**零 import、零实例化**;`load_app(name)` 才 `ep.load()`(重、失败优雅返回 None,底座绝不崩)。

**复制要点**:先定「底座/应用」边界与数据主权红线,再写第一行业务代码。数据家解析必须**只此一处**(khyos 里是 `services/backend/src/utils/dataHome.js`),否则 module-load 期 `const X = resolver()` 会造成 split-brain(见记忆 `project_admin_user_data_timely_sync_lazy_apphome`)。

---

## Part B · 核心:khyos 的开发方法论(11 个模式家族)

这是本蓝图的心脏。以下 11 个家族从 512 篇开发记忆里反复浮现——它们**就是**让这个项目
在「一个人 + AI」条件下不腐坏的操作纪律。每条给:模式、为什么有效、证据记忆、可复用规则。

### B.1 刀(cut)方法论:每次只发一个原子且完全验证的改动

- **模式**:工作拆成「刀」——交付一个诚实能力的最小端到端改动。每刀编号(刀79→刀117 成链)、自带测试、自带门控、自带验证仪式,并显式记为**「未提交未发布(feat/x.y.z)」**——实现并验证完,但留在分支,由人来做提交闸。
- **为什么有效**:小而全验的单元使得后来一个较弱的模型无法把半成品抹遍全树;每刀独立可回退、独立可证。链式刀(一个特性跨面分片交付)把大特性变成一串各自安全的小切片,而非一次高风险巨改。
- **证据**:`project_code_laziness_methodology`(懒惰资深工程师阶梯:YAGNI→复用→stdlib→一行→才写最小代码)、`project_interruption_marker_esc_ssot`(刀105/106/107 跨三面且显式记录**诚实延后**的余量)、`project_source_self_heal_engine_manifest_targeted`(Cut 1/2/3 分阶段)。
- **规则**:发能证真且完全验证的最小切片。编号、门控、测试,然后停手、留未提交待人审。绝不捆绑无关改动;绝不把某个面半接线后不声明就走人。

### B.2 纯叶子 + 薄 IO 壳

- **模式**:每个能力拆成**纯叶子**(零 IO、确定性、fail-soft、绝不抛、返回纯数据)+ **薄壳**(所有 IO,把依赖**注入**叶子,inject-don't-require)。渲染/着色留在壳,叶子返回未着色的字符串/结构,以便脱离 chalk/ink 单测。
- **为什么有效**:叶子可平凡单测,且不可能崩(fail-soft→坏输入返回 `[]`/`null`/legacy);把 IO 与时钟留在壳使叶子确定、可移植;inject-don't-require 使叶子无依赖,可放进 bundled 树而不拖进 ink/fs。这是门控+字节一致+四树保证得以成立的底座。
- **证据**:`project_leaf_contract_guard`(正式定义:零IO/env门控/fail-soft)、`project_qa_answer_echo_classic_repl_twin`(纯叶子返明文+调用方着色=可测性与视觉兼得)、`project_status_command_model_account_ssot`。
- **规则**:决策逻辑全进零 IO、绝不抛、确定性、返回纯数据的叶子;fs/网络/时钟/spawn/渲染全进薄壳并注入格式化器。叶子若需依赖,注入它——别 require。

### B.3 `KHY_*` 门控默认开 + 关掉即字节回退

- **模式**:每个行为改动藏在**默认开**的 `KHY_*` 门控后,仅 `{0,false,off,no}` 关。关掉时代码路径必须与刀前行为**逐字节一致**。两种门控形态:*条件字段*(关→省略键)vs *透传字段*(关→保留键、还原默认值)。
- **为什么有效**:默认开把改进发给所有人;严格的 `{0,false,off,no}` 词汇是共享约定使门控可预测;字节一致保证使每个改动无需重新部署即可在运行时可证地瞬时回退——这是当较弱模型或坏交互需要即刻回滚时的终极安全网,也给验证一个具体锚点。
- **证据**:`project_leaf_contract_guard`、`project_status_line_session_id_ssot` + `project_status_line_transcript_path_ssot`(两种形态)、`project_env_info_twins_superset_ssot`(两个孪生互非超集时需总开关)。
- **规则**:每个改动用默认开的 `KHY_*` 门控,仅 `{0,false,off,no}` 关;保证关态与旧行为字节一致;按字段先前是否存在决定门控形态(省略键 vs 还原默认)。

### B.4 三守卫(把「差距」写成代码的差分门禁)

- **模式**:三个 pre-commit 守卫脚本把散文承诺机械化:**check-leaf-contract**(自声明叶子里不得有 IO / 不得删门控 / 不得残留 VCS 冲突标记)、**check-model-hardcoding**(不得硬编码模型字面量)、**check-agent-rules**(通用反模式:裸端点/生产域名/不透明状态/硬超时 kill/滚动区)。经 `check:small-model:safety` 串进 pre-commit。
- **为什么有效**:目标明言——「你是最强的模型;维护 khyos 的更弱模型会让它退化——把差距编码成代码让他们尽早被拦」。散文契约只活在强模型脑中;守卫把它变确定性门禁。零误报是设计地板(邻接启发、剥注释状态机),使守卫被信任而非被静音。
- **证据**:`project_leaf_contract_guard`(三规则、`KHY_LEAF_CONTRACT_GUARD`、自扫描净)、`project_pip_conflict_marker_kernel_build`(它前置化的事故:脏冲突标记打进 wheel→远端构建爆炸)、`project_tool_capability_live_probe`。
- **规则**:把每条架构契约变成零误报的机器检查并接进 pre-commit;假想更弱的未来维护者,让守卫在具体退化发出前抓住它。

### B.5 四树字节一致(SSOT src + 3 bundled 树)

- **模式**:`services/backend/src` 是唯一真源;三份 bundled 副本(`packaging/npm/bundled/...`、`build/lib/khy_os/bundled/...`、`platform/khy_os/bundled/...`)须字节一致。每刀验 **四树 cmp FAIL=0** + 跨四树 `require` 探针。**绝不手改 bundled 树**;新叶子文件需 wheel/npm 重建,记忆须诚实记「editable 即生效」vs「在 wheel 须重建」。生成方向单向:`setup.py:BuildWithBundle` → pip bundle → `packaging/npm/scripts/assemble.js` 复用 pip bundle → npm bundle。
- **为什么有效**:dev 树能跑但发布 wheel 悄悄漂移是经典 split-brain。cmp 机械抓漂移;「editable vs须重建」诚实防假绿(作者只测了 canonical 树而用户跑陈旧 bundled)。bundled 缺 `require('./ccFormat')` → legacy 回退而非崩,使分阶段发布安全。
- **证据**:`project_cc_format_ssot_alignment`(bundled 须随之重建·绝不手改·缺失优雅回退)、`project_source_self_heal_engine_manifest_targeted`(apply:true 探针打真 bundled 树误还原 119 文件的血教训)、`project_admin_user_data_timely_sync_lazy_apphome`。
- **规则**:守一个 SSOT,每改机械 cmp 所有发布副本到字节一致;绝不手改生成副本;明说改动是 live-on-edit 还是须重建;bundled 缺文件优雅降级。

### B.6 「half-wired」检测 & 「TUI-vs-经典 REPL 漂移」家族

- **模式**:真实 bug 最富的矿脉:**底座是活的**(数据已算出/可得)但某个面从不消费它。子型成severity阶梯——*缺字段* < *幽灵/陈旧显示*(硬编码假值与 SSOT 矛盾) < *空心提示*(静态文字指向真命令却不浮现其数据);外加*输入侧半接线*(SSOT 字段就绪但 call-site 从不传)与 *TUI-vs-经典 REPL 漂移*(特性活在一个面却没接到孪生面)。诊断永远是:**grep 谁 require 这个特性叶子**找出哪些面缺席。
- **为什么有效**:这些缺口对「加功能」不可见却产生错误/陈旧输出(「选完答案就消失」「菜单只说 dark 主题而 dracula 正生效」)。认清底座已活,则修复是最小接线而非重写。关键:缺口在两个面同时存在时,必须**一并接两面**,否则制造新漂移。
- **证据**:`project_repl_slash_dispatch_dead_handler_shadowing`(三路斜杠实现;必须 `route(parseInput(name))` 找到活路径再改死 handler)、`project_cache_hit_rate_warning_classic_repl_twin` + `project_qa_answer_echo_classic_repl_twin`(TUI-only 特性回填经典 REPL)、`project_context_identity_lines_both_twins_ssot`(输入侧半接线)。
- **规则**:找 bug 先问「数据是否已算出却从不显示」——grep 底座的消费者。改任何 handler 前先证哪个实现真正可达。缺口跨孪生面时,同一刀修两面,否则制造新漂移。

### B.7 fail-soft vs fail-open vs fail-closed(按后果匹配失败姿态)

- **模式**:三种刻意不同的失败姿态。**fail-soft**(显示/叶子逻辑默认):出错返回安全 legacy/空值,使显示特性**绝不影响行为或崩主流程**。**fail-open** 仅用于治理/拦截层不得阻断可用性处(如仲裁出错则放行执行)。安全审批闸则 **fail-closed**(缺 `EXEC_APPROVED` 戳或确认 → 拒绝)。
- **为什么有效**:姿态匹配后果既防过度阻断又防保护不足:装饰性警告若抛异常比它缺席更糟(fail-soft);审批格若 fail-open 就是安全洞(fail-closed)。记忆反复画硬红线「display-only——绝不碰 permission/riskGate/预算」,使只读增强可放心 fail-soft。
- **证据**:`project_governance_wiring_truth`(intentArbiter fail-open、约束格 fail-closed)、`project_interruption_marker_esc_ssot`(fail-soft 三层 try;只记录/显示绝不碰权限/riskGate/预算)、`project_git_repo_management_gitignore_precommit_wizard`(precommit 只提示不阻断)。
- **规则**:显示/只读默认 fail-soft(绝不崩主流程、回退 legacy),守「绝不碰 permission/预算/riskGate」红线;fail-open 留给可用性关键的拦截;fail-closed 留给审批/安全闸。

### B.8 记忆纪律本身(能力进代码、教训进记忆)

- **模式**:两层纪律。其一,**能力属于代码而非记忆**:用户说「教 khyos 做 X」时先问 X 是能力还是偏好——能力→选型/实现/测试/发进 wheel;仅纯偏好/状态→记忆。其二,写下的记忆遵循固定形状:蒸馏的**教训** + *为什么* + 具体机制 + **验证** + **承 [[links]]** 连到兄弟记忆成家族。记忆定期**蒸馏**(forget=可恢复归档,绝不硬删)。
- **为什么有效**:记忆对用户不可见、不分发、未测试、会膨胀(MEMORY.md 撞尺寸上限即证);代码可执行、可测、有回归守卫、发给所有用户——契合「AI 原生自托管 OS」愿景。固定的教训/为什么/验证/承形状使每篇记忆成可复用规则而非日记。
- **证据**:`feedback_learning_as_code`(能力-vs-记忆二分,能力型记忆一旦编码即删)、`project_memory_distillation`(forget=可恢复归档+清单,价值=durability×recency×richness)、以及几乎每篇 `project_*` 记忆的 `承 [[…]]` 页脚 + 「教训=…」 + 「验证…」结构。
- **规则**:能力编码成测试过、发布出去的代码——记忆只留偏好、项目状态、指针。每篇记忆写成蒸馏教训 + 为什么 + 机制 + 验证 + 家族链接;陈旧记忆归档(绝不删)。

### B.9 文档新鲜度系统(source→doc 映射、标记同步、HTML/PDF)

- **模式**:四叶子系统:代码改动时标出哪些文档可能过时、只重生成已 committed 的 `.html/.pdf`、在隐形 HTML 注释标记块内同步内嵌 SSOT 值、可草拟 AI 建议(该层默认关)。source→doc 映射**由解析文档既有散文约定派生**(200+ 文档已在反引号里引用源码路径)——零新增维护面。
- **为什么有效**:从既有约定派生映射避免了一张会自己腐烂的手维护映射表。两级置信(exact>prefix)+ warn-only 使它是低噪音复核提醒而非误报门禁。只重生成已 committed 产物(绝不新建)+ `--diff-filter=ACMR` + 只 re-stage 自己产物,使合并冲突安全 by construction。确定性层从不 import AI 层,保离线/CI 确定性。
- **证据**:`project_docs_freshness_system_source_to_doc`(四层设计 + 8 教训)、`project_docs_html_svg_interactive_xref_generator`(离线红线:手写内联 SVG > Mermaid/CDN;交互 HTML 全内联 + `@media print` 降级)、`project_docs_update_pip_relay_pdfhtml_buglearnings`。
- **规则**:doc→source 链接从既有散文约定派生而非维护表;新鲜度做成 warn-only 低噪音提醒;只重生成已 committed 产物、只 re-stage 自己产物使合并安全 by construction;确定性层不含模型/网络调用。

### B.10 CC/行为对齐靠真解析器探针(demonstrated,非 classified)

- **模式**:判「CC 的能力 X 在 khy 有没有」必须**跑 khy 真解析路径**——工具走 `claudeCompat.normalizeToolName → TOOL_ALIASES → registry`,命令走 `router.parseInput('/'+name).command` 命中已知集——而非按名硬比或手写等价表。模型工具调用能力同理:**live-probe** 真发一个小工具观察原生 `tool_calls`,而非硬编码名字白名单。
- **为什么有效**:分类既造假阴(「SearchExtraTools 已覆盖」实则 UNRESOLVED)又造假阳(「Shell 缺」实则解析)。跑真解析器是 demonstrated proof。Stop hook 反复驳回「分类 92、修 2」并要求逐条读真源裁定。live-probe 用测量真值替代脆弱名字启发,并拒绝在无正确目标处假映射(误接比不接更糟)。
- **证据**:`project_cc_tool_vocabulary_alias_executed_xref`(跑真解析器;发现分类掩盖的真缺口;刻意不映射 ExecuteExtraTool)、`project_tool_capability_live_probe`(删正向白名单;探针+被动学习+持久 TTL 缓存;「数据当代码」红线)、`project_tooldisplay_duration_ccformat_backfill`(穷尽 grep 102 命中逐条裁定)。
- **规则**:证一个能力存在靠执行真代码路径,非按名硬比/等价表;查对齐时逐个候选对真源穷尽裁定;宁可诚实非覆盖也不做貌似合理却错的映射。

### B.11 验证仪式(每刀收尾的固定清单)

- **模式**:近乎不变的验证块收尾每篇记忆:**node:test 计数**(如「leaf 11/11」+ 回归套件)、**三守卫净**(0 err)、**四树 cmp FAIL=0** + 跨树 `require` 行为探针、**E2E 探针**(门控开 + 各分支)、以及显式的**门控关字节一致**证明。预存无关失败(如 `kernel/src/{shell,sched}.c` UU 标记)被点名并**留原样**而非静默抹掉。
- **为什么有效**:仪式使「完成」客观可重复,一刀不能在半成品上宣告完成。门控关字节一致与四树 require 探针是使门控与 SSOT 保证成真而非空口的经验骨架。测试隔离到临时 `$HOME`/`KHY_DATA_HOME` 并区分预存失败(stash-diff 证据),防假红也防假绿。
- **证据**:`project_source_self_heal_engine_manifest_targeted`(验 healed=0 前先清 heal-state 防 throttled 假绿)、`project_context_panel_detail_ssot`(stash 证据法证失败预存)、`project_cc_format_ssot_alignment`。
- **规则**:每改以固定清单收尾:单测+回归绿、守卫净、发布副本字节一致+跨副本行为探针、E2E 逐分支、门控关字节一致证明——全在隔离临时家目录内。点名并保留预存失败而非隐藏。

---

## Part C · 可复用护栏:再造时先搭的最小脚手架

Part B 是心法,Part C 是把心法落成机器强制的最小设施。**顺序很重要**:护栏先于业务。

### C.1 三守卫脚手架(第一天就建)

三守卫在仓库根 `scripts/`,共享 `scripts/lib/`。骨架统一:git 取变更文件(`GIT_BASE_REF...HEAD` → `--cached` → `HEAD`,过滤 `ACMR`)→ 逐文件喂纯 `assessFile()` → 打印 `[ERROR]/[WARN]` → 有 error(或 `--strict-warnings` 且有 warning)则 `exit(1)`。

- **check-leaf-contract**(`scripts/check-leaf-contract.js` + `scripts/lib/leafContractGuard.js`):自声明「纯叶子/pure leaf」文件不得 require IO 模块(`fs|child_process|net|http|...`)或调 IO(`execSync|process.exit|...`);不得删自己声明的 `KHY_*` 门控(warning);任何文件不得同时含 `<<<<<<<` 与 `>>>>>>>` 冲突标记(error,全文件)。门控 `KHY_LEAF_CONTRACT_GUARD` 默认开。
  - **自声明判定的坑**:marker(`纯叶子|pure leaf`)在首个块注释内、±16 字符窗有契约词、且 marker 与契约词间**不夹模块名**才算自声明。散文「决策与文案的单一真源是纯叶子 X」会**误判 IO 壳为纯叶子**(契约词紧贴 marker);写成「委派给纯叶子 X(契约)」把模块名夹中间即排除(见记忆 `project_workspace_trust_first_launch_dialog` 的踩坑)。
- **check-model-hardcoding**(`scripts/check-model-hardcoding.js` + `scripts/lib/modelHardcodingGuard.js`):模型名唯一真源 `services/backend/src/constants/models.js`(具名数组,item[0]=当前首选)。业务逻辑不得裸引模型字面量。watch-set 从 SSOT 运行时派生(新模型自动跟随);只对**独立引号字面量**且在非注释代码且非 allowlist(适配器目录/定价表等描述性数据)开火。门控 `KHY_MODEL_HARDCODING_GUARD` 默认开。
- **check-agent-rules**(`scripts/check-agent-rules.js`,自包含):裸端点(error)、生产域名(error)、不透明状态文案(warning)、硬超时 kill 无心跳(error)、滚动区 DECSTBM(error/alt-buffer 内降 warning)。无独立门控,总在。

三者由根 `package.json` 的 `check:small-model:safety` 串起(已核实):
```
check:change-safety && check:agent-rules && check:leaf-contract && check:model-hardcoding && check:node-syntax && check:python-syntax
```
自查:`npm run check:leaf-contract`(或 `:model-hardcoding` / `:agent-rules`);带 `--changed` 走真 CI 路径(跳过 clean 文件),或传显式路径。

### C.2 四树同步机制

- SSOT `services/backend/src` 单向生成三份 bundled(见 B.5)。**不存在**把编辑copy回来的双向同步脚本——bundled 每次发布从 SSOT 重建。
- 改一个**源文件**时,把它 `cp` 同步到三份 bundled 树对应路径(测试文件**不**同步);收尾 `cmp` 四份确认 FAIL=0,并跨四树 `node -e "require(...)"` 探针确认运行时一致。
- devenv 跨语言依赖自愈(硬契约「NEVER INTERRUPT」):`packaging/npm/scripts/devenv.js`(npm 侧,Node 为枢纽,治 Python/C/MoonBit)与 `platform/khy_platform/devenv.py`(pip 侧,Python 为枢纽,治 Node)。

### C.3 元数据钩子 + 文档新鲜度(接进 pre-commit)

- **维护者守卫钩子** `.githooks/pre-commit` 跑 `npm run check:small-model:safety`(pre-push 跑 `:strict`),由 `scripts/install-git-hooks.js`(`npm run hooks:install`)安装,带 `KHY_MANAGED_HOOK` 标记不覆盖外部钩子。
- **元数据钩子** `services/backend/src/services/metadataHook.js`(`khy metadata hook` 安装,标 `khy-metadata-hook v3`):提交时确定性、无 AI 地跑 `khy metadata refresh`(重建 `.ai/` 机器派生骨架并 re-stage `.ai AGENTS.md CLAUDE.md ...`)+ `khy docs check --fix --staged`(文档新鲜度 Layer 1-3)。fail-soft:khy 不可用则 exit 0 绝不挡提交。
- **文档新鲜度** `services/backend/src/services/docsFreshness/`:runner + 四叶子(`docPathIndex` source→doc、`docProductPlan` 只重生成已 committed 产物、`docMarkerSync` 标记块同步 SSOT、`docSuggestDraft` 纯 prompt 默认关)。主门控 `KHY_DOCS_FRESHNESS` 默认开、warn-only。

### C.4 版本 / 发布纪律

- 版本 SSOT:`scripts/ci/check-version-sync.js`(`npm run check:version-sync`)要求 `pyproject.toml` 与 `services/backend/package.json` 一致;`platform/khy_platform/__init__.py` 须**动态**从 pyproject 解析(硬编码 `__version__` 会 fail)。**注意第三处** `packaging/npm/package.json` 须手动同步——这正是「版本号不一致」事故根因(commit `8f2897a`:三个 package 文件一起 bump)。
- 发布链路(见传承书操作五):`khy publish check/build/pypi`,或纯工具链 `npm run check:pip-packaging` + `python -m build` + `twine upload`。wheel 纪律:`services/backend` 进 wheel(改了须重建重发);`services/ai-backend` 不进(源码 require,editable 即生效)。

### C.5 治理层的「在产」判据(GUARDS-AI 的心脏)

若你的智能体也搞「多引擎治理」,复制这条最重要的红线(`.ai/GUARDS-AI.md` §0):一个治理引擎算「在产」**当且仅当**它能从三个真执行入口之一被 `require`——`executeTool()`(`toolCalling.js` 唯一工具漏斗)、tool loop(`toolUseLoop.js`)、daemon SSE(`aiManagementServer.js`)。**「隔离单测全绿 ≠ 在产」**。`.ai/GOVERNANCE-LEDGER.md` 是「接线-或-删除」的执行花名册(带硬截止;khyos 于 2026-06-14 删 7 接 1,git 可溯)。新引擎必须:选一个既有接线缝(不开新 bypass)、复用单一真源、给一条 E2E 证明入口可达、往 ledger 写一行——「无此行=视为未在产」。

### C.6 文档放置约定(放你的复制蓝图/设计文档)

- 根 `docs/`,编号 `[阶段-类型-序号] 中文名.md`,归入 `NN_STAGE_名/`:`01_INIT`(INIT-PRD)、`03_DESIGN`(DESIGN-ARCH,当前到 060)、`04_IMPL`(IMPL-RPT)、`05_TEST`(TEST-RPT)、`06_DEPLOY`(DEPLOY-MAN)、`07_OPS`(OPS-MAN)、`08_MGMT`(MGMT-*)。
- 双级索引:master `docs/00_INDEX_文档索引.md` + 各阶段 `00_INDEX_*-分类索引.md`。**新建编号文档须两处都登记**。
- 主题目录(不进编号索引):`docs/传承/`(本蓝图所在)、`docs/设计模式/`、`docs/报告/`、`docs/维护者/`。
- 因 `docs` 在 `BASE_COPY_PAYLOADS`,新文档下次构建自动进 bundle;若正文按约定在反引号里回引源码路径(「真源:/实现:」后),docsFreshness Layer-1 索引会自动收录。

---

## Part D · 自举剧本:从空目录到能通过 pip 发布的智能体

把 A/B/C 串成分阶段行动。每阶段以「验证仪式」(B.11)收尾才进下一阶段。

**阶段 0 · 立宪(护栏先行)**
1. 定五层边界与数据主权红线(A.3):底座 vs 应用、数据家解析**只此一处**。
2. 搭三守卫 + `check:small-model:safety` 串 + `.githooks/pre-commit`(C.1、C.3)。第一天就让「越改越差」被机器拦。
3. 建模型 SSOT `constants/models.js`(C.4)。
4. 写 `.ai/` 三件套(MAP/CONTEXT/GUARDS)+ 机器派生层的确定性刷新钩子(A、C.3)。

**阶段 1 · 骨架(能跑起来)**
5. Python 薄壳启动器 → Node 后端 → CLI 路由(A.1)。先跑通 `khy --version` / `khy health`。
6. 数据家解析器 + fail-open 的 workspace trust 闸(启动期提示,非硬安全边界)。
7. AI 网关抽象(多适配器 + 故障切换)——用 live-probe 判能力(B.10),别硬编码名字白名单。

**阶段 2 · 能力(一刀一刀长肉)**
8. 每个能力按 B.1–B.3:纯叶子 + 薄壳 + 默认开 `KHY_*` 门控 + 门控关字节回退。
9. 每加一个显示/交互特性,先 grep 底座消费者防 half-wired,孪生面一并接(B.6)。
10. 失败姿态按后果匹配(B.7):显示 fail-soft、可用性 fail-open、审批 fail-closed,守 display-only 红线。
11. 若做治理引擎,遵 GUARDS-AI §0「在产」判据 + ledger 一行(C.5)。

**阶段 3 · 打包与发布(繁衍出去)**
12. SSOT → 三 bundled 树单向生成 + 四树 cmp FAIL=0(B.5、C.2)。
13. 版本三处同步(C.4)+ `check:version-sync` + `check:pip-packaging` 纯度审计。
14. `python -m build` + `twine upload`(或 `khy publish`)。wheel 纪律记清 editable-vs-须重建。

**阶段 4 · 可维护性(不靠原作者也能活)**
15. `maintenance/` 双击入口 + `khy maintain freshness` 体检 + 文档新鲜度系统(C.3)。
16. 写一份**传承书**(无 AI 维护宪法)+ 本类**复制蓝图**,放 `docs/传承/`(C.6)。
17. 记忆纪律:能力进代码、教训进记忆,固定教训/为什么/验证/承形状(B.8)。

**每刀收尾(阶段 2 起,雷打不动)**:单测 N/N + 三守卫净 + 四树 cmp FAIL=0 + 跨树 require 探针 + E2E 逐分支 + 门控关字节一致 + 预存失败点名保留(B.11)。然后**留未提交**待人审。

---

## 尾声 · 一句话交给后继智能体

khyos 不是靠某次天才设计活下来的,而是靠一套**可被更弱的后继者照抄的纪律**:
把差距写成守卫、把改动藏在可回退的门控后、守一个真源并 cmp 到字节一致、按
「底座活着哪面没接线」找 bug、能力进代码而教训进记忆、每次只发一刀完全验证过的改动。

要再造一个 khyos,不必比 khyos 的原作者更聪明——**照着这些护栏一刀一刀走**,
护栏会替你拦住绝大多数「越改越差」。这,就是把一个智能体的开发能力传承下去的方式。

— 愿后继者沿同一套护栏,造出更好的 khyos。
