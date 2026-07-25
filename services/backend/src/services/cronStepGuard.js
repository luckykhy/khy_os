'use strict';

/**
 * cronStepGuard.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 services/cronScheduler._parseCronField 的「零步长死循环」缺陷(:89/:102):
 *   const step = parseInt(stepStr, 10);           // 可为 0
 *   ...
 *   for (let i = start; i <= end; i += step) values.add(i);   // step===0 → 永不前进,死循环
 * 步长解析后**无 `step > 0` 校验**。cron 字段 `星号/0`、`5/0`、`5-10/0` 均解出 `step=0`,循环永不
 * 推进 → 100% CPU 挂死。matchesCron 每次调度 tick 都对存储的 job 表达式跑一遍,单条畸形 cron 串
 * (用户或 API 注册的 job)即可永久卡死整个调度器;而死循环从不抛异常,调用方 try/catch 救不了。
 *
 * 本叶子把「步长是否可用」的判定收成单一真源:
 *   - cronStepUsable(step, env):
 *       门开 → 合法(整数且 >0)返 true;非法(≤0 / 非整数 / NaN)返 false → 调用方 `continue` 跳过该
 *         字段部件(畸形 cron 视为不匹配,拒绝而非挂死);
 *       门关 / 异常 → 返回 null(调用方逐字节回退到 legacy:不校验直接跑循环,保留原死循环写法)。
 *
 * 门控 KHY_CRON_STEP_GUARD(默认开;0/false/off/no 关 → null 回退)。
 * flagRegistry 优先,失败回退本地 CANON;绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控 KHY_CRON_STEP_GUARD:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function cronStepGuardEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_CRON_STEP_GUARD', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_CRON_STEP_GUARD;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 判定一个 cron 步长是否可安全用于 `for(i=start;i<=end;i+=step)`。
 * @param {number} step
 * @param {Record<string,string>} [env]
 * @returns {boolean|null} 门开→true(合法整数>0)/false(≤0 或非整数);门关/异常→null(调用方 legacy)
 */
function cronStepUsable(step, env = process.env) {
  try {
    if (!cronStepGuardEnabled(env)) return null;
    return Number.isInteger(step) && step > 0;
  } catch {
    return null;
  }
}

module.exports = {
  cronStepGuardEnabled,
  cronStepUsable,
};
