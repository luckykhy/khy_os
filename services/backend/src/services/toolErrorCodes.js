'use strict';

/**
 * toolErrorCodes —— 纯叶子(pure leaf):外部依赖工具的「错误分类」单一真源。
 *
 * 契约:零 IO(不碰 fs/网络/子进程)、确定性、单一真源(语义分类只在本文件)、
 * env 门控默认开(`KHY_TOOL_ERROR_CODES`,仅 0/false/off/no 关闭即字节回退既有结果)、
 * fail-soft 绝不抛。
 *
 * 背景(经源码核实):image_generate/video_generate/imageEdit 等外部依赖工具各自就地
 * 硬编码扁平 `code`(NO_BACKEND/BACKEND_ERROR/TIMEOUT/GENERATION_FAILED/...),
 * webSearch/news 则只有 `depId`、无 `code`。调用方因此难以「区分配置缺失 vs 服务不可用」
 * 做条件分支(P2#5 诉求)。本叶子**不改既有 `code` 取值**(保持向后兼容),只在其上派生
 * 一层稳定的**语义分类** `errorClass` 与 `retryable` 布尔,供调用方据此分支重试/提示。
 *
 * 零假阳性底线:未知 `code` 且无 `depId` → 归 `UNKNOWN`(绝不臆测成 SERVICE_UNAVAILABLE),
 * 让调用方保守处理。瞬时类(SERVICE_UNAVAILABLE)才标 retryable=true。
 */

function _enabled() {
  const v = String(process.env.KHY_TOOL_ERROR_CODES || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 语义错误分类(稳定枚举,供调用方分支)。
 *   CONFIG_MISSING       —— 未配置后端/缺 API key/缺连接串:用户需先配置(不可重试)。
 *   SERVICE_UNAVAILABLE  —— 上游错误/网络/超时/生成失败:外部服务暂不可用(可重试)。
 *   BAD_PARAM            —— 入参非法:调用方应修正参数(不可重试)。
 *   UNSUPPORTED          —— 当前后端不支持该操作(不可重试)。
 *   MISSING_DEPENDENCY   —— 运行时依赖缺失(如 cheerio/playwright/DB 驱动):需安装(配置类)。
 *   UNKNOWN              —— 无法确定(零假阳性兜底)。
 */
const ERROR_CLASS = Object.freeze({
  CONFIG_MISSING: 'CONFIG_MISSING',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  BAD_PARAM: 'BAD_PARAM',
  UNSUPPORTED: 'UNSUPPORTED',
  MISSING_DEPENDENCY: 'MISSING_DEPENDENCY',
  UNKNOWN: 'UNKNOWN',
});

/**
 * 既有扁平 `code` → 语义分类的单一真源映射(键为归一化小写)。
 * 新增工具就地 code 时,在此登记其语义归属,而非另起一套。
 */
const CODE_TO_CLASS = Object.freeze({
  // 配置缺失
  no_backend: ERROR_CLASS.CONFIG_MISSING,
  config_missing: ERROR_CLASS.CONFIG_MISSING,
  not_configured: ERROR_CLASS.CONFIG_MISSING,
  // 服务不可用(可重试)
  backend_error: ERROR_CLASS.SERVICE_UNAVAILABLE,
  service_unavailable: ERROR_CLASS.SERVICE_UNAVAILABLE,
  timeout: ERROR_CLASS.SERVICE_UNAVAILABLE,
  network_error: ERROR_CLASS.SERVICE_UNAVAILABLE,
  generation_failed: ERROR_CLASS.SERVICE_UNAVAILABLE,
  download_failed: ERROR_CLASS.SERVICE_UNAVAILABLE,
  // 入参非法
  bad_param: ERROR_CLASS.BAD_PARAM,
  bad_input_image: ERROR_CLASS.BAD_PARAM,
  invalid_input: ERROR_CLASS.BAD_PARAM,
  invalid_args: ERROR_CLASS.BAD_PARAM,
  // 不支持
  edit_unsupported: ERROR_CLASS.UNSUPPORTED,
  unsupported: ERROR_CLASS.UNSUPPORTED,
  // 依赖缺失
  missing_dependency: ERROR_CLASS.MISSING_DEPENDENCY,
});

/** 哪些语义分类值得调用方重试(瞬时类)。 */
const RETRYABLE_CLASSES = Object.freeze(new Set([ERROR_CLASS.SERVICE_UNAVAILABLE]));

/**
 * 把一个失败的 `code`(及可选 `depId`)归到语义分类。
 *
 * @param {string} [code]      工具就地返回的扁平 code
 * @param {{depId?:string}} [opts]
 * @returns {string} ERROR_CLASS 之一(未知 → UNKNOWN)
 */
function classify(code, opts = {}) {
  try {
    const key = String(code == null ? '' : code).trim().toLowerCase();
    if (key && Object.prototype.hasOwnProperty.call(CODE_TO_CLASS, key)) {
      return CODE_TO_CLASS[key];
    }
    // 无可识别 code,但带依赖自愈标识 → 依赖缺失(配置类)。
    if (opts && opts.depId) return ERROR_CLASS.MISSING_DEPENDENCY;
    return ERROR_CLASS.UNKNOWN; // 零假阳性:绝不臆测
  } catch {
    return ERROR_CLASS.UNKNOWN; // fail-soft
  }
}

/**
 * 给定语义分类或原始 code,判断是否值得重试。
 * @param {string} classOrCode
 * @returns {boolean}
 */
function isRetryable(classOrCode) {
  try {
    const s = String(classOrCode || '');
    if (RETRYABLE_CLASSES.has(s)) return true;
    return RETRYABLE_CLASSES.has(classify(s));
  } catch {
    return false;
  }
}

/**
 * 在既有失败结果对象上**叠加**语义分类,不改原有字段(向后兼容、可字节回退)。
 *
 * 仅当:门控开 && result 是对象 && result.success === false && 尚无 errorClass 时,
 * 浅克隆并补 `errorClass`(语义分类)与 `retryable`(布尔)。其余一律原样返回(同引用)。
 *
 * @param {object} result   工具的失败结果(形如 {success:false, code?, depId?, error, content, meta})
 * @returns {object}
 */
function enrich(result) {
  if (!_enabled()) return result;
  try {
    if (!result || typeof result !== 'object') return result;
    if (result.success !== false) return result;
    if (result.errorClass) return result; // 已有则不覆盖(单一真源由首个写入者决定)
    const errorClass = classify(result.code, { depId: result.depId });
    return { ...result, errorClass, retryable: RETRYABLE_CLASSES.has(errorClass) };
  } catch {
    return result; // fail-soft:绝不阻断工具返回
  }
}

module.exports = {
  ERROR_CLASS,
  CODE_TO_CLASS,
  classify,
  isRetryable,
  enrich,
  _enabled,
};
