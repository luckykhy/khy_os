'use strict';

/**
 * memoryWriteSafety —— 纯叶子 (pure leaf):记忆文件写入的「重试 / 校验」确定性决策器。
 *
 * 契约 (CONTRACT):零 IO(真正的 fs.writeFileSync / renameSync / readFileSync 留在调用方
 *   memdir.js 的 _safeWriteFileSync;本叶子只做纯数值/字符串/错误码判定)、确定性、绝不抛、
 *   单一真源(重试次数 / 可重试错误码 / 退避时长 / 校验开关的判定只在本文件)、
 *   env 门控默认开(`KHY_MEMORY_WRITE_SAFETY`,仅 {0,false,off,no} 关闭,关闭即字节回退
 *   到既有「裸 fs.writeFileSync」行为)。fail-soft:入参非法一律回退安全默认。
 *
 * 背景(经源码核实):memdir.saveMemory / updateMemoryIndex / _removeFromIndex 此前都是
 *   未加保护的 `fs.writeFileSync`——写一半被打断会留下半截文件,瞬时 fs 错误(EAGAIN/EBUSY
 *   /EMFILE …)直接抛给调用方而无重试。本叶子把「该不该重试、退避多久、要不要读回校验」固化
 *   成可单测的纯规则,IO 层据此做 temp+rename 原子写 + 读回校验 + 有界重试。
 *
 * 为什么判断要收进纯叶子:写安全的脚枪是「无限重试」与「对永久错误(EACCES/ENOSPC/EROFS)
 *   白白重试」。把可重试错误码白名单与重试上界固化在这里,IO 层就不会自己拍脑袋决定重试策略。
 */

/** 默认值(均可经 env 覆盖,再经夹取)。 */
const DEFAULTS = Object.freeze({
  maxAttempts: 3,      // 写入尝试总次数(含首次),硬上界防无限重试
  backoffBaseMs: 25,   // 第 n 次重试前的退避基数(线性 n*base)
  verify: true,        // 写后读回比对内容是否一致
});

/** 瞬时(值得重试)的 fs 错误码。永久错误(EACCES/ENOSPC/EROFS/ENOENT…)不在此列,不重试。 */
const TRANSIENT_CODES = Object.freeze(new Set([
  'EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'EINTR', 'ETIMEDOUT', 'EPERM', 'EEXIST',
]));

/** 是否启用写安全(门控关 → 字节回退到裸写)。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_MEMORY_WRITE_SAFETY) != null ? env.KHY_MEMORY_WRITE_SAFETY : '')
    .trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** 整数夹取:非有限数 → fallback,再夹到 [lo, hi] 并取整。委托单一真源 utils/clampInt。 */
const _clampInt = require('../utils/clampInt');

/** 读 env 数字(缺失/非法 → undefined,交后续夹取用默认)。委托单一真源 utils/envNum。 */
const _envNum = require('../utils/envNum');

/**
 * 产出一份确定性的写入计划。门控关 → `{enabled:false}`,IO 层据此走裸写回退。
 * @param {Object} [env]
 * @returns {{enabled:boolean, maxAttempts:number, backoffBaseMs:number, verify:boolean}}
 */
function planWrite(env = (typeof process !== 'undefined' ? process.env : {})) {
  const e = env && typeof env === 'object' ? env : {};
  if (!isEnabled(e)) {
    return { enabled: false, maxAttempts: 1, backoffBaseMs: 0, verify: false };
  }
  const maxAttempts = _clampInt(
    _envNum(e, 'KHY_MEMORY_WRITE_RETRIES'), 1, 10, DEFAULTS.maxAttempts,
  );
  const backoffBaseMs = _clampInt(
    _envNum(e, 'KHY_MEMORY_WRITE_BACKOFF_MS'), 0, 5000, DEFAULTS.backoffBaseMs,
  );
  const verifyRaw = String((e.KHY_MEMORY_WRITE_VERIFY) != null ? e.KHY_MEMORY_WRITE_VERIFY : '')
    .trim().toLowerCase();
  const verify = !['0', 'false', 'off', 'no'].includes(verifyRaw); // 默认开
  return { enabled: true, maxAttempts, backoffBaseMs, verify };
}

/**
 * 给定本次错误码与已用尝试次数,是否还应再试。
 * @param {string} code        fs 错误码(err.code),可空
 * @param {number} attempt     已完成的尝试次数(从 1 起)
 * @param {number} maxAttempts 计划允许的总次数
 * @returns {boolean}
 */
function shouldRetry(code, attempt, maxAttempts) {
  const a = Number(attempt) || 0;
  const max = Number(maxAttempts) || DEFAULTS.maxAttempts;
  if (a >= max) return false;                 // 达上界:绝不再试(防无限重试)
  return TRANSIENT_CODES.has(String(code || '').toUpperCase());
}

/**
 * 第 attempt 次失败后、下一次重试前的退避毫秒(线性、确定性、无随机)。
 * @returns {number}
 */
function backoffMs(attempt, backoffBaseMs = DEFAULTS.backoffBaseMs) {
  const a = Number(attempt) || 1;
  const base = Number.isFinite(Number(backoffBaseMs)) ? Number(backoffBaseMs) : DEFAULTS.backoffBaseMs;
  if (base <= 0) return 0;
  const ms = a * base;
  return ms > 5000 ? 5000 : ms;               // 退避也封顶,避免长阻塞
}

/**
 * 读回校验:写入内容与期望内容是否逐字节一致。
 * @returns {boolean}
 */
function verifyMatches(written, expected) {
  return String(written == null ? '' : written) === String(expected == null ? '' : expected);
}

module.exports = {
  DEFAULTS,
  TRANSIENT_CODES,
  isEnabled,
  planWrite,
  shouldRetry,
  backoffMs,
  verifyMatches,
};
