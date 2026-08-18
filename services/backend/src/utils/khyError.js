'use strict';

/**
 * khyError.js — 结构化错误四件套的单一真源（纯叶子）。
 *
 * 每个错误对外必须回答四个问题，缺一不可：
 *   code        机器可读的稳定标识（用于分类、统计、审计）
 *   message     出了什么事（面向用户，中文）
 *   hint        下一步怎么办（面向用户，中文；空字符串视为未定义提示 = bug）
 *   recoverable 调用方是否有降级路径可走（true = 功能降级但不中断）
 *   retryable   原样重试是否可能成功（true = 值得退避重试；false = 重试必然同样失败）
 *
 * `recoverable` 与 `retryable` 是两个独立维度，不要合并：
 *   - 摘要模型调不通 → recoverable(退回本地摘要) 且 retryable(下一回合可能通)
 *   - 预算配置写错   → recoverable(用默认值) 但 not retryable(重试一万次还是错的)
 *   - 磁盘只读       → not recoverable(审计写不进去) 但 retryable(挂载修好就行)
 *
 * ⚠️ 刻意不做的事（避免与既有模块撞名/抢职责）：
 *   - 不是 Express 中间件。HTTP 层错误响应仍归 `src/middleware/errorHandler.js`，
 *     状态码工厂仍归 `src/utils/httpError.js`。
 *   - 不打印、不写文件、不 require 任何东西。终端渲染由调用方用
 *     `src/cli/formatters.js` 的 print* 完成；审计落盘由 `src/services/auditLog.js`
 *     完成。本文件保持零依赖，任何层都能引用而不产生 require 环。
 *   - 不做网关传输层归类，那是 `src/utils/mapRuntimeErrorCategory.js`。
 */

/**
 * 已登记的错误码 → 默认提示与可恢复/可重试语义。
 * 未登记的 code 也允许使用（调用方自带 hint），只是拿不到默认提示。
 */
const CODES = Object.freeze({
  MODULE_NOT_FOUND: { hint: '检查依赖安装或路径配置', recoverable: true, retryable: false },
  CONFIG_INVALID: { hint: '检查环境变量取值范围，或删除该项回退默认值', recoverable: true, retryable: false },
  IO_FAILED: { hint: '检查目标路径是否存在、是否只读、磁盘是否已满', recoverable: false, retryable: true },
  PERMISSION_DENIED: { hint: '该操作需要你显式授权，重新执行并选择允许', recoverable: false, retryable: false },
  TIMEOUT: { hint: '目标端长时间无响应，稍后重试或换用更快的模型/端点', recoverable: true, retryable: true },
  NETWORK_UNREACHABLE: { hint: '检查端点地址与本机网络，或改用本地模型', recoverable: true, retryable: true },
  MODEL_CALL_FAILED: { hint: '检查模型服务是否在线、上下文是否超限', recoverable: true, retryable: true },
  // ── 上下文压缩链路 ──────────────────────────────────────────────
  CONTEXT_COMPRESS_SKIPPED: { hint: '这是有意跳过；若上下文已接近满，用 /compact 手动压缩', recoverable: true, retryable: true },
  CONTEXT_SUMMARY_FAILED: { hint: '摘要模型不可用或输出过短，已退回本地抽取式摘要', recoverable: true, retryable: true },
  CONTEXT_COMPRESS_FAILED: { hint: '已降级为尾部截断；换用能力更强的模型可恢复摘要压缩', recoverable: true, retryable: true },
  CONTEXT_BUDGET_EXCEEDED: { hint: '上下文仍超预算，已执行硬截断；用 /clear 开新会话可彻底释放', recoverable: true, retryable: false },
  AUDIT_WRITE_FAILED: { hint: '检查数据目录写权限（KHY_APP_HOME），审计不影响主流程', recoverable: true, retryable: true },
  UNKNOWN: { hint: '查看上一条日志定位具体环节', recoverable: false, retryable: false },
});

/**
 * 构造一个带四件套的 Error。
 *
 * 返回真正的 Error（而不是普通对象），这样 `throw`、`instanceof Error`、
 * stack 抓取、以及所有既有 `err?.message` 读法都照旧可用。
 *
 * @param {string} code - 错误码，建议取自 CODES
 * @param {string} message - 面向用户的一句话（中文）
 * @param {object} [extra]
 * @param {string} [extra.hint] - 覆盖默认提示
 * @param {boolean} [extra.recoverable] - 覆盖默认可恢复性
 * @param {boolean} [extra.retryable] - 覆盖默认可重试性
 * @param {Error|*} [extra.cause] - 原始错误，保留供日志/审计使用
 * @param {object} [extra.details] - 附加上下文（会被审计层脱敏后落盘）
 * @returns {Error & {code:string, hint:string, recoverable:boolean, retryable:boolean}}
 */
function khyError(code, message, extra = {}) {
  // An unregistered code is kept verbatim — the caller may be using a domain code
  // not yet in CODES, and rewriting it to UNKNOWN would throw away the only
  // locating information the error carries. Only the advisory triple falls back.
  const key = typeof code === 'string' && code ? code : 'UNKNOWN';
  const spec = CODES[key] || CODES.UNKNOWN;
  const err = new Error(String(message || spec.hint || key));
  err.code = key;
  err.hint = extra.hint != null ? String(extra.hint) : spec.hint;
  err.recoverable = extra.recoverable != null ? !!extra.recoverable : !!spec.recoverable;
  err.retryable = extra.retryable != null ? !!extra.retryable : !!spec.retryable;
  err.isKhyError = true;
  if (extra.cause !== undefined) {
    err.cause = extra.cause;
  }
  if (extra.details !== undefined) {
    err.details = extra.details;
  }
  return err;
}

/**
 * 是否已经是四件套错误。
 * @param {*} err
 * @returns {boolean}
 */
function isKhyError(err) {
  return !!(err && err.isKhyError === true && typeof err.code === 'string');
}

/**
 * 把任意 throw 出来的东西规整成四件套，原样透传已经合规的。
 *
 * @param {*} err - Error / 字符串 / 任意值
 * @param {string} [fallbackCode='UNKNOWN'] - 无法判定时使用的错误码
 * @param {object} [extra] - 同 khyError 的 extra
 * @returns {Error & {code:string, hint:string, recoverable:boolean, retryable:boolean}}
 */
function toKhyError(err, fallbackCode = 'UNKNOWN', extra = {}) {
  if (isKhyError(err)) {
    return err;
  }
  const raw = err && err.message ? String(err.message) : String(err == null ? '' : err);
  // Node 自己的 code 优先于调用方给的 fallback：ENOENT/EACCES 之类比 'UNKNOWN' 信息量大。
  const guessed = _guessCode(err) || fallbackCode;
  return khyError(guessed, raw || guessed, { cause: err, ...extra });
}

/** 从原生错误的 code/message 推断已登记的错误码；推断不出返回 null。 */
function _guessCode(err) {
  const nodeCode = err && typeof err.code === 'string' ? err.code.toUpperCase() : '';
  if (nodeCode === 'MODULE_NOT_FOUND') {
    return 'MODULE_NOT_FOUND';
  }
  if (nodeCode === 'EACCES' || nodeCode === 'EPERM') {
    return 'PERMISSION_DENIED';
  }
  if (/^E(NOENT|EXIST|ISDIR|NOTDIR|NOSPC|MFILE|BUSY|XDEV)$/.test(nodeCode)) {
    return 'IO_FAILED';
  }
  if (nodeCode.startsWith('ETIMEDOUT') || nodeCode === 'ABORT_ERR') {
    return 'TIMEOUT';
  }
  if (nodeCode.startsWith('ECONN') || nodeCode === 'ENOTFOUND' || nodeCode === 'EHOSTUNREACH') {
    return 'NETWORK_UNREACHABLE';
  }
  return null;
}

/**
 * 渲染成一行面向用户的文本：`出了什么事（提示：下一步）`。
 *
 * 只负责拼字符串，不负责打印 —— 调用方决定用 printError 还是 printWarn，
 * 也由调用方负责补上「动作 + 目标 + 进度」里的进度量（第 n 次 / n/m / 百分比），
 * 因为只有调用方知道自己进行到哪一步。
 *
 * @param {*} err
 * @returns {string}
 */
function formatKhyError(err) {
  const e = toKhyError(err);
  const hint = e.hint ? `（提示：${e.hint}）` : '';
  return `${e.message}${hint}`;
}

module.exports = { khyError, isKhyError, toKhyError, formatKhyError, CODES, _internals: { _guessCode } };
