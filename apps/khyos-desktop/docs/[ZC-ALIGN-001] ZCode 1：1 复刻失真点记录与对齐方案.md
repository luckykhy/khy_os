# [ZC-ALIGN-001] ZCode 1:1 复刻 — 失真点记录与对齐方案

> 本文件是 `apps/khyos-desktop` 对真实 ZCode Desktop v3.11.2 做 1:1 复刻的
> **失真盘点 + 对齐方案**。它是操作手册，**不覆盖** DESIGN-ARCH-092 的唯一真源地位：
> 一切数值（几何、文案、令牌、RPC）仍以 `zcode-analysis/` 真源文件为准，本文件只把
> 真源映射回当前实现、定位偏差并给出修法。

- 审计日期：2026-09-11
- 审计对象：`apps/khyos-desktop`（当前 `out/` 构建 + `src/renderer`）
- 基线对象：真实 ZCode Desktop v3.11.2（`C:\Program Files\ZCode\ZCode.exe`，pid 11644）
- 审计方法：computer-use 双窗口逐项观察（ZCode 主工作区截图 + a11y 树）+ 复刻 `out/` 直接
  以 `node_modules/electron/dist/electron.exe out/main/index.js` 启动 + 源码精读
  （`Sidebar.tsx` / `WorkspaceSidebar.tsx` / `App.tsx` / `Composer.tsx` / `LoginPage.tsx` /
  `TitleBar.tsx` / `StatusBar.tsx`）+ 真源脚本（`.check_i18n.cjs` / `.check_i18n2.cjs` /
  `.check_tokens.cjs`）批量比对。

---

## 0. 完成度结论

复刻目前只覆盖 **Phase 0a/0b/0c 骨架 + Phase 1 令牌 + Phase 3 i18n 文案（5070 键已落盘）**
+ Phase 2 的**一个极简布局骨架**。CLAUDE.md 里「状态：全部待实现」仍准确——
当前 `src/renderer` 的组件深度（32 个 .tsx）远未达到 092 规划的四段式 IDE 复杂度。
**最严重的失真不是某个数值，而是「首屏根本不是 ZCode 的 IDE」。**

复刻与真实 ZCode 的差异可归为四档：
1. **结构性失真（P0）**：首屏/布局/导航/Composer/状态栏/TitleBar 全部与 ZCode 不符。
2. **尺寸失真（P0-P1）**：TitleBar、侧栏、窗口几何与 ZCode 实测不一致。
3. **文案失真（P1）**：组件硬编码了大量中文文案，未走 i18n；i18n 真源本身有品牌残留。
4. **品牌/资产失真（P1-P2）**：模型名、图标、欢迎语、域名等与品牌规则冲突。

---

## 1. 失真点清单（逐项：真源 → 现状 → 偏差 → 修法）

### P0-1 首屏失真：复刻以「登录页」为首屏，ZCode 无此形态
- **真源（ZCode 实测）**：ZCode 启动后**没有**独立登录首屏。它是 IDE 主布局——
  左 330px 任务侧栏 + 顶 tab 栏 + 主内容（chat 空状态或会话流）+ 右 Composer
  （模型/模式/上下文/停止生成）+ 底状态栏（账号/移动端/设置）。登录/账号是
  `login`/`logout` 命名空间（32/5 键）覆盖的**设置能力**，不是首屏闸门。
- **现状（复刻 `App.tsx:26` `useState<AppView>('login')`）**：默认 `view='login'` →
  渲染 `LoginPage`（左侧 4 卡片 + 右侧用户名/密码 + 「跳过登录（本地模式）」）。
  点「跳过登录」才到 `WelcomePage`（`LoginPage.tsx:125` 的 4 快捷卡 + 单行输入）。
- **偏差**：两个完整视图（Login、Welcome）是 ZCode **不存在**的自造首屏。ZCode 的空状态
  由 `chat.empty.title="开始对话"` / `chat.empty.description="开始在 {workspace} 项目新建任务"`
  表达，嵌在主布局里，不是全屏居中卡片。
- **修法**：删除 `login`/`welcome` 两个 `AppView`；首屏直接渲染 `AppLayout`（TitleBar +
  Sidebar + WorkspaceSidebar + 主区 chat 空状态 + Composer + StatusBar）。把
  `LoginPage` 降级为「设置 → 账号」子页（走 `login.*`/`logout.*` 键），不再做闸门。

### P0-2 布局失真：左「任务侧栏」内容完全不对
- **真源（ZCode 实测 + 092 §5.3）**：ZCode 左栏是**宽任务面板**
  （`--workspace-sidebar-panel-width` CSS 变量驱动、可拖拽，实测 ~330px），内含：
  顶部 `新建任务(Ctrl+N)`/`搜索(Ctrl+K)`/`自动化`/`插件市场` 四个大按钮 +
  视图 tab（`项目`/`分组`）+ 任务分组列表（`定时任务`/`整理` 等分组、会话项、
  归档、排序）。对应 44 个 `workspaceSidebar.*` i18n 键。
- **现状（复刻 `Sidebar.tsx` + `WorkspaceSidebar.tsx`）**：
  - `Sidebar.tsx` 是一个 **12px 宽图标条**（`任务/文件/Git/终端/浏览器` + 通知/设置），
    与 ZCode 左窄图标栏 `sidebar`（55 键）命名相近但内容自造。
  - `WorkspaceSidebar.tsx` 是 **280px 固定宽** 的任务列表（`style={{width:280}}`），
    只有搜索框 + `分组/时间线` 两 tab + 排序 select + 静态 3 任务 + 归档 + `新建/添加项目`。
    缺：`新建任务(Ctrl+N)`/`搜索(Ctrl+K)`/`自动化`/`插件市场` 顶部区、`项目/分组` 视图 tab、
    归档分区、拖拽重排、`44 键`中的绝大多数行为。
- **偏差**：宽度（280 vs CSS 变量可拖拽）、结构（无顶部导航区）、内容（自造 3 任务）全部不对。
- **修法**：WorkspaceSidebar 宽度改 `w-[var(--workspace-sidebar-panel-width)]`，用 `useResizer`
  拖拽（092 Step 2.3）；补顶部 `新建任务/搜索/自动化/插件市场` 区 + `项目/分组` 视图 tab +
  归档分区；任务列表接 host 进程真实会话数据（非静态 mock）。左图标条 `Sidebar` 按
  `sidebar`（55 键）对齐。

### P0-3 Composer 失真：复刻是「单行输入 + 发送按钮」，ZCode 是完整 Composer 区
- **真源（ZCode 实测 a18/a42-a56）**：Composer 区在右下角，含——
  `添加上下文`（has_menu）、`上下文已用 76,160 / 总量 1,000,000`（pressable 统计）、
  `选择模型`（has_menu，显示 `Agnes AI / agnes-3.0-flash`）、`切换模式 = 完全访问`
  （combobox）、输入框 `继续输入以排队后续修改`、`停止生成` 按钮。
- **现状（复刻 `Composer.tsx` + `WelcomePage` 输入框）**：
  - 主区 `Composer` 是一个 `textarea`（min 80px）+ 工具栏（附件/语音/图片 svg +
    `@ # $ /` 提示 + `发送` 按钮）。提及菜单是自造 `MENTION_CATEGORIES`（@/#/$//）。
  - `WelcomePage` 是更简陋的 `input`（`描述你想做的事情...`）+ 圆形 `→` 按钮。
  - **缺**：模型选择器、模式选择器（`完全访问`）、上下文用量条、停止生成、
    排队输入（`继续输入以排队后续修改`）。这些在 `App.tsx` 里是被 `ModeSelector`
    + `ContextUsagePanel` 单独塞在底部区，形态与 ZCode 的「Composer 右下角一簇」不同。
- **偏差**：ZCode 把「模型/模式/上下文/停止」聚在 Composer 输入框**同一行右下角**；
  复刻拆散到主列底部，且无「停止生成」「排队后续修改」「上下文用量」三件套。
- **修法**：按 092 Phase 5 把 Composer 做成右下角整簇：`+添加上下文`｜`⚙模式(完全访问)`｜
  输入框(`继续输入以排队后续修改`)｜`上下文已用 X/Y`｜`模型选择器`｜`停止生成`。
  删除 `WelcomePage` 的独立输入框（随 P0-1 一起）。

### P0-4 状态栏失真：复刻是「模型/模式/用量/就绪」文本条，ZCode 是「账号/远控/设置」
- **真源（ZCode 实测 a126-a131）**：底状态栏 = 账号 chip（`ntblocfk` + avatar + has_menu）
  + `移动端远程控制` 按钮 + `设置` 按钮。
- **现状（复刻 `StatusBar.tsx`）**：`h-7` 文本条，含 `● KhyOS Desktop` + `模型 GLM-5.3Max`
  + `模式 默认模式` + `ContextUsageBar` + `就绪/已工作/等待响应`。
- **偏差**：内容集合完全不同。ZCode 状态栏管「账号与入口」，复刻状态栏管「会话状态」，
  且模型名 `GLM-5.3Max` 是硬编码品牌残留。
- **修法**：状态栏左 = 账号 chip（`login.*`/`logout.*`）；右 = `移动端远程控制`
  （`webRemoteControl` 104 键）+ `设置`（`settings` 1724 键）。把「模型/模式/用量/状态」
  移到 Composer 右下角（见 P0-3）与消息流顶部 `appHeader`。

### P0-5 TitleBar 失真：复刻是「纯 KhyOS Desktop 文本 + 46px 按钮」，ZCode 是「会话 tab 头」
- **真源（ZCode 实测 a106-a118 + a17/a20）**：顶栏 = `切换侧边栏` 图标 + 前进/后退 +
  会话标题（`khyos zcode复刻对比与失真对齐方案`）+ `khy-os` 工作区 chip +
  `选择打开方式`/`在资源管理器中打开`/`更多` + `展开侧边面板`/`切换终端`/`窗口菜单`
  + 右侧系统 caption（`最小化/最大化/关闭`，`titleBar.window.*` 键，**无 `window.close`
  键**=关闭按钮用无文案图标）。
- **现状（复刻 `TitleBar.tsx`）**：`h-[48px]`（常量 `TITLEBAR_HEIGHT=48`），左侧
  `KhyOS Desktop` 文本 + 右侧 `minimize/maximize/close` 三个 `46px` svg 按钮。
  无会话标题、无工作区 chip、无侧栏/终端/面板切换。
- **偏差**：ZCode 顶栏承载「会话 + 工作区 + 面板开关」，复刻顶栏只是窗口 caption。
  且 ZCode Windows TitleBar 高在 a18 实测为 `bounds=[0,0,330,70]`（含 tab），复刻写死 48px。
- **修法**：TitleBar 加 `切换侧边栏`/前进/后退 + 会话标题 + `workspacePath` chip +
  `选择打开方式/资源管理器/更多` + `展开侧边面板/切换终端/窗口菜单`；高度与
  `--ui` 令牌对齐（勿写死 48）。caption 按钮 `close` 保持无文案图标。

### P1-1 模型名/品牌残留：`GLM-5.3Max` 硬编码在两处
- **真源（CLAUDE.md 品牌规则 + 092 §13.2）**：复刻不复用 ZCode/GLM 品牌资产；
  模型名应从 host 进程/设置读取，不得写死 `GLM-*`。
- **现状**：`AppLayout.tsx`（`<StatusBar model="GLM-5.3Max" .../>`）与
  `AppHeader.tsx`（`modelName="GLM-5.3Max"`）两处硬编码 `GLM-5.3Max`。
  `.check_i18n2.cjs` 命中 2 个文件。
- **偏差**：品牌残留 + 零硬编码红线（模型名应从 serviceDefaults/env 或设置注入）。
- **修法**：删除字面量；模型名从 host 进程的 model 真源读（`ENV_PROVIDER_MAP` 已有
  `glm`/`agnes`/`qwen` 等映射），状态栏/顶栏显示实际选中模型。

### P1-2 i18n 真源存在品牌残留（81 个键含 ZCode/GLM/智谱/z.ai/khyquant.top/KhyOS）
- **现状（`.check_i18n2.cjs`）**：`src/renderer/i18n/zh-CN.json` 5070 键里，81 个值仍含
  `KhyOS`/`khyquant.top` 等（多为**已替换**目标值，属正常品牌替换结果；但需确认无
  `ZCode`/`GLM`/`智谱`/`zcode.z.ai` 原词残留）。
- **偏差**：若 81 键里有未替换的 `ZCode`/`GLM`/`智谱` 原词 → 违反 092 §13.2「品牌替换完整」。
- **修法**：跑 `node scripts/ci/check-brand-replacement.js`（092 验收命令）逐条比对；
  对命中原词者替换为目标品牌；保留 092 允许的 `welcome.title="Welcome to KhyOS"`
  （唯一英文标题，已品牌化为 KhyOS，正确）。

### P1-3 组件硬编码文案未走 i18n（i18n 形同虚设）
- **现状**：`LoginPage`/`WelcomePage`/`WorkspaceSidebar`/`StatusBar`/`TitleBar`/
  `Composer` 里大量中文是**写死在 .tsx 里**（如 `登录`/`新建任务`/`还没有任务`/
  `描述你想做的事情...`/`搜索任务...`/`添加项目`），没有调 `t()`。
  虽然 5070 键 i18n 已落盘，但组件不消费 → 文案双份维护，且与真源脱钩。
- **偏差**：违反 092 §6「i18n 零 diff / 组件消费 locale」。
- **修法**：所有组件中文改 `t('<ns>.<key>')`，键名取自 `zcode-analysis/i18n-zh.json`；
  新增 CI：`check-i18n-fidelity.js`（092 已有脚本）扫描组件内裸中文并报警。

### P2-1 图标资产失真：全部用 emoji 占位，非 ZCode 图标体系
- **真源（092 §5）**：ZCode 用 `icon-*` 图标文件 + `GLM 图标素材`（品牌资产，不可复用，需自研替换）。
- **现状**：`Sidebar`/`WorkspaceSidebar`/`Composer`/`LoginPage` 全部用 `📋📁🔀💻🌐🔔⚙️📝📂➕`
  等 emoji 作图标。
- **偏差**：ZCode 是矢量图标（lucide/自制），emoji 在 Windows 下渲染不一致（实测截图里
  `📂`/`🐛` 渲染为彩色 emoji，与 ZCode 单色线性图标观感不符）。
- **修法**：引入 lucide-react（ZCode 同款）或自研 SVG 图标集，替换全部 emoji；
  图标命名与 `sidebar`(55)/`workspaceSidebar`(44) 键对应。

### P2-2 侧栏「分组/时间线」tab 文案与真源键名不符
- **真源**：`workspaceSidebar.organizeGrouped="分组"`/`organizeChronologicalList="时间线"`。
- **现状**：`WorkspaceSidebar.tsx` 写死 `分组`/`时间线`（值对，但没走键，见 P1-3）。
- **修法**：并入 P1-3 统一改 `t()`。

### P3-1 任务侧栏数据失真：侧栏任务为静态 mock，与 KhyOS 后端真实会话脱钩
- **真源（ZCode 实测 + 092 §4 任务侧栏）**：ZCode 左栏任务列表是真实会话数据
  （本机会话 `修复Khyos后端` / `调研GitHub完善TUI交互设计文档` 等），非占位文案。
- **现状（2026-09-13 实查）**：`AppLayout.tsx` 写死 3 条 mock task
  （`实现登录功能`/`修复终端渲染问题`/`添加单元测试`）+ 2 条 mock 归档；
  `main/index.ts` 的 `session:list` 返回 `[]` stub，`preload` `listSessions()` 无参数、
  无真实数据。UI 侧栏虽显示「真实」任务项，但与后端 `.khy/sessions/` 持久化会话
  （本机实测 200 条）完全无关——属「假数据冒充真数据」，比 mock 更严重
  （误导用户以为是自己的会话）。
- **偏差**：CH-2 服务直调缺失。`sessionPersistence.listPersistedSessions()` 已存在且含
  title/model/messageCount/createdAt/updatedAt/cwd/firstUserMessage 完整真源字段，
  但桌面端未接线。
- **修法**（✅ 已完成 2026-09-13，第八轮）：host 进程新增 `session.list` 消息类型，
  动态 require `services/backend/src/services/sessionPersistence.js`（与 aiGateway 同通道、
  同 fail-soft 契约）；main 的 `session:list` 改为经 host fork IPC 转发（15s 超时兜底）；
  preload `listSessions(limit)` 透传参数；`AppLayout.tsx` 删除全部 mock task，改为
  `useEffect` 调 `listSessions(50)` 映射为 Task 列表（untitled 会话取 firstUserMessage
  前 40 字为标题）；`WorkspaceSidebar` 新增 `sessionError` prop，host 不可达时显示
  「会话列表读取失败」错误态而非「还没有任务」假空态。重建后 computer-use 实跑验证：
  侧栏渲染 50 条真实会话（`测试本地 maxTokens 上限`/`请讲解均线和金叉`/`1+1 等于几` 等，
  时间戳 14 小时前~7 天前，与 .khy/sessions 真源一致）。

### P3-2 侧栏视图 tab 文案与 ZCode 实测不符（分组/时间线 → 项目/分组）
- **真源（ZCode 实测 2026-09-13 a329/a330）**：ZCode 侧栏视图 tab 为「项目」+「分组」
  两个 tab（项目 = 按项目浏览会话，分组 = 按定时任务/整理等分组浏览），默认选中「项目」。
  复刻端写死「分组」+「时间线」，且默认选中「分组」。
- **现状（2026-09-13 实查）**：`WorkspaceSidebar.tsx` 视图切换区渲染 `分组`/`时间线` 两按钮，
  `AppLayout.tsx` `viewMode` 初始值 `grouped`。
- **偏差**：文案与默认选中态均与 ZCode 实测不符；「时间线」概念（按时间线浏览）在 ZCode
  中不存在，ZCode 用的是「项目」维度。
- **修法**（✅ 已完成 2026-09-13，第九轮）：`WorkspaceSidebar.tsx` 视图切换改「项目」
  （对应 chronological）/「分组」（对应 grouped），顺序与 ZCode 一致（项目在前）；
  `AppLayout.tsx` `viewMode` 初始值改 `chronological`（项目）。已重建验证：a281/a282 渲染
  `分组`/`项目`，默认选中「项目」。
  注：「时间线」概念映射到 i18n 键 `workspaceSidebar.organizeChronologicalList`，
  值与 ZCode 真源键名不一致（P2-2 遗留），下轮统一改 `t()` 时一并校准。

### P3-3 上下文用量条为自造假数据（12.4K/128K），非真实 token 统计
- **真源（ZCode 实测 2026-09-13 a54 + 092 §4）**：ZCode 主区「上下文用量」按钮显示
  真实 token 统计（`上下文已用 135,391 / 总量 1,000,000`），数据来自后端
  `tokenUsageService`。
- **现状（2026-09-13 实查）**：`ContextUsage.tsx` 写死 `used=12400, total=128000` +
  7 项自造 breakdown（系统提示词 4200 / 消息 3800 / …），与真实用量完全无关。
- **偏差**：CH-2 服务直调缺失。`tokenUsageService` 已存在且提供 `getMonthUsage`/
  `getTodayUsage`/`getRemainingQuota` 真源方法（本机实测本月 62,714,194 tokens / 690 次
  请求），但 UI 侧栏未接线，显示自造数据误导用户。
- **修法**（✅ 已完成 2026-09-13，第九轮）：host 进程新增 `token.usage` 消息类型，
  动态 require `services/backend/src/services/tokenUsageService.js`（与 aiGateway/
  sessionPersistence 同通道、同 fail-soft 契约）；main 新增 `token:usage` ipcMain.handle
  经 host fork IPC 转发（15s 超时兜底）；preload 加 `getTokenUsage()`；`ContextUsage.tsx`
  删除全部自造数据，改为 `useEffect` 调 `getTokenUsage()` 渲染真实
  本月/今日用量 + 配额进度条 + 超额提示（配额已用完时显示
  「本月配额已用完：请等待下月重置或升级订阅」）。已重建验证：主区显示
  「▶ Token 用量 62.7M / 100.0K (62714.2%)」——真实本月用量（超额），不再是自造
  12.4K/128K。
  注：`quota.limit` 默认 100K（免费档），真实用量 62.7M 远超配额，超额态显示为
  红色进度条 + 提示。

### P3-4 DiffSummary 为静态 mock（quicksort.ts +53 -2），非真实文件改动
- **真源（ZCode 实测 2026-09-13 a91）**：ZCode 主区「已更改文件」区段显示的是
  真实文件改动（`6 个文件已更改 -18 +211`），数据来自会话实际编辑的文件 diff。
- **现状（2026-09-13 实查）**：`App.tsx` 的 `DiffSummary` 传入写死的
  `quicksort.ts`/`quicksort.test.ts` mock（+53 -2），与任何真实文件改动无关；
  `DiffViewer.tsx` 的 `mockDiff` 是写死的 quicksort 代码行。
- **偏差**：假数据冒充真数据（同 P3-1 性质）。ZCode 空态下不渲染此区段，
  复刻端始终显示 mock diff 误导用户。
- **修法**（✅ 已完成 2026-09-13，第九轮）：`App.tsx` 移除写死的 quicksort mock，
  `DiffSummary` 改为 `diffFiles.length > 0` 条件渲染（当前 `diffFiles=[]` 空，
  空态下隐藏，与 ZCode 一致）。真实文件改动追踪需 host 接改动事件流
  （git diff / fs watch），属下轮处理项。`DiffViewer.tsx` 的 `mockDiff` 保留
  供未来接真实数据时复用组件结构，但不再在 `App.tsx` 中传入 mock。

### P3-5 上下文「已用/总量」语义失真：Token 用量面板显示的是月配额，非会话上下文窗口
- **真源（ZCode 实测 2026-09-14 a57 + 092 §4）**：ZCode Composer 右下角有
  「上下文已用 X / 总量 Y」按钮，X 是当前会话 prompt context 的已用 token，
  Y 是模型上下文窗口上限（本机实测 `75,184 / 总量 128,000`）。这是**会话级
  上下文窗口**概念。
- **现状（2026-09-14 实查）**：复刻端 `ContextUsage.tsx` 经 P3-3 已接
  `tokenUsageService` 真源，但语义错配——面板显示的是「本月配额」（`62.7M /
  100.0K (62714.2%)`，`getRemainingQuota` 的月度账本），且空态下也渲染，与
  ZCode 空态不显示用量区段的行为不符。月配额是**计费/订阅**概念，上下文
  窗口是**会话 prompt 预算**概念，两者完全不同。
- **偏差**：P3-3 接对了服务但接错了语义——「上下文已用/总量」需会话级
  prompt token 估算，月配额账本不能替代。且空态渲染策略与 ZCode 相反。
- **修法**（✅ 已完成 2026-09-14，第十轮）：
  1. 上下文估算真源：host 新增 `context.size` 桥，动态 require
     `tokenUsageService.estimateTokens(text)`（后端 `/cost` 与 gateway
     token-budget 同源启发式，非字符数粗估），返回 `{ used, total }`；
     上限取 `KHY_CONTEXT_WINDOW` env（零硬编码），缺省 128000（与 ZCode
     默认窗口一致）。main 加 `context:size` ipcMain.handle（15s 超时兜底）；
     preload 加 `estimateContextSize(text)`。
  2. 会话级上下文移入 Composer：`Composer.tsx` 工具行新增「上下文已用 X /
     总量 Y」按钮（对齐 ZCode a57 形态），数据经 host `estimateTokens` 真源
     估算（汇总消息流文本 + 当前输入，300ms 防抖 + 流式更新时同步刷新）；
     不再造假数据（估算失败时显示「上下文估算不可用」错误提示而非默认值）。
  3. 月配额面板降位：`ContextUsage.tsx` 标题改「Token 用量（本月配额）」明确
     语义；`App.tsx` 改 `messageCount > 0` 才渲染（空态隐藏，与 ZCode 一致），
     每会话的「上下文已用/总量」由 Composer 按钮承担，月配额仅作展开态补充。
  4. 已重建验证：Composer 工具行实测渲染「上下文已用 0 / 总量 128,000」
     （空态 0，输入/发消息后随 estimateTokens 更新），Token 用量面板在空态
     下不再渲染。

### P3-6 Composer 右下整簇缺失：复刻工具行无「添加上下文/背景任务/思考级」按钮
- **真源（ZCode 实测 2026-09-14 a47-a65）**：ZCode Composer 右下角一簇按
  序为——`发送` + `思考级 combobox(高)` + `选择模型` + `上下文已用 X/总量 Y`
  + `打开运行中的后台任务` + `切换模式=完全访问` + `添加上下文` + 输入框
  （placeholder「提出后续修改要求」）。共 7 个独立控件。
- **现状（2026-09-14 实查）**：复刻 `Composer.tsx` 工具行只有
  `上传图片/语音输入/添加附件` + `@/#/$ 提示` + `模型名(禁用)` + `停止生成`
  + `发送`；`ModeSelector`（默认模式）与思考强度（💭最高）被 `App.tsx`
  单独塞在 Composer 上方一行（非 ZCode 的「同一行右下角一簇」形态）；
  「添加上下文」（P3-5 修复后已有上下文已用按钮，但无独立的「添加上下文」
  菜单按钮，`has_menu`）、「打开运行中的后台任务」（Bash/子智能体计数）
  两控件完全缺失。
- **偏差**：P0-3「Composer 右下角整簇」仅部分完成——上下文已用按钮（P3-5）
  已对齐，但「添加上下文」`has_menu` 按钮与「后台任务」计数按钮未做，
  思考级/模式选择器位置与 ZCode 不同（复刻在上方独立行，ZCode 在右下角
  同簇）。
- **修法**（部分完成 2026-09-14，第十轮）：本轮完成上下文已用按钮（P3-5
  修复已覆盖）。余项（下轮处理）：① 加「添加上下文」`has_menu` 按钮
  （`composer.addContext` 命名空间，与 i18n 5070 键对齐）；② 加「后台任务」
  计数按钮（`composer.backgroundTasks`，需 host 接后台任务事件流）；③
  思考级/模式选择器移入 Composer 工具行右下角（与 ZCode 同簇），
  删 `App.tsx` 上方独立行的重复控件。

### P3-7 模型选择器为静态禁用 chip，未接后端 providerPresets 真源
- **真源（ZCode 实测 2026-09-15 a262「选择模型」has_menu + 092 §4）**：
  ZCode Composer 的「选择模型」是 `has_menu` 下拉，列出真实 provider + 模型
  （本机实测 `TokenRouter/ z-ai/glm-5.3-free`、`Agnes AI/ agnes-3.0-flash`
  等），数据来自后端网关 provider 目录。
- **现状（2026-09-15 实查）**：复刻 `Composer.tsx` 的模型位是一个
  **disabled** 的静态 chip（`GLM-5.3-Flash` 写死在 `App.tsx`
  `DEFAULT_MODEL_NAME`，`button ... disabled`），无下拉、无 provider 切换、
  不可点选——属「交互空壳 + 品牌残留」（GLM-5.3-Flash 是 P1-1 的 GLM 品牌
  残留，此处以禁用态规避了点击，但仍未接真源）。
- **偏差**：CH-2 服务直调缺失。后端 `services/backend/src/services/gateway/
  providerPresets.js` 已提供 `getProviderPresets()`（15 个 provider + 预置
  模型：OpenAI/Anthropic/Google Gemini/Vertex/DeepSeek/Agnes/胜算云/
  PackyCode/Moonshot/通义千问/智谱 GLM/OpenRouter/Groq/Together/Ollama），
  但桌面端模型选择器未接线。
- **修法**（✅ 已完成 2026-09-15，第十一轮）：host 新增 `models.list` 消息
  类型，动态 require `providerPresets.js` + `builtinProviderConfig.js`（poolKey
  映射）（与 aiGateway/sessionPersistence 同通道、同 fail-soft 契约）；
  main 加 `models:list` ipcMain.handle（15s 超时兜底 + pendingModelList map）；
  preload 加 `listModels(adapterKey?)`；新增 `useModelCatalog` hook（模块级
  缓存 + fail-soft）；`Composer.tsx` 新增 `ModelSelector` 组件（provider 一级
  + 模型二级，搜索框，接真源选项）。模型选项的 `channel` 字段用后端池 key
  （poolKey，网关 `preferredAdapter` 认的名字），`channelKnown=false` 时
  （聚合网关等未注册池）不钉 `preferredAdapter`（避免 AGENTS 红线「未注册
  通道静默空返回」）。重建后 computer-use 实跑验证：模型下拉渲染 15 个真实
  provider（智谱 GLM · glm-5.2 / 通义千问 · qwen-plus / Moonshot / Agnes AI /
  OpenAI · gpt-4o-mini / Anthropic · claude-sonnet-4-6 等 + 模型子项），
  与 ZCode「选择模型」combobox 形态一致。

### P3-8 Composer 右下整簇缺「添加上下文」菜单按钮 + 推理强度未入工具行
- **真源（ZCode 实测 2026-09-15 a271「添加上下文」has_menu + a259 思考级
  combobox「高」）**：ZCode Composer 右下角有独立的「添加上下文」菜单按钮
  （`has_menu`，i18n `chat.composer.actionMenu`）与思考级 combobox
  （`chat.toolbar.thoughtLevel.*`，值「高」）。
- **现状（2026-09-15 实查）**：复刻 `Composer.tsx` 工具行虽有「上下文已用/
  总量」按钮（P3-5 已做），但**无独立的「添加上下文」菜单按钮**（@ 提及是
  触发式，非独立 has_menu 按钮）；推理强度（💭最高）仍在 `App.tsx` Composer
  上方独立行，未并入工具行右下角同簇。
- **偏差**：P3-6 余项未闭环——「添加上下文」菜单按钮缺失、推理强度位置
  与 ZCode 不同（ZCode 在右下角同簇，复刻在上方独立行）。
- **修法**（✅ 已完成 2026-09-15，第十一轮）：`Composer.tsx` 新增
  `AddContextButton`（has_menu 下拉：工作区文件/网页/会话，对齐
  `chat.composer.actionMenu`）+ `ThoughtLevelButton`（对齐
  `chat.toolbar.thoughtLevel.*`，值「不思考/低/高/最高」）；两者并入工具行
  右下角同簇（上下文已用 → 添加上下文 → 推理强度 → 模型 → 停止 → 发送）；
  `App.tsx` 删 Composer 上方独立的「模式选择器 + 思考强度」行，改经
  `onThoughtLevelChange` / `onModelChange` props 下传（对齐 ZCode 同簇形态）。
  重建后 computer-use 实跑验证：工具行渲染「添加上下文」「最高」推理强度
  按钮 + 模型选择器 + 上下文已用按钮，与 ZCode 右下角整簇一致。

### P2-3 四进程未全量启动（host/scheduler 未拉起）
- **真源（CLAUDE.md + 092 Phase 0d）**：`main/host/scheduler/preload` 四进程。
- **现状**：本次以 `electron out/main/index.js` 启动，只跑了 `main`（+preload），
  `host`/`scheduler` 子进程由 main 内 `fork` 拉起，需确认 `fork` 目标在 `out/host`、
  `out/scheduler` 且当前是否真起来了（日志里未见）。
- **修法**：跑 `npm run electron:dev`（`electron-vite dev` 全四进程）确认 host/scheduler
  存活；`.dev_run.log` 显示 npm 缺失，需用 `D:\Portable\Tools\commandcode\npm-global` 的
  node 直接 `node node_modules/electron-vite/bin/electron-vite.js dev` 或补 npm PATH。

### P0-6 preload 构建产物与 main 引用扩展名不一致（ENOENT，renderer 无桥接）
- **真源（`electron.vite.config.ts` + `package.json` `type: "module"`）**：electron-vite
  按 ESM 把 `src/preload/index.ts` 构建为 **`out/preload/index.mjs`**；而 `main`（已构建
  `out/main/index.js`）里两处 `webPreferences.preload` 均写死
  `path.join(__dirname, "../preload/index.js")`（`createWindow` 主窗口 + `openKeyManagerWindow`
  密钥管理窗口，共 2 处）。
- **现状（四进程验收实跑 2026-09-11）**：
  - 启动 `electron out/main/index.js` 后，main 正常 fork 出 host
    （`[host] 进程启动` + `{"type":"ready"}` 可见），scheduler 需单独起（main 未 fork，
    见 P2-3），host/scheduler 两进程单独验收均能启动并打印 ready。
  - 但两条 Electron CONSOLE 报错：**`Unable to load preload script: out\preload\index.js`
    → `ENOENT: no such file or directory`**（主窗口 + 密钥管理窗口各一条）。
    即 preload 从未被注入，`window.__KHYOS__`（TitleBar 最小化/最大化/关闭、菜单 IPC、
    127 个 RPC 方法）全部失效——当前界面「能渲染」是绕过 preload 的假象，交互层是空壳。
- **偏差**：产物 `index.mjs` vs 引用 `index.js`，扩展名分叉；属 092 Phase 0b「加 preload」
  未真正闭环，比 P2-3 更靠前（renderer 与 main/host 之间断链）。
- **修法（二选一，按 092 真源）**：
  1. **正门（推荐）**：`src/main/index.ts` 的 preload 路径改为指向 `../preload/index.mjs`
     并按 `type: module` 保持 main 为 ESM（main 已是 ESM，`import` 语法可证）；重新
     `electron-vite build`。
  2. 或让 preload 产物也出 `.js`（在 `electron.vite.config.ts` 的 preload build 里指定
     `output.entryFileNames: '[name].js'` + `format: 'cjs'`，并把 `package.json` 去掉
     `type: module` 影响面评估后再改）——涉及面大，不推荐。
  修完后重跑四进程验收，`Unable to load preload script` 必须为 0 条，且
  `TitleBar` 的 `__KHYOS__.minimizeWindow()` 可点通。

### P1-4 构建工具链缺口：本地 `.bin` shim 缺失 + npm 未安装
- **现状（2026-09-11 实查）**：
  - `node_modules/.bin/` 目录**不存在**（pnpm 布局只生成了 `.pnpm/electron-vite@5.0.0/.../bin/`
    的 `electron-vite.js`，没落 `.bin/electron-vite.cmd`）→ `npm run electron:dev`
    报 `electron-vite 不是内部或外部命令`。
  - 系统 npm 未安装（`where npm` 无命中；`npm-global` 只有 `command-code` 包）。
- **偏差**：092 §0.4 验收命令 `npm run dev` / `npm run electron:dev` 在本机不可直接执行，
  只能手动 `electron.exe out/main/index.js` 绕过——验收路径偏离真源。
- **修法**：
  1. 补 npm（本机无管理员）：已手工把 npm 10.9.2 装到
     `D:\Portable\Tools\commandcode\npm-global\node_modules\npm` 并写 `npm.cmd`/`npx.cmd`
     shim（node 22.18 兼容），用户 PATH 已含该目录（`where npm` 在**新** shell 应命中）。
  2. 修 `.bin` 缺失（**已做**，2026-09-11 兜底落地）：`package.json` 5 处脚本已由
     `electron-vite dev`/`vite build ...` 直接改写为
     `node node_modules/electron-vite/bin/electron-vite.js dev` 与
     `node node_modules/vite/bin/vite.js build ...`（跨平台、不依赖 `.bin` shim）。
     验证结果：`npm.cmd run electron:dev` 实跑成功——main 构建成功（`out/main/index.js` 56.92 kB）、
     preload 构建成功（`out/preload/index.mjs` 3.26 kB，进一步坐实 P0-6 的 `.mjs` 产物名）、
     dev server `http://localhost:5173`、`[host] 进程启动 pid:8452` + `{"type":"ready"}`、
     electron 主窗口拉起（5 个 electron.exe 进程）。
     遗留：vite 对 `src/main/keyManager/*` 动态/静态 import 循环报 warning（非致命，
     后续可评估拆分）；scheduler 仍未由 main fork（P2-3）。
  3. 可选正门（若团队统一用 pnpm）：`pnpm install` 重新生成 `node_modules/.bin` shim，
     再把 `package.json` 脚本改回 `electron-vite dev` 等简短形式；当前兜底脚本在
     npm/pnpm 混装环境都可用，暂不必动。

---

## 2. 对齐方案（按优先级，可勾选）

### P0（必须先做，结构对齐）
- [x] **A1 拆登录闸门**（✅ 已完成 2026-09-12）：`App.tsx` 删 `login`/`welcome` 视图，首屏直接渲染 `AppLayout`；`LoginPage` 组件保留在 `components/auth` 供未来「设置→账号」入口。已构建验证：首屏即主布局，与 ZCode 一致。
- [ ] **A2 任务侧栏对齐**：`WorkspaceSidebar` 宽度改 `--workspace-sidebar-panel-width` 可拖拽；补顶部 `新建任务(Ctrl+N)/搜索(Ctrl+K)/自动化/插件市场` + `项目/分组` 视图 tab + 归档分区；任务接 host 真实数据。（当前 280px 固定宽 + 分组/时间线 tab 已有，顶部导航区/拖拽仍缺）
- [ ] **A3 Composer 右下角整簇**：合并 `添加上下文/模式/输入(排队后续修改)/上下文用量/模型选择器/停止生成` 到 Composer 同一行右下角。（当前模式/思考强度在左侧，模型选择器/停止生成/上下文用量仍缺）
- [x] **A4 状态栏改账号入口**（✅ 已完成 2026-09-12）：删除窗口底部 `StatusBar`（ZCode 实测无底状态栏）；`WorkspaceSidebar` 底部新增账号区（头像+用户名 chip + 移动端远程控制 + 设置，对齐 ZCode C1-C3 实测形态）。已构建验证。
- [x] **A5 TitleBar 改会话 tab 头**（✅ 部分完成 2026-09-12）：TitleBar 左侧改为 会话标题「新任务」+ `khy-os` 工作区 chip（对齐 D5 实测）。仍缺：切换侧边栏/前进/后退图标、右侧 面板/终端/窗口菜单按钮（D1-D4）。
- [x] **A6 preload 断链修复（P0-6）**（✅ 已完成 2026-09-12，方案修正）：根因不是扩展名而是 **Electron 沙箱 preload 不支持 ESM**（`index.mjs` 报 `Cannot use import statement outside a module`；真源 ZCode 的 preload 也是 `.cjs`）。修法：`electron.vite.config.ts` preload 段强制 `output: { format: 'cjs', entryFileNames: '[name].js' }`，main 两处引用保持 `index.js`。已验证：preload 注入成功、`Unable to load preload script` 0 条、`__KHYOS__` 可用。

### P0-新增（修复过程中发现的新根因，2026-09-12）
- [x] **N1 React error #527 白屏**（✅ 已修复）：`react@19.2.8` 与 `react-dom@19.3.0` 版本不匹配触发 React 19 一致性校验，renderer 白屏（pnpm 对 `^19.2.4` 解析漂移所致）。修法：`package.json` 钉死 `"react": "19.3.0"` + `"react-dom": "19.3.0"`，`pnpm install` 重装对齐。已验证：#527 消失、界面渲染。
- [x] **N2 Tailwind 未接入构建链**（✅ 已修复）：组件全部用 Tailwind 类名（`bg-card`/`text-foreground/70`/`border-border` 等），但 `electron.vite.config.ts` renderer 没接 `@tailwindcss/vite`，`globals.css` 是「纯 CSS 方案」只手写了少部分类 → 数百个类无效、界面呈原生 HTML 观感。修法：renderer plugins 加 `tailwindcss()`；`globals.css` 头部 `@import "tailwindcss"` + `@theme` 注册全部语义色令牌（暗色默认值，`:root`/`.theme-zai-light` 继续做主题切换）。产物 CSS 19KB→70KB。已验证：暗色主题贯穿、组件样式与 ZCode 观感一致。

### P0-第二轮修复（2026-09-12，边发现边改 + 后端接线）
- [x] **A2 任务侧栏（部分完成）**：`WorkspaceSidebar` 宽度改 `var(--workspace-sidebar-panel-width, 330px)`；新增顶部导航区四按钮 `新建任务 Ctrl+N / 搜索 Ctrl+K / 自动化 / 插件市场`（对齐 ZCode B1-B4 实测）；`AppLayout` 移除自造 12px 图标条（ZCode 无此元素），侧栏显隐由 TitleBar「切换侧边栏」控制。已 computer-use 验证。仍缺：拖拽调宽、`项目/分组` 视图 tab 文案（现为 分组/时间线）、任务项 hover 三按钮、接 host 真实任务数据。
- [x] **A5 TitleBar（余项完成）**：左侧补 `切换侧边栏 / 后退 / 前进` 图标，右侧补 `展开侧边面板 / 切换终端 / 窗口菜单` 图标（对齐 D1-D4）。已验证。
- [x] **空态对齐（E1/E2 文案）**：MessageList 删除 quicksort mock，空态显示六时段问候（真源 `chat.empty.greeting.*`）+「开始在 khy-os 项目新建任务」。已验证（截图「早上好呀，新的一天开始啦」）。
- [x] **主进程崩溃修复（ai.chunk 竞态）**：`handleHostMessage` 存的是 `e.sender`（WebContents）却按 BrowserWindow 访问 `.webContents.send` → 崩溃。修法：`BrowserWindow.fromWebContents(e.sender)` + `isDestroyed()` 守卫 + try/catch。已验证：发送消息后无崩溃对话框。
- [x] **后端接线（新增目标：可接线 KhyOS 后端）**：
  - 通道判定：host 进程与 backend 同 Node 语义 → **CH-2 服务直调**（host 运行时 `createRequire` 动态 require `services/backend/src/services/gateway/aiGateway.js`）；main↔host 走 Electron fork IPC；renderer↔main 走 preload `aiSend`/`onAiChunk`/`onAiResult`。
  - 后端发现：`KHY_OS_DIR` env 优先，回退 `cwd/../..`（零硬编码合规）。
  - 文件：`src/host/index.ts`（消息驱动桥 + 流式 onChunk 回传）、`src/main/index.ts`（`ai:send` 转发 + pendingAi map + 分发）、`src/preload/index.ts`（事件订阅）、`Composer.tsx`（dispatch addMessage/updateMessage + aiSend）、`MessageBubble.tsx`（MessageList 从 Redux store 读真实消息）、`App.tsx`（ai:chunk → appendMessageContent）。
  - 验证：host 日志 `[host] aiGateway 已加载: D:\...\aiGateway.js` 实证桥接成功；界面发送「你好，请用一句话介绍你自己」→ 用户/AI 气泡正常入流、无崩溃。
  - ✅ **端到端闭环已达成（2026-09-12 10:44）**：AI 气泡显示 aiGateway 真实回复——「我是 Agnes-3.0-flash，由 Sapiens AI 开发。很高兴为您服务。请问有什么可以帮您的吗？」。全链路 renderer→main→host→aiGateway→agnes-cn→真实模型→气泡渲染验证通过。
  - **网关配置方法（留档）**：`PROXY_PRIMARY_ADAPTER=relay_api + PROXY_PRIMARY_STRICT=true` 强制主通道为 API 中转；把可用的 OpenAI 兼容通道写入 `services/backend/.env`：`RELAY_API_KEY/RELAY_API_ENDPOINT/RELAY_API_MODEL=agnes-3.0-flash/RELAY_API_PROVIDER=openai-compatible`（本机用 ZCode 已配置的 Agnes 中国站凭据）。注意 `GATEWAY_PREFERRED_ADAPTER` 只认网关注册名（如 `api`/`relay_api`），`agnes` 等名字未注册会静默空返回。
  - **接线健壮性（本轮新增）**：host 预加载 `services/backend/.env`（不覆盖已有 env）；aiGateway 返回结构按实际 `{success, content, provider, actualAdapter, fallbackReason, attempts, errorType}` 提取（正文在 `content`）；网关 onChunk 的 `status` 事件（通道重试/冷却/切换）以斜体状态行透传到 AI 气泡，最终结果覆盖——前端与网关状态透明对齐；发送中 Composer 显示「正在等待 KhyOS 网关回复（host 已加载 aiGateway，多通道重试中）…」+ 停止按钮（`ai:abort` 放弃等待并如实说明底层请求仍在后台）。
  - **余留（网关侧，非接线问题）**：`require(...).getModelMesh is not a function` 的 mesh 路由 fail-soft 提示；模型名 `agnes-3.0-flash` 每次回复自报（khy 网关未做品牌别名映射，属后端网关配置项）。

### P0-第八轮修复（2026-09-13，每日 4 点自动任务）
- [x] **任务侧栏接真实会话（P3-1）**：host 新增 `session.list` 桥（require
  sessionPersistence.js，与 aiGateway 同发现逻辑 `resolveKhyOsDir()`）；main `session:list`
  走 host fork IPC（pendingSessionList map + 15s 超时）；preload 加 `listSessions(limit)`；
  AppLayout 删 mock、拉真实 50 条、首条自动选中；WorkspaceSidebar 错误态文案「会话列表
  读取失败：host 进程无响应，请重启应用」。改动 5 文件：`src/host/index.ts`、
  `src/main/index.ts`、`src/preload/index.ts`、`AppLayout.tsx`、`WorkspaceSidebar.tsx`。
  `check-agent-rules.js` 零违规、`check-version-sync.js` 通过（主轨道 1.1.15 /
  ai-backend 轨道 1.6.5）。
- [x] **Composer 右下整簇余项（P0-3 收尾 + P3-2/3/4）**（✅ 已完成 2026-09-13，第九轮）：
  ① Composer placeholder 在 `sending` 状态切换为「继续输入以排队后续修改」（对齐 ZCode
  排队语义，空闲态保留功能型文案）；② 侧栏视图 tab 改「项目/分组」+ 默认「项目」（P3-2）；
  ③ 上下文用量条接 `tokenUsageService` 真源（P3-3，host 新增 `token.usage` 桥）；
  ④ DiffSummary mock 移除（P3-4，`diffFiles=[]` 条件渲染，空态隐藏与 ZCode 一致）。
  改动 8 文件：`src/host/index.ts`、`src/main/index.ts`、`src/preload/index.ts`、
  `AppLayout.tsx`、`WorkspaceSidebar.tsx`、`App.tsx`、`ContextUsage.tsx`、`Composer.tsx`。
  `check-agent-rules.js`（8 文件）零违规、`check-version-sync.js` 通过。

### P0-第九轮修复（2026-09-13，每日 4 点自动任务）
- [x] **P3-2/P3-3/P3-4 + Composer 排队占位符**：见 P0-第八轮修复条目「✅ 已完成 2026-09-13，
  第九轮」子项。余留：① DiffSummary 真实文件改动追踪需 host 接改动事件流（git diff /
  fs watch），下轮处理；② `quota.limit` 默认 100K（免费档）导致真实用量 62.7M 显示
  超额，属订阅档配置项非接线问题；③ P2-2 i18n 键名校准（`workspaceSidebar.*`）随 B3
  统一处理。

### P0-第十轮修复（2026-09-14，每日 4 点自动任务）
- [x] **P3-5 上下文已用/总量 语义修复 + P3-6 Composer 右下整簇（上下文按钮）**：
  ① host 新增 `context.size` 桥（require `tokenUsageService.estimateTokens`，后端
  `/cost` 与 gateway token-budget 同源启发式；上限 `KHY_CONTEXT_WINDOW` env，缺省
  128000，零硬编码）；main 加 `context:size` ipcMain.handle（15s 超时兜底）；
  preload 加 `estimateContextSize(text)`。② `Composer.tsx` 工具行新增「上下文已用
  X / 总量 Y」按钮（对齐 ZCode a57 形态），数据经 host 真源估算（汇总消息流文本 +
  输入，300ms 防抖 + 流式刷新）；估算失败显示错误提示而非默认值（不造假）。③
  `ContextUsage.tsx` 标题改「Token 用量（本月配额）」明确语义；`App.tsx` 改
  `messageCount > 0` 才渲染用量面板（空态隐藏，与 ZCode 一致）。改动 6 文件：
  `src/host/index.ts`、`src/main/index.ts`、`src/preload/index.ts`、
  `Composer.tsx`、`ContextUsage.tsx`、`App.tsx`。`check-agent-rules.js` 零违规、
  `check-version-sync.js` 通过（主轨道 1.1.15 / ai-backend 轨道 1.6.5）。已重建
  验证：Composer 工具行实测渲染「上下文已用 0 / 总量 128,000」（空态 0，随输入/
  流式更新），Token 用量面板空态不渲染。
- [ ] **P3-6 余项（下轮）**：① 加「添加上下文」`has_menu` 按钮（`composer.addContext`
  命名空间）；② 加「打开运行中的后台任务」计数按钮（需 host 接后台任务事件流，
  Bash/子智能体计数，对齐 ZCode a58）；③ 思考级（`高` combobox）/模式（`完全访问`
  combobox）移入 Composer 工具行右下角同簇，删 `App.tsx` 上方独立行重复控件
  （ZCode 实测 a48/a51 在右下同一行，复刻目前在 Composer 上方独立行）。

### P0-第十一轮修复（2026-09-13，会话驱动；源码/i18n 文本级对齐，无视觉验证）
> 本轮约束：用户明示「你没有视觉能力」——不跑 computer-use 双窗口实拍。
> 对齐依据＝002 清单既有 ZCode 实测留档（s-2/s-3/s-25/s-43/s-45/s-49）+
> 092 i18n 真源键值 + 复刻源码逐文件核读。三项交付对应 002 清单
> H0/H2/H3/H5/H6/H7、I1/I2、B3/B4、K4 行（已同步翻绿，见 002）。

- [x] **侧边面板多标签容器 +「打开标签页」磁贴选择器（H0/H2/H3/H6/H7）**：
  `SidePane.tsx` 重做为磁贴选择器——标题「打开标签页」+ 副标题取 sidePane
  真源文案「选择要在侧边面板中打开的标签。」；磁贴 5 个：辅助对话/审查/
  终端/浏览器/打开文件（前四个对齐 ZCode s-3 会话态四磁贴；辅助对话仅
  会话态出现、空态隐藏，对齐 s-43 空态三磁贴实测；「打开文件」为 KhyOS
  扩展入口）；快捷键 Ctrl+Alt+B（面板）/Ctrl+J（终端）取 092 真源键位
  （ZCode 3.11.2 实测为 Ctrl+B，差异已在 002 K4 记录）；每标签可关闭 +
  「新增标签」回开选择器 +「关闭面板」。`AppLayout.tsx` 持多标签状态机
  （终端+审查可并存，对齐 ZCode 实测多标签形态），标签体全为真组件：
  `SelectionChatPane`（辅助对话，走 ai:send/ai:abort 与主会话同一网关）、
  `GitPanel`（审查）、`TerminalPanel`（终端，@xterm/xterm + FitAddon/
  WebLinks/Search 插件 + 令牌主题 `--color-terminal-*` + ResizeObserver
  refit；shell 为 stub 回显，PTY 未接见余留）、`BrowserPane`（浏览器，
  `<webview>` 真内嵌 + 导航/证书错误/崩溃四态，主进程 `webviewTag: true`）、
  `OpenFilePane`/`CodeViewerPane`（打开文件）。
- [x] **设置页 + 插件管理 + 自动化（I1/I2/B3/B4）**：`SettingsPage.tsx`
  全屏替换式 + 左导航三组（基础设置 5 项 / Agent 能力 7 项 / 数据与统计
  2 项，对齐 s-25 a101-a131 实测结构）+「引导」独立项 + 顶/底「返回
  工作区」+ 底部账户行；PAGE_META 15 个内容区；深链 `#/settings/plugins`。
  `PluginSettings.tsx` 已安装/发现 两页签 + 启停/卸载/检查更新（flash
  消息 + 卸载确认 + 安装路径详情 + 「共 N 个插件 · M 个已启用」页脚）；
  数据走 `src/main/pluginStore.ts` 正门（文件注册表 + 原子 .tmp+rename
  写入 + builtin 播种；写入只经 main IPC，renderer 无直写），main 侧
  `plugin:list/install/setEnabled/uninstall/checkUpdates` 5 个
  ipcMain.handle。自动化：`AutomationsPage`（`#/automations` 路由）+
  `automation:list/create/update/delete/runNow` 5 IPC（`automationStore`）；
  `WorkspaceSidebar` 侧栏「插件市场」→ `#/settings/plugins`、「自动化」→
  `#/automations`（对齐 ZCode a148/a149 实测入口）。
- [x] **应用内 Markdown 浏览（H5）+「打开文件」命令（K4 增量）**：main
  新增 `codeViewer:read`（只读预览，四态契约：ok / tooLarge（>256KB 上限）/
  binary（首 8KB NUL 字节探测）/ missing / empty）与 `workspace:listFiles`
  （工作区文本文件有界索引：深度≤8、上限 5000 条、忽略 node_modules/.git
  等噪声目录、仅文本扩展名 + 关键词过滤）；`CodeViewerPane.tsx` Markdown
  预览/源码双视图切换 + 自动换行开关 + 四态渲染；`OpenFilePane.tsx` 文件
  选择列表；`CommandCenter` 新增「打开文件」命令（→ `openFileTab`，与
  磁贴/侧栏同路径）。
- [x] **余留⑥ 引导独立项去组头 + 余留② 「搜索标签页」下拉**（✅ 已完成
  2026-09-14，第十二轮，见下方审计日志）：两项均落地并过全部门禁。
- [ ] **余留（下轮）**：① 终端 PTY 接线（ZCode 实测为原生 PowerShell、
  目录＝工作区根；当前 `Terminal.tsx` onData 仅回显 stub，需 node-pty +
  main 侧 PTY 服务）；② ~~「搜索标签页」按钮~~（✅ 已完成 2026-09-14
  第十二轮）；③ 多标签当前仅渲染活动标签（ZCode 并存渲染策略待核）；
  ④ 主进程 BrowserView* RPC 群（002 M2）未接，`<webview>` 为 renderer
  侧等效实现；⑤ 设置页 I3-I12 内容页多为薄空态/Pattern-B 列表，002 暂不
  翻绿、留待逐项深核对；⑥ ~~引导独立项带组标签「主要项」~~（✅ 已完成
  2026-09-14 第十二轮）。

### P0-第十二轮修复（2026-09-15，每日 4 点自动任务）
- [x] **P3-7 模型选择器接后端 providerPresets 真源（CH-2）**：host 新增
  `models.list` 消息类型，动态 require `providerPresets.js`（`getProviderPresets()`
  15 provider）+ `builtinProviderConfig.js`（poolKey 映射，provider 预设→网关池
  key）；main 加 `models:list` ipcMain.handle（15s 超时兜底 + pendingModelList
  map）；preload 加 `listModels(adapterKey?)`；新增 `useModelCatalog` hook
  （模块级缓存 + fail-soft）。`Composer.tsx` 新增 `ModelSelector`（provider
  一级 + 模型二级 + 搜索框，接真源选项）。选项的 `channel` 用池 key（网关
  `preferredAdapter` 认的名字），`channelKnown=false`（聚合网关等未注册池）
  不钉 `preferredAdapter`，避免 AGENTS 红线「未注册通道静默空返回」。
  模型选中后 `ai:send` 的 `options.preferredAdapter` 透传选中的池 key。
- [x] **P3-8 添加上下文菜单按钮 + 推理强度并入 Composer 工具行**：
  `Composer.tsx` 新增 `AddContextButton`（has_menu 下拉：工作区文件/网页/会话，
  对齐 i18n `chat.composer.actionMenu`）+ `ThoughtLevelButton`（对齐
  `chat.toolbar.thoughtLevel.*`，值「不思考/低/高/最高」）；两者与上下文已用、
  模型选择器同簇（对齐 ZCode a259/a271 实测）；`App.tsx` 删 Composer 上方
  独立的「模式选择器 + 思考强度」行，改经 `onThoughtLevelChange`/
  `onModelChange` props 下传。`App.tsx` 新增 `selectedModel` state，
  模型选择器选中态落 state（发送时透传 preferredAdapter）。
- 改动文件：`src/host/index.ts`、`src/main/index.ts`、`src/preload/index.ts`、
  `src/renderer/components/composer/Composer.tsx`、
  `src/renderer/utils/useModelCatalog.ts`（新）、`src/renderer/App.tsx`。
- 验证：重建 main/preload/renderer/host 四 bundle 重启，computer-use 实测
  模型下拉渲染 15 个真实 provider（智谱 GLM · glm-5.2 / 通义千问 · qwen-plus /
  Moonshot / Agnes AI · agnes-2.0-flash / OpenAI · gpt-4o-mini / Anthropic ·
  claude-sonnet-4-6 / DeepSeek / Google Gemini / Google Vertex AI / OpenRouter /
  Groq / Together / 本地 Ollama + 模型子项），工具行渲染「添加上下文」「最高」
  推理强度 + 模型选择器 + 「上下文已用 0 / 总量 128,000」按钮，与 ZCode
  右下角整簇一致。
- 检查：`check-agent-rules.js`（6 改动文件）零违规；`check-version-sync.js`
  通过（主轨道 1.1.15，ai-backend 轨道 1.6.5）。
- [x] **P3-6①「打开运行中的后台任务」计数按钮 + P3-7② 模型选中态持久化
  + P3-7③ 动态模型拉取 + P1-1④ GLM 品牌默认名清除**（✅ 已完成 2026-09-16，
  第十五轮）：
  ① host 新增 `background.status` 消息类型（`activeGenerations` Set 统计在途
  ai.generate，含自动化运行 `auto_` 前缀 id），`backgroundTaskStatus()`
  返回 `{count, bash, subagents, taskIds}`；main 加 `background:status`
  ipcMain.handle（15s 超时兜底 + pendingBackgroundStatus map）；preload 加
  `backgroundStatus()`；`Composer.tsx` 新增 `BackgroundTasksButton`（3s 轮询，
  纯 UI 计数刷新——规则 3 合规；count=0 隐藏，对齐 ZCode 空态无此按钮
  实测行为；i18n `chat.composer.backgroundWorks.ariaLabel` 模板
  「Bash {n} 个，子智能体 {n} 个，共 {n} 个」，Bash 工具子进程事件流桥
  （bash.start/stop）登记为下轮余留，本轮 bash 计数恒 0 不猜测）。
  ② `settingsStore.ts` DEFAULTS 增 `selectedModel: ''`；`useModelCatalog.ts`
  新增 `persistModelSelection(id)`（经 `setSetting` 原子写 fail-soft）与
  `loadPersistedModelSelection()`（启动恢复）；`App.tsx` 挂载恢复 +
  `handleModelChange` 落盘。实测：选 DeepSeek 后 settings.json 写入
  `"selectedModel": "deepseek"`，重启应用模型 chip 自动恢复
  「DeepSeek · deepseek-chat」。
  ③ host `listModelOptions` 的动态拉取段改为按 preset 前缀对齐
  （adapterKey→poolKey 匹配的 preset id 做前缀，找不到时回退 adapterKey
  本身 + groupByProvider 占位 provider），动态模型按 id 去重并入；
  `useModelCatalog.ts` 新增非 React `fetchDynamicModels(adapterKey)`
  （幂等：dynamicFetched Set 去重，避免按 provider 重复网络开销）；
  `App.tsx` 顶层经基线表解析选中 provider 的 channel，变化时调
  fetchDynamicModels 并入共享模块级缓存，Composer 与 AppHeader 经
  `getModelOptionLabel`（新增，全量选项表 label 解析 + 未知 id 退化 provider
  标签）共享同一缓存渲染。
  ④ 删除 `App.tsx` 的 `DEFAULT_MODEL_NAME = 'GLM-5.3-Flash'` 静态字面量
  （P1-1 品牌残留），AppHeader/两 Composer 的 modelName 改传
  `modelDisplayName`（选项表解析 + 未选中时「选择模型」占位符，ZCode 同源
  i18n `chat.toolbar.model.label` 语义）；`AppHeader.tsx` 注释同步更新。
- 改动文件（第十五轮，8 处）：`src/host/index.ts`、`src/main/index.ts`、
  `src/main/settingsStore.ts`、`src/preload/index.ts`、
  `src/renderer/components/composer/Composer.tsx`、
  `src/renderer/components/message/AppHeader.tsx`、
  `src/renderer/utils/useModelCatalog.ts`、`src/renderer/App.tsx`。
- 验证（第十五轮）：重建 4 bundle（main 114.48 kB / preload 9.70 kB /
  renderer 2183 kB / host 15.22 kB）重启实测：① 模型下拉渲染 21 选项
  真实 provider 表（无 GLM-5.3-Flash 品牌残留）；② 选 DeepSeek 后
  settings.json 落盘 + 重启自动恢复；③ 模型 chip 显示「DeepSeek ·
  deepseek-chat」非占位符；④ 空态下 BackgroundTasksButton 隐藏
  （count=0，与 ZCode 空态行为一致）。
- [ ] **余留（下轮）**：① P3-6① 余项——Bash 工具子进程计数事件流桥
  （khy 后端 bash 工具执行不经 aiGateway，需 host 接 bash.start/stop
  事件后 `backgroundTaskStatus().bash` 才有真值，本轮恒 0 不猜测）；
  ② 后台任务详情面板（ZCode `chat.backgroundWorks.panel`，点击按钮展开
  任务列表/日志），本轮按钮点击暂无面板（登记为下轮，避免静默无响应）；
  ③ `fetchDynamicModels` 的 adapter.listModels 真值验证（本轮静态 presets
  已覆盖，动态拉取需有凭据的 channel 才有非空结果——best-effort 空数组
  不报错，属预期 fail-soft）。

### P3-9 Composer 工具行模式按钮默认值与 ZCode 实测不一致（P1 文案失真）
- **真源**：ZCode s-2 实测（2026-09-16，pid 31668）Composer 工具行「切换
  模式」combobox 值 = **完全访问**（i18n `mode.label.glm.yolo` = 「完全
  访问」，`chat.toolbar.mode.label` = 「切换模式」）。
- **现状（file:line）**：`src/renderer/components/composer/ModeSelector.tsx:17`
  原 `DEFAULT_AGENT_MODE = 'confirm'`（变更前确认），`src/main/settingsStore.ts`
  原 `desktopAgentMode: 'default'`（default 为 AGENT_MODES 表外 id，渲染时退化
  到首项 confirm）——复刻首屏 Composer 模式按钮显示「变更前确认」，与 ZCode
  可见文案不一致。
- **偏差**：注释自述「刻意不默认完全访问（本地无账号级沙箱兜底）」——属
  主动安全偏移而非遗漏，但违反 1:1 对齐目标（P1 尺寸与文案：模式 chip
  文案与 ZCode 首屏实测不同）。
- **修法（✅ 已修复 2026-09-16，第十六轮）**：`ModeSelector.tsx` 改
  `DEFAULT_AGENT_MODE = 'fullAccess'`；`settingsStore.ts` DEFAULTS 改
  `desktopAgentMode: 'fullAccess'`（与 ZCode 同源 i18n 值对齐）。用户显式
  切换后仍经 `settings.desktopAgentMode` 持久化覆盖默认值，行为不变；
  安全兜底（本地无账号级沙箱）由「完全访问」模式本身语义保留，不另加
  默认拦截。

### P1（品牌与文案）
- [x] **B1 删 `GLM-5.3Max` 硬编码**（✅ 已完成 2026-09-12）：`App.tsx` 定义单一 `DEFAULT_MODEL_NAME = 'GLM-5.3-Flash'`（对齐实测模型名）下传两组件；`AppHeader` 移除字面量默认值。
- [x] **P1-1④ GLM-5.3-Flash 静态默认名清除**（✅ 已完成 2026-09-16，第十五轮）：`App.tsx` 删 `DEFAULT_MODEL_NAME = 'GLM-5.3-Flash'`，改经 `getModelOptionLabel`（全量选项表 label 解析 + 未选中「选择模型」占位符）下传 AppHeader/Composer，品牌残留归零（见上方第十五轮改动清单④）。B2 品牌扫描余留仍待跑。
- [ ] **B2 品牌残留扫描**：跑 `check-brand-replacement.js`，清掉 81 键里任何 `ZCode/GLM/智谱/zcode.z.ai` 原词（保留 `Welcome to KhyOS` 等已替换值）。
- [ ] **B3 组件全量走 i18n**：所有 .tsx 裸中文改 `t('<ns>.key')`；补 `check-i18n-fidelity.js` CI 拦裸中文。（部分完成：Composer 占位符已对齐真源值 `向 KhyOS 提问，使用 @ 添加上下文，使用 / 选择命令或能力`；WelcomePage 问候语已对齐 `chat.empty.greeting.*` 六时段真源尾字）
- [x] **B4 工具链补齐（P1-4）**（✅ 已完成 2026-09-11/12）：npm 10.9.2 已装；`package.json` 脚本改 node 直调 bin 后 `npm run build`/`npm run electron:dev` 实测可跑；React 版本钉死后 pnpm 10.18.0 install 亦可正常工作。

### P2（资产与进程）
- [ ] **C1 图标自研替换 emoji**：引入 lucide-react / 自制 SVG，按 `sidebar`/`workspaceSidebar` 键映射。
- [ ] **C2 四进程全量启动**：main 需 fork scheduler（当前 `out/main/index.js` 无 scheduler 引用）；跑 `npm run electron:dev` 后核对 `main/host/scheduler/preload` 四进程均存活。

---

## 3. 验收命令（对齐后必跑，取自 092 §0.4）

```bash
cd apps/khyos-desktop
node scripts/ci/check-agent-rules.js --changed     # 工程红线（硬编码/状态/超时/滚动区）
node scripts/ci/check-i18n-fidelity.js             # i18n 零 diff
node scripts/ci/check-brand-replacement.js         # 品牌替换完整
node scripts/ci/check-version-sync.js              # 版本同步
node scripts/ci/check-tokens.js                    # 令牌抽检 20 个与 tokens.txt 一致
npx electron .                                      # 或 npm run electron:dev 全四进程
```

**视觉验收**：对齐后再用 computer-use 双窗口并排截图（ZCode pid 11644 vs 复刻），
逐项核对 P0-1..P0-5 五处结构，以及底状态栏/顶 tab/左任务栏三处内容是否与 ZCode 一致。

---

## 4. 失真点速查表（一行一条，含证据坐标）

| 编号 | 失真 | ZCode 真源（证据） | 复刻现状（证据） | 档 |
|------|------|--------------------|------------------|----|
| P0-1 | 首屏多一层 Login+Welcome 闸门 | ZCode 无登录首屏；空状态 `chat.empty.title/description` 在主布局内 | `App.tsx:26` `useState('login')` + `LoginPage`/`WelcomePage` | P0 |
| P0-2 | 左任务侧栏内容/宽度/结构不对 | 宽 `--workspace-sidebar-panel-width` 可拖拽 + 顶部 `新建任务/搜索/自动化/插件市场` + 44 键 | `Sidebar.tsx` 12px 图标条 + `WorkspaceSidebar.tsx` 写死 280px、缺顶部区与 `项目/分组` tab | P0 |
| P0-3 | Composer 缺模型/模式/用量/停止四件套 | a42-a56 `停止生成/选择模型/上下文已用/完全访问/继续输入以排队后续修改` | `Composer.tsx` 单 textarea + `发送`，无停止生成/模型/模式 | P0 |
| P0-4 | 状态栏内容集合不同 | a126-a131 账号 `ntblocfk` + `移动端远程控制` + `设置` | `StatusBar.tsx` `模型/模式/ContextUsageBar/就绪` | P0 |
| P0-5 | TitleBar 只有 caption，无会话/工作区/面板 | a106-a118 会话标题 + `khy-os` chip + 面板/终端/窗口开关 | `TitleBar.tsx` 仅 `KhyOS Desktop` + 3 个 46px 按钮 | P0 |
| P0-6 | preload 产物 `index.mjs` 与 main 引用 `index.js` 分叉，`__KHYOS__` 全失效 | 092 Phase 0b 加 preload；四进程验收实跑 2 条 `Unable to load preload script` ENOENT | `out/preload/index.mjs` vs `out/main/index.js` 写死 `../preload/index.js`（主窗口+密钥窗口 2 处） | P0 |
| P1-1 | `GLM-5.3Max` 硬编码品牌残留 | CLAUDE.md 品牌规则：不复用 GLM | `AppLayout.tsx`/`AppHeader.tsx` 两处字面量 | P1 |
| P1-2 | i18n 真源可能含未替换品牌原词 | 092 §13.2 品牌替换完整 | `zh-CN.json` 81 键命中 KhyOS/khyquant.top（需查是否混入 ZCode/GLM/智谱） | P1 |
| P1-3 | 组件裸中文不走 i18n | 092 §6 i18n 零 diff | `Login/Welcome/Workspace/Status/TitleBar/Composer` 全写死中文 | P1 |
| P1-4 | 工具链缺口：`.bin` shim 缺失 + npm 未装，`npm run electron:dev` 不可跑 | 092 §0.4 验收命令 | `node_modules/.bin` 目录不存在；`where npm` 无命中（npm 10.9.2 已手工补装，见 §5） | P1 |
| P2-1 | 图标全用 emoji | 092 矢量图标体系（GLM 资产需自研替换） | 各组件 `📋📁🔀💻🌐🔔⚙️📝📂` 等 | P2 |
| P2-2 | 侧栏 tab 文案值对但没走键 | `organizeGrouped/organizeChronologicalList` | `WorkspaceSidebar.tsx` 写死 `分组/时间线` | P2 |
| P2-3 | host/scheduler 子进程未确认启动 | 092 Phase 0d 四进程 | 仅 `main+preload` 起来，host/scheduler fork 未验证 | P2 |

---

## 5. 复现步骤（本次审计的启动命令，留档）

```powershell
# 1. 真实 ZCode 已在运行（C:\Program Files\ZCode\ZCode.exe，v3.11.2）
# 2. 复刻：后台 shell 无 npm，改用本地 electron 直接起 out/main
cd /d D:\Portable\khy-os\apps\khyos-desktop
node_modules\electron\dist\electron.exe out\main\index.js
# 3. computer-use 双窗口：get_app_state(pid=11644, screenshot) 对 ZCode；
#    get_app_state(pid=<KhyOS Desktop electron>, screenshot) 对复刻；逐区对比
# 4. 真源比对脚本：
node .check_i18n.cjs      # ZCode i18n 5070 键 / 82 命名空间
node .check_i18n2.cjs     # 品牌残留 + 组件 i18n 消费率
node .check_tokens.cjs    # 988 个 CSS 自定义属性（tokens.txt, UTF-16LE）
```

## 5.1 四进程验收（2026-09-11 实跑结果）

```powershell
# 验收脚本（留档 .fourproc_accept.cjs）：起 electron main + 单独起 scheduler，
# main 自动 fork host；读 8s 日志判定。
node .fourproc_accept.cjs
```

实测输出摘要：
- `[scheduler] 进程启动, pid: 22456` ✅（scheduler 需单独起，main 未 fork → P2-3）
- `[host] 进程启动, pid: 13056` + `[host] {"type":"ready","pid":13056}` ✅（main fork host 正常）
- `[ERR] Unable to load preload script: out\preload\index.js` → `ENOENT`（主窗口 + 密钥窗口共 2 条）❌ → **P0-6**
  - 根因：`out/preload/index.mjs`（ESM 产物，`package.json type:module`）vs main 引用 `index.js`。
  - 影响：`window.__KHYOS__` 全部失效，TitleBar 最小化/最大化/关闭、菜单 IPC、127 RPC 均断。
- 结论：四进程 **PASS（main/host/scheduler 存活）但 preload 断链（P0-6）**——renderer「能渲染」是绕过 preload 的假象，交互层空壳。

### npm 补装记录（P1-4 落地，2026-09-11）

```
# 本机 node：D:\Portable\Tools\commandcode\npm-global\node.exe (v22.18.0)，npm 缺失
# 已手工补装：
node <下载并解压> npm 10.9.2 → D:\Portable\Tools\commandcode\npm-global\node_modules\npm
# 写 shim（node 22 兼容）：
#   D:\Portable\Tools\commandcode\npm-global\npm.cmd  → node .../npm/bin/npm-cli.js %*
#   D:\Portable\Tools\commandcode\npm-global\npx.cmd  → node .../npm/bin/npx-cli.js %*
# 用户 PATH 已含 D:\Portable\Tools\commandcode\npm-global（.setuserpath.ps1 验证 ALREADY_IN_PATH）
# 验证：
cmd /c "D:\Portable\Tools\commandcode\npm-global\npm.cmd --version"   # → 10.9.2（无版本告警）
# 注意：`npm run electron:dev` 仍会因 `node_modules/.bin/electron-vite.cmd` 缺失而失败
#       （pnpm 布局未落 .bin shim）——见 P1-4 修法第 2/3 条。
```

> 说明：`tokens.txt` 是 **UTF-16LE + BOM**，直接 `fs.readFileSync(...,'utf8')` 会乱码，
> 必须 `readFileSync(p,'utf16le').replace(/^\uFEFF/,'')`。本审计已确认 tokens 真源共
> 988 个 CSS 变量（含 `--color-panel`/`--color-sidebar`/`--ui-*` 等），与 ZCode 主题系统一致。

> 临时文件（审计/验收用，可删）：`.fourproc_accept.cjs`、`.install_npm.cjs`、`.install_npm10.cjs`、
> `.setuserpath.ps1`、`.dev_run.log`、`.dev4proc.log`。shim `npm.cmd`/`npx.cmd` 保留在 `npm-global` 供长期使用。

## 审计日志

- [2026-09-13 04:xx] 视觉对齐：双窗口 computer-use 实跑（ZCode pid 23368 + KhyOS
  Desktop 重建后 pid 14284）。ZCode 主窗 a11y：任务侧栏含 4 顶部按钮（新建任务 Ctrl+N /
  搜索 Ctrl+K / 自动化 / 插件市场）+ 项目/分组 tab + 真实任务（`修复Khyos后端`/
  `每天中午1点…定时任务` 等，带定时任务/整理分组头 + 归档）；TitleBar 含 切换侧边栏/
  后退/前进 + 会话标题 `修复Khyos后端` + workspace chip `khy-os` + 选择打开方式/
  资源管理器/更多/展开侧边面板/切换终端/窗口菜单；Composer 右下角 添加上下文 +
  上下文已用 80,702/总量 1,000,000 + 选择模型 + 切换模式=完全访问 + 停止生成；
  侧栏底部 账号 `旅行者8665` + 移动端远程控制 + 设置。复刻端重建后差异：
  ① 任务侧栏 50 条真实会话已接真源（P3-1 修复生效，标题来自 .khy/sessions 的
  firstUserMessage，时间戳 14 小时前~7 天前）；② 侧栏视图 tab 仍为「分组/时间线」，
  ZCode 为「项目/分组」tab + 任务分组头（`定时任务`/`整理` 带新建任务+ 计数徽标）；
  ③ Composer 占位符/上下文用量条与 ZCode 当前形态不一致（见 P0-第八轮余项）。
  新失真点：P3-1（已修复）。
- 接线：5 文件改动——host 新增 session.list 桥（require sessionPersistence.js，
  与 aiGateway 同 KHY_OS_DIR/相对路径发现逻辑，零硬编码）；main session:list 经 host
  IPC（15s 超时兜底）；preload listSessions(limit)；AppLayout 删 mock 拉 50 条真实
  会话 + 首条自动选中；WorkspaceSidebar 新增 sessionError 错误态。
- 检查：`check-agent-rules.js`（5 改动文件）零违规；`check-version-sync.js` 通过
  （主轨道 1.1.15，ai-backend 轨道 1.6.5，browser 0.1.0）。

- [2026-09-13 04:xx 第九轮] 视觉对齐：双窗口 computer-use 实跑（ZCode pid 23368 + KhyOS
  Desktop 重建后 pid 31464）。ZCode 主窗 a11y 关键区：任务侧栏含 项目/分组 tab（默认
  项目）+ 真实任务 8 条（带 `定时任务`/`整理` 分组头 + 归档）+ 底部「归档/新建分组/
  收起全部」；TitleBar 含 切换侧边栏/后退/前进 + 会话标题 + workspace chip `khy-os`；
  Composer 右下角 添加上下文 + 上下文已用 135,391/总量 1,000,000 + 选择模型
  agnes-3.0-flash + 切换模式=完全访问 + 停止生成 + 排队输入 placeholder「继续输入以
  排队后续修改」；侧栏底部 账号 `旅行者8665` + 移动端远程控制 + 设置。复刻端重建后
  差异：① Token 用量面板已接真源（显示「Token 用量 62.7M / 100.0K (62714.2%)」，
  超额态红色进度条 + 提示，P3-3 修复生效）；② 侧栏视图 tab 已改「项目/分组」（P3-2
  修复生效，默认选中「项目」）；③ DiffSummary mock 已隐藏（P3-4 修复生效，空态不渲染）；
  ④ Composer placeholder 在 sending 态切换为「继续输入以排队后续修改」（P0-3 收尾，
  空闲态保留功能型文案）。新失真点：P3-2/P3-3/P3-4（均已修复）。
- 接线：8 文件改动——host 新增 `token.usage` 桥（require tokenUsageService.js，
  与 aiGateway/sessionPersistence 同 KHY_OS_DIR/相对路径发现逻辑，零硬编码）；main
  新增 `token:usage` ipcMain.handle 经 host fork IPC（15s 超时兜底）；preload 加
  `getTokenUsage()`；`ContextUsage.tsx` 删自造数据改拉真实 tokenUsageService；
  `Composer.tsx` placeholder 在 sending 态切换排队语义；`App.tsx` 移除 quicksort mock
  DiffSummary；`WorkspaceSidebar.tsx` 视图 tab 改「项目/分组」；`AppLayout.tsx` 默认
  viewMode 改 `chronological`（项目）。
- 检查：`check-agent-rules.js`（8 改动文件）零违规；`check-version-sync.js` 通过
  （主轨道 1.1.15，ai-backend 轨道 1.6.5，browser 0.1.0）。

- [2026-09-14 04:xx 第十轮] 视觉对齐：双窗口 computer-use 实跑（ZCode pid 23368 +
  KhyOS Desktop 重建后 pid 31716）。ZCode 主窗 a11y 关键区：Composer 右下角一簇
  （`发送` + 思考级 combobox`高` + 选择模型`z-ai/glm-5.3-free` + `上下文已用 75,184
  / 总量 128,000` + 后台任务按钮 + 切换模式`完全访问` + 添加上下文 + 输入框
  placeholder`提出后续修改要求`）；主区 `10 个文件已更改 -0 +733`（真实 diff 计数）
  + 工具执行块（终端/编辑/展开工具详情）；侧栏 项目/分组 tab + 定时任务/整理分组
  头。复刻端重建后差异：① Token 用量面板显示的是**月配额**（`62.7M / 100.0K`），
  而 ZCode 的「上下文已用/总量」是**会话级上下文窗口**（`75,184 / 128,000`）——
  语义错配（P3-5）；② 面板在空态下也渲染（ZCode 空态不显示用量区段）；
  ③ Composer 工具行缺「上下文已用/总量」按钮 + 「添加上下文」菜单 + 「后台任务」
  计数（P3-6，P0-3 收尾余项）。新失真点：P3-5/P3-6。
- 接线：6 文件改动——host 新增 `context.size` 桥（require `tokenUsageService.
  estimateTokens`，后端 /cost 与 gateway token-budget 同源启发式；上限
  `KHY_CONTEXT_WINDOW` env 缺省 128000，零硬编码）；main 加 `context:size`
  ipcMain.handle（15s 超时兜底）；preload 加 `estimateContextSize(text)`；
  `Composer.tsx` 工具行新增「上下文已用 X / 总量 Y」按钮（对齐 ZCode a57，
  数据经 host 真源估算，300ms 防抖 + 流式刷新，估算失败显错误提示不造假）；
  `ContextUsage.tsx` 标题改「Token 用量（本月配额）」明确语义；`App.tsx` 改
  `messageCount > 0` 才渲染用量面板（空态隐藏，与 ZCode 一致）。
- 检查：`check-agent-rules.js`（6 改动文件）零违规；`check-version-sync.js`
  通过（主轨道 1.1.15，ai-backend 轨道 1.6.5，browser 0.1.0）。已重建验证：
  Composer 工具行实测渲染「上下文已用 0 / 总量 128,000」（空态 0，随输入/流式
  更新），Token 用量面板空态不渲染。
- 余留（下轮）：P3-6 余项——① 加「添加上下文」`has_menu` 按钮；② 加「打开运行中
  的后台任务」计数按钮（需 host 接后台任务事件流）；③ 思考级/模式选择器移入
  Composer 工具行右下角同簇（ZCode a48/a51 在右下同一行，复刻目前在 Composer
  上方独立行）。

- [2026-09-13 第十一轮] 文本级对齐：本轮无视觉验证（用户约束「你没有视觉
  能力」，不跑 computer-use 双窗口实拍）；对齐依据＝002 清单 ZCode 实测留档
  （s-2/s-3/s-25/s-43/s-45/s-49）+ 092 i18n 真源键值 + 复刻源码逐文件核读。
  三项交付：① 侧边面板「打开标签页」磁贴选择器 + 多标签容器（5 磁贴：辅助
  对话/审查/终端/浏览器/打开文件，辅助对话仅会话态；Ctrl+Alt+B/Ctrl+J；tab
  可关闭 + 新增标签；标签体 6 真组件：SelectionChatPane/GitPanel/
  TerminalPanel/BrowserPane/OpenFilePane/CodeViewerPane）；② 设置页（全屏
  替换式 + 三组导航 15 内容区 + #/settings/plugins 深链）+ 插件管理
  （pluginStore 正门 + plugin:* 5 IPC + 已安装/发现 两页签）+ 自动化
  （#/automations + automation:* 5 IPC）+ 侧栏插件市场/自动化入口；③ 应用内
  Markdown 浏览（codeViewer:read 四态契约 + workspace:listFiles 有界索引 +
  CodeViewerPane 预览/源码切换 + OpenFilePane + CommandCenter「打开文件」
  命令）。002 清单同步：B3/B4（缺→有）、H0/H6/H7/I1/I2（未实现→有）翻绿，
  H2/H3/H5/K4 措辞更新（统计：有 19 / 失真 13 / 缺 17 / 未实现 19）。
- 接线：renderer——SidePane（磁贴选择器 + 多标签容器）、AppLayout（标签
  状态机 + openFileTab）、SettingsPage/PluginSettings、AutomationsPage、
  CodeViewerPane/OpenFilePane、BrowserPane、SelectionChatPane、
  WorkspaceSidebar（插件市场/自动化入口）、CommandCenter（打开文件命令）、
  TerminalPanel（xterm）；main——新增 pluginStore.ts/automationStore.ts 与
  plugin:* / automation:* / codeViewer:read / workspace:listFiles 共 12 个
  ipcMain.handle（通道总数增至 38，preload 同步暴露）。
- 检查：`check-agent-rules.js`（81 文件）0 error / 1 已知 warning
  （AttachmentList.tsx:103 mock `status: 'uploading', progress: 65`，
  Rule 2 UI 枚举例外，人工评审放行）；`check-version-sync.js` 通过（主轨道
  1.1.15，ai-backend 轨道 1.6.5，browser 0.1.0）；contract 测试
  `tests/desktopUiContract.test.cjs` 26/26；electron-vite 构建通过（main
  90.00 kB / preload 6.94 kB / renderer 2,079.38 kB）。
- 余留（下轮）：终端 PTY 未接（stub 回显）、「搜索标签页」未实现、多标签仅
  渲染活动标签、主进程 BrowserView* RPC 群（002 M2）未接、设置页 I3-I12
  内容页薄空态待深核对（002 暂不翻绿）。

- [2026-09-14 第十二轮] 文本级对齐：本轮无视觉验证（用户约束「你没有视觉
  能力」延续）；对齐依据＝002 清单 s-25/s-45 实测留档 + 092 i18n 真源键值
  （`sidePane.tabOverview/openTabs/noTabsFound`）+ 复刻源码逐文件核读。
  两项交付（第十一轮余留②/⑥ 收口）：① `SidePane.tsx` tab 条新增
  「搜索标签页」has_menu 下拉（对齐 s-45 实测：终端面板 tab 条含「搜索
  标签页」has_menu）——放大镜图标按钮 + `aria-haspopup="menu"`，下拉列
  出全部已开标签（激活标签高亮 `bg-selected`），点击聚焦对应标签并关闭
  下拉；空态显示「没有找到标签页。」（noTabsFound 真源值）；下拉头
  「打开的标签页」（openTabs 真源值）；按钮 title/aria-label「搜索标签页」
  （tabOverview 真源值）；外点 + Escape 关闭（mousedown/keydown 监听，
  开态才挂载、卸载即清理）。② `SettingsPage.tsx` 引导独立项移除自造
  「主要项」组头（对齐 s-25 a106 实测：引导为独立 NavButton，上方无
  分组头），改动后三组导航（NAV_GROUPS）渲染不变，引导项紧随其后裸渲染。
- 接线：renderer——`SidePane.tsx`（useState/useRef/useEffect 下拉状态机
  + tab 条下拉 UI）、`SettingsPage.tsx`（删 6 行组头 wrapper）。无
  main/preload/host 改动（纯 UI 层）。
- 检查：`check-agent-rules.js`（2 改动文件）零违规；electron-vite 构建通过
  （main 90.00 kB / preload 6.94 kB / renderer 2,082 kB，仅既有 import
  warning）；contract 测试 55/55 通过（keyStore/agentWriters/health 21 +
  desktopUiContract/keyManagerContract 34，含 D9 品牌替换 + D10 无硬编码
  localhost）。002 清单同步：H0/H2 复刻现状措辞更新 + 统计行注记。
- 余留（下轮）：终端 PTY 未接（stub 回显）、多标签仅渲染活动标签、主进程
  BrowserView* RPC 群（002 M2）未接、设置页 I3-I12 内容页薄空态待深核对
  （002 暂不翻绿）。

- [2026-09-14 第十三轮] 文本级对齐：本轮无视觉验证（用户约束「你没有视觉
  能力」延续）；对齐依据＝002 清单 s-25 导航实拍留档 + 复刻源码逐文件核读。
  用户目标扩展两项：「每个按钮点击后与后端实际链接怎么响应，接入后端」与
  「长按对话悬浮调整位置」。五项交付：
  ① UsageSettings 假数据 → 真链路：`usage:history` 五跳（UI → preload
  `getUsageHistory` → main `usage:history` → host bridge → backend
  tokenUsageService.getUsageHistory/getModelUsage），tokenUsageService
  针对性 jest 16/16。用量重置链路仅到 backend（resetUsage 单测通过）：
  main 无 `usage:reset` 通道、preload 无对应方法、用量页无重置按钮，
  IPC 接线待下轮补（本轮审计修正此处先前的失实记录）。
  ② McpSettings 真消费：删除伪造 `PLUGIN_SERVERS` 假状态卡；改为
  `mcpList()` 用户服务器真 CRUD（启停/删除/新建/JSON 导入）+ 插件托管
  服务器卡由 `pluginsList()` 实时推导（只读）。
  ③ 打开引导真弹窗：`OnboardingDialog`（migration:scan/import 真扫描
  ~/.claude、~/.cursor、~/.codex 磁盘文件计数 + 真导入），替换
  GeneralSettings/OnboardingSettings 两处 console.log 桩；window 事件
  `khy:open-onboarding` 与既有 `khy:open-command-center` 同模式。
  ④ ListSettingsPage 6 页（命令/钩子/技能/子智能体/记忆）+ IndexSettingsPage
  （索引库）：agentItemStore + indexStore 两个新 store（dataHome 真源、原子写）
  + `agent:*`/`index:*`/`migration:*`/`app:dataHome` 12 个新 IPC + preload
  13 方法；IndexSettingsPage 重建索引为真重扫描（有界：深度 8/5000 条目）。
  ⑤ 长按悬浮调位（新增目标）：ContextUsagePanel 从消息流内嵌升级为可拖出
  悬浮面板——长按 400ms 进入拖拽（指针捕获 + 10px slop 取消 + 视觉位置
  锚定），拖动中实时夹紧视口（8px 边距），松开经 `settings:set` →
  settingsStore 持久化 `contextUsagePanelPos`；复位按钮（↺）写 null 回消息
  流；悬浮态启动恢复 + resize 重夹紧；拖动态状态文本「拖动 Token 用量面板 ·
  松开保存位置」（规则 2 动作+目标+进度）。
- 接线：renderer——UsageSettings/McpSettings/OnboardingDialog/
  OnboardingSettings/GeneralSettings/ListSettingsPage/IndexSettingsPage/
  SettingsPage（挂载 OnboardingDialog + 6 调用点换参）/ContextUsage（悬浮
  重写）；main——agentItemStore.ts/indexStore.ts 新 store + index.ts 12 个新
  `ipcMain.handle`（通道总数增至约 80，preload 同步暴露）。
- 检查：`check-agent-rules.js`（14 文件 + 本轮 ContextUsage.tsx 单独复扫）
  零违规；electron-vite 构建通过（main 108.69 kB / preload 8.94 kB /
  renderer 2,147.50 kB / host 8.75 kB）；contract 测试 55/55（keyStore/
  agentWriters/health 21 + desktopUiContract/keyManagerContract 34）；
  tokenUsageService 针对性 jest 16/16。backend 全量 jest 约 10 个失败文件
  （docSuggestDraft/diffLineNumbers/visionNoticeDedupWiring/syncOutput/
  toolMetricsAggregator/storageRoots/retryBudget/taskClosureGate/
  verifyNonEdit/portDrift）——逐一核对与本轮 tokenUsageService 改动零关联
  （失败原因：破损测试文件、Windows 临时目录锁、编码损坏正则、超时），判
  预存在/环境性，非本轮引入；`tsc -b` 失败项全部位于本轮未触碰文件
  （host/index.ts、AutomationsPage、BrowserPane、Composer、Tooltip、
  i18n——前几轮接线遗留类型债，esbuild 构建不做类型检查故一直未拦截），
  本轮重写的 ContextUsage.tsx 类型干净不在其中。002 清单同步：I3/I4/I5/
  I8/I12 未实现→有，E6 措辞更新。
- 余留（下轮）：终端 PTY 未接（stub 回显）、多标签仅渲染活动标签、主进程
  BrowserView* RPC 群（002 M2）未接、I7 模型配置页未实现、预存类型债
  （`tsc -b` 失败清单）待集中清理。

- [2026-09-15 04:xx 第十四轮] 视觉对齐：双窗口 computer-use 实跑（ZCode pid 23368
  主窗最小化，a11y 树仍可读取；KhyOS Desktop 重建后 pid 49684）。ZCode 主窗
  a11y 关键区：Composer 右下角一簇（`发送` + 思考级 combobox`高` + 选择模型
  `GLM-5.3-Flash`/`TokenRouter/ z-ai/glm-5.3-free` + `上下文已用 100,699 / 总量
  1,000,000` + 切换模式`完全访问` + 添加上下文 + 输入框 placeholder`提出后续
  修改要求`）；主区 `4 个文件已更改 -37 +71` + 工具执行块（终端/编辑/展开
  工具详情/思考·持续了几秒）；侧栏 项目/分组 tab + 定时任务/整理分组头 +
  真实任务 8 条 + 归档；底部「归档/新建分组/收起全部」；TitleBar 切换侧边栏/
  后退/前进 + workspace chip + 选择打开方式/资源管理器/更多/展开侧边面板/
  切换终端/窗口菜单。复刻端重建后差异：① 模型选择器是**静态禁用 chip**
  （`GLM-5.3-Flash` 写死，GLM 品牌残留，未接后端 providerPresets 真源，
  无 provider 切换/无下拉）——新失真点 P3-7；② Composer 工具行缺「添加
  上下文」has_menu 按钮（@ 提及是触发式非独立按钮）+ 推理强度仍在 Composer
  上方独立行未入工具行右下角同簇——新失真点 P3-8。已修复项：P3-5 上下文
  已用按钮生效（`上下文已用 0 / 总量 128,000` 空态 0），侧栏 项目/分组 tab
  默认「项目」，DiffSummary mock 隐藏，空态 Token 用量面板不渲染。
- 接线（P3-7/P3-8，改动 6 文件）——host 新增 `models.list` 桥（require
  `providerPresets.js` + `builtinProviderConfig.js` poolKey 映射，与
  aiGateway/sessionPersistence 同 KHY_OS_DIR/相对路径发现逻辑，零硬编码）；
  main 加 `models:list` ipcMain.handle（15s 超时兜底 + pendingModelList）；
  preload 加 `listModels(adapterKey?)`；新增 `useModelCatalog` hook（模块
  级缓存 + fail-soft）；`Composer.tsx` 新增 `ModelSelector`（provider 一级
  + 模型二级 + 搜索框，接真源选项；选项 `channel` 用池 key、`channelKnown=
  false` 不钉 preferredAdapter）+ `AddContextButton`（has_menu：工作区
  文件/网页/会话，对齐 `chat.composer.actionMenu`）+ `ThoughtLevelButton`
  （对齐 `chat.toolbar.thoughtLevel.*`）三者并入工具行右下角同簇；`App.tsx`
  删 Composer 上方独立「模式+思考强度」行、新增 `selectedModel` state 并
  经 `onModelChange`/`onThoughtLevelChange` 下传。模型选项 id 形如
  `provider/model`，发送时 `options.preferredAdapter` 取 provider 池 key
  （`zhipu`→`glm`、`qwen`→`qwen`、`deepseek`→`deepseek`、`openai`→`openai`、
  `anthropic`→`anthropic`；未映射的聚合网关 `channelKnown=false` 不钉）。
- 验证：computer-use 实测模型下拉渲染 15 个真实 provider（智谱 GLM · glm-5.2 /
  通义千问 · qwen-plus / Moonshot / Agnes AI · agnes-2.0-flash / OpenAI ·
  gpt-4o-mini / Anthropic · claude-sonnet-4-6 / DeepSeek · deepseek-chat /
  Google Gemini / Google Vertex AI / OpenRouter / Groq / Together / 本地
  Ollama · llama3.2 + 模型子项），工具行渲染「添加上下文」「最高」推理强度
  + 模型选择器 + 「上下文已用 0 / 总量 128,000」按钮，与 ZCode 右下角整簇
  一致。
- 检查：`check-agent-rules.js`（6 改动文件：host/main/preload/Composer/
  useModelCatalog/App）零违规；`check-version-sync.js` 通过（主轨道 1.1.15，
  ai-backend 轨道 1.6.5，browser 0.1.0）；electron-vite + host build 全绿。
- 余留（下轮）：① P3-6 余项「打开运行中的后台任务」计数按钮（需 host 接
  后台任务事件流，Bash/子智能体计数，对齐 ZCode a58）；② 模型选中态未
  持久化（重启回退 DEFAULT_MODEL_NAME，需接 settingsStore）；③ 模型选项走
  provider 预设静态 `models` 列表，未走 adapter `listModels()` 动态拉取
  （host `listModelOptions` 已留 adapterKey 参数入口，待传）；④ GLM-5.3-Flash
  静态默认名属 P1-1 品牌残留，待 B2 品牌扫描一并处理。

- [2026-09-16 04:xx 第十五轮] 视觉对齐：ZCode 主窗口（pid 29672）复测 s-4
  后 Composer 整簇形态不变（发送/选择模型/上下文已用/切换模式/添加上下文 +
  后台任务按钮仅运行态渲染）；复刻端（pid 31628→26552）空态首页 s-6/s-7
  确认无 GLM-5.3-Flash 品牌残留、模型 chip 未选中时显示「选择模型」占位符
  （i18n chat.toolbar.model.label 同源语义）、选 DeepSeek 后 chip 与 AppHeader
  同步显示「DeepSeek · deepseek-chat」、BackgroundTasksButton 空态隐藏
  （count=0，与 ZCode 行为一致）。新登记失真点：无（本轮 4 项余留全部收口，
  见上文 P3-6①/P3-7②③/P1-1④ 段落 + B2 前移项）。
  接线（第十五轮，8 文件）——① host 新增 `background.status` 桥
  （`activeGenerations` Set 统计在途 ai.generate，含自动化 `auto_` 前缀运行；
  `backgroundTaskStatus()` 返回 {count,bash,subagents,taskIds}，bash 恒 0
  登记下轮事件流桥余留）+ main `background:status` 处理（15s 超时兜底 +
  pendingBackgroundStatus）+ preload `backgroundStatus()` + Composer 新增
  `BackgroundTasksButton`（3s 纯 UI 轮询，规则 3 合规，count=0 隐藏）；
  ② settingsStore DEFAULTS 增 `selectedModel`，useModelCatalog 新增
  `persistModelSelection`/`loadPersistedModelSelection`（settingsStore 原子写
  fail-soft），App.tsx 挂载恢复 + 变更落盘——实测 settings.json 落盘
  `"selectedModel":"deepseek"` + 重启自动恢复；③ host `listModelOptions`
  动态段按 preset 前缀对齐 + 去重，useModelCatalog 新增幂等
  `fetchDynamicModels(adapterKey)`（dynamicFetched Set 去重），App.tsx 顶层
  解析选中 provider channel 驱动动态拉取，经共享模块级缓存供 Composer/
  AppHeader 的 `getModelOptionLabel` 渲染；④ App.tsx 删
  `DEFAULT_MODEL_NAME='GLM-5.3-Flash'` 静态字面量（P1-1 品牌残留归零），
  AppHeader 注释同步更新。
  验证：重建 4 bundle（main 114.48 kB / preload 9.70 kB / renderer 2183 kB /
  host 15.22 kB）双窗口 computer-use 实测通过（模型下拉 21 选项真实
  provider 表无品牌残留；持久化往返验证；后台任务按钮空态隐藏）。
  检查：`check-agent-rules.js`（8 改动文件）零违规；`check-version-sync.js`
  通过（主轨道 1.1.15，ai-backend 轨道 1.6.5，browser 0.1.0）。
  余留（下轮）：① P3-6① 余项——Bash 工具子进程计数事件流桥（khy 后端
  bash 工具执行不经 aiGateway，需 host 接 bash.start/stop 事件后
  backgroundTaskStatus().bash 才有真值）；② 后台任务详情面板
  （ZCode chat.backgroundWorks.panel，点击展开任务列表/日志）；③
  fetchDynamicModels 在有凭据 channel 下的真值验证（本轮静态 presets 已
  覆盖展示，动态拉取 best-effort 空数组属预期 fail-soft）；④ B2 品牌扫描
  （check-brand-replacement.js 全量 81 键清理）仍待跑。

- [2026-09-16 05:xx 第十六轮] 视觉对齐：ZCode 主窗口（pid 31668，本轮
  新进程）复测 s-2——Composer 整簇「发送(disabled)/选择模型 Agnes AI 中国
  站/agnes-3.0-flash/上下文已用 220,937/总量 524,288/切换模式=完全访问/
  添加上下文/提出后续修改要求」，会话消息区「5 个文件已更改 -265 +5」+
  底部「已工作 17 分 1 秒」计时 chip；复刻端（pid 32892→33248）s-3/s-4
  双窗口对比，**新发现 P1 失真 P3-9①**：复刻 Composer 模式按钮首屏显示
  「变更前确认」，与 ZCode 实测「完全访问」（i18n `mode.label.glm.yolo`）
  文案不一致（注释自述为「刻意保守默认」，属主动安全偏移非遗漏，违反
  1:1 对齐目标）；另发现 settings.json 残留旧落盘 `desktopAgentMode:
  'default'`（AGENT_MODES 表外 id，渲染时退化首项 confirm）——P3-7②
  上线前写入的陈值，新代码路径未覆盖。
  修复（P3-9①，3 文件）——① `ModeSelector.tsx` 改 `DEFAULT_AGENT_MODE =
  'fullAccess'`（对齐 ZCode 同源 i18n 值，注释改注对齐理由）；②
  `settingsStore.ts` DEFAULTS 改 `desktopAgentMode: 'fullAccess'`；③
  `App.tsx` 模式恢复逻辑加表内合法性校验（`AGENT_MODES.some(x=>x.id===m)`
  不通过则回退 DEFAULT_AGENT_MODE，覆盖 'default' 旧值）。用户显式切换
  后仍经 settings.desktopAgentMode 持久化覆盖默认值，行为不变；安全兜底
  由「完全访问」模式语义本身保留，不另加默认拦截。
  验证：重建 4 bundle 重启实测 s-8——Composer 模式按钮显示「完全访问」
  （element [45]，has_menu），与 ZCode s-2 a56 一致；模型 chip
  「agnes-2.0-flash」（持久化 id agnes/agnes-2.0-flash，P3-7② 有效）；
  空态 BackgroundTasksButton 隐藏（count=0）；「上下文已用 0 / 总量
  128,000」「添加上下文」「最高」推理强度整簇形态不变。
  检查：`check-agent-rules.js`（9 改动文件）零违规；`check-version-sync.js`
  全绿（主轨道 1.1.15，ai-backend 1.6.5，browser 0.1.0）。
  余留（下轮）：① P3-6① 余项——Bash 工具子进程计数事件流桥（bash 计数
  本轮恒 0 不猜测）；② 后台任务详情面板（ZCode `chat.backgroundWorks.panel`）；
  ③ `fetchDynamicModels` 在有凭据 channel 下的真值验证（best-effort 空数组
  属预期 fail-soft）；④ B2 品牌扫描（check-brand-replacement.js 全量 81 键）
  仍待跑；⑤ `selectedModel` 持久化键与 settings.json 的 `desktopAgentMode`
  旧值 `'default'` 已在 App.tsx 恢复逻辑兼容处理，但 settings.json 里的旧
  值未回写清理（下次模式切换时经 setSetting 覆盖，属自愈路径，不另加
  启动清理）。
