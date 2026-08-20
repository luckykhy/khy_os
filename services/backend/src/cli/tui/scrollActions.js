'use strict';

/**
 * scrollActions — 滚动视口偏移计算的单一真源(纯叶子:零 IO、确定性、绝不抛)。
 *
 * 背景(参照实现:Claude Code keybindings 注册表)。CC 把「滚动」建模成一族**动作名**,
 * 由 context 决定哪些键映射到它们,而不是把偏移算术散落在每个视图组件里。CC 的
 * `Transcript` context 原文:
 *   ctrl+u → scroll:halfPageUp    ctrl+d → scroll:halfPageDown
 *   ctrl+b → scroll:fullPageUp    ctrl+f → scroll:fullPageDown
 *   ctrl+p / k / up   → scroll:lineUp
 *   ctrl+n / j / down → scroll:lineDown
 *   g / home → scroll:top         shift+g / end → scroll:bottom
 *   space → scroll:fullPageDown   b → scroll:fullPageUp
 * 半页/整页的步长惯例同 less(半页 = ⌊viewport/2⌋,整页 = viewport)。
 *
 * 本叶子只做「动作名 + 当前偏移 → 新偏移」的纯算术并 clamp 到合法区间,绝不触 React、
 * 绝不读 env、绝不渲染。ShellView 此前把这套算术内联成 `setShellScroll(s => s - 1)`
 * 之类的散点(且完全没有上界 clamp —— 按住 ↓ 能把偏移推到远超内容行数,视图空白),
 * 新视图与它都收敛到这里。
 *
 * 动作名同时接受裸名(`'lineUp'`)与 CC 原样的带前缀名(`'scroll:lineUp'`),这样调用方
 * 可以逐字节照抄 CC 注册表而不必再做一层翻译。
 */

/** CC `scroll:*` 动作族的裸名全集(顺序 = CC 注册表出现顺序)。 */
const SCROLL_ACTIONS = Object.freeze([
  'lineUp',
  'lineDown',
  'halfPageUp',
  'halfPageDown',
  'fullPageUp',
  'fullPageDown',
  'top',
  'bottom',
]);

const _ACTION_SET = new Set(SCROLL_ACTIONS);

/** 有限非负整数化。非数/NaN/Infinity/负数 → 0(fail-soft,绝不抛)。 */
function _nat(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 剥掉 CC 的 `scroll:` 前缀,得到裸动作名;不是已知动作则返回 null。
 * @param {*} action 裸名或 `scroll:` 前缀名(大小写敏感,与 CC 注册表一致)
 * @returns {string|null}
 */
function normalizeAction(action) {
  if (typeof action !== 'string') {
    return null;
  }
  const bare = action.startsWith('scroll:') ? action.slice(7) : action;
  return _ACTION_SET.has(bare) ? bare : null;
}

/**
 * 可滚动上界:内容比视口短时为 0(不可滚)。
 * @param {{viewport?:number, total?:number}} [dims]
 * @returns {number}
 */
function maxOffset({ viewport, total } = {}) {
  return Math.max(0, _nat(total) - _nat(viewport));
}

/**
 * 把偏移 clamp 到 [0, maxOffset]。
 * @param {number} offset
 * @param {{viewport?:number, total?:number}} [dims]
 * @returns {number}
 */
function clampOffset(offset, dims) {
  const max = maxOffset(dims);
  const n = Number(offset);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.min(Math.floor(n), max);
}

/**
 * 应用一个滚动动作,返回新偏移(已 clamp)。
 *
 * 未知动作 / 缺参 → 返回 clamp 后的原偏移(fail-soft:不动比乱跳好)。步长下界为 1 行,
 * 否则 viewport 为 1 时半页 = ⌊0.5⌋ = 0,按键变成静默 no-op。
 *
 * @param {string} action 裸名或 CC 的 `scroll:xxx`
 * @param {{offset?:number, viewport?:number, total?:number}} [dims]
 *   offset=当前首行索引(0-based),viewport=可见行数,total=内容总行数
 * @returns {number} 新的首行索引
 */
function applyScroll(action, dims = {}) {
  const d = dims && typeof dims === 'object' ? dims : {};
  const cur = clampOffset(d.offset, d);
  const name = normalizeAction(action);
  if (!name) {
    return cur;
  }
  const viewport = _nat(d.viewport);
  const half = Math.max(1, Math.floor(viewport / 2));
  const full = Math.max(1, viewport);
  switch (name) {
    case 'lineUp':
      return clampOffset(cur - 1, d);
    case 'lineDown':
      return clampOffset(cur + 1, d);
    case 'halfPageUp':
      return clampOffset(cur - half, d);
    case 'halfPageDown':
      return clampOffset(cur + half, d);
    case 'fullPageUp':
      return clampOffset(cur - full, d);
    case 'fullPageDown':
      return clampOffset(cur + full, d);
    case 'top':
      return 0;
    case 'bottom':
      return maxOffset(d);
    default:
      return cur;
  }
}

module.exports = {
  SCROLL_ACTIONS,
  normalizeAction,
  maxOffset,
  clampOffset,
  applyScroll,
};
