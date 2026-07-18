'use strict';

// liveTimelineLazyNorm.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:消除 StreamingBlock 每帧对**整条 turn 时间线**的 normalize 预映射的分配/GC churn。
//
// 背景(诊断,承 streamNormCache/liveClampFastMeasure 同族):流式渲染时父 App 每帧(~25fps)
// 重渲,StreamingBlock:129-131 对 `streaming.timeline` 全量 `.map`:
//   rawTimeline.map((e) => e.type === 'text' ? { ...e, text: normLive(e.text) } : e)
// 但它唯一的消费者 `liveHeightClamp.tailTimelineToVisualRows` **从末尾早停**——只触及尾部
// 视口预算内的少数 entry。于是每帧凭空:①new 出一个 N 长数组;②对**每个** text entry 做 `{...e}`
// 浅拷贝(即便冻结前缀 entry 帧帧不变)。normLive 的**字符串**工作已被 streamNormCache 按内容缓存
// (O(1) 命中),但**数组分配 + N 次对象展开**仍是纯 GC 噪声,随 turn 变长累积成 O(n²)/轮的分配churn。
//
// 关键:tail 消费者从末尾走、早停,故正确做法是**惰性 normalize**——不预映射整条时间线,把原始
// (未 normalize)时间线 + 一个 normalizer 一起交给 tail 函数,tail 走到哪个 entry 才 normalize 哪个。
// 冻结前缀根本不被触及 → 零分配。惰性方案**不依赖 entry 对象身份/是否原位变更**:每帧读 `e.text` 现值
// 现算(经缓存 normLive),永远正确(增长中的尾段每帧拿到当帧全文,绝不取陈旧)。
//
// 本叶子只做「选择:惰性 vs 预映射」的确定性决策(normalizer 由调用方注入 → 叶子零 IO):
//   门控关 → 预映射(与今日表达式逐字节等价的回退);门控开 → 原样时间线 + normalizer 交给 tail 函数。
// 门控 KHY_LIVE_TIMELINE_LAZY_NORM 默认开。异常 → 尽力预映射(安全回退),再异常 → 原样时间线。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_LIVE_TIMELINE_LAZY_NORM;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 与今日 StreamingBlock:129-131 表达式逐字节等价的预映射(门控关时的回退路径)。
function _eagerMap(rawTimeline, normalizeFn) {
  return rawTimeline.map((e) =>
    (e && e.type === 'text' ? Object.assign({}, e, { text: normalizeFn(e.text) }) : e));
}

/**
 * 决定把什么时间线 + normalizer 交给 tailTimelineToVisualRows。
 *
 * @param {Array|null} rawTimeline - streaming.timeline(可能非数组/null)
 * @param {Function} normalizeFn   - (text) => normalizedText,通常 (t)=>normLive(t, selfRender)
 * @param {object} [env]
 * @returns {{ timeline: Array|null, normalizeText: (Function|null) }}
 *   - timeline:交给 tail 的时间线(门控开=原始;门控关=预映射后)
 *   - normalizeText:门控开=normalizeFn(tail 惰性调用);门控关=null(时间线已预映射)
 */
function resolveTimelineNorm(rawTimeline, normalizeFn, env = process.env) {
  if (!Array.isArray(rawTimeline)) return { timeline: rawTimeline == null ? null : rawTimeline, normalizeText: null };
  if (typeof normalizeFn !== 'function') return { timeline: rawTimeline, normalizeText: null };
  try {
    if (isEnabled(env)) {
      // 惰性:原样时间线 + normalizer 下传;tail 只 normalize 它实际触及的尾部 entry。
      return { timeline: rawTimeline, normalizeText: normalizeFn };
    }
    // 门控关:逐字节回退今日的预映射。
    return { timeline: _eagerMap(rawTimeline, normalizeFn), normalizeText: null };
  } catch {
    try { return { timeline: _eagerMap(rawTimeline, normalizeFn), normalizeText: null }; }
    catch { return { timeline: rawTimeline, normalizeText: null }; }
  }
}

module.exports = { isEnabled, resolveTimelineNorm, OFF_VALUES };
