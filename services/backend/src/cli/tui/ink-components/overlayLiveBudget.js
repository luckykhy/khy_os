'use strict';

// overlayLiveBudget.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:让「独占输入的全屏覆盖层」(/model 的 ModelPicker、/khyos 的 KhyOsView)在挂载期间
// **不与输入框/页脚同屏累加高度**,从根上不触发 ink 的 fullscreen 重绘分支。
//
// 背景(诊断 goal「/khyos 后出现输入框残影 + 输出重复两次」):
// 本 TUI 的 live(非 <Static>)区是一列兄弟节点,高度**累加**。ink 在
// `outputHeight >= stdout.rows` 时进入全屏分支(ink.js:320-330),写
// `clearTerminal + fullStaticOutput + output`。win32 的 clearTerminal 是 `\x1b[2J\x1b[0f`
// (无 3J 可剥;scrollbackPreserve 亦刻意在所有平台剥 3J 以保住原生 scrollback),而 conhost /
// Windows Terminal 的 `2J` 是把旧帧**滚进 scrollback** 而非就地擦除 → 每次触发都在回滚缓冲里
// 留下一份**永久副本**。KhyOsView 每 40ms(FLUSH_MS)重绘一次 → 副本不断堆叠:
//   • 用户看到的「输出重复两次」= 堆叠的整屏副本;
//   • 「输入框残影」= 那些副本里被冻结的 PromptFrame/页脚 chrome。
//
// 高度账(rows=终端行数):KhyOsView 自身 = 上下边框2 + marginTop1 + 标题1 + body.marginTop1
// + body(旧代码 rows-6) = **rows-1**,已贴顶;再叠 PromptFrame(~3)+ FooterBar(~2)
// + 任务清单 → 恒 ≥ rows,即**每一帧都走全屏分支**。这不是偶发,是必然。
//
// 修复(两刀,本叶子是单一真源):
//   • ownsLiveRegion:覆盖层独占输入期间隐藏输入框/页脚。这正是仓库既有的 modelPicker 处理
//     (App.js「rendering PromptFrame + FooterBar + ModelPicker together grows the live region
//     past the terminal height … visually duplicates the prompt chrome」),此前只对 ModelPicker
//     生效,漏了同样独占输入的 KhyOsView(其 useInput 把按键送内核串口,Esc 关闭)。
//   • overlayBodyRows:把覆盖层正文预算从「rows-6」收紧为「rows - chrome - margin」,留出余量
//     吸收 hint / 补全菜单 / 任务清单等残留兄弟,使总高**严格 < rows**。
//
// 门控 KHY_OVERLAY_LIVE_BUDGET 默认开;关 →
//   ownsLiveRegion 仅认 modelPicker(与历史逐字节一致)、overlayBodyRows 返回 `max(6, rows-6)`
//   (与 KhyOsView 历史 maxBody 逐字节一致)→ 行为与今日完全相同。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 覆盖层自身 chrome:round 边框(上+下=2)+ 外 marginTop(1)+ 标题行(1)+ body marginTop(1)。
const OVERLAY_CHROME = 5;
// 覆盖层之外仍可能残留的 live 兄弟(hint 行 / 补全菜单 / 任务清单尾巴)的吸收余量。
// 取 3:比「恰好放下」多留一口气,使数据相关的 +1 离散化不会把总高顶到 rows。
const OVERLAY_MARGIN = 3;
// 正文行数地板:极小终端下也要有可读的内核输出窗口(与历史 max(6, …) 的 6 一致)。
const BODY_FLOOR = 6;
// 历史 KhyOsView 预留(字节回退目标):`max(6, rows - 6)`。
const LEGACY_RESERVE = 6;

/**
 * 覆盖层 live 预算默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_OVERLAY_LIVE_BUDGET;
  const v = String(raw === undefined || raw === null ? '' : raw)
    .trim()
    .toLowerCase();
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
 * 是否有「独占输入的全屏覆盖层」正挂载 → 壳据此隐藏 PromptFrame / FooterBar。
 *
 * 判定只看**已确认独占 stdin 的覆盖层**(它们各自的 useInput 消费按键,App 顶层 useInput
 * 对其 yield),故隐藏输入框不会让用户失去输入能力:
 *   • modelPicker(ModelPicker,/model)—— 仓库既有行为,门控关时仍只认它;
 *   • khyosOpen(KhyOsView,/khyos·/os)—— 本次补齐;按键直送内核串口,屏上已有内核自己的
 *     提示符,同屏再画一个 khy 输入框本就是两个互相矛盾的输入面(修 UX 的同时修高度)。
 *
 * 刻意**不**含 topologyView / RewindPicker / FormFlow:它们高度随内容变化、未观测到贴顶,
 * 归入本判定属推测性扩大改动集。日后如确认贴顶,只需在此处加一个 flag。
 *
 * @param {{ modelPicker?:boolean, khyosOpen?:boolean }} [flags]
 * @param {object} [env]
 * @returns {boolean}
 */
function ownsLiveRegion(flags = {}, env = process.env) {
  const f = flags || {};
  if (!isEnabled(env)) {
    return !!f.modelPicker; // legacy:只有 ModelPicker 隐藏 chrome
  }
  return !!f.modelPicker || !!f.khyosOpen;
}

/**
 * 全屏覆盖层的正文行数预算。
 * 开 → `max(6, rows - OVERLAY_CHROME - OVERLAY_MARGIN)`(= rows-8),使
 *      「覆盖层总高 = 正文 + chrome = rows-3」**严格小于** rows;
 * 关 → `max(6, rows - 6)`(与 KhyOsView 历史 maxBody 逐字节一致)。
 *
 * @param {*} rows - 终端行数
 * @param {object} [env]
 * @returns {number}
 */
function overlayBodyRows(rows, env = process.env) {
  const r = _rows(rows);
  if (!isEnabled(env)) {
    return Math.max(BODY_FLOOR, r - LEGACY_RESERVE);
  }
  return Math.max(BODY_FLOOR, r - OVERLAY_CHROME - OVERLAY_MARGIN);
}

module.exports = {
  isEnabled,
  ownsLiveRegion,
  overlayBodyRows,
  OVERLAY_CHROME,
  OVERLAY_MARGIN,
};
