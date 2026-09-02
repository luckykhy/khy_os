# Changelog

All notable changes to khy OS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.1.14

### Added

- **TUI 区域划分 SSOT**（`services/backend/src/cli/tui/ink-components/regionLayout.js`）
  - 新建区域划分单一真源文件，定义 25 个区域 ID（9 顶层 + 6 大区 + 10 小区），三层层级结构。
  - 大区值是小区值的前缀（`main.output` → `main.output.hdr`），层级可推导，测试断言锁住。
  - 覆盖层注册表 `OWNING_OVERLAYS` 集中声明 6 个独占输入覆盖层，`hideChrome` 字段决定是否隐藏 PROMPT/FOOTER。
  - 几何契约 `sidebarTopAnchorRows()` / `railCols()` 作为跨区域顶对齐 / 栏宽的单一真源。
  - 主区最小高度 `MAIN_MIN_HEIGHT = 6`，内容不足时用空行填充，确保主区始终有可读的最低高度。
  - 契约测试 `tests/cli/tui/regionLayout.test.js`（20 个断言）锁住区域顺序、层级、覆盖层判定。
  - 新增 `COMPLETION_MENU` 顶层区域（斜杠命令 / @file 补全菜单），职责边界原则：每个区域只管自己的渲染，不干涉其他区域。
  - 新增 `STATUS_AREA` 顶层区域（PROMPT 之下 5 行空行），输入区固定置底，预留未来扩展。
  - 渲染顺序调整：PROMPT 移到 FOOTER 之后（固定置底），COMPLETION_MENU 移到 PROMPT 之前（浮在上方）。

- **TUI 区域注释标签**（`services/backend/src/cli/tui/ink-components/App.js`）
  - 渲染数组每个 children 块前加 `[区域②.X]` 注释标题，grep `区域` 即可定位所有区域边界。
  - MAIN 左列总览注释列出 6 大区 + 10 小区的完整索引。

- **输出区分级显示矩阵落地**（`services/backend/src/cli/toolDisplayPolicy.js`）
  - 显示矩阵单一真源补齐 [DESIGN-ARCH-073] §2.3 声明的契约：57 个家族全部登记 `tier`（core/minor）与 `intentLabel`，`ALIASES` 覆盖工具注册表全部 151 个工具（此前 10 家族 / 147 个工具落 DEFAULT 无分级语义）。
  - 新增导出 `getToolTier` / `isCoreToolDisplay` / `buildCoreFocusLine`（`▌ 说明：目标` 三段式焦点行）；`DEFAULT_POLICY.tier='core'`（未注册工具默认 core，宁可见到不可漏掉）。
  - 接线两条渲染路径：`steps.js` `printStepLine` 新增 `opts.toolName`（core 且 active 态指示点换 `▌` 锚点，旧签名逐字节回退）；`headlessProgress.js` `formatToolStart` core 工具加 `▌ ` 前缀（stderr，stdout 机器契约不动）。
  - 契约测试 `src/cli/toolDisplayMatrix.test.js` / `src/cli/toolDisplayTier.render.test.js` 由红转绿（11/11）；存量回归 headlessProgress / foldOutputMarker / collapseConsecutiveDuplicates / toolPrefaceStreaming 共 96 用例全过。

### Changed

- **`/菜单` 与 `/commands` 分类区域上色**（`services/backend/src/cli/menu.js`、`services/backend/src/cli/commandCatalogUi.js`、`services/backend/src/cli/ui/inkComponents.js`、`services/backend/src/cli/uiPrompt.js`、`services/backend/src/cli/tui/ink-components/FormFlow.js`）
  - **改了什么**：`menu.js#showMainMenu` 为两个分类组（平台核心 / 量化交易）添加彩色分区标题与彩色图标 —— 平台核心为青色、量化交易为红色，icons 在分类色下渲染，光标选中时仅文本标为青色不遮图标颜色；`commandCatalogUi.js#CATEGORY_MAP` 为四个分类（量化交易 / AI 助手 / 系统 / 应用管理）补 `color` 字段并在 `renderCommandCatalog` 接入；`inkComponents.js#Select` 透传 `disabled` 字段、光标上下跳过禁用项、禁用项不套青色且渲染为灰色；TUI 桥接路径（`selectMenu` → `uiPrompt._normalizeChoice` → `FormFlow`）也透传 `disabled` 与 `color`，`FormFlow` 在渲染时为禁用项使用 `dimColor` + 分类色、跳过光标导航、回车键与数字键均跳过禁用项，确保 `/菜单` 在 ink TUI 下也能看到彩色分类。
  - **为什么**：菜单分类区域缺觉知分明度，用户易混淆系统管理与量化交易指令群。
  - **影响范围**：`/菜单`、`/commands` 以及所有走 `selectMenu` 路径的交互式菜单彩色渲染；Legacy Windows 终端回退到 ASCII 标记，无行为变更。

- **`overlayLiveBudget.js` 薄包装化**
  - `ownsLiveRegion()` 改为引用 `regionLayout.overlaysHidingChrome()`，不再内联覆盖层清单。
  - 新加独占输入覆盖层只需改 `regionLayout.js#OWNING_OVERLAYS`，无需触碰 `overlayLiveBudget`。

- **MAIN_TOOL_* 重命名为 MAIN_OUTPUT.*（破坏性）**
  - `MAIN_TOOL_HDR` → `MAIN_OUTPUT_HDR`（`main.tool-hdr` → `main.output.hdr`）
  - `MAIN_TOOL_OUTPUT` → `MAIN_OUTPUT_VIEW`（`main.tool-output` → `main.output.view`）
  - `MAIN_TOOL_INLINE` → `MAIN_OUTPUT_INLINE`（`main.tool-inline` → `main.output.inline`）

- **新增 MAIN 子区域 ID（破坏性）**
  - `MAIN_REASONING`（`main.reasoning`）—— 思考区大区
  - `MAIN_REASONING_LIVE`（`main.reasoning.live`）—— 思考区 live 段
  - `MAIN_REASONING_COMMITTED`（`main.reasoning.committed`）—— 思考区 committed 段
  - `MAIN_TIP`（`main.tip`）—— 提示区大区
  - `MAIN_TIP_DOUBLE_PRESS`（`main.tip.double-press`）—— 双击提示（1.5s 消失）
  - `MAIN_ACTIVITY`（`main.activity`）—— 活动区大区（原有 4 个小区挂到其下）

- **文档更新**（`docs/03_DESIGN_设计/[DESIGN-ARCH-016] AI_Agent显示规范.md`）
  - 新增 §7「终端分区」章节，完整记录三层区域结构、命名约定、几何契约、覆盖层规则、维护流程。

- **仓库结构卫生收口**（`docs/_报告/历史/`、`docs/00_INDEX_文档索引.md`、`.gitignore`、`scripts/ci/repo-layout-baseline.json`）
  - 根目录 `fix_diff.txt` / `stash_patch.txt` 收容进 `docs/_报告/历史/`（`root-whitelist` 守卫归零），另清理 `{` 与 `services/backend/{jest_out,tmp_test,test_out}.txt` 一次性测试输出，归档记录见 `docs/_报告/历史/2026-09-根目录补丁存档-归档记录.md`。
  - `.gitignore` 补防回渗规则：`*.sqlite-shm` / `*.sqlite-wal`、`.env.bak-*`、一次性测试输出（jest_out.txt / test_out.txt / tmp_test.txt）。
  - 6 篇新文档补登主索引与就近索引（DESIGN-ARCH-072/073、DESIGN-PERF-001、DESIGN-SIZE-001、IMPL-DOC-001、快速配置说明），并补登漏网的 DESIGN-OTHER-005；阶段总数校正（03: 71→78、04: 37→38、07: 177→178）。
  - 结构基线下调（只降不升）：dangling-task 115→86、cross-layer-require 43→38、unresolved-require 24→0。

### Fixed

- **启动/长回合后历史在滚动缓冲里重复出现 2~3 份**（`services/backend/src/cli/tui/scrollbackPreserve.js`、`tui/app.js`）
  - **改了什么**：scrollbackPreserve 增加第三层「全屏帧整段转录重发抑制」（门控 `KHY_SUPPRESS_STATIC_REPRINT`，默认开）。识别 ink fullscreen 分支（ink.js:327 / instance.js:132）的单次 write `clearTerminal + fullStaticOutput + output`，用 inkRuntime 实例的 `fullStaticOutput` 做**字节级前缀校验**，通过则剥离冗余的整段转录重发，只留「就地清屏 + 活动帧」；跨 write 拆开的帧先暂存快照再判，`flush()` 兜底归还。`tui/app.js` 为规范化器注入 `getStaticSnapshot` 读取 ink 实例缓冲。快照缺失 / 校验失败 / 任一门控关（`KHY_PRESERVE_SCROLLBACK` 为总门）→ 逐字节回退今日行为。回归测试 `tests/cli/scrollbackPreserve.reprintGuard.test.js`（19 用例：四形态帧头、防误伤、拆帧、冻结快照、Buffer、门控组合）。
  - **为什么**：ink 在活动区高度 ≥ 终端行数时每次都把**累积的全部**已提交 `<Static>` 转录重写一遍；即使第二层已把清屏头改写为 ED0 就地擦除，只要转录高度超过视口，重写本身就必然滚屏，把重印头部推进原生 scrollback —— 与增量提交时已写入的同一批消息形成第二、三份完整副本（用户报「启动后会话重复几次」）。而重发是纯冗余：该分支只在上一帧活动区填满视口时触发，彼时全部转录早已增量写入终端。既有防线（liveRegionBudget / liveHeightClamp / overlayLiveBudget）只钳流式正文等特定成分，盖不住覆盖层、展开态等一切可能超顶的帧。
  - **影响范围**：仅影响 ink TUI 的 stdout 字节流；`<Static>` 增量提交模型、右栏看板画笔（`forceRailPaint` 检测 `\x1b[J` 不受剥离影响）、复制粘贴行为均不变。正常路径零延迟（帧单次 write 即判即剥），拆帧路径最多延迟到下一次 write 或退出 flush。

## 1.1.12

khy OS 1.1.12 — 补齐 Android APK 构建编排与发布版本同步。

### Added

- **Android APK 构建编排**（`platform/khy_platform/android_build.py`）
  - `khy build android` 现在可以定位 `apps/khy-mobile`、检查 JDK 与 Windows 长路径支持、按需准备 Android SDK、写入 `local.properties`、构建 Web 资源、执行 Gradle 并收集 APK。
  - Android SDK 默认放在用户目录下的 Khy-OS 数据路径，不进入 pip 包，NDK 默认保持为空以避免下载无原生依赖的工具链。

### Changed

- 主发布版本轨道统一升级到 `1.1.12`，覆盖 PyPI、npm、后端运行时、模块清单和后端锁文件。
- 发布门禁补齐 `check:khyos-pins` 入口，确保工具链固定检查在发布前实际执行。

### Compatibility

- 安装 / 升级：`pip install -U khy-os` 或 `npm install -g @khy-os/khy-os`；`khy --version` 应报告 `1.1.12`。
- 构建 APK：`khy build android`。

---
## 1.1.9

khy OS 1.1.9 — 精简体积、跨平台脚本补齐与若干修复。

### Added

- **审计日志与上下文压缩透明度**（`services/backend`）
  - **改了什么**：`src/services/auditLog.js` 补齐八字段契约（`timestamp` / `tool` / `params` /
    `result` / `permission` / `elapsed` / `user` / `sessionId`），`logToolExecution` 改为幂等
    （2s 窗口内同一次执行重复上报只落一行，返回 `{written, deduped, reason}`），
    `getModuleStats({module})` 可按工具名前缀收窄统计，`clearAuditLog()` 清空前把旧文件存为
    `.bak` 并如实上报是否覆盖了上一份快照。新增纯叶子 `src/utils/khyError.js` 提供错误四件套
    `{code, message, hint, recoverable, retryable}`；`compactionUiPort.js` 新增第 4 条通道
    `emitCompactionNotice`，由 `cli/aiRenderer.js` 自注册到 `cli/formatters.print*`。
    `contextCompressor.js` 的 11 处跳过分支与 5 处失败分支全部改为「动作 + 目标 + 进度」
    的可见提示 + 审计留痕（`context-compress` / `-skip` / `-degrade` 三个工具名分开，
    使 `errorCount` 不被正常跳过污染）。
  - **为什么**：压缩链路此前有十余处静默 `return noOp` 和裸 `catch`，「压缩成功」「有意跳过」
    「链路失败」三种截然不同的结果对用户长得一模一样 —— 状态栏显示 99% 占用却什么都不发生时，
    没有任何一行输出能说明原因。审计侧则因为写入方从不检查返回值，写失败也无从察觉。
  - **影响范围**：审计文件格式向后兼容（只增字段、不改字段名），`getAuditStats()` 保留为零参
    委托以兼容 `telemetryService.js` 的既有调用；9 处 `logToolExecution` 调用点全部忽略返回值，
    新返回值纯属增量。所有新增阈值集中为 8 个 `KHY_AUDIT_*` / `KHY_COMPACT_*` 环境变量
    （见 `services/backend/.env.example`），`KHY_COMPACT_NOTICE=0` 可一键关回旧的静默行为。

### Fixed

- **审计日志轮转在攒满 3 份备份后静默停工，`audit.jsonl` 无上限增长**
  - **改了什么**：重写 `_rotateIfNeeded()` 的轮转循环 —— 从最旧一代开始迭代（`i = keep … 1`），
    先删掉 `.keep`，每次 rename 前先删除目标路径，最后才把活动文件移到 `.1`。
  - **为什么**：Windows 的 `fs.renameSync` 拒绝覆盖已存在的目标。旧循环从 `MAX_BACKUPS - 1 = 2`
    起步，`.3` 永远没机会被删除，于是第 4 次轮转时 `.2 → .3` 撞上已存在的 `.3` 抛错，又被
    `catch {}` 吞掉 —— 三份备份齐全之后轮转就再也不会成功，而失败没有任何痕迹。
    旧代码里那句 `if (i + 1 > MAX_BACKUPS) unlinkSync(from)` 因 `i` 最大只到 2 而永不可达。
  - **影响范围**：仅影响审计文件的磁盘占用，不改变已落盘内容。新增回归测试连续轮转 5 代，
    断言 `.1/.2/.3` 世代正确且 `.4` 不出现、目录里只剩 3 个文件。

- **压缩器抛异常与「压缩模块不存在」被同一个裸 catch 吞成同一件事**
  - **改了什么**：`khyUpgradeRuntime.buildSlidingWindow` 不再 `catch {}`，改为把异常经
    `toKhyError` 归类后区分 `compressor-unavailable`（模块缺失，正常的可选依赖降级）与
    `compressor-threw`（链路真的坏了，按 error 级别报出）；同时把 logger 注入进
    `compress()` —— 此前没传，压缩器自己的跳过日志在生产主路径上全是死代码。
    legacy 尾部截断路径在确实丢弃了消息时也会报出保留比例。
  - **为什么**：一条坏掉的压缩链路和一个没安装的可选模块，在日志里长得完全一样，
    导致「自动压缩为什么不执行」无法从现场定位。
  - **影响范围**：只增加输出、不改变控制流与返回值。

### Changed

- **`khy update` 改为 GitHub Release 优先并显示全过程进度**
  - **改了什么**：更新索引 schema v1 增量支持 pip wheel / npm tgz 的 GitHub 构件 URL、大小与
    SHA-256；`github → pypi → npm → local` 级联中，GitHub 只有在当前安装渠道存在可验证构件时
    才会胜出，下载后按大小与哈希校验并从本地文件安装。TTY 用单行进度条显示检查、下载、安装
    三阶段，非 TTY 按可配置间隔输出包含 `n/m`、百分比和速率的稳定行。
  - **为什么**：旧命令虽然先检查 GitHub 元数据，pip/npm 安装字节仍来自包仓库，GitHub 并非真实
    首选源；下载和安装期间也只有底层 pip 文本，无法稳定判断动作、目标与进度。
  - **影响范围**：旧的 name/version-only 更新索引继续合法，缺构件、GitHub 不可达或索引过旧时
    自动降级到 PyPI/npm；`KHY_UPDATE_STREAM_PROGRESS=0` 可关闭进度输出，下载活动超时和非 TTY
    输出间隔可分别用 `KHY_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS` / `KHY_UPDATE_PROGRESS_MIN_INTERVAL_MS` 调整。

- **体积精简**: 新增 `scripts/maintenance/slim-down.{bat,sh}` 一键清理脚本（日志、构建产物、
  sqlite 临时文件、未使用的 node-llama-cpp 多平台二进制），幂等且双平台覆盖；日志轮转收紧
  （`maxFiles` 7d/14d + `zippedArchive`）防单日日志爆量。
- **跨平台脚本**: 补齐 `slim-down.sh` 与 `khy.sh repair` 支持，bat/sh 配对完整。

### Fixed

- **模型「说要搜索却不调工具」**:同一个模型在能力缓存里留下了两条键不同、裁决相反的记录
  (`api:agnes:agnes-2.5-flash` → `text`,来自主动探测;`agnes-2.5-flash` → `native`,来自被动学习),
  而两道决定工具协议的闸各读一条:教学门拿路由 id、剥离门拿裸模型名。结果模型在同一轮里
  既收到完整的原生工具定义,又收到「你没有原生工具,请用 `<tool_call>` 文本语法」的教学 ——
  指令自相矛盾,模型于是只用散文说「我先用 WebSearch 搜索」,一个工具都不调,自我重驱一次后
  输出同样的段落并结束该轮。
  - 新增纯叶子 `services/gateway/capabilityModelKey.js`:能力缓存的键统一折叠为**裸模型名**,
    剥前缀的约定与 `apiAdapter.parseProviderModel` 同源(测试里有对撞断言防止三份正则各自演化)。
    ollama 风格的量化/尺寸 tag(`qwen:7b`)绝不误剥,否则不同模型会塌成同一条记录。
  - `toolCapabilityStore` 加载时**就地迁移**历史带前缀的键并落盘,已有缓存文件自愈,撞键时
    `native` 胜 `text`。
  - `recordVerdict` 新增**不静默降级**不变量:已确证 `native` 时,一次 `text` 观测不再覆盖它 ——
    「见过真实的原生 tool_calls」是正面证据,「这次没看到」只是证据的缺席(探测用极简工具 +
    极短 maxTokens,假阴性正常)。降级只能显式发生:`khy gateway probe-tools` 主动重测(现在传
    `force`),或 `KHY_TEXT_ONLY_TOOL_MODELS` 钉死。

### Changed

- **TUI 任务看板改为「右栏」，与正文平齐贯穿整屏**：看板不再作为 ink flex 行里的右列子元素渲染。
  ink 活动区永远画在已提交的 `<Static>` 滚动区之下，所以树内看板结构性地被钉在视口底部，
  右上方那一大片空间永久浪费。现在改为两步：ink 渲染的一切收窄到 `cols - 栏宽`（新叶子
  `railLayout.contentCols` 是唯一真源，经 `effectiveCols` 供各渲染路径读取），最右侧那几列
  预留出来，由 `runtime/sidebarRail` 用「存光标 → 逐行绝对定位 → 取光标」的字节把看板画进
  槽位，从屏幕第 1 行铺到 `rows - 1` 行。
  - 画笔字节被**追加进 ink 自己的那一次 `write()`**（`app.jsx` 已有的 stdout Proxy），
    整行擦除与重画因此是一次原子写入，屏幕上不存在「已擦除、未重画」的中间态 = 不闪烁。
  - 全程不含 `\n`/`\r`、不改 scroll region，`<Static>` + 终端原生 scrollback 的输出模型
    与复制粘贴行为完全不动；不新增定时器（复用 App 每秒的 `nowTick` 心跳）。
  - `/model`、`/review` 等原生交互界面前后自动 suspend/resume，resize 变窄时先清旧几何，
    退出路径清空槽位。
  - 门控 `KHY_SIDEBAR_RAIL` **默认开**；`KHY_SIDEBAR_RAIL=0` 逐字节回到树内看板的旧行为。
    宽度/配色沿用既有 `KHY_SIDEBAR*` 一族；约束高度的 `KHY_SIDEBAR_MAX_RATIO` /
    `KHY_SIDEBAR_MIN_CHROME` / `KHY_SIDEBAR_STACK_MAX_RATIO` 对右栏不再适用（它不占活动区行）。
  - 窄于 `KHY_SIDEBAR_MIN_COLS`（默认 120 列）或非 TTY → 不激活，完全走 legacy 路径。

## 1.1.8

khy OS 1.1.8 — 安全加固、CI 流水线完善、前端体验优化与便携模式增强。

### Highlights

- **安全加固**: 修复命令注入防护与会话撤销竞态条件 (d525650)，后端网关适配器、守护进程管理与启动恢复的全面硬化 (efb676b)。
- **CI/CD 完善**: 发布构件增加平台后缀防止覆盖 (18f60b8)；GitHub Release 写权限修复 (2a93fcc)；构建工具链锁定 Node 22 (5e31d1b)；独立构建所需打包脚本取消忽略 (b778b92)。
- **前端体验**: 浮动球、路由预加载与 AI 聊天视图改进 (338e3c2)；TUI 稳定性修复与输入→渲染性能优化 (f4e6541)。
- **便携模式**: 新增 portable 打包、健康检查与自愈工具链 (7970831)。
- **基础设施**: 后端版本同步机制与 SQLite 启动探测，`better-sqlite3` 降级为可选依赖 (893da15)；新增 `khyos-markdown` MCP 服务器 (1ceca37)。
- **测试**: TUI 渲染测试更新 (b336ca7)。

### Compatibility

- 安装 / 升级: `pip install -U khy-os` 或 `npm install -g @khy-os/khy-os`；`khy --version` 应报告 `1.1.8`。
- Node.js >= 20 要求不变。
- `better-sqlite3` 不再为强制依赖，无原生模块环境下自动回退至 `node:sqlite`。

---
