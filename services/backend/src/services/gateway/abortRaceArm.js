'use strict';

/**
 * abortRaceArm — 让 `Promise.race([...])` 在取消信号触发时**立刻返回**的第三条臂。
 *
 * 病根(见排障报告 root cause C):网关主循环里 `Promise.race([adapterPromise,
 * idleTimeout.timeoutPromise])` 只有「适配器返回」「idle 超时」两条臂。当底层卡在一个
 * **不响应 abort 的调用**上(默认 kiro 的 `client.send`、cliTool 子进程),即使 UI 侧
 * Esc/Ctrl-C 已把 abort 传播到 `gatewayAbort`(经 linked controller 到 `attemptAbort`),
 * 这个 `await` 也永不返回 → 控制权回不到 REPL → 用户「按再多次都打不断」,而独立 setInterval
 * 驱动的 spinner 继续转。补上这条 abort 臂后:signal 一 abort,race 立即 reject,`await` 解开,
 * 上层 `throwIfCancelled()` 抛出 → REPL 复位 → spinner stop。**不再依赖适配器自愿配合**。
 *
 * 纯叶子:零 IO、绝不抛。门控在**调用方**(aiGatewayGenerateMethod)判定——门关时上游不挂臂,
 * `Promise.race` 逐字节回退到今日两臂行为。
 *
 * ── HOW TO EXTEND ────────────────────────────────────────────────────────────
 * 需要在别处让一个长 await 对 abort 立即响应时,复用 createAbortRejectionArm(signal, reason):
 *   const arm = createAbortRejectionArm(mySignal, 'my op cancelled');
 *   try { return await Promise.race([workPromise, arm.promise]); }
 *   finally { arm.cleanup(); }   // 务必 cleanup,否则 listener 泄漏
 * cleanup() 幂等;signal 缺失/无 addEventListener → 返回一条永不 settle 的臂(等价「不挂臂」)。
 */

/**
 * 构造一条「signal abort 时 reject」的 race 臂。
 *
 * @param {AbortSignal|null|undefined} signal - 取消信号(通常是 attemptAbort.signal,
 *   它经 linked controller 链自 gatewayAbort ← 外部 abort ← UI 的 Esc/Ctrl-C,
 *   同时也覆盖 hard-deadline 与 idle 看门狗触发的 abort)。
 * @param {string} [reason] - reject 时错误消息用的说明。
 * @returns {{ promise: Promise<never>, cleanup: () => void }}
 *   promise: 永不 resolve;signal abort 时 reject(Error)。若 signal 无效则永不 settle
 *            (等价于这条臂不存在,`Promise.race` 由其它臂决出)。
 *   cleanup: 幂等移除 listener;race 结束务必调用以防泄漏。
 */
function createAbortRejectionArm(signal, reason = 'aborted') {
  let cleanup = () => {};

  const promise = new Promise((_, reject) => {
    // 无有效 signal → 永不 settle 的臂(与「不挂臂」等价,交由其它臂决出胜负)。
    if (!signal || typeof signal.addEventListener !== 'function') {
      return;
    }

    const doReject = () => {
      cleanup();
      try {
        reject(new Error(_describe(reason, signal)));
      } catch {
        /* best effort — reject 后重复触发无害 */
      }
    };

    // 已经 abort:同步 reject(避免挂 listener 后错过已发生的事件)。
    if (signal.aborted) {
      try {
        reject(new Error(_describe(reason, signal)));
      } catch { /* ignore */ }
      return;
    }

    const onAbort = () => doReject();
    try {
      signal.addEventListener('abort', onAbort, { once: true });
    } catch {
      // addEventListener 异常(非常规 signal 实现)→ 退化为永不 settle 的臂,绝不抛。
      return;
    }
    cleanup = () => {
      try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      cleanup = () => {}; // 幂等
    };
  });

  return {
    promise,
    cleanup: () => cleanup(),
  };
}

/** 拼装 reject 说明:优先带上 signal.reason(若可读)。绝不抛。 */
function _describe(reason, signal) {
  const base = typeof reason === 'string' && reason ? reason : 'aborted';
  try {
    const r = signal && signal.reason;
    if (r === undefined || r === null) return base;
    const text = typeof r === 'string' ? r : (r && r.message) ? r.message : String(r);
    if (!text || text === base) return base;
    return `${base}: ${text}`;
  } catch {
    return base;
  }
}

module.exports = { createAbortRejectionArm };
