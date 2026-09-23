'use strict';

/**
 * ccOverlayLayout.js — CC 表面浮层的「画得下」叶子（除 `termSize` 外皆为纯函数、永不抛）
 *
 * 病因（BUG-70/71/72/73/74/76，实测见 .khy/feedback/tui-ux-audit-20260919/AU/）：
 * CC 模式的三个选择器浮层（CcCommandPalette / CcHistorySearch / CcFuzzyPicker）
 * 把**条目条数**当成高度预算，且窗口永远钉在列表开头：
 *   • CcCommandPalette 一帧恒 25 行 → 在默认的 80×24 终端里也超；ink 在
 *     `outputHeight >= stdout.rows` 时走全屏分支写 `\x1b[2J`（ink.js:320-330），
 *     win32 的 2J 把旧帧**滚进回滚缓冲**而不是就地擦 → 每按一次 ↓ 留一份整屏副本，
 *     同时框的顶边被滚出屏幕（实测 12 次导航 = 10 次 2J + 顶框不在屏）。
 *   • CcHistorySearch `filtered.slice(0, 10)`：条数上限 ≠ 行预算（长条目折行后
 *     60 列时一帧 27 行），更要命的是窗口不跟随光标 → ↓ 过第 10 条后高亮「▸」
 *     根本不在屏上，Enter 选中的是看不见的那条。
 *   • CcFuzzyPicker 同形：`slice(0, maxHeight=15)`，选中项跑出窗口即隐身。
 *   • BUG-73：三个浮层一度裸读 `process.stdout.columns/rows` 求尺寸 —— 非 TTY 下是
 *     undefined，减法一路 NaN，裁切宽度塌到地板 → 条目全画成「h...」。尺寸改走
 *     `termSize()`（宿主 props 优先，其次 ../effectiveDims）。
 *   • BUG-74：CcHelpMenu 把「标签页内容有几条」当高度，四个页签的 chrome 恒 9 行，
 *     General/Commands 各 12 条 → 最短的一帧 15 行，80×12 终端上溢出 3 行并触发全屏擦除。
 *     本叶子只提供 `listRows()` 行预算，逐行裁切由浮层自己按「一行一条目」建模。
 *
 * 真源对齐：本叶子只做「行预算 + 由选中下标派生窗口起点」两件事，与
 * 主表面补全菜单的 ./CompletionMenu.js（`perPageFor` / `frameFits`，BUG-60/61）
 * 同一套判据；`./overlayLiveBudget.js` 管的是「覆盖层与输入框同屏累加」，
 * CC 表面的浮层是 early-return 整棵树（无兄弟节点累加），故不适用那条线。
 *
 * 门控 KHY_CC_OVERLAY_FIT 默认开；显式 falsy → 回退**旧的选取语义**
 * （palette 全量渲染、history 10 条、fuzzy maxHeight、窗口恒为 0），
 * 但**不回退行会计**：条目裁成一行、组间空行按行建模这两件事是本次病灶本身，
 * 关掉门控也保留（实测门控关时 palette 帧高 21 而非旧 25）。
 * 即：本门控回退的是「选谁、显示几条」，不是「一帧画多少行」。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/** 浮层不可压缩的 chrome：上/下边框 2 + 输入行 1 + 分隔线 1 + 底部提示 1。 */
const MIN_CHROME = 5;
// ink 在 outputHeight **等于** rows 时就进全屏分支，故留 1 行余量。
const FULLSCREEN_RESERVE = 1;
// 列表至少画 1 行：只留 chrome 的浮层没有任何可选内容，不如让它溢出可诊断。
const LIST_FLOOR = 1;

function isEnabled(env = process.env) {
  const raw = env && env.KHY_CC_OVERLAY_FIT;
  const v = String(raw === undefined || raw === null ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

/** 规整终端行数（部分 Windows 终端报 0/undefined → 24）。 */
function normRows(rows) {
  const n = Number(rows);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 24;
}

/**
 * 终端尺寸。本叶子唯一碰外部状态的入口（其余皆纯函数），且**永不抛**。
 * 两个来源，顺序固定：
 *   1. 宿主（CcApp）渲染时传下的 cols/rows —— 覆盖层与宿主用同一把尺子；
 *   2. ../effectiveDims 的 stickyCols/stickyRows —— 全仓唯一允许读
 *      process.stdout.columns/rows 的入口（DESIGN-ARCH-102 P4/H8，自带 sticky 兜底）。
 * 取 **sticky 原始读数**而不是 contentWidth/contentHeight：后者会在侧栏 rail 打开时
 * 扣掉边栏宽度，而 CC 表面的浮层是整窗 early-return（CcApp 的 cols 就是全宽），
 * 用主列宽会让浮层无谓地变窄。
 * 裸读 process.stdout 在 conpty/管道下是 undefined，`undefined - 8` 一路 NaN，
 * 裁切宽度塌到地板 4 → 面板条目全画成「h...」（实测，缺陷清单 BUG-73）。
 *
 * @param {'rows'|'cols'} axis
 * @param {number|null|undefined} explicit 宿主传入的现值，优先采用
 * @returns {number} 有限的正整数
 */
function termSize(axis, explicit) {
  const fallback = axis === 'rows' ? 24 : 80;
  const n = Number(explicit);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  try {
    const eff = require('../effectiveDims');
    const v = axis === 'rows' ? eff.stickyRows() : eff.stickyCols();
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 列表区可用行数：`rows - FULLSCREEN_RESERVE - chrome`，地板 `LIST_FLOOR`。
 * 与 `listRows()` 同一条算式，区别只在**不封顶到条目数** —— 调用方需要的是
 * 「这一屏还能塞几行」，而不是「显示几条」（BUG-76：转录视图每条消息占 2-9 行，
 * 条数上限从来就不等于行预算）。
 *
 * @param {*} rows 终端行数（一般传 `termSize('rows', 宿主 rows)`）
 * @param {number} chrome 不可压缩的行数（标题/边框/提示行/指示器）
 * @param {object} [p]
 * @param {number} [p.minChrome] chrome 地板；默认 `MIN_CHROME`（带边框的浮层口径）。
 *   无框的整屏视图（如转录）传更小的值，免得白扣两行可读内容。
 * @returns {number}
 */
function rowBudget(rows, chrome, { minChrome = MIN_CHROME } = {}) {
  const floor = Math.max(0, Number(minChrome) || 0);
  const ch = Math.max(floor, Number(chrome) || 0);
  return Math.max(LIST_FLOOR, normRows(rows) - FULLSCREEN_RESERVE - ch);
}

/**
 * 列表可用行数：`rows - FULLSCREEN_RESERVE - chrome`，地板 1，天花板 total。
 *
 * @param {object} p
 * @param {*} p.rows 终端行数（一般传 `termSize('rows', 宿主 rows)`）
 * @param {number} p.chrome 本浮层不可压缩的行数（含边框/输入行/分隔线/提示行）
 * @param {number} p.total 候选条目数
 * @param {number} [p.legacyCap] 门控关时的旧硬上限（旧选取语义）
 * @param {object} [p.env]
 * @returns {number}
 */
function listRows({ rows, chrome, total, legacyCap, env = process.env } = {}) {
  const n = Number.isFinite(Number(total)) ? Math.max(0, Math.floor(Number(total))) : 0;
  if (!isEnabled(env)) {
    const cap = Number.isFinite(Number(legacyCap)) ? Math.floor(Number(legacyCap)) : n;
    return Math.max(0, Math.min(cap, n));
  }
  const budget = rowBudget(rows, Math.max(MIN_CHROME, Number(chrome) || MIN_CHROME));
  return Math.max(1, Math.min(budget, n));
}

/**
 * chrome 降级梯：`rows - reserve - full < 1` 时，**账本自己就装不下**，
 * 而 `rowBudget()` 的地板（LIST_FLOOR）会把列表行硬撑到 1 —— 于是「chrome + 1」
 * 这一帧的高度正好（或超过）`rows`，撞进 ink 的全屏分支（条件是 `>=`，BUG-77b 实测）。
 * 唯一还能压的只有装饰，所以这里按调用方给定的「最没用在前」顺序逐件砍掉，
 * 直到 `rows - reserve - chrome >= minList` 为止。
 *
 * 与 `chromeBudget.ccChromePlan`（BUG-77b，主管表面那条降级梯）同一条思路：
 * **账本不许只报一个装不下的数**，它必须同时给出「为装下而放弃了什么」，
 * 由调用方照着渲染 ——  ledger 与 paint 同源，否则又变成「账按 A 收、画按 B 出」。
 *
 * 地板：砍无可砍（`shed` 用尽）时仍然 `minList`，那一帧照样越屏 —— 这是刻意留的
 * 诊断出口（同 `LIST_FLOOR` 的理由：什么都不画的浮层没有任何可用信息）。
 * 极端几何（rows ≤ chrome_min + reserve + minList）留给调用方决定是否干脆不开。
 *
 * @param {object} p
 * @param {*} p.rows 终端行数
 * @param {number} p.full 全量 chrome（一件都没砍时的行数）
 * @param {Array<{name:string,rows:number}>} [p.shed] 可砍件，**最没用在前**
 * @param {number} [p.reserve] 全屏余量，默认 `FULLSCREEN_RESERVE`
 * @param {number} [p.minList] 列表至少几行，默认 `LIST_FLOOR`
 * @returns {{chrome:number,budget:number,shed:string[],fits:boolean}}
 */
function chromePlan({ rows, full, shed = [], reserve = FULLSCREEN_RESERVE, minList = LIST_FLOOR } = {}) {
  const n = normRows(rows);
  const need = Math.max(0, Number(minList) || 0);
  let chrome = Math.max(0, Math.floor(Number(full) || 0));
  const cut = [];
  for (const piece of Array.isArray(shed) ? shed : []) {
    if (n - reserve - chrome >= need) break;
    chrome = Math.max(0, chrome - Math.max(0, Math.floor(Number(piece && piece.rows) || 0)));
    if (piece && piece.name) cut.push(String(piece.name));
  }
  return {
    chrome,
    budget: Math.max(need, n - reserve - chrome),
    shed: cut,
    fits: n - reserve - chrome >= need,
  };
}

/**
 * 带门控的装饰让位梯（BUG-88b/89b）。
 *
 * `chromePlan()` 是纯算式，不知道 `KHY_CC_OVERLAY_FIT` 这道门；浮层侧直接调它会让
 * 「门控关 = 逐字节回退旧行为」这条承诺失效（装饰照样被砍）。这一层壳把两件事收在
 * 一起：门控关 → 一件不砍、chrome 恒 `full`；门控开 → 走 `chromePlan`，
 * 先要 2 行列表（1 行内容 + 1 行提示），付不起再退到 1 行。
 *
 * 判据与 `CcHelpMenu.helpChromePlan`（BUG-88）同一条，只是那条长在浮层自己文件里；
 * 现在有第三个、第四个表面要用同一台机器，才抽到这里。
 *
 * @param {object} p
 * @param {*} p.rows 终端行数
 * @param {number} p.full 全量 chrome
 * @param {Array<{name:string,rows:number}>} p.shed 可砍件，最没用在前
 * @param {number} p.total 当前候选行数
 * @param {object} [p.env]
 * @returns {{chrome:number,budget:number,shed:string[],fits:boolean}}
 */
function chromeLadder({ rows, full, shed, total, env = process.env } = {}) {
  const n = Number.isFinite(Number(total)) ? Math.max(0, Math.floor(Number(total))) : 0;
  const f = Math.max(0, Math.floor(Number(full) || 0));
  if (!isEnabled(env)) {
    // 旧行为：装饰一件不砍，列表行数交给 listRows 的 legacyCap 分支（由调用方算）。
    return { chrome: f, budget: n, shed: [], fits: true };
  }
  const args = { rows, full: f, shed };
  const preferred = chromePlan({ ...args, minList: n > 1 ? 2 : 1 });
  return preferred.fits ? preferred : chromePlan({ ...args, minList: 1 });
}

/**
 * 窗口起点：由**选中下标**派生（BUG-61 同一条判据），保证选中项恒在窗口内。
 * 末页贴底，避免出现「只剩 2 条也占一页、下半截空白」。
 *
 * @param {number} selected 选中下标（可为负/越界，内部钳制）
 * @param {number} visible 一屏可见行数
 * @param {number} total 条目总数
 * @param {object} [p.env]
 * @returns {number} start 下标
 */
function pageStart(selected, visible, total, env = process.env) {
  if (!isEnabled(env)) return 0;
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const v = Math.max(1, Math.floor(Number(visible) || 1));
  const i = Math.min(Math.max(0, Math.floor(Number(selected) || 0)), Math.max(0, n - 1));
  if (n <= v) return 0;
  const page = Math.floor(i / v) * v;
  return Math.min(page, n - v);
}

/** 浮层放不下时的提示尾巴（放进既有一行的提示里，不额外占行）。门控关 → 空串（旧 UI 不说这话）。 */
function moreHint(selected, visible, total, env) {
  if (!isEnabled(env)) return '';
  const start = pageStart(selected, visible, total, env);
  const above = start;
  const below = Math.max(0, (Number(total) || 0) - start - (Number(visible) || 0));
  const parts = [];
  if (above > 0) parts.push(`+${above} ↑`);
  if (below > 0) parts.push(`+${below} ↓`);
  return parts.join(' ');
}

/**
 * 按**显示宽度**把一条文本裁成一行（CJK 双宽、去掉内嵌换行）。
 * 不裁则一条长条目折成 2-3 视觉行，「条数上限」立刻不再等于「行预算」，帧高失控
 * （BUG-72 实测：60 列终端里 10 条历史画出 27 行）。
 *
 * @param {*} s
 * @param {number} w 可用显示列数
 * @returns {string}
 */
function clipLine(s, w) {
  const str = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ');
  const width = Math.max(4, Math.floor(Number(w) || 4));
  try {
    const { truncateToWidth } = require('../../formatters');
    return truncateToWidth(str, width);
  } catch {
    return str.length > width ? str.slice(0, Math.max(0, width - 1)) + '…' : str;
  }
}

/**
 * 列表区里「条目 + 另有 N 条提示行」怎么分这 `budget` 行 —— **提示行也 from 预算**，
 * 不许在预算之外追加（BUG-88：CcHelpMenu 原先 `shown = max(1, budget - 1)` 之后
 * 又 push 一行提示，实画恒 = 预算 + 1，与 BUG-84 的输入框同形）。
 * 预算只够 1 行时**内容优先**：宁可不说「还有 N 条」，也不让用户看见半截装饰。
 *
 * @param {number} budget 列表区可用行（含提示行）
 * @param {number} total 条目总数
 * @returns {{shown:number,hint:boolean}}
 */
function listWithHint(budget, total) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const b = Math.max(0, Math.floor(Number(budget) || 0));
  if (n <= b) return { shown: n, hint: false };
  if (b <= 1) return { shown: Math.min(1, n), hint: false };
  return { shown: b - 1, hint: true };
}

module.exports = {
  isEnabled,
  normRows,
  termSize,
  listRows,
  rowBudget,
  chromePlan,
  chromeLadder,
  listWithHint,
  pageStart,
  moreHint,
  clipLine,
  MIN_CHROME,
  FULLSCREEN_RESERVE,
  LIST_FLOOR,
};
