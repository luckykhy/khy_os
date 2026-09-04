'use strict';

/**
 * failsafe/errorCodes.js — 精准归因错误字典（**单一真源**）。
 *
 * 废除"未返回有效回复 / 未知错误 / 请求失败"等模糊文案：所有非正常终止都必须落到
 * E01–E08 之一，并携带该类的**必填字段**。任何对外结构化错误的 reason 文案只能取自
 * 本表（固定、可枚举），detail 才是具体动态信息。
 *
 * 脱敏（sensitive=true）：E02 安全审查 / E07 权限拦截——detail 与 fields 不得泄露
 * 系统 Prompt、内部审批规则、命中的具体安全策略；只告知"触发了某类管控"。
 *
 * 字段约定：
 *   code        唯一错误码 E01..E08
 *   category    归因分类（中文，给人看，固定）
 *   reason      固定 reason 文案（替代模糊废话）
 *   requiredFields 该码必填的附加字段名（缺失即视为归因不完整）
 *   suggestion  默认可操作建议（分类器可按上下文覆盖）
 *   retryable   该类是否值得重试（同一请求原样重发是否有意义）
 *   resumable   该类是否可"续接"：用户说「继续」/系统自动续写能从断点推进。
 *               与 retryable 区分——E05 依赖缺失虽 retryable，但未装依赖前续接无意义，
 *               故 resumable=false；E03 上下文溢出必须先压缩，亦不可直接续接。
 *   continueHint 当 resumable=true 时，给用户的"如何继续"一句话提示（可为空）。
 *   sensitive   是否需脱敏（true → detail/fields 走脱敏白名单）
 */

const ERROR_CODES = {
  E01: {
    code: 'E01',
    category: '模型静默空响应',
    reason: '模型返回空内容',
    requiredFields: ['model', 'prompt_tokens'],
    suggestion: '请重试；若反复出现，请更换模型通道或降低输入复杂度。',
    retryable: true,
    resumable: true,
    continueHint: '输入「继续」即可重试，从断点继续生成。',
    sensitive: false,
  },
  E02: {
    code: 'E02',
    category: '模型强制中断',
    reason: '触发内容安全策略，模型已强制停止',
    requiredFields: ['model', 'finish_reason'],
    suggestion: '请调整请求内容后重试；本次响应因安全管控被终止。',
    retryable: false,
    resumable: false, // 安全中断绝不自动续接 / 重试
    continueHint: null,
    sensitive: true, // 不得泄露命中的具体策略 / 系统 Prompt
  },
  E03: {
    code: 'E03',
    category: '上下文溢出',
    reason: '请求超出模型最大上下文长度',
    requiredFields: ['model', 'ctx_limit', 'required_tokens'],
    suggestion: '请压缩上下文、清理历史或改用更大上下文窗口的模型后重试。',
    retryable: false, // 直接重试无意义，应先压缩
    resumable: false, // 必须先压缩上下文，直接续接仍会溢出
    continueHint: null,
    sensitive: false,
  },
  E04: {
    code: 'E04',
    category: '工具执行崩溃',
    reason: '工具内部抛出未捕获异常',
    requiredFields: ['tool_name', 'raw_error_stack'],
    suggestion: '请检查该工具的依赖与参数，或改用功能相近的替代工具。',
    retryable: false,
    resumable: false, // 工具崩溃需先修依赖 / 参数，盲目续接会复现崩溃
    continueHint: null,
    sensitive: false,
  },
  E05: {
    code: 'E05',
    category: '依赖缺失阻断',
    reason: '缺少关键依赖且未完成安装',
    requiredFields: ['tool_name', 'missing_dep'],
    suggestion: '请确认依赖安装提示并允许安装，或手动安装后重试。',
    retryable: true,
    resumable: false, // 装好依赖前续接无意义，须先完成安装
    continueHint: null,
    sensitive: false,
  },
  E06: {
    code: 'E06',
    category: '网络层熔断',
    reason: 'API 超时 / 重试耗尽 / 网络不可达',
    requiredFields: ['endpoint', 'timeout_ms', 'retry_count'],
    suggestion: '请检查网络连接或代理设置，稍后重试；必要时切换模型通道。',
    retryable: true,
    resumable: true,
    continueHint: '网络恢复后输入「继续」即可从断点续写未完成的内容。',
    sensitive: false,
  },
  E07: {
    code: 'E07',
    category: '权限拦截',
    reason: '操作被审批网关拒绝',
    requiredFields: ['tool_name', 'approval_level', 'deny_reason'],
    suggestion: '该操作需要更高级别授权或已触发安全红线；请在审批中确认或调整操作。',
    retryable: false,
    resumable: false, // 权限拦截绝不自动续接 / 重试，须经审批
    continueHint: null,
    sensitive: true, // 不得泄露内部审批规则细节
  },
  E08: {
    code: 'E08',
    category: '格式校验失败',
    reason: '模型输出不符合预期的 JSON Schema',
    requiredFields: ['expected_schema', 'raw_output_snippet'],
    suggestion: '请重试；若持续失败，请收紧提示词约束或降低输出结构复杂度。',
    retryable: true,
    resumable: true,
    continueHint: '输入「继续」即可从截断处续写剩余内容。',
    sensitive: false,
  },
};

/** 兜底协议默认采用的错误码（流式意外中断时，无更具体归因时使用）。 */
const FALLBACK_CODE = 'E04';

/** 取某错误码的定义；未知码 fail-safe 回落 FALLBACK_CODE，绝不返回空。 */
function getErrorCode(code) {
  return ERROR_CODES[code] || ERROR_CODES[FALLBACK_CODE];
}

/** 列出全部错误码字符串。 */
function listCodes() {
  return Object.keys(ERROR_CODES);
}

/** 是否为已登记的错误码。 */
function isKnownCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

module.exports = {
  ERROR_CODES,
  FALLBACK_CODE,
  getErrorCode,
  listCodes,
  isKnownCode,
};
