'use strict';

/**
 * flagRegistry.js — KHY_* env 门控的声明式中央注册表(纯叶子:零 IO、确定性、绝不抛、可单测)。
 *
 * 背景(goal 2026-07-03「khy 中有许多规则但是缺乏优先级,我希望能完善」):khy 全仓有 ~1500 个
 * `KHY_*` env 门控,其解析逻辑(`_FALSY`/`_off` 词表)被逐文件复制了近百遍,且**方言不一致**:
 *   - 71 个文件用 4 词 CANON `{0,false,off,no}`;
 *   - 6 个文件用 6 词 EXTENDED(加 `disable,disabled`);
 *   - priorityTaxonomy.js 用 3 词 MINIMAL 且**不归一**(`KHY_PLAN_PRIORITY=OFF` 大写读成「开」);
 *   - rewindScope 一条父子链里父 4 词、子 6 词混用。
 * 更关键的是:**父→子门控优先级是真实存在的**(父门控关 → 子门控必关),却在每个站点用私有
 * `_off` 手写重刻——如 goalStopGate.isEnabled = 「KHY_GOAL 关则 KHY_GOAL_STOP_GATE 也关」。
 * 这条散落、无声明、逐站点重复的父→子优先级,正是用户说的「缺乏优先级」。
 *
 * 本模块把它变成**单一声明式真源**:每个已登记 flag 声明自己的默认值、解析方言(per-flag off 词表)、
 * 解析模式与父门控;resolver 在**一处**集中施加父→子优先级,不再逐站点重刻。
 *
 * 设计取舍(加法式、绝不破坏):
 *   - 注册表是**种子集**,只登记已确证的父子链与 outlier,**不**迁移全部数百站点(范围过大)。
 *     未登记的 name → isFlagEnabled 保守放行(true),等价于「注册表不认识它,别拦」。
 *   - **绝不统一方言差异**:注册表**记录**分歧(per-flag off 词表 + normalize 旋钮),不抹除。
 *     统一词表会给某些 flag 悄悄加/减关闭词 = 静默行为变更,违背铁律。
 *   - 自门控 KHY_FLAG_REGISTRY(默认开,仅显式 0/false/off/no 关):关 → isRegistryEnabled 返 false,
 *     调用方据此逐字节回退到各自原有的私有 `_off`(本模块不主动改变任何行为)。
 *
 * 契约:零 IO、确定性、绝不抛。任何未知/坏输入 → 安全默认(放行 / fallback),不抛给调用方。
 *
 * @module services/flagRegistry
 */

// ── 方言词表(单一真源,消除近百处复制的分歧)──────────────────────────────
// 每个词表是一档「关闭词」集合。per-flag 通过 `off:` 指名引用,保留各自历史方言不被抹平。
const OFF_WORDS = {
  CANON: ['0', 'false', 'off', 'no'],                          // 71 文件 / goalStopGate / rewindScope 父
  EXTENDED: ['0', 'false', 'off', 'no', 'disable', 'disabled'], // toolContract / rewindScope 子
  MINIMAL: ['0', 'false', 'off'],                              // 仅 priorityTaxonomy(不归一)
};
const _VALID_OFF_NAMES = new Set(Object.keys(OFF_WORDS));
const _VALID_MODES = new Set(['default-on', 'opt-in', 'numeric']);

// ── 自门控 KHY_FLAG_REGISTRY(默认开,仅 0/false/off/no 关)────────────────
const _SELF_OFF = OFF_WORDS.CANON;
/**
 * 注册表本身是否启用。默认开;仅显式 0/false/off/no 关。关 → 调用方逐字节回退私有 `_off`。
 * @param {object} [env]
 * @returns {boolean}
 */
function isRegistryEnabled(env = process.env) {
  try {
    const v = env && env.KHY_FLAG_REGISTRY;
    if (v === undefined || v === null) return true;
    return !_SELF_OFF.includes(String(v).trim().toLowerCase());
  } catch { return true; }
}

// ── flag 声明表(种子集:已确证的父子链 + outlier)────────────────────────
// 字段:
//   mode      'default-on'(不在 off 表即开)/ 'opt-in'(仅 'true'|'1' 开)/ 'numeric'(见 resolveNumeric)。
//   off       off 词表名(CANON/EXTENDED/MINIMAL)。仅 default-on 用。
//   default   default-on 的默认布尔(恒 true,记录语义);numeric 的默认数值。
//   parent    父门控 name。父关 → 子必关(优先级核心,resolver 集中施加)。
//   normalize false → 裸 `===` 比对(精确复现 priorityTaxonomy 大写不归一 quirk);缺省 true → trim+lowercase。
//   min/max   numeric 的 clamp 边界。
const FLAGS = {
  // ── 持久目标 goal 链(goalStopGate.js;CANON 4 词 + 归一)──────────────
  KHY_GOAL: { mode: 'default-on', off: 'CANON', default: true },
  KHY_GOAL_STOP_GATE: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GOAL' },
  KHY_GOAL_EVIDENCE_GATE: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GOAL_STOP_GATE' },
  // Completion contract 门(参考 Hermes v0.18.0):目标预先声明的完成标准未被证据逐条覆盖 → redrive。
  KHY_GOAL_COMPLETION_CONTRACT: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GOAL_STOP_GATE' },
  // Verify-ran 门(goal「khy 做完任务不会及时验证测试」):声称验证通过但整轮从未真正跑过验证命令 → redrive。
  KHY_GOAL_VERIFY_RAN_GATE: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GOAL_STOP_GATE' },
  KHY_GOAL_AUTO_CLEAR: { mode: 'default-on', off: 'CANON', default: true },
  KHY_GOAL_STOP_GATE_MAX: { mode: 'numeric', default: 1, min: 0, max: 10 },

  // ── 工作目录自动 git 化(workspaceGitInit + workspaceGitInitWizardPolicy;CANON 4 词 + 归一)──
  // 每个 khy 启动目录若不在任何 git 仓库内 → 一次性 `git init`(安全判定收敛在纯叶子
  // workspaceGitInitPolicy:拒绝 HOME/文件系统根/系统目录/已是仓库)。向导为子门控:init 成功后
  // 按栈建 .gitignore + 首次 commit。父→子:自动 init 关 ⇒ 向导无意义恒关。
  // KHY_GIT_INIT_FALLBACK_IDENTITY(向导子门):缺 git 身份时也用**仓库级** fallback 身份落首次
  // commit(得可用 main 主线,让用户能立即提交/建分支);关 → 回退旧的「缺身份跳过 commit」。
  KHY_AUTO_GIT_INIT: { mode: 'default-on', off: 'CANON', default: true },
  KHY_GIT_INIT_WIZARD: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_AUTO_GIT_INIT' },
  KHY_GIT_INIT_FALLBACK_IDENTITY: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GIT_INIT_WIZARD' },

  // ── 工具契约链(toolContract.js;EXTENDED 6 词 + 归一)────────────────
  KHY_TOOL_CONTRACT: { mode: 'default-on', off: 'EXTENDED', default: true },
  KHY_TOOL_PARAM_AUDIT: { mode: 'default-on', off: 'EXTENDED', default: true, parent: 'KHY_TOOL_CONTRACT' },

  // ── 回溯 rewind 链(rewindScope.js;混合词表:父 CANON、子 EXTENDED;声明-only,不 rewire)──
  KHY_REWIND_SCOPE: { mode: 'default-on', off: 'CANON', default: true },
  KHY_REWIND_SUMMARIZE: { mode: 'default-on', off: 'EXTENDED', default: true, parent: 'KHY_REWIND_SCOPE' },

  // ── 优先级/严重性(priorityTaxonomy.js;MINIMAL 3 词 + 不归一;声明-only,不 rewire)──
  KHY_PLAN_PRIORITY: { mode: 'default-on', off: 'MINIMAL', default: true, normalize: false },
  KHY_BUG_SEVERITY: { mode: 'default-on', off: 'MINIMAL', default: true, normalize: false },

  // ── 工具结果结构化契约(toolCalling.executeTool 成功路径;CANON 4 词 + 归一)────────
  // MCP 工具 handler 返回原始协议形 `{content:[...], isError}`(无 `success` 字段、content 是数组)。
  // executeTool 成功路径原样透出未归一 → 直连消费者(toolUseLoop 等 20+ 处)读 `!result.success`
  // 把成功的 MCP 调用误判为失败。开该门 → 成功路径对 MCP 形结果走 canonical normalizeToolResult
  // (isError→success、content 数组→字符串);关 → 逐字节回退原样透出。非 MCP 工具(已带 success)零变化。
  KHY_MCP_RESULT_NORMALIZE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 外部 MCP 生态适配:`khy mcp add`(mcpAddSpec/mcpConfigStore;修「khy 无生态,需连外部,如 mcp」)──
  // 会话 /goal:khy 自己没有生态,需适配连接外面的生态(如 MCP server 的安装,对齐 `claude mcp add`)。
  // khy 早已有成熟 MCP client/host(stdio/SSE/HTTP 传输、autoconnect、tool pool、`~/.khy/mcp.json`
  // + loadConfig/saveConfig),唯缺「往 mcp.json 写一台 server」的 CLI 写入器。开 → `khy mcp add <名>
  // [--scope user|project] [--env K=V] [--transport sse|http --url …] -- <命令> [参数…]` 解析并落盘,
  // 下次会话 autoConnect 自动连上;`khy mcp remove <名>` 删除。关 → add/remove 报「未启用」并逐字节回退
  // (不改任何既有 mcp 只读状态/governance 视图)。
  KHY_MCP_ADD: { mode: 'default-on', off: 'CANON', default: true },

  // ── khy 作为 MCP server 对外暴露自己的原生工具(mcpServerProtocol/mcpServer/mcpStdio·HttpServer)──
  // 会话 /goal:khy 长期只作 MCP client(spawn 外部 server、收发 JSON-RPC 2.0);本轮把方向镜像过来
  // ——让 khy 把 `getEnabled()` 的整套原生工具作为一台 MCP server 暴露给任意 MCP 客户端(Claude
  // Desktop / Cursor / CC / 另一台 khy)。开 → `khy mcp serve [--transport stdio|http] [--host]
  // [--port] [--token] [--expose all|safe|readonly]` 起 server;stdio 走 stdin/stdout JSON-RPC,
  // http 走 Streamable HTTP + 传统 SSE(非 loopback 强制要 token,绝不裸奔上网)。tools/call 走与本地
  // 模型同一条权限门控(toolCalling.executeTool,--allowedTools/风险闸),不开后门。关 → `khy mcp
  // serve` 报「未启用」并逐字节回退(不起任何 server;client 侧只读行为零变化)。
  KHY_MCP_SERVE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 未知斜杠命令提示(unknownCommandHint;「教会 khyos 怎么处理未知指令/未知问题」)────────
  // 会话 /goal:用户显式敲了命令语法 `/x` 却没有任何命令/技能/插件匹配时,router 的交互式模糊
  // 纠错(inquirer「你是否想执行 X?」)被 `&& !isTui` 门住,在正常 TUI/REPL 里整块跳过 → literal
  // `/deploy` 被静默转发给 AI 当聊天,用户得不到「这是未知命令」的任何反馈。开该门 → 在 `return
  // false`(交 AI)之前补一条非交互(TUI 安全)提示:「未知命令 "/x"。你是不是想执行 "/y"?…」,
  // 再照常 fall through 给 AI。只对显式斜杠命令发声(裸词/自然语言问句不数落,无声交 AI)。关 →
  // 逐字节回退今日行为(直接 return false)。
  KHY_UNKNOWN_COMMAND_HINT: { mode: 'default-on', off: 'CANON', default: true },

  // ── Windows 派生黑框闪烁 + 启动慢(windowsSpawnHardening)──────────────────────
  // 用户反馈(Windows):`khy chat` 启动大量黑框闪烁,且速度比 Linux 慢太多。根因:600+ 处
  // child_process 派生(探测 git/node/python/编码等)多数未设 windowsHide → Windows 每次派生
  // 分配并销毁一个控制台窗口(既是闪烁,也是进程创建远慢于 Linux fork 的主放大器)。开该门 →
  // 入口最早处给 child_process 六方法(+fork)打薄包装,win32 上把 windowsHide:true 注入 options
  // (仅当调用方未显式指定);非 win32 完全不打补丁(Linux/mac 零影响)。关 → 逐字节回退(不打补丁)。
  KHY_WINDOWS_SPAWN_HIDE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 启动派生数量:git 上下文改无 shell 派生(gitSpawnPlan;承 KHY_WINDOWS_SPAWN_HIDE)──────
  // windowsHide 消的是「每次派生的黑框+开销」,这一层消的是「派生次数」。gitContextService 冷启动
  // (缓存空)同步跑 6–7 次 `execSync('git …')`,而 Windows 上带 shell 的 execSync 每次都是
  // cmd.exe → git 两个进程 → 12–14 个进程(启动大头)。开该门 → 改用无 shell 的 spawnSync('git',argv)
  // 直接派生 git.exe(去掉 cmd.exe 中介,进程数减半),git 命令与 stdout 逐字节不变;关 → 逐字节
  // 回退 execSync 字符串。仅当 argv 可安全分词(无 shell 元字符)时接管,否则也回退 execSync。
  KHY_GIT_SHELL_FREE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 启动派生数量:硬件探测跨启动磁盘缓存(hardwareProfileService;承 KHY_GIT_SHELL_FREE)──
  // detectProfile() 在阻塞启动路径(prefetch.applyLimits)上跑三个派生进程的探测:detectGpu()→
  // nvidia-smi、detectSwap()→ `free`/`sysctl`/PowerShell CIM、parseCpuInfo() 的 Linux
  // `grep /proc/cpuinfo`(AVX2)。这三者描述的都是**静态**硬件,而旧的 `_cachedProfile` 只在单
  // 进程内消派生——每个新 `khy chat` 都重付一遍(Windows 上尤贵:每次 CreateProcess+Defender 扫描)。
  // 开该门 → 把三者输出按「无派生的机器签名(platform|arch|cpuModel|cpuCount|totalRamMB)」缓存到
  // ~/.khy/hw_probe_cache.json,签名相符即跳过三次派生;动态字段(free RAM、磁盘余量)每次仍实时算。
  // 关 → 每次启动照旧跑三个探测,逐字节回退。任何缺失/签名不符/读写错误一律 fail-open 回落真实探测。
  KHY_HW_PROBE_CACHE: { mode: 'default-on', off: 'CANON', default: true },

  // ── pip 升级不再被守护进程锁 bundle(daemonSpawnLocation;承 KHY_HW_PROBE_CACHE)──────────
  // 分离守护进程 ai-manage-daemon.js 旧以 cwd = KHYQUANT_ROOT || __dirname/../.. 启动,pip
  // 安装布局下该 fallback 落在 site-packages/khy_os/bundled/... 内。Windows 下进程 cwd 锁住该
  // 目录及所有祖先 → `pip install --upgrade khy-os` 覆盖失败(WinError 32)→ 卸载中止 → 损坏。
  // 开该门(仅 win32 生效)→ 守护进程 cwd 改到用户可写的 ~/.khy,并把 KHYQUANT_ROOT pin 进其
  // env(全树路径解析走 KHYQUANT_ROOT||__dirname 从不依赖 cwd,故逐字节不变)→ khy 在运行时
  // pip 也能覆盖 bundle,无需停任何进程。关 → 守护进程照旧以 bundle 内 cwd 启动,逐字节回退。
  KHY_DAEMON_SITEPKG_UNLOCK: { mode: 'default-on', off: 'CANON', default: true },

  // ── 用户后台任务(backgroundTaskLauncher / scripts/task-runner.js)──────────────────────
  // `khy tasks run "<命令>"` / `khy tasks run --agent "<目标>"` 把一条任务入队到既有持久化
  // store 并 spawn 一个分离(detached)子进程执行,关掉 REPL 也继续跑;之后 `khy tasks` /
  // `khy tasks logs <id>` / `khy tasks cancel <id>` 查看与停止。开该门(default)→ run 可用;
  // 关 → run 友好拒绝,既有 list/cancel/pause/resume 不受影响(inspect/停止从不门控)。
  KHY_BG_TASKS: { mode: 'default-on', off: 'CANON', default: true },

  // ── git 工作流意识块(gitWorkflowGuidance;修「感觉 khy 缺少 git 概念/不会问是否提交」)──
  // khyos 已有全套 git 能力,但完整 Git Safety Protocol 走 on-demand 段(仅命中 git 意图正则才
  // 注入),普通编码会话里模型看不到分支/main/worktree,也不会干完活主动问是否提交。开该门 →
  // always-on 的 gitStatus 段在 repo 内每次会话追加一段简短工作流意识(分支/main/branch-first/
  // worktree/主动提交提醒·提醒是 offer 非自动提交);关 → 返回 '' 不追加,gitStatus 逐字节回退。
  KHY_GIT_WORKFLOW_GUIDANCE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 提交尾注 Co-Authored-By(gitCoAuthorTrailer;补与 CC 的差异——全仓原本 0 处尾注)──────
  // 开该门 → gitCommit 提交信息末尾幂等追加 `Co-Authored-By: khy …`(已含则不重复;可经
  // KHY_GIT_COAUTHOR_TRAILER_LINE 整行覆盖);关 → 逐字节今日行为(无尾注)。
  KHY_GIT_COAUTHOR_TRAILER: { mode: 'default-on', off: 'CANON', default: true },

  // ── 文件列举抓重点(fileSalience;分析压缩包/文件夹/盘符时「文件太多抓不住重点」)────────
  // 三类列举路径(压缩包清单/Glob/ls)原本按原始序或 mtime 盲截 N 条,中间无 salience 层,
  // 重要文件(入口/README/manifest/config)被淹没。开该门 → 在截断前插入 fileSalience 重排+分组摘要
  // (pinned 关键文件 + 按目录/扩展名分组计数 + 最大文件);关 → 逐字节回退原序 slice。
  KHY_FILE_SALIENCE: { mode: 'default-on', off: 'CANON', default: true },
  // Glob 返回值加法式附加 salience summary 字段(仅当结果数 ≥ KHY_GLOB_SALIENCE_MIN);files[]/count/truncated 不变。
  KHY_GLOB_SALIENCE: { mode: 'default-on', off: 'CANON', default: true },
  KHY_GLOB_SALIENCE_MIN: { mode: 'numeric', default: 40, min: 1, max: 100000 },
  // 专用列目录工具 ListDir(替代 agent 被推去用 Bash ls/find 裸 dump);关 → 工具不注册(=今日行为)。
  KHY_LISTDIR_TOOL: { mode: 'default-on', off: 'CANON', default: true },

  // ── 「进一步」:C/D 盘符 / 深树的剩余接缝(承 KHY_FILE_SALIENCE)──────────────────
  // 接缝3:深树目录体积热点。byDir 只按顶层单段分组,对 Users/AppData/.../ 深树近乎无分辨率;
  // 开该门 → summarizeListing 增 dirHotspots(受 maxDirDepth rollup 的目录 count+totalSize top-K);
  // 关 → dirHotspots:[](不渲染新段,字节回退)。子门控嵌 KHY_FILE_SALIENCE 语义下。
  KHY_DIR_HOTSPOTS: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_FILE_SALIENCE' },
  // 接缝1:Bash 列目录命令(ls -R/find/tree/du/dir /s)海量 stdout 在 _smartTruncate 盲截前,
  // 先经 listingParse 解析回条目 + fileSalience 摘要前置到顶部;关 → 逐字节回退纯截断。
  KHY_BASH_LISTING_SALIENCE: { mode: 'default-on', off: 'CANON', default: true },
  // 触发 Bash 列目录摘要的最小条目数(低于此值不介入,常见小清单零变化)。
  KHY_BASH_LISTING_MIN: { mode: 'numeric', default: 30, min: 1, max: 100000 },
  // 接缝2:FileReadTool 读到目录时,把「用 Bash ls」提示改为引导 ListDir 工具;关 → 回退旧文案。
  KHY_FILEREAD_LISTDIR_HINT: { mode: 'default-on', off: 'CANON', default: true },

  // ── prompt 前缀缓存稳定化(提升中转/DeepSeek relay 路径命中率)────────────────────
  // relay 路径不发 cache_control,命中率全靠 provider 最长前缀自动匹配——「匹配到第一个变了
  // 的字节为止」。易变块(env_info 时钟/task_memory/git_status/mcp/按需胶囊)靠前 → 前缀早断。
  // 杠杆 B:动态区易变段(VOLATILE_SECTION_IDS)重排到系统提示尾部;关 → 逐字节回退今日顺序。
  KHY_PROMPT_CACHE_ORDER: { mode: 'default-on', off: 'CANON', default: true },
  // 杠杆 A:按需能力胶囊(getOnDemandPromptSections·每轮按用户意图重选)从静态区剥出、移到
  // 绝对尾部(最易变,dead-last),不再击穿静态前缀 / native cache_control;关 → 回退今日位置。
  KHY_ONDEMAND_OUT_OF_PREFIX: { mode: 'default-on', off: 'CANON', default: true },

  // ── 缓存命中率诊断/守护(承 KHY_PROMPT_CACHE_ORDER;对标 Reasonix cache_shape.go)────────
  // 归因:每轮对 system/tools 拍 SHA-256 短哈希,命中低时定位「哪段变了」(system/tools/order);
  // 关 → captureShape 返 null、不显示归因(逐字节回退到只报百分比)。
  KHY_CACHE_PREFIX_SHAPE: { mode: 'default-on', off: 'CANON', default: true },
  // 会话累计命中率:把整会话每轮 hit/miss 累加,aggregate=hit/(hit+miss),比单轮稳;
  // 关 → 不累计、不显示会话行(逐字节回退到只显示单轮命中率)。
  KHY_CACHE_SESSION_AGGREGATE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 忙碌插话「转向新话题」识别(承 busyInputClassifiers steer/queue 路由)────────────
  // khy 忙碌时用户插话被按关键词分成 steer(方向修正,注入正在跑的 turn)/queue(收口后作新
  // turn)。方向词(另外/还要/also/instead…)在真·新话题里同样常见 → 一条其实换了话题的插话
  // 被误注入污染当前任务。本门控给 steer 加语义闸:插话 vs 运行话题 Jaccard 极低 → 判新话题、
  // 把 steer 降级为 queue(作独立新 turn 跑,不中途注入)。关 → 逐字节回退今日 steer 路由。
  KHY_BUSY_STEER_TOPIC_GUARD: { mode: 'default-on', off: 'CANON', default: true },

  // ── 文件系统遍历墙钟预算(防超大目录树 / Windows junction 回环导致的同步 walk 假死)──────
  // GlobTool / ListDirTool 的 walkDir 是同步 readdirSync/statSync 递归,只有 depth/results
  // 上限、无时间上限。超大树(Windows site-packages\bundled)、慢 I-O、或 junction 回环下会
  // 阻塞事件循环十几分钟、ESC 打不断。加墙钟预算:预算耗尽 walk 优雅提前返回并标 truncated。
  KHY_FS_WALK_BUDGET: { mode: 'default-on', off: 'CANON', default: true },
  // 墙钟预算毫秒;clamp[250, 600000]。默认 8s——足够列常规目录,又能兜住病态大树。
  KHY_FS_WALK_BUDGET_MS: { mode: 'numeric', default: 8000, min: 250, max: 600000 },
  // 但墙钟预算只在系统调用**之间**被检查:单个 readdirSync/statSync 卡在 Windows OneDrive 占位
  // 文件 / reparse point / 网络盘上时会冻结整个事件循环,连预算判定、工具漏斗 120s 竞赛、abort、
  // ESC 都无法派发(实测「列目录卡 17 分钟、不超时、不换方法」)。改用 fs.promises.readdir/stat
  // (走 libuv 线程池、每 entry await 让出)后事件循环不再被占,上述超时/中断全部恢复生效。
  // 只切换 walk 的同步/异步实现,不改结果形状;关 → 逐字节回退同步 walk。
  KHY_FS_WALK_ASYNC: { mode: 'default-on', off: 'CANON', default: true },

  // ── shellCommand timeout clamp(修弱模型撞 schema max:60000 → 不透明 Invalid tool parameters)──
  // 弱模型全盘递归被 60s 空闲超时杀掉后,重试时把 timeout 调大(如 600000)想绕过,却撞上 schema
  // timeout.max:60000 → _baseTool 校验拒绝 → ccUserFacingToolError 折叠成不透明 "Invalid tool
  // parameters",弱模型看不出真因、只能瞎试。shellCommand 内部本就 Math.min(timeout,60000) clamp,
  // 该 schema max 是冗余且有害的守门。开门 → normalizeParams 在校验前把 timeout/idleTimeout clamp
  // 到 [1000,60000],超限值得到 60s 封顶的运行而非报错;关门 → 原样透传,schema 仍拒绝(逐字节回退)。
  KHY_SHELL_TIMEOUT_CLAMP: { mode: 'default-on', off: 'CANON', default: true },

  // ── 计划模式与 Claude Code 对齐:先调研再做计划 + 实时工具调用 + 不一来就大方框(planModeDirective)──
  // 旧计划模式是单次 ai.chat():提交即弹「◴ 正在生成执行计划…」大方框、零调研、把模型的口语化
  // 「让我先了解一下环境…」当成「计划生成失败」。开该门 → 计划提交改走真·工具循环(query.submit
  // permissionMode:'plan'):planPhase 停在 null(无大方框)、只读窗口内先用 Read/Grep/Glob 调研(实时
  // 工具行照常渲染),模型调研够了再调 ExitPlanMode(plan) → loop 拦截 → planPhase='reviewing' 复用既有
  // PlanApproval 审阅框 + y/n 批准语法 + executePlan。关门 → 逐字节回退旧单次 startPlan(大方框+无调研)。
  KHY_PLAN_CC_RESEARCH: { mode: 'default-on', off: 'CANON', default: true },

  // ── DiskAnalyze 工具(补 khy 缺失的找大文件/旧安装包/重复文件能力,治弱模型即兴写全盘 PowerShell)──
  // 背景:khy 无正规磁盘分析路径(DiskCleanup 只清白名单缓存、零重复文件检测),弱模型只能即兴写
  // `powershell Get-ChildItem -Recurse` 扫全盘——静默无输出被 60s 超时杀、且无 du 摘要。DiskAnalyze
  // 是跨平台有界只读工具:top-N 大文件 / 旧安装包 / 重复文件(按大小分组再 hash),受 walk 墙钟预算 +
  // max-entries + hash 候选上限三重有界,不靠模型手写 shell。关 → 工具不注册(= 今日无此工具行为)。
  KHY_DISKANALYZE_TOOL: { mode: 'default-on', off: 'CANON', default: true },
  // 子门控:安装包扩展/名模式 + 大小/年龄阈值 + 去重分组决策的纯叶子。关 → 分类/分组决策逐字节回退空。
  KHY_DISKANALYZE_CATALOG: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_DISKANALYZE_TOOL' },
  // 子门控:ASCII 报告渲染纯叶子。关 → 回退最小 legacy 串(不改数据字段)。
  KHY_DISKANALYZE_REPORT: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_DISKANALYZE_TOOL' },
  // 大文件阈值(MB);低于此不计入 largeFiles。clamp[1, 1048576]。默认 100MB。
  KHY_DISKANALYZE_MIN_SIZE_MB: { mode: 'numeric', default: 100, min: 1, max: 1048576 },
  // 旧安装包年龄阈值(天);安装包 mtime 早于此才算「旧」。clamp[1, 36500]。默认 180 天。
  KHY_DISKANALYZE_OLD_INSTALLER_DAYS: { mode: 'numeric', default: 180, min: 1, max: 36500 },
  // 单次遍历文件条目上限;达上限提前返回并标 truncated。clamp[1000, 5000000]。默认 20 万。
  KHY_DISKANALYZE_MAX_ENTRIES: { mode: 'numeric', default: 200000, min: 1000, max: 5000000 },
  // 去重最多 hash 的文件数(限流 IO)。clamp[1, 1000000]。默认 2000。
  KHY_DISKANALYZE_HASH_MAX_FILES: { mode: 'numeric', default: 2000, min: 1, max: 1000000 },
  // 去重单文件 hash 大小上限(MB);超此的同大小候选跳过 hash(避免读巨文件)。clamp[1, 1048576]。默认 512MB。
  KHY_DISKANALYZE_HASH_MAX_FILE_MB: { mode: 'numeric', default: 512, min: 1, max: 1048576 },

  // ── 代理管理:前端粘贴订阅地址即添加订阅组(仿 Clash Verge 订阅+代理组)────────────────────
  // 背景:khy 已有 proxyConfigService 会抓订阅 URL、base64 解码、判 Clash/节点链接格式,但只 CLI、
  // 只「计数」不返回节点对象、且无 HTTP 路由。开该门 → 新纯叶子 proxyNodeParse 把 vmess/vless/trojan/ss
  // 节点 URI 与 Clash YAML proxies 解成节点对象 {name,type,server,port},store 持久化订阅组,route 经
  // ssrfGuard.validateUrl 抓取(防 SSRF)后落库,前端 ProxyManagement 页粘贴 URL 即导入订阅组并列节点。
  // 关门 → proxyNodeParse 返空结果(caller fail-soft 回退计数语义),前端页仍在但导入得空节点组。
  KHY_PROXY_SUBSCRIPTION: { mode: 'default-on', off: 'CANON', default: true },

  // 参考 clash-verge-rev 把订阅解析提升到「含每节点全字段」后新增:解析 `subscription-userinfo`
  // 响应头(upload/download/total/expire)→ 前端流量已用/总量/到期进度条(仿 Clash Verge 订阅卡)。
  // 纯叶子 subscriptionUserinfo 持此门;关门 → parseSubscriptionUserinfo 返 null(进度条消失、
  // 节点解析不受影响)。父 KHY_PROXY_SUBSCRIPTION 关则整个订阅特性关,故此门 parent 挂其下。
  KHY_PROXY_SUB_USERINFO: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_PROXY_SUBSCRIPTION' },

  // 「选中节点实际使用」出站内核:vmess/vless/trojan/ss/ssr 等 raw 协议节点本身不能承载流量,需本机
  // mihomo 内核生成配置 + spawn 暴露本地混合端口,再 applyProxy(本地端口)真正路由。opt-in 默认关:
  // 关门 → core-required 节点走「装内核/改用 http 节点/本机 Clash」指名指引分支(绝不静默、绝不谎报
  // 生效)。http/https 直连节点与本机 Clash 检测不受此门限,始终可用。proxyCoreManager 持此门。
  KHY_PROXY_CORE: { mode: 'opt-in', off: 'CANON', default: false },

  // 「装完即用」自动配置(bootstrap/ensureProxyCoreEnv):安装后首启把 KHY_PROXY_CORE=1 一次性播种进
  // 升级安全的 ~/.khy/.env overlay,过掉「代理内核出站未启用,请设 KHY_PROXY_CORE=1」那道门,无需用户
  // 改 shell profile。default-on;尊重用户显式值(真实 env / .env / overlay 里已设过含 =0 → 不覆盖)。
  // 关此门 → 逐字节回退到「手动设 env」旧行为。父门控 KHY_PROXY_CORE(逻辑上「自动播种的是它」,不设
  // parent 以免父关时连自动配置能力一起关 —— 二者语义正交:父=功能开关,本门=自动配置开关)。
  KHY_PROXY_CORE_AUTOSEED: { mode: 'default-on', off: 'CANON', default: true },
  // mihomo 内核二进制自动安装(proxy/proxyCoreInstaller):core-required 节点缺本机 mihomo 时,
  // 自动下载 MetaCubeX/mihomo 对应平台 release + SHA256 校验 + 落 ~/.khyquant/bin/。default-on;
  // 失败 fail-soft 回退原「core-missing 指名指引」(绝不谎报生效)。关此门 → 只提示手动装内核。
  KHY_PROXY_CORE_AUTO_INSTALL: { mode: 'default-on', off: 'CANON', default: true },

  // 「内核去哪下」指引(proxy/proxyCoreManager + 前端 ProxyManagement 横幅):此前 core-missing 指引
  // 与前端横幅都只说「请下载 mihomo 放到 ~/.khyquant/bin/」却从不给 URL,而确切官方固定 URL 早在
  // proxyCoreInstaller(ASSETS + RELEASE_BASE)里——数据在却没接到人面前。开此门 → coreManager.getStatus
  // 附 installer.describeCoreDownload() 描述符、core-missing guidance 直接给出确切官方 URL,前端横幅
  // 显示可点链接 + 落地路径 + 一键复制。default-on。关此门 → 逐字节回退到旧「请下载 mihomo」无 URL 文案
  // (getStatus.download=null、guidance 不含 URL);纯指引/透明性,不改任何路由或成败判定。
  KHY_PROXY_CORE_DOWNLOAD_HINT: { mode: 'default-on', off: 'CANON', default: true },

  // 「proxy core install/status」CLI 显式面(cli/handlers/proxyCoreInstallHandler + proxy.js
  // handleProxyCore):mihomo 内核自动安装能力(proxyCoreInstaller.install:采纳本机 / 官方 HTTPS
  // 固定版本下载 + SHA256 校验 + 落 ~/.khyquant/bin/)此前唯一调用点是 proxyCoreManager.start(node)
  // —— 只在启动 raw 节点缺内核时作为副作用触发。无头 / 离机用户(pip 安装、无 Web UI)想主动预装内核
  // 没有直达命令。开此门 → `khy proxy core install` 显式触发同一 fail-soft 安装,`khy proxy core
  // status` 查看是否就位 + 去哪下载;任何失败都附确切官方 URL + 落地路径,绝不留死路(与前端横幅 /
  // khy doctor 的「去哪下载」透明契约一致)。default-on。关此门 → `proxy core` 逐字节回退到 proxy help
  // (未知子命令原样落到 handleProxyHelp);纯接线,不改 installer 任何成败判定。
  KHY_PROXY_CORE_INSTALL_CLI: { mode: 'default-on', off: 'CANON', default: true },

  // ── UpstreamStudy 工具(把开源项目更新压缩包学进来:取其精华弃其糟粕)────────────────────────
  // 背景:Khy 开发参考了大量开源项目(DeepSeek-TUI / Hermes / OpenCode / Claude Code…),但这些项目
  // 更新时,khy 无任何正规路径把「更新包」学进来——弱模型只会手动解压、cat 一堆随机文件 flail,极易
  // 走死循环。UpstreamStudy 是**只读、有界**的正规替代:借 archiveInspectService 只列目录(零解压、
  // 无 zip-slip),纯叶子 catalog 甄别每个条目属**精华**(源码/CHANGELOG/测试/理据文档)还是**糟粕**
  // (vendored/构建产物/压缩/二进制/密钥/lockfile),可选对比用户给的旧基线出「新增/改动/删除」,产出
  // 一份策展阅读清单 + 拒绝桶 + 下一步建议。**只忠告不自动合并**(自动合并上游代码有真风险)。
  // 关 → 工具不注册(= 今日无此工具行为)。
  KHY_UPSTREAM_STUDY_TOOL: { mode: 'default-on', off: 'CANON', default: true },
  // 子门控:精华/糟粕分类 + 打分 + 已知参考项目识别的纯叶子。关 ⇒ 分类恒 neutral(逐字节回退,不产
  // 精华/糟粕划分,报告退化为纯清点)。
  KHY_UPSTREAM_STUDY_CATALOG: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_UPSTREAM_STUDY_TOOL' },
  // 子门控:ASCII 学习报告渲染纯叶子。关 ⇒ 回退最小 legacy 串(不改数据字段)。
  KHY_UPSTREAM_STUDY_REPORT: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_UPSTREAM_STUDY_TOOL' },
  // 子门控:移植计划纯叶子——在精华/糟粕之上再判**能改/不能改**(许可证/法律与糟粕=forbidden 勿移植,
  // 配置/changelog=caution 谨慎,源码/测试/文档=safe 可择优移植)与**先改/后改顺序**(先读 changelog/doc
  // 理解 → 先改接口/契约/配置 → 再改实现 → 最后改测试验证)。关 ⇒ facade 不产 plan 字段(逐字节回退)。
  KHY_UPSTREAM_STUDY_PLAN: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_UPSTREAM_STUDY_TOOL' },
  // 精华阅读清单条目数(Top-N,按学习价值打分排序)。clamp[1, 500]。默认 25。
  KHY_UPSTREAM_STUDY_TOP: { mode: 'numeric', default: 25, min: 1, max: 500 },
  // 单个「精华」文件的可读大小上限(KB);超此仍算精华但标记「过大, 略读」不进首要阅读位。clamp[1, 1048576]。默认 256KB。
  KHY_UPSTREAM_STUDY_MAX_FILE_KB: { mode: 'numeric', default: 256, min: 1, max: 1048576 },
  // 「超大 blob」判为糟粕的大小阈值(MB);单文件超此直接归 oversized 糟粕桶。clamp[1, 1048576]。默认 5MB。
  KHY_UPSTREAM_STUDY_BLOB_MB: { mode: 'numeric', default: 5, min: 1, max: 1048576 },

  // ── 非阻塞子进程执行(防同步 execSync 阻塞事件循环导致的「调用工具卡死」)──────────────
  // Grep 等工具用同步 execSync 跑 rg/grep,子进程期间阻塞整个事件循环(spinner 停、ESC 无效),
  // 且调度层 Promise.race 软超时对同步阻塞无效。换成异步 exec 垫片(_execCompat)后事件循环照转、
  // ESC 可中断、软超时真正生效;输出/退出码/抛错与 execSync 同形,调用方 try/catch 零改动。
  KHY_EXEC_NONBLOCKING: { mode: 'default-on', off: 'CANON', default: true },

  // ── 数据库查询超时(防 pg/mysql connect+query 零超时真无限挂)────────────────────────────
  // databaseQuery 的 pg/mysql 路径此前对 connect()/query() 无任何超时:不可达主机上会挂到 TCP
  // 内核超时(分钟级)甚至永挂,只靠调度层 120s Promise.race 兜(且泄漏连接)。给驱动补 native
  // 连接/语句超时(pg: connectionTimeoutMillis/query_timeout;mysql: connectTimeout),OFF 逐字节
  // 回退今日无超时行为。sqlite 是本地文件不涉网,不受此门控影响。
  KHY_DB_QUERY_TIMEOUT: { mode: 'default-on', off: 'CANON', default: true },
  // 连接超时毫秒;clamp[500, 120000]。默认 10s——足够握手,又能兜住不可达主机。
  KHY_DB_CONNECT_TIMEOUT_MS: { mode: 'numeric', default: 10000, min: 500, max: 120000 },
  // 语句超时毫秒;clamp[1000, 600000]。默认 30s——足够常规查询,又能兜住失控慢查询。
  KHY_DB_STATEMENT_TIMEOUT_MS: { mode: 'numeric', default: 30000, min: 1000, max: 600000 },

  // ── 浏览器 evaluate 墙钟超时(防 page.evaluate 跑模型死循环脚本顶死渲染线程真无限挂)──────────
  // session.evaluate() 在页面上下文 eval 任意模型脚本,而 page.evaluate 无 timeout 选项:含 while(true)
  // 的脚本会顶满渲染线程使 evaluate 永不 resolve,调度层 120s race 只 reject 且被顶死的标签页残留。
  // 用墙钟竞赛 + 超时 page.close()(经浏览器进程,独立于被顶死的渲染线程)强杀该页兜住。OFF 逐字节
  // 回退今日无超时行为(直接 await page.evaluate)。
  KHY_BROWSER_EVAL_TIMEOUT: { mode: 'default-on', off: 'CANON', default: true },
  // 墙钟超时毫秒;clamp[1000, 300000]。默认 15s——足够常规页内计算,又能兜住死循环脚本。
  KHY_BROWSER_EVAL_TIMEOUT_MS: { mode: 'numeric', default: 15000, min: 1000, max: 300000 },

  // ── 模型身份不可伪装(modelIdentityTruth;「问它你是什么模型必须答真实渠道+真实模型」)──
  // 网关可把请求路由到被微调成自称「我是 GPT/Claude」的后端,真实渠道(adapter/provider)与
  // 真实模型(路由到的 model id)只有网关知道。开该门 → 两层闭合:A 层系统提示注入反伪装指令
  // (命模型如实报真实渠道+模型、禁冒充);B 层网关成功分支在「用户问身份且答复伪装/隐瞒」时
  // 用实际路由的 adapter/model 追加确定性真值脚注。关 → 两接缝逐字节回退(不注入指令/不追加脚注)。
  KHY_MODEL_IDENTITY_TRUTH: { mode: 'default-on', off: 'CANON', default: true },

  // ── 缓存命中率如实上报(cacheMetricsTruth;「问它命中率是多少不能装作没有监控数据」)──
  // 与身份不可伪装同族:khy 网关握有真实缓存遥测(本轮 usage 的 cache_read/cache_creation +
  // cacheEconomyStore 各渠道累计),模型却常搪塞「没有访问监控数据的工具」。开该门 → 两层闭合:
  // A 层系统提示告诉模型缓存命中率可观测、被问须据实答;B 层网关成功分支在「用户问命中率且答复
  // 搪塞/未给数字」时用实际遥测追加确定性真值脚注。关 → 两接缝逐字节回退(不注入指令/不追加脚注)。
  KHY_CACHE_METRICS_TRUTH: { mode: 'default-on', off: 'CANON', default: true },

  // ── 视觉能力路由透明(visionRoutingTruth;自审 #6「无原生多模态 + 路由链路不透明」)──
  // 同「身份/命中率不伪装」族:主模型可能纯文本,视觉靠网关改选视觉模型或本地 OCR 兜底,而
  // 「哪些模型能看图 / 你能不能看图」此前无人据实回答。开该门 → 两层闭合:A 层系统提示告知模型
  // 视觉是路由而非原生、被问须据实答并回显实际模型;B 层网关成功分支在「用户问视觉能力」时,
  // 用 visionCapability SSOT 过滤真实注册表、确定性列出具备视觉能力的模型 + 回显本轮实际路由的
  // 模型能否收图。关 → 两接缝逐字节回退(不注入指令/不追加脚注)。
  KHY_VISION_ROUTING_TRUTH: { mode: 'default-on', off: 'CANON', default: true },

  // ── 三段真值 footer 只看本轮用户消息(latestUserText;治「不要每次回答都跟着一大段」)──
  // 上面三段 footer(身份/命中率/视觉)的 pickUserText 本该只取「用户当前这句话」判 intent,却
  // 收到网关传入的**整条拍平会话**(system prompt + 每轮拼接;buildFlatConversation)。而 system
  // prompt 里嵌了这三段 A 层指令,指令文本又引用了触发问句 → 三个 isXxxQuestion 每轮自命中 →
  // footer 每轮都追加(哪怕 off-topic)。开该门 → pickUserText 优先取 options.messages 末轮 user
  // 消息(干净单轮),拍平 prompt 仅作兜底 → 只有真在本轮问才追加。关 → 逐字节回退原「prompt 优先」。
  KHY_TRUTH_FOOTER_LATEST_USER_TEXT: { mode: 'default-on', off: 'CANON', default: true },

  // ── TUI 工具头行显示名对齐 CC(toolHeaderDisplayName;「做这个对齐」)──
  // 经典 REPL 早已过 getToolDisplayName 归一(edit→Update / write→Write / read→Read …),
  // 但 Ink TUI 头行此前直接用工具原始注册名(Edit/Write/…)→ 同一操作两处叫法漂移。
  // 开该门 → TUI 头行接回同一份 SSOT;关 → 逐字节回退原始注册名。
  KHY_TUI_TOOL_DISPLAY_NAME: { mode: 'default-on', off: 'CANON', default: true },

  // ── 写入前 diff 预览进 Ink 审批框(editDiffPreview;「让 khy 的 TUI 拥有 CC 一样的真 code 生产能力」)──
  // 经典(非 Ink)审批路径早已给 permissionPromptPort 传 diffInfo,但默认 UI(Ink TUI 的
  // PermissionsPrompt)走 onControlRequest 只收到原始 params → 从不渲染 diff,`default` 模式下
  // 用户盲批文件编辑,写入后才在结果里看到红/绿。开该门 → 审批前计算 before/after 并复用
  // ToolLines 的 buildWriteDiffRows/renderDiffRows 画进授权框(Write/Edit/MultiEdit,决不触盘);
  // 关 → 不计算预览 → Ink 审批框不新增渲染,与今日字节等价。
  KHY_EDIT_DIFF_PREVIEW: { mode: 'default-on', off: 'CANON', default: true },

  // ── 流式预览归一缓存(streamNormCache;「动画/任务体验卡顿,无法做真正的软件项目」)──
  // StreamingBlock 每帧(~25fps)对整条累积时间线的每个文本片段跑正则归一(normLive),
  // 再尾切到视口。除唯一增长片段外其余都已冻结(内容不再变),对它们每帧重跑正则是纯浪费,
  // 随时间线变长呈 O(n²)/turn → 长回答时打字/动画/spinner 发卡。开该门 → 按内容缓存 normLive
  // 的纯输出,冻结片段命中缓存、只增长片段重算(O(n²)→O(n)/turn);关 → 每次直接调原 fn,
  // 逐字节回退到今日行为。归一是内容的纯函数,缓存逐字节等价。
  KHY_STREAM_NORM_CACHE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 流式预览 markdown 渲染缓存(streamMdCache;承 streamNormCache 同管线,同「流畅使用」)──
  // StreamingBlock 每帧对尾窗每个 text 片段调 mdStream=renderMarkdownStreaming。其内层
  // renderMarkdownLite 已 LRU 缓存,但外层 `s.match(/^[ \t]*```/gm)` 数栅栏判奇偶补合在**每次
  // 调用都跑**(含命中冻结片段),每帧对整片段分配 match 数组 → O(n²)/turn 纯浪费。开该门 →
  // 按 (columns, text) 缓存整体渲染输出,冻结片段命中即整体复用连 fence-scan 也跳过;关 →
  // 每次直接调原 fn,逐字节回退到今日行为。渲染是 (text, 列宽) 的纯函数,缓存逐字节等价。
  KHY_STREAM_MD_CACHE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 流式卡顿:软封长增长段(TUI soft-seal;「前端 tui 很卡顿」)──
  // splitSealedText 只在空行处封存(seal)。一个持续增长、内部无空行的开放文本段(长段落 /
  // 长列表 / 无空行长内容)永远整段 live,每帧被全量重规范化 → O(n²) 卡顿(lazy-norm 只冻结
  // 已封存前缀,救不了这个不封存的长尾)。开该门 → 段长超 KHY_TUI_SOFT_SEAL_CHARS(默认 2000)
  // 且存在「两纯散文行之间」的安全软边界时,回退到软封存以封顶 live 段长度(至多把段落拆两段,
  // 绝不劈开 fence/表格/列表/引用);关 → 只用空行边界,逐字节回退今日行为。
  KHY_TUI_SOFT_SEAL: { mode: 'default-on', off: 'CANON', default: true },
  KHY_TUI_SOFT_SEAL_CHARS: { mode: 'numeric', default: 2000, min: 200, max: 1000000, parent: 'KHY_TUI_SOFT_SEAL' },

  // ── 流式卡死误判:阈值调优 + 首 token 宽限(streamStaleTuning;「任务经常中断」)──
  // 推理模型(o1/o3、deepseek-r1、thinking 模式)在**首 token 之前**会静默思考,远超历史
  // gpt/openai 45s 底线 → StreamStaleDetector 判 stale → ac.abort() → 任务被莫名中断。开该门 →
  // ①gpt/openai 稳态底线抬齐 default 90s;②首 chunk 到达前用 KHY_STREAM_FIRST_TOKEN_GRACE_MS
  // (默认 120s)宽限静默推理,首 chunk 一到即回落稳态;③KHY_STREAM_STALE_MS(>0)整体覆盖稳态阈值。
  // 关 → 冻结的 PROVIDER_STALE_MS 查表(gpt/openai 45s、无宽限),逐字节回退今日行为。
  KHY_STREAM_STALE_TUNING: { mode: 'default-on', off: 'CANON', default: true },
  KHY_STREAM_FIRST_TOKEN_GRACE_MS: { mode: 'numeric', default: 120000, min: 0, max: 1800000, parent: 'KHY_STREAM_STALE_TUNING' },
  KHY_STREAM_STALE_MS: { mode: 'numeric', default: 0, min: 0, max: 1800000, parent: 'KHY_STREAM_STALE_TUNING' },

  // ── 通用兜底小任务超时放宽(genericSmallTaskRelax;「任务经常中断」)──
  // aiGatewayGenerateMethod 小任务(prompt ≤220 字符)的 fastCap 链末位兜底此前是裸 30000——
  // relay/api/gemini/glm 等通道(最常见路径)全落这里,模型思考 >30s 即被 adapter 超时中断,
  // 而其余分支底线全 ≥90s。开该门 → 抬到 90s 且经 GATEWAY_GENERIC_SMALL_TASK_TIMEOUT_MS 可覆盖;
  // 关 → 裸 30000,逐字节回退今日行为。
  KHY_GENERIC_SMALL_TASK_RELAX: { mode: 'default-on', off: 'CANON', default: true },

  // ── 内联代码先于 LaTeX 保护(markdownRenderer;修「narration 命令回显吃掉 $/{}」)──
  // 会话现场:narrator「接着跑 `powershell … "$files = @{}; $paths = @(…`」经 markdown 渲染后
  // 显示成 `files = @;paths = @(…`——`$`、`{}` 被吞。根因是 _renderMarkdownLiteInner 里先抽围栏
  // ```块```→随即跑 _renderLatexFormulas(`$…$` 内联数学 + 剥花括号),而**内联反引号代码的保护
  // 排在其后**,故反引号内的 `$files = @{}; $paths` 被当 `$…$` 公式吃掉(去 $ 定界 + 剥 {})。开该门
  // → 内联代码保护提前到 LaTeX 渲染之前(围栏此时已占位,不受影响),`$`/`{}` 在行内代码里逐字保留;
  // 关 → 历史顺序(LaTeX 先跑),逐字节回退今日行为。
  KHY_MD_INLINE_CODE_BEFORE_MATH: { mode: 'default-on', off: 'CANON', default: true },

  // ── 行内斜体星号侧接守卫(starEmphasisFlanking;修「斜体正则吞正文星号」)──
  // markdownRenderer 行内斜体链的历史正则 /(?<!\*)\*([^*\n]+)\*(?!\*)/g 只挡相邻星号,不管
  // CommonMark 侧接(flanking):定界星号紧贴空白时不构成 emphasis。故正文里成对、两侧带空格
  // 的星号(算式 `a * b * c`、脚注 `see * x *`)被误当斜体:渲染路径把 `* b *` 显斜体,剥星
  // 路径(表格宽度计算 .replace(re,'$1'))把用户手写的字面星号直接删掉 → 内容/宽度双失真。开该门
  // → 5 处 call-site 改用 flanking-aware 正则(开定界符后非空白 `(?=\S)`、闭定界符前非空白
  // `(?<=\S)`;因 CommonMark 允许词内星号,故不加下划线那样的词边界守卫);关 → 逐字节回退历史正则。
  KHY_STAR_EMPHASIS_FLANKING: { mode: 'default-on', off: 'CANON', default: true },

  // ── 按显示宽度截断的省略号预算(truncateDisplayWidthBudget;修「工具入参/单元格截断溢出列宽」)──
  // toolDisplay 的 _truncateDisplayWidth 把内容填到**恰好 limit** 列再接 3 列的 `...` → 总宽 limit+3,
  // 溢出调用方给的列预算(_sanitizeToolTableCell 的 24、_truncateNaturalText 的 40/80/88/100/120),
  // 工具头行/入参行比其列位宽 3 列、对齐被搅乱(同仓 formatters.truncateToWidth 早已为省略号预留 3 列)。
  // 开该门 → 截断时为省略号预留 3 列(内容填到 limit-3 再接 `...`,总宽 ≤ limit;整串本就 ≤ limit 时原样返回);
  // 关 → 逐字节回退历史「填满 limit 再溢出接 `...`」行为。
  KHY_TRUNCATE_WIDTH_BUDGET: { mode: 'default-on', off: 'CANON', default: true },

  // ── `--key=value` 内联选项解析(inlineOptionParse;修「router 丢掉等号选项的值」)──
  // router.js 的选项解析只认空格分隔 `--key value`:对 `--out=report.md` 取 key='out=report.md'、
  // 落 options['out=report.md']=true,真正的值 report.md 被丢(GNU/POSIX 长选项及本仓帮助文案里
  // 的 --scope=user / --url=… 全静默失效)。开该门 → 去 `--` 后含「位置 >0 的等号」时按第一个等号
  // 切成 {key,value} 且不消费下一个 token(value 可为空串);关 → 逐字节回退历史空格分隔逻辑。
  KHY_INLINE_OPTION_PARSE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 流式围栏语言段字符集加宽(fenceLangCharset;修「流式识别不了 ```c# / ```f#」)──
  // streamingMarkdown 的 FENCE_OPEN_RE 语言段 [\w+-]* 收不下 `#`/`.` → ```c#、```f#、```asp.net
  // 无法匹配整行,classifyLine 不判 fence_open、_enterFence 拿不到语言 → 流式预览里这段不被当
  // 代码块(而同仓非流式 _COMMON_LANGS 早认得 c#/objective-c)。开该门 → 语言段额外收 `.`/`#`;
  // 关 → 逐字节回退历史正则。
  KHY_FENCE_LANG_CHARSET: { mode: 'default-on', off: 'CANON', default: true },

  // ── agnes 文生图统一默认模型(agnesImageModel;修「Agnes 2.0 Flash 调不出来」)──────────
  // Sapiens 官方文档 POST /v1/images/generations 登记两个真实图像模型:agnes-image-2.0-flash
  // (统一模型,一个端点干文生图/图生图/多图合成)与 agnes-image-2.1-flash(升级版,高信息密度/
  // 复杂构图,文生图/图生图)。imageGenService 历史把**文生图**默认 hardcode 成 2.1-flash、仅图改图
  // 才用 2.0-flash → 一条普通「画一张 X」(无输入图)请求实际打的是 2.1-flash,而用户想用统一的
  // 2.0-flash 时无从默认命中。开该门 → 文生图默认收敛到官方统一 agnes-image-2.0-flash,且 catalog
  // 同时列出 2.0/2.1 两个可选模型(2.1 仍可经 KHY_IMAGE_GEN_AGNES_MODEL 或 UI model 参数显式选中);
  // 关 → 逐字节回退历史文生图默认 agnes-image-2.1-flash 与旧 catalog 形状。显式 env/参数覆盖始终优先。
  KHY_AGNES_UNIFIED_IMAGE_MODEL: { mode: 'default-on', off: 'CANON', default: true },

  // ── 生图桥接聊天池已配置的可生图 provider(imageGenPoolBridge;修「聊天配好 agnes,生图却报
  // 『未检测到任何图像生成后端』」)──────────────────────────────────────────────────────────
  // khy 有两套互不相通的 agnes 凭据:聊天 provider 把 key 存进 apiKeyPool(poolKey=agnes,
  // endpoint=https://apihub.agnes-ai.com/v1),而 imageGenService 只从自己私有的
  // KHY_IMAGE_GEN_AGNES_API_KEY env 读 key、从不看聊天池。用户走聊天 provider 流程配 agnes 后,
  // 生图侧 backendStatus().agnes=false → resolveBackend() 返回 null → 报「无后端」。开该门 →
  // 生图缺自己的 env key 时,从聊天池桥接一个 endpoint 主机命中已知生图白名单(初始仅 agnes 的
  // apihub.agnes-ai.com)的 provider,复用其 key + endpoint(imageGenService 三处兜底:
  // backendStatus.agnes / _agnesBaseUrl / _generateAgnes)。关 → 三处逐字节回退到今日 env-only
  // 行为(无桥接、报「无后端」)。显式 KHY_IMAGE_GEN_AGNES_API_KEY / _BASE_URL 始终优先。
  KHY_IMAGE_GEN_POOL_BRIDGE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 视频生成桥接聊天池已配置的可生视频 provider(videoGenPoolBridge;修「聊天配好 agnes,视频却报
  // 『未检测到任何视频生成后端』」)──────────────────────────────────────────────────────────
  // 与 KHY_IMAGE_GEN_POOL_BRIDGE 完全同因、同构:khy 有两套互不相通的 agnes 凭据——聊天 provider
  // 把 key 存进 apiKeyPool(poolKey=agnes,endpoint=https://apihub.agnes-ai.com/v1),而
  // videoGenService 只从私有的 KHY_VIDEO_GEN_AGNES_API_KEY env 读 key、从不看聊天池。用户走聊天
  // provider 流程配 agnes 后,视频侧 backendStatus().agnes=false → resolveBackend() 返回 null →
  // 报「无后端」。开该门 → 视频缺自己的 env key 时,从聊天池桥接一个 endpoint 主机命中已知视频白名单
  // (初始仅 agnes 的 apihub.agnes-ai.com)的 provider,复用其 key + endpoint(videoGenService 三处
  // 兜底:backendStatus.agnes / _agnesBaseUrl / _agnesApiKey → create + poll 同一把 key)。关 → 三处
  // 逐字节回退到今日 env-only 行为(无桥接、报「无后端」)。显式 KHY_VIDEO_GEN_AGNES_API_KEY / _BASE_URL
  // 始终优先。
  KHY_VIDEO_GEN_POOL_BRIDGE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 生图 key 降级链:桥接 key 不可用 → 轮转其它已知可生图 key → 都不行则邀请配 key ──────────
  // 承接 KHY_IMAGE_GEN_POOL_BRIDGE:桥接从聊天池借到 agnes key 后,若首个 key 被拒(401/403/429)
  // 或缺失,今日 _generateAgnes「取一次 key、失败即抛」既不 cooldown 该 key、也不轮转到同 provider
  // 的其它 agnes key。开该门 → _generateAgnes 对 imageGenPoolBridge 白名单里**所有可用**池 key 依次
  // 试:某 key 命中 401/403/429 → apiKeyPool.markFailure(cooldown) 并试下一个,成功 → markSuccess;
  // 全部耗尽 → 抛 code=NO_USABLE_KEY(供工具层邀请配 key)。显式 KHY_IMAGE_GEN_AGNES_API_KEY env
  // 恒优先且不参与轮转。关 → 逐字节回退今日「取一次 key、失败即抛、从不 markFailure」。
  KHY_IMAGE_GEN_KEY_ROTATE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 生图失败诚实总结 + 配 key 邀约(imageGenFailureSummary;降级链最后一环)────────────────
  // 桥接 key 与其它已知可生图 key 都试过仍失败时,不能只把底层原始报错(HTTP 401 …)甩回。开该门 →
  // tools/imageGenerate 失败分支经 imageGenFailureSummary 产:①诚实定性(不窄化单一 provider)
  // ②脱敏真因(保 401/超时、剥 bearer/key)③auth/no_key → 询问「要不要帮你配置图像生成模型
  // (Agnes/OpenAI 兼容)的 API Key」(用户粘 key 后走既有 configureModelProvider 工具写入)。
  // 关/叶子异常 → 逐字节回退到今日底层 err.message 文案。
  KHY_IMAGE_GEN_FAILURE_SUMMARY: { mode: 'default-on', off: 'CANON', default: true },

  // ── 智谱 GLM 最新旗舰默认/清单收敛(zhipuGlmModel;修「glm-5.2 做适配」)────────────────────
  // 智谱最新旗舰 GLM-5.2(OpenAI 兼容 https://open.bigmodel.cn/api/paas/v4,1M 上下文/128K 最大
  // 输出/thinking/reasoning_effort/function-call/MCP)在全仓三处 SSoT 里仍停留 glm-4 世代:
  // constants/models.js ZHIPU_DIRECT_MODELS、gateway/providerPresets.js zhipu preset、
  // gateway/builtinProviderConfig.js GLM models。→ 直连 zhipu 默认仍 glm-4、provider 目录里
  // glm-5.2 从不出现。开该门 → zhipu 默认 = glm-5.2 且 preset/builtin 清单以 glm-5.2 打头
  // (glm-4 系仍可显式选中);关 → 逐字节回退历史 glm-4 默认与旧清单。显式 env/UI model 覆盖始终优先。
  KHY_GLM_LATEST_MODEL: { mode: 'default-on', off: 'CANON', default: true },

  // ── GLM 图像识别模型接入透明视觉路由 + 显式识图工具(glmVisionModel;「文本模型看不了图 →
  // 路由到 GLM-4.6V-Flash 再返回」)────────────────────────────────────────────────────────
  // khy 早有整套透明视觉路由(visionCapability 判定 → visionRouting 决策 → aiGateway 执行),但
  // `glm-4.6v-flash` 在 visionCapability 里判不出「支持视觉」(唯一 GLM 名字提示词 `glm-4v` 匹配
  // 不到 `glm-4.6v`——`4` 后跟 `.6` 非 `v`),且没被设为默认视觉兜底(KHY_VISION_FALLBACK_MODEL
  // 纯 env、无代码默认)。开该门 → ①visionCapability 认 glm-4.6v-flash 为视觉模型;②aiGateway 在
  // 用户未自定义 KHY_VISION_FALLBACK_MODEL 且 GLM key 可用时默认兜底转它;③显式识图工具 RecognizeImage
  // 启用。关 → 三者逐字节回退(能力 false、无默认兜底、工具不注册)。key 复用既有 GLM_API_KEY。
  KHY_GLM_VISION_MODEL: { mode: 'default-on', off: 'CANON', default: true },

  // ── 识图工具用「池限定 pin」而非裸模型名(recognizeImage;/goal「图像发送后为什么直接 404」)──
  // 实测:当前激活 provider 是自定义 `api` 池(auto::api)时,RecognizeImage 默认发**裸** `glm-4.6v-flash`;
  // 该 id 已被判为视觉模型 → 视觉路由取 keep 分支、从不注入 GLM 池改道 → 裸 id 原样打到 `api` 上游,
  // 那里没有此模型 → `model_not_found` 404。开该门 → 工具默认改用带 `glm/` 前缀的池限定 pin
  // (glm/glm-4.6v-flash),让 _resolveApiPoolProviderForRequest 定向到 GLM 视觉端点(模型确实存在处);
  // 关 → 逐字节回退裸 `glm-4.6v-flash`(供仅经 api 池访问 GLM、无独立 glm 池 key 的用户)。parent 上门。
  KHY_RECOGNIZE_IMAGE_POOL_PIN: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GLM_VISION_MODEL' },

  // ── 外层带图请求钉 `api` 适配器(glmVisionApiPin;/goal「图像识别始终 404 / 裸 404」根治)──
  // 实测(reproduce 证):模型本身就是 GLM 视觉模型(glm/glm-4.6v-flash、glm-4v-flash)时,
  // decideVisionRouting 走 `keep` 分支 → 不进 describe 级联 → 从不钉 api → 请求原样流进通用适配器
  // 级联,排在 api 前面的 codex/openai 兼容通道先接住、拿裸视觉模型名打自己上游 → **裸 404**
  // (`Request failed with status code 404`,既非 `智谱AI:` 也非 `OpenAI:` 前缀 → 真错因被吞,从不
  // 达 callZhipu)。describe 级联的 api-pin 只保护嵌套透传,从不保护 keep 分支的外层请求。开该门 →
  // 外层(非 describe 透传)若 GLM 视觉模型 + glm 池有 key,强制 preferredAdapter='api' 定向智谱端点
  // (callZhipu,模型确实存在处),真错因浮现(code 1211 未开通 / 1002 无效 key);仍失败则既有
  // post-failure OCR 兜底救回。关 → 逐字节回退今日行为(通用级联,可能被抢答)。当前非 api 首选
  // (含环境级 GATEWAY_PREFERRED_ADAPTER,如 codex)亦覆盖——因非 api 通道对该 GLM 视觉模型必 404。
  // parent 上门。
  KHY_GLM_VISION_API_PIN: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GLM_VISION_MODEL' },

  // ── GLM 视觉模型 max_tokens 钳位(glmVisionMaxTokens;/goal「识图 400 code 1210」根治)──
  // 实测:识图链路(relayApiAdapter OpenAI 兼容分支 `options.maxTokens ?? 8192`、callZhipu 请求体)
  // 对 max_tokens 硬编码高默认值;GLM 视觉模型(glm-4v-flash / glm-4.6v-flash)把 max_tokens 限制在
  // [1,1024],发送 8192 → 智谱端参数校验 400 拒绝(code 1210「max_tokens参数非法：限制数值范围[1,1024]」),
  // 识图整轮失败(文本模型无此上限,故文本正常)。开该门 → 命中 GLM 视觉模型时把 max_tokens 钳进
  // [1,1024];关 → 逐字节回退(原样发送高默认值)。视觉模型判定复用 glmVisionApiPin 单一真源。parent 上门。
  KHY_GLM_VISION_MAX_TOKENS_CLAMP: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GLM_VISION_MODEL' },

  // ── GLM 视觉过大图片降采样(glmVisionImageDownscale;/goal「识图 400 code 1210」第二形态根治)──
  // 实测(0.1.181 诊断浮现):GLM 视觉端另有一条**合并预算**约束 `inputs tokens + max_new_tokens
  // <= 16384`。一张高分辨率截图光图片本身就编码成 18287 个 input token > 16384,无论输出多小都必然
  // 400 code 1210(`Given: 18287 inputs tokens and 1024 max_new_tokens`)。这与上面的单参数 max_tokens
  // 钳位是不同的 1210:此处是图片太大、须**缩图**而非改参数。开该门 → 命中 GLM 视觉模型时,发送前无
  // 依赖读出宽高(imageMetadataProbe)、按面积∝token 线性模型估算,超预算者用平台自带图像工具
  // (Windows PowerShell System.Drawing / macOS sips / Linux ImageMagick·ffmpeg)等比降采样到预算内;
  // 关门 / 平台工具缺失 / 任何失败 → 原图透传(逐字节回退今日行为,交回既有 OCR 兜底与错误诊断)。
  // 仅 GLM 视觉模型 + 估算超预算才重编码,预算内的图 0 成本透传。视觉判定复用 glmVisionApiPin 单一真源。parent 上门。
  KHY_GLM_VISION_IMAGE_DOWNSCALE: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GLM_VISION_MODEL' },

  // ── GLM 视觉降采样诊断日志(glmVisionImageDownscale._diag)──
  // 默认开(与 KHY_RELAY_ERROR_BODY_DIAG 同期,便于用户复现读日志定位:探针失败 / 预算内不缩 /
  // 缩放成功 / 平台工具失败仍发原图)。写 stderr,前缀 `[glm_vision_downscale]`。关门
  // 0/false/off/no → 静默(逐字节回退无日志)。parent 上门。
  KHY_GLM_VISION_DOWNSCALE_DIAG: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GLM_VISION_IMAGE_DOWNSCALE' },

  // ── GLM 视觉「统一归一化所有输入图」(glmVisionImageDownscale;用户诉求「统一处理所有照片」)──
  // 缺口:仅「超预算才缩」会让接近预算边界的图(估算误差内)偶尔仍撞 1210,且不同来源图尺寸参差。
  // 开该门 → 对**每张** GLM 视觉输入图统一按最大边上限 KHY_GLM_VISION_MAX_EDGE(默认 1512px)等比
  // 收敛:超上限的缩到上限内(既避 token 超限,又给识别一个稳定清晰的分辨率);已在上限内的不动。
  // 与「超预算降采样」取二者更强的收缩(min scale)。关 → 逐字节回退「仅超预算才缩」。parent 上门。
  KHY_GLM_VISION_NORMALIZE_ALL: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GLM_VISION_IMAGE_DOWNSCALE' },

  // ── GLM 视觉超大文本预算截断(glmVisionTextBudget;排障「为什么会出现剪贴板中转模式」根治)──
  // 实测(v0.1.183 会话日志):扫 C+D 盘 → DiskCleanup 返回约 25304 个 input token 的**纯文本**
  // 工具结果 → 发给 glm-4v-flash 撞合并预算 `inputs + max_new_tokens <= 16384` → 恒 400 code 1210
  // → 网关级联耗尽 → 落到剪贴板中转兜底。这是 1210 的**第三种形态**:前两个修(单参数 max_tokens
  // 钳位 / 单图降采样)都只管图,**无图片**的大文本撑爆预算它们都不触发。开该门 → 命中 GLM 视觉
  // 模型时,发送前估算 messages 里所有文本 token,超「16384 - 输出保留 - 安全余量」的输入预算就
  // **中段截断最大的文本块**(优先缩巨型工具结果,保留系统/用户小提示,保头保尾 + 截断标记);
  // 关门 / 任何异常 → 原样透传(逐字节回退今日行为)。仅 GLM 视觉模型 + 估算超预算才截断,预算内
  // 0 成本透传。视觉判定复用 glmVisionApiPin 单一真源。纯字符串运算、零 IO、绝不抛。parent 上门。
  KHY_GLM_VISION_TEXT_BUDGET: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GLM_VISION_MODEL' },

  // ── 视觉级联耗尽的确定性根因诊断(visionExhaustionDiagnostic;/goal「404/429 别静默落剪贴板」)──
  // 缺口:带图请求穷尽所有通道后,generate 末端只给笼统的「所有 AI 通道均不可用」墙,不告诉用户
  // 视觉**具体**为什么失败。而 attempts 里往往已握确定性信号:①model_not_found/404 = 账号未领取
  // 该视觉新模型(glm-4.6v-flash 是 2025/12 新模型,部分账号未实名/领取时官方端点回 404,见
  // glmVisionModel.js:28);②rate_limit/429 = bigmodel 账号被限流(智谱免费档 code 1302 并发/QPS
  // 超限),连 glm-4v-flash 兜底也打不通 → 级联耗尽落 OCR/剪贴板。开该门 → 带图请求耗尽时,从
  // allAttempts 提取这两类信号,前置一段**指名道姓**的可执行指引(去 open.bigmodel.cn 实名领取模型 /
  // 降并发稍后重试)到兜底墙之前;关门/任何异常 → 逐字节回退(不前置,直接落通用墙)。诚实:404/429
  // 是账号侧事实,代码只翻译已发生的信号成指引,不代办领取/解限流。纯叶子零 IO 绝不抛。parent 上门。
  KHY_VISION_EXHAUSTION_DIAG: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GLM_VISION_MODEL' },

  // 视觉级联耗尽诊断的**网络不可达**子分支(OPS-MAN-134,承 KHY_VISION_EXHAUSTION_DIAG):socket hang up /
  // 连接被重置 / 代理隧道不通 等传输层故障,与 404(未领取)、429(限流)正交。开(默认)→ 网络信号可见,
  // 前置「图确实收到、只是网络送不到」的诚实交代;关(0/false/off/no)→ 诊断看不见网络信号,逐字节回退
  // 到只识 404/429(网络-only 耗尽落通用墙)。纯叶子零 IO 绝不抛;绝不谎称「没收到图」。
  KHY_VISION_NETWORK_EXHAUSTION_DIAG: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_VISION_EXHAUSTION_DIAG' },

  // ── 人肉中转不作自动兜底(manualRelayAutoFallbackPolicy;排障「为什么出现剪贴板中转模式」收尾修)──
  // 剪贴板中转(clipboardRelayAdapter)本质是人肉复制粘贴 + 监听剪贴板(最长等人 5 分钟),网页中转
  // (webRelayAdapter)同样要人把提示词粘进网页再贴回。旧行为:generate 级联遍历整份 _adapters,manual
  // 通道(relay/clipboard)只被排到队尾却从不剔除 → 云端全失败后静默走到剪贴板,莫名要用户手动粘贴。
  // 开该门 → 自动级联一律跳过 relay/clipboard(仅 preferredAdapter/forceAdapter 显式指定时放行),让
  // 本地模式(ollama/localLLM)成为真正的自动终端兜底;云端 + 本地都不可用时走末尾失败引导而非人肉中转。
  // 关门 → 逐字节回退今日行为(manual 通道仍在自动级联队尾兜底)。manual 集合复用 SSOT
  // DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS,判定为纯叶子(零 IO、绝不抛)。
  KHY_MANUAL_RELAY_NO_AUTO_FALLBACK: { mode: 'default-on', off: 'CANON', default: true },

  // ── /learn 从目录/网页学习技能(skillLearningService.learnFromDirectory/learnFromUrl)──
  // 参考 Hermes v0.18.0 /learn:把用户指向的来源(一个代码目录、一个 API 文档网址)提炼成可复用技能。
  // Khy-OS 保留确定性引擎模型:IO(fs 读目录 / HTTP 抓网页)在服务层,提炼由纯叶子 skillSourceDistiller
  // 完成(零 IO、绝不抛、绝不臆造——命令/标题都逐字来自来源)。开门 → 启用 dir/url 两个来源;关门 →
  // 两函数直接返回 disabled 结果(能力惰性化,既有 npm/github/workflow 来源不受影响)。
  KHY_LEARN_FROM_SOURCE: { mode: 'default-on', off: 'CANON', default: true },

  // ── /learn 引入外来源前的威胁静态扫描(skillThreatScanner)──
  // 参考 Hermes v0.18.0 tools/skills_guard.py:外来 skill 安装前按分类别威胁模式表静态扫描,
  // 依 finding 严重度派生 verdict(safe/caution/dangerous)。Khy-OS /learn 会把用户指向的任意
  // 目录/网页文本提炼成 skill 并每会话加载,故蒸馏后、持久化前必须先筛查密钥外泄/提示注入/破坏性
  // 命令/持久化/反弹 shell/混淆。纯叶子 skillThreatScanner(零 IO、绝不抛、fail-soft 偏 safe)。
  // 开门 → dangerous(critical 命中)默认阻断持久化,除非显式 force;caution 附警告仍放行。
  // 关门 → 逐字节回退今日行为(learnFrom* 不扫描直接持久化)。父门 KHY_LEARN_FROM_SOURCE。
  KHY_LEARN_SOURCE_THREAT_SCAN: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_LEARN_FROM_SOURCE' },

  // ── skill journey(统一时间线)──
  // getSkillJourney 聚合已学技能 + 记忆目录,交纯叶子 journeyTimeline 合并/排序/汇总
  // (零 IO、绝不抛)。移植自 Hermes v0.18.0 /journey。开门 → `skill journey` 可用;
  // 关门 → getSkillJourney 直接返回 disabled 结果(能力惰性化)。
  KHY_SKILL_JOURNEY: { mode: 'default-on', off: 'CANON', default: true },

  // ── MoA(Mixture-of-Agents)聚合器 ──
  // moaService.runMoa 复用 arenaManager 多模型并行扇出 → 纯叶子 moaAggregation
  // (normalizeReferences 去重 + buildAggregatorPrompt 合成提示词,零 IO、绝不抛)→
  // 单个 aggregator 模型合成最终答案。移植自 Hermes v0.18.0 MoA。开门 → `moa` 可用;
  // 关门 → runMoa 直接返回 disabled 结果(能力惰性化,arena 单独使用不受影响)。
  KHY_MOA_AGGREGATOR: { mode: 'default-on', off: 'CANON', default: true },

  // ── /prompt 编辑器长提示词撰写(promptComposerService + 纯叶子 promptComposer)──
  // 移植自 Hermes v0.18.0 /prompt:在 $EDITOR 里从容撰写多行长提示词,存回后剥掉 #! 哨兵指引行、
  // trim,原样作为下一轮输入转发给 AI(不调模型、不落盘,临时文件用后即删)。撰写编排(建临时文件 /
  // 起编辑器 / 读回 / 删除)在服务层;剥离/归一由纯叶子 promptComposer 完成(零 IO、确定性、绝不抛)。
  // 开门 → `prompt compose` 可用;关门 → composeInEditor 直接返回 disabled 结果(能力惰性化,既有
  // prompt 库 save/list/use 不受影响)。
  KHY_PROMPT_COMPOSE: { mode: 'default-on', off: 'CANON', default: true },

  // ── Google Vertex AI 请求成形(纯叶子 vertexRequestShaping)──
  // 移植自 Hermes v0.18.0「支持 Google Vertex AI」:Vertex 复用 Gemini 线格式请求体,唯 URL 方案
  // (…-aiplatform.googleapis.com/…/projects/{project}/locations/{location}/publishers/google/models/
  // {model}:generateContent)与鉴权(OAuth2 access token 作 Authorization: Bearer)不同。叶子确定性地
  // 成形端点 URL / 基址 / 鉴权字段 / 体格式(零 IO、绝不抛、无模型名字面量)。开门 → describeVertexRequest
  // 正常成形;关门 → 直接返回 { ok:false, reason:'disabled' }(能力惰性化,不影响其他路由)。
  KHY_VERTEX_REQUEST_SHAPING: { mode: 'default-on', off: 'CANON', default: true },

  // ── relay 适配器错误体诊断(relayApiAdapter.handleResponse)──
  // 缺口:GLM/智谱等 SSE 端点在 4xx/5xx 时也回 `text/event-stream`,旧 handleResponse 对任何
  // event-stream 都当正常流 resolve `{ stream }` → 上层 `!res.stream` 诊断分支被跳过、错误体被 SSE
  // 解析器读成空 → 打印 `HTTP 400 ... detail:`(空),真错误码(1210/1211/1002…)永远看不到。开该门 →
  // 仅 2xx 的 event-stream 当正常流,非 2xx 一律排干响应体、保留 rawBody,让 4xx 诊断打印真错误码与
  // GLM 结构化 code;关 → 逐字节回退旧行为(任何 event-stream 当流、不留 rawBody)。
  KHY_RELAY_ERROR_BODY_DIAG: { mode: 'default-on', off: 'CANON', default: true },

  // ── GLM/智谱 code 1211「模型不存在」正名为 model_not_found(_errorClassifiers.classifyAdapterError)──
  // 缺口:智谱把「账号未领取该免费模型」的语义以 HTTP 400 + code 1211 + 中文「模型不存在」返回,
  // 而分类器的 model_not_found 只认英文串(model not found / does not exist)+ code 404 → 1211 漏网,
  // 降级成 bad_request → 视觉降级链(KHY_VISION_FALLBACK_CASCADE)、冷却放行、modelNotFoundRecovery
  // 恢复提示三处全部失灵。文本 glm-4.7-flash 与识图 glm-4.6v-flash 撞的是同一个 1211。开该门 →
  // 命中「模型不存在」或 `code…1211` 时正名为 model_not_found(语义等价:该模型对本账号不存在),
  // 使降级链改试账号可调的次选模型;关(0/false/off/no)→ 逐字节回退旧行为(→ bad_request)。
  KHY_GLM_CN_MODEL_NOT_FOUND: { mode: 'default-on', off: 'CANON', default: true },

  // ── relay_api 发线前剥离 khy 内部三段式路由 id(aiGateway.normalizeModelForAdapter)──
  // 回归根因:khy 内部路由 id 是 `api:<pool>:<model>` 三段式复合 id(例 `api:glm:glm-4.7-flash`),
  // 仅供内部选池,绝非可上线的 wire 模型名。`api` 适配器经 parseProviderModel 会剥成裸模型,
  // 但 `relay_api` 适配器把 model 直写进 HTTP body → 复合 id 原样发给 bigmodel → 每个模型都撞
  // 1211「模型不存在」(用户报「更新几个版本后所有模型都不存在了」正是此)。开该门 → relay_api
  // 发线前把 `api:pool:model` 剥成裸 `model`;关(0/false/off/no)→ 逐字节回退原样透传。
  // 只对 relay_api 生效,绝不动 api 适配器(它需要复合 id 解析池)。
  KHY_RELAY_COMPOSITE_MODEL_STRIP: { mode: 'default-on', off: 'CANON', default: true },

  // ── pip / npm 双渠道共存自检(cli.py `_pf_check_dual_install`)──
  // pip 与 npm 是并行安装渠道,各 bundle 一份独立 backend,可长期共存。真隐患不是「装了两个」,
  // 而是「升级一个渠道时另一个变陈旧,PATH 遮蔽下用户以为升了级其实没生效」。开该门 → 自检检测
  // PATH 上是否有多个 khy 启动器,若有则**告警但不叫用户卸载**,而是提示用 `khy update` 把两渠道
  // 一起升级同步;关 → 跳过该项检查。
  KHY_DUAL_INSTALL_CHECK: { mode: 'default-on', off: 'CANON', default: true },

  // ── khyos 自更新总门控(khySelfUpdateService)──
  // 关 → checkUpdate/applyUpdate 均返回 {disabled:true},禁掉一切自升级(装包)动作。
  KHY_SELF_UPDATE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 渠道感知自更新:pip 升级时顺带同步 npm 渠道(khySelfUpdateService)──
  // 用户诉求「不要卸载哪一个,希望相互兼容,pip 装的也支持 npm 更新」。开该门 → `khy update`
  // 在 pip 升级成功后,若检测到 npm 全局装有 @khy-os/khy-os,顺带 `npm install -g @khy-os/khy-os@latest`
  // 把两渠道同步到最新;关 → 逐字节回退旧单渠道行为(只升 pip)。npm 步骤 fail-soft,失败绝不影响
  // pip 结果。
  KHY_MULTI_CHANNEL_SYNC: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_SELF_UPDATE' },

  // ── 更新时实时显示 pip 下载进度(routerDispatchOps case 'update')──
  // 用户诉求「khy update 更新时不显示下载进度」。旧路径用 execSync 整段捕获 pip 输出,跑完才出结果、
  // 全程静默。开该门 → 用 spawn 把 pip 的 Collecting/Downloading(带 MB 计数)/Installing 输出实时 tee
  // 到终端,同时累积到 buffer 供残骸清理/成功判定/失败分类(output 语义不变);关 → 逐字节回退旧
  // execSync 捕获(无实时进度)。仅在交互式 `khy update` 生效(applyUpdate 结构化路径始终捕获,不流式)。
  KHY_UPDATE_STREAM_PROGRESS: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_SELF_UPDATE' },

  // ── 文件占用(WinError 32)一次性自动重试(pipFailurePolicy.buildLockRetryPlan;routerDispatchOps +
  //    khySelfUpdateService.applyUpdate)──
  // 用户诉求「pip 安装时往往又要到第二次才成功」。WinError 32 是 khy 常驻进程/半装残骸持有 bundle 文件
  // 句柄导致 pip 覆盖失败,旧逻辑判为 file-locked 后只诊断并放弃 → 用户被迫再敲一次。开该门 → 停占用
  // 进程 + 清 ~ 前缀残骸 + 等待句柄释放后,以 --force-reinstall --no-cache-dir 干净覆盖重试一次(全局仅
  // 一次);关 → 逐字节回退旧「放弃并诊断」行为。运行时另受 KHY_PIP_FAILURE_POLICY 总策略门约束。
  KHY_UPDATE_LOCK_RETRY: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_SELF_UPDATE' },

  // ── 透明视觉降级(OCR/读不出)时顺带邀请配置 GLM 视觉 key(visionOcrFallback;/goal 收尾「接上」)──
  // 透明视觉路在「GLM 视觉门控开、但用户尚未配置 GLM key」时无法改道 GLM 视觉端点
  // (aiGateway 的 hasAvailableKeys('glm') 守卫「无 GLM key 绝不路由到它」),只能退回 OCR 文字 /
  // 「读不出」提示。用户其实离能直接看图只差一个 key,却无任何邀约。开该门 → 在这两种降级分支的
  // prompt 末尾注入一句面向模型的指令,让模型主动、简短地问用户「要不要配 GLM 视觉 key,配好后我就能
  // 直接看图」;关 → 不注入、逐字节回退。仅在调用方确认「门控开且 GLM key 缺失」时生效。parent 上门。
  KHY_VISION_OCR_KEY_INVITE: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GLM_VISION_MODEL' },

  // ── 低置信 OCR 兜底诚实告诫(ocrConfidenceCaveat;/goal 2026-07-11「纯文本模型 + 图片 →
  // 本地 OCR 兜底提取图片信息」的正交诚实缺口)────────────────────────────────────────────
  // 纯文本/非多模态模型收不到图,khy 用本地 tesseract OCR 把图中文字提取出来、以「请据此作答」
  // 注入 prompt 当权威依据。但 OCR 引擎自评的置信度(pytesseract 的 avg_conf、CLI 路径的
  // txt+tsv 平均分)一路被丢弃 → 低置信(误识/漏识)的文字被文本模型当铁定事实自信作答,用户
  // 拿到错误答案却毫不知情。开该门 → 当且仅当有**正向**低置信信号(needsAiFallback 或
  // confidence∈(0,60))时,在 OCR 文本块后追加一句诚实告诫;关 → 不注入、逐字节回退。
  // 诚实边界:置信未知(CLI 无 tsv → confidence=0)绝不告诫,不把「没测量」谎报成「低」。
  KHY_OCR_LOW_CONFIDENCE_CAVEAT: { mode: 'default-on', off: 'CANON', default: true },
  // OCR 兜底「覆盖率」诚实(ocrCoverageNotice):OCR 文本未覆盖全部输入图片(超单次上限被丢 /
  // 部分图片读不出)时,追加一句诚实告诫,别让文本模型默认已看到所有图片。与置信度告诫正交。
  KHY_OCR_COVERAGE_NOTICE: { mode: 'default-on', off: 'CANON', default: true },
  // OCR 兜底「单图内文本完整性」诚实(ocrTruncationNotice):单张稠密图片的 OCR 全文超过 maxChars
  // 被截断(只保留前一部分、尾部丢弃)时,追加一句诚实告诫,别让文本模型把残缺文本当完整依据。
  // 与置信度(准确性)、覆盖率(跨图完整性)两门正交,补「单图内文本完整性」维度。
  KHY_OCR_TRUNCATION_NOTICE: { mode: 'default-on', off: 'CANON', default: true },
  // OCR 兜底「语言包可用性」诚实(ocrLanguageNotice):khy 请求的 OCR 语言(chi_sim+eng)在本机缺
  // traineddata 时被静默窄化成子集,被丢弃语言(如缺 chi_sim 时的中文)的文字根本无法识别 → 追加告诫,
  // 别让文本模型把英文模型对中文图的乱码转写当权威。与准确性/覆盖率/截断三门正交,直击「无识图模型下准确识别」。
  KHY_OCR_LANGUAGE_NOTICE: { mode: 'default-on', off: 'CANON', default: true },

  // OCR 兜底「图片方向自动校正」—— 唯一的纠正型轴(docHelper._maybe_reorient + ocrOrientationNotice)。
  // 正向读取很弱(侧拍/旋转图读出置信度不低的乱码,如旋转 90° 的发票读成 '9202 AWOV ADIOANI' conf 51)
  // 时,暴力试 90/180/270 取置信度最高的可读结果把文字真正复原(旋正后 conf 91),并把「文本取自旋正后
  // 的图」告知模型。同门同时控 docHelper 纠正与告诫。关 → 不旋转、逐字节回退历史行为。直击「无识图模型下
  // 准确识别图片」,尤其被旋转的图。off-words CANON {0,false,off,no}。
  KHY_OCR_AUTO_ORIENT: { mode: 'default-on', off: 'CANON', default: true },

  // OCR 兜底「低分辨率图片自动放大」—— 第二条纠正型轴(docHelper._maybe_upscale + ocrResolutionNotice)。
  // 图片过小/低分辨率时 tesseract 原尺寸常一个字读不出(实测 102×10 的 'INVOICE' 裁剪原尺寸返回空),
  // 暴力试 2×/3×/4× 放大(单一固定倍数不可靠:3× 漏读而 2×/4× 成功)取置信度最高的可读结果真正复原
  // 文字(放大 2× 后 conf 96),并把「文本取自放大后的图」告知模型。同门同时控 docHelper 放大与告诫。
  // 关 → 不放大、逐字节回退历史单尺度行为。直击「无识图模型下准确识别图片」,尤其分辨率过低的小图。
  // off-words CANON {0,false,off,no}。
  KHY_OCR_UPSCALE: { mode: 'default-on', off: 'CANON', default: true },

  // OCR 兜底「使用 OCR 透明告知」—— OCR **成功路径**上的用户可见披露(ocrUsageNotice)。前六条诚实轴
  // 全是条件型告诫(只在低置信/超上限/截断/语言窄化/旋正/放大时触发);OCR **干净成功**时它们一条都
  // 不触发,注入的只有面向模型的「据 OCR 文本作答」头,从不要求模型告诉**用户**这段内容是经 OCR 读取
  // 而非原生看图 → 模型像亲眼看图一样作答,用户全程不知用了 OCR。本门在 OCR 成功注入文本时**无条件**
  // 追加一句面向模型的指令,要求它用一句自然、简短的话向用户明确说明「本次图片内容是通过 OCR 文字识别
  // 读取的」——无感但明显。直击本轮「Khy 降级到 OCR,要能无感明显告知用户用了 OCR 但正确识别图片」。
  // 关 → buildUsageDisclosure 返 null、不注入,逐字节回退历史「据 OCR 作答但不向用户披露」行为。
  // off-words CANON {0,false,off,no}。
  KHY_OCR_USAGE_DISCLOSURE: { mode: 'default-on', off: 'CANON', default: true },

  // ── OCR「使用 OCR」确定性脚注(ocrUsageFootnote;OPS-MAN-126,承 OPS-124)────────────
  // OPS-124 只在 prompt 里给模型一条**指令**要求它披露用了 OCR;模型可忽略 → 用户不知情。本门
  // 在 finishResult 成功侧确定性追加一句用户可见脚注(仅当确有 OCR 文本读出、作答成功、且正文
  // 尚未提到 OCR 时),保证「明显」触达。与 OPS-124 去重协同(模型已披露则不追加,保持无感)。
  // 关 → buildOcrUsageFootnote 返 null、不追加,result.content 逐字节回退。off-words CANON。
  KHY_OCR_USAGE_FOOTNOTE: { mode: 'default-on', off: 'CANON', default: true },

  // ── OCR 兜底「实时状态」层透明告知(ocrRescueStatusNotice;OPS-MAN-127,承 OPS-124/126)──────
  // OPS-124(prompt 指令)、OPS-126(答复脚注)兜住**答复层**的「用了 OCR」披露;本门补**实时进度层**。
  // prep 期 Site1/Site2 的 OCR 成功都发一条 emitStatus 当场告知已降级到 OCR,唯独 post-failure 救援网
  // Site3(用户实测 gpt-4o keep→运行时 404→救援网路径)的 OCR-**成功**分支从不 emitStatus → 恰在复现
  // 路径上实时进度层沉默。本门在 Site3 成功分支补齐实时状态,与 Site1/Site2 对齐。关 → buildOcrRescueStatus
  // 返 null、不 emitStatus,逐字节回退历史「Site3 成功分支静默」。off-words CANON {0,false,off,no}。
  KHY_OCR_RESCUE_STATUS: { mode: 'default-on', off: 'CANON', default: true },

  // ── OCR 兜底「实时状态」prep 期非 verbose 补齐(ocrRescueStatusNotice;OPS-MAN-129,承 OPS-127)──
  // OPS-127 把 Site3 的「已降级到 OCR」实时状态做成**无条件**发送;但 prep 期 Site1/Site2 的既有
  // emitStatus 都嵌在 `if (_isVerbose)` 里 → **非 verbose 会话**在 prep 期 OCR 降级时实时进度层仍沉默,
  // 与 Site3 不对称。本门把无条件实时状态扩到 prep 期 Site1/Site2,专补非 verbose 用户缺口(verbose
  // 用户已有既有状态,调用点用 !_isVerbose 守卫避免重复)。关 → buildOcrRescuePrepStatus 返 null、
  // 不 emitStatus,逐字节回退历史「非 verbose prep 期静默」。off-words CANON {0,false,off,no}。
  KHY_OCR_RESCUE_STATUS_PREP: { mode: 'default-on', off: 'CANON', default: true },

  // ── Site1 prep-status 与 OCR-成功闭合的跨层去重(ocrRescueStatusNotice;OPS-MAN-148,承 OPS-132+OPS-144
  // 「减少显示的心灵噪音」)── 用户复现的确切路径(非 verbose · describe 级联全失败 → 本地 OCR 成功)上,
  // 「已降级到 OCR 并成功识别」被两层各发一遍且都是永久行:OPS-132 prep-status(含「成功」→ 被 emitRuntimeStatus
  // 误分类为永久「模型已连接」行)+ OPS-144 闭合 assistant_message。闭合落地后,恰在 Site1 这条路径上闭合已
  // 交付「明显告知用了 OCR」,prep-status 沦为冗余且措辞更差的第二遍公告。本门(shouldSuppressPrepForClosure)
  // 让 Site1 在**闭合确将发射时**(_intermediateEnabled && 闭合门开)抑制冗余 prep-status,只留更清晰的闭合。
  // ★仅 Site1:Site2(ocr-fallback 无级联无闭合)始终保留 prep-status。关/异常 → 不抑制(prep+闭合并存)=
  // 逐字节回退历史行为。off-words CANON {0,false,off,no}。
  KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP: { mode: 'default-on', off: 'CANON', default: true },

  // ── 图像识别失败总结 + 配置视觉模型 key 邀约(visionFailureSummary;/goal「不能说智谱失败,
  // 文本模型也失败,失败要一个总结,并询问是否需要帮忙配置 GLM 或其他合适的图像识别模型的 apikey」)──
  // 识图工具(RecognizeImage)底层经 gateway.generate 调视觉模型失败时(如 GLM 401),原本只甩
  // 原始报错 `图像识别失败: 智谱AI: Request failed with status code 401`——既把锅窄化到单一
  // provider,又对用户毫无出路。开该门 → 失败返回改为「诚实定性总结 + 脱敏真因 + 是否帮忙配置
  // GLM/其他图像识别模型 API Key 的邀约」;关 → 逐字节回退到旧文案 `图像识别失败: <raw>`。
  KHY_VISION_FAILURE_SUMMARY: { mode: 'default-on', off: 'CANON', default: true },

  // ── 失败墙推迟到 OCR 结果已知之后(visionFailureSummary OCR suppress;/goal「减少显示的心灵噪音」)──
  // 上面的失败总结墙(含「粘贴 API Key」邀约)在 aiGatewayGenerateMethod 里于 **OCR 兜底之前**
  // 无条件发射:视觉级联全失败 → 立刻甩「图像识别失败 + 配置 key」大块墙 → 之后才跑本地 OCR。
  // 当图是 **含字图**、随后本地 OCR **成功读出文字**时,那块吓人失败墙已经先甩给用户了——与紧接着的
  // 「已用 OCR 成功识别图片」自相矛盾,是日志里最响的心灵噪音。该门 default-on → 调用方把失败墙
  // **推迟**到 OCR 结果已知之后:OCR 成功读出 → 抑制墙(不发);OCR 读空 / 提取失败 → 照常发射(真失败)。
  // 关(KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS=off)→ 逐字节回退旧行为(墙在 OCR 之前无条件发射)。
  // 与 KHY_VISION_FAILURE_SUMMARY 正交:父门治「墙的文案是否为诚实总结」,本门治「墙在 OCR 成功时是否还发」。
  KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS: { mode: 'default-on', off: 'CANON', default: true },

  // ── 视觉路由用户可见中间消息(visionIntermediateMessage;/goal「用户发送图片给文本模型，
  // 文本模型需要明确说明我无法识别所以路由给视觉识别模型，等待它传回结果」)────────────────
  // describe-and-return 默认行为:静默调视觉模型识图 → 把描述注入文本模型 prompt → 文本模型作答,
  // 用户完全看不到中间的视觉路由过程(只在 verbose 日志里有 status 行)。开该门 → 在视觉识别前后
  // 发送两条 type:'assistant_message' chunk:①「我无法直接识别图片内容。正在调用 <视觉模型>
  // 进行识别，请稍候...」;②「视觉识别完成，正在根据识别结果为您作答。」让用户明确看到路由
  // 过程与等待原因;关 → 逐字节回退静默行为(零用户可见中间消息)。仅在 describe-and-return 开启时
  // 生效(KHY_VISION_DESCRIBE_RETURN 门控);switch-model 分支已直接切换无中间消息。
  KHY_VISION_INTERMEDIATE_MESSAGE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 级联「每候选提示」减冗余(visionCascadeAttemptNotice;/goal「减少显示的心灵噪音」)──────────
  // KHY_VISION_INTERMEDIATE_MESSAGE 在 describe-and-return 级联的 `for (_att of _attempts)` 循环里,
  // 对**每个**视觉候选发一条「我无法直接识别图片内容。正在调用 <model> 进行识别，请稍候...」。当级联
  // 有 N 个候选(实测:glm/glm-4.6v-flash + glm-4v-flash)时首句逐字节重复 N 遍,且候选 2..N 其实是
  // 候选 1 已失败后的兜底却读起来像并行新调用 = 冗余噪音 + 语义不准。该门 default-on → 首候选保留
  // 完整首句,后续候选去掉冗余首句改为「视觉模型 <prev> 不可用，正在改用 <model> 继续识别...」(与成功侧
  // 「已自动改用 Y 完成识别」promise→resolution 对称);关 → 对所有候选逐字节回退历史首句。共享
  // _intermediateEnabled 父前提(仅中间消息门开时接线)。与 KHY_VISION_OCR_SUCCESS_CLOSURE(OPS-144,
  // 治级联全失败后的闭合)正交:本门治级联进行中每候选提示的冗余。
  KHY_VISION_CASCADE_ATTEMPT_NOTICE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 视觉模型名「显示归一」去 provider 前缀(visionModelDisplayName;OPS-MAN-150):describe 级联 `_attempts[0]` 保留内部 poolHint 前缀 `glm/…` 泄漏进 prose,门开去前缀保大小写。
  KHY_VISION_MODEL_DISPLAY_NAME: { mode: 'default-on', off: 'CANON', default: true },

  // ── 失败墙「真实失败原因」标签去重(visionFailureSummary;OPS-MAN-161 承 OPS-159):真因已自带 `真实失败原因:` 标签,墙再前置一次=stutter,门开剥自带标签只留一次,关逐字节回退。
  KHY_VISION_FAILURE_CAUSE_DEDUP: { mode: 'default-on', off: 'CANON', default: true },

  // ── 视觉池失败状态「人话化」(visionPoolFailStatus;OPS-MAN-164;/goal「减少显示的心灵噪音」):OCR
  // 已兜底成功时 `visionpool 失败: 404` 是次级噪音,门开+OCR 已读+池名含 vision → 换「视觉通道当前不可用,已用本地 OCR 兜底」,关/非兜底/非视觉池逐字节回退。
  KHY_VISION_POOL_FAIL_STATUS_HUMANIZE: { mode: 'default-on', off: 'CANON', default: true },

  // ── describe-fail → OCR-成功的用户可见闭合消息(visionOcrSuccessClosure;/goal「无感明显告知
  // 用户用了 ocr」+「减少显示的心灵噪音」)──────────────────────────────────────────────────
  // KHY_VISION_INTERMEDIATE_MESSAGE 在**每个候选视觉模型**识别前发一条「正在调用 <模型>,请稍候...」
  // 承诺,并在 describe **成功**时于 line 1554 发一条闭合「视觉识别完成,正在根据识别结果为您作答」。
  // 但当所有视觉模型都失败、随后本地 OCR **成功**读出文字时,那 N 条「请稍候」承诺**无人闭合**——
  // 用户看到 N 个悬空的「正在调用...请稍候」却永远等不到「识别完成」,既是心灵噪音又漏掉「已改用 OCR」告知。
  // 该门 default-on → 在 OCR-成功兜底分支追加**一条**闭合「视觉模型均不可用,已改用本地 OCR 成功识别
  // <N 张>图片,正在据此作答」:既闭合悬空承诺,又在中间消息层无感明显告知已降级到 OCR;
  // 关 → 逐字节回退(OCR-成功分支不发闭合,悬空承诺照旧)。仅在 KHY_VISION_INTERMEDIATE_MESSAGE
  // 也开启时接线(共享 _intermediateEnabled 前提);与 OPS-142 失败墙抑制正交(那治墙、本治悬空承诺闭合)。
  KHY_VISION_OCR_SUCCESS_CLOSURE: { mode: 'default-on', off: 'CANON', default: true },

  // ── Python 解释器解析调试行静默(pythonPathQuiet;/goal「同时减少显示的心灵噪音」)────────────
  // utils/pythonPath.js findPython() 每次为 OCR / 文档转换子进程解析解释器,原本无条件
  // `console.log("Using Python executable: <绝对路径>")`——纯调试日志却直冲用户终端(实测 vision→OCR
  // 兜底一屏刷出 `Using Python executable: D:\Python312\python.exe` 并泄漏本机路径),从不为用户服务。
  // 该门 default-on(静默)→ 解析成功两条 log + 兜底 warn 全消音;关(KHY_PYTHON_PATH_QUIET=off)→
  // 逐字节回退旧 verbose 行为(本地排障用)。与 KHY_VISION_INTERMEDIATE_MESSAGE / KHY_VISION_FAILURE_SUMMARY
  // 正交:那两门治「用户可见的、有意的」路由/失败告知(默认保留=明显告知),本门治「无意泄漏的」纯调试噪音。
  KHY_PYTHON_PATH_QUIET: { mode: 'default-on', off: 'CANON', default: true },

  // ── 回合内用户可见中间消息逐字节去重(visionNoticeDedup;/goal「同时减少显示的心灵噪音」)──────
  // 纯文本模型 + 带图 → 视觉描述级联在 agentic 工具循环里被多次迭代重入(实测一个回合内
  // `正在调用 <模型> 请稍候...` 6 次、大块 `图像识别失败:...` 3 次)。每次 emitAssistantMessage 都渲染
  // 一条 assistant_message → 同一句话一个回合刷屏三遍 = 心灵噪音。开该门 → REPL 在回合作用域按逐字节
  // 签名去重,首次照常「明显告知」,后续逐字节重复的中间消息压制;关(KHY_VISION_NOTICE_DEDUP=off)→
  // 逐字节回退旧「每条都渲染」行为。与 KHY_VISION_INTERMEDIATE_MESSAGE / KHY_VISION_FAILURE_SUMMARY
  // 正交:那两门治「是否告知」(内容默认保留),本门治「同一告知在一个回合里重复几遍」。保留每条不同的
  // 中间消息(不同模型名 / 不同失败真因 → 签名不同 → 全渲染),只折叠完全一致的重复。
  KHY_VISION_NOTICE_DEDUP: { mode: 'default-on', off: 'CANON', default: true },

  // ── relay_api 通道外来模型防护(relayModelGuard;用户实测:auto 讲笑话 → 404 model_not_found)──
  // auto/级联失效切换时,一个只属于其它通道的 model id 会被原样带给 relay_api。实测:选 auto →
  // auto 选中 api/agnes(自定义 provider,经代理路由表正确服务 agnes-2.0-flash)→ 该通道降级 →
  // 级联把 agnes-2.0-flash 带到 relay_api → 打到 api.trae.ai(trae 不认识 agnes)→ 404
  // model_not_found → 缓存 cooldown。normalizeModelForAdapter 对 claude 通道早有对称防护(非
  // claude-* → 丢弃用默认),唯 relay_api 缺失。开该门 → relay_api 上不属其可服务家族的外来模型
  // 丢弃为 null(用通道默认模型);关 → 逐字节回退(原样透传外来 id=今日行为)。仅治 relay_api,
  // 不碰 api 代理(它 honor PROXY_MODEL_ROUTE_MAP 能正确转发自定义 provider)。
  KHY_RELAY_MODEL_GUARD: { mode: 'default-on', off: 'CANON', default: true },

  // ── api 通配兜底守卫(wildcardPoolGuard;用户实测:agnes-2.0-flash → open.bigmodel.cn 400 code 1211)──
  // `api` 通道的 pool 解析末位是**盲通配** GATEWAY_API_POOL_PROVIDER:一个裸模型名(无 `:`/`/`)
  // 在显式 apiPoolProvider / provider / scoped 前缀全落空后,直接被塞进通配默认池,不做任何「厂商
  // vs 池」核对。实测 agnes 是已登记 provider preset(端点 apihub.agnes-ai.com)但运行时池无 agnes
  // → 通配池(.env=relay→glm 服务)让它继承 open.bigmodel.cn 端点 → 400「模型不存在」。开该门 →
  // 当裸模型厂商是已知 preset 却无运行时池、且≠通配池时,判定 mismatch,_resolveApiPoolProviderForRequest
  // 不再盲落(返回 null),转清晰失败 + 登记/pool:model 指引;关 → 逐字节回退(原样盲落=今日行为)。
  // 对称于 relay_api 的 relayModelGuard;显式 pool:model / provider 命中的路由永不受影响。
  KHY_WILDCARD_POOL_GUARD: { mode: 'default-on', off: 'CANON', default: true },

  // ── relay_api 跨厂商错配守卫(relayVendorMismatchGuard;用户实测:RELAY_API_ENDPOINT 指到
  // open.bigmodel.cn(智谱 GLM 官方 host)却发 agnes-2.0-flash(Agnes 模型)→ 400 code 1211)──
  // wildcardPoolGuard 只据「裸模型厂商 vs 通配池」判定(拿不到真实端点);relayModelGuard 的可服务
  // 家族是**端点无关**的静态表(围绕 api.trae.ai 假设),且会被 RELAY_API_MODEL 默认值重新喂回同一
  // 外来模型。二者都罩不到「端点=某厂商官方 host、模型属另一厂商」这一类。开该门 → relayApiAdapter
  // 发请求前据 providerPresets 单一真源派生「端点厂商 vs 模型厂商」,确证不同则以清晰可执行提示短路
  // (改端点/改模型/pool:model),而非把含糊的 1211 甩给用户;关 → 逐字节回退(原样发送=今日行为)。
  // 保守:自定义 relay(未知 host)或模型厂商无法确证一律放行,绝不误伤「一个 relay 代理多家」。
  KHY_RELAY_VENDOR_GUARD: { mode: 'default-on', off: 'CANON', default: true },

  // ── model_not_found(404)硬失败的可执行恢复指引(modelNotFoundRecovery;/goal「驱动 khyos
  // 解决这个错误」，图示 auto::api、`api:agnes:agnes-2.0-flash` → `api [model_not_found]` 404)──
  // 自定义 provider(agnes)注册时给每个模型写入 PROXY_MODEL_ROUTE_MAP 的 strict:true 路由 →
  // 即便 auto 模式落到该 provider 也被判为 userPinned strict → 上游 404 model_not_found 时,
  // strict 硬失败路径(_shouldRelaxStrictPreferredOnFailure 只放宽 process/timeout/network 瞬时
  // 故障,userPinned 一律不放宽)把裸 `Request failed with status code 404` 吐给用户;而
  // buildPreferredAdapterRecoveryHint 无 model_not_found 分支 → 只落最弱通用提示,用户看不出
  // 「模型名/端点配错」这一真实症结。model_not_found 是永久配置错误(非 auth、非瞬时),不宜在
  // 本通道内重试、也不宜擅自级联替换用户所选模型。开该门 → recovery hint 追加两行可执行指引
  // (点明性质 + 改选该端点确有的模型 / 核对 provider 模型名与 base URL);关或非 model_not_found →
  // 逐字节回退今日通用提示。errorType 由三处 strict 硬失败点透传(裸 404 消息不含类型词)。
  KHY_MODEL_NOT_FOUND_RECOVERY: { mode: 'default-on', off: 'CANON', default: true },

  // model_not_found 的 fast-fail 冷却从「按通道」收窄为「按模型」(modelNotFoundCooldownScope)。
  // 根因:复合路由 id(api:glm:glm-4.6v-flash)漏到上游撞 404 → 冷却写到整条 api 通道(30s),随后
  // 剥成裸名 glm-4.6v-flash 的**修正**请求被同一通道冷却直接 fast-fail 短路,吐陈旧「recent
  // model_not_found failure cached」——而该裸名模型明明可用(此前甚至报过 token 超限=已送达上游)。
  // 开该门 → 当前请求模型串 ≠ 造成 404 的模型串(如剥裸名后)则放行做真实尝试,当轮救回;相同模型串
  // 仍尊重冷却(不硬撞确实不存在的模型)。关 / 缺当前或缓存模型串 → 逐字节回退今日按通道冷却。parent 上门。
  KHY_MNF_COOLDOWN_PER_MODEL: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_MODEL_NOT_FOUND_RECOVERY' },

  // model_not_found 显示纠偏(modelExistenceEvidence):有证据表明模型已送达上游(参数/token 类报错、
  // 或送出串为复合 id)时,为「真实失败原因」行追加注解——消解「刚嫌 token 太大、转头又说找不到模型」的
  // 自相矛盾。只改显示不改分类;关或无证据 → 逐字节回退原行。parent 上门。
  KHY_MNF_EXISTENCE_NOTE: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_MODEL_NOT_FOUND_RECOVERY' },

  // 「真实失败原因」列表让本轮新鲜 live 失败(真实 statusCode)排在陈旧缓存跳过
  // (virtualSkip / statusCode:0 / "failure cached cooldown Ns")之前。修 429 现场被
  // 238s 陈旧 404 缓存冒名顶替的乱序。稳定分区不改集合、只改呈现序。关即逐字回退插入序。
  KHY_FAILURE_REASON_RANKING: { mode: 'default-on', off: 'CANON', default: true },

  // ── 安装台账(installLedger;「khy 写进宿主 exe/CLI 后怎么保证卸载干净」)──────────
  // 在**创建副作用的当刻**追加记录「实际写了什么」到 ~/.khy/.install-ledger.jsonl;
  // 卸载时逆序读台账回滚(撤注册/删运行时创建物/停进程),是 allowlist 猜测之外的兜底真源。
  // 开 → 副作用创建点记一条、uninstall 停进程+读台账回滚;关 → 台账不写不读,
  // uninstall 逐字节回退到当前 allowlist 行为(零回归)。真 key 永不落台账。
  KHY_INSTALL_LEDGER: { mode: 'default-on', off: 'CANON', default: true },

  // ── 模型列表视觉徽章(_formatVisionTag;/goal「glm-4.6v-flash 要能看见并标注视觉理解模型」)──
  // `khy gateway model` 选择器过去对模型能力一无标注,用户无法在列表里一眼认出哪个是视觉理解模型
  // (如 glm-4.6v-flash)。开 → 具备识图能力的模型行追加「👁 视觉」徽章(判定复用单一真源
  // visionCapability.isVisionCapableModel:GLM glm-4.6v 子串 + KHY_VISION_MODELS + modern hints,
  // 或 model.modality==='vision')。关 → _formatVisionTag 返 '' → 选择器行逐字节回退(不含徽章)。
  KHY_MODEL_VISION_BADGE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 延迟感知路由(routeLatencyPenalty;/goal「优化路由网关算法提升用户体验」)────────────
  // 默认罚分器 _assessDefaultRouteCandidate 对「延迟」一无所知——两个都健康的通道,一个
  // 首字 800ms、一个 6s,排名完全等价。开 → 健康但慢的通道在**健康集内部**轻度降权破平局
  // (软罚分硬顶 healthyPenaltyCeiling-1,绝不 blocked、绝不越健康集,慢≠不可用);冷启动/
  // 陈旧样本不判罚。关 → 消费点不加延迟罚分,totalPenalty/score/排名逐字节回退今天。
  KHY_ROUTE_LATENCY_AWARE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 现代多模态模型族名字提示扩展(modernVisionHints;/goal「完善…视觉理解」)──────────
  // visionCapability 的 VISION_NAME_HINTS 刻意保守,漏掉了若干**当代原生多模态**模型族——
  // 名字不含任何现有片段:llama-4-*(Meta Llama 4,原生多模态)、gpt-4.1*(收图)、glm-4.5v
  // (与 GLM 叶子处理的 4.6v 不同代)、grok-4(收图)、amazon nova-lite/pro(多模态)、gemma-3
  // (多模态)、mistral-small-3.1/3.2(多模态)。这些型号真发带图请求会被误判纯文本 → 被无谓
  // 退回 OCR。开该门 → visionCapability 额外用这组保守片段判「支持视觉」;关 → 逐字节回退
  // (这些型号不被这层识别,仍走原 VISION_NAME_HINTS/其它集)。片段刻意精确避免误伤(如
  // 用 'llama-4' 而非裸 '4',用 'gpt-4.1' 而非 '4.1')。
  KHY_MODERN_VISION_HINTS: { mode: 'default-on', off: 'CANON', default: true },

  // ── 生成模型排除:image/视频「生成型号」不当视觉输入(visionGenerationExclusion;真实 bug)──
  // visionCapability 的 VISION_NAME_HINTS 含裸片段 'image',把**图像生成模型**(名字带 image、
  // 只生成图、不收图,如自定义 provider 的 agnes-image-2.1-flash)误判为「支持视觉输入」。后果:
  // 纯文本模型收到图 → decideVisionRouting 在同池兄弟里 pickVisionCandidate 选中该生成型号 →
  // 自动改选 options.model 为它 → 图像被发到生成端点 → 上游 model_not_found/400/404。既有纠正
  // (精确 id 名单 BUILTIN_TEXT_ONLY_MODELS)只两个 SenseNova id,无法枚举任意 provider 的生成型号。
  // 开该门 → 按「媒体生成命名规律」(image/video 生成家族)在 name-hint 之前强制判其为纯文本 →
  // 不被选作视觉候选 → 退回 OCR/诚实说明,绝不误发到生成端点;关 → 逐字节回退('image' 片段照旧
  // 命中误判)。优先级低于用户 env KHY_VISION_MODELS(在 visionCapability 更早处判、命中即 true)。
  KHY_VISION_GENERATION_EXCLUSION: { mode: 'default-on', off: 'CANON', default: true },

  // ── 透明视觉路由:describe-and-return(visionDescribeReturn;用户诉求「回传文本模型」)──
  // 纯文本模型直接收图时,既有 switch-model 把 options.model **替换**成视觉模型 → 视觉模型
  // 直接接管整轮作答,用户选定的(往往更强的)文本模型这一轮不参与。开该门(默认)→ 改为
  // describe-and-return:视觉模型**只描述**图片 → 描述文本注入 prompt → **原文本模型**据此作答
  // (代价:一轮两次模型调用)。关(0/false/off/no)→ 逐字节回退到 switch-model 替换(单次调用)。
  // 描述失败/叶子不可用亦回退 switch 替换,不违反「非视觉模型永不收到裸图」不变量。
  KHY_VISION_DESCRIBE_RETURN: { mode: 'default-on', off: 'CANON', default: true },

  // ── describe-and-return 失败时自动换备用视觉模型(visionFallbackCandidates;用户诉求「路由模型
  // 不能用应由文本模型说明原因,并且可以帮忙替换」→ 二次确认「两者都要」)────────────────────
  // 旧行为:主视觉模型描述失败 → 静默切到**同一个刚失败的模型**(decision.model)→ 下游几乎必然
  // 二次失败(no_key/auth/404),用户只见原始报错或荒谬的「我没收到图片」。开该门(默认)→ 描述
  // 失败时先用 collectVisionFallbackCandidates 枚举「有 key 的、视觉可用的、≠ 失败模型」的备用视觉
  // 模型,按 GLM 优先顺序逐个再试描述;全部失败才落诚实说明兜底(见 KHY_VISION_FAILURE_SUMMARY)。
  // 关(0/false/off/no)→ 只试主视觉模型一次(逐字节回退单次尝试)。parent 上门:describe-and-return
  // 关则本门必关(级联只在 describe-and-return 内生效)。视觉判定/有 key 判定复用既有单一真源。
  KHY_VISION_FALLBACK_CASCADE: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_VISION_DESCRIBE_RETURN' },

  // ── describe-and-return 级联全失败后「剥图 + OCR + 底线」与失败说明**解耦**(visionOcrFallback
  //    .isDescribeFailFloorEnabled;修 2026-07-12「Khy 无法正确读图 / 消息里没有附带图片」)──────
  // 历史缺陷:视觉描述级联全失败后,那段「剥图 + OCR 兜底 +『图片确实收到但读不出』诚实底线」的
  // **安全不变量**代码被错误地嵌进 `if (_summaryOn)`(_summaryOn = KHY_VISION_FAILURE_SUMMARY,纯
  // 装饰门)。当用户关掉失败说明门,底线被一并跳过 → 控制流落到 switch 替换,把读不出的图**留着**
  // 改投**刚刚 404 的视觉模型**,最终文本模型在**毫无「图片存在」说明**下作答 → 如实却荒谬地回
  // 「消息里没有附带图片」。开该门(默认)→ 无论是否展示失败说明,描述级联全失败时都剥图 + OCR +
  // 底线,保证「非视觉模型永不收到裸图」且「绝不谎称没收到图」两不变量。关(0/false/off/no)→
  // 逐字节回退旧行为(底线仅在 _summaryOn 触发,再落 switch 替换)。与 KHY_VISION_OCR_FALLBACK
  // (控制 buildVisionUnreadableNote 文案本身)正交:那个管「底线文案渲不渲」,本门管「描述级联全
  // 失败这条路径要不要执行底线」。
  KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR: { mode: 'default-on', off: 'CANON', default: true },

  // ── 剥图 ⟹ 必留「收到图但读不出」痕迹的不可再降底线(visionOcrFallback.buildStrippedImageFloorNote)──
  // 历史缺陷(2026-07-12 用户实测「Khy 无法正确读图 / 消息里没有附带图片」的**第二条断桥**):
  // 描述级联全失败的 else 分支(OCR 无文本)里,剥图是**无条件**的(images: undefined),但
  // 「收到图但读不出」说明 buildVisionUnreadableNote 受 KHY_VISION_OCR_FALLBACK(OCR **功能门**)
  // 约束——用户关掉 OCR 兜底功能时该文案返 null → 说明不注入,**图却照样被剥** → 文本模型收到
  // 无图无说明的裸 prompt → 谎称「消息里没有附带图片 / 当前对话中没有任何图片附件」。开该门
  // (默认)→ 当 buildVisionUnreadableNote 因 OCR 功能门关/叶子不可用返 null 时,退回不提 OCR 的
  // 最小底线,保住「剥图必留痕」不变量。关(0/false/off/no)→ 逐字节回退旧行为(剥图无痕)。
  // 与 KHY_VISION_OCR_FALLBACK 正交:那个管「OCR 说明文案本身渲不渲」,本门管「说明渲不出时要不
  // 要用最小底线兜住剥图」;与 KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR 正交:那个管「这条路径要不要
  // 执行底线」(OPS-118),本门管「底线文案缺席时剥图别裸奔」(OPS-120)。
  KHY_VISION_STRIP_IMAGE_FLOOR: { mode: 'default-on', off: 'CANON', default: true },

  // post-failure vision-fallback OCR 救援网(shouldOcrRescue → _visionFallback)的第三处
  // 「剥图 ⟹ 必留痕」不变量门。背景(2026-07-12 用户实测「Khy 无法正确读图·降级到 ocr」):
  // 该救援网 OCR **提取到文本**时剥图 + 注入 OCR 文本(既有);但 OCR **无文本 / 抛错**时历史上
  // 只 emitStatus 就 break → 级联带着裸图继续 → 下游纯文本适配器静默丢图作答 → 谎称「消息里
  // 没有附带图片」。开该门(默认)→ 救援网 OCR 无文本时剥图 + 注入诚实底线(buildVisionUnreadableNote
  // → buildStrippedImageFloorNote 兜底),与 OCR-成功分支同款无条件剥图哲学一致;关(0/false/off/no)
  // → 逐字节回退历史行为(图留着,仅状态提示)。与 KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR(OPS-118·
  // prep 期 describe 级联失败)、KHY_VISION_STRIP_IMAGE_FLOOR(OPS-120·prep 期底线缺席)正交:
  // 那两门守 prep 期两处,本门(OPS-122)守 post-failure 救援网这第三处。
  KHY_VISION_RESCUE_STRIP_FLOOR: { mode: 'default-on', off: 'CANON', default: true },

  // ── 空 OCR 剥图路径「模型仍谎称没收到图」的确定性纠正脚注(visionDenialCorrection;OPS-MAN-138,
  //    修 2026-07-12 用户实测复现:纯文本模型 + 带图 + 视觉级联全 404 + OCR 读不出 → 模型无视诚实底线
  //    指令,回「消息里没有附带图片 / 当前对话中没有任何图片附件」)──────────────────────────────
  // 断桥:三处「空 OCR」站点(prep Site1/Site2、post-failure 救援网)剥图后都注入了一条面向模型的
  // 「收到图但读不出、绝不能说没收到图」诚实底线——**但那只是 prompt 指令,模型可以不听**。而 finishResult
  // 成功侧的确定性脚注族里,唯独 ocrUsageFootnote(KHY_OCR_USAGE_FOOTNOTE)只在 _ocrImageTextRead=true
  // (OCR 成功读出文本)时触发;空 OCR 剥图只置 _ocrFallbackApplied、不置 _ocrImageTextRead → 落在判据
  // 之外 → 模型谎称没收到图时零确定性纠正。开该门(默认)→ 当本轮带图并被剥离(_ocrFallbackApplied)、
  // 未走 OCR-文本注入(!_ocrImageTextRead)、模型成功作答却在正文否认收到图(detectImageDenial 命中)时,
  // 在末尾确定性追加用户可见纠正脚注,把「你确实上传了图、只是当前通道读不了」这一真相无条件送达用户;
  // 模型正文已诚实承认「收到图但读不出」→ 不追加(保持无感)。关(0/false/off/no)→ buildDenialCorrectionNote
  // 返 null → result.content 逐字节回退。与 KHY_OCR_USAGE_FOOTNOTE 正交:那条判据 _ocrImageTextRead=true
  // (OCR 成功、模型没提 OCR → 追加「用了 OCR」),本门判据 _ocrFallbackApplied && !_ocrImageTextRead
  // (OCR 读不出、模型否认收到图 → 追加纠正)。与 prep/救援网三条 prompt 侧底线门正交:那三门保证「剥图
  // 必留痕(prompt 侧)」,本门保证「模型无视留痕仍否认时,答复侧确定性纠正」——最后一道用户可见防线。
  KHY_VISION_DENIAL_CORRECTION: { mode: 'default-on', off: 'CANON', default: true },
  // OCR-成功变体子门(OPS-MAN-140,承上):OCR **成功读出文本**(_ocrImageTextRead=true)、模型却仍在正文
  // 否认收到图这一格,OPS-138 的空 OCR 纠正判据 `!_ocrImageTextRead` 挡在门外;而 ocrUsageFootnote(:858)
  // 在该格只追加「以上关于这张图片的内容是通过 OCR 读取的」——模型正文既已否认图片存在,那句既不自洽也不纠正
  // 否认。本子门在该格用一句**否认感知**纠正取代普通「用了 OCR」脚注(不叠加,避免心灵噪音),点明「你确实发了图、
  // OCR 已读出文字、是模型没采用」并给出「据 OCR 文本重新作答」的出路。关(0/false/off/no)→ 落回普通
  // ocrUsageFootnote 分支,result.content 逐字节回退。与父门 KHY_VISION_DENIAL_CORRECTION 正交独立。
  KHY_VISION_DENIAL_CORRECTION_OCR_READ: { mode: 'default-on', off: 'CANON', default: true },

  // ── 错误 → 建议方案单一真源(errorSolutionAdvisor;修「出错只报错、缺建议方案」)──
  // toolUseLoop「任务未完成」小结的「建议」段旧只内联判 3 类错误(权限/路径/超时),其余
  // 确定性错误(连接被拒/端口占用/磁盘满/模块缺失/命令未找到/DNS/内存/文件已存在/认证/限流/
  // git 冲突…)只吐原始报错、无可执行建议。开该门(默认)→ 用 errorSolutionAdvisor 按 14 类
  // 确定性错误签名给出具体建议方案(逐层挖出的真因匹配,覆盖面为旧 3 条超集,保留 Shift+Tab
  // 权限提示)。关(0/false/off/no)或无签名匹配 → 逐字节回退到旧 3 条内联判断。
  KHY_ERROR_SOLUTION_ADVISOR: { mode: 'default-on', off: 'CANON', default: true },

  // ── 动作声称否定守卫(claimReconciler;修「未修改任何文件」被误判为编辑声称)──
  // 确定性复核(answerVerifier→claimReconciler)的动作族关键词只匹动词、无视紧邻否定 →
  // khyos 收尾小结样板「未修改任何文件。」里的「修改」被当作「改了文件」的声称 → 每个只读/
  // 纯命令轮都误报「动作声称对不上工具记录·缺少 Edit 记录」。开该门(默认)→ 动词紧邻否定
  // (未/没有/无需/不/别 … / not/never/without)时判为「没做该动作」的陈述,跳过不计声称。
  // 关(0/false/off/no)→ _firstUnnegatedMatch 退化为原 re.exec 首匹配,逐字节回退。
  KHY_CLAIM_NEGATION_GUARD: { mode: 'default-on', off: 'CANON', default: true },

  // ── OpenAI 路径请求侧 thinking 透传(_protocolPipeline;修「glm-5.2 thinking 打不到线上」)──
  // OpenAI 兼容推理模型(如 GLM-5.2 的 thinking:{type:'enabled'})接受请求侧 `thinking` 字段,
  // 但 gateway OpenAI 路径历史只透传 reasoning_effort、把 thinking 丢弃 → GLM-5.2 招牌的 thinking
  // 开关经网关根本打不到线上。开该门 → options.thinking 存在时写入 OpenAI 请求体;关 → 逐字节回退
  // 历史「丢弃」行为(Anthropic 路径不受影响,它本就透传 thinking)。
  KHY_OPENAI_THINKING_PASSTHROUGH: { mode: 'default-on', off: 'CANON', default: true },

  // ── multiFreeService.callZhipu 对齐智谱 GLM v4 调用约定(zhipuRequestShape)────────────────
  // v4 chat-completions 端点采用标准 HTTP Bearer、直接以原始 API key 作 token,不再要求把 key 拆成
  // `id.secret` 再签 JWT。仓内主路径(routes/ai.js、gateway/providerPresets zhipu preset、apiKeyPool)
  // 早已原始 Bearer,唯 multiFreeService.callZhipu 仍走 generateZhipuJWT——遇到非 `id.secret` 形态的
  // 新版单段 key 会直接抛 'Invalid Zhipu API key format'。开该门 → 非 `id.secret` 形态走原始 Bearer
  // (`id.secret` 形态仍走 JWT,不改今日可用 key 的行为,严格超集);关 → 逐字节回退「永远 JWT」旧行为。
  KHY_ZHIPU_RAW_BEARER: { mode: 'default-on', off: 'CANON', default: true },

  // `id.secret` 形态 key 在**官方 v4 端点**(open.bigmodel.cn/api/paas/v4)上也走原始 Bearer(而非
  // legacy JWT)。实测根因:该形态 key 经 callZhipu 一直签 legacy JWT,而 test-key/主路径走 raw Bearer;
  // 新版永久免费视觉模型 glm-4.6v-flash/glm-4v-flash 在 JWT 鉴权上下文回 404 model_not_found、raw→200
  // (识图始终失败的真因)。开门 → v4 端点上 id.secret 也用 raw,与 test-key 对齐;关/异常 → 逐字节回退
  // 原「id.secret→jwt」。仅收窄官方 v4 端点,自定义/中转端点仍 JWT(严格超集)。parent 上门。
  KHY_ZHIPU_V4_RAW_BEARER: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_ZHIPU_RAW_BEARER' },

  // reasoning_effort 请求侧透传:GLM-5.2 招牌参数(max/xhigh/high/medium/low/minimal/none),
  // callZhipu 历史只透传 temperature/max_tokens,把它丢了 → 经此路径调 GLM-5.2 的 reasoning_effort
  // 打不到线上。开该门 → 从 opts.reasoningEffort/reasoning_effort 取合法枚举写入请求体;关/缺失/非法
  // → 不写该字段(逐字节回退,仍只发 temperature/max_tokens)。
  KHY_ZHIPU_REASONING_EFFORT: { mode: 'default-on', off: 'CANON', default: true },

  // ── GLM 占位 key 内置(builtinGlmKey;pip 安装后开箱可用 + 可经 NL/Web 替换)──────────────
  // 智谱 GLM 调用需配置 apikey,但默认无内置 key → pip 安装后 GLM 不以「已配置」态出现,须先手配。
  // 开该门 → apiKeyPool 把一个**占位** GLM key 以 priority 0 并入 BUILTIN_PROVIDER_KEYS fallback
  // (与 sensenova 先例同构,仅当池中尚无该 key 才并入),使 GLM 首次启动即在 provider 池 / /model
  // 选择器 / Web 网关里可见、可替换。用户经 NL(「配置 glm 的 key…」)或 Web(POST /api/ai-gateway/
  // pool/glm/keys)添加真 key(落 priority 10)→ 组成最高优先组 → 占位 key 永不被选中(池只在最高
  // 优先组内轮询)。关 → 逐字节回退「GLM 无内置 key」行为。诚实:占位是假 key,真调通须用户填真 key。
  KHY_BUILTIN_GLM_KEY: { mode: 'default-on', off: 'CANON', default: true },

  // ── token 计数格式舍入越界修正(usageTokenCountShape;formatTokenCount 边界正下方标错单位)──
  // usageFormatter.formatTokenCount 用**舍入前**的商定单位档、却用**舍入后**的值拼串 → 边界正下方
  // 越界:v∈[999500,999999]→"1000k"(作者注释 `999,500+ rounds up` 本意升 "1.0m")、v 使 toFixed(1)
  // 进位到 "10.0" 者(如 9995/9999)→"10.0k"(应为 "10k")。开该门 → 舍入后再定档,输出 "1.0m"/"10k";关/异常/非有限 → 返回 null →
  // formatTokenCount 逐字节回退原 legacy 分支("1000k"/"10.0k" 原样)。
  KHY_USAGE_TOKEN_PROMOTION: { mode: 'default-on', off: 'CANON', default: true },

  // ── Windows grep 盘符去重修正(grepWindowsDriveKey;smartTruncation 折叠键错切盘符冒号)──
  // smartTruncation._filterSearchOutput 按第一个冒号切「文件名」折叠重复匹配,但 Windows
  // grep 输出 `C:\proj\file.js:1:content` 的首冒号是盘符冒号 → 每行文件名都成 "C" → 所有不同
  // 文件塌进同一桶,只留前 3 行、其余静默丢弃(Linux 无盘符冒号不受影响)。开该门 → 盘符行取
  // 盘符冒号之后的分隔冒号,按真文件名分桶;关/异常 → 回退 `line.indexOf(':')`(逐字节等价)。
  KHY_GREP_WIN_DRIVE_DEDUP: { mode: 'default-on', off: 'CANON', default: true },

  // ── glob 权限白名单双星锚定修正(globDoublestarAnchor;matchers.globToRegExp 吞分隔符无边界)──
  // globToRegExp 把双星紧跟斜杠(`**`+`/`)译成 `.*` 并吞掉斜杠 → `**`+`/id_rsa` 编成
  // `^.*id_rsa$`,无分隔符边界 → 误匹配 `backup_id_rsa`/`evilid_rsa` 等 basename 恰以该模式
  // 结尾的**无关文件**(matchPath 文件权限白名单越权 over-match)。开该门 → 发出锚定片段
  // `(?:.*[/\\])?`(任意目录下同名 + 自身仍中,伪匹配消除·安全收紧);关/异常 → 回退 legacy
  // `.*` + 吞斜杠(逐字节等价)。
  KHY_GLOB_DOUBLESTAR_ANCHOR: { mode: 'default-on', off: 'CANON', default: true },

  // ── 工具调用冒号 KV 字段边界锚定(toolCallColonKvAnchor;parseFunctionArgs 误吞真参数)──
  // parseFunctionArgs 先无条件用未锚定 `(\w+)\s*:` 扫全串找冒号 KV → 把值里任意 `word:`(URL 的
  // `https:`、`date +%H:`、带引号 `"fix:`)当成键,命中即返回、丢掉模型真正的 `key=value`/command:
  // `command=curl https://x.com`→{https:"//x.com"}、`curl https://e.com`→{https:"//e.com"}。开该门 →
  // 冒号 KV 键锚定字段边界(串首/逗号后),伪命中转落 `=` 分支或 command 兜底;合法 `a: x, b: y` 全保留。
  // 关/异常 → 回退 legacy 未锚定正则(逐字节等价)。捕获组编号一致,解析循环不变。
  KHY_TOOLCALL_COLON_KV_ANCHOR: { mode: 'default-on', off: 'CANON', default: true },

  // ── 工具调用等号 KV 逗号切分修正(toolCallEqualsKvSplit;parseFunctionArgs 值内逗号被截断)──
  // parseFunctionArgs 的 `=` 分支用 `argsStr.split(',')` 无条件按逗号切「key=value」对 → 值里
  // 任意合法逗号(awk -F,、cut -d,、git log --pretty=format:%h,%s、含逗号散文/命令)都被当字段分隔
  // → 命令/内容在首个逗号处静默截断,尾段变成空值伪参数:`command=echo a,b,c`→
  // {command:"echo a",b:"",c:""}、`path=/a/b, content=hello,world`→{...,content:"hello",world:""}。
  // 开该门 → 只在「逗号后紧跟 `<key>=`」处切分(下一对的边界),值内逗号原样保留;关/异常 →
  // 回退 legacy `split(',')`(逐字节等价,含垃圾输出)。与 [[KHY_TOOLCALL_COLON_KV_ANCHOR]] 同类
  // (逗号/冒号作值内分隔符)但走不同分支;冒号分支的同类截断仍是已知遗留,不在本门范围。
  KHY_TOOLCALL_EQ_KV_SPLIT: { mode: 'default-on', off: 'CANON', default: true },

  // ── 工具调用等号 KV 分支准入锚定(toolCallEqualsKvGuard;含 `=` 的裸命令被误当 KV 丢 command)──
  // parseFunctionArgs 的 `=` 分支只要 `argsStr.includes('=')` 就把整串当 key=value 解析 → 含 `=`
  // 的**裸命令**(PowerShell `$x = ...`、bash `export FOO=bar`/`VAR=val cmd`、命令里 `--opt=val`)
  // 首个 `=` 左边整段被当键、拼不出 command:`Bash(powershell -Command "$files = Get-ChildItem…")`
  // → {'powershell -Command "$files':'…'}(无 command)→ shellCommand `command:required` 校验失败
  // → 折成 `Invalid tool parameters`,让含 `=` 的 shell 命令全调不动(Windows/PowerShell 高频)。
  // 开该门 → 仅当首个 `=` 左侧是裸标识符键(`[A-Za-z_][\w-]*`)才进 KV,裸命令落 command 兜底;
  // 关/异常 → 回退 legacy `includes('=')` 判定(逐字节等价)。与 [[KHY_TOOLCALL_COLON_KV_ANCHOR]]/
  // [[KHY_TOOLCALL_EQ_KV_SPLIT]] 同函数三分支同类锚定(冒号键 / 逗号切点 / 等号准入)。
  KHY_TOOLCALL_EQ_KV_GUARD: { mode: 'default-on', off: 'CANON', default: true },

  // ── 敏感 home 写入 denylist 大小写折叠(sensitiveHomeCaseFold;修大小写变体绕过提权拦截)──
  // tools/inputValidators._isSensitiveHomeWrite 的 denylist(`.ssh/`、`.bashrc`、`Library/
  // LaunchAgents/` …)封堵「写 ~/.ssh/authorized_keys(远程 root)、shell rc(登录代码执行)、
  // LaunchAgents/systemd(开机持久化)」等提权向量,但匹配只做分隔符归一、**从不折叠大小写**。于是
  // 在大小写不敏感 FS(macOS APFS/HFS+、Windows)上翻转一个字母即绕过:`~/.SSH/authorized_keys`、
  // `~/.BASHRC`、`~/Library/launchagents/evil.plist` → `.startsWith('.ssh/')===false` → 判非敏感
  // → 放行 → sshd/shell 仍按同一文件读到(全提权)。tool 自校验(inputValidators)与 PreToolUse
  // editBoundaryGuard(toolGuards)调**同一** isSensitiveHomeWrite,两道防线一并失守,无下游兜底。
  // 开该门 → legacy 精确大小写匹配后,再用折叠形对小写化 denylist 补一次匹配(fail-closed 严格超集,
  // 只多封锁);关/异常 → foldSensitiveRel 返 null → 跳过 → 逐字节回退 legacy 精确大小写行为。
  KHY_SENSITIVE_HOME_CASEFOLD: { mode: 'default-on', off: 'CANON', default: true },

  // ── 项目边界判定分隔符锚定(projectBoundaryAnchor;裸 startsWith 致兄弟目录名前缀绕过边界)──
  // inputValidators.validateNoPathTraversal(写)/validateReadAccess(严格读)用裸
  // `resolved.startsWith(normalizedBase)` 判「是否在项目内」。无分隔符边界 → 共享名字前缀的兄弟目录
  // 被误判「内」:base=`/home/u/proj` 时 `/home/u/proj-secrets/x`.startsWith('/home/u/proj')===true
  // → 写路径跳过越界拦截直接放行(连 trusted-root/审批都不过)、严格读边界被绕过。孪生
  // services/toolGuards:85-86 早已正确锚定(`abs !== root && !abs.startsWith(root+sep)`)。开该门 →
  // `resolved === base || resolved.startsWith(base + sep)`(严格收紧,真在 base/ 下者逐字节一致,只把
  // 仅名字前缀相同的兄弟目录改判「外」);关/异常 → 回退 legacy 裸 startsWith(逐字节等价)。
  KHY_PROJECT_BOUNDARY_ANCHOR: { mode: 'default-on', off: 'CANON', default: true },

  // ── @include 允许门分隔符锚定(instructionIncludeBoundary;裸 startsWith 致越界文件被内联进提示词)──
  // instructionFileService.resolveIncludes 的 `@include` 门用裸 `startsWith(baseDir) ||
  // startsWith(homedir)` 判「是否允许内联」。无分隔符边界 → 允许集过宽:名字前缀相同的兄弟目录
  // (`/tmp/proj-evil` vs `/tmp/proj`)、另一用户 home(`/home/user2` vs `/home/user`)被误判「范围内」
  // → 其文件被内联进指令 / 系统提示词(@include 提示词注入 / 机密内联,如 @../user2/.ssh/id_rsa)。
  // 开该门 → `resolved === base || resolved.startsWith(base + sep)`(对 baseDir/home 各锚定;真在其下
  // 者逐字节一致,只把仅名字前缀相同的兄弟目录改判拒绝=收紧放行=安全方向);关/异常 → 回退 legacy。
  KHY_INCLUDE_BOUNDARY_ANCHOR: { mode: 'default-on', off: 'CANON', default: true },

  // ── 上下文告警带阈值下溢守卫(contextWarningThreshold;小窗口从 token 0 起误报告警)──
  // cli/contextWarning.calculateTokenWarningState 的 `warningThreshold = threshold - 20000` 在小
  // 上下文窗口(本地模型 8k/16k/24k、或 KHY_CONTEXT_WINDOW 设小值)上下溢为负 → `tokenUsage >=
  // warningThreshold` 对任何 usage(含 0)恒真 → 从首个 token 就显示「100% until auto-compact」
  // (100% 剩余却报告警,违背文件头声明的 CC「don't nag early」意图)。开该门 → 窗口装不下 buffer
  // (threshold ≤ buffer)时只在抵达真实 threshold 才告警,生产 200k 窗口 threshold≫buffer 逐字节
  // 等价 legacy;关/异常 → 回退 legacy `threshold - buffer`。
  KHY_CONTEXT_WARNING_THRESHOLD_GUARD: { mode: 'default-on', off: 'CANON', default: true },

  // ── 重试 sleep abort 监听器清理(retrySleepCleanup;正常完成不摘 listener → 泄漏)──
  // retryWithBackoff._sleep 把清理包装事后赋给局部 resolve,但 setTimeout 已捕获原始 resolve →
  // 正常(超时)完成调的是原始 resolve、非清理包装 → removeEventListener 永不跑;`{ once:true }` 只在
  // abort 触发时自动摘除,正常完成不触发 → 每次带 signal 正常结束的 sleep 都在 signal 上残留一个 abort
  // 监听器。同一 AbortSignal 跨多次重试复用 → 累积 → MaxListenersExceededWarning + 内存增长。
  // 开该门 → 定时器回调先 removeEventListener 再 resolve;关/异常 → 逐字节回退 legacy 泄漏写法。
  KHY_RETRY_SLEEP_LISTENER_CLEANUP: { mode: 'default-on', off: 'CANON', default: true },

  // ── HTML 数字字符引用越界码点守卫(htmlEntityCodePointGuard;webFetchDecode 崩溃)──
  // webFetchDecode.decodeEntities 用 `Number.isFinite(cp) ? String.fromCodePoint(cp) : _` 解数字实体,
  // 但 isFinite 对任意 parseInt 结果恒真,而 String.fromCodePoint(cp) 在 cp>0x10FFFF 时抛 RangeError;
  // decodeEntities→htmlToText→decodeAndExtract 全链无 try/catch → 任何含 `&#x110000;`/`&#9999999999;`
  // 的远端页面(不可信输入)直接崩掉整次 webFetch,而非把该实体留字面降级。
  // 开该门 → 越界/非整数码点返回字面串(不崩),合法码点与 legacy 逐字节一致;关/异常 → 逐字节回退 legacy。
  KHY_HTML_ENTITY_CODEPOINT_GUARD: { mode: 'default-on', off: 'CANON', default: true },

  // ── 现代 OpenAI 密钥脱敏漏网(modernKeyRedaction;honestFailureReason.sanitizeCause)──
  // SECRET_PATTERNS 的 `(sk|pk|…)[-_][A-Za-z0-9]{8,}` body 类不含 `-`,而 sk-proj-/sk-svcacct-/
  // sk-admin- 的中段(proj=4/svcacct=7)短于 8 → 匹配失败 → 现代 key 未脱敏,原样带进用户可见
  // 失败文案(resolveFriendlyFailureMessage)。开该门 → 追加一趟把 `-`/`_` 纳入 body 类的正则
  // (对齐 errorClassifier:187)整体抹成 ***(严格超集,只多抹密钥);关/异常 → 逐字节回退仅 legacy 脱敏。
  KHY_MODERN_KEY_REDACTION: { mode: 'default-on', off: 'CANON', default: true },

  // ── 认证/无 key 失败主动邀请配 key(honestFailureReason.buildKeyConfigInvite)────────────
  // 识图/任何模型因缺密钥(401 认证失败 / 无可用 key)而失败时,今日只在失败文案里甩底层
  // 报错(如「认证失败。具体原因:智谱AI: … 401」),不给用户「配 key 即可继续」的出路。
  // 开该门 → toolUseLoop 模型轮错误返回路径对 auth·no_key 类**追加**一句主动邀请「要不要帮你
  // 配置该模型(认出 provider 时点名,如智谱 GLM)的 API Key,把 key 发我即可写入」(真正写入
  // 走用户粘 key → 模型调既有 configureModelProvider 工具的闭环)。关/异常 → 失败文案逐字节不变。
  KHY_FAILURE_KEY_INVITE: { mode: 'default-on', off: 'CANON', default: true },

  // ── cron 零步长死循环守卫(cronStepGuard;cronScheduler._parseCronField)──
  // `const step = parseInt(stepStr,10)` 后无 `step>0` 校验 → `*/0`/`5/0`/`5-10/0` 解出 step=0,
  // `for(i=start;i<=end;i+=step)` 永不前进 → 100% CPU 挂死。matchesCron 每 tick 对存储 job 表达式跑,
  // 单条畸形 cron 即永久卡死调度器;死循环不抛,调用方 try/catch 救不了。
  // 开该门 → 非法步长(≤0/非整数)跳过该字段部件(畸形 cron 拒绝而非挂死);关/异常 → 逐字节回退 legacy 死循环。
  KHY_CRON_STEP_GUARD: { mode: 'default-on', off: 'CANON', default: true },

  // ── keepRecent:0 → slice(-0) 反转守卫(recentTurnsSplit;tokenless/commandRewriter)──
  // rewriteHistory 用 `slice(0,-keepRecent)`/`slice(-keepRecent)` 切分,`-0===0` 故 keepRecent=0 时
  // oldTurns 空(啥都不摘要)、recentTurns 整段(全保留)——与「保留 0 条、摘要全部」恰好相反 → 显式
  // 传 0(合理的"全压缩"意图)静默 no-op 掉整趟省 token。开该门 → keepRecent<=0 时 old=整段/recent=[]
  // (keepRecent>0 与 legacy 逐字节一致);关/异常 → 逐字节回退 legacy slice 反转写法。
  KHY_RECENT_TURNS_SPLIT_GUARD: { mode: 'default-on', off: 'CANON', default: true },

  // ── Fable 5 行为 DNA 注入系统提示词(fableVoiceProfile;学泄露 Claude Fable 5 三块行为规范)──
  // 从 Fable 5 系统提示词借鉴三块与 khyos(CLI/senior-engineer 语境)相关的行为 DNA,追加到既有
  // section 的 items 末尾:①散文优先格式纪律(Response formatting)②语气规则(Tone and style:
  // 温暖但敢诚实反驳、每轮至多一个澄清问题、先答再问)③认错不自贬(Error handling and fallback)。
  // claude.ai web/artifact 专属规则一律不引入。开该门 → 三块文案注入;关 → 三 section 逐字节回退历史文案。
  KHY_FABLE_VOICE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 项目蓝图栈冲突守卫 + scaffold 旁白 root 回退(修「模板不该领跑、narration 念出字面 .」)──
  // KHY_BLUEPRINT_STACK_CONFLICT_GUARD:会话现场「开发 spring 项目数据库用 psql」,唯一 Spring
  // 原型 ssm 绑死 MyBatis+MySQL 且触发词含宽泛 "spring boot" → match 无栈感知命中它,模型被迫
  // 「先套 MySQL 再回改 PG」(模板本该最后兜底)。开 → match 检出「点名库 vs 原型持久层库」冲突时
  // 降级为 kind:'none'(模板不领跑)并附 reference 软指针 + guidance;关 → 逐字节回退旧 kind:'archetype'。
  // KHY_SCAFFOLD_VOICE_ROOT_FALLBACK:scaffoldFiles 输入无 root 字段(root 是结果字段),旁白读到
  // undefined → 历史念出「我先把 . 的骨架…」。开 → 无有效 root 时说「项目骨架」;关 → 字面 '.' 回退。
  // KHY_TOOL_PREFACE_DEDUP:一串连续同类工具(scaffoldFiles×3、write×N…)此前逐个吐一句近义过程
  // 旁白 → 刷屏。开 → 连续同类工具只在首个开口,其余静默直到出现不同类工具;关 → 逐条照发(字节回退刷屏)。
  // KHY_KHYOS_DESKTOP_CAPTURE:web 页面「进入桌面」按钮——内核在 `-display none` 下仍把窗口化桌面画到
  // VGA 帧缓冲,QEMU HMP `screendump` 可截图。开 → KhyOsRunner 额外挂一个 `-monitor tcp:` 监听,
  // khyos_desktop_start 按帧调 captureScreen()→PPM→PNG→base64 推给 <canvas>;关 → 不挂 monitor、
  // 桌面消息回一句「未启用」,内核终端串口桥不受任何影响(命令行逐字节回退)。
  KHY_BLUEPRINT_STACK_CONFLICT_GUARD: { mode: 'default-on', off: 'CANON', default: true },
  KHY_SCAFFOLD_VOICE_ROOT_FALLBACK: { mode: 'default-on', off: 'CANON', default: true },
  KHY_TOOL_PREFACE_DEDUP: { mode: 'default-on', off: 'CANON', default: true },
  KHY_KHYOS_DESKTOP_CAPTURE: { mode: 'default-on', off: 'CANON', default: true },

  // KHY_WEB_LOCAL_ACTIONS:网页「Khy 悬浮球」触发的本机管理动作(khyos_tray_start / khyos_md_open)。
  // 开 → 悬浮球可后台拉起系统托盘(`khy tray --detach` 同 SSOT)、起 khyosMarkdown 桥接器打开
  // khy.md 并回推同源 URL 供前端新标签页查看;关 → 两动作回 disabled 状态,字节回退——不 spawn、
  // 不起桥。既有 khyos_* 终端/桌面消息不受影响。
  KHY_WEB_LOCAL_ACTIONS: { mode: 'default-on', off: 'CANON', default: true },

  // ── 工具失败旁白念出根因(outcomeKeyFinding;修「错误根因不会汇报」)──────────────
  // 会话 /goal:「找到关键、错误根因,不会汇报」。toolOutcomeNarration 的失败分支此前只吐
  // 「这一步没走通,我先看下报错信息再调整」——手里明明攥着 result.error(shellErrorClassify/
  // pythonInvocationHint 已归好类的根因串)与 result.output/stderr,却笼统带过,模型据此转述
  // 也只能复读「看下报错」。开 → salientErrorReason 从失败结果里抠出一行根因(末个具名异常/
  // ModuleNotFound/命令找不到/权限/端口占用… 签名),旁白改成「没通:{根因}——我据此调整」;
  // 关 → 逐字节回退旧的笼统句。**只回显解释器/工具已点名的根因,不猜业务逻辑错**。
  KHY_TOOL_OUTCOME_ROOT_CAUSE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 丢弃 no-op 散文 echo 调用(degenerateShellEcho;修「讲笑话轮 echo 空转撞护栏」)──────
  // 会话现场:纯文本轮(讲个笑话)模型却派发 `echo "好的，给你讲个笑话："`——一个无重定向/管道/
  // 替换的裸 echo 只把模型自己已写的散文再打印一遍,毫无副作用与信息;且同一条连派 3 次撞上
  // ToolCallGuardrail(identical result 2 times → blocking)、白耗 2m33s。开 → 派发前从 toolCalls
  // 过滤掉这类退化 echo(带任意 shell 操作符 > | < & ; $() ${} $VAR ` \ 的一律保留),滤空后本轮零
  // 工具、直接交付模型文本;关 → 逐字节回退(不过滤,原样派发)。
  KHY_DROP_DEGENERATE_ECHO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 空命令补丁的工具名归一化匹配(_patchEmptyShellCommand/_patchEmptySearchQuery)────────
  // 两个补丁函数用大小写敏感的字面 Set 认工具名({shell_command,shellCommand,bash} /
  // {web_search,webSearch,websearch,search_web}),漏掉模型偶尔发的 `BASH`/`Bash`/全小写
  // `shellcommand`/`WebSearch`/`WEB_SEARCH` 等同义变体 → 该补空命令/空查询时静默跳过,工具带着
  // 空参数派发直接失败。开 → 归一化(trim+toLowerCase,搜索名再去 _/-)后比对同一批逻辑名;
  // 关 → 逐字节回退旧字面 Set。只放宽名匹配、不改推断逻辑。
  KHY_PATCH_TOOLNAME_NORMALIZE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 破坏性命令 flag 拼写/顺序归一化(shellSafetyValidator.DESTRUCTIVE_PATTERNS)──────────
  // /goal「做5轮khyos最值得治理的地方」:shell-safety 的破坏性命令表有 4 条对 flag 拼写/顺序/
  // 大小写敏感的正则,让常见破坏性拼写悄悄逃过分类、analyzeCommand 返回 safe:true:
  //   ① rm 关键级只认 r 在 f 前的 `-[a-z]*r[a-z]*f` → `rm -fr`/`rm -Rf`(大写)/`rm -rF`/
  //      `rm -r -f`(分开)全漏判 critical(最危险:递归强删被默认放行);
  //   ② dd 只认 `if=` → `dd of=/dev/sda`(反向写盘)漏判 critical;
  //   ③ git clean 只认 `-f` 子串、不覆盖 `--force` → 组合/长形漏 warning;
  //   ④ chmod 只认八进制 `777` → 符号式 `chmod a+rwx`/`chmod o+w` 漏 warning。
  // 开 → detectDestructiveCommand 用 DESTRUCTIVE_PATTERNS_STRICT(原表的**严格超集**,order/case
  // 无关,多抓真破坏性拼写,绝不比今天更松);关 → 逐字节回退原 DESTRUCTIVE_PATTERNS。
  KHY_SHELL_DESTRUCTIVE_FLAG_NORMALIZE: { mode: 'default-on', off: 'CANON', default: true },

  // ── Windows rm→rmdir 翻译的 flag 簇归一化(winCommandTranslate.patchWinCommand)──────────
  // 同 goal R5:历史两条 `rm -r[f]*` / `rm -f[r]*` 翻译只认纯 r/f 且区分大小写的 flag 簇 →
  // `rm -rfv logs`(额外 flag)、`rm -Rf x`(大写)落空未翻译,又被后面 `rm (?!-)` 拒 → 原样漏给
  // cmd.exe(无 rm 命令直接报错)。开 → 单条 case-insensitive、含任一 r/f 的 flag 簇统一翻成
  // rmdir /s /q(原两条严格超集);关 → 逐字节回退历史两条。
  KHY_WIN_RM_TRANSLATE_FLAGS: { mode: 'default-on', off: 'CANON', default: true },

  // ── R1: SSRF IPv4-mapped IPv6 HEX 形解码(ssrfGuard.isPrivateIpv6;第四批)──────────────
  // /goal「做5轮khyos最值得治理的地方」第四批:isPrivateIpv6 的 IPv4-mapped 分支只解码点分十进制
  // `::ffff:x.x.x.x`,漏了等价的 hextet 十六进制形 `::ffff:7f00:1`(=127.0.0.1)/`::ffff:a9fe:a9fe`
  // (=169.254.169.254 云元数据端点)→ 判为 PUBLIC 放行 = SSRF 绕过。兄弟 urlSafety.js 早已用
  // ipaddr.js 正确解此形,本门补齐手写层。开 → 追加 hex hextet 解码分支喂 isPrivateIpv4;关 →
  // 逐字节回退(仅点分形)。
  KHY_SSRF_IPV4_MAPPED_HEX: { mode: 'default-on', off: 'CANON', default: true },

  // ── R2: securityGuardService 家目录 rm 顺序/拆分/长形归一化(第四批)──────────────────
  // 第二安全层 DANGEROUS_COMMAND_PATTERNS 的 `rm -rf ~` 规则只认规范 `-rf` 簇。消费者比对前会
  // lowercase(故大小写 `-Rf`/`-rF` 已覆盖),但顺序 `rm -fr ~`、拆分 `rm -r -f ~`、长形
  // `rm --recursive --force ~`、额外 flag `rm -rfv ~` 全漏 → 家目录 wipe 被判 safe。开 →
  // 用 DANGEROUS_COMMAND_PATTERNS_STRICT(仅替换家目录那条为顺序/拆分/长形容忍的严格超集,
  // 仍要求递归∧强制两选择器同现,`rm -r ~`/`rm -f ~` 不误报);关 → 逐字节回退原表。
  KHY_SECURITY_GUARD_RM_FLAG_NORMALIZE: { mode: 'default-on', off: 'CANON', default: true },

  // ── R3/R4/R5: Windows 命令翻译 flag 归一化(winCommandTranslate.patchWinCommand;第四批)──
  // 同 goal 第四批三缝共门:R3 `wc -l` 历史贪婪 `.+` 吞后续管道 + 无 stdin 管道形(`cat f | wc -l`
  // 落空);R4 `ls -al`/`ls -a`(a 在前/仅 a)落到 bareword 当文件名、`ps -ef`/`ps -e`(带连字符)
  // 漏译;R5 chmod 字符类漏 who-selector(u/g/o/a)/`=`/s/t/X → 符号式 `chmod u+x`/`a+rwx`/`o=r`
  // 落空。开 → 各用严格超集正则(非贪婪 + 管道形、含 a/l 的 flag 簇、可选前导 `-`、加宽 chmod
  // 字符类);关 → 逐字节回退历史各条。
  KHY_WIN_TRANSLATE_FLAG_NORMALIZE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 模型列表增设可选「Auto」入口(autoModelSelect;/goal「khy 在模型列表下设置一个 auto 模型」)──
  // gateway 早已把 `auto` 当 adapter 级哨兵(GATEWAY_PREFERRED_ADAPTER=auto → 每请求经
  // autoSelectModel 按任务/可用性选 adapter),但模型选择器(/model)里没有用户可显式选中的
  // 「Auto」入口。开 → 选择器顶部 unshift 一条 Auto(value {adapter:'auto',model:'auto'}),选中后
  // 持久化成 GATEWAY_PREFERRED_ADAPTER=auto + 清空 GATEWAY_PREFERRED_MODEL,运行时逐请求自动选型;
  // Auto 入口标签用纯排序原语(rankAutoModels:任务期望 tier + 可用性过滤 + 来源可信度)实时预览
  // 「当前最优模型」。关 → 不 unshift Auto 入口、持久化不特判 → 逐字节回退旧行为(仅靠 adapter 哨兵)。
  KHY_AUTO_MODEL_SELECT: { mode: 'default-on', off: 'CANON', default: true },

  // ── 开源 MCP server 预设注册表(mcpServerPresets;/goal「完善开源仓库 MCP 工具」)──
  // 缺口:`khy mcp add` 要求用户手打完整启动命令(-- npx -y @modelcontextprotocol/…),
  // 没有 `khy mcp add github` 这类一键短名,也没有发现/浏览入口。开 → 内置一张常用开源
  // MCP server 预设表(github/gitlab/git/filesystem/fetch/memory…),`khy mcp add <预设名>`
  // 免写命令直接展开为标准 stdio 配置,`khy mcp presets` 列出全部;显式 `-- <命令>` 仍覆盖。
  // 关 → hasPreset 恒 false、buildServerConfig 不做预设展开 → 逐字节回退「必须手打命令」。
  KHY_MCP_PRESETS: { mode: 'default-on', off: 'CANON', default: true },

  // ── 话题标题工作指示器(topicBarWorkingIndicator)────────────────────────────
  // 用户诉求:终端窗口标题里话题左侧那个静态「太阳」✱,**工作时**换成一个「左右移动的
  // 小点」以示 khy 正在忙,忙完再变回静态太阳。开 → topicBar 在 busy 时启动定时器让小点
  // 在定宽轨道上左右弹跳;空闲=静态 ✱。关 → titlePrefix 恒返 `'✱ '`、定时器永不启动 →
  // 逐字节回退旧行为(标题恒 `✱ ${topic}`)。
  KHY_TOPIC_BAR_WORKING_DOT: { mode: 'default-on', off: 'CANON', default: true },

  // ── 过程旁白口吻自然化(toolPrefaceVoice;修「都是我先/让我 xx」opener 单调)──────
  // 会话 /goal:中间过程说明太死板——toolProgressReason 每条首发句都以「我先…」开头且带
  // 「先把…，再…」仪式尾巴,一串不同类工具(read→edit→bash)各自 occurrence 0 → 全开「我先」,
  // 读起来像模板。开 → 首发句改写成更短、更口语、每类工具措辞各异的自然句(去「我先」+ 去
  // 「先把…再…」仪式;续接句沿用 occurrence 轮换);关 → 逐字节回退历史「我先…」措辞。
  KHY_TOOL_PREFACE_NATURAL_VOICE: { mode: 'default-on', off: 'CANON', default: true },

  // ── turn 级即时确认「先回应用户,再干活」(turnAckVoice;2026-07-05 用户反馈)────────────
  // 用户反馈:khy 收到提示词后直接静默进 runToolUseLoop 调模型,全程没有任何「先回应用户」的文本
  // (现有 preface 全是逐工具、且在模型跑起来之后才出)。用户要 khy 代码级先甩一句确定性短句回应、
  // 再继续干活,且只在**会跑工具/耗时的轮次**出。开 → 本轮首个工具即将派发且模型尚未自己出文本时,
  // 注入一句按 turnIndex 轮换的短确认句(「收到,我来处理。」…);关 → 逐字节回退到「无 ack」。
  KHY_TURN_ACK: { mode: 'default-on', off: 'CANON', default: true },

  // ── 首响应静默窗口守护(firstResponseAckVoice;2026-07-12 /goal「输入提示词时 khy 要及时回应」)──
  // 交互 raw-mode 终端里 spinner 被 render-suppress,提交那刻到首个模型 chunk 之间看不到任何动静,
  // 且 turnAckVoice 只在**首个工具即将派发**(模型已开口)时才出,覆盖不到「首 token 迟迟不来」这段
  // 最像卡死的窗口。开 → 请求发出后 KHY_FIRST_RESPONSE_ACK_MS(默认 1200ms)内一个 chunk 都没到,
  // 就甩一句 wait-aware 短句(按 turnIndex 轮换);首个 chunk 一到即取消。关 → 逐字节回退无提示。
  KHY_FIRST_RESPONSE_ACK: { mode: 'default-on', off: 'CANON', default: true },
  KHY_FIRST_RESPONSE_ACK_MS: { mode: 'numeric', default: 1200, min: 200, max: 60000, parent: 'KHY_FIRST_RESPONSE_ACK' },
  // 中途选项子门:用户在 AskUserQuestion / L2 确认 / 权限 Allow-Deny 里作出选择后,模型据此恢复
  // 流式前又是一段同构静默窗口。开 → 控制请求 finally 里重新武装一个 selection 变体守护(delay 内
  // 模型没恢复出 chunk → 甩一句「收到你的选择,正在据此继续…」);首个恢复 chunk 一到即取消。
  // 关(或父门关)→ 逐字节回退到「选择后无提示」。
  KHY_FIRST_RESPONSE_ACK_SELECTION: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_FIRST_RESPONSE_ACK' },

  // 工具迭代恢复子门:一个工具刚返回、模型据此续跑前,「工具返回 → 首个恢复 chunk」之间又是一段
  // 同构静默窗口(本回合最初的提交守护早被首 chunk 消费、turnAck 也一回合至多一次)。开 → 每个工具
  // 收尾信号处(tool_result/tool_complete)重新武装一个 resume 变体守护(delay 内模型没出下一 chunk
  // → 甩一句「工具已返回,正在继续处理…」);下一 chunk 一到即取消。关(或父门关)→ 逐字节回退无提示。
  KHY_FIRST_RESPONSE_ACK_RESUME: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_FIRST_RESPONSE_ACK' },

  // 图片分析子门:图片分析子流(剪贴板/文件/粘贴)走非流式 `await ai().chat(prompt,{images})`——
  // 无 onChunk 流、无 markChunk,只一个长 await,期间终端全静默;视觉级联(vision→OCR)最耗时、
  // 最像卡死,模型偶尔谎称「没收到图片」。开 → arm 于 await 前的 image 变体守护(delay 内答复未落地
  // → 甩一句「收到你的图片,正在识别分析…」既补窗口又即时确认图片已收到);await 完成/异常即 disarm。
  // 关(或父门关)→ 逐字节回退无提示。
  KHY_FIRST_RESPONSE_ACK_IMAGE: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_FIRST_RESPONSE_ACK' },

  // ── 协作网格 peer 会话区分标签(meshCore.shapePeers;修「多会话怎么区分/管理」)────
  // 会话 /goal:同一目录不同窗口开多个会话、或不同目录开会话时,协作链接(mesh peers)只列出
  // 不透明的实例 id,既不显示各自 cwd,同目录多窗口更无人类可读的区分标记。开 → shapePeers 为
  // 每个 peer 派生 cwdLabel(目录basename)、label(名称或目录名;同标签的 peer 追加 #1/#2… 序号)、
  // shortId,CLI/工具据此列出「会话」+「目录」两列;关 → shapePeers 逐字节回退旧输出(仅原字段)。
  KHY_MESH_PEER_LABELS: { mode: 'default-on', off: 'CANON', default: true },

  // ── 外部 Skills 生态适配:`khy skill add <github源>`(skillInstallService;修「khy 无生态,需连外部」)──
  // 会话 /goal:khy 自己没有生态,需适配连接外面的生态(如 skill 的安装,对齐 `npx skills add`)。khy
  // 原生已认 SKILL.md/manifest.json 并在 <dataHome>/skills 下自动发现,唯缺「从 GitHub 仓库拉取并落盘」
  // 这一步。开 → skillSourceSpec 解析 owner/repo|https|git@|tree URL 为规范源,skillInstallService 浅
  // 克隆到临时目录、定位 skill 目录(--skill 子目录 / 根 / 扫描候选)后复用 skillPackageService.importSkill
  // 落到 loader 能发现的位置;关 → `skill add` 报「未启用」并逐字节回退(不改任何既有 skill 子命令)。
  KHY_SKILL_ADD: { mode: 'default-on', off: 'CANON', default: true },

  // ── live 区视觉行钳制 + 快度量(liveHeightClamp;「越到后面越卡」流式热点)────────────
  // KHY_LIVE_HARD_CLAMP:StreamingBlock 底部 live 区按**视觉行**(软换行+CJK)确定性硬钳制到
  // < 终端 rows,从根上不触发 ink 全屏重绘;关 → 回退原始行尾切(与历史 tailLines 逐字节一致)。
  // KHY_LIVE_CLAMP_FAST_MEASURE:tailTimelineToVisualRows 内避免对(仍在增长的)整段每帧做
  // O(段行数) 全量宽度扫描——改用已从末尾早停的 tailToVisualRows 等价判断,消 O(n²)/turn 隐性热点;
  // 输出逐字节等价(仅省扫描),关 → 回退原「整段 measure + 分支」路径。
  KHY_LIVE_HARD_CLAMP: { mode: 'default-on', off: 'CANON', default: true },
  KHY_LIVE_CLAMP_FAST_MEASURE: { mode: 'default-on', off: 'CANON', default: true },

  // ── committed <Static> 包装数组按 messages 引用记忆(staticItemsMemo)────────────────
  // useQueryBridge 每 render(每流式帧/每按键/每秒 nowTick)都重建 banner+messages.map 的 N+1
  // 个包装对象;但 messages(useState 值)绝大多数 render 未变引用 → 纯 O(messages) 分配/GC,长
  // 会话越来越卡。开该门 → 按 messages 引用记忆(引用未变即复用上次 items,内容逐字节等价);关 →
  // 每 render 重建(逐字节回退今日)。
  KHY_STATIC_ITEMS_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 已完成工具 diff 行按对象身份记忆(toolDiffRowsMemo)──────────────────────────────
  // 流式每帧父 App 重渲 → ToolLines(未 memo)对每个**已完成**工具重跑 diff 行构造:写入/编辑走
  // computeStructuredDiffHunks(全文结构化 diff)、shell 走 splitDiffLines 全量切行+逐行分类。但已完成
  // 工具 result/_khyWriteDiff 是冻结快照,每帧重算纯浪费(大 diff 工具在其后每帧重跑整份 diff)。开该门
  // → 按输入对象身份 WeakMap 记忆行数据(列宽无关,resize 仍每帧重渲不失真);关 → 每帧直接构造(逐字节回退)。
  KHY_TOOL_DIFF_ROWS_MEMO: { mode: 'default-on', off: 'CANON', default: true },
  // ToolLines.renderLiteralOutput 每帧对已完成工具的 LITERAL(非 diff)输出体重复构造:整份 stdout 的
  // JSON 美化尝试(preview)+ 全量 split/collapse/fold(shownLines)。→ 按 result 身份记忆 preview(列宽/
  // expanded 无关)与折叠行(expanded 分档、列宽无关);关 → 每帧直接构造(逐字节回退)。补 diff-rows-memo 的姊妹缺口。
  KHY_TOOL_LITERAL_OUTPUT_MEMO: { mode: 'default-on', off: 'CANON', default: true },
  // ToolLines 每帧对每工具头行重构:显示名归一(resolveToolHeaderName·2×require+主题查表)+ 入参摘要
  // summarizeArgs(JSON.parse 大入参 + path 相对化的 process.cwd() 系统调用)。→ 按 (tool, cwd) 身份
  // 记忆(name/input 工具创建后不变;cwd 守卫防 cd 后陈旧相对路径);关 → 每帧直接构造(逐字节回退)。
  KHY_TOOL_HEADER_SUMMARY_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 工具注册表 getAll() 合并 Map 记忆(toolRegistry.getAll)──────────────────────────────
  // tools/index.js getAll() 每次调用都把 _tools ⊎ _mcpTools 合成一份全新 ~200 项 Map,而注册表仅在
  // register/clearMcpTools/reload 三处变更(loadTools 全量填充只跑一次、发生在首个 getAll 之前)。开该门
  // → 按单调 version 计数器记忆合并后的基 Map,version 未变即复用(每处变更 bump);关 → 每次重建(逐字节
  // 回退)。所有 getAll 消费方均只读迭代(已核:capabilityRegistry/metaToolEngine/toolCalling/toolUseLoop/
  // toolSearch),profile/defer 过滤各自另建新 Map,故共享缓存 Map 从不被改。
  KHY_TOOL_REGISTRY_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 工具 function-calling 定义记忆(toFunctionDef)──────────────────────────────────────
  // _baseTool.defineTool 产出的 tool 是 Object.freeze 冻结的不可变对象,其 inputSchema/name/
  // description 在 tool 生命周期内静态;但 toFunctionDef() 每调用都深建 properties/required/def
  // 一份全新对象,而 getDefinitions/getEnabledDefinitions/claudeAdapter 每轮/每模型往返对全量
  // ~100+ 工具逐个 map(t=>t.toFunctionDef())。开该门 → 按 tool 对象身份(冻结即恒等)WeakMap
  // 记忆其 def,首建后复用同一引用;关 → 每次现建(逐字节回退)。因 def 是不可变 tool 的纯函数
  // 产物,零失效面(无需 version 计数器)。所有消费方均只读(claudeAdapter/mcpServer/toolSearch
  // 复制字段或序列化;collapseRedundant/canonicalizeDefs 各自 Object.assign/spread 另建新对象,
  // 从不原地改 def),故共享缓存 def 从不被改。
  KHY_TOOL_FUNCTION_DEF_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 纯静态系统 Prompt section 记忆(promptSectionStaticMemo)──────────────────────────
  // constants/prompts.js 的 no-arg section builder(getSimpleSystemSection/getDoingTasksSection/
  // getExecutionDisciplineSection/getPlanningAndRecoverySection/getSessionMemoryAndContextSection/
  // getOutputEfficiencySection)产物是编译期常量字符串(items 字面量 + map/join,无 env/Date/闭包),
  // 却在 getSystemPrompt 每轮对话重跑一次(装配处注释即「Static content (cacheable)」)。开该门 →
  // 按 section 名字符串键记忆首建结果、此后复用同一不可变字符串(零失效面,无需 version 计数器);关 →
  // 每次现建(逐字节回退)。仅登记可证纯的 builder;getToneAndStyleSection 因调 fableVoiceProfile 非纯,
  // 不走此路径。返回字符串不可变 → 共享引用无条件安全。
  KHY_PROMPT_SECTION_STATIC_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── enabledTools 派生的「Using your tools」section 记忆(promptToolsSectionMemo)────────
  // getUsingYourToolsSection 是每轮最大构建成本的 section builder(~15 个 Set.has 探测 + 条件
  // push + flatMap/join),但产物只是 Set(enabledTools) 成员关系的纯函数(无 env/Date/闭包),返回
  // 不可变字符串。enabledTools 仅在工具 profile/deferred-reveal 变更时改(极少)。开该门 → 按
  // 「去重排序后工具名连接串」作键记忆(与顺序/重复无关,可证正确);关 → 每次现建(逐字节回退)。
  // 缓存有界(超 32 个不同键即整清,绝不无界增长)。
  KHY_PROMPT_TOOLS_SECTION_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── ToolLoopDetector 已知工具名集合记忆(knownToolNameSetMemo)──────────────────────────
  // runToolUseLoop 每轮/每模型往返都为 ToolLoopDetector 重建「已知工具名」集合(对每个启用工具名+
  // 别名+NATURAL_ACTION_TO_TOOL 值+固定常见名逐个 _expandToolNameVariants:Set 构建 + 4 regex +
  // normalizeToolCall),是每轮最大派生之一。产物只是启用工具名集合 + 模块冻结常量的纯函数。开该门 →
  // 按「去重排序后工具名连接串」作键记忆 knownNames 数组(与顺序/重复无关,可证正确);关 → 每轮现建
  // (逐字节回退)。消费方 registerTools 只复制进自有 Set,共享缓存安全。缓存有界(超 16 键即整清)。
  KHY_TOOL_KNOWN_NAME_SET_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // 能力门每轮对话调 _collectEnabledToolNameSet 重建「启用工具名 + 别名」集合(每名一次
  // _expandToolNameVariants:Set 构建 + 4 regex + normalizeToolCall)。产物只是启用工具名集合的
  // 纯函数。开该门 → 按「去重排序后工具名连接串」作键记忆已算 Set(顺序/重复无关);关 → 每轮现建
  // (逐字节回退)。唯一消费方 _hasAnyToolEnabled 只做 .has() 只读探测,共享缓存安全。有界(超 16 键整清)。
  KHY_TOOL_ENABLED_NAME_SET_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // buildDirectToolDefs(原生云路径)每模型往返都调 assembleToolPool 重建全量工具池(2×denyRules
  // 过滤 + 2×profile 过滤 + 2×deferral 过滤 + 2×~200 工具全排序 + 合并),是每轮最贵派生。其为
  // 「注册表版本 _toolsVersion + profileId + deferral 开关 + reveal 指纹 _revealVersion」的纯函数。
  // 开该门 → 按上述四元组作键记忆已装配 Map(reveal/reset 不 bump _toolsVersion,故独立
  // _revealVersion 计数器捕获;caller 传 denyRules 覆盖则不可键化,始终重建);关 → 逐字节现建。
  // 唯一消费方 buildDirectToolDefs 只迭代 + toFunctionDef 只读,共享缓存安全。有界(超 16 键整清)。
  KHY_TOOL_ASSEMBLE_POOL_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // getToolDefinitions(本地文本协议 / codex 路径)每请求都 spread getClaudeCompatToolDefinitions
  // 的 22 条 def 数组。它是对冻结常量 CLAUDE_COMPAT_TOOLS 的零参纯 map,结果恒定。开该门 →
  // 构建一次后返缓存数组(下游 dedup/collapseRedundant/canonicalizeDefs 全 copy-on-write 从不
  // 原地改 def → 共享安全);关 → 每次现建(逐字节回退)。
  KHY_TOOL_COMPAT_DEFS_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 斜杠命令排序小写投影记忆(slashRankIndexMemo)──────────────────────────────────────
  // rankSlashCommands 在 TUI 斜杠菜单/经典 REPL 每次按键都对全量命令表(~173)逐条
  // toLowerCase(cmd/label/desc)——每键约 3×N 个一次性小写串,而这些投影每命令静态,只有
  // filter 逐键变。→ 按命令表数组身份(SLASH_COMMANDS 模块级稳定引用)WeakMap 记忆投影;
  // 关 → 每键现算(逐字节回退,评分与稳定排序不变)。
  KHY_SLASH_RANK_INDEX_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 斜杠命令整排序结果记忆(slashRankResultMemo)──────────────────────────────────────
  // slashRankIndexMemo 收了「逐条 toLowerCase」的投影;本条收其上层——rankSlashCommands 每键仍
  // 跑「~173 条评分循环 + Array.sort + .map」。按 (命令表身份, filter) 小 LRU 记忆整排序结果,
  // 收退格/重键回访的重复全量排序;关 → 每键现算(逐字节回退)。
  KHY_SLASH_RANK_RESULT_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── getCompletions 的 allKeys 惰性构造(completionKeysLazy)────────────────────────────
  // router.getCompletions 顶部无条件建 allKeys(展开 COMMANDS + Object.keys(ALIAS_MAP)),但斜杠
  // 路径(最常见,且是 TUI 每键前缀回退源)立即 early-return 从不用它。→ 门控开时下沉到斜杠
  // return 之后惰性构造;关 → 顶部即时构造(逐字节回退,输出不变)。
  KHY_COMPLETION_KEYS_LAZY: { mode: 'default-on', off: 'CANON', default: true },

  // ── commandRegistry.getCompletions 小写键投影记忆(commandCompletionIndexMemo)───────────
  // 斜杠补全委托实现每次调用遍历全量命令 Map 逐键 toLowerCase + matches.sort()。小写键与排序序只
  // 随注册表增删而变。→ 按注册表 (身份, size) 记忆按 cmd 升序的 [{cmd,cmdLower}] 投影,每调用只
  // 在投影上 startsWith 收集(子序列天然有序,免 sort);关 → 每次现算(逐字节回退)。
  KHY_COMMAND_COMPLETION_INDEX_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 经典 REPL 斜杠命令合并结果短 TTL 缓存(mergedSlashCommandsCache)──────────────────────
  // _getSlashCommands() 每次按键都调 _mergeUserSkillCommands→listUserSkillCommands/listCcCommands,
  // 二者对 ~/.khy/skills 与 .claude/commands 做同步 readdirSync + 逐 manifest readFileSync + JSON.parse
  // (渲染热路径的同步磁盘 IO + 解析);且每次 baseCmds.slice() 产生新数组身份,击穿下游
  // slashRankIndexMemo 的 WeakMap 键(投影每键重建)。→ 按 baseCmds 身份 + 短墙钟 TTL(默认 1000ms)
  // 缓存「发现结果 + 合并数组」:一串按键(亚秒)复用同一合并引用(免 IO,恢复投影记忆命中);TTL 过后
  // 下次渲染重扫,新建技能仍 ~1s 内出现(freshness 契约不破)。关 → 每次现扫合并(逐字节回退)。
  KHY_MERGED_SLASH_COMMANDS_CACHE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 经典 REPL `@` 文件选择器已排序投影短 TTL 缓存(atProjectionCache)──────────────────────
  // _renderAtPickerNow 每按键(`@` 后每次刷新)都对当前目录 readdirSync + 全量 skip-filter +
  // localeCompare 排序 + dir/file 映射。但同一目录内连续键入 filter(_atCurrentDir 不变)时这些全
  // 不变,只有子串收窄。TUI @-mention 已有 completionDirCache 收 readdir,经典 REPL 的 atPicker 完全
  // 没接(每键裸 readdirSync + 每键重排,大目录直接卡字符回显)。→ 按目录短 TTL(默认 1500ms)记忆
  // 「排序好的基础投影」,子串 filter 每键现算(applyAtFilter);TTL 过后重算(目录增删 ~1.5s 内反映)。
  // 关 → 每键现算整份投影(逐字节回退)。
  KHY_AT_PROJECTION_CACHE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 显示宽度 LRU 记忆(displayWidthMemo)──────────────────────────────────────────────
  // formatters.displayWidth 是全渲染层显示宽度 SSOT(aiRenderer/diffRenderer/两 picker/主输入刷新)。
  // 每次 stripAnsi(整串正则) + ASCII 快路径正则(整串扫) + 非 ASCII 走 string-width 整串 grapheme
  // 分段。主输入刷新 _getInputCursorMetrics 每按键对整行调两次 → 逐字符键入长行一行内 O(n²);CJK 输入
  // 每键命中昂贵 string-width。displayWidth 是其字符串实参的纯函数 → 按串 LRU 记忆(有界 2048·超 4096
  // 字符不缓存)。关 → 每次现算(逐字节回退)。
  KHY_DISPLAY_WIDTH_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 主输入光标度量单槽记忆(inputCursorMetricsMemo)──────────────────────────────────────
  // _getInputCursorMetrics 在 rl._refreshLine(每按键)里被调,单次刷新内还被 _inputVisualRows /
  // bottom-decoration repaint 再调。每次:① rl._prompt 剥 ANSI 正则(prompt 两次周期间静态却每键重跑)
  // ② displayWidth(inputBeforeCursor) —— 该前缀每键随光标推进变成新串,几乎永不命中整行 displayWidth
  // memo → 每键仍 O(n) 全量测量且随行增长。度量是 (line,cursor,cols,promptRaw) 的纯函数 → 单槽记忆整份
  // metrics(命中同一按键内多处重复调用 + 无变更重刷),promptLen 另按 prompt 串缓存剥离长度。
  // 关 → 每次现算(逐字节回退)。
  KHY_INPUT_CURSOR_METRICS_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 底部装饰重绘串前缀单槽记忆(bottomDecorationRepaintMemo)──────────────────────────────
  // _buildBottomDecorationRepaint 在 rl._refreshLine(每按键)里被调,每次 ~6 段字符串拼接重建整段
  // bottom-decoration ANSI(下移+gap 清行+rule+footer+上移+光标复位)。_cachedBottomRule/Footer 已缓存
  // 但外层 ANSI 拼装每键从头重跑;单一可视行内连续键入时 rowsBelowCursor/gap/rule/footer 全不变,只 cursorCol
  // 逐键 +1。→ 拆 cursorCol-无关前缀(纯函数)单槽记忆,每键只补廉价 `\x1b[{col+1}G`(输出逐字节一致)。
  // 关 → 每次现拼(逐字节回退)。
  KHY_BOTTOM_DECORATION_REPAINT_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 底部装饰 stdout.write 去重(bottomDecorationWriteDedup)──────────────────────────────
  // rl._refreshLine 补丁每按键无条件 process.stdout.write(重绘串)+ syncOutput 括号。重绘串仅当
  // (metrics,rule,footer) 变化时才不同;按了不改变几何/光标列的键、或 _refreshLine 同状态重触发时,
  // 串与上帧逐字节相同却仍触发终端写(IO + 潜在闪烁)。→ 按上次写出的串单槽去重,相同即跳过 write;
  // frame 渲染/resize 拆除时 invalidate(装饰相对光标定位,终端下方被别处改动后须重画)。
  // 关 → 每次必写(逐字节回退)。
  KHY_BOTTOM_DECORATION_WRITE_DEDUP: { mode: 'default-on', off: 'CANON', default: true },

  // ── 原始粘贴 chunk 判定快路径(rawPasteChunkClassify)────────────────────────────────
  // stdin `data` 监听器对每一块 chunk(即每次按键)跑粘贴判定;历史实现每键 `raw.match(/[\r\n]/g)` 分配
  // 一个匹配数组。粘贴判定要求 length>=阈值(40)且换行>=2;普通短按键长度远不足阈值,换行数无关却仍
  // 每键付正则/数组分配。→ isPasteChunk 先用长度短路(短 chunk 直接 false,零正则),仅长 chunk 才手扫
  // 换行(数到 2 即停)。输出与历史逐字节等价;关 → 走历史正则(逐字节回退)。
  KHY_RAW_PASTE_CHUNK_FASTPATH: { mode: 'default-on', off: 'CANON', default: true },

  // ── stdin UTF-8 跨 chunk 安全解码(repl.js data 监听器;输入侧对称于 _sseTextDecoder 输出侧修复)──
  // stdin `data` 事件按字节切块,多字节字符(中文 3 字节 / emoji 4 字节)跨两块边界被劈开时,
  // 逐块 `chunk.toString('utf8')` 会把首块尾部残字节解码成 U+FFFD,续块同样 → 粘贴缓冲里中文乱码。
  // 开该门 → 监听器整个生命周期持一个 StringDecoder(复用共享叶子 createSseTextDecoder),把不完整
  // 多字节序列留存到下块拼齐。关 / 叶子加载失败 → 历史逐块 toString(逐字节回退)。
  KHY_STDIN_UTF8_DECODE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 时间线惰性归一化(liveTimelineLazyNorm)────────────────────────────────────────────
  // StreamingBlock 每帧(~25fps)对整条 turn 时间线 .map 预归一化(`{...e, text: normLive(e.text)}`),
  // 但唯一消费者 tailTimelineToVisualRows 从末尾早停、只触及尾部少数 entry。normLive 字符串工作已被
  // streamNormCache 缓存,但每帧仍 new 一个 N 长数组 + 对每个 text entry 做 `{...e}` 浅拷贝(含冻结前缀)
  // = 纯 GC churn,随 turn 变长累积 O(n²)/轮。开该门 → 原样时间线 + normalizer 交给 tail 惰性归一化(只算
  // 触及的尾部 entry,冻结前缀零分配;不依赖 entry 身份,每帧读现值现算永不取陈旧);关 → 预映射(逐字节回退)。
  KHY_LIVE_TIMELINE_LAZY_NORM: { mode: 'default-on', off: 'CANON', default: true },

  // ── 时间线尾部合并单次分配(timelineAppendMerge;reducer 侧,每 chunk 而非每 render)──────────
  // tlAppendText/tlAppendThinking 在**每个**流式 text/thinking chunk(~25fps)把 chunk 并入尾部同型段。
  // 历史 `[...timeline.slice(0,-1), merged]` 每 chunk 分配**两个**数组(slice 出 N-1 长 + spread 出 N 长)。
  // N=段数随 turn 增长 → 每 chunk O(N) 双重分配 GC churn(同 KHY_STATIC_ITEMS_MEMO/KHY_LIVE_TIMELINE_LAZY_NORM
  // 的每-render N 数组分配类)。开该门 → 尾合并改单次分配 `arr.slice(); next[last]=merged`(数组内容逐字节
  // 相同、前缀段引用不变),每 chunk 分配 2→1;关 → 逐字节回退历史双分配。诚实:常数级 ~2× 削减,非渐进。
  KHY_TIMELINE_APPEND_SINGLE_ALLOC: { mode: 'default-on', off: 'CANON', default: true },

  // ── 工具目标抽取按对象身份记忆(toolTargetMemo)──────────────────────────────────────
  // ProcessGroup(未 memo)每帧 groupTitle→representativeTarget→tools.map(toolTarget),toolTarget 对
  // string 型 input 做 JSON.parse 抽取操作目标。已完成工具 input 是冻结快照,每帧重 parse 纯浪费。开该门
  // → 按 tool 对象身份 WeakMap 记忆 toolTarget 输出(冻结工具跳过 parse);关 → 每帧直接算(逐字节回退)。
  KHY_TOOL_TARGET_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 过程组标题分类按对象身份记忆(processGroupClassifyMemo)──────────────────────────
  // ProcessGroup(plain function 未 React.memo)每帧对可见尾窗每个工具组算 groupTitle(tools),对组内
  // 每工具调 classifyTool(name)(_normName toLowerCase+replace + 命中 Map 未中则遍历 CATEGORY_RULES
  // **最多 ~13 条正则 .test**)。工具 name 恒定 → 分类是纯函数,已到达工具每帧重跑正则电池纯浪费。开该门
  // → 按 tool 对象身份 WeakMap 记忆 classifyTool 输出(冻结工具跳过正则;分类与 running 无关缓存不陈旧);
  // 关 → 每帧直接算(逐字节回退)。
  KHY_PROCESS_GROUP_CLASSIFY_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 在跑工具聚合分类按对象身份记忆(runningToolsSummaryMemo)─────────────────────────
  // StreamingBlock 每帧(~25fps)调 buildLiveStatusBroadcast(streaming.tools)→summarizeRunningTools,
  // 对**整条**(全轮累积、随轮增长)工具数组每帧对每个在跑工具重跑 classifyAgentTool(toLowerCase/
  // replace/~7 正则)。工具 name 恒定 → 分类是 name 的纯函数,已到达工具每帧重分类纯浪费(长轮 O(n²)/轮)。
  // 开该门 → 按 tool 对象身份 WeakMap 记忆分类(命中跳过正则;_isRunning 仍每帧现读,分类与 running 无关
  // 缓存不陈旧);关 → 每帧全量分类(逐字节回退今日)。
  KHY_RUNNING_TOOLS_SUMMARY_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 在跑工具聚合按数组身份整体记忆(runningToolsSummaryMemo·第二层)────────────────────
  // 承上:分类已按 tool 身份记忆,但 summarizeRunning 的**外层循环本身**每帧仍对整条 streaming.tools
  // 走一遍 _isRunning(t)(=`!t.result` 便宜属性读)并重建 counts 对象——长轮工具累积上千,这层
  // O(turn)/帧 × ~25fps = O(turn²)/turn 属性读 + 每帧一个新 counts 分配,是命中路径最后一段每帧 churn。
  // 取证 useQueryBridge.js:494/506:streaming.tools 在追加/解析时得新数组引用,纯文本流入帧保持同一引用。
  // 开该门 → 按 tools **数组对象身份** WeakMap 整体记忆 counts(文本帧命中即跳过全扫描;counts 仅被
  // buildLiveStatusBroadcast 只读消费,跨帧复用安全);关 → 每帧全扫描(逐字节回退今日)。
  KHY_RUNNING_TOOLS_ARRAY_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 任务清单合并解析单槽记忆(taskLinesMemo)────────────────────────────────────────
  // App.js:_readMergedTaskLines 每 render(含每次按键)跑 taskStore.snapshot()→mergeTaskLines
  // (把快照文本再 split 回行 + 去重)。任务状态多数 render 不变(打字/流式帧不改任务),该「构建串→
  // 再解析回行」纯浪费。开该门 → 按 (snap 字符串值, planTasks 引用) 单槽记忆 mergeTaskLines 输出
  // (snap 值+planTasks 引用均不变则复用上次 lines);关 → 每帧直接算(逐字节回退今日)。
  KHY_TASK_LINES_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 尾切 truncated 判定早停化(tailTruncation;承 KHY_LIVE_TIMELINE_LAZY_NORM)──────────
  // liveHeightClamp 的 tailTimelineToVisualRows/_tailTimelineRaw 从末尾早停构建尾窗,却用
  // `timeline.filter(visiblePred).length` **全量扫描整条时间线**判 truncated(每帧一次),带 norm
  // 时还对整条(含冻结前缀)重跑 normalizer,部分抵消 lazy-norm 收益+分配抛弃数组。truncated 完全由
  // 尾循环停点决定 → 开该门用停点早停扫描(命中首个可见项即返,通常 O(1));关 → 逐字节回退全量 filter。
  KHY_TAIL_TRUNCATION_FAST: { mode: 'default-on', off: 'CANON', default: true },

  // ── 任务循环 token 估算按 message 记忆(messageTokenTally;「任务体验卡顿,无法交付」)──
  // toolUseLoop 每次迭代对整条 conversationMessages 跑 reduce 估算已用 token(JSON.stringify
  // +estimateTokens 全文正则扫描),驱动容量/溢出闸门,且同轮跑 2–3 次。会话只增不减 →
  // O(N²) in transcript bytes/turn,落在「模型返回→工具派发」阻塞主路径 = 任务执行发卡来源。
  // 开该门 → 按 message 对象身份 WeakMap 记忆逐条估算,幸存 message 命中、只新增 message 计算
  // (O(N²)→O(N)/turn);关 → 每元素直接算,逐字节回退到今日行为。估算是内容纯函数,逐字节等价。
  KHY_MSG_TOKEN_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 输入框重排记忆(promptLayoutMemo;「输入/动画体验卡顿,无法做真正的软件项目」)────
  // PromptFrame 组件体无条件调 layoutPromptRows,对整条输入 buffer 逐字符跑 string-width
  // 重排成视觉行。App 任何无关状态变化(击键/1s nowTick 心跳/hint/footer 定时器)都触发
  // PromptFrame 重渲染 → 即便 value 没变也把整条 buffer(可能含多 KB 粘贴)重排一遍 = 打字/
  // 心跳发卡。开该门 → React.useMemo 按 {value,offset,cols,placeholder,maxRows} 记忆,输入
  // 不变复用上帧 rows;关 → 每帧重算,逐字节回退今日行为。重排是纯函数,逐字节等价。
  KHY_PROMPT_LAYOUT_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── live spinner token 懒估算(spinnerTokenLazy;「动画/输入体验卡顿,无法做真正的软件项目」)──
  // App._spinnerProgress 在渲染体内被调(忙碌时每帧 + 1s nowTick),每次对整条累积
  // streaming.text 逐字符跑 _estimateTok 重估 token 数 = O(len)/帧 → O(len²)/turn。但该
  // token 数仅在 spinner meta 被揭示时才显示——buildSpinnerMeta 复用 spinnerMeta 的 30s
  // 揭示门,前 30s(及任何 <30s 收尾的回合)meta 隐藏、直接 return '' 根本不读 tokens,
  // 那段逐帧重估纯属浪费。开该门 → 揭示门确定隐藏时跳过估算(渲染层丢弃 tokens,字节安全);
  // 关 → 每帧照常估算,逐字节回退今日行为。仅在确定隐藏时跳过,门控关/叶子缺失→保守估算。
  KHY_SPINNER_TOKEN_LAZY: { mode: 'default-on', off: 'CANON', default: true },

  // ── spinner「~N tok」估算增量化(spinnerTokenEstimate;每帧全串 CJK 正则 → 仅扫新增后缀)──
  // 揭示后(>30s 的长流式回合)_estimateTok 每帧对**整条累积回答**跑 estimateTokens 的全串
  // CJK 正则 .match() = O(N)/帧 → O(N²)/轮 + 每帧匹配数组分配。estimateTokens 可精确增量分解
  // (cjk 与 len 对拼接可加,末尾单次 ceil)→ CC-tokens 路径(text=纯 streaming.text,turn 内
  // append-only)用 turnStartedAt 锚定单槽只扫 delta,与全量逐字节等价。关/异常 → 全量估算。
  KHY_SPINNER_TOKEN_INCREMENTAL: { mode: 'default-on', off: 'CANON', default: true },

  // ── 补全下拉 caret 边距单槽记忆(promptCaretMarginMemo;菜单打开时 ↑/↓ 导航不重排整条 buffer)──
  // App 渲染体在补全菜单打开(completion.active)时对整条输入 buffer 重排求下拉左边距;用户按
  // ↑/↓ 在候选里导航时 App 因 selectedIndex 重渲染但 value/offset/cols 不变,却每次重跑整条
  // buffer 的 layoutPromptRows + caret 几何。按 (value,offset,cols) 单槽记忆 → 输入不变复用上次
  // margin,逐字节等价。关/异常 → 每帧重算(回退今日)。同族 KHY_PROMPT_LAYOUT_MEMO。
  KHY_COMPLETION_MARGIN_MEMO: { mode: 'default-on', off: 'CANON', default: true },

  // ── 收尾总结「根因/改动/验证」三段式(deliverySummaryFormat;「总结我希望也是和你一样结构化的」)──
  // 用户希望 khy 完成实质工程任务后,像交付说明那样结构化收尾:先讲根因(问题成因/需求取证,
  // 定位文件:行)、再列改动(文件/函数/门控)、最后给验证(实际跑过的测试/守卫/回归证据)。
  // 这是 protocol tier 系统提示指令,仅在识别到工程任务意图时注入(纯提问/闲聊/检索不注入);
  // 指令含诚实红线(绝不编造未跑的验证)。关 → 不注入本段(系统提示逐字节回退)。
  KHY_DELIVERY_SUMMARY_FORMAT: { mode: 'default-on', off: 'CANON', default: true },

  // ── 交付门人类可读报告落盘(deliveryGateReport;承 deliveryGateReporter 叶——此前零生产消费者)──
  // deliveryGate 评估后只把结构化摘要挂到 harnessReport.deliveryGate(verdict/passed/missing 标签),
  // 从不产出带逐条判定 + 改进建议的 markdown 报告;deliveryGateReporter.generateDeliveryReport /
  // saveDeliveryReport 全实现且有测,却无任何生产消费者。开该门 → harness 在最终 verdict 定案处,把
  // 完整报告经 saveDeliveryReport 落到本项目 ~/.khyquant/projects/<hash>/delivery-gate-report.md
  // (与 saveSessionTrace 同源轨迹目录),给维护者/用户一份可打开的交付说明,并发 delivery_gate_report
  // 事件告知路径。关 → 不 require、不落盘、不发事件(harness 行为逐字节回退)。落盘 fail-soft,报告是
  // 装饰性,绝不打断主流程(同 delivery_gate best-effort 约定)。
  KHY_DELIVERY_GATE_REPORT: { mode: 'default-on', off: 'CANON', default: true },

  KHY_TASK_TEMPLATE_HINT: { mode: 'default-on', off: 'CANON', default: true }, // taskTemplateHint:承 taskTemplates 叶(零消费者)→ loopInput 命中模板关键词则附加 [Task Playbook];关→不注入逐字节回退。fail-soft。
  KHY_FETCH_EXEC_GUARD: { mode: 'default-on', off: 'CANON', default: true }, // fetchExecuteGuard:承叶(零消费者·安全)→ shellSafetyValidator 把 curl|sh / base64 -d|bash 取来即执行升 critical 拦;关→buildFetchExecuteRisks 返 [] 回退。fail-soft。
  KHY_FPF_CHARACTERIZATION: { mode: 'default-on', off: 'CANON', default: true }, // fpfCharacterization:承 characterizationSnapshot 叶。开→falsePositiveFixGuard.finalize 用回归门 baseline/current 快照差分「未覆盖文件静默行为漂移」并入收口裁决;关→silentBehaviorChanges 恒 [] 逐字节回退。纯叶 fail-soft。
  KHY_ACTION_CONTRACT: { mode: 'default-on', off: 'CANON', default: true }, // actionContractVerifier:动作契约极小核验器 V 的门(叶零依赖、读 env 直判、CI 强制 P1-P8 fail-closed 不变量)。仅供未来接入网关的缝按需短路;V 本身被显式调用,门关→isEnabled 返 false。
  // localModelCatalog:承 localOllamaProbe 叶(此前零生产消费者)。开 → modelCatalogGraph.buildCatalogGraph 在 live 发现时把本地 Ollama 正在服务的模型作 source:'local' 边并入统一目录;关/Ollama 未运行/探测超时 → 无边逐字节回退。never-throw 非阻塞。
  KHY_LOCAL_MODEL_CATALOG: { mode: 'default-on', off: 'CANON', default: true },
  KHY_WEAK_MODEL_EDIT_GUARD: { mode: 'default-on', off: 'CANON', default: true }, // weakModelChangeGuard:弱档模型(T2/T3)改红线文件(.env/发布·CI/flagRegistry/版本三源/权限核心/.git)→拦要求强模型复核;敏感核心→放行须确认;关→assessWeakModelChange 返 null 逐字节回退。纯叶 fail-soft。

  // ── RTK 真实生效状态对账(rtkEffectiveState;「rtk 不是能力直接集成在 rtk 模式中吗,可以开关才对」)──
  // RTK「是否启用」此前只读 KHY_RTK_MODE,与「二进制是否真装了」从不对账 → status 能同屏打印
  // 「已启用」+「二进制:未找到」,声称启用实则未生效(幻影启用)。开该门 → 状态面把 mode×installed
  // 对账成三态(active / pending-install / off),mode-on 但没装如实说「未生效·原生截断兜底」;
  // 关 → 各状态面逐字节回退到旧的「只读 env」渲染。父门控经 KHY_RTK_MODE 语义,但本门控只管
  // 「怎么如实显示」,不改 RTK 是否真的改写命令(那仍由 rtkMode + 二进制决定)。
  KHY_RTK_EFFECTIVE_STATE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 主命令可发现性面板(commandOverlapAudit;自审 #7「命令过载·173 命令重叠」)──
  // 命令重叠几乎全是有意的 CC 名别名(route 指向 khy 既有 canonical),但「有意」只写在自由
  // 文本 desc 里、无机器声明 → 撞 route 无人察觉(叠加式无收敛)。COMMAND_ALIASES 把别名变成
  // 声明式 SSOT,commandOverlapAudit 守卫锁死「每处 route 碰撞必须是显式登记的别名」。本门控
  // 只管**面板渲染**(把 canonical 按类别聚合、别名折叠其下,收敛 173 条的可发现性);
  // 关 → buildPrimaryCommandPanel 返 null,调用方逐字节回退旧全量列表。审计原语本身无门控。
  KHY_COMMAND_PRIMARY_PANEL: { mode: 'default-on', off: 'CANON', default: true },

  // ── 自我认知/自审知识(selfAuditRegistry;goal「khy 对自己的情况做到自知」)──
  // khyos 早有一份自审报告(#1..#7,驱动了 directiveRegistryAudit/toolClusterActivation/
  // configureErrorShape/visionRoutingTruth/commandOverlapAudit 一整族修复),但它只以散落的
  // 代码注释存在,跑在 khyos 上的模型读不到 → 被问「khyos 最大的问题有哪些」只能凭空猜。开该门
  // → selfProfile 在系统提示注入一段 token 高效的自审块(每条已评估问题的严重度/现状/缓解),
  // 模型据实快答、不夸大;并如实标注这是已评估集、编号缺口(#2/#3 未在代码库记录)不臆造。
  // 关 → selfAuditRegistry.formatForSystemPrompt 返 ''、selfProfile 不注入(接缝逐字节回退)。
  KHY_SELF_AUDIT_AWARENESS: { mode: 'default-on', off: 'CANON', default: true },

  // ── 工具簇预激活(toolClusterActivation;自审 #4「工具发现成本高」)──
  // 30 个工具标 shouldDefer,子代理(AgentContext 作用域)起手拿到的是过滤掉延迟工具的精简
  // 定义,要用某能力须先 ToolSearch 命中——而关键词召回不稳(报告:返回的多是被 defer 的工具)。
  // 开该门 → 按用户输入的能力专有信号(浏览器/编译/密钥配置…)确定式预激活对应延迟工具簇,
  // 对每个名字 ensureToolForContext 提前揭示(幂等、加法式)。关 → selectToolsToActivate 返 [],
  // 调用方逐字节回退到「不预激活、靠 ToolSearch 现搜」的旧行为。
  KHY_TOOL_CLUSTER_ACTIVATION: { mode: 'default-on', off: 'CANON', default: true },

  // ── 命令替换 shell 感知(commandSubstitutionContext;修「PowerShell $() 被当 bash 注入硬拒」)──
  // execApproval 有一条 bash 视角硬拒:检出 `$(`/反引号且非 FULL 档即 allowed:false 且不带
  // requestId(无审批通道)。但 `$(...)`/反引号是 PowerShell 原生语法 → Windows 上每条含子表达式
  // 的 powershell/pwsh 命令都被误判注入、硬拒、无路可批(「已批准却禁止」的矛盾)。开该门 →
  // 外层是 PowerShell 家族时不硬拒,改走正常审批通道(用户可批,非静默放行);bash/POSIX 逐字节不变。
  // 关 → isPosixCommandSubstitution 恒 true → execApproval 逐字节回退旧硬拒。fail-safe 偏保守。
  KHY_SUBST_SHELL_AWARE: { mode: 'default-on', off: 'CANON', default: true },

  // ── PowerShell 感知的命令串接措辞(shellChainStyle;修「PowerShell 里 `&&` 报错」)──
  // Windows PowerShell 5.1 不支持 `&&`/`||`(仅 PowerShell 7+ 支持),但 khy 多处
  // (BashTool 描述、系统提示词 Windows 规则块、platformCapabilities 分支)一刀切教
  // 模型用 `&&` 串接命令 → 用户在 PowerShell 里跑 `pip install x && khy` 直接报
  // 「'&&' 不是有效语句分隔符」。开该门 → 目标 shell 为 PowerShell 家族(KHY_SHELL
  // 覆盖 / COMSPEC 指向 powershell·pwsh)时,串接措辞改用 `;` 与 `if ($?) { next }`,
  // 并注明 `&&` 需 PowerShell 7+;并允许 KHY_SHELL 覆盖 khy 实际 spawn 的 shell,使
  // 提示词措辞与工具执行一致。关 → 所有措辞逐字节回退 `&&`,不覆盖 spawn。cmd/bash
  // /sh 语境不受影响(它们本就支持 `&&`)。
  KHY_POWERSHELL_CHAIN_STYLE: { mode: 'default-on', off: 'CANON', default: true },

  // ── inline python 调用姿势提示(pythonInvocationHint;修会话两坑之一)──────────────
  // 会话现场:模型 `python3 -c "..."`(Windows 无 python3)与 `python -c "...def..."`(单行塞
  // def 非法)连踩两坑、空转两轮,修复动作都不在 stderr 里。开该门 → shell 失败经 composeShellError
  // 时,据「命令形态 + 报错签名」确定式识别这两类姿势错并各追加一句「怎么改」(python3→python、
  // 多行块→写临时 .py)。关 → buildPythonInvocationHint 返 null,composeShellError 逐字节回退不追加。
  KHY_PYTHON_INVOCATION_HINT: { mode: 'default-on', off: 'CANON', default: true },

  // ── 通用 shell 错误分类(shellErrorClassify;「教 khyos 处理未见过的错误」)──────────
  // pythonInvocationHint 只治两类 inline-python 姿势错;diagnoseEmptyFailure 只治空输出。命令带
  // **非空 stderr** 却不属这两类时,composeShellError 只贴 stderr 尾部——命令找不到、权限拒绝、
  // 路径不存在、缺依赖/模块、端口占用、磁盘满、网络/DNS 这些跨工具高频环境/姿势错,报错只说
  // 「是什么」不说「怎么改」,模型每碰一次就反复试错。开该门 → shell 失败经 composeShellError 时,
  // 据报错签名(+命令形态)确定式归入一个已知家族并追加**一条**可操作改法(单火·让位 python·
  // 只治环境/姿势错不猜业务逻辑错)。关 → buildShellErrorHint 返 null,composeShellError 逐字节回退不追加。
  KHY_SHELL_ERROR_CLASSIFY: { mode: 'default-on', off: 'CANON', default: true },

  // ── 流式请求索取 usage(streamUsageOptions;修「ctx 卡在 0%」)──────────────────────
  // TUI 必走 multiFreeService 流式分支(stream:true)。按 OpenAI 流式协议,服务端只有在请求带
  // `stream_options:{include_usage:true}` 时才在 SSE 末块回 usage。历史请求体从不带它 → agnes 这类
  // 标准 OpenAI 兼容网关整条流无 usage → tokenUsage=null → contextTokens 停在 0 → 底栏 `0% ctx (0/128k)`。
  // 开该门 → 流式请求体补 stream_options.include_usage=true,usage 得以回流(配合解析侧把 usage-only
  // 末块的读取上移到 delta 守卫之前)。关 → 不加字段(逐字节回退今日,ctx 仍可能为 0)。
  KHY_STREAM_USAGE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 多 agent 后端启动器(agentLauncherRegistry;「khy 不只能 khy claude,也要 khy opencode/…」)──
  // 网关注册了 17 个适配器(claude/codex/cursor/kiro/trae/opencode/warp/vscode/windsurf…),
  // 但 `khy <agent>` 顶层启动命令此前硬编码为 5 个(claude/codex/cursor/kiro/trae),与网关漂移——
  // opencode 适配器早已存在却无法 `khy opencode` 启动。开该门 → 启动器集由声明式 SSOT
  // AGENT_LAUNCHERS 驱动(含 opencode 直连型 + warp/vscode/windsurf 选模型型),ROUTER_COMMANDS/
  // 路由 case/ide handler 三面从注册表派生。关 → getAgentLaunchers 只返旧 5 个,三面逐字节回退。
  KHY_AGENT_LAUNCHERS: { mode: 'default-on', off: 'CANON', default: true },

  // ── 交互式 TUI 应用新终端启动(terminalLaunchCommand;「让 khy 启动 opencode 却不新开终端」)──
  // opencode/claude/codex 等交互式终端 agent 经 _spawnDetached 以 stdio:'ignore'+windowsHide 分离启动
  // = 无控制台可渲染/读输入 → 启不起来。开该门 → 已知交互 agent(保守白名单)改经「新终端窗口」启动
  // (win: `start "" cmd /k <target>`;mac: osascript Terminal do script;linux: x-terminal-emulator -e),
  // 终端 spawn 失败 fail-soft 回退历史分离启动。关 → isInteractiveTerminalApp 恒 false,逐字节回退。
  KHY_TERMINAL_LAUNCH: { mode: 'default-on', off: 'CANON', default: true },

  // ── worktree 工具双 cwd 同步(worktreeSessionCwd;「khy 不会真正使用工作树」)──
  // EnterWorktreeTool/ExitWorktreeTool 切 worktree 时只 process.chdir,而文件/git 工具、文件锁、
  // 红绿 diff、检查点全以 KHYQUANT_CWD 为准 → 模型进 worktree 后工具仍锚旧根,隔离失效。
  // 开该门 → switchToolCwd 同步两个 cwd 源(env+chdir)。关 → 只 chdir,逐字节回退旧行为。
  KHY_WORKTREE_TOOL_CWD: { mode: 'default-on', off: 'CANON', default: true },

  // ── 过程文案表格去边框(plainProcessTable;「输出过程表格线条太多·复制混乱」)──
  // 模型 narration 里的 markdown 表格被 _formatTableFromData 画成 ╭┬╮…╰┴╯ 盒线,复制过程文案时
  // 边框字符把内容搅乱。开该门 → 表格渲染为无边框、按列对齐的纯文本(表头下一行 --- 分隔),
  // 复制即得干净文本。关 → 逐字节回退到今日盒线表格。
  KHY_PLAIN_PROCESS_TABLE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 多协议冲突仲裁(protocolArbitration;「协议冲突无仲裁机制」)──
  // directiveComposer 的「协调头」把多套 protocol 一律当「互补、并非互斥」,靠自然语言让模型
  // 自行取舍。对真正互斥的协议对(典型:数学解题「分步详解」vs 懒人「最短输出」在输出详略轴
  // 上正相反)不够——没有确定性仲裁。开该门 → 用声明式互斥矩阵仲裁:一对里两者同时生效则按
  // 优先级抑制败者,并注入显式仲裁说明(采用谁 / 弃用谁 / 为什么);关 → arbitrate 返回空抑制,
  // directiveComposer 逐字节回退到今日「全协议 + 协调头软取舍」。矩阵保守只登记确证互斥的对。
  KHY_PROTOCOL_ARBITRATION: { mode: 'default-on', off: 'CANON', default: true },

  // ── 20 倍模式(twentyXMode;「cc 有 20 倍模式,khy 没有需要补充」)──
  // CC 的「20x mode」= Max 20x 订阅(约 Pro 20 倍用量额度),体感是权力用户「满负荷跑」:
  // 更长连续运行、并行 agent 团队、始终开着扩展思考。khy 自托管不受额度约束,对齐同一体感在
  // khy 能控制的轴上 —— **opt-in(默认关)** 的开关:开 → effort 顶到 max(含扩展思考)、
  // 工具循环迭代顶到硬顶、并行子代理扇出放大(安全封顶,非字面 20×);关 = 逐字节回退今日。
  // opt-in 语义:仅 'true'|'1' 视为开(/20x on 与 NL 配置都持久化 'true')。
  KHY_20X_MODE: { mode: 'opt-in', off: 'CANON', default: false },

  // ── 网关墙钟硬死线(_gatewayHardDeadline;「必要时让模型设硬超时,不能一直卡在这里」)──
  // 网关现有防线全是 idle 看门狗,靠每个 chunk/状态 touch 重置计时,而重试级联自己不断吐
  // `失败 N/M` 状态 → idle 计时被自己的输出永久重置 → 永不触发(实测卡死 9 分钟、失败 220/1437)。
  // 开该门 → 加一道基于一次性 startedAt 的**真墙钟硬死线**(与 touch 无关):到点即 abort
  // gatewayAbort(经 linked controller 传播到在途适配器调用,真正取消)。关 → createGatewayDeadline
  // 返 null,逐字节回退今日无硬死线行为。
  KHY_GATEWAY_HARD_TIMEOUT: { mode: 'default-on', off: 'CANON', default: true },
  // 网关 race abort 臂(root cause C:「卡住时 Esc/Ctrl-C 打不断」根治)。开 → 给两处
  // `Promise.race([adapter, idleTimeout])` 补第三条「attemptAbort.signal abort 时立即 reject」
  // 的臂,UI 的取消信号不再依赖适配器自愿配合即可打断在途请求。关 → 上游不挂臂,逐字节回退今日
  // 两臂行为。父门 KHY_GATEWAY_HARD_TIMEOUT 关时本子门也关(取消基础设施成对关闭)。
  KHY_GATEWAY_ABORT_RACE_ARM: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_GATEWAY_HARD_TIMEOUT' },
  // kiro 适配器透传 abortSignal(root cause A)。开 → client.send/内部 120s race/parseCWStreamEvents
  // 都接取消信号,卡在建连/首字节/流上时 abort 能真正撤回在途请求并释放 socket。关 → 逐字节回退
  // 今日「kiro 不响应 abort、只等 120s 硬超时」行为。
  KHY_KIRO_ABORT: { mode: 'default-on', off: 'CANON', default: true },
  // cliTool 子进程适配器 abort→kill(root cause B)。开 → invokeStreamingTool/invokeToolAsync 监听
  // abortSignal,abort 时 SIGKILL 子进程,不再只靠 ≥180s idle-timeout。关 → 逐字节回退今日仅 idle
  // 兜底行为。
  KHY_CLITOOL_ABORT: { mode: 'default-on', off: 'CANON', default: true },
  // 网关 idle 看门狗「仅真实推进重置」(root cause D:「卡住时看门狗被自身心跳永久续命、
  // 兜底失效」根治)。开 → 只有真实推进(适配器模型 token / assistant 内容)重置 idle,
  // 网关自造心跳(status / 脉冲「已耗时 Xs」/ idle 预警)不再续命,真实卡死能在 gatewayIdleMs
  // 内被兜底 abort。关 → 任何心跳都重置(逐字节回退修复前:看门狗被自身状态输出永久重置)。
  KHY_GATEWAY_IDLE_PROGRESS_ONLY: { mode: 'default-on', off: 'CANON', default: true },
  // 启动器(bin/khy.js)网关 idle/stall 超时默认值 CC 对齐(gatewayIdleTimeoutPolicy 纯叶子)。
  // 开 → idle 20s→60s、hard 45s→180s,从源头消除「长思考/吞大工具结果时 20s 内容间隙被误判
  // 停滞中断」的中段超时。关 → 逐字节回退今日写死的 45000/20000。用户显式 env 仍最高优先。
  KHY_GATEWAY_IDLE_TIMEOUT_POLICY: { mode: 'default-on', off: 'CANON', default: true },
  // 管理服务(khychat / aiManagementServer)启动时幂等自愈 DB(manageDbBootstrap)。开 →
  // 空库(pip 新装、无表)时建 base 表 + 写 advertise 的 admin/admin123,让首次即可登录、
  // DB 支撑路由不再 `no such table: users` 报 500。关 → 不自愈(逐字节回退今日行为)。
  KHY_MANAGE_DB_AUTOSEED: { mode: 'default-on', off: 'CANON', default: true },
  // 硬死线毫秒显式覆盖;clamp[5000, 1800000]。未设 → 按任务规模保守默认(small180s/normal300s/large600s)。
  KHY_GATEWAY_HARD_TIMEOUT_MS: { mode: 'numeric', default: 300000, min: 5000, max: 1800000 },
  // 级联总次数上限(跨外层适配器循环 × 密钥池 × 单次尝试的聚合计数);clamp[4, 500]。默认 48——
  // 足够正常多渠道回退,又能兜住 strict 放宽后从头重走整张表导致的 churn 膨胀(实测 1437 次)。
  // 显式设 0/off/false/no → 不封顶(逐字节回退今日无上限行为)。
  KHY_GATEWAY_MAX_TOTAL_ATTEMPTS: { mode: 'numeric', default: 48, min: 4, max: 500 },

  // ── 网关 scale-to-zero(scaleToZeroPolicy 纯叶子;Hermes v0.18.0「Gateway 支持 scale-to-zero」)──
  // 长期部署下常驻网关进程长时间闲置时**降到零**(停常驻省资源),下次请求再冷启(可选预热)。
  // **opt-in(默认关)**:自动停常驻进程有破坏性,须为长期部署显式开启(语义对齐 KHY_20X_MODE)。
  // 关(默认)→ 决策叶子恒返 reason:'disabled'、scaleDown:false,逐字节回退今日无降零行为。
  // 诚实边界:叶子只**决策**,不执行关停;daemonManager.daemonStatus() 仅把决策作**只读建议**呈现。
  KHY_GATEWAY_SCALE_TO_ZERO: { mode: 'opt-in', off: 'CANON', default: false },
  // 降零前的闲置窗口毫秒;clamp[60000, 86400000]。默认 900000(15min):够避免抖动式频繁停/启,
  // 又不至于让空闲进程长期占资源。冷启是否预热沿用 KHY_GATEWAY_WARMUP_ON_BOOT,不新造预热门。
  KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS: { mode: 'numeric', default: 900000, min: 60000, max: 86400000 },

  // ── 工具级模型可设超时(_toolTimeout;同「让模型设硬超时」族)──────────────────────────
  // WebSearch/DesktopControl/LSP 对各自网络/子进程/RPC 调用无任何超时;WebFetch/databaseQuery 有
  // 超时但硬编码/仅 env,模型无法按场景自设。开该门 → 这些工具在 inputSchema 暴露 `timeoutMs`,
  // resolveToolTimeoutMs 按「模型入参 > env > 默认」解析并 clamp,withDeadline 墙钟兑现(到点返
  // 结构化超时、绝不悬挂)。关 → resolveToolTimeoutMs 直返 defaultMs,逐字节回退今日行为。
  KHY_TOOL_TIMEOUT: { mode: 'default-on', off: 'CANON', default: true },

  // ── ESC / 用户中断 → 取消执行中的工具(治「工具在跑时按 ESC 打不断,要等 120s 硬超时」)──
  // ESC(cancelActiveRequest)今天只 abort 模型/网关流,到不了在途工具。开该门 → loop 把
  // parentAbort.signal(仅真·中断时触发)穿进工具执行,_withToolTimeout 让在途工具与 abort
  // 竞赛,信号触发 → 诚实、可重试的「已取消」结果,loop 迭代间断开本轮。关 → 工具不与 abort
  // 竞赛、上下文不带 signal、入口不传 abortSignal,逐字节回退今日行为。
  KHY_TOOL_ABORT_SIGNAL: { mode: 'default-on', off: 'CANON', default: true },

  // ── WebFetch 总墙钟 + abort 接线(webFetchDeadline;治「一显示正在处理就卡死·抓取卡 1m59s」)──
  // 现场:一次 WebFetch 卡在「正在检索外部信息… 1m59s · 等待响应…」直到外层 120s 工具硬顶才松手。
  // 两条根因都在 WebFetchTool:① Node 的 `timeout` 是 **socket 空闲超时**非总时限——慢站点滴数据
  // 就不断重置它,且同源重定向每跳**重新武装**新 30s → 无任何总上限,一路骑到 120s = 感知卡死;
  // ② execute 从不读 _context.signal → ESC 到不了在途请求,socket 永不销毁(最后一公里)。开该门 →
  // 给整条抓取(含重定向链)套**单一总墙钟** AbortController(预算=已解析 timeoutMs),到点 abort
  // 销毁 socket;并把 loop 传入的父 abort 信号链到同一 controller,ESC 真正打断在途请求;catch 里
  // 把 abort 塑成诚实、可重试的「超时/已取消」结果。关 → 不建 controller/定时器、请求 options 不含
  // signal 键,逐字节回退今日行为。同族 KHY_TOOL_ABORT_SIGNAL / KHY_TOOL_TIMEOUT。
  KHY_WEBFETCH_HARD_DEADLINE: { mode: 'default-on', off: 'CANON', default: true },

  // ── WebFetch 主工具字符集感知解码(webFetchCharset;/goal「完善…网页读取」)────────────
  // 缺陷:WebFetchTool._handleResponse 把每个响应体恒 `Buffer.concat(chunks).toString('utf-8')`,
  // 无论服务器声明什么 charset。国内新闻站(新华/人民/中新)至今仍发 GB2312/GBK → 模型收到的是
  // 乱码 HTML,语义无用。同仓早有纯字符集感知解码器 webFetchDecode(detectCharset:Content-Type
  // header → <meta> 嗅探;decodeBuffer:TextDecoder gbk/gb2312/gb18030/big5,未知标签回退 utf-8),
  // 但只接进了 compat 版 webFetch,主工具从没用上。开 → 主工具用 detectCharset+decodeBuffer 按声明
  // 解码;关 → 逐字节回退 `.toString('utf-8')`(原行为)。UTF-8 站点两路等价。
  KHY_WEBFETCH_CHARSET: { mode: 'default-on', off: 'CANON', default: true },

  // 联网搜索扇出补一个「独立自建索引、免 key、直连、无需代理」的全球引擎 Mojeek(治现有
  // 5 引擎偏国内:DuckDuckGo 之外无一个无需代理的国际引擎,代理不可用时国际召回塌成 0)。
  // 开 → Mojeek 并入 _resolveFanout 扇出;关 → 从扇出剔除,逐字节回退今日「仅国内 5 引擎」。
  KHY_SEARCH_MOJEEK: { mode: 'default-on', off: 'CANON', default: true },

  // ── 会话持久化收尾提速(治「每轮收尾在渲染事件循环上做无界同步 IO,回车后卡一下才能打字」)──
  // persistSession 每轮:① 对整份(随会话增长)JSONL 跑**两次** readFileSync(数行 + 取末条
  // uuid)= O(n)/turn 纯浪费;② 整份 messages pretty re-stringify + 阻塞 fsync + rename 同步写快照。
  // 开该门 → ①用 per-file 计数/末 uuid 记忆(persistSession 是 JSONL 唯一追加者,进程内计数即真值;
  // cache miss 时单次读播种)免去每轮双读;②对**进程内已建立**的会话(cache hit=非首轮/非 fork)把
  // 快照写挪到 setImmediate 出本轮 tick(权威恢复源 JSONL 已同步 fsync;restoreSession 消息取自
  // JSONL、仅从快照补元数据;fork/新会话 cache miss 仍同步写保证紧随的同步读回)。关 → 逐字节
  // 回退今日双读 + 同步快照。
  KHY_SESSION_PERSIST_FAST: { mode: 'default-on', off: 'CANON', default: true },

  // ── 会话快照损坏时结构修复再还原(sessionFileRepair;承叶子——此前零消费者/零测试)──
  // restoreSession 优先 JSONL(逐行 try/catch,天然抗坏行);但 JSONL 缺失/清空时退回 JSON
  // 快照,那一步 `JSON.parse(raw)` 对**截断/损坏**快照直接抛 → 整段会话丢给 checkpoint 或 null。
  // 开该门 → 快照解析失败时先调 sessionFileRepair.repairSessionFile(原子写 + .bak 备份 + 截断
  // 前缀 salvage + 重建有效消息),修好再 re-read 还原(_source:'json-repaired'),把「损坏快照
  // = 整段丢失」变「salvage 后还原」,直接服务「完整的简单的还原」。关 → 跳过修复,逐字节回退
  // 到旧的 checkpoint/null 兜底。fail-soft:修复任何异常都落回既有兜底,绝不打断还原。
  KHY_SESSION_FILE_REPAIR: { mode: 'default-on', off: 'CANON', default: true },

  // ── @-mention 补全目录读缓存(治「大目录里每键 readdirSync 阻塞字符回显」)──
  // useCompletions.computeFile 每次按键对当前 @-token 的目录跑同步 readdirSync,连续键入
  // `@s`→`@sr`→`@src` 对同一目录重复读。开该门 → 按 abs 目录短 TTL 记忆 readdir 结果,连续
  // 按键复用一次系统调用(过滤/映射仍现算)。关 → 直读不缓存,逐字节回退今日行为。
  KHY_COMPLETION_READDIR_CACHE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 搜索浏览器兜底硬超时(playwrightSearch.fetchRenderedHtml;治「一显示正在搜索就卡死」)──
  // web 搜索的 request 抓取空时会回退到无头浏览器(bing-cn/baidu 各起一个 Chromium)。旧路径
  // 除 page.goto 外,chromium.launch/newContext/newPage/page.content **均无超时**,teardown 只在
  // finally——某个 await 卡住时 finally 永不执行 → 浏览器进程泄漏、搜索永挂(软超时对已泄漏进程
  // 无效,ESC 打不断)。开该门 → fetchRenderedHtml 用墙钟硬预算竞赛整段浏览器序列,到点强制
  // teardown(close + process.kill(SIGKILL)),既有界返回又绝不泄漏僵尸浏览器;chromium.launch 也
  // 补显式 timeout。关 → 逐字节回退今日(仅 finally teardown、launch 用 Playwright 默认 30s)。
  KHY_SEARCH_BROWSER_HARD_TIMEOUT: { mode: 'default-on', off: 'CANON', default: true },

  // ── git 上下文异步刷新(gitContextService;治「系统提示每轮重建时同步 git 卡顿」)──
  // 系统提示每轮注入 git 上下文(branch/status/log/staged-diff),经 collectGitContext。旧路径
  // 缓存(默认 60s TTL)过期后的那一轮**同步跑 ~7 次 execSync git**——execSync 在子进程期间
  // 阻塞整个事件循环(spinner 冻结、ESC 失灵),正常 <100ms,但大仓/index.lock 争用/网络盘时
  // 最坏可达数秒。开该门 → stale-while-revalidate:过期时**立即返回上一份(略陈旧)缓存**并在
  // 后台用非阻塞 exec(_execCompat.execAsync)异步刷新,热路径永不因 git 阻塞;冷启动(无缓存)
  // 仍同步采一次(启动时已在 setImmediate 预热)。关 → 逐字节回退今日全同步采集。
  KHY_GIT_CONTEXT_ASYNC_REFRESH: { mode: 'default-on', off: 'CANON', default: true },

  // ── 自然语言给外部软件配模型:解析闸门(nlExternalAppResolver)──────────────────────
  // 把「给 opencode/openclaw/reasonix/deepseek-tui/coze/claude-code 增删改查模型」的 NL 解析成
  // 结构化意图(零 IO 纯叶子·零假阳性:app 名 + 动作词 + 领域引用三命中才接管)。关 → 叶子 resolve
  // 恒 null → localBrainService 的 external_app_config cooperative handler 不接管(逐字节回退,
  // khy 自身 provider_config 与其它 handler 不受影响)。
  KHY_NL_EXTERNAL_APP: { mode: 'default-on', off: 'CANON', default: true },

  // ── 自然语言给外部软件配模型:落地动作闸门(configureExternalApp 工具 / 有模型路径)──────
  // 有模型路径经 agent tool configureExternalApp 落地(risk:high),经同一批 externalApps/*Adapter
  // 写各 app 官方配置文件(merge-write·原子写·删除确认闸门·密钥复用 khy 已存或 NL 现给)。关 →
  // 工具拒绝执行并回明确说明(逐字节回退:不写任何外部 app 配置)。
  KHY_EXTERNAL_APP_ACTIONS: { mode: 'default-on', off: 'CANON', default: true },

  // ── 反向使用外部软件的模型:NL 解析闸门(nlExternalAppImportResolver)────────────────────
  // 把「用/导入 opencode/openclaw/reasonix/deepseek-tui/coze/claude-code 里可用的模型」的 NL 解析成
  // 结构化意图(零 IO 纯叶子·零假阳性:app 名 + 反向动词『用/导入』二命中才接管)。关 → 叶子 resolve
  // 恒 null → localBrainService 的 external_app_import cooperative handler 不接管(逐字节回退)。
  KHY_NL_EXTERNAL_APP_IMPORT: { mode: 'default-on', off: 'CANON', default: true },

  // ── 反向使用外部软件的模型:导入/注册动作闸门(appModelImporter / ImportExternalAppModels 工具)──
  // 读各 app 已配置的可用模型(真 key+endpoint+models),经 customProviderRegistrar.registerCustomProvider
  // 注册进 khy 自己的 provider 池(poolKey=<app>-<provider>),让 khy 像用 codex/claude-code 一样选用。
  // 关 → discover/import/unimport 整体 no-op(逐字节回退:不注册任何外部 app 模型)。
  KHY_EXTERNAL_APP_IMPORT: { mode: 'default-on', off: 'CANON', default: true },

  // ── 键盘快捷键对齐 Claude Code:反斜杠续行(backslashContinuation)────────────────────
  // Ink TUI 输入框里,Enter 前紧邻一个未转义的 `\` 视为续行:删掉反斜杠并插入换行而非提交
  // (对齐 CC 的通用换行键位)。纯叶子判定尾部反斜杠奇偶(`\\`+Enter 仍字面提交)。关 →
  // shouldContinue 恒 false → 逐字节回退历史「尾部 \ 直接提交」行为。
  KHY_BACKSLASH_NEWLINE: { mode: 'default-on', off: 'CANON', default: true },

  // ── 键盘快捷键对齐 Claude Code:Ctrl+R 反向增量历史搜索(historyReverseSearch)──────────
  // Ctrl+R 打开反向增量历史搜索浮层,复用既有 ~/.khyquant_history 持久化 + session 历史;纯叶子
  // 只做「query → 命中(新→旧序)」搜索计算,IO/渲染留 App.js 薄壳与 HistorySearchOverlay。关 →
  // isEnabled false → App.js 顶层完全不激活该浮层,Ctrl+R 逐字节回退为落到 textInput 的历史 no-op。
  KHY_HISTORY_REVERSE_SEARCH: { mode: 'default-on', off: 'CANON', default: true },

  // ── MarkText(muya)Markdown 工作台 + 右键「打开方式」注册(md 命令 / mdEditorRegister)──────
  // khy md <file> 用嵌入的 muya 引擎(WYSIWYG + 数学/图表/高亮/表格)打开 .md;首次运行幂等注册进
  // 系统「打开方式」。三门:
  //   KHY_MD_EDITOR        整体开关。关 → `khy md` 提示已禁用、自动注册跳过。
  //   KHY_MD_WYSIWYG       是否加载同源本地 muya 产物 vendor/。关 → 桥接器传 wysiwyg=0,
  //                        khyosMarkdown.html 逐字节回退零依赖内联引擎(与无 muya 的旧行为等价)。
  //   KHY_MD_AUTO_REGISTER 首次运行是否 fire-and-forget 自动注册。关 → 不自动注册(仍可 `khy md register`)。
  //   KHY_MD_AUTO_SHUTDOWN 桥接器是否随浏览器标签生命周期自我关停(心跳看门狗 + 关闭信标)。
  //                        关 → 逐字节回退旧行为(服务常驻直到 Ctrl+C/杀进程),右键打开会留孤儿进程。
  //   KHY_MD_SIDEBAR_CURRENT_DIR 全局工具模式(右键打开某文件)侧边栏是否列「当前打开文件所在目录」。
  //                        关 → 逐字节回退旧行为(侧边栏恒列项目 docs/)。
  // 后四者 parent=KHY_MD_EDITOR:父关→子必关。
  KHY_MD_EDITOR: { mode: 'default-on', off: 'CANON', default: true },
  KHY_MD_WYSIWYG: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_MD_EDITOR' },
  KHY_MD_AUTO_REGISTER: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_MD_EDITOR' },
  KHY_MD_AUTO_SHUTDOWN: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_MD_EDITOR' },
  KHY_MD_SIDEBAR_CURRENT_DIR: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_MD_EDITOR' },

  // ── 设备应用管理器:下载 / 卸载 / 管理当前设备所有应用(deviceApps)──────────────────
  //   KHY_DEVICE_APPS(父)总闸:设备应用管理器(deviceAppManager IO 壳 + deviceAppsPolicy 纯判定)。
  //                     关 → getManager 返回 available:false(诚实回报),DeviceAppsTool 从自动发现里
  //                     消失,`khy device` CLI 拒绝执行。逐字节回退:khyos 不触碰系统包管理器。
  //   KHY_DEVICE_APPS_TOOL   NL 工具 DeviceAppsTool 是否登记(list/uninstall/install/search)。
  //                     关 → 工具导出 disabled 占位,loadTools 跳过;CLI/服务不受影响。
  //   KHY_DEVICE_APPS_PROGRESS  下载时是否显示字节级进度条(deviceAppsDownloader → ProgressBar)。
  //                     关 → 静默下载(仍下载,只是不重绘进度),逐字节回退到无进度提示。
  // 后二者 parent=KHY_DEVICE_APPS:父关→子必关。
  KHY_DEVICE_APPS: { mode: 'default-on', off: 'CANON', default: true },
  KHY_DEVICE_APPS_TOOL: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_DEVICE_APPS' },
  KHY_DEVICE_APPS_PROGRESS: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_DEVICE_APPS' },
  //   KHY_DEVICE_APPS_NATIVE_UNINSTALL  卸载「非包管理器安装」的原生 exe/CLI(Windows 注册表
  //                     Uninstall 键 → 跑 app 自带卸载器:MSI msiexec /x、Inno unins*.exe、NSIS Uninstall.exe)。
  //                     T2 层:包管理器(T1)找不到该 app 时的兜底。关 → nativeUninstaller 诚实回报
  //                     available:false,路由回退到「仅 T1 + T3 拒绝盲删」。父关→子必关。
  KHY_DEVICE_APPS_NATIVE_UNINSTALL: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_DEVICE_APPS' },

  // ── 厂商连通性自检:输入 key 测是否连通(providerConnectivitySpec 纯叶子 + tester IO 壳 + `khy test-key` CLI)──
  //   KHY_PROVIDER_CONNECTIVITY_TEST 总闸:`khy test-key <厂商> --key <k>` / `--all` / `list`。
  //                     关 → spec.isEnabled 返 false,listConnectivityTargets 返 [],
  //                     buildConnectivityRequest 返 {ok:false},CLI 诚实拒绝执行。
  //                     逐字节回退:khyos 不做厂商探针请求(不影响正常网关调用)。
  //   key 只在运行时传入(命令行 / 环境变量 / 交互密文),绝不写入 repo / 包 / 磁盘。
  KHY_PROVIDER_CONNECTIVITY_TEST: { mode: 'default-on', off: 'CANON', default: true },

  // ── 生命周期边界:后台常驻 vs 一次性启动 vs 按需加载(serviceLifecyclePolicy 纯叶子 SSoT)──
  //   KHY_LIFECYCLE_POLICY 主门:声明 + 驱动 deferredPrefetch 的 cli-startup 调度。
  //                     关 → policy.isPolicyEnabled 返 false,listStartupSchedule 回退全量
  //                     (忽略 per-id 覆盖)≈ 改造前逐字节行为(escape hatch)。
  //   per-id 覆盖 KHY_LIFECYCLE_<ID>=off|0|false 是动态约定名(不逐个登记),仅主门开时生效——
  //   见 docs/03_DESIGN_设计 生命周期边界设计文档。各子系统自身的门(KHY_GATEWAY_WARMUP_ON_BOOT /
  //   KHY_CHANGE_WATCH / KHY_DISABLE_KEYPOOL_WATCH / KHY_SELF_EDIT_WATCH …)由其服务直读,不改语义。
  KHY_LIFECYCLE_POLICY: { mode: 'default-on', off: 'CANON', default: true },


  // ── 不信任弱模型:就地护栏标注 + 示范引导(weakModelGuidance)──────────────────────────
  // [AI-弱模型·加在这] 新 KHY_* 门控就加在 FLAGS 里、这个形状;父→子优先级用 parent 声明。
  // 弱模型改 khyos 时,由 weakModelGuidance 纯叶子(单一真源)向就地横幅 / WeakModelGuidance 工具 /
  // CommentGuidance view / coding profile 注入,同源输出「哪个高危位置放什么护栏 + 照抄哪个范例」。
  // 关 → 工具出口降级、profile 不注入该指令段(逐字节回退:无本引擎的旧行为;源码里的静态横幅注释
  // 不受门控影响,永远在)。
  KHY_WEAK_MODEL_GUIDANCE: { mode: 'default-on', off: 'CANON', default: true },

  // coding profile 是否**始终注入**弱模型护栏指令 + 反例→正例示范(闭合 dead-end:否则弱模型只有
  // 主动调 WeakModelGuidance 工具才看得到护栏)。parent=KHY_WEAK_MODEL_GUIDANCE:父关→子必关。
  // 关 → _codingProfile 逐字节回退(不注入该段),但源码里的静态横幅与工具出口不受影响。
  KHY_WEAK_MODEL_PROFILE_INJECT: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_WEAK_MODEL_GUIDANCE' },

  // ── 网页空态多角度提示词模板:内置目录(promptTemplateCatalog)──────────────────────────
  // AIChat 空态起始模板的**后端可配置内置目录**(纯叶子单一真源);前端经 GET /api/ai/prompts/builtin
  // 拉取渲染,后端不可达时前端另有兜底常量,保证永不空白。关 → listTemplates/listCategories 返空,
  // 路由返空目录,前端逐字节回退到自带兜底常量(与「未接后端目录」时的旧空态等价)。
  KHY_PROMPT_TEMPLATE_CATALOG: { mode: 'default-on', off: 'CANON', default: true },

  // ── 不信任弱模型:多套「照着做」的确定性流程(procedureCatalog)──────────────────────────
  // [AI-弱模型·加在这] 放任弱模型自由发挥不可控——把 khyos 上高频、易翻车的任务类型固化成编号
  // 步骤的 SOP,让模型「照着做」而非「即兴发挥」。procedureCatalog 纯叶子(单一真源)向 coding
  // profile(始终注入流程索引指令)+ toolUseLoop 循环顶部(首轮据用户消息匹配到就注入整套流程)
  // 同源输出。parent=KHY_WEAK_MODEL_GUIDANCE:父关→本门必关。关 → buildProcedureDirective 返空、
  // matchProcedure 返 null,两注入点逐字节回退(不注入任何流程,与无本引擎的旧行为等价)。
  KHY_PROCEDURE_CATALOG: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_WEAK_MODEL_GUIDANCE' },

  // ── 修复智能体纪律:「说了却没做就收场」跟进回核 ─────────────────────────────
  // [AI-弱模型·加在这] 弱模型(乃至被污染上下文带偏的强模型)最高频翻车形态——零工具调用的动作
  // 轮次里,虚构阻碍(「指令被截断/无法继续」)或空头承诺(「我将编辑」)却不真动手就收场。开 →
  // followThroughGuard 在 toolUseLoop 收尾分支一次性回核,逼模型真的发起工具调用或用具体工具证据
  // 证明阻碍真实。parent=KHY_WEAK_MODEL_GUIDANCE:父关→本门必关。关 → assessFollowThrough 恒返
  // null,接线处不注入任何 nudge(逐字节回退到无本守卫的旧行为)。
  KHY_FOLLOW_THROUGH_GUARD: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_WEAK_MODEL_GUIDANCE' },

  // ── 修 GLM 配置死循环:configureModelProvider 的 list/add 真源一致化 ─────────────────────
  // [AI-弱模型·加在这] 内置 provider(glm/deepseek/…)的 key 写进 apiKeyPool+env、从不写
  // custom_providers.json,而 action=list 历史只读该文件 → 配了 key 的内置 provider 永不出现在
  // list → 弱模型误判「没加成功」反复重试撞循环。开 → executeList 同时枚举有**真** key(非
  // priority-0 占位)的内置 provider,tag kind:'builtin'。关 → 逐字节回退只读 custom_providers.json。
  KHY_PROVIDER_LIST_MERGE_BUILTIN: { mode: 'default-on', off: 'CANON', default: true },
  // 内置 add 后回读 apiKeyPool 确认真 key 是否落地(keyLanded)+ 追加解释性 note(内置 provider
  // 不进 custom_providers.json 属正常、占位 key 非真实可用)。关 → 不回读、不追加字段,逐字节回退。
  KHY_PROVIDER_ADD_READBACK: { mode: 'default-on', off: 'CANON', default: true },

  // ── 智谱 key 配好后自动加入免费模型(zhipuFreeModels)────────────────────────────────────
  // 裸 poolKey `glm`(有 key、无 custom_providers.json 记录)在模型目录面只被枚举 0-1 个默认模型,
  // 那批智谱永久免费模型(glm-4.7-flash / glm-4.6v-flash / … cogview/cogvideox)在占位或离线时
  // 根本不出现在 /model 选择器。开 → augmentGlmPoolModels 把免费**聊天/视觉**模型并入 glm 池静态集,
  // apiAdapter.listModels / modelCatalogGraph 两处目录面即可见并直接免费调用(图像/视频端点不进聊天
  // 目录避免误选 404)。关 → augment 原样返回入参 → 逐字节回退今日「裸 glm 只 0-1 个模型」行为。
  KHY_ZHIPU_FREE_MODELS: { mode: 'default-on', off: 'CANON', default: true },

  // ── qoder-proxy 反代消费(qoderProxyModels)────────────────────────────────────────────────
  // qoder-proxy 是本机 HTTP 反代(默认 127.0.0.1:3000),把 qoder CLI 包成 OpenAI 兼容
  // (/v1/chat/completions)+ Anthropic 兼容(/v1/messages)两条线。开 → 启动时把 qoder 的
  // 模型 seed 成 `api:qoder:<m>`(openai)与 `api:qoder-anthropic:<m>`(anthropic)两个自定义
  // provider。**opt-in 默认关**:本地反代没跑时 seed 出来的都是 ECONNREFUSED 死条目(同内置 GLM
  // 占位 key 死条目一类 bug),故只在用户显式表态(此 flag=true,或设 QODER_PROXY_ENDPOINT/
  // QODER_PROXY_API_KEY)时才 seed;关 → ensureBuiltinQoder 内部即 no-op(逐字节回退不 seed)。
  KHY_QODER_PROXY: { mode: 'opt-in', off: 'CANON', default: false },

  // ── 问 khyos 时也给其他免费模型渠道(freeModelChannels)──────────────────────────────────
  // 配好某 provider(如智谱)后,configureModelProvider 的成功 note / action=list 结果附带一份
  // **其他免费模型渠道**发现清单(智谱 GLM / 硅基流动 / OpenRouter :free 等,纯公开 URL 无凭据,
  // env KHY_FREE_MODEL_CHANNELS 可按 key 覆盖/新增)。开 → 附带 freeChannels 字段与一行摘要。
  // 关 → list 返 []、message 返 '' → 逐字节回退今日「不主动列免费渠道」行为。
  KHY_FREE_MODEL_CHANNELS: { mode: 'default-on', off: 'CANON', default: true },

  // ── 工具分级 + 元工具(toolTierCatalog)──────────────────────────────────────────────────
  // [AI-弱模型·加在这] /goal「保证工具名单一简洁,并给工具分级——第一级为元工具,可组装任意
  // 工具、实现任何工具」。名字单一由既有栈(toolRegistryDedup 折叠真重复 + toolContract 冲突巡检)
  // 落地;本门控的 toolTierCatalog 纯叶子(单一真源)补真缺口=**分级 + 元工具一等概念**:声明三级
  // 层级与第一级元工具集,并向 coding profile 注入「有哪些元工具、任何能力都能由元工具组装(必要时
  // 用 createTool 铸造)、每个能力只用单一规范名」的确定性指令。关 → buildTierDirective 返 ''、
  // isMetaTool/classifyTier 返安全默认,注入点逐字节回退(不注入,与无本引擎的旧行为等价)。
  KHY_TOOL_TIER_CATALOG: { mode: 'default-on', off: 'CANON', default: true },

  // ── 让 khyos 用自然语言驱动别的 agent(externalAgentDirective)──────────────────────────
  // [AI-弱模型·加在这] /goal「让 khyos 自己学会使用自然语言驱动别的 agent 如 claude code 等」。
  // 执行链早已成熟(AgentTool subagent_type:'claude'|'codex'|'opencode' 经各 CLI 适配器真 spawn;
  // agentLauncherRegistry 的 `khy <agent>` 顶层启动)。真缺口是弱模型的**认知**两处:①coding
  // profile 从不告诉模型「你能把整个任务委派给外部 CLI agent」;②用户 NL 明确点名外部 agent 时无
  // 确定性识别把弱模型引到正确路由。externalAgentDirective 纯叶子(单一真源)向 coding profile
  // (始终注入能力指令)+ toolUseLoop 首轮(点名即注入路由 nudge)同源输出。parent=
  // KHY_WEAK_MODEL_GUIDANCE:父关→本门必关。关 → buildExternalAgentDirective 返 ''、两注入点逐
  // 字节回退(不注入,与无本引擎的旧行为等价)。
  KHY_EXTERNAL_AGENT_DIRECTIVE: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_WEAK_MODEL_GUIDANCE' },
  // 首轮「用户点名某外部 agent」的确定性路由 nudge(点名 + 驱动动词两命中才接管,零假阳性)。
  // parent=KHY_EXTERNAL_AGENT_DIRECTIVE:父关→本门必关。关 → detectExternalAgentRequest 返 null、
  // buildExternalAgentNudge 返 '' → 首轮注入点逐字节回退(能力指令仍在,只是不主动点名 nudge)。
  KHY_EXTERNAL_AGENT_NUDGE: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_EXTERNAL_AGENT_DIRECTIVE' },

  // ── 诊断锚定:追问「为什么报错」时把最近捕获的真因 pin 回上下文,逼模型诊断真错而非跑偏 ──
  // dogfood:上一轮 gateway 报 model_not_found 404(真因已捕获),下一轮用户问「为什么报了 404」,
  // 弱模型却抓表层 token「404」去查 nginx.conf、当成 HTTP 404 查错方向。缺口=失败只埋在自由文本
  // 历史里、无机制逼模型注意它。diagnosticGrounding 纯叶子(捕获侧 recordFailure 单槽 + 读侧首轮
  // detect「为什么失败」意图 → 注入 [SYSTEM: 诊断锚定] pin 真因)。parent=KHY_WEAK_MODEL_GUIDANCE:
  // 父/子任一关 → detectWhyFailureQuestion 返 false、buildGroundingDirective 返 null → 注入点逐字节回退。
  KHY_DIAGNOSTIC_GROUNDING: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_WEAK_MODEL_GUIDANCE' },

  // ── headless `khy -p` 走真·工具循环(runToolUseLoop)使工具真执行(Claude Code -p 对齐)──
  // [AI-弱模型·加在这] dogfood 实测:headless `-p` 直接 `await chat(prompt,…)`(ai.chat 是**单次
  // 模型调用核心**),从不进 runToolUseLoop,故 num_turns 恒 1、无工具循环——模型请求原生工具时
  // 只吐 `[模型请求执行工具: NAME]` 占位串当回复(与 TUI 早期 bug 同源,见 useQueryBridge:1789),
  // 且 toolUseLoop 全部注入引导(procedureCatalog/promptStructurer/roundAdvance/followThrough/
  // externalAgentNudge/planMode)在 headless 全失效。开 → headless 经 runToolUseLoop(chatFn 关内层
  // NL 循环、外层 loop 主导工具执行,完全镜像 TUI useQueryBridge 原生循环路径);loopResult.finalResponse
  // → render 的 reply 契约。关 → 逐字节回退到单次 chat()(与本修前一致)。loop 模块不可用/isEnabled()
  // 关/异常 → 亦 fail-soft 回退单发。
  KHY_HEADLESS_NATIVE_LOOP: { mode: 'default-on', off: 'CANON', default: true },

  // ── headless `khy -p` 执行过程的人类友好进度反馈(headlessProgress·CC `-p` 对齐)──────
  // [AI-弱模型·加在这] dogfood 实测:headless 经原生循环真执行工具后,人类全程零反馈——text
  // 模式整段沉默(实测 8 轮 142s 空屏),stream-json 也只吐 init→user→assistant(final)→result,
  // 无中间 tool_use/tool_result 事件。CC 的 `-p` 在 TTY 里实时显示工具活动。开 → 执行中把每次
  // 工具调用/结果以 renderTheme 一致的图标/显示名写 **stderr**(stdout 机器契约逐字节不动·
  // pipe/重定向安全);auto 档仅当 stderr 是 TTY 才发(重定向到文件的 stderr 不被污染),显式
  // KHY_HEADLESS_PROGRESS=1|on|force 可在非 TTY 强开(测试/CI)。关(0/off)→ 不挂进度回调,
  // 逐字节回退今日的沉默。parent=KHY_HEADLESS_NATIVE_LOOP:仅原生循环路径有工具回调可挂,父关
  // 则本门无处发。
  KHY_HEADLESS_PROGRESS: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_HEADLESS_NATIVE_LOOP' },
  // KHY_HEADLESS_PROGRESS_DETAIL:headless `-p` 工具结果行的**内容摘要**(CC `-p` 对齐的下一层)。
  // 今日 formatToolResult 只吐 `完成/失败 + 耗时`,零结果内容(无 diff/无「读取 N 行」/无退出码)。
  // 开 → 成功结果行追加一句 CC 风格摘要(读取 N 行 / 更新 basename (+X −Y) / N 处匹配 / N 个文件 /
  // 退出码 0 · N 行),仍只走 stderr、stdout 契约不动。关(0/off)→ 逐字节回退今日「完成 + 耗时」终态。
  // parent=KHY_HEADLESS_PROGRESS:父关则连结果行都不发,内容摘要无处附。
  KHY_HEADLESS_PROGRESS_DETAIL: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_HEADLESS_PROGRESS' },
  // KHY_HEADLESS_PROGRESS_TEXT:headless `-p` 执行中的**中间叙述文本**(工具调用前的「说明」散文)。
  // 今日 headless text 模式只把 finalResponse 打到 stdout,模型在工具调用前写的「先读一下这个文件…」
  // 之类过程叙述全不可见(loop 级 _callerOnChunk 因 chatOpts 无 onChunk 而为 null,preamble 补发路
  // 径 toolUseLoop.js:3697 整段成死码)。CC `-p` 会实时显示这些过程散文。开 → 给 runToolUseLoop 的
  // chatOpts 挂一个 onChunk,把 `{type:'text'}` 的中间散文写 **stderr**(复用 loop 内已有的 preamble
  // 补发 + 逐轮去重,stdout finalResponse 契约逐字节不动)。关(0/off)→ chatOpts 不挂 onChunk,
  // preamble 补发继续沉默,逐字节回退今日行为。parent=KHY_HEADLESS_PROGRESS:父关则整条进度反馈都不发。
  KHY_HEADLESS_PROGRESS_TEXT: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_HEADLESS_PROGRESS' },
  // KHY_HEADLESS_PROGRESS_HEARTBEAT:headless `-p` 单个**长时工具**运行中的「仍在运行…」心跳。
  // 今日 onToolCall 打一行 start 后直到 onToolResult 之间全静默——一个跑 30s 的 shellCommand/子代理
  // 在人眼里和卡死无异(CC `-p` 会持续显示活动)。开 → bin/khy.js 起一个 unref 的 setInterval,当有
  // 在飞工具且已运行 ≥5s 时每 5s 往 **stderr** 补一行 `⏳ {显示名} 运行中 {elapsed}`(unref 不阻塞退出·
  // 工具结束即停发)。关(0/off)→ 不起心跳定时器,逐字节回退今日 start→静默→result。
  // parent=KHY_HEADLESS_PROGRESS:父关则整条进度反馈都不发。
  KHY_HEADLESS_PROGRESS_HEARTBEAT: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_HEADLESS_PROGRESS' },

  // ── headless `khy -p` 原生循环抛错时的回退诊断(KHY_HEADLESS_LOOP_FALLBACK_DIAG)────────
  // [AI-弱模型·加在这] 今日 bin/khy.js 的 `} catch { result = null; }` 静默吞掉整个 runToolUseLoop
  // 的异常,回退到单次 chat()——用户拿到降级答案却全无线索(富工具循环为何被放弃?卡在哪?)。
  // 开 → catch 里往 **stderr** 写一行 `⚠ 原生工具循环失败,回退单发 · {错误摘要}`(stdout 机器契约
  // 逐字节不动·pipe/重定向安全),随后照常回退单发。关(0/off)→ 逐字节回退今日静默吞回退。
  // parent=KHY_HEADLESS_NATIVE_LOOP:回退路径只存在于原生循环块内,父关则根本不进该路径。
  KHY_HEADLESS_LOOP_FALLBACK_DIAG: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_HEADLESS_NATIVE_LOOP' },

  // ── headless `khy -p` 达迭代/步数上限时如实反映退出码与 json 契约(KHY_HEADLESS_EXIT_ON_LIMIT)─
  // [AI-弱模型·加在这] dogfood:runToolUseLoop 达内部最大迭代数返回 {maxIterationsReached:true} 但
  // **无 errorType**,且 result 映射不透传该字段,故 `process.exit(errorType?2:0)` → 退出 **0**;json
  // 侧 detectMaxTurnsHit 在默认(未传 --max-turns)时短路 false → subtype:"success"/is_error:false。
  // 于是一个「没做完就撞上限」的任务对 `&&`/CI 看起来完全成功——「khy 布置要能完成任务」的反面。
  // 改退出码/is_error 是**契约变更**,故 **opt-in 默认关**。开 → 透传 maxIterationsReached/stoppedByLimit
  // 并置 result.maxTurnsHit,使 json 报 error_max_turns/is_error:true、退出码用 resolveExitCode 给
  // **3**(区别于硬错误 2·表示「步数耗尽·可重试」)。关(0/off)→ 不置位、不透传影响判决,退出码
  // 逐字节回退 `errorType?2:0`(限流停止仍退 0,与今日一致)。parent=KHY_HEADLESS_NATIVE_LOOP。
  KHY_HEADLESS_EXIT_ON_LIMIT: { mode: 'opt-in', off: 'CANON', default: false, parent: 'KHY_HEADLESS_NATIVE_LOOP' },

  // ── 自主/非交互 L1(黄灯)自动放行,唯 L2 红线仍 fail-closed(autonomousL1AutoApprove)──
  // [AI-弱模型·别绕过红线] dogfood 实测:非交互环境(无交互器 onCtrl 缺失·headless `khy -p`/
  // 管道/后台)下 syscallGateway/approvalRouter 对 **L1 黄灯** 一律 fail-closed(「L1 需用户确认
  // 但无交互器」),于是 headless khy 连 `node`/`sleep`/`timeout`/`npm test`/`git add` 都跑不了——
  // 用户显式 `khy -p` 起一个自主任务却无从完成。对齐 Claude Code headless `-p`:自主模式自动跑
  // L1,**唯 L2 红线(删除/全局装/系统路径/破坏性)仍 fail-closed 需人**。开 → 无交互器 + 未被
  // 权限模式预授权 + 非不可越红线(riskGate.isUnbypassableGate 双保险:critical/destructive 恒不
  // 放行)时把 gwAutoApproveL1 置真(router 里 autoApproveL1 只作用 L1 分支,L2 分支不读→红线零
  // 弱化)。关(0/off)→ 逐字节回退今日「非交互 L1 fail-closed」。**与 KHY_SHELL_TOOL_RISK_MATCH
  // 配套**:后者(riskGate 本地门控)修 isShellTool 归一化使 shell 命令走动态分级(echo→L0 直接跑·
  // node/sleep→L1),本门再让那些 L1 在自主模式跑起来;二者皆关则完全回退到「shell 命令恒 critical
  // →L2 fail-closed」的旧行为。
  KHY_AUTONOMOUS_L1_AUTO_APPROVE: { mode: 'default-on', off: 'CANON', default: true },

  // ── API Key 失效→询问→无模型也能更新(keyUpdateFlow)────────────────────────────────
  // [AI-弱模型·加在这] /goal「apikey 失效后需要询问是否帮忙更新,即使没有模型也要能实现,当用户
  // 回答 apikey 后帮忙更新」。有模型时 honestFailureReason.buildKeyConfigInvite 已在失败文案末尾
  // 追加「帮你配置 key 吗」;真缺口=**无模型路径**——无模型兜底菜单从不邀请贴 key,且用户随后
  // 直接粘一段裸 `sk-...`(无动词/无厂商)不被 nlProviderResolver 的「域名+动词」零误报闸门识别,
  // 于是无法确定性写入。本门控的 keyUpdateFlow 纯叶子补这条:①无模型兜底菜单追加确定性邀请;
  // ②新增 key_update 确定性 handler(cooperative:true → 仅无模型介入·置于 provider_config 之后)
  // 把裸 key 识别 + 厂商推断后交既有 _execProviderAdd 写入(全程无需模型)。关 → looksLikeBareKey
  // 返 {isKey:false}、邀请返 ''、handler 不匹配,逐字节回退(无模型路径与旧兜底菜单等价)。
  KHY_KEY_UPDATE_FLOW: { mode: 'default-on', off: 'CANON', default: true },

  // ── 裸 key 形态推断出的厂商需先确认,不静默归属(keyUpdateFlow.decideProvider)──────────
  // [AI-弱模型·加在这] /goal「我直接在输入框里输入 key 不能直接判定为 glm 的 key,需要简单的
  // 流程询问一下」。此前 decideProvider 对 hex32.secret 形态**直接短路归属 glm**,用户只贴一把
  // key 就被拍板成智谱——但同形态的 key 未必真属智谱(用户可能贴的是别家兼容 key)。本门控让形态
  // 命中时改为**带猜测的反问**:返 { needsProvider:true, shapeGuess:'glm' },由 _execProviderAskWhich
  // 渲染「这看起来像 glm 的 key,确认是这家吗?」让用户点头/改厂商,绝不静默拍板。**显式 hint 仍即时
  // 归属**(用户已明说厂商就不再多问)。parent=KHY_KEY_UPDATE_FLOW:父关→本门必关。关 → decideProvider
  // 逐字节回退旧行为(形态命中直接 { provider:'glm' }·shapeGuess 不产出)。
  KHY_KEY_SHAPE_CONFIRM: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_KEY_UPDATE_FLOW' },

  // ── 用户提示词发给模型前先做结构化处理(promptStructurer)──────────────────────────────
  // [AI-弱模型·加在这] /goal「我发给 ai 的提示词,都先做结构化处理后再发给模型,提示词=结构+内容」。
  // promptStructurer 纯叶子(单一真源)把用户这一条消息重排成「结构(任务类型/关键动作/约束/期望
  // 产出)+ 内容(原文逐字)」,由 toolUseLoop 在 currentMessage 赋值处(首个注入前)包裹一次;绝不
  // 改写/删减原文,冲突时以原文为准。关 → buildStructuredPrompt 返 null,接线处逐字节回退(currentMessage
  // 保持用户原文,与无本引擎的旧行为等价)。
  KHY_PROMPT_STRUCTURING: { mode: 'default-on', off: 'CANON', default: true },

  // 结构化之上的「提示词资产化」判断透镜:在结构块后追加三条判断标准(可复用性=处理这只猫 vs
  // 搞定猫科动物 / 场景性=调教演员 vs 搭建舞台 / 工作流=加速试错 vs 消灭试错),外加抽象层级识别,
  // 引导模型据任务性质把请求往可复用/成类的资产形态取舍(不为通用而通用,冲突仍以原文为准)。
  // parent=KHY_PROMPT_STRUCTURING:父关→本门必关。关 → buildAssetLens 返 ''、不追加透镜段,
  // 结构化仍产「结构+内容」(逐字节回退到无透镜的基础结构化)。
  KHY_PROMPT_STRUCTURING_ASSET_LENS: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_PROMPT_STRUCTURING' },

  // 代码化提示词:复杂任务时,在结构块后追加一段 ```spec 声明式规格(把已解析的任务/范围/约束/期望写
  // 成逻辑精确、消歧、线性化的代码化表达,供 AI 的逻辑推理直接消费)。**仅复杂任务触发**(简单请求不加
  // 噪),仍是原文的逻辑重述、冲突以原文为准。parent=KHY_PROMPT_STRUCTURING:父关→本门必关。
  // 关 → buildCodeSpec 返 ''、不追加 spec 段(逐字节回退到无代码化的结构+内容)。
  KHY_PROMPT_STRUCTURING_CODE_SPEC: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_PROMPT_STRUCTURING' },

  // roundAdvanceAssessor 纯叶子:toolUseLoop 每完成一轮(模型回应+工具执行)后,吃每轮小结已算好的
  // 成功/失败/去重/读写命令分项,确定性判一个「本轮任务是否向前推进了一步」的判决(推进/停滞/空转)+
  // 必要性与价值档位,供每轮小结行渲染紧凑标签、并 breadcrumb 记录。纯观测,不夺取循环控制流。
  // 关 → assessRoundAdvance 返 null,接线处不给小结附 advance 字段(逐字节回退到无判决的旧小结)。
  KHY_ROUND_ADVANCE_ASSESS: { mode: 'default-on', off: 'CANON', default: true },

  // ── 重复输出:跨轮「答案回声」断路器(answerEchoGuard)────────────────────────────────────
  // [AI-弱模型·加在这] dogfood(api:agnes:agnes-2.0-flash):toolUseLoop 产出答案后跑约 18 个质量/交付门,
  // 每个门 `currentMessage='[SYSTEM]…'; continue;` 会在同一用户轮内**再驱动一次完整生成**;relay/api
  // SSE 逐轮 live 流式、append-only REPL 无法回收 → 屏幕出两遍同一答案(Flavor A 无工具 Q&A / Flavor B
  // 失败工具 repoAudit 反复)。既有守卫都无**跨轮答案文本比对**。开 → answerEchoGuard.normalize 出指纹,
  // isEcho 判本轮答案复现了本轮已流式过的某答案 → toolUseLoop 在结论前早返、不再进下一轮(封顶到已流式
  // 那一份,不无限循环),兜底所有门(含 goalStopGate)。关 → isEcho 恒 false、接线整段跳过(逐字节回退)。
  KHY_ANSWER_ECHO_GUARD: { mode: 'default-on', off: 'CANON', default: true },

  // 软交付门抑制:一个 substantive 答案已流式 + 本轮零工具调用时,抑制 7 个软交付门(intentCoverage/
  // summaryAssist/deliverableClosure/choiceResponse/earlyEndTurn/deliveryConclusion/completenessCoverage)
  // 的再驱动,彻底消除 Flavor A 的那一次重复。硬纠错门与 goalStopGate 不受影响(由回声断路器兜底)。
  // parent=KHY_ANSWER_ECHO_GUARD:父关→本门必关。关 → shouldSuppressSoftRedrive 恒 false,7 软门各自的
  // `&& !suppressed` 恒 `&& true`(逐字节回退,软门原样触发)。
  KHY_SUPPRESS_SOFT_REDRIVE: { mode: 'default-on', off: 'CANON', default: true, parent: 'KHY_ANSWER_ECHO_GUARD' },

  // 单次 completion 内「整段答案逐字重复两遍」折叠(replyDedup)。dogfood(api:agnes:agnes-2.0-flash,
  // v0.1.165):工具轮后弱模型在**一次**回复里把整段旅游答案生成两遍(reply = A + A,逐字节相同、
  // 首尾直接拼接),渲染一次即屏幕出两遍。与 answerEchoGuard(跨轮回声)、streamRepetitionGuard
  // (≤48 字短单元 chanting)、renderDedup(final vs 已流式)三者的形状都不同——它们均放过 completion
  // 自身内部的 A+A。开 → toolUseLoop 结论分支在 strippedReply 源头把精确等半(A===B,中缝纯空白,
  // 每份实质字符 ≥40)的自我重复折叠为一份,下游全链只见单份。关 → collapseDuplicatedReply 恒返原文
  // (逐字节回退),non-matching 输入本就原样返回。
  KHY_REPLY_DEDUP: { mode: 'default-on', off: 'CANON', default: true },

  // ── 截断缓解:弱模型自然早停的一次性自动续写(shortStopContinuation)· 默认关(opt-in)─────────
  // dogfood:「讲个笑话」在 ~26 token 处自然 stop(finish_reason=stop,非 length)中途断句结束。这不是
  // khyos 缺陷(忠实渲染了模型产出),根因是弱模型早停;maxTokensRecovery 只管 length 不介入。开 → 当回复
  // 以非终止标点中途断句 + 异常短 + finish_reason 为自然停止时,toolUseLoop 追加**一次**「接着上文续写」
  // (单次封顶,产新文本不触发回声断路器)。**默认关**:续写多一次模型调用、且可能续写本就该短的答案,
  // 故仅显式 =true|1 开启。关 → shouldContinue 恒 false,接线整段跳过(逐字节回退到「忠实渲染早停」)。
  KHY_SHORT_STOP_CONTINUATION: { mode: 'opt-in', off: 'CANON', default: false },
};

/**
 * 判定一个已登记 flag 是否启用。父→子优先级在此集中施加:父门控关 → 子门控必关。
 * 未登记 name → 保守放行(true)。绝不抛;坏 env/坏 spec → 安全默认。
 *
 * @param {string} name             flag 名(如 'KHY_GOAL_STOP_GATE')
 * @param {object} [env]            默认 process.env
 * @param {Set<string>} [_seen]     内部递归防环用,调用方不传
 * @returns {boolean}
 */
function isFlagEnabled(name, env = process.env, _seen) {
  try {
    const spec = FLAGS[name];
    if (!spec) return true;                                   // 未登记 → 保守放行

    // 父→子优先级:父关则子必关。_seen 防父子成环导致的无限递归。
    const seen = _seen || new Set();
    if (spec.parent && !seen.has(name)) {
      seen.add(name);
      if (!isFlagEnabled(spec.parent, env, seen)) return false;
    }

    const raw = env && env[name];

    if (spec.mode === 'opt-in') {                             // KHY_FEATURE_* 方言:仅显式开
      return raw === 'true' || raw === '1';
    }
    if (spec.mode === 'numeric') {                            // 数值型:非 0 即「配置了」——布尔视角保守放行
      return true;
    }

    // default-on:不在 off 词表即开。
    const words = OFF_WORDS[spec.off] || OFF_WORDS.CANON;
    if (spec.normalize === false) {
      // 精确复现 priorityTaxonomy 的裸 `===`:不 trim、不 lowercase(大写 OFF 读成「开」)。
      return !words.includes(raw);
    }
    if (raw === undefined || raw === null) return true;
    return !words.includes(String(raw).trim().toLowerCase());
  } catch {
    return true;                                              // 兜底:任何意外 → 保守放行
  }
}

/**
 * 解析数值型 flag(mode:'numeric')。精确复现 goalStopGate.resolveMaxRedrives 的语义:
 * Number.parseInt(非 Number)+ 非负校验 + clamp[min,max];非法/缺失 → spec.default。
 *
 * @param {string} name
 * @param {object} [env]
 * @returns {number}
 */
function resolveNumeric(name, env = process.env) {
  const spec = FLAGS[name];
  const fallback = spec && Number.isFinite(spec.default) ? spec.default : 0;
  try {
    if (!spec || spec.mode !== 'numeric') return fallback;
    const raw = env && env[name];
    const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
    if (!Number.isFinite(n) || n < 0) return fallback;
    const min = Number.isFinite(spec.min) ? spec.min : 0;
    const max = Number.isFinite(spec.max) ? spec.max : n;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  } catch {
    return fallback;
  }
}

/**
 * 列出全部已登记 flag(name 升序,确定性)。守卫查活表用,非文本解析。
 * 返回浅拷贝的规格对象,含 name 字段;调用方改动不影响内部表。
 * @returns {Array<{name:string, mode:string, off?:string, default:*, parent?:string, normalize?:boolean, min?:number, max?:number}>}
 */
function listFlags() {
  try {
    return Object.keys(FLAGS).sort().map((name) => ({ name, ...FLAGS[name] }));
  } catch {
    return [];
  }
}

module.exports = {
  OFF_WORDS,
  FLAGS,
  isRegistryEnabled,
  isFlagEnabled,
  resolveNumeric,
  listFlags,
  // 供守卫做名合法性校验的白名单(避免守卫硬编码字符串漂移)。
  VALID_OFF_NAMES: _VALID_OFF_NAMES,
  VALID_MODES: _VALID_MODES,
};
