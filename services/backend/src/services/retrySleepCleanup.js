'use strict';

/**
 * retrySleepCleanup.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 services/retryWithBackoff._sleep 的「abort 监听器泄漏」缺陷(:176-193):
 *   const timer = setTimeout(resolve, ms);       // 捕获**原始** resolve
 *   ...
 *   const origResolve = resolve;
 *   resolve = () => { signal.removeEventListener('abort', onAbort); origResolve(); }; // 重赋局部变量
 * setTimeout **在重赋前**已捕获原始 resolve 引用 → 定时器到点调的是原始 resolve、**不是**清理包装 →
 * 正常(超时)完成路径下 `removeEventListener` 永不执行。`{ once: true }` 只在监听器**触发**(abort)
 * 时自动摘除,正常完成不触发 → 每次带 signal 且正常结束的 sleep 都在 signal 上**残留一个 abort 监听器**。
 * 而重试 sleep 绝大多数是正常结束(abort 罕见),若同一 AbortSignal 跨多次重试复用(长生命周期请求)→
 * 监听器累积 → Node EventEmitter「MaxListenersExceededWarning」+ 真实内存增长。
 *
 * 正确写法:让定时器回调走清理路径(先 removeEventListener 再 resolve),而非依赖对局部 resolve 变量
 * 的事后重赋。本叶子只提供门控布尔;修复的控制流在 _sleep 内按门控二选一(门开=清理路径,
 * 门关=逐字节保留原泄漏写法)。
 *
 * 门控 KHY_RETRY_SLEEP_LISTENER_CLEANUP(默认开):关(0/false/off/no)/异常 → false(_sleep 走
 * legacy 泄漏路径,逐字节回退)。flagRegistry 优先,失败回退本地 CANON;绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控 KHY_RETRY_SLEEP_LISTENER_CLEANUP:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function retrySleepCleanupEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_RETRY_SLEEP_LISTENER_CLEANUP', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_RETRY_SLEEP_LISTENER_CLEANUP;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

module.exports = {
  retrySleepCleanupEnabled,
};
