/**
 * retryPrimitives.js — 解释器外挂的重试 / 空闲看门狗 / 进度日志原语。
 *
 * 不改 workflowExecutor 解释器本体:通过包装 `defaultPrimitives(ctx)` 返回的
 * 同形对象,把可靠性能力(重试、空闲超时、结构化进度)注入 runGraph 的
 * `options.primitives` / `options.onLog`。
 *
 * 设计:
 * - `buildRetryPrimitives(ctx, opts)` 仅包装 `executeTool`:失败(抛异常或返回
 *   含 error 的结果)时按 `opts.retryPolicy`(默认 { retries: 2, backoffMs: 1000 },
 *   指数退避)重试,每次重试经 `opts.onRetry(info)` 上报,供 flowStats 累计
 *   retryTotal;其余 primitive 原样透传,只挂活动追踪;
 * - Exhaustion semantics: when retries are exhausted AND the last result is
 *   still error-shaped ({ success: false } or { error }), executeTool THROWS
 *   instead of returning the error object. This lets the interpreter mark the
 *   toolCall node as failed (it only fails on throw), so flowStats records the
 *   run as failed and find() weighting stays truthful. The thrown Error carries
 *   `failedTool` (tool name), `lastResult` (the raw error-shaped result) and
 *   `retryCount` (retries performed) for upstream fail-soft reporting.
 *   getRetryTotal() counting semantics are unchanged;
 * - 空闲超时(工程红线:禁止硬墙钟杀活跃任务):每次任一 primitive 调用返回
 *   (成功或失败)都重置 `lastActivity`;`createIdleWatchdog(idleLimitMs)` 只在
 *   距最近活动超过阈值时才判定超时(默认 `KHY_FLOW_IDLE_LIMIT_MS` 或 120000ms),
 *   由调用方轮询 `check()`,本模块不主动 kill 任何任务;
 * - `buildProgressLogger` 产出可传给 runGraph 的 onLog:每行含「动作 + 目标 +
 *   进度」(规则 2),失败行附错误摘要与累计重试计数;
 * - 退避等待用纯 Promise 延迟睡眠(无 kill/abort),属合法例外清单情形。
 */
'use strict';

const workflowExecutor = require('./workflowExecutor');

const DEFAULT_RETRY_POLICY = { retries: 2, backoffMs: 1000 };

function _defaultIdleLimit() {
  const n = Number(process.env.KHY_FLOW_IDLE_LIMIT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120000;
}

// Promise-based delay sleep (no kill/abort — allowed timeout pattern).
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A tool result "failed" when it carries an error field or explicit success:false.
function _isErrorResult(res) {
  if (res == null || typeof res !== 'object') {
    return false;
  }
  if (res.error != null && res.error !== false && res.error !== '') {
    return true;
  }
  if (res.success === false) {
    return true;
  }
  return false;
}

/**
 * Sliding idle watchdog. Times out ONLY when no productive activity happened
 * for `idleLimitMs` — an actively progressing task is never killed (rule 3).
 * @param {number} [idleLimitMs]  default KHY_FLOW_IDLE_LIMIT_MS || 120000
 * @returns {{touch:()=>void, idleMs:()=>number, isIdle:()=>boolean,
 *            check:()=>{idle:boolean,idleMs:number,limitMs:number}}}
 */
function createIdleWatchdog(idleLimitMs) {
  const limit =
    Number.isFinite(Number(idleLimitMs)) && Number(idleLimitMs) > 0
      ? Math.floor(Number(idleLimitMs))
      : _defaultIdleLimit();
  let lastActivity = Date.now();
  return {
    touch() {
      lastActivity = Date.now();
    },
    idleMs() {
      return Date.now() - lastActivity;
    },
    isIdle() {
      return Date.now() - lastActivity > limit;
    },
    check() {
      const idleMs = Date.now() - lastActivity;
      return { idle: idleMs > limit, idleMs, limitMs: limit };
    },
  };
}

/**
 * Wrap defaultPrimitives(ctx) with retry on executeTool + activity tracking on
 * every primitive. Same-shape return object drops into runGraph unchanged.
 * @param {object} [ctx]  passed through to workflowExecutor.defaultPrimitives
 * @param {object} [opts]
 * @param {{retries?:number,backoffMs?:number}} [opts.retryPolicy]
 * @param {(info:{tool:string,attempt:number,maxAttempts:number,waitMs:number,error:string})=>void} [opts.onRetry]
 * @param {object} [opts.watchdog]  idle watchdog to touch (createIdleWatchdog())
 * @param {object} [opts.basePrimitives]  injectable base (tests); defaults to defaultPrimitives(ctx)
 * @returns {{primitives:object, watchdog:object, getRetryTotal:()=>number}}
 */
function buildRetryPrimitives(ctx = {}, opts = {}) {
  const base = opts.basePrimitives || workflowExecutor.defaultPrimitives(ctx);
  const policy = { ...DEFAULT_RETRY_POLICY, ...(opts.retryPolicy || {}) };
  const retries =
    Number.isFinite(Number(policy.retries)) && Number(policy.retries) >= 0
      ? Math.floor(Number(policy.retries))
      : DEFAULT_RETRY_POLICY.retries;
  const backoffMs =
    Number.isFinite(Number(policy.backoffMs)) && Number(policy.backoffMs) >= 0
      ? Math.floor(Number(policy.backoffMs))
      : DEFAULT_RETRY_POLICY.backoffMs;
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : () => {};
  const watchdog = opts.watchdog || createIdleWatchdog(opts.idleLimitMs);
  let retryTotal = 0;

  // Every primitive return (success OR failure) is productive activity.
  const track =
    (fn) =>
    async (...args) => {
      try {
        return await fn(...args);
      } finally {
        watchdog.touch();
      }
    };

  async function executeToolWithRetry(name, params) {
    const maxAttempts = retries + 1;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await base.executeTool(name, params);
        watchdog.touch();
        if (!_isErrorResult(res)) {
          return res;
        }
        const summary =
          typeof res.error === 'string' ? res.error : JSON.stringify(res.error || res);
        lastErr = new Error(summary);
        if (attempt >= maxAttempts) {
          // Retries exhausted with an error-shaped result: throw so the
          // interpreter can mark this node failed (it only fails on throw).
          const err = new Error(
            `工具「${String(name)}」重试 ${retries} 次后仍失败：${String(summary).slice(0, 300)}`
          );
          err.failedTool = String(name);
          err.lastResult = res;
          err.retryCount = retries;
          throw err;
        }
      } catch (err) {
        watchdog.touch();
        lastErr = err;
        if (attempt >= maxAttempts) {
          throw err;
        }
      }
      // Exponential backoff: backoffMs * 2^(attempt-1). Pure delay, no kill.
      const waitMs = backoffMs * Math.pow(2, attempt - 1);
      retryTotal += 1;
      try {
        onRetry({
          tool: String(name),
          attempt,
          maxAttempts,
          waitMs,
          error: lastErr && lastErr.message ? lastErr.message : String(lastErr),
        });
      } catch {
        /* observer errors never break the run */
      }
      if (waitMs > 0) {
        await _sleep(waitMs);
      }
    }
    // Unreachable, kept for safety.
    throw lastErr || new Error('executeTool 重试耗尽');
  }

  const primitives = {};
  for (const [key, fn] of Object.entries(base)) {
    if (typeof fn !== 'function') {
      primitives[key] = fn;
      continue;
    }
    primitives[key] =
      key === 'executeTool'
        ? (name, params) => executeToolWithRetry(name, params)
        : track(fn.bind(base));
  }

  return { primitives, watchdog, getRetryTotal: () => retryTotal };
}

/**
 * Build an onLog callback for runGraph that prints structured Chinese progress
 * lines with action + target + progress (rule 2), e.g.
 * `执行流程「发票整理」第 3/10 步:toolCall「DesktopControl」… 成功`.
 * @param {object} opts
 * @param {string} opts.flowName
 * @param {number} [opts.totalSteps]  planned node count (for n/m display)
 * @param {(line:string)=>void} [opts.print]  defaults to console.log
 * @param {()=>number} [opts.getRetryTotal]  from buildRetryPrimitives, shown on failures
 * @returns {(entry:object)=>void}
 */
function buildProgressLogger(opts = {}) {
  const flowName = String(opts.flowName == null ? '流程' : opts.flowName);
  const total =
    Number.isFinite(Number(opts.totalSteps)) && Number(opts.totalSteps) > 0
      ? Math.floor(Number(opts.totalSteps))
      : null;
  const print = typeof opts.print === 'function' ? opts.print : console.log;
  const getRetryTotal = typeof opts.getRetryTotal === 'function' ? opts.getRetryTotal : null;
  let step = 0;

  return function onLog(entry) {
    try {
      const e = entry || {};
      step += 1;
      const progress = total ? `第 ${step}/${total} 步` : `第 ${step} 步`;
      const target = `${e.type || '?'}「${e.name || e.type || '?'}」`;
      let line;
      if (e.status === 'failed') {
        const retries = getRetryTotal ? getRetryTotal() : 0;
        const errMsg = e.error ? String(e.error).slice(0, 200) : '未知错误';
        line = `执行流程「${flowName}」${progress}:${target}… 失败(${errMsg};累计重试 ${retries} 次)`;
      } else if (e.status === 'skipped') {
        line = `执行流程「${flowName}」${progress}:${target}… 跳过${e.summary ? `(${e.summary})` : ''}`;
      } else if (e.status === 'awaiting_input') {
        line = `执行流程「${flowName}」${progress}:${target}… 等待用户输入`;
      } else {
        line = `执行流程「${flowName}」${progress}:${target}… 成功${e.summary ? `(${String(e.summary).slice(0, 120)})` : ''}`;
      }
      print(line);
    } catch {
      /* logging must never break the run */
    }
  };
}

module.exports = {
  buildRetryPrimitives,
  createIdleWatchdog,
  buildProgressLogger,
  DEFAULT_RETRY_POLICY,
};
