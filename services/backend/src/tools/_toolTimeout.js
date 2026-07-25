'use strict';

/**
 * _toolTimeout.js — 给「本身缺超时入参」的工具一套**模型可设的墙钟超时**基元:一个解析器(把
 * 模型入参 / env / 默认值收敛成一个 clamp 后的毫秒数)+ 一个墙钟兜底包裹器(Promise.race,到点
 * 返回结构化超时结果,绝不抛、绝不悬挂)。
 *
 * 为什么要这个:WebSearch / DesktopControl / LSP 等工具对各自的网络/子进程/RPC 调用**无任何超时**,
 * 一旦下游挂住就无限等;WebFetch / databaseQuery 有超时但**硬编码 / 仅 env**,模型无法按场景自设。
 * 用户要「必要时让模型自己设置合理时间的硬超时」——本叶子让每个工具在 inputSchema 暴露 `timeoutMs`,
 * 模型据需自设,解析走这里、兑现走 withDeadline。
 *
 * 契约:纯函数、除读 env 外零副作用、绝不抛、坏输入 → 安全默认。**门控关(KHY_TOOL_TIMEOUT)⇒
 * resolveToolTimeoutMs 返 defaultMs(逐字节回退今日行为)。** withDeadline 不受门控管——它只是个
 * 不悬挂的竞赛包裹,ms 由调用方(经 resolveToolTimeoutMs)决定。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_TOOL_TIMEOUT  默认 on —— 工具级模型可设超时总开关;关 → resolveToolTimeoutMs 直返 defaultMs。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 收敛到 utils/resolveEnv 单一真源(逐字节委托,调用点不变)
const _env = require('../utils/resolveEnv');

function _isEnabled(name, env) {
  const e = _env(env);
  try {
    const flagRegistry = require('../services/flagRegistry');
    return flagRegistry.isFlagEnabled(name, e);
  } catch {
    const raw = e && e[name];
    if (raw === undefined || raw === null) return true;
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  }
}

/** 工具级模型可设超时总开关。默认 on。 */
function isToolTimeoutEnabled(env) {
  return _isEnabled('KHY_TOOL_TIMEOUT', env);
}

/**
 * ESC / 用户中断 → 执行中的工具取消总开关。默认 on。关 → 工具执行漏斗**不**与 abort 信号
 * 竞赛(attachAbortRace 直返原 promise、上下文不带 signal),逐字节回退今日行为(ESC 期间
 * 在途工具不被取消,只在迭代之间被 loop 断开)。
 */
function isToolAbortEnabled(env) {
  return _isEnabled('KHY_TOOL_ABORT_SIGNAL', env);
}

function _toFiniteMs(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * 解析工具超时毫秒。优先级:模型入参 paramMs > env(envKey)> defaultMs;全部 clamp[min,max]。
 * 门控关 → 直返 clamp 后的 defaultMs(今日行为,忽略 paramMs/env)。
 *
 * @param {object} opts
 * @param {number|string} [opts.paramMs] 模型/调用方入参
 * @param {string} [opts.envKey] 兜底 env 变量名
 * @param {number} opts.defaultMs 缺省毫秒
 * @param {number} [opts.min] clamp 下界
 * @param {number} [opts.max] clamp 上界
 * @param {object} [opts.env]
 * @returns {number}
 */
function resolveToolTimeoutMs(opts) {
  const o = opts || {};
  const e = _env(o.env);
  const min = Number.isFinite(o.min) ? o.min : 1000;
  const max = Number.isFinite(o.max) ? o.max : 600000;
  const def = Number.isFinite(o.defaultMs) ? o.defaultMs : 30000;

  const clamp = (n) => {
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  };
  const safeDefault = clamp(def) != null ? clamp(def) : Math.min(max, Math.max(min, def));

  try {
    if (!isToolTimeoutEnabled(e)) return safeDefault;

    const fromParam = clamp(_toFiniteMs(o.paramMs));
    if (fromParam != null) return fromParam;

    if (o.envKey) {
      const fromEnv = clamp(_toFiniteMs(e && e[o.envKey]));
      if (fromEnv != null) return fromEnv;
    }
    return safeDefault;
  } catch {
    return safeDefault;
  }
}

/**
 * 墙钟兜底包裹器:把一个可能永挂的异步操作与一个 ms 定时器竞赛。到点 → resolve 结构化超时结果
 * (`{ __timedOut:true, timeoutMs, message }`),**绝不抛、绝不悬挂**。操作先完成 → 原样 resolve。
 * 定时器 unref,不阻止进程退出。
 *
 * 注意:这是**软墙钟**——到点后停止等待并返回超时结果,但被包裹的底层操作(socket/子进程)是否
 * 真被取消,取决于调用方是否同时用 onTimeout 主动清理(如 req.destroy() / child.kill())。对本身
 * 无原生超时的工具,至少保证调用方不再无限等待。
 *
 * @param {() => Promise<any>} promiseFactory 产生被包裹 promise 的工厂(惰性,便于 onTimeout 清理)
 * @param {number} ms 墙钟毫秒
 * @param {(info:{timeoutMs:number}) => void} [onTimeout] 到点时的清理回调(如销毁 socket)
 * @returns {Promise<any>}
 */
function withDeadline(promiseFactory, ms, onTimeout) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (timer) { try { clearTimeout(timer); } catch { /* noop */ } }
      resolve(val);
    };

    const timeoutMs = _toFiniteMs(ms) || 30000;
    try {
      timer = setTimeout(() => {
        if (typeof onTimeout === 'function') {
          try { onTimeout({ timeoutMs }); } catch { /* 清理失败不影响返回 */ }
        }
        finish({
          __timedOut: true,
          timeoutMs,
          message: `操作超时:已达 ${timeoutMs}ms 硬上限`,
        });
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    } catch { /* 定时器创建失败 → 无墙钟,退化为纯 await */ }

    let p;
    try {
      p = typeof promiseFactory === 'function' ? promiseFactory() : promiseFactory;
    } catch (err) {
      finish({ __timedOut: false, __error: err });
      return;
    }
    Promise.resolve(p).then(
      (val) => finish(val),
      (err) => finish({ __timedOut: false, __error: err })
    );
  });
}

/**
 * 系统提示词命令执行段的「模型可自设工具超时」教学单条。门控关 → 返 null(调用方不追加,
 * 命令执行段逐字节回退今日文案)。教模型:对预期可能长时间无响应的操作,必要时显式设一个
 * 合理的 `timeoutMs` 硬上限,而不是无限等待。
 * @param {object} [env]
 * @returns {string|null}
 */
function buildToolTimeoutGuidanceItem(env) {
  if (!isToolTimeoutEnabled(env)) return null;
  return 'For operations that can hang or run long with no visible progress — web search, external page '
    + 'fetches, database queries, desktop/UI automation, and language-server (LSP) requests — you may set a '
    + 'sensible hard `timeoutMs` on the tool call when a bounded wait is appropriate, instead of waiting '
    + 'indefinitely. These tools accept an optional `timeoutMs` (milliseconds); on timeout they return a '
    + 'structured timeout result rather than blocking. Prefer a value matched to the work (a quick lookup '
    + 'needs far less than a large crawl); omit it to use the tool default. Do not set it so low that healthy '
    + 'long-running work is cut off — the goal is to avoid getting stuck, not to abandon slow-but-progressing tasks.';
}

// ── 通用工具执行漏斗(_withToolTimeout)的模型可设墙钟预算 + 诚实超时塑形 ──────
//
// 背景:toolCalling.js 有一道**单一漏斗** `_withToolTimeout`,每次工具调用都与一个
// 固定 120s 定时器竞赛。用户要「工具调用也要会超时;超时后诚实说超时,可以选择换方法
// 重试,不要直接断 AI 网关」。漏斗超时本就是被外层 catch 收敛成结构化结果(不会 abort
// 网关),缺的是:①预算不可由模型按场景自设;②到点后的错误只是**通用** ToolError,
// 没有明说「已超时·非终局失败·可换方法重试」。以下三件套补齐,全部门控 KHY_TOOL_TIMEOUT、
// 关态逐字节回退今日行为。

/** 漏斗超时错误的非枚举标记键——供外层 catch 识别并塑成诚实可重试结果。 */
const TOOL_EXEC_TIMEOUT_FLAG = '__toolExecTimeout';

/**
 * 解析通用工具执行漏斗的墙钟预算(ms)。这是**每一次**工具调用在 toolCalling
 * `_withToolTimeout` 里竞赛的时间上限。
 *
 * 优先级:模型入参 paramMs(仅当显式给出时)> env KHY_TOOL_EXEC_TIMEOUT_MS > 120000。
 *
 * **逐字节回退铁律**:门控关(KHY_TOOL_TIMEOUT off)**或**未给 paramMs ⇒ 直接返回
 * baseline(env 或 120000,**不 clamp、保留 <=0 的「禁用」语义**),与今日
 * `parseInt(process.env.KHY_TOOL_EXEC_TIMEOUT_MS || '120000', 10)` 完全一致。
 * 仅当模型**显式**设了 paramMs 且门控开,才启用该值并 clamp 到合理带宽,防止一个
 * 荒谬的超大/超小值卡死或秒杀循环。
 *
 * @param {object} opts
 * @param {number|string} [opts.paramMs] 模型/调用方按本次调用设的预算
 * @param {object} [opts.env]
 * @returns {number} 预算毫秒(<=0 表示禁用,调用方应跳过竞赛)
 */
function resolveToolExecBudgetMs(opts) {
  const o = opts || {};
  const e = _env(o.env);
  const rawEnv = e && e.KHY_TOOL_EXEC_TIMEOUT_MS;
  let baseline;
  if (rawEnv === undefined || rawEnv === null || rawEnv === '') {
    baseline = 120000;
  } else {
    const parsed = Number.parseInt(String(rawEnv).trim(), 10);
    baseline = Number.isFinite(parsed) ? parsed : 120000;
  }
  try {
    // 门控关 → 今日行为:baseline 原样(含 <=0 禁用语义),忽略 paramMs。
    if (!isToolTimeoutEnabled(e)) return baseline;
    // 无显式模型入参 → 仍是今日行为:baseline 原样。
    const paramMs = _toFiniteMs(o.paramMs);
    if (paramMs == null) return baseline;
    // 模型显式设了本次调用预算 → 启用并 clamp 到合理带宽。
    const MIN = 1000;
    const MAX = 1800000;
    if (paramMs < MIN) return MIN;
    if (paramMs > MAX) return MAX;
    return paramMs;
  } catch {
    return baseline;
  }
}

/**
 * 给漏斗超时错误打上非枚举标记(并补 code/label/timeoutMs 元数据),使外层 catch
 * 能把它塑成诚实可重试的超时结果,而非落入通用 ToolError。绝不抛;非对象原样返回。
 * @param {Error} err
 * @param {{toolLabel?:string, timeoutMs?:number}} [info]
 * @returns {Error}
 */
function markToolExecTimeoutError(err, info) {
  if (!err || typeof err !== 'object') return err;
  try {
    Object.defineProperty(err, TOOL_EXEC_TIMEOUT_FLAG, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    if (info && typeof info === 'object') {
      if (info.toolLabel) err.__toolLabel = info.toolLabel;
      if (Number.isFinite(info.timeoutMs)) err.__timeoutMs = info.timeoutMs;
    }
    if (!err.code) err.code = 'ETIMEDOUT';
  } catch { /* 打标失败不影响错误本身照常透出 */ }
  return err;
}

/** 识别一个错误是否为漏斗打标的工具执行超时。绝不抛。 */
function isToolExecTimeoutError(err) {
  return !!(err && typeof err === 'object' && err[TOOL_EXEC_TIMEOUT_FLAG] === true);
}

/**
 * 为「通用工具执行漏斗超时」构造**诚实、可重试**的结构化结果。明确告诉模型:本次
 * 工具调用触及时间预算被中止——**这不是终局失败,AI 网关未被中断**——可以换个方法
 * 重试(缩小范围 / 换更快更合适的工具 / 分批 / 在该工具入参显式设更大的 timeoutMs)。
 *
 * 结构与 ToolError.toStructuredResult 对齐(code/message/hint/recoverable/retryable/
 * details),额外附 errorType:'timeout' 供循环与模型确定性识别。门控关(KHY_TOOL_TIMEOUT
 * off)→ 返 null,调用方逐字节回退今日的通用 ToolError 塑形。
 *
 * @param {object} opts
 * @param {string} [opts.toolLabel] 工具名(permissionKey)
 * @param {number} [opts.timeoutMs] 触发的墙钟预算
 * @param {number} [opts.elapsedMs] 实际耗时
 * @param {object} [opts.env]
 * @returns {object|null}
 */
function buildToolExecTimeoutResult(opts) {
  const o = opts || {};
  if (!isToolTimeoutEnabled(o.env)) return null;
  const label = o.toolLabel || 'tool';
  const ms = Number.isFinite(o.timeoutMs) ? o.timeoutMs : null;
  const elapsed = Number.isFinite(o.elapsedMs) ? o.elapsedMs : null;
  const msPart = ms != null ? `已达 ${ms}ms 的执行时间上限` : '已达执行时间上限';
  const message = `工具 ${label} ${msPart},本次调用已超时中止。`;
  const hint = '这不是最终失败,AI 网关未中断——你可以换个方法重试:缩小处理范围、'
    + '改用更快或更合适的工具、分批处理,或在该工具入参上显式设更大的 timeoutMs 后重试。'
    + '若该操作本就需要较久且在稳定推进,可给一个更宽的 timeoutMs;否则优先换更省时的做法。';
  const details = { tool: label, reason: 'tool-exec-timeout' };
  if (ms != null) details.timeoutMs = ms;
  if (elapsed != null) details.elapsedMs = elapsed;
  return {
    success: false,
    error: {
      code: 'TIMEOUT',
      errorType: 'timeout',
      message,
      hint,
      recoverable: true,
      retryable: true,
      details,
    },
  };
}

// ── ESC / 用户中断 → 执行中的工具取消（abort 竞赛 + 诚实取消结果）─────────────
//
// 背景:ESC(cancelActiveRequest)今天只 abort 模型/网关流,**到不了**执行中的工具——
// 一次长搜索/外网抓取/DB 查询在跑时按 ESC,要等到工具的 120s 硬超时才松手。修:loop 把
// 已有的 parentAbort.signal(仅在真·用户中断/外部 abort 时触发)穿进工具执行漏斗;漏斗用
// 下面的 attachAbortRace 让在途工具与 abort 竞赛,信号触发 → 以带标记的取消错误落败,外层
// catch 据标记塑成诚实、可重试的「已取消」结果。全部门控 KHY_TOOL_ABORT_SIGNAL、关态逐字节
// 回退今日行为。注意:这让调用方**不再等待**被取消的工具;底层同步阻塞(execSync 类)是否
// 真被杀,仍取决于该工具是否走非阻塞路径(见 _execCompat 家族)——此处只保证不再无限等。

/** 工具取消错误的非枚举标记键——供外层 catch 识别并塑成诚实可重试的「已取消」结果。 */
const TOOL_CANCELLED_FLAG = '__toolCancelled';

/**
 * 给一个错误打上「工具被用户中断」标记。绝不抛;非对象原样返回。
 * @param {Error} err
 * @param {{toolLabel?:string}} [info]
 * @returns {Error}
 */
function markToolCancelledError(err, info) {
  if (!err || typeof err !== 'object') return err;
  try {
    Object.defineProperty(err, TOOL_CANCELLED_FLAG, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    if (info && typeof info === 'object' && info.toolLabel) err.__toolLabel = info.toolLabel;
    if (!err.code) err.code = 'ECANCELLED';
  } catch { /* 打标失败不影响错误本身照常透出 */ }
  return err;
}

/** 识别一个错误是否为「工具被用户中断」。绝不抛。 */
function isToolCancelledError(err) {
  return !!(err && typeof err === 'object' && err[TOOL_CANCELLED_FLAG] === true);
}

/**
 * 让一个在途工具 promise 与 abort 信号竞赛:信号触发 → 以带取消标记的错误落败,调用方据此
 * 停止等待。返回 `{ promise, cleanup }`——**cleanup 必须在 promise settle 后调用**以移除挂在
 * 长寿命 parentAbort.signal 上的监听(否则一长会话数百次工具调用会累积监听 → 内存/告警)。
 *
 * 契约:门控关 / 无有效 signal → 直返**原 promise**(byte-identical,cleanup 为 no-op)。
 * signal 已 aborted → 立即以取消错误落败。绝不抛。
 *
 * @param {Promise<any>} promise 被包裹的在途工具 promise
 * @param {AbortSignal} signal loop 的 parentAbort.signal(仅真·中断时触发)
 * @param {string} toolLabel 工具名(permissionKey),用于取消错误信息
 * @param {object} [env]
 * @returns {{ promise: Promise<any>, cleanup: () => void }}
 */
function attachAbortRace(promise, signal, toolLabel, env) {
  const NOOP = () => {};
  try {
    if (!isToolAbortEnabled(env)) return { promise, cleanup: NOOP };
    if (!signal || typeof signal.addEventListener !== 'function') return { promise, cleanup: NOOP };
    const label = toolLabel || 'tool';
    if (signal.aborted) {
      const err = markToolCancelledError(
        new Error(`Tool ${label} cancelled by user before execution (abort)`), { toolLabel: label }
      );
      return { promise: Promise.reject(err), cleanup: NOOP };
    }
    let onAbort = null;
    const abortP = new Promise((_, reject) => {
      onAbort = () => {
        reject(markToolCancelledError(
          new Error(`Tool ${label} cancelled by user (abort)`), { toolLabel: label }
        ));
      };
      try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* ignore */ }
    });
    const cleanup = () => {
      try { if (onAbort) signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
    };
    // 若 abortP 落败而调用方未消费其 rejection(工具先完成时),Promise.race 已 settle,
    // abortP 的 rejection 会成为「未处理拒绝」——用一个吞噬 catch 兜住(cleanup 也会移除监听,
    // 使 onAbort 通常永不触发)。
    abortP.catch(() => {});
    return { promise: Promise.race([promise, abortP]), cleanup };
  } catch {
    return { promise, cleanup: NOOP };
  }
}

/**
 * 为「工具被用户中断(ESC/interrupt)」构造诚实、可重试的结构化结果。区别于超时:是用户主动
 * 喊停。明确告诉模型这不是终局失败(可按需重试),且本次中断由 loop 处理。门控关 → 返 null,
 * 调用方逐字节回退今日通用 ToolError 塑形。
 *
 * @param {object} opts
 * @param {string} [opts.toolLabel]
 * @param {number} [opts.elapsedMs]
 * @param {object} [opts.env]
 * @returns {object|null}
 */
function buildToolCancelledResult(opts) {
  const o = opts || {};
  if (!isToolAbortEnabled(o.env)) return null;
  const label = o.toolLabel || 'tool';
  const elapsed = Number.isFinite(o.elapsedMs) ? o.elapsedMs : null;
  const message = `工具 ${label} 已被用户中断(ESC),本次调用取消。`;
  const hint = '这是用户主动中断,不是失败——若确需继续,可重新发起该操作(必要时缩小范围或换更快的做法);'
    + '若用户是想改变方向,请按其新指示行事,不要机械重试同一调用。';
  const details = { tool: label, reason: 'tool-cancelled' };
  if (elapsed != null) details.elapsedMs = elapsed;
  return {
    success: false,
    error: {
      code: 'CANCELLED',
      errorType: 'cancelled',
      message,
      hint,
      recoverable: true,
      retryable: true,
      details,
    },
  };
}

module.exports = {
  isToolTimeoutEnabled,
  isToolAbortEnabled,
  resolveToolTimeoutMs,
  withDeadline,
  buildToolTimeoutGuidanceItem,
  resolveToolExecBudgetMs,
  markToolExecTimeoutError,
  isToolExecTimeoutError,
  buildToolExecTimeoutResult,
  attachAbortRace,
  markToolCancelledError,
  isToolCancelledError,
  buildToolCancelledResult,
};
