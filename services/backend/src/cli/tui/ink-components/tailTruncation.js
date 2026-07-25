'use strict';

// tailTruncation.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:消除 liveHeightClamp 尾切收尾处**每帧对整条时间线的 filter().length 全量扫描**。
//
// 背景(承 [[project_live_timeline_lazy_norm_per_frame_alloc]] Slice 4):liveHeightClamp 的
// `tailTimelineToVisualRows` / `_tailTimelineRaw` 从末尾早停构建可见尾窗(只触及尾部少数 entry),
// 但收尾用 `timeline.filter(visiblePred).length` **全量扫描整条时间线**来判 `truncated`——每帧一次。
// 且带 `norm`(惰性归一化 normalizer)时,该 filter 对**整条**(含冻结前缀)重跑 normalizer,
// **部分抵消 Slice 4 让尾循环只归一化尾段的收益**,还分配一个用完即弃的过滤数组 = 每帧 O(N) CPU+分配。
//
// 关键取证:`truncated` 完全由尾循环的**停点**决定,无需全量扫描。尾循环从 len-1 递减,处理
// 索引 `[k..len-1]`、未处理 `[0..i]`(i=k-1):
//   out.length = countVisible([k..len-1]);  visible = countVisible([0..i]) + out.length
//   ⇒ out.length < visible ⟺ countVisible([0..i]) > 0 ⟺ arr[0..i] 存在可见项。
// 故:`truncated ⟺ 内层尾切已置位 OR (停点 i>=0 且 arr[0..i] 存在可见项)`。用**早停**扫描
// arr[0..i](命中首个可见项即返)替代全量 filter:truncated 场景通常 O(1)(索引 0 常可见)。
//
// 门控 KHY_TAIL_TRUNCATION_FAST default-on。关 / 缺叶子 → 调用方逐字节回退全量 filter().length。
// 绝不抛(异常 → 保守返 true,宁可多显示一次「更多内容」指示,绝不隐藏内容)。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_TAIL_TRUNCATION_FAST;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 与两处调用点**完全一致**的可见谓词:tool 恒可见;text 仅当(归一化后)非空。
// norm 可选(惰性归一化 normalizer);缺省则读 e.text 原文。
function _isVisible(e, norm) {
  if (!e) return false;
  if (e.type === 'tool') return true;
  if (e.type === 'text') {
    const t = norm ? norm(e.text) : e.text;
    return !!t;
  }
  return false;
}

/**
 * arr[0..stopIndex] 是否存在可见项(从 stopIndex 向 0 **早停**扫描,命中即返)。
 * stopIndex < 0 → false(尾循环已走到顶,无未处理项)。异常 → true(保守)。
 * @param {Array} arr
 * @param {number} stopIndex - 尾循环退出时的索引 i(未处理区间为 [0..i])
 * @param {Function} [norm]
 * @returns {boolean}
 */
function hasVisibleAbove(arr, stopIndex, norm) {
  try {
    if (!Array.isArray(arr)) return false;
    let j = Math.min(Number(stopIndex), arr.length - 1);
    for (; j >= 0; j--) {
      if (_isVisible(arr[j], norm)) return true;
    }
    return false;
  } catch { return true; }
}

/**
 * 尾切收尾判定:内层尾切已置位 → true;否则「停点以上存在可见项」→ true。
 * 与 `truncated || (out.length < countVisible(arr))` 逐结果等价(见文件头证明)。
 * @param {boolean} innerCutTruncated - 尾循环内因单段过大被尾切时置的 truncated
 * @param {number} stopIndex - 尾循环退出时的索引 i
 * @param {Array} arr
 * @param {Function} [norm]
 * @returns {boolean}
 */
function resolveTailTruncated(innerCutTruncated, stopIndex, arr, norm) {
  if (innerCutTruncated) return true;
  return hasVisibleAbove(arr, stopIndex, norm);
}

module.exports = { isEnabled, hasVisibleAbove, resolveTailTruncated, _isVisible, OFF_VALUES };
