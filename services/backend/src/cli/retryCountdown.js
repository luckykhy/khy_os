'use strict';

/**
 * retryCountdown.js — 纯叶子:网关稳定性重试「等待期状态行」文案的单一真源。
 *
 * Goal(对齐 Claude Code):CC 在 API/网关瞬时失败后做退避重试时,于 scrollback 里显示一条
 * **逐秒递减的倒计时**「Retrying in N seconds… (attempt X/Y)」
 * (src/components/messages/SystemAPIErrorMessage.tsx:29-52,`useInterval` 每秒把
 * `countdownMs` 递减,算出 `retryInSecondsLive` 并区分 second/seconds 单复数)。让用户在等待
 * 退避的这几秒里**看得见还要等多久、这是第几次重试**。
 *
 * Khy 此前:退避延迟 `waitMs` 与「第 n/m 次」其实**都已算出**(ai.js:3835 `_resolveGatewayRecoveryDelayMs`
 * 退避 ~1.2s→~6s,attempt 计数在循环里),却只推一条**静态**状态
 * 「网关连接波动（type），正在进行稳定性重试 n/m...」然后 `await setTimeout(waitMs)` 盲等——
 * 用户看不到剩余秒数,盯着不动的字以为卡死。本叶子补上「还剩几秒」的倒计时文案判定。
 *
 * 关键 LOGIC(比 CC 更简、且尊重 khy 中文口径):
 *   - 中文「秒」无单复数,故不需要 CC 的 second/seconds 复数分支(比 CC 少一层)。
 *   - 剩余 >0:显示 `${sec} 秒后重试（第 attempt/max 次）`,sec=ceil(remainingMs/1000) 语义为
 *     「至少还要等 N 秒」,逐秒 2→1 递减。
 *   - 剩余 <=0(退避已到、马上真正发起重试):显示 `正在重试（第 attempt/max 次）...`。
 *   - **门控关 / 任何异常 → 逐字节回退 legacy 静态串**(与今日行为完全一致),故 call-site 可无脑
 *     调本叶子:开=倒计时,关=原样。
 *
 * 设计同 interruptHint.js / rewindControl.js:纯叶子、env 门控(默认开)、零 IO、绝不发起
 * timer/React(逐秒 tick 的 setTimeout 循环留在 ai.js 壳里),只做「给定剩余毫秒→产文案」的判定。
 */

const FLAG = 'KHY_RETRY_COUNTDOWN'; // 主闸:网关重试等待期显示逐秒倒计时,默认开

/** env 门控惯例(同 interruptHint.isInterruptHintEnabled):默认开,仅显式 0/false/off/no 关。 */
function isRetryCountdownEnabled(env = process.env) {
  const raw = env && env[FLAG];
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * legacy 静态状态串(与 ai.js 迁移前逐字一致,作为门控关/异常时的回退)。
 * @param {string} errType   网关错误分类(gatewayErrType)
 * @param {number} attempt   本次是第几次重试(1-based)
 * @param {number} maxAttempts 总重试次数
 */
function buildLegacyRetryStatus(errType, attempt, maxAttempts) {
  return `网关连接波动（${errType}），正在进行稳定性重试 ${attempt}/${maxAttempts}...`;
}

/**
 * 构造这一帧的重试等待状态文案。
 *
 * @param {object} p
 * @param {string} p.errType       网关错误分类
 * @param {number} p.attempt       第几次重试(1-based)
 * @param {number} p.maxAttempts   总重试次数
 * @param {number} p.remainingMs   距离本次退避结束还剩多少毫秒(<=0 表示即将真正发起重试)
 * @param {object} [env]
 * @returns {string} 状态行文案(门控关/异常时为 legacy 静态串)
 */
function buildRetryStatusMessage(p = {}, env = process.env) {
  const errType = p && p.errType != null ? String(p.errType) : 'unknown';
  const attempt = Number(p && p.attempt) || 1;
  const maxAttempts = Number(p && p.maxAttempts) || 1;
  try {
    if (!isRetryCountdownEnabled(env)) {
      return buildLegacyRetryStatus(errType, attempt, maxAttempts);
    }
    const remainingMs = Number(p && p.remainingMs);
    const safeRemaining = Number.isFinite(remainingMs) ? remainingMs : 0;
    if (safeRemaining > 0) {
      const sec = Math.max(1, Math.ceil(safeRemaining / 1000));
      return `网关连接波动（${errType}），${sec} 秒后重试（第 ${attempt}/${maxAttempts} 次）`;
    }
    return `网关连接波动（${errType}），正在重试（第 ${attempt}/${maxAttempts} 次）...`;
  } catch {
    return buildLegacyRetryStatus(errType, attempt, maxAttempts);
  }
}

/** 逐秒 tick 的建议间隔(ms);实际 setTimeout 循环在 ai.js 壳里,叶子只暴露常量。 */
const TICK_MS = 1000;

module.exports = {
  isRetryCountdownEnabled,
  buildRetryStatusMessage,
  buildLegacyRetryStatus,
  TICK_MS,
};
