'use strict';

/**
 * failureReasonRanking — 纯叶子:为「真实失败原因」清单排序,让**本轮新鲜的 live 失败**
 * 排在**陈旧的缓存跳过**之前,避免旧缓存盖过新鲜真相。
 *
 * 背景(用户实测):同一次识图请求里,主视觉通道本轮 live 撞 `HTTP 429 code=1305`
 * (「该模型当前访问量过大」,瞬时限流),但「真实失败原因」却报 238s 前缓存的
 * `404 model_not_found (cooldown 238s)` —— 陈旧缓存跳过被 push 在前,盖过了本轮的 429,
 * 误导用户以为「模型不存在」,实则只是被限流、稍后自愈。
 *
 * 判定信号(确定性、无需时钟):
 *   - 缓存跳过 attempt 由 inspectCachedFastFail 产出,恒带 `virtualSkip:true`、`statusCode:0`,
 *     且 error 文本形如 `recent <type> failure cached: … (cooldown Ns)`。
 *   - live 失败带**真实 statusCode**(429/404/…)且**非 virtualSkip**。
 * `virtualSkip` 已是全仓公认「非真实尝试」标记(健康计数 incrFailure 已 `.filter(!virtualSkip)`),
 * 此叶子把同一语义引入**展示层排序**:live 优先,缓存靠后,同类保持原相对顺序(稳定分区)。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读 env 门控;不碰 fs / 网络 / 子进程 / 时钟 / 随机)。
 *   - 确定性:同输入恒同输出(稳定分区,不重排同组内元素)。
 *   - 绝不抛:任何异常路径返回安全值(原数组浅拷贝 / 原样)。
 *   - 门控 KHY_FAILURE_REASON_RANKING 默认开;关 → rankFailedAttempts 原样返回(逐字节回退今日插入序)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

/**
 * 门控 KHY_FAILURE_REASON_RANKING 是否启用。flagRegistry 优先(集中真源),
 * 失败/不可用再退本地 CANON 解析。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_FAILURE_REASON_RANKING', env || process.env);
  } catch { /* fall through to local */ }
  try {
    const raw = (env || process.env).KHY_FAILURE_REASON_RANKING;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

// 缓存跳过的 error 文本特征:inspectCachedFastFail 恒以 `recent … failure cached` 开头。
const _CACHED_SKIP_RE = /recent\s+\S+\s+failure\s+cached/i;

/**
 * 判定一个失败 attempt 是否为「陈旧缓存跳过」(非本轮真实 live 尝试)。
 * 判定优先级:显式 virtualSkip 标记 > statusCode===0 且文本命中 cached 特征。
 * 绝不抛;无法判定按「非缓存」(live)处理,保守偏向展示真实尝试。
 * @param {object} attempt
 * @returns {boolean}
 */
function isCachedSkip(attempt) {
  try {
    if (!attempt || typeof attempt !== 'object') return false;
    if (attempt.virtualSkip === true) return true;
    // 兜底:未带 virtualSkip 但 statusCode 缺省(0/空)且文本是缓存跳过口吻。
    const status = Number(attempt.statusCode || attempt.status || attempt.code || 0);
    if (status > 0) return false; // 有真实 HTTP 码 → 一定是 live 失败
    const text = String(attempt.error || attempt.message || '');
    return _CACHED_SKIP_RE.test(text);
  } catch {
    return false;
  }
}

/**
 * 稳定分区排序:live 失败在前、缓存跳过在后,组内保持原相对顺序。
 * 门关 / 坏输入 → 原样返回(逐字节回退)。绝不抛,绝不 mutate 入参。
 * @param {Array} attempts 失败 attempt 列表(调用方已 filter success===false)
 * @param {object} [env]
 * @returns {Array} 重排后的**新数组**(或原数组的安全回退)
 */
function rankFailedAttempts(attempts, env = process.env) {
  try {
    if (!Array.isArray(attempts) || attempts.length < 2) {
      return Array.isArray(attempts) ? attempts.slice() : [];
    }
    if (!isEnabled(env)) return attempts.slice();
    const live = [];
    const cached = [];
    for (const a of attempts) {
      if (isCachedSkip(a)) cached.push(a);
      else live.push(a);
    }
    // 稳定:两组各自维持原插入序,拼接。同组不重排。
    return live.concat(cached);
  } catch {
    return Array.isArray(attempts) ? attempts.slice() : [];
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeFailureReasonRanking() {
  return {
    gate: 'KHY_FAILURE_REASON_RANKING',
    defaultOn: true,
    summary: '「真实失败原因」清单排序:本轮新鲜 live 失败(带真实 HTTP 状态码、非 virtualSkip)'
      + '排在陈旧缓存跳过(virtualSkip / `recent … failure cached (cooldown Ns)`)之前,'
      + '避免 238s 前缓存的 404 盖过本轮真实的 429;稳定分区,组内保持原序;'
      + '门控关则逐字节回退今日插入序。',
  };
}

module.exports = {
  isEnabled,
  isCachedSkip,
  rankFailedAttempts,
  describeFailureReasonRanking,
};
