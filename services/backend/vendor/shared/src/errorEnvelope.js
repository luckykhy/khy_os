'use strict';

/**
 * errorEnvelope.js — KhyError HTTP 序列化与前端归类（共享层）。
 *
 * 设计目标：
 *   1. 单一 JSON schema —— 后端 Express errorHandler 与前端 axios 拦截器 / Vue notify /
 *      khy-mobile errorNotify store 共用，避免「success/message/error 字段含义漂移」。
 *   2. 纯叶子 —— 零依赖，仅依赖 ./utils/classifyKhyError.js 的归类能力，
 *      让它可以被任何平台（CLI / Node / Browser）require。
 *   3. 向前兼容 —— 老代码用 `{success:false, message, requestId}` 仍可被解析；
 *      缺字段时默认 fallback 到 UNKNOWN。
 *
 * Envelope shape（JSON wire format）：
 *   {
 *     success: false,
 *     error: {
 *       code:     "AUTH_REQUIRED",
 *       message:  "请先登录或配置 API Key",
 *       hint:     "检查 API Key 是否已设置",
 *       category: "auth",
 *       severity: "error",
 *       recoverable: true,
 *       retryable:    true,
 *       actionable:   true,
 *       suggestions: ["前往设置页填写 API Key"],
 *       requestId:    "req_abc123",
 *       cause:        { ... }    // 仅 server 模式（NODE_ENV !== production）才输出
 *     }
 *   }
 *
 * 单一真源：`@khy/shared/src/errorEnvelope.js`。
 * 后端：services/backend/src/middleware/errorHandler.js 调用 `toEnvelope(err, req)` 出 JSON。
 * 前端：apps/ai-frontend/src/api/notify.js + apps/khy-mobile/src/stores/errorNotify.js
 *       调用 `fromEnvelope(json)` 或直接 `classifyKhyError(rawError)` 把任意输入规整。
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
  INTERNAL:                  { hint: '内部异常，请联系开发组', category: 'internal', severity: 'fatal',  recoverable: false, retryable: false },
  UNKNOWN:                   { hint: '查看上一条日志定位具体环节', category: 'unknown',  severity: 'error',  recoverable: false, retryable: false },
});

const STATUS_TABLE = Object.freeze({
  400: { code: 'INVALID_ARGUMENT', category: 'user',     severity: 'warn'   },
  401: { code: 'AUTH_REQUIRED',   category: 'auth',     severity: 'error'  },
  403: { code: 'PERMISSION_DENIED', category: 'auth',   severity: 'error'  },
  404: { code: 'MODEL_NOT_FOUND', category: 'upstream', severity: 'warn'   },
  408: { code: 'TIMEOUT',         category: 'network',  severity: 'warn'   },
  413: { code: 'CONTEXT_TOO_LONG', category: 'upstream', severity: 'warn'  },
  429: { code: 'RATE_LIMITED',    category: 'upstream', severity: 'warn'   },
  500: { code: 'UPSTREAM_5XX',    category: 'upstream', severity: 'warn'   },
  502: { code: 'UPSTREAM_5XX',    category: 'upstream', severity: 'warn'   },
  503: { code: 'MODEL_OVERLOADED', category: 'upstream', severity: 'warn'  },
  504: { code: 'TIMEOUT',         category: 'network',  severity: 'warn'   },
});

const ERRNO_TABLE = Object.freeze({
  EACCES:       { code: 'PERMISSION_DENIED', category: 'auth',    severity: 'error' },
  EPERM:        { code: 'PERMISSION_DENIED', category: 'auth',    severity: 'error' },
  ENOENT:       { code: 'IO_FAILED',        category: 'io',      severity: 'error' },
  EEXIST:       { code: 'IO_FAILED',        category: 'io',      severity: 'error' },
  EISDIR:       { code: 'IO_FAILED',        category: 'io',      severity: 'error' },
  ENOTDIR:      { code: 'IO_FAILED',        category: 'io',      severity: 'error' },
  ENOSPC:       { code: 'IO_FAILED',        category: 'resource', severity: 'fatal' },
  EMFILE:       { code: 'IO_FAILED',        category: 'resource', severity: 'fatal' },
  EBUSY:        { code: 'IO_FAILED',        category: 'io',      severity: 'error' },
  EXDEV:        { code: 'IO_FAILED',        category: 'io',      severity: 'error' },
  EADDRINUSE:   { code: 'PORT_IN_USE',      category: 'config',  severity: 'warn'  },
  EALREADY:     { code: 'IO_FAILED',        category: 'io',      severity: 'error' },
  ETIMEDOUT:    { code: 'TIMEOUT',          category: 'network', severity: 'warn'  },
  ECONNRESET:   { code: 'NETWORK_UNREACHABLE', category: 'network', severity: 'error' },
  ECONNREFUSED: { code: 'NETWORK_UNREACHABLE', category: 'network', severity: 'error' },
  ENOTFOUND:    { code: 'DNS_FAILED',       category: 'network', severity: 'error' },
  EHOSTUNREACH: { code: 'NETWORK_UNREACHABLE', category: 'network', severity: 'error' },
  EAI_AGAIN:    { code: 'DNS_FAILED',       category: 'network', severity: 'error' },
  ABORT_ERR:    { code: 'TIMEOUT',          category: 'network', severity: 'warn'  },
  ERR_IPC_CHANNEL_CLOSED: { code: 'NETWORK_UNREACHABLE', category: 'network', severity: 'error' },
});

const NAME_TABLE = Object.freeze({
  AbortError:           { category: 'network',  severity: 'warn'  },
  TimeoutError:         { category: 'network',  severity: 'warn'  },
  URIError:             { category: 'user',     severity: 'warn'  },
  SyntaxError:          { category: 'internal', severity: 'fatal' },
  TypeError:            { category: 'internal', severity: 'fatal' },
  RangeError:           { category: 'internal', severity: 'fatal' },
  ReferenceError:       { category: 'internal', severity: 'fatal' },
  AssertionError:       { category: 'internal', severity: 'fatal' },
  EvalError:            { category: 'internal', severity: 'fatal' },
});

const MESSAGE_TABLE = [
  [/\bCORS\b|cross[- ]?origin|blocked by CORS/i,
    { code: 'CORS_BLOCKED', category: 'network', severity: 'error' }],
  [/context[_ ]?(length|window|too[_ ]?long)|prompt[_ ]?is[_ ]?too[_ ]?long|maximum[_ ]?context/i,
    { code: 'CONTEXT_TOO_LONG', category: 'upstream', severity: 'warn' }],
  [/rate[_ ]?limit|too[_ ]?many[_ ]?requests/i,
    { code: 'RATE_LIMITED', category: 'upstream', severity: 'warn' }],
  [/model[_ ]?not[_ ]?found|unknown[_ ]?model|invalid[_ ]?model/i,
    { code: 'MODEL_NOT_FOUND', category: 'upstream', severity: 'warn' }],
  [/overloaded|capacity|server[_ ]?busy/i,
    { code: 'MODEL_OVERLOADED', category: 'upstream', severity: 'warn' }],
  [/billing|quota[_ ]?exceeded|payment[_ ]?required/i,
    { code: 'BILLING_REQUIRED', category: 'upstream', severity: 'warn' }],
  [/refus(e|al)|content[_ ]?policy|safety[_ ]?filter/i,
    { code: 'MODEL_REFUSAL', category: 'upstream', severity: 'warn' }],
  [/pair(ing)?[_ ]?(code|expired)|session[_ ]?expired/i,
    { code: 'PAIRING_EXPIRED', category: 'auth', severity: 'warn' }],
  [/api[_ ]?key|invalid[_ ]?key|missing[_ ]?key/i,
    { code: 'AUTH_INVALID', category: 'auth', severity: 'error' }],
  [/EADDRINUSE|port[_ ]?already[_ ]?in[_ ]?use/i,
    { code: 'PORT_IN_USE', category: 'config', severity: 'warn' }],
  [/out[_ ]?of[_ ]?memory|ENOMEM/i,
    { code: 'OOM', category: 'resource', severity: 'fatal' }],
];

// ⚠️ CATEGORIES / SEVERITIES / SUB_CATEGORIES 是与 backend khyErrorCategory.js 完全平行的
// 镜像 —— frontend 用 ESM 不能 require CommonJS 包。两边必须保持同步。
const CATEGORIES = Object.freeze({
  USER:      { code: 'user',     label: '用户输入',     defaultSeverity: 'warn',   recoverable: true,  retryable: false },
  CONFIG:    { code: 'config',   label: '配置问题',     defaultSeverity: 'warn',   recoverable: true,  retryable: false },
  AUTH:      { code: 'auth',     label: '鉴权失败',     defaultSeverity: 'error',  recoverable: false, retryable: true  },
  NETWORK:   { code: 'network',  label: '网络层',       defaultSeverity: 'error',  recoverable: true,  retryable: true  },
  UPSTREAM:  { code: 'upstream', label: '上游服务',     defaultSeverity: 'warn',   recoverable: true,  retryable: true  },
  IO:        { code: 'io',       label: '本地IO',       defaultSeverity: 'error',  recoverable: false, retryable: true  },
  RESOURCE:  { code: 'resource', label: '系统资源',     defaultSeverity: 'fatal',  recoverable: false, retryable: false },
  INTERNAL:  { code: 'internal', label: '内部错误',     defaultSeverity: 'fatal',  recoverable: false, retryable: false },
  UNKNOWN:   { code: 'unknown',  label: '未分类',       defaultSeverity: 'error',  recoverable: false, retryable: false },
});

const SEVERITIES = Object.freeze({
  SILENT: { code: 'silent', rank: 0, label: 'silent',  icon: '',    color: 'dim'    },
  INFO:   { code: 'info',   rank: 1, label: 'info',    icon: 'ℹ',   color: 'blue'   },
  WARN:   { code: 'warn',   rank: 2, label: 'warn',    icon: '⚠',   color: 'yellow' },
  ERROR:  { code: 'error',  rank: 3, label: 'error',   icon: '✗',   color: 'red'    },
  FATAL:  { code: 'fatal',  rank: 4, label: 'fatal',   icon: '✗',   color: 'red.bold' },
});

function getCategorySpec(categoryCode) {
  if (typeof categoryCode !== 'string') return CATEGORIES.UNKNOWN;
  return CATEGORIES[categoryCode.toUpperCase()] || CATEGORIES.UNKNOWN;
}

function getSeveritySpec(severityCode) {
  if (typeof severityCode !== 'string') return SEVERITIES.ERROR;
  return SEVERITIES[severityCode.toUpperCase()] || SEVERITIES.ERROR;
}

function getSubCategory(code) {
  if (typeof code !== 'string') return null;
  const spec = CODES[code.toUpperCase()];
  if (!spec) return null;
  return { code: code.toUpperCase(), category: spec.category, severity: spec.severity };
}

function _extractStatus(err) {
  if (!err) return null;
  const direct = Number(err.status ?? err.statusCode);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const resp = err.response && (err.response.status ?? err.response.statusCode);
  const n = Number(resp);
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}

function _extractNodeCode(err) {
  if (!err || typeof err.code !== 'string') return null;
  return err.code.toUpperCase();
}

function _tryTable(table, key) {
  if (key == null) return null;
  return table[String(key).toUpperCase()] || table[key] || null;
}

function _scanMessage(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  for (const [re, hit] of MESSAGE_TABLE) {
    if (re.test(raw)) return hit;
  }
  return null;
}

/**
 * 完整归类 —— 共享给后端与前端的单一真源。永远返回 KhyErrorShape。
 * @param {*} err
 * @param {object} [opts]
 * @param {string} [opts.fallbackCode='UNKNOWN']
 * @returns {Error & KhyErrorShape}
 */
function classifyKhyError(err, opts = {}) {
  const fallbackCode = typeof opts.fallbackCode === 'string' ? opts.fallbackCode : 'UNKNOWN';

  // 已经是 envelope/error.shape（带 isKhyError / category+severity）→ 原样透传
  if (err && err.isKhyError === true && typeof err.code === 'string') return err;

  const rawMessage = (err && err.message) ? String(err.message)
    : (err == null ? '' : String(err));
  const status = _extractStatus(err);
  const nodeCode = _extractNodeCode(err);

  if (status != null && STATUS_TABLE[status]) {
    const hit = STATUS_TABLE[status];
    const sub = getSubCategory(hit.code);
    return _mkEnv(hit.code, rawMessage || hit.code, {
      cause: err,
      category: sub ? sub.category : hit.category,
      severity: sub ? sub.severity : hit.severity,
    });
  }
  if (nodeCode && ERRNO_TABLE[nodeCode]) {
    const hit = ERRNO_TABLE[nodeCode];
    const sub = getSubCategory(hit.code);
    return _mkEnv(hit.code, rawMessage || hit.code, {
      cause: err,
      category: sub ? sub.category : hit.category,
      severity: sub ? sub.severity : hit.severity,
    });
  }
  if (err && typeof err.name === 'string' && NAME_TABLE[err.name]) {
    const hit = NAME_TABLE[err.name];
    return _mkEnv(fallbackCode, rawMessage || fallbackCode, {
      cause: err,
      category: hit.category,
      severity: hit.severity,
    });
  }
  const msgHit = _scanMessage(rawMessage);
  if (msgHit) {
    const sub = getSubCategory(msgHit.code);
    return _mkEnv(msgHit.code, rawMessage || msgHit.code, {
      cause: err,
      category: sub ? sub.category : msgHit.category,
      severity: sub ? sub.severity : msgHit.severity,
    });
  }
  return _mkEnv(fallbackCode, rawMessage || fallbackCode, { cause: err });
}

function _mkEnv(code, message, extra = {}) {
  const key = typeof code === 'string' && code ? code : 'UNKNOWN';
  const spec = CODES[key] || CODES.UNKNOWN;
  const err = new Error(String(message || spec.hint || key));
  err.code = key;
  err.hint = spec.hint;
  err.recoverable = !!spec.recoverable;
  err.retryable = !!spec.retryable;
  err.category = extra.category || spec.category;
  err.severity = extra.severity || spec.severity;
  err.actionable = true;
  err.isKhyError = true;
  if (extra.cause !== undefined) err.cause = extra.cause;
  return err;
}

/**
 * 兜底规整：保证所有字段都填齐，给渲染层一个「非空保证」。
 */
function ensureKhyError(err, opts = {}) {
  const enriched = classifyKhyError(err, opts);
  if (!enriched.category) enriched.category = getCategorySpec().code;
  if (!enriched.severity) enriched.severity = getSeveritySpec().code;
  return enriched;
}

/**
 * 把任意错误装进 envelope JSON。后端 errorHandler 用。
 * @param {*} err
 * @param {object} [opts]
 * @param {string} [opts.requestId]
 * @param {boolean} [opts.includeCause] - 是否带 cause（仅 dev 模式）
 * @returns {{success: false, error: KhyErrorEnvelope}}
 */
function toEnvelope(err, opts = {}) {
  const env = ensureKhyError(err);
  const errorObj = {
    code: env.code,
    message: env.message,
    hint: env.hint,
    category: env.category,
    severity: env.severity,
    recoverable: !!env.recoverable,
    retryable: !!env.retryable,
    actionable: env.actionable !== false,
  };
  if (Array.isArray(env.suggestions) && env.suggestions.length) {
    errorObj.suggestions = env.suggestions.slice();
  }
  if (opts.requestId) errorObj.requestId = String(opts.requestId);
  if (opts.includeCause && env.cause) errorObj.cause = _safeCause(env.cause);
  return { success: false, error: errorObj };
}

/**
 * 把 envelope JSON 反解为 KhyErrorShape。前端 axios 拦截器 / SSE 错误解析用。
 * 接受任何「长得像 envelope」的输入 —— 字段缺失时按 fallback 补齐。
 *
 * @param {*} json
 * @returns {Error & KhyErrorShape}
 */
function fromEnvelope(json) {
  if (!json || typeof json !== 'object') {
    return _mkEnv('UNKNOWN', 'malformed envelope');
  }
  // 后端信封：{success:false, error:{...}}
  // 老格式：{success:false, message, requestId} —— 兼容
  const e = (json.error && typeof json.error === 'object') ? json.error : json;
  const code = typeof e.code === 'string' ? e.code : 'UNKNOWN';
  const message = String(e.message || e.error || code);
  const sub = getSubCategory(code);
  return _mkEnv(code, message, {
    category: sub ? sub.category : (e.category || 'unknown'),
    severity: sub ? sub.severity : (e.severity || 'error'),
  });
}

function _safeCause(cause) {
  // 只导出可序列化的字段，避免把原始 Error 对象扔进 JSON。
  if (!cause) return null;
  if (typeof cause === 'string') return { message: cause };
  if (typeof cause !== 'object') return { message: String(cause) };
  return {
    message: cause.message ? String(cause.message) : undefined,
    code: cause.code ? String(cause.code) : undefined,
    status: cause.status || cause.statusCode,
  };
}

module.exports = {
  // 分类与规整
  classifyKhyError,
  ensureKhyError,
  fromEnvelope,
  toEnvelope,
  // 元数据查询
  getCategorySpec,
  getSeveritySpec,
  getSubCategory,
  // 内部表
  CODES,
  STATUS_TABLE,
  ERRNO_TABLE,
  NAME_TABLE,
  MESSAGE_TABLE,
  CATEGORIES,
  SEVERITIES,
};