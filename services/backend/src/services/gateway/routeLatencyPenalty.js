'use strict';

/**
 * routeLatencyPenalty.js — 纯叶子:零 IO / 确定性 / 绝不抛 / 门控默认开。
 *
 * 背景:默认路由罚分器 `_assessDefaultRouteCandidate`(aiGateway.js)对「延迟」一无所知——
 * 两个都健康(penalty 0)的通道,一个首字 800ms、一个 6s,排名完全等价。慢通道对路由不可
 * 见,除非开默认关闭的 UCB 路由。本叶子把「某通道近期延迟统计」转成「一笔**有界软罚分** +
 * 一句人读理由」,让健康但慢的通道在**健康集内部**轻度降权破平局。
 *
 * 设计红线(慢 ≠ 不可用):
 *   - 罚分**硬顶在 ceiling-1**(ceiling = healthyPenaltyCeiling)——单凭延迟**永不**把通道
 *     踢出健康集、**永不** blocked;慢通道仍是合法兜底。
 *   - 冷启动不误伤:samples < MIN_SAMPLES → insufficient_data → 零罚分。
 *   - 陈旧不误伤:ageMs 超 STALE_MS → 视为样本不足 → 零罚分(通道可能已恢复)。
 *
 * 单一真源:
 *   - classifyLatency({ ewmaMs, samples, ageMs }, env) → fast/typical/slow/very_slow/
 *     insufficient_data(只读统计,绝不抛)。
 *   - latencyPenalty({ ewmaMs, samples, ageMs, ceiling }, env) → 有界罚分整数(0 = 不降权)。
 *   - buildLatencyReason(stats, { ceiling, env }) → { code, penalty, text } 供 reasons.push;
 *     penalty 0 → 返回 null(调用方不 push)。
 *
 * 门控 KHY_ROUTE_LATENCY_AWARE(默认开;flagRegistry 优先,注册表不可用 → 本地 CANON 回退)。
 * 取 0/false/off/no 关闭 → 罚分恒 0 / 理由恒 null,默认路由排名逐字节回退今天。
 * env 经参数注入可测。纯叶子:无外部 IO、不读时钟、无副作用、异常一律回退安全值(0/null)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控 KHY_ROUTE_LATENCY_AWARE 是否启用。flagRegistry 优先,失败 → 本地 CANON 回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isRouteLatencyAwareEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_ROUTE_LATENCY_AWARE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e && e.KHY_ROUTE_LATENCY_AWARE;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 可调参数(env 覆盖、有界、缺省即安全值) ──────────────────────────────────
// 每个都经严格解析:非有限/越界 → 缺省。绝不因坏 env 抛。

function _envIntBounded(env, name, fallback, min, max) {
  try {
    const raw = env && env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  } catch {
    return fallback;
  }
}

function _envFloatBounded(env, name, fallback, min, max) {
  try {
    const raw = env && env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  } catch {
    return fallback;
  }
}

function _tuning(env) {
  const e = env || {};
  return {
    // 判罚前的最小样本量:低于此视为冷启动,不判罚。
    minSamples: _envIntBounded(e, 'KHY_ROUTE_LATENCY_MIN_SAMPLES', 3, 1, 1000),
    // 延迟分档阈值(ms,EWMA)。fast < FAST ≤ typical < SLOW ≤ slow < VERY_SLOW ≤ very_slow。
    fastMs: _envIntBounded(e, 'KHY_ROUTE_LATENCY_FAST_MS', 1500, 100, 600000),
    slowMs: _envIntBounded(e, 'KHY_ROUTE_LATENCY_SLOW_MS', 4000, 100, 600000),
    verySlowMs: _envIntBounded(e, 'KHY_ROUTE_LATENCY_VERY_SLOW_MS', 9000, 100, 600000),
    // 陈旧阈值:近期没测到(ageMs 超此)→ 视为样本不足,不判罚。默认 30min。
    staleMs: _envIntBounded(e, 'KHY_ROUTE_LATENCY_STALE_MS', 1800000, 10000, 86400000),
    // 各档罚分(整数)。硬顶由 ceiling 在 latencyPenalty 里施加。
    slowPenalty: _envIntBounded(e, 'KHY_ROUTE_LATENCY_SLOW_PENALTY', 12, 0, 1000),
    verySlowPenalty: _envIntBounded(e, 'KHY_ROUTE_LATENCY_VERY_SLOW_PENALTY', 22, 0, 1000),
  };
}

/**
 * 把一份延迟统计归档。只读统计,绝不抛。
 * @param {object} stats { ewmaMs, samples, ageMs }
 * @param {object} [env]
 * @returns {'fast'|'typical'|'slow'|'very_slow'|'insufficient_data'}
 */
function classifyLatency(stats, env = process.env) {
  try {
    const s = stats && typeof stats === 'object' ? stats : {};
    const t = _tuning(env);
    const samples = Number(s.samples);
    const ewmaMs = Number(s.ewmaMs);
    const ageMs = Number(s.ageMs);
    // 样本不足 / 无有效 EWMA / 陈旧 → 不判罚。
    if (!Number.isFinite(samples) || samples < t.minSamples) return 'insufficient_data';
    if (!Number.isFinite(ewmaMs) || ewmaMs <= 0) return 'insufficient_data';
    if (Number.isFinite(ageMs) && ageMs > t.staleMs) return 'insufficient_data';
    // 保证阈值单调(坏 env 可能给出乱序)——按升序取有效边界。
    const fast = t.fastMs;
    const slow = Math.max(t.slowMs, fast);
    const verySlow = Math.max(t.verySlowMs, slow);
    if (ewmaMs < fast) return 'fast';
    if (ewmaMs < slow) return 'typical';
    if (ewmaMs < verySlow) return 'slow';
    return 'very_slow';
  } catch {
    return 'insufficient_data';
  }
}

/**
 * 有界延迟罚分。fast/typical/insufficient → 0;slow/very_slow → 对应罚分,但硬顶在
 * ceiling-1(保证延迟单独一笔永远不足以把健康通道踢出健康集)。绝不抛。
 * @param {object} stats { ewmaMs, samples, ageMs, ceiling }
 * @param {object} [env]
 * @returns {number} 非负整数罚分(0 = 不降权)
 */
function latencyPenalty(stats, env = process.env) {
  try {
    if (!isRouteLatencyAwareEnabled(env)) return 0;
    const s = stats && typeof stats === 'object' ? stats : {};
    const t = _tuning(env);
    const verdict = classifyLatency(s, env);
    let penalty = 0;
    if (verdict === 'slow') penalty = t.slowPenalty;
    else if (verdict === 'very_slow') penalty = t.verySlowPenalty;
    if (penalty <= 0) return 0;
    // 硬顶:ceiling-1。ceiling 非有限正数 → 不施加额外顶(仅用各档罚分)。
    const ceiling = Number(s.ceiling);
    if (Number.isFinite(ceiling) && ceiling > 0) {
      const cap = Math.max(0, Math.floor(ceiling) - 1);
      penalty = Math.min(penalty, cap);
    }
    return penalty > 0 ? penalty : 0;
  } catch {
    return 0;
  }
}

// 档位 → 中文形容(供理由文案)。
const _VERDICT_LABEL = Object.freeze({ slow: '较慢', very_slow: '很慢' });

function _formatMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '未知';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}

/**
 * 为 `_assessDefaultRouteCandidate` 产一条 reasons 条目。penalty 0 → 返回 null(不 push)。绝不抛。
 * @param {object} stats { ewmaMs, samples, ageMs }
 * @param {object} [opts] { ceiling, env }
 * @returns {{code:string, penalty:number, text:string}|null}
 */
function buildLatencyReason(stats, opts = {}) {
  try {
    const env = (opts && opts.env) || process.env;
    const ceiling = opts && opts.ceiling;
    const s = stats && typeof stats === 'object' ? { ...stats } : {};
    if (ceiling !== undefined) s.ceiling = ceiling;
    const penalty = latencyPenalty(s, env);
    if (penalty <= 0) return null;
    const verdict = classifyLatency(s, env);
    const label = _VERDICT_LABEL[verdict] || '较慢';
    return {
      code: 'slow_latency',
      penalty,
      text: `近期平均响应延迟 ${_formatMs(s.ewmaMs)}（${label}），默认路由轻度降权`,
    };
  } catch {
    return null;
  }
}

module.exports = {
  isRouteLatencyAwareEnabled,
  classifyLatency,
  latencyPenalty,
  buildLatencyReason,
  _tuning,
};
