'use strict';

// liveRegionBudget.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:把底部 live(非 Static)区的**总高度**约束在终端行数以内,从根上避免 ink 进入
// 「fullscreen clearTerminal 重绘」分支。该分支会发 `\x1b[2J\x1b[3J\x1b[H`(清回滚缓冲 +
// 光标归位左上),在长输出/长任务清单时**每帧反复触发**→ 画面不断弹回顶部、scrollback 被
// 擦除、用户无法向下滚到结果末尾(本次修复的 bug)。
//
// 背景(诊断):本 TUI 不自管 transcript 滚动,已提交历史走 ink `<Static>` + 终端原生
// scrollback。唯一能造成「跳顶且滚不动」的机制就是 ink 的全屏清屏,而它在 **live 区渲染高度
// ≥ 终端 rows** 时被 ink 自动触发(App.js resize 全屏重绘注释亦印证此路径)。live 区是一列
// 兄弟节点(StreamingBlock + 任务清单 + 计划/队列面板 + 输入框 + footer …),其高度会**累加**。
// 真缺口两处:① StreamingBlock 只给自己留 `9+min(tools,6)` 行,**未把任务清单/计划/队列面板
// 的高度算进 reserve**;② TaskListPanel 任务清单**无行数封顶**,长清单直接把 live 区顶破。
//
// 修复(两刀,本叶子是算术单源):
//   • Plan A(reserve 纳入兄弟高度):`resolveStreamReserve` 让 StreamingBlock 的 reserve =
//     基础 chrome + 任务清单高度 + 计划/队列/steer 高度 → StreamingBlock 自动缩短正文窗口,
//     腾出空间,使 `streaming + 兄弟 ≈ rows`(StreamingBlock 内部 `max(6,…)` 地板兜底)。
//   • Plan B(任务清单封顶):`capTaskLines` 把清单尾切到与终端成比例的上界,使单个面板的高度
//     不会自身把预算撑爆(尾切=与 StreamingBlock「实时仅显示末尾」一致的锚定哲学)。
//
// 关键设计点:reserve **包含** taskHeight,所以 StreamingBlock 正好按 taskHeight 缩短 →
// 总高自平衡到 ≈ rows。唯一失守是 StreamingBlock 触到 6 行地板(极小终端 + 兄弟全满),此时
// 总高可能略超 rows——诚实边界:小终端(≤24 行)同时跑满流式正文 + 满任务清单时退化为尽力而为
// (不劣于现状,且罕见);常规终端(≥30 行)恒守住。
//
// 门控 KHY_LIVE_HEIGHT_BUDGET 默认开;关 → `resolveStreamReserve` 返回 legacy
// `9+min(tools,6)`、`capTaskLines` 不封顶(cap=Infinity)→ 逐字节回退现状。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 刀30:截断时的「按状态生存优先级」选择(进行中/错误 > 待办 > 已完成)由 taskPanelLines
// (ICON_STATUS 图标→状态 SSOT 所在)收敛,避免另立第二份图标表。
const { selectTaskLinesByPriority, taskPriorityCapEnabled } = require('./taskPanelLines');

// 任务清单面板 chrome:round 边框(上+下=2)+ 标题行(1)+ marginTop(1)。
const TASK_PANEL_CHROME = 4;
// StreamingBlock 之下「几乎恒在」的基础 chrome:输入框(~3)+ footer(~2)+ spinner/状态行(~2)
// + slack(1)。设为 9 与 legacy base 持平,使「无任何兄弟面板」时与历史**逐字节一致**。
const BASE_CHROME = 9;
// StreamingBlock 历史 reserve 基数(字节回退目标):`9 + min(toolCount,6)`。
const LEGACY_BASE = 9;
// 任务清单封顶比例与硬上下限。
const TASK_CAP_RATIO = 0.30;
const TASK_CAP_MIN = 3;
const TASK_CAP_MAX = 10;
// 兄弟面板存在时,在 reserve 上多留的安全余量,确保 `streaming + 兄弟 < rows`(严格小于,
// 因 ink 在 height >= rows 时即触发全屏清屏)。仅在确有兄弟面板时施加,使「无兄弟」case
// 与 legacy 逐字节一致。
const SAFETY_MARGIN = 2;

// 页脚**条件行**的高度(BASE_CHROME 的固定 9 未计入这两条变高行):
//   • 协作行(FooterBar bridgeLine,bridge 运行时才渲)= 1 行;
//   • 主题回退行(FooterBar,置顶 topicBar 跑不起来时把主题塞进页脚,典型见 Windows legacy
//     conhost)= 1 行。
// 二者由壳(App.js)按 `bridgeStatus.running` / `topic && !topicBarOn` 传入离散 bool,叶子只做
// 行数换算(不在叶子里读任何运行期状态,保持纯)。计入 reserve 后,StreamingBlock 正文预览相应
// 缩短,使「streaming + 页脚 < rows」,从根上不触发 ink 全屏重绘(Windows 上该重绘会把整屏刷进
// scrollback,用户报「放大缩小/生成中整屏重复刷屏」的 Windows 特有分支)。
const COLLAB_LINE_ROWS = 1;
const TOPIC_FOOTER_ROWS = 1;

// Windows 专属静态预留余量。非 win32 靠 scrollbackPreserve 剥 `\x1b[3J` + xterm 就地清屏,
// 即便偶发触顶也不在 scrollback 留重复副本,故不加(保持今日预览高度、逐字节一致)。win32 的
// clearTerminal 是 `\x1b[2J\x1b[0f`(无 3J 可剥),每次触顶都是一份**永久** scrollback 副本 →
// 反应式钳制(resolveExtraReserve)追不上,必须前馈多留:用此静态余量吸收 markdown 换行/围栏
// 边框等数据相关的正文增高,使 Windows 上从第一帧起就稳定 < rows。
const WIN_SAFETY_MARGIN = 2;

// 测量反馈钳制(measurement-feedback clamp)的目标缓冲:把 ink 实测的 live 区高度压到
// `rows - CLAMP_MARGIN`(留 2 行吸收 markdown/换行的 +1 离散化)。resolveStreamReserve 是
// **前馈预测**,永远无法准确预知数据相关的工具/兄弟面板真实渲染高度;本钳制读 ink 每帧写入的
// 真实 `lastOutputHeight`(即 ink 决策全屏清屏所用的同一高度),在超顶时把额外 reserve 抬高
// 喂回 StreamingBlock,使正文预览下一帧收缩,收敛到 live < rows,从根上止住「每帧全屏重绘」。
const CLAMP_MARGIN = 2;

/**
 * live 区高度预算默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_LIVE_HEIGHT_BUDGET;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 测量反馈钳制默认开;仅显式 falsy 关闭。独立于 KHY_LIVE_HEIGHT_BUDGET,但钳制在两者任一关时
 * 均惰性(返回 0),使 KHY_LIVE_HEIGHT_BUDGET=0 仍是整体字节回退。
 * @param {object} [env]
 * @returns {boolean}
 */
function clampEnabled(env = process.env) {
  const raw = env && env.KHY_LIVE_HEIGHT_CLAMP;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 规整终端行数(非有限/≤0 → 24 的安全兜底,部分 Windows 终端报 0)。
 * @param {*} rows
 * @returns {number}
 */
function _rows(rows) {
  const n = Number(rows);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 24;
}

/**
 * 任务清单行数上界(Plan B)。开 → `clamp(floor(rows*0.30), 3, 10)`;关 → Infinity(不封顶)。
 * @param {*} rows
 * @param {object} [env]
 * @returns {number}
 */
function resolveTaskLineCap(rows, env = process.env) {
  if (!isEnabled(env)) return Infinity;
  const r = _rows(rows);
  const cap = Math.floor(r * TASK_CAP_RATIO);
  return Math.max(TASK_CAP_MIN, Math.min(TASK_CAP_MAX, cap));
}

/**
 * 把任务清单截断到上界。**默认按状态生存优先级**保活(进行中/错误 > 待办 > 已完成),
 * 使非末尾的进行中任务不被长清单尾切挤掉(对齐 CC TaskListV2 截断优先级核心意图);
 * 同一状态档内仍守 khy 既有「尾锚定」哲学。门控 `KHY_TASK_PRIORITY_CAP` 关、或任一行
 * 图标无法识别 → 逐字节回退历史**尾切**(保留最末 cap 行)。
 * 额外返回 `hiddenLines`(被隐藏的行)供下游按状态分解隐藏项(刀19);
 * 无截断/非数组路径恒返 `[]`,保持加性、不破坏既有 `.lines`/`.hidden` 消费者。
 * @param {string[]} lines
 * @param {*} rows
 * @param {object} [env]
 * @returns {{ lines: string[], hidden: number, hiddenLines: string[] }}
 */
function capTaskLines(lines, rows, env = process.env) {
  const arr = Array.isArray(lines) ? lines : [];
  const cap = resolveTaskLineCap(rows, env);
  if (!Number.isFinite(cap) || arr.length <= cap) return { lines: arr, hidden: 0, hiddenLines: [] };
  const cut = arr.length - cap;
  // 刀30:优先保活进行中/错误/待办,陈旧已完成最先隐藏。门控开且全部行图标可识别 →
  // 优先级选择;门控关或任一行不可识别 → 回退历史尾切(slice)。截断条数 `cut` 不变,
  // 故面板高度(=保活行数)与既有 reserve 一致——本刀是「保活哪些行」的重排,高度中性。
  if (taskPriorityCapEnabled(env)) {
    const sel = selectTaskLinesByPriority(arr, cap);
    if (sel) return { lines: sel.kept, hidden: cut, hiddenLines: sel.hiddenLines };
  }
  const kept = arr.slice(cut); // tail（legacy 尾切）
  const hiddenLines = arr.slice(0, cut); // head（被丢弃,供状态分解）
  return { lines: kept, hidden: cut, hiddenLines };
}

/**
 * 任务清单面板的渲染高度(含 chrome);0 行 → 0(面板不渲染)。
 * @param {*} lineCount
 * @param {boolean} [hasHiddenNotice] - 是否多一行「⋯ 还有 N 项」提示
 * @returns {number}
 */
function taskPanelHeight(lineCount, hasHiddenNotice = false) {
  const n = Number(lineCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n) + TASK_PANEL_CHROME + (hasHiddenNotice ? 1 : 0);
}

/**
 * StreamingBlock 应为「其下方所有 live 兄弟」预留的行数(Plan A)。
 * 开 → BASE_CHROME + 工具行 + 任务清单高度 + 计划/队列/steer 高度 + 页脚条件行 + Windows 余量;
 * 关 → legacy `9 + min(toolCount,6)`(与历史逐字节一致)。
 *
 * 页脚条件行(collabActive/topicInFooter)与 Windows 余量(platform==='win32')是**加性**修正:
 * 三者皆惰性(false / 非 win32)且无兄弟面板时,返回 `BASE_CHROME + toolRows`,与今日 ON 路径
 * 逐字节一致——常规「无协作、非 Windows」场景零回归。
 *
 * @param {{ rows?:*, toolCount?:*, taskLineCount?:*, taskHasHiddenNotice?:boolean,
 *           planActive?:boolean, queueLen?:*, steerLen?:*, collabActive?:boolean,
 *           topicInFooter?:boolean, platform?:string }} [opts]
 * @param {object} [env]
 * @returns {number}
 */
function resolveStreamReserve(opts = {}, env = process.env) {
  const o = opts || {};
  const toolCount = Math.max(0, Number(o.toolCount) || 0);
  const toolRows = Math.min(toolCount, 6);
  if (!isEnabled(env)) return LEGACY_BASE + toolRows;

  // 兄弟面板的累计高度(任务清单 + 计划 + 队列 + steer)。
  let siblingHeight = taskPanelHeight(o.taskLineCount, !!o.taskHasHiddenNotice);
  if (o.planActive) siblingHeight += 3; // PlanApproval 预览 / 执行 spinner
  const queueLen = Math.max(0, Number(o.queueLen) || 0);
  if (queueLen > 0) siblingHeight += Math.min(queueLen, 4) + 1;
  const steerLen = Math.max(0, Number(o.steerLen) || 0);
  if (steerLen > 0) siblingHeight += 1;

  // 页脚条件行(BASE_CHROME 未计入的变高行)+ Windows 静态余量。均加性,惰性时为 0。
  let footerExtra = 0;
  if (o.collabActive) footerExtra += COLLAB_LINE_ROWS;
  if (o.topicInFooter) footerExtra += TOPIC_FOOTER_ROWS;
  const winMargin = (o.platform === 'win32') ? WIN_SAFETY_MARGIN : 0;

  // 三项修正皆 0 且无兄弟面板 → 与 legacy 逐字节一致(不加 base chrome 差、不加 margin)。
  if (siblingHeight <= 0 && footerExtra === 0 && winMargin === 0) return BASE_CHROME + toolRows;
  // 有兄弟面板 → 额外叠加 SAFETY_MARGIN(严格 < rows);仅页脚行/Windows 余量在时不叠 SAFETY_MARGIN
  // (那是「兄弟面板行计数离散化」的专属余量,与页脚固定行无关)。
  const siblingMargin = siblingHeight > 0 ? SAFETY_MARGIN : 0;
  return BASE_CHROME + toolRows + siblingHeight + siblingMargin + footerExtra + winMargin;
}

/**
 * 测量反馈钳制:由 ink 实测的上一帧 live 区高度算出应**额外**叠加到前馈 reserve 的行数。
 * 一轮内**单调非降**(running max via 滞回),调用方在每轮边界把 prevExtra 复位 0。
 *
 * 语义:
 *   - budget 或 clamp 任一关 → 返回 0(惰性,整体字节回退)。
 *   - measured 非有限/≤0(无信号)→ 返回 prevExtra(保持,不动)。
 *   - measured ≤ rows - CLAMP_MARGIN(在预算内)→ 返回 prevExtra(滞回,单向不降)。
 *   - 否则按超出量抬:min(prevExtra + overflow, maxExtra),maxExtra = max(0, rows - CLAMP_MARGIN)。
 *
 * 不振荡/不死循环:一轮内序列 0 ≤ e₁ ≤ e₂ … 单调非降且有上界 maxExtra,至多 maxExtra 步到
 * 不动点后恒定;调用方 `next !== prev` 相等守卫在恒定后停止 setState。极小终端(兄弟单独超 rows)
 * 时饱和于 maxExtra=prev → settle(终止但无法消除真实超出,诚实退化边界)。
 *
 * @param {{ lastOutputHeight?:*, rows?:*, prevExtra?:* }} [opts]
 * @param {object} [env]
 * @returns {number}
 */
function resolveExtraReserve(opts = {}, env = process.env) {
  const o = opts || {};
  const prev = Math.max(0, Number(o.prevExtra) || 0);
  if (!isEnabled(env) || !clampEnabled(env)) return 0; // 惰性 → 字节回退
  const rows = _rows(o.rows);
  const measured = Number(o.lastOutputHeight);
  if (!Number.isFinite(measured) || measured <= 0) return prev; // 无信号 → 保持
  const target = rows - CLAMP_MARGIN;
  const overflow = measured - target;
  if (overflow <= 0) return prev; // 在预算内 → 保持(滞回)
  const maxExtra = Math.max(0, rows - CLAMP_MARGIN); // 有限上限;下限保护交 StreamingBlock 的 max(6,…)
  return Math.min(prev + overflow, maxExtra);
}

module.exports = {
  isEnabled,
  clampEnabled,
  resolveTaskLineCap,
  capTaskLines,
  taskPanelHeight,
  resolveStreamReserve,
  resolveExtraReserve,
  OFF_VALUES,
  BASE_CHROME,
  LEGACY_BASE,
  TASK_PANEL_CHROME,
  TASK_CAP_RATIO,
  TASK_CAP_MIN,
  TASK_CAP_MAX,
  CLAMP_MARGIN,
  COLLAB_LINE_ROWS,
  TOPIC_FOOTER_ROWS,
  WIN_SAFETY_MARGIN,
};
