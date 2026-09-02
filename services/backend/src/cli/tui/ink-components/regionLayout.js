'use strict';

// regionLayout.js — khyOS TUI 区域划分的单一真源 (SSOT)。
//
// 目的:消除「App.js 里所有布局判定都是隐式条件 + 散落字面量」导致的「一改全改」风险。
// 任何对区域顺序 / 横向栏宽 / 顶对齐偏移 / 覆盖层隐藏规则的修改,只允许动本文件 +
// 对应组件的 props 接收处。App.js 的渲染数组是「按本文件声明的顺序」拼装的契约消费者,
// 不能在其中夹塞未声明的兄弟节点。
//
// 区域顺序(自顶向下):与 App.js 渲染树严格一致 —— 改这里 = 改 App.js 的 JSX 顺序。
// 见 docs/03_DESIGN_设计/[DESIGN-ARCH-016] AI_Agent显示规范.md 中的「终端分区」一节。

// ── 区域 ID 枚举(冻结,三层结构)─────────────────────────────────────────────
//
// 层级约定:顶层(9) → 大区(MAIN 内 6 个宏观组) → 小区(各组下细分,10 个)。
// 所有 MAIN.* 值一律用点分号(`main.output.hdr`),不允许 _ - 等其他分隔符;
// REGION 的 JS key 用下划线(`MAIN_OUTPUT_HDR`),与值的点分号正交。
// 新增需要在本文件改 REGION 后同步改 regionLayout.test.js 的预期数组。
//
// 职责边界原则:每个区域只管自己的渲染,不干涉其他区域的显示/隐藏/尺寸。
// 修改某个区域时,只允许动该区域对应的组件 + 本文件的 ID 定义,
// 不允许在该区域的渲染逻辑里掺入其他区域的判定条件。
//
// 顶层(9 个,自顶向下,与 App.js 渲染树严格一致):
//   ① BANNER          — 启动横幅,顶部,首轮 commit 后进 scrollback(动态转为透明占位)
//   ② MAIN            — 左列主区(宏观 ID;内部按 6 个大区 + 10 个小区进一步拆解)
//   ③ SIDEBAR         — 侧栏(可选,仅宽终端);顶对齐 MAIN 第一行
//   ④ TASK_PANEL      — 全宽任务看板,Ctrl+T 隐藏
//   ⑤ COMPLETION_MENU — 斜杠命令 / @file 补全菜单;浮在 PROMPT 上方;completion.active 时挂载
//   ⑥ PROMPT          — 输入框;被 hideChrome 覆盖层隐藏
//   ⑦ FOOTER          — 状态栏(输入框正下方):模型/精度/上下文/权限模式/桥接/目标
//   ⑧ STATUS_AREA     — 状态区,页尾 5 行空行;预留未来扩展(实时状态/快捷操作)
//   ⑨ OVERLAY         — 全屏覆盖层;独占输入时使用;按需挂载,不占纵向顺序
//
// MAIN 大区(6 个宏观组):
//   ②.1  MAIN_TEXT       流式正文(不含思考);StreamingBlock 内 t${i} / 'text' 等文本段
//   ②.2  MAIN_REASONING  思考区(大区);含 live 段 + committed 段两个小区
//   ②.3  MAIN_OUTPUT     输出大区(工具相关);含 HDR / VIEW / INLINE 三个小区
//   ②.4  MAIN_ACTIVITY   活动区(忙态指示);含 SPINNER / QUEUE / STEER / INTERRUPT 四个小区
//   ②.5  MAIN_TIP        提示区(大区);含 DOUBLE_PRESS 一个小区
//   ②.6  MAIN_SUBVIEW    局部子视图;Ctrl+O 详情 + PlanApproval + TranscriptView
//
// MAIN 小区(10 个,挂在大区之下):
//   ②.2.1 MAIN_REASONING_LIVE       思考区(live 段);StreamingBlock.js:194/196
//                                  'think-ell' / 'think' 行;gate:streaming.thinking
//   ②.2.2 MAIN_REASONING_COMMITTED  思考区(committed 段);Transcript.js:411-431
//                                  'k${i}' 行;gate:timeline e.type==='thinking'
//   ②.3.1 MAIN_OUTPUT_HDR           工具说明区 —— `✓ readFile(src/a.js)` 摘要头行;
//                                  ToolLines.summarizeArgs 派生;StreamingBlock + Transcript
//                                  共用同一份 summarizeArgs(保证 live/committed 字节一致)
//   ②.3.2 MAIN_OUTPUT_VIEW          工具结果展示区(检视子视图)—— ShellView;
//                                  ↓ while turn is executing → 检视当前/最近工具完整输出;
//                                  数据源:query.streaming,与 StreamingBlock 共享同一份
//   ②.3.3 MAIN_OUTPUT_INLINE        工具结果展示区(内联行)—— ToolLines 内嵌在头行下的
//                                  literal output 行 + ±diff 行;ShellView 之外的另一条
//                                  展示路径(短输出 / shell 命令直接看)
//   ②.4.1 MAIN_ACTIVITY_SPINNER     Spinner + CompactionProgress;状态指示核心
//   ②.4.2 MAIN_ACTIVITY_QUEUE       排队消息条数(`已排 N 条待发`)
//   ②.4.3 MAIN_ACTIVITY_STEER       方向修正提示(`⟳ N 条方向修正待注入`)
//   ②.4.4 MAIN_ACTIVITY_INTERRUPT   Esc 中断提示(`⎋ ${hint}`);interruptHint 派生
//   ②.5.1 MAIN_TIP_DOUBLE_PRESS     双击提示(1.5s 自动消失);App.js:5189 hint state
//
// 命名层级约定:
//   - REGION JS key:顶层用下划线(`BANNER`),大区用 `MAIN_XXX`,小区用 `MAIN_XXX_YYY`
//   - REGION 值:顶层用连字符(`task-panel`),大区/小区用点分号(`main.output.hdr`)
//   - 值禁止下划线(测试断言);key 禁止点(语法限制)
//   - 大区 ID 在 MAIN_SUBREGIONS 里排在小区之前(顺序 = 渲染顺序)
const REGION = Object.freeze({
  // ── 顶层(9)────────────────────────────────────────────────────────────────
  // 职责边界:每个顶层区域只管自己的渲染,不干涉其他区域。
  // 修改某个区域时,只允许动该区域对应的组件 + 本文件的 ID 定义。
  BANNER: 'banner',              // 职责:启动横幅内容;不干涉 MAIN / SIDEBAR
  MAIN: 'main',                  // 职责:左列内容区;不干涉 PROMPT / FOOTER / OVERLAY
  SIDEBAR: 'sidebar',            // 职责:右栏看板;不干涉 MAIN / TASK_PANEL
  TASK_PANEL: 'task-panel',      // 职责:全宽任务清单;不干涉 MAIN / SIDEBAR
  COMPLETION_MENU: 'completion-menu', // 职责:斜杠命令 / @file 补全菜单;浮在 PROMPT 上方;不干涉 PROMPT
  PROMPT: 'prompt',              // 职责:输入框;不干涉 FOOTER / STATUS_AREA / OVERLAY
  FOOTER: 'footer',              // 职责:状态栏,输入框正下方;不干涉 PROMPT / OVERLAY
  STATUS_AREA: 'status-area',    // 职责:页尾 5 行空行(FOOTER 之下);预留未来扩展;不干涉 PROMPT
  OVERLAY: 'overlay',            // 职责:全屏覆盖层;不干涉其他区域

  // ── MAIN 大区(6)───────────────────────────────────────────────────────────
  MAIN_TEXT: 'main.text',
  MAIN_REASONING: 'main.reasoning',
  MAIN_OUTPUT: 'main.output',
  MAIN_ACTIVITY: 'main.activity',
  MAIN_TIP: 'main.tip',
  MAIN_SUBVIEW: 'main.subview',

  // ── MAIN 小区(10)──────────────────────────────────────────────────────────
  // 思考区(2)
  MAIN_REASONING_LIVE: 'main.reasoning.live',
  MAIN_REASONING_COMMITTED: 'main.reasoning.committed',
  // 输出大区(3)
  MAIN_OUTPUT_HDR: 'main.output.hdr',
  MAIN_OUTPUT_VIEW: 'main.output.view',
  MAIN_OUTPUT_INLINE: 'main.output.inline',
  // 活动区(4)
  MAIN_ACTIVITY_SPINNER: 'main.activity.spinner',
  MAIN_ACTIVITY_QUEUE: 'main.activity.queue',
  MAIN_ACTIVITY_STEER: 'main.activity.steer',
  MAIN_ACTIVITY_INTERRUPT: 'main.activity.interrupt',
  // 提示区(1)
  MAIN_TIP_DOUBLE_PRESS: 'main.tip.double-press',
});

// MAIN 子区域分组(大区在前,小区在后;便于 App.js 一组注释里引用、便于测试断言)
const MAIN_SUBREGIONS = Object.freeze([
  // 大区(6)
  REGION.MAIN_TEXT,
  REGION.MAIN_REASONING,
  REGION.MAIN_OUTPUT,
  REGION.MAIN_ACTIVITY,
  REGION.MAIN_TIP,
  REGION.MAIN_SUBVIEW,
  // 小区(10)
  REGION.MAIN_REASONING_LIVE,
  REGION.MAIN_REASONING_COMMITTED,
  REGION.MAIN_OUTPUT_HDR,
  REGION.MAIN_OUTPUT_VIEW,
  REGION.MAIN_OUTPUT_INLINE,
  REGION.MAIN_ACTIVITY_SPINNER,
  REGION.MAIN_ACTIVITY_QUEUE,
  REGION.MAIN_ACTIVITY_STEER,
  REGION.MAIN_ACTIVITY_INTERRUPT,
  REGION.MAIN_TIP_DOUBLE_PRESS,
]);

// 顶层 ID 顺序(自顶向下)
const TOP_LEVEL_ORDER = Object.freeze([
  REGION.BANNER,
  REGION.MAIN,
  REGION.SIDEBAR,
  REGION.TASK_PANEL,
  REGION.COMPLETION_MENU,
  REGION.PROMPT,
  REGION.FOOTER,
  REGION.STATUS_AREA,
  REGION.OVERLAY,
]);

// ── 区域顶对齐契约 ─────────────────────────────────────────────────────────
//   SidebarPanel 必须贴在 BANNER 之下 = MAIN 的同一行,纵向偏移等于 bannerRowsBeforeVersion。
//   改 WelcomeBanner 起始行数时,只动 bannerRowsBeforeVersion() 一处,本契约自动跟随。
function sidebarTopAnchorRows() {
  const WelcomeBanner = require('./WelcomeBanner');
  if (typeof WelcomeBanner.bannerRowsBeforeVersion !== 'function') {
    return 0;
  }
  const n = Number(WelcomeBanner.bannerRowsBeforeVersion());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ── 主区最小高度契约 ───────────────────────────────────────────────────────
//   MAIN 左列 Box 的最小行数。内容不足时用空行填充,确保主区始终有可读的最低高度。
//   单一真源:App.js 的 MAIN Box minHeight 消费此处。
const MAIN_MIN_HEIGHT = 6;

// ── 横向栏宽契约 ───────────────────────────────────────────────────────────
//   物理列宽的单一真源,ConPTY 帧间震荡由 effectiveCols.stickyCols 兜底。
//   SidebarPanel / StreamingBlock / TaskListPanel 的宽度预算均消费此处。
function railCols() {
  const { stickyCols } = require('../effectiveCols');
  return typeof stickyCols === 'function' ? stickyCols() : null;
}

// ── 覆盖层注册表(OWNING_OVERLAYS)───────────────────────────────────────────
//   任何「独占输入的全屏覆盖层」必须在此注册。hideChrome=true 的覆盖层在挂载期间
//   隐藏 ⑥ PROMPT + ⑦ FOOTER(防 ink 全屏分支触发 win32 scrollback 重复 + 输入框残影)。
//
//   判定与决策依据见 ./overlayLiveBudget.js 顶部注释 + App.js「_overlayOwnsLive」分支;
//   修改流程:加新覆盖层 → 在本表加一行 → App.js 加 state → done。不允许在 App.js 里
//   内联新的「独占输入」判定,必须经本表。
//
//   已知全部覆盖层:
//     modelPicker    — /model,ModelPicker,已确认贴顶,hideChrome=true
//     khyosOpen      — /khyos / /os,KhyOsView(QEMU 内核串口),已确认贴顶,hideChrome=true
//     rewindPicker   — 双击 Esc 触发的回溯选择,未观测贴顶,hideChrome=false(留接口)
//     rollbackPicker — /rollback 检查点选择(复用 RewindPicker 组件),同上
//     formFlow       — /login / /register / /passwd / /apikey 等顺序表单,同上
//     topologyView   — /topology view 会话森林只读视图,同上
const OWNING_OVERLAYS = Object.freeze({
  modelPicker: { region: REGION.OVERLAY, ownsInput: true, hideChrome: true },
  khyosOpen: { region: REGION.OVERLAY, ownsInput: true, hideChrome: true },
  rewindPicker: { region: REGION.OVERLAY, ownsInput: true, hideChrome: false },
  rollbackPicker: { region: REGION.OVERLAY, ownsInput: true, hideChrome: false },
  formFlow: { region: REGION.OVERLAY, ownsInput: true, hideChrome: false },
  topologyView: { region: REGION.OVERLAY, ownsInput: true, hideChrome: false },
});

// ── 覆盖层判定(供 App.js / overlayLiveBudget 共用)─────────────────────────
//   返回当前正挂载且 hideChrome=true 的覆盖层 key 列表。
//   App.js 据此决定是否隐藏 PROMPT + FOOTER;overlayLiveBudget 据此判定 ink 全屏分支。
function overlaysHidingChrome(flags = {}) {
  const f = flags && typeof flags === 'object' ? flags : {};
  return Object.keys(OWNING_OVERLAYS).filter((key) => !!f[key] && OWNING_OVERLAYS[key].hideChrome);
}

// 全部「独占输入」的覆盖层 key(无论是否隐藏 chrome),供消费方做 own-input 路由。
function owningOverlayKeys(flags = {}) {
  const f = flags && typeof flags === 'object' ? flags : {};
  return Object.keys(OWNING_OVERLAYS).filter((key) => !!f[key]);
}

module.exports = {
  REGION,
  OWNING_OVERLAYS,
  MAIN_SUBREGIONS,
  TOP_LEVEL_ORDER,
  MAIN_MIN_HEIGHT,
  sidebarTopAnchorRows,
  railCols,
  overlaysHidingChrome,
  owningOverlayKeys,
};