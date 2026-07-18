'use strict';

/**
 * rateLimitRetry.js — 纯叶子:「限流(429)自动重试」的策略与文案单一真源。
 *
 * Goal(用户报 2026-07·对齐 Claude Code):一发请求就 429,khy 却只把
 * 「api [rate_limit]: recent rate_limit failure cached ... (cooldown 11s)」甩给用户 +
 * 「输入『继续』即可从断点续写」,逼用户**手动**一遍遍敲「继续」推进。CC 的做法是**自动**
 * 退避重试并在 scrollback 明文显示「Retrying… (attempt X/Y)」。本叶子补齐 khy 的等价物:
 * 限流类失败自动重试至多 N 轮(默认 10,对齐 CC 的观感),每轮明文告知「第 n/N 轮」与
 * 还要等多久,耗尽才回退到原来的「继续」提示。
 *
 * 关键区分(与 query/continuation.js 的自动续写 maxAutoResume 互补):
 *   - continuation 处理的是**可续接**(空响应/截断)——续写**未完成内容**;
 *   - 本叶子处理的是**限流被拒**——请求根本没发出去,要做的是**等冷却窗口过去再原样重发**。
 *     故必须尊重网关给出的 cooldown(否则重发只会再次命中缓存快速失败)。
 *
 * 设计同 retryCountdown.js / interruptHint.js:纯叶子、env 门控(默认开)、零 IO、绝不起
 * timer(逐秒 tick 的 setTimeout 循环留在 ai.js 壳里),只做「给定 errorType/轮次/剩余毫秒
 * → 该不该重试 + 产文案」的判定。门控关 → maxRounds=0 → 调用方逐字节回退到今日「手动继续」。
 */

const FLAG = 'KHY_RATE_LIMIT_AUTORETRY'; // 主闸:限流自动重试,默认开
const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 限流 / 过载类 errorType(值得等冷却后原样重发)。 */
const _RATE_LIMIT_TYPES = new Set(['rate_limit', 'ratelimit', 'overloaded', 'too_many_requests', '429']);

const DEFAULT_MAX_ROUNDS = 10;   // 对齐 CC 观感
const _HARD_CAP_ROUNDS = 20;     // 防误配无界烧 token
const DEFAULT_COOLDOWN_MS = 6000; // 结果里解析不到 cooldown 时的兜底退避
const _MIN_WAIT_MS = 1000;
const _MAX_WAIT_MS = 30000;      // 单轮等待上限,防某次 cooldown 异常大把用户锁死

/** env 门控惯例(同 retryCountdown):默认开,仅显式 0/false/off/no 关。 */
function isRateLimitAutoRetryEnabled(env = process.env) {
  const raw = env && env[FLAG];
  return !_FALSY.has(String(raw == null ? '' : raw).trim().toLowerCase());
}

/** 该 errorType 是否属限流/过载类。 */
function isRateLimitErrorType(errorType) {
  if (!errorType) return false;
  return _RATE_LIMIT_TYPES.has(String(errorType).trim().toLowerCase());
}

/**
 * 读取自动重试轮数上限。
 * - 门控关 → 0(调用方回退到手动「继续」)
 * - 未设置 → DEFAULT_MAX_ROUNDS
 * - 非法/负 → DEFAULT_MAX_ROUNDS;0 → 关闭自动重试(仍可手动继续)
 * - 钳到 _HARD_CAP_ROUNDS
 */
function maxRounds(env = process.env) {
  if (!isRateLimitAutoRetryEnabled(env)) return 0;
  const raw = env && env.KHY_RATE_LIMIT_MAX_ROUNDS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_ROUNDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_ROUNDS;
  return Math.min(Math.floor(n), _HARD_CAP_ROUNDS);
}

/**
 * 从失败结果里解析该等多久(ms):优先结构化 cooldownMs;否则从 content/error 文案里的
 * `(cooldown Ns)` 抠出秒数;都没有 → 指数退避兜底(按第几轮增长)。永远钳在 [1s, 30s]。
 * @param {object} result   网关失败结果 { content?, error?, cooldownMs?, errorType? }
 * @param {number} roundIndex 0-based:第几轮(用于兜底退避增长)
 * @returns {number} 等待毫秒
 */
function resolveCooldownMs(result, roundIndex = 0) {
  let ms = NaN;
  const structured = result && Number(result.cooldownMs);
  if (Number.isFinite(structured) && structured > 0) {
    ms = structured;
  } else {
    const text = String((result && (result.content || result.error)) || '');
    // 匹配 "(cooldown 11s)" / "cooldown 11 s" / "cooldown 11秒"。
    const m = text.match(/cooldown\s*(\d+(?:\.\d+)?)\s*(?:s|秒)/i);
    if (m) ms = Math.round(parseFloat(m[1]) * 1000);
  }
  if (!Number.isFinite(ms) || ms <= 0) {
    // 兜底:指数退避 base * 1.6^round,base=DEFAULT_COOLDOWN_MS。
    const exp = Math.min(4, Math.max(0, roundIndex));
    ms = Math.round(DEFAULT_COOLDOWN_MS * Math.pow(1.6, exp));
  }
  return Math.min(_MAX_WAIT_MS, Math.max(_MIN_WAIT_MS, ms));
}

/**
 * 是否应对这个失败结果发起(下一轮)限流自动重试。
 * @param {object} p { errorType, round, maxRounds, env }
 *   round=即将进行的轮次(1-based);maxRounds=上限(通常来自 maxRounds())。
 * @returns {boolean}
 */
function shouldAutoRetry({ errorType, round, maxRounds: cap, env } = {}) {
  if (!isRateLimitAutoRetryEnabled(env)) return false;
  if (!isRateLimitErrorType(errorType)) return false;
  const limit = Number.isFinite(cap) ? cap : maxRounds(env);
  const r = Number(round);
  return limit > 0 && Number.isFinite(r) && r >= 1 && r <= limit;
}

/**
 * 构造限流重试等待期的状态行文案(明文「第 n/N 轮」+ 剩余秒数,对齐 CC「Retrying… (X/Y)」)。
 * @param {object} p { round, maxRounds, remainingMs, env }
 * @returns {string}
 */
function buildRetryStatusMessage({ round, maxRounds: cap, remainingMs, env } = {}) {
  const r = Number(round) || 1;
  const total = Number(cap) || maxRounds(env);
  const rem = Number(remainingMs);
  const safeRem = Number.isFinite(rem) ? rem : 0;
  if (safeRem > 0) {
    const sec = Math.max(1, Math.ceil(safeRem / 1000));
    return `API 限流(429),${sec} 秒后自动重试（第 ${r}/${total} 轮）`;
  }
  return `API 限流(429),正在自动重试（第 ${r}/${total} 轮）...`;
}

/** 自动重试全部耗尽、仍限流时,回给用户的一句话(告知已自动重试过、可稍后手动继续)。 */
function buildExhaustedNote(total = DEFAULT_MAX_ROUNDS) {
  const n = Number(total) || DEFAULT_MAX_ROUNDS;
  return `已自动重试 ${n} 轮仍被限流(429)。上游额度可能仍未恢复——可稍后说「继续」再试,或更换模型通道 / 降低请求频率。`;
}

const TICK_MS = 1000;

module.exports = {
  FLAG,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_COOLDOWN_MS,
  TICK_MS,
  isRateLimitAutoRetryEnabled,
  isRateLimitErrorType,
  maxRounds,
  resolveCooldownMs,
  shouldAutoRetry,
  buildRetryStatusMessage,
  buildExhaustedNote,
};
