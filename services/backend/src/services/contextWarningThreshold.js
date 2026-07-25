'use strict';

/**
 * contextWarningThreshold.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 cli/contextWarning.calculateTokenWarningState 的「告警带阈值下溢」缺陷(:112-116):
 *   const warningThreshold = threshold - WARNING_BUFFER_TOKENS;   // buffer = 20000
 *   const isAboveWarningThreshold = threshold > 0 && tokenUsage >= warningThreshold;
 * 当上下文窗口较小(小型本地模型 8k/16k/24k,或 KHY_CONTEXT_WINDOW 设小值)时,
 * `threshold = ratio*window`(如 0.8*16000=12800)**小于 buffer(20000)** → `threshold - buffer`
 * 变负(12800-20000=-7200)→ `tokenUsage >= -7200` 对任何 usage(含 0)恒真 → 从 **token 0** 起就
 * 判「已入告警带」→ buildContextWarning 显示「100% until auto-compact」(100% 剩余却报告警,自相矛盾)。
 * 恰违背该文件头声明的 CC「don't nag early」意图(不在首个 token 就唠叨)。
 *
 * 正确语义:告警带定义为「距 threshold 不足 buffer」。仅当窗口大到能容纳 buffer(threshold > buffer)
 * 该定义才成立;窗口装不下 buffer 时不存在「提前」区,应只在**真正抵达 threshold**(0% 时刻,即
 * 真实 compaction 点)才告警,而非从 0 起唠叨。故:
 *   guarded = (threshold > buffer) ? (threshold - buffer) : threshold
 * 正常(生产 200k)窗口 threshold ≫ buffer → 恒走 `threshold - buffer` 分支 → **逐字节等价 legacy**;
 * 仅小窗口从「从 0 唠叨」收敛为「抵达 threshold 才告警」。
 *
 * 门控 KHY_CONTEXT_WARNING_THRESHOLD_GUARD(默认开):关(0/false/off/no)/异常/threshold 或 buffer
 * 非有限数 → 返回 null,调用方回退 legacy `threshold - buffer`(逐字节等价)。flagRegistry 优先,
 * 失败回退本地 CANON;绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控 KHY_CONTEXT_WARNING_THRESHOLD_GUARD:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function contextWarningThresholdGuardEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_CONTEXT_WARNING_THRESHOLD_GUARD', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_CONTEXT_WARNING_THRESHOLD_GUARD;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 返回告警带阈值(带下溢守卫):
 *   - 门关 / 异常 / threshold|buffer 非有限数 → null(调用方回退 legacy `threshold - buffer`);
 *   - 门开 → `threshold > buffer ? threshold - buffer : threshold`。
 * @param {number} threshold  compaction 阈值(ratio * window,或 effectiveWindow)
 * @param {number} buffer     告警/错误 buffer 常量(20000)
 * @param {Record<string,string>} [env]
 * @returns {number|null}
 */
function guardBandThreshold(threshold, buffer, env = process.env) {
  try {
    if (!contextWarningThresholdGuardEnabled(env)) return null;
    const t = Number(threshold);
    const b = Number(buffer);
    if (!Number.isFinite(t) || !Number.isFinite(b)) return null;
    return t > b ? t - b : t;
  } catch {
    return null;
  }
}

module.exports = {
  contextWarningThresholdGuardEnabled,
  guardBandThreshold,
};
