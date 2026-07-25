'use strict';

/**
 * webFetchDeadline — pure leaf deciding WebFetch's total wall-clock deadline +
 * abort wiring (goal「khy 卡顿/卡死,没法做真正的软件项目」;症状「一显示正在处理就卡死」).
 *
 * 背景(现场取证):一次 WebFetch 抓取卡在「正在检索外部信息… 1m59s · 等待响应…」——
 * 直到外层 120s 工具硬超时才松手,整个 TUI 像冻住。两条根因都在 WebFetchTool:
 *   ① Node 的 `timeout: timeoutMs` 是 **socket 空闲超时**,不是总时限——慢站点只要一直
 *      滴数据(首包 P95≈40s)就不断重置它;且同源重定向每跳**重新武装**一个新 30s
 *      (index.js:294)。于是没有任何**总墙钟**上限,一路骑到 120s 硬顶 = 感知卡死。
 *   ② `execute(params, _context)` **从不读** `_context.signal`,也从不把它传进 http.request,
 *      所以 ESC 只让循环停止等待(attachAbortRace),底层 **socket 永不被销毁**——
 *      这正是 [[project_esc_tool_abort_inflight_interrupt]] 在 _toolTimeout.js:314-315
 *      明确记下的「最后一公里」(信号穿进了漏斗,却没穿进 WebFetch)。
 *
 * 本叶子只做**纯决策**(零 IO、确定性、绝不抛),有状态的 AbortController/定时器留在工具里:
 *   - 门控 KHY_WEBFETCH_HARD_DEADLINE(默认开)查询;
 *   - 从工具执行上下文里挑出有效的父 abort 信号(ESC);
 *   - 把总墙钟预算映射自已解析的 timeoutMs(单跳空闲超时复用为**整条链的总上限**);
 *   - 把 signal 合并进请求 options(signal 为空时**返回原对象**,保证门控关/无信号逐字节等价);
 *   - 识别 abort 类错误,供工具把结果塑成诚实、可重试的「超时/已取消」而非无意义的 Fetch failed。
 *
 * 门控关 → resolveParentSignal 返 null、mergeSignalOption 返原 options、工具据此逐字节回退今日
 * 行为(无 controller、无总定时器、options 不含 signal 键)。
 */

const FALSY = ['0', 'false', 'off', 'no'];

/**
 * WebFetch 总墙钟 + abort 接线是否启用。未设/异常 → 保守放行(true,default-on)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isWebFetchHardDeadlineEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_WEBFETCH_HARD_DEADLINE;
    if (raw === undefined || raw === null || raw === '') return true;
    return !FALSY.includes(String(raw).trim().toLowerCase());
  } catch { return true; }
}

/** 是否像一个可用的 AbortSignal(具 aborted 布尔 + addEventListener)。绝不抛。 */
function _isSignalLike(s) {
  return !!(s && typeof s === 'object'
    && typeof s.addEventListener === 'function'
    && 'aborted' in s);
}

/**
 * 从工具执行上下文挑出父 abort 信号(loop 在真·中断时经 toolExecutionContext.signal 传入)。
 * 门控关 / 上下文无有效信号 → null(工具据此不接线,逐字节回退)。绝不抛。
 * @param {object} context toolExecutionContext(WebFetch.execute 的第二参)
 * @param {object} [env]
 * @returns {AbortSignal|null}
 */
function resolveParentSignal(context, env = process.env) {
  try {
    if (!isWebFetchHardDeadlineEnabled(env)) return null;
    const sig = context && context.signal;
    return _isSignalLike(sig) ? sig : null;
  } catch { return null; }
}

/**
 * 整条抓取(含重定向链)的总墙钟预算 ms。以已解析的单跳 timeoutMs 为总上限
 * (语义升级:原本每跳各自 30s 空闲、可累加成分钟级;现全链共享这一预算)。
 * 非有限/非正 → 回退 fallbackMs。绝不抛。
 * @param {number} timeoutMs 已由 resolveToolTimeoutMs 解析并 clamp 的单次超时
 * @param {number} [fallbackMs]
 * @returns {number}
 */
function resolveTotalDeadlineMs(timeoutMs, fallbackMs = 30000) {
  const n = Number(timeoutMs);
  if (Number.isFinite(n) && n > 0) return n;
  const f = Number(fallbackMs);
  return Number.isFinite(f) && f > 0 ? f : 30000;
}

/**
 * 把 signal 合并进请求 options。signal 为 null/undefined → **返回原 options 引用**
 * (调用方逐字节等价:不新增 signal 键)。否则返回浅拷贝并附 signal。绝不抛。
 * @param {object} options http.request/get 的 options
 * @param {AbortSignal|null} signal
 * @returns {object}
 */
function mergeSignalOption(options, signal) {
  if (!signal) return options;
  try { return Object.assign({}, options, { signal }); }
  catch { return options; }
}

/** 识别一个错误是否为 abort(总墙钟耗尽 / ESC / 底层 AbortSignal)。绝不抛。 */
function isAbortError(err) {
  if (!err || typeof err !== 'object') return false;
  return err.code === 'ABORT_ERR' || err.name === 'AbortError' || err.__webFetchDeadline === true;
}

module.exports = {
  isWebFetchHardDeadlineEnabled,
  resolveParentSignal,
  resolveTotalDeadlineMs,
  mergeSignalOption,
  isAbortError,
};
