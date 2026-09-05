'use strict';

/**
 * errorContract.js — 错误契约标准化：统一错误形状 + 工厂函数。
 *
 * 为什么存在:网关层有多个错误分类器(errorClassifier / _errorClassifiers / chatErrorGuard),
 * 返回形状各异({finalResponse, errorType} vs {kind, retryable} vs {code, message})。
 * 本模块收敛为唯一契约,让调用方可以统一处理。
 *
 * 契约 (CONTRACT):纯叶子 + 零 IO + 确定性 + 绝不抛。
 *
 * 标准错误形状:
 *   {
 *     ok: false,
 *     error: {
 *       code: 'E01' | 'E02' | ...,
 *       type: 'parse_error' | 'network' | 'timeout' | ...,
 *       message: string,           // 用户可读中文消息
 *       retryable: boolean,
 *       cause?: Error,             // 原始错误(可选)
 *     }
 *   }
 *
 * 与既有件的关系:
 *   - chatErrorGuard.js 的输出可通过 normalizeChatErrorResult() 转换为本契约
 *   - errorClassifier.js 的分类结果可通过 fromClassifierResult() 转换
 *   - selfHealingWrapper.js 使用本契约的 retryable 字段决定是否重试
 */

// 错误码表 — 与 failsafe/errorCodes.js 对齐
const ERROR_CODES = {
  E01: 'unexpected_silence',    // 模型静默空响应
  E02: 'content_filter',        // 模型强制中断(内容安全)
  E03: 'context_overflow',      // 上下文溢出
  E04: 'tool_crash',            // 工具执行崩溃
  E05: 'missing_dependency',    // 依赖缺失阻断
  E06: 'network_breaker',       // 网络层熔断
  E07: 'permission_denied',     // 权限拦截
  E08: 'schema_validation',     // 格式校验失败
};

// 错误类型集合
const ERROR_TYPES = new Set([
  'parse_error',
  'network',
  'timeout',
  'auth',
  'rate_limit',
  'overloaded',
  'server_error',
  'cancelled',
  'empty',
  'refusal',
  'context_length',
  'model_not_found',
  'permission',
  'billing',
  'unexpected_error',
]);

/**
 * 创建标准错误结果。
 * @param {string} type - 错误类型
 * @param {string} message - 用户可读消息
 * @param {object} [opts]
 * @param {string} [opts.code] - 错误码(E01-E08)
 * @param {boolean} [opts.retryable] - 是否可重试
 * @param {Error} [opts.cause] - 原始错误
 * @returns {{ok:false, error:{code,type,message,retryable,cause?}}}
 */
function createErrorResult(type, message, opts = {}) {
  const retryable = opts.retryable != null ? opts.retryable : isRetryableType(type);
  return {
    ok: false,
    error: {
      code: opts.code || typeToCode(type),
      type: type || 'unexpected_error',
      message: String(message || '未知错误'),
      retryable,
      ...(opts.cause ? { cause: opts.cause } : {}),
    },
  };
}

/**
 * 创建标准成功结果。
 * @param {*} data - 成功数据
 * @returns {{ok:true, data}}
 */
function createSuccessResult(data) {
  return { ok: true, data };
}

/**
 * 判断错误类型是否可重试。
 * @param {string} type
 * @returns {boolean}
 */
function isRetryableType(type) {
  const retryableTypes = new Set([
    'parse_error',
    'network',
    'timeout',
    'server_error',
    'rate_limit',
    'overloaded',
    'empty',
  ]);
  return retryableTypes.has(type);
}

/**
 * 错误类型 → 错误码映射。
 * @param {string} type
 * @returns {string}
 */
function typeToCode(type) {
  const map = {
    parse_error: 'E08',
    network: 'E06',
    timeout: 'E06',
    auth: 'E02',
    rate_limit: 'E06',
    overloaded: 'E06',
    server_error: 'E06',
    cancelled: 'E02',
    empty: 'E01',
    refusal: 'E02',
    context_length: 'E03',
    model_not_found: 'E05',
    permission: 'E07',
    billing: 'E02',
  };
  return map[type] || 'E01';
}

/**
 * 将 chatErrorGuard 的输出转换为标准契约。
 * @param {{finalResponse:string, errorType:string, errorCode:string, retryable?:boolean, message:string}} guardResult
 * @returns {{ok:false, error:object}}
 */
function fromChatErrorResult(guardResult) {
  if (!guardResult) {
    return createErrorResult('unexpected_error', '未知错误');
  }
  return {
    ok: false,
    error: {
      code: guardResult.errorCode || 'E01',
      type: guardResult.errorType || 'unexpected_error',
      message: guardResult.finalResponse || guardResult.message || '未知错误',
      retryable: guardResult.retryable != null ? guardResult.retryable : isRetryableType(guardResult.errorType),
      ...(guardResult.message ? { detail: guardResult.message } : {}),
    },
  };
}

/**
 * 将 errorClassifier 的分类结果转换为标准契约。
 * @param {{kind:string, retryable:boolean, message?:string}} classifierResult
 * @returns {{ok:false, error:object}}
 */
function fromClassifierResult(classifierResult) {
  if (!classifierResult) {
    return createErrorResult('unexpected_error', '未知错误');
  }
  return createErrorResult(
    classifierResult.kind || 'unexpected_error',
    classifierResult.message || classifierResult.kind || '未知错误',
    {
      retryable: classifierResult.retryable,
    }
  );
}

/**
 * 检查对象是否符合标准错误契约。
 * @param {*} obj
 * @returns {boolean}
 */
function isStandardError(obj) {
  return !!(
    obj &&
    obj.ok === false &&
    obj.error &&
    typeof obj.error === 'object' &&
    obj.error.code &&
    obj.error.type &&
    typeof obj.error.retryable === 'boolean'
  );
}

module.exports = {
  ERROR_CODES,
  ERROR_TYPES,
  createErrorResult,
  createSuccessResult,
  isRetryableType,
  typeToCode,
  fromChatErrorResult,
  fromClassifierResult,
  isStandardError,
};
