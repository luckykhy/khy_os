'use strict';

// Cache-hit-rate warning — pure leaf (zero IO, deterministic, fail-soft).
// Aligns the LOGIC BEHIND Claude Code's prompt-cache warning, NOT just its look.
//
// CC reference: src/utils/cacheWarning.ts — calculateCacheHitRate /
// shouldShowCacheWarning / createCacheWarningMessage, constant
// DEFAULT_CACHE_THRESHOLD = 80. CC's documented 背后逻辑: when a prompt-cache
// capable link reports usage, the cache HIT RATE = cache_read / (input +
// cache_creation + cache_read); if that rate drops below a threshold (default
// 80%) the user is silently paying near-full price for context that should have
// been cache-served, so CC surfaces a one-shot `system` warning per turn (with a
// trend arrow vs the previous turn). The FIRST observation only seeds the
// baseline — no warning — because a trend needs two points.
//
// khy parity: khy's adapters already normalize cache billing into
// tokenUsage.cacheReadInputTokens / cacheWriteInputTokens (see
// services/gateway/adapters/_cacheUsage.js), and inputTokens is the UNCACHED
// input segment — the exact three disjoint buckets CC's formula needs. But khy
// never computed or surfaced the hit rate anywhere. This leaf reproduces CC's
// algorithm faithfully.
//
// Honest divergence from CC: CC keeps a module-level Map<querySource, state>
// (bounded at MAX_SOURCE_ENTRIES=50 with oldest-eviction) to remember the last
// hit rate. This leaf is intentionally STATELESS — the single `lastHitRate`
// scalar lives in the caller (a per-hook ref, matching the idle-return /
// post-compaction 刀). That removes the unbounded-Map failure mode entirely and
// keeps the leaf pure. When no cache data is present (non-cache links / gateways
// that drop cache fields) the rate is null → no warning, mirroring CC's "no
// cache data" branch exactly.

const DEFAULT_CACHE_THRESHOLD = 80;
const OFF_VALUES = ['0', 'false', 'off', 'no'];

function cacheWarningEnabled(env) {
  const raw = env && env.KHY_CACHE_WARNING;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// Threshold percent (1..100). Env override KHY_CACHE_THRESHOLD; anything
// out-of-range or non-numeric → CC's documented default (80). Mirrors CC's
// settings.cacheThreshold ?? DEFAULT_CACHE_THRESHOLD.
function getCacheThreshold(env) {
  const raw = env && env.KHY_CACHE_THRESHOLD;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1 && n <= 100) return n;
  return DEFAULT_CACHE_THRESHOLD;
}

// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../utils/finiteNumber').toPositiveOr0;

function _numOrNull(v) {
  if (v == null) return null; // null/undefined → null (a real 0 stays 0)
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Faithful port of CC calculateCacheHitRate. Accepts khy-canonical token field
// names (inputTokens / cacheWriteInputTokens / cacheReadInputTokens) and also
// tolerates CC's raw Anthropic snake_case as a fallback, so the leaf is reusable.
// Returns 0..100, or null when there is no cache data (both cache segments 0) or
// no input at all — CC's exact null branches.
function calculateCacheHitRate(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = _num(usage.inputTokens != null ? usage.inputTokens : usage.input_tokens);
  const cacheWrite = _num(
    usage.cacheWriteInputTokens != null ? usage.cacheWriteInputTokens : usage.cache_creation_input_tokens
  );
  const cacheRead = _num(
    usage.cacheReadInputTokens != null ? usage.cacheReadInputTokens : usage.cache_read_input_tokens
  );
  // 所有缓存字段为 0 → 无缓存数据(对齐 CC)。
  if (cacheRead === 0 && cacheWrite === 0) return null;
  const total = input + cacheWrite + cacheRead;
  if (total === 0) return null;
  return (cacheRead / total) * 100;
}

// ── 会话累计命中率(承 KHY_PROMPT_CACHE_ORDER;对标 Reasonix SessionCache)──────────
// 单轮命中率天然抖动(新会话预热、一轮大 tail 就砸下去),页脚一个跳动的 8% 既不稳也不
// 能反映重排后的真实收益。会话累计把整会话每轮的 hit/miss 累加,aggregate=hit/(hit+miss),
// 更平滑、更高、更诚实。纯函数;状态(session 计数)由调用方(repl/TUI)持有,本叶子仍无状态。

// 会话累计门控。默认开;仅显式 0/false/off/no 关。关 → 调用方不累计、不显示会话行。
function sessionAggregateEnabled(env) {
  const raw = env && env.KHY_CACHE_SESSION_AGGREGATE;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 从一轮 usage 抽出 {input, cacheWrite, cacheRead}(复用 calculateCacheHitRate 的字段口径:
// khy 规范名优先、CC snake_case 兜底)。无 usage → 全 0。绝不抛。
function _extractCacheTokens(usage) {
  if (!usage || typeof usage !== 'object') return { input: 0, cacheWrite: 0, cacheRead: 0 };
  return {
    input: _num(usage.inputTokens != null ? usage.inputTokens : usage.input_tokens),
    cacheWrite: _num(
      usage.cacheWriteInputTokens != null ? usage.cacheWriteInputTokens : usage.cache_creation_input_tokens
    ),
    cacheRead: _num(
      usage.cacheReadInputTokens != null ? usage.cacheReadInputTokens : usage.cache_read_input_tokens
    ),
  };
}

// 把一轮 usage 累加进会话计数。hit += cacheRead;miss += (input + cacheWrite)——与单轮公式
// cacheRead/(input+cacheWrite+cacheRead) 同分母口径,故 aggregate 与单轮同尺度可直接对比。
// prev 缺省 → 从零起。无缓存数据(read+write 皆 0)的一轮不计入 turns(与单轮「无数据」对齐)。
// 返回**新对象**(不改 prev),调用方存回自己的 ref。绝不抛。
function accumulateSessionCache(prev, usage) {
  const base = prev && typeof prev === 'object'
    ? { hit: _num(prev.hit), miss: _num(prev.miss), turns: _num(prev.turns) }
    : { hit: 0, miss: 0, turns: 0 };
  try {
    const { input, cacheWrite, cacheRead } = _extractCacheTokens(usage);
    if (cacheRead === 0 && cacheWrite === 0) return base; // 无缓存数据 → 原样(不计 turn)
    return {
      hit: base.hit + cacheRead,
      miss: base.miss + input + cacheWrite,
      turns: base.turns + 1,
    };
  } catch {
    return base;
  }
}

// 会话累计命中率百分比(0..100),或 null(无累计数据)。
function aggregateCacheRate(session) {
  const hit = _num(session && session.hit);
  const miss = _num(session && session.miss);
  const total = hit + miss;
  if (total === 0) return null;
  return (hit / total) * 100;
}

// 会话累计一行文案(khy scope 允许中文)。turns<1 或无数据 → null(不打印)。
function buildSessionAggregateLine(session) {
  const rate = aggregateCacheRate(session);
  if (rate === null) return null;
  const turns = _num(session && session.turns);
  if (turns < 1) return null;
  return `会话累计命中率 ${Math.round(rate)}%(${turns} 轮)`;
}

// 便利入口:给定本轮 usage + 调用方持有的会话计数,返回累计后的新计数与可显示文案。
// 门控关 → { session: 原样累加(仍供调用方持有), text: null }?——不。门控关时**完全不介入**:
// 返回 null,调用方逐字节回退到「只显示单轮」。门控开 → { session:新计数, rate, text }。
// text 在 turns<2 时为 null(单轮时会话=单轮,无额外信息,避免噪声);≥2 轮才显示。绝不抛。
function sessionAggregateFor(input, env) {
  try {
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (!sessionAggregateEnabled(e)) return null;
    const prev = input && input.session;
    const session = accumulateSessionCache(prev, input && input.usage);
    const rate = aggregateCacheRate(session);
    const text = session.turns >= 2 ? buildSessionAggregateLine(session) : null;
    return { session, rate, text };
  } catch {
    return null;
  }
}

// Pure trend/threshold evaluation. `lastHitRate` may be null (first observation)
// — the caller owns first-obs suppression; this returns trend=null in that case.
function evaluateCacheWarning({ hitRate, lastHitRate, threshold }) {
  const rate = _numOrNull(hitRate);
  const thr = Number.isFinite(Number(threshold)) ? Number(threshold) : DEFAULT_CACHE_THRESHOLD;
  if (rate === null) return { shouldWarn: false, trend: null };
  const last = _numOrNull(lastHitRate);
  const trend = last === null ? null : rate - last;
  return { shouldWarn: rate < thr, trend };
}

// Chinese-CLI warning line (khy scope allows Chinese). Mirrors CC's
// `Cache hit rate X%, below Y% threshold (^/vN%)`; the trend segment is shown
// only when |trend| > 0.1 (CC's exact guard). Arrows use ↑/↓ to match khy's
// existing token-arrow aesthetic instead of CC's ASCII ^/v.
function buildCacheWarningLine({ hitRate, threshold, trend }) {
  const rate = Math.round(_num(hitRate));
  const thr = Math.round(Number.isFinite(Number(threshold)) ? Number(threshold) : DEFAULT_CACHE_THRESHOLD);
  let line = `缓存命中率 ${rate}%,低于 ${thr}% 阈值`;
  const t = _numOrNull(trend);
  if (t !== null && Math.abs(t) > 0.1) {
    const icon = t > 0 ? '↑' : '↓';
    line += `(${icon}${Math.abs(Math.round(t))}%)`;
  }
  return line;
}

// Convenience: given the current turn's usage and the caller-held lastHitRate,
// return { hitRate, text } when there IS cache data (caller must store hitRate
// for next turn's trend), or null when there is NO cache data (caller leaves its
// prior state untouched). `text` is null on the first observation or when the
// rate is at/above threshold; a warning string only when it should warn. Gate
// off / any error → null (byte-identical no-op fallback). Fully stateless.
function cacheWarningFor(input, env) {
  try {
    if (!cacheWarningEnabled(env || (typeof process !== 'undefined' ? process.env : {}))) return null;
    const hitRate = calculateCacheHitRate(input && input.usage);
    if (hitRate === null) return null; // no cache data → keep prior state
    const threshold = getCacheThreshold(env || (typeof process !== 'undefined' ? process.env : {}));
    const lastHitRate = _numOrNull(input && input.lastHitRate);
    if (lastHitRate === null) return { hitRate, text: null }; // first obs → seed only
    const { shouldWarn, trend } = evaluateCacheWarning({ hitRate, lastHitRate, threshold });
    return { hitRate, text: shouldWarn ? buildCacheWarningLine({ hitRate, threshold, trend }) : null };
  } catch {
    return null;
  }
}

// 缓存前缀击穿归因(承 constants/promptPrefixShape 叶子——此前零消费者)。给定本轮
// curShape(来自 result.prefixShape)与调用方持有的 prevShape,产出「这一轮为什么没命中」
// 的一行归因(系统提示 / 工具集 / 工具顺序变了)。首观(prevShape 空)或前缀未变 → text:null;
// 门控 KHY_CACHE_PREFIX_SHAPE 关 / 无 curShape / 任何错误 → null(逐字节 no-op 回退)。
// 纯无状态:调用方须把返回的 shape 存作下一轮 prevShape。
function prefixAttributionFor(input, env) {
  try {
    const pps = require('../constants/promptPrefixShape');
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (!pps.isPrefixShapeEnabled(e)) return null;
    const cur = input && input.curShape;
    if (!cur || typeof cur !== 'object') return null;
    const prev = input && input.prevShape ? input.prevShape : null;
    const cmp = pps.compareShape(prev, cur);
    const text = cmp && cmp.changed ? pps.describeReasons(cmp.reasons) : null;
    return { shape: cur, text: text || null };
  } catch {
    return null;
  }
}

module.exports = {
  cacheWarningEnabled,
  getCacheThreshold,
  calculateCacheHitRate,
  evaluateCacheWarning,
  buildCacheWarningLine,
  cacheWarningFor,
  prefixAttributionFor,
  // 会话累计命中率(承 KHY_CACHE_SESSION_AGGREGATE)
  sessionAggregateEnabled,
  accumulateSessionCache,
  aggregateCacheRate,
  buildSessionAggregateLine,
  sessionAggregateFor,
  DEFAULT_CACHE_THRESHOLD,
};
