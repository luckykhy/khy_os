'use strict';

/**
 * khyError.js — 结构化错误七件套的单一真源（纯叶子）。
 *
 * 每个错误对外必须回答四个问题（向后兼容部分）：
 *   code        机器可读的稳定标识（用于分类、统计、审计）
 *   message     出了什么事（面向用户，中文）
 *   hint        下一步怎么办（面向用户，中文；空字符串视为未定义提示 = bug）
 *   recoverable 调用方是否有降级路径可走（true = 功能降级但不中断）
 *   retryable   原样重试是否可能成功（true = 值得退避重试；false = 重试必然同样失败）
 *
 * 新增三件套（v2，向后兼容，旧调用方不感知）：
 *   category    错误分类（user / config / auth / upstream / network / io /
 *               resource / internal / unknown）。见 khyErrorCategory.js。
 *   severity    渲染形态（silent / info / warn / error / fatal）。
 *               不由调用方传，从 category + recoverable 派生。
 *   actionable  是否给出具体下一步（true = 给出 suggestion[]；false = 只说事实）。
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
 *   - 不做精确分类推理，那是 `src/utils/classifyKhyError.js`；
 *     这里只负责把已确定的 category/severity 落到 err 上。
 */

/**
 * 已登记的错误码 → 默认提示与可恢复/可重试语义。
 * 未登记的 code 也允许使用（调用方自带 hint），只是拿不到默认提示。
 *
 * 每个条目带 category（user/config/auth/network/upstream/io/resource/internal/unknown）
 * 和 severity（silent/info/warn/error/fatal）。severity 可被调用方在 extra.severity 覆盖，
 * 但默认从 code + 类别推导，不再由调用方拍脑袋决定。
 */
const CODES = Object.freeze({
  MODULE_NOT_FOUND:          { hint: '检查依赖安装或路径配置',     category: 'config',   severity: 'warn',   recoverable: true,  retryable: false },
  CONFIG_INVALID:            { hint: '检查环境变量取值范围，或删除该项回退默认值', category: 'config',   severity: 'warn',   recoverable: true,  retryable: false },
  CONFIG_MISSING:            { hint: '在配置文件或环境变量里补齐该项', category: 'config',   severity: 'warn',   recoverable: true,  retryable: false },
  PORT_IN_USE:               { hint: '指定端口被占用，自动顺延到下一个可用端口', category: 'config',   severity: 'warn',   recoverable: true,  retryable: false },
  IO_FAILED:                 { hint: '检查目标路径是否存在、是否只读、磁盘是否已满', category: 'io',       severity: 'error',  recoverable: false, retryable: true },
  PERMISSION_DENIED:         { hint: '该操作需要你显式授权，重新执行并选择允许', category: 'auth',     severity: 'error',  recoverable: false, retryable: false },
  AUTH_REQUIRED:             { hint: '请先登录或配置 API Key',      category: 'auth',     severity: 'error',  recoverable: true,  retryable: true  },
  AUTH_INVALID:              { hint: 'API Key 或凭据失效，重新填写后再试', category: 'auth',     severity: 'error',  recoverable: true,  retryable: false },
  PAIRING_EXPIRED:           { hint: '配对码已过期，在主端生成新码后重新配对', category: 'auth',     severity: 'warn',   recoverable: true,  retryable: true  },
  TIMEOUT:                   { hint: '目标端长时间无响应，稍后重试或换用更快的模型/端点', category: 'network',  severity: 'warn',   recoverable: true,  retryable: true  },
  NETWORK_UNREACHABLE:       { hint: '检查端点地址与本机网络，或改用本地模型', category: 'network',  severity: 'error',  recoverable: true,  retryable: true  },
  DNS_FAILED:                { hint: '域名解析失败，检查 DNS 设置或换个端点', category: 'network',  severity: 'error',  recoverable: true,  retryable: true  },
  CORS_BLOCKED:              { hint: '浏览器拒绝了跨域请求，确认 Web 端与后端的 origin 配置', category: 'network',  severity: 'error',  recoverable: true,  retryable: false },
  MODEL_CALL_FAILED:         { hint: '检查模型服务是否在线、上下文是否超限', category: 'upstream', severity: 'warn',   recoverable: true,  retryable: true  },
  RATE_LIMITED:              { hint: '上游限流，等几秒再试或换用其他模型', category: 'upstream', severity: 'warn',   recoverable: true,  retryable: true  },
  MODEL_NOT_FOUND:           { hint: '模型标识拼错或已下架，刷新模型列表后重选', category: 'upstream', severity: 'warn',   recoverable: true,  retryable: false },
  CONTEXT_TOO_LONG:          { hint: '上下文超过模型窗口，用 /compact 压缩或换用更大窗口的模型', category: 'upstream', severity: 'warn',   recoverable: true,  retryable: false },
  MODEL_OVERLOADED:          { hint: '上游模型暂忙，稍后自动重试', category: 'upstream', severity: 'warn',   recoverable: true,  retryable: true  },
  MODEL_REFUSAL:             { hint: '模型主动拒答，调整 prompt 或换用其他模型', category: 'upstream', severity: 'warn',   recoverable: true,  retryable: false },
  BILLING_REQUIRED:          { hint: '账户余额不足，前往账单页面充值', category: 'upstream', severity: 'warn',   recoverable: true,  retryable: false },
  UPSTREAM_5XX:              { hint: '上游服务暂时不可用，稍后重试', category: 'upstream', severity: 'warn',   recoverable: true,  retryable: true  },
  // ── 上下文压缩链路 ──────────────────────────────────────────────
  CONTEXT_COMPRESS_SKIPPED:  { hint: '这是有意跳过；若上下文已接近满，用 /compact 手动压缩', category: 'user',     severity: 'info',   recoverable: true,  retryable: true  },
  CONTEXT_SUMMARY_FAILED:    { hint: '摘要模型不可用或输出过短，已退回本地抽取式摘要', category: 'upstream', severity: 'warn',   recoverable: true,  retryable: true  },
  CONTEXT_COMPRESS_FAILED:   { hint: '已降级为尾部截断；换用能力更强的模型可恢复摘要压缩', category: 'upstream', severity: 'warn',   recoverable: true,  retryable: true  },
  CONTEXT_BUDGET_EXCEEDED:   { hint: '上下文仍超预算，已执行硬截断；用 /clear 开新会话可彻底释放', category: 'upstream', severity: 'warn',   recoverable: true,  retryable: false },
  AUDIT_WRITE_FAILED:        { hint: '检查数据目录写权限（KHY_APP_HOME），审计不影响主流程', category: 'io',       severity: 'warn',   recoverable: true,  retryable: true  },
  OOM:                       { hint: '内存耗尽，关闭其他大进程后重试', category: 'resource', severity: 'fatal',  recoverable: false, retryable: false },
  ASSERTION:                 { hint: '内部断言失败，提交 issue 并附上 stack', category: 'internal', severity: 'fatal',  recoverable: false, retryable: false },
  UNHANDLED:                 { hint: '未捕获异常，请把 stack 反馈给开发组', category: 'internal', severity: 'fatal',  recoverable: false, retryable: false },
  INVALID_ARGUMENT:          { hint: '检查参数拼写与取值范围', category: 'user',     severity: 'warn',   recoverable: true,  retryable: false },
  MISSING_REQUIRED:          { hint: '补齐必填参数后再执行', category: 'user',     severity: 'warn',   recoverable: true,  retryable: false },
  COMMAND_NOT_FOUND:         { hint: '用 /help 查看可用命令，或检查拼写', category: 'user',     severity: 'warn',   recoverable: true,  retryable: false },
  UNKNOWN:                   { hint: '查看上一条日志定位具体环节', category: 'unknown',  severity: 'error',  recoverable: false, retryable: false },
});

/**
 * 构造一个带七件套的 Error。
 *
 * 返回真正的 Error（而不是普通对象），这样 `throw`、`instanceof Error`、
 * stack 抓取、以及所有既有 `err?.message` 读法都照旧可用。
 *
 * 字段优先级：extra.X 显式传入 > spec（来自 CODES）默认 > CATEGORIES 默认。
 * 调用方传 extra.category / extra.severity 时表示「我知道我在干嘛」，
 * 否则全部从 spec 自动派生。
 *
 * @param {string} code - 错误码，建议取自 CODES
 * @param {string} message - 面向用户的一句话（中文）
 * @param {object} [extra]
 * @param {string} [extra.hint] - 覆盖默认提示
 * @param {boolean} [extra.recoverable] - 覆盖默认可恢复性
 * @param {boolean} [extra.retryable] - 覆盖默认可重试性
 * @param {string} [extra.category] - 覆盖默认分类（user/config/auth/network/upstream/io/resource/internal/unknown）
 * @param {string} [extra.severity] - 覆盖默认严重度（silent/info/warn/error/fatal）
 * @param {boolean} [extra.actionable] - 是否给出具体下一步；默认 true（hint 视为建议）
 * @param {string[]} [extra.suggestions] - 额外建议列表，追加到 hint 后面
 * @param {Error|*} [extra.cause] - 原始错误，保留供日志/审计使用
 * @param {object} [extra.details] - 附加上下文（会被审计层脱敏后落盘）
 * @returns {Error & KhyErrorShape}
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
  err.category = extra.category != null ? String(extra.category) : (spec.category || 'unknown');
  err.severity = extra.severity != null ? String(extra.severity) : (spec.severity || 'error');
  err.actionable = extra.actionable != null ? !!extra.actionable : true;
  err.isKhyError = true;
  if (Array.isArray(extra.suggestions) && extra.suggestions.length > 0) {
    err.suggestions = extra.suggestions.map((s) => String(s));
  }
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
 * 把任意 throw 出来的东西规整成七件套，原样透传已经合规的。
 *
 * 启发式：先看 err.code → err.name → err.status / err.statusCode → message 关键词，
 * 把没有 category / severity 字段的原生 Error 自动归类。完整归类器见
 * `classifyKhyError.js`；这里只做「轻量版」，避免循环依赖。
 *
 * @param {*} err - Error / 字符串 / 任意值
 * @param {string} [fallbackCode='UNKNOWN'] - 无法判定时使用的错误码
 * @param {object} [extra] - 同 khyError 的 extra
 * @returns {Error & KhyErrorShape}
 */
function toKhyError(err, fallbackCode = 'UNKNOWN', extra = {}) {
  if (isKhyError(err)) {
    return err;
  }
  const raw = err && err.message ? String(err.message) : String(err == null ? '' : err);
  // Node 自己的 code 优先于调用方给的 fallback：ENOENT/EACCES 之类比 'UNKNOWN' 信息量大。
  const guessed = _guessCode(err) || fallbackCode;
  const enriched = _lightClassify(err);
  return khyError(guessed, raw || guessed, {
    cause: err,
    category: enriched.category,
    severity: enriched.severity,
    ...extra,
  });
}

/**
 * 轻量级启发式归类：仅依据 err.code / err.status / 关键词三件套。
 * 不引入 status-code 详细映射表（那是 classifyKhyError.js 的活），
 * 这里只保证原生 Error 落到一个合理的默认 category / severity。
 */
function _lightClassify(err) {
  const nodeCode = (err && typeof err.code === 'string') ? err.code.toUpperCase() : '';
  const status = Number(err && (err.status || err.statusCode));
  if (nodeCode === 'EACCES' || nodeCode === 'EPERM') {
    return { category: 'auth', severity: 'error' };
  }
  if (/^E(NOENT|EXIST|ISDIR|NOTDIR|NOSPC|MFILE|BUSY|XDEV)$/.test(nodeCode)) {
    return { category: 'io', severity: 'error' };
  }
  if (nodeCode.startsWith('ETIMEDOUT') || nodeCode === 'ABORT_ERR') {
    return { category: 'network', severity: 'warn' };
  }
  if (nodeCode.startsWith('ECONN') || nodeCode === 'ENOTFOUND' || nodeCode === 'EHOSTUNREACH') {
    return { category: 'network', severity: 'error' };
  }
  if (status === 401 || status === 403) {
    return { category: 'auth', severity: 'error' };
  }
  if (status === 404) {
    return { category: 'user', severity: 'warn' };
  }
  if (status === 429) {
    return { category: 'upstream', severity: 'warn' };
  }
  if (status >= 500 && status < 600) {
    return { category: 'upstream', severity: 'warn' };
  }
  return { category: 'unknown', severity: 'error' };
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
 * 渲染成一行面向用户的文本：`[分类] 出了什么事（提示：下一步）`。
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
  return `[${e.category}] ${e.message}${hint}`;
}

module.exports = { khyError, isKhyError, toKhyError, formatKhyError, CODES, _internals: { _guessCode } };
