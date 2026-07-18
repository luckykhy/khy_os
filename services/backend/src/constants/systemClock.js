'use strict';

/**
 * systemClock.js — 纯叶子:把「系统时间」注入系统提示词的单一真源(零 IO、确定性、
 * env 门控、绝不抛、可单测)。
 *
 * 背景(goal「我希望 Khyos 中有系统时间的概念,不要把时间丢弃了」):历史上
 * getEnvironmentSection 计算了 `new Date()` 却只发出 ` - Current date: YYYY-MM-DD`,
 * 把当天的**时刻、时区、星期**统统丢弃 —— 模型只知道日期,不知道现在几点、在哪个时区。
 * 本叶子把「当前时刻」的完整信息(日期 + 星期 + 时刻 + UTC 偏移 + IANA 时区 + ISO 8601)
 * 规范化成若干 ` - key: value` 行,交由调用方(prompts.js 的 getEnvironmentSection)拼进
 * # Environment 区块;并提供 clockCacheKey 让缓存按时间桶刷新,避免时刻被会话级缓存冻结。
 *
 * 契约:零 IO(只用全局 Date / Intl,不 require fs/net/子进程);确定性(注入 now/
 * offsetMinutes/timeZone 即可在任意宿主时区下产出同一结果);绝不抛(坏输入 → 回退)。
 *
 * 门控 KHY_SYSTEM_CLOCK(默认开,仅显式 0/false/off/no 关闭):关闭后
 * formatSystemClockLines 逐字节回退到历史单行 ` - Current date: YYYY-MM-DD`,
 * clockCacheKey 返回 '' → 上游 cacheKey 保持 `${model}|${cwd}` 不变(字节回退)。
 * 桶粒度门控 KHY_SYSTEM_CLOCK_BUCKET_SECONDS(默认 60,clamp [1, 86400])。
 *
 * @module constants/systemClock
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_SYSTEM_CLOCK 默认开,仅显式 0/false/off/no 关闭。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_SYSTEM_CLOCK;
  return !(v !== undefined && _OFF.has(String(v).trim().toLowerCase()));
}

/** 解析时间桶秒数(缓存刷新粒度):KHY_SYSTEM_CLOCK_BUCKET_SECONDS,默认 60,clamp [1, 86400]。 */
function _bucketSeconds(env) {
  const raw = (env || process.env || {}).KHY_SYSTEM_CLOCK_BUCKET_SECONDS;
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  if (Number.isFinite(n) && n >= 1) return Math.min(n, 86400);
  return 60;
}

function _pad2(n) { return String(n).padStart(2, '0'); }

const _WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 有效 Date 或回退到「现在」。 */
function _resolveNow(now) {
  return (now instanceof Date && !Number.isNaN(now.getTime())) ? now : new Date();
}

/**
 * 分钟为单位的「UTC 以东偏移」(UTC+8 → +480)。优先用注入值(测试确定性),
 * 否则从 Date 派生(getTimezoneOffset 返回「本地落后 UTC 的分钟数」,取负即以东偏移)。
 */
function _resolveOffsetMinutes(now, offsetMinutes) {
  if (Number.isFinite(offsetMinutes)) return offsetMinutes;
  try { return -now.getTimezoneOffset(); } catch { return 0; }
}

/**
 * IANA 时区名(best-effort)。显式传入字符串(含空串)→ 原样采用(空串 = 省略时区,
 * 便于单测确定性);未传(undefined)→ Intl 解析,失败 → ''。
 */
function _resolveTimeZone(timeZone) {
  if (typeof timeZone === 'string') return timeZone;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' ? tz : '';
  } catch { return ''; }
}

/** 历史单行(门控关时逐字节回退):` - Current date: YYYY-MM-DD`(本地日期)。 */
function legacyDateLine(now) {
  const d = _resolveNow(now);
  const s = `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
  return ` - Current date: ${s}`;
}

/**
 * 富时间行数组(拼进 # Environment)。门控关 → 历史单行数组(字节回退)。
 *
 * 用「偏移平移 + UTC getter」而非本地 getter,使给定 (epoch, offsetMinutes) 时输出与宿主
 * 时区无关 → 单测确定性。
 *
 * @param {object} [args]
 * @param {Date}   [args.now]           当前时刻(默认 new Date())
 * @param {object} [args.env]           环境变量(门控)
 * @param {number} [args.offsetMinutes] 以东偏移分钟(测试注入;默认由 now 派生)
 * @param {string} [args.timeZone]      IANA 时区名(测试注入;默认 Intl 派生)
 * @returns {string[]}
 */
function formatSystemClockLines({ now, env, offsetMinutes, timeZone } = {}) {
  const d = _resolveNow(now);
  if (!isEnabled(env)) return [legacyDateLine(d)];

  const off = _resolveOffsetMinutes(d, offsetMinutes);
  // 平移时间戳,使 UTC getter 读出「本地墙钟」——与宿主时区解耦。
  const local = new Date(d.getTime() + off * 60000);
  const Y = local.getUTCFullYear();
  const Mo = _pad2(local.getUTCMonth() + 1);
  const Da = _pad2(local.getUTCDate());
  const H = _pad2(local.getUTCHours());
  const Mi = _pad2(local.getUTCMinutes());
  const S = _pad2(local.getUTCSeconds());
  const weekday = _WEEKDAYS[local.getUTCDay()] || '';

  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const offH = _pad2(Math.floor(abs / 60));
  const offM = _pad2(abs % 60);
  const offsetStr = `UTC${sign}${offH}:${offM}`;
  const iso = `${Y}-${Mo}-${Da}T${H}:${Mi}:${S}${sign}${offH}:${offM}`;
  const tz = _resolveTimeZone(timeZone);

  const timeLine = tz
    ? ` - Current time: ${H}:${Mi}:${S} (${offsetStr}, ${tz})`
    : ` - Current time: ${H}:${Mi}:${S} (${offsetStr})`;

  return [
    ` - Current date: ${Y}-${Mo}-${Da} (${weekday})`,
    timeLine,
    ` - Current timestamp (ISO 8601): ${iso}`,
  ];
}

/**
 * 缓存键(时间桶)。门控关 → ''(上游据此保持旧 cacheKey 不变 = 字节回退)。
 * 门控开 → `t<floor(epochSeconds / bucketSeconds)>`,使被缓存的 env 区块每桶刷新一次,
 * 避免注入的时刻被会话级缓存冻结在会话开始时。
 */
function clockCacheKey({ now, env } = {}) {
  if (!isEnabled(env)) return '';
  const d = _resolveNow(now);
  const bucket = _bucketSeconds(env);
  return `t${Math.floor(d.getTime() / 1000 / bucket)}`;
}

module.exports = {
  isEnabled,
  legacyDateLine,
  formatSystemClockLines,
  clockCacheKey,
};
