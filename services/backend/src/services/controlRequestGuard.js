'use strict';

/**
 * controlRequestGuard.js — 「失败/某些情况下一直转圈实际卡死」的确定式收尾(纯叶子)。
 *
 * 症状取证:toolUseLoop 在两处 `await onControlRequest(...)`(AskUserQuestion 答案接缝
 * ~5933、_resolveExecApproval 审批 ~7233)等待宿主控制通道应答。两处都 try/catch 兜
 * reject,但**一个永不 settle 的 promise 会让 await 永久停泊**——TUI 侧 onControlRequest
 * (useQueryBridge.js)构造的 promise 无 timeout、无 reject、无 abort 监听,只靠
 * resolveControl 兑现;一旦 overlay 卸载/请求被孤儿化/用户 ESC 但未回传兑现,循环就卡在
 * await 里,spinner 永转、看着在工作实则死锁。下游对 null 应答已 fail-closed
 * (问答→「User declined」、审批→ deny),所以让 await 在中断/超时时**settle 成 null**
 * 即可安全解卡。
 *
 * 本叶子把控制请求 promise 与「parentAbort 中断」和「可选超时兜底」赛跑,谁先到谁赢:
 *   - 原 promise 先 settle → 原样透传(resolve 值 / 抛出的 reject 交回调用方 catch)。
 *   - abort 先到 → resolve(null)(下游 fail-closed)。
 *   - timeout 先到 → resolve(null)。默认**超时关闭**(0):用户合法地可以无限等待问答/
 *     审批,中断信号才是主机制;超时只是给「孤儿请求真死锁」留的兜底开关。
 *
 * 纯叶子契约:零 I/O、无随机(setTimeout/clearTimeout 可注入以便测试)、绝不抛、
 * 门控 `KHY_CONTROL_REQUEST_GUARD` 默认开(off ∈ {0,false,off,no})→**逐字节回退**:
 * 门控关时直接 `return promise`(await 行为与今日完全一致)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

function isEnabled(env) {
  const raw = env && env.KHY_CONTROL_REQUEST_GUARD;
  if (raw === undefined || raw === null || raw === '') return true;
  return !_FALSY.has(String(raw).trim().toLowerCase());
}

/**
 * 解析超时兜底毫秒。默认 0(关闭)。仅接受正有限数;非法/缺省 → 0。
 * 显式覆盖优先级:opts.timeoutMs > env.KHY_CONTROL_REQUEST_TIMEOUT_MS。
 * @returns {number} >=0
 */
function resolveTimeoutMs(env, opts) {
  const pick = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  if (opts && opts.timeoutMs !== undefined) {
    return pick(opts.timeoutMs) || 0;
  }
  if (env && env.KHY_CONTROL_REQUEST_TIMEOUT_MS !== undefined) {
    return pick(env.KHY_CONTROL_REQUEST_TIMEOUT_MS) || 0;
  }
  return 0;
}

/**
 * 让控制请求 promise 与中断/超时赛跑。
 *
 * @param {Promise<any>} promise            onControlRequest(...) 返回的 promise
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]       parentAbort.signal / externalSignal
 * @param {number} [opts.timeoutMs]         >0 启用超时兜底(默认取 env,再默认 0=关)
 * @param {object} [opts.env]               门控/超时读取源(默认 process.env)
 * @param {Function} [opts.setTimeout]      可注入(测试)
 * @param {Function} [opts.clearTimeout]    可注入(测试)
 * @returns {Promise<any>}  原值 / null(中断或超时)
 */
function guardControlRequest(promise, opts = {}) {
  const env = opts.env || (typeof process !== 'undefined' ? process.env : {});
  // 门控关 → 逐字节回退:await 原 promise,零行为差异。
  if (!isEnabled(env)) return promise;

  // 非 thenable 的意外输入:直接透传,绝不抛。
  if (!promise || typeof promise.then !== 'function') return promise;

  const signal = opts.signal || null;
  const timeoutMs = resolveTimeoutMs(env, opts);
  const _setTimeout = opts.setTimeout || setTimeout;
  const _clearTimeout = opts.clearTimeout || clearTimeout;

  // 已中断:立刻 fail-closed,连 race 都不必起。
  if (signal && signal.aborted) return Promise.resolve(null);
  // 无中断信号且无超时 → 无可赛跑者,行为等价于 await 原 promise。
  if (!signal && !(timeoutMs > 0)) return promise;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let onAbort = null;

    const cleanup = () => {
      if (timer !== null) { try { _clearTimeout(timer); } catch { /* ignore */ } timer = null; }
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ } }
    };
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(val);
    };

    // 原 promise 胜出 → 原样透传(resolve 值;reject 也 resolve 交回调用方,
    // 保持「onControlRequest 抛错 → ctrlResp=null」的既有 try/catch 语义:此处把
    // reject 归一为 null,与调用点 catch 的结果一致,避免未处理拒绝)。
    promise.then(
      (v) => settle(resolve, v),
      () => settle(resolve, null),
    );

    if (signal) {
      onAbort = () => settle(resolve, null);
      try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* ignore */ }
    }
    if (timeoutMs > 0) {
      timer = _setTimeout(() => settle(resolve, null), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  });
}

module.exports = {
  isEnabled,
  resolveTimeoutMs,
  guardControlRequest,
};
