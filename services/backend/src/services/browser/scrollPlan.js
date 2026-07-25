'use strict';

/**
 * scrollPlan.js — 纯叶子 (pure leaf)：Playwright「强力爬虫」的确定性判断单一真源。
 *
 * 契约 (CONTRACT)：零 IO、确定性、绝不抛、env 门控默认开 (KHY_BROWSER_AUTOSCROLL)。
 *   本模块只做**确定性的滚动决策与文本归并**（纯数值 / 字符串运算，绝不碰 fs / 子进程 /
 *   网络 / Playwright）；真正的 page.evaluate / scrollBy / waitForTimeout 等 IO 由
 *   browser/session.js 的 autoScroll / jumpToIndex 在本叶子裁决的参数与判断下执行。
 *
 * 设计意图 (为什么把判断收进纯叶子)：
 *   「完整滚动到底」最大的脚枪是**无限滚动失控**——某些页面每滚一次就再加载一屏，
 *   永远停不下来。这里把「何时停（高度不再增长 N 轮 / 达到次数上界 / 达到字符上界）」与
 *   「虚拟滚动如何去重（DOM 回收时同一项会反复出现）」固化成可单测的确定性规则，让 IO 层
 *   只负责执行，绝不自己拍脑袋决定停不停。
 *
 * 门控：KHY_BROWSER_AUTOSCROLL 默认开，置 {0,false,off,no} 关闭后 autoScroll 字节回退到
 *   单次「滚到底」（session.js 负责回退；本叶子只提供 isEnabled 判定）。
 */

/** autoScroll 的默认参数（均可被 opts / env 覆盖，再经夹取）。 */
const DEFAULTS = Object.freeze({
  maxPasses: 60,        // 最多滚动轮数（硬上界，防无限滚动）
  settleMs: 400,        // 每轮滚动后等待懒加载的毫秒数
  stableRounds: 3,      // 高度连续多少轮不增长即判定「到底」
  maxChars: 2_000_000,  // harvest 文本字符上界（防内存爆）
  stepRatio: 0.9,       // 每轮滚动 innerHeight * stepRatio
});

/** 数值夹取：非有限数 → 回退 fallback，再夹到 [lo, hi]。 */
function _clampNum(v, lo, hi, fallback) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = fallback;
  if (n < lo) n = lo;
  if (n > hi) n = hi;
  return n;
}

/** 整数夹取（用于 maxPasses / stableRounds / index）。 */
function _clampInt(v, lo, hi, fallback) {
  return Math.round(_clampNum(v, lo, hi, fallback));
}

/** 读 env 数字（缺失 / 非法 → undefined，交由后续夹取用默认值）。委托单一真源 utils/envNum。 */
const _envNum = require('../../utils/envNum');

/** 是否启用自动滚动（门控关 → 字节回退，autoScroll 退化为单次滚到底）。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_BROWSER_AUTOSCROLL) != null ? env.KHY_BROWSER_AUTOSCROLL : '')
    .trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 合并 opts + env 默认并夹取，得到一份确定性的滚动配置。
 * @param {Object} [opts]  调用方（工具入参）给的配置
 * @param {Object} [env]   环境变量（读 KHY_BROWSER_SCROLL_* 默认）
 * @returns {{maxPasses,settleMs,stableRounds,maxChars,stepRatio,harvest,harvestSelector,toSelector}}
 */
function normalizeScrollConfig(opts = {}, env = (typeof process !== 'undefined' ? process.env : {})) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const e = env && typeof env === 'object' ? env : {};

  const maxPasses = _clampInt(
    o.maxPasses != null ? o.maxPasses : _envNum(e, 'KHY_BROWSER_SCROLL_MAX_PASSES'),
    1, 1000, DEFAULTS.maxPasses,
  );
  const settleMs = _clampNum(
    o.settleMs != null ? o.settleMs : _envNum(e, 'KHY_BROWSER_SCROLL_SETTLE_MS'),
    0, 30_000, DEFAULTS.settleMs,
  );
  const maxChars = _clampInt(
    o.maxChars != null ? o.maxChars : _envNum(e, 'KHY_BROWSER_SCROLL_MAX_CHARS'),
    1000, 20_000_000, DEFAULTS.maxChars,
  );
  const stableRounds = _clampInt(o.stableRounds, 1, 10, DEFAULTS.stableRounds);
  const stepRatio = _clampNum(o.stepRatio, 0.1, 1, DEFAULTS.stepRatio);

  return {
    maxPasses,
    settleMs,
    stableRounds,
    maxChars,
    stepRatio,
    harvest: !!o.harvest,
    harvestSelector: typeof o.harvestSelector === 'string' && o.harvestSelector.trim()
      ? o.harvestSelector.trim() : null,
    toSelector: typeof o.toSelector === 'string' && o.toSelector.trim()
      ? o.toSelector.trim() : null,
  };
}

/**
 * 计算下一轮「高度未增长」的连续计数。
 * 虚拟滚动里 scrollHeight 可能维持不变（DOM 回收）——靠这个连续计数判定「到底」。
 * @returns {number} height <= prevHeight ? prevStreak+1 : 0
 */
function nextStagnant(prevStreak, prevHeight, height) {
  const ps = Number.isFinite(prevStreak) && prevStreak > 0 ? Math.floor(prevStreak) : 0;
  const ph = Number(prevHeight);
  const h = Number(height);
  if (!Number.isFinite(h)) return ps; // 读不到高度：保守不归零也不增长
  if (!Number.isFinite(ph)) return 0; // 首轮没有上一高度：不算停滞
  return h <= ph ? ps + 1 : 0;
}

/**
 * 是否继续滚动。纯判定，所有事实由调用方在每轮探测后传入。
 * @param {Object} state
 * @param {number} state.pass            当前轮次（从 1 起）
 * @param {number} state.maxPasses
 * @param {number} state.stagnantStreak  连续未增长轮数
 * @param {number} state.stableRounds
 * @param {number} [state.harvestedChars]
 * @param {number} [state.maxChars]
 * @returns {{cont:boolean, reason:string}}
 */
function decideContinue(state = {}) {
  const pass = Number(state.pass) || 0;
  const maxPasses = Number(state.maxPasses) || DEFAULTS.maxPasses;
  const stagnantStreak = Number(state.stagnantStreak) || 0;
  const stableRounds = Number(state.stableRounds) || DEFAULTS.stableRounds;
  const harvestedChars = Number(state.harvestedChars) || 0;
  const maxChars = Number(state.maxChars) || DEFAULTS.maxChars;

  if (pass >= maxPasses) return { cont: false, reason: 'max-passes' };
  if (harvestedChars >= maxChars) return { cont: false, reason: 'char-cap' };
  if (stagnantStreak >= stableRounds) return { cont: false, reason: 'stable' };
  return { cont: true, reason: 'continue' };
}

/** 新建一份空的 harvest 累积状态。 */
function newHarvestState() {
  return { keys: Object.create(null), text: '', chars: 0, lines: 0, truncated: false };
}

/**
 * 把一段新采集到的文本并入累积状态——**虚拟滚动去重核心**。
 * 虚拟列表滚动时同一项的文本会反复出现，这里按「归一化整行」去重，只追加未见过的行，
 * 并在超过 maxChars 时截断（置 truncated）。纯函数：不修改入参 state，返回新状态。
 *
 * @param {Object} state      上一累积状态（来自 newHarvestState / 上次返回）
 * @param {string} chunkText  本轮 innerText
 * @param {number} maxChars   字符上界
 * @returns {{keys,text,chars,lines,truncated}}
 */
function mergeHarvest(state, chunkText, maxChars) {
  const base = state && typeof state === 'object' ? state : newHarvestState();
  const keys = Object.create(null);
  // 浅拷贝已见 key 集（保持纯函数：不动入参）。
  if (base.keys) for (const k in base.keys) keys[k] = true;

  let text = typeof base.text === 'string' ? base.text : '';
  let chars = Number.isFinite(base.chars) ? base.chars : text.length;
  let lines = Number.isFinite(base.lines) ? base.lines : 0;
  let truncated = !!base.truncated;
  const capNum = Number(maxChars);
  const cap = Number.isFinite(capNum) && capNum > 0 ? capNum : DEFAULTS.maxChars;

  if (typeof chunkText === 'string' && chunkText && !truncated) {
    const rawLines = chunkText.split(/\r?\n/);
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line) continue;
      const key = line; // 归一化键 = trim 后整行
      if (keys[key]) continue;
      keys[key] = true;
      const piece = (text ? '\n' : '') + line;
      if (chars + piece.length > cap) { truncated = true; break; }
      text += piece;
      chars += piece.length;
      lines += 1;
    }
  }

  return { keys, text, chars, lines, truncated };
}

/** 取首个非空字符串。 */
function _firstStr(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * 归一化「跳转索引」目标。把多种入参收敛成一个确定性的 {mode,...}，供 session.jumpToIndex
 * 在页内 page.evaluate 时分支定位。优先级：anchor/hash > index(+itemSelector) > text > selector。
 *
 * @param {Object} [opts]
 * @returns {{mode:'anchor'|'index'|'text'|'selector'|'none', ...}}
 */
function resolveIndexTarget(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};

  // anchor / hash：'#id' 或裸 id 或 a[name=...]。
  const anchorRaw = _firstStr(o.hash, o.anchor);
  if (anchorRaw) {
    const value = anchorRaw.replace(/^#+/, '').trim();
    if (value) return { mode: 'anchor', value };
  }

  // index：需有数字 index；itemSelector 缺省 '*'。
  if (o.index != null && o.index !== '' && Number.isFinite(Number(o.index))) {
    const itemSelector = _firstStr(o.itemSelector, o.selector) || '*';
    const index = _clampInt(o.index, 0, 1_000_000, 0);
    return { mode: 'index', itemSelector, index };
  }

  // text：在页内找含该文本的元素；可选 selector 缩小范围。
  const text = _firstStr(o.text);
  if (text) {
    const selector = _firstStr(o.selector);
    return { mode: 'text', text, selector };
  }

  // selector：直接 CSS 定位。
  const selector = _firstStr(o.selector);
  if (selector) return { mode: 'selector', selector };

  return { mode: 'none' };
}

module.exports = {
  DEFAULTS,
  isEnabled,
  normalizeScrollConfig,
  nextStagnant,
  decideContinue,
  newHarvestState,
  mergeHarvest,
  resolveIndexTarget,
};
